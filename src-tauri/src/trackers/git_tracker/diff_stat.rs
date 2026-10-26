//! Working-tree diff stat (`+added -removed`) for CAP-1 project rows.
//!
//! One shared function — [`git_get_diff_stat`] — is the single source of truth
//! behind both the Tauri command and the `POST /git/diff-stat` web route.
//!
//! The stat matches git: tracked lines are the totals of
//! `git diff --numstat HEAD` (staged + unstaged; against the empty tree when
//! the repository has no HEAD yet), and untracked lines are counted from every
//! untracked, non-ignored regular file. Binary files contribute 0. `files`
//! lists the same counts per repository-root-relative path, so a caller can
//! show line counts per changed file. The
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

/// Added / removed lines of one changed file. `path` is relative to the
/// repository root, like `git status --porcelain` paths.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiffStat {
    pub path: String,
    pub added: u64,
    pub removed: u64,
}

/// Added / removed line totals for a working tree, plus the per-file rows
/// they sum (tracked files sorted by path, then untracked files).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffStat {
    pub added: u64,
    pub removed: u64,
    #[serde(default)]
    pub files: Vec<GitFileDiffStat>,
    /// Repository root as a host path: the base that `files[].path` and
    /// `git status --porcelain` paths are relative to.
    #[serde(default)]
    pub root: String,
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
                "[GitTracker] diff stat for {cwd}: +{} -{} in {} file(s)",
                stat.added,
                stat.removed,
                stat.files.len()
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
        // `--no-relative`: a `diff.relative` config must not narrow the rows or
        // make them cwd-relative.
        &["diff", "--no-relative", "--numstat", "-z", base],
    )?;
    let mut files = parse_numstat_files(&String::from_utf8_lossy(&numstat));

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
    let root = git_path_on_host(cwd, &toplevel);
    files.extend(untracked_file_stats(&root, &untracked));

    let (added, removed) = files.iter().fold((0u64, 0u64), |(a, r), f| {
        (a.saturating_add(f.added), r.saturating_add(f.removed))
    });
    Ok(GitDiffStat {
        added,
        removed,
        files,
        root: root.to_string_lossy().into_owned(),
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

/// Per-file rows of a `git diff --numstat -z` listing, sorted by path. A
/// rename is keyed by its new path; binary rows (`-\t-`) count 0 lines.
pub(super) fn parse_numstat_files(output: &str) -> Vec<GitFileDiffStat> {
    let mut files: Vec<GitFileDiffStat> = super::commit_detail::parse_numstat_z(output)
        .into_iter()
        .map(|(path, (added, removed))| GitFileDiffStat {
            path,
            added: added.unwrap_or(0),
            removed: removed.unwrap_or(0),
        })
        .collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    files
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

/// Line count per file of the NUL-separated untracked listing (paths relative
/// to `toplevel`). Bounded by [`MAX_UNTRACKED_FILES`] / [`MAX_UNTRACKED_FILE_BYTES`];
/// symlinks, directories, unreadable, oversized and binary files get no row.
pub(super) fn untracked_file_stats(toplevel: &Path, listing: &[u8]) -> Vec<GitFileDiffStat> {
    let mut files = Vec::new();
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
        files.push(GitFileDiffStat {
            path: rel.into_owned(),
            added: count_lines(&bytes),
            removed: 0,
        });
    }

    if skipped_oversize > 0 {
        log::debug!(
            "[GitTracker] diff stat: skipped {skipped_oversize} untracked file(s) over {MAX_UNTRACKED_FILE_BYTES} bytes"
        );
    }
    files
}
