//! Supervisor daemon core (Unix).
//!
//! Owns PTY masters + child processes independently of any UI client, so a
//! force-closed / crashed Termul leaves the CLI sessions running. A client
//! reconnects over the Unix socket, lists sessions, and re-attaches to live
//! output with a scrollback replay.
//!
//! Windows (named-pipe transport + ConPTY ownership) is a separate platform and
//! is intentionally not implemented here yet.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tokio::sync::broadcast;

use crate::session_recovery::ipc::SpawnSpec;
use crate::session_recovery::registry::{
    RecoveredSession, RecoveredSessionKind, RecoveredSessionStatus,
};

/// Max bytes retained per session for replay on re-attach.
const SCROLLBACK_CAP: usize = 256 * 1024;
const OUTPUT_CHUNK: usize = 8 * 1024;
const BROADCAST_CAP: usize = 1024;

/// A single supervisor-owned PTY session.
pub struct Session {
    pub id: String,
    pub pid: u32,
    pub spec: SpawnSpec,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    scrollback: Mutex<std::collections::VecDeque<u8>>,
    /// Broadcast of live output bytes to all attached clients.
    output_tx: broadcast::Sender<Vec<u8>>,
    exited: AtomicBool,
    exit_code: Mutex<Option<i32>>,
    reader_done: Arc<AtomicBool>,
}

impl Session {
    pub fn subscribe(&self) -> broadcast::Receiver<Vec<u8>> {
        self.output_tx.subscribe()
    }

    pub fn scrollback_snapshot(&self) -> Vec<u8> {
        self.scrollback.lock().iter().copied().collect()
    }

    pub fn write_input(&self, data: &[u8]) -> std::io::Result<()> {
        let mut w = self.writer.lock();
        w.write_all(data)?;
        w.flush()
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.master
            .lock()
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("resize failed: {e}"))
    }

    pub fn kill(&self) {
        let _ = self.child.lock().kill();
    }

    pub fn is_exited(&self) -> bool {
        self.exited.load(Ordering::Relaxed)
    }

    pub fn to_recovered(&self) -> RecoveredSession {
        let status = if self.is_exited() {
            RecoveredSessionStatus::Exited
        } else {
            RecoveredSessionStatus::Running
        };
        RecoveredSession {
            session_id: self.id.clone(),
            kind: RecoveredSessionKind::Terminal,
            status,
            pid: Some(self.pid),
            process_group_id: Some(self.pid),
            command: self.spec.command.clone().or_else(|| self.spec.shell.clone()),
            args: self.spec.args.clone(),
            shell: self.spec.shell.clone(),
            cwd: self.spec.cwd.clone(),
            cols: Some(self.spec.cols),
            rows: Some(self.spec.rows),
            scrollback_journal_path: None,
            exit_code: *self.exit_code.lock(),
            recovery_reason: None,
        }
    }
}

/// The live, in-memory table of supervisor-owned sessions.
#[derive(Default)]
pub struct SessionTable {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

impl SessionTable {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn list(&self) -> Vec<RecoveredSession> {
        self.sessions
            .lock()
            .values()
            .map(|s| s.to_recovered())
            .collect()
    }

    pub fn get(&self, session_id: &str) -> Option<Arc<Session>> {
        self.sessions.lock().get(session_id).cloned()
    }

    pub fn is_empty(&self) -> bool {
        self.sessions.lock().is_empty()
    }

    pub fn kill_all(&self) {
        for session in self.sessions.lock().values() {
            session.kill();
        }
    }

    /// Spawn a new PTY-backed session and start its reader thread. The reader
    /// appends to the scrollback ring and broadcasts to attached clients; on
    /// EOF it records the exit code and marks the session exited.
    pub fn spawn(&self, spec: SpawnSpec) -> Result<Arc<Session>, String> {
        let shell = spec
            .shell
            .clone()
            .or_else(|| std::env::var("SHELL").ok())
            .unwrap_or_else(|| "/bin/sh".to_string());

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: spec.rows.max(1),
                cols: spec.cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("openpty failed: {e}"))?;

        let program = spec.command.clone().unwrap_or_else(|| shell.clone());
        let mut cmd = CommandBuilder::new(&program);
        for arg in &spec.args {
            cmd.arg(arg);
        }
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        if let Some(cwd) = &spec.cwd {
            cmd.cwd(cwd);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn failed: {e}"))?;
        let pid = child.process_id().unwrap_or(0);
        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("clone reader failed: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("take writer failed: {e}"))?;

        let (output_tx, _) = broadcast::channel(BROADCAST_CAP);
        let session = Arc::new(Session {
            id: new_session_id(),
            pid,
            spec,
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            scrollback: Mutex::new(std::collections::VecDeque::new()),
            output_tx,
            exited: AtomicBool::new(false),
            exit_code: Mutex::new(None),
            reader_done: Arc::new(AtomicBool::new(false)),
        });

        start_reader(session.clone(), reader);

        self.sessions
            .lock()
            .insert(session.id.clone(), session.clone());
        Ok(session)
    }
}

fn start_reader(session: Arc<Session>, mut reader: Box<dyn Read + Send>) {
    let done = session.reader_done.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; OUTPUT_CHUNK];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = &buf[..n];
                    {
                        let mut sb = session.scrollback.lock();
                        sb.extend(chunk.iter().copied());
                        while sb.len() > SCROLLBACK_CAP {
                            sb.pop_front();
                        }
                    }
                    // Best-effort broadcast; ignore if no client attached.
                    let _ = session.output_tx.send(chunk.to_vec());
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }

        // EOF: reap the child and record the exit code.
        let code = {
            let mut child = session.child.lock();
            match child.wait() {
                Ok(status) => status.exit_code() as i32,
                Err(_) => -1,
            }
        };
        *session.exit_code.lock() = Some(code);
        session.exited.store(true, Ordering::Relaxed);
        done.store(true, Ordering::Relaxed);
    });
}

fn new_session_id() -> String {
    format!("sess-{}-{}", std::process::id(), now_nanos())
}

fn now_nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// Detach the current process from the controlling terminal / parent process
/// group so it survives the parent (Termul) dying. Call once at daemon start.
pub fn daemonize_detach() {
    // SAFETY: setsid() on a freshly started process with no children is safe;
    // it creates a new session so the daemon is not killed when the parent's
    // process group is signalled.
    unsafe {
        libc::setsid();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn echo_spec(line: &str) -> SpawnSpec {
        SpawnSpec {
            shell: Some("/bin/sh".to_string()),
            cwd: Some("/tmp".to_string()),
            cols: 80,
            rows: 24,
            command: Some("/bin/sh".to_string()),
            args: vec!["-c".to_string(), format!("printf '{line}'; sleep 0.2")],
            env: vec![],
        }
    }

    #[test]
    fn spawn_captures_output_in_scrollback() {
        let table = SessionTable::new();
        let session = table.spawn(echo_spec("hello-supervisor")).unwrap();

        // Wait for the short command to finish and reader to drain.
        for _ in 0..200 {
            if session.is_exited() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        let out = String::from_utf8_lossy(&session.scrollback_snapshot()).to_string();
        assert!(
            out.contains("hello-supervisor"),
            "scrollback should capture child output, got: {out:?}"
        );
        assert!(session.is_exited());
    }

    #[test]
    fn list_reflects_spawned_session() {
        let table = SessionTable::new();
        assert!(table.is_empty());
        let session = table.spawn(echo_spec("x")).unwrap();
        let listed = table.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].session_id, session.id);
        assert_eq!(listed[0].pid, Some(session.pid));
    }

    #[test]
    fn write_input_reaches_shell() {
        let table = SessionTable::new();
        let session = table
            .spawn(SpawnSpec {
                shell: Some("/bin/sh".to_string()),
                cwd: Some("/tmp".to_string()),
                cols: 80,
                rows: 24,
                command: Some("/bin/sh".to_string()),
                args: vec![],
                env: vec![],
            })
            .unwrap();

        session.write_input(b"printf 'from-stdin'\nexit\n").unwrap();

        for _ in 0..300 {
            if session.is_exited() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        let out = String::from_utf8_lossy(&session.scrollback_snapshot()).to_string();
        assert!(
            out.contains("from-stdin"),
            "stdin write should reach the shell, got: {out:?}"
        );
    }
}
