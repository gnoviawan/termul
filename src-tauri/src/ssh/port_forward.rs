//! Local port forwarding over a session's SSH connection.
//!
//! A forward listens on `127.0.0.1:<local_port>` and opens one
//! `direct-tcpip` channel per accepted socket on the session's connection.
//! Forwards end with their session.

use super::connection::SshConnection;
use super::session::Emit;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::task::JoinHandle;

pub const EVENT_STATUS: &str = "ssh-port-forward-status-changed";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivePortForward {
    pub id: String,
    pub config_id: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    #[serde(rename = "type")]
    pub forward_type: String,
    pub status: String, // "active" | "failed" | "stopped"
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardRequest {
    pub id: String,
    pub forward_type: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    pub label: Option<String>,
}

struct ForwardHandle {
    task: JoinHandle<()>,
    info: ActivePortForward,
}

pub struct PortForwardManager {
    emit: Emit,
    /// session id -> forward id -> handle
    forwards: parking_lot::Mutex<HashMap<String, HashMap<String, ForwardHandle>>>,
}

pub(crate) fn validate(request: &PortForwardRequest) -> Result<(), String> {
    if request.forward_type != "local" {
        return Err(format!(
            "Unsupported port forward type: {}",
            request.forward_type
        ));
    }
    if request.local_port == 0 || request.remote_port == 0 {
        return Err("Ports must be between 1 and 65535".to_string());
    }
    if request.remote_host.trim().is_empty() {
        return Err("Remote host is empty".to_string());
    }
    Ok(())
}

impl PortForwardManager {
    pub fn new(emit: Emit) -> Self {
        Self {
            emit,
            forwards: parking_lot::Mutex::new(HashMap::new()),
        }
    }

    fn emit_status(&self, session_id: &str, info: &ActivePortForward) {
        (self.emit)(EVENT_STATUS, serde_json::json!([session_id, info]));
    }

    fn stop_handle(&self, session_id: &str, handle: ForwardHandle) {
        handle.task.abort();
        let stopped = ActivePortForward {
            status: "stopped".to_string(),
            ..handle.info
        };
        self.emit_status(session_id, &stopped);
    }

    /// Start forwarding `127.0.0.1:local_port` to `remote_host:remote_port`
    /// through the session's connection.
    pub async fn start_local_forward(
        &self,
        session_id: &str,
        request: PortForwardRequest,
        connection: Arc<SshConnection>,
    ) -> Result<ActivePortForward, String> {
        validate(&request)?;
        // Release a previous forward with the same id before binding, so
        // its listener frees the port.
        let prior = self
            .forwards
            .lock()
            .get_mut(session_id)
            .and_then(|forwards| forwards.remove(&request.id));
        if let Some(prior) = prior {
            self.stop_handle(session_id, prior);
        }

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", request.local_port))
            .await
            .map_err(|e| format!("Port {} is not available: {}", request.local_port, e))?;

        let info = ActivePortForward {
            id: request.id.clone(),
            config_id: request.id.clone(),
            local_port: request.local_port,
            remote_host: request.remote_host.clone(),
            remote_port: request.remote_port,
            forward_type: "local".to_string(),
            status: "active".to_string(),
            error: None,
        };
        let remote_host = request.remote_host.clone();
        let remote_port = u32::from(request.remote_port);
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, peer) = match listener.accept().await {
                    Ok(accepted) => accepted,
                    Err(e) => {
                        log::warn!("[SSH-PF] Accept failed: {}", e);
                        continue;
                    }
                };
                if connection.is_closed() {
                    break;
                }
                let connection = connection.clone();
                let remote_host = remote_host.clone();
                tokio::spawn(async move {
                    let channel = match connection
                        .handle()
                        .channel_open_direct_tcpip(
                            remote_host,
                            remote_port,
                            peer.ip().to_string(),
                            u32::from(peer.port()),
                        )
                        .await
                    {
                        Ok(channel) => channel,
                        Err(e) => {
                            log::warn!("[SSH-PF] Could not open tunnel: {}", e);
                            return;
                        }
                    };
                    let mut stream = channel.into_stream();
                    if let Err(e) = tokio::io::copy_bidirectional(&mut socket, &mut stream).await {
                        log::debug!("[SSH-PF] Tunnel closed: {}", e);
                    }
                });
            }
        });

        self.forwards
            .lock()
            .entry(session_id.to_string())
            .or_default()
            .insert(
                request.id.clone(),
                ForwardHandle {
                    task,
                    info: info.clone(),
                },
            );
        log::info!(
            "[SSH-PF] Forwarding local port {} for session {}",
            request.local_port,
            session_id
        );
        self.emit_status(session_id, &info);
        Ok(info)
    }

    pub fn stop_forward(&self, session_id: &str, forward_id: &str) -> Result<(), String> {
        let handle = self
            .forwards
            .lock()
            .get_mut(session_id)
            .and_then(|forwards| forwards.remove(forward_id))
            .ok_or_else(|| format!("Forward not found: {}", forward_id))?;
        self.stop_handle(session_id, handle);
        Ok(())
    }

    pub fn stop_all_for_session(&self, session_id: &str) {
        let removed = self.forwards.lock().remove(session_id);
        for (_, handle) in removed.into_iter().flatten() {
            self.stop_handle(session_id, handle);
        }
    }

    pub fn stop_all(&self) {
        let drained: Vec<_> = self.forwards.lock().drain().collect();
        for (session_id, forwards) in drained {
            for (_, handle) in forwards {
                self.stop_handle(&session_id, handle);
            }
        }
    }
}

#[cfg(test)]
mod tests;
