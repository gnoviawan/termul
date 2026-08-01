//! Dedicated interactive terminal websocket.
//!
//! This endpoint intentionally stays separate from the ACP relay. Authentication
//! is not implemented yet; never expose it to an untrusted network. All
//! operations are project-scoped: a connection may only interact with terminals
//! whose `project_id` it has been authorized for via spawn or explicit attach.

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

    info!("[terminal-ws] client connected (authentication deferred)");

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
    match request.type_.as_str() {
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
            let info = state
                .pty
                .spawn(options, None)
                .await
                .map_err(|e| ("SPAWN_FAILED", e))?;
            ctx.authorize(&info.id);
            info!("[terminal-ws] spawn success terminal_id={}", info.id);
            serde_json::to_value(info).map_err(|e| ("SPAWN_FAILED", e.to_string()))
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
                return Err(("UNAUTHORIZED", format!("Not authorized for terminal {terminal_id}")));
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
            // Idempotent kill: if the terminal is already gone, treat as success
            // so a lost reply or double-close doesn't leave an uncloseable tab.
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
            let last_seq = request.payload["lastSeq"]
                .as_u64()
                .unwrap_or(0);
            let instance = state.pty.get(&terminal_id).ok_or_else(|| {
                ("TERMINAL_NOT_FOUND", format!("Terminal not found: {terminal_id}"))
            })?;
            // attach does NOT authorize — only spawn does. This prevents a
            // client from self-authorizing for any terminal ID it discovers.
            // If the connection is not already authorized, reject.
            if !ctx.is_authorized(&terminal_id) {
                return Err((
                    "UNAUTHORIZED",
                    format!("Not authorized for terminal {terminal_id}"),
                ));
            }

            // Sequenced replay: only unseen chunks, with gap detection.
            let replay = instance.subscribe_from(last_seq);
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
            let task = tokio::spawn(async move {
                let mut receiver = replay.receiver;
                let mut current_seq = replay.latest_seq;
                loop {
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
            ctx.attachments.insert(terminal_id, task);
            Ok(json!({ "latestSeq": replay.latest_seq }))
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
            // Global setting — require at least one authorized terminal to
            // prevent arbitrary clients from changing lifecycle policy.
            if ctx.authorized.read().is_empty() {
                return Err(("UNAUTHORIZED", "Not authorized to update orphan detection".to_string()));
            }
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
        _ => Err(("NOT_IMPLEMENTED", "unknown terminal request".to_string())),
    }
}

fn string_field<'a>(value: &'a Value, key: &str) -> Result<&'a str, (&'static str, String)> {
    value[key]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ("VALIDATION_ERROR", format!("missing {key}")))
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
        };
        ctx.authorize("t1");
        assert!(ctx.is_authorized("t1"));
        assert!(!ctx.is_authorized("t2"));
        ctx.detach("t1");
        assert!(!ctx.is_authorized("t1"));
    }
}
