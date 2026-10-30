//! The running Claude sign-in of each Account, and the link sign-in.
//!
//! A link sign-in runs `claude auth login` on the host without opening a
//! browser. The CLI prints a sign-in link, which goes to the client. The user
//! signs in on claude.com in any browser, and the Claude page shows a code.
//! The client sends that code back, and the host writes it to the CLI. The CLI
//! exchanges the code and stores the login itself, so Termul never sees a
//! token. The link, the code and the CLI output are never logged.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use super::accounts::{LOGIN_CANCELLED, LOGIN_TIMEOUT};
use super::{claude_cli_command, ClaudeAgentService};

/// How long the CLI may take to print the sign-in link, and to answer a code.
const CLI_STEP_TIMEOUT: Duration = Duration::from_secs(30);
/// Longest code accepted. A real code is a few hundred characters.
const MAX_CODE_CHARS: usize = 4096;
/// Most CLI output a session keeps while it looks for the link or a verdict:
/// the latest part, where both appear.
const MAX_OUTPUT_BYTES: usize = 64 * 1024;
/// Output chunks waiting for the session; a full queue pauses the pipe reads.
const OUTPUT_CHUNKS: usize = 64;

const NO_LINK: &str = "The Claude CLI did not show a sign-in link. Try again.";
const NO_LINK_LOGIN: &str = "No sign-in is waiting for a code. Start the sign-in again.";
const CODE_REJECTED: &str = "Claude did not accept that code. Start the sign-in again.";
const CODE_UNANSWERED: &str = "Claude did not answer in time. Start the sign-in again.";
const CODE_EARLY: &str = "The sign-in link is not ready yet.";
const CODE_BUSY: &str = "Claude is still checking the last code.";

/// The running sign-in of each Account, at most one per Account. Dropping an
/// entry stops its sign-in: the browser login's cancel receiver resolves, and
/// the link session's code channel closes.
#[derive(Default)]
pub(super) struct Logins {
    generations: AtomicU64,
    running: parking_lot::Mutex<HashMap<String, Login>>,
}

struct Login {
    generation: u64,
    kind: LoginKind,
    /// Resolves once the task running the sign-in dropped its [`Ticket`].
    ended: oneshot::Receiver<()>,
}

pub(super) enum LoginKind {
    /// `claude auth login` that opened the host's browser. Held only so that
    /// dropping it stops that login.
    Browser { _cancel: oneshot::Sender<()> },
    /// A link sign-in that waits for the code from the client.
    Link(mpsc::Sender<CodeSubmission>),
}

/// Held by the task that runs a sign-in, and dropped only once its CLI is
/// gone. [`Logins::stop`] waits for that.
pub(super) struct Ticket {
    generation: u64,
    _ended: oneshot::Sender<()>,
}

impl Logins {
    /// Register `kind` as the sign-in of `id`, stopping the one it replaces.
    /// The caller hands the ticket to [`Self::end`] once its CLI is gone.
    pub(super) fn begin(&self, id: &str, kind: LoginKind) -> Ticket {
        let generation = self.generations.fetch_add(1, Ordering::Relaxed);
        let (ended_tx, ended) = oneshot::channel();
        let replaced = self.running.lock().insert(
            id.to_string(),
            Login {
                generation,
                kind,
                ended,
            },
        );
        if replaced.is_some() {
            log::info!("[claude-accounts] a new sign-in replaced the running one");
        }
        Ticket {
            generation,
            _ended: ended_tx,
        }
    }

    /// Forget the sign-in of `id` if it is still the one `ticket` names.
    pub(super) fn end(&self, id: &str, ticket: Ticket) {
        let mut running = self.running.lock();
        if running
            .get(id)
            .is_some_and(|login| login.generation == ticket.generation)
        {
            running.remove(id);
        }
    }

    /// Stop the sign-in of `id` and wait until its CLI is gone. `false` when
    /// none was running.
    pub(super) async fn stop(&self, id: &str) -> bool {
        let stopped = self.running.lock().remove(id);
        let Some(Login { kind, ended, .. }) = stopped else {
            return false;
        };
        drop(kind);
        let _ = ended.await;
        true
    }

    fn link(&self, id: &str) -> Option<mpsc::Sender<CodeSubmission>> {
        match &self.running.lock().get(id)?.kind {
            LoginKind::Link(codes) => Some(codes.clone()),
            LoginKind::Browser { .. } => None,
        }
    }
}

/// A code from the Claude page, with the whitespace a paste picks up removed.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct LoginCode(String);

impl LoginCode {
    pub(super) fn parse(pasted: &str) -> Option<Self> {
        let code: String = pasted.split_whitespace().collect();
        let usable =
            !code.is_empty() && code.len() <= MAX_CODE_CHARS && !code.chars().any(char::is_control);
        usable.then_some(Self(code))
    }
}

/// Why a code did not finish the link sign-in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkCodeError {
    /// The CLI asked for the whole code. The sign-in still waits for one.
    Incomplete,
    /// The sign-in is over; the user starts it again.
    Ended(String),
}

impl LinkCodeError {
    #[must_use]
    pub fn message(&self) -> &str {
        match self {
            Self::Incomplete => {
                "That code is incomplete. Copy the whole code from the Claude page."
            }
            Self::Ended(message) => message,
        }
    }
}

fn ended(message: &str) -> LinkCodeError {
    LinkCodeError::Ended(message.to_string())
}

pub(super) struct CodeSubmission {
    code: LoginCode,
    reply: oneshot::Sender<Result<(), LinkCodeError>>,
}

/// The sign-in link in `claude auth login` output: the `https://` token after
/// "visit:", once whitespace has closed it (a later read may still extend an
/// unclosed one).
pub(super) fn sign_in_link(output: &str) -> Option<&str> {
    let after_visit = &output[output.find("visit:")? + "visit:".len()..];
    let link = &after_visit[after_visit.find("https://")?..];
    let end = link.find(|c: char| c.is_whitespace() || c.is_control())?;
    Some(&link[..end])
}

/// Append `text` to `output`, keeping at most the last [`MAX_OUTPUT_BYTES`].
pub(super) fn keep_tail(output: &mut String, text: &str) {
    output.push_str(text);
    let Some(mut cut) = output.len().checked_sub(MAX_OUTPUT_BYTES) else {
        return;
    };
    while !output.is_char_boundary(cut) {
        cut += 1;
    }
    output.drain(..cut);
}

/// Whether the CLI refused a code as cut short. It then waits for another.
pub(super) fn reports_incomplete_code(output: &str) -> bool {
    output.contains("Invalid code")
}

/// What a link session is doing.
enum Phase {
    /// Reading the CLI output until it prints the sign-in link.
    AwaitingLink {
        output: String,
        until: Instant,
        reply: oneshot::Sender<Result<String, String>>,
    },
    /// The link went to the client. The CLI waits for the code.
    AwaitingCode,
    /// A code went to the CLI. Its verdict goes to `reply`.
    Checking {
        output: String,
        until: Instant,
        reply: oneshot::Sender<Result<(), LinkCodeError>>,
    },
}

/// Something a link session reacts to.
enum Event {
    /// Text the CLI printed on stdout or stderr.
    Output(String),
    Exited {
        success: bool,
    },
    Code(CodeSubmission),
    /// The registry dropped the session: cancelled, or replaced by a new one.
    Cancelled,
    TimedOut,
}

/// The phase after an event (`None` ends the session) and the code to write
/// to the CLI.
struct Step {
    next: Option<Phase>,
    write: Option<LoginCode>,
}

impl Step {
    fn to(phase: Phase) -> Self {
        Self {
            next: Some(phase),
            write: None,
        }
    }

    fn end() -> Self {
        Self {
            next: None,
            write: None,
        }
    }
}

fn step(phase: Phase, event: Event, now: Instant) -> Step {
    match (phase, event) {
        (
            Phase::AwaitingLink {
                mut output,
                until,
                reply,
            },
            Event::Output(text),
        ) => {
            keep_tail(&mut output, &text);
            let Some(link) = sign_in_link(&output) else {
                return Step::to(Phase::AwaitingLink {
                    output,
                    until,
                    reply,
                });
            };
            log::info!("[claude-accounts] link sign-in is waiting for a code");
            let _ = reply.send(Ok(link.to_string()));
            Step::to(Phase::AwaitingCode)
        }
        (Phase::AwaitingLink { reply, .. }, Event::Exited { .. } | Event::TimedOut) => {
            log::warn!("[claude-accounts] the Claude CLI showed no sign-in link");
            let _ = reply.send(Err(NO_LINK.to_string()));
            Step::end()
        }
        (Phase::AwaitingLink { reply, .. }, Event::Cancelled) => {
            log::info!("[claude-accounts] link sign-in cancelled");
            let _ = reply.send(Err(LOGIN_CANCELLED.to_string()));
            Step::end()
        }
        (phase @ Phase::AwaitingLink { .. }, Event::Code(early)) => {
            let _ = early.reply.send(Err(ended(CODE_EARLY)));
            Step::to(phase)
        }
        (Phase::AwaitingCode, Event::Output(_)) => Step::to(Phase::AwaitingCode),
        (Phase::AwaitingCode, Event::Code(CodeSubmission { code, reply })) => Step {
            next: Some(Phase::Checking {
                output: String::new(),
                until: now + CLI_STEP_TIMEOUT,
                reply,
            }),
            write: Some(code),
        },
        (Phase::AwaitingCode, Event::Exited { .. }) => {
            log::warn!("[claude-accounts] the Claude CLI stopped while waiting for a code");
            Step::end()
        }
        (Phase::AwaitingCode, Event::TimedOut) => {
            log::warn!("[claude-accounts] link sign-in timed out waiting for a code");
            Step::end()
        }
        (Phase::AwaitingCode, Event::Cancelled) => {
            log::info!("[claude-accounts] link sign-in cancelled");
            Step::end()
        }
        (
            Phase::Checking {
                mut output,
                until,
                reply,
            },
            Event::Output(text),
        ) => {
            keep_tail(&mut output, &text);
            if !reports_incomplete_code(&output) {
                return Step::to(Phase::Checking {
                    output,
                    until,
                    reply,
                });
            }
            log::info!("[claude-accounts] the Claude CLI asked for the whole code");
            let _ = reply.send(Err(LinkCodeError::Incomplete));
            Step::to(Phase::AwaitingCode)
        }
        (Phase::Checking { reply, .. }, Event::Exited { success }) => {
            if success {
                log::info!("[claude-accounts] link sign-in finished");
                let _ = reply.send(Ok(()));
            } else {
                log::warn!("[claude-accounts] the Claude CLI did not accept the code");
                let _ = reply.send(Err(ended(CODE_REJECTED)));
            }
            Step::end()
        }
        (Phase::Checking { reply, .. }, Event::TimedOut) => {
            log::warn!("[claude-accounts] the Claude CLI did not answer the code in time");
            let _ = reply.send(Err(ended(CODE_UNANSWERED)));
            Step::end()
        }
        (Phase::Checking { reply, .. }, Event::Cancelled) => {
            log::info!("[claude-accounts] link sign-in cancelled");
            let _ = reply.send(Err(ended(LOGIN_CANCELLED)));
            Step::end()
        }
        (phase @ Phase::Checking { .. }, Event::Code(second)) => {
            let _ = second.reply.send(Err(ended(CODE_BUSY)));
            Step::to(phase)
        }
    }
}

/// The `claude auth login` child of one link session.
struct LinkCli {
    child: Child,
    stdin: ChildStdin,
    /// stdout and stderr chunks; closed once both pipes end.
    output: mpsc::Receiver<String>,
}

/// Forward each chunk `pipe` yields to `output` until it ends.
fn forward(mut pipe: impl AsyncRead + Unpin + Send + 'static, output: mpsc::Sender<String>) {
    tokio::spawn(async move {
        let mut buffer = [0u8; 4096];
        while let Ok(read @ 1..) = pipe.read(&mut buffer).await {
            if output
                .send(String::from_utf8_lossy(&buffer[..read]).into_owned())
                .await
                .is_err()
            {
                break;
            }
        }
    });
}

async fn next_output(output: &mut mpsc::Receiver<String>) -> String {
    match output.recv().await {
        Some(text) => text,
        None => std::future::pending().await,
    }
}

/// Drive one link session until it ends and its CLI is gone.
async fn run_link_session(
    mut cli: LinkCli,
    mut phase: Phase,
    mut codes: mpsc::Receiver<CodeSubmission>,
    session_until: Instant,
) {
    loop {
        let until = match &phase {
            Phase::AwaitingLink { until, .. } | Phase::Checking { until, .. } => {
                (*until).min(session_until)
            }
            Phase::AwaitingCode => session_until,
        };
        let event = tokio::select! {
            text = next_output(&mut cli.output) => Event::Output(text),
            status = cli.child.wait() => Event::Exited {
                success: status.is_ok_and(|status| status.success()),
            },
            submission = codes.recv() => submission.map_or(Event::Cancelled, Event::Code),
            () = tokio::time::sleep_until(until) => Event::TimedOut,
        };
        let Step { next, write } = step(phase, event, Instant::now());
        if let Some(LoginCode(code)) = write {
            let line = format!("{code}\n");
            if cli.stdin.write_all(line.as_bytes()).await.is_err()
                || cli.stdin.flush().await.is_err()
            {
                // The CLI exit that closed the pipe ends the check.
                log::warn!("[claude-accounts] could not hand the code to the Claude CLI");
            }
        }
        match next {
            Some(next) => phase = next,
            None => break,
        }
    }
    // An exited CLI is already reaped; otherwise wait until it is gone.
    let _ = cli.child.kill().await;
}

impl ClaudeAgentService {
    /// Start a link sign-in for one Account and return the sign-in link. A
    /// sign-in already running for the Account stops. The session waits for
    /// [`Self::finish_link_login`] until it ends, is cancelled with
    /// [`Self::cancel_login`], or times out.
    pub async fn start_link_login(&self, id: &str) -> Result<String, String> {
        let dir = self.sign_in_dir(id)?;
        let Some(mut command) = claude_cli_command(&["auth", "login"], dir.as_deref())? else {
            return Err("Claude Code CLI is not installed or is not on PATH".to_string());
        };
        command
            .kill_on_drop(true)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        // The user opens the link wherever they are; a browser on the host
        // would only get in the way.
        #[cfg(unix)]
        command.env("BROWSER", "true");
        let mut child = command
            .spawn()
            .map_err(|_| "Could not start the Claude CLI".to_string())?;
        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            return Err("Could not start the Claude CLI".to_string());
        };
        let (output_tx, output) = mpsc::channel(OUTPUT_CHUNKS);
        forward(stdout, output_tx.clone());
        forward(stderr, output_tx);

        let (codes_tx, codes) = mpsc::channel(1);
        let (link_tx, link) = oneshot::channel();
        let ticket = self.logins.begin(id, LoginKind::Link(codes_tx));
        log::info!("[claude-accounts] link sign-in started");
        let now = Instant::now();
        let phase = Phase::AwaitingLink {
            output: String::new(),
            until: now + CLI_STEP_TIMEOUT,
            reply: link_tx,
        };
        let cli = LinkCli {
            child,
            stdin,
            output,
        };
        let logins = Arc::clone(&self.logins);
        let id = id.to_string();
        tokio::spawn(async move {
            run_link_session(cli, phase, codes, now + LOGIN_TIMEOUT).await;
            logins.end(&id, ticket);
        });
        link.await
            .unwrap_or_else(|_| Err(LOGIN_CANCELLED.to_string()))
    }

    /// Hand the code from the Claude page to the link sign-in of one Account.
    /// `Ok` once the CLI stored the login.
    pub async fn finish_link_login(&self, id: &str, pasted: &str) -> Result<(), LinkCodeError> {
        let Some(code) = LoginCode::parse(pasted) else {
            return Err(LinkCodeError::Incomplete);
        };
        let Some(codes) = self.logins.link(id) else {
            log::info!("[claude-accounts] a code arrived with no link sign-in waiting");
            return Err(ended(NO_LINK_LOGIN));
        };
        let (reply, verdict) = oneshot::channel();
        let sent = codes.send(CodeSubmission { code, reply }).await;
        // Holding the sender would keep a cancelled session waiting.
        drop(codes);
        if sent.is_err() {
            return Err(ended(NO_LINK_LOGIN));
        }
        verdict.await.unwrap_or_else(|_| Err(ended(NO_LINK_LOGIN)))
    }
}

#[cfg(test)]
#[path = "logins_tests.rs"]
mod tests;
