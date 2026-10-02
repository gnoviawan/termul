use super::IpcResult;
use crate::browser_tab_manager::{BrowserBounds, BrowserTabInfo, BrowserTabManager};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State, Webview};

/// Validate that the caller webview matches the expected tab_id.
/// This prevents cross-tab command injection where a malicious webview
/// could emit events for other tabs.
fn validate_browser_tab_caller(webview: &Webview, expected_tab_id: &str) -> Result<(), String> {
    let caller_label = webview.label();
    if caller_label != expected_tab_id {
        log::warn!(
            "[Security] Browser tab command rejected: caller '{}' does not match expected '{}'",
            caller_label,
            expected_tab_id
        );
        return Err(format!(
            "Browser tab command rejected: caller '{}' does not match expected '{}'",
            caller_label, expected_tab_id
        ));
    }
    Ok(())
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
    match browser_manager.create(tab_id, url, bounds).await {
        Ok(mut info) => {
            // If the tab was opened on behalf of an agent (pending agent
            // request), flag it so the renderer shows the Agent badge and
            // the automation host tracks its lifetime.
            if crate::browser_automation::tab_created(&info.id) {
                browser_manager.set_agent_controlled(&info.id, true);
                info.agent_controlled = true;
                log::info!("[BrowserTab] tab {} marked agent-controlled", info.id);
            }
            Ok(IpcResult::success(info))
        }
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
        Ok(()) => {
            crate::browser_automation::tab_closed(&tab_id);
            Ok(IpcResult::success(()))
        }
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

/// Open DevTools for a browser tab.
///
/// Debug-gated: the real implementation calls `BrowserTabManager::open_devtools`
/// (which opens the webview inspector). In release builds the command is a
/// stub that returns `Ok(IpcResult::error("DevTools disabled in production",
/// ...))` so the browser-tab devtools path is fully blocked in prod — mirrors
/// the existing `toggle_devtools` cfg-gate pattern in `lib.rs`. P13: the
/// `BrowserTabManager::open_devtools` method only exists in debug builds (no
/// release stub → no dead_code). The TS side also hides the Debug Console
/// button in prod, so a user never reaches the release stub.
#[cfg(debug_assertions)]
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

#[cfg(not(debug_assertions))]
#[tauri::command]
pub async fn browser_tab_open_devtools(
    _tab_id: String,
    _browser_manager: State<'_, Arc<BrowserTabManager>>,
) -> Result<IpcResult<()>, String> {
    Ok(IpcResult::error(
        "DevTools disabled in production".to_string(),
        "BROWSER_TAB_OPEN_DEVTOOLS_DISABLED",
    ))
}

/// Inject agentation toolbar into a browser tab webview (on-demand).
/// Called from the browser controls UI button.
#[tauri::command]
pub async fn browser_tab_inject_agentation(
    tab_id: String,
    browser_manager: State<'_, Arc<BrowserTabManager>>,
) -> Result<IpcResult<()>, String> {
    if !browser_manager.is_agentation_enabled() {
        log::info!(
            "[BrowserTab] Agentation injection rejected — feature disabled for tab={}",
            tab_id
        );
        return Ok(IpcResult::error(
            "Agentation is disabled".to_string(),
            "AGENTATION_DISABLED",
        ));
    }
    match browser_manager.inject_agentation_toolbar(&tab_id) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "BROWSER_TAB_INJECT_AGENTATION_FAILED")),
    }
}

/// Report URL from browser tab webview (called by injected JS poller)
#[tauri::command]
pub async fn browser_tab_report_url(
    tab_id: String,
    url: String,
    app_handle: AppHandle,
    webview: Webview,
    _browser_manager: State<'_, Arc<BrowserTabManager>>,
) -> Result<(), String> {
    validate_browser_tab_caller(&webview, &tab_id)?;
    log::debug!("[BrowserTab] URL report: tab={} navigated", tab_id);
    // Invalidate stored @eN refs held by agent automation for this tab.
    crate::browser_automation::tab_navigated(&tab_id);
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
    validate_browser_tab_caller(&webview, &tab_id)?;
    log::info!(
        "[BrowserTab] Loaded report: tab={} agentation_enabled={}",
        tab_id,
        browser_manager.is_agentation_enabled()
    );
    // Inject agentation toolbar after page load (the library accesses
    // document.head at module top-level, so it must run after DOM ready).
    if browser_manager.is_agentation_enabled() {
        log::info!(
            "[BrowserTab] Injecting agentation toolbar for tab={}",
            tab_id
        );
        if let Err(e) = browser_manager.inject_agentation_toolbar(&tab_id) {
            log::warn!(
                "[BrowserTab] Agentation toolbar injection failed for tab={}: {}",
                tab_id,
                e
            );
        }
    }
    app_handle
        .emit(
            "browser-tab-loaded",
            serde_json::json!({ "browserTabId": tab_id }),
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Return channel for the agent eval bridge: injected scripts post their
/// result back here. Caller-validated to the originating tab so a page in
/// one tab can't resolve another tab's pending eval.
#[tauri::command]
pub async fn browser_agent_eval_result(
    tab_id: String,
    nonce: String,
    ok: bool,
    value: Option<String>,
    webview: Webview,
) -> Result<(), String> {
    validate_browser_tab_caller(&webview, &tab_id)?;
    crate::browser_automation::eval_resolved(&nonce, ok, value);
    Ok(())
}

/// Renderer response to an `acp:browser_consent_request` prompt. Restricted
/// to the main webview — browser tabs share the app-wide event channel and
/// could otherwise observe the request id and self-grant consent.
#[tauri::command]
pub async fn browser_consent_respond(
    request_id: String,
    allowed: bool,
    webview: Webview,
) -> Result<(), String> {
    if webview.label() != "main" {
        log::warn!(
            "[Security] browser_consent_respond rejected from '{}'",
            webview.label()
        );
        return Err("consent must come from the main window".to_string());
    }
    if !crate::browser_automation::consent_responded(&request_id, allowed) {
        return Err("unknown or expired consent request".to_string());
    }
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
    validate_browser_tab_caller(&webview, &tab_id)?;
    log::debug!("[BrowserTab] Title report: tab={}", tab_id);
    app_handle
        .emit(
            "browser-tab-title-changed",
            serde_json::json!({ "browserTabId": tab_id, "title": title }),
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}
