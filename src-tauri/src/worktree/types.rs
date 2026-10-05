use serde::{Deserialize, Serialize};

// ============================================================================
// Symlink Types
// ============================================================================

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitignoreDir {
    pub dir_name: String,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymlinkResult {
    pub path: String,
    pub target: String,
    pub status: String, // "created", "skipped", "failed"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

// ============================================================================
// Data Types
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeEntry {
    pub name: String,
    pub branch: String,
    pub path: String,
    pub head_commit: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchEntry {
    pub name: String,
    pub is_remote: bool,
    pub is_current: bool,
    pub upstream: Option<String>,
    /// True when this branch is checked out in a different git worktree.
    pub has_other_worktree: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirtyStatus {
    pub modified: usize,
    pub staged: usize,
    pub untracked: usize,
    pub has_changes: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveResult {
    pub worktree_path: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ============================================================================
// Archive Types
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    pub original_path: String,
    pub archive_path: String,
    pub archived_at: String,
    pub expires_at: String,
    pub branch_name: String,
    pub worktree_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveManifest {
    pub entries: Vec<ArchiveEntry>,
}

// ============================================================================
// Merge Types
// ============================================================================

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    pub severity: String,
    pub conflict_count: usize,
    pub is_lock_file: bool,
    pub suggestions: Vec<ConflictSuggestion>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictSuggestion {
    pub strategy: String,
    pub confidence: String,
    pub reason: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePreview {
    pub direction: String,
    pub source_branch: String,
    pub target_branch: String,
    pub conflict_files: Vec<ConflictFile>,
    pub changed_files: Vec<String>,
    pub total_changes: usize,
    pub detection_mode: String,
    pub has_auto_resolvable: bool,
}

// ============================================================================
// Base Branch Resolution + Worktree-Include Carry-Over (CAP-2 / CAP-5)
// ============================================================================

/// Origin-aware default base branch + detached-HEAD guard for worktree
/// creation (CAP-2). `current_branch` is `None` when the repo is in detached
/// HEAD — the launcher must then force a base-branch pick before allowing a
/// worktree launch.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseBranchInfo {
    /// The branch `chat/{id}` should be created from: origin/HEAD → main →
    /// master → current branch (last resort).
    pub default_base: String,
    /// Current checked-out branch, or `None` on detached HEAD.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_branch: Option<String>,
    /// `true` when `git rev-parse --abbrev-ref HEAD` returns `HEAD`.
    pub is_detached: bool,
}

/// Per-file skip reason for the `.worktree-include` carry-over (CAP-5).
/// Surfaced to the renderer so the launcher can log per-file decisions.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncludeSkipReason {
    pub path: String,
    pub reason: String,
}

/// Result of `copy_worktree_include_files` (CAP-5). `ran` is the number of
/// patterns that matched at least one file; `copied` is files actually
/// copied; `skipped` carries per-file reasons (symlink, path-escape,
/// already-present).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncludeCopyResult {
    pub ran: usize,
    pub copied: usize,
    pub skipped: Vec<IncludeSkipReason>,
}

// ============================================================================
// Error Handling
// ============================================================================

#[derive(Debug, Clone)]
pub enum WorktreeError {
    GitNotFound,
    NotAGitRepo,
    WorktreeExists,
    BranchAlreadyHasWorktree,
    BranchNotFound,
    WorktreeRemoveFailed,
    PathTooLong,
    WorktreeLocked,
    ArchiveFailed,
    ArchiveNotFound,
    MergeFailed,
    IoError(String),
    GitError(String),
}

impl WorktreeError {
    pub fn error_code(&self) -> &str {
        match self {
            Self::WorktreeExists => "WORKTREE_EXISTS",
            Self::WorktreeRemoveFailed => "WORKTREE_REMOVE_FAILED",
            Self::BranchAlreadyHasWorktree => "BRANCH_ALREADY_HAS_WORKTREE",
            Self::NotAGitRepo => "NOT_A_GIT_REPO",
            Self::GitNotFound => "GIT_NOT_FOUND",
            Self::PathTooLong => "PATH_TOO_LONG",
            Self::BranchNotFound => "BRANCH_NOT_FOUND",
            Self::WorktreeLocked => "WORKTREE_LOCKED",
            Self::IoError(_) | Self::GitError(_) => "WORKTREE_CREATE_FAILED",
            Self::ArchiveFailed => "ARCHIVE_FAILED",
            Self::MergeFailed => "MERGE_FAILED",
            Self::ArchiveNotFound => "ARCHIVE_NOT_FOUND",
        }
    }
}

impl std::fmt::Display for WorktreeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::GitNotFound => write!(f, "Git not found. Install git to use worktrees."),
            Self::NotAGitRepo => write!(f, "Not a git repository."),
            Self::WorktreeExists => {
                write!(
                    f,
                    "A worktree with this name already exists. Choose a different name."
                )
            }
            Self::BranchAlreadyHasWorktree => {
                write!(f, "This branch already has a worktree in another location.")
            }
            Self::BranchNotFound => write!(f, "The specified branch was not found."),
            Self::WorktreeRemoveFailed => {
                write!(
                    f,
                    "Failed to remove the worktree. It may have uncommitted changes."
                )
            }
            Self::PathTooLong => {
                write!(f, "The worktree path is too long. Choose a shorter name.")
            }
            Self::WorktreeLocked => write!(f, "Git is busy. Try again in a moment."),
            Self::ArchiveFailed => write!(f, "Failed to archive worktree."),
            Self::ArchiveNotFound => write!(f, "Archive not found."),
            Self::MergeFailed => write!(f, "Merge operation failed. There may be conflicts."),
            Self::IoError(msg) => write!(f, "Filesystem error: {}", msg),
            Self::GitError(msg) => write!(f, "Git error: {}", msg),
        }
    }
}

/// Parse Git stderr output into a user-friendly error message.
///
/// Only `fatal:`/`error:`-prefixed lines are classifiable. Git usage dumps
/// (exit 129) and help text repeat phrases like "already checked out" in
/// option descriptions — scanning the whole stderr would misclassify an
/// argument error as a branch collision and trigger a bogus `-2` retry in
/// the launcher. With no match the raw stderr is returned verbatim via
/// `GitError` so the real git message reaches the UI.
pub(super) fn parse_git_stderr(stderr: &str) -> WorktreeError {
    let stderr = stderr.trim();

    // True when a `fatal:`/`error:`-prefixed line contains `needle` — no
    // intermediate allocation, one pass per predicate.
    let matches_error_line = |needle: &str| {
        stderr
            .lines()
            .map(str::trim_start)
            .filter(|line| line.starts_with("fatal:") || line.starts_with("error:"))
            .any(|line| line.contains(needle))
    };

    if matches_error_line("already checked out") {
        return WorktreeError::BranchAlreadyHasWorktree;
    }
    if matches_error_line("already exists") {
        return WorktreeError::WorktreeExists;
    }
    if matches_error_line("not a git repository") {
        return WorktreeError::NotAGitRepo;
    }
    if matches_error_line("is not a valid repository")
        || matches_error_line("not a valid git repository")
    {
        return WorktreeError::NotAGitRepo;
    }
    if matches_error_line("did not match any file") || matches_error_line("pathspec") {
        return WorktreeError::BranchNotFound;
    }
    if matches_error_line("locked") {
        return WorktreeError::WorktreeLocked;
    }
    if matches_error_line("is dirty") || matches_error_line("has uncommitted changes") {
        return WorktreeError::WorktreeRemoveFailed;
    }

    WorktreeError::GitError(stderr.to_string())
}
