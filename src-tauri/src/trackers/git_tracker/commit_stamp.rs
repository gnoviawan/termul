//! The command stamp of a commit: the `Termul-Command-Id: <id>` trailer that
//! lets a resend find the commit it made, and the `expectedHead` precondition
//! that refuses a commit when `HEAD` moved since the caller looked. Also the
//! by-existence lookup of a created branch.
//!
//! Limits of the stamp: a resend is found within the commits between
//! `expectedHead` and `HEAD`, or the [`SEARCH_DEPTH`] most recent commits when
//! the request names no `expectedHead`; an older commit is not found. An amend
//! replaces the message, so the commit keeps only the trailer of the amend that
//! last rewrote it (an earlier command's trailer is dropped).

use std::fmt;

use super::*;

/// Trailer key of the commit entity stamp.
const TRAILER_KEY: &str = "Termul-Command-Id";
/// Most recent commits a stamp search looks through (see the module doc).
const SEARCH_DEPTH: &str = "200";

/// Whether `head` is a well-formed `expectedHead`: empty (an unborn branch) or
/// a full 40- or 64-digit hex object name. Anything else (a ref name, an
/// option-shaped string) is refused before it reaches a git argument.
#[must_use]
pub fn is_valid_expected_head(head: &str) -> bool {
    let head = head.trim();
    head.is_empty()
        || ((head.len() == 40 || head.len() == 64) && head.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// What a commit call knows about the command it carries.
#[derive(Debug, Default, Clone, Copy)]
pub struct CommitStamp<'a> {
    /// Stamped on the commit as a trailer.
    pub command_id: Option<&'a str>,
    /// The full sha `HEAD` must be at (empty: no commit yet).
    pub expected_head: Option<&'a str>,
}

/// Why a commit did not happen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommitFailure {
    /// `HEAD` is not `expected_head`; nothing was committed.
    PreconditionFailed { expected: String, actual: String },
    /// `expected_head` is not empty or a full hex object name.
    InvalidExpectedHead,
    /// git refused or could not run.
    Failed(String),
}

impl fmt::Display for CommitFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::PreconditionFailed { expected, actual } => write!(
                f,
                "HEAD is at {} but the commit expected {}; nothing was committed",
                describe_head(actual),
                describe_head(expected),
            ),
            Self::InvalidExpectedHead => f.write_str(
                "expectedHead must be empty (no commit yet) or a full 40/64-digit hex commit id",
            ),
            Self::Failed(message) => f.write_str(message),
        }
    }
}

fn describe_head(sha: &str) -> &str {
    if sha.is_empty() {
        "no commit yet"
    } else {
        sha
    }
}

/// `message` followed by the `Termul-Command-Id` trailer.
pub(super) fn with_command_trailer(message: &str, command_id: &str) -> String {
    format!("{message}\n\n{TRAILER_KEY}: {command_id}")
}

/// The full sha of `HEAD`, empty on an unborn branch (or when git fails).
#[must_use]
pub fn head_sha(cwd: &str) -> String {
    GitTracker::run_git_command(cwd, &["rev-parse", "--verify", "--quiet", "HEAD"])
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .unwrap_or_default()
}

/// The sha of the commit stamped with `command_id`, searched between
/// `expected_head` (exclusive) and `HEAD`; without a bound, in the most recent
/// commits. An amended commit keeps its trailer, so a resend of an amend finds
/// the commit too.
#[must_use]
pub fn find_stamped_commit(
    cwd: &str,
    command_id: &str,
    expected_head: Option<&str>,
) -> Option<String> {
    if expected_head.is_some_and(|head| !is_valid_expected_head(head)) {
        return None;
    }
    let range = expected_head
        .map(str::trim)
        .filter(|head| !head.is_empty())
        .map(|head| format!("{head}..HEAD"));
    let mut args = vec![
        "log",
        "-n",
        SEARCH_DEPTH,
        "--format=%H%x1f%B%x1e",
    ];
    args.push(range.as_deref().unwrap_or("HEAD"));
    // Revisions end here: nothing after is ever read as a path or an option.
    args.push("--");
    let output = GitTracker::run_git_command(cwd, &args).filter(|o| o.status.success())?;
    let wanted = format!("{TRAILER_KEY}: {command_id}");
    String::from_utf8_lossy(&output.stdout)
        .split('\u{1e}')
        .find_map(|record| {
            let (sha, body) = record.split_once('\u{1f}')?;
            body.lines()
                .any(|line| line.trim_end() == wanted)
                .then(|| sha.trim().to_string())
        })
}

/// Whether the local branch `branch` exists (the entity of a create-branch).
#[must_use]
pub fn local_branch_exists(cwd: &str, branch: &str) -> bool {
    if branch.trim().is_empty() || branch.starts_with('-') {
        return false;
    }
    let reference = format!("refs/heads/{branch}");
    GitTracker::run_git_command(cwd, &["rev-parse", "--verify", "--quiet", &reference])
        .is_some_and(|output| output.status.success())
}
