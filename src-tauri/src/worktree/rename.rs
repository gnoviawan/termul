//! Worktree branch rename (story 16, CAP-5). The only git logic for the
//! feature: transports and the ACP host call [`WorktreeManager::rename_branch`].

use super::*;

impl WorktreeManager {
    /// Rename `old` to `new` for the worktree at `worktree_path` with
    /// `git branch -m <old> <new>` (never `-M`: an existing target is refused,
    /// not overwritten).
    ///
    /// Guards, in order: `new` must be a valid branch name
    /// (`INVALID_BRANCH_NAME`), the worktree's CURRENT branch must still equal
    /// `old` (`BRANCH_CHANGED`, which also covers detached HEAD and a branch
    /// switched or mid-rebase), and `refs/heads/<new>` must not exist
    /// (`BRANCH_EXISTS`).
    pub fn rename_branch(worktree_path: &str, old: &str, new: &str) -> Result<(), WorktreeError> {
        if old.is_empty() || old.starts_with('-') {
            return Err(WorktreeError::InvalidBranchName);
        }
        ensure_valid_branch_name(new, worktree_path)?;

        // `-q` keeps a detached HEAD silent: exit 1 with no message, which
        // `run_git` surfaces as an empty `GitError`.
        let current = match run_git(
            &["symbolic-ref", "--short", "-q", "HEAD"],
            Some(worktree_path),
        ) {
            Ok((stdout, _)) => stdout.trim().to_string(),
            Err(WorktreeError::GitError(_)) => return Err(WorktreeError::BranchChanged),
            Err(other) => return Err(other),
        };
        if current != old {
            return Err(WorktreeError::BranchChanged);
        }

        let target_ref = format!("refs/heads/{new}");
        match run_git(
            &["show-ref", "--verify", "--quiet", &target_ref],
            Some(worktree_path),
        ) {
            Ok(_) => return Err(WorktreeError::BranchExists),
            Err(WorktreeError::GitError(_)) => {}
            Err(other) => return Err(other),
        }

        run_git(&["branch", "-m", old, new], Some(worktree_path)).map(|_| ())
    }
}
