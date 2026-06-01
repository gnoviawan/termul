use crate::browser_tab_manager::{BrowserBounds, BrowserTabInfo, BrowserTabManager};
use crate::migrations::{
    MigrationInfo, MigrationManager, MigrationRecord, MigrationResult, SchemaVersion,
};
use crate::pty::{PtyManager, SpawnOptions, TerminalInfo};
use crate::remote;
use crate::worktree::{BranchEntry, DirtyStatus, GitWorktreeEntry, RemoveResult, WorktreeManager};
use crate::trackers::{CwdTracker, ExitCodeTracker, GitCommit, GitStatus, GitTracker, GitStatusDetail};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Emitter, State, Webview};

/// Validate that the caller webview matches the expected tab_id.
/// This prevents cross-tab command injection where a malicious webview
/// could emit events for other tabs.
fn validate_browser_tab_caller(webview: &Webview, expected_tab_id: &str) -> Result<(), String> {
    let caller_label = webview.label();
    if caller_label != expected_tab_id {
        log::warn!(
            "[Security] Browser tab command rejected: caller '{}' does not match expected '{}'",
            caller_label,
            expected_tab_id
        );
        return Err(format!(
            "Browser tab command rejected: caller '{}' does not match expected '{}'",
            caller_label, expected_tab_id
        ));
    }
    Ok(())
}

/// Validate and canonicalize a project path to prevent path traversal attacks.
/// Returns the canonicalized path or an error if the path is invalid or inaccessible.
fn validate_project_path(path: &str) -> Result<PathBuf, String> {
    let path_buf = PathBuf::from(path);
    
    // Canonicalize to resolve symlinks and relative paths
    let canonical = path_buf.canonicalize().map_err(|e| {
        log::warn!(
            "[Security] Path validation failed for '{}': {}",
            path,
            e
        );
        format!("Invalid or inaccessible path: {}", e)
    })?;
    
    log::debug!("[Security] Path validated: {} -> {:?}", path, canonical);
    Ok(canonical)
}

/// Macro to validate a path and convert it to a String, returning early with an IpcResult error if validation fails.
macro_rules! validate_and_stringify {
    ($path:expr) => {
        match validate_project_path($path) {
            Ok(validated) => match validated.to_str() {
                Some(s) => s.to_string(),
                None => return Ok(IpcResult::error("Path contains invalid UTF-8", "INVALID_PATH_ENCODING")),
            },
            Err(e) => return Ok(IpcResult::error(e, "PATH_VALIDATION_FAILED")),
        }
    };
}

/// IPC Result pattern
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IpcResult<T> {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

impl<T> IpcResult<T> {
    pub fn success(data: T) -> Self {
        Self {
            success: true,
            data: Some(data),
            error: None,
            code: None,
        }
    }

    pub fn error(error: impl Into<String>, code: impl Into<String>) -> Self {
        Self {
            success: false,
            data: None,
            error: Some(error.into()),
            code: Some(code.into()),
        }
    }
}

/// Terminal visibility state
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetVisibilityRequest {
    pub is_visible: bool,
}

/// Orphan detection settings
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanDetectionSettings {
    pub enabled: bool,
    pub timeout_minutes: Option<u64>,
}

/// Renderer ref request
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererRefRequest {
    pub terminal_id: String,
    pub renderer_id: String,
}

// ==================== Terminal Commands ====================

/// Spawn a new terminal with binary data channel
///
/// The `on_data` channel uses Tauri 2's Channel API for
/// zero-overhead binary IPC. PTY output is sent as raw `Vec<u8>` via
/// `Response::new(bytes)`, arriving in JS as `ArrayBuffer` with no JSON
/// serialization overhead.
#[tauri::command]
pub async fn terminal_spawn(
    options: SpawnOptions,
    on_data: Channel<Response>,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Result<IpcResult<TerminalInfo>, String> {
    match pty_manager.spawn(options, Some(on_data)).await {
        Ok(info) => Ok(IpcResult::success(info)),
        Err(e) => Ok(IpcResult::error(e, "SPAWN_FAILED")),
    }
}

/// Write data to a terminal
#[tauri::command]
pub async fn terminal_write(
    terminal_id: String,
    data: String,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Result<IpcResult<()>, String> {
    match pty_manager.write(&terminal_id, &data).await {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "WRITE_FAILED")),
    }
}

/// Resize a terminal
#[tauri::command]
pub async fn terminal_resize(
    terminal_id: String,
    cols: u16,
    rows: u16,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Result<IpcResult<()>, String> {
    match pty_manager.resize(&terminal_id, cols, rows).await {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "RESIZE_FAILED")),
    }
}

/// Kill a terminal
#[tauri::command]
pub async fn terminal_kill(
    terminal_id: String,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Result<IpcResult<()>, String> {
    match pty_manager.kill(&terminal_id).await {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "KILL_FAILED")),
    }
}

/// Get the current working directory for a terminal
#[tauri::command]
pub async fn terminal_get_cwd(
    terminal_id: String,
    cwd_tracker: State<'_, Arc<CwdTracker>>,
) -> Result<IpcResult<Option<String>>, String> {
    let cwd = cwd_tracker.get_cwd(&terminal_id);
    Ok(IpcResult::success(cwd))
}

/// Get the git branch for a terminal
#[tauri::command]
pub async fn terminal_get_git_branch(
    terminal_id: String,
    git_tracker: State<'_, Arc<GitTracker>>,
) -> Result<IpcResult<Option<String>>, String> {
    let branch = git_tracker.get_branch(&terminal_id);
    Ok(IpcResult::success(branch))
}

/// Get the git status for a terminal
#[tauri::command]
pub async fn terminal_get_git_status(
    terminal_id: String,
    git_tracker: State<'_, Arc<GitTracker>>,
) -> Result<IpcResult<Option<GitStatus>>, String> {
    let status = git_tracker.get_status(&terminal_id);
    Ok(IpcResult::success(status))
}

/// Get the exit code for a terminal
#[tauri::command]
pub async fn terminal_get_exit_code(
    terminal_id: String,
    exit_code_tracker: State<'_, Arc<ExitCodeTracker>>,
) -> Result<IpcResult<Option<i32>>, String> {
    let exit_code = exit_code_tracker.get_exit_code(&terminal_id);
    Ok(IpcResult::success(exit_code))
}

/// Update orphan detection settings
#[tauri::command]
pub async fn terminal_update_orphan_detection(
    settings: OrphanDetectionSettings,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Result<IpcResult<()>, String> {
    pty_manager
        .update_orphan_detection_settings(settings.enabled, settings.timeout_minutes)
        .await;
    Ok(IpcResult::success(()))
}

/// Add a renderer reference to a terminal
#[tauri::command]
pub async fn terminal_add_renderer_ref(
    request: RendererRefRequest,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Result<IpcResult<()>, String> {
    match pty_manager.add_renderer_ref(&request.terminal_id, &request.renderer_id) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "TERMINAL_NOT_FOUND")),
    }
}

/// Remove a renderer reference from a terminal
#[tauri::command]
pub async fn terminal_remove_renderer_ref(
    request: RendererRefRequest,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Result<IpcResult<()>, String> {
    match pty_manager.remove_renderer_ref(&request.terminal_id, &request.renderer_id) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "TERMINAL_NOT_FOUND")),
    }
}

/// Set visibility state (affects polling behavior and PTY kill deferral)
#[tauri::command]
pub async fn terminal_set_visibility(
    request: SetVisibilityRequest,
    pty_manager: State<'_, Arc<PtyManager>>,
    cwd_tracker: State<'_, Arc<CwdTracker>>,
    git_tracker: State<'_, Arc<GitTracker>>,
) -> Result<IpcResult<()>, String> {
    pty_manager.set_hidden(!request.is_visible);
    cwd_tracker.set_visibility(request.is_visible);
    git_tracker.set_visibility(request.is_visible);
    Ok(IpcResult::success(()))
}

// ==================== Worktree Commands ====================

/// List all worktrees for a git repo at the given path.
/// Filters out bare worktrees and detached-HEAD worktrees.
#[tauri::command]
pub async fn worktree_list(
    project_path: String,
) -> Result<IpcResult<Vec<WorktreeInfo>>, String> {
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
#[tauri::command]
pub async fn worktree_create(
    project_path: String,
    name: String,
    branch: String,
    is_new_branch: bool,
    start_ref: Option<String>,
    target_path: Option<String>,
) -> Result<IpcResult<WorktreeInfo>, String> {
    let validated_path = validate_and_stringify!(&project_path);
    match WorktreeManager::create(
        &validated_path,
        &name,
        &branch,
        is_new_branch,
        start_ref.as_deref(),
        target_path.as_deref(),
    ) {
        Ok(entry) => Ok(IpcResult::success(WorktreeInfo {
            name: entry.name,
            branch: entry.branch,
            path: entry.path,
            head_commit: entry.head_commit,
        })),
        Err(e) => Ok(IpcResult::error(e.to_string(), e.error_code())),
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
    match WorktreeManager::remove(
        &validated_project,
        &validated_worktree,
        force,
    ) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e.to_string(), e.error_code())),
    }
}

/// List local and remote branches for a git repo.
#[tauri::command]
pub async fn worktree_branches(
    project_path: String,
) -> Result<IpcResult<Vec<BranchInfo>>, String> {
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
                })
                .collect();
            Ok(IpcResult::success(infos))
        }
        Err(e) => Ok(IpcResult::error(e.to_string(), e.error_code())),
    }
}

/// Check dirty status for a worktree checkout.
#[tauri::command]
pub async fn worktree_check_dirty(
    worktree_path: String,
) -> Result<IpcResult<DirtyStatus>, String> {
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
    let results = WorktreeManager::create_symlinks(
        &validated_project,
        &validated_worktree,
        &dirs,
    );
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
    let results = WorktreeManager::ensure_symlinks(
        &validated_project,
        &validated_worktree,
        &dirs2,
    );
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
    match WorktreeManager::archive(
        &validated_project,
        &validated_worktree,
    ) {
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
    match WorktreeManager::restore(
        &validated_project,
        &validated_archive,
    ) {
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
                conflict_files: preview.conflict_files.into_iter().map(|f| ConflictFileInfo {
                    path: f.path,
                    severity: f.severity,
                    conflict_count: f.conflict_count,
                    is_lock_file: f.is_lock_file,
                }).collect(),
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
}

impl From<BranchEntry> for BranchInfo {
    fn from(entry: BranchEntry) -> Self {
        Self {
            name: entry.name,
            is_remote: entry.is_remote,
            is_current: entry.is_current,
            upstream: entry.upstream,
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

// ==================== Browser Tab Commands ====================

/// Create a new browser tab webview
#[tauri::command]
pub async fn browser_tab_create(
    tab_id: String,
    url: String,
    bounds: BrowserBounds,
    browser_manager: State<'_, Arc<BrowserTabManager>>,
) -> Result<IpcResult<BrowserTabInfo>, String> {
    match browser_manager.create(tab_id, url, bounds) {
        Ok(info) => Ok(IpcResult::success(info)),
        Err(e) => Ok(IpcResult::error(e, "BROWSER_TAB_CREATE_FAILED")),
    }
}

/// Navigate a browser tab to a new URL
#[tauri::command]
pub async fn browser_tab_navigate(
    tab_id: String,
    url: String,
    browser_manager: State<'_, Arc<BrowserTabManager>>,
) -> Result<IpcResult<()>, String> {
    match browser_manager.navigate(&tab_id, url) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "BROWSER_TAB_NAVIGATE_FAILED")),
    }
}

/// Resize/reposition a browser tab webview
#[tauri::command]
pub async fn browser_tab_resize(
    tab_id: String,
    bounds: BrowserBounds,
    browser_manager: State<'_, Arc<BrowserTabManager>>,
) -> Result<IpcResult<()>, String> {
    match browser_manager.resize(&tab_id, bounds) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "BROWSER_TAB_RESIZE_FAILED")),
    }
}

/// Show a browser tab webview
#[tauri::command]
pub async fn browser_tab_show(
    tab_id: String,
    browser_manager: State<'_, Arc<BrowserTabManager>>,
) -> Result<IpcResult<()>, String> {
    match browser_manager.show(&tab_id) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "BROWSER_TAB_SHOW_FAILED")),
    }
}

/// Hide a browser tab webview
#[tauri::command]
pub async fn browser_tab_hide(
    tab_id: String,
    browser_manager: State<'_, Arc<BrowserTabManager>>,
) -> Result<IpcResult<()>, String> {
    match browser_manager.hide(&tab_id) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "BROWSER_TAB_HIDE_FAILED")),
    }
}

/// Destroy a browser tab webview
#[tauri::command]
pub async fn browser_tab_destroy(
    tab_id: String,
    browser_manager: State<'_, Arc<BrowserTabManager>>,
) -> Result<IpcResult<()>, String> {
    match browser_manager.destroy(&tab_id) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "BROWSER_TAB_DESTROY_FAILED")),
    }
}

/// Go back in browser tab history
#[tauri::command]
pub async fn browser_tab_go_back(
    tab_id: String,
    browser_manager: State<'_, Arc<BrowserTabManager>>,
) -> Result<IpcResult<()>, String> {
    match browser_manager.go_back(&tab_id) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "BROWSER_TAB_GO_BACK_FAILED")),
    }
}

/// Go forward in browser tab history
#[tauri::command]
pub async fn browser_tab_go_forward(
    tab_id: String,
    browser_manager: State<'_, Arc<BrowserTabManager>>,
) -> Result<IpcResult<()>, String> {
    match browser_manager.go_forward(&tab_id) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "BROWSER_TAB_GO_FORWARD_FAILED")),
    }
}

/// Reload a browser tab
#[tauri::command]
pub async fn browser_tab_reload(
    tab_id: String,
    browser_manager: State<'_, Arc<BrowserTabManager>>,
) -> Result<IpcResult<()>, String> {
    match browser_manager.reload(&tab_id) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "BROWSER_TAB_RELOAD_FAILED")),
    }
}

/// Open DevTools for a browser tab
#[tauri::command]
pub async fn browser_tab_open_devtools(
    tab_id: String,
    browser_manager: State<'_, Arc<BrowserTabManager>>,
) -> Result<IpcResult<()>, String> {
    match browser_manager.open_devtools(&tab_id) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "BROWSER_TAB_OPEN_DEVTOOLS_FAILED")),
    }
}


/// Inject annotation overlay script into a browser tab
#[tauri::command]
pub async fn browser_tab_inject_annotation(
    tab_id: String,
    mode: String,
    browser_manager: State<'_, Arc<BrowserTabManager>>,
) -> Result<IpcResult<()>, String> {
    match browser_manager.inject_annotation_script(&tab_id, &mode) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "BROWSER_TAB_INJECT_ANNOTATION_FAILED")),
    }
}

/// Remove annotation overlay from a browser tab
#[tauri::command]
pub async fn browser_tab_remove_annotation_overlay(
    tab_id: String,
    browser_manager: State<'_, Arc<BrowserTabManager>>,
) -> Result<IpcResult<()>, String> {
    match browser_manager.remove_annotation_overlay(&tab_id) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(
            e,
            "BROWSER_TAB_REMOVE_ANNOTATION_OVERLAY_FAILED",
        )),
    }
}

/// Inject annotation markers into a browser tab webview
#[tauri::command]
pub async fn browser_tab_inject_annotation_markers(
    tab_id: String,
    annotations_json: String,
    selected_id: Option<String>,
    browser_manager: State<'_, Arc<BrowserTabManager>>,
) -> Result<IpcResult<()>, String> {
    match browser_manager.inject_annotation_markers(
        &tab_id,
        &annotations_json,
        selected_id.as_deref(),
    ) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(
            e,
            "BROWSER_TAB_INJECT_ANNOTATION_MARKERS_FAILED",
        )),
    }
}

/// Update annotation marker selection in a browser tab webview
#[tauri::command]
pub async fn browser_tab_update_annotation_marker_selection(
    tab_id: String,
    selected_id: Option<String>,
    browser_manager: State<'_, Arc<BrowserTabManager>>,
) -> Result<IpcResult<()>, String> {
    match browser_manager.update_annotation_marker_selection(&tab_id, selected_id.as_deref()) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(
            e,
            "BROWSER_TAB_UPDATE_MARKER_SELECTION_FAILED",
        )),
    }
}

/// Report URL from browser tab webview (called by injected JS poller)
#[tauri::command]
pub async fn browser_tab_report_url(
    tab_id: String,
    url: String,
    app_handle: AppHandle,
    webview: Webview,
    browser_manager: State<'_, Arc<BrowserTabManager>>,
) -> Result<(), String> {
    validate_browser_tab_caller(&webview, &tab_id)?;
    log::debug!("[BrowserTab] URL report: tab={} navigated", tab_id);
    browser_manager.invalidate_annotation_injected(&tab_id);
    app_handle
        .emit(
            "browser-tab-navigated",
            serde_json::json!({ "browserTabId": tab_id, "url": url }),
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Report page loaded from browser tab webview (called by injected JS poller)
#[tauri::command]
pub async fn browser_tab_report_loaded(
    tab_id: String,
    app_handle: AppHandle,
    webview: Webview,
    browser_manager: State<'_, Arc<BrowserTabManager>>,
) -> Result<(), String> {
    validate_browser_tab_caller(&webview, &tab_id)?;
    log::debug!("[BrowserTab] Loaded report: tab={}", tab_id);
    browser_manager.invalidate_annotation_injected(&tab_id);
    app_handle
        .emit(
            "browser-tab-loaded",
            serde_json::json!({ "browserTabId": tab_id }),
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Report region captured from browser tab webview (called by injected annotation overlay)
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn browser_tab_report_region_captured(
    tab_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    viewport_width: f64,
    viewport_height: f64,
    app_handle: AppHandle,
    webview: Webview,
) -> Result<(), String> {
    validate_browser_tab_caller(&webview, &tab_id)?;
    log::debug!(
        "[BrowserTab] Region captured: tab={} x={} y={} w={} h={}",
        tab_id,
        x,
        y,
        width,
        height
    );
    app_handle
        .emit(
            "browser-tab-region-captured",
            serde_json::json!({
                "browserTabId": tab_id,
                "x": x,
                "y": y,
                "width": width,
                "height": height,
                "viewportWidth": viewport_width,
                "viewportHeight": viewport_height,
            }),
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Report title change from browser tab webview (called by injected JS poller)
#[tauri::command]
pub async fn browser_tab_report_title(
    tab_id: String,
    title: String,
    app_handle: AppHandle,
    webview: Webview,
) -> Result<(), String> {
    validate_browser_tab_caller(&webview, &tab_id)?;
    log::debug!("[BrowserTab] Title report: tab={}", tab_id);
    app_handle
        .emit(
            "browser-tab-title-changed",
            serde_json::json!({ "browserTabId": tab_id, "title": title }),
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Report element captured from browser tab webview (called by injected annotation overlay)
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn browser_tab_report_element_captured(
    tab_id: String,
    url: String,
    title: String,
    viewport_width: f64,
    viewport_height: f64,
    tag_name: String,
    selector: String,
    selector_confidence: String,
    attributes: serde_json::Value,
    text_content: String,
    text_truncated: bool,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    app_handle: AppHandle,
    webview: Webview,
) -> Result<(), String> {
    validate_browser_tab_caller(&webview, &tab_id)?;

    let attributes = attributes.as_object().cloned().ok_or_else(|| {
        "Browser tab report element captured rejected: attributes must be an object".to_string()
    })?;

    log::debug!(
        "[BrowserTab] Element captured: tab={} tag={} selector=<redacted>",
        tab_id,
        tag_name
    );
    app_handle
        .emit(
            "browser-tab-element-captured",
            serde_json::json!({
                "browserTabId": tab_id,
                "url": url,
                "title": title,
                "viewportWidth": viewport_width,
                "viewportHeight": viewport_height,
                "tagName": tag_name,
                "selector": selector,
                "selectorConfidence": selector_confidence,
                "attributes": attributes,
                "textContent": text_content,
                "textTruncated": text_truncated,
                "boundingBox": {
                    "x": x,
                    "y": y,
                    "width": width,
                    "height": height
                }
            }),
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Report annotation marker clicked from browser tab webview
#[tauri::command]
pub async fn browser_tab_report_annotation_marker_clicked(
    tab_id: String,
    annotation_id: String,
    app_handle: AppHandle,
    webview: Webview,
) -> Result<(), String> {
    validate_browser_tab_caller(&webview, &tab_id)?;
    log::debug!(
        "[BrowserTab] Annotation marker clicked: tab={} annotation_id={}",
        tab_id,
        annotation_id
    );
    app_handle
        .emit(
            "browser-tab-annotation-marker-clicked",
            serde_json::json!({
                "browserTabId": tab_id,
                "annotationId": annotation_id,
            }),
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Rollback request
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackRequest {
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchMatch {
    pub line_number: usize,
    pub line_text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchResult {
    pub file_path: String,
    pub matches: Vec<FileSearchMatch>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchResponse {
    pub results: Vec<FileSearchResult>,
    pub truncated: bool,
    pub scanned_files: usize,
    pub failed_files: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchContentRequest {
    pub root_path: String,
    pub query: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchContentStreamRequest {
    pub root_path: String,
    pub query: String,
    pub search_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchContentCancelRequest {
    pub search_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchContentBatchEvent {
    pub search_id: String,
    pub results: Vec<FileSearchResult>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchContentDoneEvent {
    pub search_id: String,
    pub truncated: bool,
    pub scanned_files: usize,
    pub failed_files: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFileNamesRequest {
    pub root_path: String,
    pub query: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFileNamesResponse {
    pub files: Vec<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RgInfoResponse {
    pub sidecar_binary_name: String,
    pub resolved_path: String,
    pub source: String,
    pub exists: bool,
}

static SEARCH_PROCESSES: OnceLock<Mutex<HashMap<String, Arc<Mutex<Child>>>>> = OnceLock::new();
static RG_PATH_CACHE: OnceLock<String> = OnceLock::new();

fn search_processes() -> &'static Mutex<HashMap<String, Arc<Mutex<Child>>>> {
    SEARCH_PROCESSES.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(target_os = "windows")]
fn rg_sidecar_name() -> &'static str {
    "rg-x86_64-pc-windows-msvc.exe"
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn rg_sidecar_name() -> &'static str {
    "rg-aarch64-apple-darwin"
}

#[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
fn rg_sidecar_name() -> &'static str {
    "rg-x86_64-apple-darwin"
}

#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
fn rg_sidecar_name() -> &'static str {
    "rg-aarch64-unknown-linux-gnu"
}

#[cfg(all(target_os = "linux", target_arch = "arm"))]
fn rg_sidecar_name() -> &'static str {
    "rg-armv7-unknown-linux-gnueabihf"
}

#[cfg(all(
    target_os = "linux",
    not(any(target_arch = "aarch64", target_arch = "arm"))
))]
fn rg_sidecar_name() -> &'static str {
    "rg-x86_64-unknown-linux-musl"
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn rg_sidecar_name() -> &'static str {
    "rg"
}

fn resolve_rg_path() -> (String, String) {
    let from_env = std::env::var("TERMUL_RG_PATH")
        .ok()
        .filter(|v| !v.trim().is_empty());
    if let Some(path) = from_env {
        let env_path = PathBuf::from(&path);
        if env_path.is_absolute() {
            return (path, "env".to_string());
        }

        if let Ok(cwd) = std::env::current_dir() {
            let direct = cwd.join(&env_path);
            if direct.exists() && direct.is_file() {
                return (direct.to_string_lossy().to_string(), "env".to_string());
            }

            let from_src_tauri = cwd.join("src-tauri").join(&env_path);
            if from_src_tauri.exists() && from_src_tauri.is_file() {
                return (
                    from_src_tauri.to_string_lossy().to_string(),
                    "env".to_string(),
                );
            }
        }

        return (path, "env".to_string());
    }

    let binary = rg_sidecar_name();
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("src-tauri").join("bin").join(binary));
        candidates.push(cwd.join("bin").join(binary));
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.join(binary));
            candidates.push(exe_dir.join("../Resources").join(binary));
            candidates.push(exe_dir.join("../lib").join(binary));
        }
    }

    if let Some(found) = candidates
        .into_iter()
        .find(|path| path.exists() && path.is_file())
    {
        return (found.to_string_lossy().to_string(), "sidecar".to_string());
    }

    ("rg".to_string(), "path".to_string())
}

fn detect_rg_path() -> String {
    if let Some(cached) = RG_PATH_CACHE.get() {
        return cached.clone();
    }

    let (detected, _source) = resolve_rg_path();
    let _ = RG_PATH_CACHE.set(detected.clone());
    detected
}

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "windows")]
fn configure_background_command(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn configure_background_command(_command: &mut Command) {}

fn build_search_args(query: &str, root_path: &str, max_matches_per_file: usize) -> Vec<String> {
    let mut args = vec![
        "--json".to_string(),
        "-F".to_string(),
        "-i".to_string(),
        "-n".to_string(),
        "--max-filesize".to_string(),
        "1M".to_string(),
        "--max-count".to_string(),
        max_matches_per_file.to_string(),
    ];

    for ignored in [
        "node_modules",
        ".git",
        ".next",
        ".cache",
        ".turbo",
        "dist",
        "build",
        ".output",
        ".nuxt",
        ".svelte-kit",
        "__pycache__",
        ".pytest_cache",
        "venv",
        ".env",
        "coverage",
        ".nyc_output",
    ] {
        args.push("-g".to_string());
        args.push(format!("!**/{}/**", ignored));
    }
    args.push("-g".to_string());
    args.push("!**/.env".to_string());

    args.push("--".to_string());
    args.push(query.to_string());
    args.push(root_path.to_string());
    args
}

#[tauri::command]
pub async fn search_get_rg_info() -> Result<IpcResult<RgInfoResponse>, String> {
    let (resolved_path, source) = resolve_rg_path();
    let exists = PathBuf::from(&resolved_path).exists();

    Ok(IpcResult::success(RgInfoResponse {
        sidecar_binary_name: rg_sidecar_name().to_string(),
        resolved_path,
        source,
        exists,
    }))
}

#[tauri::command]
pub async fn search_content_stream(
    request: SearchContentStreamRequest,
    app_handle: AppHandle,
) -> Result<IpcResult<()>, String> {
    let trimmed_query = request.query.trim().to_string();
    if trimmed_query.is_empty() {
        let _ = app_handle.emit(
            "search-content-done",
            SearchContentDoneEvent {
                search_id: request.search_id,
                truncated: false,
                scanned_files: 0,
                failed_files: 0,
                error: None,
            },
        );
        return Ok(IpcResult::success(()));
    }

    let max_files_with_matches: usize = 100;
    let max_matches_per_file: usize = 30;
    let args = build_search_args(&trimmed_query, &request.root_path, max_matches_per_file);

    let rg_path = detect_rg_path();
    let mut rg_command = Command::new(&rg_path);
    rg_command.args(args).stdout(Stdio::piped()).stderr(Stdio::null());
    configure_background_command(&mut rg_command);
    let mut child = match rg_command.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = app_handle.emit(
                "search-content-done",
                SearchContentDoneEvent {
                    search_id: request.search_id,
                    truncated: false,
                    scanned_files: 0,
                    failed_files: 0,
                    error: Some(format!("rg spawn failed (path: {}): {}", rg_path, e)),
                },
            );
            return Ok(IpcResult::success(()));
        }
    };

    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            let _ = app_handle.emit(
                "search-content-done",
                SearchContentDoneEvent {
                    search_id: request.search_id,
                    truncated: false,
                    scanned_files: 0,
                    failed_files: 1,
                    error: Some("failed to capture rg stdout".to_string()),
                },
            );
            return Ok(IpcResult::success(()));
        }
    };

    let child_handle = Arc::new(Mutex::new(child));
    {
        let mut guard = search_processes().lock().map_err(|e| e.to_string())?;
        guard.insert(request.search_id.clone(), Arc::clone(&child_handle));
    }

    let search_id = request.search_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let reader = BufReader::new(stdout);
        let mut grouped: BTreeMap<String, Vec<FileSearchMatch>> = BTreeMap::new();
        let mut pending_matches: BTreeMap<String, Vec<FileSearchMatch>> = BTreeMap::new();
        let mut truncated = false;

        let flush_batch = |pending: &mut BTreeMap<String, Vec<FileSearchMatch>>,
                           truncated: bool| {
            if pending.is_empty() {
                return;
            }
            let batch: Vec<FileSearchResult> = pending
                .iter()
                .map(|(file_path, matches)| FileSearchResult {
                    file_path: file_path.clone(),
                    matches: matches.clone(),
                })
                .collect();
            let _ = app_handle.emit(
                "search-content-batch",
                SearchContentBatchEvent {
                    search_id: search_id.clone(),
                    results: batch,
                    truncated,
                },
            );
            pending.clear();
        };

        for line in reader.lines() {
            let line = match line {
                Ok(v) => v,
                Err(_) => continue,
            };

            let parsed: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            if parsed.get("type").and_then(|v| v.as_str()) != Some("match") {
                continue;
            }

            let file_path = match parsed
                .get("data")
                .and_then(|d| d.get("path"))
                .and_then(|p| p.get("text"))
                .and_then(|t| t.as_str())
            {
                Some(p) => p.replace('\\', "/"),
                None => continue,
            };

            let line_number = match parsed
                .get("data")
                .and_then(|d| d.get("line_number"))
                .and_then(|n| n.as_u64())
            {
                Some(n) => n as usize,
                None => continue,
            };

            let line_text = parsed
                .get("data")
                .and_then(|d| d.get("lines"))
                .and_then(|l| l.get("text"))
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .trim_end_matches(['\r', '\n'])
                .to_string();

            if !grouped.contains_key(&file_path) {
                if grouped.len() >= max_files_with_matches {
                    truncated = true;
                    break;
                }
                grouped.insert(file_path.clone(), Vec::new());
            }

            if let Some(matches) = grouped.get_mut(&file_path) {
                if matches.len() >= max_matches_per_file {
                    truncated = true;
                    continue;
                }
                let new_match = FileSearchMatch {
                    line_number,
                    line_text,
                };
                matches.push(new_match.clone());
                pending_matches
                    .entry(file_path)
                    .or_default()
                    .push(new_match);
            }

            if pending_matches.values().map(Vec::len).sum::<usize>() >= 25 {
                flush_batch(&mut pending_matches, truncated);
            }
        }

        flush_batch(&mut pending_matches, truncated);

        if let Ok(mut child) = child_handle.lock() {
            let _ = child.try_wait().or_else(|_| child.wait().map(Some));
        }
        if let Ok(mut guard) = search_processes().lock() {
            guard.remove(&search_id);
        }

        let _ = app_handle.emit(
            "search-content-done",
            SearchContentDoneEvent {
                search_id,
                truncated,
                scanned_files: 0,
                failed_files: 0,
                error: None,
            },
        );
    });

    Ok(IpcResult::success(()))
}

#[tauri::command]
pub async fn search_content_cancel(
    request: SearchContentCancelRequest,
) -> Result<IpcResult<()>, String> {
    let mut guard = search_processes().lock().map_err(|e| e.to_string())?;
    if let Some(child_handle) = guard.remove(&request.search_id) {
        if let Ok(mut child) = child_handle.lock() {
            let _ = child.kill();
            let _ = child.try_wait().or_else(|_| child.wait().map(Some));
        }
    }
    Ok(IpcResult::success(()))
}

#[tauri::command]
pub async fn search_file_names(
    request: SearchFileNamesRequest,
) -> Result<IpcResult<SearchFileNamesResponse>, String> {
    let trimmed_query = request.query.trim().to_lowercase();
    if trimmed_query.is_empty() {
        return Ok(IpcResult::success(SearchFileNamesResponse {
            files: vec![],
            truncated: false,
        }));
    }

    let mut stack = vec![request.root_path];
    let mut matches: Vec<String> = Vec::new();
    let mut truncated = false;
    let max_files = 100;

    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            let file_name = match path.file_name().and_then(|n| n.to_str()) {
                Some(name) => name,
                None => continue,
            };

            if [
                "node_modules",
                ".git",
                ".next",
                ".cache",
                ".turbo",
                "dist",
                "build",
                ".output",
                ".nuxt",
                ".svelte-kit",
                "__pycache__",
                ".pytest_cache",
                "venv",
                ".env",
                "coverage",
                ".nyc_output",
            ]
            .contains(&file_name)
            {
                continue;
            }

            if path.is_dir() {
                stack.push(path.to_string_lossy().to_string());
                continue;
            }

            if file_name.to_lowercase().contains(&trimmed_query) {
                matches.push(path.to_string_lossy().replace('\\', "/"));
                if matches.len() >= max_files {
                    truncated = true;
                    break;
                }
            }
        }

        if truncated {
            break;
        }
    }

    Ok(IpcResult::success(SearchFileNamesResponse {
        files: matches,
        truncated,
    }))
}

#[tauri::command]
pub async fn search_content(
    request: SearchContentRequest,
) -> Result<IpcResult<FileSearchResponse>, String> {
    let trimmed_query = request.query.trim();
    if trimmed_query.is_empty() {
        return Ok(IpcResult::success(FileSearchResponse {
            results: vec![],
            truncated: false,
            scanned_files: 0,
            failed_files: 0,
        }));
    }

    let max_files_with_matches: usize = 100;
    let max_matches_per_file: usize = 30;

    let args = build_search_args(trimmed_query, &request.root_path, max_matches_per_file);

    let rg_path = detect_rg_path();
    let mut rg_command = Command::new(&rg_path);
    rg_command.args(args);
    configure_background_command(&mut rg_command);
    let output = rg_command.output();
    let output = match output {
        Ok(o) => o,
        Err(e) => {
            return Ok(IpcResult::error(
                format!("rg spawn failed (path: {}): {}", rg_path, e),
                "SEARCH_ERROR",
            ))
        }
    };

    let code = output.status.code().unwrap_or(0);
    if code > 1 {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Ok(IpcResult::error(
            format!("rg failed ({}): {}", code, stderr),
            "SEARCH_ERROR",
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut grouped: BTreeMap<String, Vec<FileSearchMatch>> = BTreeMap::new();
    let mut truncated = false;

    for line in stdout.lines() {
        let parsed: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if parsed.get("type").and_then(|v| v.as_str()) != Some("match") {
            continue;
        }

        let file_path = match parsed
            .get("data")
            .and_then(|d| d.get("path"))
            .and_then(|p| p.get("text"))
            .and_then(|t| t.as_str())
        {
            Some(p) => p.replace('\\', "/"),
            None => continue,
        };

        let line_number = match parsed
            .get("data")
            .and_then(|d| d.get("line_number"))
            .and_then(|n| n.as_u64())
        {
            Some(n) => n as usize,
            None => continue,
        };

        let line_text = parsed
            .get("data")
            .and_then(|d| d.get("lines"))
            .and_then(|l| l.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .trim_end_matches(['\r', '\n'])
            .to_string();

        if !grouped.contains_key(&file_path) {
            if grouped.len() >= max_files_with_matches {
                truncated = true;
                break;
            }
            grouped.insert(file_path.clone(), Vec::new());
        }

        if let Some(matches) = grouped.get_mut(&file_path) {
            if matches.len() >= max_matches_per_file {
                truncated = true;
                continue;
            }
            matches.push(FileSearchMatch {
                line_number,
                line_text,
            });
        }
    }

    let results = grouped
        .into_iter()
        .map(|(file_path, matches)| FileSearchResult { file_path, matches })
        .collect();

    Ok(IpcResult::success(FileSearchResponse {
        results,
        truncated,
        scanned_files: 0,
        failed_files: 0,
    }))
}

/// Get current schema version
#[tauri::command]
pub async fn data_migration_get_version(
    migration_manager: State<'_, Arc<MigrationManager>>,
) -> Result<IpcResult<String>, String> {
    Ok(migration_manager.get_current_schema_version())
}

/// Get schema version info (current and target)
#[tauri::command]
pub async fn data_migration_get_schema_info(
    migration_manager: State<'_, Arc<MigrationManager>>,
) -> Result<IpcResult<SchemaVersion>, String> {
    Ok(migration_manager.get_schema_version_info())
}

/// Get migration history
#[tauri::command]
pub async fn data_migration_get_history(
    migration_manager: State<'_, Arc<MigrationManager>>,
) -> Result<IpcResult<Vec<MigrationRecord>>, String> {
    Ok(migration_manager.get_migration_history())
}

/// Get all registered migrations
#[tauri::command]
pub async fn data_migration_get_registered(
    migration_manager: State<'_, Arc<MigrationManager>>,
) -> Result<IpcResult<Vec<MigrationInfo>>, String> {
    Ok(migration_manager.get_registered_migrations())
}

/// Run pending migrations
#[tauri::command]
pub async fn data_migration_run_migrations(
    migration_manager: State<'_, Arc<MigrationManager>>,
) -> Result<IpcResult<Vec<MigrationResult>>, String> {
    Ok(migration_manager.run_migrations())
}

/// Rollback to a specific version
#[tauri::command]
pub async fn data_migration_rollback(
    request: RollbackRequest,
    migration_manager: State<'_, Arc<MigrationManager>>,
) -> Result<IpcResult<()>, String> {
    Ok(migration_manager.rollback_migration(request.version))
}

// ============================================================================
// SSH Commands
// ============================================================================

use crate::ssh::config_parser;
use crate::ssh::profile_manager::SSHProfile;
use crate::ssh::sftp as sftp_ops;
use crate::ssh::SSHManager;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SSHConnectRequest {
    pub profile_id: String,
    pub password: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SSHPortForwardRequest {
    pub connection_id: String,
    pub id: String,
    pub forward_type: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    pub label: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SFTPPathRequest {
    pub connection_id: String,
    pub remote_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SFTPTransferRequest {
    pub connection_id: String,
    pub remote_path: String,
    pub local_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SFTPRenameRequest {
    pub connection_id: String,
    pub old_path: String,
    pub new_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SFTPFileRequest {
    pub connection_id: String,
    pub remote_path: String,
    pub content: Option<String>,
}

#[tauri::command]
pub async fn ssh_list_profiles(
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<Vec<SSHProfile>>, String> {
    match ssh_manager.profiles.list() {
        Ok(profiles) => Ok(IpcResult::success(profiles)),
        Err(e) => Ok(IpcResult::error(e, "SSH_PROFILE_ERROR")),
    }
}

#[tauri::command]
pub async fn ssh_save_profile(
    profile: SSHProfile,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<()>, String> {
    match ssh_manager.profiles.save(profile) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "SSH_PROFILE_ERROR")),
    }
}

#[tauri::command]
pub async fn ssh_delete_profile(
    profile_id: String,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<()>, String> {
    match ssh_manager.profiles.delete(&profile_id) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "SSH_PROFILE_ERROR")),
    }
}

#[tauri::command]
pub async fn ssh_import_config(
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<Vec<SSHProfile>>, String> {
    let parsed = config_parser::parse_ssh_config();
    match ssh_manager.profiles.import_from_config(parsed) {
        Ok(imported) => Ok(IpcResult::success(imported)),
        Err(e) => Ok(IpcResult::error(e, "SSH_IMPORT_ERROR")),
    }
}

#[tauri::command]
pub async fn ssh_connect(
    request: SSHConnectRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<crate::ssh::connection::SSHConnectionInfo>, String> {
    // Load profile with credentials from OS keychain
    let profile = match ssh_manager
        .profiles
        .get_with_credentials(&request.profile_id)
    {
        Ok(Some(p)) => p,
        Ok(None) => {
            return Ok(IpcResult::error(
                "Profile not found",
                "SSH_PROFILE_NOT_FOUND",
            ))
        }
        Err(e) => return Ok(IpcResult::error(e, "SSH_PROFILE_ERROR")),
    };

    // Use request password, or fall back to keychain-stored credential
    let password = request
        .password
        .or_else(|| match profile.auth_method.as_str() {
            "password" => profile.password.clone(),
            "key" => profile.passphrase.clone(),
            _ => None,
        });

    match ssh_manager
        .connections
        .connect(&profile, password.as_deref())
        .await
    {
        Ok(info) => {
            // Update last_connected
            let _ = ssh_manager
                .profiles
                .update_last_connected(&request.profile_id);
            Ok(IpcResult::success(info))
        }
        Err(e) => Ok(IpcResult::error(e, "SSH_CONNECT_ERROR")),
    }
}

#[tauri::command]
pub async fn ssh_disconnect(
    connection_id: String,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<()>, String> {
    match ssh_manager.disconnect(&connection_id).await {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "SSH_DISCONNECT_ERROR")),
    }
}

#[tauri::command]
pub async fn ssh_get_connections(
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<Vec<crate::ssh::connection::SSHConnectionInfo>>, String> {
    Ok(IpcResult::success(
        ssh_manager.connections.list_connections().await,
    ))
}

#[tauri::command]
pub async fn ssh_port_forward_start(
    request: SSHPortForwardRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<crate::ssh::port_forward::ActivePortForward>, String> {
    if ssh_manager
        .connections
        .get_connection(&request.connection_id)
        .await
        .is_none()
    {
        return Ok(IpcResult::error(
            "Connection not found",
            "SSH_CONNECTION_NOT_FOUND",
        ));
    }

    let session = match ssh_manager
        .connections
        .clone_session(&request.connection_id)
        .await
    {
        Ok(session) => session,
        Err(e) => return Ok(IpcResult::error(e, "SSH_CONNECTION_NOT_FOUND")),
    };

    let pf_request = crate::ssh::port_forward::PortForwardRequest {
        id: request.id,
        forward_type: request.forward_type,
        local_port: request.local_port,
        remote_host: request.remote_host,
        remote_port: request.remote_port,
        label: request.label,
    };

    match ssh_manager
        .port_forwards
        .start_local_forward(&request.connection_id, pf_request, session)
        .await
    {
        Ok(forward) => Ok(IpcResult::success(forward)),
        Err(e) => Ok(IpcResult::error(e, "SSH_PORT_FORWARD_ERROR")),
    }
}

#[tauri::command]
pub async fn ssh_port_forward_stop(
    connection_id: String,
    forward_id: String,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<()>, String> {
    match ssh_manager
        .port_forwards
        .stop_forward(&connection_id, &forward_id)
    {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "SSH_PORT_FORWARD_ERROR")),
    }
}

#[tauri::command]
pub async fn sftp_list_dir(
    request: SFTPPathRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<Vec<crate::ssh::sftp::SFTPEntry>>, String> {
    let remote_path = request.remote_path.clone();
    match ssh_manager
        .connections
        .with_session(&request.connection_id, |session| {
            let sftp = sftp_ops::create_sftp(session)?;
            sftp_ops::list_dir(&sftp, &remote_path)
        })
        .await
    {
        Ok(entries) => Ok(IpcResult::success(entries)),
        Err(e) => Ok(IpcResult::error(e, "SFTP_ERROR")),
    }
}

#[tauri::command]
pub async fn sftp_download(
    request: SFTPTransferRequest,
    app_handle: AppHandle,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<()>, String> {
    let remote_path = request.remote_path.clone();
    let local_path = request.local_path.clone();
    let conn_id = request.connection_id.clone();
    let app = app_handle.clone();

    // Clone session to avoid holding the per-connection mutex during long I/O
    let session = match ssh_manager
        .connections
        .clone_session(&request.connection_id)
        .await
    {
        Ok(s) => s,
        Err(e) => return Ok(IpcResult::error(e, "SFTP_DOWNLOAD_ERROR")),
    };

    match tokio::task::spawn_blocking(move || {
        let sftp = sftp_ops::create_sftp(&session)?;
        sftp_ops::download_file(&sftp, &remote_path, &local_path, &app, &conn_id)
    })
    .await
    {
        Ok(Ok(())) => Ok(IpcResult::success(())),
        Ok(Err(e)) => Ok(IpcResult::error(e, "SFTP_DOWNLOAD_ERROR")),
        Err(e) => Ok(IpcResult::error(format!("Task failed: {}", e), "SFTP_DOWNLOAD_ERROR")),
    }
}

#[tauri::command]
pub async fn sftp_upload(
    request: SFTPTransferRequest,
    app_handle: AppHandle,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<()>, String> {
    let remote_path = request.remote_path.clone();
    let local_path = request.local_path.clone();
    let conn_id = request.connection_id.clone();
    let app = app_handle.clone();

    // Clone session to avoid holding the per-connection mutex during long I/O
    let session = match ssh_manager
        .connections
        .clone_session(&request.connection_id)
        .await
    {
        Ok(s) => s,
        Err(e) => return Ok(IpcResult::error(e, "SFTP_UPLOAD_ERROR")),
    };

    match tokio::task::spawn_blocking(move || {
        let sftp = sftp_ops::create_sftp(&session)?;
        sftp_ops::upload_file(&sftp, &local_path, &remote_path, &app, &conn_id)
    })
    .await
    {
        Ok(Ok(())) => Ok(IpcResult::success(())),
        Ok(Err(e)) => Ok(IpcResult::error(e, "SFTP_UPLOAD_ERROR")),
        Err(e) => Ok(IpcResult::error(format!("Task failed: {}", e), "SFTP_UPLOAD_ERROR")),
    }
}

#[tauri::command]
pub async fn sftp_delete(
    request: SFTPPathRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<()>, String> {
    let remote_path = request.remote_path.clone();
    match ssh_manager
        .connections
        .with_session(&request.connection_id, |session| {
            let sftp = sftp_ops::create_sftp(session)?;
            sftp_ops::delete_path(&sftp, &remote_path)
        })
        .await
    {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "SFTP_DELETE_ERROR")),
    }
}

#[tauri::command]
pub async fn sftp_mkdir(
    request: SFTPPathRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<()>, String> {
    let remote_path = request.remote_path.clone();
    match ssh_manager
        .connections
        .with_session(&request.connection_id, |session| {
            let sftp = sftp_ops::create_sftp(session)?;
            sftp_ops::mkdir(&sftp, &remote_path)
        })
        .await
    {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "SFTP_MKDIR_ERROR")),
    }
}

#[tauri::command]
pub async fn sftp_rename(
    request: SFTPRenameRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<()>, String> {
    let old_path = request.old_path.clone();
    let new_path = request.new_path.clone();
    match ssh_manager
        .connections
        .with_session(&request.connection_id, |session| {
            let sftp = sftp_ops::create_sftp(session)?;
            sftp_ops::rename(&sftp, &old_path, &new_path)
        })
        .await
    {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "SFTP_RENAME_ERROR")),
    }
}

#[tauri::command]
pub async fn ssh_create_askpass(password: String) -> Result<IpcResult<String>, String> {
    let temp_dir = std::env::temp_dir();
    let id = uuid::Uuid::new_v4()
        .to_string()
        .split('-')
        .next()
        .unwrap_or("tmp")
        .to_string();
    let password_path = temp_dir.join(format!("termul-askpass-{}.dat", id));

    // Write the raw password to a separate data file to avoid shell metacharacter injection.
    if let Err(e) = std::fs::write(&password_path, password.as_bytes()) {
        return Ok(IpcResult::error(
            format!("Failed to create askpass data: {}", e),
            "SSH_ASKPASS_ERROR",
        ));
    }

    // Restrict file permissions: owner-only on Unix, hidden attribute on Windows
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&password_path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(windows)]
    {
        // Mark the data file as hidden to reduce casual exposure
        use std::process::Command;
        let _ = Command::new("attrib")
            .args(["+H", &password_path.to_string_lossy()])
            .output();
    }

    // Create platform-specific askpass script
    #[cfg(windows)]
    let script_path = {
        let path = temp_dir.join(format!("termul-askpass-{}.bat", id));
        // The batch script outputs the password file contents and cleans up both files on exit.
        let content = format!(
            "@echo off\r\ntype \"{}\"\r\ndel /q \"{}\" >nul 2>&1\r\n(goto) 2>nul & del /q \"%~f0\" >nul 2>&1\r\n",
            password_path.to_string_lossy(),
            password_path.to_string_lossy(),
        );
        if let Err(e) = std::fs::write(&path, &content) {
            let _ = std::fs::remove_file(&password_path);
            return Ok(IpcResult::error(
                format!("Failed to create askpass: {}", e),
                "SSH_ASKPASS_ERROR",
            ));
        }
        path
    };

    #[cfg(unix)]
    let script_path = {
        use std::os::unix::fs::PermissionsExt;
        let path = temp_dir.join(format!("termul-askpass-{}.sh", id));
        // The shell script outputs the password file and cleans up both files.
        let content = format!(
            "#!/bin/sh\ncat \"{}\"\nrm -f \"{}\" \"$0\"\n",
            password_path.to_string_lossy(),
            password_path.to_string_lossy(),
        );
        if let Err(e) = std::fs::write(&path, &content) {
            let _ = std::fs::remove_file(&password_path);
            return Ok(IpcResult::error(
                format!("Failed to create askpass: {}", e),
                "SSH_ASKPASS_ERROR",
            ));
        }
        // Make the script executable
        if let Err(e) = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)) {
            let _ = std::fs::remove_file(&password_path);
            let _ = std::fs::remove_file(&path);
            return Ok(IpcResult::error(
                format!("Failed to set askpass permissions: {}", e),
                "SSH_ASKPASS_ERROR",
            ));
        }
        path
    };

    // Spawn a background cleanup task that removes both files after a timeout,
    // ensuring secrets don't persist on disk if the helper is never invoked.
    let cleanup_script = script_path.clone();
    let cleanup_password = password_path.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        let _ = std::fs::remove_file(&cleanup_password);
        let _ = std::fs::remove_file(&cleanup_script);
    });

    log::info!("[SSH] Created askpass helper at {:?}", script_path);
    Ok(IpcResult::success(
        script_path.to_string_lossy().to_string(),
    ))
}

#[tauri::command]
pub async fn sftp_read_file(
    request: SFTPFileRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<String>, String> {
    let remote_path = request.remote_path.clone();
    match ssh_manager
        .connections
        .with_session(&request.connection_id, |session| {
            let sftp = sftp_ops::create_sftp(session)?;
            sftp_ops::read_file_to_string(&sftp, &remote_path)
        })
        .await
    {
        Ok(content) => Ok(IpcResult::success(content)),
        Err(e) => Ok(IpcResult::error(e, "SFTP_READ_ERROR")),
    }
}

#[tauri::command]
pub async fn sftp_write_file(
    request: SFTPFileRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<()>, String> {
    let remote_path = request.remote_path.clone();
    let content = request.content.clone().unwrap_or_default();
    match ssh_manager
        .connections
        .with_session(&request.connection_id, |session| {
            let sftp = sftp_ops::create_sftp(session)?;
            sftp_ops::write_file_from_string(&sftp, &remote_path, &content)
        })
        .await
    {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "SFTP_WRITE_ERROR")),
    }
}

#[tauri::command]
pub async fn sftp_create_file(
    request: SFTPPathRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<()>, String> {
    let remote_path = request.remote_path.clone();
    match ssh_manager
        .connections
        .with_session(&request.connection_id, |session| {
            let sftp = sftp_ops::create_sftp(session)?;
            sftp_ops::create_file(&sftp, &remote_path)
        })
        .await
    {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "SFTP_CREATE_ERROR")),
    }
}

// ==================== Remote Server Commands ====================

/// Start the remote terminal server
#[tauri::command]
pub async fn remote_server_start(
    app_handle: AppHandle,
    pty_manager: State<'_, Arc<PtyManager>>,
    remote_state: State<'_, Arc<remote::RemoteServerState>>,
) -> Result<IpcResult<remote::RemoteStatus>, String> {
    match remote_state
        .start(pty_manager.inner().clone(), app_handle)
        .await
    {
        Ok(status) => Ok(IpcResult::success(status)),
        Err(e) => Ok(IpcResult::error(e, "REMOTE_START_FAILED")),
    }
}

/// Stop the remote terminal server
#[tauri::command]
pub async fn remote_server_stop(
    remote_state: State<'_, Arc<remote::RemoteServerState>>,
) -> Result<IpcResult<remote::RemoteStatus>, String> {
    match remote_state.stop().await {
        Ok(status) => Ok(IpcResult::success(status)),
        Err(e) => Ok(IpcResult::error(e, "REMOTE_STOP_FAILED")),
    }
}

/// Get remote server status
#[tauri::command]
pub async fn remote_server_status(
    remote_state: State<'_, Arc<remote::RemoteServerState>>,
) -> Result<IpcResult<remote::RemoteStatus>, String> {
    Ok(IpcResult::success(remote_state.status()))
}

/// Publish the renderer's project → terminal tree to the remote server.
///
/// The web client reads this tree from `GET /api/projects`. The renderer should
/// call this whenever its projects/terminals change (and once on server start).
#[tauri::command]
pub async fn remote_publish_projects(
    tree: remote::ProjectTree,
    remote_state: State<'_, Arc<remote::RemoteServerState>>,
) -> Result<IpcResult<()>, String> {
    remote_state.registry.replace(tree);
    Ok(IpcResult::success(()))
}

// ==================== Git Commands ====================

/// Get git status for a repository
#[tauri::command]
pub async fn git_get_status(
    cwd: String,
) -> Result<Vec<GitStatusDetail>, String> {
    crate::trackers::git_tracker::git_get_status_detail(&cwd)
        .map_err(|e: String| e)
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

/// Get available shells
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ipc_result_success() {
        let result: IpcResult<String> = IpcResult::success("test".to_string());
        assert!(result.success);
        assert_eq!(result.data, Some("test".to_string()));
        assert!(result.error.is_none());
        assert!(result.code.is_none());
    }

    #[test]
    fn test_ipc_result_error() {
        let result: IpcResult<String> = IpcResult::error("test error", "TEST_ERROR");
        assert!(!result.success);
        assert!(result.data.is_none());
        assert_eq!(result.error, Some("test error".to_string()));
        assert_eq!(result.code, Some("TEST_ERROR".to_string()));
    }
}
