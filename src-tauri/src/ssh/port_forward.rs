//! SSH Port Forwarding
//!
//! Manages local and remote port forwards over SSH connections.

use serde::{Deserialize, Serialize};
use ssh2::Session;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::task::JoinHandle;

const FORWARD_ACCEPT_POLL_MS: u64 = 100;
const TUNNEL_IDLE_POLL_MS: u64 = 10;
const TUNNEL_BUFFER_SIZE: usize = 16 * 1024;

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

    /// Start a local port forward.
    ///
    /// Binds to local_port and tunnels traffic through the provided SSH session
    /// to remote_host:remote_port using `channel_direct_tcpip`.
    pub async fn start_local_forward(
        &self,
        connection_id: &str,
        request: PortForwardRequest,
        session: Session,
    ) -> Result<ActivePortForward, String> {
        if request.forward_type != "local" {
            return Err(format!(
                "Unsupported port forward type: {}",
                request.forward_type
            ));
        }

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
        let app_handle = self.app_handle.clone();
        let conn_id = connection_id.to_string();
        let fwd_info_clone = forward_info.clone();

        // Spawn the forwarding loop on the blocking pool since it uses std::thread::sleep
        let task = tokio::task::spawn_blocking(move || {
            Self::local_forward_loop(
                listener,
                session,
                remote_host,
                remote_port,
                should_stop_clone,
                app_handle,
                conn_id,
                fwd_info_clone,
            );
        });

        // Store the handle
        {
            let mut forwards = self.forwards.write();
            let conn_forwards = forwards
                .entry(connection_id.to_string())
                .or_default();

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

    /// Local port forward loop - accepts connections and tunnels them.
    /// Runs on the blocking thread pool to avoid parking Tokio workers.
    #[allow(clippy::too_many_arguments)]
    fn local_forward_loop(
        listener: TcpListener,
        session: Session,
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

        // Set session to non-blocking for the lifetime of this forward.
        // Each client thread gets a cloned Session handle sharing this state.
        session.set_blocking(false);

        loop {
            if should_stop.load(Ordering::Relaxed) {
                break;
            }

            // Non-blocking accept with sleep to check should_stop
            match listener.accept() {
                Ok((client_stream, _addr)) => {
                    let remote_host = remote_host.clone();
                    let session = session.clone();
                    let should_stop = should_stop.clone();
                    let forward_info = forward_info.clone();

                    log::debug!(
                        "[SSH-PF] Accepted connection on port {}, tunneling to {}:{}",
                        forward_info.local_port,
                        remote_host,
                        remote_port
                    );

                    std::thread::spawn(move || {
                        if let Err(error) = Self::handle_local_client(
                            session,
                            client_stream,
                            &remote_host,
                            remote_port,
                            should_stop,
                        ) {
                            log::warn!(
                                "[SSH-PF] Tunnel failed on local port {}: {}",
                                forward_info.local_port,
                                error
                            );
                        }
                    });
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(FORWARD_ACCEPT_POLL_MS));
                }
                Err(e) => {
                    log::error!("[SSH-PF] Accept error: {}", e);
                    let mut failed_info = forward_info.clone();
                    failed_info.status = "failed".to_string();
                    failed_info.error = Some(format!("Accept error: {}", e));

                    if let Err(emit_err) = app_handle.emit(
                        "ssh-port-forward-status-changed",
                        (&connection_id, &failed_info),
                    ) {
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

    fn handle_local_client(
        session: Session,
        client_stream: TcpStream,
        remote_host: &str,
        remote_port: u16,
        should_stop: Arc<AtomicBool>,
    ) -> Result<(), String> {
        client_stream
            .set_nonblocking(true)
            .map_err(|e| format!("Failed to set client stream non-blocking: {}", e))?;

        let channel = session
            .channel_direct_tcpip(remote_host, remote_port, None)
            .map_err(|e| format!("Failed to open direct-tcpip channel: {}", e))?;

        Self::pump_bidirectional(client_stream, channel, should_stop)
    }

    fn pump_bidirectional(
        mut client_stream: TcpStream,
        mut channel: ssh2::Channel,
        should_stop: Arc<AtomicBool>,
    ) -> Result<(), String> {
        let mut client_to_remote_closed = false;
        let mut remote_to_client_closed = false;
        let mut client_buffer = vec![0u8; TUNNEL_BUFFER_SIZE];
        let mut remote_buffer = vec![0u8; TUNNEL_BUFFER_SIZE];

        while !(should_stop.load(Ordering::Relaxed)
            || (client_to_remote_closed && remote_to_client_closed))
        {
            let mut progressed = false;

            if !client_to_remote_closed {
                match client_stream.read(&mut client_buffer) {
                    Ok(0) => {
                        client_to_remote_closed = true;
                        let _ = channel.send_eof();
                        progressed = true;
                    }
                    Ok(n) => {
                        write_all_nonblocking(&mut channel, &client_buffer[..n])?;
                        progressed = true;
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(e) => return Err(format!("Failed to read local client: {}", e)),
                }
            }

            if !remote_to_client_closed {
                match channel.read(&mut remote_buffer) {
                    Ok(0) if channel.eof() => {
                        remote_to_client_closed = true;
                        let _ = client_stream.shutdown(Shutdown::Write);
                        progressed = true;
                    }
                    Ok(0) => {}
                    Ok(n) => {
                        write_all_nonblocking(&mut client_stream, &remote_buffer[..n])?;
                        progressed = true;
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(e) => return Err(format!("Failed to read SSH channel: {}", e)),
                }
            }

            if !progressed {
                std::thread::sleep(std::time::Duration::from_millis(TUNNEL_IDLE_POLL_MS));
            }
        }

        let _ = channel.close();
        Ok(())
    }

    /// Stop a port forward
    pub fn stop_forward(&self, connection_id: &str, forward_id: &str) -> Result<(), String> {
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
    pub fn stop_all_for_connection(&self, connection_id: &str) {
        let mut forwards = self.forwards.write();

        if let Some(conn_forwards) = forwards.remove(connection_id) {
            for (_, handle) in conn_forwards {
                handle.should_stop.store(true, Ordering::Relaxed);
                handle.task.abort();

                let stopped_info = ActivePortForward {
                    status: "stopped".to_string(),
                    ..handle.info
                };
                self.emit_forward_status(connection_id, &stopped_info);
            }
        }
    }

    /// Stop all active port forwards across all connections.
    pub fn stop_all(&self) {
        let mut forwards = self.forwards.write();
        for (connection_id, conn_forwards) in forwards.drain() {
            for (_, handle) in conn_forwards {
                handle.should_stop.store(true, Ordering::Relaxed);
                handle.task.abort();

                let stopped_info = ActivePortForward {
                    status: "stopped".to_string(),
                    ..handle.info
                };
                self.emit_forward_status(&connection_id, &stopped_info);
            }
        }
    }

    /// List active forwards for a connection
    #[allow(dead_code)]
    pub fn list_forwards(&self, connection_id: &str) -> Vec<ActivePortForward> {
        let forwards = self.forwards.read();
        forwards
            .get(connection_id)
            .map(|conn_forwards| conn_forwards.values().map(|h| h.info.clone()).collect())
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

fn write_all_nonblocking<W: Write>(writer: &mut W, mut buffer: &[u8]) -> Result<(), String> {
    while !buffer.is_empty() {
        match writer.write(buffer) {
            Ok(0) => return Err("write returned zero bytes".to_string()),
            Ok(n) => buffer = &buffer[n..],
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(TUNNEL_IDLE_POLL_MS));
            }
            Err(e) => return Err(format!("write failed: {}", e)),
        }
    }
    writer.flush().map_err(|e| format!("flush failed: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_all_nonblocking_retries_after_would_block() {
        struct FlakyWriter {
            attempts: usize,
            output: Vec<u8>,
        }

        impl Write for FlakyWriter {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.attempts += 1;
                if self.attempts == 1 {
                    return Err(std::io::Error::from(std::io::ErrorKind::WouldBlock));
                }
                self.output.extend_from_slice(buf);
                Ok(buf.len())
            }

            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        let mut writer = FlakyWriter {
            attempts: 0,
            output: Vec::new(),
        };

        write_all_nonblocking(&mut writer, b"hello").expect("write should retry and succeed");

        assert_eq!(writer.output, b"hello");
    }

    #[tokio::test]
    async fn stop_all_in_map_signals_and_clears() {
        let should_stop = Arc::new(AtomicBool::new(false));
        let should_stop_assertion = should_stop.clone();
        let task = tokio::spawn(async {});
        let forward = ActivePortForward {
            id: "forward-1".to_string(),
            config_id: "forward-1".to_string(),
            local_port: 8080,
            remote_host: "127.0.0.1".to_string(),
            remote_port: 80,
            forward_type: "local".to_string(),
            status: "active".to_string(),
            error: None,
        };

        let mut forwards = HashMap::from([(
            "conn-1".to_string(),
            HashMap::from([(
                "forward-1".to_string(),
                ForwardHandle {
                    should_stop,
                    task,
                    info: forward,
                },
            )]),
        )]);

        // Drain and signal stop (same logic as stop_all without emit)
        for (_, conn_forwards) in forwards.drain() {
            for (_, handle) in conn_forwards {
                handle.should_stop.store(true, Ordering::Relaxed);
                handle.task.abort();
            }
        }

        assert!(forwards.is_empty());
        assert!(should_stop_assertion.load(Ordering::Relaxed));
    }
}
