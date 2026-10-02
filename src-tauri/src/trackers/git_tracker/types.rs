use super::*;

/// Git status information
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub modified: u32,
    pub staged: u32,
    pub untracked: u32,
    pub ahead: u32,
    pub behind: u32,
    pub has_changes: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusDetail {
    pub path: String,
    pub status: String,
    pub staged: bool,
}

/// A single commit row for the history/graph view.
///
/// `parents` holds full parent SHAs in order (first parent first); a merge has
/// two or more. `refs` is the raw `%D` decoration list split on ", " with empty
/// entries dropped (e.g. `HEAD -> main`, `tag: v1.0`, `origin/main`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    /// Full 40-char commit hash.
    pub hash: String,
    /// Abbreviated commit hash.
    pub short_hash: String,
    /// Parent full hashes, first-parent first. Empty for the root commit.
    pub parents: Vec<String>,
    /// Ref decorations attached to this commit (branches, tags, HEAD).
    pub refs: Vec<String>,
    /// Author name.
    pub author: String,
    /// Author date in ISO 8601 / strict format (`%aI`).
    pub date: String,
    /// Commit subject (first line of the message).
    pub subject: String,
}

impl GitStatus {
    /// Create a new GitStatus with all zeros
    pub fn new() -> Self {
        Self {
            modified: 0,
            staged: 0,
            untracked: 0,
            ahead: 0,
            behind: 0,
            has_changes: false,
        }
    }
}

impl Default for GitStatus {
    fn default() -> Self {
        Self::new()
    }
}

/// Context the commit footer needs to render: current branch, whether an
/// upstream is configured, ahead/behind counts, how many entries are staged,
/// and the last commit's subject/body (used to prefill an amend).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitContext {
    /// Current branch name, or `None` in a detached HEAD / no-branch state.
    pub branch: Option<String>,
    /// Whether the current branch has a configured upstream.
    pub has_upstream: bool,
    /// Commits the local branch is ahead of its upstream.
    pub ahead: u32,
    /// Commits the local branch is behind its upstream.
    pub behind: u32,
    /// Number of staged index entries (`git diff --cached --name-only`).
    pub staged_count: u32,
    /// Whether the repo has at least one commit (HEAD resolves).
    pub has_head: bool,
    /// Last commit subject (first line), empty when no HEAD.
    pub last_subject: String,
    /// Last commit body (everything after the subject + blank line), empty when none.
    pub last_body: String,
}
