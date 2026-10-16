//! Working-tree diff stat (`+added -removed`) for CAP-1 project rows.
//!
//! One shared function — [`git_get_diff_stat`] — is the single source of truth
//! behind both the Tauri command and the `POST /git/diff-stat` web route.
//!
//! The stat matches git: tracked lines are the totals of
//! `git diff --numstat HEAD` (staged + unstaged; against the empty tree when
//! the repository has no HEAD yet), and untracked lines are counted from every
//! untracked, non-ignored regular file. Binary files contribute 0. The
//! untracked scan is bounded ([`MAX_UNTRACKED_FILES`] files,
//! [`MAX_UNTRACKED_FILE_BYTES`] per file) and never follows symlinks.
//!
//! File contents are never logged.

use super::git_exec::{
    git_stdout, run_git_capture, GitRunError, StdoutCap, EMPTY_TREE, GIT_READ_TIMEOUT_MS,
};
use super::*;

use std::io::Read;
use std::path::Path;

/// Maximum untracked files scanned per call; the rest contribute 0.
pub(super) const MAX_UNTRACKED_FILES: usize = 5000;
/// Maximum size of a single untracked file we will read; larger files contribute 0.
pub(super) const MAX_UNTRACKED_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// Added / removed line totals for a working tree.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffStat {
    pub added: u64,
    pub removed: u64,
}

/// Why a diff stat could not be computed: git could not be started or timed
/// out, or it exited non-zero (for example, the cwd is not a repository).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffStatError(pub GitRunError);

impl From<GitRunError> for DiffStatError {
    fn from(e: GitRunError) -> Self {
        DiffStatError(e)
    }
}

impl DiffStatError {
    /// Stable machine code shared by the Tauri `IpcResult` and the web `IpcBody`.
    pub fn code(&self) -> &'static str {
        "GIT_DIFF_STAT_ERROR"
    }
}

impl std::fmt::Display for DiffStatError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(&self.0, f)
    }
}

impl std::error::Error for DiffStatError {}

/// Compute the `+added -removed` stat for the repository containing `cwd`.
pub fn git_get_diff_stat(cwd: &str) -> Result<GitDiffStat, DiffStatError> {
    match compute_diff_stat(cwd) {
        Ok(stat) => {
            log::debug!(
                "[GitTracker] diff stat for {cwd}: +{} -{}",
                stat.added,
                stat.removed
            );
            Ok(stat)
        }
        Err(e) => {
            log::warn!("[GitTracker] diff stat failed for {cwd}: {e}");
            Err(e)
        }
    }
}

fn compute_diff_stat(cwd: &str) -> Result<GitDiffStat, DiffStatError> {
    // Also the "is this a repository" check: fails for a non-repo cwd.
    let toplevel = git_stdout(
        cwd,
        "rev-parse",
        StdoutCap::Unbounded,
        &["rev-parse", "--show-toplevel"],
    )?;
    let toplevel = String::from_utf8_lossy(&toplevel).trim().to_string();

    let base = if probe_head(cwd)? { "HEAD" } else { EMPTY_TREE };
    let numstat = git_stdout(
        cwd,
        "diff",
        StdoutCap::Unbounded,
        &["diff", "--numstat", base],
    )?;
    let (added, removed) = parse_numstat(&String::from_utf8_lossy(&numstat));

    // `--full-name` + the `:/` pathspec make the listing repo-wide, matching
    // the repo-wide scope of `git diff --numstat`.
    let untracked = git_stdout(
        cwd,
        "ls-files",
        StdoutCap::NulPaths(MAX_UNTRACKED_FILES),
        &[
            "ls-files",
            "--others",
            "--exclude-standard",
            "--full-name",
            "-z",
            "--",
            ":/",
        ],
    )?;
    let untracked_added = count_untracked_lines(Path::new(&toplevel), &untracked);

    Ok(GitDiffStat {
        added: added.saturating_add(untracked_added),
        removed,
    })
}

/// Does the repository have a HEAD commit? Status-preserving: only git's
/// documented "not a valid ref" result (exit 1 under `--verify --quiet`) means
/// no HEAD (an unborn branch) and selects the empty-tree base. A spawn failure
/// or timeout is [`GitRunError::GitUnavailable`] and any other non-zero exit
/// is [`GitRunError::GitFailed`], so a failed probe never turns existing
/// content into additions.
pub(super) fn probe_head(cwd: &str) -> Result<bool, GitRunError> {
    let output = run_git_capture(
        cwd,
        StdoutCap::Unbounded,
        &["rev-parse", "--verify", "--quiet", "HEAD"],
        GIT_READ_TIMEOUT_MS,
    )?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(GitRunError::GitFailed {
            command: "rev-parse HEAD",
            detail: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        }),
    }
}

/// Sum a `git diff --numstat` listing. Binary rows (`-\t-\t<path>`) and any
/// row that does not parse contribute 0.
pub(super) fn parse_numstat(output: &str) -> (u64, u64) {
    let mut added = 0u64;
    let mut removed = 0u64;
    for line in output.lines() {
        let mut parts = line.splitn(3, '\t');
        let (Some(a), Some(r), Some(_path)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        if let (Ok(a), Ok(r)) = (a.parse::<u64>(), r.parse::<u64>()) {
            added = added.saturating_add(a);
            removed = removed.saturating_add(r);
        }
    }
    (added, removed)
}

/// Lines in `bytes`: the number of `\n`, plus one when the content is
/// non-empty and does not end with a newline.
pub(super) fn count_lines(bytes: &[u8]) -> u64 {
    let newlines = bytes.iter().filter(|b| **b == b'\n').count() as u64;
    match bytes.last() {
        Some(last) if *last != b'\n' => newlines + 1,
        _ => newlines,
    }
}

/// Count lines across the NUL-separated untracked listing (paths relative to
/// `toplevel`). Bounded by [`MAX_UNTRACKED_FILES`] / [`MAX_UNTRACKED_FILE_BYTES`];
/// symlinks, directories, unreadable, oversized and binary files add 0.
pub(super) fn count_untracked_lines(toplevel: &Path, listing: &[u8]) -> u64 {
    let mut total = 0u64;
    let mut skipped_oversize = 0usize;

    for (scanned, raw) in listing
        .split(|b| *b == 0)
        .filter(|p| !p.is_empty())
        .enumerate()
    {
        if scanned >= MAX_UNTRACKED_FILES {
            log::debug!(
                "[GitTracker] diff stat: untracked scan capped at {MAX_UNTRACKED_FILES} files"
            );
            break;
        }

        let rel = String::from_utf8_lossy(raw);
        let path = toplevel.join(rel.as_ref());
        // `symlink_metadata` never follows links; only plain files count.
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.file_type().is_file() {
            continue;
        }
        if meta.len() > MAX_UNTRACKED_FILE_BYTES {
            skipped_oversize += 1;
            continue;
        }
        let Ok(file) = std::fs::File::open(&path) else {
            continue;
        };
        // `take` bounds the read even if the file grows after the metadata check.
        let mut bytes = Vec::new();
        if file
            .take(MAX_UNTRACKED_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .is_err()
            || bytes.len() as u64 > MAX_UNTRACKED_FILE_BYTES
        {
            skipped_oversize += 1;
            continue;
        }
        if bytes.contains(&0) {
            continue;
        }
        total = total.saturating_add(count_lines(&bytes));
    }

    if skipped_oversize > 0 {
        log::debug!(
            "[GitTracker] diff stat: skipped {skipped_oversize} untracked file(s) over {MAX_UNTRACKED_FILE_BYTES} bytes"
        );
    }
    total
}
