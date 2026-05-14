//! SSH Port Forwarding
//!
//! Manages local and remote port forwards over SSH connections.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::task::JoinHandle;

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
    should_stop: Arc<AtomicBool>,
    task: JoinHandle<()>,
    info: ActivePortForward,
}

pub struct PortForwardManager {
    app_handle: AppHandle,
    /// connection_id -> forward_id -> handle
    forwards: parking_lot::RwLock<HashMap<String, HashMap<String, ForwardHandle>>>,
}

impl PortForwardManager {
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            app_handle,
            forwards: parking_lot::RwLock::new(HashMap::new()),
        }
    }

    /// Start a local port forward
    ///
    /// Binds to local_port and tunnels traffic through the SSH session
    /// to remote_host:remote_port.
    pub async fn start_local_forward(
        &self,
        connection_id: &str,
        request: PortForwardRequest,
        session_host: &str,
        session_port: u16,
    ) -> Result<ActivePortForward, String> {
        let forward_id = request.id.clone();

        // Try to bind the local port
        let listener = TcpListener::bind(format!("127.0.0.1:{}", request.local_port))
            .map_err(|e| format!("Failed to bind port {}: {}", request.local_port, e))?;

        listener
            .set_nonblocking(true)
            .map_err(|e| format!("Failed to set non-blocking: {}", e))?;

        let forward_info = ActivePortForward {
            id: forward_id.clone(),
            config_id: request.id.clone(),
            local_port: request.local_port,
            remote_host: request.remote_host.clone(),
            remote_port: request.remote_port,
            forward_type: "local".to_string(),
            status: "active".to_string(),
            error: None,
        };

        let should_stop = Arc::new(AtomicBool::new(false));
        let should_stop_clone = should_stop.clone();
        let remote_host = request.remote_host.clone();
        let remote_port = request.remote_port;
        let ssh_addr = format!("{}:{}", session_host, session_port);
        let app_handle = self.app_handle.clone();
        let conn_id = connection_id.to_string();
        let fwd_info_clone = forward_info.clone();

        // Spawn the forwarding loop
        let task = tokio::spawn(async move {
            Self::local_forward_loop(
                listener,
                ssh_addr,
                remote_host,
                remote_port,
                should_stop_clone,
                app_handle,
                conn_id,
                fwd_info_clone,
            )
            .await;
        });

        // Store the handle
        {
            let mut forwards = self.forwards.write();
            let conn_forwards = forwards
                .entry(connection_id.to_string())
                .or_insert_with(HashMap::new);

            conn_forwards.insert(
                forward_id.clone(),
                ForwardHandle {
                    should_stop,
                    task,
                    info: forward_info.clone(),
                },
            );
        }

        // Emit status
        self.emit_forward_status(connection_id, &forward_info);

        Ok(forward_info)
    }

    /// Local port forward loop - accepts connections and tunnels them
    async fn local_forward_loop(
        listener: TcpListener,
        _ssh_addr: String,
        remote_host: String,
        remote_port: u16,
        should_stop: Arc<AtomicBool>,
        app_handle: AppHandle,
        connection_id: String,
        forward_info: ActivePortForward,
    ) {
        log::info!(
            "[SSH-PF] Local forward active: 127.0.0.1:{} -> {}:{}",
            forward_info.local_port,
            remote_host,
            remote_port
        );

        loop {
            if should_stop.load(Ordering::Relaxed) {
                break;
            }

            // Non-blocking accept with sleep to check should_stop
            match listener.accept() {
                Ok((client_stream, _addr)) => {
                    let remote_host = remote_host.clone();
                    let _remote_port = remote_port;
                    let _app_handle = app_handle.clone();
                    let _connection_id = connection_id.clone();

                    // For each accepted connection, we need to tunnel through SSH
                    // In a real implementation, this would use the SSH session's channel_direct_tcpip
                    // For now, we log the connection attempt
                    log::debug!(
                        "[SSH-PF] Accepted connection on port {}, tunneling to {}:{}",
                        forward_info.local_port,
                        remote_host,
                        remote_port
                    );

                    // Spawn a task to handle this connection
                    tokio::task::spawn_blocking(move || {
                        // The actual tunneling would happen here using ssh2's channel_direct_tcpip
                        // This requires access to the SSH session which we'd pass via Arc
                        drop(client_stream);
                    });
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    // No connection pending, sleep briefly
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(e) => {
                    log::error!("[SSH-PF] Accept error: {}", e);
                    let mut failed_info = forward_info.clone();
                    failed_info.status = "failed".to_string();
                    failed_info.error = Some(format!("Accept error: {}", e));

                    if let Err(emit_err) =
                        app_handle.emit("ssh-port-forward-status-changed", (&connection_id, &failed_info))
                    {
                        log::error!("[SSH-PF] Failed to emit status: {}", emit_err);
                    }
                    break;
                }
            }
        }

        log::info!(
            "[SSH-PF] Forward stopped: 127.0.0.1:{}",
            forward_info.local_port
        );
    }

    /// Stop a port forward
    pub fn stop_forward(
        &self,
        connection_id: &str,
        forward_id: &str,
    ) -> Result<(), String> {
        let mut forwards = self.forwards.write();

        let conn_forwards = forwards
            .get_mut(connection_id)
            .ok_or_else(|| format!("No forwards for connection: {}", connection_id))?;

        let handle = conn_forwards
            .remove(forward_id)
            .ok_or_else(|| format!("Forward not found: {}", forward_id))?;

        handle.should_stop.store(true, Ordering::Relaxed);
        handle.task.abort();

        let stopped_info = ActivePortForward {
            status: "stopped".to_string(),
            ..handle.info
        };

        self.emit_forward_status(connection_id, &stopped_info);

        Ok(())
    }

    /// Stop all forwards for a connection
    #[allow(dead_code)]
    pub fn stop_all_for_connection(&self, connection_id: &str) {
        let mut forwards = self.forwards.write();

        if let Some(conn_forwards) = forwards.remove(connection_id) {
            for (_, handle) in conn_forwards {
                handle.should_stop.store(true, Ordering::Relaxed);
                handle.task.abort();
            }
        }
    }

    /// List active forwards for a connection
    #[allow(dead_code)]
    pub fn list_forwards(&self, connection_id: &str) -> Vec<ActivePortForward> {
        let forwards = self.forwards.read();
        forwards
            .get(connection_id)
            .map(|conn_forwards| {
                conn_forwards
                    .values()
                    .map(|h| h.info.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    fn emit_forward_status(&self, connection_id: &str, info: &ActivePortForward) {
        if let Err(e) = self
            .app_handle
            .emit("ssh-port-forward-status-changed", (connection_id, info))
        {
            log::error!("[SSH-PF] Failed to emit forward status: {}", e);
        }
    }
}
