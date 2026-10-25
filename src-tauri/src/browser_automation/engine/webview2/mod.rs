//! WebView2 adapter (Windows): in-process CDP through
//! `ICoreWebView2.CallDevToolsProtocolMethod` (no debug port, no sockets)
//! for isolated-world eval, trusted input and screenshots.
//!
//! `ICoreWebView2` is !Send/!Sync, so every call is issued inside
//! `with_webview` (the closure runs on the UI thread that owns the COM
//! object); the completion handler forwards the result through a oneshot
//! to the awaiting task.

mod dialogs;
mod downloads;
pub mod events;
pub mod input;
mod external_protocol;
pub mod observe;

use std::sync::Arc;

use serde_json::Value;
use tokio::sync::oneshot;
use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_11;
use windows_core::{Interface, HSTRING};

use super::assets::Script;
use super::cdp::{self, CdpMethod, CdpTransport};
use super::events::DialogAnswer;
use super::issue_gate::IssueGate;
use super::profile;
use super::{
    BrowserEngine, CapabilityId, ChildFrame, CapabilityTable, EngineError, EngineErrorKind, EngineFacts,
    EngineFuture, EngineTraits, InputMode, Point, Support,
};
use crate::browser_automation::budgets::{CDP_ISSUE, CDP_RESULT, EVAL_STEP};
use crate::browser_tab_manager::BrowserTabManager;

/// The WebView2 CDP transport over the pane's tab webviews.
struct WebView2Transport {
    tabs: Arc<BrowserTabManager>,
}

impl CdpTransport for WebView2Transport {
    fn call<'a>(
        &'a self,
        tab: &'a str,
        method: CdpMethod,
        params: Value,
    ) -> EngineFuture<'a, Value> {
        Box::pin(call(&self.tabs, tab, None, method, params))
    }

    fn call_in<'a>(
        &'a self,
        tab: &'a str,
        frame: Option<&'a str>,
        method: CdpMethod,
        params: Value,
    ) -> EngineFuture<'a, Value> {
        Box::pin(call(&self.tabs, tab, frame, method, params))
    }
}

/// Issue a CDP call on the UI thread; resolve with the raw JSON result.
/// Issue-phase failures mean the command was never delivered;
/// result-phase failures mean the page may have run the script.
async fn call(
    tabs: &BrowserTabManager,
    tab_id: &str,
    frame: Option<&str>,
    method: CdpMethod,
    params: Value,
) -> Result<Value, EngineError> {
    let undelivered = EngineError::new;
    let webview = tabs
        .webview(tab_id)
        .map_err(|_| undelivered(EngineErrorKind::TabNotFound))?;
    // Both are tokio oneshots: a blocking recv here would stall the
    // single-threaded host-MCP runtime while it waits on the UI thread.
    let (result_tx, result_rx) = oneshot::channel::<Result<String, ()>>();
    let (issue_tx, issue_rx) = oneshot::channel::<Result<(), EngineErrorKind>>();
    let params_json = params.to_string();
    let label = tab_id.to_string();
    let frame = frame.map(str::to_string);
    let gate = IssueGate::new();
    // Also stands the queued closure down when an outer deadline drops
    // this future.
    let _stand_down = gate.cancel_on_drop();
    let closure_gate = gate.clone();
    webview
        .with_webview(move |platform| {
            // SAFETY: runs on the UI thread that owns the WebView2 object;
            // the returned handle is used only within this closure's scope
            // (issuing the call synchronously) — WebView2 addrefs the
            // completion handler for the async round trip.
            let Ok(core) = (unsafe { platform.controller().CoreWebView2() }) else {
                let _ = issue_tx.send(Err(EngineErrorKind::Dispatch));
                return;
            };
            // An out-of-process frame's session changes when it reloads,
            // so it is looked up when the command goes out. Any other
            // frame lives in the page's own session.
            let session = frame.as_deref().and_then(|f| observe::session_of(&label, f));
            // The caller may already have given up and reported the command
            // as never issued.
            if !closure_gate.claim() {
                return;
            }
            let handler =
                CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |hr, json| {
                    let _ = result_tx.send(hr.map(|()| json).map_err(|_| ()));
                    Ok(())
                }));
            let (method, params) = (HSTRING::from(method.as_str()), HSTRING::from(params_json));
            let issued = match session {
                None => unsafe { core.CallDevToolsProtocolMethod(&method, &params, &handler) },
                Some(session) => core.cast::<ICoreWebView2_11>().and_then(|core| unsafe {
                    core.CallDevToolsProtocolMethodForSession(&HSTRING::from(session), &method, &params, &handler)
                }),
            };
            let _ = issue_tx.send(issued.map_err(|_| EngineErrorKind::Dispatch));
        })
        .map_err(|_| undelivered(EngineErrorKind::Dispatch))?;
    // Issue phase: timing out here cancels the queued closure so it never
    // issues late; a command that was already issued is in flight from this
    // point on.
    tokio::time::timeout(CDP_ISSUE, issue_rx)
        .await
        .map_err(|_| {
            gate.cancel();
            EngineError::new(EngineErrorKind::Timeout)
        })?
        .map_err(|_| undelivered(EngineErrorKind::Dispatch))?
        .map_err(undelivered)?;
    // Result phase: the command was issued, so a timeout or dropped
    // completion means the page script may have run.
    let json = tokio::time::timeout(CDP_RESULT, result_rx)
        .await
        .map_err(|_| EngineError::new(EngineErrorKind::Timeout))?
        .map_err(|_| EngineError::new(EngineErrorKind::NoReply))?
        .map_err(|()| EngineError::new(EngineErrorKind::Protocol))?;
    serde_json::from_str(&json).map_err(|_| EngineError::new(EngineErrorKind::Malformed))
}

/// Frames a snapshot follows per tab; owner lookups cost four CDP calls each.
const MAX_FRAMES: usize = 24;

/// Run `read` on the UI thread that owns `tab`'s webview.
async fn on_ui_thread<T: Send + 'static>(
    tabs: &BrowserTabManager,
    tab: &str,
    read: fn(&str) -> T,
) -> Result<T, EngineError> {
    let webview = tabs
        .webview(tab)
        .map_err(|_| EngineError::new(EngineErrorKind::TabNotFound))?;
    let (tx, rx) = oneshot::channel();
    let label = tab.to_string();
    webview
        .with_webview(move |_| {
            let _ = tx.send(read(&label));
        })
        .map_err(|_| EngineError::new(EngineErrorKind::Dispatch))?;
    tokio::time::timeout(CDP_ISSUE, rx)
        .await
        .map_err(|_| EngineError::new(EngineErrorKind::Timeout))?
        .map_err(|_| EngineError::new(EngineErrorKind::NoReply))
}

/// WebView2 engine over in-process CDP.
pub struct WebView2Engine {
    transport: WebView2Transport,
    facts: EngineFacts,
}

impl WebView2Engine {
    pub fn new(tabs: Arc<BrowserTabManager>) -> Self {
        Self {
            transport: WebView2Transport { tabs },
            facts: EngineFacts {
                capabilities: capability_table(),
                traits: EngineTraits {
                    isolated_world: true,
                    background_render: false,
                    network_observe: true,
                },
            },
        }
    }
}

/// What this adapter implements today: isolated-world eval, trusted
/// clicks, screenshots and file inputs, the tab-policy hooks (downloads
/// and file choosers among them); the DOM-event verbs are synthetic.
pub fn capability_table() -> CapabilityTable {
    CapabilityTable::unavailable("not implemented on the WebView2 engine yet")
        .with(CapabilityId::IsolatedEval, Support::Trusted)
        .with(
            CapabilityId::PersistentProfile,
            profile::persistent_profile_support(),
        )
        .with(CapabilityId::PointerClick, Support::Trusted)
        .with(CapabilityId::Screenshot, Support::Trusted)
        .with(CapabilityId::NavigationIntercept, Support::Trusted)
        .with(CapabilityId::NewWindowIntercept, Support::Trusted)
        .with(CapabilityId::DialogIntercept, Support::Trusted)
        .with(CapabilityId::PermissionIntercept, Support::Trusted)
        .with(CapabilityId::ExternalProtocolIntercept, Support::Trusted)
        .with(CapabilityId::FileChooser, Support::Trusted)
        .with(CapabilityId::DownloadIntercept, Support::Trusted)
        .with(CapabilityId::TrustedKey, Support::Synthetic)
        .with(CapabilityId::PointerMove, Support::Synthetic)
        .with(CapabilityId::Wheel, Support::Synthetic)
        .with(CapabilityId::ConsoleObserve, Support::Trusted)
        .with(CapabilityId::NetworkObserve, Support::Trusted)
}

impl BrowserEngine for WebView2Engine {
    fn facts(&self) -> &EngineFacts {
        &self.facts
    }

    fn evaluate<'a>(&'a self, tab: &'a str, script: Script) -> EngineFuture<'a, Value> {
        Box::pin(async move {
            tokio::time::timeout(EVAL_STEP, cdp::evaluate(&self.transport, tab, &script))
                .await
                .unwrap_or(Err(EngineError::new(EngineErrorKind::Timeout)))
        })
    }

    fn pointer_click<'a>(
        &'a self,
        tab: &'a str,
        at: Point,
        mode: InputMode,
    ) -> EngineFuture<'a, ()> {
        Box::pin(async move {
            match mode {
                InputMode::Trusted => cdp::click_at(&self.transport, tab, at).await,
                InputMode::Synthetic => Err(EngineError::new(EngineErrorKind::Unsupported)),
            }
        })
    }

    fn screenshot<'a>(&'a self, tab: &'a str) -> EngineFuture<'a, Vec<u8>> {
        Box::pin(cdp::capture_screenshot(&self.transport, tab))
    }

    fn child_frames<'a>(&'a self, tab: &'a str) -> EngineFuture<'a, Vec<ChildFrame>> {
        Box::pin(async move {
            let mut listed = on_ui_thread(&self.transport.tabs, tab, observe::frames).await?;
            let tree = self.transport.call(tab, CdpMethod::PageGetFrameTree, serde_json::json!({})).await?;
            listed.extend(cdp::child_frames(&tree));
            listed.truncate(MAX_FRAMES);
            let mut frames = Vec::with_capacity(listed.len());
            for (id, parent) in listed {
                // A frame whose owner cannot be read is left out: it shows
                // in the outline as unreachable.
                if let Ok(owner_path) = cdp::owner_path(&self.transport, tab, parent.as_deref(), &id).await {
                    frames.push(ChildFrame { id, parent, owner_path });
                }
            }
            Ok(frames)
        })
    }

    fn evaluate_in_frame<'a>(&'a self, tab: &'a str, frame: &'a str, script: Script) -> EngineFuture<'a, Value> {
        Box::pin(async move {
            tokio::time::timeout(EVAL_STEP, cdp::evaluate_in(&self.transport, tab, Some(frame), &script))
                .await
                .unwrap_or(Err(EngineError::new(EngineErrorKind::Timeout)))
        })
    }

    fn answer_dialog<'a>(
        &'a self,
        tab: &'a str,
        id: u64,
        answer: DialogAnswer,
    ) -> EngineFuture<'a, bool> {
        Box::pin(super::dialogs::answer(&self.transport.tabs, tab, id, answer))
    }

    fn set_input_files<'a>(
        &'a self,
        tab: &'a str,
        frame: Option<&'a str>,
        path: &'a str,
        files: &'a [std::path::PathBuf],
    ) -> EngineFuture<'a, ()> {
        Box::pin(async move {
            tokio::time::timeout(EVAL_STEP, cdp::set_input_files(&self.transport, tab, frame, path, files))
                .await
                .unwrap_or(Err(EngineError::new(EngineErrorKind::Timeout)))
        })
    }
}
