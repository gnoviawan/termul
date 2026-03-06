//! Data Migration Module
//!
//! Manages schema versioning, migrations, and rollback for application data.
//! Provides migration history tracking and safe migration execution.

use crate::commands::IpcResult;
use chrono::{DateTime, SecondsFormat, Utc};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

// ==================== Types ====================

/// Migration record in history
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationRecord {
    pub version: String,
    pub timestamp: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<u64>,
}

/// Migration result
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationResult {
    pub version: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub duration: u64,
}

/// Schema version info
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaVersion {
    pub current: String,
    pub target: String,
}

/// Registered migration info
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationInfo {
    pub version: String,
    pub description: String,
}

/// Migration entry with functions
struct MigrationEntry {
    version: String,
    description: String,
    migration_fn: Option<Box<dyn Fn() -> Result<(), String> + Send + Sync>>,
    rollback_fn: Option<Box<dyn Fn() -> Result<(), String> + Send + Sync>>,
}

// ==================== Migration Error Codes ====================

pub const ERROR_MIGRATION_VERSION_INVALID: &str = "MIGRATION_VERSION_INVALID";
pub const ERROR_MIGRATION_HISTORY_CORRUPT: &str = "MIGRATION_HISTORY_CORRUPT";
pub const ERROR_MIGRATION_ALREADY_RUNNING: &str = "MIGRATION_ALREADY_RUNNING";
pub const ERROR_MIGRATION_NOT_FOUND: &str = "MIGRATION_NOT_FOUND";
pub const ERROR_ROLLBACK_FAILED: &str = "ROLLBACK_FAILED";

// ==================== Scope Guard ====================

/// Scope guard that sets a Mutex<bool> to false when dropped
struct ScopeGuard<'a> {
    flag: &'a Mutex<bool>,
}

impl<'a> ScopeGuard<'a> {
    fn new(flag: &'a Mutex<bool>) -> Self {
        Self { flag }
    }
}

impl<'a> Drop for ScopeGuard<'a> {
    fn drop(&mut self) {
        *self.flag.lock() = false;
    }
}

// ==================== Migration Manager ====================

/// Manages data migrations, versioning, and history
pub struct MigrationManager {
    migrations: Mutex<HashMap<String, MigrationEntry>>,
    history: Mutex<Vec<MigrationRecord>>,
    is_running: Mutex<bool>,
    app_handle: AppHandle,
    schema_version_key: String,
    migration_history_key: String,
}

impl MigrationManager {
    /// Create a new migration manager
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            migrations: Mutex::new(HashMap::new()),
            history: Mutex::new(Vec::new()),
            is_running: Mutex::new(false),
            app_handle,
            schema_version_key: "schema-version".to_string(),
            migration_history_key: "migration-history".to_string(),
        }
    }

    /// Load migration history from store
    fn load_history(&self) -> Result<(), String> {
        let store = self
            .app_handle
            .store("settings.json")
            .map_err(|e| format!("Failed to get store: {}", e))?;

        // Try to get history from store
        if let Some(history_value) = store.get(&self.migration_history_key) {
            let parsed_history = serde_json::from_value::<Vec<MigrationRecord>>(
                history_value.clone(),
            )
            .or_else(|_| {
                history_value
                    .as_str()
                    .ok_or_else(|| "Migration history is not an array or JSON string".to_string())
                    .and_then(|raw| {
                        serde_json::from_str::<Vec<MigrationRecord>>(raw)
                            .map_err(|e| format!("Failed to parse migration history: {}", e))
                    })
            })?;

            *self.history.lock() = parsed_history;
        }

        Ok(())
    }

    fn write_history_records(&self, history: &[MigrationRecord]) -> Result<(), String> {
        let history_json = serde_json::to_value(history)
            .map_err(|e| format!("Failed to serialize history: {}", e))?;

        let store = self
            .app_handle
            .store("settings.json")
            .map_err(|e| format!("Failed to get store: {}", e))?;

        store.set(self.migration_history_key.clone(), history_json);

        Ok(())
    }

    /// Get current schema version
    pub fn get_current_schema_version(&self) -> IpcResult<String> {
        let store = match self.app_handle.store("settings.json") {
            Ok(s) => s,
            Err(_) => return IpcResult::success("0.0.0".to_string()), // Fresh install or error
        };

        if let Some(version_value) = store.get(&self.schema_version_key) {
            if let Some(version) = version_value.as_str() {
                return IpcResult::success(version.to_string());
            }
        }

        IpcResult::success("0.0.0".to_string()) // Fresh install
    }

    fn set_schema_version_result(&self, version: String) -> Result<(), String> {
        let store = match self.app_handle.store("settings.json") {
            Ok(s) => s,
            Err(e) => {
                return Err(format!("Store error: {}", e));
            }
        };

        store.set(self.schema_version_key.clone(), version);
        Ok(())
    }

    /// Register a migration
    #[allow(dead_code)]
    pub fn register_migration<F, R>(
        &self,
        version: String,
        description: String,
        migration_fn: F,
        rollback_fn: Option<R>,
    ) -> IpcResult<()>
    where
        F: Fn() -> Result<(), String> + Send + Sync + 'static,
        R: Fn() -> Result<(), String> + Send + Sync + 'static,
    {
        let entry = MigrationEntry {
            version: version.clone(),
            description,
            migration_fn: Some(
                Box::new(migration_fn) as Box<dyn Fn() -> Result<(), String> + Send + Sync>
            ),
            rollback_fn: rollback_fn
                .map(|f| Box::new(f) as Box<dyn Fn() -> Result<(), String> + Send + Sync>),
        };

        self.migrations.lock().insert(version, entry);
        IpcResult::success(())
    }

    /// Get all registered migrations
    pub fn get_registered_migrations(&self) -> IpcResult<Vec<MigrationInfo>> {
        let migrations_map = self.migrations.lock();
        let mut migrations: Vec<MigrationInfo> = migrations_map
            .values()
            .map(|m| MigrationInfo {
                version: m.version.clone(),
                description: m.description.clone(),
            })
            .collect();

        // Sort by version
        migrations.sort_by(|a, b| compare_versions(&a.version, &b.version));

        IpcResult::success(migrations)
    }

    /// Get migration history
    pub fn get_migration_history(&self) -> IpcResult<Vec<MigrationRecord>> {
        // Reload from store to get latest
        if let Err(e) = self.load_history() {
            return IpcResult::error(e, ERROR_MIGRATION_HISTORY_CORRUPT);
        }

        let history = self.history.lock();
        let history_clone = history.clone();
        IpcResult::success(history_clone)
    }

    /// Get schema version info
    pub fn get_schema_version_info(&self) -> IpcResult<SchemaVersion> {
        let current_result = self.get_current_schema_version();

        if !current_result.success {
            return IpcResult::error(
                current_result.error.unwrap_or_default(),
                ERROR_MIGRATION_VERSION_INVALID,
            );
        }

        let current = current_result.data.unwrap_or_default();

        // Find target version (highest registered)
        let migrations_map = self.migrations.lock();
        let target = migrations_map
            .keys()
            .max_by_key(|v| version_to_parts(v))
            .cloned()
            .unwrap_or_else(|| "0.0.0".to_string());

        IpcResult::success(SchemaVersion { current, target })
    }

    /// Run all pending migrations
    pub fn run_migrations(&self) -> IpcResult<Vec<MigrationResult>> {
        // Acquire lock once, check and set atomically
        let mut guard = self.is_running.lock();
        if *guard {
            return IpcResult::error(
                "Migration already in progress".to_string(),
                ERROR_MIGRATION_ALREADY_RUNNING,
            );
        }
        *guard = true;
        drop(guard);

        // Scope guard ensures is_running is reset when function exits
        let _scope_guard = ScopeGuard::new(&self.is_running);

        // Load history after setting is_running
        if let Err(error) = self.load_history() {
            return IpcResult::error(error, ERROR_MIGRATION_HISTORY_CORRUPT);
        }

        // Get current version
        let current_result = self.get_current_schema_version();
        if !current_result.success {
            return IpcResult::error(
                current_result.error.unwrap_or_default(),
                ERROR_MIGRATION_VERSION_INVALID,
            );
        }

        let current_version = current_result.data.unwrap_or_default();

        // Get sorted migrations
        let migrations_map = self.migrations.lock();
        let mut pending_versions: Vec<String> = migrations_map
            .values()
            .filter(|migration| {
                compare_versions(&migration.version, &current_version)
                    == std::cmp::Ordering::Greater
            })
            .map(|migration| migration.version.clone())
            .collect();
        drop(migrations_map);

        pending_versions.sort_by(|a, b| compare_versions(a, b));

        if pending_versions.is_empty() {
            return IpcResult::success(vec![]);
        }

        // Execute migrations
        let mut results = Vec::new();

        for version in pending_versions {
            let start = std::time::Instant::now();

            // Check if already migrated
            let history = self.history.lock();
            let already_migrated = history.iter().any(|r| r.version == version && r.success);
            drop(history);

            if already_migrated {
                continue;
            }

            // Get the migration entry and execute the migration function
            let execution_result = {
                let migrations_map = self.migrations.lock();
                let entry = migrations_map.get(&version);
                match entry {
                    Some(e) => {
                        let result = if let Some(ref migration_fn) = e.migration_fn {
                            // Execute the migration function
                            migration_fn()
                        } else {
                            let error = format!(
                                "Migration {} is registered without an implementation",
                                version
                            );
                            log::error!("{}", error);
                            Err(error)
                        };
                        result
                    }
                    None => {
                        continue;
                    }
                }
            };

            let duration = start.elapsed().as_millis() as u64;

            let migration_result = match execution_result {
                Ok(()) => {
                    let record = MigrationRecord {
                        version: version.clone(),
                        timestamp: chrono_timestamp(),
                        success: true,
                        error: None,
                        duration: Some(duration),
                    };

                    let mut next_history = self.history.lock().clone();
                    next_history.push(record);

                    match self.write_history_records(&next_history) {
                        Ok(()) => match self.set_schema_version_result(version.clone()) {
                            Ok(()) => {
                                *self.history.lock() = next_history;
                                Ok(())
                            }
                            Err(error) => Err(format!(
                                "Migration {} applied but failed to persist schema version: {}",
                                version, error
                            )),
                        },
                        Err(error) => Err(format!(
                            "Migration {} applied but failed to persist migration history: {}",
                            version, error
                        )),
                    }
                }
                Err(error) => Err(error),
            };

            // Build result based on execution outcome
            let result = match &migration_result {
                Ok(()) => MigrationResult {
                    version: version.clone(),
                    success: true,
                    error: None,
                    duration,
                },
                Err(err) => MigrationResult {
                    version: version.clone(),
                    success: false,
                    error: Some(err.clone()),
                    duration,
                },
            };

            results.push(result);
        }

        IpcResult::success(results)
    }

    /// Rollback a specific migration
    pub fn rollback_migration(&self, version: String) -> IpcResult<()> {
        let start = std::time::Instant::now();

        if !self
            .history
            .lock()
            .iter()
            .any(|record| record.version == version && record.success)
        {
            return IpcResult::error(
                format!("Migration {} has not been applied", version),
                ERROR_ROLLBACK_FAILED,
            );
        }

        // Execute rollback and get result
        let rollback_result = {
            let migrations_map = self.migrations.lock();
            let entry = match migrations_map.get(&version) {
                Some(e) => e,
                None => {
                    return IpcResult::error(
                        format!("Migration {} not found", version),
                        ERROR_MIGRATION_NOT_FOUND,
                    );
                }
            };

            if entry.rollback_fn.is_none() {
                return IpcResult::error(
                    format!("Migration {} does not have a rollback function", version),
                    ERROR_ROLLBACK_FAILED,
                );
            }

            // Execute rollback function while holding the lock
            // We can't clone the function, so we execute it here
            if let Some(ref rollback_fn) = entry.rollback_fn {
                rollback_fn()
            } else {
                Err("Rollback function not available".to_string())
            }
        };

        let duration = start.elapsed().as_millis() as u64;

        let base_record = match &rollback_result {
            Ok(()) => MigrationRecord {
                version: version.clone(),
                timestamp: chrono_timestamp(),
                success: true,
                error: None,
                duration: Some(duration),
            },
            Err(err) => MigrationRecord {
                version: version.clone(),
                timestamp: chrono_timestamp(),
                success: false,
                error: Some(err.clone()),
                duration: Some(duration),
            },
        };

        let current_history = self.history.lock().clone();
        let mut next_history = current_history.clone();
        next_history.push(base_record);

        let persistence_result = match &rollback_result {
            Ok(()) => {
                let mut applied_versions: Vec<String> = current_history
                    .iter()
                    .filter(|record| record.success)
                    .map(|record| record.version.clone())
                    .collect();
                applied_versions.sort_by(|a, b| compare_versions(a, b));
                applied_versions.dedup();

                let previous_version = applied_versions
                    .iter()
                    .position(|entry| entry == &version)
                    .and_then(|index| index.checked_sub(1))
                    .and_then(|index| applied_versions.get(index).cloned())
                    .unwrap_or_else(|| "0.0.0".to_string());

                self.write_history_records(&next_history)
                    .and_then(|_| self.set_schema_version_result(previous_version))
            }
            Err(_) => self.write_history_records(&next_history),
        };

        if let Err(error) = persistence_result {
            let mut failure_history = current_history;
            failure_history.push(MigrationRecord {
                version: version.clone(),
                timestamp: chrono_timestamp(),
                success: false,
                error: Some(format!("Rollback persistence failed: {}", error)),
                duration: Some(duration),
            });
            let _ = self.write_history_records(&failure_history);
            *self.history.lock() = failure_history;
            return IpcResult::error(error, ERROR_ROLLBACK_FAILED);
        }

        *self.history.lock() = next_history;

        match rollback_result {
            Ok(()) => IpcResult::success(()),
            Err(err) => IpcResult::error(err, ERROR_ROLLBACK_FAILED),
        }
    }
}

// ==================== Helper Functions ====================

/// Compare two version strings
/// Returns: -1 if v1 < v2, 0 if v1 == v2, 1 if v1 > v2
fn compare_versions(v1: &str, v2: &str) -> std::cmp::Ordering {
    let parts1: Vec<&str> = v1.split('.').collect();
    let parts2: Vec<&str> = v2.split('.').collect();

    let max_len = parts1.len().max(parts2.len());

    for i in 0..max_len {
        let part1 = parts1.get(i).unwrap_or(&"0");
        let part2 = parts2.get(i).unwrap_or(&"0");

        let num1 = part1.parse::<u32>().unwrap_or(0);
        let num2 = part2.parse::<u32>().unwrap_or(0);

        match num1.cmp(&num2) {
            std::cmp::Ordering::Equal => continue,
            other => return other,
        }
    }

    std::cmp::Ordering::Equal
}

/// Convert version string to comparable parts tuple
fn version_to_parts(version: &str) -> (u32, u32, u32) {
    let parts: Vec<&str> = version.split('.').collect();
    let major = parts.first().and_then(|p| p.parse().ok()).unwrap_or(0);
    let minor = parts.get(1).and_then(|p| p.parse().ok()).unwrap_or(0);
    let patch = parts.get(2).and_then(|p| p.parse().ok()).unwrap_or(0);
    (major, minor, patch)
}

/// Get current ISO timestamp
fn chrono_timestamp() -> String {
    // Simple ISO 8601 timestamp without chrono dependency
    use std::time::{SystemTime, UNIX_EPOCH};

    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();

    let secs = duration.as_secs();
    format_datetime(secs)
}

/// Format Unix timestamp to ISO 8601
fn format_datetime(secs: u64) -> String {
    DateTime::<Utc>::from_timestamp(secs as i64, 0)
        .map(|datetime| datetime.to_rfc3339_opts(SecondsFormat::Secs, true))
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_string())
}

// ==================== Tests ====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compare_versions() {
        assert_eq!(
            compare_versions("1.0.0", "1.0.0"),
            std::cmp::Ordering::Equal
        );
        assert_eq!(compare_versions("1.0.0", "1.0.1"), std::cmp::Ordering::Less);
        assert_eq!(
            compare_versions("1.0.1", "1.0.0"),
            std::cmp::Ordering::Greater
        );
        assert_eq!(
            compare_versions("1.2.0", "1.10.0"),
            std::cmp::Ordering::Less
        );
        assert_eq!(
            compare_versions("2.0.0", "1.9.9"),
            std::cmp::Ordering::Greater
        );
    }

    #[test]
    fn test_version_to_parts() {
        assert_eq!(version_to_parts("1.2.3"), (1, 2, 3));
        assert_eq!(version_to_parts("0.0.0"), (0, 0, 0));
        assert_eq!(version_to_parts("2.10.5"), (2, 10, 5));
    }
}
