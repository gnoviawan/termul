//! SSH Profile Manager
//!
//! CRUD operations for SSH connection profiles, persisted via tauri-plugin-store.
//! Sensitive credentials (password, passphrase) are stored in the OS keychain
//! via the credential_store module — they are never written to disk.

use super::credential_store;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "ssh-profiles.json";
const STORE_KEY: &str = "profiles";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardConfig {
    pub id: String,
    #[serde(rename = "type")]
    pub forward_type: String, // "local" | "remote"
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    pub label: Option<String>,
    pub auto_start: bool,
}

/// SSH profile as stored on disk (no secrets).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSSHProfile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    pub private_key_path: Option<String>,
    pub jump_host_id: Option<String>,
    pub port_forwards: Vec<PortForwardConfig>,
    pub tags: Option<Vec<String>>,
    pub last_connected: Option<String>,
    pub imported_from: Option<String>,
    /// Whether a password is stored in the OS keychain
    #[serde(default)]
    pub has_stored_password: bool,
    /// Whether a passphrase is stored in the OS keychain
    #[serde(default)]
    pub has_stored_passphrase: bool,
}

/// Full SSH profile including secrets (used in-memory and over IPC).
/// The `password` and `passphrase` fields are never persisted to the JSON store.
/// Active SSH connections may retain a process-memory copy of the relevant
/// secret only so automatic reconnect can re-authenticate; SSH agent auth avoids
/// that runtime secret retention path.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SSHProfile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String, // "password" | "key" | "agent"
    pub private_key_path: Option<String>,
    /// Transient: only populated from keychain on demand, never written to disk
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    /// Transient: only populated from keychain on demand, never written to disk
    #[serde(skip_serializing_if = "Option::is_none")]
    pub passphrase: Option<String>,
    pub jump_host_id: Option<String>,
    pub port_forwards: Vec<PortForwardConfig>,
    pub tags: Option<Vec<String>>,
    pub last_connected: Option<String>,
    pub imported_from: Option<String>,
    /// Indicates whether a password exists in the OS keychain
    #[serde(default)]
    pub has_stored_password: bool,
    /// Indicates whether a passphrase exists in the OS keychain
    #[serde(default)]
    pub has_stored_passphrase: bool,
}

impl From<StoredSSHProfile> for SSHProfile {
    fn from(stored: StoredSSHProfile) -> Self {
        SSHProfile {
            id: stored.id,
            name: stored.name,
            host: stored.host,
            port: stored.port,
            username: stored.username,
            auth_method: stored.auth_method,
            private_key_path: stored.private_key_path,
            password: None,
            passphrase: None,
            jump_host_id: stored.jump_host_id,
            port_forwards: stored.port_forwards,
            tags: stored.tags,
            last_connected: stored.last_connected,
            imported_from: stored.imported_from,
            has_stored_password: stored.has_stored_password,
            has_stored_passphrase: stored.has_stored_passphrase,
        }
    }
}

impl From<&SSHProfile> for StoredSSHProfile {
    fn from(profile: &SSHProfile) -> Self {
        StoredSSHProfile {
            id: profile.id.clone(),
            name: profile.name.clone(),
            host: profile.host.clone(),
            port: profile.port,
            username: profile.username.clone(),
            auth_method: profile.auth_method.clone(),
            private_key_path: profile.private_key_path.clone(),
            jump_host_id: profile.jump_host_id.clone(),
            port_forwards: profile.port_forwards.clone(),
            tags: profile.tags.clone(),
            last_connected: profile.last_connected.clone(),
            imported_from: profile.imported_from.clone(),
            has_stored_password: profile.has_stored_password,
            has_stored_passphrase: profile.has_stored_passphrase,
        }
    }
}

pub struct ProfileManager {
    app_handle: AppHandle,
    /// In-memory cache of profiles for fast access
    cache: Mutex<Option<Vec<SSHProfile>>>,
}

impl ProfileManager {
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            app_handle,
            cache: Mutex::new(None),
        }
    }

    /// Load profiles from store (secrets are NOT loaded here)
    fn load_from_store(&self) -> Result<Vec<SSHProfile>, String> {
        let store = self
            .app_handle
            .store(STORE_FILE)
            .map_err(|e| format!("Failed to open SSH store: {}", e))?;

        let stored: Vec<StoredSSHProfile> = store
            .get(STORE_KEY)
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();

        Ok(stored.into_iter().map(SSHProfile::from).collect())
    }

    /// Save profiles to store (only non-secret fields)
    fn save_to_store(&self, profiles: &[SSHProfile]) -> Result<(), String> {
        let store = self
            .app_handle
            .store(STORE_FILE)
            .map_err(|e| format!("Failed to open SSH store: {}", e))?;

        let stored: Vec<StoredSSHProfile> = profiles.iter().map(StoredSSHProfile::from).collect();

        let value = serde_json::to_value(&stored)
            .map_err(|e| format!("Failed to serialize profiles: {}", e))?;

        store.set(STORE_KEY, value);
        store
            .save()
            .map_err(|e| format!("Failed to save SSH store: {}", e))?;

        Ok(())
    }

    /// Get all profiles (uses cache). Secrets are NOT included in the returned profiles.
    pub fn list(&self) -> Result<Vec<SSHProfile>, String> {
        let mut cache = self.cache.lock().map_err(|_| "Cache lock poisoned")?;

        if let Some(ref profiles) = *cache {
            return Ok(profiles.clone());
        }

        let profiles = self.load_from_store()?;
        *cache = Some(profiles.clone());
        Ok(profiles)
    }

    /// Get a single profile by ID (without secrets)
    pub fn get(&self, id: &str) -> Result<Option<SSHProfile>, String> {
        let profiles = self.list()?;
        Ok(profiles.into_iter().find(|p| p.id == id))
    }

    /// Get a profile with its credentials loaded from the OS keychain.
    pub fn get_with_credentials(&self, id: &str) -> Result<Option<SSHProfile>, String> {
        let mut profile = match self.get(id)? {
            Some(p) => p,
            None => return Ok(None),
        };

        // Load password from keychain if one is stored
        if profile.has_stored_password {
            match credential_store::get_password(&profile.id) {
                Ok(pw) => profile.password = pw,
                Err(e) => {
                    log::warn!(
                        "[SSH] Failed to load password from keychain for {}: {}",
                        id,
                        e
                    );
                }
            }
        }

        // Load passphrase from keychain if one is stored
        if profile.has_stored_passphrase {
            match credential_store::get_passphrase(&profile.id) {
                Ok(pp) => profile.passphrase = pp,
                Err(e) => {
                    log::warn!(
                        "[SSH] Failed to load passphrase from keychain for {}: {}",
                        id,
                        e
                    );
                }
            }
        }

        Ok(Some(profile))
    }

    /// Save (create or update) a profile.
    /// If password/passphrase are provided, they are stored in the OS keychain.
    pub fn save(&self, mut profile: SSHProfile) -> Result<(), String> {
        // Store credentials in OS keychain if provided
        if let Some(ref password) = profile.password {
            if !password.is_empty() {
                credential_store::store_password(&profile.id, password)?;
                profile.has_stored_password = true;
            }
        }

        if let Some(ref passphrase) = profile.passphrase {
            if !passphrase.is_empty() {
                credential_store::store_passphrase(&profile.id, passphrase)?;
                profile.has_stored_passphrase = true;
            }
        }

        // Clear password if auth method changed away from password
        if profile.auth_method != "password" && profile.has_stored_password {
            credential_store::delete_password(&profile.id)?;
            profile.has_stored_password = false;
        }

        // Clear passphrase if auth method changed away from key
        if profile.auth_method != "key" && profile.has_stored_passphrase {
            credential_store::delete_passphrase(&profile.id)?;
            profile.has_stored_passphrase = false;
        }

        // Clear transient secrets before caching (they live only in keychain)
        profile.password = None;
        profile.passphrase = None;

        let mut cache = self.cache.lock().map_err(|_| "Cache lock poisoned")?;
        let mut profiles = self.load_from_store()?;

        // Update existing or insert new
        if let Some(existing) = profiles.iter_mut().find(|p| p.id == profile.id) {
            *existing = profile;
        } else {
            profiles.push(profile);
        }

        self.save_to_store(&profiles)?;
        *cache = Some(profiles);

        Ok(())
    }

    /// Delete a profile by ID (also removes credentials from keychain)
    pub fn delete(&self, id: &str) -> Result<(), String> {
        let mut cache = self.cache.lock().map_err(|_| "Cache lock poisoned")?;
        let mut profiles = self.load_from_store()?;
        let original_len = profiles.len();
        profiles.retain(|p| p.id != id);

        if profiles.len() == original_len {
            return Err(format!("Profile not found: {}", id));
        }

        // Remove credentials from OS keychain
        if let Err(e) = credential_store::delete_credentials(id) {
            log::warn!("[SSH] Failed to delete credentials from keychain: {}", e);
        }

        self.save_to_store(&profiles)?;
        *cache = Some(profiles);

        Ok(())
    }

    /// Update last_connected timestamp for a profile
    pub fn update_last_connected(&self, id: &str) -> Result<(), String> {
        let mut cache = self.cache.lock().map_err(|_| "Cache lock poisoned")?;
        let mut profiles = self.load_from_store()?;

        if let Some(profile) = profiles.iter_mut().find(|p| p.id == id) {
            profile.last_connected = Some(chrono::Utc::now().to_rfc3339());
        } else {
            return Err(format!("Profile not found: {}", id));
        }

        self.save_to_store(&profiles)?;
        *cache = Some(profiles);

        Ok(())
    }

    /// Import profiles from SSH config, skipping duplicates by host+username+port
    pub fn import_from_config(
        &self,
        parsed: Vec<super::config_parser::ParsedSSHProfile>,
    ) -> Result<Vec<SSHProfile>, String> {
        let mut cache = self.cache.lock().map_err(|_| "Cache lock poisoned")?;
        let mut profiles = self.load_from_store()?;
        let mut imported = Vec::new();

        for parsed_profile in parsed {
            // Skip if a profile with same host+username+port already exists
            let duplicate = profiles.iter().any(|p| {
                p.host == parsed_profile.host
                    && p.username == parsed_profile.username
                    && p.port == parsed_profile.port
            });

            if duplicate {
                log::debug!(
                    "[SSH] Skipping duplicate import for host {}:{}",
                    parsed_profile.host,
                    parsed_profile.port
                );
                continue;
            }

            let profile = SSHProfile {
                id: uuid::Uuid::new_v4().to_string(),
                name: parsed_profile.name,
                host: parsed_profile.host,
                port: parsed_profile.port,
                username: parsed_profile.username,
                auth_method: parsed_profile.auth_method,
                private_key_path: parsed_profile.private_key_path,
                password: None,
                passphrase: None,
                jump_host_id: None,
                port_forwards: Vec::new(),
                tags: None,
                last_connected: None,
                imported_from: parsed_profile.imported_from,
                has_stored_password: false,
                has_stored_passphrase: false,
            };

            imported.push(profile.clone());
            profiles.push(profile);
        }

        if !imported.is_empty() {
            self.save_to_store(&profiles)?;
            *cache = Some(profiles);
        }

        Ok(imported)
    }
}
