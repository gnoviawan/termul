//! Windows-only WebView2 CDP path: `ICoreWebView2.CallDevToolsProtocolMethod`
//! in-process — no debug port, no sockets. `ICoreWebView2` is !Send/!Sync, so
//! every call is issued inside `with_webview` (the dispatcher runs the
//! closure on the UI thread that owns the COM object); the completion
//! handler forwards the result through a oneshot to the awaiting task.
//! Used for trusted input (`Input.dispatch*`), `Page.captureScreenshot`,
//! and `Runtime.evaluate` — the trusted Windows eval transport (the JS eval
//! bridge remains the fallback there and the only path on other platforms,
//! which share it).

use serde_json::Value;
use std::sync::Arc;
use std::sync::atomic::AtomicU8;
use std::sync::atomic::Ordering;
use tokio::sync::oneshot;
use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
use windows_core::HSTRING;

use super::BrowserError;
use super::cdp_protocol::{
    CALL_ISSUED, CALL_PENDING, CdpEvalError, CdpEvalFailureKind, EVALUATE_METHOD, evaluate_params,
    issue_timeout_kind, parse_evaluate_result,
};
use crate::browser_tab_manager::BrowserTabManager;

/// Issue a CDP call on the UI thread; resolve with the raw JSON result.
/// Every failure is classified: issue-phase errors mean the command was
/// never delivered (bridge-retry-safe), result-phase errors mean the page
/// may have run the script (terminal).
async fn call(
    tabs: &BrowserTabManager,
    tab_id: &str,
    method: &'static str,
    params: Value,
) -> Result<Value, CdpEvalError> {
    let webview = tabs.webview(tab_id).map_err(|_| {
        // The command cannot even be addressed — never delivered.
        CdpEvalError::new(
            CdpEvalFailureKind::NotDelivered,
            BrowserError::new(
                super::ERR_TAB_NOT_FOUND,
                format!("tab '{tab_id}' not found"),
            ),
        )
    })?;
    // Result channel (async completion) + issue channel (did the call go
    // out). Both are tokio oneshots — a blocking recv here would stall the
    // single-threaded host-MCP runtime while it waits on the UI thread.
    let (result_tx, result_rx) = oneshot::channel::<Result<String, String>>();
    let (issue_tx, issue_rx) = oneshot::channel::<Result<(), String>>();
    let params_json = params.to_string();
    let state = Arc::new(AtomicU8::new(CALL_PENDING));
    let issue_state = state.clone();
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
            // The caller may already have given up (issue-phase timeout) and
            // run the bridge fallback — issuing now would execute the script
            // a second time.
            if issue_state
                .compare_exchange(CALL_PENDING, CALL_ISSUED, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
            {
                return;
            }
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
        .map_err(|e| {
            CdpEvalError::new(
                CdpEvalFailureKind::NotDelivered,
                BrowserError::internal(format!("with_webview: {e}")),
            )
        })?;
    // Issue phase (did the call go out, or was the closure cancelled before
    // issuing?): a cancelled closure is retry-safe; a command that was
    // already issued is terminal from this point on.
    tokio::time::timeout(std::time::Duration::from_secs(5), issue_rx)
        .await
        .map_err(|_| {
            let kind = issue_timeout_kind(&state);
            CdpEvalError::new(
                kind,
                BrowserError::new(super::ERR_TIMEOUT, "webview dispatch timed out"),
            )
        })?
        .map_err(|_| {
            CdpEvalError::new(
                CdpEvalFailureKind::NotDelivered,
                BrowserError::internal("webview channel dropped"),
            )
        })?
        .map_err(|e| {
            CdpEvalError::new(
                CdpEvalFailureKind::NotDelivered,
                BrowserError::internal(e),
            )
        })?;
    // Result phase: the command was issued, so a timeout or dropped
    // completion means the page script may have run — terminal.
    let json = tokio::time::timeout(std::time::Duration::from_secs(15), result_rx)
        .await
        .map_err(|_| {
            CdpEvalError::new(
                CdpEvalFailureKind::NoReply,
                BrowserError::new(super::ERR_TIMEOUT, "cdp round trip timed out"),
            )
        })?
        .map_err(|_| {
            CdpEvalError::new(
                CdpEvalFailureKind::NoReply,
                BrowserError::internal("cdp channel dropped"),
            )
        })?
        .map_err(|e| {
            CdpEvalError::new(
                CdpEvalFailureKind::ProtocolError,
                BrowserError::internal(e),
            )
        })?;
    serde_json::from_str(&json).map_err(|e| {
        CdpEvalError::new(
            CdpEvalFailureKind::MalformedReply,
            BrowserError::internal(format!("cdp json: {e}")),
        )
    })
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
            serde_json::json!({
                "type": kind,
                "x": x,
                "y": y,
                "button": "left",
                "clickCount": 1,
            }),
        )
        .await
        .map_err(|e| e.error)?;
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
        serde_json::json!({ "format": "png" }),
    )
    .await
    .map_err(|e| e.error)?;
    let b64 = out
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| BrowserError::internal("screenshot: no data field"))?;
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| BrowserError::internal(format!("screenshot decode: {e}")))
}

/// `Runtime.evaluate` with `returnByValue` + `awaitPromise` — the trusted
/// Windows eval transport. `expression` is the same page script the JS-eval
/// bridge runs (minus its reply wrapper); CDP returns the completion value
/// directly, so the page never needs `__TAURI_INTERNALS__` IPC — whose
/// reply path failed for every observation call on mounted agent tabs in
/// the 2026-10-03 field session (agent-tab context/timing; root cause
/// unconfirmed — see the spec's bug evidence).
pub async fn evaluate(
    tabs: &BrowserTabManager,
    tab_id: &str,
    expression: &str,
) -> Result<Value, CdpEvalError> {
    let out = call(
        tabs,
        tab_id,
        EVALUATE_METHOD,
        evaluate_params(expression),
    )
    .await?;
    parse_evaluate_result(&out)
}
