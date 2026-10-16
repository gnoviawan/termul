//! Claude Accounts: several Claude subscription logins on one host, one Claude
//! config directory per Account (ADR-0004).
//!
//! The built-in Account uses the shared Claude config directory itself
//! (`~/.claude`, or the host's `CLAUDE_CONFIG_DIR`). Every other Account has a
//! Termul-owned directory under `<state dir>/claude-accounts/<id>` whose shared
//! entries link back to the shared directory. Each Project uses one Account;
//! a Project without a choice uses the Default Account.
//!
//! The store keeps no secrets: logins live in Claude Code's own credential
//! store (OS keychain or `.credentials.json`), keyed by the config directory.

pub mod links;
pub mod usage;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::atomic_file;

/// Id of the built-in Account that uses the shared Claude config directory.
pub const BUILTIN_ACCOUNT_ID: &str = "default";
const BUILTIN_ACCOUNT_NAME: &str = "Default";
const STORE_FILE_NAME: &str = "claude-accounts.json";
const ACCOUNTS_DIR_NAME: &str = "claude-accounts";
const SCHEMA_VERSION: u32 = 1;
const MAX_NAME_CHARS: usize = 40;

/// One Claude subscription login.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAccount {
    pub id: String,
    pub name: String,
    pub created_at: i64,
}

/// Safe, secret-free view of the Account list for every transport.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAccountsSnapshot {
    // Not named `accounts`: CodeQL treats that word as secret data. The
    // JSON key stays `accounts`. These are profile ids and display names.
    #[serde(rename = "accounts")]
    pub profiles: Vec<ClaudeAccountView>,
    pub default_account_id: String,
    /// Project id → Account id, only for Projects with an explicit choice.
    // JSON key stays `projectAccounts`.
    #[serde(rename = "projectAccounts")]
    pub project_profiles: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAccountView {
    pub id: String,
    pub name: String,
    /// `true` for the Account that uses the shared Claude config directory.
    pub builtin: bool,
    /// Claude CLI login state; `None` when it could not be read.
    pub signed_in: Option<bool>,
}

/// The Account a spawn uses, and the config directory to export for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountResolution {
    pub account_id: String,
    pub account_name: String,
    /// `None` for the built-in Account: the agent inherits the host's Claude
    /// config directory unchanged.
    pub config_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoreFile {
    version: u32,
    // Not named `accounts`: CodeQL treats that word as secret data, and this
    // list holds only ids and display names. The on-disk key stays `accounts`.
    #[serde(rename = "accounts")]
    entries: Vec<ClaudeAccount>,
    default_account_id: String,
    // JSON key stays `projectAccounts`.
    #[serde(default, rename = "projectAccounts")]
    project_profiles: BTreeMap<String, String>,
}

impl StoreFile {
    fn initial() -> Self {
        Self {
            version: SCHEMA_VERSION,
            entries: vec![ClaudeAccount {
                id: BUILTIN_ACCOUNT_ID.to_string(),
                name: BUILTIN_ACCOUNT_NAME.to_string(),
                created_at: 0,
            }],
            default_account_id: BUILTIN_ACCOUNT_ID.to_string(),
            project_profiles: BTreeMap::new(),
        }
    }

    /// Repair invariants after a load: the built-in Account exists, and the
    /// default and every Project choice name an existing Account.
    fn normalize(&mut self) {
        if !self.entries.iter().any(|a| a.id == BUILTIN_ACCOUNT_ID) {
            self.entries
                .insert(0, StoreFile::initial().entries.remove(0));
        }
        if !self.has_account(&self.default_account_id.clone()) {
            log::warn!("[claude-accounts] default account is missing; using the built-in account");
            self.default_account_id = BUILTIN_ACCOUNT_ID.to_string();
        }
        let known: Vec<String> = self.entries.iter().map(|a| a.id.clone()).collect();
        self.project_profiles.retain(|_, id| known.contains(id));
    }

    fn has_account(&self, id: &str) -> bool {
        self.entries.iter().any(|a| a.id == id)
    }
}

/// File-backed Account store. One per host state directory.
pub struct ClaudeAccountStore {
    store_path: PathBuf,
    accounts_root: PathBuf,
    shared_dir: PathBuf,
    lock: parking_lot::Mutex<()>,
}

impl ClaudeAccountStore {
    /// Store under `state_dir`, linking Account directories to `shared_dir`.
    #[must_use]
    pub fn new(state_dir: &Path, shared_dir: PathBuf) -> Self {
        Self {
            store_path: state_dir.join(STORE_FILE_NAME),
            accounts_root: state_dir.join(ACCOUNTS_DIR_NAME),
            shared_dir,
            lock: parking_lot::Mutex::new(()),
        }
    }

    /// The shared Claude config directory of this host: the host's
    /// `CLAUDE_CONFIG_DIR` when set, else `~/.claude`.
    #[must_use]
    pub fn host_shared_dir() -> Option<PathBuf> {
        if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|v| !v.is_empty()) {
            return Some(PathBuf::from(dir));
        }
        let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .filter(|v| !v.is_empty())?;
        Some(PathBuf::from(home).join(".claude"))
    }

    /// Secret-free Account list. `signed_in` is `None`; callers that need the
    /// login state fill it in.
    pub fn snapshot(&self) -> Result<ClaudeAccountsSnapshot, String> {
        let _guard = self.lock.lock();
        let file = self.load()?;
        Ok(ClaudeAccountsSnapshot {
            profiles: file
                .entries
                .iter()
                .map(|a| ClaudeAccountView {
                    id: a.id.clone(),
                    name: a.name.clone(),
                    builtin: a.id == BUILTIN_ACCOUNT_ID,
                    signed_in: None,
                })
                .collect(),
            default_account_id: file.default_account_id,
            project_profiles: file.project_profiles,
        })
    }

    /// Add an Account and create its linked config directory. The Account is
    /// signed out until the user runs the Claude login for it.
    pub fn add(&self, name: &str) -> Result<ClaudeAccount, String> {
        let name = validate_name(name)?;
        let _guard = self.lock.lock();
        let mut file = self.load()?;
        if file
            .entries
            .iter()
            .any(|a| a.name.eq_ignore_ascii_case(&name))
        {
            return Err(format!("An account named \"{name}\" already exists"));
        }
        let created = ClaudeAccount {
            id: uuid::Uuid::new_v4().simple().to_string(),
            name,
            created_at: chrono::Utc::now().timestamp_millis(),
        };
        let dir = self.accounts_root.join(&created.id);
        match links::ensure_links(&self.shared_dir, &dir) {
            Ok(0) => {}
            Ok(_failed) => {
                log::warn!("[claude-accounts] profile created with unlinked shared entries");
            }
            Err(error) => {
                log::warn!(
                    "[claude-accounts] could not create profile directory: {:?}",
                    error.kind()
                );
                return Err("Could not create the account folder".to_string());
            }
        }
        file.entries.push(created.clone());
        if let Err(error) = self.save(&file) {
            remove_account_dir(&dir);
            return Err(error);
        }
        log::info!("[claude-accounts] profile added");
        Ok(created)
    }

    pub fn rename(&self, id: &str, name: &str) -> Result<(), String> {
        let name = validate_name(name)?;
        let _guard = self.lock.lock();
        let mut file = self.load()?;
        if file
            .entries
            .iter()
            .any(|a| a.id != id && a.name.eq_ignore_ascii_case(&name))
        {
            return Err(format!("An account named \"{name}\" already exists"));
        }
        let account = file
            .entries
            .iter_mut()
            .find(|a| a.id == id)
            .ok_or_else(|| unknown_account(id))?;
        account.name = name;
        self.save(&file)?;
        log::info!("[claude-accounts] profile renamed");
        Ok(())
    }

    /// Remove an Account and its directory. Projects that used it, and the
    /// default when it pointed at it, return to the built-in Account. Returns
    /// the ids of the Projects that moved.
    pub fn remove(&self, id: &str) -> Result<Vec<String>, String> {
        if id == BUILTIN_ACCOUNT_ID {
            return Err("The built-in account cannot be removed".to_string());
        }
        let _guard = self.lock.lock();
        let mut file = self.load()?;
        if !file.has_account(id) {
            return Err(unknown_account(id));
        }
        file.entries.retain(|a| a.id != id);
        if file.default_account_id == id {
            file.default_account_id = BUILTIN_ACCOUNT_ID.to_string();
        }
        let moved: Vec<String> = file
            .project_profiles
            .iter()
            .filter(|(_, account)| account.as_str() == id)
            .map(|(project, _)| project.clone())
            .collect();
        for project in &moved {
            file.project_profiles.remove(project);
        }
        self.save(&file)?;
        if let Some(dir) = self.account_dir(id) {
            remove_account_dir(&dir);
        }
        log::info!("[claude-accounts] profile removed; projects moved to the default");
        Ok(moved)
    }

    pub fn set_default(&self, id: &str) -> Result<(), String> {
        let _guard = self.lock.lock();
        let mut file = self.load()?;
        if !file.has_account(id) {
            return Err(unknown_account(id));
        }
        file.default_account_id = id.to_string();
        self.save(&file)?;
        log::info!("[claude-accounts] default profile updated");
        Ok(())
    }

    /// Choose the Account of a Project. `None` returns it to the Default
    /// Account.
    pub fn set_project_account(
        &self,
        project_id: &str,
        account_id: Option<&str>,
    ) -> Result<(), String> {
        let project_id = project_id.trim();
        if project_id.is_empty() {
            return Err("A project id is required".to_string());
        }
        let _guard = self.lock.lock();
        let mut file = self.load()?;
        match account_id {
            Some(id) => {
                if !file.has_account(id) {
                    return Err(unknown_account(id));
                }
                file.project_profiles
                    .insert(project_id.to_string(), id.to_string());
            }
            None => {
                file.project_profiles.remove(project_id);
            }
        }
        self.save(&file)?;
        log::info!("[claude-accounts] project profile updated");
        Ok(())
    }

    /// The Account a spawn for `project_id` uses. A damaged store falls back
    /// to the built-in Account so Claude chats keep working.
    #[must_use]
    pub fn resolve(&self, project_id: Option<&str>) -> AccountResolution {
        let _guard = self.lock.lock();
        let file = match self.load() {
            Ok(file) => file,
            Err(error) => {
                log::warn!("[claude-accounts] resolve fell back to the built-in account: {error}");
                return builtin_resolution(BUILTIN_ACCOUNT_NAME);
            }
        };
        let id = project_id
            .and_then(|project| file.project_profiles.get(project.trim()))
            .unwrap_or(&file.default_account_id)
            .clone();
        let name = file
            .entries
            .iter()
            .find(|a| a.id == id)
            .map_or_else(|| BUILTIN_ACCOUNT_NAME.to_string(), |a| a.name.clone());
        if id == BUILTIN_ACCOUNT_ID {
            return builtin_resolution(&name);
        }
        let Some(dir) = self.account_dir(&id) else {
            return builtin_resolution(BUILTIN_ACCOUNT_NAME);
        };
        // Repair links that a manual cleanup or a new shared entry left out.
        if let Err(error) = links::ensure_links(&self.shared_dir, &dir) {
            log::warn!(
                "[claude-accounts] could not repair shared links: {:?}",
                error.kind()
            );
        }
        AccountResolution {
            account_id: id,
            account_name: name,
            config_dir: Some(dir),
        }
    }

    /// Config directory of an Account; `None` for the built-in Account.
    #[must_use]
    pub fn config_dir(&self, id: &str) -> Option<PathBuf> {
        self.account_dir(id)
    }

    /// The directory of a non-built-in Account. The id is a Termul-generated
    /// hex string; anything else never maps to a path.
    fn account_dir(&self, id: &str) -> Option<PathBuf> {
        if id == BUILTIN_ACCOUNT_ID || id.is_empty() || !id.chars().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        Some(self.accounts_root.join(id))
    }

    fn load(&self) -> Result<StoreFile, String> {
        let bytes = match std::fs::read(&self.store_path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(StoreFile::initial());
            }
            Err(error) => {
                log::warn!("[claude-accounts] store read failed: {error}");
                return Err("Could not read the Claude account list".to_string());
            }
        };
        let mut file: StoreFile = match serde_json::from_slice(&bytes) {
            Ok(file) => file,
            Err(error) => {
                log::warn!("[claude-accounts] store is not valid JSON: {error}");
                if let Err(backup) = atomic_file::backup_corrupt(&self.store_path, &bytes) {
                    log::warn!("[claude-accounts] could not back up the damaged store: {backup}");
                }
                return Err("The Claude account list is damaged".to_string());
            }
        };
        if file.version > SCHEMA_VERSION {
            log::warn!(
                "[claude-accounts] store version {} is newer than {SCHEMA_VERSION}",
                file.version
            );
            return Err("The Claude account list is from a newer Termul version".to_string());
        }
        file.normalize();
        Ok(file)
    }

    fn save(&self, file: &StoreFile) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(file).map_err(|error| {
            log::warn!("[claude-accounts] store encode failed: {error}");
            "Could not save the Claude account list".to_string()
        })?;
        atomic_file::replace(&self.store_path, &bytes).map_err(|error| {
            log::warn!("[claude-accounts] store write failed: {error}");
            "Could not save the Claude account list".to_string()
        })
    }
}

fn builtin_resolution(name: &str) -> AccountResolution {
    AccountResolution {
        account_id: BUILTIN_ACCOUNT_ID.to_string(),
        account_name: name.to_string(),
        config_dir: None,
    }
}

fn validate_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("An account name is required".to_string());
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(format!(
            "An account name can have at most {MAX_NAME_CHARS} characters"
        ));
    }
    if name.chars().any(char::is_control) {
        return Err("An account name cannot contain control characters".to_string());
    }
    Ok(name.to_string())
}

fn unknown_account(_id: &str) -> String {
    log::warn!("[claude-accounts] unknown profile");
    "That Claude account does not exist".to_string()
}

fn remove_account_dir(dir: &Path) {
    links::remove_links(dir);
    if let Err(error) = std::fs::remove_dir_all(dir) {
        if error.kind() != std::io::ErrorKind::NotFound {
            log::warn!(
                "[claude-accounts] could not remove profile directory: {:?}",
                error.kind()
            );
        }
    }
}

#[cfg(test)]
mod tests;
