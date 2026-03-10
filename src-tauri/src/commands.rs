use crate::migrations::{
    MigrationInfo, MigrationManager, MigrationRecord, MigrationResult, SchemaVersion,
};
use crate::pty::{PtyManager, SpawnOptions, TerminalInfo};
use crate::trackers::{CwdTracker, ExitCodeTracker, GitStatus, GitTracker};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;

/// IPC Result pattern
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IpcResult<T> {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

impl<T> IpcResult<T> {
    pub fn success(data: T) -> Self {
        Self {
            success: true,
            data: Some(data),
            error: None,
            code: None,
        }
    }

    pub fn error(error: impl Into<String>, code: impl Into<String>) -> Self {
        Self {
            success: false,
            data: None,
            error: Some(error.into()),
            code: Some(code.into()),
        }
    }
}

/// Terminal visibility state
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetVisibilityRequest {
    pub is_visible: bool,
}

/// Orphan detection settings
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanDetectionSettings {
    pub enabled: bool,
    pub timeout_minutes: Option<u64>,
}

/// Renderer ref request
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererRefRequest {
    pub terminal_id: String,
    pub renderer_id: String,
}

// ==================== Terminal Commands ====================

/// Spawn a new terminal
#[tauri::command]
pub async fn terminal_spawn(
    options: SpawnOptions,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Result<IpcResult<TerminalInfo>, String> {
    match pty_manager.spawn(options).await {
        Ok(info) => Ok(IpcResult::success(info)),
        Err(e) => Ok(IpcResult::error(e, "SPAWN_FAILED")),
    }
}

/// Write data to a terminal
#[tauri::command]
pub async fn terminal_write(
    terminal_id: String,
    data: String,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Result<IpcResult<()>, String> {
    match pty_manager.write(&terminal_id, &data).await {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "WRITE_FAILED")),
    }
}

/// Resize a terminal
#[tauri::command]
pub async fn terminal_resize(
    terminal_id: String,
    cols: u16,
    rows: u16,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Result<IpcResult<()>, String> {
    match pty_manager.resize(&terminal_id, cols, rows).await {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "RESIZE_FAILED")),
    }
}

/// Kill a terminal
#[tauri::command]
pub async fn terminal_kill(
    terminal_id: String,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Result<IpcResult<()>, String> {
    match pty_manager.kill(&terminal_id).await {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "KILL_FAILED")),
    }
}

/// Get the current working directory for a terminal
#[tauri::command]
pub async fn terminal_get_cwd(
    terminal_id: String,
    cwd_tracker: State<'_, Arc<CwdTracker>>,
) -> Result<IpcResult<Option<String>>, String> {
    let cwd = cwd_tracker.get_cwd(&terminal_id);
    Ok(IpcResult::success(cwd))
}

/// Get the git branch for a terminal
#[tauri::command]
pub async fn terminal_get_git_branch(
    terminal_id: String,
    git_tracker: State<'_, Arc<GitTracker>>,
) -> Result<IpcResult<Option<String>>, String> {
    let branch = git_tracker.get_branch(&terminal_id);
    Ok(IpcResult::success(branch))
}

/// Get the git status for a terminal
#[tauri::command]
pub async fn terminal_get_git_status(
    terminal_id: String,
    git_tracker: State<'_, Arc<GitTracker>>,
) -> Result<IpcResult<Option<GitStatus>>, String> {
    let status = git_tracker.get_status(&terminal_id);
    Ok(IpcResult::success(status))
}

/// Get the exit code for a terminal
#[tauri::command]
pub async fn terminal_get_exit_code(
    terminal_id: String,
    exit_code_tracker: State<'_, Arc<ExitCodeTracker>>,
) -> Result<IpcResult<Option<i32>>, String> {
    let exit_code = exit_code_tracker.get_exit_code(&terminal_id);
    Ok(IpcResult::success(exit_code))
}

/// Update orphan detection settings
#[tauri::command]
pub async fn terminal_update_orphan_detection(
    settings: OrphanDetectionSettings,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Result<IpcResult<()>, String> {
    pty_manager
        .update_orphan_detection_settings(settings.enabled, settings.timeout_minutes)
        .await;
    Ok(IpcResult::success(()))
}

/// Add a renderer reference to a terminal
#[tauri::command]
pub async fn terminal_add_renderer_ref(
    request: RendererRefRequest,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Result<IpcResult<()>, String> {
    match pty_manager.add_renderer_ref(&request.terminal_id, &request.renderer_id) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "TERMINAL_NOT_FOUND")),
    }
}

/// Remove a renderer reference from a terminal
#[tauri::command]
pub async fn terminal_remove_renderer_ref(
    request: RendererRefRequest,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Result<IpcResult<()>, String> {
    match pty_manager.remove_renderer_ref(&request.terminal_id, &request.renderer_id) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "TERMINAL_NOT_FOUND")),
    }
}

/// Set visibility state (affects polling behavior)
#[tauri::command]
pub async fn terminal_set_visibility(
    request: SetVisibilityRequest,
    cwd_tracker: State<'_, Arc<CwdTracker>>,
    git_tracker: State<'_, Arc<GitTracker>>,
) -> Result<IpcResult<()>, String> {
    cwd_tracker.set_visibility(request.is_visible);
    git_tracker.set_visibility(request.is_visible);
    Ok(IpcResult::success(()))
}

// ==================== Data Migration Commands ====================

/// Rollback request
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackRequest {
    pub version: String,
}

/// Get current schema version
#[tauri::command]
pub async fn data_migration_get_version(
    migration_manager: State<'_, Arc<MigrationManager>>,
) -> Result<IpcResult<String>, String> {
    Ok(migration_manager.get_current_schema_version())
}

/// Get schema version info (current and target)
#[tauri::command]
pub async fn data_migration_get_schema_info(
    migration_manager: State<'_, Arc<MigrationManager>>,
) -> Result<IpcResult<SchemaVersion>, String> {
    Ok(migration_manager.get_schema_version_info())
}

/// Get migration history
#[tauri::command]
pub async fn data_migration_get_history(
    migration_manager: State<'_, Arc<MigrationManager>>,
) -> Result<IpcResult<Vec<MigrationRecord>>, String> {
    Ok(migration_manager.get_migration_history())
}

/// Get all registered migrations
#[tauri::command]
pub async fn data_migration_get_registered(
    migration_manager: State<'_, Arc<MigrationManager>>,
) -> Result<IpcResult<Vec<MigrationInfo>>, String> {
    Ok(migration_manager.get_registered_migrations())
}

/// Run pending migrations
#[tauri::command]
pub async fn data_migration_run_migrations(
    migration_manager: State<'_, Arc<MigrationManager>>,
) -> Result<IpcResult<Vec<MigrationResult>>, String> {
    Ok(migration_manager.run_migrations())
}

/// Rollback to a specific version
#[tauri::command]
pub async fn data_migration_rollback(
    request: RollbackRequest,
    migration_manager: State<'_, Arc<MigrationManager>>,
) -> Result<IpcResult<()>, String> {
    Ok(migration_manager.rollback_migration(request.version))
}

/// Get available shells
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ipc_result_success() {
        let result: IpcResult<String> = IpcResult::success("test".to_string());
        assert!(result.success);
        assert_eq!(result.data, Some("test".to_string()));
        assert!(result.error.is_none());
        assert!(result.code.is_none());
    }

    #[test]
    fn test_ipc_result_error() {
        let result: IpcResult<String> = IpcResult::error("test error", "TEST_ERROR");
        assert!(!result.success);
        assert!(result.data.is_none());
        assert_eq!(result.error, Some("test error".to_string()));
        assert_eq!(result.code, Some("TEST_ERROR".to_string()));
    }
}
