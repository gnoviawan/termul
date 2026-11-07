//! The eval round trip shared by the WebKit adapters. Both engines call a
//! function body in a named script world with named string arguments, on
//! the UI thread, and answer through a native completion callback. The
//! helper's value comes back as JSON text (see [`call_body`]).

use std::time::Duration;

use serde_json::Value;
use tokio::sync::oneshot;

use super::assets::Script;
use super::issue_gate::IssueGate;
use super::{
    CapabilityId, CapabilityTable, EngineError, EngineErrorKind, EngineFacts, EngineTraits,
    Support,
};

/// The argument name the JSON-encoded parameters are bound to.
pub const PARAMS_ARG: &str = "termulParams";

/// The function body a WebKit engine runs for `script`: it decodes the
/// parameters and returns the helper's value as JSON text, all inside the
/// isolated world. A helper may return a promise; both engines await the
/// body's promise before they complete the call. The body is static; the
/// parameters travel as [`params_json`] under [`PARAMS_ARG`].
pub fn call_body(script: &Script) -> String {
    format!(
        "return Promise.resolve((function (p) {{\n{}\n}})(JSON.parse({PARAMS_ARG}))).then(function (r) {{\n  return r === undefined ? 'null' : JSON.stringify(r);\n}});",
        script.helper.body
    )
}

/// The parameters as one JSON string argument.
pub fn params_json(script: &Script) -> String {
    script.params.to_string()
}

/// What both WebKit adapters implement today: isolated-world eval, the
/// tab-policy hooks (downloads and file choosers among them), file inputs
/// and viewport snapshots, with every input verb run as synthetic DOM
/// events by the helpers.
pub fn isolated_facts() -> EngineFacts {
    EngineFacts {
        capabilities: CapabilityTable::unavailable("not implemented on this engine yet")
            .with(CapabilityId::IsolatedEval, Support::Trusted)
            .with(
                CapabilityId::PersistentProfile,
                super::profile::persistent_profile_support(),
            )
            .with(CapabilityId::PointerClick, Support::Synthetic)
            .with(CapabilityId::TrustedKey, Support::Synthetic)
            .with(CapabilityId::PointerMove, Support::Synthetic)
            .with(CapabilityId::Wheel, Support::Synthetic)
            .with(CapabilityId::Screenshot, Support::Trusted)
            .with(CapabilityId::NavigationIntercept, Support::Trusted)
            .with(CapabilityId::NewWindowIntercept, Support::Trusted)
            .with(CapabilityId::DialogIntercept, Support::Trusted)
            .with(CapabilityId::PermissionIntercept, Support::Trusted)
            .with(CapabilityId::ExternalProtocolIntercept, Support::Trusted)
            .with(CapabilityId::DownloadIntercept, Support::Trusted)
            .with(CapabilityId::FileChooser, Support::Trusted),
        traits: EngineTraits {
            isolated_world: true,
            background_render: false,
            network_observe: false,
        },
    }
}

/// An engine with no isolated world runs no helper at all.
#[cfg(any(test, target_os = "macos"))]
pub fn no_world_facts(reason: &'static str) -> EngineFacts {
    EngineFacts {
        capabilities: CapabilityTable::unavailable(reason),
        traits: EngineTraits {
            isolated_world: false,
            background_render: false,
            network_observe: false,
        },
    }
}

/// How the engine completed one call: the helper's JSON text, or why the
/// engine refused or failed it.
pub type CallResult = Result<String, EngineErrorKind>;

/// Parse a completed call. Every failure here is terminal: the engine
/// processed the call, so the helper may have run.
pub fn parse(result: CallResult) -> Result<Value, EngineError> {
    let json = result.map_err(EngineError::new)?;
    serde_json::from_str(&json).map_err(|_| EngineError::new(EngineErrorKind::Malformed))
}

/// Where an adapter's completion callback sends its [`CallResult`].
pub type Completion = oneshot::Sender<CallResult>;

/// Queue `issue` on the UI thread through `queue` and await the completion
/// it hands to the engine. A tokio oneshot, so the wait never blocks the
/// host-MCP runtime. When `deadline` passes or this future is dropped
/// first, the queued closure stands down: it must not run an action the
/// host has already reported as timed out.
pub async fn run<P, Q, F>(queue: Q, deadline: Duration, issue: F) -> Result<Value, EngineError>
where
    Q: FnOnce(Box<dyn FnOnce(&P) + Send>) -> Result<(), ()>,
    F: FnOnce(&P, Completion) + Send + 'static,
{
    let (tx, rx) = oneshot::channel();
    let gate = IssueGate::new();
    let _stand_down = gate.cancel_on_drop();
    let closure_gate = gate.clone();
    queue(Box::new(move |platform: &P| {
        if closure_gate.claim() {
            issue(platform, tx);
        }
    }))
    .map_err(|()| EngineError::new(EngineErrorKind::Dispatch))?;
    match tokio::time::timeout(deadline, rx).await {
        Ok(Ok(result)) => parse(result),
        Ok(Err(_)) => Err(EngineError::new(EngineErrorKind::NoReply)),
        Err(_) => {
            gate.cancel();
            Err(EngineError::new(EngineErrorKind::Timeout))
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub use ui::call;

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod ui {
    use serde_json::Value;
    use tauri::webview::PlatformWebview;

    use super::{run, Completion};
    use crate::browser_automation::budgets::EVAL_STEP;
    use crate::browser_automation::engine::{EngineError, EngineErrorKind};
    use crate::browser_tab_manager::BrowserTabManager;

    /// Run `issue` on the UI thread that owns `tab`'s webview.
    pub async fn call<F>(tabs: &BrowserTabManager, tab: &str, issue: F) -> Result<Value, EngineError>
    where
        F: FnOnce(&PlatformWebview, Completion) + Send + 'static,
    {
        let webview = tabs
            .webview(tab)
            .map_err(|_| EngineError::new(EngineErrorKind::TabNotFound))?;
        run(
            |job| webview.with_webview(move |platform| job(&platform)).map_err(|_| ()),
            EVAL_STEP,
            issue,
        )
        .await
    }
}

#[cfg(test)]
#[path = "string_eval_tests.rs"]
mod tests;
