//! Daemon-backed terminal bridge.
//!
//! When enabled (env `TERMUL_DAEMON_TERMINALS=1`), GUI terminal spawn/write/
//! resize/kill route through the supervisor daemon instead of the in-process
//! `PtyManager`, so the underlying CLI survives a force-closed/crashed Termul.
//!
//! Each bridged terminal owns one socket connection to the daemon: a streaming
//! thread reads scrollback + live `Output` frames and pushes them into the
//! per-terminal Tauri `Channel`; the same connection is used for write/resize.

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use tauri::ipc::{Channel, Response};

use crate::session_recovery::client::SupervisorClient;
use crate::session_recovery::ipc::{SpawnSpec, SupervisorRequest, SupervisorResponse};

/// True when GUI terminals should be daemon-backed.
pub fn daemon_terminals_enabled() -> bool {
    std::env::var("TERMUL_DAEMON_TERMINALS").as_deref() == Ok("1")
}

/// A bridged terminal: the write half of its daemon connection plus the daemon
/// session id.
struct BridgedTerminal {
    session_id: String,
    pid: u32,
    client: Mutex<SupervisorClient>,
}

#[derive(Default)]
pub struct DaemonTerminalBridge {
    terminals: Mutex<HashMap<String, Arc<BridgedTerminal>>>,
}

impl DaemonTerminalBridge {
    pub fn new() -> Self {
        Self::default()
    }

    fn connect() -> Result<SupervisorClient, String> {
        let socket = crate::session_recovery::server::default_socket_path();
        let token = crate::session_recovery::supervisor::read_token().unwrap_or_default();
        SupervisorClient::connect(&socket, &token)
    }

    /// Spawn a daemon session for `terminal_id`, attach, and stream output into
    /// `on_data`. Returns the daemon pid.
    pub fn spawn(
        &self,
        terminal_id: String,
        spec: SpawnSpec,
        on_data: Channel<Response>,
    ) -> Result<u32, String> {
        // Control connection: spawn + write/resize.
        let mut control = Self::connect()?;
        let (session_id, pid) = control.spawn(spec)?;

        // Separate streaming connection: attach + pump output frames.
        let mut stream = Self::connect()?;
        stream.send_request(&SupervisorRequest::Attach {
            session_id: session_id.clone(),
        })?;
        stream.set_blocking();

        let stream_session = session_id.clone();
        std::thread::spawn(move || loop {
            match stream.recv_response() {
                Ok(SupervisorResponse::Scrollback { session_id, data })
                | Ok(SupervisorResponse::Output { session_id, data })
                    if session_id == stream_session =>
                {
                    if !data.is_empty() {
                        let _ = on_data.send(Response::new(data));
                    }
                }
                Ok(SupervisorResponse::Exited { session_id, .. })
                    if session_id == stream_session =>
                {
                    break;
                }
                Ok(_) => {}
                Err(_) => break,
            }
        });

        self.terminals.lock().insert(
            terminal_id,
            Arc::new(BridgedTerminal {
                session_id,
                pid,
                client: Mutex::new(control),
            }),
        );
        Ok(pid)
    }

    pub fn write(&self, terminal_id: &str, data: &[u8]) -> Result<(), String> {
        let term = self
            .terminals
            .lock()
            .get(terminal_id)
            .cloned()
            .ok_or_else(|| format!("no bridged terminal {terminal_id}"))?;
        let mut client = term.client.lock();
        client.send_request(&SupervisorRequest::Write {
            session_id: term.session_id.clone(),
            data: data.to_vec(),
        })?;
        // Drain the Ok/Error ack so it does not desync the next request.
        let _ = client.recv_response();
        Ok(())
    }

    pub fn resize(&self, terminal_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let term = self
            .terminals
            .lock()
            .get(terminal_id)
            .cloned()
            .ok_or_else(|| format!("no bridged terminal {terminal_id}"))?;
        let mut client = term.client.lock();
        client.send_request(&SupervisorRequest::Resize {
            session_id: term.session_id.clone(),
            cols,
            rows,
        })?;
        let _ = client.recv_response();
        Ok(())
    }

    pub fn kill(&self, terminal_id: &str) -> Result<(), String> {
        let term = self.terminals.lock().remove(terminal_id);
        if let Some(term) = term {
            let mut client = term.client.lock();
            client.send_request(&SupervisorRequest::Kill {
                session_id: term.session_id.clone(),
            })?;
            let _ = client.recv_response();
        }
        Ok(())
    }

    /// True when `terminal_id` is bridged through the daemon.
    pub fn has(&self, terminal_id: &str) -> bool {
        self.terminals.lock().contains_key(terminal_id)
    }

    pub fn pid(&self, terminal_id: &str) -> Option<u32> {
        self.terminals.lock().get(terminal_id).map(|t| t.pid)
    }
}
