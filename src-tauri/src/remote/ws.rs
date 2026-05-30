//! WebSocket handler for terminal I/O
//!
//! Implements a bidirectional bridge between browser xterm.js and Tauri PtyManager:
//! - On connect, replays the terminal's scrollback buffer (persistence/parity)
//! - Streams live PTY output via `broadcast::Receiver` as `Message::Binary` frames
//! - Receives terminal input from browser (`Message::Binary`) and writes to PTY stdin
//! - Handles resize control messages (`Message::Text` JSON)
//! - Sends terminal exit notification on PTY shutdown
//!
//! ## Access model (no token)
//!
//! Per product requirement, the server is reachable by `ip:port` alone — there is
//! no auth token. To still defend against Cross-Site WebSocket Hijacking (CSWSH),
//! we enforce a **same-origin** check: the `Origin` header must be present and
//! match the request `Host`. A browser page on another site therefore cannot open
//! a socket to this server using the victim's network position. Requests missing
//! `Origin` are rejected with 403 (fail closed). The server still binds to
//! `127.0.0.1` by default; exposing it via a tunnel is the operator's risk.
//!
//! Multiple clients per terminal are supported via broadcast fan-out. All clients
//! share the same PTY session (collaborative terminal, not independent sessions).

use crate::pty::PtyManager;
use crate::remote::auth::{validate_same_origin, ConnectionTracker};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, Query, State,
    },
    http::{HeaderMap, StatusCode},
    response::Response,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::broadcast::error::RecvError;
use tracing::{debug, error, info, warn};

/// Query parameters for WebSocket upgrade
#[derive(Debug, Clone, Deserialize)]
pub struct WsUpgradeParams {
    pub terminal_id: String,
}

/// Control messages sent as JSON text frames
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ControlMessage {
    #[serde(rename = "resize")]
    Resize { cols: u16, rows: u16 },
    #[serde(rename = "exit")]
    Exit { code: i32 },
    #[serde(rename = "error")]
    Error { message: String },
    #[serde(rename = "connected")]
    Connected { terminal_id: String },
}

/// Shared state for all WebSocket handlers
#[derive(Clone)]
pub struct WsState {
    pub pty_manager: Arc<PtyManager>,
    pub connection_tracker: Arc<ConnectionTracker>,
    /// Max concurrent WebSocket clients per terminal.
    pub max_connections_per_terminal: usize,
}

/// WebSocket upgrade handler
///
/// Security checks performed before upgrade:
/// 1. Same-origin validation (CSWSH prevention)
/// 2. Terminal existence check
/// 3. Per-terminal connection limit
///
/// On successful upgrade, spawns a task that:
/// - Replays scrollback, then subscribes to the live broadcast (atomic seam)
/// - Splits the WebSocket into read/write halves
/// - Bridges browser↔PTY in two concurrent tasks, joined via `tokio::select!`
#[tracing::instrument(level = "info", skip(ws, headers, state), fields(addr = %addr.ip()))]
pub async fn ws_upgrade(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    addr: ConnectInfo<SocketAddr>,
    Query(params): Query<WsUpgradeParams>,
    State(state): State<WsState>,
) -> Result<Response, (StatusCode, &'static str)> {
    let addr = addr.0;
    info!("WebSocket upgrade request from {}", addr.ip());

    // 1. Same-origin validation (CSWSH prevention)
    if let Err(status) = validate_same_origin(&headers) {
        warn!("Same-origin validation failed for {}", addr.ip());
        return Err(status);
    }

    // 2. Verify terminal exists
    if state.pty_manager.get(&params.terminal_id).is_none() {
        error!("Terminal {} not found", params.terminal_id);
        return Err((StatusCode::NOT_FOUND, "Terminal not found"));
    }

    // 3. Connection limit check
    if !state
        .connection_tracker
        .try_add(&params.terminal_id, state.max_connections_per_terminal)
    {
        warn!(
            "Connection limit exceeded for terminal {}",
            params.terminal_id
        );
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "Too many connections to this terminal",
        ));
    }

    info!(
        "Upgrade authorized for {} → terminal {}",
        addr.ip(),
        params.terminal_id
    );

    let tracker = Arc::clone(&state.connection_tracker);
    Ok(ws.on_upgrade(move |socket| async move {
        handle_socket(socket, params, state, tracker).await;
    }))
}

async fn handle_socket(
    socket: WebSocket,
    params: WsUpgradeParams,
    state: WsState,
    connection_tracker: Arc<ConnectionTracker>,
) {
    let terminal_id = params.terminal_id;
    info!("WebSocket connected to terminal {}", terminal_id);

    // Atomically snapshot scrollback AND subscribe to live output. Holding the
    // scrollback lock across both prevents any loss/duplication at the seam.
    let (backlog, mut rx) = match state.pty_manager.get(&terminal_id) {
        Some(instance) => instance.subscribe_with_backlog(),
        None => {
            error!("Terminal {} disappeared after auth", terminal_id);
            connection_tracker.remove(&terminal_id);
            return;
        }
    };

    // Split WebSocket into read/write halves for concurrent I/O
    let (mut ws_sender, mut ws_receiver) = socket.split();

    // Send initial "connected" control message
    let connected_msg = ControlMessage::Connected {
        terminal_id: terminal_id.clone(),
    };
    if let Ok(json) = serde_json::to_string(&connected_msg) {
        let _ = ws_sender.send(Message::Text(json.into())).await;
    }

    // Replay scrollback so the web client sees prior output (persistence).
    if !backlog.is_empty()
        && ws_sender
            .send(Message::Binary(backlog.into()))
            .await
            .is_err()
    {
        connection_tracker.remove(&terminal_id);
        return;
    }

    // Spawn two concurrent tasks:
    // 1. Sender: PTY output → Browser (broadcast receiver → WS sender)
    // 2. Receiver: Browser → PTY (WS receiver → PTY writer)

    let pty_manager_sender = Arc::clone(&state.pty_manager);
    let terminal_id_sender = terminal_id.clone();
    let terminal_id_receiver = terminal_id.clone();

    let mut sender_task = tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(data) => {
                    // PTY output → browser as binary frame
                    if ws_sender.send(Message::Binary(data.into())).await.is_err() {
                        debug!("WebSocket closed, stopping output loop");
                        break;
                    }
                }
                Err(RecvError::Lagged(n)) => {
                    // Slow consumer: client missed messages
                    warn!(
                        "Client lagged on {}, dropped {} messages",
                        terminal_id_sender, n
                    );
                    // Continue; gaps in terminal output are acceptable
                }
                Err(RecvError::Closed) => {
                    // Terminal shut down
                    info!("Terminal {} broadcast closed", terminal_id_sender);
                    let exit_msg = ControlMessage::Exit { code: 1 };
                    if let Ok(json) = serde_json::to_string(&exit_msg) {
                        let _ = ws_sender.send(Message::Text(json.into())).await;
                    }
                    let _ = ws_sender.send(Message::Close(None)).await;
                    break;
                }
            }
        }
    });

    let mut receiver_task = tokio::spawn(async move {
        while let Some(msg) = ws_receiver.next().await {
            match msg {
                Ok(Message::Binary(data)) => {
                    // User input: browser → PTY stdin
                    let input_str = String::from_utf8_lossy(&data);
                    if let Err(e) = pty_manager_sender
                        .write(&terminal_id_receiver, &input_str)
                        .await
                    {
                        error!("Failed to write to PTY: {}", e);
                        break;
                    }
                }
                Ok(Message::Text(text)) => {
                    // Control message (resize, exit)
                    match serde_json::from_str::<ControlMessage>(&text) {
                        Ok(ControlMessage::Resize { cols, rows }) => {
                            debug!("Resize: {}x{} for {}", cols, rows, terminal_id_receiver);
                            let _ = pty_manager_sender
                                .resize(&terminal_id_receiver, cols, rows)
                                .await;
                        }
                        Ok(ControlMessage::Exit { .. }) => {
                            debug!("Client requested disconnect");
                            // Don't kill the PTY; just close the WS
                            break;
                        }
                        Ok(other) => {
                            warn!("Unexpected control message: {:?}", other);
                        }
                        Err(e) => {
                            warn!("Invalid control message JSON: {}", e);
                        }
                    }
                }
                Ok(Message::Close(_)) => {
                    info!("Client disconnected from {}", terminal_id_receiver);
                    break;
                }
                Ok(Message::Ping(_)) => {
                    // WebSocket protocol: respond with Pong (axum handles this automatically)
                    debug!("Ping from client on {}", terminal_id_receiver);
                }
                Ok(Message::Pong(_)) => {
                    // Ignore pong messages
                }
                Err(e) => {
                    error!("WebSocket receive error: {}", e);
                    break;
                }
            }
        }
    });

    // Wait for either task to complete (client disconnect or terminal exit),
    // then abort the survivor so cleanup is deterministic (no leaked task
    // holding the socket half or broadcast receiver).
    tokio::select! {
        _ = &mut sender_task => {
            debug!("Sender task finished for {}", terminal_id);
            receiver_task.abort();
            let _ = receiver_task.await;
        }
        _ = &mut receiver_task => {
            debug!("Receiver task finished for {}", terminal_id);
            sender_task.abort();
            let _ = sender_task.await;
        }
    }

    // Clean up connection tracker on disconnect
    connection_tracker.remove(&terminal_id);
    info!(
        "WebSocket connection closed for terminal {} ({} active connection(s) remaining)",
        terminal_id,
        connection_tracker.total()
    );
}
