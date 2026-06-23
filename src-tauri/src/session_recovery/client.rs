//! Minimal blocking client for talking to the supervisor daemon over its Unix
//! socket. Used by Tauri commands (e.g. list recovered sessions, attach) to
//! query the live daemon rather than an in-memory mirror.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::time::Duration;

use crate::session_recovery::ipc::{SupervisorRequest, SupervisorResponse};
use crate::session_recovery::registry::RecoveredSession;

/// A short-lived authenticated connection to the daemon.
pub struct SupervisorClient {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl SupervisorClient {
    /// Connect to the daemon socket and complete the `Hello` handshake with the
    /// given token. Returns an error if the socket is absent or auth fails.
    pub fn connect(socket_path: &std::path::Path, token: &str) -> Result<Self, String> {
        let stream = UnixStream::connect(socket_path)
            .map_err(|e| format!("connect {}: {e}", socket_path.display()))?;
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .map_err(|e| format!("set timeout: {e}"))?;
        let writer = stream
            .try_clone()
            .map_err(|e| format!("clone stream: {e}"))?;
        let mut client = Self {
            reader: BufReader::new(stream),
            writer,
        };

        client.send(&SupervisorRequest::Hello {
            protocol_version: crate::session_recovery::ipc::SUPERVISOR_PROTOCOL_VERSION,
            app_instance_id: "termul-ui".to_string(),
            auth_token: token.to_string(),
        })?;
        match client.recv()? {
            SupervisorResponse::HelloAck { .. } => Ok(client),
            SupervisorResponse::Error { code, message } => {
                Err(format!("handshake rejected ({code}): {message}"))
            }
            other => Err(format!("unexpected handshake response: {other:?}")),
        }
    }

    fn send(&mut self, req: &SupervisorRequest) -> Result<(), String> {
        let mut line = serde_json::to_string(req).map_err(|e| format!("encode: {e}"))?;
        line.push('\n');
        self.writer
            .write_all(line.as_bytes())
            .map_err(|e| format!("write: {e}"))?;
        self.writer.flush().map_err(|e| format!("flush: {e}"))
    }

    fn recv(&mut self) -> Result<SupervisorResponse, String> {
        let mut line = String::new();
        let n = self
            .reader
            .read_line(&mut line)
            .map_err(|e| format!("read: {e}"))?;
        if n == 0 {
            return Err("daemon closed connection".to_string());
        }
        serde_json::from_str(line.trim()).map_err(|e| format!("decode: {e}"))
    }

    /// List the daemon's live sessions.
    pub fn list_sessions(&mut self) -> Result<Vec<RecoveredSession>, String> {
        self.send(&SupervisorRequest::ListSessions)?;
        match self.recv()? {
            SupervisorResponse::Sessions { sessions } => Ok(sessions),
            SupervisorResponse::Error { code, message } => {
                Err(format!("list_sessions error ({code}): {message}"))
            }
            other => Err(format!("unexpected list response: {other:?}")),
        }
    }

    /// Send a request frame without consuming a response (caller drives reads).
    pub fn send_request(&mut self, req: &SupervisorRequest) -> Result<(), String> {
        self.send(req)
    }

    /// Read one response frame (blocking, subject to the read timeout).
    pub fn recv_response(&mut self) -> Result<SupervisorResponse, String> {
        self.recv()
    }

    /// Clear the read timeout so a streaming consumer can block on live frames.
    pub fn set_blocking(&mut self) {
        let _ = self.reader.get_ref().set_read_timeout(None);
    }

    /// Spawn a session and return (session_id, pid).
    pub fn spawn(
        &mut self,
        spec: crate::session_recovery::ipc::SpawnSpec,
    ) -> Result<(String, u32), String> {
        self.send(&SupervisorRequest::Spawn { spec })?;
        match self.recv()? {
            SupervisorResponse::Spawned { session_id, pid } => Ok((session_id, pid)),
            SupervisorResponse::Error { code, message } => {
                Err(format!("spawn error ({code}): {message}"))
            }
            other => Err(format!("unexpected spawn response: {other:?}")),
        }
    }
}

/// Convenience: connect with the persisted token and list sessions. Returns an
/// empty vec (not an error) when no daemon is reachable, so the UI degrades
/// gracefully.
pub fn list_recovered_sessions() -> Vec<RecoveredSession> {
    let socket = crate::session_recovery::server::default_socket_path();
    let Some(token) = super::supervisor::read_token() else {
        return Vec::new();
    };
    match SupervisorClient::connect(&socket, &token) {
        Ok(mut client) => client.list_sessions().unwrap_or_default(),
        Err(e) => {
            log::debug!("[supervisor] list_recovered_sessions: {e}");
            Vec::new()
        }
    }
}
