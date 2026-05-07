use crate::browser_tab_manager::{BrowserBounds, BrowserTabInfo, BrowserTabManager};
use crate::migrations::{
    MigrationInfo, MigrationManager, MigrationRecord, MigrationResult, SchemaVersion,
};
use crate::pty::{PtyManager, SpawnOptions, TerminalInfo};
use crate::trackers::{CwdTracker, ExitCodeTracker, GitStatus, GitTracker};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State, Webview};

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

// ==================== Browser Tab Commands ====================

/// Create a new browser tab webview
#[tauri::command]
pub async fn browser_tab_create(
    tab_id: String,
    url: String,
    bounds: BrowserBounds,
    browser_manager: State<'_, Arc<BrowserTabManager>>,
) -> Result<IpcResult<BrowserTabInfo>, String> {
    match browser_manager.create(tab_id, url, bounds) {
        Ok(info) => Ok(IpcResult::success(info)),
        Err(e) => Ok(IpcResult::error(e, "BROWSER_TAB_CREATE_FAILED")),
    }
}

/// Navigate a browser tab to a new URL
#[tauri::command]
pub async fn browser_tab_navigate(
    tab_id: String,
    url: String,
    browser_manager: State<'_, Arc<BrowserTabManager>>,
) -> Result<IpcResult<()>, String> {
    match browser_manager.navigate(&tab_id, url) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "BROWSER_TAB_NAVIGATE_FAILED")),
    }
}

/// Resize/reposition a browser tab webview
#[tauri::command]
pub async fn browser_tab_resize(
    tab_id: String,
    bounds: BrowserBounds,
    browser_manager: State<'_, Arc<BrowserTabManager>>,
) -> Result<IpcResult<()>, String> {
    match browser_manager.resize(&tab_id, bounds) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "BROWSER_TAB_RESIZE_FAILED")),
    }
}

/// Show a browser tab webview
#[tauri::command]
pub async fn browser_tab_show(
    tab_id: String,
    browser_manager: State<'_, Arc<BrowserTabManager>>,
) -> Result<IpcResult<()>, String> {
    match browser_manager.show(&tab_id) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "BROWSER_TAB_SHOW_FAILED")),
    }
}

/// Hide a browser tab webview
#[tauri::command]
pub async fn browser_tab_hide(
    tab_id: String,
    browser_manager: State<'_, Arc<BrowserTabManager>>,
) -> Result<IpcResult<()>, String> {
    match browser_manager.hide(&tab_id) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "BROWSER_TAB_HIDE_FAILED")),
    }
}

/// Destroy a browser tab webview
#[tauri::command]
pub async fn browser_tab_destroy(
    tab_id: String,
    browser_manager: State<'_, Arc<BrowserTabManager>>,
) -> Result<IpcResult<()>, String> {
    match browser_manager.destroy(&tab_id) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "BROWSER_TAB_DESTROY_FAILED")),
    }
}

/// Go back in browser tab history
#[tauri::command]
pub async fn browser_tab_go_back(
    tab_id: String,
    browser_manager: State<'_, Arc<BrowserTabManager>>,
) -> Result<IpcResult<()>, String> {
    match browser_manager.go_back(&tab_id) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "BROWSER_TAB_GO_BACK_FAILED")),
    }
}

/// Go forward in browser tab history
#[tauri::command]
pub async fn browser_tab_go_forward(
    tab_id: String,
    browser_manager: State<'_, Arc<BrowserTabManager>>,
) -> Result<IpcResult<()>, String> {
    match browser_manager.go_forward(&tab_id) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "BROWSER_TAB_GO_FORWARD_FAILED")),
    }
}

/// Reload a browser tab
#[tauri::command]
pub async fn browser_tab_reload(
    tab_id: String,
    browser_manager: State<'_, Arc<BrowserTabManager>>,
) -> Result<IpcResult<()>, String> {
    match browser_manager.reload(&tab_id) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "BROWSER_TAB_RELOAD_FAILED")),
    }
}

/// Inject annotation overlay script into a browser tab
#[tauri::command]
pub async fn browser_tab_inject_annotation(
    tab_id: String,
    mode: String,
    browser_manager: State<'_, Arc<BrowserTabManager>>,
) -> Result<IpcResult<()>, String> {
    match browser_manager.inject_annotation_script(&tab_id, &mode) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "BROWSER_TAB_INJECT_ANNOTATION_FAILED")),
    }
}

/// Remove annotation overlay from a browser tab
#[tauri::command]
pub async fn browser_tab_remove_annotation_overlay(
    tab_id: String,
    browser_manager: State<'_, Arc<BrowserTabManager>>,
) -> Result<IpcResult<()>, String> {
    match browser_manager.remove_annotation_overlay(&tab_id) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "BROWSER_TAB_REMOVE_ANNOTATION_OVERLAY_FAILED")),
    }
}

/// Inject annotation markers into a browser tab webview
#[tauri::command]
pub async fn browser_tab_inject_annotation_markers(
    tab_id: String,
    annotations_json: String,
    selected_id: Option<String>,
    browser_manager: State<'_, Arc<BrowserTabManager>>,
) -> Result<IpcResult<()>, String> {
    match browser_manager.inject_annotation_markers(&tab_id, &annotations_json, selected_id.as_deref()) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "BROWSER_TAB_INJECT_ANNOTATION_MARKERS_FAILED")),
    }
}

/// Update annotation marker selection in a browser tab webview
#[tauri::command]
pub async fn browser_tab_update_annotation_marker_selection(
    tab_id: String,
    selected_id: Option<String>,
    browser_manager: State<'_, Arc<BrowserTabManager>>,
) -> Result<IpcResult<()>, String> {
    match browser_manager.update_annotation_marker_selection(&tab_id, selected_id.as_deref()) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "BROWSER_TAB_UPDATE_MARKER_SELECTION_FAILED")),
    }
}

/// Report URL from browser tab webview (called by injected JS poller)
#[tauri::command]
pub async fn browser_tab_report_url(
    tab_id: String,
    url: String,
    app_handle: AppHandle,
    webview: Webview,
) -> Result<(), String> {
    let caller_label = webview.label().to_string();
    if caller_label != tab_id {
        return Err(format!(
            "Browser tab report URL rejected: caller '{}' does not match payload '{}'",
            caller_label, tab_id
        ));
    }
    log::debug!("[BrowserTab] URL report: tab={} navigated", tab_id);
    app_handle
        .emit(
            "browser-tab-navigated",
            serde_json::json!({ "browserTabId": tab_id, "url": url }),
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Report page loaded from browser tab webview (called by injected JS poller)
#[tauri::command]
pub async fn browser_tab_report_loaded(
    tab_id: String,
    app_handle: AppHandle,
    webview: Webview,
) -> Result<(), String> {
    let caller_label = webview.label().to_string();
    if caller_label != tab_id {
        return Err(format!(
            "Browser tab report loaded rejected: caller '{}' does not match payload '{}'",
            caller_label, tab_id
        ));
    }
    log::debug!("[BrowserTab] Loaded report: tab={}", tab_id);
    app_handle
        .emit(
            "browser-tab-loaded",
            serde_json::json!({ "browserTabId": tab_id }),
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Report region captured from browser tab webview (called by injected annotation overlay)
#[tauri::command]
pub async fn browser_tab_report_region_captured(
    tab_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    app_handle: AppHandle,
    webview: Webview,
) -> Result<(), String> {
    let caller_label = webview.label().to_string();
    if caller_label != tab_id {
        return Err(format!(
            "Browser tab report region captured rejected: caller '{}' does not match payload '{}'",
            caller_label, tab_id
        ));
    }
    log::debug!(
        "[BrowserTab] Region captured: tab={} x={} y={} w={} h={}",
        tab_id, x, y, width, height
    );
    app_handle
        .emit(
            "browser-tab-region-captured",
            serde_json::json!({
                "browserTabId": tab_id,
                "x": x,
                "y": y,
                "width": width,
                "height": height
            }),
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Report title change from browser tab webview (called by injected JS poller)
#[tauri::command]
pub async fn browser_tab_report_title(
    tab_id: String,
    title: String,
    app_handle: AppHandle,
    webview: Webview,
) -> Result<(), String> {
    let caller_label = webview.label().to_string();
    if caller_label != tab_id {
        return Err(format!(
            "Browser tab report title rejected: caller '{}' does not match payload '{}'",
            caller_label, tab_id
        ));
    }
    log::debug!("[BrowserTab] Title report: tab={} title={}", tab_id, title);
    app_handle
        .emit(
            "browser-tab-title-changed",
            serde_json::json!({ "browserTabId": tab_id, "title": title }),
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Report element captured from browser tab webview (called by injected annotation overlay)
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn browser_tab_report_element_captured(
    tab_id: String,
    url: String,
    title: String,
    viewport_width: f64,
    viewport_height: f64,
    tag_name: String,
    selector: String,
    selector_confidence: String,
    attributes: serde_json::Value,
    text_content: String,
    text_truncated: bool,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    app_handle: AppHandle,
    webview: Webview,
) -> Result<(), String> {
    let caller_label = webview.label().to_string();
    if caller_label != tab_id {
        return Err(format!(
            "Browser tab report element captured rejected: caller '{}' does not match payload '{}'",
            caller_label, tab_id
        ));
    }

    let attributes = attributes
        .as_object()
        .cloned()
        .ok_or_else(|| "Browser tab report element captured rejected: attributes must be an object".to_string())?;

    log::debug!(
        "[BrowserTab] Element captured: tab={} tag={} selector={}",
        tab_id, tag_name, selector
    );
    app_handle
        .emit(
            "browser-tab-element-captured",
            serde_json::json!({
                "browserTabId": tab_id,
                "url": url,
                "title": title,
                "viewportWidth": viewport_width,
                "viewportHeight": viewport_height,
                "tagName": tag_name,
                "selector": selector,
                "selectorConfidence": selector_confidence,
                "attributes": attributes,
                "textContent": text_content,
                "textTruncated": text_truncated,
                "boundingBox": {
                    "x": x,
                    "y": y,
                    "width": width,
                    "height": height
                }
            }),
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Report annotation marker clicked from browser tab webview
#[tauri::command]
pub async fn browser_tab_report_annotation_marker_clicked(
    tab_id: String,
    annotation_id: String,
    app_handle: AppHandle,
    webview: Webview,
) -> Result<(), String> {
    let caller_label = webview.label().to_string();
    if caller_label != tab_id {
        return Err(format!(
            "Browser tab report annotation marker clicked rejected: caller '{}' does not match payload '{}'",
            caller_label, tab_id
        ));
    }
    log::debug!(
        "[BrowserTab] Annotation marker clicked: tab={} annotation_id={}",
        tab_id, annotation_id
    );
    app_handle
        .emit(
            "browser-tab-annotation-marker-clicked",
            serde_json::json!({
                "browserTabId": tab_id,
                "annotationId": annotation_id,
            }),
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

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
