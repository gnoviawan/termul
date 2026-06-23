//! Unix-socket server for the supervisor daemon.
//!
//! Newline-delimited JSON frames. The server owns a `SessionTable` (PTYs +
//! children) that lives independently of any connected client, so a client
//! disconnect (Termul crash / force-close) does NOT tear down the sessions.
//!
//! Each client connection is handled on its own thread. Per-session attach
//! spawns a forwarder thread that pumps broadcast output frames to that client.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::session_recovery::daemon::SessionTable;
use crate::session_recovery::ipc::{
    SupervisorRequest, SupervisorResponse, SUPERVISOR_PROTOCOL_VERSION,
};

/// Default socket path under the user runtime/temp dir.
pub fn default_socket_path() -> std::path::PathBuf {
    let base = std::env::var_os("XDG_RUNTIME_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("termul-supervisor.sock")
}

/// Run the socket server until `shutdown` is set. Binds (removing any stale
/// socket file), then accepts client connections, each handled on its own
/// thread. Returns when the listener is closed.
pub fn serve(
    socket_path: &std::path::Path,
    table: Arc<SessionTable>,
    shutdown: Arc<AtomicBool>,
) -> std::io::Result<()> {
    // Remove a stale socket file from a previous run before binding.
    if socket_path.exists() {
        let _ = std::fs::remove_file(socket_path);
    }
    let listener = UnixListener::bind(socket_path)?;
    listener.set_nonblocking(true)?;

    while !shutdown.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((stream, _addr)) => {
                let table = table.clone();
                let shutdown = shutdown.clone();
                std::thread::spawn(move || {
                    if let Err(e) = handle_client(stream, table, shutdown) {
                        log::debug!("[supervisor] client handler ended: {e}");
                    }
                });
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(e) => return Err(e),
        }
    }

    let _ = std::fs::remove_file(socket_path);
    Ok(())
}

fn write_frame(stream: &Arc<std::sync::Mutex<UnixStream>>, resp: &SupervisorResponse) -> bool {
    let Ok(mut line) = serde_json::to_string(resp) else {
        return false;
    };
    line.push('\n');
    let mut guard = match stream.lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    guard.write_all(line.as_bytes()).is_ok() && guard.flush().is_ok()
}

fn handle_client(
    stream: UnixStream,
    table: Arc<SessionTable>,
    shutdown: Arc<AtomicBool>,
) -> std::io::Result<()> {
    let reader_stream = stream.try_clone()?;
    let write_stream = Arc::new(std::sync::Mutex::new(stream));
    let mut reader = BufReader::new(reader_stream);
    // Forwarder threads stop when this client disconnects.
    let client_alive = Arc::new(AtomicBool::new(true));

    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            break; // client disconnected; sessions stay alive in the table.
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let request: SupervisorRequest = match serde_json::from_str(trimmed) {
            Ok(req) => req,
            Err(e) => {
                write_frame(
                    &write_stream,
                    &SupervisorResponse::Error {
                        code: "bad_request".to_string(),
                        message: e.to_string(),
                    },
                );
                continue;
            }
        };

        let response = dispatch(&request, &table, &write_stream, &client_alive, &shutdown);
        if let Some(resp) = response {
            if !write_frame(&write_stream, &resp) {
                break;
            }
        }

        if matches!(request, SupervisorRequest::Shutdown { .. }) {
            break;
        }
    }

    client_alive.store(false, Ordering::Relaxed);
    Ok(())
}

fn dispatch(
    request: &SupervisorRequest,
    table: &Arc<SessionTable>,
    write_stream: &Arc<std::sync::Mutex<UnixStream>>,
    client_alive: &Arc<AtomicBool>,
    shutdown: &Arc<AtomicBool>,
) -> Option<SupervisorResponse> {
    match request {
        SupervisorRequest::Hello { .. } => Some(SupervisorResponse::HelloAck {
            supervisor_pid: std::process::id(),
            protocol_version: SUPERVISOR_PROTOCOL_VERSION,
        }),
        SupervisorRequest::Spawn { spec } => match table.spawn(spec.clone()) {
            Ok(session) => Some(SupervisorResponse::Spawned {
                session_id: session.id.clone(),
                pid: session.pid,
            }),
            Err(message) => Some(SupervisorResponse::Error {
                code: "spawn_failed".to_string(),
                message,
            }),
        },
        SupervisorRequest::Write { session_id, data } => match table.get(session_id) {
            Some(session) => match session.write_input(data) {
                Ok(()) => Some(SupervisorResponse::Ok),
                Err(e) => Some(SupervisorResponse::Error {
                    code: "write_failed".to_string(),
                    message: e.to_string(),
                }),
            },
            None => Some(session_not_found(session_id)),
        },
        SupervisorRequest::Resize {
            session_id,
            cols,
            rows,
        } => match table.get(session_id) {
            Some(session) => match session.resize(*cols, *rows) {
                Ok(()) => Some(SupervisorResponse::Ok),
                Err(message) => Some(SupervisorResponse::Error {
                    code: "resize_failed".to_string(),
                    message,
                }),
            },
            None => Some(session_not_found(session_id)),
        },
        SupervisorRequest::Kill { session_id } => match table.get(session_id) {
            Some(session) => {
                session.kill();
                Some(SupervisorResponse::Ok)
            }
            None => Some(session_not_found(session_id)),
        },
        SupervisorRequest::ListSessions => Some(SupervisorResponse::Sessions {
            sessions: table.list(),
        }),
        SupervisorRequest::Attach { session_id } => match table.get(session_id) {
            Some(session) => {
                // Replay scrollback first, then stream live output on a
                // forwarder thread until the client disconnects.
                let replay = SupervisorResponse::Scrollback {
                    session_id: session_id.clone(),
                    data: session.scrollback_snapshot(),
                };
                write_frame(write_stream, &replay);

                let mut rx = session.subscribe();
                let forward_stream = write_stream.clone();
                let alive = client_alive.clone();
                let sid = session_id.clone();
                std::thread::spawn(move || {
                    while alive.load(Ordering::Relaxed) {
                        match rx.blocking_recv() {
                            Ok(data) => {
                                let frame = SupervisorResponse::Output {
                                    session_id: sid.clone(),
                                    data,
                                };
                                if !write_frame(&forward_stream, &frame) {
                                    break;
                                }
                            }
                            Err(_) => break,
                        }
                    }
                });
                Some(SupervisorResponse::Ok)
            }
            None => Some(session_not_found(session_id)),
        },
        SupervisorRequest::Detach { .. } => Some(SupervisorResponse::Ok),
        SupervisorRequest::Shutdown { kill_all } => {
            if *kill_all {
                table.kill_all();
            }
            shutdown.store(true, Ordering::Relaxed);
            Some(SupervisorResponse::Ok)
        }
    }
}

fn session_not_found(session_id: &str) -> SupervisorResponse {
    SupervisorResponse::Error {
        code: "session_not_found".to_string(),
        message: format!("no session {session_id}"),
    }
}
