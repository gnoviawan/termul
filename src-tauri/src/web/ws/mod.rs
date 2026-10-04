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

mod agents;
mod dispatch;
mod lifecycle;
mod projects;
mod prompts;
mod relay;
mod sessions;
mod store;
mod subscribe;

// Handler submodules expose their items as `pub(super)`; these private
// glob re-exports keep bare-name lookups working for sibling submodules and
// for `tests.rs`' `use super::*` without widening visibility past `ws`.
use agents::*;
use dispatch::*;
use lifecycle::*;
use projects::*;
use prompts::*;
use relay::*;
use sessions::*;
use store::*;
use subscribe::*;

// The wire-contract `pub` surface stays reachable at `web::ws::*`.
pub use relay::{ws_upgrade, AUTH_REQUIRED_TYPE, WS_BATCH_TYPE};

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
    /// `session/load` / `session/resume` targeted a session owned by a
    /// DIFFERENT live agent with a turn in flight (issue #837 split-brain
    /// guard). Additive: receivers that ignore unknown codes stay compatible.
    SessionOwnedByOther,
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
            Self::SessionOwnedByOther => "session_owned_by_other",
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

/// Cheaply extract the `type` field of a client WS text frame (CAP-3 control
/// signals). Returns `None` for non-JSON or frames without a string `type`.
/// The read task uses this to recognize id-less `background`/`foreground`
/// lifecycle frames before the strict `WsRequest` parse (which requires `id`).
pub(super) fn peer_frame_type(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    value.get("type")?.as_str().map(str::to_owned)
}

/// Epoch-millis timestamp for the keepalive watchdog. Uses `SystemTime` (not
/// `Instant`) so it fits an `AtomicU64`; clock skew inside one process over a
/// ~minute window is negligible, and `saturating_sub` keeps the compare safe
/// even if the clock jumps backwards.
pub(super) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
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
pub(super) fn acp_err_to_reply(id: String, err: String) -> WsReply {
    if let Some(code) = map_prompt_error_code(&err) {
        return WsReply::err(id, code, err);
    }
    // Issue #837 split-brain guard: the manager tags a rejected reopen with
    // `ACP_SESSION_OWNED_BY_OTHER` when the session belongs to a different
    // live agent mid-turn.
    if err.starts_with(crate::acp::manager::ACP_SESSION_OWNED_BY_OTHER) {
        return WsReply::err(id, WsErrorCode::SessionOwnedByOther, err);
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
pub(super) fn ok_with_payload<T: serde::Serialize>(id: String, value: &T) -> WsReply {
    match serde_json::to_value(value) {
        Ok(v) => WsReply::ok(id, Some(v)),
        Err(e) => WsReply::err(
            id,
            WsErrorCode::Unsupported,
            format!("failed to serialize reply payload: {e}"),
        ),
    }
}

#[cfg(test)]
mod tests;
