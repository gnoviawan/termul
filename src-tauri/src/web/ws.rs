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

use std::sync::Arc;

use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tracing::warn;

use crate::acp::config::AgentConfig;
use crate::acp::AcpManager;
use crate::web::sink::{ClientId, ReplayResult, WsRelaySink};

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

/// The 9 stable `err.code` machine strings (AC2). Mirrors the TS
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
    OS_FULFILLED_CAPS
        .iter()
        .copied()
        .any(|entry| entry == cap || entry.ends_with("/*") && cap.starts_with(&entry[..entry.len() - 1]))
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
/// WS relay sink. Typed struct (preferred over tuple state past 2 fields).
#[derive(Clone)]
pub struct AppState {
    /// The ACP manager (server is the ACP client-of-record).
    pub acp: Arc<AcpManager>,
    /// The live WS relay sink (owns per-session logs + seq counters + subs).
    pub relay: Arc<WsRelaySink>,
    /// PR-S4: the project-root boundary for the fs_api routes. Requests whose
    /// canonicalized target path resolves outside this root are refused with
    /// `code: "OUTSIDE_ROOT"` (or `PATH_TRAVERSAL` for explicit `..`
    /// components). Resolved from `ServerConfig::project_root` at startup;
    /// defaults to the user's home directory when unset.
    pub project_root: Arc<std::path::PathBuf>,
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

/// Run the per-connection relay loop: a write task draining the outbound
/// channel + a read task routing requests. Returns when either half closes.
async fn run_relay(socket: WebSocket, state: AppState) {
    let (mut sink, mut stream) = socket.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Outbound>();
    let relay = Arc::clone(&state.relay);
    // Story 1.8: the ACP manager — the server is the ACP client-of-record; the
    // 10 ACP command handlers (`send_prompt`, `create_session`, …) forward to it.
    let acp = Arc::clone(&state.acp);
    // Client ids registered via `subscribe` — unregistered on disconnect.
    let mut subscribed_clients: Vec<(String, ClientId)> = Vec::new();

    // AC9: emit auth_required on the connection before anything else.
    if out_tx
        .send(Outbound::Event(auth_required_event()))
        .is_err()
    {
        return; // receiver dropped before we started — peer already gone.
    }

    let write_tx = out_tx.clone();
    let mut write_task = tokio::spawn(async move {
        while let Some(frame) = out_rx.recv().await {
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
    });

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
            match msg {
                Message::Text(t) => {
                    let handled =
                        handle_request(&t, &mut authed, &acp, &relay, &write_tx, &mut subscribed_clients)
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
        // Cleanup subscriptions for this connection.
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
            let relay_for_count = Arc::clone(&relay);
            rdz.deny_all_for_client(move |sid| relay_for_count.session_subscriber_count(sid))
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
async fn handle_request(
    text: &str,
    authed: &mut bool,
    acp: &Arc<AcpManager>,
    relay: &Arc<WsRelaySink>,
    out_tx: &mpsc::UnboundedSender<Outbound>,
    subscribed_clients: &mut Vec<(String, ClientId)>,
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
            return WsReply::ok(id, Some(json!({})));
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
        "subscribe" => handle_subscribe(id, &req.payload, relay, out_tx, subscribed_clients),
        // Story 1.7: `respond_permission` — route the browser's permission
        // decision through the server-side rendezvous (first-response-wins,
        // TOCTOU re-validation, at-most-one) to `AcpManager::respond_permission`,
        // which resolves the agent's `Responder` on the driver thread.
        "respond_permission" => handle_respond_permission(id, &req.payload, relay, subscribed_clients).await,
        // Story 1.8: ACP command forwarding → `AcpManager`. The streaming events
        // (`message_chunk`, `tool_call`, `prompt_complete`, `session_created`,
        // `config_options_update`, …) flow back automatically through the
        // existing `fan_out` → `WsRelaySink::emit` → WS frame → store pipeline.
        "create_session" => handle_create_session(id, &req.payload, acp).await,
        "load_session" => handle_load_session(id, &req.payload, acp).await,
        "resume_session" => handle_resume_session(id, &req.payload, acp).await,
        "close_session" => handle_close_session(id, &req.payload, acp).await,
        "list_sessions" => handle_list_sessions(id, &req.payload, acp).await,
        "spawn_agent" => handle_spawn_agent(id, &req.payload, acp).await,
        "kill_agent" => handle_kill_agent(id, &req.payload, acp).await,
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
        // Remaining ACP request types: stub not_implemented (Epic 4 — e.g.
        // `switch_project` belongs to multi-project switching).
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
/// invoke args `{ config }`. Reply payload = `AgentId` (JSON string).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpawnAgentPayload {
    config: AgentConfig,
}

async fn handle_spawn_agent(id: String, payload: &Value, acp: &Arc<AcpManager>) -> WsReply {
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
        Ok(agent_id) => ok_with_payload(id, &agent_id),
        Err(e) => acp_err_to_reply(id, e),
    }
}

/// `kill_agent` → `AcpManager::kill(agent_id)`. Mirrors Tauri `acp_kill_agent`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KillAgentPayload {
    agent_id: crate::acp::AgentId,
}

async fn handle_kill_agent(id: String, payload: &Value, acp: &Arc<AcpManager>) -> WsReply {
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
        Ok(()) => WsReply::ok(id, Some(json!({}))),
        Err(e) => acp_err_to_reply(id, e),
    }
}

/// `list_agents` → `AcpManager::list_agents()`. Reply = `AgentId[]` (JSON array).
fn handle_list_agents(id: String, acp: &Arc<AcpManager>) -> WsReply {
    ok_with_payload(id, &acp.list_agents())
}

/// `create_session` → `AcpManager::new_session(agent_id, cwd, mcp_servers)`.
/// Reply payload = the `NewSessionOutcome` (camelCase: sessionId/modes/models/configOptions).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateSessionPayload {
    agent_id: crate::acp::AgentId,
    cwd: String,
    #[serde(default)]
    mcp_servers: Vec<agent_client_protocol::schema::McpServer>,
}

async fn handle_create_session(id: String, payload: &Value, acp: &Arc<AcpManager>) -> WsReply {
    let parsed: CreateSessionPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => return WsReply::err(id, WsErrorCode::Unsupported, format!("malformed create_session payload (want agentId, cwd, mcpServers?): {e}")),
    };
    // Story 1.8 review (EC4): reject an empty cwd (the desktop store path
    // trims + rejects `cwd.length === 0`; the WS path must not diverge — an
    // empty cwd would give the agent subprocess undefined cwd semantics).
    if parsed.cwd.trim().is_empty() {
        return WsReply::err(id, WsErrorCode::Unsupported, "create_session requires a non-empty `cwd`");
    }
    match acp.new_session(&parsed.agent_id, parsed.cwd, parsed.mcp_servers).await {
        Ok(outcome) => ok_with_payload(id, &outcome),
        Err(e) => acp_err_to_reply(id, e),
    }
}

/// `load_session` → `AcpManager::load_session(agent_id, session_id, cwd)`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadResumeSessionPayload {
    agent_id: crate::acp::AgentId,
    session_id: crate::acp::SessionId,
    cwd: String,
}

async fn handle_load_session(id: String, payload: &Value, acp: &Arc<AcpManager>) -> WsReply {
    let parsed: LoadResumeSessionPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => return WsReply::err(id, WsErrorCode::Unsupported, format!("malformed load_session payload (want agentId, sessionId, cwd): {e}")),
    };
    match acp.load_session(&parsed.agent_id, parsed.session_id, parsed.cwd).await {
        Ok(()) => WsReply::ok(id, Some(json!({}))),
        Err(e) => acp_err_to_reply(id, e),
    }
}

/// `resume_session` → `AcpManager::resume_session(agent_id, session_id, cwd)`.
async fn handle_resume_session(id: String, payload: &Value, acp: &Arc<AcpManager>) -> WsReply {
    let parsed: LoadResumeSessionPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => return WsReply::err(id, WsErrorCode::Unsupported, format!("malformed resume_session payload (want agentId, sessionId, cwd): {e}")),
    };
    match acp.resume_session(&parsed.agent_id, parsed.session_id, parsed.cwd).await {
        Ok(()) => WsReply::ok(id, Some(json!({}))),
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

async fn handle_close_session(id: String, payload: &Value, acp: &Arc<AcpManager>) -> WsReply {
    let parsed: CloseSessionPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => return WsReply::err(id, WsErrorCode::Unsupported, format!("malformed close_session payload (want agentId, sessionId): {e}")),
    };
    match acp.close_session(&parsed.agent_id, parsed.session_id).await {
        Ok(()) => WsReply::ok(id, Some(json!({}))),
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
        Err(e) => return WsReply::err(id, WsErrorCode::Unsupported, format!("malformed list_sessions payload (want agentId, cwd?, cursor?): {e}")),
    };
    match acp.list_sessions(&parsed.agent_id, parsed.cwd, parsed.cursor).await {
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
    content: Option<Vec<agent_client_protocol::schema::ContentBlock>>,
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
            vec![agent_client_protocol::schema::ContentBlock::Text(
                agent_client_protocol::schema::TextContent::new(text),
            )]
        }
        _ => return WsReply::err(id, WsErrorCode::Unsupported, "send_prompt requires non-empty `text` or `content`"),
    };

    // Story 1.8 T3.3: reject a stale turn the client already completed
    // (FR13 last-completed-turn watermark). Best-effort — if no turnId, skip.
    if let Some(turn_id) = &parsed.turn_id {
        if relay.turn_watermark().is_completed(parsed.session_id.0.as_str(), turn_id) {
            return WsReply::err(id, WsErrorCode::Stale, "this turn already completed (stale turn-id)");
        }
    }

    match acp.send_prompt(&parsed.agent_id, parsed.session_id.clone(), content, parsed.turn_id.clone()).await {
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
        Err(e) => acp_err_to_reply(id, e),
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
        Err(e) => return WsReply::err(id, WsErrorCode::Unsupported, format!("malformed cancel_prompt payload (want agentId, sessionId): {e}")),
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
        Err(e) => return WsReply::err(id, WsErrorCode::Unsupported, format!("malformed set_mode payload (want agentId, sessionId, modeId): {e}")),
    };
    match acp.set_mode(&parsed.agent_id, parsed.session_id, parsed.mode_id).await {
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
        Err(e) => return WsReply::err(id, WsErrorCode::Unsupported, format!("malformed set_model payload (want agentId, sessionId, modelId): {e}")),
    };
    match acp.set_model(&parsed.agent_id, parsed.session_id, parsed.model_id).await {
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
    match acp.set_config_option(&parsed.agent_id, parsed.session_id, parsed.config_id, parsed.value_id).await {
        Ok(options) => ok_with_payload(id, &options),
        Err(e) => acp_err_to_reply(id, e),
    }
}

/// Wire `subscribe` → [`WsRelaySink::subscribe`] + forward replay/live to this connection.
fn handle_subscribe(
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

    // Re-subscribe: drop any prior ClientId for this session on this connection.
    subscribed_clients.retain(|(sid, cid)| {
        if sid == &parsed.session_id {
            relay.unsubscribe(sid, *cid);
            false
        } else {
            true
        }
    });

    let (client_id, mut rx, replay) = relay.subscribe(&parsed.session_id, parsed.last_seq);
    match replay {
        ReplayResult::Stale => WsReply::err(
            id,
            WsErrorCode::Stale,
            "cursor is older than the event log; re-sync live-only (omit lastSeq)",
        ),
        ReplayResult::Ok(replayed) => {
            subscribed_clients.push((parsed.session_id.clone(), client_id));
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
        return WsReply::err(id, WsErrorCode::Stale, "no outstanding permission for this requestId");
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
        return WsReply::err(id, WsErrorCode::Stale, "no outstanding permission for this requestId");
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
    match rdz.try_respond(client_id, &parsed.request_id, option_id).await {
        Ok(crate::web::permissions::RespondOutcome::Resolved) => {
            WsReply::ok(id, Some(json!({})))
        }
        Err(err) => {
            // Map each rendezvous rejection to its stable `err.code` (mirrors
            // `RespondError::wire_code`, but goes through `WsErrorCode` so the
            // enum + TS const stay the single source of truth).
            let (code, msg) = match err {
                crate::web::permissions::RespondError::NotFound => {
                    (WsErrorCode::Stale, "no outstanding permission for this requestId")
                }
                crate::web::permissions::RespondError::AlreadyResolved => (
                    WsErrorCode::Stale,
                    "this permission was already resolved by another client (first-response-wins)",
                ),
                crate::web::permissions::RespondError::Duplicate => {
                    (WsErrorCode::Duplicate, "this client already responded to this permission")
                }
                crate::web::permissions::RespondError::InvalidOption => (
                    WsErrorCode::PermissionDenied,
                    "optionId is not among the original permission options (TOCTOU defense)",
                ),
                crate::web::permissions::RespondError::NotSubscribed => {
                    (WsErrorCode::NotFound, "not subscribed to the permission's session")
                }
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

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;

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
    fn sequenced_event_serializes_snake_case_envelope() {
        let evt = SequencedEvent::new(Some("sess-1".to_string()), 7, "message_chunk", json!({
            "agentId": "a1", "sessionId": "sess-1", "role": "agent"
        }));
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
        assert!(ve.get("payload").is_none(), "payload must be omitted on failure");
    }

    fn handle_sync(text: &str, authed: &mut bool) -> WsReply {
        let relay = Arc::new(WsRelaySink::new());
        // Story 1.8: handle_request now takes `&Arc<AcpManager>`. The no-op
        // manager (`vec![]` sinks) returns fast `Err`s for the ACP command
        // methods (no agent spawned) which the handlers map to `WsErrorCode`.
        let acp = Arc::new(AcpManager::new(vec![]));
        let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
        let mut subs = Vec::new();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(handle_request(text, authed, &acp, &relay, &tx, &mut subs))
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
    fn handle_request_post_auth_other_types_not_implemented() {
        let mut authed = true;
        // Story 1.7 wired `respond_permission`; Story 1.8 wired `send_prompt`,
        // `create_session`, `load_session`, `resume_session`, `close_session`,
        // `list_sessions`, `cancel_prompt`, `set_mode`, `set_model`,
        // `set_config_option`. `switch_project` stays `not_implemented` (Epic 4 —
        // multi-project switching). Unknown types also stay `not_implemented`.
        for ty in ["switch_project", "totally_unknown_type"] {
            let reply = handle_sync(
                &format!(r#"{{"id":"r1","type":"{ty}","payload":{{}}}}"#),
                &mut authed,
            );
            assert!(!reply.ok, "{ty} should be not_implemented");
            assert_eq!(reply.err.unwrap().code, "not_implemented", "{ty}");
        }
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
        let r = acp_err_to_reply("r1".to_string(), "ACP_TURN_IN_PROGRESS: session s1".to_string());
        assert_eq!(r.err.unwrap().code, "rate_limited");
        // Unknown agent → not_found.
        let r = acp_err_to_reply("r2".to_string(), "unknown agent: a1".to_string());
        assert_eq!(r.err.unwrap().code, "not_found");
        // Capability gate → unsupported.
        let r = acp_err_to_reply("r3".to_string(), "agent does not support session/load (loadSession capability)".to_string());
        assert_eq!(r.err.unwrap().code, "unsupported");
        // Unrecognized → not_implemented (fallback, message preserved).
        let r = acp_err_to_reply("r4".to_string(), "agent initialize failed: boom".to_string());
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
        relay.set_rendezvous(Arc::new(crate::web::permissions::PermissionRendezvous::default()));
        let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
        let mut subs = Vec::new();
        let mut authed = true;
        let reply = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(handle_request(
                r#"{"id":"r1","type":"respond_permission","payload":{"agentId":"a1"}}"#,
                &mut authed,
                &acp,
                &relay,
                &tx,
                &mut subs,
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
        let (client_id, _rx, _replay) = relay.subscribe(session_id, None);
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
        let reply = block_on(handle_request(
            r#"{"id":"r1","type":"respond_permission","payload":{"agentId":"a2","requestId":"perm-1","optionId":"allow"}}"#,
            &mut authed,
            &acp,
            &relay,
            &tx,
            &mut subs.clone(),
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
        let (_other_client, _rx, _replay) = relay.subscribe("sess-B", None);
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
        let reply = block_on(handle_request(
            r#"{"id":"r1","type":"respond_permission","payload":{"agentId":"a1","requestId":"perm-A","optionId":"allow"}}"#,
            &mut authed,
            &acp,
            &relay,
            &tx,
            &mut subs.clone(),
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
        let ok_reply = block_on(handle_request(
            r#"{"id":"r1","type":"respond_permission","payload":{"agentId":"a1","requestId":"perm-1","optionId":"allow"}}"#,
            &mut authed,
            &acp,
            &relay,
            &tx,
            &mut subs.clone(),
        ));
        assert!(ok_reply.ok, "first response wins: {:?}", ok_reply.err);
        // Second frame for the same requestId → stale (ticket evicted).
        let stale_reply = block_on(handle_request(
            r#"{"id":"r2","type":"respond_permission","payload":{"agentId":"a1","requestId":"perm-1","optionId":"allow"}}"#,
            &mut authed,
            &acp,
            &relay,
            &tx,
            &mut subs.clone(),
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
        let reply = block_on(handle_request(
            r#"{"id":"r1","type":"respond_permission","payload":{"agentId":"a1","requestId":"perm-1","optionId":"escalate"}}"#,
            &mut authed,
            &acp,
            &relay,
            &tx,
            &mut subs.clone(),
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
        let reply = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(handle_request(
                r#"{"id":"sub1","type":"subscribe","payload":{"sessionId":"s1","lastSeq":0}}"#,
                &mut authed,
                &acp,
                &relay,
                &tx,
                &mut subs,
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
                &tx,
                &mut subs2,
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
                &tx,
                &mut subs2,
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
                &tx,
                &mut subs3,
            ));
        assert!(reply_live.ok, "{:?}", reply_live.err);

        // Drain any replay/live.
        while rx.try_recv().is_ok() {}
    }
}
