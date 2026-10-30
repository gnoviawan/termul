//! Project secrets for `http` nodes. Values sit in the OS keychain under
//! `automation:<project_id>:<NAME>`, or, on a host without one, in an
//! owner-only file keyed the same way; only names are stored in the
//! automation database. Values are read only while an `http` node renders and
//! are never logged. Every vault failure fails closed.

use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;

use super::store::{AutomationStore, StoreError};
use crate::acp::{atomic_file, credentials};

/// The file vault in the host data dir.
pub const FILE_VAULT_NAME: &str = "automation-secrets.json";
/// A keychain account no secret uses: reading it tells whether the keychain
/// answers at all.
const PROBE_ACCOUNT: &str = "automation:probe";

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

/// Secrets in an owner-only JSON object `{account: value}` in the host data
/// dir, for hosts without an OS keychain (headless Linux, `termul-server`).
/// One process owns a data dir (AD-14), so the map is read once and written
/// through on every change.
struct FileVault {
    path: PathBuf,
    entries: Mutex<BTreeMap<String, String>>,
}

impl FileVault {
    /// Reads `path`; a missing file is an empty vault.
    fn open(path: PathBuf) -> io::Result<Self> {
        let entries = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(io::Error::other)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => BTreeMap::new(),
            Err(error) => return Err(error),
        };
        Ok(Self {
            path,
            entries: Mutex::new(entries),
        })
    }

    fn write(&self, entries: &BTreeMap<String, String>) -> Result<(), SecretError> {
        let bytes = serde_json::to_vec(entries).map_err(|_| SecretError::KeychainUnavailable)?;
        atomic_file::replace_private(&self.path, &bytes).map_err(|error| {
            log::error!("[Automation] secrets file not written: {}", error.kind());
            SecretError::KeychainUnavailable
        })
    }
}

impl SecretVault for FileVault {
    fn get(&self, account: &str) -> Result<Option<String>, SecretError> {
        Ok(self.entries.lock().get(account).cloned())
    }

    fn set(&self, account: &str, value: &str) -> Result<(), SecretError> {
        let mut entries = self.entries.lock();
        let mut next = entries.clone();
        next.insert(account.to_string(), value.to_string());
        self.write(&next)?;
        *entries = next;
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), SecretError> {
        let mut entries = self.entries.lock();
        if !entries.contains_key(account) {
            return Ok(());
        }
        let mut next = entries.clone();
        next.remove(account);
        self.write(&next)?;
        *entries = next;
        Ok(())
    }
}

/// The vault this host keeps secrets in, chosen once: the file vault when
/// `data_dir` already holds one or the OS keychain does not answer, else the
/// keychain. A file vault that cannot be read leaves the keychain, which fails
/// closed where there is none.
pub fn open_vault(data_dir: &Path) -> Arc<dyn SecretVault> {
    choose_vault(data_dir, || {
        credentials::read_secret(PROBE_ACCOUNT, "empty").is_ok()
    })
}

pub(super) fn choose_vault(
    data_dir: &Path,
    keychain_answers: impl FnOnce() -> bool,
) -> Arc<dyn SecretVault> {
    let path = data_dir.join(FILE_VAULT_NAME);
    if !path.exists() && keychain_answers() {
        log::info!("[Automation] secrets are kept in the OS keychain");
        return Arc::new(KeychainVault);
    }
    match FileVault::open(path.clone()) {
        Ok(vault) => {
            log::info!("[Automation] secrets are kept in {}", path.display());
            Arc::new(vault)
        }
        Err(error) => {
            log::error!(
                "[Automation] secrets file {} unreadable ({}); using the OS keychain",
                path.display(),
                error.kind()
            );
            Arc::new(KeychainVault)
        }
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
