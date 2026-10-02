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
//! `authenticate` validates the single-token web auth gate (CAP-1 interim,
//! QA remediation Story 1) when `AppState.web_auth` is `Some` — a wrong/absent
//! token is refused `unauthorized` and the connection stays pre-auth (retry
//! allowed). Ungated servers (`web_auth: None`) keep the legacy
//! accept-any-token behavior byte-for-byte. `subscribe` is wired (Story 1.6):
//! binds the connection to a session log with optional `lastSeq` cursor
//! replay. Unknown request types return `err.code: "not_implemented"`.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
use crate::web::auth::WebAuth;
use crate::web::permissions::{TurnClaim, DEFAULT_PERMISSION_RECONNECT_GRACE};
use crate::web::project_registry::{ProjectRegistry, ProjectSwitchContext};
use crate::web::sink::{
    broadcast_chat_history_changed, broadcast_projects_changed, ClientId, ReplayResult, WsRelaySink,
};
use crate::web::store::WebStore;

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

    /// Build a failure reply with a raw (SCREAMING_SNAKE_CASE) code string.
    ///
    /// CAP-6 / Story 9: the install handler carries transport-identical codes
    /// (`INTEGRITY_MISMATCH`, `INTEGRITY_METADATA_MISSING`, …) matching the
    /// Tauri `IpcResult.code` + HTTP `IpcBody.code` byte-for-byte. The
    /// protocol-level `WsErrorCode` enum is snake_case (e.g. `unsupported`),
    /// so the install codes cannot be expressed as enum variants without
    /// breaking the wire contract. This constructor accepts a raw string so
    /// the install handler's `err.code` is byte-identical across transports.
    #[must_use]
    pub fn err_with_code(
        id: impl Into<String>,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            ok: false,
            payload: None,
            err: Some(WsError {
                code: code.into(),
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

/// The 11 stable `err.code` machine strings (AC2). Mirrors the TS
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
    /// The agent rejected session entry (`session/new` / `session/load` /
    /// `session/resume`) with ACP `AuthRequired` (-32000) — the user must
    /// authenticate first. Additive (Story 7): receivers that ignore unknown
    /// codes stay compatible.
    AgentAuthRequired,
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
            Self::AgentAuthRequired => "agent_auth_required",
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
    /// Host-owned verified-atomic ACP install service (CAP-6 / Story 9). `None`
    /// when the desktop could not open `AcpInstallService` at startup (degraded
    /// mode — the `install_acp_agent` handler returns
    /// `ACP_INSTALL_UNAVAILABLE`). The web/remote client installs a catalog
    /// agent through `POST /acp/install` (catalog_api sibling) + WS
    /// `install_acp_agent`; the desktop renderer uses the `acp_install_agent`
    /// Tauri command (same `IpcResult<T>` shape byte-for-byte).
    pub acp_install: Option<Arc<crate::acp::install::AcpInstallService>>,
    /// Issue #613: server-side generic key-value store for web-client state
    /// (terminal layout, settings, editor state, command history, snapshots,
    /// SSH profiles). `None` when a server does not attach a store — the
    /// `store_*` WS handlers return `STORE_UNAVAILABLE` (degraded mode). The
    /// standalone binary + desktop shared-live host both attach one.
    pub store: Option<Arc<WebStore>>,
    /// Operator opt-in: admit non-loopback peers on the loopback-guarded
    /// write routes (fs/git/workspace/projects/host-state). Default `false`
    /// (the CWE-306 guard stays on); set `true` only by the standalone
    /// `termul-server` `--allow-remote-writes` flag. The desktop shared-live
    /// host leaves this `false` (LAN clients stay view-only for mutations).
    pub allow_remote_writes: bool,
    /// Deployment-mode deny: when `true`, the write guard refuses ALL write
    /// routes BEFORE evaluating the peer address or `allow_remote_writes`.
    /// Set `true` by the desktop shared-live host — it binds localhost and a
    /// cloudflared quick-tunnel forwards public traffic to it from a loopback
    /// source, so `is_loopback()` cannot distinguish cloudflared-forwarded
    /// requests from genuine local callers. The standalone `termul-server`
    /// sets this `false` (its `--allow-remote-writes` opt-in is the
    /// admission path there). Closes the cloudflared loopback bypass.
    pub shared_live_writes_denied: bool,
    /// PR-S4 / CAP-1: the project-root boundary for the routes that enforce it
    /// (`/git/*`, `/skills`, `/search/content` via
    /// `git_api::ensure_within_project_boundary`). The `/fs/*` routes are
    /// intentionally NOT confined to this root (ADR-007 breadth); they reject
    /// only `..` traversal (`PATH_TRAVERSAL`), not paths outside the root.
    /// On the desktop shared-live path it is
    /// derived from the `ProjectRegistry`'s default (active) project at start,
    /// falling back to the user home dir when the registry is empty or its
    /// default project path is invalid (fails canonicalization); on the
    /// standalone `termul-server` path it comes from
    /// `ServerConfig::project_root` (the `--project-root` CLI flag or the
    /// env/home default).
    ///
    /// **CAP-1 (live rebind):** wrapped in `Arc<parking_lot::RwLock<PathBuf>>`
    /// so switching the active project (via `remote_sync_projects` /
    /// `set_default_project`) updates the boundary in place without a server
    /// restart. The same `Arc` handle is registered with the
    /// `ProjectRegistry` (see `set_project_root_handle`) so the registry's
    /// `set` / `set_default_project` mutators recompute the canonical path
    /// from the new default and write it here. Read sites lock-read the guard
    /// for the duration of the `starts_with` containment check (no `.await`
    /// under the guard).
    pub project_root: Arc<parking_lot::RwLock<std::path::PathBuf>>,
    /// Pending MCP OAuth flows keyed by server URL. Used by the web OAuth
    /// callback route to complete the token exchange after the browser
    /// redirect. The desktop path doesn't use this (it runs the full flow
    /// synchronously in the `acp_mcp_oauth_start` command).
    pub pending_oauth_flows: Arc<
        parking_lot::RwLock<
            std::collections::HashMap<String, crate::acp::mcp_oauth::PendingOAuthFlow>,
        >,
    >,
    /// Base URL for OAuth redirect URIs on the web path. The standalone
    /// server derives this from its bind address; the desktop shared-live
    /// host uses the cloudflared tunnel URL. The OAuth callback route lives
    /// at `{base}/oauth/callback`.
    pub oauth_base_url: String,
    /// The web auth gate (CAP-1 interim, QA remediation Story 1). `Some` on
    /// a gated server (explicit token configured, or public bind with a
    /// generated/loaded token — see `web::auth::resolve`): the pre-auth
    /// `authenticate` branch validates `payload.token` in constant time, and
    /// `/terminal/ws` + the gated HTTP API routes enforce the same token.
    /// `None` keeps the legacy ungated behavior (accept-any-token
    /// `authenticate`, no `/terminal/ws` connection gate).
    pub web_auth: Option<Arc<WebAuth>>,
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
        let turn_idle = crate::acp::manager::turn_idle_timeout(); // Option
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
    /// Terminal close handshake (CAP-11: after a binary-frame protocol error).
    /// The channel is FIFO, so everything enqueued ahead of it (the
    /// `unsupported` error reply) is flushed first; the write loop then sends
    /// `Message::Close` and breaks, guaranteeing reply-before-close ordering.
    Close(axum::extract::ws::CloseFrame),
}

/// The `auth_required` event type name (relay-level, not from `events.rs`).
pub const AUTH_REQUIRED_TYPE: &str = "auth_required";
/// Batched WS frame type: `{"type":"events","events":[{sid,seq,type,payload}]}`
/// — the write loop packs a drained burst into one frame; the client unwraps
/// inner events through the same `handleEvent` path (per-event seq intact).
pub const WS_BATCH_TYPE: &str = "events";

/// Max events per batched frame — a burst drains in ≤this-sized slices so a
/// sustained flood still yields progressively (no unbounded flush latency).
const WS_BATCH_MAX_EVENTS: usize = 64;

/// Build the `auth_required` event (sid=null, seq=0, payload={}).
fn auth_required_event() -> SequencedEvent {
    SequencedEvent::new(None, 0, AUTH_REQUIRED_TYPE, json!({}))
}

/// Axum WS upgrade handler for `/ws` (AC1).
///
/// The upgrade itself always proceeds; the token gate lives in the
/// first-frame `authenticate` handling (`handle_request`), so a wrong token
/// gets a structured `unauthorized` reply instead of a failed handshake. The
/// default bind stays localhost per `web/config.rs`.
pub async fn ws_upgrade(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    // The first frame is auth_required; the gate (when active) is enforced on
    // the `authenticate` request, not at upgrade time.
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

/// Signal-gated keepalive ceiling (CAP-3): while a web client has sent a
/// `type:"background"` control frame and not yet sent `foreground` (or any
/// normal frame), the watchdog tolerates up to 5 minutes of inactivity so a
/// backgrounded mobile tab (whose `setInterval` the OS throttles/pauses)
/// survives an app-switch round-trip. `PONG_TIMEOUT` is NOT raised — the
/// 5-min ceiling applies only while `backgrounded=true`. 5 min balances
/// mobile battery against reconnect latency (codeg tolerates 1h; buzz 30s).
const BACKGROUND_TIMEOUT: Duration = Duration::from_secs(300);

/// Reusable Ping payload (opaque; browsers must echo it back in the Pong, but
/// the relay does not correlate — any inbound frame resets the watchdog).
/// Must stay under 125 bytes per RFC 6455 control-frame limits.
const PING_PAYLOAD: &[u8] = b"keepalive";

/// Pure keepalive-watchdog decision: returns true when no inbound frame
/// (text request, Pong, or client Ping) has arrived for longer than `ceiling`
/// — `PONG_TIMEOUT` for an active/foreground connection, or `BACKGROUND_TIMEOUT`
/// while a `background` signal is in effect (CAP-3). Extracted from the write
/// task so the threshold semantics (strict `>`) are unit-testable without
/// spinning up a real socket. The write task calls this with
/// `last_activity.load()` + `now_ms()` + the active ceiling on each tick.
fn watchdog_is_stale(last_activity_ms: u64, now_ms_value: u64, ceiling_ms: u64) -> bool {
    now_ms_value.saturating_sub(last_activity_ms) > ceiling_ms
}

/// Cheaply extract the `type` field of a client WS text frame (CAP-3 control
/// signals). Returns `None` for non-JSON or frames without a string `type`.
/// The read task uses this to recognize id-less `background`/`foreground`
/// lifecycle frames before the strict `WsRequest` parse (which requires `id`).
fn peer_frame_type(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    value.get("type")?.as_str().map(str::to_owned)
}

/// CAP-3: consume an id-less `background`/`foreground` lifecycle control frame.
/// Returns `true` when the frame was a lifecycle signal and the caller should
/// skip dispatch (no reply, no `WsRequest` parse). The `backgrounded` flag is
/// toggled ONLY when `authed` (an unauthenticated peer cannot manipulate the
/// watchdog ceiling); an unauthenticated signal is still consumed (ignored,
/// no dispatch, no error). Returns `false` for any other frame — the caller
/// then resets the flag ("any normal frame resets the normal timeout") and
/// dispatches as a normal ACP request.
fn handle_lifecycle_signal(text: &str, authed: bool, backgrounded: &AtomicBool) -> bool {
    if let Some(type_) = peer_frame_type(text) {
        match type_.as_str() {
            "background" => {
                if authed {
                    backgrounded.store(true, Ordering::Relaxed);
                } else {
                    debug!("[ws] ignoring background signal from unauthenticated connection");
                }
                true
            }
            "foreground" => {
                if authed {
                    backgrounded.store(false, Ordering::Relaxed);
                }
                true
            }
            _ => false,
        }
    } else {
        false
    }
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
    // CAP-6 / Story 9: the host-owned verified-atomic ACP install service for
    // the `install_acp_agent` WS request.
    let acp_install = state.acp_install.clone();
    // Issue #613: the server-side generic key-value store behind the
    // `store_read` / `store_write` / `store_delete` WS requests.
    let store = state.store.clone();
    // CAP-1 interim (Story 1): the web auth gate threaded into the pre-auth
    // `authenticate` validation. `None` = ungated (legacy behavior).
    let web_auth = state.web_auth.clone();
    // Client ids registered via `subscribe` — unregistered on disconnect.
    let subscribed_clients = Arc::new(tokio::sync::Mutex::new(Vec::<(String, ClientId)>::new()));
    let cleanup = ConnectionCleanup::new(Arc::clone(&relay), Arc::clone(&subscribed_clients));
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
    // CAP-3: per-connection background flag. `true` while a web client has
    // signaled `type:"background"` (tab suspending); the watchdog then uses
    // BACKGROUND_TIMEOUT (5min) instead of PONG_TIMEOUT (75s). Reset to
    // false by `foreground` or any normal client frame.
    let backgrounded = Arc::new(AtomicBool::new(false));
    let write_last_activity = Arc::clone(&last_activity);
    let write_backgrounded = Arc::clone(&backgrounded);

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
                    // Burst coalescing: when the first dequeued frame is an
                    // event, greedily pull whatever else the channel already
                    // holds and ship the run as ONE `events` frame. Under an
                    // 8-agent stream this collapses ~160 per-event WS frames
                    // per second (each its own webview dispatch + JSON.parse)
                    // into one frame per drain — zero added latency since we
                    // never wait for events that haven't arrived.
                    let text = match frame {
                        Outbound::Event(first) => {
                            let mut batch = vec![first];
                            let mut lookahead: Option<Outbound> = None;
                            while batch.len() < WS_BATCH_MAX_EVENTS {
                                match out_rx.try_recv() {
                                    Ok(Outbound::Event(evt)) => batch.push(evt),
                                    Ok(other) => {
                                        lookahead = Some(other);
                                        break;
                                    }
                                    Err(_) => break,
                                }
                            }
                            let text = if batch.len() == 1 {
                                serde_json::to_string(&batch[0]).unwrap_or_else(|e| {
                                    warn!("[ws] failed to serialize event {}: {e}", batch[0].type_);
                                    String::new()
                                })
                            } else {
                                serde_json::to_string(&json!({
                                    "type": WS_BATCH_TYPE,
                                    "events": batch,
                                }))
                                .unwrap_or_else(|e| {
                                    warn!("[ws] failed to serialize event batch: {e}");
                                    String::new()
                                })
                            };
                            if !text.is_empty() && sink.send(Message::Text(text.into())).await.is_err() {
                                break; // peer gone — stop writing.
                            }
                            // The non-event frame that ended the drain goes
                            // next, preserving strict FIFO across frame kinds.
                            match lookahead {
                                Some(Outbound::Reply(rep)) => {
                                    let text = serde_json::to_string(&rep).unwrap_or_else(|e| {
                                        warn!("[ws] failed to serialize reply for {}: {e}", rep.id);
                                        String::new()
                                    });
                                    if !text.is_empty()
                                        && sink.send(Message::Text(text.into())).await.is_err()
                                    {
                                        break;
                                    }
                                    continue;
                                }
                                Some(Outbound::Close(close)) => {
                                    let _ = sink.send(Message::Close(Some(close))).await;
                                    break;
                                }
                                Some(Outbound::Event(_)) => unreachable!(),
                                None => continue,
                            }
                        }
                        Outbound::Reply(rep) => serde_json::to_string(&rep).unwrap_or_else(|e| {
                            warn!("[ws] failed to serialize reply for {}: {e}", rep.id);
                            String::new()
                        }),
                        // CAP-11: the write task owns the close handshake —
                        // flush `Message::Close` AFTER everything queued ahead
                        // of it, then break so the outer select aborts the
                        // read task (not the other way around, which would
                        // race the queued frames away).
                        Outbound::Close(close) => {
                            let _ = sink.send(Message::Close(Some(close))).await;
                            break;
                        }
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
                    // CAP-3: a backgrounded client (sent `type:"background"`)
                    // gets the 5-min ceiling; any other state gets 75s.
                    let ceiling = if write_backgrounded.load(Ordering::Relaxed) {
                        BACKGROUND_TIMEOUT
                    } else {
                        PONG_TIMEOUT
                    };
                    if watchdog_is_stale(last, now, ceiling.as_millis() as u64) {
                        warn!(
                            "[ws] keepalive: no client activity for {stale} ms \
                             (>{ceiling:?}); closing connection"
                        );
                        break;
                    }
                }
            }
        }
    });

    let read_last_activity = Arc::clone(&last_activity);
    let read_backgrounded = Arc::clone(&backgrounded);
    let read_subscribed_clients = Arc::clone(&subscribed_clients);
    let read_relay = Arc::clone(&relay);
    let mut read_task = tokio::spawn(async move {
        let mut authed = false;
        // CAP-11: set once a binary frame poisons the connection. The error
        // reply + Close(1003) are already queued; further text requests must
        // NOT dispatch (they would execute before the close lands) — the read
        // loop just waits for the write task to finish the handshake.
        let mut protocol_error = false;
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
                    if protocol_error {
                        continue;
                    }
                    // CAP-3: consume id-less `background`/`foreground`
                    // lifecycle control frames before the strict `WsRequest`
                    // parse (which requires `id`). These are fire-and-forget
                    // (no reply) and toggle the keepalive ceiling; an
                    // unauthenticated connection's signal is ignored (no flag
                    // set, no dispatch, no error).
                    if handle_lifecycle_signal(&t, authed, &read_backgrounded) {
                        continue;
                    }
                    // Any other text frame resets the background flag (CAP-3:
                    // "resets on foreground or any normal frame") and dispatches
                    // as a normal ACP request.
                    read_backgrounded.store(false, Ordering::Relaxed);
                    if !dispatch_connection_text(
                        &t,
                        &mut authed,
                        web_auth.as_deref(),
                        &acp,
                        &read_relay,
                        &registry,
                        registry_persistence.as_ref(),
                        projects_file.as_deref(),
                        &write_tx,
                        &read_subscribed_clients,
                        &mut current_agent,
                        &current_session,
                        &current_project,
                        &switch_queue,
                        history_mode,
                        acp_catalog.as_ref(),
                        acp_install.as_ref(),
                        store.as_ref(),
                    )
                    .await
                    {
                        break; // write half closed.
                    }
                }
                Message::Binary(_) => {
                    // Protocol error (CAP-11): the structured `unsupported`
                    // error reply MUST reach the client before the Close(1003)
                    // handshake. Do NOT break here — finishing this read task
                    // would let the outer `tokio::select!` abort the write task
                    // mid-queue, racing the queued reply + close away. Instead
                    // the write task owns the handshake: `Outbound::Close`
                    // flushes after the reply (FIFO), the write loop breaks,
                    // and the outer select then aborts this read task. The
                    // latch suppresses duplicate replies on repeated binary
                    // frames.
                    if protocol_error {
                        continue;
                    }
                    protocol_error = true;
                    let _ = write_tx.send(Outbound::Reply(WsReply::err(
                        "binary-frame",
                        WsErrorCode::Unsupported,
                        "binary frames are not supported by this protocol",
                    )));
                    let _ = write_tx.send(Outbound::Close(axum::extract::ws::CloseFrame {
                        code: 1003,
                        reason: "binary frames are not supported".into(),
                    }));
                }
                Message::Close(_) | Message::Ping(_) | Message::Pong(_) => {
                    // Axum auto-answers pings; Close ends the loop.
                    if matches!(msg, Message::Close(_)) {
                        break;
                    }
                }
            }
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
    cleanup.run().await;
}

struct ConnectionCleanup {
    relay: Arc<WsRelaySink>,
    subscribed_clients: Arc<tokio::sync::Mutex<Vec<(String, ClientId)>>>,
    state: Arc<std::sync::atomic::AtomicU8>,
}

impl ConnectionCleanup {
    fn new(
        relay: Arc<WsRelaySink>,
        subscribed_clients: Arc<tokio::sync::Mutex<Vec<(String, ClientId)>>>,
    ) -> Self {
        Self {
            relay,
            subscribed_clients,
            state: Arc::new(std::sync::atomic::AtomicU8::new(0)),
        }
    }

    async fn run(&self) {
        if self
            .state
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let relay = Arc::clone(&self.relay);
        let subscribed_clients = Arc::clone(&self.subscribed_clients);
        let state = Arc::clone(&self.state);
        let cleanup = tokio::spawn(async move {
            cleanup_connection_subscriptions(&relay, &subscribed_clients).await;
            state.store(2, Ordering::Release);
        });
        let _ = cleanup.await;
    }
}

impl Drop for ConnectionCleanup {
    fn drop(&mut self) {
        if self
            .state
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let relay = Arc::clone(&self.relay);
        let subscribed_clients = Arc::clone(&self.subscribed_clients);
        let state = Arc::clone(&self.state);
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                cleanup_connection_subscriptions(&relay, &subscribed_clients).await;
                state.store(2, Ordering::Release);
            });
        } else {
            warn!(
                target: "termul::web::ws",
                "connection cleanup dropped outside a Tokio runtime"
            );
        }
    }
}

fn authenticated_send_prompt(text: &str, authed: bool) -> Option<(String, Value)> {
    if !authed {
        return None;
    }
    let request: WsRequest = serde_json::from_str(text).ok()?;
    (request.type_ == "send_prompt").then_some((request.id, request.payload))
}

#[allow(clippy::too_many_arguments)]
async fn dispatch_connection_text(
    text: &str,
    authed: &mut bool,
    web_auth: Option<&WebAuth>,
    acp: &Arc<AcpManager>,
    relay: &Arc<WsRelaySink>,
    registry: &Arc<ProjectRegistry>,
    registry_persistence: Option<&Arc<parking_lot::Mutex<FileProjectRegistry>>>,
    projects_file: Option<&PathBuf>,
    write_tx: &mpsc::UnboundedSender<Outbound>,
    subscribed_clients: &Arc<tokio::sync::Mutex<Vec<(String, ClientId)>>>,
    current_agent: &mut Option<AgentId>,
    current_session: &Arc<parking_lot::Mutex<Option<SessionId>>>,
    current_project: &Arc<parking_lot::Mutex<Option<String>>>,
    switch_queue: &Arc<tokio::sync::Mutex<ProjectSwitchQueue>>,
    history_mode: HistoryMode,
    acp_catalog: Option<&Arc<crate::acp::AcpCatalogService>>,
    acp_install: Option<&Arc<crate::acp::install::AcpInstallService>>,
    store: Option<&Arc<WebStore>>,
) -> bool {
    if let Some((id, payload)) = authenticated_send_prompt(text, *authed) {
        return match accept_send_prompt(id, &payload, acp, relay).await {
            Ok(accepted) => {
                let prompt_acp = Arc::clone(acp);
                let prompt_tx = write_tx.clone();
                tokio::spawn(async move {
                    let reply = complete_send_prompt(accepted, &prompt_acp).await;
                    let _ = prompt_tx.send(Outbound::Reply(reply));
                });
                true
            }
            Err(reply) => write_tx.send(Outbound::Reply(reply)).is_ok(),
        };
    }

    let mut subscriptions = subscribed_clients.lock().await;
    let reply = handle_request(
        text,
        authed,
        web_auth,
        acp,
        relay,
        registry,
        registry_persistence,
        projects_file,
        write_tx,
        &mut subscriptions,
        current_agent,
        current_session,
        current_project,
        switch_queue,
        history_mode,
        acp_catalog,
        acp_install,
        store,
    )
    .await;
    write_tx.send(Outbound::Reply(reply)).is_ok()
}

async fn cleanup_connection_subscriptions(
    relay: &Arc<WsRelaySink>,
    subscribed_clients: &Arc<tokio::sync::Mutex<Vec<(String, ClientId)>>>,
) {
    let subscriptions = std::mem::take(&mut *subscribed_clients.lock().await);
    let disconnected_sessions: std::collections::HashSet<String> = subscriptions
        .iter()
        .map(|(session_id, _)| session_id.clone())
        .collect();
    for (session_id, client_id) in subscriptions {
        relay.unsubscribe(&session_id, client_id);
    }
    info!(
        target: "termul::web::ws",
        session_count = disconnected_sessions.len(),
        "connection subscriptions cleaned up"
    );

    if let Some(rendezvous) = relay.rendezvous() {
        for session_id in disconnected_sessions
            .iter()
            .filter(|session_id| relay.session_subscriber_count(session_id) == 0)
        {
            let relay_for_count = Arc::clone(relay);
            rendezvous.schedule_disconnect_grace(session_id.clone(), move |candidate| {
                relay_for_count.session_subscriber_count(candidate)
            });
        }
    }
    if let Some(rendezvous) = relay.question_rendezvous() {
        let relay_for_count = Arc::clone(relay);
        rendezvous
            .deny_all_for_client(move |session_id| {
                relay_for_count.session_subscriber_count(session_id)
            })
            .await;
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
/// `AcpManager` (Story 1.8); OS-cap requests → `unsupported`; unknown types →
/// `not_implemented`.
#[allow(clippy::too_many_arguments)]
async fn handle_request(
    text: &str,
    authed: &mut bool,
    web_auth: Option<&WebAuth>,
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
    acp_install: Option<&Arc<crate::acp::install::AcpInstallService>>,
    store: Option<&Arc<WebStore>>,
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
            // CAP-1 interim (Story 1): when the server runs gated, validate
            // the presented token in constant time BEFORE marking authed. A
            // wrong/absent token is refused `unauthorized`; `authed` stays
            // false and the connection stays open so the client may retry.
            // Ungated servers (`web_auth: None`) keep the legacy
            // accept-any-token behavior (frozen contract: ungated loopback is
            // byte-identical to the pre-gate server).
            if let Some(gate) = web_auth {
                let presented = req.payload["token"].as_str().unwrap_or("");
                if !gate.accepts(presented) {
                    // Durable boundary event (AGENTS.md logging policy): a
                    // refused authenticate must be visible in the service
                    // log. NEVER log the presented token — only that the
                    // gate refused, plus enough context to correlate.
                    warn!(
                        target: "termul::web::ws",
                        request_id = %req.id,
                        token_presented = !presented.is_empty(),
                        "web auth gate refused /ws authenticate (invalid or missing token)"
                    );
                    return WsReply::err(
                        id,
                        WsErrorCode::Unauthorized,
                        "invalid or missing auth token",
                    );
                }
            }
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
        // CAP-11: host-owned session delete (desktop parity with the
        // `acp_history_delete` Tauri command) — removes the persisted record
        // and fans `chat_history_changed` so every client refetches the index.
        "delete_session" => handle_delete_session(id, &req.payload, relay, history_mode).await,
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
        "get_session_payload_tail" => {
            handle_get_session_payload_tail(id, &req.payload, relay, history_mode).await
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
        // Story 8: promote a backend-ephemeral warm-pool session to durable
        // (register persistence metadata + clear the ephemeral mark).
        "promote_session" => handle_promote_session(id, &req.payload, acp).await,
        "register_discovered_session" => {
            handle_register_discovered_session(id, &req.payload, acp, relay).await
        }
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
        // Option B: project-list mutations. The standalone server is a
        // first-class project-list authority; these persist to
        // `FileProjectRegistry` (VPS, with rollback) + broadcast
        // `projects_changed`. Mirrors the `POST /projects`,
        // `PUT /projects/{id}`, `DELETE /projects/{id}` HTTP routes
        // (transport parity). Any authenticated client for now (Epic 2).
        "add_project" => {
            handle_add_project(
                id,
                &req.payload,
                relay,
                registry,
                registry_persistence,
                projects_file,
            )
            .await
        }
        "update_project" => {
            handle_update_project(
                id,
                &req.payload,
                relay,
                registry,
                registry_persistence,
                projects_file,
            )
            .await
        }
        "remove_project" => {
            handle_remove_project(
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
            handle_list_acp_catalog(id, &req.payload, acp_catalog, acp_install).await
        }
        "set_catalog_opt_in" => {
            handle_set_catalog_opt_in(id, &req.payload, acp_catalog).await
        }
        // CAP-6 / Story 9: host-owned verified-atomic ACP install. The web
        // client installs a catalog agent through `install_acp_agent`; the
        // host resolves the agent by id from the catalog, downloads the HTTPS
        // archive, verifies sha256, extracts safely, atomically activates,
        // serializes per-agent, records the manifest, and returns
        // `{ command, args }`. The request is `{ agentId }` only; the host
        // never accepts browser-supplied URLs/commands/paths/args. Errors
        // carry SCREAMING_SNAKE_CASE codes byte-identical to the Tauri +
        // HTTP transports (via `WsReply::err_with_code`).
        "install_acp_agent" => {
            handle_install_acp_agent(id, &req.payload, acp_install).await
        }
        // Issue #613: server-side generic key-value store. The web client
        // routes its `persistenceApi` through these (replacing the per-browser
        // localStorage stub) so settings / layout / command history / SSH
        // profiles survive browser switches + server restarts.
        "store_read" => handle_store_read(id, &req.payload, store).await,
        "store_write" => handle_store_write(id, &req.payload, store).await,
        "store_delete" => handle_store_delete(id, &req.payload, store).await,
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
        // CAP: ACP agent `authenticate` method (agent-advertised auth, e.g.
        // `pi_terminal_login`). Distinct from the WS connection `authenticate`
        // token gate — this runs the method on the host where the agent lives.
        "authenticate_agent" => handle_authenticate_agent(id, &req.payload, acp).await,
        // Paste-back half of the headless browser-auth flow
        // (spec-acp-terminal-auth): the client delivers the failed loopback
        // redirect URL; the host validates loopback-only then replays it.
        "acp_deliver_auth_redirect" => {
            handle_deliver_auth_redirect(id, &req.payload, acp).await
        }
        "send_prompt" => handle_send_prompt(id, &req.payload, acp, relay).await,
        // CAP-2: host-authored durable agent-switch marker (desktop parity
        // with the `acp_record_agent_switch` Tauri command). Persists the
        // `agent_switch` record through `SessionPersistence`, then fans the
        // synthetic live event — ONE durable record per switch.
        "record_agent_switch" => {
            handle_record_agent_switch(id, &req.payload, acp, relay, history_mode).await
        }
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
        // Unknown request types: `not_implemented`. The message names the
        // offending type and nothing else — no stale epic references.
        _ => WsReply::err(
            id,
            WsErrorCode::NotImplemented,
            format!("`{}` is not implemented by this server", req.type_),
        ),
    }
}

/// `delete_session` request payload (CAP-11).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeleteSessionPayload {
    session_id: String,
}

/// `delete_session` — permanently remove a persisted session from the
/// host-owned `SessionPersistence` store (CAP-11; desktop parity with the
/// `acp_history_delete` Tauri command). Mirrors
/// `handle_list_persisted_sessions`'s gating (server history mode + attached
/// persistence, else `unsupported`). The reply data is the typed idempotent
/// delete contract (`{ "deleted": true }` when a record was removed,
/// `{ "deleted": false }` when it was already absent — never a not-found
/// error), so the renderer can treat delete as idempotent without string
/// sniffing. On success the relay forgets any in-memory state for the session
/// and every connected client is told to refetch the index
/// (`chat_history_changed`).
async fn handle_delete_session(
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
    let parsed: DeleteSessionPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed delete_session payload (want sessionId): {e}"),
            )
        }
    };
    let Some(persistence) = relay.persistence() else {
        return WsReply::err(
            id,
            WsErrorCode::Unsupported,
            "persisted history is unavailable",
        );
    };
    match persistence.delete_session(&parsed.session_id).await {
        Ok(()) => {
            relay.forget_session(&parsed.session_id).await;
            broadcast_chat_history_changed(relay);
            WsReply::ok(id, Some(json!({ "deleted": true })))
        }
        Err(crate::acp::session_persistence::SessionPersistenceError::SessionNotFound) => {
            // Typed idempotent delete: the record is already gone — the desired
            // end state holds, reported as `{ deleted: false }` (never a
            // not-found error). Drop stale in-memory relay state too — the
            // record is gone from disk, so a lingering live session would
            // resurrect it on save.
            relay.forget_session(&parsed.session_id).await;
            WsReply::ok(id, Some(json!({ "deleted": false })))
        }
        Err(error) => {
            // Full storage error stays in the host log; the client gets a fixed
            // generic message — the storage error may embed filesystem paths.
            warn!("[ws] delete_session failed: {error}");
            WsReply::err_with_code(
                id,
                "SESSION_DELETE_FAILED",
                "failed to delete persisted session",
            )
        }
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
                    WsReply::err(
                        id,
                        WsErrorCode::Unsupported,
                        "failed to read session payload",
                    )
                }
            }
        }
        None => WsReply::err(id, WsErrorCode::NotFound, "session payload not found"),
    }
}

/// `get_session_payload_tail` — tail-first variant of `get_session_payload`.
/// Fetches only the last `limit` messages + matching tool calls so the
/// renderer can install the recent transcript immediately and lazy-load the
/// full payload on scroll-up. Mirrors `handle_get_session_payload` but calls
/// `session_payload_tail_async`.
async fn handle_get_session_payload_tail(
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
    struct GetSessionPayloadTailRequest {
        session_id: String,
        limit: Option<u32>,
    }
    let parsed: GetSessionPayloadTailRequest = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed get_session_payload_tail payload (want sessionId, limit?): {e}"),
            )
        }
    };
    let limit = parsed.limit.unwrap_or(50).clamp(1, 500) as usize;
    match relay.persistence() {
        Some(persistence) => {
            match persistence
                .session_payload_tail_async(&parsed.session_id, limit)
                .await
            {
                Ok(payload) => {
                    tracing::debug!(
                        target: "termul::web::ws",
                        session_id = %parsed.session_id,
                        messages = payload.messages.len(),
                        "get_session_payload_tail: materialized host tail payload"
                    );
                    ok_with_payload(id, &payload)
                }
                Err(crate::acp::SessionPersistenceError::SessionNotFound) => {
                    WsReply::err(id, WsErrorCode::NotFound, "session payload not found")
                }
                Err(error) => {
                    tracing::warn!(
                        target: "termul::web::ws",
                        session_id = %parsed.session_id,
                        error = %error,
                        "get_session_payload_tail: host tail materialization failed"
                    );
                    WsReply::err(
                        id,
                        WsErrorCode::Unsupported,
                        "failed to read session payload tail",
                    )
                }
            }
        }
        None => WsReply::err(id, WsErrorCode::NotFound, "session payload not found"),
    }
}

/// `record_agent_switch` request payload (CAP-2). Mirrors the Tauri command
/// args and the durable record's payload shape byte-for-byte.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecordAgentSwitchPayload {
    session_id: String,
    from_config_id: String,
    to_config_id: String,
    new_session_id: String,
    summary_text: String,
}

/// `record_agent_switch` — durably record an agent-switch marker (CAP-2).
/// Desktop parity with the `acp_record_agent_switch` Tauri command: the host
/// is the sole author of the marker. Persists the `agent_switch` record
/// through `SessionPersistence` (writer-assigned seq) + flush, then fans the
/// synthetic `acp:agent_switch` event through the manager's sinks. Unknown
/// session → `not_found`; storage failure → `unsupported` (fail closed — no
/// partial state). Boundary logging carries ids only, never the summary.
async fn handle_record_agent_switch(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
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
    let parsed: RecordAgentSwitchPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!(
                    "malformed record_agent_switch payload (want sessionId, fromConfigId, \
                     toConfigId, newSessionId, summaryText): {e}"
                ),
            )
        }
    };
    if parsed.session_id.trim().is_empty() || parsed.to_config_id.trim().is_empty() {
        return WsReply::err(
            id,
            WsErrorCode::Unsupported,
            "sessionId and toConfigId are required",
        );
    }
    let Some(persistence) = relay.persistence() else {
        return WsReply::err(
            id,
            WsErrorCode::Unsupported,
            "persisted history is unavailable",
        );
    };
    // Unknown session fails closed BEFORE any durable write.
    if persistence.metadata(&parsed.session_id).is_err() {
        return WsReply::err(id, WsErrorCode::NotFound, "persisted session not found");
    }
    // Note: the event's agent id resolves inside the manager from the
    // session metadata (the OLD session's runtime agent) — nothing to
    // pre-resolve here.
    let record = crate::acp::session_persistence::AgentSwitchRecord {
        session_id: parsed.session_id.clone(),
        from_config_id: parsed.from_config_id,
        to_config_id: parsed.to_config_id,
        new_session_id: parsed.new_session_id,
        summary_text: parsed.summary_text,
    };
    match acp.record_agent_switch(parsed.session_id.clone(), record).await {
        Ok(()) => {
            tracing::debug!(
                target: "termul::web::ws",
                session_id = %parsed.session_id,
                "record_agent_switch: durable marker recorded"
            );
            WsReply::ok(id, Some(json!({})))
        }
        Err(error) => {
            // A catalog-known session whose writer runtime is gone (a
            // post-restart recovered session: metadata check above passed,
            // but `append_agent_switch` hits SessionNotFound) surfaces as a
            // typed `not_found` so the client can distinguish "unknown
            // session" from a real storage failure.
            if error.contains("session not found")
                || error.contains("not found")
                || error.contains("session writer unavailable")
            {
                return WsReply::err(id, WsErrorCode::NotFound, "persisted session not found");
            }
            // Other failures stay fail-closed with a generic client-facing
            // message: the error string may embed filesystem paths.
            // Ids-only context stays in the host log.
            tracing::warn!(
                target: "termul::web::ws",
                session_id = %parsed.session_id,
                error = %error,
                "record_agent_switch: durable marker write failed"
            );
            WsReply::err(id, WsErrorCode::Unsupported, "failed to record agent switch")
        }
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
            Err(error) => {
                if relay.persistence().is_some_and(|persistence| {
                    matches!(
                        persistence.metadata(&parsed.session_id),
                        Err(crate::acp::SessionPersistenceError::SessionNotFound)
                    )
                }) {
                    return WsReply::err(id, WsErrorCode::NotFound, "session snapshot not found");
                }
                tracing::warn!(
                    target: "termul::web::ws",
                    session_id = %parsed.session_id,
                    error = %error,
                    "recover_session_snapshot: transient snapshot materialization failure"
                );
                return WsReply::err(
                    id,
                    WsErrorCode::AgentCrashed,
                    "session snapshot is temporarily unavailable; retry after reconnect",
                );
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
            persistence
                .last_seq(&parsed.session_id)
                .unwrap_or_else(|error| {
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
/// rejection (`"ACP_TURN_IN_PROGRESS: …"`) → `RateLimited`; agent-side ACP
/// `AuthRequired` (-32000) failures — tagged `"ACP_AUTH_REQUIRED: …"` at the
/// manager boundary, or the bare default `"Authentication required"` message
/// (exact match) for pre-collapsed paths — → `AgentAuthRequired` (Story 7);
/// `"unknown agent: …"` / `"unknown permission request: …"` → `NotFound`;
/// capability-gate failures (`"agent does not support …"`) → `Unsupported`.
/// Unrecognized errors fall back to `NotImplemented` (preserves the human
/// message verbatim).
fn acp_err_to_reply(id: String, err: String) -> WsReply {
    if let Some(code) = map_prompt_error_code(&err) {
        return WsReply::err(id, code, err);
    }
    let code = if err
        .strip_prefix(crate::acp::manager::ACP_AUTH_REQUIRED_PREFIX)
        .is_some_and(|rest| rest.starts_with(": "))
        || err == "Authentication required"
    {
        WsErrorCode::AgentAuthRequired
    } else if err.starts_with("unknown agent") || err.contains("unknown permission request") {
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
    // OQ1: require a non-empty `config.configId` (mirrors `acp_spawn_agent`)
    // so the spawn path derives a stable `config:{config_id}` namespace on web
    // too. Shared guard lives in `acp::config::require_config_id`.
    if let Err(msg) = crate::acp::config::require_config_id(&parsed.config) {
        return WsReply::err(id, WsErrorCode::Unsupported, msg);
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

/// `list_agents` → `AcpManager::list_agent_summaries()` (CAP-11). Reply =
/// `AgentSummary[]` — identity-rich `{ id, name, configId?, namespace?,
/// capabilities }` objects, replacing bare id strings. The only in-repo
/// consumer (`WsAcpTransport.listAgents`) maps `.id`; `listAgentDetails`
/// keeps the full summaries. Desktop parity: `acp_list_agent_details`.
fn handle_list_agents(id: String, acp: &Arc<AcpManager>) -> WsReply {
    let summaries = acp.list_agent_summaries();
    // Boundary log: count only — agent configs/credentials are never logged.
    tracing::info!("[ws] list_agents success agents={}", summaries.len());
    ok_with_payload(id, &summaries)
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
    acp_install: Option<&Arc<crate::acp::install::AcpInstallService>>,
) -> WsReply {
    // Distinct SCREAMING_SNAKE_CASE codes matching the HTTP route
    // (`catalog_api::list`) byte-for-byte (the protocol-level `WsErrorCode`
    // enum is snake_case and collapses these to `Unsupported`, masking the
    // real failure for the renderer). `err_with_code` carries the raw string.
    let parsed: ListAcpCatalogPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err_with_code(
                id,
                "VALIDATION_ERROR",
                format!("malformed list_acp_catalog payload: {e}"),
            )
        }
    };
    let Some(service) = acp_catalog.cloned() else {
        return WsReply::err_with_code(
            id,
            "ACP_CATALOG_UNAVAILABLE",
            "acp catalog store is unavailable",
        );
    };
    match service.list_catalog(parsed.refresh.unwrap_or(false)).await {
        Ok(mut catalog) => {
            // Overlay host-installed state so installed agents report `ready`
            // with their resolved command/args — the host is the single
            // source of truth (web has no renderer persistence).
            if let Some(install) = acp_install {
                let installed = install.installed_agents();
                crate::acp::overlay_installed(&mut catalog, &installed);
            }
            ok_with_payload(id, &catalog)
        }
        Err(error) => WsReply::err_with_code(
            id,
            "CATALOG_LOAD_FAILED",
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
    // Distinct SCREAMING_SNAKE_CASE codes matching the HTTP route
    // (`catalog_api::set_opt_in`) byte-for-byte. A malformed payload is
    // `VALIDATION_ERROR`, a missing store is `ACP_CATALOG_UNAVAILABLE`, and a
    // persistence failure is `ACP_CATALOG_OPT_IN_FAILED` (NOT collapsed to
    // `Unsupported`, which the renderer could not distinguish from a genuine
    // catalog-load failure).
    let parsed: SetCatalogOptInPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err_with_code(
                id,
                "VALIDATION_ERROR",
                format!("malformed set_catalog_opt_in payload (want enabled): {e}"),
            )
        }
    };
    let Some(service) = acp_catalog.cloned() else {
        return WsReply::err_with_code(
            id,
            "ACP_CATALOG_UNAVAILABLE",
            "acp catalog store is unavailable",
        );
    };
    match service.set_opt_in(parsed.enabled) {
        Ok(()) => WsReply::ok(id, Some(json!({}))),
        Err(error) => WsReply::err_with_code(
            id,
            "ACP_CATALOG_OPT_IN_FAILED",
            format!("opt-in persistence failed: {error}"),
        ),
    }
}

// --- CAP-6 / Story 9: ACP install WS handler --------------------------------

/// `install_acp_agent` WS request payload. `deny_unknown_fields` rejects an
/// over-serialized payload loudly at the host boundary (the request is
/// `{ agentId }` only — never carries archive URLs, commands, executable
/// paths, or args; the host resolves everything from the trusted catalog).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstallAcpAgentPayload {
    agent_id: String,
}

/// `install_acp_agent` WS request handler. Mirrors the desktop
/// `#[tauri::command] acp_install_agent` + HTTP `POST /acp/install` handlers.
/// Degrade-mode (`acp_install: None`) returns `ACP_INSTALL_UNAVAILABLE`. All
/// errors carry SCREAMING_SNAKE_CASE codes byte-identical to the other
/// transports via `WsReply::err_with_code` (the protocol-level `WsErrorCode`
/// enum is snake_case, so the install codes use the raw-string constructor).
async fn handle_install_acp_agent(
    id: String,
    payload: &Value,
    acp_install: Option<&Arc<crate::acp::install::AcpInstallService>>,
) -> WsReply {
    use crate::acp::install::code;
    let parsed: InstallAcpAgentPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err_with_code(
                id,
                code::VALIDATION_ERROR,
                format!("malformed install_acp_agent payload (want agentId): {e}"),
            )
        }
    };
    let Some(service) = acp_install.cloned() else {
        return WsReply::err_with_code(
            id,
            code::ACP_INSTALL_UNAVAILABLE,
            "acp install store is unavailable",
        );
    };
    match service.install_by_id(&parsed.agent_id).await {
        Ok(outcome) => ok_with_payload(id, &outcome),
        Err(error) => WsReply::err_with_code(id, error.code(), error.message),
    }
}

// --- Issue #613: server-side generic key-value store -------------------------

/// Per-value serialized size cap for `store_write` (CAP-11). The whole-file
/// 10 MiB cap inside `WebStore::write` still applies; this bound rejects a
/// single oversized value BEFORE it reaches the store so the on-disk file
/// stays untouched.
const STORE_VALUE_MAX_BYTES: usize = 256 * 1024;

/// Shared `store_*` key validation (CAP-11): an empty or whitespace-only key
/// is a `VALIDATION_ERROR`; the connection stays open and the store is never
/// touched. Returns the error reply to send, or `None` when the key is valid.
fn validate_store_key(id: &str, key: &str) -> Option<WsReply> {
    if key.trim().is_empty() {
        return Some(WsReply::err_with_code(
            id,
            "VALIDATION_ERROR",
            "key must be non-empty",
        ));
    }
    if key.len() > 1024 {
        return Some(WsReply::err_with_code(
            id,
            "VALIDATION_ERROR",
            "key too long",
        ));
    }
    None
}

/// `store_read` WS request payload. `deny_unknown_fields` rejects an
/// over-serialized payload loudly at the host boundary.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoreReadPayload {
    key: String,
}

/// `store_write` WS request payload. `value` is any JSON value.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoreWritePayload {
    key: String,
    value: Value,
    #[serde(default)]
    expected: Option<Value>,
}

/// `store_delete` WS request payload.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoreDeletePayload {
    key: String,
}

/// `store_read` → `WebStore::read`. Reply = `{ value: <json | null> }`.
/// Degrade-mode (`store: None`) returns `STORE_UNAVAILABLE`.
async fn handle_store_read(id: String, payload: &Value, store: Option<&Arc<WebStore>>) -> WsReply {
    let parsed: StoreReadPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err_with_code(
                id,
                "VALIDATION_ERROR",
                format!("malformed store_read payload (want key): {e}"),
            )
        }
    };
    let Some(store) = store.cloned() else {
        return WsReply::err_with_code(id, "STORE_UNAVAILABLE", "server store is unavailable");
    };
    if let Some(reply) = validate_store_key(&id, &parsed.key) {
        return reply;
    }
    let result = tokio::task::spawn_blocking(move || store.read(&parsed.key)).await;
    match result {
        Ok(Ok(value)) => WsReply::ok(id, Some(json!({ "value": value }))),
        Ok(Err(e)) => WsReply::err_with_code(id, "STORE_UNAVAILABLE", e.to_string()),
        Err(join_err) => {
            tracing::warn!("store_read task failed: {join_err}");
            WsReply::err_with_code(
                id,
                "STORE_UNAVAILABLE",
                format!("store read task failed: {join_err}"),
            )
        }
    }
}

/// `store_write` → `WebStore::write` (atomic replace). Reply = `{}`.
async fn handle_store_write(id: String, payload: &Value, store: Option<&Arc<WebStore>>) -> WsReply {
    let parsed: StoreWritePayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err_with_code(
                id,
                "VALIDATION_ERROR",
                format!("malformed store_write payload (want key + value): {e}"),
            )
        }
    };
    let Some(store) = store.cloned() else {
        return WsReply::err_with_code(id, "STORE_UNAVAILABLE", "server store is unavailable");
    };
    if let Some(reply) = validate_store_key(&id, &parsed.key) {
        return reply;
    }
    // CAP-11: reject an oversized value before it reaches the store — the
    // on-disk file stays untouched. Measured on the serialized JSON bytes.
    let value_len = match serde_json::to_vec(&parsed.value) {
        Ok(bytes) => bytes.len(),
        Err(e) => {
            return WsReply::err_with_code(
                id,
                "VALIDATION_ERROR",
                format!("unserializable store value: {e}"),
            )
        }
    };
    if value_len > STORE_VALUE_MAX_BYTES {
        return WsReply::err_with_code(
            id,
            "STORE_VALUE_TOO_LARGE",
            format!("value is {value_len} bytes (max {STORE_VALUE_MAX_BYTES})"),
        );
    }
    let store_clone = store.clone();
    let result = tokio::task::spawn_blocking(move || {
        store_clone.write(&parsed.key, parsed.value, parsed.expected)
    })
    .await;
    match result {
        Ok(Ok(true)) => WsReply::ok(id, Some(json!({}))),
        Ok(Ok(false)) => WsReply::err_with_code(
            id,
            "STORE_CAS_FAILED",
            "store write rejected: value changed concurrently",
        ),
        Ok(Err(error)) => {
            tracing::warn!("store_write failed: {error}");
            WsReply::err_with_code(
                id,
                "STORE_WRITE_FAILED",
                format!("store write failed: {error}"),
            )
        }
        Err(join_err) => {
            tracing::warn!("store_write task failed: {join_err}");
            WsReply::err_with_code(id, "STORE_WRITE_FAILED", format!("task failed: {join_err}"))
        }
    }
}

/// `store_delete` → `WebStore::delete`. Reply = `{ existed: bool }`.
async fn handle_store_delete(
    id: String,
    payload: &Value,
    store: Option<&Arc<WebStore>>,
) -> WsReply {
    let parsed: StoreDeletePayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err_with_code(
                id,
                "VALIDATION_ERROR",
                format!("malformed store_delete payload (want key): {e}"),
            )
        }
    };
    let Some(store) = store.cloned() else {
        return WsReply::err_with_code(id, "STORE_UNAVAILABLE", "server store is unavailable");
    };
    if let Some(reply) = validate_store_key(&id, &parsed.key) {
        return reply;
    }
    let store_clone = store.clone();
    let result = tokio::task::spawn_blocking(move || store_clone.delete(&parsed.key)).await;
    match result {
        Ok(Ok(existed)) => WsReply::ok(id, Some(json!({ "existed": existed }))),
        Ok(Err(error)) => {
            tracing::warn!("store_delete failed: {error}");
            WsReply::err_with_code(
                id,
                "STORE_DELETE_FAILED",
                format!("store delete failed: {error}"),
            )
        }
        Err(join_err) => {
            tracing::warn!("store_delete task failed: {join_err}");
            WsReply::err_with_code(
                id,
                "STORE_DELETE_FAILED",
                format!("task failed: {join_err}"),
            )
        }
    }
}

/// `authenticate_agent` → `AcpManager::authenticate(agent_id, method_id)`.
/// Runs the ACP agent-advertised `authenticate` method (e.g.
/// `pi_terminal_login`) on the host where the agent process runs. Distinct
/// from the WS connection `authenticate` token gate — this is the agent
/// method, not the relay handshake. Mirrors the desktop `acp_authenticate`
/// Tauri command (both call `AcpManager::authenticate`). The provider owns
/// the login UX (often opens its own browser); Termul never invents a
/// redirect URL or stores credentials.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthenticateAgentPayload {
    agent_id: crate::acp::AgentId,
    method_id: String,
}

async fn handle_authenticate_agent(id: String, payload: &Value, acp: &Arc<AcpManager>) -> WsReply {
    let parsed: AuthenticateAgentPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err_with_code(
                id,
                "VALIDATION_ERROR",
                format!("malformed authenticate_agent payload (want agentId, methodId): {e}"),
            )
        }
    };
    debug!(
        target: "termul::web::ws",
        agent = %parsed.agent_id,
        method = %parsed.method_id,
        "authenticate_agent: invoking agent auth method"
    );
    // `AcpManager::authenticate` takes `method_id` by value, so keep a clone
    // for the failure log (the debug! above borrows before the move).
    let method_id = parsed.method_id.clone();
    match acp.authenticate(&parsed.agent_id, parsed.method_id).await {
        Ok(()) => WsReply::ok(id, Some(json!({}))),
        Err(e) => {
            warn!(
                target: "termul::web::ws",
                agent = %parsed.agent_id,
                method = %method_id,
                error = %e,
                "authenticate_agent: agent auth failed"
            );
            WsReply::err_with_code(id, "AUTHENTICATE_FAILED", e)
        }
    }
}

/// `acp_deliver_auth_redirect` → `AcpManager::deliver_auth_redirect(agent_id, url)`.
///
/// The paste-back half of the headless browser-auth flow
/// (spec-acp-terminal-auth): the web client collects the failed `127.0.0.1`
/// redirect URL from the user's own browser and delivers it here. The manager
/// validates it is http(s) AND loopback-only (SSRF guard — a non-loopback URL
/// is rejected before any outbound request), then GETs it so the agent's own
/// callback listener completes the flow. Mirrors the desktop
/// `acp_auth_deliver_redirect` Tauri command (both call
/// `AcpManager::deliver_auth_redirect`). Success payload `{status}` is the
/// listener's HTTP status code.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeliverAuthRedirectPayload {
    agent_id: crate::acp::AgentId,
    url: String,
}

async fn handle_deliver_auth_redirect(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
) -> WsReply {
    let parsed: DeliverAuthRedirectPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err_with_code(
                id,
                "VALIDATION_ERROR",
                format!("malformed acp_deliver_auth_redirect payload (want agentId, url): {e}"),
            )
        }
    };
    // Never log the URL — it carries OAuth state. The manager logs host+port.
    debug!(
        target: "termul::web::ws",
        agent = %parsed.agent_id,
        "acp_deliver_auth_redirect: replaying pasted redirect"
    );
    match acp
        .deliver_auth_redirect(&parsed.agent_id, parsed.url)
        .await
    {
        Ok(status) => WsReply::ok(id, Some(json!({ "status": status }))),
        Err(e) => {
            warn!(
                target: "termul::web::ws",
                agent = %parsed.agent_id,
                error = %e,
                "acp_deliver_auth_redirect: replay failed"
            );
            WsReply::err_with_code(id, "AUTH_REDIRECT_FAILED", e)
        }
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
    /// Story 8: an ephemeral session the client may later promote to durable
    /// (`promote_session`) — keeps the host plan-MCP injection it would
    /// otherwise skip. Ignored for non-ephemeral creates; unknown to older
    /// servers (additive).
    #[serde(default)]
    promotable: bool,
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
                promotable: parsed.promotable,
                ..Default::default()
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
/// "persistence failed" variant (the 11 stable codes are mirrored in TS).
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
        if let (Some(file_registry), Some(path), Some(old_default)) =
            (registry_persistence, projects_file, persisted_old_default)
        {
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
/// `add_project` WS request payload (Option B). Mirrors the
/// `POST /projects` body + the desktop `addProject` renderer store action.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AddProjectPayload {
    id: String,
    name: String,
    path: String,
    color: String,
    #[serde(default)]
    is_archived: bool,
}

/// `update_project` WS request payload (Option B). All fields optional (partial
/// update). Mirrors `PUT /projects/{id}`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateProjectPayload {
    project_id: String,
    name: Option<String>,
    color: Option<String>,
    is_archived: Option<bool>,
}

/// `remove_project` WS request payload (Option B). Mirrors
/// `DELETE /projects/{id}`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoveProjectPayload {
    project_id: String,
}

/// `add_project` WS handler — create / upsert a VFS root (Option B).
///
/// Validates + canonicalizes the path, upserts into `FileProjectRegistry`
/// (VPS, with rollback) + the in-memory `ProjectRegistry`, and broadcasts
/// `projects_changed`. Desktop-hosted mode has no file registry — it upserts
/// the in-memory mirror + broadcasts only.
#[allow(clippy::too_many_arguments)]
async fn handle_add_project(
    id: String,
    payload: &Value,
    relay: &Arc<WsRelaySink>,
    registry: &Arc<ProjectRegistry>,
    registry_persistence: Option<&Arc<parking_lot::Mutex<FileProjectRegistry>>>,
    projects_file: Option<&PathBuf>,
) -> WsReply {
    let parsed: AddProjectPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            warn!(
                target: "termul::web::ws",
                error = %e,
                "add_project: malformed payload (want id + name + path + color)"
            );
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed add_project payload: {e}"),
            );
        }
    };
    let mut root = crate::acp::VfsRoot {
        id: parsed.id.clone(),
        name: parsed.name.clone(),
        path: std::path::PathBuf::from(parsed.path.clone()),
        color: parsed.color.clone(),
        is_archived: parsed.is_archived,
        mcp_servers: Vec::new(),
    };
    // VPS persistence (with rollback). Desktop-hosted mode skips this.
    if let (Some(file_registry), Some(path)) = (registry_persistence, projects_file) {
        let persistence_result = {
            let mut file_registry = file_registry.lock();
            let old_root = file_registry
                .roots()
                .iter()
                .find(|r| r.id == parsed.id)
                .cloned();
            // F-020: an upsert that re-registers a project must not wipe its
            // file-side MCP config — carry the existing root's mcp_servers.
            if let Some(old) = &old_root {
                root.mcp_servers = old.mcp_servers.clone();
            }
            match file_registry.upsert_root(root.clone()) {
                Ok(()) => match file_registry.save_atomic(path) {
                    Ok(()) => Ok(old_root),
                    Err(error) => {
                        if let Some(old) = old_root {
                            let _ = file_registry.upsert_root(old);
                        } else {
                            let _ = file_registry.remove_root(&parsed.id);
                        }
                        Err(error)
                    }
                },
                Err(error) => Err(error),
            }
        };
        if let Err(error) = persistence_result {
            error!(
                target: "termul::web::ws",
                project_id = %parsed.id,
                error = %error,
                "add_project: persistence failed (rolled back)"
            );
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("failed to persist project: {error}"),
            );
        }
    }
    // Mirror into the in-memory registry. F-020: `is_default` reflects the
    // CURRENT default (an upsert of the default keeps its flag; an archived
    // default is cleared by `upsert` itself — P4). `upsert` recomputes the
    // flag internally regardless of what is passed here.
    let summary = crate::web::project_registry::ProjectSummary {
        id: parsed.id.clone(),
        name: parsed.name,
        color: parsed.color,
        path: Some(parsed.path),
        is_archived: parsed.is_archived,
        is_default: !parsed.is_archived
            && registry.snapshot().default_project_id.as_deref() == Some(parsed.id.as_str()),
    };
    registry.upsert(summary.clone());
    broadcast_projects_changed(relay, None);
    info!(
        target: "termul::web::ws",
        project_id = %summary.id,
        "add_project: project upserted + broadcast"
    );
    WsReply::ok(id, Some(json!({ "project": summary })))
}

/// `update_project` WS handler — patch a project's display fields (Option B).
#[allow(clippy::too_many_arguments)]
async fn handle_update_project(
    id: String,
    payload: &Value,
    relay: &Arc<WsRelaySink>,
    registry: &Arc<ProjectRegistry>,
    registry_persistence: Option<&Arc<parking_lot::Mutex<FileProjectRegistry>>>,
    projects_file: Option<&PathBuf>,
) -> WsReply {
    let parsed: UpdateProjectPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            warn!(
                target: "termul::web::ws",
                error = %e,
                "update_project: malformed payload (want projectId)"
            );
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed update_project payload: {e}"),
            );
        }
    };
    // VPS persistence (with rollback).
    if let (Some(file_registry), Some(path)) = (registry_persistence, projects_file) {
        let persistence_result = {
            let mut file_registry = file_registry.lock();
            let old_root = file_registry
                .roots()
                .iter()
                .find(|r| r.id == parsed.project_id)
                .cloned();
            if !file_registry.update_root(
                &parsed.project_id,
                parsed.name.clone(),
                parsed.color.clone(),
                parsed.is_archived,
            ) {
                None
            } else {
                match file_registry.save_atomic(path) {
                    Ok(()) => Some(Ok(old_root)),
                    Err(error) => {
                        if let Some(old) = old_root {
                            let _ = file_registry.upsert_root(old);
                        }
                        Some(Err(error))
                    }
                }
            }
        };
        match persistence_result {
            None => {
                warn!(
                    target: "termul::web::ws",
                    project_id = %parsed.project_id,
                    "update_project: project not found"
                );
                return WsReply::err(
                    id,
                    WsErrorCode::NotFound,
                    format!("project '{}' not found", parsed.project_id),
                );
            }
            Some(Err(error)) => {
                error!(
                    target: "termul::web::ws",
                    project_id = %parsed.project_id,
                    error = %error,
                    "update_project: persistence failed (rolled back)"
                );
                return WsReply::err(
                    id,
                    WsErrorCode::Unsupported,
                    format!("failed to persist project: {error}"),
                );
            }
            Some(_) => {}
        }
    }
    // Mirror into the in-memory registry.
    if !registry.update(
        &parsed.project_id,
        parsed.name,
        parsed.color,
        parsed.is_archived,
    ) {
        warn!(
            target: "termul::web::ws",
            project_id = %parsed.project_id,
            "update_project: project not found in in-memory registry"
        );
        return WsReply::err(
            id,
            WsErrorCode::NotFound,
            format!("project '{}' not found", parsed.project_id),
        );
    }
    broadcast_projects_changed(relay, None);
    info!(
        target: "termul::web::ws",
        project_id = %parsed.project_id,
        "update_project: project updated + broadcast"
    );
    WsReply::ok(id, Some(json!({})))
}

/// `remove_project` WS handler — remove a VFS root (Option B).
#[allow(clippy::too_many_arguments)]
async fn handle_remove_project(
    id: String,
    payload: &Value,
    relay: &Arc<WsRelaySink>,
    registry: &Arc<ProjectRegistry>,
    registry_persistence: Option<&Arc<parking_lot::Mutex<FileProjectRegistry>>>,
    projects_file: Option<&PathBuf>,
) -> WsReply {
    let parsed: RemoveProjectPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            warn!(
                target: "termul::web::ws",
                error = %e,
                "remove_project: malformed payload (want projectId)"
            );
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed remove_project payload: {e}"),
            );
        }
    };
    // VPS persistence (with rollback).
    if let (Some(file_registry), Some(path)) = (registry_persistence, projects_file) {
        let persistence_result = {
            let mut file_registry = file_registry.lock();
            let old_root = file_registry
                .roots()
                .iter()
                .find(|r| r.id == parsed.project_id)
                .cloned();
            if !file_registry.remove_root(&parsed.project_id) {
                None
            } else {
                match file_registry.save_atomic(path) {
                    Ok(()) => Some(Ok(old_root)),
                    Err(error) => {
                        if let Some(old) = old_root {
                            let _ = file_registry.upsert_root(old);
                        }
                        Some(Err(error))
                    }
                }
            }
        };
        match persistence_result {
            None => {
                warn!(
                    target: "termul::web::ws",
                    project_id = %parsed.project_id,
                    "remove_project: project not found"
                );
                return WsReply::err(
                    id,
                    WsErrorCode::NotFound,
                    format!("project '{}' not found", parsed.project_id),
                );
            }
            Some(Err(error)) => {
                error!(
                    target: "termul::web::ws",
                    project_id = %parsed.project_id,
                    error = %error,
                    "remove_project: persistence failed (rolled back)"
                );
                return WsReply::err(
                    id,
                    WsErrorCode::Unsupported,
                    format!("failed to persist project removal: {error}"),
                );
            }
            Some(_) => {}
        }
    }
    // Mirror into the in-memory registry.
    registry.remove(&parsed.project_id);
    broadcast_projects_changed(relay, None);
    info!(
        target: "termul::web::ws",
        project_id = %parsed.project_id,
        "remove_project: project removed + broadcast"
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
                        ..Default::default()
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

/// Frozen replay contract 1 (story 3): history reconstruction belongs to
/// `get_session_payload` / `recover_session_snapshot`; `resume_session` NEVER
/// emits replay events or a replay snapshot. Inject the explicit
/// `"replaySnapshot": null` marker into the ok payload at the WS boundary so
/// clients get an unambiguous signal — the shared `SessionReopenOutcome`
/// struct itself stays untouched for story 3.
fn resume_ok_payload(id: String, outcome: &crate::acp::manager::SessionReopenOutcome) -> WsReply {
    let mut value = serde_json::to_value(outcome).unwrap_or_else(|e| {
        warn!("[ws] failed to serialize resume_session outcome: {e}");
        json!({})
    });
    if let Some(obj) = value.as_object_mut() {
        obj.insert("replaySnapshot".to_string(), Value::Null);
    }
    WsReply::ok(id, Some(value))
}

/// `resume_session` → `AcpManager::resume_session(agent_id, session_id, cwd)`.
/// Reply payload = the camelCase reopen option snapshot + the explicit
/// `"replaySnapshot": null` marker (CAP-11; see [`resume_ok_payload`]).
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
            resume_ok_payload(id, &outcome)
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

/// `promote_session` WS request payload (story 8). Mirrors
/// `close_session`'s `{agentId, sessionId}` shape.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromoteSessionPayload {
    agent_id: crate::acp::AgentId,
    session_id: crate::acp::SessionId,
}

/// `promote_session` → `AcpManager::promote_session(agent_id, session_id)`.
/// Story 8 (ephemeral warm pool): promotes a backend-ephemeral warm-pool
/// session to durable — the driver registers the persistence metadata captured
/// at `session/new` and clears the ephemeral mark, so the first real prompt
/// persists. Idempotent for already-durable sessions; `not_found` for sessions
/// the driver never created.
async fn handle_promote_session(id: String, payload: &Value, acp: &Arc<AcpManager>) -> WsReply {
    let parsed: PromoteSessionPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(
                target: "termul::web::ws",
                error = %e,
                "promote_session: malformed payload"
            );
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed promote_session payload (want agentId, sessionId): {e}"),
            );
        }
    };
    let session_id = parsed.session_id.clone();
    match acp
        .promote_session(&parsed.agent_id, parsed.session_id)
        .await
    {
        Ok(()) => {
            tracing::info!(
                target: "termul::web::ws",
                agent_id = %parsed.agent_id,
                session_id = %session_id,
                "promote_session: warm-pool session promoted to durable"
            );
            WsReply::ok(id, Some(json!({})))
        }
        // An unknown session id is a lookup failure, not an unsupported call
        // (mirrors the `unknown agent` mapping in `acp_err_to_reply`).
        Err(e) if e.starts_with("unknown session") => {
            tracing::warn!(
                target: "termul::web::ws",
                agent_id = %parsed.agent_id,
                session_id = %session_id,
                error = %e,
                "promote_session: unknown session"
            );
            WsReply::err(id, WsErrorCode::NotFound, e)
        }
        Err(e) => {
            tracing::warn!(
                target: "termul::web::ws",
                agent_id = %parsed.agent_id,
                session_id = %session_id,
                error = %e,
                "promote_session: promotion failed"
            );
            acp_err_to_reply(id, e)
        }
    }
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

/// Persist metadata for an agent-owned session returned by `session/list`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterDiscoveredSessionPayload {
    session_id: String,
    agent_id: crate::acp::AgentId,
    cwd: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    updated_at: Option<u64>,
    #[serde(default)]
    project_id: Option<String>,
}

async fn handle_register_discovered_session(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
    relay: &Arc<WsRelaySink>,
) -> WsReply {
    let parsed: RegisterDiscoveredSessionPayload = match serde_json::from_value(payload.clone()) {
        Ok(parsed) => parsed,
        Err(error) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!(
                    "malformed register_discovered_session payload (want sessionId, agentId, cwd): {error}"
                ),
            )
        }
    };
    if parsed.session_id.trim().is_empty() || parsed.cwd.trim().is_empty() {
        return WsReply::err(
            id,
            WsErrorCode::Unsupported,
            "sessionId and cwd are required",
        );
    }
    let Some(persistence) = relay.persistence() else {
        return WsReply::err(
            id,
            WsErrorCode::Unsupported,
            "session persistence unavailable",
        );
    };
    let stable_agent_namespace = match acp.stable_agent_namespace(&parsed.agent_id) {
        Ok(namespace) => namespace,
        Err(error) => return acp_err_to_reply(id, error),
    };
    match persistence
        .register_discovered_session(
            crate::acp::SessionRegistration {
                session_id: parsed.session_id,
                stable_agent_namespace,
                runtime_agent_id: Some(parsed.agent_id.0),
                project_id: parsed.project_id,
                cwd: parsed.cwd.into(),
                ..Default::default()
            },
            parsed.title,
            parsed.updated_at,
        )
        .await
    {
        Ok(metadata) => {
            tracing::info!(
                target: "termul::web::ws",
                session_id = %metadata.session_id,
                "register_discovered_session: metadata promoted"
            );
            ok_with_payload(id, &crate::acp::SessionIndexEntry::from(&metadata))
        }
        Err(error) => {
            tracing::warn!(
                target: "termul::web::ws",
                error = %error,
                "register_discovered_session: persistence failed"
            );
            WsReply::err(
                id,
                WsErrorCode::Unsupported,
                "failed to persist discovered session metadata",
            )
        }
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
    /// Display-side content persisted as the durable `user_prompt` record in
    /// place of `content`/`text` (spec-agent-switch-separator-redesign): the
    /// switch handoff wires `summary + --- + draft` to the agent but only the
    /// draft belongs in the replayed transcript. Absent → the wire content is
    /// persisted verbatim.
    #[serde(default)]
    display_content: Option<Vec<agent_client_protocol::schema::v1::ContentBlock>>,
}

struct AcceptedSendPrompt {
    id: String,
    started: crate::acp::manager::StartedPrompt,
    claim: PromptClaim,
}

struct PromptClaim {
    relay: Arc<WsRelaySink>,
    session_id: String,
    turn_id: Option<String>,
    armed: bool,
}

impl PromptClaim {
    fn complete(mut self) {
        if let Some(turn_id) = self.turn_id.as_deref() {
            self.relay
                .turn_watermark()
                .record_completed(&self.session_id, turn_id);
        } else {
            self.relay
                .turn_watermark()
                .release_claim(&self.session_id, None);
        }
        self.armed = false;
    }
}

impl Drop for PromptClaim {
    fn drop(&mut self) {
        if self.armed {
            self.relay
                .turn_watermark()
                .release_claim(&self.session_id, self.turn_id.as_deref());
        }
    }
}

// clippy 1.98 (`result_large_err`): `WsReply` is ≥128 bytes — it carries the
// full reply envelope. It is the error currency of every WS handler here and
// is consumed immediately by the enclosing send path; boxing would add an
// allocation per WS reply and ripple through all call sites for no functional
// gain. Allowed pending a dedicated WsReply refactor.
#[allow(clippy::result_large_err)]
async fn accept_send_prompt(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
    relay: &Arc<WsRelaySink>,
) -> Result<AcceptedSendPrompt, WsReply> {
    let parsed: SendPromptPayload = serde_json::from_value(payload.clone()).map_err(|error| {
        WsReply::err(
            id.clone(),
            WsErrorCode::Unsupported,
            format!("malformed send_prompt payload (want agentId, sessionId, text|content, turnId?): {error}"),
        )
    })?;
    let content = match (parsed.content, parsed.text) {
        (Some(blocks), _) if !blocks.is_empty() => blocks,
        (_, Some(text)) if !text.trim().is_empty() => {
            vec![agent_client_protocol::schema::v1::ContentBlock::Text(
                agent_client_protocol::schema::v1::TextContent::new(text),
            )]
        }
        _ => {
            return Err(WsReply::err(
                id,
                WsErrorCode::Unsupported,
                "send_prompt requires non-empty `text` or `content`",
            ))
        }
    };

    match acp
        .owns_session(&parsed.agent_id, parsed.session_id.clone())
        .await
    {
        Ok(true) => {}
        Ok(false) => {
            return Err(WsReply::err(
                id,
                WsErrorCode::NotFound,
                "session does not belong to the supplied live agent",
            ))
        }
        Err(error) => return Err(acp_err_to_reply(id, error)),
    }

    match relay
        .turn_watermark()
        .claim_turn(parsed.session_id.0.as_str(), parsed.turn_id.as_deref())
    {
        TurnClaim::Claimed => {}
        TurnClaim::Completed => {
            return Err(WsReply::err(
                id,
                WsErrorCode::Stale,
                "this turn already completed (stale turn-id)",
            ))
        }
        TurnClaim::DuplicateInFlight | TurnClaim::Busy => {
            return Err(WsReply::err(
                id,
                WsErrorCode::RateLimited,
                "a prompt turn is already in progress",
            ))
        }
    }
    let claim = PromptClaim {
        relay: Arc::clone(relay),
        session_id: parsed.session_id.0.clone(),
        turn_id: parsed.turn_id.clone(),
        armed: true,
    };

    let ephemeral = acp
        .is_ephemeral_session(&parsed.agent_id, parsed.session_id.clone())
        .await
        .map_err(|error| acp_err_to_reply(id.clone(), error))?;
    // Display-side override (spec-agent-switch-separator-redesign): the
    // durable `user_prompt` records the pending draft, not the wire framing
    // (handoff summary + `---`) when the caller supplies displayContent.
    // Empty display_content = no override (a zero-block record would replay
    // as a ghost row and hide the turn).
    let persisted_content = parsed
        .display_content
        .clone()
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| content.clone());
    let prompt_payload = json!({
        "agentId": parsed.agent_id.clone(),
        "sessionId": parsed.session_id.clone(),
        "turnId": parsed.turn_id.clone(),
        "content": persisted_content,
    });
    if !ephemeral {
        relay
            .persist_user_prompt(parsed.session_id.0.as_str(), prompt_payload)
            .await
            .map_err(|error| {
                WsReply::err(
                    id.clone(),
                    WsErrorCode::NotImplemented,
                    format!("failed to persist accepted prompt: {error}"),
                )
            })?;
    }

    let started = acp
        .start_prompt(&parsed.agent_id, parsed.session_id, content, parsed.turn_id)
        .await
        .map_err(|error| acp_err_to_reply(id.clone(), error))?;
    Ok(AcceptedSendPrompt { id, started, claim })
}

async fn complete_send_prompt(accepted: AcceptedSendPrompt, acp: &Arc<AcpManager>) -> WsReply {
    let AcceptedSendPrompt { id, started, claim } = accepted;
    match acp.wait_prompt(started).await {
        Ok(stop_reason) => {
            claim.complete();
            ok_with_payload(id, &stop_reason)
        }
        Err(error) => acp_err_to_reply(id, error),
    }
}

async fn handle_send_prompt(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
    relay: &Arc<WsRelaySink>,
) -> WsReply {
    match accept_send_prompt(id, payload, acp, relay).await {
        Ok(accepted) => complete_send_prompt(accepted, acp).await,
        Err(reply) => reply,
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

    // Story 7: subscribe is a READ path. The session must already be known —
    // live in the relay map (events emitted, incl. ephemeral never-persisted
    // sessions) or present in the persistence catalog (finalized sessions
    // replay from disk). Unknown ids get `not_found` (parity with
    // `get_session_payload`) instead of a silent `{replayed: 0}` success.
    // `WsRelaySink::subscribe` performs the existence validation and the
    // subscription registration under the SAME `sessions` lock
    // `forget_session` removes under, so a concurrently removed session
    // cannot slip a subscription through the check→register gap (TOCTOU) —
    // both the live-only and cursor paths surface `ReplayResult::NotFound`.
    // The durable writer is deliberately NOT reinstalled here or in the sink:
    // `reopen_writer` flips the persisted status Closed→Active, bumps
    // `last_activity_at`, and rewrites the on-disk index — that mutation
    // belongs to the manager's `session/load` / `session/resume` paths (flip
    // on resume/prompt only, never on reads).

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
        ReplayResult::NotFound => {
            // Durable failure record for the desktop log sink (ws.rs runs on
            // both transports; only `log` lands in the desktop file sink).
            // Structured, no credentials, no ACP error text; the session id
            // is redacted per `logging::redact_session_id`.
            log::warn!(
                "[ws] subscribe failed failure=not_found session_id={}",
                crate::logging::redact_session_id(&parsed.session_id)
            );
            WsReply::err(id, WsErrorCode::NotFound, "session not found")
        }
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
mod tests;
