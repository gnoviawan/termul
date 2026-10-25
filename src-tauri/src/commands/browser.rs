use super::IpcResult;
use crate::browser_tab_manager::{BrowserBounds, BrowserTabInfo, BrowserTabManager};
use std::sync::Arc;
use tauri::{State, Webview};

// ==================== Browser Tab Commands ====================

/// Create a browser tab: the tab registry validates the label (a
/// `tab-<uuid>` the renderer names, or an agent tab the host asked for),
/// builds the webview and admits it once the engine confirmed it.
#[tauri::command]
pub async fn browser_tab_create(
    tab_id: String,
    url: String,
    bounds: BrowserBounds,
) -> Result<IpcResult<BrowserTabInfo>, String> {
    match crate::browser_automation::create_tab(&tab_id, &url, bounds).await {
        Ok(view) => Ok(IpcResult::success(BrowserTabInfo {
            id: view.tab_id,
            url: view.url,
            title: view.title,
            agent_controlled: view.agent_controlled,
        })),
        Err(e) => Ok(IpcResult::error(e.message, e.code)),
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

/// Close a browser tab through the registry; resolves once the engine
/// destroyed the webview. Closing an agent tab ends the agent's control.
#[tauri::command]
pub async fn browser_tab_destroy(tab_id: String) -> Result<IpcResult<()>, String> {
    crate::browser_automation::destroy_tab(&tab_id).await;
    Ok(IpcResult::success(()))
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

/// Only the `main` webview answers host consent and presses Stop: browser
/// tabs share the app-wide event channel and could otherwise observe a
/// ticket id and approve themselves.
fn require_main_webview(webview: &Webview, command: &str) -> Result<(), String> {
    if webview.label() == "main" {
        return Ok(());
    }
    log::warn!("[Security] {command} rejected from a non-main webview");
    Err(format!("{command} must come from the main window"))
}

/// Desktop answer to a host-originated browser consent ticket (`host:`
/// request id). `option_id: None` denies.
#[tauri::command]
pub async fn browser_ticket_respond(
    request_id: String,
    option_id: Option<String>,
    webview: Webview,
    tickets: State<'_, Arc<crate::acp::host_ticket::HostTickets>>,
) -> Result<IpcResult<()>, String> {
    use crate::acp::host_ticket::{AnswerError, Approver};
    require_main_webview(&webview, "browser_ticket_respond")?;
    Ok(
        match tickets.answer(Approver::Desktop, &request_id, option_id.as_deref()) {
            Ok(_) => IpcResult::success(()),
            Err(err) => {
                let code = match err {
                    AnswerError::NotFound => "TICKET_NOT_FOUND",
                    AnswerError::AlreadyResolved => "TICKET_ALREADY_RESOLVED",
                    AnswerError::Unqualified => "TICKET_UNQUALIFIED",
                    AnswerError::TooEarly => "TICKET_TOO_EARLY",
                    AnswerError::InvalidOption => "TICKET_INVALID_OPTION",
                };
                IpcResult::error(err.as_str(), code)
            }
        },
    )
}

/// Stop agent browsing for a session until the user's next prompt turn.
#[tauri::command]
pub async fn browser_stop(session_id: String, webview: Webview) -> Result<IpcResult<()>, String> {
    require_main_webview(&webview, "browser_stop")?;
    Ok(match crate::browser_automation::stop_session(&session_id) {
        Some(_) => IpcResult::success(()),
        None => IpcResult::error("browser automation is not running", "BROWSER_STOP_UNAVAILABLE"),
    })
}
