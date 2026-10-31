//! The one `gh` runner. Every GitHub op spawns `gh` through [`GhRunner`],
//! which caps concurrency, keeps a per-host rate-limit backoff window, and
//! maps spawn and exit failures to [`GithubError`].
//!
//! Never logged: stdout of any call, environment contents, tokens. `gh auth
//! token` is never run.

use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime};

use parking_lot::{Condvar, Mutex};

use super::error::{bounded, classify_failure, stderr_kind, GithubError, StderrKind};
use crate::trackers::git_tracker::{resolve_executable, spawn_captured, GitWaitError, StdoutCap};

pub(super) const GH_TIMEOUT: Duration = Duration::from_secs(20);
/// Agents running `gh` share the user's hourly budget, so the UI keeps a
/// small footprint.
const MAX_CONCURRENT: usize = 4;
/// Largest stdout kept from a JSON call; a 50-item search is ~100 KB.
const STDOUT_CAP_BYTES: usize = 8 * 1024 * 1024;
/// Backoff when the reset time is unknown (secondary limits carry none).
const FALLBACK_BACKOFF: Duration = Duration::from_secs(60);
const MAX_BACKOFF: Duration = Duration::from_secs(60 * 60);
pub(super) const DEFAULT_HOST: &str = "github.com";

/// One `gh` invocation. `host` becomes `GH_HOST`; `None` only for host-less
/// calls (`gh auth status`, `gh --version`).
#[derive(Debug, Clone)]
pub(super) struct GhCall {
    pub args: Vec<String>,
    pub host: Option<String>,
    pub stdout: StdoutCap,
}

impl GhCall {
    pub fn new<I, S>(host: Option<&str>, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            args: args.into_iter().map(Into::into).collect(),
            host: host.map(str::to_string),
            stdout: StdoutCap::Bytes(STDOUT_CAP_BYTES),
        }
    }

    pub fn keep_tail(mut self, bytes: usize) -> Self {
        self.stdout = StdoutCap::TailBytes(bytes);
        self
    }

    /// The subcommand for logs (`api`, `pr`, `repo`); never the arguments,
    /// which can carry search text.
    fn label(&self) -> &str {
        self.args.first().map(String::as_str).unwrap_or("")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct GhOutput {
    pub success: bool,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

#[derive(Debug)]
pub(super) enum SpawnFailure {
    Missing,
    TimedOut,
    Io(String),
}

/// Runs one `gh` process. The system implementation spawns the real binary;
/// tests script outputs.
pub(super) trait GhProcess: Send + Sync {
    fn run(&self, call: &GhCall, timeout: Duration) -> Result<GhOutput, SpawnFailure>;
}

pub(super) struct SystemGh;

impl GhProcess for SystemGh {
    fn run(&self, call: &GhCall, timeout: Duration) -> Result<GhOutput, SpawnFailure> {
        let mut command = Command::new(resolve_executable("gh"));
        crate::process_util::background_command_hygiene(&mut command);
        command
            .args(&call.args)
            // Never pick up a project checkout: every call names its repo.
            .current_dir(std::env::temp_dir())
            .stdin(Stdio::null())
            .env("GH_PROMPT_DISABLED", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GH_PAGER", "cat")
            .env("NO_COLOR", "1")
            .env("GH_NO_UPDATE_NOTIFIER", "1")
            .env("GH_SPINNER_DISABLED", "1")
            .env_remove("GH_REPO");
        match &call.host {
            Some(host) => command.env("GH_HOST", host),
            None => command.env_remove("GH_HOST"),
        };
        let child = spawn_captured(&mut command, call.stdout).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                SpawnFailure::Missing
            } else {
                SpawnFailure::Io(error.to_string())
            }
        })?;
        match child.wait(timeout.as_millis() as u64) {
            Ok(output) => Ok(GhOutput {
                success: output.status.success(),
                stdout: output.stdout,
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            }),
            Err(GitWaitError::TimedOut) => Err(SpawnFailure::TimedOut),
            Err(GitWaitError::Io(error)) => Err(SpawnFailure::Io(error.to_string())),
        }
    }
}

pub(super) struct GhRunner {
    process: Box<dyn GhProcess>,
    running: Mutex<usize>,
    slot_freed: Condvar,
    /// Per host: calls fail fast with `GH_RATE_LIMITED` until this time.
    backoff_until: Mutex<HashMap<String, SystemTime>>,
}

struct Slot<'a>(&'a GhRunner);

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        *self.0.running.lock() -= 1;
        self.0.slot_freed.notify_one();
    }
}

impl GhRunner {
    pub fn new(process: Box<dyn GhProcess>) -> Self {
        Self {
            process,
            running: Mutex::new(0),
            slot_freed: Condvar::new(),
            backoff_until: Mutex::new(HashMap::new()),
        }
    }

    /// Run `call` and return its stdout; a non-zero exit is an error.
    pub fn stdout(&self, call: &GhCall) -> Result<Vec<u8>, GithubError> {
        let output = self.output(call)?;
        if output.success {
            return Ok(output.stdout);
        }
        Err(self.failure(call, &output))
    }

    /// The error for a non-zero exit of `call`.
    pub fn failure(&self, call: &GhCall, output: &GhOutput) -> GithubError {
        let host = call.host.as_deref().unwrap_or(DEFAULT_HOST);
        log::warn!(
            "[github] gh {} failed on {host}: {}",
            call.label(),
            bounded(&output.stderr)
        );
        classify_failure(&output.stderr, host)
    }

    /// Run `call` and return its output even on a non-zero exit, for commands
    /// whose failure exit still carries the answer. Spawn failures, timeouts
    /// and rate limits are errors.
    pub fn output(&self, call: &GhCall) -> Result<GhOutput, GithubError> {
        if let Some(host) = &call.host {
            if let Some(until) = self.backoff_for(host) {
                return Err(GithubError::RateLimited { until: iso(until) });
            }
        }
        let output = {
            let _slot = self.take_slot()?;
            self.process.run(call, GH_TIMEOUT)
        };
        let output = match output {
            Ok(output) => output,
            Err(SpawnFailure::Missing) => return Err(GithubError::CliMissing),
            Err(SpawnFailure::TimedOut) => {
                log::warn!("[github] gh {} timed out", call.label());
                return Err(GithubError::Timeout);
            }
            Err(SpawnFailure::Io(detail)) => {
                log::warn!("[github] gh {} could not run: {detail}", call.label());
                return Err(GithubError::Failed(detail));
            }
        };
        if !output.success && matches!(stderr_kind(&output.stderr), StderrKind::RateLimited) {
            let host = call.host.as_deref().unwrap_or(DEFAULT_HOST);
            let until = self.open_backoff(host);
            return Err(GithubError::RateLimited { until: iso(until) });
        }
        Ok(output)
    }

    fn take_slot(&self) -> Result<Slot<'_>, GithubError> {
        let mut running = self.running.lock();
        let deadline = std::time::Instant::now() + GH_TIMEOUT;
        while *running >= MAX_CONCURRENT {
            if self
                .slot_freed
                .wait_until(&mut running, deadline)
                .timed_out()
            {
                log::warn!("[github] no gh slot freed within {GH_TIMEOUT:?}");
                return Err(GithubError::Timeout);
            }
        }
        *running += 1;
        Ok(Slot(self))
    }

    fn backoff_for(&self, host: &str) -> Option<SystemTime> {
        let mut windows = self.backoff_until.lock();
        let until = *windows.get(host)?;
        if SystemTime::now() < until {
            return Some(until);
        }
        windows.remove(host);
        log::info!("[github] rate-limit backoff for {host} ended");
        None
    }

    fn open_backoff(&self, host: &str) -> SystemTime {
        let now = SystemTime::now();
        // `gh api rate_limit` itself does not count against the limit.
        let reset = self
            .process
            .run(&GhCall::new(Some(host), ["api", "rate_limit"]), GH_TIMEOUT)
            .ok()
            .filter(|output| output.success)
            .and_then(|output| exhausted_reset(&output.stdout));
        let until = reset
            .map(|reset| reset.clamp(now, now + MAX_BACKOFF))
            .unwrap_or(now + FALLBACK_BACKOFF);
        self.backoff_until.lock().insert(host.to_string(), until);
        log::warn!(
            "[github] rate limited on {host}; pausing gh calls until {}",
            iso(until)
        );
        until
    }
}

/// The latest reset among exhausted `gh api rate_limit` resources; `None`
/// when none is exhausted (a secondary limit).
pub(super) fn exhausted_reset(stdout: &[u8]) -> Option<SystemTime> {
    let value: serde_json::Value = serde_json::from_slice(stdout).ok()?;
    value
        .get("resources")?
        .as_object()?
        .values()
        .filter(|resource| resource.get("remaining").and_then(|r| r.as_u64()) == Some(0))
        .filter_map(|resource| resource.get("reset").and_then(|r| r.as_u64()))
        .max()
        .map(|secs| SystemTime::UNIX_EPOCH + Duration::from_secs(secs))
}

pub(super) fn iso(time: SystemTime) -> String {
    chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}
