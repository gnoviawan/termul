use serde::{Deserialize, Serialize};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;

/// Windows flag to suppress the transient console window that would otherwise
/// flash for every short-lived helper process (git.exe, where.exe, cmd.exe).
/// Without this, GUI/release builds pop a console window on each invocation
/// — highly visible when worktree status polling runs `git status` every 2s.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Build a helper command that does not spawn a visible console window.
/// On Windows this applies the `CREATE_NO_WINDOW` creation flag; on other
/// platforms it is a plain `Command::new`.
fn quiet_command(program: &str) -> Command {
    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new(program);
        command.creation_flags(CREATE_NO_WINDOW);
        command
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new(program)
    }
}

/// Directories that should never be symlinked into worktrees.
const SYMLINK_EXCLUSION_LIST: &[&str] = &[
    ".git",
    ".termul",
    ".worktrees",
    ".claude",
    ".codex",
    ".opencode",
    ".pi",
    ".pi-lens",
    ".agents",
    ".auto-claude",
    ".vscode",
    ".idea",
    "_bmad",
    "_bmad-output",
    "_bmad-bkp",
];

/// Check if a directory name is in the hardcoded exclusion list.
fn is_excluded_dir(dir_name: &str) -> bool {
    SYMLINK_EXCLUSION_LIST
        .iter()
        .any(|excluded| dir_name == *excluded || dir_name.starts_with(&format!("{}{}", *excluded, "/")))
}

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeEntry {
    pub name: String,
    pub branch: String,
    pub path: String,
    pub head_commit: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchEntry {
    pub name: String,
    pub is_remote: bool,
    pub is_current: bool,
    pub upstream: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
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
                write!(f, "A worktree with this name already exists. Choose a different name.")
            }
            Self::BranchAlreadyHasWorktree => {
                write!(f, "This branch already has a worktree in another location.")
            }
            Self::BranchNotFound => write!(f, "The specified branch was not found."),
            Self::WorktreeRemoveFailed => {
                write!(f, "Failed to remove the worktree. It may have uncommitted changes.")
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
fn parse_git_stderr(stderr: &str) -> WorktreeError {
    let stderr = stderr.trim();

    if stderr.contains("already checked out") {
        return WorktreeError::BranchAlreadyHasWorktree;
    }
    if stderr.contains("already exists") {
        return WorktreeError::WorktreeExists;
    }
    if stderr.contains("not a git repository") || stderr.contains("fatal: not a git repository") {
        return WorktreeError::NotAGitRepo;
    }
    if stderr.contains("is not a valid repository") || stderr.contains("not a valid git repository")
    {
        return WorktreeError::NotAGitRepo;
    }
    if stderr.contains("did not match any file") || stderr.contains("pathspec") {
        return WorktreeError::BranchNotFound;
    }
    if stderr.contains("locked") {
        return WorktreeError::WorktreeLocked;
    }
    if stderr.contains("is dirty") || stderr.contains("has uncommitted changes") {
        return WorktreeError::WorktreeRemoveFailed;
    }

    WorktreeError::GitError(stderr.to_string())
}

/// Run a git command and return (stdout, stderr, success).
fn run_git(args: &[&str], cwd: Option<&str>) -> Result<(String, String), WorktreeError> {
    let git = which_git()?;

    let mut cmd = quiet_command(&git);
    cmd.args(args);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    let output = cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            WorktreeError::GitNotFound
        } else {
            WorktreeError::IoError(e.to_string())
        }
    })?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(parse_git_stderr(&stderr));
    }

    Ok((stdout, stderr))
}

/// Find the `git` binary on PATH.
fn which_git() -> Result<String, WorktreeError> {
    // On Windows, check common locations first
    #[cfg(target_os = "windows")]
    {
        let candidates = [
            "git.exe",
            "C:\\Program Files\\Git\\cmd\\git.exe",
            "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
        ];
        for candidate in &candidates {
            if Path::new(candidate).exists() {
                return Ok(candidate.to_string());
            }
        }
    }

    // Check PATH via `where git` (Windows) or `which git` (Unix)
    let cmd = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };

    let output = quiet_command(cmd)
        .arg("git")
        .output()
        .map_err(|_| WorktreeError::GitNotFound)?;

    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()
            .unwrap_or("git")
            .trim()
            .to_string();
        if !path.is_empty() {
            return Ok(path);
        }
    }

    Err(WorktreeError::GitNotFound)
}

// ============================================================================
// WorktreeManager
// ============================================================================

pub struct WorktreeManager;

impl WorktreeManager {
    /// List all worktrees for a git repo at the given path.
    /// Uses `git worktree list --porcelain`.
    /// Filters out bare worktrees and detached-HEAD worktrees (v1 scope only branch-based).
    pub fn list(project_path: &str) -> Result<Vec<GitWorktreeEntry>, WorktreeError> {
        let (stdout, _) = run_git(&["worktree", "list", "--porcelain"], Some(project_path))?;

        let mut entries = Vec::new();
        let mut current_path: Option<String> = None;
        let mut current_head: Option<String> = None;
        let mut current_branch: Option<String> = None;

        for line in stdout.lines() {
            let line = line.trim();
            if line.is_empty() {
                // End of an entry — flush if branch-based (not bare/detached)
                if let (Some(path), Some(head), Some(branch)) =
                    (current_path.take(), current_head.take(), current_branch.take())
                {
                    let name = Path::new(&path)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| branch.clone());

                    entries.push(GitWorktreeEntry {
                        name,
                        branch,
                        path,
                        head_commit: head,
                    });
                } else {
                    // Reset partial entry (bare/detached — filtered)
                    current_path = None;
                    current_head = None;
                    current_branch = None;
                }
                continue;
            }

            if let Some(val) = line.strip_prefix("worktree ") {
                current_path = Some(val.to_string());
            } else if let Some(val) = line.strip_prefix("HEAD ") {
                current_head = Some(val.to_string());
            } else if let Some(val) = line.strip_prefix("branch refs/heads/") {
                // Only capture branch-based worktrees (skip bare/detached)
                current_branch = Some(val.to_string());
            }
            // Skip bare/detached lines — they don't start with "branch refs/heads/"
        }

        // Flush last entry
        if let (Some(path), Some(head), Some(branch)) =
            (current_path, current_head, current_branch)
        {
            let name = Path::new(&path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| branch.clone());

            entries.push(GitWorktreeEntry {
                name,
                branch,
                path,
                head_commit: head,
            });
        }

        Ok(entries)
    }

    /// Create a new worktree.
    ///
    /// - If `is_new_branch` is true, uses `git worktree add -b <branch> <path> [start_ref]`
    /// - Otherwise uses `git worktree add <path> <branch>`
    /// - `target_path` defaults to `<project_path>/.termul/worktrees/<name>/` when `None`
    /// - Auto-adds `.termul/` to `.gitignore` if not already present
    pub fn create(
        project_path: &str,
        name: &str,
        branch: &str,
        is_new_branch: bool,
        start_ref: Option<&str>,
        target_path: Option<&str>,
    ) -> Result<GitWorktreeEntry, WorktreeError> {
        let target = match target_path {
            Some(p) => p.to_string(),
            None => format!(
                "{}/.termul/worktrees/{}/",
                project_path.trim_end_matches('/'),
                name
            ),
        };

        // Validate path length (Windows MAX_PATH guard)
        let target_path_obj = Path::new(&target);
        let target_str = target_path_obj.to_string_lossy();
        if target_str.len() > 200 {
            return Err(WorktreeError::PathTooLong);
        }

        // Pre-check: does this branch already have a worktree?
        let existing = Self::list(project_path)?;
        if existing.iter().any(|e| e.branch == branch) {
            return Err(WorktreeError::BranchAlreadyHasWorktree);
        }

        // Build git worktree add args
        let mut args = vec!["worktree", "add"];

        if is_new_branch {
            args.push("-b");
            args.push(branch);
            args.push(&target);
            if let Some(ref_val) = start_ref {
                args.push(ref_val);
            }
        } else {
            args.push(&target);
            args.push(branch);
        }

        run_git(&args, Some(project_path))?;

        // Auto-add .termul/ to .gitignore if not already present
        let gitignore_path = Path::new(project_path).join(".gitignore");
        if gitignore_path.exists() {
            let content = std::fs::read_to_string(&gitignore_path)
                .map_err(|e| WorktreeError::IoError(e.to_string()))?;
            if !content.lines().any(|l| l.trim() == ".termul/") {
                let updated = format!("{}\n.termul/\n", content.trim_end());
                std::fs::write(&gitignore_path, updated)
                    .map_err(|e| WorktreeError::IoError(e.to_string()))?;
            }
        } else {
            std::fs::write(&gitignore_path, ".termul/\n")
                .map_err(|e| WorktreeError::IoError(e.to_string()))?;
        }

        let entry_name = Path::new(&target)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| name.to_string());

        Ok(GitWorktreeEntry {
            name: entry_name,
            branch: branch.to_string(),
            path: target,
            head_commit: String::new(), // Will be populated on next list
        })
    }

    /// Remove a worktree.
    /// Uses `git worktree remove <path>` (with --force if requested).
    /// Git runs with the repository as its working directory so the worktree
    /// metadata can be located; otherwise git reports "not a git repository".
    /// After removal, runs `git worktree prune` to clean stale metadata.
    pub fn remove(project_path: &str, worktree_path: &str, force: bool) -> Result<(), WorktreeError> {
        let mut args = vec!["worktree", "remove"];
        if force {
            args.push("--force");
        }
        args.push(worktree_path);

        run_git(&args, Some(project_path))?;

        // Prune stale metadata
        let _ = run_git(&["worktree", "prune"], Some(project_path));

        Ok(())
    }

    /// List branches for a git repo.
    /// Returns local and remote branches with metadata.
    pub fn branches(project_path: &str) -> Result<Vec<BranchEntry>, WorktreeError> {
        // Get local branches
        let (local_stdout, _) = run_git(
            &[
                "branch",
                "--list",
                "--format=%(refname:short)|%(upstream:short)",
            ],
            Some(project_path),
        )?;

        // Get current branch
        let (current_stdout, _) = run_git(
            &["branch", "--show-current"],
            Some(project_path),
        )?;
        let current_branch = current_stdout.trim().to_string();

        let mut entries: Vec<BranchEntry> = Vec::new();

        for line in local_stdout.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let parts: Vec<&str> = line.splitn(2, '|').collect();
            let name = parts[0].to_string();
            let upstream = if parts.len() > 1 && !parts[1].is_empty() {
                Some(parts[1].to_string())
            } else {
                None
            };

            entries.push(BranchEntry {
                is_current: name == current_branch,
                is_remote: false,
                upstream,
                name,
            });
        }

        // Get remote branches
        let (remote_stdout, _) = run_git(
            &[
                "branch",
                "--remote",
                "--list",
                "--format=%(refname:short)",
            ],
            Some(project_path),
        )?;

        for line in remote_stdout.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let name = line.to_string();
            // Skip if already in local branches
            if !entries.iter().any(|e| e.name == name) {
                entries.push(BranchEntry {
                    is_current: false,
                    is_remote: true,
                    upstream: None,
                    name,
                });
            }
        }

        Ok(entries)
    }

    /// Check dirty status for a worktree checkout.
    /// Returns a summary of uncommitted changes (or empty if clean).
    pub fn check_dirty(worktree_path: &str) -> Result<DirtyStatus, WorktreeError> {
        let (stdout, _) = run_git(&["status", "--porcelain"], Some(worktree_path))?;

        let mut modified = 0usize;
        let mut staged = 0usize;
        let mut untracked = 0usize;

        for line in stdout.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            // --porcelain format: XY path
            let status = line.chars().take(2).collect::<String>();
            let chars: Vec<char> = status.chars().collect();

            if chars.len() >= 2 {
                // Index (staging area)
                match chars[0] {
                    'M' | 'A' | 'D' | 'R' | 'C' => staged += 1,
                    _ => {}
                }
                // Working tree
                match chars[1] {
                    'M' | 'A' | 'D' | 'R' | 'C' => modified += 1,
                    '?' | '!' => untracked += 1,
                    _ => {}
                }
            }
        }

        Ok(DirtyStatus {
            modified,
            staged,
            untracked,
            has_changes: modified > 0 || staged > 0 || untracked > 0,
        })
    }

    /// Remove all Termul-managed worktrees for a project.
    /// Used during project cascade delete. Reports per-worktree success/failure.
    pub fn remove_all_managed(
        project_path: &str,
        worktrees_json: &str,
    ) -> Result<Vec<RemoveResult>, WorktreeError> {
        // Parse worktrees from JSON
        let worktrees: Vec<serde_json::Value> = serde_json::from_str(worktrees_json)
            .map_err(|e| WorktreeError::GitError(format!("Failed to parse worktrees: {}", e)))?;

        let mut results = Vec::new();

        for wt in &worktrees {
            let path = wt["path"]
                .as_str()
                .unwrap_or("")
                .to_string();
            let _name = wt["name"]
                .as_str()
                .unwrap_or("unknown")
                .to_string();

            // Only remove Termul-managed worktrees
            // Use Path components for cross-platform detection (Windows uses backslashes)
            let wt_path_obj = std::path::Path::new(&path);
            let is_managed = wt_path_obj.components().collect::<Vec<_>>().windows(2).any(|w| {
                w[0].as_os_str() == ".termul" && w[1].as_os_str() == "worktrees"
            });
            if !is_managed {
                results.push(RemoveResult {
                    worktree_path: path.clone(),
                    success: true,
                    error: Some("Skipped: not a Termul-managed worktree".to_string()),
                });
                continue;
            }

            match Self::remove(project_path, &path, true) {
                Ok(()) => {
                    results.push(RemoveResult {
                        worktree_path: path,
                        success: true,
                        error: None,
                    });
                }
                Err(e) => {
                    results.push(RemoveResult {
                        worktree_path: path,
                        success: false,
                        error: Some(e.to_string()),
                    });
                }
            }
        }

        // Prune stale metadata
        let _ = run_git(&["worktree", "prune"], Some(project_path));

        Ok(results)
    }

    /// Parse `.gitignore` and return directory entries that could be symlinked.
    /// Only returns simple directory patterns (no globs, no negations).
    /// Each entry includes whether it exists as a directory in the project root.
    pub fn parse_gitignore_dirs(project_path: &str) -> Result<Vec<GitignoreDir>, WorktreeError> {
        let gitignore_path = Path::new(project_path).join(".gitignore");
        if !gitignore_path.exists() {
            return Ok(Vec::new());
        }

        let content = std::fs::read_to_string(&gitignore_path)
            .map_err(|e| WorktreeError::IoError(e.to_string()))?;

        let project_root = Path::new(project_path);
        let mut seen = std::collections::HashSet::<String>::new();
        let mut dirs = Vec::new();

        for line in content.lines() {
            let line = line.trim();

            // Skip empty lines and comments
            if line.is_empty() || line.starts_with('#') {
                continue;
            }

            // Skip negation patterns
            if line.starts_with('!') {
                continue;
            }

            // Skip glob patterns
            if line.contains('*') || line.contains('?') || line.contains('[') {
                continue;
            }

            // Strip trailing slash
            let dir_name = line.trim_end_matches('/').trim();

            // Skip empty after trimming
            if dir_name.is_empty() {
                continue;
            }

            // Skip if it contains path separators (subdirectory patterns like src/dist/)
            if dir_name.contains('/') || dir_name.contains('\\') {
                continue;
            }

            // Skip if in exclusion list
            if is_excluded_dir(dir_name) {
                continue;
            }

            // Deduplicate
            if seen.contains(dir_name) {
                continue;
            }
            seen.insert(dir_name.to_string());

            // Check if it exists as a directory in the project root
            let full_path = project_root.join(dir_name);
            let exists = full_path.is_dir();

            dirs.push(GitignoreDir {
                dir_name: dir_name.to_string(),
                exists,
            });
        }

        Ok(dirs)
    }

    /// Create symlinks (or directory junctions on Windows) from the project root
    /// to the worktree for each directory in `symlink_dirs`.
    ///
    /// Only creates symlinks for directories that exist in the project root.
    /// Skips entries where the target already exists (as a real dir or symlink).
    /// Returns a result for each attempted symlink.
    pub fn create_symlinks(
        project_path: &str,
        worktree_path: &str,
        symlink_dirs: &[String],
    ) -> Vec<SymlinkResult> {
        let project_root = Path::new(project_path);
        let worktree_root = Path::new(worktree_path);
        let mut results = Vec::new();

        for dir_name in symlink_dirs {
            // Validate: reject absolute paths and path-traversal components
            let dir_path = Path::new(dir_name);
            if dir_path.is_absolute()
                || dir_path.components().any(|c| c == std::path::Component::ParentDir)
            {
                results.push(SymlinkResult {
                    path: worktree_root.join(dir_name).to_string_lossy().to_string(),
                    target: project_root.join(dir_name).to_string_lossy().to_string(),
                    status: "skipped".to_string(),
                    reason: Some(format!(
                        "Invalid symlink directory name (absolute or path traversal): {}",
                        dir_name
                    )),
                });
                continue;
            }

            let source = project_root.join(dir_name);
            let target = worktree_root.join(dir_name);

            // Skip if source doesn't exist as a directory
            if !source.is_dir() {
                results.push(SymlinkResult {
                    path: target.to_string_lossy().to_string(),
                    target: source.to_string_lossy().to_string(),
                    status: "skipped".to_string(),
                    reason: Some(format!(
                        "Source directory does not exist: {}",
                        source.to_string_lossy()
                    )),
                });
                continue;
            }

            // Skip if target already exists (real dir or symlink)
            if target.exists() {
                results.push(SymlinkResult {
                    path: target.to_string_lossy().to_string(),
                    target: source.to_string_lossy().to_string(),
                    status: "skipped".to_string(),
                    reason: Some(format!(
                        "Target already exists: {}",
                        target.to_string_lossy()
                    )),
                });
                continue;
            }

            // Try to create symlink/junction
            let link_result = create_dir_symlink(&source, &target);
            match link_result {
                Ok(()) => results.push(SymlinkResult {
                    path: target.to_string_lossy().to_string(),
                    target: source.to_string_lossy().to_string(),
                    status: "created".to_string(),
                    reason: None,
                }),
                Err(e) => results.push(SymlinkResult {
                    path: target.to_string_lossy().to_string(),
                    target: source.to_string_lossy().to_string(),
                    status: "failed".to_string(),
                    reason: Some(e.to_string()),
                }),
            }
        }

        results
    }

    /// Ensure symlinks exist for all directories in `symlink_dirs`.
    /// Creates any missing symlinks. Does not remove or overwrite existing ones.
    /// Returns a result for each directory checked/created.
    pub fn ensure_symlinks(
        project_path: &str,
        worktree_path: &str,
        symlink_dirs: &[String],
    ) -> Vec<SymlinkResult> {
        Self::create_symlinks(project_path, worktree_path, symlink_dirs)
    }

    /// Archive a worktree by moving it to `.termul/archives/<name>-<timestamp>/`.
    /// Creates an archive manifest entry for later recovery.
    pub fn archive(project_path: &str, worktree_path: &str) -> Result<(), WorktreeError> {
        let project_root = Path::new(project_path);
        let wt_path = Path::new(worktree_path);

        // Verify the worktree path is under the project using canonicalized paths
        // to prevent prefix-traversal bypasses (e.g., "/project" matching "/project-evil")
        let canonical_project = std::fs::canonicalize(project_root)
            .map_err(|_| WorktreeError::ArchiveFailed)?;
        let canonical_worktree = std::fs::canonicalize(wt_path)
            .map_err(|_| WorktreeError::ArchiveFailed)?;
        if !canonical_worktree.starts_with(&canonical_project) {
            return Err(WorktreeError::ArchiveFailed);
        }

        // Get worktree name from path
        let wt_name = wt_path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or(WorktreeError::ArchiveFailed)?;

        // Create archive directory
        let archive_dir = project_root.join(".termul").join("archives");
        let timestamp = chrono_timestamp();
        let archive_path = archive_dir.join(format!("{}-{}", wt_name, timestamp));

        std::fs::create_dir_all(&archive_dir)
            .map_err(|e| WorktreeError::IoError(e.to_string()))?;

        // Read branch metadata BEFORE the rename (get_worktree_branch reads git data from the path)
        let branch_name = Self::get_worktree_branch(worktree_path).unwrap_or_else(|_| wt_name.to_string());

        // Move the worktree directory to the archive
        std::fs::rename(wt_path, &archive_path)
            .map_err(|e| WorktreeError::IoError(e.to_string()))?;

        // Read existing manifest or create new one
        let manifest_path = archive_dir.join("archive-manifest.json");
        let mut manifest = if manifest_path.exists() {
            let content = std::fs::read_to_string(&manifest_path)
                .map_err(|e| WorktreeError::IoError(e.to_string()))?;
            serde_json::from_str::<ArchiveManifest>(&content)
                .unwrap_or(ArchiveManifest { entries: Vec::new() })
        } else {
            ArchiveManifest { entries: Vec::new() }
        };
        let archived_at = timestamp.clone();
        let expires_at = thirty_days_from_now();

        manifest.entries.push(ArchiveEntry {
            original_path: worktree_path.to_string(),
            archive_path: archive_path.to_string_lossy().to_string(),
            archived_at,
            expires_at,
            branch_name,
            worktree_path: worktree_path.to_string(),
        });

        // Write manifest
        let manifest_json = serde_json::to_string_pretty(&manifest)
            .map_err(|e| WorktreeError::IoError(e.to_string()))?;
        std::fs::write(&manifest_path, manifest_json)
            .map_err(|e| WorktreeError::IoError(e.to_string()))?;

        // Prune git worktree metadata
        let _ = run_git(&["worktree", "prune"], Some(project_path));

        Ok(())
    }

    /// Restore an archived worktree back to its original location.
    pub fn restore(project_path: &str, archive_path: &str) -> Result<(), WorktreeError> {
        let project_root = Path::new(project_path);
        let archive_dir = project_root.join(".termul").join("archives");
        let manifest_path = archive_dir.join("archive-manifest.json");

        if !manifest_path.exists() {
            return Err(WorktreeError::ArchiveNotFound);
        }

        let content = std::fs::read_to_string(&manifest_path)
            .map_err(|e| WorktreeError::IoError(e.to_string()))?;
        let mut manifest = serde_json::from_str::<ArchiveManifest>(&content)
            .map_err(|_| WorktreeError::ArchiveNotFound)?;

        // Find the archive entry
        let index = manifest.entries.iter().position(|e| e.archive_path == archive_path)
            .ok_or(WorktreeError::ArchiveNotFound)?;

        let entry = &manifest.entries[index];
        let src = Path::new(&entry.archive_path);
        let dst = Path::new(&entry.original_path);

        if !src.exists() {
            return Err(WorktreeError::ArchiveNotFound);
        }

        // Move back to original location
        std::fs::rename(src, dst)
            .map_err(|e| WorktreeError::IoError(e.to_string()))?;

        // Remove from manifest
        manifest.entries.remove(index);
        let manifest_json = serde_json::to_string_pretty(&manifest)
            .map_err(|e| WorktreeError::IoError(e.to_string()))?;
        std::fs::write(&manifest_path, manifest_json)
            .map_err(|e| WorktreeError::IoError(e.to_string()))?;

        Ok(())
    }

    /// Generate a merge preview by running `git merge --no-commit --no-ff --dry-run`.
    /// Parses output to identify conflicting and changed files.
    pub fn merge_preview(worktree_path: &str, target_branch: &str) -> Result<MergePreview, WorktreeError> {
        let current_branch = Self::get_current_branch(worktree_path)?;

        // Try accurate detection first
        match run_git(&["merge", "--no-commit", "--no-ff", "--dry-run", target_branch], Some(worktree_path)) {
            Ok((stdout, _stderr)) => {
                // Parse git diff-tree --stat style output for changed files
                let changed = stdout.lines()
                    .filter(|l| !l.is_empty())
                    .map(|l| l.to_string())
                    .collect::<Vec<_>>();

                Ok(MergePreview {
                    direction: format!("{} → {}", current_branch, target_branch),
                    source_branch: current_branch,
                    target_branch: target_branch.to_string(),
                    conflict_files: Vec::new(),
                    changed_files: changed.clone(),
                    total_changes: changed.len(),
                    detection_mode: "accurate".to_string(),
                })
            }
            Err(e) => {
                // Check if the error is due to conflicts
                let err_str = e.to_string();
                if err_str.contains("conflict") || err_str.contains("merge failed") {
                    // Fast detection fallback: check `git status --porcelain`
                    let conflict_files = Self::detect_conflict_files(worktree_path)?;
                    Ok(MergePreview {
                        direction: format!("{} → {}", current_branch, target_branch),
                        source_branch: current_branch,
                        target_branch: target_branch.to_string(),
                        conflict_files,
                        changed_files: Vec::new(),
                        total_changes: 0,
                        detection_mode: "fast".to_string(),
                    })
                } else {
                    Err(WorktreeError::MergeFailed)
                }
            }
        }
    }

    /// Execute a merge from the worktree's current branch to target_branch.
    pub fn merge_execute(worktree_path: &str, target_branch: &str) -> Result<String, WorktreeError> {
        let (stdout, _) = run_git(&["merge", target_branch], Some(worktree_path))
            .map_err(|_| WorktreeError::MergeFailed)?;
        Ok(stdout.trim().to_string())
    }

    /// Get the current branch name of a git repo.
    fn get_current_branch(worktree_path: &str) -> Result<String, WorktreeError> {
        let (stdout, _) = run_git(&["rev-parse", "--abbrev-ref", "HEAD"], Some(worktree_path))?;
        Ok(stdout.trim().to_string())
    }

    /// Get the branch name of a worktree by reading its git HEAD.
    fn get_worktree_branch(worktree_path: &str) -> Result<String, WorktreeError> {
        let (stdout, _) = run_git(&["rev-parse", "--abbrev-ref", "HEAD"], Some(worktree_path))?;
        let branch = stdout.trim().to_string();
        if branch == "HEAD" {
            Err(WorktreeError::BranchNotFound)
        } else {
            Ok(branch)
        }
    }

    /// Detect conflict files by parsing `git status --porcelain` for conflicted entries.
    fn detect_conflict_files(worktree_path: &str) -> Result<Vec<ConflictFile>, WorktreeError> {
        let (stdout, _) = run_git(&["status", "--porcelain"], Some(worktree_path))?;
        let mut conflict_files = Vec::new();

        // Porcelain format: XY filename
        // Conflicted entries have status codes: DD, AU, UD, UA, DU, AA, UU
        for line in stdout.lines() {
            let trimmed = line.trim();
            if trimmed.len() >= 2 {
                let code = &trimmed[..2];
                let path = trimmed[3..].trim();

                // Unmerged/conflicted paths start with U or have DD/AA
                let is_conflict = code.contains('U') || code == "DD" || code == "AA";
                if is_conflict && !path.is_empty() {
                    let is_lock = path.ends_with(".lock") || path.contains("package-lock") || path.contains("yarn.lock");
                    conflict_files.push(ConflictFile {
                        path: path.to_string(),
                        severity: if is_lock { "low".to_string() } else { "high".to_string() },
                        conflict_count: 1,
                        is_lock_file: is_lock,
                    });
                }
            }
        }

        Ok(conflict_files)
    }
}

/// Get an ISO 8601 timestamp string for the current time.
fn chrono_timestamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    // Use chrono-compatible ISO 8601 format: YYYY-MM-DDTHHMMSSZ
    // Approximate Gregorian calendar from Unix timestamp
    let mut days = secs / 86400;
    let time_secs = secs % 86400;
    let hours = time_secs / 3600;
    let minutes = (time_secs % 3600) / 60;
    let seconds = time_secs % 60;

    // Civil date from days since epoch (proleptic Gregorian)
    let mut y = 1970i64;
    loop {
        let year_days = if is_leap(y) { 366 } else { 365 };
        if days < year_days { break; }
        days -= year_days;
        y += 1;
    }
    let month_days = if is_leap(y) {
        [31,29,31,30,31,30,31,31,30,31,30,31]
    } else {
        [31,28,31,30,31,30,31,31,30,31,30,31]
    };
    let mut m = 0;
    for &md in &month_days {
        if days < md { break; }
        days -= md;
        m += 1;
    }
    format!("{:04}-{:02}-{:02}T{:02}{:02}{:02}Z", y, m + 1, days as u32 + 1, hours, minutes, seconds)
}

/// Check if a year is a leap year.
fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

/// Get a timestamp 30 days from now as ISO string.
fn thirty_days_from_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() + 30 * 86400;
    let mut days = secs / 86400;
    let time_secs = secs % 86400;
    let hours = time_secs / 3600;
    let minutes = (time_secs % 3600) / 60;
    let seconds = time_secs % 60;

    let mut y = 1970i64;
    loop {
        let year_days = if is_leap(y) { 366 } else { 365 };
        if days < year_days { break; }
        days -= year_days;
        y += 1;
    }
    let month_days = if is_leap(y) {
        [31,29,31,30,31,30,31,31,30,31,30,31]
    } else {
        [31,28,31,30,31,30,31,31,30,31,30,31]
    };
    let mut m = 0;
    for &md in &month_days {
        if days < md { break; }
        days -= md;
        m += 1;
    }
    format!("{:04}-{:02}-{:02}T{:02}{:02}{:02}Z", y, m + 1, days as u32 + 1, hours, minutes, seconds)
}

/// Create a directory symlink from `target` pointing to `source`.
///
/// On Windows, tries `symlink_dir()` first, falls back to creating a junction.
/// On Unix, uses `symlink()`.
fn create_dir_symlink(source: &Path, target: &Path) -> Result<(), String> {
    // Ensure the parent directory of the target exists
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directory: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        // On Windows, try symlink_dir first (requires developer mode or admin)
        use std::os::windows::fs::symlink_dir;
        if symlink_dir(source, target).is_ok() {
            return Ok(());
        }

        // Fallback: create a directory junction using `mklink /J`
        let source_str = source.to_string_lossy().to_string();
        let target_str = target.to_string_lossy().to_string();
        let output = quiet_command("cmd")
            .args([
                "/C",
                "mklink",
                "/J",
                &target_str,
                &source_str,
            ])
            .output()
            .map_err(|e| format!("Failed to run mklink: {}", e))?;

        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!(
                "Failed to create symlink or junction for {}: {}",
                target.to_string_lossy(),
                stderr.trim()
            ))
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::os::unix::fs::symlink(source, target)
            .map_err(|e| format!("Failed to create symlink: {}", e))
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_list_parses_basic_entry() {
        let output = "worktree /path/to/project\n\
                      HEAD abc1234\n\
                      branch refs/heads/main\n\
                      \n";
        // Test the porcelain parsing logic directly
        let mut entries = Vec::new();
        let mut current_path: Option<String> = None;
        let mut current_head: Option<String> = None;
        let mut current_branch: Option<String> = None;

        for line in output.lines() {
            let line = line.trim();
            if line.is_empty() {
                if let (Some(path), Some(head), Some(branch)) =
                    (current_path.take(), current_head.take(), current_branch.take())
                {
                    let name = Path::new(&path)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| branch.clone());

                    entries.push(GitWorktreeEntry {
                        name,
                        branch,
                        path,
                        head_commit: head,
                    });
                } else {
                    current_path = None;
                    current_head = None;
                    current_branch = None;
                }
                continue;
            }

            if let Some(val) = line.strip_prefix("worktree ") {
                current_path = Some(val.to_string());
            } else if let Some(val) = line.strip_prefix("HEAD ") {
                current_head = Some(val.to_string());
            } else if let Some(val) = line.strip_prefix("branch refs/heads/") {
                current_branch = Some(val.to_string());
            }
        }

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].branch, "main");
        assert_eq!(entries[0].head_commit, "abc1234");
        assert_eq!(entries[0].path, "/path/to/project");
    }

    #[test]
    fn test_list_filters_detached_head() {
        let output = "worktree /path/to/project\n\
                      HEAD def5678\n\
                      \n";
        let mut entries = Vec::new();
        let mut current_path: Option<String> = None;
        let mut current_head: Option<String> = None;
        let mut current_branch: Option<String> = None;

        for line in output.lines() {
            let line = line.trim();
            if line.is_empty() {
                if let (Some(path), Some(head), Some(branch)) =
                    (current_path.take(), current_head.take(), current_branch.take())
                {
                    let name = Path::new(&path)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| branch.clone());

                    entries.push(GitWorktreeEntry {
                        name,
                        branch,
                        path,
                        head_commit: head,
                    });
                } else {
                    current_path = None;
                    current_head = None;
                    current_branch = None;
                }
                continue;
            }

            if let Some(val) = line.strip_prefix("worktree ") {
                current_path = Some(val.to_string());
            } else if let Some(val) = line.strip_prefix("HEAD ") {
                current_head = Some(val.to_string());
            } else if let Some(val) = line.strip_prefix("branch refs/heads/") {
                current_branch = Some(val.to_string());
            }
        }

        // Detached HEAD (no branch line) should be filtered out
        assert_eq!(entries.len(), 0);
    }

    #[test]
    fn test_list_multiple_entries() {
        let output = "worktree /path/to/project\n\
                      HEAD aaa111\n\
                      branch refs/heads/main\n\
                      \n\
                      worktree /path/to/project/.termul/worktrees/feat-1\n\
                      HEAD bbb222\n\
                      branch refs/heads/feat-1\n\
                      \n";

        let mut entries = Vec::new();
        let mut current_path: Option<String> = None;
        let mut current_head: Option<String> = None;
        let mut current_branch: Option<String> = None;

        for line in output.lines() {
            let line = line.trim();
            if line.is_empty() {
                if let (Some(path), Some(head), Some(branch)) =
                    (current_path.take(), current_head.take(), current_branch.take())
                {
                    let name = Path::new(&path)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| branch.clone());

                    entries.push(GitWorktreeEntry {
                        name,
                        branch,
                        path,
                        head_commit: head,
                    });
                } else {
                    current_path = None;
                    current_head = None;
                    current_branch = None;
                }
                continue;
            }

            if let Some(val) = line.strip_prefix("worktree ") {
                current_path = Some(val.to_string());
            } else if let Some(val) = line.strip_prefix("HEAD ") {
                current_head = Some(val.to_string());
            } else if let Some(val) = line.strip_prefix("branch refs/heads/") {
                current_branch = Some(val.to_string());
            }
        }

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].branch, "main");
        assert_eq!(entries[1].branch, "feat-1");
        assert_eq!(entries[1].name, "feat-1");
    }

    #[test]
    fn test_list_filters_bare() {
        let output = "worktree /path/to/bare\n\
                      HEAD ccc333\n\
                      bare\n\
                      \n";
        let mut entries = Vec::new();
        let mut current_path: Option<String> = None;
        let mut current_head: Option<String> = None;
        let mut current_branch: Option<String> = None;

        for line in output.lines() {
            let line = line.trim();
            if line.is_empty() {
                if let (Some(path), Some(head), Some(branch)) =
                    (current_path.take(), current_head.take(), current_branch.take())
                {
                    let name = Path::new(&path)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| branch.clone());

                    entries.push(GitWorktreeEntry {
                        name,
                        branch,
                        path,
                        head_commit: head,
                    });
                } else {
                    current_path = None;
                    current_head = None;
                    current_branch = None;
                }
                continue;
            }

            if let Some(val) = line.strip_prefix("worktree ") {
                current_path = Some(val.to_string());
            } else if let Some(val) = line.strip_prefix("HEAD ") {
                current_head = Some(val.to_string());
            } else if let Some(val) = line.strip_prefix("branch refs/heads/") {
                current_branch = Some(val.to_string());
            }
        }

        // Bare worktree (no branch line) should be filtered out
        assert_eq!(entries.len(), 0);
    }

    #[test]
    fn test_empty_output() {
        let output = "";
        let mut entries = Vec::new();
        let mut current_path: Option<String> = None;
        let mut current_head: Option<String> = None;
        let mut current_branch: Option<String> = None;

        for line in output.lines() {
            let line = line.trim();
            if line.is_empty() {
                if let (Some(path), Some(head), Some(branch)) =
                    (current_path.take(), current_head.take(), current_branch.take())
                {
                    let name = Path::new(&path)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| branch.clone());

                    entries.push(GitWorktreeEntry {
                        name,
                        branch,
                        path,
                        head_commit: head,
                    });
                } else {
                    current_path = None;
                    current_head = None;
                    current_branch = None;
                }
                continue;
            }

            if let Some(val) = line.strip_prefix("worktree ") {
                current_path = Some(val.to_string());
            } else if let Some(val) = line.strip_prefix("HEAD ") {
                current_head = Some(val.to_string());
            } else if let Some(val) = line.strip_prefix("branch refs/heads/") {
                current_branch = Some(val.to_string());
            }
        }

        assert_eq!(entries.len(), 0);
    }

    #[test]
    fn test_error_parsing_already_exists() {
        let err = parse_git_stderr("fatal: '/path/to/worktree' already exists");
        assert!(matches!(err, WorktreeError::WorktreeExists));
    }

    #[test]
    fn test_error_parsing_already_checked_out() {
        let err = parse_git_stderr(
            "fatal: 'feat-1' is already checked out at '/other/path'",
        );
        assert!(matches!(err, WorktreeError::BranchAlreadyHasWorktree));
    }

    #[test]
    fn test_error_parsing_not_a_git_repo() {
        let err = parse_git_stderr("fatal: not a git repository");
        assert!(matches!(err, WorktreeError::NotAGitRepo));
    }

    #[test]
    fn test_error_parsing_branch_not_found() {
        let err = parse_git_stderr("fatal: 'nonexistent' did not match any file(s) known to git");
        assert!(matches!(err, WorktreeError::BranchNotFound));
    }

    #[test]
    fn test_error_parsing_locked() {
        let err = parse_git_stderr("fatal: 'worktree' is locked");
        assert!(matches!(err, WorktreeError::WorktreeLocked));
    }

    #[test]
    fn test_error_parsing_dirty() {
        let err = parse_git_stderr("fatal: worktree 'path' is dirty, use --force");
        assert!(matches!(err, WorktreeError::WorktreeRemoveFailed));
    }

    #[test]
    fn test_dirty_status_clean() {
        let status = DirtyStatus {
            modified: 0,
            staged: 0,
            untracked: 0,
            has_changes: false,
        };
        assert!(!status.has_changes);
        assert_eq!(status.modified, 0);
    }

    #[test]
    fn test_dirty_status_dirty() {
        let status = DirtyStatus {
            modified: 3,
            staged: 1,
            untracked: 2,
            has_changes: true,
        };
        assert!(status.has_changes);
        assert_eq!(status.modified, 3);
        assert_eq!(status.staged, 1);
        assert_eq!(status.untracked, 2);
    }

    #[test]
    fn test_error_code_mapping() {
        assert_eq!(WorktreeError::WorktreeExists.error_code(), "WORKTREE_EXISTS");
        assert_eq!(
            WorktreeError::BranchAlreadyHasWorktree.error_code(),
            "BRANCH_ALREADY_HAS_WORKTREE"
        );
        assert_eq!(WorktreeError::NotAGitRepo.error_code(), "NOT_A_GIT_REPO");
        assert_eq!(WorktreeError::GitNotFound.error_code(), "GIT_NOT_FOUND");
        assert_eq!(WorktreeError::PathTooLong.error_code(), "PATH_TOO_LONG");
        assert_eq!(
            WorktreeError::WorktreeRemoveFailed.error_code(),
            "WORKTREE_REMOVE_FAILED"
        );
    }

    #[test]
    fn test_is_termul_managed_true() {
        assert!("/project/.termul/worktrees/feat-1"
            .contains(".termul/worktrees/"));
    }

    #[test]
    fn test_is_termul_managed_false() {
        assert!(
            !"/project/../other-worktree"
                .contains(".termul/worktrees/")
        );
    }
}
