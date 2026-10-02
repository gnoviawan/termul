use super::{validate_project_path, IpcResult};
use crate::worktree::{
    BaseBranchInfo, BranchEntry, DirtyStatus, GitWorktreeEntry, IncludeCopyResult, RemoveResult,
    WorktreeManager,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

// ==================== Worktree Commands ====================

/// List all worktrees for a git repo at the given path.
/// Filters out bare worktrees and detached-HEAD worktrees.
#[tauri::command]
pub async fn worktree_list(project_path: String) -> Result<IpcResult<Vec<WorktreeInfo>>, String> {
    let validated_path = validate_and_stringify!(&project_path);
    match WorktreeManager::list(&validated_path) {
        Ok(entries) => {
            let infos: Vec<WorktreeInfo> = entries
                .into_iter()
                .map(|e| WorktreeInfo {
                    name: e.name,
                    branch: e.branch,
                    path: e.path,
                    head_commit: e.head_commit,
                })
                .collect();
            Ok(IpcResult::success(infos))
        }
        Err(e) => Ok(IpcResult::error(e.to_string(), e.error_code())),
    }
}

/// Create a new worktree.
///
/// When `progress_id` is set, streams git's stderr lines as
/// `acp:worktree_progress` events (`{ progressId, line }`) so the renderer can
/// show live preparation output while the blocking `git worktree add` runs.
/// Emit failures are logged and ignored — they must not fail the create.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn worktree_create(
    app: AppHandle,
    project_path: String,
    name: String,
    branch: String,
    is_new_branch: bool,
    start_ref: Option<String>,
    target_path: Option<String>,
    progress_id: Option<String>,
) -> Result<IpcResult<WorktreeInfo>, String> {
    let validated_path = validate_and_stringify!(&project_path);
    let pid = progress_id.filter(|id| !id.is_empty());

    // Boundary log: the create inputs so a failed launch is diagnosable
    // from termul.log alone. `{:?}` quotes/escapes renderer-controlled
    // values so a `\n` cannot forge log lines.
    log::info!(
        "[worktree-create] project={:?} name={:?} branch={:?} is_new_branch={} start_ref={:?} target_path={:?} streaming={}",
        validated_path,
        name,
        branch,
        is_new_branch,
        start_ref,
        target_path,
        pid.is_some()
    );

    let emit_progress = |line: &str| {
        if let Some(ref id) = pid {
            if let Err(e) = app.emit(
                "acp:worktree_progress",
                serde_json::json!({"progressId": id, "line": line}),
            ) {
                log::warn!("worktree_create: failed to emit progress event: {}", e);
            }
        }
    };

    if pid.is_some() {
        emit_progress("preparing");
    }

    let result = if pid.is_some() {
        let mut on_line = |line: &str| emit_progress(line);
        WorktreeManager::create(
            &validated_path,
            &name,
            &branch,
            is_new_branch,
            start_ref.as_deref(),
            target_path.as_deref(),
            Some(&mut on_line),
        )
    } else {
        WorktreeManager::create(
            &validated_path,
            &name,
            &branch,
            is_new_branch,
            start_ref.as_deref(),
            target_path.as_deref(),
            None,
        )
    };

    match result {
        Ok(entry) => {
            emit_progress("done");
            Ok(IpcResult::success(WorktreeInfo {
                name: entry.name,
                branch: entry.branch,
                path: entry.path,
                head_commit: entry.head_commit,
            }))
        }
        Err(e) => {
            log::warn!(
                "[worktree-create] failed project={:?} name={:?} branch={:?} code={} error={:?}",
                validated_path,
                name,
                branch,
                e.error_code(),
                e
            );
            // `termul:`-prefixed terminal sentinel — a real git stderr line
            // can legitimately start with `error:` mid-run and must not be
            // parsed as the error terminator by the progress store.
            emit_progress(&format!("termul:error: {}", e));
            Ok(IpcResult::error(e.to_string(), e.error_code()))
        }
    }
}

/// Remove a worktree. Uses --force if requested. Runs `git worktree prune` after.
#[tauri::command]
pub async fn worktree_remove(
    project_path: String,
    worktree_path: String,
    force: bool,
) -> Result<IpcResult<()>, String> {
    let validated_project = validate_and_stringify!(&project_path);
    let validated_worktree = validate_and_stringify!(&worktree_path);
    match WorktreeManager::remove(&validated_project, &validated_worktree, force) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e.to_string(), e.error_code())),
    }
}

/// List local and remote branches for a git repo.
#[tauri::command]
pub async fn worktree_branches(project_path: String) -> Result<IpcResult<Vec<BranchInfo>>, String> {
    let validated_path = validate_and_stringify!(&project_path);
    match WorktreeManager::branches(&validated_path) {
        Ok(entries) => {
            let infos: Vec<BranchInfo> = entries
                .into_iter()
                .map(|e| BranchInfo {
                    name: e.name,
                    is_remote: e.is_remote,
                    is_current: e.is_current,
                    upstream: e.upstream,
                    has_other_worktree: e.has_other_worktree,
                })
                .collect();
            Ok(IpcResult::success(infos))
        }
        Err(e) => Ok(IpcResult::error(e.to_string(), e.error_code())),
    }
}

/// Check dirty status for a worktree checkout.
#[tauri::command]
pub async fn worktree_check_dirty(worktree_path: String) -> Result<IpcResult<DirtyStatus>, String> {
    let validated_path = validate_and_stringify!(&worktree_path);
    match WorktreeManager::check_dirty(&validated_path) {
        Ok(status) => Ok(IpcResult::success(status)),
        Err(e) => Ok(IpcResult::error(e.to_string(), e.error_code())),
    }
}

/// Remove all Termul-managed worktrees for a project.
/// Reports per-worktree success/failure.
#[tauri::command]
pub async fn worktree_remove_all_managed(
    project_path: String,
    worktrees_json: String,
) -> Result<IpcResult<Vec<RemoveResult>>, String> {
    let validated_path = validate_and_stringify!(&project_path);
    match WorktreeManager::remove_all_managed(&validated_path, &worktrees_json) {
        Ok(results) => Ok(IpcResult::success(results)),
        Err(e) => Ok(IpcResult::error(e.to_string(), e.error_code())),
    }
}

/// Parse `.gitignore` and return directory entries that could be symlinked into worktrees.
/// Returns simple directory entries with whether they exist in the project root.
#[tauri::command]
pub async fn worktree_parse_gitignore(
    project_path: String,
) -> Result<IpcResult<Vec<GitignoreDirInfo>>, String> {
    let validated_path = validate_and_stringify!(&project_path);
    match WorktreeManager::parse_gitignore_dirs(&validated_path) {
        Ok(dirs) => {
            let infos: Vec<GitignoreDirInfo> = dirs
                .into_iter()
                .map(|d| GitignoreDirInfo {
                    dir_name: d.dir_name,
                    exists: d.exists,
                })
                .collect();
            Ok(IpcResult::success(infos))
        }
        Err(e) => Ok(IpcResult::error(e.to_string(), e.error_code())),
    }
}

/// Create symlinks from project root directories into a worktree.
/// `symlink_dirs` is a JSON array of directory names to symlink (e.g. ["node_modules", "dist"]).
#[tauri::command]
pub async fn worktree_create_symlinks(
    project_path: String,
    worktree_path: String,
    symlink_dirs: String,
) -> Result<IpcResult<Vec<SymlinkResultInfo>>, String> {
    let validated_project = validate_and_stringify!(&project_path);
    let validated_worktree = validate_and_stringify!(&worktree_path);
    let dirs: Vec<String> = match serde_json::from_str(&symlink_dirs) {
        Ok(dirs) => dirs,
        Err(e) => {
            return Ok(IpcResult::error(
                format!("Failed to parse symlink_dirs: {}", e),
                "PARSE_FAILED",
            ));
        }
    };
    let results = WorktreeManager::create_symlinks(&validated_project, &validated_worktree, &dirs);
    let infos: Vec<SymlinkResultInfo> = results
        .into_iter()
        .map(|r| SymlinkResultInfo {
            path: r.path,
            target: r.target,
            status: r.status,
            reason: r.reason,
        })
        .collect();
    Ok(IpcResult::success(infos))
}

/// Ensure symlinks exist for all directories in symlink_dirs.
/// Creates any missing symlinks. Does not remove or overwrite existing ones.
#[tauri::command]
pub async fn worktree_ensure_symlinks(
    project_path: String,
    worktree_path: String,
    symlink_dirs: String,
) -> Result<IpcResult<Vec<SymlinkResultInfo>>, String> {
    let validated_project = validate_and_stringify!(&project_path);
    let validated_worktree = validate_and_stringify!(&worktree_path);
    let dirs2: Vec<String> = match serde_json::from_str(&symlink_dirs) {
        Ok(dirs) => dirs,
        Err(e) => {
            return Ok(IpcResult::error(
                format!("Failed to parse symlink_dirs: {}", e),
                "PARSE_FAILED",
            ));
        }
    };
    let results = WorktreeManager::ensure_symlinks(&validated_project, &validated_worktree, &dirs2);
    let infos: Vec<SymlinkResultInfo> = results
        .into_iter()
        .map(|r| SymlinkResultInfo {
            path: r.path,
            target: r.target,
            status: r.status,
            reason: r.reason,
        })
        .collect();
    Ok(IpcResult::success(infos))
}

/// Archive a worktree by moving it to `.termul/archives/`.
#[tauri::command]
pub async fn worktree_archive(
    project_path: String,
    worktree_path: String,
) -> Result<IpcResult<()>, String> {
    let validated_project = validate_and_stringify!(&project_path);
    let validated_worktree = validate_and_stringify!(&worktree_path);
    match WorktreeManager::archive(&validated_project, &validated_worktree) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e.to_string(), e.error_code())),
    }
}

/// Restore an archived worktree back to its original location.
#[tauri::command]
pub async fn worktree_restore(
    project_path: String,
    archive_path: String,
) -> Result<IpcResult<()>, String> {
    let validated_project = validate_and_stringify!(&project_path);
    let validated_archive = validate_and_stringify!(&archive_path);
    match WorktreeManager::restore(&validated_project, &validated_archive) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e.to_string(), e.error_code())),
    }
}

/// Generate a merge preview for a worktree against a target branch.
#[tauri::command]
pub async fn worktree_merge_preview(
    worktree_path: String,
    target_branch: String,
) -> Result<IpcResult<MergePreviewInfo>, String> {
    let validated_path = validate_and_stringify!(&worktree_path);
    match WorktreeManager::merge_preview(&validated_path, &target_branch) {
        Ok(preview) => {
            let info = MergePreviewInfo {
                direction: preview.direction,
                source_branch: preview.source_branch,
                target_branch: preview.target_branch,
                conflict_files: preview
                    .conflict_files
                    .into_iter()
                    .map(|f| ConflictFileInfo {
                        path: f.path,
                        severity: f.severity,
                        conflict_count: f.conflict_count,
                        is_lock_file: f.is_lock_file,
                    })
                    .collect(),
                changed_files: preview.changed_files,
                total_changes: preview.total_changes,
                detection_mode: preview.detection_mode,
            };
            Ok(IpcResult::success(info))
        }
        Err(e) => Ok(IpcResult::error(e.to_string(), e.error_code())),
    }
}

/// Execute a merge from the worktree's current branch to target_branch.
#[tauri::command]
pub async fn worktree_merge_execute(
    worktree_path: String,
    target_branch: String,
) -> Result<IpcResult<String>, String> {
    let validated_path = validate_and_stringify!(&worktree_path);
    match WorktreeManager::merge_execute(&validated_path, &target_branch) {
        Ok(result) => Ok(IpcResult::success(result)),
        Err(e) => Ok(IpcResult::error(e.to_string(), e.error_code())),
    }
}

/// Resolve the default base branch for a new chat worktree (CAP-2).
/// Returns the origin/HEAD default with a `main`/`master`/current fallback
/// chain and a detached-HEAD flag so the launcher can force a base pick.
#[tauri::command]
pub async fn worktree_resolve_base_branch(
    project_path: String,
) -> Result<IpcResult<BaseBranchInfo>, String> {
    let validated_path = validate_and_stringify!(&project_path);
    match WorktreeManager::resolve_default_base_branch(&validated_path) {
        Ok(info) => Ok(IpcResult::success(info)),
        Err(e) => Ok(IpcResult::error(e.to_string(), e.error_code())),
    }
}

/// Carry over untracked files listed in `.worktree-include` into a fresh
/// worktree (CAP-5). Symlink/path-escape/already-present defenses run per
/// file; the result reports `ran`/`copied`/`skipped` with per-file reasons.
#[tauri::command]
pub async fn worktree_copy_include_files(
    project_path: String,
    worktree_path: String,
) -> Result<IpcResult<IncludeCopyResult>, String> {
    let validated_project = validate_and_stringify!(&project_path);
    let validated_worktree = validate_and_stringify!(&worktree_path);
    // Filesystem walk + copy is blocking; offload from the async runtime.
    match tokio::task::spawn_blocking(move || {
        WorktreeManager::copy_worktree_include_files(&validated_project, &validated_worktree)
    })
    .await
    {
        Ok(Ok(result)) => Ok(IpcResult::success(result)),
        Ok(Err(e)) => Ok(IpcResult::error(e.to_string(), e.error_code())),
        Err(join_err) => Ok(IpcResult::error(
            format!("worktree_copy_include_files join failed: {join_err}"),
            "INTERNAL_ERROR",
        )),
    }
}

/// Worktree info for IPC response
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub name: String,
    pub branch: String,
    pub path: String,
    pub head_commit: String,
}

impl From<GitWorktreeEntry> for WorktreeInfo {
    fn from(entry: GitWorktreeEntry) -> Self {
        Self {
            name: entry.name,
            branch: entry.branch,
            path: entry.path,
            head_commit: entry.head_commit,
        }
    }
}

/// Branch info for IPC response
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub is_remote: bool,
    pub is_current: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    pub has_other_worktree: bool,
}

impl From<BranchEntry> for BranchInfo {
    fn from(entry: BranchEntry) -> Self {
        Self {
            name: entry.name,
            is_remote: entry.is_remote,
            is_current: entry.is_current,
            upstream: entry.upstream,
            has_other_worktree: entry.has_other_worktree,
        }
    }
}

/// Gitignore directory info for IPC response
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitignoreDirInfo {
    pub dir_name: String,
    pub exists: bool,
}

/// Symlink result info for IPC response
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymlinkResultInfo {
    pub path: String,
    pub target: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Merge preview info for IPC response
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePreviewInfo {
    pub direction: String,
    pub source_branch: String,
    pub target_branch: String,
    pub conflict_files: Vec<ConflictFileInfo>,
    pub changed_files: Vec<String>,
    pub total_changes: usize,
    pub detection_mode: String,
}

/// Conflict file info for IPC response
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFileInfo {
    pub path: String,
    pub severity: String,
    pub conflict_count: usize,
    pub is_lock_file: bool,
}
