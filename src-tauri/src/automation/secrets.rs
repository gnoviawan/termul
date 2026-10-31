//! Project secrets for `http` nodes. Values sit in the OS keychain under
//! `automation:<project_id>:<NAME>`; only names are stored in the automation
//! database. Values are read only while an `http` node renders and are never
//! logged. Every keychain failure fails closed.

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

use super::store::{AutomationStore, StoreError};
use crate::acp::credentials;

const MAX_NAME_LEN: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecretError {
    Missing(String),
    KeychainUnavailable,
    InvalidName(String),
    EmptyValue,
    Store(String),
}

impl fmt::Display for SecretError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Missing(name) => write!(f, "secret_missing:{name}"),
            Self::KeychainUnavailable => f.write_str("keychain_unavailable"),
            Self::InvalidName(name) => write!(
                f,
                "invalid secret name {name:?}: use 1-{MAX_NAME_LEN} letters, digits, _ or -"
            ),
            Self::EmptyValue => f.write_str("a secret value cannot be empty"),
            Self::Store(detail) => write!(f, "secret names: {detail}"),
        }
    }
}

impl std::error::Error for SecretError {}

impl From<StoreError> for SecretError {
    fn from(error: StoreError) -> Self {
        Self::Store(error.to_string())
    }
}

/// Where secret values live. The keychain in production, a map in tests.
pub trait SecretVault: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, SecretError>;
    fn set(&self, account: &str, value: &str) -> Result<(), SecretError>;
    fn delete(&self, account: &str) -> Result<(), SecretError>;
}

pub struct KeychainVault;

impl SecretVault for KeychainVault {
    fn get(&self, account: &str) -> Result<Option<String>, SecretError> {
        credentials::read_secret(account, "empty").map_err(|_| SecretError::KeychainUnavailable)
    }

    fn set(&self, account: &str, value: &str) -> Result<(), SecretError> {
        credentials::write_secret(account, value, "save", "verify")
            .map_err(|_| SecretError::KeychainUnavailable)
    }

    fn delete(&self, account: &str) -> Result<(), SecretError> {
        credentials::delete_secret(account, "delete").map_err(|_| SecretError::KeychainUnavailable)
    }
}

/// Template-segment compatible, so `{{ secrets.NAME }}` can reach every name.
pub fn validate_name(name: &str) -> Result<(), SecretError> {
    let ok = !name.is_empty()
        && name.len() <= MAX_NAME_LEN
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if ok {
        Ok(())
    } else {
        Err(SecretError::InvalidName(name.to_string()))
    }
}

fn account(project_id: &str, name: &str) -> String {
    format!("automation:{project_id}:{name}")
}

pub struct Secrets {
    vault: Arc<dyn SecretVault>,
    store: Arc<AutomationStore>,
}

impl Secrets {
    pub fn new(vault: Arc<dyn SecretVault>, store: Arc<AutomationStore>) -> Self {
        Self { vault, store }
    }

    pub fn set(&self, project_id: &str, name: &str, value: &str) -> Result<(), SecretError> {
        validate_name(name)?;
        if value.is_empty() {
            return Err(SecretError::EmptyValue);
        }
        self.vault.set(&account(project_id, name), value)?;
        self.store.add_secret_name(project_id, name)?;
        log::info!("[Automation] secret {name} set for project {project_id}");
        Ok(())
    }

    pub fn delete(&self, project_id: &str, name: &str) -> Result<(), SecretError> {
        validate_name(name)?;
        self.vault.delete(&account(project_id, name))?;
        self.store.remove_secret_name(project_id, name)?;
        log::info!("[Automation] secret {name} deleted for project {project_id}");
        Ok(())
    }

    pub fn list_names(&self, project_id: &str) -> Result<Vec<String>, SecretError> {
        Ok(self.store.secret_names(project_id)?)
    }

    /// Values for `names`, or the first one that cannot be read.
    pub fn resolve(
        &self,
        project_id: &str,
        names: &[String],
    ) -> Result<HashMap<String, String>, SecretError> {
        names
            .iter()
            .map(|name| match self.vault.get(&account(project_id, name))? {
                Some(value) => Ok((name.clone(), value)),
                None => Err(SecretError::Missing(name.clone())),
            })
            .collect()
    }
}
