//! Agent browser automation for the embedded Termul browser pane.
//!
//! The host-injected `termul` MCP tool `browser` (see `acp::host_mcp`) forwards
//! `FrameKind::Browser` calls here. A `BrowserHost` trait keeps the parent
//! runtime-neutral: the desktop registers a [`DesktopBrowserHost`] at setup;
//! `termul-server` and tests that never register one get a fail-closed
//! `capability_unavailable`.
//!
//! Layout: `core` owns the tab registry, consent, verb dispatch and reply
//! shaping and drives engines only through the `engine::BrowserEngine`
//! port. Per-OS adapters live under `engine/`: WebView2 (Windows, in-process
//! CDP), WKWebView (macOS) and WebKitGTK (Linux), each running page helpers
//! in an isolated script world.
//!
//! Logging: boundary/failure lines only — never page contents, cookies, or
//! typed values (CWE-532).

pub mod budgets;
pub mod core;
pub mod engine;

#[cfg(test)]
pub use self::core::boundary::BROWSER_CALL_FAILED_PREFIX;
pub use self::core::boundary::{boundary_arg_keys, boundary_failure_line};
pub use self::core::{
    expected_args_text, BrowserError, DesktopBrowserHost, HostServices, Success, TabView,
    ToolSchema,
};
#[cfg(test)]
pub use self::core::{
    ERR_CAPABILITY, ERR_CONFIRMATION, ERR_INTERNAL, ERR_INVALID_PARAMS, ERR_STALE_REF,
    ERR_TAB_NOT_FOUND, ERR_TIMEOUT,
};

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, RwLock};

use budgets::Deadline;
use engine::EngineFacts;

use crate::browser_tab_manager::BrowserBounds;

use serde::Deserialize;
use serde_json::Value;

/// One `browser` tool call decoded at the frame boundary.
#[derive(Debug, Clone, Deserialize)]
pub struct BrowserCall {
    pub action: String,
    #[serde(default)]
    pub args: Value,
    /// Agent-stated intent for mutating actions (shown in consent/audit UI).
    #[serde(default)]
    pub element: Option<String>,
}

pub type HostFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Why the registry refused or failed a renderer-requested tab.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TabCreateError {
    pub code: &'static str,
    pub message: String,
}

/// Host-side capability. The desktop registers the real impl; standalone
/// servers and tests leave it unset — `dispatch` then fails closed.
pub trait BrowserHost: Send + Sync {
    fn execute<'a>(
        &'a self,
        session_id: &'a str,
        agent_id: &'a str,
        call: BrowserCall,
        deadline: Deadline,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Success, BrowserError>> + Send + 'a>>;
    fn end_session(&self, session_id: &str);
    /// `browser_tab_create`: the registry validates the label, builds the
    /// webview and admits the tab once the engine confirmed it.
    fn create_tab<'a>(
        &'a self,
        _label: &'a str,
        _url: &'a str,
        _bounds: BrowserBounds,
    ) -> HostFuture<'a, Result<TabView, TabCreateError>> {
        Box::pin(async { Err(no_tab_host()) })
    }
    /// `browser_tab_destroy`: close the tab and wait for the engine.
    fn destroy_tab<'a>(&'a self, _label: &'a str) -> HostFuture<'a, ()> {
        Box::pin(async {})
    }
    /// Stop: latch the session until the user's next prompt turn. Returns
    /// false when it was already stopped. Hosts that drive no tabs have
    /// nothing to stop.
    fn stop(&self, _session_id: &str) -> bool {
        false
    }
    /// The user submitted a prompt in the session: clears Stop.
    fn user_turn(&self, _session_id: &str) {}
    /// The registered engine's frozen capability table and traits.
    fn engine_facts(&self) -> EngineFacts;
}

static BROWSER_HOST: RwLock<Option<Arc<dyn BrowserHost>>> = RwLock::new(None);

/// Register the desktop host (called once from `lib.rs` setup).
pub fn set_browser_host(host: Arc<dyn BrowserHost>) {
    *BROWSER_HOST.write().unwrap_or_else(|e| e.into_inner()) = Some(host);
}

pub fn browser_host() -> Option<Arc<dyn BrowserHost>> {
    BROWSER_HOST
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

/// Entry point used by `host_mcp::parent` for `FrameKind::Browser`.
///
/// No pre-stamping of `arg_keys` here or in `DesktopBrowserHost::execute`:
/// the parent log site's `boundary_arg_keys` fallback is the SINGLE place
/// the action table is applied (pre-stamps are unobservable — they
/// produce the same line — and erase the site-keys-vs-table distinction).
pub async fn dispatch(
    session_id: &str,
    agent_id: &str,
    call: BrowserCall,
    deadline: Deadline,
) -> Result<Success, BrowserError> {
    match browser_host() {
        Some(host) => host.execute(session_id, agent_id, call, deadline).await,
        None => Err(no_host_error()),
    }
}

/// What every call gets when no automation host is registered (the
/// standalone server, tests): fail closed, never hang or succeed.
pub fn no_host_error() -> BrowserError {
    BrowserError::capability("browser automation is only available on the desktop app")
        .with_reason("no_automation_host")
}

/// The `browser` tool schema served to host_mcp children: built from the
/// registered host's engine, or the fail-closed schema when none is.
pub fn describe() -> ToolSchema {
    let facts = browser_host().map(|host| host.engine_facts());
    self::core::schema(facts.as_ref())
}

/// Called by `HostPlanServer::unregister_session` — closes the session's
/// agent tabs and drops its consent grant.
pub fn session_ended(session_id: &str) {
    if let Some(host) = browser_host() {
        host.end_session(session_id);
    }
}

/// Stop from the desktop command or the `/ws` route. `None` when this
/// process has no automation host.
pub fn stop_session(session_id: &str) -> Option<bool> {
    browser_host().map(|host| host.stop(session_id))
}

/// Called when a prompt turn of the session starts.
pub fn user_turn(session_id: &str) {
    if let Some(host) = browser_host() {
        host.user_turn(session_id);
    }
}

fn no_tab_host() -> TabCreateError {
    TabCreateError {
        code: "BROWSER_TAB_NO_HOST",
        message: "browser tabs need the desktop automation host".to_string(),
    }
}

/// `browser_tab_create`: build a tab through the registry.
pub async fn create_tab(
    label: &str,
    url: &str,
    bounds: BrowserBounds,
) -> Result<TabView, TabCreateError> {
    match browser_host() {
        Some(host) => host.create_tab(label, url, bounds).await,
        None => Err(no_tab_host()),
    }
}

/// `browser_tab_destroy`: close a tab through the registry.
pub async fn destroy_tab(label: &str) {
    if let Some(host) = browser_host() {
        host.destroy_tab(label).await;
    }
}

/// Test hook: drop the registered host so `dispatch`-level tests can assert
/// the no-host fail-closed path deterministically.
#[cfg(test)]
pub fn clear_browser_host() {
    *BROWSER_HOST.write().unwrap_or_else(|e| e.into_inner()) = None;
}

/// Serializes every test that touches the process-global `BROWSER_HOST`
/// (this module's `mod tests` plus `acp::host_mcp::parent::tests`).
#[cfg(test)]
pub(crate) static TEST_HOST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests;
