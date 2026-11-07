//! Bounded tail of an agent process's stderr.
//!
//! Agents print the reason they cannot start (a missing runtime, a bad login,
//! a stack trace) on stderr. The driver feeds every line into a [`StderrRing`]
//! so a spawn failure or a crash can report the last few lines instead of a
//! bare "process did not initialize". The ring is bounded in lines and bytes,
//! masks secret-looking text before it is stored, and stores nothing at all
//! for a profile that redacts agent output.

use std::collections::VecDeque;
use std::fmt::Display;
use std::sync::LazyLock;

use parking_lot::Mutex;
use regex::{Captures, Regex};

use crate::acp::config::AgentConfig;

/// Most lines the ring keeps.
const MAX_LINES: usize = 20;
/// Most bytes the ring keeps across all lines.
const MAX_BYTES: usize = 8 * 1024;
/// Most bytes kept from one line; the rest is cut.
const MAX_LINE_BYTES: usize = 512;
/// Most bytes of the tail that an error detail embeds.
pub(super) const DETAIL_TAIL_BYTES: usize = 2 * 1024;

const MASK: &str = "[redacted]";

/// `Bearer <token>` / `Basic <token>` authorization values.
static BEARER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}").expect("valid bearer pattern")
});

/// `name=value`, `name: value` and `"name": "value"` pairs whose name says the
/// value is a secret. Groups: the prefix to keep, the name, the value.
static NAMED_SECRET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)(["']?([A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|passw(?:or)?d|authorization|credential)[A-Za-z0-9_.-]*)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)"#,
    )
    .expect("valid named secret pattern")
});

/// The password in a URL's `user:password@` credentials.
static URL_PASSWORD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b([a-z][a-z0-9+.-]*://[^\s:/@]+:)[^\s/@]+@")
        .expect("valid URL credentials pattern")
});

/// `Cookie:` / `Set-Cookie:` header values, masked to the end of the line
/// because one header carries several `name=value` pairs.
static COOKIE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\b((?:set-)?cookie["']?\s*[:=]\s*)[^\r\n]+"#).expect("valid cookie pattern")
});

/// Well-known credential shapes that appear without a name in front of them.
static TOKEN_SHAPE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16}|[rs]k_(?:live|test)_[A-Za-z0-9]{16,}|ya29\.[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})",
    )
    .expect("valid token shape pattern")
});

/// Mask everything in `line` that looks like a key, token, cookie or bearer
/// value. `pub(crate)` so the diagnostics collector applies the same mask to
/// log tails before they leave the host.
pub(crate) fn redact_line(line: &str) -> String {
    let masked = BEARER.replace_all(line, format!("$1 {MASK}"));
    let masked = COOKIE.replace_all(&masked, format!("${{1}}{MASK}"));
    let masked = URL_PASSWORD.replace_all(&masked, format!("${{1}}{MASK}@"));
    let masked = NAMED_SECRET.replace_all(&masked, |caps: &Captures| {
        if is_token_count(&caps[2], &caps[3]) {
            caps[0].to_string()
        } else {
            format!("{}{MASK}", &caps[1])
        }
    });
    TOKEN_SHAPE.replace_all(&masked, MASK).into_owned()
}

/// `max_tokens=4096` names a count of tokens, not a token.
fn is_token_count(name: &str, value: &str) -> bool {
    name.to_ascii_lowercase().contains("tokens")
        && value
            .trim_matches(|ch: char| !ch.is_ascii_alphanumeric())
            .bytes()
            .all(|byte| byte.is_ascii_digit())
}

/// Cut `text` to at most `max` bytes on a character boundary.
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

#[derive(Default)]
struct Lines {
    lines: VecDeque<String>,
    bytes: usize,
}

/// The last lines an agent wrote to stderr, safe to log.
pub(super) struct StderrRing {
    capture: bool,
    lines: Mutex<Lines>,
}

impl StderrRing {
    /// A ring that stores lines when `capture` is true. A profile that redacts
    /// agent output passes false: nothing is ever stored.
    pub(super) fn new(capture: bool) -> Self {
        Self {
            capture,
            lines: Mutex::new(Lines::default()),
        }
    }

    /// Record one stderr line, masked and cut to size. Evicts the oldest
    /// lines until the ring is back inside both bounds.
    pub(super) fn push(&self, line: &str) {
        if !self.capture {
            return;
        }
        let line = line.trim_end();
        if line.is_empty() {
            return;
        }
        // Mask the whole line first: cutting a credential short could leave a
        // prefix too short for the patterns to recognize.
        let masked = redact_line(line);
        let masked = truncate_to(&masked, MAX_LINE_BYTES);
        let mut state = self.lines.lock();
        state.bytes += masked.len();
        state.lines.push_back(masked.to_string());
        while state.lines.len() > MAX_LINES || state.bytes > MAX_BYTES {
            match state.lines.pop_front() {
                Some(evicted) => state.bytes -= evicted.len(),
                None => break,
            }
        }
    }

    /// The stored lines, oldest first, joined by newlines. Empty when nothing
    /// was captured.
    pub(super) fn tail(&self) -> String {
        let state = self.lines.lock();
        state
            .lines
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The newest whole lines that fit in `max_bytes` (a single line longer
    /// than that is cut from its start), joined by newlines. Empty when
    /// nothing was captured.
    pub(super) fn tail_within(&self, max_bytes: usize) -> String {
        let state = self.lines.lock();
        let mut kept: Vec<&str> = Vec::new();
        let mut used = 0usize;
        for line in state.lines.iter().rev() {
            let cost = line.len() + usize::from(!kept.is_empty());
            if used + cost > max_bytes {
                if kept.is_empty() {
                    let mut start = line.len() - max_bytes.min(line.len());
                    while !line.is_char_boundary(start) {
                        start += 1;
                    }
                    kept.push(&line[start..]);
                }
                break;
            }
            used += cost;
            kept.push(line);
        }
        kept.reverse();
        kept.join("\n")
    }
}

/// The agent's stable kind for logs: its config id, else its name.
pub(super) fn agent_kind(config: &AgentConfig) -> &str {
    config.config_id.as_deref().unwrap_or(&config.name)
}

/// The command's file name, never its directory, arguments or environment.
pub(super) fn command_basename(command: &str) -> &str {
    let trimmed = command.trim();
    trimmed
        .rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or(trimmed)
}

/// Log a failed agent launch or a crash: the agent kind, the command basename
/// and the stderr tail. Arguments and environment never reach the log.
pub(super) fn log_agent_failure(
    event: &str,
    kind: impl Display,
    command: &str,
    detail: &str,
    ring: &StderrRing,
) {
    let tail = ring.tail();
    let basename = command_basename(command);
    // The SDK folds the process's stderr into the connection error, so the
    // detail needs the same masking as the tail.
    let detail = redact_line(detail);
    if tail.is_empty() {
        log::warn!("[acp] {event}: kind={kind} command={basename} detail={detail}");
    } else {
        log::warn!(
            "[acp] {event}: kind={kind} command={basename} detail={detail}\nagent stderr tail:\n{tail}"
        );
    }
}

/// Append the stderr tail to a failure message, masking secret-looking text in
/// both (the SDK folds the process's stderr into the connection error). The
/// message keeps its text when no stderr was captured.
pub(super) fn with_stderr_tail(message: String, ring: &StderrRing) -> String {
    let message = redact_line(&message);
    let tail = ring.tail_within(DETAIL_TAIL_BYTES);
    if tail.is_empty() {
        message
    } else {
        format!("{message}\nagent stderr:\n{tail}")
    }
}

#[cfg(test)]
mod tests;
