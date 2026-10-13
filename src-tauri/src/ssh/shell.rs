//! Interactive remote shell over an SSH channel.
//!
//! The channel is split: one task reads output, another writes keystrokes
//! and resizes, so a large paste can never stall output (or the reverse).
//! The shell is exposed to `PtyManager` through plain `Read`/`Write`/`Child`
//! adapters, so it is a regular Termul terminal (xterm, scrollback replay,
//! claims, resize, kill).

use super::connect::{ConnectError, ConnectErrorKind};
use super::connection::SshConnection;
use russh::ChannelMsg;
use std::io::{ErrorKind, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;

/// Output batches buffered between the reader task and the terminal reader
/// thread. When full, the reader task stops pulling from the channel, so the
/// SSH window applies backpressure to the server instead of growing memory.
const OUTPUT_QUEUE: usize = 256;
/// Wait for the server to accept the shell request.
const SHELL_START_TIMEOUT: Duration = Duration::from_secs(15);
/// Bound on the graceful close handshake.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);

/// Why the shell ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShellEnd {
    /// The remote shell exited (`exit`, logout); carries its exit status.
    Exited(Option<i32>),
    /// The connection broke (network loss, server gone).
    Lost(String),
    /// Closed from Termul (tab closed, app exit).
    Closed,
}

impl ShellEnd {
    fn exit_code(&self) -> u32 {
        match self {
            ShellEnd::Exited(Some(code)) => *code as u32,
            ShellEnd::Exited(None) | ShellEnd::Closed => 0,
            ShellEnd::Lost(_) => 1,
        }
    }
}

enum ShellCmd {
    Input(Vec<u8>),
    Resize(u16, u16),
    Close,
}

#[derive(Default)]
struct EndState {
    end: Mutex<Option<ShellEnd>>,
    done: Condvar,
}

impl EndState {
    fn finish(&self, end: ShellEnd) {
        let mut guard = self.end.lock().unwrap_or_else(|p| p.into_inner());
        if guard.is_none() {
            *guard = Some(end);
        }
        self.done.notify_all();
    }

    fn get(&self) -> Option<ShellEnd> {
        self.end.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
}

/// Terminal output side: blocks for the next batch; EOF once the reader task
/// has finished. Runs on `PtyManager`'s reader thread (not async).
struct OutputReader {
    rx: mpsc::Receiver<Vec<u8>>,
    pending: Vec<u8>,
    pos: usize,
}

impl Read for OutputReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.pos >= self.pending.len() {
            match self.rx.blocking_recv() {
                Some(next) => {
                    self.pending = next;
                    self.pos = 0;
                }
                None => return Ok(0),
            }
        }
        let n = std::cmp::min(buf.len(), self.pending.len() - self.pos);
        buf[..n].copy_from_slice(&self.pending[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

/// Terminal input side: hands keystrokes to the writer task.
struct InputWriter {
    tx: mpsc::UnboundedSender<ShellCmd>,
}

impl Write for InputWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.tx
            .send(ShellCmd::Input(buf.to_vec()))
            .map_err(|_| std::io::Error::new(ErrorKind::BrokenPipe, "SSH session closed"))?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// `portable_pty::Child` stand-in: kill closes the channel, wait reports the
/// remote exit status.
#[derive(Clone)]
struct ShellChild {
    tx: mpsc::UnboundedSender<ShellCmd>,
    state: Arc<EndState>,
}

impl std::fmt::Debug for ShellChild {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ShellChild").finish_non_exhaustive()
    }
}

impl portable_pty::ChildKiller for ShellChild {
    fn kill(&mut self) -> std::io::Result<()> {
        // An ended session has dropped the receiver; that is fine.
        let _ = self.tx.send(ShellCmd::Close);
        Ok(())
    }

    fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
        Box::new(self.clone())
    }
}

impl portable_pty::Child for ShellChild {
    fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
        Ok(self
            .state
            .get()
            .map(|end| portable_pty::ExitStatus::with_exit_code(end.exit_code())))
    }

    fn wait(&mut self) -> std::io::Result<portable_pty::ExitStatus> {
        let mut guard = self.state.end.lock().unwrap_or_else(|p| p.into_inner());
        while guard.is_none() {
            guard = self
                .state
                .done
                .wait(guard)
                .unwrap_or_else(|p| p.into_inner());
        }
        let code = guard.as_ref().map(ShellEnd::exit_code).unwrap_or(0);
        Ok(portable_pty::ExitStatus::with_exit_code(code))
    }

    fn process_id(&self) -> Option<u32> {
        None
    }

    #[cfg(windows)]
    fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
        None
    }
}

pub type Resizer = crate::pty::manager::ExternalResizer;

/// What `PtyManager::adopt_external` needs to run the shell as a terminal.
pub struct ShellHandles {
    pub reader: Box<dyn Read + Send>,
    pub writer: Box<dyn Write + Send>,
    pub child: Box<dyn portable_pty::Child + Send>,
    pub resizer: Resizer,
}

fn shell_error(detail: impl ToString) -> ConnectError {
    ConnectError::new(ConnectErrorKind::ShellFailed, detail.to_string())
}

fn describe(end: &ShellEnd) -> String {
    match end {
        ShellEnd::Exited(code) => format!("remote shell exited ({:?})", code),
        ShellEnd::Lost(detail) => format!("connection lost ({})", detail),
        ShellEnd::Closed => "closed by Termul".to_string(),
    }
}

/// Open a PTY + shell channel on the connection and start the I/O tasks.
/// `on_end` runs once, after the shell ended and the terminal reader has
/// seen EOF; the connection is closed at the same time.
pub async fn start(
    connection: Arc<SshConnection>,
    cols: u16,
    rows: u16,
    on_end: Box<dyn FnOnce(ShellEnd) + Send>,
) -> Result<ShellHandles, ConnectError> {
    let channel = connection
        .handle()
        .channel_open_session()
        .await
        .map_err(shell_error)?;
    channel
        .request_pty(
            false,
            "xterm-256color",
            u32::from(cols.max(1)),
            u32::from(rows.max(1)),
            0,
            0,
            &[],
        )
        .await
        .map_err(shell_error)?;
    channel.request_shell(true).await.map_err(shell_error)?;
    let (mut read, write) = channel.split();

    // The server answers the shell request before any output; keep anything
    // that arrives first anyway.
    let mut early: Vec<Vec<u8>> = Vec::new();
    loop {
        match tokio::time::timeout(SHELL_START_TIMEOUT, read.wait()).await {
            Ok(Some(ChannelMsg::Success)) => break,
            Ok(Some(ChannelMsg::Failure)) => {
                return Err(shell_error("The server refused to start a shell"))
            }
            Ok(Some(ChannelMsg::Data { data }))
            | Ok(Some(ChannelMsg::ExtendedData { data, .. })) => early.push(data.to_vec()),
            Ok(Some(_)) => {}
            Ok(None) => return Err(shell_error("The channel closed before the shell started")),
            Err(_) => return Err(shell_error("The server did not start a shell in time")),
        }
    }

    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<ShellCmd>();
    let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>(OUTPUT_QUEUE);
    let state = Arc::new(EndState::default());
    let closing = Arc::new(AtomicBool::new(false));

    // Writer: keystrokes, resizes, close.
    let writer_closing = closing.clone();
    let writer_connection = connection.clone();
    tokio::spawn(async move {
        while let Some(cmd) = cmd_rx.recv().await {
            match cmd {
                ShellCmd::Input(bytes) => {
                    if let Err(e) = write.data(&bytes[..]).await {
                        log::warn!("[SSH] Could not send input: {}", e);
                        break;
                    }
                }
                ShellCmd::Resize(cols, rows) => {
                    if let Err(e) = write
                        .window_change(u32::from(cols.max(1)), u32::from(rows.max(1)), 0, 0)
                        .await
                    {
                        log::warn!("[SSH] Resize failed: {}", e);
                    }
                }
                ShellCmd::Close => break,
            }
        }
        // Closed from Termul, or every handle to the terminal is gone.
        writer_closing.store(true, Ordering::Release);
        let _ = tokio::time::timeout(CLOSE_TIMEOUT, async {
            let _ = write.eof().await;
            let _ = write.close().await;
        })
        .await;
        writer_connection.close().await;
    });

    // Reader: output, exit status, end of the channel.
    let reader_state = state.clone();
    let reader_connection = connection.clone();
    tokio::spawn(async move {
        let mut exit: Option<i32> = None;
        for batch in early {
            let _ = out_tx.send(batch).await;
        }
        let end = loop {
            match read.wait().await {
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                    if out_tx.send(data.to_vec()).await.is_err() {
                        break ShellEnd::Closed;
                    }
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    exit = Some(i32::try_from(exit_status).unwrap_or(i32::MAX))
                }
                Some(ChannelMsg::ExitSignal { signal_name, .. }) => {
                    log::info!("[SSH] Remote shell ended by signal {:?}", signal_name);
                }
                Some(ChannelMsg::Close) => {
                    break if closing.load(Ordering::Acquire) {
                        ShellEnd::Closed
                    } else {
                        ShellEnd::Exited(exit)
                    }
                }
                Some(_) => {}
                None => {
                    break if closing.load(Ordering::Acquire) {
                        ShellEnd::Closed
                    } else if exit.is_some() {
                        ShellEnd::Exited(exit)
                    } else {
                        ShellEnd::Lost(
                            reader_connection
                                .disconnect_reason()
                                .unwrap_or_else(|| "The connection closed".to_string()),
                        )
                    }
                }
            }
        };
        log::info!("[SSH] Shell ended: {}", describe(&end));
        // Record the outcome before the terminal reader sees EOF, so the
        // terminal exit event carries the real exit status.
        reader_state.finish(end.clone());
        drop(out_tx);
        if !matches!(end, ShellEnd::Lost(_)) {
            reader_connection.close().await;
        }
        on_end(end);
    });

    let resize_tx = cmd_tx.clone();
    let resizer: Resizer = Arc::new(move |cols, rows| {
        resize_tx
            .send(ShellCmd::Resize(cols, rows))
            .map_err(|_| "SSH session closed".to_string())
    });

    Ok(ShellHandles {
        reader: Box::new(OutputReader {
            rx: out_rx,
            pending: Vec::new(),
            pos: 0,
        }),
        writer: Box::new(InputWriter { tx: cmd_tx.clone() }),
        child: Box::new(ShellChild { tx: cmd_tx, state }),
        resizer,
    })
}

#[cfg(test)]
mod tests;
