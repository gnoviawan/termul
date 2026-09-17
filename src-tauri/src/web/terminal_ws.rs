//! Dedicated interactive terminal websocket.
//!
//! This endpoint intentionally stays separate from the ACP relay. When the
//! server runs with the web auth gate (`AppState.web_auth = Some` — public
//! bind or explicit token, see `web::auth::resolve`), a fresh connection must
//! send `authenticate{token}` before any other request; every pre-auth op is
//! refused with the single generic `UNAUTHORIZED` and spawns no PTY. An
//! ungated server treats `authenticate` as a no-op success (new-client /
//! old-server tolerance) and admits all operations, exactly as before the
//! gate existed. Beyond the connection gate, all operations are
//! project-scoped: a connection may only interact with terminals whose
//! `project_id` it has been authorized for via spawn or explicit attach.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use parking_lot::RwLock;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::pty::manager::SpawnOptions;
use crate::web::ws::AppState;

const MAX_RECONNECT_FRAMES: usize = 64;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    id: String,
    #[serde(rename = "type")]
    type_: String,
    #[serde(default)]
    payload: Value,
}

pub async fn terminal_ws_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| run(socket, state))
}

async fn run(socket: WebSocket, state: AppState) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::channel::<Message>(MAX_RECONNECT_FRAMES);

    let write_task = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            if sink.send(message).await.is_err() {
                break;
            }
        }
    });

    // Per-connection authorization: terminal IDs this socket may operate on.
    // Shared with the event-forwarding task so it can see updates.
    let authorized: Arc<RwLock<HashSet<String>>> =
        Arc::new(RwLock::new(HashSet::new()));
    // Per-terminal output forwarding tasks.
    let attachments: HashMap<String, tokio::task::JoinHandle<()>> = HashMap::new();

    if state.web_auth.is_some() {
        info!("[terminal-ws] client connected (web auth gate ON — authenticate required)");
    } else {
        info!("[terminal-ws] client connected (ungated)");
    }

    let event_tx = tx.clone();
    let event_state = state.clone();
    let event_authorized = authorized.clone();
    let mut event_rx = event_state.terminal_events.subscribe();
    let event_task = tokio::spawn(async move {
        loop {
            match event_rx.recv().await {
                Ok(event) => {
                    let terminal_id = event.terminal_id().to_string();
                    // Only forward events for terminals this connection is
                    // authorized to see.
                    if !event_authorized.read().contains(&terminal_id) {
                        continue;
                    }
                    let payload = serde_json::to_value(&event)
                        .unwrap_or_else(|_| json!({}));
                    if send_json(
                        &event_tx,
                        json!({ "type": "event", "payload": payload }),
                    )
                    .await
                    .is_err()
                    {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    warn!("[terminal-ws] lifecycle event receiver lagged by {skipped}");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    let mut ctx = ConnectionContext {
        authorized: authorized.clone(),
        attachments,
        // The connection starts authed exactly when the server is ungated.
        authed: state.web_auth.is_none(),
    };

    while let Some(frame) = stream.next().await {
        let Ok(message) = frame else { break };
        let Message::Text(text) = message else { continue };
        let request = match serde_json::from_str::<Request>(&text) {
            Ok(request) => request,
            Err(error) => {
                let _ = send_error(&tx, "malformed", "VALIDATION_ERROR", error.to_string()).await;
                continue;
            }
        };
        let id = request.id.clone();
        let op_type = request.type_.clone();
        info!("[terminal-ws] request start type={op_type} id={id}");
        match handle(request, &state, &tx, &mut ctx).await {
            Ok(data) => {
                info!("[terminal-ws] request success type={op_type} id={id}");
                let _ = send_json(&tx, json!({ "id": id, "success": true, "data": data })).await;
            }
            Err((code, message)) => {
                warn!("[terminal-ws] request failed type={op_type} id={id} code={code}");
                let _ = send_error(&tx, &id, code, message).await;
            }
        }
    }

    // Cleanup: abort all output forwarding tasks. PTYs are preserved.
    event_task.abort();
    for task in ctx.attachments.values() {
        task.abort();
    }
    info!("[terminal-ws] client disconnected; {} PTY(s) preserved", ctx.authorized.read().len());
    drop(tx);
    let _ = write_task.await;
}

struct ConnectionContext {
    /// Terminal IDs this connection is authorized to operate on.
    authorized: Arc<RwLock<HashSet<String>>>,
    /// Per-terminal output forwarding tasks (terminal_id -> task).
    attachments: HashMap<String, tokio::task::JoinHandle<()>>,
    /// Whether this connection has passed the web auth gate (`authenticate`
    /// request). Initialized to `true` on ungated servers so legacy behavior
    /// is byte-identical; a gated server starts every connection un-authed.
    authed: bool,
}

/// Pure connection-gate decision for an incoming request (unit-testable
/// without a live socket). `authenticate` is ALWAYS routed (it is the way
/// in); every other request requires an authed connection — pre-auth ops are
/// refused with the single generic `UNAUTHORIZED` before any handler runs
/// (so a pre-auth `spawn` never creates a PTY).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConnectionGate {
    /// Route to the `authenticate` handling (token validation / no-op).
    Authenticate,
    /// Proceed to the normal request arms.
    Allow,
    /// Refuse pre-auth: `("UNAUTHORIZED", "Unauthorized")`.
    Refuse,
}

fn connection_gate(authed: bool, request_type: &str) -> ConnectionGate {
    if request_type == "authenticate" {
        ConnectionGate::Authenticate
    } else if authed {
        ConnectionGate::Allow
    } else {
        ConnectionGate::Refuse
    }
}

impl ConnectionContext {
    fn authorize(&mut self, terminal_id: &str) {
        self.authorized.write().insert(terminal_id.to_string());
    }

    fn is_authorized(&self, terminal_id: &str) -> bool {
        self.authorized.read().contains(terminal_id)
    }

    fn detach(&mut self, terminal_id: &str) {
        if let Some(task) = self.attachments.remove(terminal_id) {
            task.abort();
        }
        self.authorized.write().remove(terminal_id);
    }
}

async fn handle(
    request: Request,
    state: &AppState,
    tx: &mpsc::Sender<Message>,
    ctx: &mut ConnectionContext,
) -> Result<Value, (&'static str, String)> {
    match connection_gate(ctx.authed, request.type_.as_str()) {
        ConnectionGate::Refuse => Err(("UNAUTHORIZED", "Unauthorized".to_string())),
        ConnectionGate::Authenticate => {
            match state.web_auth.as_ref() {
                // Gated + not yet authed: validate the presented token
                // (constant-time). A wrong or absent token refuses with the
                // single generic UNAUTHORIZED and leaves the connection
                // un-authed (retry allowed) — the same collapse the terminal
                // claim/attach paths use.
                Some(gate) if !ctx.authed => {
                    let presented = request.payload["token"].as_str().unwrap_or("");
                    if gate.accepts(presented) {
                        ctx.authed = true;
                        info!("[terminal-ws] connection authenticated");
                        Ok(json!({}))
                    } else {
                        warn!("[terminal-ws] authenticate rejected (bad token)");
                        Err(("UNAUTHORIZED", "Unauthorized".to_string()))
                    }
                }
                // Ungated server or already-authed connection: no-op success
                // so new clients stay compatible with pre-gate servers
                // (and re-auth is idempotent).
                _ => Ok(json!({})),
            }
        }
        ConnectionGate::Allow => match request.type_.as_str() {
        "spawn" => {
            let options: SpawnOptions = serde_json::from_value(request.payload)
                .map_err(|e| ("VALIDATION_ERROR", e.to_string()))?;
            // Require project_id so the terminal is scoped — do not default
            // to a literal that any client can target.
            if options.project_id.as_deref().filter(|s| !s.is_empty()).is_none() {
                return Err((
                    "VALIDATION_ERROR",
                    "spawn requires a non-empty projectId".to_string(),
                ));
            }
            info!(
                "[terminal-ws] spawn requested project_id={}",
                options.project_id.as_deref().unwrap_or("?")
            );
            // CAP-3: spawn is the only issuance path. The reply carries the
            // flattened info + claim (same camelCase shape as desktop).
            let spawned = state
                .pty
                .spawn(options, None)
                .await
                .map_err(|e| ("SPAWN_FAILED", e))?;
            ctx.authorize(&spawned.info.id);
            info!("[terminal-ws] spawn success terminal_id={}", spawned.info.id);
            serde_json::to_value(spawned).map_err(|e| ("SPAWN_FAILED", e.to_string()))
        }
        "write" => {
            let terminal_id = string_field(&request.payload, "terminalId")?;
            if !ctx.is_authorized(terminal_id) {
                return Err(("UNAUTHORIZED", format!("Not authorized for terminal {terminal_id}")));
            }
            let data = string_field(&request.payload, "data")?;
            state
                .pty
                .write(terminal_id, data)
                .await
                .map(|_| Value::Null)
                .map_err(|e| ("WRITE_FAILED", e))
        }
        "resize" => {
            let terminal_id = string_field(&request.payload, "terminalId")?;
            if !ctx.is_authorized(terminal_id) {
                return Err(unauthorized_error(terminal_id));
            }
            let cols = u16_field(&request.payload, "cols")?;
            let rows = u16_field(&request.payload, "rows")?;
            state
                .pty
                .resize(terminal_id, cols, rows)
                .await
                .map(|_| Value::Null)
                .map_err(|e| ("RESIZE_FAILED", e))
        }
        "kill" => {
            let terminal_id = string_field(&request.payload, "terminalId")?;
            // CWE-862: authorization FIRST — a connection may only kill a
            // terminal it spawned or verifiably attached to. The check runs
            // BEFORE any existence check or force_kill and collapses to the
            // single generic UNAUTHORIZED, so a client holding only the shared
            // web token can neither terminate another connection's PTY nor
            // distinguish "terminal exists but not yours" from "unknown id".
            if !ctx.is_authorized(terminal_id) {
                return Err(unauthorized_error(terminal_id));
            }
            // Idempotent kill for an AUTHORIZED terminal whose PTY is already
            // gone (reaped/exited on its own): treat as success so closing a
            // tab over a dead PTY doesn't leave an uncloseable tab. A repeat
            // kill after a successful kill is NOT idempotent — the first kill
            // detached the terminal, so the retry takes the generic
            // UNAUTHORIZED branch above like any other unauthorized id.
            if state.pty.get(terminal_id).is_none() {
                ctx.detach(terminal_id);
                return Ok(Value::Null);
            }
            // Force-kill: bypass the desktop is_hidden deferral so web close
            // actually terminates the process. Desktop behavior is unchanged.
            state
                .pty
                .force_kill(terminal_id)
                .await
                .map(|_| {
                    ctx.detach(terminal_id);
                    Value::Null
                })
                .map_err(|e| ("KILL_FAILED", e))
        }
        "attach" => {
            let terminal_id = string_field(&request.payload, "terminalId")?.to_string();
            // CAP-3: verification is the gate and runs BEFORE any replay; every
            // failure mode collapses to the single generic UNAUTHORIZED error
            // (the leaking TERMINAL_NOT_FOUND branch is gone — existence stays
            // hidden). A missing or empty claim is NOT a shape error: it flows
            // through verification like any bad credential (contract: "missing/
            // invalid claim" collapses into the one generic error).
            let claim = request.payload["claim"].as_str().unwrap_or("");
            let last_seq = request.payload["lastSeq"]
                .as_u64()
                .unwrap_or(0);

            // Capture the generation BEFORE verifying (TOCTOU-safe ordering,
            // same as the desktop command): captured-first means a rotate/
            // revoke landing mid-handshake either fails verification or leaves
            // the attachment task holding a stale generation it terminates on.
            let generation = state.pty.claim_generation(&terminal_id);
            if state.pty.verify_claim(&terminal_id, claim).is_err() {
                return Err(unauthorized_error(&terminal_id));
            }
            let Some(instance) = state.pty.get(&terminal_id) else {
                // Verified a heartbeat ago but gone now — same generic error.
                return Err(unauthorized_error(&terminal_id));
            };
            // The credential is the gate now (same-connection prior
            // authorization no longer is): verified attach authorizes the
            // connection for write/resize/events on this terminal.
            ctx.authorize(&terminal_id);

            // Sequenced replay: only unseen chunks, with gap detection.
            let replay = instance.subscribe_from(last_seq);
            let attach_result = state.pty.build_attach_result(&instance, &replay);
            let snapshot = state.terminal_events.snapshot(&terminal_id);

            // Send replay frame: chunks + gap flag + latest seq + state snapshot.
            let chunk_payloads: Vec<Value> = replay
                .chunks
                .iter()
                .map(|chunk| {
                    json!({
                        "seq": chunk.seq,
                        "data": chunk.data.iter().map(|b| *b as u64).collect::<Vec<u64>>()
                    })
                })
                .collect();
            send_json(
                tx,
                json!({
                    "type": "replay",
                    "terminalId": terminal_id,
                    "chunks": chunk_payloads,
                    "gap": replay.gap,
                    "latestSeq": replay.latest_seq,
                    "snapshot": serde_json::to_value(&snapshot).unwrap_or(json!({}))
                }),
            )
            .await
            .map_err(|e| ("NETWORK_ERROR", e))?;

            // Replace prior attachment task if any.
            if let Some(previous) = ctx.attachments.remove(&terminal_id) {
                previous.abort();
            }
            let output_tx = tx.clone();
            let attached_id = terminal_id.clone();
            let pty = state.pty.clone();
            let task = tokio::spawn(async move {
                let mut receiver = replay.receiver;
                let mut current_seq = replay.latest_seq;
                loop {
                    // CAP-3 teardown (amendment R1): when this credential is
                    // rotated/revoked — by ANY connection — or the terminal is
                    // killed/reaped, the derived stream ends. The generation
                    // check is what makes rotate/revoke sever the holders on
                    // other connections, not just the rotating one.
                    if crate::commands::forwarder_should_terminate(
                        generation,
                        pty.claim_generation(&attached_id),
                    ) {
                        info!(
                            "[terminal-ws] attachment terminating (claim invalidated) terminal_id={attached_id}"
                        );
                        break;
                    }
                    match receiver.recv().await {
                        Ok(chunk) => {
                            current_seq = chunk.seq;
                            let data: Vec<u64> = chunk.data.iter().map(|b| *b as u64).collect();
                            if send_json(
                                &output_tx,
                                json!({
                                    "type": "data",
                                    "terminalId": attached_id,
                                    "seq": current_seq,
                                    "data": data
                                }),
                            )
                            .await
                            .is_err()
                            {
                                break;
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                            // Recoverable: send a gap marker and continue.
                            warn!(
                                "[terminal-ws] output receiver lagged by {skipped} for {attached_id}"
                            );
                            let _ = send_json(
                                &output_tx,
                                json!({
                                    "type": "gap",
                                    "terminalId": attached_id,
                                    "lastSeq": current_seq
                                }),
                            )
                            .await;
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            });
            ctx.attachments.insert(terminal_id.clone(), task);
            // Shared attach result — byte-identical camelCase shape to the
            // desktop `terminal_attach` response (no claim key, ever).
            serde_json::to_value(attach_result).map_err(|e| ("NETWORK_ERROR", e.to_string()))
        }
        "rotate_claim" => {
            // CAP-3: possession of the current credential yields a fresh one
            // and atomically invalidates the old. Any failure — including a
            // missing/empty claim — is the same generic UNAUTHORIZED as attach
            // (missing claims flow through verification, never a shape error).
            let terminal_id = string_field(&request.payload, "terminalId")?.to_string();
            let claim = request.payload["claim"].as_str().unwrap_or("");
            let rotated = state
                .pty
                .rotate_claim(&terminal_id, claim)
                .map_err(|_| unauthorized_error(&terminal_id))?;
            // Teardown (amendment R1): the invalidated holder loses the output
            // stream (attachment task detached) AND write/resize access
            // (removed from the authorized set). Holders on OTHER connections
            // are severed by the claim-generation check inside their
            // attachment tasks. The PTY keeps running.
            ctx.detach(&terminal_id);
            info!("[terminal-ws] claim rotated terminal_id={terminal_id}");
            serde_json::to_value(crate::pty::RotatedClaim { claim: rotated })
                .map_err(|e| ("NETWORK_ERROR", e.to_string()))
        }
        "revoke_claim" => {
            // CAP-3: revocation invalidates the credential; the PTY survives
            // until explicit kill/release/expiry/shutdown. Any failure —
            // including a missing/empty claim — is the same generic
            // UNAUTHORIZED as attach.
            let terminal_id = string_field(&request.payload, "terminalId")?.to_string();
            let claim = request.payload["claim"].as_str().unwrap_or("");
            state
                .pty
                .revoke_claim(&terminal_id, claim)
                .map_err(|_| unauthorized_error(&terminal_id))?;
            // Teardown (amendment R1): same severing as rotate — the revoked
            // holder is a credential-less client and receives no further
            // metadata or output; other connections are severed by the
            // generation check in their attachment tasks. The PTY keeps
            // running.
            ctx.detach(&terminal_id);
            info!("[terminal-ws] claim revoked terminal_id={terminal_id}");
            Ok(Value::Null)
        }
        "detach" => {
            let terminal_id = string_field(&request.payload, "terminalId")?;
            ctx.detach(terminal_id);
            Ok(Value::Null)
        }
        "get_cwd" => {
            let terminal_id = string_field(&request.payload, "terminalId")?;
            if !ctx.is_authorized(terminal_id) {
                return Err(("UNAUTHORIZED", format!("Not authorized for terminal {terminal_id}")));
            }
            Ok(json!(state.cwd_tracker.get_cwd(terminal_id)))
        }
        "get_git_branch" => {
            let terminal_id = string_field(&request.payload, "terminalId")?;
            if !ctx.is_authorized(terminal_id) {
                return Err(("UNAUTHORIZED", format!("Not authorized for terminal {terminal_id}")));
            }
            Ok(json!(state.git_tracker.get_branch(terminal_id)))
        }
        "get_git_status" => {
            let terminal_id = string_field(&request.payload, "terminalId")?;
            if !ctx.is_authorized(terminal_id) {
                return Err(("UNAUTHORIZED", format!("Not authorized for terminal {terminal_id}")));
            }
            Ok(json!(state.git_tracker.get_status(terminal_id)))
        }
        "get_exit_code" => {
            let terminal_id = string_field(&request.payload, "terminalId")?;
            if !ctx.is_authorized(terminal_id) {
                return Err(("UNAUTHORIZED", format!("Not authorized for terminal {terminal_id}")));
            }
            Ok(json!(state.exit_code_tracker.get_exit_code(terminal_id)))
        }
        "add_renderer_ref" => {
            let terminal_id = string_field(&request.payload, "terminalId")?;
            if !ctx.is_authorized(terminal_id) {
                return Err(("UNAUTHORIZED", format!("Not authorized for terminal {terminal_id}")));
            }
            state
                .pty
                .add_renderer_ref(terminal_id, string_field(&request.payload, "rendererId")?)
                .map(|_| Value::Null)
                .map_err(|e| ("TERMINAL_NOT_FOUND", e))
        }
        "remove_renderer_ref" => {
            let terminal_id = string_field(&request.payload, "terminalId")?;
            if !ctx.is_authorized(terminal_id) {
                return Err(("UNAUTHORIZED", format!("Not authorized for terminal {terminal_id}")));
            }
            state
                .pty
                .remove_renderer_ref(terminal_id, string_field(&request.payload, "rendererId")?)
                .map(|_| Value::Null)
                .map_err(|e| ("TERMINAL_NOT_FOUND", e))
        }
        "set_protected" => {
            let terminal_id = string_field(&request.payload, "terminalId")?;
            if !ctx.is_authorized(terminal_id) {
                return Err(("UNAUTHORIZED", format!("Not authorized for terminal {terminal_id}")));
            }
            let protected = request.payload["protected"].as_bool().unwrap_or(true);
            state.pty.set_protected(terminal_id, protected);
            Ok(Value::Null)
        }
        "update_orphan_detection" => {
            // Global lifecycle setting. Accepted on any AUTHED connection —
            // including one with zero attached terminals — because the web
            // auth token (the connection gate) is the trust boundary for the
            // deployment posture this op exists in: the settings loader
            // pushes it at boot, before the first terminal attaches (QA
            // round 2: the push was previously refused until ≥1 authorized
            // terminal existed, so orphan-detection settings never applied).
            // Pre-auth connections are already refused with the single
            // generic UNAUTHORIZED by `connection_gate` before this arm.
            let enabled = request.payload["enabled"].as_bool().unwrap_or(true);
            let timeout = request.payload["timeout"]
                .as_u64()
                .and_then(|t| t.checked_mul(60 * 1000)) // minutes → ms (checked to prevent overflow)
                .filter(|t| *t > 0 && *t <= 3_600_000); // cap at 1 hour
            state
                .pty
                .update_orphan_detection_settings(enabled, timeout)
                .await;
            info!(
                "[terminal-ws] orphan detection updated enabled={enabled} timeout_ms={:?}",
                timeout
            );
            Ok(Value::Null)
        }
        "list_preserved" => {
            // Cross-reload reattach (QA round 2, spec story 5): an AUTHED
            // connection asks which PTYs the host still preserves for a
            // project and gets metadata + a freshly issued claim per
            // terminal. Scoping is the terminal's OWN write-once
            // `project_id` — never the per-connection authorized set — so
            // the reply is a function of the project, not of who is asking.
            // The connection gate above already refuses pre-auth
            // `list_preserved` with the single generic UNAUTHORIZED, so no
            // terminal existence leaks to un-authed clients, and an authed
            // client querying an unknown project gets the same empty reply
            // shape as a project with nothing preserved.
            let project_id = string_field(&request.payload, "projectId")?;
            let preserved = state.pty.list_preserved(project_id);
            info!(
                "[terminal-ws] list_preserved project_id={} count={}",
                project_id,
                preserved.len()
            );
            let entries: Vec<Value> = preserved
                .into_iter()
                .map(|entry| {
                    json!({
                        "id": entry.info.id,
                        "shell": entry.info.shell,
                        "cwd": entry.info.cwd,
                        "pid": entry.info.pid,
                        "cols": entry.info.cols,
                        "rows": entry.info.rows,
                        "claim": entry.claim,
                    })
                })
                .collect();
            Ok(json!({ "projectId": project_id, "terminals": entries }))
        }
        _ => Err(("NOT_IMPLEMENTED", "unknown terminal request".to_string())),
        }
    }
}

fn string_field<'a>(value: &'a Value, key: &str) -> Result<&'a str, (&'static str, String)> {
    value[key]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ("VALIDATION_ERROR", format!("missing {key}")))
}

/// The single generic authorization failure shared by attach, rotate_claim,
/// revoke_claim, kill and resize. CAP-3 forbids any of these surfaces from
/// distinguishing unknown terminal from wrong/revoked credential from binding
/// mismatch - one code, one message shape. Message matches the desktop
/// `terminal_attach` / rotate / revoke error string byte-for-byte (transport
/// parity) and never echoes the terminal id. Kept free-standing so the
/// contract is testable.
fn unauthorized_error(_terminal_id: &str) -> (&'static str, String) {
    ("UNAUTHORIZED", "Unauthorized".to_string())
}

fn u16_field(value: &Value, key: &str) -> Result<u16, (&'static str, String)> {
    value[key]
        .as_u64()
        .and_then(|value| u16::try_from(value).ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| ("VALIDATION_ERROR", format!("invalid {key}")))
}

async fn send_json(tx: &mpsc::Sender<Message>, value: Value) -> Result<(), String> {
    tx.send(Message::Text(value.to_string().into()))
        .await
        .map_err(|_| "terminal websocket closed".to_string())
}

async fn send_error(
    tx: &mpsc::Sender<Message>,
    id: &str,
    code: &str,
    error: String,
) -> Result<(), String> {
    send_json(
        tx,
        json!({ "id": id, "success": false, "error": error, "code": code }),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_numeric_dimensions() {
        assert_eq!(u16_field(&json!({ "cols": 80 }), "cols"), Ok(80));
        assert!(u16_field(&json!({ "cols": 0 }), "cols").is_err());
    }

    #[test]
    fn u16_rejects_negative_and_overflow() {
        assert!(u16_field(&json!({ "rows": -1 }), "rows").is_err());
        assert!(u16_field(&json!({ "rows": 70000 }), "rows").is_err());
    }

    #[test]
    fn string_field_rejects_empty_and_missing() {
        assert!(string_field(&json!({ "terminalId": "" }), "terminalId").is_err());
        assert!(string_field(&json!({}), "terminalId").is_err());
        assert_eq!(
            string_field(&json!({ "terminalId": "t1" }), "terminalId"),
            Ok("t1")
        );
    }

    #[test]
    fn context_authorize_and_detach_roundtrip() {
        let mut ctx = ConnectionContext {
            authorized: Arc::new(RwLock::new(HashSet::new())),
            attachments: HashMap::new(),
            // Tests exercise post-gate behavior; the ungated posture starts
            // every connection authed.
            authed: true,
        };
        ctx.authorize("t1");
        assert!(ctx.is_authorized("t1"));
        assert!(!ctx.is_authorized("t2"));
        ctx.detach("t1");
        assert!(!ctx.is_authorized("t1"));
    }

    #[test]
    fn string_field_validates_structural_ids() {
        // Structural validation applies to `terminalId` on every arm (a missing
        // terminal id reveals nothing about any terminal, so VALIDATION_ERROR
        // is allowed there). Claims deliberately do NOT use this path: on
        // attach/rotate/revoke a missing or empty claim flows through
        // verification and fails with the generic UNAUTHORIZED like any bad
        // credential (contract: no response distinguishes "missing" from
        // "invalid"). The handler-level wiring of that behavior needs a live
        // PtyManager (deferred seam); this test pins the helper only.
        assert!(string_field(&json!({ "terminalId": "" }), "terminalId").is_err());
        assert!(string_field(&json!({}), "terminalId").is_err());
        assert_eq!(
            string_field(&json!({ "terminalId": "t1" }), "terminalId"),
            Ok("t1")
        );
    }


    #[test]
    fn connection_gate_routes_authenticate_pre_auth() {
        // `authenticate` is always routed — it is the way in.
        assert_eq!(connection_gate(false, "authenticate"), ConnectionGate::Authenticate);
        assert_eq!(connection_gate(true, "authenticate"), ConnectionGate::Authenticate);
    }

    #[test]
    fn connection_gate_refuses_every_pre_auth_op() {
        // QA repro (P1): a pre-auth spawn/write/attach/… must be refused
        // before any handler runs — no PTY is ever created pre-auth.
        for ty in [
            "spawn",
            "write",
            "resize",
            "kill",
            "attach",
            "detach",
            "rotate_claim",
            "revoke_claim",
            "get_cwd",
            "get_git_branch",
            "get_git_status",
            "get_exit_code",
            "add_renderer_ref",
            "remove_renderer_ref",
            "set_protected",
            "update_orphan_detection",
            "unknown-future-op",
        ] {
            assert_eq!(
                connection_gate(false, ty),
                ConnectionGate::Refuse,
                "pre-auth {ty} must be refused"
            );
        }
    }

    #[test]
    fn connection_gate_allows_all_ops_post_auth() {
        for ty in ["spawn", "write", "attach", "unknown-future-op"] {
            assert_eq!(
                connection_gate(true, ty),
                ConnectionGate::Allow,
                "post-auth {ty} must proceed"
            );
        }
    }
    /// Build an AppState with the given gate posture (mirrors the fs_api test
    /// literal). `Some(token)` = gated server, `None` = legacy ungated.
    fn gate_test_state(token: Option<&str>) -> crate::web::ws::AppState {
        let pty = crate::web::test_pty_manager();
        crate::web::ws::AppState {
            acp: Arc::new(crate::acp::AcpManager::new(vec![])),
            terminal_events: pty.terminal_events(),
            cwd_tracker: pty.cwd_tracker(),
            git_tracker: pty.git_tracker(),
            exit_code_tracker: pty.exit_code_tracker(),
            pty,
            relay: Arc::new(crate::web::sink::WsRelaySink::new()),
            registry: Arc::new(crate::web::project_registry::ProjectRegistry::new()),
            registry_persistence: None,
            projects_file: None,
            history_mode: crate::web::ws::HistoryMode::LiveOnly,
            project_root: Arc::new(parking_lot::RwLock::new(std::path::PathBuf::from("/tmp"))),
            pending_oauth_flows: Arc::new(parking_lot::RwLock::new(std::collections::HashMap::new())),
            oauth_base_url: "http://127.0.0.1".to_string(),
            workspace_manifest: None,
            acp_catalog: None,
            acp_install: None,
            store: None,
            web_auth: token.map(|t| {
                Arc::new(crate::web::auth::WebAuth::new(
                    crate::web::auth::WebAuthToken::new(t).expect("non-empty"),
                ))
            }),
            allow_remote_writes: false,
            shared_live_writes_denied: false,
        }
    }

    fn gate_test_ctx(authed: bool) -> ConnectionContext {
        ConnectionContext {
            authorized: Arc::new(RwLock::new(HashSet::new())),
            attachments: HashMap::new(),
            authed,
        }
    }

    fn gate_request(id: &str, type_: &str, payload: Value) -> Request {
        Request {
            id: id.to_string(),
            type_: type_.to_string(),
            payload,
        }
    }

    #[tokio::test]
    async fn gated_handle_refuses_pre_auth_spawn_and_validates_token() {
        // QA P1 repro, in-module: a gated connection starts un-authed; spawn
        // is refused with the generic UNAUTHORIZED before any handler runs,
        // a wrong token is refused the same way, and the correct token
        // authenticates (retry on the same connection is allowed).
        let state = gate_test_state(Some("s3cret"));
        let (tx, _rx) = mpsc::channel(8);
        let mut ctx = gate_test_ctx(false);

        let refused = handle(
            gate_request("r1", "spawn", json!({"projectId": "p", "shell": "/bin/bash"})),
            &state,
            &tx,
            &mut ctx,
        )
        .await;
        assert_eq!(refused, Err(("UNAUTHORIZED", "Unauthorized".to_string())));
        assert!(!ctx.authed, "refused spawn must not authenticate");

        let wrong = handle(
            gate_request("r2", "authenticate", json!({"token": "WRONG"})),
            &state,
            &tx,
            &mut ctx,
        )
        .await;
        assert_eq!(wrong, Err(("UNAUTHORIZED", "Unauthorized".to_string())));
        assert!(!ctx.authed, "wrong token must not authenticate");

        let missing = handle(
            gate_request("r3", "authenticate", json!({})),
            &state,
            &tx,
            &mut ctx,
        )
        .await;
        assert_eq!(missing, Err(("UNAUTHORIZED", "Unauthorized".to_string())));
        assert!(!ctx.authed);

        let ok = handle(
            gate_request("r4", "authenticate", json!({"token": "s3cret"})),
            &state,
            &tx,
            &mut ctx,
        )
        .await;
        assert_eq!(ok, Ok(json!({})));
        assert!(ctx.authed, "correct token authenticates the connection");

        // Post-auth, requests dispatch normally again (unknown type reaches
        // the legacy NOT_IMPLEMENTED arm instead of the gate refusal).
        let unknown = handle(gate_request("r5", "bogus-op", json!({})), &state, &tx, &mut ctx).await;
        assert_eq!(
            unknown,
            Err(("NOT_IMPLEMENTED", "unknown terminal request".to_string()))
        );
    }

    #[tokio::test]
    async fn ungated_handle_treats_authenticate_as_noop_success() {
        // New-client/old-server tolerance: an ungated server accepts
        // `authenticate` as a no-op success, so clients that always send it
        // keep working on pre-gate deployments.
        let state = gate_test_state(None);
        let (tx, _rx) = mpsc::channel(8);
        // run() initializes ungated connections authed: true.
        let mut ctx = gate_test_ctx(true);
        let reply = handle(
            gate_request("r1", "authenticate", json!({"token": "anything"})),
            &state,
            &tx,
            &mut ctx,
        )
        .await;
        assert_eq!(reply, Ok(json!({})));
        assert!(ctx.authed);
    }

    #[test]
    fn unauthorized_error_is_single_generic_shape_for_all_surfaces() {
        // attach, rotate_claim and revoke_claim must all fail with the same
        // code + message shape — no distinguishing unknown terminal from
        // wrong/revoked credential from binding mismatch (CAP-3 leak fix).
        let (code, message) = unauthorized_error("t1");
        assert_eq!(code, "UNAUTHORIZED");
        // Byte-identical to the desktop error string and independent of the
        // terminal id (no input echo — nothing distinguishes failure causes).
        assert_eq!(message, "Unauthorized");
        assert_eq!(unauthorized_error("t1"), unauthorized_error("t2"));
        assert_ne!(code, "TERMINAL_NOT_FOUND", "existence-leaking code must not return");
    }

    #[tokio::test]
    async fn connection_detach_aborts_attachment_and_clears_authorization() {
        // This test pins the ConnectionContext::detach PRIMITIVE the teardown
        // relies on: aborting the attachment task and clearing authorization.
        // It does NOT drive handle() — the handler wiring (rotate_claim/
        // revoke_claim calling ctx.detach, plus the cross-connection
        // generation teardown inside attachment tasks) requires a live
        // PtyManager seam and is covered in CI integration, not here.
        let mut ctx = ConnectionContext {
            authorized: Arc::new(RwLock::new(HashSet::new())),
            attachments: HashMap::new(),
            // Tests exercise post-gate behavior; the ungated posture starts
            // every connection authed.
            authed: true,
        };
        ctx.authorize("t1");

        // A live attachment task mimicking the output forwarder.
        let task = tokio::spawn(async {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        });
        ctx.attachments.insert("t1".to_string(), task);

        assert!(ctx.is_authorized("t1"));
        ctx.detach("t1");

        // Output stream severed + write/resize authorization removed, and the
        // abort actually reached the task (teardown is real, not bookkeeping).
        assert!(!ctx.is_authorized("t1"));
        assert!(ctx.attachments.is_empty());
    }

    /// Spawn a live PTY through the handler on the OWNER context (default
    /// shell + home cwd — platform-agnostic) and return its terminal id.
    async fn spawn_owned(state: &crate::web::ws::AppState, owner: &mut ConnectionContext) -> String {
        let (tx, _rx) = mpsc::channel(8);
        let spawned = handle(
            gate_request("spawn-1", "spawn", json!({"projectId": "p"})),
            state,
            &tx,
            owner,
        )
        .await
        .expect("owner spawn succeeds");
        let id = spawned["id"].as_str().expect("spawn reply carries id").to_string();
        assert!(owner.is_authorized(&id), "issuance authorizes the spawner");
        id
    }

    #[tokio::test]
    async fn kill_requires_authorization_before_existence_check_or_force_kill() {
        // CWE-862 regression: a connection holding only the shared web token
        // must not kill another connection's PTY. The authorization check runs
        // BEFORE any existence check or force_kill and collapses to the single
        // generic UNAUTHORIZED — identical for a live foreign terminal and an
        // unknown id (existence is never revealed).
        let state = gate_test_state(None);
        let (tx, _rx) = mpsc::channel(8);
        let mut owner = gate_test_ctx(true);
        let terminal_id = spawn_owned(&state, &mut owner).await;
        let generic = Err(unauthorized_error(&terminal_id));

        // Attacker connection: authed (ungated server admits the connection)
        // but NOT authorized for the owner's terminal.
        let mut attacker = gate_test_ctx(true);
        let foreign = handle(
            gate_request("k1", "kill", json!({"terminalId": terminal_id})),
            &state,
            &tx,
            &mut attacker,
        )
        .await;
        let unknown = handle(
            gate_request("k2", "kill", json!({"terminalId": "term-never-existed"})),
            &state,
            &tx,
            &mut attacker,
        )
        .await;
        assert_eq!(foreign, generic);
        assert_eq!(unknown, generic, "unknown-terminal kill must be identical");
        assert!(
            state.pty.get(&terminal_id).is_some(),
            "a foreign kill must leave the PTY running"
        );

        // Authorized behavior preserved: the owner kills its own terminal…
        let owner_kill = handle(
            gate_request("k3", "kill", json!({"terminalId": terminal_id})),
            &state,
            &tx,
            &mut owner,
        )
        .await;
        assert_eq!(owner_kill, Ok(Value::Null));
        assert!(state.pty.get(&terminal_id).is_none());
        // …and a repeat kill collapses to the same generic UNAUTHORIZED (the
        // first kill detached the terminal — no existence leak on retry).
        let repeat = handle(
            gate_request("k4", "kill", json!({"terminalId": terminal_id})),
            &state,
            &tx,
            &mut owner,
        )
        .await;
        assert_eq!(repeat, generic);
    }

    #[tokio::test]
    async fn resize_requires_authorization_and_collapses_with_unknown_terminal() {
        // Same contract as kill: unauthorized resize and unknown-terminal
        // resize are the identical generic UNAUTHORIZED (no existence leak),
        // and the authorized resizer is unaffected.
        let state = gate_test_state(None);
        let (tx, _rx) = mpsc::channel(8);
        let mut owner = gate_test_ctx(true);
        let terminal_id = spawn_owned(&state, &mut owner).await;
        let generic = Err(unauthorized_error(&terminal_id));

        let mut attacker = gate_test_ctx(true);
        let foreign = handle(
            gate_request(
                "r1",
                "resize",
                json!({"terminalId": terminal_id, "cols": 100, "rows": 40}),
            ),
            &state,
            &tx,
            &mut attacker,
        )
        .await;
        let unknown = handle(
            gate_request(
                "r2",
                "resize",
                json!({"terminalId": "term-never-existed", "cols": 100, "rows": 40}),
            ),
            &state,
            &tx,
            &mut attacker,
        )
        .await;
        assert_eq!(foreign, generic);
        assert_eq!(unknown, generic, "unknown-terminal resize must be identical");

        // Authorized behavior preserved: the owner resizes its own terminal.
        let ok = handle(
            gate_request(
                "r3",
                "resize",
                json!({"terminalId": terminal_id, "cols": 100, "rows": 40}),
            ),
            &state,
            &tx,
            &mut owner,
        )
        .await;
        assert_eq!(ok, Ok(Value::Null));

        // Cleanup: kill the live PTY so the test doesn't leak a process.
        let _ = handle(
            gate_request("k", "kill", json!({"terminalId": terminal_id})),
            &state,
            &tx,
            &mut owner,
        )
        .await;
    }

    /// QA round 2, spec story 5: `update_orphan_detection` is accepted on an
    /// AUTHED connection with ZERO attached terminals (the settings loader
    /// pushes it at boot, pre-attach), while an un-authed connection gets the
    /// single generic UNAUTHORIZED via the connection gate — identical for a
    /// gated connection before `authenticate`.
    #[tokio::test]
    async fn update_orphan_detection_accepted_on_authed_connection_with_zero_terminals() {
        let state = gate_test_state(Some("s3cret"));
        let (tx, _rx) = mpsc::channel(8);

        // Authed connection, no authorized terminals at all.
        let mut authed = gate_test_ctx(true);
        assert!(authed.authorized.read().is_empty());
        let accepted = handle(
            gate_request("od-1", "update_orphan_detection", json!({"enabled": true, "timeout": 15})),
            &state,
            &tx,
            &mut authed,
        )
        .await;
        assert_eq!(accepted, Ok(Value::Null));

        // Un-authed (gated, pre-authenticate) connection: the connection gate
        // refuses before the arm — the single generic UNAUTHORIZED, no state
        // change, and the connection stays un-authed.
        let mut unauthed = gate_test_ctx(false);
        let refused = handle(
            gate_request("od-2", "update_orphan_detection", json!({"enabled": false})),
            &state,
            &tx,
            &mut unauthed,
        )
        .await;
        assert_eq!(refused, Err(("UNAUTHORIZED", "Unauthorized".to_string())));
        assert!(!unauthed.authed);
    }

    /// Story 5: `list_preserved {projectId}` on an AUTHED connection returns
    /// the preserved terminals of that project — metadata plus a freshly
    /// issued claim that a subsequent `attach` accepts (reattach-by-claim).
    /// The re-issue replaces the prior record: the ORIGINAL spawn claim stops
    /// verifying (revoke-and-reissue), so a stale pre-reload credential gains
    /// nothing from the new issuance.
    #[tokio::test]
    async fn list_preserved_returns_terminals_and_fresh_claims_for_authed_connection() {
        let state = gate_test_state(None);
        let (tx, _rx) = mpsc::channel(16);
        let mut owner = gate_test_ctx(true);

        // Two live terminals for project-a, one for project-b.
        let spawned_a1 = handle(
            gate_request("s1", "spawn", json!({"projectId": "project-a"})),
            &state,
            &tx,
            &mut owner,
        )
        .await
        .expect("spawn a1");
        let id_a1 = spawned_a1["id"].as_str().unwrap().to_string();
        let original_claim_a1 = spawned_a1["claim"].as_str().unwrap().to_string();
        let _ = handle(
            gate_request("s2", "spawn", json!({"projectId": "project-a"})),
            &state,
            &tx,
            &mut owner,
        )
        .await
        .expect("spawn a2");
        let spawned_b = handle(
            gate_request("s3", "spawn", json!({"projectId": "project-b"})),
            &state,
            &tx,
            &mut owner,
        )
        .await
        .expect("spawn b");
        let id_b = spawned_b["id"].as_str().unwrap().to_string();

        // Fresh authed connection with ZERO authorized terminals asks for
        // project-a (the reload case: new page, no attaches yet).
        let mut reloader = gate_test_ctx(true);
        let listed = handle(
            gate_request("lp-1", "list_preserved", json!({"projectId": "project-a"})),
            &state,
            &tx,
            &mut reloader,
        )
        .await
        .expect("list_preserved succeeds");

        let terminals = listed["terminals"].as_array().expect("terminals array");
        assert_eq!(terminals.len(), 2, "both project-a PTYs preserved");
        let ids: Vec<&str> = terminals.iter().filter_map(|t| t["id"].as_str()).collect();
        assert!(ids.contains(&id_a1.as_str()));
        let entry_a1 = terminals
            .iter()
            .find(|t| t["id"].as_str() == Some(id_a1.as_str()))
            .unwrap();
        assert!(entry_a1["shell"].as_str().is_some());
        assert!(entry_a1["cwd"].as_str().is_some());
        assert!(entry_a1["pid"].as_u64().is_some());
        let fresh_claim = entry_a1["claim"].as_str().expect("fresh claim").to_string();
        assert!(!fresh_claim.is_empty());
        assert_ne!(fresh_claim, original_claim_a1);

        // The fresh claim attaches (verified reattach path), while the
        // ORIGINAL claim — held only by the pre-reload page — no longer
        // verifies (record replaced) and takes the generic UNAUTHORIZED.
        let attach_ok = handle(
            gate_request(
                "at-1",
                "attach",
                json!({"terminalId": id_a1, "claim": fresh_claim, "lastSeq": 0}),
            ),
            &state,
            &tx,
            &mut reloader,
        )
        .await;
        assert!(attach_ok.is_ok(), "fresh claim attaches: {attach_ok:?}");
        let attach_stale = handle(
            gate_request(
                "at-2",
                "attach",
                json!({"terminalId": id_a1, "claim": original_claim_a1, "lastSeq": 0}),
            ),
            &state,
            &tx,
            &mut owner,
        )
        .await;
        assert_eq!(
            attach_stale,
            Err(unauthorized_error(&id_a1)),
            "the pre-reload claim must be dead after re-issue"
        );

        // Cleanup: kill both projects' terminals so no PTY processes leak.
        for (request_id, terminal_id) in [
            ("k1", id_a1.as_str()),
            ("k2", id_b.as_str()),
        ] {
            let _ = handle(
                gate_request(request_id, "kill", json!({"terminalId": terminal_id})),
                &state,
                &tx,
                &mut owner,
            )
            .await;
        }
        // a2 id discovered from the listing above.
        for entry in terminals {
            let Some(id) = entry["id"].as_str() else { continue };
            let _ = handle(
                gate_request("kx", "kill", json!({"terminalId": id})),
                &state,
                &tx,
                &mut owner,
            )
            .await;
        }
    }

    /// Story 5 no-leak bars, pinned in-module:
    /// 1. Pre-auth `list_preserved` takes the connection gate's single
    ///    generic UNAUTHORIZED (never a VALIDATION_ERROR or a count) — no
    ///    existence signal for un-authed clients.
    /// 2. An authed connection asking for a project with NO preserved
    ///    terminals gets the same empty-list reply shape as any other
    ///    project — an unknown project is indistinguishable from an empty
    ///    one.
    /// 3. Cross-reload listing is idempotent in PTY count: repeated
    ///    `list_preserved` cycles re-issue claims but never create or
    ///    destroy terminals (the 3-reload-cycles no-leak row).
    #[tokio::test]
    async fn list_preserved_refuses_unauthed_and_leaks_no_existence() {
        let state = gate_test_state(Some("s3cret"));
        let (tx, _rx) = mpsc::channel(8);

        // Pre-auth: the gate refuses with the single generic UNAUTHORIZED.
        let mut unauthed = gate_test_ctx(false);
        let refused = handle(
            gate_request("lp-auth", "list_preserved", json!({"projectId": "project-a"})),
            &state,
            &tx,
            &mut unauthed,
        )
        .await;
        assert_eq!(refused, Err(("UNAUTHORIZED", "Unauthorized".to_string())));
        // A missing projectId on an AUTHED connection is a shape error
        // (nothing about any terminal is revealed — ids are structural).
        let authed_bad_shape = handle(
            gate_request("lp-shape", "list_preserved", json!({})),
            &state,
            &tx,
            &mut unauthed,
        )
        .await;
        assert_eq!(authed_bad_shape, Err(("UNAUTHORIZED", "Unauthorized".to_string())));

        // Authenticate the same connection, then query with a missing
        // projectId: now VALIDATION_ERROR (structural) — the gate is the
        // only existence boundary.
        let auth = handle(
            gate_request("auth", "authenticate", json!({"token": "s3cret"})),
            &state,
            &tx,
            &mut unauthed,
        )
        .await;
        assert_eq!(auth, Ok(json!({})));
        let shape = handle(
            gate_request("lp-shape2", "list_preserved", json!({})),
            &state,
            &tx,
            &mut unauthed,
        )
        .await;
        assert_eq!(
            shape,
            Err(("VALIDATION_ERROR", "missing projectId".to_string()))
        );

        // Empty vs unknown project: identical reply shape, no PTY created.
        let before = state.pty.get_count();
        let empty = handle(
            gate_request("lp-empty", "list_preserved", json!({"projectId": "project-none"})),
            &state,
            &tx,
            &mut unauthed,
        )
        .await
        .expect("empty list succeeds");
        assert_eq!(empty["terminals"].as_array().map(Vec::len), Some(0));
        assert_eq!(state.pty.get_count(), before, "no PTY created by listing");

        // 3 reload cycles: spawn one terminal, then list 3 times — the
        // preserved count stays 1 and the terminal id is stable each time.
        let mut owner = gate_test_ctx(true);
        let spawned = handle(
            gate_request("s", "spawn", json!({"projectId": "project-cycles"})),
            &state,
            &tx,
            &mut owner,
        )
        .await
        .expect("spawn");
        let id = spawned["id"].as_str().unwrap().to_string();
        for cycle in 0..3 {
            let listed = handle(
                gate_request(&format!("lp-{cycle}"), "list_preserved", json!({"projectId": "project-cycles"})),
                &state,
                &tx,
                &mut unauthed,
            )
            .await
            .expect("cycle list succeeds");
            let terminals = listed["terminals"].as_array().unwrap();
            assert_eq!(terminals.len(), 1, "cycle {cycle}: preserved count stable");
            assert_eq!(terminals[0]["id"].as_str(), Some(id.as_str()));
            let claim = terminals[0]["claim"].as_str().unwrap();
            // Each cycle's claim is fresh (re-issue) and verifies.
            assert_eq!(state.pty.verify_claim(&id, claim), Ok(()));
        }
        assert_eq!(state.pty.get_count(), before + 1, "3 cycles leaked no PTY");

        // Cleanup.
        let _ = handle(
            gate_request("k", "kill", json!({"terminalId": id})),
            &state,
            &tx,
            &mut owner,
        )
        .await;
    }
}
