use super::{validate_project_path, IpcResult};
use crate::acp::destructive_guard::{ensure_no_active_turn_in_checkout, start_ref_rewrites_tree};
use crate::acp::AcpManager;
use crate::trackers::git_tracker::{DiffStatError, GitDiffStat};
use crate::trackers::{GitCommit, GitStatusDetail};
use std::sync::Arc;
use tauri::State;

// ==================== Git Commands ====================

/// Get git status for a repository
#[tauri::command]
pub async fn git_get_status(cwd: String) -> Result<Vec<GitStatusDetail>, String> {
    crate::trackers::git_tracker::git_get_status_detail(&cwd).map_err(|e: String| e)
}

/// Get git diff for a file. `staged` selects the index-vs-HEAD diff
/// (`git diff --cached`) instead of the worktree-vs-index diff.
#[tauri::command]
pub async fn git_get_diff(
    cwd: String,
    path: String,
    staged: Option<bool>,
) -> Result<String, String> {
    crate::trackers::git_tracker::git_get_diff(&cwd, &path, staged.unwrap_or(false))
        .map_err(|e: String| e)
}

/// Working-tree `+added -removed` line stat for the repository at `cwd`
/// (tracked changes against HEAD plus untracked files). Read-only; the same
/// shared function backs `POST /git/diff-stat`. Failures surface as
/// `IpcResult::error(.., DiffStatError::code())`.
#[tauri::command]
pub async fn git_get_diff_stat(cwd: String) -> Result<IpcResult<GitDiffStat>, String> {
    let cwd = match validate_project_path(&cwd) {
        Ok(path) => path.to_string_lossy().into_owned(),
        Err(e) => {
            log::warn!("[git_get_diff_stat] invalid cwd: {e}");
            return Ok(IpcResult::error(e, "PATH_VALIDATION_FAILED"));
        }
    };
    let result: Result<GitDiffStat, DiffStatError> =
        tokio::task::spawn_blocking(move || crate::trackers::git_tracker::git_get_diff_stat(&cwd))
            .await
            .map_err(|e| format!("git diff stat task failed: {e}"))?;
    Ok(match result {
        Ok(stat) => IpcResult::success(stat),
        Err(e) => IpcResult::error(e.to_string(), e.code()),
    })
}

/// Stage a single file (`git add`).
#[tauri::command]
pub async fn git_stage(cwd: String, path: String) -> Result<(), String> {
    crate::trackers::git_tracker::git_stage_file(&cwd, &path).map_err(|e: String| e)
}

/// Unstage a single file (`git restore --staged`).
#[tauri::command]
pub async fn git_unstage(cwd: String, path: String) -> Result<(), String> {
    crate::trackers::git_tracker::git_unstage_file(&cwd, &path).map_err(|e: String| e)
}

/// Stage a single hunk. `hunk_patch` is a unified-diff fragment
/// (`--- a/<path>` / `+++ b/<path>` / `@@ … @@` / body) built by the
/// renderer from the working-tree diff. See #257.
#[tauri::command]
pub async fn git_stage_hunk(cwd: String, path: String, hunk_patch: String) -> Result<(), String> {
    crate::trackers::git_tracker::git_stage_hunk(&cwd, &path, &hunk_patch)
}

/// Unstage a single hunk. `hunk_patch` is built from the staged diff and
/// reverse-applied to the index. See #257.
#[tauri::command]
pub async fn git_unstage_hunk(cwd: String, path: String, hunk_patch: String) -> Result<(), String> {
    crate::trackers::git_tracker::git_unstage_hunk(&cwd, &path, &hunk_patch)
}

/// Discard changes to a single file. Untracked files are deleted; tracked
/// changes revert to HEAD. This is destructive and irreversible.
#[tauri::command]
pub async fn git_discard(cwd: String, path: String) -> Result<(), String> {
    crate::trackers::git_tracker::git_discard_file(&cwd, &path).map_err(|e: String| e)
}

/// Read commit history for the repository at `cwd` as structured rows for the
/// history/graph view. `limit` caps the number of commits (clamped backend-side;
/// defaults to 200). Read-only.
#[tauri::command]
pub async fn git_get_log(cwd: String, limit: Option<u32>) -> Result<Vec<GitCommit>, String> {
    crate::trackers::git_tracker::git_get_log(&cwd, limit).map_err(|e: String| e)
}

/// Create a commit from the staged index. `amend` rewrites HEAD instead of
/// adding a new commit. The message is passed via a temp file, not `-m`.
#[tauri::command]
pub async fn git_commit(
    cwd: String,
    summary: String,
    description: Option<String>,
    amend: Option<bool>,
) -> Result<(), String> {
    // git_commit_file runs `git commit` (which can block on hooks / GPG prompts
    // for up to the network timeout), so run it on the blocking thread pool
    // instead of the async executor.
    let description = description.unwrap_or_default();
    let amend = amend.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        crate::trackers::git_tracker::git_commit_file(&cwd, &summary, &description, amend)
    })
    .await
    .map_err(|e| format!("git commit task failed: {e}"))?
}

/// Push the current branch to `origin`, setting upstream when none exists.
#[tauri::command]
pub async fn git_push(cwd: String) -> Result<(), String> {
    // git_push_current performs a network push (up to the network timeout), so
    // run it on the blocking thread pool instead of the async executor.
    tauri::async_runtime::spawn_blocking(move || {
        crate::trackers::git_tracker::git_push_current(&cwd)
    })
    .await
    .map_err(|e| format!("git push task failed: {e}"))?
}

/// Get commit-footer context: branch, upstream, ahead/behind, staged count,
/// and the last commit's subject/body (for prefilling an amend).
#[tauri::command]
pub async fn git_get_commit_context(
    cwd: String,
) -> Result<crate::trackers::git_tracker::GitCommitContext, String> {
    crate::trackers::git_tracker::git_get_commit_context(&cwd).map_err(|e: String| e)
}

#[tauri::command]
pub async fn git_init(cwd: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let output = crate::trackers::git_tracker::GitTracker::run_git_command(&cwd, &["init"])
            .ok_or_else(|| "Failed to run git init".to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    })
    .await
    .map_err(|e| format!("git init task failed: {e}"))?
}

/// Check out an existing local or remote-tracking branch. Refused with a
/// `destructive_op_blocked: …` error while a session working inside the work
/// tree is mid-turn (identical text on the HTTP route).
#[tauri::command]
pub async fn git_checkout_branch(
    manager: State<'_, Arc<AcpManager>>,
    cwd: String,
    branch: String,
    is_remote: Option<bool>,
) -> Result<(), String> {
    checkout_branch_guarded(&manager, cwd, branch, is_remote.unwrap_or(false)).await
}

/// Body of [`git_checkout_branch`] (guard, then checkout) taking the manager
/// directly so tests can drive the desktop entry point without a Tauri app.
pub(crate) async fn checkout_branch_guarded(
    acp: &AcpManager,
    cwd: String,
    branch: String,
    is_remote: bool,
) -> Result<(), String> {
    ensure_no_active_turn_in_checkout(acp, std::path::Path::new(&cwd))
        .await
        .map_err(|blocked| blocked.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::trackers::git_tracker::git_checkout_branch(&cwd, &branch, is_remote)
    })
    .await
    .map_err(|e| format!("git checkout task failed: {e}"))?
}

/// Create a new branch from `start_ref` (defaults to HEAD) and check it out.
/// A start ref other than HEAD is refused with `destructive_op_blocked: …`
/// while a session working inside the work tree is mid-turn.
#[tauri::command]
pub async fn git_create_branch(
    manager: State<'_, Arc<AcpManager>>,
    cwd: String,
    branch: String,
    start_ref: Option<String>,
) -> Result<(), String> {
    create_branch_guarded(&manager, cwd, branch, start_ref).await
}

/// Body of [`git_create_branch`], see [`checkout_branch_guarded`].
pub(crate) async fn create_branch_guarded(
    acp: &AcpManager,
    cwd: String,
    branch: String,
    start_ref: Option<String>,
) -> Result<(), String> {
    // Branching from HEAD leaves the work tree alone; branching from another
    // `start_ref` checks that ref out, which rewrites it.
    if start_ref_rewrites_tree(start_ref.as_deref()) {
        ensure_no_active_turn_in_checkout(acp, std::path::Path::new(&cwd))
            .await
            .map_err(|blocked| blocked.to_string())?;
    }
    tauri::async_runtime::spawn_blocking(move || {
        crate::trackers::git_tracker::git_create_branch(&cwd, &branch, start_ref.as_deref())
    })
    .await
    .map_err(|e| format!("git create branch task failed: {e}"))?
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStashInfo {
    pub index: usize,
    pub name: String,
    pub message: String,
}

#[tauri::command]
pub async fn git_stash_save(
    cwd: String,
    message: Option<String>,
    include_untracked: Option<bool>,
) -> Result<(), String> {
    let validated = validate_project_path(&cwd)?;
    let validated_str = validated
        .to_str()
        .ok_or_else(|| "Path contains invalid UTF-8".to_string())?
        .to_string();

    tauri::async_runtime::spawn_blocking(move || {
        let mut args = vec!["stash", "push"];
        if let Some(true) = include_untracked {
            args.push("-u");
        }
        let msg;
        if let Some(ref m) = message {
            args.push("-m");
            msg = m.clone();
            args.push(&msg);
        }
        let output =
            crate::trackers::git_tracker::GitTracker::run_git_command(&validated_str, &args)
                .ok_or_else(|| "Failed to run git stash push".to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    })
    .await
    .map_err(|e| format!("git stash push task failed: {e}"))?
}

#[tauri::command]
pub async fn git_stash_list(cwd: String) -> Result<Vec<GitStashInfo>, String> {
    let validated = validate_project_path(&cwd)?;
    let validated_str = validated
        .to_str()
        .ok_or_else(|| "Path contains invalid UTF-8".to_string())?
        .to_string();

    tauri::async_runtime::spawn_blocking(move || {
        let output = crate::trackers::git_tracker::GitTracker::run_git_command(
            &validated_str,
            &["stash", "list"],
        )
        .ok_or_else(|| "Failed to run git stash list".to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut stashes = Vec::new();
        for line in stdout.lines() {
            if let Some((stash_part, rest)) = line.split_once(':') {
                let name = stash_part.trim().to_string();
                if let Some(start) = name.find('{') {
                    if let Some(end) = name.find('}') {
                        if let Ok(index) = name[start + 1..end].parse::<usize>() {
                            let message = rest.trim().to_string();
                            stashes.push(GitStashInfo {
                                index,
                                name,
                                message,
                            });
                        }
                    }
                }
            }
        }
        Ok(stashes)
    })
    .await
    .map_err(|e| format!("git stash list task failed: {e}"))?
}

#[tauri::command]
pub async fn git_stash_apply(cwd: String, index: usize) -> Result<(), String> {
    let validated = validate_project_path(&cwd)?;
    let validated_str = validated
        .to_str()
        .ok_or_else(|| "Path contains invalid UTF-8".to_string())?
        .to_string();

    tauri::async_runtime::spawn_blocking(move || {
        let stash_ref = format!("stash@{{{}}}", index);
        let output = crate::trackers::git_tracker::GitTracker::run_git_command(
            &validated_str,
            &["stash", "apply", &stash_ref],
        )
        .ok_or_else(|| "Failed to run git stash apply".to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    })
    .await
    .map_err(|e| format!("git stash apply task failed: {e}"))?
}

#[tauri::command]
pub async fn git_stash_pop(cwd: String, index: usize) -> Result<(), String> {
    let validated = validate_project_path(&cwd)?;
    let validated_str = validated
        .to_str()
        .ok_or_else(|| "Path contains invalid UTF-8".to_string())?
        .to_string();

    tauri::async_runtime::spawn_blocking(move || {
        let stash_ref = format!("stash@{{{}}}", index);
        let output = crate::trackers::git_tracker::GitTracker::run_git_command(
            &validated_str,
            &["stash", "pop", &stash_ref],
        )
        .ok_or_else(|| "Failed to run git stash pop".to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    })
    .await
    .map_err(|e| format!("git stash pop task failed: {e}"))?
}

#[tauri::command]
pub async fn git_stash_drop(cwd: String, index: usize) -> Result<(), String> {
    let validated = validate_project_path(&cwd)?;
    let validated_str = validated
        .to_str()
        .ok_or_else(|| "Path contains invalid UTF-8".to_string())?
        .to_string();

    tauri::async_runtime::spawn_blocking(move || {
        let stash_ref = format!("stash@{{{}}}", index);
        let output = crate::trackers::git_tracker::GitTracker::run_git_command(
            &validated_str,
            &["stash", "drop", &stash_ref],
        )
        .ok_or_else(|| "Failed to run git stash drop".to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    })
    .await
    .map_err(|e| format!("git stash drop task failed: {e}"))?
}

#[tauri::command]
pub async fn git_branch_list(cwd: String) -> Result<Vec<String>, String> {
    let validated = validate_project_path(&cwd)?;
    let validated_str = validated
        .to_str()
        .ok_or_else(|| "Path contains invalid UTF-8".to_string())?
        .to_string();

    tauri::async_runtime::spawn_blocking(move || {
        let output = crate::trackers::git_tracker::GitTracker::run_git_command(
            &validated_str,
            &["branch", "-a", "--format=%(refname:short)"],
        )
        .ok_or_else(|| "Failed to run git branch".to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut branches = Vec::new();
        for line in stdout.lines() {
            let name = line.trim();
            if !name.is_empty() {
                branches.push(name.to_string());
            }
        }
        Ok(branches)
    })
    .await
    .map_err(|e| format!("git branch list task failed: {e}"))?
}

/// `git checkout <name>`. Refused with a `destructive_op_blocked: …` error
/// while a session working inside the work tree is mid-turn.
#[tauri::command]
pub async fn git_branch_switch(
    manager: State<'_, Arc<AcpManager>>,
    cwd: String,
    name: String,
) -> Result<(), String> {
    branch_switch_guarded(&manager, cwd, name).await
}

/// Body of [`git_branch_switch`], see [`checkout_branch_guarded`].
pub(crate) async fn branch_switch_guarded(
    acp: &AcpManager,
    cwd: String,
    name: String,
) -> Result<(), String> {
    let validated = validate_project_path(&cwd)?;
    ensure_no_active_turn_in_checkout(acp, &validated)
        .await
        .map_err(|blocked| blocked.to_string())?;
    let validated_str = validated
        .to_str()
        .ok_or_else(|| "Path contains invalid UTF-8".to_string())?
        .to_string();

    tauri::async_runtime::spawn_blocking(move || {
        let output = crate::trackers::git_tracker::GitTracker::run_git_command(
            &validated_str,
            &["checkout", &name],
        )
        .ok_or_else(|| "Failed to run git checkout".to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    })
    .await
    .map_err(|e| format!("git branch switch task failed: {e}"))?
}

#[tauri::command]
pub async fn git_branch_create(cwd: String, name: String) -> Result<(), String> {
    let validated = validate_project_path(&cwd)?;
    let validated_str = validated
        .to_str()
        .ok_or_else(|| "Path contains invalid UTF-8".to_string())?
        .to_string();

    tauri::async_runtime::spawn_blocking(move || {
        let output = crate::trackers::git_tracker::GitTracker::run_git_command(
            &validated_str,
            &["checkout", "-b", &name],
        )
        .ok_or_else(|| "Failed to run git checkout -b".to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    })
    .await
    .map_err(|e| format!("git branch create task failed: {e}"))?
}

#[cfg(test)]
mod guard_tests;
