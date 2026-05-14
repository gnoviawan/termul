//! SSH Connection Manager
//!
//! Manages SSH connection lifecycle including connect, disconnect,
//! heartbeat monitoring, and auto-reconnect with exponential backoff.

use crate::ssh::profile_manager::SSHProfile;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use ssh2::Session;
use std::collections::HashMap;
use std::io::Read;
use std::net::TcpStream;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex as AsyncMutex;

const HEARTBEAT_INTERVAL_SECS: u64 = 15;
const MAX_RECONNECT_ATTEMPTS: u32 = 5;
const INITIAL_BACKOFF_MS: u64 = 1000;
const MAX_BACKOFF_MS: u64 = 30000;
const TCP_CONNECT_TIMEOUT_SECS: u64 = 10;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SSHConnectionInfo {
    pub id: String,
    pub profile_id: String,
    pub status: String, // "disconnected" | "connecting" | "connected" | "reconnecting" | "failed"
    pub terminal_id: Option<String>,
    pub error: Option<String>,
    pub reconnect_attempts: u32,
    pub connected_at: Option<String>,
}

/// Internal connection state
struct ConnectionState {
    info: SSHConnectionInfo,
    session: Option<Session>,
    /// Flag to signal the heartbeat loop to stop
    should_stop: Arc<std::sync::atomic::AtomicBool>,
}

pub struct SSHConnectionManager {
    app_handle: AppHandle,
    connections: RwLock<HashMap<String, Arc<AsyncMutex<ConnectionState>>>>,
}

impl SSHConnectionManager {
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            app_handle,
            connections: RwLock::new(HashMap::new()),
        }
    }

    /// Establish an SSH connection to the given profile
    pub async fn connect(
        &self,
        profile: &SSHProfile,
        password: Option<&str>,
    ) -> Result<SSHConnectionInfo, String> {
        let connection_id = uuid::Uuid::new_v4().to_string();

        let info = SSHConnectionInfo {
            id: connection_id.clone(),
            profile_id: profile.id.clone(),
            status: "connecting".to_string(),
            terminal_id: None,
            error: None,
            reconnect_attempts: 0,
            connected_at: None,
        };

        // Emit connecting status
        self.emit_status(&info);

        // Attempt connection
        let session = self
            .create_session(profile, password)
            .map_err(|e| format!("SSH connection failed: {}", e))?;

        let connected_info = SSHConnectionInfo {
            status: "connected".to_string(),
            connected_at: Some(chrono::Utc::now().to_rfc3339()),
            ..info
        };

        let should_stop = Arc::new(std::sync::atomic::AtomicBool::new(false));

        let state = Arc::new(AsyncMutex::new(ConnectionState {
            info: connected_info.clone(),
            session: Some(session),
            should_stop: should_stop.clone(),
        }));

        // Store connection
        {
            let mut connections = self.connections.write();
            connections.insert(connection_id.clone(), state.clone());
        }

        // Emit connected status
        self.emit_status(&connected_info);

        // Start heartbeat loop
        let app_handle = self.app_handle.clone();
        let profile_clone = profile.clone();
        let password_owned = password.map(|p| p.to_string());
        let conn_id = connection_id.clone();

        tokio::spawn(async move {
            Self::heartbeat_loop(
                app_handle,
                state,
                profile_clone,
                password_owned,
                conn_id,
                should_stop,
            )
            .await;
        });

        Ok(connected_info)
    }

    /// Create an SSH session to the given profile
    fn create_session(
        &self,
        profile: &SSHProfile,
        password: Option<&str>,
    ) -> Result<Session, String> {
        let addr = format!("{}:{}", profile.host, profile.port);

        let tcp = TcpStream::connect_timeout(
            &addr
                .parse()
                .map_err(|e| format!("Invalid address {}: {}", addr, e))?,
            Duration::from_secs(TCP_CONNECT_TIMEOUT_SECS),
        )
        .map_err(|e| format!("TCP connection to {} failed: {}", addr, e))?;

        let mut session = Session::new().map_err(|e| format!("Failed to create SSH session: {}", e))?;
        session.set_tcp_stream(tcp);
        session
            .handshake()
            .map_err(|e| format!("SSH handshake failed: {}", e))?;

        // Authenticate
        match profile.auth_method.as_str() {
            "key" => {
                let key_path = profile
                    .private_key_path
                    .as_ref()
                    .ok_or_else(|| "Private key path not set".to_string())?;

                let key_path = Path::new(key_path);
                if !key_path.exists() {
                    return Err(format!("Private key not found: {:?}", key_path));
                }

                session
                    .userauth_pubkey_file(
                        &profile.username,
                        None, // public key (auto-derived)
                        key_path,
                        password, // passphrase
                    )
                    .map_err(|e| format!("Key authentication failed: {}", e))?;
            }
            "password" => {
                let pass = password.ok_or_else(|| "Password required".to_string())?;
                session
                    .userauth_password(&profile.username, pass)
                    .map_err(|e| format!("Password authentication failed: {}", e))?;
            }
            "agent" => {
                session
                    .userauth_agent(&profile.username)
                    .map_err(|e| format!("SSH agent authentication failed: {}", e))?;
            }
            other => {
                return Err(format!("Unknown auth method: {}", other));
            }
        }

        if !session.authenticated() {
            return Err("Authentication failed".to_string());
        }

        // Enable keepalive
        session.set_keepalive(true, HEARTBEAT_INTERVAL_SECS as u32);

        Ok(session)
    }

    /// Heartbeat loop that monitors connection health and auto-reconnects
    async fn heartbeat_loop(
        app_handle: AppHandle,
        state: Arc<AsyncMutex<ConnectionState>>,
        profile: SSHProfile,
        password: Option<String>,
        connection_id: String,
        should_stop: Arc<std::sync::atomic::AtomicBool>,
    ) {
        loop {
            if should_stop.load(std::sync::atomic::Ordering::Relaxed) {
                log::debug!("[SSH] Heartbeat loop stopped for {}", connection_id);
                break;
            }

            tokio::time::sleep(Duration::from_secs(HEARTBEAT_INTERVAL_SECS)).await;

            if should_stop.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }

            // Check connection health
            let is_alive = {
                let state_guard = state.lock().await;
                if let Some(ref session) = state_guard.session {
                    // Try to send keepalive
                    session.keepalive_send().is_ok()
                } else {
                    false
                }
            };

            if !is_alive {
                log::warn!("[SSH] Connection {} lost, attempting reconnect", connection_id);

                // Update status to reconnecting
                {
                    let mut state_guard = state.lock().await;
                    state_guard.info.status = "reconnecting".to_string();
                    Self::emit_status_static(&app_handle, &state_guard.info);
                }

                // Attempt reconnect with exponential backoff
                let mut attempts = 0u32;
                let mut reconnected = false;

                while attempts < MAX_RECONNECT_ATTEMPTS && !should_stop.load(std::sync::atomic::Ordering::Relaxed) {
                    attempts += 1;
                    let backoff = std::cmp::min(
                        INITIAL_BACKOFF_MS * 2u64.pow(attempts - 1),
                        MAX_BACKOFF_MS,
                    );

                    log::info!(
                        "[SSH] Reconnect attempt {}/{} for {} (backoff: {}ms)",
                        attempts,
                        MAX_RECONNECT_ATTEMPTS,
                        connection_id,
                        backoff
                    );

                    tokio::time::sleep(Duration::from_millis(backoff)).await;

                    // Try to create new session
                    let addr = format!("{}:{}", profile.host, profile.port);
                    let tcp_result = TcpStream::connect_timeout(
                        &match addr.parse() {
                            Ok(a) => a,
                            Err(_) => continue,
                        },
                        Duration::from_secs(TCP_CONNECT_TIMEOUT_SECS),
                    );

                    if let Ok(tcp) = tcp_result {
                        if let Ok(mut new_session) = Session::new() {
                            new_session.set_tcp_stream(tcp);
                            if new_session.handshake().is_ok() {
                                let auth_ok = match profile.auth_method.as_str() {
                                    "key" => {
                                        if let Some(ref key_path) = profile.private_key_path {
                                            new_session
                                                .userauth_pubkey_file(
                                                    &profile.username,
                                                    None,
                                                    Path::new(key_path),
                                                    password.as_deref(),
                                                )
                                                .is_ok()
                                        } else {
                                            false
                                        }
                                    }
                                    "password" => {
                                        if let Some(ref pass) = password {
                                            new_session
                                                .userauth_password(&profile.username, pass)
                                                .is_ok()
                                        } else {
                                            false
                                        }
                                    }
                                    "agent" => {
                                        new_session.userauth_agent(&profile.username).is_ok()
                                    }
                                    _ => false,
                                };

                                if auth_ok && new_session.authenticated() {
                                    new_session.set_keepalive(true, HEARTBEAT_INTERVAL_SECS as u32);

                                    let mut state_guard = state.lock().await;
                                    state_guard.session = Some(new_session);
                                    state_guard.info.status = "connected".to_string();
                                    state_guard.info.reconnect_attempts = attempts;
                                    state_guard.info.error = None;
                                    Self::emit_status_static(&app_handle, &state_guard.info);

                                    log::info!(
                                        "[SSH] Reconnected {} after {} attempts",
                                        connection_id,
                                        attempts
                                    );
                                    reconnected = true;
                                    break;
                                }
                            }
                        }
                    }

                    // Update reconnect attempts
                    {
                        let mut state_guard = state.lock().await;
                        state_guard.info.reconnect_attempts = attempts;
                        Self::emit_status_static(&app_handle, &state_guard.info);
                    }
                }

                if !reconnected {
                    let mut state_guard = state.lock().await;
                    state_guard.info.status = "failed".to_string();
                    state_guard.info.error =
                        Some(format!("Reconnect failed after {} attempts", attempts));
                    state_guard.session = None;
                    Self::emit_status_static(&app_handle, &state_guard.info);

                    log::error!(
                        "[SSH] Connection {} failed after {} reconnect attempts",
                        connection_id,
                        attempts
                    );
                    break;
                }
            }
        }
    }

    /// Disconnect a connection
    pub async fn disconnect(&self, connection_id: &str) -> Result<(), String> {
        let state = {
            let mut connections = self.connections.write();
            connections
                .remove(connection_id)
                .ok_or_else(|| format!("Connection not found: {}", connection_id))?
        };

        let mut state_guard = state.lock().await;
        state_guard
            .should_stop
            .store(true, std::sync::atomic::Ordering::Relaxed);

        if let Some(ref session) = state_guard.session {
            let _ = session.disconnect(None, "User disconnected", None);
        }
        state_guard.session = None;
        state_guard.info.status = "disconnected".to_string();

        self.emit_status(&state_guard.info);

        Ok(())
    }

    /// Get all active connections
    #[allow(dead_code)]
    pub fn list_connections(&self) -> Vec<SSHConnectionInfo> {
        let connections = self.connections.read();
        // We can't await inside a sync context, so return cached info
        // The heartbeat loop keeps info up-to-date
        connections
            .keys()
            .map(|id| SSHConnectionInfo {
                id: id.clone(),
                profile_id: String::new(),
                status: "unknown".to_string(),
                terminal_id: None,
                error: None,
                reconnect_attempts: 0,
                connected_at: None,
            })
            .collect()
    }

    /// Get connection info by ID
    pub async fn get_connection(&self, connection_id: &str) -> Option<SSHConnectionInfo> {
        let state = {
            let connections = self.connections.read();
            connections.get(connection_id).cloned()
        };
        if let Some(state) = state {
            let state_guard = state.lock().await;
            Some(state_guard.info.clone())
        } else {
            None
        }
    }

    /// Get the SSH session for SFTP/port-forward operations.
    /// Runs the provided closure with access to the SSH session.
    pub async fn with_session<F, R>(
        &self,
        connection_id: &str,
        f: F,
    ) -> Result<R, String>
    where
        F: FnOnce(&Session) -> Result<R, String>,
    {
        let state = {
            let connections = self.connections.read();
            connections
                .get(connection_id)
                .cloned()
                .ok_or_else(|| format!("Connection not found: {}", connection_id))?
        };

        let state_guard = state.lock().await;
        let session = state_guard
            .session
            .as_ref()
            .ok_or_else(|| "Not connected".to_string())?;

        f(session)
    }

    /// Execute a command on the SSH session (for SFTP subsystem access)
    #[allow(dead_code)]
    pub async fn exec_command(
        &self,
        connection_id: &str,
        command: &str,
    ) -> Result<String, String> {
        let state = {
            let connections = self.connections.read();
            connections
                .get(connection_id)
                .cloned()
                .ok_or_else(|| format!("Connection not found: {}", connection_id))?
        };

        let state_guard = state.lock().await;
        let session = state_guard
            .session
            .as_ref()
            .ok_or_else(|| "Not connected".to_string())?;

        let mut channel = session
            .channel_session()
            .map_err(|e| format!("Failed to open channel: {}", e))?;

        channel
            .exec(command)
            .map_err(|e| format!("Failed to execute command: {}", e))?;

        let mut output = String::new();
        channel
            .read_to_string(&mut output)
            .map_err(|e| format!("Failed to read output: {}", e))?;

        channel.wait_close().ok();

        Ok(output)
    }

    fn emit_status(&self, info: &SSHConnectionInfo) {
        Self::emit_status_static(&self.app_handle, info);
    }

    fn emit_status_static(app_handle: &AppHandle, info: &SSHConnectionInfo) {
        if let Err(e) = app_handle.emit("ssh-connection-status-changed", info) {
            log::error!("[SSH] Failed to emit connection status: {}", e);
        }
    }
}
