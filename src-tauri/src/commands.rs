use crate::browser_tab_manager::{BrowserBounds, BrowserTabInfo, BrowserTabManager};
use crate::tunnel::{TunnelConfig, TunnelSession};
use crate::migrations::{
    MigrationInfo, MigrationManager, MigrationRecord, MigrationResult, SchemaVersion,
};
use crate::pty::{PtyManager, SpawnOptions, TerminalInfo};
use crate::trackers::{CwdTracker, ExitCodeTracker, GitStatus, GitTracker, GitStatusDetail};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::ipc::{Channel, Response};
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

// ==================== Tunnel Commands ====================

#[tauri::command]
pub async fn tunnel_start(
    config: TunnelConfig,
    app_handle: AppHandle,
) -> Result<IpcResult<TunnelSession>, String> {
    crate::tunnel::tunnel_start(config, app_handle).await
}

#[tauri::command]
pub async fn tunnel_stop(
    tunnel_id: String,
    app_handle: AppHandle,
) -> Result<IpcResult<()>, String> {
    crate::tunnel::tunnel_stop(tunnel_id, app_handle).await
}

#[tauri::command]
pub async fn tunnel_get_status(
    tunnel_id: String,
) -> Result<IpcResult<Option<TunnelSession>>, String> {
    crate::tunnel::tunnel_get_status(tunnel_id).await
}

#[tauri::command]
pub async fn tunnel_list() -> Result<IpcResult<Vec<TunnelSession>>, String> {
    crate::tunnel::tunnel_list().await
}

// ==================== Terminal Commands ====================

/// Spawn a new terminal with binary data channel
///
/// The `on_data` channel uses Tauri 2's Channel API for
/// zero-overhead binary IPC. PTY output is sent as raw `Vec<u8>` via
/// `Response::new(bytes)`, arriving in JS as `ArrayBuffer` with no JSON
/// serialization overhead.
#[tauri::command]
pub async fn terminal_spawn(
    options: SpawnOptions,
    on_data: Channel<Response>,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Result<IpcResult<TerminalInfo>, String> {
    match pty_manager.spawn(options, Some(on_data)).await {
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

/// Take over control of a terminal, notifying other clients to suspend
#[tauri::command]
pub async fn terminal_takeover(
    terminal_id: String,
    client_type: String,
    app_handle: tauri::AppHandle,
) -> Result<IpcResult<()>, String> {
    let payload = serde_json::json!({
        "terminalId": terminal_id,
        "clientType": client_type,
    });
    // emit() to Tauri event bus.
    // The bridge in lib.rs automatically forwards this to all WebSocket clients.
    // Do NOT also call ws_server.emit_event() — that would cause double-emission.
    let _ = app_handle.emit("terminal-takeover", payload);
    Ok(IpcResult::success(()))
}

/// Set visibility state (affects polling behavior and PTY kill deferral)
#[tauri::command]
pub async fn terminal_set_visibility(
    request: SetVisibilityRequest,
    pty_manager: State<'_, Arc<PtyManager>>,
    cwd_tracker: State<'_, Arc<CwdTracker>>,
    git_tracker: State<'_, Arc<GitTracker>>,
) -> Result<IpcResult<()>, String> {
    pty_manager.set_hidden(!request.is_visible);
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

/// Open DevTools for a browser tab
#[tauri::command]
pub async fn browser_tab_open_devtools(
    tab_id: String,
    browser_manager: State<'_, Arc<BrowserTabManager>>,
) -> Result<IpcResult<()>, String> {
    match browser_manager.open_devtools(&tab_id) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "BROWSER_TAB_OPEN_DEVTOOLS_FAILED")),
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
    browser_manager: State<'_, Arc<BrowserTabManager>>,
) -> Result<(), String> {
    let caller_label = webview.label().to_string();
    if caller_label != tab_id {
        return Err(format!(
            "Browser tab report URL rejected: caller '{}' does not match payload '{}'",
            caller_label, tab_id
        ));
    }
    log::debug!("[BrowserTab] URL report: tab={} navigated", tab_id);
    browser_manager.invalidate_annotation_injected(&tab_id);
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
    browser_manager: State<'_, Arc<BrowserTabManager>>,
) -> Result<(), String> {
    let caller_label = webview.label().to_string();
    if caller_label != tab_id {
        return Err(format!(
            "Browser tab report loaded rejected: caller '{}' does not match payload '{}'",
            caller_label, tab_id
        ));
    }
    log::debug!("[BrowserTab] Loaded report: tab={}", tab_id);
    browser_manager.invalidate_annotation_injected(&tab_id);
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
#[allow(clippy::too_many_arguments)]
pub async fn browser_tab_report_region_captured(
    tab_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    viewport_width: f64,
    viewport_height: f64,
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
                "height": height,
                "viewportWidth": viewport_width,
                "viewportHeight": viewport_height,
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
    log::debug!("[BrowserTab] Title report: tab={}", tab_id);
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
        "[BrowserTab] Element captured: tab={} tag={} selector=<redacted>",
        tab_id, tag_name
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchMatch {
    pub line_number: usize,
    pub line_text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchResult {
    pub file_path: String,
    pub matches: Vec<FileSearchMatch>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchResponse {
    pub results: Vec<FileSearchResult>,
    pub truncated: bool,
    pub scanned_files: usize,
    pub failed_files: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchContentRequest {
    pub root_path: String,
    pub query: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchContentStreamRequest {
    pub root_path: String,
    pub query: String,
    pub search_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchContentCancelRequest {
    pub search_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchContentBatchEvent {
    pub search_id: String,
    pub results: Vec<FileSearchResult>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchContentDoneEvent {
    pub search_id: String,
    pub truncated: bool,
    pub scanned_files: usize,
    pub failed_files: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFileNamesRequest {
    pub root_path: String,
    pub query: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFileNamesResponse {
    pub files: Vec<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RgInfoResponse {
    pub sidecar_binary_name: String,
    pub resolved_path: String,
    pub source: String,
    pub exists: bool,
}

static SEARCH_PROCESSES: OnceLock<Mutex<HashMap<String, Arc<Mutex<Child>>>>> = OnceLock::new();
static RG_PATH_CACHE: OnceLock<String> = OnceLock::new();

fn search_processes() -> &'static Mutex<HashMap<String, Arc<Mutex<Child>>>> {
    SEARCH_PROCESSES.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(target_os = "windows")]
fn rg_sidecar_name() -> &'static str {
    "rg-x86_64-pc-windows-msvc.exe"
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn rg_sidecar_name() -> &'static str {
    "rg-aarch64-apple-darwin"
}

#[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
fn rg_sidecar_name() -> &'static str {
    "rg-x86_64-apple-darwin"
}

#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
fn rg_sidecar_name() -> &'static str {
    "rg-aarch64-unknown-linux-gnu"
}

#[cfg(all(target_os = "linux", target_arch = "arm"))]
fn rg_sidecar_name() -> &'static str {
    "rg-armv7-unknown-linux-gnueabihf"
}

#[cfg(all(target_os = "linux", not(any(target_arch = "aarch64", target_arch = "arm"))))]
fn rg_sidecar_name() -> &'static str {
    "rg-x86_64-unknown-linux-musl"
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn rg_sidecar_name() -> &'static str {
    "rg"
}

fn resolve_rg_path() -> (String, String) {
    let from_env = std::env::var("TERMUL_RG_PATH")
        .ok()
        .filter(|v| !v.trim().is_empty());
    if let Some(path) = from_env {
        let env_path = PathBuf::from(&path);
        if env_path.is_absolute() {
            return (path, "env".to_string());
        }

        if let Ok(cwd) = std::env::current_dir() {
            let direct = cwd.join(&env_path);
            if direct.exists() && direct.is_file() {
                return (direct.to_string_lossy().to_string(), "env".to_string());
            }

            let from_src_tauri = cwd.join("src-tauri").join(&env_path);
            if from_src_tauri.exists() && from_src_tauri.is_file() {
                return (
                    from_src_tauri.to_string_lossy().to_string(),
                    "env".to_string(),
                );
            }
        }

        return (path, "env".to_string());
    }

    let binary = rg_sidecar_name();
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("src-tauri").join("bin").join(binary));
        candidates.push(cwd.join("bin").join(binary));
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.join(binary));
            candidates.push(exe_dir.join("../Resources").join(binary));
            candidates.push(exe_dir.join("../lib").join(binary));
        }
    }

    if let Some(found) = candidates
        .into_iter()
        .find(|path| path.exists() && path.is_file())
    {
        return (found.to_string_lossy().to_string(), "sidecar".to_string());
    }

    ("rg".to_string(), "path".to_string())
}

fn detect_rg_path() -> String {
    if let Some(cached) = RG_PATH_CACHE.get() {
        return cached.clone();
    }

    let (detected, _source) = resolve_rg_path();
    let _ = RG_PATH_CACHE.set(detected.clone());
    detected
}

fn build_search_args(query: &str, root_path: &str, max_matches_per_file: usize) -> Vec<String> {
    let mut args = vec![
        "--json".to_string(),
        "-F".to_string(),
        "-i".to_string(),
        "-n".to_string(),
        "--max-filesize".to_string(),
        "1M".to_string(),
        "--max-count".to_string(),
        max_matches_per_file.to_string(),
    ];

    for ignored in [
        "node_modules",
        ".git",
        ".next",
        ".cache",
        ".turbo",
        "dist",
        "build",
        ".output",
        ".nuxt",
        ".svelte-kit",
        "__pycache__",
        ".pytest_cache",
        "venv",
        ".env",
        "coverage",
        ".nyc_output",
    ] {
        args.push("-g".to_string());
        args.push(format!("!**/{}/**", ignored));
    }
    args.push("-g".to_string());
    args.push("!**/.env".to_string());

    args.push("--".to_string());
    args.push(query.to_string());
    args.push(root_path.to_string());
    args
}

#[tauri::command]
pub async fn search_get_rg_info() -> Result<IpcResult<RgInfoResponse>, String> {
    let (resolved_path, source) = resolve_rg_path();
    let exists = PathBuf::from(&resolved_path).exists();

    Ok(IpcResult::success(RgInfoResponse {
        sidecar_binary_name: rg_sidecar_name().to_string(),
        resolved_path,
        source,
        exists,
    }))
}

#[tauri::command]
pub async fn search_content_stream(
    request: SearchContentStreamRequest,
    app_handle: AppHandle,
) -> Result<IpcResult<()>, String> {
    let trimmed_query = request.query.trim().to_string();
    if trimmed_query.is_empty() {
        let _ = app_handle.emit(
            "search-content-done",
            SearchContentDoneEvent {
                search_id: request.search_id,
                truncated: false,
                scanned_files: 0,
                failed_files: 0,
                error: None,
            },
        );
        return Ok(IpcResult::success(()));
    }

    let max_files_with_matches: usize = 100;
    let max_matches_per_file: usize = 30;
    let args = build_search_args(&trimmed_query, &request.root_path, max_matches_per_file);

    let rg_path = detect_rg_path();
    let mut child = match Command::new(&rg_path)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            let _ = app_handle.emit(
                "search-content-done",
                SearchContentDoneEvent {
                    search_id: request.search_id,
                    truncated: false,
                    scanned_files: 0,
                    failed_files: 0,
                    error: Some(format!("rg spawn failed (path: {}): {}", rg_path, e)),
                },
            );
            return Ok(IpcResult::success(()));
        }
    };

    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            let _ = app_handle.emit(
                "search-content-done",
                SearchContentDoneEvent {
                    search_id: request.search_id,
                    truncated: false,
                    scanned_files: 0,
                    failed_files: 1,
                    error: Some("failed to capture rg stdout".to_string()),
                },
            );
            return Ok(IpcResult::success(()));
        }
    };

    let child_handle = Arc::new(Mutex::new(child));
    {
        let mut guard = search_processes().lock().map_err(|e| e.to_string())?;
        guard.insert(request.search_id.clone(), Arc::clone(&child_handle));
    }

    let search_id = request.search_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let reader = BufReader::new(stdout);
        let mut grouped: BTreeMap<String, Vec<FileSearchMatch>> = BTreeMap::new();
        let mut pending_matches: BTreeMap<String, Vec<FileSearchMatch>> = BTreeMap::new();
        let mut truncated = false;

        let flush_batch = |pending: &mut BTreeMap<String, Vec<FileSearchMatch>>, truncated: bool| {
            if pending.is_empty() {
                return;
            }
            let batch: Vec<FileSearchResult> = pending
                .iter()
                .map(|(file_path, matches)| FileSearchResult {
                    file_path: file_path.clone(),
                    matches: matches.clone(),
                })
                .collect();
            let _ = app_handle.emit(
                "search-content-batch",
                SearchContentBatchEvent {
                    search_id: search_id.clone(),
                    results: batch,
                    truncated,
                },
            );
            pending.clear();
        };

        for line in reader.lines() {
            let line = match line {
                Ok(v) => v,
                Err(_) => continue,
            };

            let parsed: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            if parsed.get("type").and_then(|v| v.as_str()) != Some("match") {
                continue;
            }

            let file_path = match parsed
                .get("data")
                .and_then(|d| d.get("path"))
                .and_then(|p| p.get("text"))
                .and_then(|t| t.as_str())
            {
                Some(p) => p.replace('\\', "/"),
                None => continue,
            };

            let line_number = match parsed
                .get("data")
                .and_then(|d| d.get("line_number"))
                .and_then(|n| n.as_u64())
            {
                Some(n) => n as usize,
                None => continue,
            };

            let line_text = parsed
                .get("data")
                .and_then(|d| d.get("lines"))
                .and_then(|l| l.get("text"))
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .trim_end_matches(['\r', '\n'])
                .to_string();

            if !grouped.contains_key(&file_path) {
                if grouped.len() >= max_files_with_matches {
                    truncated = true;
                    break;
                }
                grouped.insert(file_path.clone(), Vec::new());
            }

            if let Some(matches) = grouped.get_mut(&file_path) {
                if matches.len() >= max_matches_per_file {
                    truncated = true;
                    continue;
                }
                let new_match = FileSearchMatch {
                    line_number,
                    line_text,
                };
                matches.push(new_match.clone());
                pending_matches
                    .entry(file_path)
                    .or_default()
                    .push(new_match);
            }

            if pending_matches.values().map(Vec::len).sum::<usize>() >= 25 {
                flush_batch(&mut pending_matches, truncated);
            }
        }

        flush_batch(&mut pending_matches, truncated);

        if let Ok(mut child) = child_handle.lock() {
            let _ = child.try_wait().or_else(|_| child.wait().map(Some));
        }
        if let Ok(mut guard) = search_processes().lock() {
            guard.remove(&search_id);
        }

        let _ = app_handle.emit(
            "search-content-done",
            SearchContentDoneEvent {
                search_id,
                truncated,
                scanned_files: 0,
                failed_files: 0,
                error: None,
            },
        );
    });

    Ok(IpcResult::success(()))
}

#[tauri::command]
pub async fn search_content_cancel(
    request: SearchContentCancelRequest,
) -> Result<IpcResult<()>, String> {
    let mut guard = search_processes().lock().map_err(|e| e.to_string())?;
    if let Some(child_handle) = guard.remove(&request.search_id) {
        if let Ok(mut child) = child_handle.lock() {
            let _ = child.kill();
            let _ = child.try_wait().or_else(|_| child.wait().map(Some));
        }
    }
    Ok(IpcResult::success(()))
}

#[tauri::command]
pub async fn search_file_names(
    request: SearchFileNamesRequest,
) -> Result<IpcResult<SearchFileNamesResponse>, String> {
    let trimmed_query = request.query.trim().to_lowercase();
    if trimmed_query.is_empty() {
        return Ok(IpcResult::success(SearchFileNamesResponse {
            files: vec![],
            truncated: false,
        }));
    }

    let mut stack = vec![request.root_path];
    let mut matches: Vec<String> = Vec::new();
    let mut truncated = false;
    let max_files = 100;

    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            let file_name = match path.file_name().and_then(|n| n.to_str()) {
                Some(name) => name,
                None => continue,
            };

            if [
                "node_modules",
                ".git",
                ".next",
                ".cache",
                ".turbo",
                "dist",
                "build",
                ".output",
                ".nuxt",
                ".svelte-kit",
                "__pycache__",
                ".pytest_cache",
                "venv",
                ".env",
                "coverage",
                ".nyc_output",
            ]
            .contains(&file_name)
            {
                continue;
            }

            if path.is_dir() {
                stack.push(path.to_string_lossy().to_string());
                continue;
            }

            if file_name.to_lowercase().contains(&trimmed_query) {
                matches.push(path.to_string_lossy().replace('\\', "/"));
                if matches.len() >= max_files {
                    truncated = true;
                    break;
                }
            }
        }

        if truncated {
            break;
        }
    }

    Ok(IpcResult::success(SearchFileNamesResponse {
        files: matches,
        truncated,
    }))
}

#[tauri::command]
pub async fn search_content(
    request: SearchContentRequest,
) -> Result<IpcResult<FileSearchResponse>, String> {
    let trimmed_query = request.query.trim();
    if trimmed_query.is_empty() {
        return Ok(IpcResult::success(FileSearchResponse {
            results: vec![],
            truncated: false,
            scanned_files: 0,
            failed_files: 0,
        }));
    }

    let max_files_with_matches: usize = 100;
    let max_matches_per_file: usize = 30;

    let args = build_search_args(trimmed_query, &request.root_path, max_matches_per_file);

    let rg_path = detect_rg_path();
    let output = Command::new(&rg_path).args(args).output();
    let output = match output {
        Ok(o) => o,
        Err(e) => {
            return Ok(IpcResult::error(
                format!("rg spawn failed (path: {}): {}", rg_path, e),
                "SEARCH_ERROR",
            ))
        }
    };

    let code = output.status.code().unwrap_or(0);
    if code > 1 {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Ok(IpcResult::error(
            format!("rg failed ({}): {}", code, stderr),
            "SEARCH_ERROR",
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut grouped: BTreeMap<String, Vec<FileSearchMatch>> = BTreeMap::new();
    let mut truncated = false;

    for line in stdout.lines() {
        let parsed: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if parsed.get("type").and_then(|v| v.as_str()) != Some("match") {
            continue;
        }

        let file_path = match parsed
            .get("data")
            .and_then(|d| d.get("path"))
            .and_then(|p| p.get("text"))
            .and_then(|t| t.as_str())
        {
            Some(p) => p.replace('\\', "/"),
            None => continue,
        };

        let line_number = match parsed
            .get("data")
            .and_then(|d| d.get("line_number"))
            .and_then(|n| n.as_u64())
        {
            Some(n) => n as usize,
            None => continue,
        };

        let line_text = parsed
            .get("data")
            .and_then(|d| d.get("lines"))
            .and_then(|l| l.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .trim_end_matches(['\r', '\n'])
            .to_string();

        if !grouped.contains_key(&file_path) {
            if grouped.len() >= max_files_with_matches {
                truncated = true;
                break;
            }
            grouped.insert(file_path.clone(), Vec::new());
        }

        if let Some(matches) = grouped.get_mut(&file_path) {
            if matches.len() >= max_matches_per_file {
                truncated = true;
                continue;
            }
            matches.push(FileSearchMatch {
                line_number,
                line_text,
            });
        }
    }

    let results = grouped
        .into_iter()
        .map(|(file_path, matches)| FileSearchResult { file_path, matches })
        .collect();

    Ok(IpcResult::success(FileSearchResponse {
        results,
        truncated,
        scanned_files: 0,
        failed_files: 0,
    }))
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

// ==================== Git Commands ====================

/// Get git status for a repository
#[tauri::command]
pub async fn git_get_status(
    cwd: String,
) -> Result<Vec<GitStatusDetail>, String> {
    crate::trackers::git_tracker::git_get_status_detail(&cwd)
        .map_err(|e: String| e)
}

/// Get git diff for a file
#[tauri::command]
pub async fn git_get_diff(
    cwd: String,
    path: String,
) -> Result<String, String> {
    crate::trackers::git_tracker::git_get_diff(&cwd, &path)
        .map_err(|e: String| e)
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
