//! ACP terminal capability: a non-interactive command runner servicing
//! `terminal/create|output|wait_for_terminal_exit|kill|release`.
//!
//! This is deliberately NOT bridged through the interactive `PtyManager`
//! (ConPTY / xterm streaming / renderer refs): ACP terminals are
//! fire-and-poll command runs (spawn a command, buffer output to a byte cap,
//! poll, wait/kill/release, report exit status). We run them with
//! `tokio::process::Command` and own all state on the agent's driver thread, so
//! nothing here needs to be `Send` across threads.
//!
//! Terminal access is the highest-risk client capability (arbitrary command
//! execution requested by the agent), so it is OFF by default and only enabled
//! per-agent via `AgentConfig.allow_terminal` (M6 = false).

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;

use agent_client_protocol::schema::{TerminalExitStatus, TerminalId};
use parking_lot::Mutex;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

/// Truncate a byte buffer from the FRONT so it fits within `limit`, then advance
/// to the next UTF-8 character boundary so the retained bytes form a valid
/// string. Returns the (possibly) trimmed buffer and whether any truncation
/// happened. Trimming slightly under the limit is acceptable per the ACP spec.
#[must_use]
pub fn truncate_front_to_char_boundary(buf: &[u8], limit: usize) -> (Vec<u8>, bool) {
    if buf.len() <= limit {
        return (buf.to_vec(), false);
    }
    // Drop from the front to reach the limit, then walk forward to a char start.
    let mut start = buf.len() - limit;
    while start < buf.len() && (buf[start] & 0b1100_0000) == 0b1000_0000 {
        // byte is a UTF-8 continuation byte (10xxxxxx) — advance to a leading byte
        start += 1;
    }
    (buf[start..].to_vec(), true)
}

/// Shared, growing output buffer for a single terminal, capped by an optional
/// byte limit (front-truncated when exceeded).
#[derive(Default)]
struct TerminalBuffer {
    bytes: Vec<u8>,
    truncated: bool,
    limit: Option<usize>,
}

impl TerminalBuffer {
    fn append(&mut self, chunk: &[u8]) {
        self.bytes.extend_from_slice(chunk);
        if let Some(limit) = self.limit {
            if self.bytes.len() > limit {
                let (trimmed, did) = truncate_front_to_char_boundary(&self.bytes, limit);
                self.bytes = trimmed;
                self.truncated = self.truncated || did;
            }
        }
    }

    fn snapshot(&self) -> (String, bool) {
        (String::from_utf8_lossy(&self.bytes).into_owned(), self.truncated)
    }
}

/// A live (or completed) terminal: its child process handle, shared output
/// buffer, and a cached exit status (set once the process is observed exited).
struct AcpTerminal {
    /// `None` while a `wait_exit` is in flight (the child is being awaited
    /// outside the registry lock) or after the process has been reaped.
    child: Option<tokio::process::Child>,
    buffer: Arc<Mutex<TerminalBuffer>>,
    exit: Option<TerminalExitStatus>,
}

/// Per-agent registry of terminals, keyed by ACP `TerminalId`. Owned by the
/// driver thread (not `Send`-shared).
#[derive(Default)]
pub struct TerminalRegistry {
    terminals: HashMap<String, AcpTerminal>,
    next_id: u64,
}

impl TerminalRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Spawn a command and begin capturing its combined stdout+stderr.
    pub fn create(
        &mut self,
        command: &str,
        args: &[String],
        env: &[(String, String)],
        cwd: Option<&std::path::Path>,
        output_byte_limit: Option<u64>,
    ) -> Result<TerminalId, String> {
        // Validate the working directory if provided.
        if let Some(dir) = cwd {
            if !dir.is_absolute() {
                return Err(format!("cwd must be absolute: {}", dir.display()));
            }
            if !dir.exists() {
                return Err(format!("cwd does not exist: {}", dir.display()));
            }
        }

        // Resolve the executable on Windows so bare names like "npm"/"npx"
        // map to their .cmd/.bat wrappers (no-op on Unix, where the OS resolves
        // bare names on PATH natively). Mirrors the agent-spawn path.
        let resolved = crate::trackers::git_tracker::resolve_executable(command);
        let mut cmd = Command::new(resolved);
        cmd.args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for (k, v) in env {
            cmd.env(k, v);
        }
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn terminal command: {e}"))?;

        let buffer = Arc::new(Mutex::new(TerminalBuffer {
            limit: output_byte_limit.map(|l| l as usize),
            ..TerminalBuffer::default()
        }));

        // Reader tasks append stdout/stderr to the shared buffer off the
        // dispatch path. They hold the pipe handles (taken from the child),
        // independent of the child handle we keep for wait/kill.
        if let Some(mut out) = child.stdout.take() {
            let buf = buffer.clone();
            tokio::spawn(async move {
                let mut chunk = [0u8; 8192];
                loop {
                    match out.read(&mut chunk).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => buf.lock().append(&chunk[..n]),
                    }
                }
            });
        }
        if let Some(mut err) = child.stderr.take() {
            let buf = buffer.clone();
            tokio::spawn(async move {
                let mut chunk = [0u8; 8192];
                loop {
                    match err.read(&mut chunk).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => buf.lock().append(&chunk[..n]),
                    }
                }
            });
        }

        self.next_id += 1;
        let id = format!("term-{}", self.next_id);
        let terminal_id = TerminalId::new(id.as_str());
        self.terminals.insert(
            id,
            AcpTerminal {
                child: Some(child),
                buffer,
                exit: None,
            },
        );
        Ok(terminal_id)
    }

    /// Current buffered output + truncation flag + exit status (if exited).
    /// Non-blocking: uses `try_wait` to observe (and cache) exit without blocking.
    pub fn output(
        &mut self,
        id: &TerminalId,
    ) -> Result<(String, bool, Option<TerminalExitStatus>), String> {
        let term = self
            .terminals
            .get_mut(id.0.as_ref())
            .ok_or_else(|| format!("unknown terminal: {}", id.0))?;
        if term.exit.is_none() {
            if let Some(child) = term.child.as_mut() {
                if let Ok(Some(status)) = child.try_wait() {
                    term.exit = Some(to_exit_status(status));
                }
            }
        }
        let (output, truncated) = term.buffer.lock().snapshot();
        Ok((output, truncated, term.exit.clone()))
    }

    /// Take the child handle out of the registry so the caller can `await` its
    /// exit WITHOUT holding the registry lock across the await. Returns:
    /// - `Ok(Some(child))` to await, then call [`record_exit`],
    /// - `Ok(None)` if the exit status is already known (see `cached_exit`),
    /// - `Err` if the terminal id is unknown.
    pub fn take_child_for_wait(
        &mut self,
        id: &TerminalId,
    ) -> Result<Option<tokio::process::Child>, String> {
        let term = self
            .terminals
            .get_mut(id.0.as_ref())
            .ok_or_else(|| format!("unknown terminal: {}", id.0))?;
        if term.exit.is_some() {
            return Ok(None);
        }
        Ok(term.child.take())
    }

    /// The cached exit status for a terminal, if known.
    #[must_use]
    pub fn cached_exit(&self, id: &TerminalId) -> Option<TerminalExitStatus> {
        self.terminals.get(id.0.as_ref()).and_then(|t| t.exit.clone())
    }

    /// Record a terminal's observed exit status (and that it is reaped). Called
    /// after awaiting the child taken via [`take_child_for_wait`].
    pub fn record_exit(&mut self, id: &TerminalId, status: TerminalExitStatus) {
        if let Some(term) = self.terminals.get_mut(id.0.as_ref()) {
            term.exit = Some(status);
            term.child = None;
        }
    }

    /// Kill the process but keep its buffer + exit status queryable.
    pub fn kill(&mut self, id: &TerminalId) -> Result<(), String> {
        let term = self
            .terminals
            .get_mut(id.0.as_ref())
            .ok_or_else(|| format!("unknown terminal: {}", id.0))?;
        if let Some(child) = term.child.as_mut() {
            let _ = child.start_kill();
            // Reap if it has already exited so we don't leave a zombie; the
            // handle stays in the map (we keep the buffer/status queryable),
            // and `release` will spawn a waiter if it's still running then.
            if let Ok(Some(status)) = child.try_wait() {
                term.exit = Some(to_exit_status(status));
                term.child = None;
            }
        }
        Ok(())
    }

    /// Release a terminal: kill if still running and drop all its resources.
    pub fn release(&mut self, id: &TerminalId) -> Result<(), String> {
        let mut term = self
            .terminals
            .remove(id.0.as_ref())
            .ok_or_else(|| format!("unknown terminal: {}", id.0))?;
        if let Some(child) = term.child.take() {
            reap(child);
        }
        Ok(())
    }

    /// Kill every terminal (driver-thread teardown). Best-effort.
    pub fn release_all(&mut self) {
        for (_, mut term) in self.terminals.drain() {
            if let Some(child) = term.child.take() {
                reap(child);
            }
        }
    }
}

/// Kill and reap a child without blocking: start termination, then await its
/// exit on a background task so the OS process entry is collected (no zombie)
/// even though we've taken ownership out of the registry.
fn reap(mut child: tokio::process::Child) {
    let _ = child.start_kill();
    tokio::spawn(async move {
        let _ = child.wait().await;
    });
}

/// Convert a process exit status into the ACP `TerminalExitStatus`.
pub fn to_exit_status(status: std::process::ExitStatus) -> TerminalExitStatus {
    #[allow(unused_mut)]
    let mut exit = TerminalExitStatus::new().exit_code(status.code().map(|c| c as u32));
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = status.signal() {
            exit = exit.signal(signal_name(sig));
        }
    }
    exit
}

#[cfg(unix)]
fn signal_name(sig: i32) -> String {
    // A small, common subset; fall back to the raw number.
    match sig {
        2 => "SIGINT".to_string(),
        9 => "SIGKILL".to_string(),
        15 => "SIGTERM".to_string(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_truncation_under_limit() {
        let (out, trunc) = truncate_front_to_char_boundary(b"hello", 10);
        assert_eq!(out, b"hello");
        assert!(!trunc);
    }

    #[test]
    fn truncates_from_front() {
        let (out, trunc) = truncate_front_to_char_boundary(b"0123456789", 4);
        assert!(trunc);
        assert_eq!(String::from_utf8(out).unwrap(), "6789");
    }

    #[test]
    fn truncation_respects_utf8_char_boundary() {
        // 'a' (1 byte) + three 'é' (2 bytes each) = 7 bytes. A tight front cut
        // could land mid-codepoint; we must advance to a leading byte.
        let s = "aééé".as_bytes();
        let (out, trunc) = truncate_front_to_char_boundary(s, 5);
        assert!(trunc);
        let decoded = String::from_utf8(out).expect("valid utf-8 after truncation");
        assert!(decoded.len() <= 5);
        assert!(decoded.chars().all(|c| c == 'é'));
    }

    #[test]
    fn buffer_caps_and_flags_truncation() {
        let mut buf = TerminalBuffer {
            limit: Some(4),
            ..TerminalBuffer::default()
        };
        buf.append(b"abcdef");
        let (out, trunc) = buf.snapshot();
        assert!(trunc);
        assert_eq!(out, "cdef");
    }
}
