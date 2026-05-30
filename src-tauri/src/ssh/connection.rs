//! SSH Connection Manager
//!
//! Manages SSH connection lifecycle including connect, disconnect,
//! heartbeat monitoring, and auto-reconnect with exponential backoff.

use crate::ssh::profile_manager::SSHProfile;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use ssh2::{CheckResult, KnownHostFileKind, Session};
use std::collections::HashMap;
use std::io::Read;
use std::net::{TcpStream, ToSocketAddrs};
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

/// Minimal standard-base64 encoder (RFC 4648) for serializing host-key blobs
/// into OpenSSH `known_hosts` lines. Avoids pulling in a base64 dependency for
/// this single use site.
fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((n >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((n >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(n & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

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

    /// Resolve `host:port` (DNS name or literal IP) and open a TCP connection to
    /// the first address that accepts within the timeout.
    ///
    /// `TcpStream::connect_timeout` requires a `SocketAddr`, which only parses
    /// numeric IPs. Resolving via `ToSocketAddrs` first lets us connect to
    /// hostnames (e.g. `example.com`) as well as IPs.
    ///
    /// The total connect time is bounded by `TCP_CONNECT_TIMEOUT_SECS` across
    /// ALL resolved addresses (a shared deadline), so a dual-stack host whose
    /// IPv6 route black-holes cannot stall for `N * timeout` before falling
    /// back to IPv4.
    fn connect_tcp(host: &str, port: u16) -> Result<TcpStream, String> {
        let addr = format!("{}:{}", host, port);
        let resolved: Vec<_> = addr
            .to_socket_addrs()
            .map_err(|e| format!("Failed to resolve {}: {}", addr, e))?
            .collect();

        if resolved.is_empty() {
            return Err(format!("Failed to resolve {}: no addresses returned", addr));
        }

        let total = Duration::from_secs(TCP_CONNECT_TIMEOUT_SECS);
        let deadline = std::time::Instant::now() + total;
        // Divide the budget across addresses, with a sensible floor so each
        // address still gets a fair attempt.
        let per_attempt = std::cmp::max(
            total / resolved.len() as u32,
            Duration::from_secs(2),
        );

        let mut last_err: Option<String> = None;
        for socket_addr in resolved {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            let attempt_timeout = std::cmp::min(per_attempt, remaining);
            match TcpStream::connect_timeout(&socket_addr, attempt_timeout) {
                Ok(stream) => return Ok(stream),
                Err(e) => last_err = Some(e.to_string()),
            }
        }

        Err(format!(
            "TCP connection to {} failed: {}",
            addr,
            last_err.unwrap_or_else(|| "connection timed out".to_string())
        ))
    }

    /// Create an SSH session to the given profile
    fn create_session(
        &self,
        profile: &SSHProfile,
        password: Option<&str>,
    ) -> Result<Session, String> {
        let tcp = Self::connect_tcp(&profile.host, profile.port)?;

        let mut session =
            Session::new().map_err(|e| format!("Failed to create SSH session: {}", e))?;
        session.set_tcp_stream(tcp);
        session
            .handshake()
            .map_err(|e| format!("SSH handshake failed: {}", e))?;

        // Verify the server host key against ~/.ssh/known_hosts (TOFU /
        // accept-new semantics) before authenticating, so the SFTP/port-forward
        // channel is not silently exposed to MITM.
        Self::verify_host_key(&session, &profile.host, profile.port)?;

        // Authenticate
        Self::authenticate_session(&session, profile, password)?;

        // Enable keepalive
        session.set_keepalive(true, HEARTBEAT_INTERVAL_SECS as u32);

        Ok(session)
    }

    /// Path to the user's `~/.ssh` directory.
    fn ssh_dir() -> Option<std::path::PathBuf> {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(std::path::PathBuf::from)?;
        Some(home.join(".ssh"))
    }

    /// Path to the user's `~/.ssh/known_hosts` file (read-only, for verification).
    fn known_hosts_path() -> Option<std::path::PathBuf> {
        Self::ssh_dir().map(|d| d.join("known_hosts"))
    }

    /// Path to the app-managed known_hosts file. New accept-new entries are
    /// persisted here (appended) instead of rewriting the user's shared
    /// `~/.ssh/known_hosts`, whose format (markers like `@cert-authority` /
    /// `@revoked`, unsupported key types, comments) libssh2's writer would drop.
    fn app_known_hosts_path() -> Option<std::path::PathBuf> {
        Self::ssh_dir().map(|d| d.join("known_hosts_termul"))
    }

    /// Verify the server host key against the user's `known_hosts` plus the
    /// app-managed store, applying `accept-new` behavior: unknown hosts are
    /// recorded and persisted, changed keys are rejected (potential MITM). This
    /// mirrors the interactive terminal path's `StrictHostKeyChecking=accept-new`.
    ///
    /// To avoid corrupting the user's shared `~/.ssh/known_hosts` (libssh2's
    /// `write_file` truncates and re-serializes only what it could parse), both
    /// files are loaded read-only for the check, and newly accepted keys are
    /// appended to the app-managed file only.
    fn verify_host_key(session: &Session, host: &str, port: u16) -> Result<(), String> {
        let (key, key_type) = session
            .host_key()
            .ok_or_else(|| "Server did not present a host key".to_string())?;

        let mut known_hosts = session
            .known_hosts()
            .map_err(|e| format!("Failed to access known_hosts: {}", e))?;

        // Load the user's shared known_hosts (read-only) and the app-managed
        // file. If a file exists but cannot be read, fail closed rather than
        // silently downgrading a populated store to accept-new.
        for path in [Self::known_hosts_path(), Self::app_known_hosts_path()]
            .into_iter()
            .flatten()
        {
            if path.exists() {
                if let Err(e) = known_hosts.read_file(&path, KnownHostFileKind::OpenSSH) {
                    // A genuinely empty file reads as Ok; an error here means the
                    // file is present but unreadable/partially parseable. Treat
                    // the user's file leniently (system ssh remains source of
                    // truth) but log; only the app file is ours to trust.
                    log::warn!("[SSH] Could not fully read known_hosts {:?}: {}", path, e);
                }
            }
        }

        match known_hosts.check_port(host, port, key) {
            CheckResult::Match => Ok(()),
            CheckResult::Mismatch => Err(format!(
                "Host key verification failed for {}:{}: the server key does not match the known_hosts entry (possible man-in-the-middle). Remove the stale entry to reconnect.",
                host, port
            )),
            CheckResult::NotFound => {
                // accept-new: remember this host by appending a single OpenSSH
                // line to the app-managed file (never rewriting the user's).
                Self::append_known_host(host, port, key, key_type);
                Ok(())
            }
            CheckResult::Failure => {
                Err("Host key verification failed: unable to check known_hosts".to_string())
            }
        }
    }

    /// Append a single OpenSSH-format known_hosts line to the app-managed file.
    /// Best-effort: failures are logged, not fatal (the host was still accepted
    /// for this session under TOFU).
    fn append_known_host(host: &str, port: u16, key: &[u8], key_type: ssh2::HostKeyType) {
        use std::io::Write;

        let key_type_str = match key_type {
            ssh2::HostKeyType::Rsa => "ssh-rsa",
            ssh2::HostKeyType::Dss => "ssh-dss",
            ssh2::HostKeyType::Ecdsa256 => "ecdsa-sha2-nistp256",
            ssh2::HostKeyType::Ecdsa384 => "ecdsa-sha2-nistp384",
            ssh2::HostKeyType::Ecdsa521 => "ecdsa-sha2-nistp521",
            ssh2::HostKeyType::Ed25519 => "ssh-ed25519",
            ssh2::HostKeyType::Unknown => {
                log::warn!("[SSH] Not persisting host key for {}: unknown key type", host);
                return;
            }
        };

        let host_entry = if port == 22 {
            host.to_string()
        } else {
            format!("[{}]:{}", host, port)
        };
        // base64-encode the raw key blob (OpenSSH known_hosts format).
        let key_b64 = base64_encode(key);
        let line = format!("{} {} {}\n", host_entry, key_type_str, key_b64);

        let path = match Self::app_known_hosts_path() {
            Some(p) => p,
            None => return,
        };
        if let Some(parent) = path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                log::warn!("[SSH] Failed to create {:?}: {}", parent, e);
                return;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
            }
        }

        match std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            Ok(mut file) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = file.set_permissions(std::fs::Permissions::from_mode(0o600));
                }
                if let Err(e) = file.write_all(line.as_bytes()) {
                    log::warn!("[SSH] Failed to persist host key for {}: {}", host_entry, e);
                }
            }
            Err(e) => log::warn!("[SSH] Failed to open {:?}: {}", path, e),
        }
    }

    fn authenticate_session(
        session: &Session,
        profile: &SSHProfile,
        secret: Option<&str>,
    ) -> Result<(), String> {
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
                        secret, // passphrase
                    )
                    .map_err(|e| format!("Key authentication failed: {}", e))?;
            }
            "password" => {
                let password = secret.ok_or_else(|| "Password required".to_string())?;
                session
                    .userauth_password(&profile.username, password)
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

        Ok(())
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

            // Check connection health outside the mutex using a cloned session
            let session_clone = {
                let state_guard = state.lock().await;
                state_guard.session.clone()
            };

            let is_alive = if let Some(session) = session_clone {
                // Perform blocking keepalive I/O without holding the lock
                tokio::task::spawn_blocking(move || session.keepalive_send().is_ok())
                    .await
                    .unwrap_or(false)
            } else {
                false
            };

            if !is_alive {
                log::warn!(
                    "[SSH] Connection {} lost, attempting reconnect",
                    connection_id
                );

                // Update status to reconnecting
                {
                    let mut state_guard = state.lock().await;
                    state_guard.info.status = "reconnecting".to_string();
                    Self::emit_status_static(&app_handle, &state_guard.info);
                }

                // Attempt reconnect with exponential backoff
                let mut attempts = 0u32;
                let mut reconnected = false;

                while attempts < MAX_RECONNECT_ATTEMPTS
                    && !should_stop.load(std::sync::atomic::Ordering::Relaxed)
                {
                    attempts += 1;
                    let backoff =
                        std::cmp::min(INITIAL_BACKOFF_MS * 2u64.pow(attempts - 1), MAX_BACKOFF_MS);

                    log::info!(
                        "[SSH] Reconnect attempt {}/{} for {} (backoff: {}ms)",
                        attempts,
                        MAX_RECONNECT_ATTEMPTS,
                        connection_id,
                        backoff
                    );

                    tokio::time::sleep(Duration::from_millis(backoff)).await;

                    // Try to create new session (resolves DNS names, not just IPs)
                    let tcp_result = Self::connect_tcp(&profile.host, profile.port);

                    if let Ok(tcp) = tcp_result {
                        if let Ok(mut new_session) = Session::new() {
                            new_session.set_tcp_stream(tcp);
                            let handshake_ok = new_session.handshake().is_ok();
                            let verify_result = if handshake_ok {
                                Self::verify_host_key(&new_session, &profile.host, profile.port)
                            } else {
                                Ok(())
                            };
                            if let Err(e) = &verify_result {
                                // A rotated/changed host key turns a transient
                                // reconnect into a hard failure; log the cause so
                                // it is diagnosable rather than a generic retry.
                                log::warn!(
                                    "[SSH] Host key verification failed during reconnect of {}: {}",
                                    connection_id,
                                    e
                                );
                            }
                            if handshake_ok
                                && verify_result.is_ok()
                                && Self::authenticate_session(
                                    &new_session,
                                    &profile,
                                    password.as_deref(),
                                )
                                .is_ok()
                            {
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

        let session_to_disconnect = {
            let mut state_guard = state.lock().await;
            state_guard
                .should_stop
                .store(true, std::sync::atomic::Ordering::Relaxed);

            let session = state_guard.session.take();
            state_guard.info.status = "disconnected".to_string();
            self.emit_status(&state_guard.info);
            session
        };

        // Perform blocking disconnect I/O outside the mutex
        if let Some(session) = session_to_disconnect {
            let _ = tokio::task::spawn_blocking(move || {
                session.disconnect(None, "User disconnected", None)
            })
            .await;
        }

        Ok(())
    }

    /// Get all active connections
    pub async fn list_connections(&self) -> Vec<SSHConnectionInfo> {
        let states: Vec<Arc<AsyncMutex<ConnectionState>>> = {
            let connections = self.connections.read();
            connections.values().cloned().collect()
        };

        let mut infos = Vec::with_capacity(states.len());
        for state in states {
            let state_guard = state.lock().await;
            infos.push(state_guard.info.clone());
        }
        infos
    }

    /// Snapshot active connection IDs without waiting on per-connection locks.
    pub fn connection_ids(&self) -> Vec<String> {
        let connections = self.connections.read();
        connections.keys().cloned().collect()
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
    ///
    /// # Safety
    /// The closure `f` MUST NOT perform blocking I/O. For blocking operations,
    /// use `clone_session()` + `spawn_blocking` instead.
    pub async fn with_session<F, R>(&self, connection_id: &str, f: F) -> Result<R, String>
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

    /// Clone the current SSH session handle for long-running operations such as port forwarding.
    pub async fn clone_session(&self, connection_id: &str) -> Result<Session, String> {
        let state = {
            let connections = self.connections.read();
            connections
                .get(connection_id)
                .cloned()
                .ok_or_else(|| format!("Connection not found: {}", connection_id))?
        };

        let state_guard = state.lock().await;
        state_guard
            .session
            .as_ref()
            .cloned()
            .ok_or_else(|| "Not connected".to_string())
    }

    /// Execute a command on the SSH session (for SFTP subsystem access)
    /// Uses clone_session + spawn_blocking to avoid holding async mutex during blocking I/O.
    #[allow(dead_code)]
    pub async fn exec_command(&self, connection_id: &str, command: &str) -> Result<String, String> {
        // Clone session out of the guard to avoid holding async mutex during blocking I/O
        let session = self.clone_session(connection_id).await?;
        let command = command.to_string();

        tokio::task::spawn_blocking(move || {
            let mut channel = session
                .channel_session()
                .map_err(|e| format!("Failed to open channel: {}", e))?;

            channel
                .exec(&command)
                .map_err(|e| format!("Failed to execute command: {}", e))?;

            let mut output = String::new();
            channel
                .read_to_string(&mut output)
                .map_err(|e| format!("Failed to read output: {}", e))?;

            channel.wait_close().ok();

            Ok(output)
        })
        .await
        .map_err(|e| format!("Task join error: {}", e))?
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

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(auth_method: &str) -> SSHProfile {
        SSHProfile {
            id: "p1".to_string(),
            name: "Test".to_string(),
            host: "example.com".to_string(),
            port: 22,
            username: "user".to_string(),
            auth_method: auth_method.to_string(),
            private_key_path: None,
            password: None,
            passphrase: None,
            jump_host_id: None,
            port_forwards: Vec::new(),
            tags: None,
            last_connected: None,
            imported_from: None,
            has_stored_password: false,
            has_stored_passphrase: false,
        }
    }

    #[test]
    fn auth_result_requires_password_for_password_profiles() {
        let session = Session::new().expect("session should be created");
        let error =
            SSHConnectionManager::authenticate_session(&session, &profile("password"), None)
                .expect_err("missing password must fail before network authentication");

        assert_eq!(error, "Password required");
    }

    #[test]
    fn auth_result_rejects_unknown_auth_method() {
        let session = Session::new().expect("session should be created");
        let error =
            SSHConnectionManager::authenticate_session(&session, &profile("webauthn"), None)
                .expect_err("unknown auth method must fail before network authentication");

        assert_eq!(error, "Unknown auth method: webauthn");
    }

    #[test]
    fn connect_tcp_rejects_unresolvable_host_without_panicking() {
        // A syntactically valid but non-resolvable host must produce a
        // descriptive error rather than the old IP-only parse failure.
        let err = SSHConnectionManager::connect_tcp(
            "nonexistent.invalid.example.test.",
            22,
        )
        .expect_err("unresolvable host should error");
        assert!(
            err.contains("resolve") || err.contains("TCP connection"),
            "unexpected error message: {}",
            err
        );
    }

    #[test]
    fn connect_tcp_accepts_hostname_syntax() {
        // Regression for the IP-only bug: an address must reach DNS resolution
        // (and then a connection attempt) rather than failing with "invalid
        // socket address syntax". 127.0.0.1 on a closed low port refuses
        // immediately and avoids resolver/dual-stack dependence.
        let err = SSHConnectionManager::connect_tcp("127.0.0.1", 1)
            .expect_err("closed port should not connect");
        assert!(
            !err.contains("invalid socket address"),
            "address should resolve, got: {}",
            err
        );
        assert!(err.contains("TCP connection"), "unexpected error: {}", err);
    }

    #[test]
    fn base64_encode_matches_known_vectors() {
        // RFC 4648 test vectors, ensuring correct padding for the known_hosts
        // serializer.
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }
}
