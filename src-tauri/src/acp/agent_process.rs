//! ACP agent process transport with whole-tree teardown.
//!
//! [`TreeKillAgent`] is a drop-in replacement for
//! [`agent_client_protocol::AcpAgent`] as the `connect_with` transport. Termul
//! spawns the agent itself on every platform and mirrors the crate's
//! `ConnectTo` impl: stdin/stdout/stderr debug lines, an error with a stderr
//! tail on a non-zero early exit, and a 1s shutdown grace.
//!
//! - **Unix:** the child's stdio goes through tokio's process and I/O types,
//!   not async-io. async-io's readiness registration wakes the waker it
//!   replaces whenever `Waker::will_wake` says the new one differs, and the
//!   connection runtime polls this transport inside a `FuturesUnordered`,
//!   which hands it a fresh waker on every poll. Optimized builds duplicate
//!   that waker's vtable, so every poll of an idle agent re-woke itself and
//!   the `acp-agent-*` thread pinned a core (#1391). tokio replaces a stored
//!   waker without waking it. Teardown SIGKILLs the agent's process group,
//!   as the crate does.
//! - **Windows:** the crate kills only the direct child, so agents that spawn
//!   their own workers (Antigravity's `agy_acp_server.exe`, `npx → node`
//!   wrappers) leak one orphan per agent. Here the process is assigned to a
//!   kill-on-close Job Object, and the job is terminated on every exit path:
//!   protocol shutdown, early child exit, connection drop/cancel, and Termul
//!   exiting (the OS closes the job handle).
//!
//! Job creation failure is logged (`warn`) and the agent runs without
//! tree-kill, exactly as before this transport existed.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::v1::McpServer;
use agent_client_protocol::util::internal_error;
use agent_client_protocol::{Client, ConnectTo, LineDirection, Role};
use futures::future::Either;

type DebugCallback = Arc<dyn Fn(&str, LineDirection) + Send + Sync + 'static>;

const STDERR_CAPTURE_LIMIT: usize = 64 * 1024;
const STDERR_READ_BUFFER_SIZE: usize = 8 * 1024;
const STDERR_LINE_TRUNCATION_MARKER: &str = "… [stderr line truncated]";
const SHUTDOWN_GRACE_PERIOD: Duration = Duration::from_secs(1);

/// An external ACP agent process whose whole process tree dies with the
/// connection. See the module docs.
pub struct TreeKillAgent {
    server: McpServer,
    debug_callback: Option<DebugCallback>,
}

impl TreeKillAgent {
    /// Agent launched from a stdio [`McpServer`] configuration.
    #[must_use]
    pub fn new(server: McpServer) -> Self {
        Self {
            server,
            debug_callback: None,
        }
    }

    /// Invoke `callback` for every line sent (stdin) or received
    /// (stdout/stderr). Same contract as `AcpAgent::with_debug`.
    #[must_use]
    pub fn with_debug<F>(mut self, callback: F) -> Self
    where
        F: Fn(&str, LineDirection) + Send + Sync + 'static,
    {
        self.debug_callback = Some(Arc::new(callback));
        self
    }
}

impl ConnectTo<Client> for TreeKillAgent {
    async fn connect_to(
        self,
        client: impl ConnectTo<<Client as Role>::Counterpart>,
    ) -> Result<(), agent_client_protocol::Error> {
        connect(self.server, self.debug_callback, client).await
    }
}

fn timer(duration: Duration) -> std::pin::Pin<Box<tokio::time::Sleep>> {
    Box::pin(tokio::time::sleep(duration))
}

#[cfg(unix)]
mod process {
    use std::os::unix::process::CommandExt as _;

    use agent_client_protocol::schema::v1::McpServer;
    use agent_client_protocol::util::internal_error;
    use tokio_util::compat::{Compat, TokioAsyncReadCompatExt as _, TokioAsyncWriteCompatExt as _};

    pub(super) type Stdin = Compat<tokio::process::ChildStdin>;
    pub(super) type Stdout = Compat<tokio::process::ChildStdout>;
    pub(super) type Stderr = Compat<tokio::process::ChildStderr>;

    /// Owns the agent child. Terminating (or dropping) it kills the child's
    /// whole process group.
    pub(super) struct TreeGuard {
        child: tokio::process::Child,
        pub(super) pid: u32,
    }

    impl TreeGuard {
        pub(super) async fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
            self.child.wait().await
        }

        pub(super) fn terminate(&mut self) {
            // The child leads its own process group, so this reaches the
            // workers of wrapper launchers (`npx → node`, `uvx → python`)
            // and the real agent of a launcher that already exited. `ESRCH`
            // means the group is already gone.
            // SAFETY: `killpg` has no memory-safety preconditions; the pid
            // came from this process's own spawn.
            unsafe { libc::killpg(self.pid as libc::pid_t, libc::SIGKILL) };
            drop(self.child.start_kill());
        }
    }

    impl Drop for TreeGuard {
        fn drop(&mut self) {
            self.terminate();
        }
    }

    pub(super) fn spawn(
        server: &McpServer,
    ) -> Result<(Stdin, Stdout, Stderr, TreeGuard), agent_client_protocol::Error> {
        let McpServer::Stdio(stdio) = server else {
            return Err(internal_error(
                "ACP agents are spawned over stdio; HTTP and SSE transports are not supported",
            ));
        };
        let mut command = std::process::Command::new(&stdio.command);
        command.args(&stdio.args);
        // Scrub AppImage-only vars before applying the agent's own env, so an
        // explicit `env` entry still wins over the cleanup (node/npx agents must
        // resolve host libraries, not the bundled ones — #1435).
        crate::process_util::clean_appimage_env(&mut command);
        for env_var in &stdio.env {
            command.env(&env_var.name, &env_var.value);
        }
        command.process_group(0);
        let mut command = tokio::process::Command::from(command);
        command
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(agent_client_protocol::Error::into_internal_error)?;
        let pid = child
            .id()
            .ok_or_else(|| internal_error("agent process exited before it was observed"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| internal_error("Failed to open stdin"))?
            .compat_write();
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| internal_error("Failed to open stdout"))?
            .compat();
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| internal_error("Failed to open stderr"))?
            .compat();
        Ok((stdin, stdout, stderr, TreeGuard { child, pid }))
    }
}

#[cfg(windows)]
mod process {
    use std::os::windows::io::AsRawHandle as _;

    use agent_client_protocol::schema::v1::McpServer;
    use agent_client_protocol::AcpAgent;

    use crate::process_util::KillOnCloseJob;

    pub(super) type Stdin = async_process::ChildStdin;
    pub(super) type Stdout = async_process::ChildStdout;
    pub(super) type Stderr = async_process::ChildStderr;

    /// Owns the agent child and its job. Terminating (or dropping) it kills
    /// the whole tree; with no job it falls back to killing the direct child.
    pub(super) struct TreeGuard {
        child: async_process::Child,
        job: Option<KillOnCloseJob>,
        pub(super) pid: u32,
    }

    impl TreeGuard {
        pub(super) async fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
            self.child.status().await
        }

        pub(super) fn terminate(&mut self) {
            if let Some(job) = &self.job {
                if let Err(error) = job.terminate() {
                    log::warn!(
                        "[acp] TerminateJobObject failed; agent descendants may survive: {error}"
                    );
                }
            }
            // Fallback without a job (and a harmless double tap with one).
            drop(self.child.kill());
        }
    }

    impl Drop for TreeGuard {
        fn drop(&mut self) {
            self.terminate();
        }
    }

    pub(super) fn spawn(
        server: &McpServer,
    ) -> Result<(Stdin, Stdout, Stderr, TreeGuard), agent_client_protocol::Error> {
        // `spawn_process` keeps `CREATE_NO_WINDOW`.
        let (stdin, stdout, stderr, child) = AcpAgent::new(server.clone()).spawn_process()?;
        let pid = child.id();
        // Assigned immediately after spawn, before the first await, so every
        // exit path (including cancelling the connection) tears the tree down
        // via the guard. A microsecond race remains between spawn and
        // assignment; agents create descendants after ms to seconds, so it
        // is accepted.
        let job = KillOnCloseJob::new_assigned(child.as_raw_handle(), "ACP agent", true);
        if job.is_some() {
            log::debug!("[acp] agent process {pid} assigned to a kill-on-close job");
        }
        Ok((stdin, stdout, stderr, TreeGuard { child, job, pid }))
    }
}

use process::TreeGuard;

#[derive(Default)]
struct StderrTail {
    bytes: VecDeque<u8>,
    truncated: bool,
}

impl StderrTail {
    fn push(&mut self, bytes: &[u8]) {
        self.bytes.extend(bytes.iter().copied());
        let overflow = self.bytes.len().saturating_sub(STDERR_CAPTURE_LIMIT);
        if overflow > 0 {
            self.truncated = true;
            drop(self.bytes.drain(..overflow));
        }
    }

    fn into_string(mut self) -> String {
        let stderr = String::from_utf8_lossy(self.bytes.make_contiguous()).into_owned();
        if self.truncated {
            format!("[stderr truncated; showing last {STDERR_CAPTURE_LIMIT} bytes]\n{stderr}")
        } else {
            stderr
        }
    }
}

/// Splits stderr bytes into bounded lines (`\n` or `\r\n`) for the debug
/// callback.
#[derive(Default)]
struct StderrDebugLines {
    current: Vec<u8>,
    truncated: bool,
}

impl StderrDebugLines {
    fn push(&mut self, bytes: &[u8], callback: &DebugCallback) {
        for &byte in bytes {
            if byte == b'\n' {
                self.emit(callback);
            } else if self.current.len() < STDERR_CAPTURE_LIMIT {
                self.current.push(byte);
            } else {
                self.truncated = true;
            }
        }
    }

    fn finish(&mut self, callback: &DebugCallback) {
        if !self.current.is_empty() || self.truncated {
            self.emit(callback);
        }
    }

    fn emit(&mut self, callback: &DebugCallback) {
        if self.current.last() == Some(&b'\r') {
            self.current.pop();
        }
        let mut line = String::from_utf8_lossy(&self.current).into_owned();
        if self.truncated {
            line.push_str(STDERR_LINE_TRUNCATION_MARKER);
        }
        callback(&line, LineDirection::Stderr);
        self.current.clear();
        self.truncated = false;
    }
}

/// Read stderr to EOF, feeding the debug callback, and return the bounded
/// tail for exit reporting.
async fn drain_stderr(
    mut stderr: impl futures::AsyncRead + Unpin,
    debug_callback: Option<DebugCallback>,
) -> String {
    use futures::AsyncReadExt as _;

    let mut tail = StderrTail::default();
    let mut lines = StderrDebugLines::default();
    let mut buffer = vec![0_u8; STDERR_READ_BUFFER_SIZE];
    loop {
        match stderr.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read) => {
                tail.push(&buffer[..read]);
                if let Some(callback) = debug_callback.as_ref() {
                    lines.push(&buffer[..read], callback);
                }
            }
            Err(error) => {
                log::warn!("[acp] failed to read agent stderr; no longer capturing: {error}");
                break;
            }
        }
    }
    if let Some(callback) = debug_callback.as_ref() {
        lines.finish(callback);
    }
    tail.into_string()
}

struct ExitedChild {
    guard: TreeGuard,
    status: std::process::ExitStatus,
    stderr_rx: futures::channel::oneshot::Receiver<String>,
}

async fn wait_for_child(
    mut guard: TreeGuard,
    stderr_rx: futures::channel::oneshot::Receiver<String>,
) -> Result<ExitedChild, agent_client_protocol::Error> {
    let status = guard
        .wait()
        .await
        .map_err(|e| internal_error(format!("Failed to wait for process: {e}")))?;
    Ok(ExitedChild {
        guard,
        status,
        stderr_rx,
    })
}

/// Report an observed child exit. Descendants are terminated first: a
/// launcher may exit while a worker it spawned keeps running (and keeps
/// the inherited stderr open).
async fn finish_child_exit(child: ExitedChild) -> Result<(), agent_client_protocol::Error> {
    let ExitedChild {
        mut guard,
        status,
        stderr_rx,
    } = child;
    guard.terminate();
    if status.success() {
        return Ok(());
    }
    let stderr = match futures::future::select(stderr_rx, timer(SHUTDOWN_GRACE_PERIOD)).await {
        Either::Left((stderr, _)) => stderr.unwrap_or_default(),
        Either::Right(_) => {
            log::debug!(
                "[acp] agent stderr stayed open after process exit; reporting status without it"
            );
            String::new()
        }
    };
    let message = if stderr.is_empty() {
        format!("Process exited with {status}")
    } else {
        format!("Process exited with {status}: {stderr}")
    };
    Err(internal_error(message))
}

async fn write_line<W>(writer: &mut W, line: String) -> std::io::Result<()>
where
    W: futures::AsyncWrite + Unpin + ?Sized,
{
    use futures::AsyncWriteExt as _;
    let mut bytes = line.into_bytes();
    bytes.push(b'\n');
    writer.write_all(&bytes).await?;
    writer.flush().await
}

async fn await_write_during_shutdown<F>(write: F) -> std::io::Result<()>
where
    F: std::future::Future<Output = std::io::Result<()>> + Unpin,
{
    match futures::future::select(write, timer(SHUTDOWN_GRACE_PERIOD)).await {
        Either::Left((result, _)) => result,
        Either::Right(_) => Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            format!(
                "Agent closed its protocol output but pending protocol output did not drain within {SHUTDOWN_GRACE_PERIOD:?}"
            ),
        )),
    }
}

/// Write one protocol line; once the agent closed stdout, a write that
/// does not drain within the grace fails instead of hanging forever.
async fn write_line_with_shutdown_timeout<W>(
    writer: &mut W,
    line: String,
    stdout_eof_rx: &mut Option<futures::channel::oneshot::Receiver<()>>,
    stdout_eof_seen: &mut bool,
) -> std::io::Result<()>
where
    W: futures::AsyncWrite + Unpin + ?Sized,
{
    let write = Box::pin(write_line(writer, line));
    if *stdout_eof_seen {
        return await_write_during_shutdown(write).await;
    }
    let Some(stdout_eof) = stdout_eof_rx.as_mut() else {
        return write.await;
    };
    match futures::future::select(write, stdout_eof).await {
        Either::Left((result, _)) => result,
        Either::Right((stdout_eof, write)) => {
            *stdout_eof_rx = None;
            if stdout_eof.is_err() {
                // Stream dropped (not a clean EOF): no deadline.
                return write.await;
            }
            *stdout_eof_seen = true;
            await_write_during_shutdown(write).await
        }
    }
}

async fn connect(
    server: McpServer,
    debug_callback: Option<DebugCallback>,
    client: impl ConnectTo<<Client as Role>::Counterpart>,
) -> Result<(), agent_client_protocol::Error> {
    use futures::io::BufReader;
    use futures::{AsyncBufReadExt as _, StreamExt as _};

    let (child_stdin, child_stdout, child_stderr, guard) = process::spawn(&server)?;
    let pid = guard.pid;

    let (stderr_tx, stderr_rx) = futures::channel::oneshot::channel::<String>();
    let stderr_callback = debug_callback.clone();
    let stderr_future = Box::pin(async move {
        let captured = drain_stderr(child_stderr, stderr_callback).await;
        drop(stderr_tx.send(captured));
    });
    let child_wait = Box::pin(wait_for_child(guard, stderr_rx));

    let incoming_lines: std::pin::Pin<
        Box<dyn futures::Stream<Item = std::io::Result<String>> + Send>,
    > = if let Some(callback) = debug_callback.clone() {
        Box::pin(BufReader::new(child_stdout).lines().inspect(move |result| {
            if let Ok(line) = result {
                callback(line, LineDirection::Stdout);
            }
        }))
    } else {
        Box::pin(BufReader::new(child_stdout).lines())
    };

    // Signal physical stdout EOF so a final stdin write cannot hang on an
    // agent that half-closed stdout and stopped reading.
    let (stdout_eof_tx, stdout_eof_rx) = futures::channel::oneshot::channel();
    let mut stdout_eof_tx = Some(stdout_eof_tx);
    let mut incoming_lines = incoming_lines;
    let incoming_lines = Box::pin(futures::stream::poll_fn(move |cx| {
        let next = incoming_lines.as_mut().poll_next(cx);
        if matches!(next, std::task::Poll::Ready(None)) {
            if let Some(tx) = stdout_eof_tx.take() {
                let _ = tx.send(());
            }
        }
        next
    }));

    let outgoing_sink: std::pin::Pin<
        Box<dyn futures::Sink<String, Error = std::io::Error> + Send>,
    > = Box::pin(futures::sink::unfold(
        (child_stdin, debug_callback, Some(stdout_eof_rx), false),
        async move |(mut writer, callback, mut stdout_eof_rx, mut stdout_eof_seen),
                    line: String| {
            if let Some(callback) = callback.as_ref() {
                callback(&line, LineDirection::Stdin);
            }
            write_line_with_shutdown_timeout(
                &mut writer,
                line,
                &mut stdout_eof_rx,
                &mut stdout_eof_seen,
            )
            .await?;
            Ok::<_, std::io::Error>((writer, callback, stdout_eof_rx, stdout_eof_seen))
        },
    ));

    let protocol_future = Box::pin(ConnectTo::<Client>::connect_to(
        agent_client_protocol::Lines::new(outgoing_sink, incoming_lines),
        client,
    ));

    // Race the protocol against child exit (same shape as the crate).
    let main_race = Box::pin(async move {
        match futures::future::select(protocol_future, child_wait).await {
            Either::Left((result, child_wait)) => {
                result?;
                match futures::future::select(child_wait, timer(SHUTDOWN_GRACE_PERIOD)).await {
                    Either::Left((child, _)) => finish_child_exit(child?).await,
                    Either::Right((_, child_wait)) => {
                        log::debug!(
                            "[acp] agent process {pid} did not exit after protocol shutdown; terminating its tree"
                        );
                        drop(child_wait);
                        Ok(())
                    }
                }
            }
            Either::Right((child, protocol_future)) => {
                finish_child_exit(child?).await?;
                match futures::future::select(protocol_future, timer(SHUTDOWN_GRACE_PERIOD)).await {
                    Either::Left((result, _)) => result,
                    Either::Right(_) => {
                        log::debug!(
                            "[acp] protocol transport stayed open after agent process {pid} exited; stopping it"
                        );
                        Ok(())
                    }
                }
            }
        }
    });

    // Collect stderr concurrently; once the main race settles it is moot.
    match futures::future::select(main_race, stderr_future).await {
        Either::Left((result, _)) => result,
        Either::Right(((), main_race)) => main_race.await,
    }
}

#[cfg(all(test, windows))]
mod tests;

#[cfg(all(test, unix))]
mod unix_tests;
