//! File contents are never logged here.

use super::*;

use std::io::Read;
use std::sync::mpsc;

/// Object id of git's well-known empty tree in a SHA-1 repository; the diff
/// base when there is no commit to diff against.
pub(super) const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/// Empty tree of a SHA-256 repository (`git hash-object -t tree /dev/null`).
const EMPTY_TREE_SHA256: &str = "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321";
/// Generous per-command timeout for read-only services: `diff`, `show` and
/// `log` on a large repository can outlast the 2s status-poll default.
pub(super) const GIT_READ_TIMEOUT_MS: u64 = 15_000;

/// The empty tree for a repository whose object ids are `oid_len` hex characters.
pub(super) fn empty_tree_for(oid_len: usize) -> &'static str {
    if oid_len == 64 {
        EMPTY_TREE_SHA256
    } else {
        EMPTY_TREE
    }
}

/// Why a git run failed; shared by the services that wrap it in their own error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitRunError {
    /// git could not be started, or it timed out.
    GitUnavailable(String),
    /// git ran and exited non-zero (for example, the cwd is not a repository).
    GitFailed {
        command: &'static str,
        detail: String,
    },
}

impl std::fmt::Display for GitRunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GitRunError::GitUnavailable(detail) => write!(f, "Failed to run git: {detail}"),
            GitRunError::GitFailed { command, detail } if detail.is_empty() => {
                write!(f, "git {command} failed")
            }
            GitRunError::GitFailed { command, detail } => {
                write!(f, "git {command} failed: {detail}")
            }
        }
    }
}

impl std::error::Error for GitRunError {}

/// Run git and return stdout, mapping spawn failure / timeout / non-zero exit
/// to a [`GitRunError`].
pub(super) fn git_stdout(
    cwd: &str,
    label: &'static str,
    cap: StdoutCap,
    args: &[&str],
) -> Result<Vec<u8>, GitRunError> {
    let output = run_git_capture(cwd, cap, args, GIT_READ_TIMEOUT_MS)?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(GitRunError::GitFailed {
            command: label,
            detail: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        })
    }
}

pub(super) fn run_git_capture(
    cwd: &str,
    cap: StdoutCap,
    args: &[&str],
    timeout_ms: u64,
) -> Result<std::process::Output, GitRunError> {
    let mut git = git_command(cwd);
    git.command
        .args(args)
        // Read-only: never take the index lock for an opportunistic refresh.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null());
    let child = git
        .spawn(cap)
        .map_err(|e| GitRunError::GitUnavailable(e.to_string()))?;
    child.wait(timeout_ms).map_err(|error| match error {
        GitWaitError::TimedOut => GitRunError::GitUnavailable(format!(
            "git {} timed out",
            args.first().copied().unwrap_or("")
        )),
        GitWaitError::Io(e) => GitRunError::GitUnavailable(e.to_string()),
    })
}

/// How long to keep reading git's pipes after git exits. Everything git wrote
/// is already in the pipe buffer by then, so this only covers scheduling the
/// drain threads; it is spent in full only when a process git started (a hook's
/// background job) inherited the pipes and keeps them open.
const DRAIN_GRACE: Duration = Duration::from_millis(500);

/// A git invocation for one working directory; every git runner starts from
/// [`git_command`], so a project inside WSL runs the distro's git.
pub(super) struct GitCommand {
    pub(super) command: Command,
    min_wait_ms: u64,
}

impl From<Command> for GitCommand {
    fn from(command: Command) -> Self {
        Self {
            command,
            min_wait_ms: 0,
        }
    }
}

impl GitCommand {
    pub(super) fn spawn(mut self, cap: StdoutCap) -> std::io::Result<GitChild> {
        let mut child = spawn_git(&mut self.command, cap)?;
        child.min_wait_ms = self.min_wait_ms;
        Ok(child)
    }
}

/// git, ready for its arguments, running in `cwd`.
pub(super) fn git_command(cwd: &str) -> GitCommand {
    if let Some(target) = wsl::wsl_target(cwd) {
        return GitCommand {
            command: target.git_command(),
            min_wait_ms: wsl::WSL_START_TIMEOUT_MS,
        };
    }
    let mut command = backend_command(resolve_git_binary());
    command.current_dir(cwd);
    command.into()
}

pub(crate) struct GitChild {
    child: std::process::Child,
    min_wait_ms: u64,
    #[cfg(windows)]
    job: Option<crate::process_util::KillOnCloseJob>,
    stdout: Drain,
    stderr: Drain,
}

#[derive(Debug)]
pub(crate) enum GitWaitError {
    TimedOut,
    Io(std::io::Error),
}

/// Spawn `command` with stdout and stderr drained on helper threads, so
/// output past the pipe buffer never blocks git, keeping stdout per `cap`.
pub(crate) fn spawn_git(command: &mut Command, cap: StdoutCap) -> std::io::Result<GitChild> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    // `PATH` usually resolves Git for Windows' `cmd\git.exe` launcher, which
    // runs the real `mingw64\bin\git.exe` (and ssh or credential helpers) as
    // children, so a timeout must kill the job, not just the child.
    #[cfg(windows)]
    let job = {
        use std::os::windows::io::AsRawHandle as _;
        crate::process_util::KillOnCloseJob::new_assigned(child.as_raw_handle(), "git", true)
    };
    let stdout = drain_capped(child.stdout.take(), cap);
    let stderr = drain_capped(child.stderr.take(), StdoutCap::Unbounded);
    Ok(GitChild {
        child,
        min_wait_ms: 0,
        #[cfg(windows)]
        job,
        stdout,
        stderr,
    })
}

impl GitChild {
    pub(super) fn take_stdin(&mut self) -> Option<std::process::ChildStdin> {
        self.child.stdin.take()
    }

    pub(crate) fn wait(mut self, timeout_ms: u64) -> Result<std::process::Output, GitWaitError> {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms.max(self.min_wait_ms));
        let status = loop {
            match self.child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() >= deadline => {
                    self.kill_tree();
                    return Err(GitWaitError::TimedOut);
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(10)),
                Err(e) => return Err(GitWaitError::Io(e)),
            }
        };
        // Whatever git left running (its fsmonitor daemon) is meant to
        // outlive it.
        #[cfg(windows)]
        if let Some(job) = self.job.take() {
            job.close_without_killing();
        }
        let grace_end = Instant::now() + DRAIN_GRACE;
        let stdout = self.stdout.collect_until(grace_end);
        let stderr = self.stderr.collect_until(grace_end);
        if !(stdout.reached_eof && stderr.reached_eof) {
            log::warn!(
                "[GitTracker] git exited but a process it started still holds its output \
                 pipes; returning the output read within {}ms",
                DRAIN_GRACE.as_millis()
            );
        }
        Ok(std::process::Output {
            status,
            stdout: stdout.bytes,
            stderr: stderr.bytes,
        })
    }

    fn kill_tree(&mut self) {
        #[cfg(windows)]
        if let Some(job) = &self.job {
            if let Err(error) = job.terminate() {
                log::warn!(
                    "[GitTracker] TerminateJobObject failed; git helpers may survive: {error}"
                );
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// How much of a child's stdout to retain while it is drained.
#[derive(Debug, Clone, Copy)]
pub(crate) enum StdoutCap {
    /// Keep everything.
    Unbounded,
    /// Keep only the first N NUL-terminated paths (`-z` listings); the rest is
    /// read and discarded so the child never blocks on a full pipe.
    NulPaths(usize),
    /// Keep only the first N bytes; the rest is read and discarded. Callers
    /// that must tell "exactly N" from "more than N" ask for one byte extra.
    Bytes(usize),
    /// Keep only the last N bytes, delivered when the pipe reaches EOF.
    TailBytes(usize),
}

/// A pipe being drained on a helper thread: the retained chunks arrive in
/// order, and the channel disconnects when the pipe reaches EOF.
pub(super) struct Drain(mpsc::Receiver<Vec<u8>>);

pub(super) struct Drained {
    pub(super) bytes: Vec<u8>,
    pub(super) reached_eof: bool,
}

impl Drain {
    /// The output retained by `deadline`. Dropping the drain early leaves its
    /// thread reading and discarding until every holder of the pipe exits.
    pub(super) fn collect_until(self, deadline: Instant) -> Drained {
        let mut bytes = Vec::new();
        let reached_eof = loop {
            let wait = deadline.saturating_duration_since(Instant::now());
            match self.0.recv_timeout(wait) {
                Ok(chunk) => bytes.extend_from_slice(&chunk),
                Err(mpsc::RecvTimeoutError::Disconnected) => break true,
                Err(mpsc::RecvTimeoutError::Timeout) => break false,
            }
        };
        Drained { bytes, reached_eof }
    }
}

/// Drain `pipe` to EOF on a helper thread, retaining output per `cap`.
pub(super) fn drain_capped<R: Read + Send + 'static>(pipe: Option<R>, cap: StdoutCap) -> Drain {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let Some(mut pipe) = pipe else {
            return;
        };
        let mut chunk = [0u8; 8192];
        let mut kept = 0usize;
        let mut paths = 0usize;
        let mut discard = false;
        let mut tail = Vec::new();
        loop {
            let n = match pipe.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            if discard {
                continue;
            }
            if let StdoutCap::TailBytes(max) = cap {
                tail.extend_from_slice(&chunk[..n]);
                if tail.len() > max.saturating_mul(2) {
                    tail.drain(..tail.len() - max);
                }
                continue;
            }
            let end = match cap {
                StdoutCap::Unbounded => n,
                StdoutCap::NulPaths(max) => {
                    let mut end = n;
                    for (idx, byte) in chunk[..n].iter().enumerate() {
                        if *byte == 0 {
                            paths += 1;
                            if paths >= max {
                                end = idx + 1;
                                discard = true;
                                break;
                            }
                        }
                    }
                    end
                }
                StdoutCap::Bytes(max) => {
                    let take = n.min(max - kept);
                    discard = kept + take >= max;
                    take
                }
                StdoutCap::TailBytes(_) => unreachable!("tail mode is handled above"),
            };
            kept += end;
            // Once the waiter has gone, keep reading so a process still
            // holding the pipe never blocks or dies on a closed pipe.
            if end > 0 && sender.send(chunk[..end].to_vec()).is_err() {
                discard = true;
            }
        }
        if let StdoutCap::TailBytes(max) = cap {
            let cut = tail.len().saturating_sub(max);
            let _ = sender.send(tail.split_off(cut));
        }
    });
    Drain(receiver)
}
