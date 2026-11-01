//! Bug-report diagnostics: bounded, deterministically redacted context
//! collection plus `gh`-mediated issue submission (spec-bug-report-dialog).
//!
//! One shared service behind the desktop `collect_bug_report_context` /
//! `submit_bug_report` commands and the `/log/…` web routes. The collect
//! path is `AppHandle`-free so the standalone `termul-server` calls the same
//! code with its own log path (or `None`). Every returned log line passes
//! through the ACP stderr-ring secret mask plus a home-dir scrub before it
//! leaves the host — renderers, agents and GitHub only ever see redacted
//! text. Report title/body contents are never logged.

use std::ffi::OsStr;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::acp::manager::stderr_ring::redact_line;
use crate::process_util::background_command_hygiene;

/// Most bytes of log tail attached to a report.
const LOG_TAIL_BYTES: usize = 64 * 1024;

/// Repo `gh issue create` files against.
const ISSUE_REPO: &str = "gnoviawan/termul";
/// Host `gh` must be authenticated against for the issue repo.
const ISSUE_HOST: &str = "github.com";
/// Most chars of `gh` stderr kept in a `Failed` reason.
const GH_STDERR_MAX: usize = 512;

/// Longest a `gh` probe (`--version`, `auth status`) may run before the
/// child is killed and the call reports [`io::ErrorKind::TimedOut`]. The
/// probes are local reads — 15 s is generous; a hung `gh` must not pin the
/// blocking thread (and the submit spinner) forever.
const GH_PROBE_TIMEOUT: Duration = Duration::from_secs(15);
/// Longest `gh issue create` may run — it does real network work, so it
/// gets the larger share. Total worst case across the three calls is
/// ~120 s, bounded per step rather than one global budget.
const GH_CREATE_TIMEOUT: Duration = Duration::from_secs(90);

/// Poll cadence for the `gh` timeout loop.
const GH_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Diagnostics bundle collected when the bug-report dialog opens. Nothing in
/// this struct is secret: `log_tail` is already redacted. camelCase wire
/// shape mirrors `src/shared/types/bug-report.types.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BugReportContext {
    /// `env!("CARGO_PKG_VERSION")` of the host build.
    pub app_version: String,
    /// `std::env::consts::OS`.
    pub os: String,
    /// `std::env::consts::ARCH`.
    pub arch: String,
    /// Build channel: `debug` or `release`.
    pub channel: String,
    /// Per-run host correlation id ([`crate::logging::run_id`]).
    pub run_id: String,
    /// RFC 3339 timestamp of the collect.
    pub collected_at: String,
    /// False when the log file was missing/unreadable — a note, not an error.
    pub log_available: bool,
    /// True when the tail was cut to [`LOG_TAIL_BYTES`] and the start dropped.
    pub log_truncated: bool,
    /// Bounded redacted log tail; empty when `log_available` is false.
    pub log_tail: String,
}

/// Report fields the user previews/edits before anything leaves the host.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BugReportSubmitRequest {
    pub title: String,
    pub body: String,
}

/// `gh` submit outcome. `Unavailable` (no `gh` on PATH, not authenticated, or
/// the process could not spawn) sends the caller down the clipboard +
/// prefilled-URL fallback; `Failed` is a real submission error worth
/// surfacing. `kind` is the serde tag.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum BugReportSubmitResult {
    Submitted { issue_url: String },
    Unavailable { reason: String },
    Failed { reason: String },
}

/// Collect the diagnostics bundle. `log_path` is the active log file (`None`
/// → `log_available=false`); never fails — a missing or unreadable log only
/// clears `log_available`.
pub fn collect_bug_report_context(log_path: Option<&Path>) -> BugReportContext {
    let tail = read_log_tail(log_path);
    log::info!(
        "[diagnostics] collected bug report context available={} truncated={}",
        tail.available,
        tail.truncated
    );
    BugReportContext {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        channel: crate::logging::build_channel().to_string(),
        run_id: crate::logging::run_id().to_string(),
        collected_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        log_available: tail.available,
        log_truncated: tail.truncated,
        log_tail: tail.text,
    }
}

/// Desktop entry: resolve the app's active log file, then collect.
pub fn collect_bug_report_context_for_app<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> BugReportContext {
    collect_bug_report_context(crate::logging::log_file_path(app).as_deref())
}

/// Submit a bug report through the host `gh` CLI (arg arrays only, never a
/// shell). Probes `gh` first; an absent, unauthenticated or unspawnable `gh`
/// yields [`BugReportSubmitResult::Unavailable`] so the caller falls back to
/// the clipboard + prefilled-URL path. Never logs the title or body.
pub fn submit_bug_report(title: &str, body: &str) -> BugReportSubmitResult {
    submit_with(title, body, gh_output)
}

/// Submit flow behind an injectable `gh` runner so tests exercise the
/// probe/parse/cleanup branches without a real `gh`.
fn submit_with(
    title: &str,
    body: &str,
    run_gh: impl Fn(&[&OsStr], Duration) -> io::Result<Output>,
) -> BugReportSubmitResult {
    log::info!("[diagnostics] bug report submit: probing gh");
    match run_gh(&[OsStr::new("--version")], GH_PROBE_TIMEOUT) {
        Ok(output) if output.status.success() => {}
        Ok(output) => {
            log::warn!("[diagnostics] gh --version exited {}", output.status);
            return BugReportSubmitResult::Unavailable {
                reason: "gh --version did not succeed".to_string(),
            };
        }
        Err(error) => {
            log::warn!("[diagnostics] gh --version failed to spawn: {error}");
            return BugReportSubmitResult::Unavailable {
                reason: "gh CLI is not available".to_string(),
            };
        }
    }
    let auth_args = [
        OsStr::new("auth"),
        OsStr::new("status"),
        OsStr::new("--hostname"),
        OsStr::new(ISSUE_HOST),
    ];
    match run_gh(&auth_args, GH_PROBE_TIMEOUT) {
        Ok(output) if output.status.success() => {}
        Ok(output) => {
            log::warn!(
                "[diagnostics] gh auth status exited {} for {ISSUE_HOST}",
                output.status
            );
            return BugReportSubmitResult::Unavailable {
                reason: format!("gh is not authenticated for {ISSUE_HOST}"),
            };
        }
        Err(error) => {
            log::warn!("[diagnostics] gh auth status failed to spawn: {error}");
            return BugReportSubmitResult::Unavailable {
                reason: "gh CLI is not available".to_string(),
            };
        }
    }

    // `gh issue create` reads the markdown body via `--body-file`; the staged
    // temp file is removed on every exit path by its drop guard.
    let body_file = match write_body_file(body) {
        Ok(file) => file,
        Err(error) => {
            log::warn!("[diagnostics] could not stage report body: {error}");
            return BugReportSubmitResult::Failed {
                reason: "could not write the report body to a temp file".to_string(),
            };
        }
    };
    let create_args = [
        OsStr::new("issue"),
        OsStr::new("create"),
        OsStr::new("-R"),
        OsStr::new(ISSUE_REPO),
        OsStr::new("--title"),
        OsStr::new(title),
        OsStr::new("--body-file"),
        body_file.0.as_os_str(),
    ];
    match run_gh(&create_args, GH_CREATE_TIMEOUT) {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            match parse_issue_url(&stdout) {
                Some(issue_url) => {
                    log::info!("[diagnostics] bug report filed: {issue_url}");
                    BugReportSubmitResult::Submitted { issue_url }
                }
                None => {
                    log::warn!("[diagnostics] gh issue create printed no issue URL");
                    BugReportSubmitResult::Failed {
                        reason: "gh created the issue but did not print its URL".to_string(),
                    }
                }
            }
        }
        Ok(output) => {
            let detail = bounded_stderr(&output.stderr);
            log::warn!(
                "[diagnostics] gh issue create exited {}: {detail}",
                output.status
            );
            BugReportSubmitResult::Failed { reason: detail }
        }
        Err(error) => {
            log::warn!("[diagnostics] gh issue create failed to spawn: {error}");
            BugReportSubmitResult::Unavailable {
                reason: "gh CLI could not be spawned".to_string(),
            }
        }
    }
}

/// Run `gh` with an arg array (no shell); process output, spawn error, or
/// [`io::ErrorKind::TimedOut`] when the child outlives `timeout`.
fn gh_output(args: &[&OsStr], timeout: Duration) -> io::Result<Output> {
    run_with_timeout("gh", args, timeout)
}

/// Spawn `program` and collect its output within `timeout`. Stdout and
/// stderr drain on reader threads so a child filling a pipe buffer cannot
/// deadlock while the poll loop waits on `try_wait`. On expiry the child
/// is killed AND reaped (`kill` + `wait` — no zombie or limbo process) and
/// the call reports [`io::ErrorKind::TimedOut`], which the submit flow maps
/// to `Unavailable` like any other `Err`.
fn run_with_timeout(program: &str, args: &[&OsStr], timeout: Duration) -> io::Result<Output> {
    let mut command = Command::new(program);
    background_command_hygiene(&mut command);
    let mut child = command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let stdout_reader = drain_pipe(child.stdout.take());
    let stderr_reader = drain_pipe(child.stderr.take());
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(GH_POLL_INTERVAL);
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("{program} did not exit within {timeout:?}"),
                ));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        }
    };
    // Both pipes reach EOF once the child has exited, so the readers always
    // finish here.
    let stdout = stdout_reader.join().unwrap_or(Ok(Vec::new()))?;
    let stderr = stderr_reader.join().unwrap_or(Ok(Vec::new()))?;
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

/// Drain a child pipe to EOF on a reader thread — required while the parent
/// polls `try_wait`, or a child producing more than a pipe buffer of output
/// would block mid-run and look hung.
fn drain_pipe<R: Read + Send + 'static>(pipe: Option<R>) -> JoinHandle<io::Result<Vec<u8>>> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut pipe) = pipe {
            pipe.read_to_end(&mut buf)?;
        }
        Ok(buf)
    })
}

/// Write `body` to a fresh temp file; the name embeds pid + uuid so
/// concurrent submits never collide. Created owner-only on unix — the body
/// carries user text plus a redacted log tail and the shared temp dir's
/// default 0644 would leave it readable by other local users while `gh`
/// reads it.
fn write_body_file(body: &str) -> io::Result<BodyFile> {
    let path = std::env::temp_dir().join(format!(
        "termul-bug-report-{}-{}.md",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    write_private(&path, body.as_bytes())?;
    Ok(BodyFile(path))
}

/// `create_new` + mode `0o600`: the pid+uuid name never exists in practice
/// (a collision errors rather than truncating someone else's file) and only
/// the owner can read the staged body.
#[cfg(unix)]
fn write_private(path: &Path, contents: &[u8]) -> io::Result<()> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?
        .write_all(contents)
}

/// Non-unix targets keep the plain create/write — their temp dirs are
/// already per-user ACL'd.
#[cfg(not(unix))]
fn write_private(path: &Path, contents: &[u8]) -> io::Result<()> {
    std::fs::write(path, contents)
}

/// Staged `--body-file`: removed from disk on drop, whatever path was taken.
struct BodyFile(PathBuf);

impl Drop for BodyFile {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_file(&self.0) {
            log::debug!("[diagnostics] removing staged report body failed: {error}");
        }
    }
}

/// The `gh issue create` URL on stdout, anchored to the issue shape so a
/// warning or banner URL `gh` prints first cannot be captured instead.
fn parse_issue_url(stdout: &str) -> Option<String> {
    let prefix = format!("https://github.com/{ISSUE_REPO}/issues/");
    stdout
        .split_whitespace()
        .find(|token| {
            token
                .strip_prefix(prefix.as_str())
                .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()))
        })
        .map(str::to_string)
}

/// First ~[`GH_STDERR_MAX`] chars of process stderr, secret-masked and
/// flattened for a single log/result line.
fn bounded_stderr(stderr: &[u8]) -> String {
    let text = redact_line(&String::from_utf8_lossy(stderr));
    let flat = text.replace(['\n', '\r'], " ");
    truncate_to(flat.trim(), GH_STDERR_MAX).to_string()
}

/// Cut `text` to at most `max` bytes on a char boundary.
fn truncate_to(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// The bounded redacted tail of `log_path` (or `None` → unavailable).
struct LogTail {
    available: bool,
    truncated: bool,
    text: String,
}

fn read_log_tail(log_path: Option<&Path>) -> LogTail {
    let Some(path) = log_path else {
        return LogTail {
            available: false,
            truncated: false,
            text: String::new(),
        };
    };
    let (truncated, window) = match read_tail_window(path, LOG_TAIL_BYTES) {
        Ok(pair) => pair,
        Err(error) => {
            log::warn!(
                "[diagnostics] log file unreadable {}: {error}",
                path.display()
            );
            return LogTail {
                available: false,
                truncated: false,
                text: String::new(),
            };
        }
    };
    let slice = tail_slice(&window, truncated);
    LogTail {
        available: true,
        truncated,
        text: redact_log_tail(&String::from_utf8_lossy(slice), home_string().as_deref()),
    }
}

/// Read at most the last `max` bytes of `path`: stat the file, seek to the
/// window start and read only that span, so an unbounded log
/// (`termul-server.log` is a raw stdout redirect) never loads fully into
/// memory. Returns `(truncated, window)`; `truncated` is true iff the file
/// is longer than `max` — the `log_truncated` semantics the whole-file read
/// had.
fn read_tail_window(path: &Path, max: usize) -> io::Result<(bool, Vec<u8>)> {
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    let window_len = len.min(max as u64);
    file.seek(SeekFrom::End(-(window_len as i64)))?;
    let mut window = vec![0u8; window_len as usize];
    file.read_exact(&mut window)?;
    Ok((len > max as u64, window))
}

/// Align a truncated tail `window` to a line boundary by dropping the
/// partial first line, so the tail opens with a whole line. Falls back to
/// the unaligned window when it holds no newline (one giant line) — and
/// when the window's ONLY newline is its last byte, where aligning would
/// return an empty slice despite up to [`LOG_TAIL_BYTES`] of content.
/// `truncated: false` means `window` is the whole file and is returned
/// untouched.
fn tail_slice(window: &[u8], truncated: bool) -> &[u8] {
    if !truncated {
        return window;
    }
    let aligned = window
        .iter()
        .position(|b| *b == b'\n')
        .map_or(window, |pos| &window[pos + 1..]);
    if aligned.is_empty() {
        window
    } else {
        aligned
    }
}

/// Mask every line of `text`: secret patterns first, then the home-dir scrub.
fn redact_log_tail(text: &str, home: Option<&str>) -> String {
    text.lines()
        .map(|line| scrub_home(&redact_line(line), home))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The user's home dir for the scrub; `None` when it cannot be resolved to a
/// non-empty UTF-8 path.
fn home_string() -> Option<String> {
    let home = std::env::home_dir()?;
    let home = home.to_str()?.trim_end_matches(['/', '\\']);
    if home.len() < 3 {
        None
    } else {
        Some(home.to_string())
    }
}

/// Replace the user's home absolute path (both separator spellings) and the
/// `$HOME` / `${HOME}` / `%USERPROFILE%` references with `~`. A replacement
/// only applies on a path boundary so `/home/alice` does not mangle
/// `/home/alice2`.
fn scrub_home(line: &str, home: Option<&str>) -> String {
    let mut out = line.to_string();
    if let Some(home) = home.filter(|h| !h.is_empty()) {
        out = replace_path_with_tilde(&out, home);
        let forward = home.replace('\\', "/");
        if forward != home {
            out = replace_path_with_tilde(&out, &forward);
        }
        // Case-insensitive filesystems (Windows, standard macOS volumes)
        // resolve `C:\Users\X` and `c:\users\x` alike, so the byte-exact
        // pass misses differently-cased spellings and the profile path —
        // username included — would leak into the filed report. The
        // env-var aliases stay case-sensitive: shells are.
        #[cfg(any(target_os = "macos", windows))]
        {
            out = replace_path_with_tilde_ci(&out, home);
            if forward != home {
                out = replace_path_with_tilde_ci(&out, &forward);
            }
        }
    }
    for alias in ["${HOME}", "$HOME", "%USERPROFILE%"] {
        out = replace_path_with_tilde(&out, alias);
    }
    out
}

/// True for chars that continue a path component: a match bounded by one
/// on EITHER side is part of a longer path or name (`/var/home/tester`,
/// `/home/tester2`) and must not collapse to `~`.
fn path_component_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')
}

/// Replace `needle` with `~` where `needle` is bounded on BOTH sides by a
/// non-path-component char (string edge, separator, quote, space…), so a
/// match that continues a longer component either way is left alone.
fn replace_path_with_tilde(text: &str, needle: &str) -> String {
    if needle.is_empty() {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for (idx, matched) in text.match_indices(needle) {
        let before_ok = text[..idx]
            .chars()
            .next_back()
            .is_none_or(|c| !path_component_char(c));
        let after_ok = text[idx + matched.len()..]
            .chars()
            .next()
            .is_none_or(|c| !path_component_char(c));
        if before_ok && after_ok {
            out.push_str(&text[last..idx]);
            out.push('~');
            last = idx + matched.len();
        }
    }
    out.push_str(&text[last..]);
    out
}

/// Case-insensitive sibling of [`replace_path_with_tilde`], for
/// case-insensitive filesystems: the match is located by char-wise
/// lowercase comparison and the matched slice — whatever casing `text`
/// carries — becomes `~`, under the same two-sided boundary rule. Home
/// paths only; the `$HOME` / `${HOME}` / `%USERPROFILE%` aliases stay
/// case-sensitive because shells are.
#[cfg(any(target_os = "macos", windows))]
fn replace_path_with_tilde_ci(text: &str, needle: &str) -> String {
    if needle.is_empty() {
        return text.to_string();
    }
    let needle: Vec<char> = needle.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    let mut from = 0;
    while let Some((idx, len)) = find_ci(text, &needle, from) {
        let before_ok = text[..idx]
            .chars()
            .next_back()
            .is_none_or(|c| !path_component_char(c));
        let after_ok = text[idx + len..]
            .chars()
            .next()
            .is_none_or(|c| !path_component_char(c));
        if before_ok && after_ok {
            out.push_str(&text[last..idx]);
            out.push('~');
            last = idx + len;
        }
        // Resume past this match either way so progress is guaranteed.
        from = idx + len;
    }
    out.push_str(&text[last..]);
    out
}

/// First char-wise-lowercase match of `needle` in `text` at or after byte
/// index `from` (a char boundary), as `(match_start, match_byte_len)`. The
/// matched byte length can differ from the needle's when a char's
/// lowercase changes width, so it is measured, not assumed.
#[cfg(any(target_os = "macos", windows))]
fn find_ci(text: &str, needle: &[char], from: usize) -> Option<(usize, usize)> {
    text[from..]
        .char_indices()
        .map(|(off, _)| from + off)
        .find_map(|idx| ci_match_len(text, idx, needle).map(|len| (idx, len)))
}

/// Byte length of a `needle` match starting exactly at `idx`, or `None`
/// when `text[idx..]` does not start with `needle` under char-wise
/// lowercase comparison.
#[cfg(any(target_os = "macos", windows))]
fn ci_match_len(text: &str, idx: usize, needle: &[char]) -> Option<usize> {
    let mut rest = text[idx..].chars();
    for &n in needle {
        if !rest.next()?.to_lowercase().eq(n.to_lowercase()) {
            return None;
        }
    }
    Some(text[idx..].len() - rest.as_str().len())
}

#[cfg(test)]
mod tests;
