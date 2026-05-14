//! SSH Profile Manager
//!
//! CRUD operations for SSH connection profiles, persisted via tauri-plugin-store.

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
    pub password: Option<String>,
    pub passphrase: Option<String>,
    pub jump_host_id: Option<String>,
    pub port_forwards: Vec<PortForwardConfig>,
    pub tags: Option<Vec<String>>,
    pub last_connected: Option<String>,
    pub imported_from: Option<String>,
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

    /// Load profiles from store
    fn load_from_store(&self) -> Result<Vec<SSHProfile>, String> {
        let store = self
            .app_handle
            .store(STORE_FILE)
            .map_err(|e| format!("Failed to open SSH store: {}", e))?;

        let profiles: Vec<SSHProfile> = store
            .get(STORE_KEY)
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();

        Ok(profiles)
    }

    /// Save profiles to store
    fn save_to_store(&self, profiles: &[SSHProfile]) -> Result<(), String> {
        let store = self
            .app_handle
            .store(STORE_FILE)
            .map_err(|e| format!("Failed to open SSH store: {}", e))?;

        let value = serde_json::to_value(profiles)
            .map_err(|e| format!("Failed to serialize profiles: {}", e))?;

        store.set(STORE_KEY, value);
        store
            .save()
            .map_err(|e| format!("Failed to save SSH store: {}", e))?;

        Ok(())
    }

    /// Get all profiles (uses cache)
    pub fn list(&self) -> Result<Vec<SSHProfile>, String> {
        let mut cache = self.cache.lock().map_err(|_| "Cache lock poisoned")?;

        if let Some(ref profiles) = *cache {
            return Ok(profiles.clone());
        }

        let profiles = self.load_from_store()?;
        *cache = Some(profiles.clone());
        Ok(profiles)
    }

    /// Get a single profile by ID
    pub fn get(&self, id: &str) -> Result<Option<SSHProfile>, String> {
        let profiles = self.list()?;
        Ok(profiles.into_iter().find(|p| p.id == id))
    }

    /// Save (create or update) a profile
    pub fn save(&self, profile: SSHProfile) -> Result<(), String> {
        let mut profiles = self.load_from_store()?;

        // Update existing or insert new
        if let Some(existing) = profiles.iter_mut().find(|p| p.id == profile.id) {
            *existing = profile;
        } else {
            profiles.push(profile);
        }

        self.save_to_store(&profiles)?;

        // Invalidate cache
        let mut cache = self.cache.lock().map_err(|_| "Cache lock poisoned")?;
        *cache = Some(profiles);

        Ok(())
    }

    /// Delete a profile by ID
    pub fn delete(&self, id: &str) -> Result<(), String> {
        let mut profiles = self.load_from_store()?;
        let original_len = profiles.len();
        profiles.retain(|p| p.id != id);

        if profiles.len() == original_len {
            return Err(format!("Profile not found: {}", id));
        }

        self.save_to_store(&profiles)?;

        // Invalidate cache
        let mut cache = self.cache.lock().map_err(|_| "Cache lock poisoned")?;
        *cache = Some(profiles);

        Ok(())
    }

    /// Update last_connected timestamp for a profile
    pub fn update_last_connected(&self, id: &str) -> Result<(), String> {
        let mut profiles = self.load_from_store()?;

        if let Some(profile) = profiles.iter_mut().find(|p| p.id == id) {
            profile.last_connected = Some(chrono::Utc::now().to_rfc3339());
        } else {
            return Err(format!("Profile not found: {}", id));
        }

        self.save_to_store(&profiles)?;

        let mut cache = self.cache.lock().map_err(|_| "Cache lock poisoned")?;
        *cache = Some(profiles);

        Ok(())
    }

    /// Import profiles from SSH config, skipping duplicates by host+username
    pub fn import_from_config(
        &self,
        parsed: Vec<super::config_parser::ParsedSSHProfile>,
    ) -> Result<Vec<SSHProfile>, String> {
        let mut profiles = self.load_from_store()?;
        let mut imported = Vec::new();

        for parsed_profile in parsed {
            // Skip if a profile with same host+username already exists
            let duplicate = profiles
                .iter()
                .any(|p| p.host == parsed_profile.host && p.username == parsed_profile.username);

            if duplicate {
                log::debug!(
                    "[SSH] Skipping duplicate: {}@{}",
                    parsed_profile.username,
                    parsed_profile.host
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
            };

            imported.push(profile.clone());
            profiles.push(profile);
        }

        if !imported.is_empty() {
            self.save_to_store(&profiles)?;
            let mut cache = self.cache.lock().map_err(|_| "Cache lock poisoned")?;
            *cache = Some(profiles);
        }

        Ok(imported)
    }
}
