//! Agent browser automation for the embedded Termul browser pane.
//!
//! The host-injected `termul` MCP tool `browser` (see `acp::host_mcp`) forwards
//! `FrameKind::Browser` calls here. A `BrowserHost` trait keeps the parent
//! runtime-neutral: the desktop registers a [`DesktopBrowserHost`] at setup;
//! `termul-server` and tests that never register one get a fail-closed
//! `capability_unavailable`.
//!
//! Phase 1 scope (spec `spec-acp-browser-pane-automation`):
//! - Windows/WebView2 is the only fully-capable engine — in-process CDP via
//!   `CallDevToolsProtocolMethod` for trusted input, screenshots, and eval
//!   (`Runtime.evaluate`). Other
//!   desktop platforms run the JS-eval action subset; non-desktop surfaces
//!   report `capability_unavailable`.
//! - Agent tabs are normal visible pane tabs (`BrowserTabManager`) marked
//!   agent-controlled; the first call per session gates on a one-time user
//!   consent (`acp:browser_consent_request` → `browser_consent_respond`).
//! - Observation is an injected aria-snapshot script with `@eN` fingerprint
//!   refs that re-resolve against a structural selector; a navigated/rebuilt
//!   DOM fails the re-resolution and reports `stale_ref`. Navigation also
//!   advances a per-tab epoch that rides snapshot replies so an agent can
//!   detect document changes (the epoch itself is a counter, not the
//!   staleness mechanism).
//!
//! Logging: boundary/failure lines only — never page contents, cookies, or
//! typed values (CWE-532).

#[cfg(target_os = "windows")]
mod cdp;
// Platform-neutral CDP protocol seams: compiled for the Windows cdp module
// and for tests on every platform (the gate keeps non-test non-Windows
// builds free of dead code — only the Windows `cdp` module consumes it in
// prod).
#[cfg(any(test, target_os = "windows"))]
mod cdp_protocol;
mod js;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::acp::events;
use crate::browser_tab_manager::BrowserTabManager;
use crate::web::EventSink;

/// Stable wire error codes (agents match on these, not the message text).
pub const ERR_CAPABILITY: &str = "capability_unavailable";
pub const ERR_CONFIRMATION: &str = "confirmation_required";
pub const ERR_TAB_NOT_FOUND: &str = "tab_not_found";
pub const ERR_STALE_REF: &str = "stale_ref";
pub const ERR_INVALID_PARAMS: &str = "invalid_params";
pub const ERR_TIMEOUT: &str = "timeout";
pub const ERR_INTERNAL: &str = "internal";

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

/// Typed failure returned to the agent.
#[derive(Debug)]
pub struct BrowserError {
    pub code: &'static str,
    pub message: String,
}

impl std::fmt::Display for BrowserError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl BrowserError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    fn capability(msg: impl Into<String>) -> Self {
        Self::new(ERR_CAPABILITY, msg)
    }
    fn invalid(msg: impl Into<String>) -> Self {
        Self::new(ERR_INVALID_PARAMS, msg)
    }
    fn tab_not_found(tab_id: &str) -> Self {
        Self::new(ERR_TAB_NOT_FOUND, format!("tab '{tab_id}' not found"))
    }
    fn internal(msg: impl Into<String>) -> Self {
        Self::new(ERR_INTERNAL, msg)
    }
}

/// Host-side capability. The desktop registers the real impl; standalone
/// servers and tests leave it unset — `dispatch` then fails closed.
pub trait BrowserHost: Send + Sync {
    fn execute<'a>(
        &'a self,
        session_id: &'a str,
        agent_id: &'a str,
        call: BrowserCall,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, BrowserError>> + Send + 'a>>;
    fn end_session(&self, session_id: &str);
    /// Called by `browser_tab_create` — returns true when the tab was a
    /// pending agent tab (so the caller can flag it agent-controlled).
    fn notify_tab_created(&self, tab_id: &str) -> bool;
    fn notify_tab_closed(&self, tab_id: &str);
    /// Advance the per-tab epoch (rides snapshot replies so an agent can
    /// detect document changes; ref staleness is decided page-side).
    fn notify_tab_navigated(&self, tab_id: &str);
    fn resolve_consent(&self, request_id: &str, allowed: bool) -> bool;
    /// Resolve a pending eval bridge reply from `browser_agent_eval_result`.
    fn resolve_eval(&self, nonce: &str, ok: bool, value: Option<String>) -> bool;
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
pub async fn dispatch(
    session_id: &str,
    agent_id: &str,
    call: BrowserCall,
) -> Result<Value, BrowserError> {
    match browser_host() {
        Some(host) => host.execute(session_id, agent_id, call).await,
        None => Err(BrowserError::capability(
            "browser automation is only available on the desktop app",
        )),
    }
}

/// Called by `HostPlanServer::unregister_session` — closes the session's
/// agent tabs and drops its consent grant.
pub fn session_ended(session_id: &str) {
    if let Some(host) = browser_host() {
        host.end_session(session_id);
    }
}

/// `browser_consent_respond` command → resolve the pending consent prompt.
pub fn consent_responded(request_id: &str, allowed: bool) -> bool {
    match browser_host() {
        Some(host) => host.resolve_consent(request_id, allowed),
        None => false,
    }
}

/// `browser_agent_eval_result` command → resolve the pending eval waiter.
/// Returns false when the nonce is unknown (stale/unrelated page report).
pub fn eval_resolved(nonce: &str, ok: bool, value: Option<String>) -> bool {
    match browser_host() {
        Some(host) => host.resolve_eval(nonce, ok, value),
        None => false,
    }
}

/// `browser_tab_create` hook — returns true when `tab_id` is a pending agent
/// tab (the caller marks it agent-controlled).
pub fn tab_created(tab_id: &str) -> bool {
    match browser_host() {
        Some(host) => host.notify_tab_created(tab_id),
        None => false,
    }
}

/// `browser_tab_destroy` / user-close hook.
pub fn tab_closed(tab_id: &str) {
    if let Some(host) = browser_host() {
        host.notify_tab_closed(tab_id);
    }
}

/// `browser_tab_report_url` hook — user/script-driven navigation inside an
/// agent tab invalidates stored refs too.
pub fn tab_navigated(tab_id: &str) {
    if let Some(host) = browser_host() {
        host.notify_tab_navigated(tab_id);
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

// ---------------------------------------------------------------------------
// Consent + session-scoped event payloads (`acp:` namespace via `fan_out`).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserConsentRequestEvent {
    pub request_id: String,
    pub session_id: String,
    pub agent_id: String,
    /// First action the agent wants to run — surfaced in the dialog.
    pub action: String,
    /// Agent-stated intent for the first mutating action, when provided.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub element: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserAgentTabEvent {
    pub action: &'static str, // "open" | "close"
    pub tab_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub session_id: String,
}

const EVENT_CONSENT_REQUEST: &str = "acp:browser_consent_request";
const EVENT_AGENT_TAB: &str = "acp:browser_agent_tab";

// ---------------------------------------------------------------------------
// Desktop implementation.
// ---------------------------------------------------------------------------

/// How long the consent prompt may sit unanswered before auto-deny.
const CONSENT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
/// Renderer round-trip to open a workspace tab + native webview.
const TAB_OPEN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
/// eval-bridge reply budget (the poller shows IPC is sub-ms; 20s is generous).
const EVAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
/// Post-navigate settle poll budget.
const NAV_SETTLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
/// Snapshot text cap — keeps replies inside the child's reply bound.
const SNAPSHOT_MAX_CHARS: usize = 48 * 1024;

struct PendingConsent {
    request_id: String,
    waiters: Vec<oneshot::Sender<bool>>,
}

#[derive(Debug)]
struct AgentTab {
    session_id: String,
    /// Advanced on every navigation (agent- or user-driven); snapshot
    /// replies carry it so an agent can detect document changes. Ref
    /// staleness itself is decided page-side (fingerprint re-resolution
    /// → `stale_ref`), not by this counter.
    epoch: AtomicU64,
}

impl AgentTab {
    /// Advance the per-tab epoch. Snapshot replies carry it so an agent
    /// can detect that the document changed between calls; it does not
    /// invalidate refs — ref staleness comes from document replacement
    /// plus the page-side fingerprint re-check (page-reported
    /// `stale_ref:`, mapped by `eval_gate`).
    fn bump_epoch(&self) {
        self.epoch.fetch_add(1, Ordering::AcqRel);
    }
}

/// Desktop host: drives real pane webviews via `BrowserTabManager` — JS eval
/// bridge as the baseline transport (sole transport off-Windows); on Windows
/// eval goes through WebView2 CDP first with one bridge fallback, plus CDP
/// trusted input + screenshots (`cdp` module, feature of the platform not
/// the code path).
pub struct DesktopBrowserHost {
    app: AppHandle,
    tabs: Arc<BrowserTabManager>,
    sinks: Vec<Arc<dyn EventSink>>,
    /// session_id -> consent granted. Denials are not cached — a denied agent
    /// re-prompts on the next call so the user can change their mind.
    consent: parking_lot::Mutex<HashMap<String, ()>>,
    /// session_id -> in-flight consent prompt (request id + every caller
    /// waiting on it). Concurrent tool calls share ONE prompt instead of
    /// stacking dialogs.
    pending_consent: parking_lot::Mutex<HashMap<String, PendingConsent>>,
    pending_tab_open: parking_lot::Mutex<HashMap<String, oneshot::Sender<Result<(), String>>>>,
    pending_eval: parking_lot::Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
    agent_tabs: parking_lot::Mutex<HashMap<String, Arc<AgentTab>>>,
    /// session_id → async open serialization. The auto-open path (navigate
    /// without `tabId`) holds the session's lock across the re-check +
    /// `open_agent_tab` await + insert, so concurrent no-`tabId` navigates
    /// for one session serialize and the second finds the first's tab.
    /// `new_tab` mints unconditionally (explicit multi-tab by design) and
    /// never takes this lock.
    session_open_locks: parking_lot::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

// -- eval transports --------------------------------------------------------
//
// Windows routes eval through CDP `Runtime.evaluate` first: in the
// 2026-10-03 field session the JS-eval bridge's reply path (page-side
// `__TAURI_INTERNALS__` invoke) failed for every observation call on
// mounted agent tabs — the failure is specific to the agent-tab
// context/timing and the root cause is unconfirmed (see the
// spec-acp-browser-automation-v2 bug evidence). The bridge stays as the
// single fallback there and the only transport elsewhere.

/// One eval transport. The CDP arm only exists on Windows (WebView2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EvalTransport {
    /// In-process CDP `Runtime.evaluate` (trusted, Windows-only).
    #[cfg(target_os = "windows")]
    Cdp,
    /// JS-eval bridge: fire-and-forget `webview.eval`; results return
    /// through the `browser_agent_eval_result` command.
    Bridge,
}

/// Ordered transports for one eval call (pure — unit-tested headlessly):
/// Windows walks CDP first with at most one bridge fallback — only when
/// the CDP command never reached the page (see
/// `cdp_protocol::should_fallback_to_bridge`; page exceptions and result
/// timeouts are terminal so a mutating script can never run twice); other
/// platforms use the bridge only. The bridge is the terminal transport:
/// its outcome governs (timeout stays `timeout`).
fn eval_transports() -> &'static [EvalTransport] {
    #[cfg(target_os = "windows")]
    {
        &[EvalTransport::Cdp, EvalTransport::Bridge]
    }
    #[cfg(not(target_os = "windows"))]
    {
        &[EvalTransport::Bridge]
    }
}

impl DesktopBrowserHost {
    pub fn new(
        app: AppHandle,
        tabs: Arc<BrowserTabManager>,
        sinks: Vec<Arc<dyn EventSink>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            app,
            tabs,
            sinks,
            consent: parking_lot::Mutex::new(HashMap::new()),
            pending_consent: parking_lot::Mutex::new(HashMap::new()),
            pending_tab_open: parking_lot::Mutex::new(HashMap::new()),
            pending_eval: parking_lot::Mutex::new(HashMap::new()),
            agent_tabs: parking_lot::Mutex::new(HashMap::new()),
            session_open_locks: parking_lot::Mutex::new(HashMap::new()),
        })
    }

    /// Get (or create) the per-session async open lock (see
    /// `session_open_locks`). Returned as an `Arc` so the holder keeps the
    /// SAME lock even if `end_session` removes the map entry mid-flight.
    fn session_open_lock(&self, session_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.session_open_locks
            .lock()
            .entry(session_id.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    fn emit<T: Serialize>(&self, session_id: Option<&str>, name: &'static str, payload: &T) {
        events::fan_out(&self.sinks, session_id, name, payload);
    }

    // -- consent ------------------------------------------------------------

    async fn ensure_consent(
        &self,
        session_id: &str,
        agent_id: &str,
        call: &BrowserCall,
    ) -> Result<(), BrowserError> {
        if self.consent.lock().contains_key(session_id) {
            return Ok(());
        }
        let (tx, rx) = oneshot::channel::<bool>();
        {
            let mut pending = self.pending_consent.lock();
            match pending.get_mut(session_id) {
                // A prompt is already on screen for this session — queue
                // behind it rather than stacking a second dialog.
                Some(pc) => pc.waiters.push(tx),
                None => {
                    let request_id = Uuid::new_v4().to_string();
                    pending.insert(
                        session_id.to_string(),
                        PendingConsent {
                            request_id: request_id.clone(),
                            waiters: vec![tx],
                        },
                    );
                    drop(pending);
                    self.emit(
                        Some(session_id),
                        EVENT_CONSENT_REQUEST,
                        &BrowserConsentRequestEvent {
                            request_id,
                            session_id: session_id.to_string(),
                            agent_id: agent_id.to_string(),
                            action: call.action.clone(),
                            element: call.element.clone(),
                        },
                    );
                }
            }
        }
        let allowed = match tokio::time::timeout(CONSENT_TIMEOUT, rx).await {
            Ok(Ok(v)) => v,
            _ => {
                // Timeout or dropped sender (renderer gone) → fail closed.
                false
            }
        };
        if allowed {
            self.consent.lock().insert(session_id.to_string(), ());
            log::info!(
                "[browser-agent] consent granted for session {}",
                crate::logging::redact_session_id(session_id)
            );
            Ok(())
        } else {
            log::info!(
                "[browser-agent] consent denied/timed out for session {}",
                crate::logging::redact_session_id(session_id)
            );
            Err(BrowserError::new(
                ERR_CONFIRMATION,
                "user did not grant browser automation for this session",
            ))
        }
    }

    // -- tab lifecycle ------------------------------------------------------

    fn agent_tab(&self, tab_id: &str) -> Option<Arc<AgentTab>> {
        self.agent_tabs.lock().get(tab_id).cloned()
    }

    /// Resolve the target tab for an action (strict `tabId` validation +
    /// ownership + deterministic default, see [`action_target`]). Absent/
    /// null `tabId` → the session's default agent tab; creating one is
    /// the caller's job (needs a URL).
    fn resolve_tab(
        &self,
        session_id: &str,
        action: &str,
        args: &Value,
    ) -> Result<(String, Arc<AgentTab>), BrowserError> {
        let tabs = self.agent_tabs.lock();
        action_target(&tabs, session_id, action, args)?.ok_or_else(|| {
            BrowserError::tab_not_found("(no agent tab — call navigate or new_tab first)")
        })
    }

    /// Open a renderer-mediated agent tab: emit the open event, wait for the
    /// renderer to mount the pane and call `browser_tab_create`.
    async fn open_agent_tab(
        &self,
        session_id: &str,
        url: Option<&str>,
    ) -> Result<String, BrowserError> {
        let tab_id = format!("agent-{}", Uuid::new_v4());
        let (tx, rx) = oneshot::channel();
        self.pending_tab_open.lock().insert(tab_id.clone(), tx);
        self.emit(
            Some(session_id),
            EVENT_AGENT_TAB,
            &BrowserAgentTabEvent {
                action: "open",
                tab_id: tab_id.clone(),
                url: url.map(str::to_string),
                session_id: session_id.to_string(),
            },
        );
        match tokio::time::timeout(TAB_OPEN_TIMEOUT, rx).await {
            Ok(Ok(Ok(()))) => {
                self.agent_tabs.lock().insert(
                    tab_id.clone(),
                    Arc::new(AgentTab {
                        session_id: session_id.to_string(),
                        epoch: AtomicU64::new(1),
                    }),
                );
                log::info!(
                    "[browser-agent] opened agent tab {} for session {}",
                    tab_id,
                    crate::logging::redact_session_id(session_id)
                );
                Ok(tab_id)
            }
            Ok(Ok(Err(e))) => {
                self.pending_tab_open.lock().remove(&tab_id);
                Err(BrowserError::internal(e))
            }
            _ => {
                self.pending_tab_open.lock().remove(&tab_id);
                Err(BrowserError::capability(
                    "renderer did not open the agent tab (no desktop UI attached?)",
                ))
            }
        }
    }

    /// Validate + normalize a navigation target. http(s) only.
    fn check_url(url: &str) -> Result<String, BrowserError> {
        let parsed = url
            .parse::<tauri::Url>()
            .map_err(|_| BrowserError::invalid(format!("invalid url: {url}")))?;
        match parsed.scheme() {
            "http" | "https" => Ok(parsed.to_string()),
            other => Err(BrowserError::invalid(format!(
                "scheme '{other}' is not allowed (http/https only)"
            ))),
        }
    }

    /// Extract the required `url` arg for navigate/new_tab — a missing or
    /// non-string value fails with `invalid_params` naming the key.
    fn require_url_arg(args: &Value, action: &str) -> Result<String, BrowserError> {
        args.get("url")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| BrowserError::invalid(format!("{action} needs 'url'")))
    }

    /// Extract the optional `tabId` arg — absent (or JSON null) → `None`
    /// (default-tab resolution); a non-string or empty value fails with
    /// `invalid_params` naming the key. Silently treating a malformed
    /// `tabId` as absent would retarget a tab the caller never named.
    fn tab_id_arg(args: &Value, action: &str) -> Result<Option<String>, BrowserError> {
        match args.get("tabId") {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) if !s.is_empty() => Ok(Some(s.clone())),
            Some(_) => Err(BrowserError::invalid(format!(
                "{action}: 'tabId' must be a non-empty string when provided"
            ))),
        }
    }

    /// Refs are host-minted `@eN` tokens. Validating before script build
    /// keeps an agent-supplied value out of the eval bridge entirely (defense
    /// in depth on top of the script builders' expression concatenation).
    fn check_ref(ref_id: &str) -> Result<(), BrowserError> {
        let ok = ref_id.starts_with("@e")
            && ref_id.len() > 2
            && ref_id[2..].chars().all(|c| c.is_ascii_digit());
        if ok {
            Ok(())
        } else {
            Err(BrowserError::invalid(format!(
                "invalid ref '{ref_id}' (expected @eN)"
            )))
        }
    }

    // -- eval transports ----------------------------------------------------
    //
    // `eval` walks the module-level transport plan; the bridge body lives
    // below in `eval_bridge`.

    /// Eval routed through the transport plan: CDP on Windows; a single
    /// bridge fallback only when the CDP command never reached the page;
    /// bridge-only elsewhere. A page exception or CDP result timeout is
    /// terminal (the script ran or may have run — re-executing it could
    /// double-apply side effects like a fill or an Enter-press).
    async fn eval(&self, tab_id: &str, expr: &str) -> Result<Value, BrowserError> {
        let transports = eval_transports();
        let mut last_err = None;
        for transport in transports {
            let outcome = match transport {
                #[cfg(target_os = "windows")]
                EvalTransport::Cdp => match cdp::evaluate(&self.tabs, tab_id, expr).await {
                    Ok(v) => Ok(v),
                    Err(failure) => {
                        if cdp_protocol::should_fallback_to_bridge(&failure) {
                            // Transport-establishment failure: the command
                            // never reached the page, so one bridge retry is
                            // side-effect-safe. Failure boundary log — tab
                            // id + code only, never the message: eval
                            // errors can quote page content (CWE-532).
                            log::warn!(
                                "[browser-agent] CDP eval transport failed on tab {tab_id} ({}), JS-eval bridge fallback",
                                failure.error.code
                            );
                            // Fall through to the next transport (bridge).
                            Err(failure.error)
                        } else {
                            // Terminal: the page script ran (exception) or
                            // may have run (result timeout / error reply) —
                            // re-executing it could double its side effects.
                            return Err(failure.error);
                        }
                    }
                },
                EvalTransport::Bridge => self.eval_bridge(tab_id, expr).await,
            };
            match outcome {
                Ok(v) => return Ok(v),
                Err(e) => last_err = Some(e),
            }
        }
        // The bridge is the terminal transport on every plan, so reaching
        // here with an error means the bridge failed — the eval's final
        // outcome. Durable boundary log: tab id + code only (CWE-532).
        if let Some(e) = &last_err {
            log::warn!("[browser-agent] eval failed on tab {tab_id} ({})", e.code);
        }
        // Unreachable on today's plans (every plan ends with the bridge);
        // kept so a future plan change can't silently swallow the last error.
        Err(last_err.unwrap_or_else(|| {
            BrowserError::internal("no eval transport available for this platform")
        }))
    }

    /// JS-eval bridge transport: `webview.eval` is fire-and-forget; results
    /// return through the `browser_agent_eval_result` command
    /// (caller-validated to the tab).
    async fn eval_bridge(&self, tab_id: &str, expr: &str) -> Result<Value, BrowserError> {
        let webview = self
            .tabs
            .webview(tab_id)
            .map_err(|_| BrowserError::tab_not_found(tab_id))?;
        let nonce = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending_eval.lock().insert(nonce.clone(), tx);
        let wrapped = js::wrap_eval(tab_id, &nonce, expr);
        webview.eval(&wrapped).map_err(|e| {
            self.pending_eval.lock().remove(&nonce);
            BrowserError::internal(format!("eval dispatch failed: {e}"))
        })?;
        match tokio::time::timeout(EVAL_TIMEOUT, rx).await {
            Ok(Ok(Ok(v))) => Ok(v),
            Ok(Ok(Err(e))) => Err(BrowserError::new(ERR_INTERNAL, e)),
            Ok(Err(_)) => {
                self.pending_eval.lock().remove(&nonce);
                Err(BrowserError::internal("eval channel dropped"))
            }
            Err(_) => {
                self.pending_eval.lock().remove(&nonce);
                Err(BrowserError::new(ERR_TIMEOUT, "eval timed out"))
            }
        }
    }

    /// Wait until `document.readyState` reaches interactive/complete.
    async fn settle(&self, tab_id: &str) -> Result<(), BrowserError> {
        let deadline = std::time::Instant::now() + NAV_SETTLE_TIMEOUT;
        loop {
            match self
                .eval(tab_id, "document.readyState")
                .await
                .ok()
                .and_then(|v| v.as_str().map(str::to_string))
            {
                Some(state) if state == "complete" || state == "interactive" => return Ok(()),
                _ => {
                    if std::time::Instant::now() > deadline {
                        // Still return Ok — the page may be a slow SPA; the
                        // agent retries reads on demand.
                        return Ok(());
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
            }
        }
    }

    // -- actions ------------------------------------------------------------

    async fn act(&self, session_id: &str, call: BrowserCall) -> Result<Value, BrowserError> {
        let args = &call.args;
        match call.action.as_str() {
            "list_tabs" => {
                let tabs = self.agent_tabs.lock();
                let list: Vec<Value> = tabs
                    .iter()
                    .filter(|(_, t)| t.session_id == session_id)
                    .filter_map(|(id, _)| {
                        self.tabs.info(id).ok().map(
                            |info| json!({ "tabId": id, "url": info.url, "title": info.title }),
                        )
                    })
                    .collect();
                Ok(json!({ "tabs": list }))
            }
            "new_tab" => {
                let url = Self::require_url_arg(args, "new_tab")?;
                let url = Self::check_url(&url)?;
                let tab_id = self.open_agent_tab(session_id, Some(&url)).await?;
                Ok(json!({ "tabId": tab_id }))
            }
            "close_tab" => {
                let (tab_id, _) = self.resolve_tab(session_id, &call.action, args)?;
                self.close_agent_tab(&tab_id);
                Ok(json!({ "closed": tab_id }))
            }
            "navigate" => {
                let url = Self::require_url_arg(args, "navigate")?;
                let url = Self::check_url(&url)?;
                let tab_id = Self::tab_id_arg(args, "navigate")?;
                let resolution = {
                    let tabs = self.agent_tabs.lock();
                    navigate_resolution(&tabs, session_id, tab_id.as_deref())
                };
                let (tab_id, tab, fresh) = match resolution {
                    NavigateResolution::Reuse(id, tab) => (id, tab, false),
                    // Auto-open ONLY when no `tabId` was given: the first
                    // navigate creates the visible tab already pointing at
                    // the target URL (the renderer loads it on mount — no
                    // double nav).
                    NavigateResolution::AutoOpen => {
                        // Serialize automatic opens per session: the open is
                        // asynchronous (it waits for the renderer before
                        // inserting into `agent_tabs`), so the re-check
                        // alone can't stop a concurrent no-`tabId` navigate
                        // from minting a second tab while the first is in
                        // flight. Holding the session's open lock across
                        // re-check + open + insert makes the second call
                        // find the first's tab (retargeted below).
                        let _open_guard = self.session_open_lock(session_id).lock_owned().await;
                        let winner = default_session_tab(&self.agent_tabs.lock(), session_id);
                        match winner {
                            Some((id, tab)) => (id, tab, false),
                            None => {
                                let id = self.open_agent_tab(session_id, Some(&url)).await?;
                                let tab = self
                                    .agent_tab(&id)
                                    .ok_or_else(|| BrowserError::tab_not_found(&id))?;
                                (id, tab, true)
                            }
                        }
                    }
                    // An explicit non-resolving `tabId` is a caller error:
                    // return `tab_not_found` WITHOUT minting another tab
                    // (auto-opening here let a bad target proliferate
                    // tabs — the 2026-10-03 failure session's pile-up).
                    NavigateResolution::TabNotFound(e) => {
                        log::warn!(
                            "[browser-agent] navigate: explicit tabId not owned by session {} ({}), no auto-open",
                            crate::logging::redact_session_id(session_id),
                            e.code
                        );
                        return Err(e);
                    }
                };
                if !fresh {
                    self.tabs
                        .navigate(&tab_id, url.clone())
                        .map_err(BrowserError::internal)?;
                }
                tab.bump_epoch();
                let _ = self.settle(&tab_id).await;
                // Report the tab's real URL — never fabricate the
                // requested one when the lookup fails.
                let url_now = self
                    .tabs
                    .info(&tab_id)
                    .map(|i| i.url)
                    .map_err(|_| BrowserError::tab_not_found(&tab_id))?;
                Ok(json!({ "tabId": tab_id, "url": url_now }))
            }
            "back" | "forward" | "reload" => {
                let (tab_id, tab) = self.resolve_tab(session_id, &call.action, args)?;
                let r = match call.action.as_str() {
                    "back" => self.tabs.go_back(&tab_id),
                    "forward" => self.tabs.go_forward(&tab_id),
                    _ => self.tabs.reload(&tab_id),
                };
                r.map_err(BrowserError::internal)?;
                tab.bump_epoch();
                let _ = self.settle(&tab_id).await;
                Ok(json!({ "ok": true }))
            }
            "snapshot" => {
                let (tab_id, tab) = self.resolve_tab(session_id, &call.action, args)?;
                let epoch = tab.epoch.load(Ordering::Acquire);
                let out = self.eval(&tab_id, &js::snapshot_script()).await?;
                shape_snapshot(&out, &tab_id, epoch)
            }
            "screenshot" => {
                let (tab_id, _) = self.resolve_tab(session_id, &call.action, args)?;
                let png = self.screenshot_png(&tab_id).await?;
                // The session id is agent-generated — sanitize before it ever
                // touches a path (only [A-Za-z0-9_-] survive).
                let safe_sid: String = session_id
                    .chars()
                    .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
                    .collect();
                let dir = self
                    .app
                    .path()
                    .app_data_dir()
                    .map_err(|e| BrowserError::internal(format!("app_data_dir: {e}")))?
                    .join("browser-artifacts")
                    .join(if safe_sid.is_empty() {
                        "_".to_string()
                    } else {
                        safe_sid
                    });
                std::fs::create_dir_all(&dir)
                    .map_err(|e| BrowserError::internal(format!("artifact dir: {e}")))?;
                let path = dir.join(format!("shot-{}.png", Uuid::new_v4()));
                std::fs::write(&path, png)
                    .map_err(|e| BrowserError::internal(format!("write artifact: {e}")))?;
                Ok(json!({ "path": path.to_string_lossy() }))
            }
            "click" => {
                let (tab_id, tab) = self.resolve_tab(session_id, &call.action, args)?;
                let (el, epoch) = args
                    .get("ref")
                    .and_then(Value::as_str)
                    .map(|r| (r.to_string(), tab.epoch.load(Ordering::Acquire)))
                    .ok_or_else(|| BrowserError::invalid("missing 'ref'"))?;
                Self::check_ref(&el)?;
                self.click_ref(&tab_id, &el, epoch).await?;
                Ok(json!({ "ok": true }))
            }
            "fill" => {
                let (tab_id, tab) = self.resolve_tab(session_id, &call.action, args)?;
                let ref_id = args
                    .get("ref")
                    .and_then(Value::as_str)
                    .ok_or_else(|| BrowserError::invalid("missing 'ref'"))?;
                Self::check_ref(ref_id)?;
                let value = args
                    .get("value")
                    .and_then(Value::as_str)
                    .ok_or_else(|| BrowserError::invalid("missing 'value'"))?;
                let epoch = tab.epoch.load(Ordering::Acquire);
                let out = self
                    .eval(&tab_id, &js::fill_ref(ref_id, value, epoch))
                    .await?;
                eval_gate(out)?;
                Ok(json!({ "ok": true }))
            }
            "type" | "press" | "scroll" | "hover" => {
                let (tab_id, tab) = self.resolve_tab(session_id, &call.action, args)?;
                // `ref` is optional for these (type/press fall back to the
                // focused element); validate when present.
                if let Some(r) = args.get("ref").and_then(Value::as_str) {
                    Self::check_ref(r)?;
                }
                let epoch = tab.epoch.load(Ordering::Acquire);
                let out = self
                    .eval(&tab_id, &js::interaction(&call.action, args, epoch))
                    .await?;
                eval_gate(out)?;
                Ok(json!({ "ok": true }))
            }
            "wait" => {
                let (tab_id, _) = self.resolve_tab(session_id, &call.action, args)?;
                match args.get("ms").and_then(Value::as_u64) {
                    Some(ms) => {
                        tokio::time::sleep(std::time::Duration::from_millis(ms.min(30_000))).await
                    }
                    None => {
                        // wait for text present
                        let text = args
                            .get("text")
                            .and_then(Value::as_str)
                            .ok_or_else(|| BrowserError::invalid("wait needs 'ms' or 'text'"))?;
                        let deadline =
                            std::time::Instant::now() + std::time::Duration::from_secs(30);
                        loop {
                            let found = self
                                .eval(&tab_id, &js::contains_text(text))
                                .await
                                .ok()
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false);
                            if found {
                                break;
                            }
                            if std::time::Instant::now() > deadline {
                                return Err(BrowserError::new(
                                    ERR_TIMEOUT,
                                    "wait: text did not appear within 30s",
                                ));
                            }
                            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                        }
                    }
                }
                Ok(json!({ "ok": true }))
            }
            other => Err(BrowserError::invalid(format!("unknown action '{other}'"))),
        }
    }

    /// Click an `@eN` ref: resolve to a rect (the page re-verifies the
    /// fingerprint and reports `stale_ref` if the DOM changed), then drive
    /// real trusted input on Windows via CDP; fall back to a JS click
    /// elsewhere.
    async fn click_ref(&self, tab_id: &str, ref_id: &str, epoch: u64) -> Result<(), BrowserError> {
        let out = self.eval(tab_id, &js::resolve_ref(ref_id, epoch)).await?;
        eval_gate(out.clone())?;
        let rect = out.get("rect").cloned().ok_or_else(|| {
            BrowserError::new(ERR_STALE_REF, format!("{ref_id} no longer resolves"))
        })?;
        let x = rect.get("cx").and_then(Value::as_f64).unwrap_or(0.0);
        let y = rect.get("cy").and_then(Value::as_f64).unwrap_or(0.0);
        #[cfg(target_os = "windows")]
        {
            if let Err(e) = cdp::click_at(&self.tabs, tab_id, x, y).await {
                log::warn!("[browser-agent] CDP click failed, JS fallback: {e}");
                self.eval(tab_id, &js::dom_click(ref_id, epoch))
                    .await
                    .map(|_| ())?;
            }
            Ok(())
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = (x, y);
            let out = self.eval(tab_id, &js::dom_click(ref_id, epoch)).await?;
            eval_gate(out)?;
            Ok(())
        }
    }

    async fn screenshot_png(&self, tab_id: &str) -> Result<Vec<u8>, BrowserError> {
        #[cfg(target_os = "windows")]
        {
            return cdp::capture_screenshot(&self.tabs, tab_id).await;
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = tab_id;
            Err(BrowserError::capability(
                "screenshot requires the WebView2 engine (Windows)",
            ))
        }
    }

    fn close_agent_tab(&self, tab_id: &str) {
        let removed = self.agent_tabs.lock().remove(tab_id);
        if let Some(tab) = removed {
            self.emit(
                Some(&tab.session_id),
                EVENT_AGENT_TAB,
                &BrowserAgentTabEvent {
                    action: "close",
                    tab_id: tab_id.to_string(),
                    url: None,
                    session_id: tab.session_id.clone(),
                },
            );
            // The renderer removes the workspace tab on the event; also
            // destroy the native webview directly so a wedged renderer can't
            // leak it.
            let _ = self.tabs.destroy(tab_id);
            log::info!("[browser-agent] closed agent tab {tab_id}");
        }
    }
}

/// How `navigate` targets a tab (pure decision — unit-tested headlessly).
#[derive(Debug)]
enum NavigateResolution {
    /// Retarget this session-owned tab (explicit or default match).
    Reuse(String, Arc<AgentTab>),
    /// No `tabId` given and the session owns no agent tab — open one.
    AutoOpen,
    /// Return this typed `tab_not_found` error — an explicit
    /// non-resolving `tabId` never auto-opens.
    TabNotFound(BrowserError),
}

/// Decide which tab `navigate` targets (pure — no AppHandle/webview
/// types so every matrix row is headless-testable). `tab_id: None`
/// reuses the session's default tab (the single-reused-tab model) or
/// auto-opens when the session owns none; an explicit `tab_id` must
/// resolve to a tab owned by this session or the call fails with
/// `tab_not_found` and opens nothing.
fn navigate_resolution(
    tabs: &HashMap<String, Arc<AgentTab>>,
    session_id: &str,
    tab_id: Option<&str>,
) -> NavigateResolution {
    match owned_tab_or_default(tabs, session_id, tab_id) {
        Ok(Some((id, tab))) => NavigateResolution::Reuse(id, tab),
        Ok(None) => NavigateResolution::AutoOpen,
        Err(e) => NavigateResolution::TabNotFound(e),
    }
}

/// The session's default tab: the lexicographically smallest owned tab id
/// — deterministic across calls and processes (HashMap iteration order
/// is not). Several owned tabs can exist (`new_tab` mints by design);
/// the navigate arm still reuses exactly one of them.
fn default_session_tab(
    tabs: &HashMap<String, Arc<AgentTab>>,
    session_id: &str,
) -> Option<(String, Arc<AgentTab>)> {
    tabs.iter()
        .filter(|(_, t)| t.session_id == session_id)
        .min_by(|(a, _), (b, _)| a.cmp(b))
        .map(|(id, tab)| (id.clone(), tab.clone()))
}

/// Core tab-resolution rule shared by every action (pure — unit-tested):
/// an explicit `tab_id` must name a tab owned by `session_id`, otherwise
/// the call fails with `tab_not_found`; `None` resolves the session's
/// default tab ([`default_session_tab`]) or `None` when the session owns
/// no tab (the caller decides whether that means auto-open or an error).
fn owned_tab_or_default(
    tabs: &HashMap<String, Arc<AgentTab>>,
    session_id: &str,
    tab_id: Option<&str>,
) -> Result<Option<(String, Arc<AgentTab>)>, BrowserError> {
    if let Some(id) = tab_id {
        return match tabs.get(id) {
            Some(tab) if tab.session_id == session_id => Ok(Some((id.to_string(), tab.clone()))),
            _ => Err(BrowserError::tab_not_found(id)),
        };
    }
    Ok(default_session_tab(tabs, session_id))
}

/// Full action-target resolution (pure — unit-tested): strict `tabId`
/// arg validation (non-string/empty → `invalid_params` naming `tabId`,
/// never a silent fall-through to the default tab — for `close_tab`
/// that could close a tab the caller never named) combined with the
/// [`owned_tab_or_default`] ownership + deterministic default rule.
/// `Ok(None)` = no `tabId` given and the session owns no tab (the
/// caller decides whether that is auto-open or an error).
fn action_target(
    tabs: &HashMap<String, Arc<AgentTab>>,
    session_id: &str,
    action: &str,
    args: &Value,
) -> Result<Option<(String, Arc<AgentTab>)>, BrowserError> {
    let tab_id = DesktopBrowserHost::tab_id_arg(args, action)?;
    owned_tab_or_default(tabs, session_id, tab_id.as_deref())
}

/// `notify_tab_navigated` core (pure over the map): user/script-driven
/// navigation inside an agent tab advances that tab's epoch. A tab id
/// that is not an agent tab is a no-op.
fn bump_epoch_if_agent_tab(tabs: &HashMap<String, Arc<AgentTab>>, tab_id: &str) {
    if let Some(tab) = tabs.get(tab_id) {
        tab.bump_epoch();
    }
}

/// Map a page-side `{error: "…"}` result to the typed wire codes.
/// `stale_ref:` prefixes come straight back as `stale_ref` so agents can
/// take a fresh snapshot; anything else is internal.
fn eval_gate(out: Value) -> Result<(), BrowserError> {
    if let Some(e) = out.get("error").and_then(Value::as_str) {
        if e.starts_with("stale_ref") {
            return Err(BrowserError::new(ERR_STALE_REF, e));
        }
        return Err(BrowserError::new(ERR_INTERNAL, e));
    }
    Ok(())
}

/// Trailing marker appended when snapshot text is cut at the cap.
const SNAPSHOT_TRUNCATION_MARKER: &str = "\n…[snapshot truncated]";
/// Cap for page-controlled snapshot metadata (`url`, `title`) — keeps the
/// reply inside the child's reply bound even on an adversarial page.
const SNAPSHOT_META_MAX_CHARS: usize = 4 * 1024;

/// Hard cut at `max` bytes on a UTF-8 char boundary.
fn cut_at_char_boundary(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut cut = max;
    while !s.is_char_boundary(cut) {
        cut -= 1;
    }
    &s[..cut]
}

/// Snapshot text cap enforcement (pure — unit-tested): hard cut at
/// `SNAPSHOT_MAX_CHARS` on a char boundary, with a trailing marker so
/// the agent knows the text was truncated.
fn truncate_snapshot(text: String) -> String {
    if text.len() > SNAPSHOT_MAX_CHARS {
        let mut out = cut_at_char_boundary(&text, SNAPSHOT_MAX_CHARS).to_string();
        out.push_str(SNAPSHOT_TRUNCATION_MARKER);
        out
    } else {
        text
    }
}

/// Cap a page-controlled string field (pure — unit-tested). Metadata
/// fields get a plain cut — no truncation marker (that is snapshot-text
/// only); non-string values pass through untouched.
fn cap_snapshot_field(value: &Value, max: usize) -> Value {
    match value.as_str() {
        Some(s) => Value::String(cut_at_char_boundary(s, max).to_string()),
        None => value.clone(),
    }
}

/// Guard and shape a snapshot eval result into the wire reply (pure —
/// unit-tested). The eval result must be a JSON object — anything else
/// (null, string, …) is an `internal` error rather than a silently empty
/// snapshot; `text` is capped at `SNAPSHOT_MAX_CHARS` with the truncation
/// marker; page-controlled `url`/`title` are capped at
/// `SNAPSHOT_META_MAX_CHARS`.
fn shape_snapshot(out: &Value, tab_id: &str, epoch: u64) -> Result<Value, BrowserError> {
    if !out.is_object() {
        return Err(BrowserError::internal(
            "snapshot eval result was not an object",
        ));
    }
    Ok(json!({
        "tabId": tab_id,
        "epoch": epoch,
        "url": cap_snapshot_field(out.get("url").unwrap_or(&Value::Null), SNAPSHOT_META_MAX_CHARS),
        "title": cap_snapshot_field(out.get("title").unwrap_or(&Value::Null), SNAPSHOT_META_MAX_CHARS),
        "snapshot": truncate_snapshot(
            out.get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        ),
        "refs": out.get("refs").cloned().unwrap_or(json!(0)),
    }))
}

impl BrowserHost for DesktopBrowserHost {
    fn execute<'a>(
        &'a self,
        session_id: &'a str,
        agent_id: &'a str,
        call: BrowserCall,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, BrowserError>> + Send + 'a>>
    {
        Box::pin(async move {
            self.ensure_consent(session_id, agent_id, &call).await?;
            self.act(session_id, call).await
        })
    }

    fn end_session(&self, session_id: &str) {
        self.consent.lock().remove(session_id);
        // Deny any in-flight consent waiters for this session immediately —
        // they'd otherwise sit until the 120s timeout.
        if let Some(pc) = self.pending_consent.lock().remove(session_id) {
            for tx in pc.waiters {
                let _ = tx.send(false);
            }
        }
        // Drop the session's open-serialization lock entry — an in-flight
        // open keeps using its `Arc` clone, and session ids are unique so
        // a future session can't collide with it.
        self.session_open_locks.lock().remove(session_id);
        let ids: Vec<String> = {
            let tabs = self.agent_tabs.lock();
            tabs.iter()
                .filter(|(_, t)| t.session_id == session_id)
                .map(|(id, _)| id.clone())
                .collect()
        };
        for id in ids {
            self.close_agent_tab(&id);
        }
    }

    fn notify_tab_created(&self, tab_id: &str) -> bool {
        if let Some(tx) = self.pending_tab_open.lock().remove(tab_id) {
            let _ = tx.send(Ok(()));
            true
        } else {
            false
        }
    }

    fn notify_tab_closed(&self, tab_id: &str) {
        if self.agent_tabs.lock().remove(tab_id).is_some() {
            log::info!("[browser-agent] agent tab closed externally: {tab_id}");
        }
    }

    fn notify_tab_navigated(&self, tab_id: &str) {
        let tabs = self.agent_tabs.lock();
        bump_epoch_if_agent_tab(&tabs, tab_id);
    }

    fn resolve_consent(&self, request_id: &str, allowed: bool) -> bool {
        // Keyed by session, addressed by request id — find the session whose
        // pending prompt carries this request id (the map is tiny).
        let session = {
            let pending = self.pending_consent.lock();
            pending
                .iter()
                .find(|(_, pc)| pc.request_id == request_id)
                .map(|(sid, _)| sid.clone())
        };
        let Some(session) = session else {
            return false;
        };
        if let Some(pc) = self.pending_consent.lock().remove(&session) {
            for tx in pc.waiters {
                let _ = tx.send(allowed);
            }
            true
        } else {
            false
        }
    }

    fn resolve_eval(&self, nonce: &str, ok: bool, value: Option<String>) -> bool {
        match self.pending_eval.lock().remove(nonce) {
            Some(tx) => {
                let parsed = value
                    .map(|s| serde_json::from_str(&s).unwrap_or(Value::String(s)))
                    .unwrap_or(Value::Null);
                let _ = tx.send(if ok {
                    Ok(parsed)
                } else {
                    Err(value_text(&parsed))
                });
                true
            }
            None => false,
        }
    }
}

fn value_text(v: &Value) -> String {
    v.as_str()
        .map(str::to_string)
        .unwrap_or_else(|| v.to_string())
}

#[cfg(test)]
mod tests;
