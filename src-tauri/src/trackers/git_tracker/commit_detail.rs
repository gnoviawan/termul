//! Commit detail for the Git History view: the full message, the author email
//! and the changed files of one commit, with `+added -removed` per file.
//!
//! One shared function — [`git_get_commit_detail`] — backs both the Tauri
//! command and the `POST /git/commit-detail` web route.
//!
//! The files are the diff against the commit's first parent (`--root` for a
//! root commit), with rename detection, the same view a merge commit shows in
//! `git log --first-parent -p`. The list is capped at [`MAX_COMMIT_FILES`]
//! entries; `files_truncated` tells the caller.
//!
//! The request hash is only a lookup key. It must be hex, and it is resolved
//! with `rev-parse <hash>^{commit}` so a blob or tree id is refused; every
//! later git call gets the resolved full ids (validated as hex of the repo's
//! length). A hex id cannot be an option, so these calls omit
//! `--end-of-options` (Git 2.30). `git show` passes `--no-show-signature` so
//! `log.showSignature` cannot put GPG text in front of the header. File
//! contents are never read into logs.

use super::git_exec::{empty_tree_for, git_stdout, GitRunError, StdoutCap};
use super::*;

/// Maximum changed files returned for one commit; the rest are dropped.
pub(super) const MAX_COMMIT_FILES: usize = 1000;
/// Largest file diff returned; a bigger one is reported as `too_large`.
pub(super) const MAX_FILE_DIFF_BYTES: usize = 2 * 1024 * 1024;
/// Field and record separators of the `git show` format below.
const FIELD_SEP: char = '\0';

/// One-letter status of a changed file. Serialized as the letter itself,
/// matching the renderer's `GitCommitFileStatus`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum GitCommitFileStatus {
    #[serde(rename = "A")]
    Added,
    #[serde(rename = "M")]
    Modified,
    #[serde(rename = "D")]
    Deleted,
    #[serde(rename = "R")]
    Renamed,
    #[serde(rename = "C")]
    Copied,
    #[serde(rename = "T")]
    TypeChanged,
}

impl GitCommitFileStatus {
    fn from_letter(letter: char) -> Option<Self> {
        match letter {
            'A' => Some(Self::Added),
            'M' => Some(Self::Modified),
            'D' => Some(Self::Deleted),
            'R' => Some(Self::Renamed),
            'C' => Some(Self::Copied),
            'T' => Some(Self::TypeChanged),
            _ => None,
        }
    }
}

/// One file changed by a commit.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFile {
    /// Path after the commit (the new path of a rename).
    pub path: String,
    /// Path before the commit, for a rename or copy only.
    pub old_path: Option<String>,
    pub status: GitCommitFileStatus,
    /// Added lines; `None` for a binary file.
    pub added: Option<u64>,
    /// Removed lines; `None` for a binary file.
    pub removed: Option<u64>,
}

/// Everything the detail pane shows that the log row does not carry.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDetail {
    /// Full hash: 40 hex characters, or 64 in a SHA-256 repository (the
    /// request may be abbreviated).
    pub hash: String,
    pub author_email: String,
    /// Full commit message (subject, blank line, body), trailing newline trimmed.
    pub message: String,
    /// Parent full hashes, first-parent first.
    pub parents: Vec<String>,
    pub files: Vec<GitCommitFile>,
    /// More than [`MAX_COMMIT_FILES`] files changed; `files` holds the first ones.
    pub files_truncated: bool,
}

/// One file's diff in a commit. `diff` is empty when `too_large` is set.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFileDiff {
    pub diff: String,
    /// The diff is over [`MAX_FILE_DIFF_BYTES`] and was not returned.
    pub too_large: bool,
}

/// Why a commit detail could not be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommitDetailError {
    /// The hash is not 4–64 hex characters.
    InvalidHash,
    /// A file path is absolute, empty, or leaves the repository.
    InvalidPath,
    /// git failed to run, timed out, or exited non-zero (unknown commit, the
    /// hash names a blob or tree, not a repository, ...).
    Git(GitRunError),
}

impl From<GitRunError> for CommitDetailError {
    fn from(e: GitRunError) -> Self {
        CommitDetailError::Git(e)
    }
}

impl CommitDetailError {
    /// Stable machine code shared by the Tauri `IpcResult` and the web `IpcBody`.
    pub fn code(&self) -> &'static str {
        match self {
            CommitDetailError::InvalidHash => "INVALID_COMMIT_HASH",
            CommitDetailError::InvalidPath => "INVALID_PATH",
            CommitDetailError::Git(_) => "GIT_COMMIT_DETAIL_ERROR",
        }
    }
}

impl std::fmt::Display for CommitDetailError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CommitDetailError::InvalidHash => write!(f, "Not a commit hash"),
            CommitDetailError::InvalidPath => write!(f, "Not a repository-relative path"),
            CommitDetailError::Git(e) => std::fmt::Display::fmt(e, f),
        }
    }
}

impl std::error::Error for CommitDetailError {}

/// A commit hash or an unambiguous prefix: 4 to 64 hex characters (a full id
/// is 40 in a SHA-1 repository and 64 in a SHA-256 one).
pub(super) fn is_commit_hash(hash: &str) -> bool {
    (4..=64).contains(&hash.len()) && hash.bytes().all(|b| b.is_ascii_hexdigit())
}

/// A full object id: exactly 40 or 64 hex characters. Git prints ids in this
/// form, so anything else (for example a blob's content) is not an id.
pub(super) fn is_object_id(id: &str) -> bool {
    matches!(id.len(), 40 | 64) && id.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Read the message, author email, parents and changed files of `hash` in the
/// repository at `cwd`.
pub fn git_get_commit_detail(cwd: &str, hash: &str) -> Result<GitCommitDetail, CommitDetailError> {
    if !is_commit_hash(hash) {
        log::warn!("[GitTracker] commit detail refused a non-hash in {cwd}");
        return Err(CommitDetailError::InvalidHash);
    }
    match read_commit_detail(cwd, hash) {
        Ok(detail) => {
            log::debug!(
                "[GitTracker] commit detail for {cwd} {}: {} files{}",
                detail.hash,
                detail.files.len(),
                if detail.files_truncated {
                    " (truncated)"
                } else {
                    ""
                }
            );
            Ok(detail)
        }
        Err(e) => {
            log::warn!("[GitTracker] commit detail failed for {cwd} {hash}: {e}");
            Err(e)
        }
    }
}

/// Resolve `hash` to the full id of a commit. `^{commit}` makes git refuse a
/// blob or tree id (and peel a tag to its commit); the result must be a full
/// object id before it is used anywhere else.
fn resolve_commit(cwd: &str, hash: &str) -> Result<String, CommitDetailError> {
    // `hash` is hex, so `spec` cannot be an option. Omit `--end-of-options`
    // (Git 2.30); older git would fail this lookup for every commit.
    let spec = format!("{hash}^{{commit}}");
    let stdout = git_stdout(
        cwd,
        "rev-parse",
        StdoutCap::Unbounded,
        &["rev-parse", "--verify", "--quiet", &spec],
    )
    .map_err(|e| match e {
        // `--quiet` prints nothing for an id that names no commit.
        GitRunError::GitFailed { command, detail } if detail.is_empty() => GitRunError::GitFailed {
            command,
            detail: "unknown commit".to_string(),
        },
        other => other,
    })?;
    let full = String::from_utf8_lossy(&stdout).trim().to_string();
    if !is_object_id(&full) {
        return Err(unexpected_output("rev-parse"));
    }
    Ok(full)
}

fn unexpected_output(command: &'static str) -> CommitDetailError {
    GitRunError::GitFailed {
        command,
        detail: "unexpected output".to_string(),
    }
    .into()
}

/// `(full hash, author email, parents, message)` of the commit `full`. Every
/// id git printed must be a full object id of the same length.
fn read_header(
    cwd: &str,
    full: &str,
) -> Result<(String, String, Vec<String>, String), CommitDetailError> {
    // %H full hash, %ae author email, %P parents, %B raw message.
    // `--no-show-signature` overrides `log.showSignature`, which writes GPG
    // text to stdout before the format and makes the hash field unreadable.
    let header = git_stdout(
        cwd,
        "show",
        StdoutCap::Unbounded,
        &[
            "show",
            "-s",
            "--no-color",
            "--no-show-signature",
            "--format=%H%x00%ae%x00%P%x00%B",
            full,
        ],
    )?;
    let (full_hash, author_email, parents, message) =
        parse_show_header(&String::from_utf8_lossy(&header));
    let ids_ok = is_object_id(&full_hash)
        && parents
            .iter()
            .all(|p| is_object_id(p) && p.len() == full_hash.len());
    if !ids_ok {
        return Err(unexpected_output("show"));
    }
    Ok((full_hash, author_email, parents, message))
}

fn read_commit_detail(cwd: &str, hash: &str) -> Result<GitCommitDetail, CommitDetailError> {
    let full = resolve_commit(cwd, hash)?;
    let (full_hash, author_email, parents, message) = read_header(cwd, &full)?;

    let numstat = diff_tree(cwd, "--numstat", &full_hash, parents.first())?;
    let name_status = diff_tree(cwd, "--name-status", &full_hash, parents.first())?;
    let (files, files_truncated) = merge_file_lists(
        parse_name_status_z(&name_status),
        parse_numstat_z(&numstat),
        MAX_COMMIT_FILES,
    );

    Ok(GitCommitDetail {
        hash: full_hash,
        author_email,
        message,
        parents,
        files,
        files_truncated,
    })
}

/// `git diff-tree -z <format>` of a commit against its first parent, or the
/// whole tree for a root commit. Two runs (`--numstat`, `--name-status`) are
/// joined by path: a combined `--raw --numstat -z` stream interleaves
/// mode/id-prefixed records with count records, which costs a parser more
/// than the spare process saves.
fn diff_tree(
    cwd: &str,
    format: &'static str,
    full: &str,
    first_parent: Option<&String>,
) -> Result<String, CommitDetailError> {
    let mut args = vec![
        "diff-tree",
        "-r",
        "-z",
        "-M",
        "--no-color",
        "--no-commit-id",
        format,
    ];
    match first_parent {
        Some(parent) => args.extend([parent.as_str(), full]),
        None => args.extend(["--root", full]),
    }
    let stdout = git_stdout(cwd, "diff-tree", StdoutCap::Unbounded, &args)?;
    Ok(String::from_utf8_lossy(&stdout).into_owned())
}

/// Unified diff of one file in `hash` against the commit's first parent (the
/// empty tree for a root commit), for the read-only commit Diff tab. `old_path`
/// (a rename's source) joins the pathspec so `-M` can pair the two sides.
/// Both paths must be safe repo-relative paths; the hash must be hex and name
/// a commit. A diff over [`MAX_FILE_DIFF_BYTES`] is not returned.
pub fn git_get_commit_file_diff(
    cwd: &str,
    hash: &str,
    path: &str,
    old_path: Option<&str>,
) -> Result<GitCommitFileDiff, CommitDetailError> {
    if !is_commit_hash(hash) {
        log::warn!("[GitTracker] commit file diff refused a non-hash in {cwd}");
        return Err(CommitDetailError::InvalidHash);
    }
    let paths_ok = super::commands::is_safe_relative_path(path)
        && old_path.is_none_or(super::commands::is_safe_relative_path);
    if !paths_ok {
        log::warn!("[GitTracker] commit file diff refused an unsafe path in {cwd}");
        return Err(CommitDetailError::InvalidPath);
    }

    let full = resolve_commit(cwd, hash)?;
    let (full, _, parents, _) = read_header(cwd, &full)?;
    let base = parents
        .first()
        .map(String::as_str)
        .unwrap_or_else(|| empty_tree_for(full.len()));
    let mut args = vec![
        "diff",
        "--no-color",
        "--no-ext-diff",
        "-M",
        base,
        &full,
        "--",
        path,
    ];
    if let Some(old) = old_path {
        args.push(old);
    }
    // One byte past the cap tells "exactly at the cap" from "over it".
    let stdout = git_stdout(
        cwd,
        "diff",
        StdoutCap::Bytes(MAX_FILE_DIFF_BYTES + 1),
        &args,
    )?;
    if stdout.len() > MAX_FILE_DIFF_BYTES {
        log::info!(
            "[GitTracker] commit file diff for {cwd} {full}: over {MAX_FILE_DIFF_BYTES} bytes, not returned"
        );
        return Ok(GitCommitFileDiff {
            diff: String::new(),
            too_large: true,
        });
    }
    let diff = String::from_utf8_lossy(&stdout).into_owned();
    log::debug!(
        "[GitTracker] commit file diff for {cwd} {full}: {} bytes",
        diff.len()
    );
    Ok(GitCommitFileDiff {
        diff,
        too_large: false,
    })
}

/// Split the `%H%x00%ae%x00%P%x00%B` output into its four fields. The message
/// keeps its inner newlines; only the trailing ones git adds are trimmed.
pub(super) fn parse_show_header(stdout: &str) -> (String, String, Vec<String>, String) {
    let mut fields = stdout.splitn(4, FIELD_SEP);
    let hash = fields.next().unwrap_or("").trim().to_string();
    let email = fields.next().unwrap_or("").trim().to_string();
    let parents = fields
        .next()
        .unwrap_or("")
        .split_whitespace()
        .map(str::to_string)
        .collect();
    let message = fields
        .next()
        .unwrap_or("")
        .trim_end_matches(['\n', '\r'])
        .to_string();
    (hash, email, parents, message)
}

/// `(status, old_path, path)` rows from `diff-tree -z --name-status`:
/// `M\0path\0`, or `R087\0old\0new\0` for a rename or copy. A row with a
/// status the renderer has no letter for is skipped with a warning.
pub(super) fn parse_name_status_z(
    stdout: &str,
) -> Vec<(GitCommitFileStatus, Option<String>, String)> {
    let mut rows = Vec::new();
    let mut parts = stdout.split(FIELD_SEP).filter(|p| !p.is_empty());
    while let Some(raw_status) = parts.next() {
        let letter = raw_status.chars().next();
        // Read the paths first so a skipped row still consumes its fields.
        let old_path = if matches!(letter, Some('R' | 'C')) {
            let Some(old) = parts.next() else {
                break;
            };
            Some(old.to_string())
        } else {
            None
        };
        let Some(path) = parts.next() else {
            break;
        };
        match letter.and_then(GitCommitFileStatus::from_letter) {
            Some(status) => rows.push((status, old_path, path.to_string())),
            None => log::warn!(
                "[GitTracker] commit detail skipped a file with unsupported status {raw_status:?}"
            ),
        }
    }
    rows
}

/// `path -> (added, removed)` from `diff-tree -z --numstat`: `a\tr\tpath\0`, or
/// `a\tr\t\0old\0new\0` for a rename. `-\t-` (binary) maps to `None`.
pub(super) fn parse_numstat_z(stdout: &str) -> HashMap<String, (Option<u64>, Option<u64>)> {
    let mut stats = HashMap::new();
    let mut parts = stdout.split(FIELD_SEP);
    while let Some(head) = parts.next() {
        let head = head.trim_start_matches(['\n', '\r']);
        if head.is_empty() {
            continue;
        }
        let mut cols = head.splitn(3, '\t');
        let added = cols.next().and_then(|v| v.parse::<u64>().ok());
        let removed = cols.next().and_then(|v| v.parse::<u64>().ok());
        let inline_path = cols.next().unwrap_or("");
        let path = if inline_path.is_empty() {
            // Rename: the old and the new path follow as their own fields.
            let _old = parts.next();
            match parts.next() {
                Some(new) => new.to_string(),
                None => break,
            }
        } else {
            inline_path.to_string()
        };
        stats.insert(path, (added, removed));
    }
    stats
}

/// Join the status rows with their counts, in git's order, capped at `max`.
pub(super) fn merge_file_lists(
    rows: Vec<(GitCommitFileStatus, Option<String>, String)>,
    stats: HashMap<String, (Option<u64>, Option<u64>)>,
    max: usize,
) -> (Vec<GitCommitFile>, bool) {
    let truncated = rows.len() > max;
    let files = rows
        .into_iter()
        .take(max)
        .map(|(status, old_path, path)| {
            let (added, removed) = stats.get(&path).copied().unwrap_or((None, None));
            GitCommitFile {
                path,
                old_path,
                status,
                added,
                removed,
            }
        })
        .collect();
    (files, truncated)
}
