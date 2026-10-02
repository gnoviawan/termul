//! Windows-only WebView2 CDP path: `ICoreWebView2.CallDevToolsProtocolMethod`
//! in-process — no debug port, no sockets. `ICoreWebView2` is !Send/!Sync, so
//! every call is issued inside `with_webview` (the dispatcher runs the
//! closure on the UI thread that owns the COM object); the completion
//! handler forwards the result through a oneshot to the awaiting task.
//! Used for trusted input (`Input.dispatch*`) and `Page.captureScreenshot`;
//! the JS eval bridge covers everything else so non-Windows adapters can
//! share it.

use serde_json::{json, Value};
use tokio::sync::oneshot;
use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
use windows_core::HSTRING;

use super::BrowserError;
use crate::browser_tab_manager::BrowserTabManager;

/// Issue a CDP call on the UI thread; resolve with the raw JSON result.
async fn call(
    tabs: &BrowserTabManager,
    tab_id: &str,
    method: &'static str,
    params: Value,
) -> Result<Value, BrowserError> {
    let webview = tabs.webview(tab_id).map_err(|_| {
        BrowserError::new(
            super::ERR_TAB_NOT_FOUND,
            format!("tab '{tab_id}' not found"),
        )
    })?;
    // Result channel (async completion) + issue channel (did the call go out).
    let (result_tx, result_rx) = oneshot::channel::<Result<String, String>>();
    let (issue_tx, issue_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let params_json = params.to_string();
    webview
        .with_webview(move |platform| {
            // SAFETY: runs on the UI thread that owns the WebView2 object;
            // the returned handle is used only within this closure's scope
            // (issuing the call synchronously) — WebView2 addrefs the
            // completion handler for the async round trip.
            let core = match unsafe { platform.controller().CoreWebView2() } {
                Ok(c) => c,
                Err(e) => {
                    let _ = issue_tx.send(Err(format!("CoreWebView2: {e}")));
                    return;
                }
            };
            // The handler must outlive the async call — WebView2 addrefs the
            // COM object it was given, so dropping our local binding is fine.
            let handler =
                CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |hr, json| {
                    let _ = result_tx.send(match hr {
                        Ok(()) => Ok(json),
                        Err(e) => Err(format!("cdp error: {e}")),
                    });
                    Ok(())
                }));
            let issued = unsafe {
                core.CallDevToolsProtocolMethod(
                    &HSTRING::from(method),
                    &HSTRING::from(params_json),
                    &handler,
                )
            };
            let _ = issue_tx.send(issued.map_err(|e| format!("CDP call failed: {e}")));
        })
        .map_err(|e| BrowserError::internal(format!("with_webview: {e}")))?;
    issue_rx
        .recv()
        .map_err(|_| BrowserError::internal("webview channel dropped"))?
        .map_err(BrowserError::internal)?;
    let json = tokio::time::timeout(std::time::Duration::from_secs(15), result_rx)
        .await
        .map_err(|_| BrowserError::new(super::ERR_TIMEOUT, "cdp round trip timed out"))?
        .map_err(|_| BrowserError::internal("cdp channel dropped"))?
        .map_err(BrowserError::internal)?;
    serde_json::from_str(&json).map_err(|e| BrowserError::internal(format!("cdp json: {e}")))
}

/// Trusted click at page viewport coords via `Input.dispatchMouseEvent`.
pub async fn click_at(
    tabs: &BrowserTabManager,
    tab_id: &str,
    x: f64,
    y: f64,
) -> Result<(), BrowserError> {
    for kind in ["mousePressed", "mouseReleased"] {
        call(
            tabs,
            tab_id,
            "Input.dispatchMouseEvent",
            json!({
                "type": kind,
                "x": x,
                "y": y,
                "button": "left",
                "clickCount": 1,
            }),
        )
        .await?;
    }
    Ok(())
}

/// `Page.captureScreenshot` → PNG bytes.
pub async fn capture_screenshot(
    tabs: &BrowserTabManager,
    tab_id: &str,
) -> Result<Vec<u8>, BrowserError> {
    let out = call(
        tabs,
        tab_id,
        "Page.captureScreenshot",
        json!({ "format": "png" }),
    )
    .await?;
    let b64 = out
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| BrowserError::internal("screenshot: no data field"))?;
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| BrowserError::internal(format!("screenshot decode: {e}")))
}
