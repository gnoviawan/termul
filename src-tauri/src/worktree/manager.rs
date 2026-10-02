use std::path::Path;

use super::*;

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
                if let (Some(path), Some(head), Some(branch)) = (
                    current_path.take(),
                    current_head.take(),
                    current_branch.take(),
                ) {
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
        if let (Some(path), Some(head), Some(branch)) = (current_path, current_head, current_branch)
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
    /// - `on_progress` receives each git stderr line live (`Preparing worktree…`,
    ///   `HEAD is now at…`). Checkout percent counters (`Updating files: N%`)
    ///   only appear when git emits them on its own — no flag forces them while
    ///   stderr is piped, so callers must tolerate a run with no `N%` lines.
    pub fn create(
        project_path: &str,
        name: &str,
        branch: &str,
        is_new_branch: bool,
        start_ref: Option<&str>,
        target_path: Option<&str>,
        on_progress: Option<&mut dyn FnMut(&str)>,
    ) -> Result<GitWorktreeEntry, WorktreeError> {
        let target = match target_path {
            Some(p) => p.to_string(),
            None => format!(
                "{}/.termul/worktrees/{}/",
                project_path.trim_end_matches('/'),
                name
            ),
        };

        // Boundary log: record the create inputs before ANY early return so
        // every failure mode (path-length guard, list/pre-check error, branch
        // collision, git failure) leaves a diagnosable record in termul.log.
        // `{:?}` quotes and escapes control characters — name/branch/target
        // are renderer-controlled, so a raw `{}` would let a `\n` forge log
        // lines.
        log::info!(
            "[worktree-create] project={:?} name={:?} branch={:?} is_new_branch={} start_ref={:?} target={:?}",
            project_path,
            name,
            branch,
            is_new_branch,
            start_ref,
            target
        );
        let log_failure = |error: &WorktreeError| {
            log::warn!(
                "[worktree-create] failed project={:?} name={:?} branch={:?} code={} error={:?}",
                project_path,
                name,
                branch,
                error.error_code(),
                error
            );
        };

        // Validate path length (Windows MAX_PATH guard)
        let target_path_obj = Path::new(&target);
        let target_str = target_path_obj.to_string_lossy();
        if target_str.len() > 200 {
            log_failure(&WorktreeError::PathTooLong);
            return Err(WorktreeError::PathTooLong);
        }

        // Pre-check: does this branch already have a worktree?
        let existing = match Self::list(project_path) {
            Ok(entries) => entries,
            Err(error) => {
                log_failure(&error);
                return Err(error);
            }
        };
        if existing.iter().any(|e| e.branch == branch) {
            log_failure(&WorktreeError::BranchAlreadyHasWorktree);
            return Err(WorktreeError::BranchAlreadyHasWorktree);
        }

        let args = worktree_add_args(branch, is_new_branch, &target, start_ref);

        let git_result = match on_progress {
            Some(callback) => run_git_streaming(&args, Some(project_path), callback),
            None => run_git(&args, Some(project_path)),
        };
        if let Err(ref error) = git_result {
            log_failure(error);
        }
        git_result?;

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
    pub fn remove(
        project_path: &str,
        worktree_path: &str,
        force: bool,
    ) -> Result<(), WorktreeError> {
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
        let (top_stdout, _) = run_git(&["rev-parse", "--show-toplevel"], Some(project_path))?;
        let current_worktree = top_stdout.trim().to_string();

        let worktree_branches: std::collections::HashMap<String, String> = Self::list(project_path)
            .unwrap_or_default()
            .into_iter()
            .map(|entry| (entry.branch, entry.path))
            .collect();

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
        let (current_stdout, _) = run_git(&["branch", "--show-current"], Some(project_path))?;
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

            let has_other_worktree = worktree_branches
                .get(&name)
                .map(|path| path != &current_worktree)
                .unwrap_or(false);

            entries.push(BranchEntry {
                is_current: name == current_branch,
                is_remote: false,
                upstream,
                has_other_worktree,
                name,
            });
        }

        // Get remote branches
        let (remote_stdout, _) = run_git(
            &["branch", "--remote", "--list", "--format=%(refname:short)"],
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
                    has_other_worktree: false,
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
                // Working tree. F-016: `git status --porcelain` uses `!!`
                // for IGNORED entries — ignored files are neither untracked
                // changes nor a dirty state (a worktree with only ignored
                // build output is clean). Counting `!` inflated
                // `untracked`/`has_changes` for every ignored dir.
                match chars[1] {
                    'M' | 'A' | 'D' | 'R' | 'C' => modified += 1,
                    '?' => untracked += 1,
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
            let path = wt["path"].as_str().unwrap_or("").to_string();
            let _name = wt["name"].as_str().unwrap_or("unknown").to_string();

            // Only remove Termul-managed worktrees
            // Use Path components for cross-platform detection (Windows uses backslashes)
            let wt_path_obj = std::path::Path::new(&path);
            let is_managed = wt_path_obj
                .components()
                .collect::<Vec<_>>()
                .windows(2)
                .any(|w| w[0].as_os_str() == ".termul" && w[1].as_os_str() == "worktrees");
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
                || dir_path
                    .components()
                    .any(|c| c == std::path::Component::ParentDir)
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
}
