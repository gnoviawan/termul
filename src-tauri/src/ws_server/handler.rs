use super::{AppState, WsServer, WsClient, WsOutbound, WsInbound};
use crate::ws_server::commands::handle_command;
use axum::extract::ws::{Message, WebSocket};
use axum::extract::{State, WebSocketUpgrade};
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Instant;
use tauri::{AppHandle, Emitter};

const SESSION_IDLE_TIMEOUT_SECS: u64 = 900;
const SESSION_MAX_DURATION_SECS: u64 = 28_800;

pub(crate) async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let connection_context = state.server.get_connection_context().await;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    let token_expired = now >= connection_context.1 + connection_context.2;

    if token_expired {
        log::warn!("[WsServer] Rejecting WS connection: token expired");
        return ws.on_upgrade(move |_| async move {
            log::info!("[WsServer] Dropped expired connection");
        });
    }

    let server = state.server;
    let token = connection_context.0;
    let expected_project_id = connection_context.4;
    let expected_session_id = connection_context.3;
    let app = state.app_handle;

    let addr = SocketAddr::from(([127, 0, 0, 1], 0));
    server.log_connection(&addr, "connecting");

    ws.on_upgrade(move |socket| handle_ws(socket, server, token, expected_project_id, expected_session_id, app, addr))
}

pub(crate) async fn shutdown_signal(server: Arc<WsServer>) {
    while server.running.load(Ordering::SeqCst) {
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
    }
}

async fn handle_ws(
    socket: WebSocket,
    server: Arc<WsServer>,
    auth_token: String,
    expected_project_id: Option<String>,
    expected_session_id: String,
    app_handle: AppHandle,
    addr: SocketAddr,
) {
    let (ws_write, mut ws_read) = socket.split();

    let client_id = format!("{}-{}", addr.ip(), std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis());

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<WsOutbound>();

    {
        let mut clients = server.clients.lock().await;
        clients.insert(client_id.clone(), WsClient {
            authenticated: false,
            tx: tx.clone(),
            connected_at: Instant::now(),
        });
        let mut status = server.status.lock().await;
        status.client_count = clients.len();
        let _ = app_handle.emit("ws-server-status-changed", status.clone());
    }

    let mut event_rx = server.event_tx.subscribe();

    let write_task = tokio::spawn(async move {
        let mut ws_write = ws_write;
        loop {
            tokio::select! {
                Some(msg) = rx.recv() => {
                    let send_result = match msg {
                        WsOutbound::Pong(data) => ws_write.send(Message::Pong(data)).await,
                        other => {
                            if let Ok(text) = serde_json::to_string(&other) {
                                ws_write.send(Message::Text(text)).await
                            } else {
                                break;
                            }
                        }
                    };
                    if send_result.is_err() {
                        break;
                    }
                }
                Ok(event) = event_rx.recv() => {
                    if let Ok(text) = serde_json::to_string(&event) {
                        if ws_write.send(Message::Text(text)).await.is_err() {
                            break;
                        }
                    }
                }
                else => break,
            }
        }
    });

    let connected_at = Instant::now();
    let mut last_activity = connected_at;

    loop {
        let idle_deadline = tokio::time::Instant::from_std(last_activity + std::time::Duration::from_secs(SESSION_IDLE_TIMEOUT_SECS));
        let max_deadline = tokio::time::Instant::from_std(connected_at + std::time::Duration::from_secs(SESSION_MAX_DURATION_SECS));

        tokio::select! {
            _ = tokio::time::sleep_until(idle_deadline) => {
                log::warn!("[WsServer] Closing idle websocket client: {}", addr);
                break;
            }
            _ = tokio::time::sleep_until(max_deadline) => {
                log::warn!("[WsServer] Closing expired websocket session: {}", addr);
                break;
            }
            msg = ws_read.next() => {
                let Some(Ok(msg)) = msg else { break; };
                last_activity = Instant::now();

                match msg {
                    Message::Text(text) => {
                        if let Ok(ws_msg) = serde_json::from_str::<WsInbound>(&text) {
                            match ws_msg {
                                WsInbound::Auth { token, project_id, session_id } => {
                                    let project_ok = match &project_id {
                                        Some(id) => expected_project_id.as_ref() == Some(id),
                                        None => true,
                                    };
                                    let session_ok = match &session_id {
                                        Some(id) => id == &expected_session_id,
                                        None => true,
                                    };
                                    let context_ok = project_ok && session_ok;
                                    let success = token == auth_token && context_ok;
                                    let resp = if success {
                                        let mut clients = server.clients.lock().await;
                                        if let Some(client) = clients.get_mut(&client_id) {
                                            client.authenticated = true;
                                        }
                                        server.log_connection(&addr, "authenticated");
                                        WsOutbound::Response {
                                            id: "auth".to_string(),
                                            success: true,
                                            data: None,
                                            error: None,
                                            code: None,
                                        }
                                    } else {
                                        server.log_connection(&addr, "auth_failed");
                                        WsOutbound::Response {
                                            id: "auth".to_string(),
                                            success: false,
                                            data: None,
                                            error: Some(if !context_ok { "Invalid auth context".to_string() } else { "Invalid auth token".to_string() }),
                                            code: Some(if !context_ok { "AUTH_CONTEXT_MISMATCH".to_string() } else { "AUTH_FAILED".to_string() }),
                                        }
                                    };
                                    let _ = tx.send(resp);
                                    if !success {
                                        log::warn!("[WsServer] Auth failed for {}", addr);
                                        break;
                                    }
                                    log::info!("[WsServer] WS client authenticated: {}", addr);
                                }
                                WsInbound::Request { id, method, params } => {
                                    let is_authenticated = {
                                        let clients = server.clients.lock().await;
                                        clients.get(&client_id).map(|c| c.authenticated).unwrap_or(false)
                                    };

                                    if !is_authenticated {
                                        let _ = tx.send(WsOutbound::Response {
                                            id,
                                            success: false,
                                            data: None,
                                            error: Some("Not authenticated".to_string()),
                                            code: Some("NOT_AUTHENTICATED".to_string()),
                                        });
                                        continue;
                                    }

                                    let app_handle_clone = app_handle.clone();
                                    let server_clone = server.clone();
                                    let tx_clone = tx.clone();
                                    let method_string = method.clone();
                                    let id_string = id.clone();

                                    tokio::spawn(async move {
                                        let result = handle_command(&method_string, params, &app_handle_clone, &server_clone).await;
                                        let resp = match result {
                                            Ok(ipc_result) => {
                                                if ipc_result.success {
                                                    WsOutbound::Response {
                                                        id: id_string,
                                                        success: true,
                                                        data: ipc_result.data,
                                                        error: None,
                                                        code: None,
                                                    }
                                                } else {
                                                    WsOutbound::Response {
                                                        id: id_string,
                                                        success: false,
                                                        data: None,
                                                        error: ipc_result.error,
                                                        code: ipc_result.code,
                                                    }
                                                }
                                            }
                                            Err(e) => WsOutbound::Response {
                                                id: id_string,
                                                success: false,
                                                data: None,
                                                error: Some(e),
                                                code: Some("COMMAND_ERROR".to_string()),
                                            },
                                        };
                                        let _ = tx_clone.send(resp);
                                    });
                                }
                            }
                        }
                    }
                    Message::Close(_) => break,
                    Message::Ping(data) => {
                        let _ = tx.send(WsOutbound::Pong(data.to_vec()));
                    }
                    _ => {}
                }
            }
        }
    }

    write_task.abort();

    {
        let mut clients = server.clients.lock().await;
        let client = clients.remove(&client_id);
        let mut status = server.status.lock().await;
        status.client_count = clients.len();
        if let Some(c) = client {
            let duration = c.connected_at.elapsed();
            log::info!("[WsServer] Client {} disconnected after {:.1}s", addr, duration.as_secs_f64());
            server.log_connection(&addr, "disconnected");
        }
        let _ = app_handle.emit("ws-server-status-changed", status.clone());
    }
}
