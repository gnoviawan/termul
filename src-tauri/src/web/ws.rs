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
                        handle_request(&t, &mut authed, &relay, &write_tx, &mut subscribed_clients)
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
    tokio::select! {
        _ = &mut write_task => {
            read_task.abort();
        }
        _ = &mut read_task => {
            write_task.abort();
        }
    }
    // Join both so the abort is observed and tasks are not orphaned.
    let _ = write_task.await;
    let _ = read_task.await;
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

/// Route a single text request frame to a reply (AC9 + AC10 + Story 1.6 subscribe).
///
/// Pre-auth: only `authenticate` is allowed; everything else → `unauthorized`.
/// Post-auth: `authenticate` is a no-op success; `subscribe` wires the sink;
/// OS-cap requests → `unsupported`; all other request types → `not_implemented`.
async fn handle_request(
    text: &str,
    authed: &mut bool,
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
        // OS caps (AC8): server-fulfilled; reject browser requests.
        t if is_os_fulfilled_cap(t) => WsReply::err(
            id,
            WsErrorCode::Unsupported,
            format!(
                "`{t}` is an OS-fulfilled cap; the server handles it locally (not relayed to the browser)"
            ),
        ),
        // Remaining ACP request types: stub not_implemented (1.8/Epic 4).
        _ => WsReply::err(
            id,
            WsErrorCode::NotImplemented,
            format!(
                "`{}` is not implemented yet (ACP forwarding lands in Stories 1.8/Epic 4)",
                req.type_
            ),
        ),
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
        let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
        let mut subs = Vec::new();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(handle_request(text, authed, &relay, &tx, &mut subs))
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
        // `respond_permission` is now a live handler (Story 1.7) — excluded.
        for ty in [
            "send_prompt",
            "create_session",
            "switch_project",
            "list_sessions",
            "set_mode",
        ] {
            let reply = handle_sync(
                &format!(r#"{{"id":"r1","type":"{ty}","payload":{{}}}}"#),
                &mut authed,
            );
            assert!(!reply.ok, "{ty} should be not_implemented");
            assert_eq!(reply.err.unwrap().code, "not_implemented", "{ty}");
        }
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
        let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
        let mut authed = true;
        let reply = block_on(handle_request(
            r#"{"id":"r1","type":"respond_permission","payload":{"agentId":"a2","requestId":"perm-1","optionId":"allow"}}"#,
            &mut authed,
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
        let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
        let mut authed = true;
        let ok_reply = block_on(handle_request(
            r#"{"id":"r1","type":"respond_permission","payload":{"agentId":"a1","requestId":"perm-1","optionId":"allow"}}"#,
            &mut authed,
            &relay,
            &tx,
            &mut subs.clone(),
        ));
        assert!(ok_reply.ok, "first response wins: {:?}", ok_reply.err);
        // Second frame for the same requestId → stale (ticket evicted).
        let stale_reply = block_on(handle_request(
            r#"{"id":"r2","type":"respond_permission","payload":{"agentId":"a1","requestId":"perm-1","optionId":"allow"}}"#,
            &mut authed,
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
        let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
        let mut authed = true;
        let reply = block_on(handle_request(
            r#"{"id":"r1","type":"respond_permission","payload":{"agentId":"a1","requestId":"perm-1","optionId":"escalate"}}"#,
            &mut authed,
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
                &relay,
                &tx,
                &mut subs3,
            ));
        assert!(reply_live.ok, "{:?}", reply_live.err);

        // Drain any replay/live.
        while rx.try_recv().is_ok() {}
    }
}
