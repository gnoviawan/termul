//! A PR's checks and a failing job's log tail (CAP-4).

use std::sync::OnceLock;

use regex::Regex;
use serde::Deserialize;

use super::types::{GithubCheck, GithubCheckRollup, GithubCheckStatus};

pub(super) const CHECK_FIELDS: &str = "name,state,bucket,link,workflow";
pub(super) const LOG_TAIL_LINES: usize = 200;
/// Around the last error line: the failing step's output before it, and the
/// next lines (later errors, annotations) after it.
pub(super) const LINES_BEFORE_ERROR: usize = 150;
pub(super) const LINES_AFTER_ERROR: usize = 30;
const ERROR_MARK: &str = "##[error]";
pub(super) const LOG_TAIL_BYTES: usize = 16 * 1024;
/// How much of the end of a job log is read before trimming to the tail.
/// Generous so the last error line is usually inside it, and ANSI codes and
/// `\r` noise stripped later still leave 200 lines.
pub(super) const LOG_READ_BYTES: usize = 256 * 1024;

#[derive(Deserialize)]
struct CheckRow {
    name: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    bucket: String,
    #[serde(default)]
    link: String,
    #[serde(default)]
    workflow: String,
}

/// `gh pr checks` exits non-zero with this when the head has no checks.
pub(super) fn is_no_checks(stderr: &str) -> bool {
    stderr.contains("no checks reported")
}

fn status_of(bucket: &str, state: &str) -> GithubCheckStatus {
    match bucket {
        "pass" => GithubCheckStatus::Success,
        "fail" => GithubCheckStatus::Failure,
        "cancel" => GithubCheckStatus::Cancelled,
        "skipping" if state == "NEUTRAL" => GithubCheckStatus::Neutral,
        "skipping" => GithubCheckStatus::Skipped,
        _ => GithubCheckStatus::Pending,
    }
}

/// The Actions job id in a check link (`…/actions/runs/<run>/job/<job>`).
pub(super) fn job_id_of(link: &str) -> Option<u64> {
    static JOB: OnceLock<Regex> = OnceLock::new();
    let job = JOB.get_or_init(|| Regex::new(r"/actions/runs/\d+/job/(\d+)").expect("job regex"));
    job.captures(link)?.get(1)?.as_str().parse().ok()
}

pub(super) fn parse_checks(stdout: &[u8]) -> Option<Vec<GithubCheck>> {
    let rows: Vec<CheckRow> = serde_json::from_slice(stdout).ok()?;
    Some(
        rows.into_iter()
            .map(|row| GithubCheck {
                status: status_of(&row.bucket, &row.state),
                job_id: job_id_of(&row.link),
                workflow: (!row.workflow.is_empty()).then_some(row.workflow),
                details_url: (!row.link.is_empty()).then_some(row.link),
                name: row.name,
            })
            .collect(),
    )
}

pub(super) fn rollup(checks: &[GithubCheck]) -> Option<GithubCheckRollup> {
    if checks.is_empty() {
        return None;
    }
    let any = |status: GithubCheckStatus| checks.iter().any(|check| check.status == status);
    Some(if any(GithubCheckStatus::Failure) {
        GithubCheckRollup::Failure
    } else if any(GithubCheckStatus::Pending) {
        GithubCheckRollup::Pending
    } else {
        GithubCheckRollup::Success
    })
}

/// The part of a job log worth reading, with terminal escape sequences and
/// stray control characters removed: up to [`LINES_BEFORE_ERROR`] lines
/// before the last `##[error]` line and [`LINES_AFTER_ERROR`] after it, or
/// the last [`LOG_TAIL_LINES`] lines when no step reported an error. At most
/// [`LOG_TAIL_BYTES`]; the error line itself is kept first when trimming.
/// `cut_before` is whether the read already dropped the log's beginning.
pub(super) fn log_tail(raw: &[u8], cut_before: bool) -> (String, bool) {
    static ANSI: OnceLock<Regex> = OnceLock::new();
    let ansi = ANSI.get_or_init(|| {
        Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]")
            .expect("ansi regex")
    });
    let text = String::from_utf8_lossy(raw);
    let text = ansi.replace_all(&text, "");
    let clean: String = text
        .chars()
        .filter(|c| *c == '\n' || *c == '\t' || !c.is_control())
        .collect();
    let mut lines: Vec<&str> = clean.lines().collect();
    if cut_before && !lines.is_empty() {
        // The first line is a fragment of a longer one.
        lines.remove(0);
    }
    if lines.is_empty() {
        return (String::new(), cut_before);
    }
    let (mut start, mut end, anchor) = match lines.iter().rposition(|l| l.contains(ERROR_MARK)) {
        Some(error) => (
            error.saturating_sub(LINES_BEFORE_ERROR),
            (error + 1 + LINES_AFTER_ERROR).min(lines.len()),
            error,
        ),
        None => (
            lines.len().saturating_sub(LOG_TAIL_LINES),
            lines.len(),
            lines.len() - 1,
        ),
    };
    let size = |start: usize, end: usize| -> usize {
        lines[start..end].iter().map(|l| l.len() + 1).sum::<usize>() - 1
    };
    let mut bytes = size(start, end);
    while bytes > LOG_TAIL_BYTES && start < anchor {
        bytes -= lines[start].len() + 1;
        start += 1;
    }
    while bytes > LOG_TAIL_BYTES && end > anchor + 1 {
        end -= 1;
        bytes -= lines[end].len() + 1;
    }
    let truncated = cut_before || start > 0 || end < lines.len();
    let mut tail = lines[start..end].join("\n");
    if tail.len() > LOG_TAIL_BYTES {
        // One line longer than the cap: keep its end.
        let mut cut = tail.len() - LOG_TAIL_BYTES;
        while !tail.is_char_boundary(cut) {
            cut += 1;
        }
        tail = tail[cut..].to_string();
        return (tail, true);
    }
    (tail, truncated)
}
