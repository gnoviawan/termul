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
//!   `CallDevToolsProtocolMethod` for trusted input + screenshots. Other
//!   desktop platforms run the JS-eval action subset; non-desktop surfaces
//!   report `capability_unavailable`.
//! - Agent tabs are normal visible pane tabs (`BrowserTabManager`) marked
//!   agent-controlled; the first call per session gates on a one-time user
//!   consent (`acp:browser_consent_request` → `browser_consent_respond`).
//! - Observation is an injected aria-snapshot script with `@eN` fingerprint
//!   refs that re-resolve against a structural selector; navigation bumps a
//!   per-tab epoch so stale refs error as `stale_ref`.
//!
//! Logging: boundary/failure lines only — never page contents, cookies, or
//! typed values (CWE-532).

#[cfg(target_os = "windows")]
mod cdp;
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
    /// Bump the ref epoch so stored `@eN` refs die (`stale_ref` on next use).
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

struct AgentTab {
    session_id: String,
    /// Bumped on every navigation; snapshot refs capture the epoch.
    epoch: AtomicU64,
}

/// Desktop host: drives real pane webviews via `BrowserTabManager` —
/// JS eval bridge everywhere; WebView2 CDP for trusted input + screenshots
/// on Windows (`cdp` module, feature of the platform not the code path).
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
        })
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

    /// Resolve the target tab for an action. `None` → the session's most
    /// recent agent tab; creating one is the caller's job (needs a URL).
    fn resolve_tab(
        &self,
        session_id: &str,
        tab_id: Option<&str>,
    ) -> Result<(String, Arc<AgentTab>), BrowserError> {
        let tabs = self.agent_tabs.lock();
        if let Some(id) = tab_id {
            let tab = tabs.get(id).cloned();
            return match tab {
                Some(t) if t.session_id == session_id => Ok((id.to_string(), t)),
                Some(_) => Err(BrowserError::tab_not_found(id)),
                None => Err(BrowserError::tab_not_found(id)),
            };
        }
        // Default: any tab owned by this session (at most a handful).
        tabs.iter()
            .find(|(_, t)| t.session_id == session_id)
            .map(|(id, t)| (id.clone(), t.clone()))
            .ok_or_else(|| {
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

    // -- eval bridge --------------------------------------------------------
    //
    // `webview.eval` is fire-and-forget; results return through the
    // `browser_agent_eval_result` command (caller-validated to the tab).

    async fn eval(&self, tab_id: &str, expr: &str) -> Result<Value, BrowserError> {
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

    fn bump_epoch(&self, tab: &AgentTab) {
        tab.epoch.fetch_add(1, Ordering::AcqRel);
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
                let url = args.get("url").and_then(Value::as_str).map(str::to_string);
                if let Some(u) = &url {
                    Self::check_url(u)?;
                }
                let tab_id = self.open_agent_tab(session_id, url.as_deref()).await?;
                Ok(json!({ "tabId": tab_id }))
            }
            "close_tab" => {
                let (tab_id, _) =
                    self.resolve_tab(session_id, args.get("tabId").and_then(Value::as_str))?;
                self.close_agent_tab(&tab_id);
                Ok(json!({ "closed": tab_id }))
            }
            "navigate" => {
                let url =
                    Self::check_url(args.get("url").and_then(Value::as_str).unwrap_or_default())?;
                let (tab_id, tab, fresh) =
                    match self.resolve_tab(session_id, args.get("tabId").and_then(Value::as_str)) {
                        Ok((id, t)) => (id, t, false),
                        Err(_) => {
                            // Auto-open: the first navigate creates the visible
                            // tab already pointing at the target URL (the
                            // renderer loads it on mount — no double nav).
                            let id = self.open_agent_tab(session_id, Some(&url)).await?;
                            let tab = self.agent_tab(&id).expect("just inserted");
                            (id, tab, true)
                        }
                    };
                if !fresh {
                    self.tabs
                        .navigate(&tab_id, url.clone())
                        .map_err(BrowserError::internal)?;
                }
                self.bump_epoch(&tab);
                let _ = self.settle(&tab_id).await;
                let url_now = self.tabs.info(&tab_id).map(|i| i.url).unwrap_or(url);
                Ok(json!({ "tabId": tab_id, "url": url_now }))
            }
            "back" | "forward" | "reload" => {
                let (tab_id, tab) =
                    self.resolve_tab(session_id, args.get("tabId").and_then(Value::as_str))?;
                let r = match call.action.as_str() {
                    "back" => self.tabs.go_back(&tab_id),
                    "forward" => self.tabs.go_forward(&tab_id),
                    _ => self.tabs.reload(&tab_id),
                };
                r.map_err(BrowserError::internal)?;
                self.bump_epoch(&tab);
                let _ = self.settle(&tab_id).await;
                Ok(json!({ "ok": true }))
            }
            "snapshot" => {
                let (tab_id, tab) =
                    self.resolve_tab(session_id, args.get("tabId").and_then(Value::as_str))?;
                let epoch = tab.epoch.load(Ordering::Acquire);
                let out = self.eval(&tab_id, &js::snapshot_script()).await?;
                let mut text = out
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if text.len() > SNAPSHOT_MAX_CHARS {
                    let mut cut = SNAPSHOT_MAX_CHARS;
                    while !text.is_char_boundary(cut) {
                        cut -= 1;
                    }
                    text.truncate(cut);
                    text.push_str("\n…[snapshot truncated]");
                }
                Ok(json!({
                    "tabId": tab_id,
                    "epoch": epoch,
                    "url": out.get("url").cloned().unwrap_or(Value::Null),
                    "title": out.get("title").cloned().unwrap_or(Value::Null),
                    "snapshot": text,
                    "refs": out.get("refs").cloned().unwrap_or(json!(0)),
                }))
            }
            "screenshot" => {
                let (tab_id, _) =
                    self.resolve_tab(session_id, args.get("tabId").and_then(Value::as_str))?;
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
                let (tab_id, tab) =
                    self.resolve_tab(session_id, args.get("tabId").and_then(Value::as_str))?;
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
                let (tab_id, tab) =
                    self.resolve_tab(session_id, args.get("tabId").and_then(Value::as_str))?;
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
                eval_gate(out, epoch)?;
                Ok(json!({ "ok": true }))
            }
            "type" | "press" | "scroll" | "hover" => {
                let (tab_id, tab) =
                    self.resolve_tab(session_id, args.get("tabId").and_then(Value::as_str))?;
                // `ref` is optional for these (type/press fall back to the
                // focused element); validate when present.
                if let Some(r) = args.get("ref").and_then(Value::as_str) {
                    Self::check_ref(r)?;
                }
                let epoch = tab.epoch.load(Ordering::Acquire);
                let out = self
                    .eval(&tab_id, &js::interaction(&call.action, args, epoch))
                    .await?;
                eval_gate(out, epoch)?;
                Ok(json!({ "ok": true }))
            }
            "wait" => {
                let (tab_id, _) =
                    self.resolve_tab(session_id, args.get("tabId").and_then(Value::as_str))?;
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

    /// Click an `@eN` ref: resolve to a rect (epoch-checked), then drive real
    /// trusted input on Windows via CDP; fall back to a JS click elsewhere.
    async fn click_ref(&self, tab_id: &str, ref_id: &str, epoch: u64) -> Result<(), BrowserError> {
        let out = self.eval(tab_id, &js::resolve_ref(ref_id, epoch)).await?;
        eval_gate(out.clone(), epoch)?;
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
            eval_gate(out, epoch)?;
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

/// Map a page-side `{error: "…"}` result to the typed wire codes.
/// `stale_ref:` prefixes come straight back as `stale_ref` so agents can
/// take a fresh snapshot; anything else is internal.
fn eval_gate(out: Value, _epoch: u64) -> Result<(), BrowserError> {
    if let Some(e) = out.get("error").and_then(Value::as_str) {
        if e.starts_with("stale_ref") {
            return Err(BrowserError::new(ERR_STALE_REF, e));
        }
        return Err(BrowserError::new(ERR_INTERNAL, e));
    }
    Ok(())
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
        if let Some(tab) = self.agent_tab(tab_id) {
            self.bump_epoch(&tab);
        }
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
mod tests {
    use super::*;

    /// Alias for the shared test lock (see `TEST_HOST_LOCK`).
    use super::TEST_HOST_LOCK as HOST_LOCK;

    fn call(action: &str, args: Value) -> BrowserCall {
        BrowserCall {
            action: action.to_string(),
            args,
            element: None,
        }
    }

    #[test]
    fn dispatch_without_host_fails_closed() {
        let _g = HOST_LOCK.lock().unwrap();
        clear_browser_host();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let err = rt
            .block_on(dispatch(
                "sess",
                "agent",
                call("navigate", json!({"url": "https://x"})),
            ))
            .expect_err("no host must fail closed");
        assert_eq!(err.code, ERR_CAPABILITY);
    }

    #[test]
    fn hooks_without_host_are_noops() {
        let _g = HOST_LOCK.lock().unwrap();
        clear_browser_host();
        assert!(!tab_created("t1"));
        // Real nonces/request ids are `Uuid`s — keep the test values in the
        // same shape (and avoid hard-coded literal nonces).
        assert!(!eval_resolved(&Uuid::new_v4().to_string(), true, None));
        assert!(!consent_responded(&Uuid::new_v4().to_string(), true));
        tab_closed("t1");
        tab_navigated("t1");
        session_ended("s1");
    }

    #[test]
    fn url_allowlist_accepts_http_s_only() {
        assert!(DesktopBrowserHost::check_url("https://example.com").is_ok());
        assert!(DesktopBrowserHost::check_url("http://127.0.0.1:3000/app").is_ok());
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<h1>x</h1>",
            "about:blank",
            "not a url",
            "",
        ] {
            assert!(
                DesktopBrowserHost::check_url(bad).is_err(),
                "must reject {bad}"
            );
        }
    }

    #[test]
    fn eval_gate_maps_stale_ref_prefix() {
        let err = eval_gate(json!({"error": "stale_ref: @e3 detached"}), 1)
            .expect_err("stale prefix maps to stale_ref");
        assert_eq!(err.code, ERR_STALE_REF);
        let err = eval_gate(json!({"error": "boom"}), 1).expect_err("other errors internal");
        assert_eq!(err.code, ERR_INTERNAL);
        eval_gate(json!({"ok": true}), 1).expect("no error field passes");
    }

    /// A registered host routes dispatch end-to-end; `session_ended` reaches
    /// `end_session` so tabs/consent are reclaimed.
    #[test]
    fn registered_host_routes_dispatch_and_session_end() {
        let _g = HOST_LOCK.lock().unwrap();
        clear_browser_host();
        struct Stub {
            ended: parking_lot::Mutex<Vec<String>>,
        }
        impl BrowserHost for Stub {
            fn execute<'a>(
                &'a self,
                session_id: &'a str,
                _agent_id: &'a str,
                call: BrowserCall,
            ) -> std::pin::Pin<
                Box<dyn std::future::Future<Output = Result<Value, BrowserError>> + Send + 'a>,
            > {
                Box::pin(async move { Ok(json!({ "sid": session_id, "action": call.action })) })
            }
            fn end_session(&self, session_id: &str) {
                self.ended.lock().push(session_id.to_string());
            }
            fn notify_tab_created(&self, _tab_id: &str) -> bool {
                false
            }
            fn notify_tab_closed(&self, _tab_id: &str) {}
            fn notify_tab_navigated(&self, _tab_id: &str) {}
            fn resolve_consent(&self, _request_id: &str, _allowed: bool) -> bool {
                false
            }
            fn resolve_eval(&self, _nonce: &str, _ok: bool, _value: Option<String>) -> bool {
                false
            }
        }
        let stub = Arc::new(Stub {
            ended: parking_lot::Mutex::new(Vec::new()),
        });
        set_browser_host(stub.clone());
        let rt = tokio::runtime::Runtime::new().unwrap();
        let out = rt
            .block_on(dispatch("sess-1", "agent", call("list_tabs", Value::Null)))
            .expect("stub host resolves");
        assert_eq!(out["sid"], "sess-1");
        assert_eq!(out["action"], "list_tabs");
        session_ended("sess-1");
        assert_eq!(stub.ended.lock().as_slice(), &["sess-1".to_string()]);
        clear_browser_host();
    }

    #[test]
    fn browser_call_deserializes_action_args_element() {
        let c: BrowserCall = serde_json::from_value(json!({
            "action": "click",
            "args": {"ref": "@e2"},
            "element": "the login button"
        }))
        .unwrap();
        assert_eq!(c.action, "click");
        assert_eq!(c.args["ref"], "@e2");
        assert_eq!(c.element.as_deref(), Some("the login button"));

        let bare: BrowserCall = serde_json::from_value(json!({"action": "snapshot"})).unwrap();
        assert!(bare.args.is_null());
        assert!(bare.element.is_none());
    }
}
