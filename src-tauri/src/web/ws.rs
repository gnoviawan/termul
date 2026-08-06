//! WS relay protocol — frame envelopes, seq, event log, cursor, tiers (Story 1.4+1.6).
//!
//! One multiplexed bidirectional WebSocket per browser connection carries all
//! sessions (AC1). The wire contract is defined here and mirrored 1:1 in
//! `src/shared/types/web-protocol.types.ts` (AC2).
//!
//! # Wire casing (AC3 — deviation from architecture text, MUST follow)
//!
//! The **envelope** fields (`sid`, `seq`, `type`, `payload`) are snake_case.
//! The **payload** is the existing camelCase-serialized ACP event struct
//! `Value` (byte-identical to what `TauriEventSink` emits today — `fan_out`
//! serializes ONCE, fans out N). This module does NOT re-case payloads.
//!
//! # OS vs human cap boundary (AC8)
//!
//! The server is the ACP client-of-record (thin relay, not pure ACP-over-WS).
//! OS caps ([`OS_FULFILLED_CAPS`]) are fulfilled by the server; only human caps
//! ([`HUMAN_RELAYED_CAPS`]) are relayed to the browser. A browser WS request
//! for an OS cap is rejected with `err.code: "unsupported"`.
//!
//! # Scope fence
//!
//! `authenticate` is a placeholder (accepts any token; Epic 2 replaces).
//! `subscribe` is wired (Story 1.6): binds the connection to a session log with
//! optional `lastSeq` cursor replay. Other ACP request types still return
//! `err.code: "not_implemented"` until Stories 1.7/1.8/Epic 4.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use crate::acp::config::AgentConfig;
use crate::acp::{AcpManager, AgentId, FileProjectRegistry, SessionCreationContext, SessionId};
use crate::pty::PtyManager;
use crate::trackers::{CwdTracker, ExitCodeTracker, GitTracker, TerminalEventHub};
use crate::web::permissions::{TurnClaim, DEFAULT_PERMISSION_RECONNECT_GRACE};
use crate::web::project_registry::{ProjectRegistry, ProjectSwitchContext};
use crate::web::sink::{broadcast_projects_changed, ClientId, ReplayResult, WsRelaySink};

// ---------------------------------------------------------------------------
// Sequenced event — the wire envelope (AC2 + AC3)
// ---------------------------------------------------------------------------

/// A sequenced event ready for fan-out + cursor replay.
///
/// Serializes to the WS event envelope `{sid, seq, type, payload}` (snake_case
/// envelope; `payload` is the camelCase ACP event struct `Value` passed through
/// verbatim). `seq` is `0` for agent-level (`sid: None`) + relay-level events.
#[derive(Debug, Clone, Serialize)]
pub struct SequencedEvent {
    /// Session id, or `None` for agent-level / relay-level events.
    pub sid: Option<String>,
    /// Per-session monotonic sequence (starts at 1). `0` for agent-level.
    pub seq: u64,
    /// Event `type` (prefix-dropped snake_case, e.g. `message_chunk`).
    #[serde(rename = "type")]
    pub type_: String,
    /// The camelCase ACP event struct value (passed through verbatim).
    pub payload: Value,
}

impl SequencedEvent {
    /// Build a sequenced event from a prefix-dropped type + payload.
    #[must_use]
    pub fn new(sid: Option<String>, seq: u64, type_: impl Into<String>, payload: Value) -> Self {
        Self {
            sid,
            seq,
            type_: type_.into(),
            payload,
        }
    }
}

// ---------------------------------------------------------------------------
// Reliability tier registry (AC5) — single Rust enum + tier_of
// ---------------------------------------------------------------------------

/// The three delivery tiers for a WS event type. Mirrors the TS
/// `WS_RELAY_TIERS` const.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReliabilityTier {
    /// Drop-oldest on a slow client (high-frequency streams).
    Lossy,
    /// Never dropped (unbounded per-client queue in this story).
    Reliable,
    /// Dedup by turn-id before enqueue.
    Idempotent,
}

/// Map a prefix-dropped event `type` to its [`ReliabilityTier`].
///
/// Lossy: `message_chunk`, `tool_call_update`, `commands_update`, `plan_update`.
/// Idempotent: `prompt_complete`.
/// Reliable: everything else (including `permission_request` + all request↔reply,
/// though request↔reply reliability is enforced at the request layer, not here).
/// Unknown types default to [`ReliabilityTier::Reliable`] (the safe choice —
/// never drop an event the relay does not recognize).
#[must_use]
pub fn tier_of(type_: &str) -> ReliabilityTier {
    match type_ {
        "message_chunk" | "tool_call_update" | "commands_update" | "plan_update" => {
            ReliabilityTier::Lossy
        }
        "prompt_complete" => ReliabilityTier::Idempotent,
        _ => ReliabilityTier::Reliable,
    }
}

// ---------------------------------------------------------------------------
// Request / reply / error envelope structs (AC2 + AC10)
// ---------------------------------------------------------------------------

/// A WS request frame `{id, type, payload}` sent client→server.
#[derive(Debug, Clone, Deserialize)]
pub struct WsRequest {
    /// Client-chosen correlation id (echoed in the reply).
    pub id: String,
    /// Request `type` (prefix-dropped snake_case).
    #[serde(rename = "type")]
    pub type_: String,
    /// Request payload (shape depends on `type`).
    #[serde(default = "Value::default")]
    pub payload: Value,
}

/// A WS reply frame `{id, ok, payload?, err?}` sent server→client.
#[derive(Debug, Clone, Serialize)]
pub struct WsReply {
    /// Echoes the request `id`.
    pub id: String,
    /// `true` for success, `false` for failure.
    pub ok: bool,
    /// Success payload (omitted on failure).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
    /// Failure detail (omitted on success).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub err: Option<WsError>,
}

impl WsReply {
    /// Build a success reply.
    #[must_use]
    pub fn ok(id: impl Into<String>, payload: Option<Value>) -> Self {
        Self {
            id: id.into(),
            ok: true,
            payload,
            err: None,
        }
    }

    /// Build a failure reply with a stable code + human message.
    #[must_use]
    pub fn err(id: impl Into<String>, code: WsErrorCode, message: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            ok: false,
            payload: None,
            err: Some(WsError {
                code: code.as_str().to_string(),
                message: message.into(),
            }),
        }
    }
}

/// The `err` object inside a failing [`WsReply`].
#[derive(Debug, Clone, Serialize)]
pub struct WsError {
    /// Stable machine string (one of [`WsErrorCode`]).
    pub code: String,
    /// Human-readable message.
    pub message: String,
}

/// The 10 stable `err.code` machine strings (AC2). Mirrors the TS
/// `WS_ERROR_CODES` const. Serialized as snake_case via [`WsErrorCode::as_str`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WsErrorCode {
    NotFound,
    Unauthorized,
    RateLimited,
    AgentCrashed,
    PermissionDenied,
    Stale,
    Duplicate,
    Unsupported,
    NotImplemented,
    /// `switch_project` was sent on a connection with no live agent yet
    /// (cold web tab) — the server refuses to auto-spawn. Epic-4 bridge.
    NoAgent,
}

impl WsErrorCode {
    /// The stable snake_case wire string for this code.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::NotFound => "not_found",
            Self::Unauthorized => "unauthorized",
            Self::RateLimited => "rate_limited",
            Self::AgentCrashed => "agent_crashed",
            Self::PermissionDenied => "permission_denied",
            Self::Stale => "stale",
            Self::Duplicate => "duplicate",
            Self::Unsupported => "unsupported",
            Self::NotImplemented => "not_implemented",
            Self::NoAgent => "no_agent",
        }
    }
}

// ---------------------------------------------------------------------------
// OS vs human cap boundary (AC8)
// ---------------------------------------------------------------------------

/// ACP caps the SERVER fulfills locally (the browser cannot perform them).
/// `terminal/*` is a prefix — every cap under `terminal/` is OS-fulfilled.
pub const OS_FULFILLED_CAPS: &[&str] = &["fs/read_text_file", "fs/write_text_file", "terminal/*"];

/// ACP caps RELAYED to the browser (human-in-the-loop).
pub const HUMAN_RELAYED_CAPS: &[&str] = &["session_notification", "request_permission"];

/// Whether `cap` matches an OS-fulfilled cap entry (exact, or prefix match for
/// entries ending in `/*`). Enforced at the request-handling layer (AC8).
#[must_use]
pub fn is_os_fulfilled_cap(cap: &str) -> bool {
    OS_FULFILLED_CAPS.iter().copied().any(|entry| {
        entry == cap || entry.ends_with("/*") && cap.starts_with(&entry[..entry.len() - 1])
    })
}

/// Whether `cap` matches a human-relayed cap entry (exact match).
#[must_use]
pub fn is_human_relayed_cap(cap: &str) -> bool {
    HUMAN_RELAYED_CAPS.iter().copied().any(|entry| entry == cap)
}

/// Map an `AcpManager` prompt error to a stable WS `err.code` (Story 1.7 T7.1).
///
/// `AcpManager::send_prompt` (via `DriverState::try_begin_turn`) rejects a
/// concurrent prompt on the same session with the string
/// `"ACP_TURN_IN_PROGRESS: session {id}"`. The renderer keys on that stable
/// code (`ACP_TURN_IN_PROGRESS_CODE`). For the WS path (Story 1.8's
/// `send_prompt`), this maps it to [`WsErrorCode::RateLimited`] (the closest
/// stable `err.code` for "try again shortly" — the architecture's set has no
/// dedicated turn-busy code). Returns `None` for any other error string.
#[must_use]
pub fn map_prompt_error_code(err: &str) -> Option<WsErrorCode> {
    if err.starts_with("ACP_TURN_IN_PROGRESS") {
        Some(WsErrorCode::RateLimited)
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Router state (AC1 + AC7)
// ---------------------------------------------------------------------------

/// Shared Axum state for the standalone server: the ACP manager + the live
/// WS relay sink + the in-memory project registry (Epic-4 bridge). Typed
/// struct (preferred over tuple state past 2 fields).
#[derive(Clone)]
pub struct AppState {
    /// The ACP manager (server is the ACP client-of-record).
    pub acp: Arc<AcpManager>,
    /// Interactive PTYs exposed on the separate `/terminal/ws` endpoint.
    pub pty: Arc<PtyManager>,
    pub terminal_events: TerminalEventHub,
    pub cwd_tracker: Arc<CwdTracker>,
    pub git_tracker: Arc<GitTracker>,
    pub exit_code_tracker: Arc<ExitCodeTracker>,
    /// The live WS relay sink (owns per-session logs + seq counters + subs).
    pub relay: Arc<WsRelaySink>,
    /// In-memory, renderer-fed project registry — source for `GET /projects`
    /// + `switch_project` cwd resolution. Empty on the standalone path.
    pub registry: Arc<ProjectRegistry>,
    /// Optional writable VPS file registry + configured path. Desktop shared-live
    /// passes `None`, so switching there remains file-free.
    pub registry_persistence: Option<Arc<parking_lot::Mutex<FileProjectRegistry>>>,
    pub projects_file: Option<Arc<PathBuf>>,
    /// Deployment history provider exposed to authenticated browser clients.
    pub history_mode: HistoryMode,
    /// Host-owned versioned workspace manifest service (CAP-5 / Story 5).
    /// `None` when the desktop could not open `WorkspaceManifestService` at
    /// startup (degraded fresh-only mode) — routes return `Ok(None)` /
    /// idempotent success in that case. The web/remote client reads/writes a
    /// project's manifest through the three `/workspace/*` routes in
    /// `workspace_api.rs`; the desktop renderer uses the `workspace_manifest_*`
    /// Tauri commands (same `IpcResult<T>` shape byte-for-byte).
    pub workspace_manifest: Option<Arc<crate::acp::WorkspaceManifestService>>,
    /// Host-owned ACP catalog service (CAP-6 / Story 8). `None` when the
    /// desktop could not open `AcpCatalogService` at startup (degraded mode —
    /// routes return `ACP_CATALOG_UNAVAILABLE`). The web/remote client reads
    /// the resolved catalog through `GET /acp/catalog` + WS
    /// `list_acp_catalog`; the desktop renderer uses the `acp_list_catalog` +
    /// `acp_set_catalog_opt_in` Tauri commands (same `IpcResult<T>` shape
    /// byte-for-byte).
    pub acp_catalog: Option<Arc<crate::acp::AcpCatalogService>>,
    /// PR-S4: the project-root boundary for the fs_api routes. Requests whose
    /// canonicalized target path resolves outside this root are refused with
    /// `code: "OUTSIDE_ROOT"` (or `PATH_TRAVERSAL` for explicit `..`
    /// components). Resolved from `ServerConfig::project_root` at startup;
    /// defaults to the user's home directory when unset.
    pub project_root: Arc<std::path::PathBuf>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HistoryMode {
    Server,
    LiveOnly,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePolicy {
    /// Authoritative absolute server turn ceiling, in ms. `0` is the
    /// **unlimited** sentinel — no hard cap is imposed (the default). A
    /// non-zero value is the bounded hard-cap deadline the client should not
    /// let its inactivity refresh extend past.
    pub turn_timeout_ms: u64,
    /// Inactivity budget, in ms, refreshed on matching-session activity. `0`
    /// is the **unlimited** sentinel — the client imposes no inactivity timer
    /// (the default). A non-zero value is the bounded inactivity window.
    pub prompt_inactivity_timeout_ms: u64,
    pub permission_reconnect_grace_ms: u64,
    pub ping_interval_ms: u64,
    pub pong_timeout_ms: u64,
}

impl RuntimePolicy {
    #[must_use]
    pub fn resolved(permission_reconnect_grace: Duration) -> Self {
        let turn_timeout = crate::acp::manager::resolved_turn_timeout(); // Option
        let turn_idle = crate::acp::manager::turn_idle_timeout();         // Option
        // `turn_timeout_ms`: 0 = unlimited (no hard cap) sentinel; otherwise
        // the bounded hard cap in ms.
        let turn_timeout_ms = turn_timeout.map(|d| d.as_millis() as u64).unwrap_or(0);
        // Inactivity budget published to the client. Preserve the original
        // `hard/2` derivation when a hard cap is configured (bounded, strictly
        // shorter than the ceiling); otherwise use the idle timeout when it is
        // configured (bounded); otherwise 0 (unlimited — no client-side
        // inactivity timer). 0 keeps the client's `setTimeout` well under the
        // browser 32-bit ceiling and defers entirely to the server.
        let prompt_inactivity_timeout_ms = match (turn_timeout, turn_idle) {
            (Some(hard), _) => (hard.as_millis() as u64 / 2).max(1),
            (None, Some(idle)) => idle.as_millis() as u64,
            (None, None) => 0,
        };
        Self {
            turn_timeout_ms,
            prompt_inactivity_timeout_ms,
            permission_reconnect_grace_ms: permission_reconnect_grace.as_millis() as u64,
            ping_interval_ms: PING_INTERVAL.as_millis() as u64,
            pong_timeout_ms: PONG_TIMEOUT.as_millis() as u64,
        }
    }
}

// ---------------------------------------------------------------------------
// WS upgrade handler + relay loop (AC1 + AC9 + AC10)
// ---------------------------------------------------------------------------

/// Outbound frame on a connection's write loop (event or reply).
enum Outbound {
    /// A sequenced event (server→client push).
    Event(SequencedEvent),
    /// A reply to a client request.
    Reply(WsReply),
}

/// The `auth_required` event type name (relay-level, not from `events.rs`).
pub const AUTH_REQUIRED_TYPE: &str = "auth_required";

/// Build the `auth_required` event (sid=null, seq=0, payload={}).
fn auth_required_event() -> SequencedEvent {
    SequencedEvent::new(None, 0, AUTH_REQUIRED_TYPE, json!({}))
}

/// Axum WS upgrade handler for `/ws` (AC1).
///
/// The upgrade is gated behind a placeholder `pre_auth` check (AC1): the
/// primary auth gate is the first-frame `auth_required` emission (AC9). The
/// default bind stays localhost per `web/config.rs`.
pub async fn ws_upgrade(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    // Placeholder pre_auth check (AC1) — Epic 2 wires the real token gate.
    // Until then, the upgrade always proceeds; the first frame is auth_required.
    ws.on_upgrade(move |socket| async move {
        run_relay(socket, state).await;
    })
}

/// Keepalive Ping interval for the `/ws` relay.
///
/// Browser WebSockets never send their own pings (the WS API hides
/// ping/pong control frames from JavaScript), so without a server-emitted
/// Ping the socket goes silent during long agent turns — especially the
/// "thinking"/reasoning phase, which can produce no `session/update` chunks
/// for tens of seconds. Idle NAT/proxy hops and backgrounded mobile browser
/// tabs then RST the TCP connection (surfacing in the log as
/// "Connection reset without closing handshake" and in the chat UI as a
/// mid-response disconnect). 20s is well under common idle timeouts
/// (60–300s) yet light enough not to spam a recovering link.
const PING_INTERVAL: Duration = Duration::from_secs(20);

/// How long without ANY client→server frame (a Pong answering our keepalive
/// Ping, a request, or a client Ping) before the server declares the
/// connection half-open and tears it down. ~3.5× the ping interval to absorb
/// jitter on slow/mobile links while still bounding a dead socket so the
/// relay reaps subscriptions + denies outstanding permissions and the
/// browser's reconnect+cursor-resubscribe path can engage.
const PONG_TIMEOUT: Duration = Duration::from_secs(75);

/// Reusable Ping payload (opaque; browsers must echo it back in the Pong, but
/// the relay does not correlate — any inbound frame resets the watchdog).
/// Must stay under 125 bytes per RFC 6455 control-frame limits.
const PING_PAYLOAD: &[u8] = b"keepalive";

/// Pure keepalive-watchdog decision: returns true when no inbound frame
/// (text request, Pong, or client Ping) has arrived for longer than
/// `PONG_TIMEOUT`. Extracted from the write task so the threshold semantics
/// (strict `>`) are unit-testable without spinning up a real socket. The write
/// task calls this with `last_activity.load()` + `now_ms()` on each ping tick.
fn watchdog_is_stale(last_activity_ms: u64, now_ms_value: u64) -> bool {
    now_ms_value.saturating_sub(last_activity_ms) > PONG_TIMEOUT.as_millis() as u64
}

/// Epoch-millis timestamp for the keepalive watchdog. Uses `SystemTime` (not
/// `Instant`) so it fits an `AtomicU64`; clock skew inside one process over a
/// ~minute window is negligible, and `saturating_sub` keeps the compare safe
/// even if the clock jumps backwards.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Run the per-connection relay loop: a write task draining the outbound
/// channel + a read task routing requests. Returns when either half closes.
async fn run_relay(socket: WebSocket, state: AppState) {
    let (mut sink, mut stream) = socket.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Outbound>();
    let relay = Arc::clone(&state.relay);
    // Story 1.8: the ACP manager — the server is the ACP client-of-record; the
    // 10 ACP command handlers (`send_prompt`, `create_session`, …) forward to it.
    let acp = Arc::clone(&state.acp);
    // Epic-4 bridge: the in-memory project registry — source for `GET /projects`
    // (router) + `switch_project` cwd resolution (this handler).
    let registry = Arc::clone(&state.registry);
    let registry_persistence = state.registry_persistence.clone();
    let projects_file = state.projects_file.clone();
    let history_mode = state.history_mode;
    // CAP-6 / Story 8: the host-owned ACP catalog service for the
    // `list_acp_catalog` + `set_catalog_opt_in` WS requests.
    let acp_catalog = state.acp_catalog.clone();
    // Client ids registered via `subscribe` — unregistered on disconnect.
    let mut subscribed_clients: Vec<(String, ClientId)> = Vec::new();
    // Per-connection tracking for `switch_project` (Ask-First resolution): the
    // last agent + session this connection used. `switch_project` reuses the
    // agent rather than auto-spawning; a cold tab (no agent yet) → `NO_AGENT`.
    // The old web-focused session is closed server-side after the new one is
    // ready. Set by `spawn_agent` / `create_session` / `load_session` /
    // `resume_session` (the handlers that carry an agentId / create a session).
    let mut current_agent: Option<crate::acp::AgentId> = None;
    let current_session = Arc::new(parking_lot::Mutex::new(None::<crate::acp::SessionId>));
    // Project identity is connection-local. The registry's active id may have
    // been changed by another browser/desktop and cannot prove this socket's
    // tracked session is already rooted at that project.
    let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
    let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));

    // AC9: emit auth_required on the connection before anything else.
    if out_tx.send(Outbound::Event(auth_required_event())).is_err() {
        return; // receiver dropped before we started — peer already gone.
    }

    // Keepalive watchdog: shared "last seen alive" epoch-ms. The read task
    // stamps it on every inbound frame (text request, Pong, or client Ping);
    // the write task consults it on each keepalive tick to detect a
    // half-open/dead peer. Browser WebSockets auto-pong protocol-level Pings
    // (the WS API never exposes ping/pong to JS), so a server-emitted Ping is
    // the only way to refresh NAT/proxy/browser idle timers during silent
    // reasoning phases and to surface a dead client promptly.
    let last_activity = Arc::new(AtomicU64::new(now_ms()));
    let write_last_activity = Arc::clone(&last_activity);

    let write_tx = out_tx.clone();
    let mut write_task = tokio::spawn(async move {
        let mut ping = tokio::time::interval(PING_INTERVAL);
        // Steady, not bursty: if a slow client stalled the write loop, don't
        // ping-storm it on recovery — delay missed ticks to the next period.
        ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // Discard the immediate first tick so the first keepalive lands one
        // full interval after connect (a fresh connection needs no keepalive
        // yet and the auth_required frame has just been queued).
        ping.tick().await;
        loop {
            tokio::select! {
                frame = out_rx.recv() => {
                    let Some(frame) = frame else { break };
                    let text = match frame {
                        Outbound::Event(evt) => serde_json::to_string(&evt).unwrap_or_else(|e| {
                            warn!("[ws] failed to serialize event {}: {e}", evt.type_);
                            String::new()
                        }),
                        Outbound::Reply(rep) => serde_json::to_string(&rep).unwrap_or_else(|e| {
                            warn!("[ws] failed to serialize reply for {}: {e}", rep.id);
                            String::new()
                        }),
                    };
                    if text.is_empty() {
                        continue;
                    }
                    if sink.send(Message::Text(text.into())).await.is_err() {
                        break; // peer gone — stop writing.
                    }
                }
                _ = ping.tick() => {
                    // Send a keepalive Ping. The browser auto-pongs at the
                    // protocol layer; that Pong (or any client→server frame)
                    // refreshes `last_activity`.
                    if sink.send(Message::Ping(PING_PAYLOAD.to_vec().into())).await.is_err() {
                        break; // peer gone — stop writing.
                    }
                    // Dead-peer detection: if nothing has arrived from the
                    // client for PONG_TIMEOUT (no Pong, no request, no close),
                    // the connection is half-open. Tear it down so the read
                    // loop ends and the client's reconnect logic engages
                    // instead of the server silently holding a dead socket
                    // (which would otherwise leak subscriptions + pending
                    // permissions and stall the chat UI mid-response).
                    let last = write_last_activity.load(Ordering::Relaxed);
                    let now = now_ms();
                    let stale = now.saturating_sub(last);
                    if watchdog_is_stale(last, now) {
                        warn!(
                            "[ws] keepalive: no client activity for {stale} ms \
                             (>{PONG_TIMEOUT:?}); closing connection"
                        );
                        break;
                    }
                }
            }
        }
    });

    let read_last_activity = Arc::clone(&last_activity);
    let mut read_task = tokio::spawn(async move {
        let mut authed = false;
        while let Some(frame) = stream.next().await {
            let msg = match frame {
                Ok(m) => m,
                Err(e) => {
                    warn!("[ws] read error: {e}");
                    break;
                }
            };
            // Any frame from the client (text request, a Pong answering our
            // keepalive Ping, or a client Ping) proves the connection is live
            // — stamp it so the write task's watchdog doesn't close a healthy
            // peer during a burst of agent output.
            read_last_activity.store(now_ms(), Ordering::Relaxed);
            match msg {
                Message::Text(t) => {
                    let handled = handle_request(
                        &t,
                        &mut authed,
                        &acp,
                        &relay,
                        &registry,
                        registry_persistence.as_ref(),
                        projects_file.as_deref(),
                        &write_tx,
                        &mut subscribed_clients,
                        &mut current_agent,
                        &current_session,
                        &current_project,
                        &switch_queue,
                        history_mode,
                        acp_catalog.as_ref(),
                    )
                    .await;
                    if write_tx.send(Outbound::Reply(handled)).is_err() {
                        break; // write half closed.
                    }
                }
                Message::Binary(_) => {
                    // Protocol error — close the connection.
                    let _ = write_tx.send(Outbound::Reply(WsReply::err(
                        "binary-frame",
                        WsErrorCode::Unsupported,
                        "binary frames are not supported by this protocol",
                    )));
                    break;
                }
                Message::Close(_) | Message::Ping(_) | Message::Pong(_) => {
                    // Axum auto-answers pings; Close ends the loop.
                    if matches!(msg, Message::Close(_)) {
                        break;
                    }
                }
            }
        }
        // Cleanup subscriptions for this connection. Retain the affected
        // session ids so last-subscriber permission grace can be scheduled.
        let disconnected_sessions: std::collections::HashSet<String> = subscribed_clients
            .iter()
            .map(|(sid, _)| sid.clone())
            .collect();
        for (sid, cid) in subscribed_clients.drain(..) {
            relay.unsubscribe(&sid, cid);
        }
        // Story 1.7: on browser disconnect, resolve every outstanding
        // permission whose session now has zero remaining subscribers as deny
        // (FR14: disconnect → deny). A ticket is denied only when the
        // disconnecting client was the LAST subscriber — otherwise a remaining
        // client can still legitimately respond. `relay.session_subscriber_count`
        // reports the post-unsubscribe count.
        if let Some(rdz) = relay.rendezvous() {
            let orphan_sessions: std::collections::HashSet<String> = disconnected_sessions
                .into_iter()
                .filter(|sid| relay.session_subscriber_count(sid) == 0)
                .collect();
            for sid in orphan_sessions {
                let relay_for_count = Arc::clone(&relay);
                rdz.schedule_disconnect_grace(sid, move |session_id| {
                    relay_for_count.session_subscriber_count(session_id)
                });
            }
        }
        // Issue #411: on browser disconnect, resolve every outstanding question
        // whose session now has zero remaining subscribers as cancelled
        // (mirrors the permission disconnect-deny above).
        if let Some(qrdz) = relay.question_rendezvous() {
            let relay_for_count = Arc::clone(&relay);
            qrdz.deny_all_for_client(move |sid| relay_for_count.session_subscriber_count(sid))
                .await;
        }
    });

    // Drop the original sender so the write loop ends when the read task
    // (which owns the only remaining sender clone) finishes.
    drop(out_tx);
    // Patch L: the `tokio::select!` completes the WINNING branch's JoinHandle
    // (it is polled to completion inside select). Re-awaiting the winner
    // panics in tokio ≥ 1.52 ("JoinHandle polled after completion"). So we
    // only await the LOSING (aborted) task — the winner is already joined.
    tokio::select! {
        _ = &mut write_task => {
            read_task.abort();
            // Read is the loser — await its abort to avoid orphaning.
            let _ = read_task.await;
        }
        _ = &mut read_task => {
            write_task.abort();
            // Write is the loser — await its abort to avoid orphaning.
            let _ = write_task.await;
        }
    }
}

/// CamelCase subscribe payload (Story 1.6) — envelope snake_case, payload camelCase.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubscribePayload {
    session_id: String,
    /// Cursor: `None` / omitted → live-only (no replay). `Some(n)` → replay from `n + 1`.
    /// Note: `Some(0)` is still a cursor and can be [`ReplayResult::Stale`] after ring eviction.
    #[serde(default)]
    last_seq: Option<u64>,
}

/// Route a single text request frame to a reply (AC9 + AC10 + Story 1.6 subscribe
/// + Story 1.7 `respond_permission` + Story 1.8 ACP command forwarding).
///
/// Pre-auth: only `authenticate` is allowed; everything else → `unauthorized`.
/// Post-auth: `authenticate` is a no-op success; `subscribe` wires the sink;
/// `respond_permission` routes through the Story 1.7 rendezvous; the 10 ACP
/// command types (`send_prompt`, `create_session`, …) forward to
/// `AcpManager` (Story 1.8); OS-cap requests → `unsupported`; `switch_project`
/// + unknown types → `not_implemented` (Epic 4).
#[allow(clippy::too_many_arguments)]
async fn handle_request(
    text: &str,
    authed: &mut bool,
    acp: &Arc<AcpManager>,
    relay: &Arc<WsRelaySink>,
    registry: &Arc<ProjectRegistry>,
    registry_persistence: Option<&Arc<parking_lot::Mutex<FileProjectRegistry>>>,
    projects_file: Option<&PathBuf>,
    out_tx: &mpsc::UnboundedSender<Outbound>,
    subscribed_clients: &mut Vec<(String, ClientId)>,
    current_agent: &mut Option<AgentId>,
    current_session: &Arc<parking_lot::Mutex<Option<SessionId>>>,
    current_project: &Arc<parking_lot::Mutex<Option<String>>>,
    switch_queue: &Arc<tokio::sync::Mutex<ProjectSwitchQueue>>,
    history_mode: HistoryMode,
    acp_catalog: Option<&Arc<crate::acp::AcpCatalogService>>,
) -> WsReply {
    let req: WsRequest = match serde_json::from_str(text) {
        Ok(r) => r,
        Err(e) => {
            return WsReply::err(
                "malformed",
                WsErrorCode::Unsupported,
                format!("malformed request frame: {e}"),
            );
        }
    };
    let id = req.id.clone();

    // Pre-auth gate (AC9): only authenticate is allowed.
    if !*authed {
        if req.type_ == "authenticate" {
            // Placeholder (AC10): accept any token, mark authed. Epic 2 wires
            // the real cookie/token gate.
            *authed = true;
            let reconnect_grace = relay
                .rendezvous()
                .map_or(DEFAULT_PERMISSION_RECONNECT_GRACE, |rendezvous| {
                    rendezvous.disconnect_grace()
                });
            return WsReply::ok(
                id,
                Some(json!({
                    "historyMode": history_mode,
                    "runtimePolicy": RuntimePolicy::resolved(reconnect_grace),
                })),
            );
        }
        return WsReply::err(
            id,
            WsErrorCode::Unauthorized,
            "pre-auth: send an `authenticate` request first",
        );
    }

    // Post-auth routing.
    match req.type_.as_str() {
        "authenticate" => {
            // Idempotent re-auth — accept and succeed.
            WsReply::ok(id, Some(json!({})))
        }
        // Application-level heartbeat: a client-emitted `ping` request keeps
        // the keepalive watchdog (`last_activity`) fresh through proxies that
        // strip WS-level Ping/Pong control frames (Cloudflare tunnels, etc.).
        // The read loop stamps `last_activity` on every inbound text frame
        // before routing, so this handler only needs to round-trip a reply so
        // the client's request promise resolves (no timeout).
        "ping" => WsReply::ok(id, Some(json!({}))),
        "subscribe" => handle_subscribe(id, &req.payload, relay, out_tx, subscribed_clients).await,
        "list_persisted_sessions" => {
            handle_list_persisted_sessions(id, relay, history_mode).await
        }
        "open_persisted_session" => {
            handle_open_persisted_session(
                id,
                &req.payload,
                relay,
                out_tx,
                subscribed_clients,
                history_mode,
            )
            .await
        }
        "get_session_payload" => {
            handle_get_session_payload(id, &req.payload, relay, history_mode).await
        }
        "recover_session_snapshot" => {
            handle_recover_session_snapshot(
                id,
                &req.payload,
                relay,
                out_tx,
                subscribed_clients,
                history_mode,
            )
            .await
        }
        // R2: lightweight server-authoritative replay cursor (no snapshot).
        // Unlike `recover_session_snapshot` (which re-registers a
        // subscription), this only returns `{ sessionId, watermark }` so a
        // refreshed transport seeds `lastSeq` before its first subscribe.
        "get_session_cursor" => {
            handle_get_session_cursor(id, &req.payload, relay, history_mode).await
        }
        // Story 1.7: `respond_permission` — route the browser's permission
        // decision through the server-side rendezvous (first-response-wins,
        // TOCTOU re-validation, at-most-one) to `AcpManager::respond_permission`,
        // which resolves the agent's `Responder` on the driver thread.
        "respond_permission" => handle_respond_permission(id, &req.payload, relay, subscribed_clients).await,
        // Issue #411: `answer_question` — route the browser's structured-question
        // answer through the server-side question rendezvous (first-response-wins,
        // TOCTOU re-validation) to `AcpManager::answer_question`, which resolves
        // the agent's `Responder` on the driver thread.
        "answer_question" => handle_answer_question(id, &req.payload, relay, subscribed_clients).await,
        // Story 1.8: ACP command forwarding → `AcpManager`. The streaming events
        // (`message_chunk`, `tool_call`, `prompt_complete`, `session_created`,
        // `config_options_update`, …) flow back automatically through the
        // existing `fan_out` → `WsRelaySink::emit` → WS frame → store pipeline.
        "create_session" => {
            handle_create_session(
                id,
                &req.payload,
                acp,
                registry,
                current_agent,
                current_session,
                current_project,
            )
            .await
        }
        "load_session" => {
            handle_load_session(
                id,
                &req.payload,
                acp,
                current_agent,
                current_session,
                current_project,
            )
            .await
        }
        "resume_session" => {
            handle_resume_session(
                id,
                &req.payload,
                acp,
                current_agent,
                current_session,
                current_project,
            )
            .await
        }
        "close_session" => {
            handle_close_session(id, &req.payload, acp, current_session, current_project).await
        }
        "dispose_ephemeral_session" => {
            handle_dispose_ephemeral_session(
                id,
                &req.payload,
                acp,
                relay,
                subscribed_clients,
                current_session,
                current_project,
            )
            .await
        }
        "list_sessions" => handle_list_sessions(id, &req.payload, acp).await,
        "switch_project" => {
            handle_switch_project(
                id,
                &req.payload,
                acp,
                relay,
                registry,
                out_tx,
                current_agent,
                current_session,
                current_project,
                switch_queue,
            )
            .await
        }
        // Explicit host-default change (Epic 7 — cross-client continuity).
        // Distinct from `switch_project` (per-connection): updates the host's
        // `default_project_id`, persists to `FileProjectRegistry` (VPS, with
        // rollback), and broadcasts `projects_changed` to ALL clients. Any
        // authenticated client can set the default for now (Epic 2 wires auth).
        "set_default_project" => {
            handle_set_default_project(
                id,
                &req.payload,
                relay,
                registry,
                registry_persistence,
                projects_file,
            )
            .await
        }
        "spawn_agent" => handle_spawn_agent(id, &req.payload, acp, current_agent).await,
        // CAP-6 / Story 8: host-owned ACP catalog resolution. The catalog
        // carries the host's OS/arch/runtime availability + per-agent
        // resolved `SupportedAcpAgentStatus`. The web client never probes
        // `@tauri-apps/plugin-os` or PATH locally — the host is the single
        // source of truth.
        "list_acp_catalog" => {
            handle_list_acp_catalog(id, &req.payload, acp_catalog).await
        }
        "set_catalog_opt_in" => {
            handle_set_catalog_opt_in(id, &req.payload, acp_catalog).await
        }
        "kill_agent" => {
            handle_kill_agent(
                id,
                &req.payload,
                acp,
                current_agent,
                current_session,
                current_project,
            )
            .await
        }
        "list_agents" => handle_list_agents(id, acp),
        "send_prompt" => handle_send_prompt(id, &req.payload, acp, relay).await,
        "cancel_prompt" => handle_cancel_prompt(id, &req.payload, acp).await,
        "set_mode" => handle_set_mode(id, &req.payload, acp).await,
        "set_model" => handle_set_model(id, &req.payload, acp).await,
        "set_config_option" => handle_set_config_option(id, &req.payload, acp).await,
        // OS caps (AC8): server-fulfilled; reject browser requests.
        t if is_os_fulfilled_cap(t) => WsReply::err(
            id,
            WsErrorCode::Unsupported,
            format!(
                "`{t}` is an OS-fulfilled cap; the server handles it locally (not relayed to the browser)"
            ),
        ),
        // Remaining ACP request types: stub not_implemented (Epic 4 — unknown
        // types not yet routed).
        _ => WsReply::err(
            id,
            WsErrorCode::NotImplemented,
            format!(
                "`{}` is not implemented yet (ACP forwarding lands in Epic 4)",
                req.type_
            ),
        ),
    }
}

async fn handle_list_persisted_sessions(
    id: String,
    relay: &Arc<WsRelaySink>,
    history_mode: HistoryMode,
) -> WsReply {
    if history_mode != HistoryMode::Server {
        return WsReply::err(
            id,
            WsErrorCode::Unsupported,
            "persisted history is unavailable",
        );
    }
    // Host-owned history (CAP-2): both desktop shared-live and the standalone
    // server serve the file-backed `SessionPersistence` index.
    match relay.persistence() {
        Some(persistence) => ok_with_payload(id, &persistence.list_sessions()),
        None => WsReply::err(
            id,
            WsErrorCode::Unsupported,
            "persisted history is unavailable",
        ),
    }
}

/// `get_session_payload` — fetch the FULL stored transcript (`{ metadata,
/// messages }`) for a session id. Both desktop shared-live and the standalone
/// server materialize the renderer shape from the host-owned
/// `SessionPersistence` JSONL records. Returns
/// `{ ok:false, err:'not_found' }` when the id is absent (web shows "chat
/// unavailable").
async fn handle_get_session_payload(
    id: String,
    payload: &Value,
    relay: &Arc<WsRelaySink>,
    history_mode: HistoryMode,
) -> WsReply {
    if history_mode != HistoryMode::Server {
        return WsReply::err(
            id,
            WsErrorCode::Unsupported,
            "persisted history is unavailable",
        );
    }
    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct GetSessionPayloadRequest {
        session_id: String,
    }
    let parsed: GetSessionPayloadRequest = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed get_session_payload payload (want sessionId): {e}"),
            )
        }
    };
    // Host-owned history (CAP-2): materialize the renderer-shaped payload from
    // the durable JSONL records (pure fold of `user_prompt` / `message_chunk`).
    // `session_payload_async` flushes the writer queue first, so an active
    // session reads every already-assigned seq; a finalized session is served
    // read-only. Errors fail closed — never a fabricated empty payload.
    match relay.persistence() {
        Some(persistence) => {
            match persistence.session_payload_async(&parsed.session_id).await {
                Ok(payload) => {
                    tracing::debug!(
                        target: "termul::web::ws",
                        session_id = %parsed.session_id,
                        messages = payload.messages.len(),
                        "get_session_payload: materialized host payload"
                    );
                    ok_with_payload(id, &payload)
                }
                Err(crate::acp::SessionPersistenceError::SessionNotFound) => {
                    WsReply::err(id, WsErrorCode::NotFound, "session payload not found")
                }
                Err(error) => {
                    // Fail closed with a generic client-facing message: storage
                    // error strings can carry absolute paths and internal
                    // detail that do not belong on the wire. The full context
                    // stays in the host log.
                    tracing::warn!(
                        target: "termul::web::ws",
                        session_id = %parsed.session_id,
                        error = %error,
                        "get_session_payload: host payload materialization failed"
                    );
                    WsReply::err(id, WsErrorCode::Unsupported, "failed to read session payload")
                }
            }
        }
        None => WsReply::err(id, WsErrorCode::NotFound, "session payload not found"),
    }
}

async fn handle_recover_session_snapshot(
    id: String,
    payload: &Value,
    relay: &Arc<WsRelaySink>,
    out_tx: &mpsc::UnboundedSender<Outbound>,
    subscribed_clients: &mut Vec<(String, ClientId)>,
    history_mode: HistoryMode,
) -> WsReply {
    if history_mode != HistoryMode::Server {
        return WsReply::err(
            id,
            WsErrorCode::Unsupported,
            "atomic snapshot recovery is unavailable in live-only mode",
        );
    }
    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct RecoverSnapshotRequest {
        session_id: String,
    }
    let parsed: RecoverSnapshotRequest = match serde_json::from_value(payload.clone()) {
        Ok(parsed) => parsed,
        Err(error) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed recover_session_snapshot payload: {error}"),
            )
        }
    };
    if parsed.session_id.is_empty() {
        return WsReply::err(id, WsErrorCode::Unsupported, "sessionId is required");
    }
    let prior_clients: Vec<ClientId> = subscribed_clients
        .iter()
        .filter(|(sid, _)| sid == &parsed.session_id)
        .map(|(_, client_id)| *client_id)
        .collect();
    let (client_id, mut rx, events, watermark) =
        match relay.subscribe_snapshot(&parsed.session_id).await {
            Ok(result) => result,
            Err(_) => {
                return WsReply::err(id, WsErrorCode::NotFound, "session snapshot not found");
            }
        };
    subscribed_clients.retain(|(sid, client_id)| {
        if sid == &parsed.session_id && prior_clients.contains(client_id) {
            relay.unsubscribe(sid, *client_id);
            false
        } else {
            true
        }
    });
    subscribed_clients.push((parsed.session_id.clone(), client_id));
    if let Some(rendezvous) = relay.rendezvous() {
        rendezvous.cancel_disconnect_grace(&parsed.session_id);
    }
    let forward_tx = out_tx.clone();
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            if forward_tx.send(Outbound::Event(event)).is_err() {
                break;
            }
        }
    });
    WsReply::ok(
        id,
        Some(json!({
            "sessionId": parsed.session_id,
            "watermark": watermark,
            "events": events,
        })),
    )
}

/// `get_session_cursor` (R2) — returns the server-authoritative replay
/// watermark `{ sessionId, watermark }` for a session WITHOUT subscribing
/// (contrast `recover_session_snapshot`, which re-registers a subscription
/// and emits the snapshot payload). A refreshed WS transport seeds its
/// per-session `lastSeq` from this before the first `subscribeSession`, so
/// events missed during the reload gap (seq > watermark) replay instead of
/// running live-only (the stale-recovery path that fires only on a `STALE`
/// error). Best-effort: an unknown session or a payload without `seq`-bearing
/// messages resolves to `watermark: 0` (live-only subscribe), never an error.
async fn handle_get_session_cursor(
    id: String,
    payload: &Value,
    relay: &Arc<WsRelaySink>,
    history_mode: HistoryMode,
) -> WsReply {
    if history_mode != HistoryMode::Server {
        return WsReply::err(
            id,
            WsErrorCode::Unsupported,
            "persisted history is unavailable",
        );
    }
    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct GetSessionCursorRequest {
        session_id: String,
    }
    let parsed: GetSessionCursorRequest = match serde_json::from_value(payload.clone()) {
        Ok(parsed) => parsed,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed get_session_cursor payload (want sessionId): {e}"),
            )
        }
    };
    if parsed.session_id.is_empty() {
        return WsReply::err(id, WsErrorCode::Unsupported, "sessionId is required");
    }
    // Host-owned history (CAP-2): both desktop shared-live and the standalone
    // server resolve the authoritative JSONL append log's `last_seq`.
    // `last_seq` returns `Ok(0)` for a genuinely unknown (brand-new) session,
    // but `Err(_)` for a real I/O / decode failure. `unwrap_or(0)` would mask a
    // storage failure as "new session" in the reply + logs; log the `Err` first
    // so a corrupted payload or permission error is visible, then default to 0.
    let watermark = relay
        .persistence()
        .map(|persistence| {
            persistence.last_seq(&parsed.session_id).unwrap_or_else(|error| {
                tracing::warn!(
                    session_id = %parsed.session_id,
                    error = ?error,
                    "get_session_cursor: last_seq lookup failed"
                );
                0
            })
        })
        .unwrap_or(0);
    tracing::debug!(
        target: "termul::web::ws",
        session_id = %parsed.session_id,
        watermark,
        "get_session_cursor"
    );
    WsReply::ok(
        id,
        Some(json!({ "sessionId": parsed.session_id, "watermark": watermark })),
    )
}

async fn handle_open_persisted_session(
    id: String,
    payload: &Value,
    relay: &Arc<WsRelaySink>,
    out_tx: &mpsc::UnboundedSender<Outbound>,
    subscribed_clients: &mut Vec<(String, ClientId)>,
    history_mode: HistoryMode,
) -> WsReply {
    if history_mode != HistoryMode::Server {
        return WsReply::err(
            id,
            WsErrorCode::Unsupported,
            "persisted history is unavailable",
        );
    }
    handle_subscribe(id, payload, relay, out_tx, subscribed_clients).await
}

/// Map an `AcpManager` `Err(String)` to a `WsReply` err. Story 1.8 review:
/// map recognizable agent-manager error strings to their stable `err.code`
/// (so the browser's error routing keys on the right category — not every
/// runtime failure is "not_implemented"). `send_prompt`'s concurrent-turn
/// rejection (`"ACP_TURN_IN_PROGRESS: …"`) → `RateLimited`; `"unknown agent:
/// …"` / `"unknown permission request: …"` → `NotFound`; capability-gate
/// failures (`"agent does not support …"`) → `Unsupported`. Unrecognized
/// errors fall back to `NotImplemented` (preserves the human message verbatim).
fn acp_err_to_reply(id: String, err: String) -> WsReply {
    if let Some(code) = map_prompt_error_code(&err) {
        return WsReply::err(id, code, err);
    }
    let code = if err.starts_with("unknown agent") || err.contains("unknown permission request") {
        WsErrorCode::NotFound
    } else if err.contains("agent does not support") || err.contains("capability") {
        WsErrorCode::Unsupported
    } else {
        WsErrorCode::NotImplemented
    };
    WsReply::err(id, code, err)
}

/// Serialize a `Serialize` success value into a `WsReply::ok` payload, or reply
/// `err` on serialization failure (never `null` — mirrors `fan_out` semantics).
fn ok_with_payload<T: serde::Serialize>(id: String, value: &T) -> WsReply {
    match serde_json::to_value(value) {
        Ok(v) => WsReply::ok(id, Some(v)),
        Err(e) => WsReply::err(
            id,
            WsErrorCode::Unsupported,
            format!("failed to serialize reply payload: {e}"),
        ),
    }
}

// --- Story 1.8 ACP command handlers -----------------------------------------
//
// Each handler parses a camelCase payload (mirroring the renderer's
// `acp-transport.ts` request shapes), calls the corresponding `AcpManager`
// method, and maps `Result<T, String>` → `WsReply`. The streaming events
// emitted by `AcpManager` (via `fan_out` → `WsRelaySink`) flow back to the
// browser automatically — these handlers only own the request/reply half.

/// `spawn_agent` → `AcpManager::spawn(config)`. Mirrors Tauri `acp_spawn_agent`
/// invoke args `{ config }`. Reply payload = the [`SpawnOutcome`] (camelCase:
/// `agentId`/`capabilities`/`authMethods`/`stableNamespace?`) — the
/// authoritative spawn metadata so the renderer populates the store
/// synchronously from the response (CAP-4: the spawn response — not the async
/// `agent_spawned` event — is the source of truth on both desktop and web).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpawnAgentPayload {
    config: AgentConfig,
}

async fn handle_spawn_agent(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
    current_agent: &mut Option<crate::acp::AgentId>,
) -> WsReply {
    let mut parsed: SpawnAgentPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed spawn_agent payload (want config): {e}"),
            )
        }
    };
    // Mirror desktop `validateAgentConfig`: trim + require non-empty name/command.
    parsed.config.name = parsed.config.name.trim().to_string();
    parsed.config.command = parsed.config.command.trim().to_string();
    if parsed.config.name.is_empty() {
        return WsReply::err(
            id,
            WsErrorCode::Unsupported,
            "spawn_agent requires a non-empty `config.name`",
        );
    }
    if parsed.config.command.is_empty() {
        return WsReply::err(
            id,
            WsErrorCode::Unsupported,
            "spawn_agent requires a non-empty `config.command`",
        );
    }
    match acp.spawn(parsed.config).await {
        Ok(outcome) => {
            // Track the spawned agent so a later `switch_project` can reuse it
            // (Ask-First resolution: do NOT auto-spawn on switch).
            *current_agent = Some(outcome.agent_id.clone());
            ok_with_payload(id, &outcome)
        }
        Err(e) => acp_err_to_reply(id, e),
    }
}

/// `kill_agent` → `AcpManager::kill(agent_id)`. Mirrors Tauri `acp_kill_agent`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KillAgentPayload {
    agent_id: crate::acp::AgentId,
}

async fn handle_kill_agent(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
    current_agent: &mut Option<AgentId>,
    current_session: &Arc<parking_lot::Mutex<Option<SessionId>>>,
    current_project: &Arc<parking_lot::Mutex<Option<String>>>,
) -> WsReply {
    let parsed: KillAgentPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed kill_agent payload (want agentId): {e}"),
            )
        }
    };
    match acp.kill(&parsed.agent_id).await {
        Ok(()) => {
            // If the killed agent is this connection's tracked agent, drop the
            // tracking so a later `switch_project` does not reuse the dead id
            // (which would map `new_session`'s "unknown agent" to `not_found").
            // The web client must spawn/create a session again first.
            if current_agent
                .as_ref()
                .is_some_and(|a| *a == parsed.agent_id)
            {
                *current_agent = None;
                *current_session.lock() = None;
                *current_project.lock() = None;
            }
            WsReply::ok(id, Some(json!({})))
        }
        Err(e) => acp_err_to_reply(id, e),
    }
}

/// `list_agents` → `AcpManager::list_agents()`. Reply = `AgentId[]` (JSON array).
fn handle_list_agents(id: String, acp: &Arc<AcpManager>) -> WsReply {
    ok_with_payload(id, &acp.list_agents())
}

// --- CAP-6 / Story 8: ACP catalog WS handlers ------------------------------

/// `list_acp_catalog` WS request payload. `refresh` is optional (defaults to
/// false — serve the cached catalog if fresh within the TTL).
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct ListAcpCatalogPayload {
    refresh: Option<bool>,
}

async fn handle_list_acp_catalog(
    id: String,
    payload: &Value,
    acp_catalog: Option<&Arc<crate::acp::AcpCatalogService>>,
) -> WsReply {
    let parsed: ListAcpCatalogPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed list_acp_catalog payload: {e}"),
            )
        }
    };
    let Some(service) = acp_catalog.cloned() else {
        return WsReply::err(
            id,
            WsErrorCode::Unsupported,
            "acp catalog store is unavailable",
        );
    };
    match service.list_catalog(parsed.refresh.unwrap_or(false)).await {
        Ok(catalog) => ok_with_payload(id, &catalog),
        Err(error) => WsReply::err(
            id,
            WsErrorCode::Unsupported,
            format!("catalog load failed: {error}"),
        ),
    }
}

/// `set_catalog_opt_in` WS request payload. `deny_unknown_fields` rejects an
/// over-serialized payload loudly at the host boundary.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetCatalogOptInPayload {
    enabled: bool,
}

async fn handle_set_catalog_opt_in(
    id: String,
    payload: &Value,
    acp_catalog: Option<&Arc<crate::acp::AcpCatalogService>>,
) -> WsReply {
    let parsed: SetCatalogOptInPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed set_catalog_opt_in payload (want enabled): {e}"),
            )
        }
    };
    let Some(service) = acp_catalog.cloned() else {
        return WsReply::err(
            id,
            WsErrorCode::Unsupported,
            "acp catalog store is unavailable",
        );
    };
    match service.set_opt_in(parsed.enabled) {
        Ok(()) => WsReply::ok(id, Some(json!({}))),
        Err(error) => WsReply::err(
            id,
            WsErrorCode::Unsupported,
            format!("opt-in persistence failed: {error}"),
        ),
    }
}

/// `create_session` → `AcpManager::new_session(agent_id, cwd, mcp_servers)`.
/// Reply payload = the `NewSessionOutcome` (camelCase: sessionId/modes/models/configOptions).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateSessionPayload {
    agent_id: crate::acp::AgentId,
    cwd: String,
    #[serde(default)]
    mcp_servers: Vec<agent_client_protocol::schema::v1::McpServer>,
    #[serde(default)]
    ephemeral: bool,
}

async fn handle_create_session(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
    registry: &Arc<ProjectRegistry>,
    current_agent: &mut Option<crate::acp::AgentId>,
    current_session: &Arc<parking_lot::Mutex<Option<crate::acp::SessionId>>>,
    current_project: &Arc<parking_lot::Mutex<Option<String>>>,
) -> WsReply {
    let parsed: CreateSessionPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed create_session payload (want agentId, cwd, mcpServers?): {e}"),
            )
        }
    };
    // Story 1.8 review (EC4): reject an empty cwd (the desktop store path
    // trims + rejects `cwd.length === 0`; the WS path must not diverge — an
    // empty cwd would give the agent subprocess undefined cwd semantics).
    if parsed.cwd.trim().is_empty() {
        return WsReply::err(
            id,
            WsErrorCode::Unsupported,
            "create_session requires a non-empty `cwd`",
        );
    }
    // CAP-2 attribution: resolve the project id best-effort from the registry
    // by cwd, so browser-origin sessions persist under their owning project
    // (switch-back reopen + project-scoped listings). Unknown cwds stay
    // project-less.
    let project_id = registry.find_by_path(&parsed.cwd);
    match acp
        .new_session_with_context(
            &parsed.agent_id,
            parsed.cwd,
            parsed.mcp_servers,
            SessionCreationContext {
                project_id,
                ephemeral: parsed.ephemeral,
            },
        )
        .await
    {
        Ok(outcome) => {
            if !parsed.ephemeral {
                // Track the agent + new session for `switch_project` cwd switching.
                *current_agent = Some(parsed.agent_id.clone());
                *current_session.lock() = Some(outcome.session_id.clone());
                // Generic session creation carries a cwd, not a registry-owned
                // project id. Leave it unknown so the next switch is always real.
                *current_project.lock() = None;
            }
            ok_with_payload(id, &outcome)
        }
        Err(e) => acp_err_to_reply(id, e),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SwitchProjectPayload {
    project_id: String,
}

/// `set_default_project` WS request payload. Changes the host's default
/// project (distinct from a per-connection `switch_project`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetDefaultProjectPayload {
    project_id: String,
}

/// `set_default_project` WS handler — the explicit host-default change.
///
/// Validates the target (unknown/archived/pathless → `NOT_FOUND`), updates
/// `registry.set_default_project`, persists to `FileProjectRegistry` (VPS only,
/// with rollback on failure), and broadcasts `projects_changed` carrying the
/// new `defaultProjectId` to ALL connected clients. Desktop-hosted mode has
/// no `FileProjectRegistry` (`registry_persistence`/`projects_file` are
/// `None`) — it updates the in-memory registry + broadcasts only. The
/// `remote_sync_projects` desktop push is the other path that changes the
/// default (the desktop user IS the host operator).
///
/// # Error code mapping (P9)
///
/// The WS protocol's fixed `WsErrorCode` enum has no dedicated
/// "persistence failed" variant (the 10 stable codes are mirrored in TS).
/// Malformed payloads use `Unsupported` (matching `switch_project`); a
/// persistence failure also maps to `Unsupported` but with a distinct
/// message ("failed to persist default project: ..."). The HTTP route
/// (`POST /projects/default`) uses the free-form `IpcBody.code` string
/// `PERSIST_FAILED` for the same condition — the codes differ by transport
/// but the messages are unambiguous.
#[allow(clippy::too_many_arguments)]
async fn handle_set_default_project(
    id: String,
    payload: &Value,
    relay: &Arc<WsRelaySink>,
    registry: &Arc<ProjectRegistry>,
    registry_persistence: Option<&Arc<parking_lot::Mutex<FileProjectRegistry>>>,
    projects_file: Option<&PathBuf>,
) -> WsReply {
    let parsed: SetDefaultProjectPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            warn!(
                target: "termul::web::ws",
                error = %e,
                "set_default_project: malformed payload (want projectId)"
            );
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed set_default_project payload (want projectId): {e}"),
            );
        }
    };
    // Validate via the in-memory registry (unknown/archived/pathless → NOT_FOUND).
    // `switch_context` re-checks the same conditions; reuse it so the
    // validation path is identical to `switch_project`.
    if registry.switch_context(&parsed.project_id).is_none() {
        warn!(
            target: "termul::web::ws",
            project_id = %parsed.project_id,
            "set_default_project: project not found or not switchable"
        );
        return WsReply::err(
            id,
            WsErrorCode::NotFound,
            format!(
                "project '{}' not found or not switchable",
                parsed.project_id
            ),
        );
    }
    // VPS persistence (with rollback). Desktop-hosted mode skips this (no file
    // registry). The old default is captured so the in-memory-set failure path
    // below can roll the file back (P1: no split-brain — if
    // `registry.set_default_project` returns false after the file was already
    // persisted, the file is restored + re-saved before returning the error).
    let mut persisted_old_default: Option<Option<String>> = None;
    if let (Some(file_registry), Some(path)) = (registry_persistence, projects_file) {
        let persistence_result = {
            let mut file_registry = file_registry.lock();
            let old_default = file_registry.default_project_id().map(str::to_string);
            match file_registry.set_default_project(&parsed.project_id) {
                Ok(()) => match file_registry.save_atomic(path) {
                    Ok(()) => {
                        persisted_old_default = Some(old_default);
                        Ok(())
                    }
                    Err(error) => {
                        file_registry.restore_default_project(old_default);
                        Err(error)
                    }
                },
                Err(error) => Err(error),
            }
        };
        if let Err(error) = persistence_result {
            error!(
                target: "termul::web::ws",
                project_id = %parsed.project_id,
                error = %error,
                "set_default_project: persistence failed (rolled back)"
            );
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("failed to persist default project: {error}"),
            );
        }
    }
    // Update the in-memory registry default + broadcast to all clients.
    // If the in-memory set fails (target vanished between validation and
    // commit), roll back the file registry (P1: no split-brain).
    if !registry.set_default_project(&parsed.project_id) {
        if let (Some(file_registry), Some(path), Some(old_default)) = (
            registry_persistence,
            projects_file,
            persisted_old_default,
        ) {
            let mut file_registry = file_registry.lock();
            file_registry.restore_default_project(old_default);
            if let Err(error) = file_registry.save_atomic(path) {
                warn!(
                    target: "termul::web::ws",
                    error = %error,
                    "set_default_project: failed to persist in-memory-set rollback"
                );
            }
        }
        warn!(
            target: "termul::web::ws",
            project_id = %parsed.project_id,
            "set_default_project: target became unavailable before commit (file rolled back)"
        );
        return WsReply::err(
            id,
            WsErrorCode::NotFound,
            "target project became unavailable before commit",
        );
    }
    broadcast_projects_changed(relay, Some(&parsed.project_id));
    info!(
        target: "termul::web::ws",
        project_id = %parsed.project_id,
        "set_default_project: host default updated + broadcast"
    );
    WsReply::ok(id, Some(json!({})))
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum SwitchProjectOutcome {
    Completed {
        project_id: String,
        session_id: SessionId,
        cwd: String,
        mcp_server_count: usize,
    },
    Queued {
        project_id: String,
        current_session_id: SessionId,
    },
    /// Cold-tab (no live agent) deferred select: the shared active project
    /// changed but no session was created. The web client spawns the agent
    /// lazily when a chat starts (Ask-First resolution stands). `cwd` lets the
    /// client resolve the project root without a second registry round-trip.
    Selected { project_id: String, cwd: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSwitchCompletedPayload {
    status: &'static str,
    request_id: String,
    project_id: String,
    previous_session_id: SessionId,
    session_id: SessionId,
    cwd: String,
    mcp_server_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSwitchFailedPayload {
    request_id: String,
    project_id: String,
    previous_session_id: SessionId,
    message: String,
}

#[derive(Clone)]
struct PendingProjectSwitch {
    request_id: String,
    target: ProjectSwitchContext,
    previous_session_id: SessionId,
}

#[derive(Default)]
struct ProjectSwitchQueue {
    pending: Option<PendingProjectSwitch>,
    worker_running: bool,
}

impl ProjectSwitchQueue {
    /// Queue policy is latest-wins per connection. Returns the replaced request
    /// so the caller can emit one correlated failure event for it.
    fn replace_pending(&mut self, pending: PendingProjectSwitch) -> Option<PendingProjectSwitch> {
        self.pending.replace(pending)
    }
}

#[must_use]
fn connection_already_on_project(
    current_project_id: Option<&str>,
    target_project_id: &str,
) -> bool {
    current_project_id == Some(target_project_id)
}

fn project_switch_failed_event(
    request_id: String,
    project_id: String,
    previous_session_id: SessionId,
    message: String,
) -> SequencedEvent {
    SequencedEvent::new(
        Some(previous_session_id.0.clone()),
        0,
        "project_switch_failed",
        serde_json::to_value(ProjectSwitchFailedPayload {
            request_id,
            project_id,
            previous_session_id,
            message,
        })
        .unwrap_or_else(|_| json!({})),
    )
}

/// Attempt to reopen the most-recent resumable session for a project switch
/// (switch-back restore). Looks up the host persistence store for the target
/// `(project_id, cwd)`, gates on the agent's `load`/`resume` capability, and
/// reopens via `resume_session` (preferred) or `load_session`. Returns
/// `Ok(Some(id))` on a successful reopen, `Ok(None)` when there is no
/// resumable session or the agent lacks both capabilities, and `Err` when the
/// reopen attempt fails (the caller falls back to `new_session_with_context`
/// in both the `None` and `Err` cases).
async fn try_reopen_session_for_switch(
    acp: &Arc<AcpManager>,
    agent_id: &AgentId,
    persistence: &Arc<crate::acp::SessionPersistence>,
    target: &ProjectSwitchContext,
) -> Result<Option<SessionId>, String> {
    // Resolve the current agent's stable namespace (config id or safe
    // fallback) so the durable store filters candidates to sessions owned by the
    // SAME agent namespace — not just any resumable session for
    // (project_id, cwd). Falls back to the unfiltered lookup when the
    // namespace cannot be resolved (agent unknown / has no stable
    // namespace).
    let agent_namespace = acp.stable_agent_namespace(agent_id).ok().flatten();
    let Some(entry) = persistence.find_most_recent_for_project(
        &target.project_id,
        &target.cwd,
        agent_namespace.as_deref(),
    ) else {
        return Ok(None);
    };
    let session_id = SessionId(entry.session_id.clone());
    // Prefer resume; fall back to load. The store's `resumeEligible` flag
    // only guarantees the session has SOME stable agent namespace — it does
    // NOT guarantee that namespace matches the current agent. The
    // `agent_namespace` filter above (patch #4) narrows candidates to the
    // current agent's namespace, but the load/resume attempt below can still
    // fail (purged session, capability missing, agent error). Both
    // `AcpManager` methods are internally capability-gated — a missing
    // capability returns a fast error string ("agent does not support …")
    // WITHOUT contacting the agent, so the wasteful-attempt cost is one
    // cheap error. Any failure (capability, purged session, agent error) →
    // fall back to a new session.
    match acp
        .resume_session(agent_id, session_id.clone(), target.cwd.clone())
        .await
    {
        Ok(_) => Ok(Some(session_id)),
        Err(resume_err) => match acp
            .load_session(agent_id, session_id.clone(), target.cwd.clone())
            .await
        {
            Ok(_) => Ok(Some(session_id)),
            Err(load_err) => {
                warn!(
                    "[ws] switch-back reopen of session {} failed (resume: {}; load: {}); \
                     falling back to a new session",
                    session_id.0, resume_err, load_err
                );
                Err(load_err)
            }
        },
    }
}

#[allow(clippy::too_many_arguments)]
async fn execute_project_switch(
    agent_id: &AgentId,
    target: ProjectSwitchContext,
    previous_session_id: SessionId,
    acp: &Arc<AcpManager>,
    relay: &Arc<WsRelaySink>,
    current_session: &Arc<parking_lot::Mutex<Option<SessionId>>>,
    current_project: &Arc<parking_lot::Mutex<Option<String>>>,
) -> Result<SwitchProjectOutcome, String> {
    if connection_already_on_project(current_project.lock().as_deref(), &target.project_id) {
        return Ok(SwitchProjectOutcome::Completed {
            project_id: target.project_id,
            session_id: previous_session_id,
            cwd: target.cwd,
            mcp_server_count: target.mcp_servers.len(),
        });
    }

    let mcp_server_count = target.mcp_servers.len();
    // Switch-back reopen (Epic-4 bridge): before minting a new session, look up
    // the most-recent resumable session for the target `(project_id, cwd)` in
    // the host-owned durable history store. If found AND the agent has the
    // `load`/`resume` capability, reopen it so the web client restores the
    // previous conversation instead of starting a blank chat (mirrors desktop's
    // "restore the last tab"). Falls back to `new_session_with_context` when
    // no resumable session exists, the agent lacks the capability, or the
    // reopen fails (e.g. the session was purged).
    let reopened = match relay.persistence() {
        Some(persistence) => {
            try_reopen_session_for_switch(acp, agent_id, &persistence, &target).await
        }
        None => Ok(None),
    }
    .unwrap_or(None);
    let new_session = match reopened {
        Some(session_id) => session_id,
        None => {
            let outcome = acp
                .new_session_with_context(
                    agent_id,
                    target.cwd.clone(),
                    target.mcp_servers,
                    SessionCreationContext {
                        project_id: Some(target.project_id.clone()),
                        ephemeral: false,
                    },
                )
                .await?;
            outcome.session_id
        }
    };

    // Per-connection switch (Epic 7): update only this connection's
    // `current_project`. No `registry.set_default_project`, no
    // `broadcast_projects_changed`, no `FileProjectRegistry` persistence —
    // a per-client switch is ephemeral; only `set_default_project` writes
    // the durable default. Other connected clients are unaffected.
    *current_session.lock() = Some(new_session.clone());
    *current_project.lock() = Some(target.project_id.clone());
    debug!(
        target: "termul::web::ws",
        project_id = %target.project_id,
        session_id = %new_session.0,
        "switch_project: per-connection switch committed (no broadcast)"
    );

    if previous_session_id != new_session {
        if let Err(error) = acp.close_session(agent_id, previous_session_id).await {
            warn!("[ws] project switch committed but old session close failed: {error}");
        }
    }

    Ok(SwitchProjectOutcome::Completed {
        project_id: target.project_id,
        session_id: new_session,
        cwd: target.cwd,
        mcp_server_count,
    })
}

/// Cold-tab (no live agent) `switch_project`: deferred select. Updates only
/// the requesting connection's `current_project`. No agent is spawned and no
/// session is created — the Ask-First resolution stands; the web client
/// spawns the agent lazily when a chat starts. Returns `Selected`. The shared
/// `default_project_id` is NOT touched (per-connection switch); only
/// `set_default_project` changes the host default.
fn execute_cold_tab_select(
    target: ProjectSwitchContext,
    current_project: &Arc<parking_lot::Mutex<Option<String>>>,
) -> Result<SwitchProjectOutcome, String> {
    *current_project.lock() = Some(target.project_id.clone());
    debug!(
        target: "termul::web::ws",
        project_id = %target.project_id,
        "switch_project: cold-tab per-connection select (no broadcast, no persistence)"
    );
    Ok(SwitchProjectOutcome::Selected {
        project_id: target.project_id,
        cwd: target.cwd,
    })
}

#[allow(clippy::too_many_arguments)]
async fn run_switch_queue(
    agent_id: AgentId,
    acp: Arc<AcpManager>,
    relay: Arc<WsRelaySink>,
    out_tx: mpsc::UnboundedSender<Outbound>,
    current_session: Arc<parking_lot::Mutex<Option<SessionId>>>,
    current_project: Arc<parking_lot::Mutex<Option<String>>>,
    switch_queue: Arc<tokio::sync::Mutex<ProjectSwitchQueue>>,
) {
    loop {
        let pending = {
            let queue = switch_queue.lock().await;
            queue.pending.clone()
        };
        let Some(pending) = pending else {
            switch_queue.lock().await.worker_running = false;
            return;
        };

        if let Err(error) = acp
            .wait_turn_idle(&agent_id, pending.previous_session_id.clone())
            .await
        {
            let failed = {
                let mut queue = switch_queue.lock().await;
                queue.pending.take()
            };
            if let Some(failed) = failed {
                let _ = out_tx.send(Outbound::Event(project_switch_failed_event(
                    failed.request_id,
                    failed.target.project_id,
                    failed.previous_session_id,
                    error,
                )));
            }
            switch_queue.lock().await.worker_running = false;
            return;
        }

        let pending = {
            let mut queue = switch_queue.lock().await;
            queue.pending.take()
        };
        let Some(pending) = pending else {
            continue;
        };
        match execute_project_switch(
            &agent_id,
            pending.target.clone(),
            pending.previous_session_id.clone(),
            &acp,
            &relay,
            &current_session,
            &current_project,
        )
        .await
        {
            Ok(SwitchProjectOutcome::Completed {
                project_id,
                session_id,
                cwd,
                mcp_server_count,
            }) => {
                let event = SequencedEvent::new(
                    Some(pending.previous_session_id.0.clone()),
                    0,
                    "project_switch_completed",
                    serde_json::to_value(ProjectSwitchCompletedPayload {
                        status: "completed",
                        request_id: pending.request_id,
                        project_id,
                        previous_session_id: pending.previous_session_id,
                        session_id,
                        cwd,
                        mcp_server_count,
                    })
                    .unwrap_or_else(|_| json!({})),
                );
                let _ = out_tx.send(Outbound::Event(event));
            }
            Ok(SwitchProjectOutcome::Queued { .. }) => {}
            // `execute_project_switch` never returns `Selected` (only
            // `execute_cold_tab_select` does, on the cold-tab path); kept for
            // exhaustiveness now that the enum has a `Selected` variant.
            Ok(SwitchProjectOutcome::Selected { .. }) => {}
            Err(error) => {
                let _ = out_tx.send(Outbound::Event(project_switch_failed_event(
                    pending.request_id,
                    pending.target.project_id,
                    pending.previous_session_id,
                    error,
                )));
            }
        }
        let mut queue = switch_queue.lock().await;
        if queue.pending.is_some() {
            continue;
        }
        queue.worker_running = false;
        return;
    }
}

#[allow(clippy::too_many_arguments)]
async fn handle_switch_project(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
    relay: &Arc<WsRelaySink>,
    registry: &Arc<ProjectRegistry>,
    out_tx: &mpsc::UnboundedSender<Outbound>,
    current_agent: &mut Option<AgentId>,
    current_session: &Arc<parking_lot::Mutex<Option<SessionId>>>,
    current_project: &Arc<parking_lot::Mutex<Option<String>>>,
    switch_queue: &Arc<tokio::sync::Mutex<ProjectSwitchQueue>>,
) -> WsReply {
    let parsed: SwitchProjectPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed switch_project payload (want projectId): {e}"),
            )
        }
    };
    // Resolve the target FIRST (pure registry lookup). Archived / unknown /
    // pathless ids are `NOT_FOUND` for both cold-tab and live-agent paths —
    // hoisted above the agent check so a cold tab can select without a live
    // agent. The live-agent behavior is unchanged: it also resolves `target`
    // before any session work.
    let target = match registry.switch_context(&parsed.project_id) {
        Some(target) => target,
        None => {
            return WsReply::err(
                id,
                WsErrorCode::NotFound,
                format!(
                    "project '{}' not found or not switchable",
                    parsed.project_id
                ),
            )
        }
    };
    let agent_id = match current_agent.clone() {
        Some(agent_id) => agent_id,
        // Cold tab (no live agent): deferred per-connection select — update
        // only this connection's `current_project`, return `Selected`. No
        // agent spawn / session (Ask-First stands; the web client spawns
        // lazily on chat start). No host-default change, no broadcast, no
        // persistence (per-connection switch is ephemeral).
        None => match execute_cold_tab_select(target, current_project) {
            Ok(outcome) => return ok_with_payload(id, &outcome),
            Err(error) => return acp_err_to_reply(id, error),
        },
    };
    let previous_session_id = match current_session.lock().clone() {
        Some(session_id) => session_id,
        None => {
            return WsReply::err(
                id,
                WsErrorCode::NotFound,
                "switch_project requires a tracked current session",
            )
        }
    };

    match acp
        .is_turn_active(&agent_id, previous_session_id.clone())
        .await
    {
        Ok(false) => match execute_project_switch(
            &agent_id,
            target,
            previous_session_id,
            acp,
            relay,
            current_session,
            current_project,
        )
        .await
        {
            Ok(outcome) => ok_with_payload(id, &outcome),
            Err(error) => acp_err_to_reply(id, error),
        },
        Ok(true) => {
            let outcome = SwitchProjectOutcome::Queued {
                project_id: target.project_id.clone(),
                current_session_id: previous_session_id.clone(),
            };
            let mut queue = switch_queue.lock().await;
            let replaced = queue.replace_pending(PendingProjectSwitch {
                request_id: id.clone(),
                target,
                previous_session_id,
            });
            if let Some(replaced) = replaced {
                let _ = out_tx.send(Outbound::Event(project_switch_failed_event(
                    replaced.request_id,
                    replaced.target.project_id,
                    replaced.previous_session_id,
                    "queued project switch was replaced by a newer request".to_string(),
                )));
            }
            if !queue.worker_running {
                queue.worker_running = true;
                tokio::spawn(run_switch_queue(
                    agent_id,
                    Arc::clone(acp),
                    Arc::clone(relay),
                    out_tx.clone(),
                    Arc::clone(current_session),
                    Arc::clone(current_project),
                    Arc::clone(switch_queue),
                ));
            }
            ok_with_payload(id, &outcome)
        }
        Err(error) => acp_err_to_reply(id, error),
    }
}

/// `load_session` → `AcpManager::load_session(agent_id, session_id, cwd)`.
/// Reply payload = the camelCase reopen option snapshot.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadResumeSessionPayload {
    agent_id: crate::acp::AgentId,
    session_id: crate::acp::SessionId,
    cwd: String,
}

async fn handle_load_session(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
    current_agent: &mut Option<crate::acp::AgentId>,
    current_session: &Arc<parking_lot::Mutex<Option<crate::acp::SessionId>>>,
    current_project: &Arc<parking_lot::Mutex<Option<String>>>,
) -> WsReply {
    let parsed: LoadResumeSessionPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed load_session payload (want agentId, sessionId, cwd): {e}"),
            )
        }
    };
    // Clone the ids before the call moves `parsed.session_id` + `parsed.cwd`;
    // we still need the session id to track it for `switch_project`.
    let agent_id = parsed.agent_id.clone();
    let session_id = parsed.session_id.clone();
    match acp
        .load_session(&agent_id, parsed.session_id, parsed.cwd)
        .await
    {
        Ok(outcome) => {
            *current_agent = Some(agent_id);
            *current_session.lock() = Some(session_id);
            *current_project.lock() = None;
            ok_with_payload(id, &outcome)
        }
        Err(e) => acp_err_to_reply(id, e),
    }
}

/// `resume_session` → `AcpManager::resume_session(agent_id, session_id, cwd)`.
/// Reply payload = the camelCase reopen option snapshot.
async fn handle_resume_session(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
    current_agent: &mut Option<crate::acp::AgentId>,
    current_session: &Arc<parking_lot::Mutex<Option<crate::acp::SessionId>>>,
    current_project: &Arc<parking_lot::Mutex<Option<String>>>,
) -> WsReply {
    let parsed: LoadResumeSessionPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed resume_session payload (want agentId, sessionId, cwd): {e}"),
            )
        }
    };
    // Clone the ids before the call moves `parsed.session_id` + `parsed.cwd`;
    // we still need the session id to track it for `switch_project`.
    let agent_id = parsed.agent_id.clone();
    let session_id = parsed.session_id.clone();
    match acp
        .resume_session(&agent_id, parsed.session_id, parsed.cwd)
        .await
    {
        Ok(outcome) => {
            *current_agent = Some(agent_id);
            *current_session.lock() = Some(session_id);
            *current_project.lock() = None;
            ok_with_payload(id, &outcome)
        }
        Err(e) => acp_err_to_reply(id, e),
    }
}

/// `close_session` → `AcpManager::close_session(agent_id, session_id)`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloseSessionPayload {
    agent_id: crate::acp::AgentId,
    session_id: crate::acp::SessionId,
}

async fn handle_dispose_ephemeral_session(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
    relay: &Arc<WsRelaySink>,
    subscribed_clients: &mut Vec<(String, ClientId)>,
    current_session: &Arc<parking_lot::Mutex<Option<SessionId>>>,
    current_project: &Arc<parking_lot::Mutex<Option<String>>>,
) -> WsReply {
    let parsed: CloseSessionPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!(
                    "malformed dispose_ephemeral_session payload (want agentId, sessionId): {e}"
                ),
            )
        }
    };
    let disposed_session_id = parsed.session_id.clone();
    match acp
        .dispose_ephemeral_session(&parsed.agent_id, parsed.session_id)
        .await
    {
        Ok(()) => {
            subscribed_clients.retain(|(session_id, client_id)| {
                if session_id == &disposed_session_id.0 {
                    relay.unsubscribe(session_id, *client_id);
                    false
                } else {
                    true
                }
            });
            if current_session.lock().as_ref() == Some(&disposed_session_id) {
                *current_session.lock() = None;
                *current_project.lock() = None;
            }
            relay.forget_session(&disposed_session_id.0).await;
            WsReply::ok(id, Some(json!({})))
        }
        Err(e) => acp_err_to_reply(id, e),
    }
}

async fn handle_close_session(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
    current_session: &Arc<parking_lot::Mutex<Option<SessionId>>>,
    current_project: &Arc<parking_lot::Mutex<Option<String>>>,
) -> WsReply {
    let parsed: CloseSessionPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed close_session payload (want agentId, sessionId): {e}"),
            )
        }
    };
    let closing_session_id = parsed.session_id.clone();
    match acp.close_session(&parsed.agent_id, parsed.session_id).await {
        Ok(()) => {
            if current_session.lock().as_ref() == Some(&closing_session_id) {
                *current_session.lock() = None;
                *current_project.lock() = None;
            }
            WsReply::ok(id, Some(json!({})))
        }
        Err(e) => acp_err_to_reply(id, e),
    }
}

/// `list_sessions` → `AcpManager::list_sessions(agent_id, cwd?, cursor?)`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListSessionsPayload {
    agent_id: crate::acp::AgentId,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    cursor: Option<String>,
}

async fn handle_list_sessions(id: String, payload: &Value, acp: &Arc<AcpManager>) -> WsReply {
    let parsed: ListSessionsPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed list_sessions payload (want agentId, cwd?, cursor?): {e}"),
            )
        }
    };
    match acp
        .list_sessions(&parsed.agent_id, parsed.cwd, parsed.cursor)
        .await
    {
        Ok(resp) => ok_with_payload(id, &resp),
        Err(e) => acp_err_to_reply(id, e),
    }
}

/// `send_prompt` → `AcpManager::send_prompt(agent_id, session_id, content)`.
/// Story 1.7 T7.1: the concurrent-turn rejection (`ACP_TURN_IN_PROGRESS`) maps
/// to `err.code: "rate_limited"` via `map_prompt_error_code`. Story 1.8 T3:
/// the client `turnId` is extracted + stashed for the `prompt_complete`
/// idempotent-by-turn-id dedup (see `TurnWatermark`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendPromptPayload {
    agent_id: crate::acp::AgentId,
    session_id: crate::acp::SessionId,
    /// Text-mode prompt (mutually exclusive with `content`).
    #[serde(default)]
    text: Option<String>,
    /// Blocks-mode prompt (attachments + structured content).
    #[serde(default)]
    content: Option<Vec<agent_client_protocol::schema::v1::ContentBlock>>,
    /// Story 1.8 T3: client-generated turn id for `prompt_complete` dedup.
    /// Optional for forward-compat (older clients omit it; dedup is a no-op).
    #[serde(default)]
    turn_id: Option<String>,
}

async fn handle_send_prompt(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
    relay: &Arc<WsRelaySink>,
) -> WsReply {
    let parsed: SendPromptPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => return WsReply::err(id, WsErrorCode::Unsupported, format!("malformed send_prompt payload (want agentId, sessionId, text|content, turnId?): {e}")),
    };
    // Build the content blocks: prefer explicit `content`; fall back to a
    // single text block from `text` (mirrors the desktop store's `sendPrompt`
    // vs `sendPromptBlocks` split — both become `Vec<ContentBlock>` for the agent).
    let content = match (parsed.content, parsed.text) {
        (Some(blocks), _) if !blocks.is_empty() => blocks,
        // Story 1.8 review (EC3): reject an empty/whitespace-only text (the
        // desktop `commands.rs` has the same guard; an empty-text turn would
        // leak past the `content.is_empty()` check in `AcpManager::send_prompt`
        // and poison the turn-id watermark).
        (_, Some(text)) if !text.trim().is_empty() => {
            vec![agent_client_protocol::schema::v1::ContentBlock::Text(
                agent_client_protocol::schema::v1::TextContent::new(text),
            )]
        }
        _ => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                "send_prompt requires non-empty `text` or `content`",
            )
        }
    };

    // Ownership is authoritative driver state, not browser input. Reject a
    // cross-agent session id before claiming a turn, assigning a relay seq, or
    // writing any durable prompt record.
    match acp
        .owns_session(&parsed.agent_id, parsed.session_id.clone())
        .await
    {
        Ok(true) => {}
        Ok(false) => {
            return WsReply::err(
                id,
                WsErrorCode::NotFound,
                "session does not belong to the supplied live agent",
            )
        }
        Err(error) => return acp_err_to_reply(id, error),
    }

    // Claim before persistence so duplicate/busy turns cannot create durable
    // prompt records. The manager still enforces its driver-thread single-flight
    // invariant; this closes the web persistence ordering gap.
    match relay
        .turn_watermark()
        .claim_turn(parsed.session_id.0.as_str(), parsed.turn_id.as_deref())
    {
        TurnClaim::Claimed => {}
        TurnClaim::Completed => {
            return WsReply::err(
                id,
                WsErrorCode::Stale,
                "this turn already completed (stale turn-id)",
            )
        }
        TurnClaim::DuplicateInFlight | TurnClaim::Busy => {
            return WsReply::err(
                id,
                WsErrorCode::RateLimited,
                "a prompt turn is already in progress",
            )
        }
    }

    let ephemeral = match acp
        .is_ephemeral_session(&parsed.agent_id, parsed.session_id.clone())
        .await
    {
        Ok(value) => value,
        Err(error) => {
            relay
                .turn_watermark()
                .release_claim(parsed.session_id.0.as_str(), parsed.turn_id.as_deref());
            return acp_err_to_reply(id, error);
        }
    };

    let prompt_payload = json!({
        "agentId": parsed.agent_id.clone(),
        "sessionId": parsed.session_id.clone(),
        "turnId": parsed.turn_id.clone(),
        "content": content.clone(),
    });
    if !ephemeral {
        if let Err(error) = relay
            .persist_user_prompt(parsed.session_id.0.as_str(), prompt_payload)
            .await
        {
            relay
                .turn_watermark()
                .release_claim(parsed.session_id.0.as_str(), parsed.turn_id.as_deref());
            return WsReply::err(
                id,
                WsErrorCode::NotImplemented,
                format!("failed to persist accepted prompt: {error}"),
            );
        }
    }

    match acp
        .send_prompt(
            &parsed.agent_id,
            parsed.session_id.clone(),
            content,
            parsed.turn_id.clone(),
        )
        .await
    {
        Ok(stop_reason) => {
            // Story 1.8 T3.3: advance the watermark on completion so a stale
            // `send_prompt` for the same turn-id is rejected on reconnect
            // (FR13 last-completed-turn watermark; backs `is_completed` above).
            // NOTE: the `seen` SET is NOT grown here (review EC2) — dedup of
            // replayed `prompt_complete` events is client-side
            // (`acp-transport.ts::seenTurnIds`); the server-side `seen` set has
            // no reader and would grow unbounded. Only the high-water mark
            // (`record_completed`) is advanced, which `is_completed` reads.
            if let Some(turn_id) = &parsed.turn_id {
                relay
                    .turn_watermark()
                    .record_completed(parsed.session_id.0.as_str(), turn_id);
            }
            ok_with_payload(id, &stop_reason)
        }
        Err(e) => {
            relay
                .turn_watermark()
                .release_claim(parsed.session_id.0.as_str(), parsed.turn_id.as_deref());
            acp_err_to_reply(id, e)
        }
    }
}

/// `cancel_prompt` → `AcpManager::cancel_prompt(agent_id, session_id)`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionOnlyPayload {
    agent_id: crate::acp::AgentId,
    session_id: crate::acp::SessionId,
}

async fn handle_cancel_prompt(id: String, payload: &Value, acp: &Arc<AcpManager>) -> WsReply {
    let parsed: SessionOnlyPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed cancel_prompt payload (want agentId, sessionId): {e}"),
            )
        }
    };
    match acp.cancel_prompt(&parsed.agent_id, parsed.session_id).await {
        Ok(()) => WsReply::ok(id, Some(json!({}))),
        Err(e) => acp_err_to_reply(id, e),
    }
}

/// `set_mode` → `AcpManager::set_mode(agent_id, session_id, mode_id)`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetModePayload {
    agent_id: crate::acp::AgentId,
    session_id: crate::acp::SessionId,
    mode_id: String,
}

async fn handle_set_mode(id: String, payload: &Value, acp: &Arc<AcpManager>) -> WsReply {
    let parsed: SetModePayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed set_mode payload (want agentId, sessionId, modeId): {e}"),
            )
        }
    };
    match acp
        .set_mode(&parsed.agent_id, parsed.session_id, parsed.mode_id)
        .await
    {
        Ok(()) => WsReply::ok(id, Some(json!({}))),
        Err(e) => acp_err_to_reply(id, e),
    }
}

/// `set_model` → `AcpManager::set_model(agent_id, session_id, model_id)`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetModelPayload {
    agent_id: crate::acp::AgentId,
    session_id: crate::acp::SessionId,
    model_id: String,
}

async fn handle_set_model(id: String, payload: &Value, acp: &Arc<AcpManager>) -> WsReply {
    let parsed: SetModelPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed set_model payload (want agentId, sessionId, modelId): {e}"),
            )
        }
    };
    match acp
        .set_model(&parsed.agent_id, parsed.session_id, parsed.model_id)
        .await
    {
        Ok(()) => WsReply::ok(id, Some(json!({}))),
        Err(e) => acp_err_to_reply(id, e),
    }
}

/// `set_config_option` → `AcpManager::set_config_option(agent_id, session_id,
/// config_id, value_id)`. Reply payload = the updated `Vec<SessionConfigOption>`
/// (the desktop path also emits `acp:config_options_update` automatically).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetConfigOptionPayload {
    agent_id: crate::acp::AgentId,
    session_id: crate::acp::SessionId,
    config_id: String,
    value_id: String,
}

async fn handle_set_config_option(id: String, payload: &Value, acp: &Arc<AcpManager>) -> WsReply {
    let parsed: SetConfigOptionPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => return WsReply::err(id, WsErrorCode::Unsupported, format!("malformed set_config_option payload (want agentId, sessionId, configId, valueId): {e}")),
    };
    match acp
        .set_config_option(
            &parsed.agent_id,
            parsed.session_id,
            parsed.config_id,
            parsed.value_id,
        )
        .await
    {
        Ok(options) => ok_with_payload(id, &options),
        Err(e) => acp_err_to_reply(id, e),
    }
}

/// Wire `subscribe` → [`WsRelaySink::subscribe`] + forward replay/live to this connection.
async fn handle_subscribe(
    id: String,
    payload: &Value,
    relay: &Arc<WsRelaySink>,
    out_tx: &mpsc::UnboundedSender<Outbound>,
    subscribed_clients: &mut Vec<(String, ClientId)>,
) -> WsReply {
    let parsed: SubscribePayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed subscribe payload (want sessionId, lastSeq): {e}"),
            );
        }
    };
    if parsed.session_id.is_empty() {
        return WsReply::err(id, WsErrorCode::Unsupported, "sessionId is required");
    }

    // Do not drop the currently-live subscription until the replacement is
    // successfully registered. This preserves pending-permission ownership on
    // stale/failure and lets grace cancellation happen only after resubscribe.
    let prior_clients: Vec<ClientId> = subscribed_clients
        .iter()
        .filter(|(sid, _)| sid == &parsed.session_id)
        .map(|(_, client_id)| *client_id)
        .collect();

    let (client_id, mut rx, replay) = relay.subscribe(&parsed.session_id, parsed.last_seq).await;
    match replay {
        ReplayResult::Stale => {
            relay.unregister_client(client_id);
            WsReply::err(
                id,
                WsErrorCode::Stale,
                "cursor is older than the event log; request an atomic session snapshot",
            )
        }
        ReplayResult::Ok(replayed) => {
            subscribed_clients.retain(|(sid, cid)| {
                if sid == &parsed.session_id && prior_clients.contains(cid) {
                    relay.unsubscribe(sid, *cid);
                    false
                } else {
                    true
                }
            });
            subscribed_clients.push((parsed.session_id.clone(), client_id));
            if let Some(rendezvous) = relay.rendezvous() {
                rendezvous.cancel_disconnect_grace(&parsed.session_id);
            }
            let forward_tx = out_tx.clone();
            tokio::spawn(async move {
                while let Some(evt) = rx.recv().await {
                    if forward_tx.send(Outbound::Event(evt)).is_err() {
                        break;
                    }
                }
            });
            WsReply::ok(
                id,
                Some(json!({
                    "sessionId": parsed.session_id,
                    "replayed": replayed,
                })),
            )
        }
    }
}

/// CamelCase `respond_permission` payload (Story 1.7) — mirrors the client
/// `acp-transport.ts: respondPermission(agentId, requestId, optionId?)`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RespondPermissionPayload {
    agent_id: crate::acp::AgentId,
    request_id: String,
    /// `None` / omitted → cancel/deny (`RequestPermissionOutcome::Cancelled`).
    #[serde(default)]
    option_id: Option<String>,
}

/// Wire `respond_permission` → [`crate::web::permissions::PermissionRendezvous`]
/// (first-response-wins, TOCTOU re-validation, at-most-one) →
/// `AcpManager::respond_permission` (resolves the agent `Responder` on the
/// driver thread). Maps the rendezvous outcome/error to a stable `err.code`.
///
/// Requires a server-side rendezvous attached to the relay (`relay.rendezvous()`).
/// On the desktop path (no rendezvous) the browser never reaches this handler
/// — the desktop uses the `acp_respond_permission` Tauri command directly.
async fn handle_respond_permission(
    id: String,
    payload: &Value,
    relay: &Arc<WsRelaySink>,
    subscribed_clients: &[(String, ClientId)],
) -> WsReply {
    let Some(rdz) = relay.rendezvous() else {
        return WsReply::err(
            id,
            WsErrorCode::NotImplemented,
            "permission rendezvous is not attached (desktop path uses the Tauri command)",
        );
    };

    let parsed: RespondPermissionPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed respond_permission payload (want agentId, requestId, optionId?): {e}"),
            );
        }
    };
    if parsed.request_id.is_empty() {
        return WsReply::err(id, WsErrorCode::Unsupported, "requestId is required");
    }

    // Defense in depth: the payload's `agentId` must match the ticket's agent
    // (a client cannot resolve another agent's permission).
    let Some(ticket_agent) = rdz.agent_for_request(&parsed.request_id) else {
        return WsReply::err(
            id,
            WsErrorCode::Stale,
            "no outstanding permission for this requestId",
        );
    };
    if ticket_agent != parsed.agent_id {
        return WsReply::err(
            id,
            WsErrorCode::PermissionDenied,
            "agentId does not match the permission's agent",
        );
    }

    // Resolve the calling connection's `ClientId` for this permission's session
    // (a connection may be subscribed to several sessions; the permission belongs
    // to one). Ownership check: the connection MUST be subscribed to the
    // permission's session (NFR5 — no cross-session permission resolution).
    let Some(session_id) = rdz.session_for_request(&parsed.request_id) else {
        return WsReply::err(
            id,
            WsErrorCode::Stale,
            "no outstanding permission for this requestId",
        );
    };
    let Some((_, client_id)) = subscribed_clients
        .iter()
        .find(|(sid, _)| *sid == session_id)
    else {
        return WsReply::err(
            id,
            WsErrorCode::NotFound,
            "this connection is not subscribed to the permission's session",
        );
    };
    let client_id = *client_id;

    let option_id = parsed.option_id.as_deref();
    match rdz
        .try_respond(client_id, &parsed.request_id, option_id)
        .await
    {
        Ok(crate::web::permissions::RespondOutcome::Resolved) => WsReply::ok(id, Some(json!({}))),
        Err(err) => {
            // Map each rendezvous rejection to its stable `err.code` (mirrors
            // `RespondError::wire_code`, but goes through `WsErrorCode` so the
            // enum + TS const stay the single source of truth).
            let (code, msg) = match err {
                crate::web::permissions::RespondError::NotFound => (
                    WsErrorCode::Stale,
                    "no outstanding permission for this requestId",
                ),
                crate::web::permissions::RespondError::AlreadyResolved => (
                    WsErrorCode::Stale,
                    "this permission was already resolved by another client (first-response-wins)",
                ),
                crate::web::permissions::RespondError::Duplicate => (
                    WsErrorCode::Duplicate,
                    "this client already responded to this permission",
                ),
                crate::web::permissions::RespondError::InvalidOption => (
                    WsErrorCode::PermissionDenied,
                    "optionId is not among the original permission options (TOCTOU defense)",
                ),
                crate::web::permissions::RespondError::NotSubscribed => (
                    WsErrorCode::NotFound,
                    "not subscribed to the permission's session",
                ),
            };
            WsReply::err(id, code, msg)
        }
        // `RespondOutcome` has only `Resolved` after the enum consolidation; the
        // other arms are unreachable. Keep a fallthrough for future variants.
        #[allow(unreachable_patterns)]
        _ => WsReply::err(
            id,
            WsErrorCode::NotImplemented,
            "unexpected permission rendezvous outcome",
        ),
    }
}

/// CamelCase `answer_question` payload (issue #411) — mirrors the client
/// `acp-transport.ts: answerQuestion(agentId, questionId, values?)`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnswerQuestionPayload {
    agent_id: crate::acp::AgentId,
    question_id: String,
    /// `None` / omitted → cancel; `Some(values)` → selected option values.
    #[serde(default)]
    values: Option<Vec<String>>,
}

/// Wire `answer_question` → [`crate::web::permissions::QuestionRendezvous`]
/// (first-response-wins, TOCTOU re-validation) → `AcpManager::answer_question`
/// (resolves the agent `Responder` on the driver thread). Maps the rendezvous
/// outcome/error to a stable `err.code` (mirrors `handle_respond_permission`).
///
/// Requires a server-side question rendezvous attached to the relay
/// (`relay.question_rendezvous()`). On the desktop path (no rendezvous) the
/// browser never reaches this handler — the desktop uses the `acp_answer_question`
/// Tauri command directly.
async fn handle_answer_question(
    id: String,
    payload: &Value,
    relay: &Arc<WsRelaySink>,
    subscribed_clients: &[(String, ClientId)],
) -> WsReply {
    let Some(rdz) = relay.question_rendezvous() else {
        return WsReply::err(
            id,
            WsErrorCode::NotImplemented,
            "question rendezvous is not attached (desktop path uses the Tauri command)",
        );
    };

    let parsed: AnswerQuestionPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!(
                    "malformed answer_question payload (want agentId, questionId, values?): {e}"
                ),
            );
        }
    };
    if parsed.question_id.is_empty() {
        return WsReply::err(id, WsErrorCode::Unsupported, "questionId is required");
    }

    // Defense in depth: the payload's `agentId` must match the ticket's agent.
    let Some(ticket_agent) = rdz.agent_for_question(&parsed.question_id) else {
        return WsReply::err(
            id,
            WsErrorCode::Stale,
            "no outstanding question for this questionId",
        );
    };
    if ticket_agent != parsed.agent_id {
        return WsReply::err(
            id,
            WsErrorCode::PermissionDenied,
            "agentId does not match the question's agent",
        );
    }

    // Ownership check: the connection MUST be subscribed to the question's
    // session (NFR5 — no cross-session question resolution).
    let Some(session_id) = rdz.session_for_question(&parsed.question_id) else {
        return WsReply::err(
            id,
            WsErrorCode::Stale,
            "no outstanding question for this questionId",
        );
    };
    let Some((_, client_id)) = subscribed_clients
        .iter()
        .find(|(sid, _)| *sid == session_id)
    else {
        return WsReply::err(
            id,
            WsErrorCode::NotFound,
            "this connection is not subscribed to the question's session",
        );
    };
    let client_id = *client_id;

    let values = parsed.values.as_deref();
    match rdz
        .try_respond(client_id, &parsed.question_id, values)
        .await
    {
        Ok(crate::web::permissions::QuestionRespondOutcome::Resolved) => {
            WsReply::ok(id, Some(json!({})))
        }
        Err(err) => {
            let (code, msg) = match err {
                crate::web::permissions::QuestionRespondError::NotFound => (
                    WsErrorCode::Stale,
                    "no outstanding question for this questionId",
                ),
                crate::web::permissions::QuestionRespondError::AlreadyResolved => (
                    WsErrorCode::Stale,
                    "this question was already answered by another client (first-response-wins)",
                ),
                crate::web::permissions::QuestionRespondError::Duplicate => (
                    WsErrorCode::Duplicate,
                    "this client already answered this question",
                ),
                crate::web::permissions::QuestionRespondError::InvalidOption => (
                    WsErrorCode::PermissionDenied,
                    "a value is not among the original question options (TOCTOU defense)",
                ),
            };
            WsReply::err(id, code, msg)
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;
    use crate::acp::SpawnOutcome;
    use std::collections::HashSet;

    #[tokio::test]
    async fn cross_agent_prompt_is_rejected_before_claim_or_persistence() {
        let root =
            std::env::temp_dir().join(format!("termul-ws-ownership-{}", uuid::Uuid::new_v4()));
        let cwd = root.join("cwd");
        std::fs::create_dir_all(&cwd).unwrap();
        let persistence = crate::acp::SessionPersistence::open(root.join("sessions"))
            .await
            .unwrap();
        persistence
            .register_session(crate::acp::SessionRegistration {
                session_id: "session-a".to_string(),
                stable_agent_namespace: None,
                runtime_agent_id: Some("agent-a".to_string()),
                project_id: None,
                cwd,
            })
            .await
            .unwrap();
        let relay = Arc::new(WsRelaySink::with_persistence(8, persistence.clone()));
        let acp = Arc::new(AcpManager::with_persistence(vec![], persistence.clone()));
        acp.install_test_agent_with_sessions(
            crate::acp::AgentId("agent-b".to_string()),
            HashSet::new(),
        );

        let reply = handle_send_prompt(
            "request-1".to_string(),
            &json!({
                "agentId": "agent-b",
                "sessionId": "session-a",
                "text": "must not persist",
                "turnId": "turn-cross-agent"
            }),
            &acp,
            &relay,
        )
        .await;
        assert!(!reply.ok);
        assert_eq!(reply.err.unwrap().code, "not_found");
        assert_eq!(persistence.last_seq("session-a").unwrap(), 0);
        assert!(persistence.replay_after("session-a", 0).unwrap().is_empty());
        assert_eq!(
            relay
                .turn_watermark()
                .claim_turn("session-a", Some("turn-cross-agent")),
            TurnClaim::Claimed
        );
        relay
            .turn_watermark()
            .release_claim("session-a", Some("turn-cross-agent"));
        persistence.shutdown().await.unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn tier_of_maps_lossy_events() {
        assert_eq!(tier_of("message_chunk"), ReliabilityTier::Lossy);
        assert_eq!(tier_of("tool_call_update"), ReliabilityTier::Lossy);
        assert_eq!(tier_of("commands_update"), ReliabilityTier::Lossy);
        assert_eq!(tier_of("plan_update"), ReliabilityTier::Lossy);
    }

    #[test]
    fn tier_of_maps_idempotent_and_reliable() {
        assert_eq!(tier_of("prompt_complete"), ReliabilityTier::Idempotent);
        assert_eq!(tier_of("permission_request"), ReliabilityTier::Reliable);
        assert_eq!(tier_of("agent_spawned"), ReliabilityTier::Reliable);
        assert_eq!(tier_of("auth_required"), ReliabilityTier::Reliable);
        // Unknown types default to reliable (safe — never drop).
        assert_eq!(tier_of("unknown_type"), ReliabilityTier::Reliable);
    }

    #[test]
    fn error_codes_are_snake_case() {
        assert_eq!(WsErrorCode::NotFound.as_str(), "not_found");
        assert_eq!(WsErrorCode::Unauthorized.as_str(), "unauthorized");
        assert_eq!(WsErrorCode::RateLimited.as_str(), "rate_limited");
        assert_eq!(WsErrorCode::AgentCrashed.as_str(), "agent_crashed");
        assert_eq!(WsErrorCode::PermissionDenied.as_str(), "permission_denied");
        assert_eq!(WsErrorCode::Stale.as_str(), "stale");
        assert_eq!(WsErrorCode::Duplicate.as_str(), "duplicate");
        assert_eq!(WsErrorCode::Unsupported.as_str(), "unsupported");
        assert_eq!(WsErrorCode::NotImplemented.as_str(), "not_implemented");
    }

    /// Story 1.7 T7.1: the `ACP_TURN_IN_PROGRESS` desktop error string maps to
    /// `WsErrorCode::RateLimited` on the WS path (for Story 1.8's `send_prompt`).
    #[test]
    fn map_prompt_error_code_maps_turn_in_progress_to_rate_limited() {
        assert_eq!(
            map_prompt_error_code("ACP_TURN_IN_PROGRESS: session sess-1"),
            Some(WsErrorCode::RateLimited)
        );
        assert_eq!(
            map_prompt_error_code("ACP_TURN_IN_PROGRESS: session abc"),
            Some(WsErrorCode::RateLimited)
        );
        // Other errors are not mapped (caller handles them generically).
        assert_eq!(map_prompt_error_code("agent initialize failed"), None);
        assert_eq!(map_prompt_error_code(""), None);
    }

    #[test]
    fn os_cap_boundary_exact_and_prefix() {
        assert!(is_os_fulfilled_cap("fs/read_text_file"));
        assert!(is_os_fulfilled_cap("fs/write_text_file"));
        assert!(is_os_fulfilled_cap("terminal/run_command"));
        assert!(is_os_fulfilled_cap("terminal/anything"));
        // Human-relayed + unknown caps are NOT OS-fulfilled.
        assert!(!is_os_fulfilled_cap("request_permission"));
        assert!(!is_os_fulfilled_cap("session_notification"));
        assert!(!is_os_fulfilled_cap("unknown/cap"));
    }

    #[test]
    fn human_cap_boundary() {
        assert!(is_human_relayed_cap("request_permission"));
        assert!(is_human_relayed_cap("session_notification"));
        assert!(!is_human_relayed_cap("fs/read_text_file"));
        assert!(!is_human_relayed_cap("terminal/run_command"));
    }

    #[test]
    fn reopen_outcome_serializes_as_ws_reply_payload() {
        let outcome = crate::acp::manager::SessionReopenOutcome {
            modes: None,
            models: None,
            config_options: Some(vec![]),
        };
        let reply = ok_with_payload("reopen-1".to_string(), &outcome);
        assert!(reply.ok);
        assert_eq!(reply.payload, Some(json!({ "configOptions": [] })));
        assert!(reply.err.is_none());
    }

    #[test]
    fn sequenced_event_serializes_snake_case_envelope() {
        let evt = SequencedEvent::new(
            Some("sess-1".to_string()),
            7,
            "message_chunk",
            json!({
                "agentId": "a1", "sessionId": "sess-1", "role": "agent"
            }),
        );
        let v = serde_json::to_value(&evt).expect("serialize");
        // Envelope fields are snake_case.
        assert_eq!(v["sid"], "sess-1");
        assert_eq!(v["seq"], 7);
        assert_eq!(v["type"], "message_chunk");
        // Payload is passed through verbatim (camelCase preserved — AC3).
        assert_eq!(v["payload"]["agentId"], "a1");
        assert_eq!(v["payload"]["sessionId"], "sess-1");
    }

    #[test]
    fn auth_required_event_shape() {
        let evt = auth_required_event();
        assert!(evt.sid.is_none());
        assert_eq!(evt.seq, 0);
        assert_eq!(evt.type_, "auth_required");
        assert_eq!(evt.payload, json!({}));
    }

    #[test]
    fn project_switch_outcomes_and_failure_event_serialize_camel_case() {
        let completed = SwitchProjectOutcome::Completed {
            project_id: "p-2".to_string(),
            session_id: SessionId("s-new".to_string()),
            cwd: "/work/p2".to_string(),
            mcp_server_count: 2,
        };
        let completed = serde_json::to_value(completed).expect("completed serde");
        assert_eq!(completed["status"], "completed");
        assert_eq!(completed["projectId"], "p-2");
        assert_eq!(completed["sessionId"], "s-new");
        assert_eq!(completed["mcpServerCount"], 2);

        let queued = SwitchProjectOutcome::Queued {
            project_id: "p-3".to_string(),
            current_session_id: SessionId("s-old".to_string()),
        };
        let queued = serde_json::to_value(queued).expect("queued serde");
        assert_eq!(queued["status"], "queued");
        assert_eq!(queued["projectId"], "p-3");
        assert_eq!(queued["currentSessionId"], "s-old");

        let failed = project_switch_failed_event(
            "r-1".to_string(),
            "p-3".to_string(),
            SessionId("s-old".to_string()),
            "persist failed".to_string(),
        );
        assert_eq!(failed.type_, "project_switch_failed");
        assert_eq!(failed.sid.as_deref(), Some("s-old"));
        assert_eq!(failed.seq, 0);
        assert_eq!(failed.payload["requestId"], "r-1");
        assert_eq!(failed.payload["projectId"], "p-3");
        assert_eq!(failed.payload["previousSessionId"], "s-old");
        assert_eq!(failed.payload["message"], "persist failed");
    }

    #[test]
    fn connection_specific_no_op_requires_known_matching_project() {
        assert!(!connection_already_on_project(None, "p-1"));
        assert!(!connection_already_on_project(Some("p-2"), "p-1"));
        assert!(connection_already_on_project(Some("p-1"), "p-1"));
    }

    #[test]
    fn project_switch_queue_replacement_is_latest_wins() {
        let pending = |request_id: &str, project_id: &str| PendingProjectSwitch {
            request_id: request_id.to_string(),
            target: ProjectSwitchContext {
                project_id: project_id.to_string(),
                cwd: format!("/work/{project_id}"),
                mcp_servers: Vec::new(),
            },
            previous_session_id: SessionId("s-old".to_string()),
        };
        let mut queue = ProjectSwitchQueue::default();
        assert!(queue.replace_pending(pending("r-1", "p-1")).is_none());
        let replaced = queue
            .replace_pending(pending("r-2", "p-2"))
            .expect("first request replaced");
        assert_eq!(replaced.request_id, "r-1");
        assert_eq!(replaced.target.project_id, "p-1");
        assert_eq!(queue.pending.as_ref().unwrap().request_id, "r-2");
        assert_eq!(queue.pending.as_ref().unwrap().target.project_id, "p-2");
    }

    #[test]
    fn ws_reply_ok_and_err_shape() {
        let ok = WsReply::ok("r1", Some(json!({"ok": true})));
        let v = serde_json::to_value(&ok).expect("serialize ok");
        assert_eq!(v["id"], "r1");
        assert_eq!(v["ok"], true);
        assert_eq!(v["payload"]["ok"], true);
        assert!(v.get("err").is_none(), "err must be omitted on success");

        let err = WsReply::err("r2", WsErrorCode::Unauthorized, "nope");
        let ve = serde_json::to_value(&err).expect("serialize err");
        assert_eq!(ve["id"], "r2");
        assert_eq!(ve["ok"], false);
        assert_eq!(ve["err"]["code"], "unauthorized");
        assert_eq!(ve["err"]["message"], "nope");
        assert!(
            ve.get("payload").is_none(),
            "payload must be omitted on failure"
        );
    }

    fn handle_sync(text: &str, authed: &mut bool) -> WsReply {
        let relay = Arc::new(WsRelaySink::new());
        // Story 1.8: handle_request now takes `&Arc<AcpManager>`. The no-op
        // manager (`vec![]` sinks) returns fast `Err`s for the ACP command
        // methods (no agent spawned) which the handlers map to `WsErrorCode`.
        let acp = Arc::new(AcpManager::new(vec![]));
        let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
        let mut subs = Vec::new();
        // Epic-4 bridge: `handle_request` now also takes the project registry +
        // per-connection agent/session tracking (for `switch_project`). The
        // generic tests use an empty registry + no agent/session; the
        // `switch_project`-specific tests call `handle_request` directly with a
        // populated registry.
        let registry = Arc::new(ProjectRegistry::new());
        let mut current_agent: Option<AgentId> = None;
        let current_session = Arc::new(parking_lot::Mutex::new(None::<SessionId>));
        let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
        let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(handle_request(
                text,
                authed,
                &acp,
                &relay,
                &registry,
                None,
                None,
                &tx,
                &mut subs,
                &mut current_agent,
                &current_session,
                &current_project,
                &switch_queue,
                HistoryMode::LiveOnly,
            None,
            ))
    }

    #[test]
    fn handle_request_pre_auth_rejects_non_authenticate() {
        let mut authed = false;
        let reply = handle_sync(
            r#"{"id":"r1","type":"send_prompt","payload":{}}"#,
            &mut authed,
        );
        assert!(!reply.ok);
        assert_eq!(reply.err.unwrap().code, "unauthorized");
        assert!(!authed, "pre-auth non-authenticate must not flip authed");
    }

    #[test]
    fn handle_request_authenticate_marks_authed() {
        let mut authed = false;
        let reply = handle_sync(
            r#"{"id":"r1","type":"authenticate","payload":{"token":"any"}}"#,
            &mut authed,
        );
        assert!(reply.ok);
        assert!(authed, "authenticate must flip authed");
    }

    #[test]
    fn handle_request_post_auth_os_cap_rejected_unsupported() {
        let mut authed = true;
        let reply = handle_sync(
            r#"{"id":"r1","type":"fs/read_text_file","payload":{}}"#,
            &mut authed,
        );
        assert!(!reply.ok);
        assert_eq!(reply.err.unwrap().code, "unsupported");
    }

    #[test]
    fn ping_request_replies_ok_post_auth() {
        // Heartbeat handler: a post-auth `ping` round-trips an ok reply so the
        // client's request promise resolves (no timeout). The keepalive value
        // is that the read loop stamps `last_activity` on the inbound text
        // frame before routing — that refresh happens regardless of the reply.
        let mut authed = true;
        let reply = handle_sync(r#"{"id":"r1","type":"ping","payload":{}}"#, &mut authed);
        assert!(reply.ok, "ping must round-trip an ok reply");
        assert_eq!(reply.id, "r1");
    }

    #[test]
    fn ping_request_pre_auth_rejected_unauthorized() {
        // A pre-auth `ping` is gated like every other non-`authenticate` type —
        // the heartbeat only refreshes the watchdog on an already-authed socket.
        let mut authed = false;
        let reply = handle_sync(r#"{"id":"r1","type":"ping","payload":{}}"#, &mut authed);
        assert!(!reply.ok);
        assert_eq!(reply.err.unwrap().code, "unauthorized");
    }

    #[test]
    fn watchdog_is_stale_only_past_pong_timeout() {
        // Pure threshold semantics for the keepalive watchdog: a connection is
        // torn down only after strictly more than PONG_TIMEOUT with no inbound
        // frame. Tests the decision the write task consults on each ping tick
        // (the false-positive symptom behind issue: a focused tab through a
        // proxy dropped every ~75s because Pongs didn't round-trip; a client
        // `ping` text frame refreshes this and stays open).
        let base = 1_000_000_u64;
        let timeout = PONG_TIMEOUT.as_millis() as u64;
        assert!(
            !watchdog_is_stale(base, base),
            "fresh connection is not stale"
        );
        assert!(
            !watchdog_is_stale(base, base + timeout),
            "exactly at timeout is not stale (strict >)"
        );
        assert!(
            !watchdog_is_stale(base, base + timeout - 1),
            "just under timeout is not stale"
        );
        assert!(
            watchdog_is_stale(base, base + timeout + 1),
            "just past timeout is stale"
        );
        // Clock-skew safe: a future `last_activity` saturates to 0 (not stale).
        assert!(!watchdog_is_stale(base + 10_000, base));
    }

    #[test]
    fn handle_request_post_auth_other_types_not_implemented() {
        let mut authed = true;
        // Story 1.7 wired `respond_permission`; Story 1.8 wired `send_prompt`,
        // `create_session`, `load_session`, `resume_session`, `close_session`,
        // `list_sessions`, `cancel_prompt`, `set_mode`, `set_model`,
        // `set_config_option`. The Epic-4 bridge now wires `switch_project` too
        // (a malformed `{}` payload → `unsupported`, covered separately). Only
        // truly unknown types stay `not_implemented`.
        let ty = "totally_unknown_type";
        let reply = handle_sync(
            &format!(r#"{{"id":"r1","type":"{ty}","payload":{{}}}}"#),
            &mut authed,
        );
        assert!(!reply.ok, "{ty} should be not_implemented");
        assert_eq!(reply.err.unwrap().code, "not_implemented", "{ty}");
    }

    /// Story 1.8: ACP command handlers are wired. With an empty payload
    /// they reject `unsupported` (malformed payload) — proving the match arm
    /// routes to the handler (not the `_ => not_implemented` stub).
    /// `list_agents` accepts `{}` and is covered separately.
    #[test]
    fn handle_request_post_auth_acp_commands_reject_malformed_payload() {
        let mut authed = true;
        for ty in [
            "send_prompt",
            "create_session",
            "load_session",
            "resume_session",
            "close_session",
            "list_sessions",
            "cancel_prompt",
            "set_mode",
            "set_model",
            "set_config_option",
            "spawn_agent",
            "kill_agent",
            "switch_project",
        ] {
            let reply = handle_sync(
                &format!(r#"{{"id":"r1","type":"{ty}","payload":{{}}}}"#),
                &mut authed,
            );
            assert!(!reply.ok, "{ty} should be rejected (malformed payload)");
            assert_eq!(
                reply.err.unwrap().code,
                "unsupported",
                "{ty} should route to its live handler (malformed-payload → unsupported, NOT not_implemented)"
            );
        }
    }

    /// Browser agent lifecycle: `list_agents` with empty payload returns `[]`
    /// (no-op manager has zero agents) — proves the arm is live.
    #[test]
    fn handle_list_agents_returns_empty_array() {
        let mut authed = true;
        let reply = handle_sync(
            r#"{"id":"r1","type":"list_agents","payload":{}}"#,
            &mut authed,
        );
        assert!(reply.ok, "list_agents should succeed");
        assert_eq!(reply.payload, Some(json!([])));
    }

    /// `spawn_agent` rejects empty `config.command` (mirrors create_session cwd guard).
    #[test]
    fn handle_spawn_agent_rejects_empty_command() {
        let mut authed = true;
        let reply = handle_sync(
            r#"{"id":"r1","type":"spawn_agent","payload":{"config":{"name":"x","command":""}}}"#,
            &mut authed,
        );
        assert!(!reply.ok);
        assert_eq!(reply.err.unwrap().code, "unsupported");
    }

    /// `spawn_agent` success path: `ok_with_payload` serializes the full
    /// `SpawnOutcome` (camelCase: `agentId`/`capabilities`/`authMethods`/
    /// `stableNamespace?`) — the same shape the desktop Tauri command returns,
    /// so the renderer sees one authoritative payload on both transports (CAP-4).
    #[test]
    fn spawn_outcome_serializes_full_payload_as_ws_reply() {
        let outcome = SpawnOutcome {
            agent_id: AgentId("agn_test".to_string()),
            capabilities: agent_client_protocol::schema::v1::AgentCapabilities::default(),
            auth_methods: vec![crate::acp::events::AuthMethodInfo {
                id: "cursor_login".to_string(),
                name: "Sign in with Cursor".to_string(),
                description: None,
            }],
            stable_namespace: Some("config:cursor".to_string()),
        };
        let reply = ok_with_payload("spawn-1".to_string(), &outcome);
        assert!(reply.ok);
        assert!(reply.err.is_none());
        let payload = reply.payload.expect("payload present on success");
        assert_eq!(payload["agentId"], "agn_test");
        assert!(payload.get("capabilities").is_some(), "capabilities always serialized");
        assert_eq!(payload["authMethods"][0]["id"], "cursor_login");
        assert_eq!(payload["authMethods"][0]["name"], "Sign in with Cursor");
        // `description` is `None` + skip_serializing_if → omitted from JSON.
        assert!(
            payload["authMethods"][0].get("description").is_none(),
            "description omitted when absent"
        );
        assert_eq!(payload["stableNamespace"], "config:cursor");
    }

    /// `spawn_agent` success with no auth + no namespace: `authMethods` is `[]`
    /// (always serialized) and `stableNamespace` is omitted (skip_if_none).
    #[test]
    fn spawn_outcome_serializes_no_auth_no_namespace() {
        let outcome = SpawnOutcome {
            agent_id: AgentId("agn_noauth".to_string()),
            capabilities: agent_client_protocol::schema::v1::AgentCapabilities::default(),
            auth_methods: vec![],
            stable_namespace: None,
        };
        let reply = ok_with_payload("spawn-2".to_string(), &outcome);
        assert!(reply.ok);
        let payload = reply.payload.expect("payload");
        assert_eq!(payload["agentId"], "agn_noauth");
        assert_eq!(payload["authMethods"], json!([]), "authMethods always serialized as []");
        assert!(
            payload.get("stableNamespace").is_none(),
            "stableNamespace omitted when None"
        );
    }

    /// Story 1.8 review (EC4): `create_session` rejects an empty/whitespace
    /// `cwd` (mirrors the desktop store's `cwd.trim()` guard — the WS path must
    /// not diverge).
    #[test]
    fn handle_create_session_rejects_empty_cwd() {
        let mut authed = true;
        let reply = handle_sync(
            r#"{"id":"r1","type":"create_session","payload":{"agentId":"a1","cwd":""}}"#,
            &mut authed,
        );
        assert!(!reply.ok);
        assert_eq!(reply.err.unwrap().code, "unsupported");

        let mut authed2 = true;
        let reply2 = handle_sync(
            r#"{"id":"r2","type":"create_session","payload":{"agentId":"a1","cwd":"   "}}"#,
            &mut authed2,
        );
        assert!(!reply2.ok);
        assert_eq!(reply2.err.unwrap().code, "unsupported");
    }

    /// Story 1.8 review (EC3): `send_prompt` rejects an empty/whitespace
    /// `text` (the desktop `commands.rs` has the same guard; without it an
    /// empty-text turn leaks past the `content.is_empty()` check + poisons the
    /// turn-id watermark).
    #[test]
    fn handle_send_prompt_rejects_empty_text() {
        let mut authed = true;
        let reply = handle_sync(
            r#"{"id":"r1","type":"send_prompt","payload":{"agentId":"a1","sessionId":"s1","text":""}}"#,
            &mut authed,
        );
        assert!(!reply.ok);
        assert_eq!(reply.err.unwrap().code, "unsupported");

        let mut authed2 = true;
        let reply2 = handle_sync(
            r#"{"id":"r2","type":"send_prompt","payload":{"agentId":"a1","sessionId":"s1","text":"   "}}"#,
            &mut authed2,
        );
        assert!(!reply2.ok);
        assert_eq!(reply2.err.unwrap().code, "unsupported");
    }

    /// Story 1.8 review: `acp_err_to_reply` maps recognizable agent errors to
    /// the right `err.code` (not_implemented is the fallback for unrecognized
    /// errors; "unknown agent" → not_found; capability-gate → unsupported).
    #[test]
    fn acp_err_to_reply_maps_recognizable_errors() {
        // ACP_TURN_IN_PROGRESS → rate_limited (via map_prompt_error_code).
        let r = acp_err_to_reply(
            "r1".to_string(),
            "ACP_TURN_IN_PROGRESS: session s1".to_string(),
        );
        assert_eq!(r.err.unwrap().code, "rate_limited");
        // Unknown agent → not_found.
        let r = acp_err_to_reply("r2".to_string(), "unknown agent: a1".to_string());
        assert_eq!(r.err.unwrap().code, "not_found");
        // Capability gate → unsupported.
        let r = acp_err_to_reply(
            "r3".to_string(),
            "agent does not support session/load (loadSession capability)".to_string(),
        );
        assert_eq!(r.err.unwrap().code, "unsupported");
        // Unrecognized → not_implemented (fallback, message preserved).
        let r = acp_err_to_reply(
            "r4".to_string(),
            "agent initialize failed: boom".to_string(),
        );
        assert_eq!(r.err.unwrap().code, "not_implemented");
    }

    /// Story 1.7: without a rendezvous attached (desktop path), the
    /// `respond_permission` handler replies `not_implemented` (the desktop uses
    /// the `acp_respond_permission` Tauri command directly). This guards the
    /// `relay.rendezvous() == None` branch.
    #[test]
    fn handle_respond_permission_without_rendezvous_is_not_implemented() {
        let mut authed = true;
        let reply = handle_sync(
            r#"{"id":"r1","type":"respond_permission","payload":{"agentId":"a1","requestId":"perm-x"}}"#,
            &mut authed,
        );
        assert!(!reply.ok);
        assert_eq!(reply.err.unwrap().code, "not_implemented");
    }

    /// Story 1.7: a malformed `respond_permission` payload is rejected with
    /// `unsupported` (mirrors `handle_subscribe`'s malformed-payload reply).
    #[test]
    fn handle_respond_permission_malformed_payload_is_unsupported() {
        // Attach a rendezvous so we reach the payload-parse branch.
        let relay = Arc::new(WsRelaySink::new());
        let acp = Arc::new(AcpManager::new(vec![]));
        relay.set_rendezvous(Arc::new(
            crate::web::permissions::PermissionRendezvous::default(),
        ));
        let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
        let mut subs = Vec::new();
        let mut authed = true;
        let registry = Arc::new(ProjectRegistry::new());
        let mut current_agent: Option<crate::acp::AgentId> = None;
        let current_session = Arc::new(parking_lot::Mutex::new(None::<crate::acp::SessionId>));
        let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
        let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
        let reply = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(handle_request(
                r#"{"id":"r1","type":"respond_permission","payload":{"agentId":"a1"}}"#,
                &mut authed,
                &acp,
                &relay,
                &registry,
                None,
                None,
                &tx,
                &mut subs,
                &mut current_agent,
                &current_session,
                &current_project,
                &switch_queue,
                HistoryMode::LiveOnly,
            None,
            ));
        assert!(!reply.ok);
        assert_eq!(reply.err.unwrap().code, "unsupported");
    }

    /// Helper: build a relay + rendezvous, subscribe a connection to a session
    /// (populating `subscribed_clients`), and register a permission ticket via
    /// `emit` (the production path). Returns the (relay, subs) ready for a
    /// `handle_request` call.
    fn relay_with_subscribed_permission(
        agent_id: &str,
        session_id: &str,
        request_id: &str,
        options: &[&str],
    ) -> (Arc<WsRelaySink>, Vec<(String, ClientId)>) {
        use crate::web::sink::{AcpEvent, EventSink};
        let relay = Arc::new(WsRelaySink::new());
        relay.set_rendezvous(Arc::new(
            crate::web::permissions::PermissionRendezvous::default(),
        ));
        // Subscribe a client to the session (populates subscribed_clients via
        // the production subscribe path).
        let (client_id, _rx, _replay) = block_on(relay.subscribe(session_id, None));
        let subs: Vec<(String, ClientId)> = vec![(session_id.to_string(), client_id)];
        // Emit a permission_request event through the sink (production path) so
        // the rendezvous snapshots a ticket.
        let options_value = serde_json::Value::Array(
            options
                .iter()
                .map(|id| serde_json::json!({ "optionId": id, "name": id, "kind": "auto" }))
                .collect(),
        );
        relay.emit(&AcpEvent {
            sid: Some(session_id.to_string()),
            type_: "acp:permission_request",
            payload: serde_json::json!({
                "agentId": agent_id,
                "sessionId": session_id,
                "requestId": request_id,
                "toolCall": { "toolCallId": "tc-1" },
                "options": options_value,
            }),
        });
        (relay, subs)
    }

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(future)
    }

    /// Story 1.7 (verification gap #1): a `respond_permission` frame whose
    /// `agentId` differs from the ticket's agent is rejected `permission_denied`
    /// (defense-in-depth — a client cannot resolve another agent's permission).
    #[test]
    fn handle_respond_permission_wrong_agent_is_permission_denied() {
        let (relay, subs) = relay_with_subscribed_permission("a1", "sess-1", "perm-1", &["allow"]);
        let acp = Arc::new(AcpManager::new(vec![]));
        let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
        let mut authed = true;
        let registry = Arc::new(ProjectRegistry::new());
        let mut current_agent: Option<crate::acp::AgentId> = None;
        let current_session = Arc::new(parking_lot::Mutex::new(None::<crate::acp::SessionId>));
        let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
        let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
        let reply = block_on(handle_request(
            r#"{"id":"r1","type":"respond_permission","payload":{"agentId":"a2","requestId":"perm-1","optionId":"allow"}}"#,
            &mut authed,
            &acp,
            &relay,
            &registry,
            None,
            None,
            &tx,
            &mut subs.clone(),
            &mut current_agent,
            &current_session,
            &current_project,
            &switch_queue,
            HistoryMode::LiveOnly,
        None,
        ));
        assert!(!reply.ok);
        assert_eq!(reply.err.unwrap().code, "permission_denied");
    }

    /// Story 1.7 (verification gap #2): a connection NOT subscribed to the
    /// permission's session is rejected `not_found` (NFR5 ownership check — no
    /// cross-session permission resolution; the code does not leak existence).
    #[test]
    fn handle_respond_permission_not_subscribed_is_not_found() {
        // Register a permission on sess-A but subscribe the connection to sess-B.
        use crate::web::sink::{AcpEvent, EventSink};
        let relay = Arc::new(WsRelaySink::new());
        let acp = Arc::new(AcpManager::new(vec![]));
        relay.set_rendezvous(Arc::new(
            crate::web::permissions::PermissionRendezvous::default(),
        ));
        let (_other_client, _rx, _replay) = block_on(relay.subscribe("sess-B", None));
        let subs: Vec<(String, ClientId)> = vec![("sess-B".to_string(), ClientId::new())];
        relay.emit(&AcpEvent {
            sid: Some("sess-A".to_string()),
            type_: "acp:permission_request",
            payload: serde_json::json!({
                "agentId": "a1", "sessionId": "sess-A", "requestId": "perm-A",
                "toolCall": { "toolCallId": "tc-1" }, "options": [{ "optionId": "allow" }]
            }),
        });
        let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
        let mut authed = true;
        let registry = Arc::new(ProjectRegistry::new());
        let mut current_agent: Option<crate::acp::AgentId> = None;
        let current_session = Arc::new(parking_lot::Mutex::new(None::<crate::acp::SessionId>));
        let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
        let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
        let reply = block_on(handle_request(
            r#"{"id":"r1","type":"respond_permission","payload":{"agentId":"a1","requestId":"perm-A","optionId":"allow"}}"#,
            &mut authed,
            &acp,
            &relay,
            &registry,
            None,
            None,
            &tx,
            &mut subs.clone(),
            &mut current_agent,
            &current_session,
            &current_project,
            &switch_queue,
            HistoryMode::LiveOnly,
        None,
        ));
        assert!(!reply.ok);
        assert_eq!(reply.err.unwrap().code, "not_found");
    }

    /// Story 1.7 (verification gap #4 + happy path): a valid `respond_permission`
    /// from a subscribed connection resolves the ticket (ok); a second frame for
    /// the same requestId is rejected `stale` (handler-level first-response-wins,
    /// exercising the handler's `subscribed_clients` ClientId resolution).
    #[test]
    fn handle_respond_permission_resolves_then_second_is_stale() {
        let (relay, subs) = relay_with_subscribed_permission("a1", "sess-1", "perm-1", &["allow"]);
        let acp = Arc::new(AcpManager::new(vec![]));
        let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
        let mut authed = true;
        let registry = Arc::new(ProjectRegistry::new());
        let mut current_agent: Option<crate::acp::AgentId> = None;
        let current_session = Arc::new(parking_lot::Mutex::new(None::<crate::acp::SessionId>));
        let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
        let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
        let ok_reply = block_on(handle_request(
            r#"{"id":"r1","type":"respond_permission","payload":{"agentId":"a1","requestId":"perm-1","optionId":"allow"}}"#,
            &mut authed,
            &acp,
            &relay,
            &registry,
            None,
            None,
            &tx,
            &mut subs.clone(),
            &mut current_agent,
            &current_session,
            &current_project,
            &switch_queue,
            HistoryMode::LiveOnly,
        None,
        ));
        assert!(ok_reply.ok, "first response wins: {:?}", ok_reply.err);
        // Second frame for the same requestId → stale (ticket evicted).
        let stale_reply = block_on(handle_request(
            r#"{"id":"r2","type":"respond_permission","payload":{"agentId":"a1","requestId":"perm-1","optionId":"allow"}}"#,
            &mut authed,
            &acp,
            &relay,
            &registry,
            None,
            None,
            &tx,
            &mut subs.clone(),
            &mut current_agent,
            &current_session,
            &current_project,
            &switch_queue,
            HistoryMode::LiveOnly,
        None,
        ));
        assert!(!stale_reply.ok);
        assert_eq!(stale_reply.err.unwrap().code, "stale");
    }

    /// Story 1.7 (verification gap: TOCTOU through the handler): an `optionId`
    /// not in the original options is rejected `permission_denied` end-to-end.
    #[test]
    fn handle_respond_permission_invalid_option_is_permission_denied() {
        let (relay, subs) =
            relay_with_subscribed_permission("a1", "sess-1", "perm-1", &["allow", "deny"]);
        let acp = Arc::new(AcpManager::new(vec![]));
        let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
        let mut authed = true;
        let registry = Arc::new(ProjectRegistry::new());
        let mut current_agent: Option<crate::acp::AgentId> = None;
        let current_session = Arc::new(parking_lot::Mutex::new(None::<crate::acp::SessionId>));
        let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
        let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
        let reply = block_on(handle_request(
            r#"{"id":"r1","type":"respond_permission","payload":{"agentId":"a1","requestId":"perm-1","optionId":"escalate"}}"#,
            &mut authed,
            &acp,
            &relay,
            &registry,
            None,
            None,
            &tx,
            &mut subs.clone(),
            &mut current_agent,
            &current_session,
            &current_project,
            &switch_queue,
            HistoryMode::LiveOnly,
        None,
        ));
        assert!(!reply.ok);
        assert_eq!(reply.err.unwrap().code, "permission_denied");
    }

    /// Helper (issue #411): build a relay + question rendezvous, subscribe a
    /// connection to a session, and register a question ticket via `emit` (the
    /// production path). Returns the (relay, subs) ready for a `handle_request`
    /// call.
    fn relay_with_subscribed_question(
        agent_id: &str,
        session_id: &str,
        question_id: &str,
        options: &[&str],
    ) -> (Arc<WsRelaySink>, Vec<(String, ClientId)>) {
        use crate::web::sink::{AcpEvent, EventSink};
        let relay = Arc::new(WsRelaySink::new());
        relay.set_question_rendezvous(Arc::new(
            crate::web::permissions::QuestionRendezvous::default(),
        ));
        let (client_id, _rx, _replay) = block_on(relay.subscribe(session_id, None));
        let subs: Vec<(String, ClientId)> = vec![(session_id.to_string(), client_id)];
        let options_value = serde_json::Value::Array(
            options
                .iter()
                .map(|v| serde_json::json!({ "value": v, "label": v }))
                .collect(),
        );
        relay.emit(&AcpEvent {
            sid: Some(session_id.to_string()),
            type_: "acp:question_request",
            payload: serde_json::json!({
                "agentId": agent_id,
                "sessionId": session_id,
                "questionId": question_id,
                "question": "Which approach?",
                "options": options_value,
            }),
        });
        (relay, subs)
    }

    /// Issue #411: without a question rendezvous attached (desktop path), the
    /// `answer_question` handler replies `not_implemented`.
    #[test]
    fn handle_answer_question_without_rendezvous_is_not_implemented() {
        let mut authed = true;
        let reply = handle_sync(
            r#"{"id":"r1","type":"answer_question","payload":{"agentId":"a1","questionId":"q-x"}}"#,
            &mut authed,
        );
        assert!(!reply.ok);
        assert_eq!(reply.err.unwrap().code, "not_implemented");
    }

    /// Issue #411: a malformed `answer_question` payload is rejected with
    /// `unsupported`.
    #[test]
    fn handle_answer_question_malformed_payload_is_unsupported() {
        let relay = Arc::new(WsRelaySink::new());
        relay.set_question_rendezvous(Arc::new(
            crate::web::permissions::QuestionRendezvous::default(),
        ));
        let acp = Arc::new(AcpManager::new(vec![]));
        let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
        let mut authed = true;
        let registry = Arc::new(ProjectRegistry::new());
        let mut current_agent: Option<crate::acp::AgentId> = None;
        let current_session = Arc::new(parking_lot::Mutex::new(None::<crate::acp::SessionId>));
        let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
        let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
        let mut subs = Vec::new();
        let reply = block_on(handle_request(
            r#"{"id":"r1","type":"answer_question","payload":{"agentId":"a1"}}"#,
            &mut authed,
            &acp,
            &relay,
            &registry,
            None,
            None,
            &tx,
            &mut subs,
            &mut current_agent,
            &current_session,
            &current_project,
            &switch_queue,
            HistoryMode::LiveOnly,
        None,
        ));
        assert!(!reply.ok);
        assert_eq!(reply.err.unwrap().code, "unsupported");
    }

    /// Issue #411: an `answer_question` whose `agentId` differs from the
    /// ticket's agent is rejected `permission_denied` (defense-in-depth).
    #[test]
    fn handle_answer_question_wrong_agent_is_permission_denied() {
        let (relay, subs) = relay_with_subscribed_question("a1", "sess-1", "q-1", &["plan-a"]);
        let acp = Arc::new(AcpManager::new(vec![]));
        let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
        let mut authed = true;
        let registry = Arc::new(ProjectRegistry::new());
        let mut current_agent: Option<crate::acp::AgentId> = None;
        let current_session = Arc::new(parking_lot::Mutex::new(None::<crate::acp::SessionId>));
        let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
        let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
        let reply = block_on(handle_request(
            r#"{"id":"r1","type":"answer_question","payload":{"agentId":"a2","questionId":"q-1","values":["plan-a"]}}"#,
            &mut authed,
            &acp,
            &relay,
            &registry,
            None,
            None,
            &tx,
            &mut subs.clone(),
            &mut current_agent,
            &current_session,
            &current_project,
            &switch_queue,
            HistoryMode::LiveOnly,
        None,
        ));
        assert!(!reply.ok);
        assert_eq!(reply.err.unwrap().code, "permission_denied");
    }

    /// Issue #411: a connection NOT subscribed to the question's session is
    /// rejected `not_found` (NFR5 ownership check).
    #[test]
    fn handle_answer_question_not_subscribed_is_not_found() {
        use crate::web::sink::{AcpEvent, EventSink};
        let relay = Arc::new(WsRelaySink::new());
        let acp = Arc::new(AcpManager::new(vec![]));
        relay.set_question_rendezvous(Arc::new(
            crate::web::permissions::QuestionRendezvous::default(),
        ));
        let (_other_client, _rx, _replay) = block_on(relay.subscribe("sess-B", None));
        let subs: Vec<(String, ClientId)> = vec![("sess-B".to_string(), ClientId::new())];
        relay.emit(&AcpEvent {
            sid: Some("sess-A".to_string()),
            type_: "acp:question_request",
            payload: serde_json::json!({
                "agentId": "a1", "sessionId": "sess-A", "questionId": "q-A",
                "question": "Q", "options": [{ "value": "plan-a", "label": "Plan A" }]
            }),
        });
        let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
        let mut authed = true;
        let registry = Arc::new(ProjectRegistry::new());
        let mut current_agent: Option<crate::acp::AgentId> = None;
        let current_session = Arc::new(parking_lot::Mutex::new(None::<crate::acp::SessionId>));
        let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
        let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
        let reply = block_on(handle_request(
            r#"{"id":"r1","type":"answer_question","payload":{"agentId":"a1","questionId":"q-A","values":["plan-a"]}}"#,
            &mut authed,
            &acp,
            &relay,
            &registry,
            None,
            None,
            &tx,
            &mut subs.clone(),
            &mut current_agent,
            &current_session,
            &current_project,
            &switch_queue,
            HistoryMode::LiveOnly,
        None,
        ));
        assert!(!reply.ok);
        assert_eq!(reply.err.unwrap().code, "not_found");
    }

    /// Issue #411: a valid `answer_question` from a subscribed connection
    /// resolves the ticket (ok); a second frame for the same questionId is
    /// rejected `stale` (handler-level first-response-wins).
    #[test]
    fn handle_answer_question_resolves_then_second_is_stale() {
        let (relay, subs) = relay_with_subscribed_question("a1", "sess-1", "q-1", &["plan-a"]);
        let acp = Arc::new(AcpManager::new(vec![]));
        let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
        let mut authed = true;
        let registry = Arc::new(ProjectRegistry::new());
        let mut current_agent: Option<crate::acp::AgentId> = None;
        let current_session = Arc::new(parking_lot::Mutex::new(None::<crate::acp::SessionId>));
        let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
        let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
        let ok_reply = block_on(handle_request(
            r#"{"id":"r1","type":"answer_question","payload":{"agentId":"a1","questionId":"q-1","values":["plan-a"]}}"#,
            &mut authed,
            &acp,
            &relay,
            &registry,
            None,
            None,
            &tx,
            &mut subs.clone(),
            &mut current_agent,
            &current_session,
            &current_project,
            &switch_queue,
            HistoryMode::LiveOnly,
        None,
        ));
        assert!(ok_reply.ok, "first answer wins: {:?}", ok_reply.err);
        let stale_reply = block_on(handle_request(
            r#"{"id":"r2","type":"answer_question","payload":{"agentId":"a1","questionId":"q-1","values":["plan-a"]}}"#,
            &mut authed,
            &acp,
            &relay,
            &registry,
            None,
            None,
            &tx,
            &mut subs.clone(),
            &mut current_agent,
            &current_session,
            &current_project,
            &switch_queue,
            HistoryMode::LiveOnly,
        None,
        ));
        assert!(!stale_reply.ok);
        assert_eq!(stale_reply.err.unwrap().code, "stale");
    }

    /// Issue #411: an option value not in the original options is rejected
    /// `permission_denied` end-to-end (TOCTOU through the handler).
    #[test]
    fn handle_answer_question_invalid_option_is_permission_denied() {
        let (relay, subs) = relay_with_subscribed_question("a1", "sess-1", "q-1", &["plan-a"]);
        let acp = Arc::new(AcpManager::new(vec![]));
        let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
        let mut authed = true;
        let registry = Arc::new(ProjectRegistry::new());
        let mut current_agent: Option<crate::acp::AgentId> = None;
        let current_session = Arc::new(parking_lot::Mutex::new(None::<crate::acp::SessionId>));
        let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
        let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
        let reply = block_on(handle_request(
            r#"{"id":"r1","type":"answer_question","payload":{"agentId":"a1","questionId":"q-1","values":["escalate"]}}"#,
            &mut authed,
            &acp,
            &relay,
            &registry,
            None,
            None,
            &tx,
            &mut subs.clone(),
            &mut current_agent,
            &current_session,
            &current_project,
            &switch_queue,
            HistoryMode::LiveOnly,
        None,
        ));
        assert!(!reply.ok);
        assert_eq!(reply.err.unwrap().code, "permission_denied");
    }

    #[test]
    fn handle_request_malformed_frame_replies_unsupported() {
        let mut authed = false;
        let reply = handle_sync("not-json", &mut authed);
        assert!(!reply.ok);
        assert_eq!(reply.err.unwrap().code, "unsupported");
    }

    #[test]
    fn handle_subscribe_ok_and_stale() {
        let relay = Arc::new(WsRelaySink::with_capacity(2, 8));
        let acp = Arc::new(AcpManager::new(vec![]));
        // Fill log so last_seq=0 becomes stale after eviction… actually capacity 2
        // means after 3 emits base advances. Use subscribe with huge last_seq gap.
        use crate::web::sink::{AcpEvent, EventSink};
        for i in 1..=3 {
            relay.emit(&AcpEvent {
                sid: Some("s1".to_string()),
                type_: "acp:message_chunk",
                payload: json!({"i": i}),
            });
        }
        // Evicted seq 1; last_seq=0 → next wanted 1 < base → Stale
        let (tx, mut rx) = mpsc::unbounded_channel::<Outbound>();
        let mut subs = Vec::new();
        let mut authed = true;
        let registry = Arc::new(ProjectRegistry::new());
        let mut current_agent: Option<crate::acp::AgentId> = None;
        let current_session = Arc::new(parking_lot::Mutex::new(None::<crate::acp::SessionId>));
        let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
        let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
        let reply = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(handle_request(
                r#"{"id":"sub1","type":"subscribe","payload":{"sessionId":"s1","lastSeq":0}}"#,
                &mut authed,
                &acp,
                &relay,
                &registry,
                None,
                None,
                &tx,
                &mut subs,
                &mut current_agent,
                &current_session,
                &current_project,
                &switch_queue,
                HistoryMode::LiveOnly,
            None,
            ));
        assert!(!reply.ok);
        assert_eq!(reply.err.unwrap().code, "stale");

        // Fresh session live-only subscribe (omit lastSeq) succeeds.
        let mut subs2 = Vec::new();
        let reply_ok = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(handle_request(
                r#"{"id":"sub2","type":"subscribe","payload":{"sessionId":"fresh"}}"#,
                &mut authed,
                &acp,
                &relay,
                &registry,
                None,
                None,
                &tx,
                &mut subs2,
                &mut current_agent,
                &current_session,
                &current_project,
                &switch_queue,
                HistoryMode::LiveOnly,
            None,
            ));
        assert!(reply_ok.ok, "{:?}", reply_ok.err);
        assert_eq!(subs2.len(), 1);

        // Re-subscribe same session replaces prior ClientId (no leak).
        let reply_resub = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(handle_request(
                r#"{"id":"sub3","type":"subscribe","payload":{"sessionId":"fresh"}}"#,
                &mut authed,
                &acp,
                &relay,
                &registry,
                None,
                None,
                &tx,
                &mut subs2,
                &mut current_agent,
                &current_session,
                &current_project,
                &switch_queue,
                HistoryMode::LiveOnly,
            None,
            ));
        assert!(reply_resub.ok, "{:?}", reply_resub.err);
        assert_eq!(subs2.len(), 1);

        // Evicted log + omit lastSeq → live-only succeeds (not stale).
        let mut subs3 = Vec::new();
        let reply_live = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(handle_request(
                r#"{"id":"sub4","type":"subscribe","payload":{"sessionId":"s1"}}"#,
                &mut authed,
                &acp,
                &relay,
                &registry,
                None,
                None,
                &tx,
                &mut subs3,
                &mut current_agent,
                &current_session,
                &current_project,
                &switch_queue,
                HistoryMode::LiveOnly,
            None,
            ));
        assert!(reply_live.ok, "{:?}", reply_live.err);

        // Drain any replay/live.
        while rx.try_recv().is_ok() {}
    }

    /// Epic-4 bridge: a cold web tab (no agent spawned / session created yet)
    /// sends `switch_project` → deferred `Selected` (Ask-First resolution:
    /// do NOT auto-spawn). Per-connection `current_project` is updated; the
    /// host default is NOT touched (no `registry.set_default_project`, no
    /// `broadcast_projects_changed`, no persistence — a per-client switch is
    /// ephemeral). No agent/session is created — the web client spawns the
    /// agent lazily when a chat starts.
    #[test]
    fn handle_switch_project_cold_tab_is_deferred_select() {
        let relay = Arc::new(WsRelaySink::new());
        let acp = Arc::new(AcpManager::new(vec![]));
        let registry = Arc::new(ProjectRegistry::new());
        registry.set(
            vec![crate::web::project_registry::ProjectSummary {
                id: "p-1".to_string(),
                name: "Proj p-1".to_string(),
                color: "blue".to_string(),
                path: Some("/a".to_string()),
                is_archived: false,
                is_default: false,
            }],
            None,
        );
        let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
        let mut subs = Vec::new();
        let mut authed = true;
        let mut current_agent: Option<crate::acp::AgentId> = None;
        let current_session = Arc::new(parking_lot::Mutex::new(None::<crate::acp::SessionId>));
        let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
        let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
        let reply = block_on(handle_request(
            r#"{"id":"r1","type":"switch_project","payload":{"projectId":"p-1"}}"#,
            &mut authed,
            &acp,
            &relay,
            &registry,
            None,
            None,
            &tx,
            &mut subs,
            &mut current_agent,
            &current_session,
            &current_project,
            &switch_queue,
            HistoryMode::LiveOnly,
        None,
        ));
        assert!(reply.ok, "{:?}", reply.err);
        let payload = reply.payload.expect("selected payload");
        assert_eq!(payload["status"], "selected");
        assert_eq!(payload["projectId"], "p-1");
        assert_eq!(payload["cwd"], "/a");
        // Cold tab: no session was created.
        assert!(current_session.lock().is_none());
        // Per-connection tracking reflects the switch.
        let cp = current_project.lock().clone();
        assert_eq!(cp.as_deref(), Some("p-1"));
        // The host default is UNCHANGED (per-connection switch — Epic 7).
        let snap = registry.snapshot();
        assert_eq!(snap.default_project_id, None);
    }

    /// Cold-tab `switch_project` with an unknown/archived/pathless `projectId`
    /// → `NOT_FOUND` (the registry lookup is hoisted above the agent check, so
    /// a cold tab gets the same `not_found` as the live-agent path).
    #[test]
    fn handle_switch_project_cold_tab_unknown_id_is_not_found() {
        let relay = Arc::new(WsRelaySink::new());
        let acp = Arc::new(AcpManager::new(vec![]));
        let registry = Arc::new(ProjectRegistry::new());
        registry.set(
            vec![crate::web::project_registry::ProjectSummary {
                id: "p-1".to_string(),
                name: "Proj p-1".to_string(),
                color: "blue".to_string(),
                path: Some("/a".to_string()),
                is_archived: false,
                is_default: true,
            }],
            Some("p-1".to_string()),
        );
        let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
        let mut subs = Vec::new();
        let mut authed = true;
        let mut current_agent: Option<crate::acp::AgentId> = None;
        let current_session = Arc::new(parking_lot::Mutex::new(None::<crate::acp::SessionId>));
        let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
        let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
        let reply = block_on(handle_request(
            r#"{"id":"r1","type":"switch_project","payload":{"projectId":"missing"}}"#,
            &mut authed,
            &acp,
            &relay,
            &registry,
            None,
            None,
            &tx,
            &mut subs,
            &mut current_agent,
            &current_session,
            &current_project,
            &switch_queue,
            HistoryMode::LiveOnly,
        None,
        ));
        assert!(!reply.ok);
        assert_eq!(reply.err.unwrap().code, "not_found");
    }

    /// Cold-tab `switch_project` is per-connection (Epic 7): it updates only
    /// the requester's `current_project`. It does NOT persist to the
    /// `--projects-file` (only `set_default_project` writes the durable
    /// default) and does NOT broadcast `projects_changed`.
    #[test]
    fn execute_cold_tab_select_is_per_connection_no_persistence_no_broadcast() {
        // A relay is wired (VPS-mode fixture) but the cold-tab switch must NOT
        // touch it (no broadcast). Prefix `_` so the unused binding documents
        // the intent without failing the build.
        let _relay = Arc::new(WsRelaySink::new());
        let registry = Arc::new(ProjectRegistry::new());
        registry.set(
            vec![crate::web::project_registry::ProjectSummary {
                id: "p-1".to_string(),
                name: "Proj p-1".to_string(),
                color: "blue".to_string(),
                path: Some("/a".to_string()),
                is_archived: false,
                is_default: false,
            }],
            None,
        );
        // A file registry + path are wired (VPS-mode fixtures), but the
        // cold-tab switch must NOT touch them.
        let file_registry = FileProjectRegistry::from_roots(
            vec![crate::acp::VfsRoot {
                id: "p-1".to_string(),
                name: "Proj p-1".to_string(),
                path: PathBuf::from("/a"),
                color: "blue".to_string(),
                is_archived: false,
                mcp_servers: vec![],
            }],
            None,
        );
        let file_registry = Arc::new(parking_lot::Mutex::new(file_registry));
        let path = std::env::temp_dir().join(format!(
            "termul-ws-cold-tab-noperist-{}.json",
            std::process::id()
        ));
        let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
        let target = ProjectSwitchContext {
            project_id: "p-1".to_string(),
            cwd: "/a".to_string(),
            mcp_servers: vec![],
        };
        let result = execute_cold_tab_select(target, &current_project);
        // Capture whether a file was written (it must NOT be).
        let leaked = std::fs::read_to_string(&path).ok();
        let _ = std::fs::remove_file(&path);
        let outcome = result.expect("cold-tab select succeeds");
        let SwitchProjectOutcome::Selected { project_id, cwd } = outcome else {
            panic!("expected Selected, got {:?}", outcome);
        };
        assert_eq!(project_id, "p-1");
        assert_eq!(cwd, "/a");
        // Per-connection tracking reflects the switch.
        let cp = current_project.lock().clone();
        assert_eq!(cp.as_deref(), Some("p-1"));
        // The host default is UNCHANGED (per-connection switch).
        assert_eq!(registry.snapshot().default_project_id, None);
        // The file registry is UNCHANGED (no persistence on switch).
        assert_eq!(file_registry.lock().default_project_id(), None);
        // No file was written to disk.
        assert!(leaked.is_none(), "switch must not write the projects file");
    }

    /// `switch_project` with a live agent but an unknown `projectId` →
    /// `NOT_FOUND` (registry lookup happens BEFORE `new_session`, so the no-op
    /// AcpManager never creates a session).
    #[test]
    fn handle_switch_project_unknown_id_is_not_found() {
        let relay = Arc::new(WsRelaySink::new());
        let acp = Arc::new(AcpManager::new(vec![]));
        let registry = Arc::new(ProjectRegistry::new());
        // A known project so the registry is non-empty; "missing" is absent.
        registry.set(
            vec![crate::web::project_registry::ProjectSummary {
                id: "p-1".to_string(),
                name: "Proj p-1".to_string(),
                color: "blue".to_string(),
                path: Some("/a".to_string()),
                is_archived: false,
                is_default: true,
            }],
            Some("p-1".to_string()),
        );
        let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
        let mut subs = Vec::new();
        let mut authed = true;
        let mut current_agent: Option<crate::acp::AgentId> = Some(crate::acp::AgentId::new());
        let current_session = Arc::new(parking_lot::Mutex::new(None::<crate::acp::SessionId>));
        let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
        let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
        let reply = block_on(handle_request(
            r#"{"id":"r1","type":"switch_project","payload":{"projectId":"missing"}}"#,
            &mut authed,
            &acp,
            &relay,
            &registry,
            None,
            None,
            &tx,
            &mut subs,
            &mut current_agent,
            &current_session,
            &current_project,
            &switch_queue,
            HistoryMode::LiveOnly,
        None,
        ));
        assert!(!reply.ok);
        assert_eq!(reply.err.unwrap().code, "not_found");
    }

    /// Host-owned history (CAP-2): `list_persisted_sessions` serves the
    /// host `SessionPersistence` index — the same seam on desktop shared-live
    /// and standalone.
    #[tokio::test]
    async fn list_persisted_sessions_serves_host_persistence() {
        let root = std::env::temp_dir().join(format!("termul-ws-list-{}", uuid::Uuid::new_v4()));
        let cwd = root.join("cwd");
        std::fs::create_dir_all(&cwd).unwrap();
        let persistence = crate::acp::SessionPersistence::open(root.join("sessions"))
            .await
            .unwrap();
        persistence
            .register_session(crate::acp::SessionRegistration {
                session_id: "s-1".to_string(),
                stable_agent_namespace: Some("config:claude".to_string()),
                runtime_agent_id: Some("agent-1".to_string()),
                project_id: Some("p-1".to_string()),
                cwd,
            })
            .await
            .unwrap();
        let relay = Arc::new(WsRelaySink::with_persistence(8, persistence.clone()));
        let reply =
            handle_list_persisted_sessions("r1".to_string(), &relay, HistoryMode::Server).await;
        assert!(reply.ok);
        let value = serde_json::to_value(&reply).unwrap();
        assert_eq!(value["payload"][0]["sessionId"], "s-1");
        persistence.shutdown().await.unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn get_session_payload_unsupported_in_live_only() {
        let relay = Arc::new(WsRelaySink::new());
        let reply = handle_get_session_payload(
            "r1".to_string(),
            &json!({ "sessionId": "s-1" }),
            &relay,
            HistoryMode::LiveOnly,
        )
        .await;
        assert!(!reply.ok);
        assert_eq!(reply.err.unwrap().code, "unsupported");
    }

    fn standalone_payload_record(
        session_id: &str,
        seq: u64,
        type_: &str,
        payload: Value,
    ) -> crate::acp::PersistedEventRecord {
        crate::acp::PersistedEventRecord {
            schema_version: crate::acp::session_persistence::SESSION_SCHEMA_VERSION,
            session_id: session_id.to_string(),
            seq,
            type_: type_.to_string(),
            recorded_at: 2_000 + seq,
            payload,
        }
    }

    #[tokio::test]
    async fn get_session_payload_materializes_standalone_durable_history() {
        let root =
            std::env::temp_dir().join(format!("termul-ws-payload-{}", uuid::Uuid::new_v4()));
        let cwd = root.join("cwd");
        std::fs::create_dir_all(&cwd).unwrap();
        let persistence = crate::acp::SessionPersistence::open(root.join("sessions"))
            .await
            .unwrap();
        persistence
            .register_session(crate::acp::SessionRegistration {
                session_id: "session-p".to_string(),
                stable_agent_namespace: Some("config:claude".to_string()),
                runtime_agent_id: Some("runtime-p".to_string()),
                project_id: Some("p-1".to_string()),
                cwd,
            })
            .await
            .unwrap();
        // Turn with a tool boundary mid-stream: user bubble + two agent runs.
        for record in [
            standalone_payload_record(
                "session-p",
                1,
                "user_prompt",
                json!({
                    "agentId": "runtime-p",
                    "sessionId": "session-p",
                    "turnId": "turn-1",
                    "content": [{"type": "text", "text": "hello"}],
                }),
            ),
            standalone_payload_record(
                "session-p",
                2,
                "message_chunk",
                json!({
                    "agentId": "runtime-p",
                    "sessionId": "session-p",
                    "role": "agent",
                    "content": {"type": "text", "text": "wor"},
                }),
            ),
            standalone_payload_record(
                "session-p",
                3,
                "tool_call",
                json!({
                    "agentId": "runtime-p",
                    "sessionId": "session-p",
                    "toolCall": {"toolCallId": "t-1", "kind": "execute", "status": "completed"},
                }),
            ),
            standalone_payload_record(
                "session-p",
                4,
                "message_chunk",
                json!({
                    "agentId": "runtime-p",
                    "sessionId": "session-p",
                    "role": "agent",
                    "content": {"type": "text", "text": "ld"},
                }),
            ),
            standalone_payload_record(
                "session-p",
                5,
                "prompt_complete",
                json!({"sessionId": "session-p", "turnId": "turn-1", "stopReason": "end_turn"}),
            ),
        ] {
            persistence.enqueue_event(record).unwrap();
        }
        let relay = Arc::new(WsRelaySink::with_persistence(8, persistence.clone()));

        let reply = handle_get_session_payload(
            "r1".to_string(),
            &json!({ "sessionId": "session-p" }),
            &relay,
            HistoryMode::Server,
        )
        .await;
        assert!(reply.ok, "reply: {reply:?}");
        let value = serde_json::to_value(&reply).unwrap();
        let payload = &value["payload"];
        assert_eq!(payload["metadata"]["id"], "session-p");
        assert_eq!(payload["metadata"]["agentId"], "runtime-p");
        assert_eq!(payload["metadata"]["agentConfigId"], "claude");
        assert_eq!(payload["metadata"]["projectId"], "p-1");
        assert_eq!(payload["metadata"]["messageCount"], 3);
        assert_eq!(payload["metadata"]["lastSeq"], 5);
        assert_eq!(payload["metadata"]["status"], "active");
        assert_eq!(payload["messages"][0]["id"], "turn:turn-1");
        assert_eq!(payload["messages"][0]["role"], "user");
        assert_eq!(payload["messages"][0]["seq"], 1);
        assert_eq!(payload["messages"][0]["streaming"], false);
        assert_eq!(payload["messages"][0]["blocks"][0]["text"], "hello");
        // tool_call at seq 3 splits the agent run; text coalesces per run.
        assert_eq!(payload["messages"][1]["id"], "snapshot:agent:2");
        assert_eq!(payload["messages"][1]["blocks"][0]["text"], "wor");
        assert_eq!(payload["messages"][2]["id"], "snapshot:agent:4");
        assert_eq!(payload["messages"][2]["blocks"][0]["text"], "ld");

        // Stable re-read: a second request is byte-identical.
        let reply2 = handle_get_session_payload(
            "r2".to_string(),
            &json!({ "sessionId": "session-p" }),
            &relay,
            HistoryMode::Server,
        )
        .await;
        assert!(reply2.ok);
        let value2 = serde_json::to_value(&reply2).unwrap();
        assert_eq!(value2["payload"], payload.clone());

        persistence.shutdown().await.unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn get_session_payload_standalone_unknown_session_is_not_found() {
        let root =
            std::env::temp_dir().join(format!("termul-ws-payload-nf-{}", uuid::Uuid::new_v4()));
        let cwd = root.join("cwd");
        std::fs::create_dir_all(&cwd).unwrap();
        let persistence = crate::acp::SessionPersistence::open(root.join("sessions"))
            .await
            .unwrap();
        persistence
            .register_session(crate::acp::SessionRegistration {
                session_id: "session-known".to_string(),
                stable_agent_namespace: None,
                runtime_agent_id: None,
                project_id: None,
                cwd,
            })
            .await
            .unwrap();
        let relay = Arc::new(WsRelaySink::with_persistence(8, persistence.clone()));
        let reply = handle_get_session_payload(
            "r1".to_string(),
            &json!({ "sessionId": "session-absent" }),
            &relay,
            HistoryMode::Server,
        )
        .await;
        assert!(!reply.ok);
        assert_eq!(reply.err.unwrap().code, "not_found");
        persistence.shutdown().await.unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn get_session_payload_without_store_or_persistence_is_not_found() {
        let relay = Arc::new(WsRelaySink::new());
        let reply = handle_get_session_payload(
            "r1".to_string(),
            &json!({ "sessionId": "s-1" }),
            &relay,
            HistoryMode::Server,
        )
        .await;
        assert!(!reply.ok);
        assert_eq!(reply.err.unwrap().code, "not_found");
    }

    /// Storage degradation after finalization: the transcript log becomes
    /// unreadable. The handler must fail closed with `unsupported` — never a
    /// fabricated empty payload that would wipe the client's transcript.
    #[tokio::test]
    async fn get_session_payload_standalone_corrupt_log_is_unsupported() {
        let root =
            std::env::temp_dir().join(format!("termul-ws-payload-corrupt-{}", uuid::Uuid::new_v4()));
        let cwd = root.join("cwd");
        std::fs::create_dir_all(&cwd).unwrap();
        let persistence = crate::acp::SessionPersistence::open(root.join("sessions"))
            .await
            .unwrap();
        persistence
            .register_session(crate::acp::SessionRegistration {
                session_id: "session-c".to_string(),
                stable_agent_namespace: None,
                runtime_agent_id: None,
                project_id: None,
                cwd,
            })
            .await
            .unwrap();
        persistence
            .enqueue_event(standalone_payload_record(
                "session-c",
                1,
                "user_prompt",
                json!({
                    "agentId": "runtime-c",
                    "sessionId": "session-c",
                    "turnId": "turn-1",
                    "content": [{"type": "text", "text": "hello"}],
                }),
            ))
            .unwrap();
        persistence
            .finalize_session("session-c", crate::acp::PersistedSessionStatus::Closed)
            .await
            .unwrap();
        // Corrupt the durable transcript log after finalization.
        let storage_key = persistence.metadata("session-c").unwrap().storage_key;
        let log_path = persistence
            .root()
            .join(&storage_key)
            .join("messages.jsonl");
        {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(&log_path)
                .unwrap();
            file.write_all(b"{not valid json}\n").unwrap();
            file.flush().unwrap();
        }
        let relay = Arc::new(WsRelaySink::with_persistence(8, persistence.clone()));
        let reply = handle_get_session_payload(
            "r1".to_string(),
            &json!({ "sessionId": "session-c" }),
            &relay,
            HistoryMode::Server,
        )
        .await;
        assert!(!reply.ok);
        assert_eq!(reply.err.unwrap().code, "unsupported");
        persistence.shutdown().await.unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn try_reopen_returns_none_when_no_stored_session() {
        let root =
            std::env::temp_dir().join(format!("termul-ws-reopen-none-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let persistence = crate::acp::SessionPersistence::open(root.join("sessions"))
            .await
            .unwrap();
        let acp = Arc::new(AcpManager::new(vec![]));
        let target = ProjectSwitchContext {
            project_id: "p-1".to_string(),
            cwd: "/a".to_string(),
            mcp_servers: vec![],
        };
        let result =
            try_reopen_session_for_switch(&acp, &AgentId("a-1".to_string()), &persistence, &target)
                .await
                .unwrap();
        assert!(result.is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    /// Switch-back reopen returns `Err` (fallback) when a durable session exists
    /// but the agent cannot load or resume it. `execute_project_switch` catches
    /// this and falls back to a new session.
    #[tokio::test]
    async fn try_reopen_falls_back_when_agent_cannot_load() {
        let root = std::env::temp_dir().join(format!(
            "termul-ws-reopen-fallback-{}",
            uuid::Uuid::new_v4()
        ));
        let cwd = root.join("cwd");
        std::fs::create_dir_all(&cwd).unwrap();
        let persistence = crate::acp::SessionPersistence::open(root.join("sessions"))
            .await
            .unwrap();
        persistence
            .register_session(crate::acp::SessionRegistration {
                session_id: "s-1".to_string(),
                stable_agent_namespace: Some("config:claude".to_string()),
                runtime_agent_id: Some("agent-1".to_string()),
                project_id: Some("p-1".to_string()),
                cwd: cwd.clone(),
            })
            .await
            .unwrap();
        let acp = Arc::new(AcpManager::new(vec![]));
        let target = ProjectSwitchContext {
            project_id: "p-1".to_string(),
            // `register_session` canonicalizes cwd; match exactly so the
            // `(project_id, cwd)` lookup finds the stored session.
            cwd: persistence.metadata("s-1").unwrap().cwd,
            mcp_servers: vec![],
        };
        let result =
            try_reopen_session_for_switch(&acp, &AgentId("a-1".to_string()), &persistence, &target)
                .await;
        assert!(
            result.is_err(),
            "no registered agent → reopen fails → Err → new session"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    /// `set_default_project` WS request (Epic 7): updates the host default,
    /// persists to the `FileProjectRegistry` (VPS, rollback-safe), and
    /// broadcasts `projects_changed`. Mirrors the `set_host_default_project`
    /// Tauri command + `POST /projects/default` HTTP route (transport parity).
    #[tokio::test]
    async fn handle_set_default_project_updates_host_default_and_persists() {
        let relay = Arc::new(WsRelaySink::new());
        let registry = Arc::new(ProjectRegistry::new());
        registry.set(
            vec![
                crate::web::project_registry::ProjectSummary {
                    id: "p-1".to_string(),
                    name: "Proj p-1".to_string(),
                    color: "blue".to_string(),
                    path: Some("/a".to_string()),
                    is_archived: false,
                    is_default: true,
                },
                crate::web::project_registry::ProjectSummary {
                    id: "p-2".to_string(),
                    name: "Proj p-2".to_string(),
                    color: "green".to_string(),
                    path: Some("/b".to_string()),
                    is_archived: false,
                    is_default: false,
                },
            ],
            Some("p-1".to_string()),
        );
        let file_registry = FileProjectRegistry::from_roots(
            vec![
                crate::acp::VfsRoot {
                    id: "p-1".to_string(),
                    name: "Proj p-1".to_string(),
                    path: PathBuf::from("/a"),
                    color: "blue".to_string(),
                    is_archived: false,
                    mcp_servers: vec![],
                },
                crate::acp::VfsRoot {
                    id: "p-2".to_string(),
                    name: "Proj p-2".to_string(),
                    path: PathBuf::from("/b"),
                    color: "green".to_string(),
                    is_archived: false,
                    mcp_servers: vec![],
                },
            ],
            Some("p-1".to_string()),
        );
        let file_registry = Arc::new(parking_lot::Mutex::new(file_registry));
        let path = std::env::temp_dir().join(format!(
            "termul-ws-set-default-{}-{}.json",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));

        let reply = handle_set_default_project(
            "r1".to_string(),
            &json!({ "projectId": "p-2" }),
            &relay,
            &registry,
            Some(&file_registry),
            Some(&path),
        )
        .await;
        let saved = std::fs::read_to_string(&path).ok();
        let _ = std::fs::remove_file(&path);
        assert!(reply.ok, "{:?}", reply.err);
        // In-memory registry default + flags updated.
        let snap = registry.snapshot();
        assert_eq!(snap.default_project_id.as_deref(), Some("p-2"));
        assert!(!snap.projects[0].is_default);
        assert!(snap.projects[1].is_default);
        // File registry persisted (VPS mode).
        assert_eq!(file_registry.lock().default_project_id(), Some("p-2"));
        let saved = saved.expect("persisted file written");
        let v: Value = serde_json::from_str(&saved).expect("valid json");
        assert_eq!(v["schemaVersion"], 3);
        assert_eq!(v["defaultProjectId"], "p-2");
    }

    /// `set_default_project` WS request with an unknown/archived/pathless id →
    /// `NOT_FOUND` (validation rejects before any mutation or persistence).
    #[tokio::test]
    async fn handle_set_default_project_unknown_id_is_not_found() {
        let relay = Arc::new(WsRelaySink::new());
        let registry = Arc::new(ProjectRegistry::new());
        registry.set(
            vec![
                crate::web::project_registry::ProjectSummary {
                    id: "p-1".to_string(),
                    name: "Proj p-1".to_string(),
                    color: "blue".to_string(),
                    path: Some("/a".to_string()),
                    is_archived: false,
                    is_default: true,
                },
                crate::web::project_registry::ProjectSummary {
                    id: "p-archived".to_string(),
                    name: "Archived".to_string(),
                    color: "blue".to_string(),
                    path: Some("/b".to_string()),
                    is_archived: true,
                    is_default: false,
                },
                crate::web::project_registry::ProjectSummary {
                    id: "p-pathless".to_string(),
                    name: "Pathless".to_string(),
                    color: "blue".to_string(),
                    path: None,
                    is_archived: false,
                    is_default: false,
                },
            ],
            Some("p-1".to_string()),
        );
        let path = std::env::temp_dir().join(format!(
            "termul-ws-set-default-nf-{}-{}.json",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        for bad in ["missing", "p-archived", "p-pathless"] {
            let reply = handle_set_default_project(
                "r1".to_string(),
                &json!({ "projectId": bad }),
                &relay,
                &registry,
                None,
                Some(&path),
            )
            .await;
            assert!(!reply.ok, "{bad} should be rejected");
            assert_eq!(reply.err.unwrap().code, "not_found");
            // Default unchanged.
            assert_eq!(
                registry.snapshot().default_project_id.as_deref(),
                Some("p-1")
            );
        }
        // No file was written (validation rejected before persistence).
        assert!(
            !path.exists(),
            "no file should be written on validation failure"
        );
    }

    /// `set_default_project` WS request is a distinct operation from
    /// `switch_project`: the host default changes + broadcasts to ALL clients,
    /// while a per-connection switch touches only the requester's
    /// `current_project`. This test documents the parity boundary.
    #[tokio::test]
    async fn handle_set_default_project_broadcasts_unlike_switch() {
        let relay = Arc::new(WsRelaySink::new());
        let registry = Arc::new(ProjectRegistry::new());
        registry.set(
            vec![crate::web::project_registry::ProjectSummary {
                id: "p-1".to_string(),
                name: "Proj p-1".to_string(),
                color: "blue".to_string(),
                path: Some("/a".to_string()),
                is_archived: false,
                is_default: false,
            }],
            None,
        );
        // Subscribe a client to prove the broadcast reaches it.
        let (_client, mut rx, _replay) = relay.subscribe("sess-1", None).await;

        let reply = handle_set_default_project(
            "r1".to_string(),
            &json!({ "projectId": "p-1" }),
            &relay,
            &registry,
            None,
            None,
        )
        .await;
        assert!(reply.ok, "{:?}", reply.err);
        // P13: inspect the broadcast event type + payload (not just count).
        let mut drained = Vec::new();
        while let Ok(evt) = rx.try_recv() {
            drained.push(evt);
        }
        assert_eq!(drained.len(), 1, "exactly one projects_changed broadcast");
        let evt = &drained[0];
        assert_eq!(evt.type_, "projects_changed");
        assert!(
            evt.sid.is_none(),
            "agent-level event: sid must be null"
        );
        assert_eq!(evt.seq, 0, "agent-level event: seq must be 0");
        assert_eq!(
            evt.payload["defaultProjectId"], "p-1",
            "the broadcast carries the new default project id"
        );
    }

    /// P7 — live-agent `switch_project` success path: no `projects_changed`
    /// broadcast, no `FileProjectRegistry` persistence. The cold-tab path has
    /// this assertion; this test covers the live-agent `execute_project_switch`
    /// path. A `block_on` AcpManager can't spawn a real agent, so we call
    /// `execute_project_switch` directly with a no-op AcpManager — the key
    /// assertion is that NO broadcast fires (the relay's event log stays empty)
    /// and the file registry default is UNCHANGED even though the connection's
    /// `current_project` was updated.
    ///
    /// Note: `AcpManager::new(vec![])` has no registered agents, so
    /// `new_session_with_context` will fail. We assert the error path does NOT
    /// broadcast (the success path can't be exercised without a real agent).
    /// This is a structural gap — a regression that adds a broadcast BEFORE
    /// the session-creation step would be caught here.
    #[tokio::test]
    async fn execute_project_switch_live_agent_path_does_not_broadcast() {
        let relay = Arc::new(WsRelaySink::new());
        let acp = Arc::new(AcpManager::new(vec![]));
        let registry = Arc::new(ProjectRegistry::new());
        registry.set(
            vec![crate::web::project_registry::ProjectSummary {
                id: "p-1".to_string(),
                name: "Proj p-1".to_string(),
                color: "blue".to_string(),
                path: Some("/a".to_string()),
                is_archived: false,
                is_default: true,
            }],
            Some("p-1".to_string()),
        );
        // A file registry + path are wired (VPS fixtures), but the switch must
        // NOT touch them.
        let file_registry = FileProjectRegistry::from_roots(
            vec![crate::acp::VfsRoot {
                id: "p-1".to_string(),
                name: "Proj p-1".to_string(),
                path: PathBuf::from("/a"),
                color: "blue".to_string(),
                is_archived: false,
                mcp_servers: vec![],
            }],
            Some("p-1".to_string()),
        );
        let file_registry = Arc::new(parking_lot::Mutex::new(file_registry));
        let path = std::env::temp_dir().join(format!(
            "termul-ws-live-switch-nobroadcast-{}-{}.json",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        // Subscribe a client to prove NO broadcast reaches it.
        let (_client, mut rx, _replay) = relay.subscribe("sess-1", None).await;

        let current_session =
            Arc::new(parking_lot::Mutex::new(None::<crate::acp::SessionId>));
        let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
        let target = ProjectSwitchContext {
            project_id: "p-1".to_string(),
            cwd: "/a".to_string(),
            mcp_servers: vec![],
        };
        // The live-agent path will fail (no registered agent →
        // new_session_with_context errors), but the key assertion is that NO
        // broadcast fires even on this path. A regression that calls
        // broadcast_projects_changed BEFORE the session-creation error would
        // be caught.
        let _result = execute_project_switch(
            &AgentId("a-1".to_string()),
            target,
            SessionId("s-old".to_string()),
            &acp,
            &relay,
            &current_session,
            &current_project,
        )
        .await;
        // No broadcast reached the subscribed client.
        assert!(
            rx.try_recv().is_err(),
            "switch_project must NOT broadcast projects_changed (per-connection)"
        );
        // The file registry default is UNCHANGED (no persistence on switch).
        assert_eq!(
            file_registry.lock().default_project_id(),
            Some("p-1"),
            "switch must not persist to the file registry"
        );
        // No file was written to disk.
        assert!(
            !path.exists(),
            "switch must not write the projects file"
        );
    }

    /// P8 — multi-client: a `switch_project` by one client does NOT fan out
    /// a `projects_changed` event to other subscribed clients. This is the
    /// symmetric negative of `handle_set_default_project_broadcasts_unlike_switch`
    /// (which proves `set_default_project` DOES broadcast). The cold-tab path
    /// is used (no live agent) — the assertion is that the relay's event log
    /// stays empty for the non-switching client.
    #[tokio::test]
    async fn switch_project_cold_tab_does_not_fan_out_to_other_clients() {
        let relay = Arc::new(WsRelaySink::new());
        let acp = Arc::new(AcpManager::new(vec![]));
        let registry = Arc::new(ProjectRegistry::new());
        registry.set(
            vec![crate::web::project_registry::ProjectSummary {
                id: "p-1".to_string(),
                name: "Proj p-1".to_string(),
                color: "blue".to_string(),
                path: Some("/a".to_string()),
                is_archived: false,
                is_default: false,
            }],
            None,
        );
        // Client A subscribes to sess-a; client B subscribes to sess-b.
        let (_client_a, mut rx_a, _replay_a) = relay.subscribe("sess-a", None).await;
        let (_client_b, mut rx_b, _replay_b) = relay.subscribe("sess-b", None).await;

        let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
        let mut subs = Vec::new();
        let mut authed = true;
        let mut current_agent: Option<crate::acp::AgentId> = None;
        let current_session =
            Arc::new(parking_lot::Mutex::new(None::<crate::acp::SessionId>));
        let current_project_a = Arc::new(parking_lot::Mutex::new(None::<String>));
        let switch_queue =
            Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));

        // Client A sends switch_project (cold-tab path).
        let reply_a = handle_request(
            r#"{"id":"r1","type":"switch_project","payload":{"projectId":"p-1"}}"#,
            &mut authed,
            &acp,
            &relay,
            &registry,
            None,
            None,
            &tx,
            &mut subs,
            &mut current_agent,
            &current_session,
            &current_project_a,
            &switch_queue,
            HistoryMode::LiveOnly,
            None,
        )
        .await;
        assert!(reply_a.ok, "client A switch succeeds: {:?}", reply_a.err);

        // Client A's current_project reflects the switch.
        assert_eq!(current_project_a.lock().as_deref(), Some("p-1"));

        // P8: client B receives ZERO projects_changed events (no fan-out).
        let mut b_drained = 0;
        while rx_b.try_recv().is_ok() {
            b_drained += 1;
        }
        assert_eq!(
            b_drained, 0,
            "switch_project must not fan out to other clients"
        );
        // Client A also receives nothing (switch_project responds to the
        // requester ONLY — no broadcast).
        let mut a_drained = 0;
        while rx_a.try_recv().is_ok() {
            a_drained += 1;
        }
        assert_eq!(a_drained, 0, "switch_project must not broadcast at all");
    }

    /// P10 — cold-tab `switch_project` with `registry_persistence: Some(...)`
    /// still does NOT write the file (the persistence block was removed from
    /// the switch path entirely — only `set_default_project` persists).
    #[test]
    fn execute_cold_tab_select_with_persistence_does_not_write_file() {
        let _relay = Arc::new(WsRelaySink::new());
        let registry = Arc::new(ProjectRegistry::new());
        registry.set(
            vec![crate::web::project_registry::ProjectSummary {
                id: "p-1".to_string(),
                name: "Proj p-1".to_string(),
                color: "blue".to_string(),
                path: Some("/a".to_string()),
                is_archived: false,
                is_default: false,
            }],
            None,
        );
        // Wire a REAL file registry + path (VPS-mode fixtures) — the switch
        // must NOT touch them.
        let file_registry = FileProjectRegistry::from_roots(
            vec![crate::acp::VfsRoot {
                id: "p-1".to_string(),
                name: "Proj p-1".to_string(),
                path: PathBuf::from("/a"),
                color: "blue".to_string(),
                is_archived: false,
                mcp_servers: vec![],
            }],
            None,
        );
        let file_registry = Arc::new(parking_lot::Mutex::new(file_registry));
        let path = std::env::temp_dir().join(format!(
            "termul-ws-cold-tab-vps-noperist-{}-{}.json",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
        let target = ProjectSwitchContext {
            project_id: "p-1".to_string(),
            cwd: "/a".to_string(),
            mcp_servers: vec![],
        };
        // The cold-tab switch only takes (target, current_project) now — it
        // no longer accepts registry_persistence/projects_file. Calling it
        // directly proves the file is untouched even when VPS fixtures exist
        // in the caller's scope.
        let result = execute_cold_tab_select(target, &current_project);
        let leaked = std::fs::read_to_string(&path).ok();
        let _ = std::fs::remove_file(&path);
        let outcome = result.expect("cold-tab select succeeds");
        let SwitchProjectOutcome::Selected { project_id, cwd } = outcome else {
            panic!("expected Selected, got {:?}", outcome);
        };
        assert_eq!(project_id, "p-1");
        assert_eq!(cwd, "/a");
        assert_eq!(current_project.lock().as_deref(), Some("p-1"));
        // The host default is UNCHANGED (per-connection switch).
        assert_eq!(registry.snapshot().default_project_id, None);
        // The file registry is UNCHANGED.
        assert_eq!(file_registry.lock().default_project_id(), None);
        // No file was written.
        assert!(leaked.is_none(), "switch must not write the projects file");
    }

    /// P17 — `connection_already_on_project` gate: when the connection's
    /// `current_project` already matches the target, the switch returns early
    /// (a no-op `Completed` with the previous session). The cold-tab test
    /// (`execute_cold_tab_select_is_per_connection_no_persistence_no_broadcast`)
    /// covers the non-matching path; this test pins the matching path.
    #[tokio::test]
    async fn execute_project_switch_returns_early_when_already_on_project() {
        let relay = Arc::new(WsRelaySink::new());
        let acp = Arc::new(AcpManager::new(vec![]));
        let registry = Arc::new(ProjectRegistry::new());
        registry.set(
            vec![crate::web::project_registry::ProjectSummary {
                id: "p-1".to_string(),
                name: "Proj p-1".to_string(),
                color: "blue".to_string(),
                path: Some("/a".to_string()),
                is_archived: false,
                is_default: true,
            }],
            Some("p-1".to_string()),
        );
        let current_session =
            Arc::new(parking_lot::Mutex::new(Some(SessionId("s-prev".to_string()))));
        // The connection is ALREADY on p-1.
        let current_project = Arc::new(parking_lot::Mutex::new(Some("p-1".to_string())));
        let target = ProjectSwitchContext {
            project_id: "p-1".to_string(),
            cwd: "/a".to_string(),
            mcp_servers: vec![],
        };
        let outcome = execute_project_switch(
            &AgentId("a-1".to_string()),
            target,
            SessionId("s-prev".to_string()),
            &acp,
            &relay,
            &current_session,
            &current_project,
        )
        .await
        .expect("early return succeeds");
        // The switch is a no-op: same session, no new session created.
        let SwitchProjectOutcome::Completed {
            project_id,
            session_id,
            cwd,
            mcp_server_count: _,
        } = outcome
        else {
            panic!("expected Completed (early return), got {:?}", outcome);
        };
        assert_eq!(project_id, "p-1");
        assert_eq!(session_id.0, "s-prev");
        assert_eq!(cwd, "/a");
        // current_session unchanged (no new session).
        assert_eq!(current_session.lock().as_ref().unwrap().0, "s-prev");
    }
}
