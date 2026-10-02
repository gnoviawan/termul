//! HTTP handlers for git operations exposed to the web/remote client
//! (CAP-1: Web & Mobile 1:1 Parity).
//!
//! Mirrors the desktop `#[tauri::command] git_*` handlers in `commands.rs`
//! over HTTP, reusing the SAME `git_tracker` logic (`git_get_status_detail`,
//! `git_get_diff`, `git_stage_file`, `git_commit_file`, `git_push_current`,
//! the inline `stash`/`branch` command runners). Each route:
//!
//! - enforces `resolve_request_path` (inherited from `fs_api`) for `..`
//!   rejection + canonicalization, then a `project_root` containment check
//!   (`OUTSIDE_PROJECT_ROOT`) — the web server is a security boundary the
//!   desktop commands do not need.
//! - enforces `check_local_only` (loopback guard) on WRITE routes, matching
//!   the fs_api mutation pattern (`mkdir`/`write`/`delete`/…).
//! - wraps results in `IpcBody<T>` (`{ success, data } | { success, error, code }`)
//!   so the renderer facade swaps transparently with the desktop `IpcResult<T>`.
//! - runs blocking git calls on `tokio::task::spawn_blocking` (template:
//!   `fs_api::git_init`).
//! - logs at route boundaries via `tracing` (the standalone server's logger;
//!   a no-op when no subscriber is installed on the desktop shared-live path).

use std::net::SocketAddr;
use std::path::Path;

use axum::{
    extract::{ConnectInfo, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::trackers::git_tracker::{
    self, GitCommit, GitCommitContext, GitStatusDetail, GitTracker,
};
use crate::web::fs_api::{check_local_only, resolve_request_path, IpcBody};
use crate::web::ws::AppState;

/// `POST /git/status { cwd }` body. Mirrors the desktop `git_get_status`
/// command shape.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCwdRequest {
    pub cwd: String,
}

/// `POST /git/diff { cwd, path, staged? }` body. `staged` defaults to `false`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffRequest {
    pub cwd: String,
    pub path: String,
    #[serde(default)]
    pub staged: bool,
}

/// `POST /git/stage | unstage | discard { cwd, path }` body.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPathRequest {
    pub cwd: String,
    pub path: String,
}

/// `POST /git/log { cwd, limit? }` body. `limit` is clamped server-side
/// (`GIT_LOG_DEFAULT_LIMIT`/`GIT_LOG_MAX_LIMIT`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLogRequest {
    pub cwd: String,
    pub limit: Option<u32>,
}

/// `POST /git/commit { cwd, summary, description?, amend? }` body.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitRequest {
    pub cwd: String,
    pub summary: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub amend: bool,
}

/// `POST /git/checkout-branch { cwd, branch, isRemote? }` body.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCheckoutBranchRequest {
    pub cwd: String,
    pub branch: String,
    #[serde(default)]
    pub is_remote: bool,
}

/// `POST /git/create-branch { cwd, branch, startRef? }` body.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCreateBranchRequest {
    pub cwd: String,
    pub branch: String,
    pub start_ref: Option<String>,
}

/// `POST /git/stash-save { cwd, message?, includeUntracked? }` body.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStashSaveRequest {
    pub cwd: String,
    pub message: Option<String>,
    pub include_untracked: Option<bool>,
}

/// `POST /git/stash-apply | stash-pop | stash-drop { cwd, index }` body.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStashIndexRequest {
    pub cwd: String,
    pub index: usize,
}

/// `GET /git/stash-list?cwd=...` / `GET /git/branch-list?cwd=...` query.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCwdQuery {
    pub cwd: String,
}

/// `POST /git/branch-switch | branch-create { cwd, name }` body.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchNameRequest {
    pub cwd: String,
    pub name: String,
}

/// Mirrors the shared TS `GitStashInfo` contract (`{ index, name, message }`)
/// and the desktop `commands::GitStashInfo` struct. Local DTO so the web
/// module does not depend on `commands.rs` (which is desktop-wired).
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStashInfoDto {
    pub index: usize,
    pub name: String,
    pub message: String,
}

/// Reject when the resolved cwd is outside `project_root`. Returns `None` when
/// the cwd is within bounds; otherwise `Some(IpcBody::err(...,
/// "OUTSIDE_PROJECT_ROOT"))`. Both `resolved` (from `resolve_request_path`) and
/// `project_root` (from `AppState`, set via `resolve_and_validate_project_root`
/// at startup) are canonicalized, so `starts_with` is a reliable containment
/// check on every platform.
pub(crate) fn ensure_within_project_root<T>(
    resolved: &Path,
    project_root: &Path,
) -> Option<IpcBody<T>> {
    if resolved.starts_with(project_root) {
        None
    } else {
        Some(IpcBody::<T>::err(
            format!(
                "cwd '{}' is outside project_root '{}'",
                resolved.display(),
                project_root.display()
            ),
            "OUTSIDE_PROJECT_ROOT",
        ))
    }
}

/// Reject when the resolved cwd is outside ALL authorized project roots. First
/// checks the default `project_root` via `ensure_within_project_root` (fast
/// path — single `starts_with`), then falls back to ALL registered project
/// roots (handles a web client that switched to a non-default project via
/// per-connection `switch_project` — the boundary follows any registered
/// project, not just the host default). Returns `None` when within bounds;
/// otherwise `Some(IpcBody::err(..., "OUTSIDE_PROJECT_ROOT"))`.
pub(crate) fn ensure_within_project_boundary<T>(
    resolved: &Path,
    project_root: &Path,
    registry: &crate::web::project_registry::ProjectRegistry,
) -> Option<IpcBody<T>> {
    ensure_within_project_root::<T>(resolved, project_root)
        .filter(|_| !registry.is_within_any_registered_root(resolved))
}

/// Resolve + boundary-check the request `cwd`. On failure returns the
/// `(StatusCode, Json<IpcBody::err>)` to send directly; on success returns the
/// resolved `PathBuf` (which the caller passes to `spawn_blocking` as a
/// tool-friendly `String`). `peer` is the request peer for the loopback write
/// guard (`Some` on write routes, `None` on read routes).
type RouteErr<T> = (StatusCode, Json<IpcBody<T>>);

pub(super) fn resolve_cwd<T>(
    req_cwd: &str,
    state: &AppState,
    peer: Option<SocketAddr>,
    is_write: bool,
) -> Result<std::path::PathBuf, RouteErr<T>> {
    // 1) Loopback guard for write routes FIRST — fail fast on non-local peers
    //    before any filesystem work. `resolve_request_path` canonicalizes
    //    (follows symlinks / reads FS metadata); a LAN peer must not trigger
    //    that on a write (mutation safety on a 0.0.0.0 bind).
    if is_write {
        if let Some(peer) = peer {
            if let Some(forbidden) = check_local_only::<T>(
                peer,
                state.allow_remote_writes,
                state.shared_live_writes_denied,
                "/git/*",
            ) {
                return Err((StatusCode::OK, Json(forbidden)));
            }
        }
    }
    // 2) `..` rejection + canonicalization.
    let resolved = match resolve_request_path(Path::new(req_cwd)) {
        Ok(safe) => safe,
        Err((msg, code)) => {
            return Err((StatusCode::OK, Json(IpcBody::<T>::err(msg, code))));
        }
    };
    // 3) project_root containment (web-server security boundary). CAP-1:
    //    lock-read the RwLock for the duration of the `starts_with` check
    //    (sync — no `.await` under the guard). The boundary may have been
    //    rebound by a project switch since the last request. CAP-2: also
    //    check ALL registered project roots so a web client that switched to
    //    a non-default project (per-connection `switch_project`) can operate
    //    on it — the boundary follows any registered project, not just the
    //    host default.
    let outside_err = {
        let project_root = state.project_root.read();
        ensure_within_project_boundary::<T>(&resolved, &project_root, &state.registry)
    };
    if let Some(err) = outside_err {
        return Err((StatusCode::OK, Json(err)));
    }
    Ok(resolved)
}

/// Convert a resolved `PathBuf` to a tool-friendly `String`. Mirrors the
/// desktop `validate_project_path` behavior of stripping the Windows verbatim
/// (`\\?\`) prefix so `git.exe` receives a path it understands. Returns an
/// `IpcBody::err` (`INVALID_PATH_ENCODING`) when the path resolves to empty.
fn cwd_string<T>(resolved: &std::path::Path) -> Result<String, RouteErr<T>> {
    let lossy = resolved.to_string_lossy();
    let simplified = crate::path_validation::strip_verbatim_prefix(&lossy).into_owned();
    if simplified.is_empty() {
        return Err((
            StatusCode::OK,
            Json(IpcBody::<T>::err(
                "cwd resolved to empty path",
                "INVALID_PATH_ENCODING",
            )),
        ));
    }
    Ok(simplified)
}

// ============================ Route handlers ============================

/// `POST /git/status` — list modified/staged/untracked entries.
/// Mirrors `git_get_status` → `git_tracker::git_get_status_detail`.
pub async fn get_status(
    State(state): State<AppState>,
    Json(req): Json<GitCwdRequest>,
) -> impl IntoResponse {
    let resolved = match resolve_cwd::<Vec<GitStatusDetail>>(&req.cwd, &state, None, false) {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    let cwd = match cwd_string::<Vec<GitStatusDetail>>(&resolved) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let cwd_for_log = cwd.clone();
    let result = tokio::task::spawn_blocking(move || git_tracker::git_get_status_detail(&cwd))
        .await
        .map_err(|e| format!("git status task failed: {e}"));
    let body = match result {
        Ok(Ok(rows)) => {
            tracing::info!(path = %cwd_for_log, entries = rows.len(), "git status ok");
            IpcBody::ok(rows)
        }
        Ok(Err(e)) => {
            tracing::warn!(path = %cwd_for_log, error = %e, "git status failed");
            IpcBody::<Vec<GitStatusDetail>>::err(e, "GIT_STATUS_ERROR")
        }
        Err(e) => {
            tracing::error!(path = %cwd_for_log, error = %e, "git status task panicked");
            IpcBody::<Vec<GitStatusDetail>>::err(
                format!("git status task failed: {e}"),
                "GIT_STATUS_ERROR",
            )
        }
    };
    (StatusCode::OK, Json(body))
}

/// `POST /git/diff` — diff for a single path. `staged` selects the
/// index-vs-HEAD diff; untracked files are shown via `--no-index`.
pub async fn get_diff(
    State(state): State<AppState>,
    Json(req): Json<GitDiffRequest>,
) -> impl IntoResponse {
    let resolved = match resolve_cwd::<String>(&req.cwd, &state, None, false) {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    let cwd = match cwd_string::<String>(&resolved) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let cwd_for_log = cwd.clone();
    let path = req.path;
    let staged = req.staged;
    let result =
        tokio::task::spawn_blocking(move || git_tracker::git_get_diff(&cwd, &path, staged))
            .await
            .map_err(|e| format!("git diff task failed: {e}"));
    let body = match result {
        Ok(Ok(diff)) => {
            tracing::info!(path = %cwd_for_log, bytes = diff.len(), "git diff ok");
            IpcBody::ok(diff)
        }
        Ok(Err(e)) => {
            tracing::warn!(path = %cwd_for_log, error = %e, "git diff failed");
            IpcBody::<String>::err(e, "GIT_DIFF_ERROR")
        }
        Err(e) => {
            tracing::error!(path = %cwd_for_log, error = %e, "git diff task panicked");
            IpcBody::<String>::err(format!("git diff task failed: {e}"), "GIT_DIFF_ERROR")
        }
    };
    (StatusCode::OK, Json(body))
}

/// `POST /git/stage` — `git add -- <path>` (write, loopback-guarded).
pub async fn stage(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<GitPathRequest>,
) -> impl IntoResponse {
    run_git_path_write(
        &state,
        peer,
        req,
        git_tracker::git_stage_file,
        "stage",
        "GIT_STAGE_ERROR",
    )
    .await
}

/// `POST /git/unstage` — `git reset -q HEAD -- <path>` (or `git rm --cached`
/// in a no-HEAD repo). Write, loopback-guarded.
pub async fn unstage(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<GitPathRequest>,
) -> impl IntoResponse {
    run_git_path_write(
        &state,
        peer,
        req,
        git_tracker::git_unstage_file,
        "unstage",
        "GIT_UNSTAGE_ERROR",
    )
    .await
}

/// `POST /git/discard` — revert worktree or delete untracked. Destructive;
/// loopback-guarded.
pub async fn discard(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<GitPathRequest>,
) -> impl IntoResponse {
    run_git_path_write(
        &state,
        peer,
        req,
        git_tracker::git_discard_file,
        "discard",
        "GIT_DISCARD_ERROR",
    )
    .await
}

/// `POST /git/log` — commit history (read-only).
pub async fn get_log(
    State(state): State<AppState>,
    Json(req): Json<GitLogRequest>,
) -> impl IntoResponse {
    let resolved = match resolve_cwd::<Vec<GitCommit>>(&req.cwd, &state, None, false) {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    let cwd = match cwd_string::<Vec<GitCommit>>(&resolved) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let cwd_for_log = cwd.clone();
    let limit = req.limit;
    let result = tokio::task::spawn_blocking(move || git_tracker::git_get_log(&cwd, limit))
        .await
        .map_err(|e| format!("git log task failed: {e}"));
    let body = match result {
        Ok(Ok(commits)) => {
            tracing::info!(path = %cwd_for_log, commits = commits.len(), "git log ok");
            IpcBody::ok(commits)
        }
        Ok(Err(e)) => {
            tracing::warn!(path = %cwd_for_log, error = %e, "git log failed");
            IpcBody::<Vec<GitCommit>>::err(e, "GIT_LOG_ERROR")
        }
        Err(e) => {
            tracing::error!(path = %cwd_for_log, error = %e, "git log task panicked");
            IpcBody::<Vec<GitCommit>>::err(format!("git log task failed: {e}"), "GIT_LOG_ERROR")
        }
    };
    (StatusCode::OK, Json(body))
}

/// `POST /git/commit` — create/amend a commit from the staged index (write).
pub async fn commit(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<GitCommitRequest>,
) -> impl IntoResponse {
    let resolved = match resolve_cwd::<()>(&req.cwd, &state, Some(peer), true) {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    let cwd = match cwd_string::<()>(&resolved) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let cwd_for_log = cwd.clone();
    let summary = req.summary;
    let description = req.description;
    let amend = req.amend;
    let result = tokio::task::spawn_blocking(move || {
        git_tracker::git_commit_file(&cwd, &summary, &description, amend)
    })
    .await
    .map_err(|e| format!("git commit task failed: {e}"));
    let body = match result {
        Ok(Ok(())) => {
            tracing::info!(path = %cwd_for_log, amend, "git commit ok");
            IpcBody::<()>::ok(())
        }
        Ok(Err(e)) => {
            tracing::warn!(path = %cwd_for_log, error = %e, "git commit failed");
            IpcBody::<()>::err(e, "GIT_COMMIT_ERROR")
        }
        Err(e) => {
            tracing::error!(path = %cwd_for_log, error = %e, "git commit task panicked");
            IpcBody::<()>::err(format!("git commit task failed: {e}"), "GIT_COMMIT_ERROR")
        }
    };
    (StatusCode::OK, Json(body))
}

/// `POST /git/push` — push current branch to origin (network write,
/// loopback-guarded). Uses `GIT_TERMINAL_PROMPT=0` so a credential prompt
/// fails fast instead of blocking until the network timeout.
pub async fn push(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<GitCwdRequest>,
) -> impl IntoResponse {
    let resolved = match resolve_cwd::<()>(&req.cwd, &state, Some(peer), true) {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    let cwd = match cwd_string::<()>(&resolved) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let cwd_for_log = cwd.clone();
    let result = tokio::task::spawn_blocking(move || git_tracker::git_push_current(&cwd))
        .await
        .map_err(|e| format!("git push task failed: {e}"));
    let body = match result {
        Ok(Ok(())) => {
            tracing::info!(path = %cwd_for_log, "git push ok");
            IpcBody::<()>::ok(())
        }
        Ok(Err(e)) => {
            tracing::warn!(path = %cwd_for_log, error = %e, "git push failed");
            IpcBody::<()>::err(e, "GIT_PUSH_ERROR")
        }
        Err(e) => {
            tracing::error!(path = %cwd_for_log, error = %e, "git push task panicked");
            IpcBody::<()>::err(format!("git push task failed: {e}"), "GIT_PUSH_ERROR")
        }
    };
    (StatusCode::OK, Json(body))
}

/// `POST /git/commit-context` — branch, upstream, ahead/behind, last commit
/// (read-only). Used to prefill the commit footer.
pub async fn get_commit_context(
    State(state): State<AppState>,
    Json(req): Json<GitCwdRequest>,
) -> impl IntoResponse {
    let resolved = match resolve_cwd::<GitCommitContext>(&req.cwd, &state, None, false) {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    let cwd = match cwd_string::<GitCommitContext>(&resolved) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let cwd_for_log = cwd.clone();
    let result = tokio::task::spawn_blocking(move || git_tracker::git_get_commit_context(&cwd))
        .await
        .map_err(|e| format!("git commit-context task failed: {e}"));
    let body = match result {
        Ok(Ok(ctx)) => {
            tracing::info!(
                path = %cwd_for_log,
                branch = ?ctx.branch,
                has_upstream = ctx.has_upstream,
                "git commit-context ok"
            );
            IpcBody::ok(ctx)
        }
        Ok(Err(e)) => {
            tracing::warn!(path = %cwd_for_log, error = %e, "git commit-context failed");
            IpcBody::<GitCommitContext>::err(e, "GIT_COMMIT_CONTEXT_ERROR")
        }
        Err(e) => {
            tracing::error!(path = %cwd_for_log, error = %e, "git commit-context task panicked");
            IpcBody::<GitCommitContext>::err(
                format!("git commit-context task failed: {e}"),
                "GIT_COMMIT_CONTEXT_ERROR",
            )
        }
    };
    (StatusCode::OK, Json(body))
}

/// `POST /git/checkout-branch` — checkout existing local/remote branch (write).
pub async fn checkout_branch(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<GitCheckoutBranchRequest>,
) -> impl IntoResponse {
    let resolved = match resolve_cwd::<()>(&req.cwd, &state, Some(peer), true) {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    let cwd = match cwd_string::<()>(&resolved) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let cwd_for_log = cwd.clone();
    let branch = req.branch;
    let branch_for_log = branch.clone();
    let is_remote = req.is_remote;
    let result = tokio::task::spawn_blocking(move || {
        git_tracker::git_checkout_branch(&cwd, &branch, is_remote)
    })
    .await
    .map_err(|e| format!("git checkout task failed: {e}"));
    let body = match result {
        Ok(Ok(())) => {
            tracing::info!(path = %cwd_for_log, branch = %branch_for_log, "git checkout ok");
            IpcBody::<()>::ok(())
        }
        Ok(Err(e)) => {
            tracing::warn!(path = %cwd_for_log, branch = %branch_for_log, error = %e, "git checkout failed");
            IpcBody::<()>::err(e, "GIT_CHECKOUT_ERROR")
        }
        Err(e) => {
            tracing::error!(path = %cwd_for_log, error = %e, "git checkout task panicked");
            IpcBody::<()>::err(
                format!("git checkout task failed: {e}"),
                "GIT_CHECKOUT_ERROR",
            )
        }
    };
    (StatusCode::OK, Json(body))
}

/// `POST /git/create-branch` — create + checkout a new branch from `start_ref`
/// (defaults to HEAD). Write.
pub async fn create_branch(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<GitCreateBranchRequest>,
) -> impl IntoResponse {
    let resolved = match resolve_cwd::<()>(&req.cwd, &state, Some(peer), true) {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    let cwd = match cwd_string::<()>(&resolved) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let cwd_for_log = cwd.clone();
    let branch = req.branch;
    let branch_for_log = branch.clone();
    let start_ref = req.start_ref;
    let result = tokio::task::spawn_blocking(move || {
        git_tracker::git_create_branch(&cwd, &branch, start_ref.as_deref())
    })
    .await
    .map_err(|e| format!("git create-branch task failed: {e}"));
    let body = match result {
        Ok(Ok(())) => {
            tracing::info!(path = %cwd_for_log, branch = %branch_for_log, "git create-branch ok");
            IpcBody::<()>::ok(())
        }
        Ok(Err(e)) => {
            tracing::warn!(path = %cwd_for_log, branch = %branch_for_log, error = %e, "git create-branch failed");
            IpcBody::<()>::err(e, "GIT_CREATE_BRANCH_ERROR")
        }
        Err(e) => {
            tracing::error!(path = %cwd_for_log, error = %e, "git create-branch task panicked");
            IpcBody::<()>::err(
                format!("git create-branch task failed: {e}"),
                "GIT_CREATE_BRANCH_ERROR",
            )
        }
    };
    (StatusCode::OK, Json(body))
}

/// `POST /git/stash-save` — `git stash push [-u] [-m <msg>]` (write).
pub async fn stash_save(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<GitStashSaveRequest>,
) -> impl IntoResponse {
    let resolved = match resolve_cwd::<()>(&req.cwd, &state, Some(peer), true) {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    let cwd = match cwd_string::<()>(&resolved) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let cwd_for_log = cwd.clone();
    let message = req.message;
    let include_untracked = req.include_untracked.unwrap_or(false);
    let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut args: Vec<String> = vec!["stash".into(), "push".into()];
        if include_untracked {
            args.push("-u".into());
        }
        let msg_holder;
        if let Some(m) = message.as_ref() {
            args.push("-m".into());
            msg_holder = m.clone();
            args.push(msg_holder);
        }
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let output = GitTracker::run_git_command(&cwd, &arg_refs)
            .ok_or_else(|| "Failed to run git stash push".to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    })
    .await
    .map_err(|e| format!("git stash-save task failed: {e}"));
    let body = match result {
        Ok(Ok(())) => {
            tracing::info!(path = %cwd_for_log, "git stash-save ok");
            IpcBody::<()>::ok(())
        }
        Ok(Err(e)) => {
            tracing::warn!(path = %cwd_for_log, error = %e, "git stash-save failed");
            IpcBody::<()>::err(e, "GIT_STASH_SAVE_ERROR")
        }
        Err(e) => {
            tracing::error!(path = %cwd_for_log, error = %e, "git stash-save task panicked");
            IpcBody::<()>::err(
                format!("git stash-save task failed: {e}"),
                "GIT_STASH_SAVE_ERROR",
            )
        }
    };
    (StatusCode::OK, Json(body))
}

/// `GET /git/stash-list?cwd=...` — parse `git stash list` into rows (read).
pub async fn stash_list(
    State(state): State<AppState>,
    Query(q): Query<GitCwdQuery>,
) -> impl IntoResponse {
    let resolved = match resolve_cwd::<Vec<GitStashInfoDto>>(&q.cwd, &state, None, false) {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    let cwd = match cwd_string::<Vec<GitStashInfoDto>>(&resolved) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let cwd_for_log = cwd.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<Vec<GitStashInfoDto>, String> {
        let output = GitTracker::run_git_command(&cwd, &["stash", "list"])
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
                            stashes.push(GitStashInfoDto {
                                index,
                                name,
                                message: rest.trim().to_string(),
                            });
                        }
                    }
                }
            }
        }
        Ok(stashes)
    })
    .await
    .map_err(|e| format!("git stash-list task failed: {e}"));
    let body = match result {
        Ok(Ok(rows)) => {
            tracing::info!(path = %cwd_for_log, stashes = rows.len(), "git stash-list ok");
            IpcBody::ok(rows)
        }
        Ok(Err(e)) => {
            tracing::warn!(path = %cwd_for_log, error = %e, "git stash-list failed");
            IpcBody::<Vec<GitStashInfoDto>>::err(e, "GIT_STASH_LIST_ERROR")
        }
        Err(e) => {
            tracing::error!(path = %cwd_for_log, error = %e, "git stash-list task panicked");
            IpcBody::<Vec<GitStashInfoDto>>::err(
                format!("git stash-list task failed: {e}"),
                "GIT_STASH_LIST_ERROR",
            )
        }
    };
    (StatusCode::OK, Json(body))
}

/// `POST /git/stash-apply` — apply without removing (write).
pub async fn stash_apply(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<GitStashIndexRequest>,
) -> impl IntoResponse {
    run_stash_index_write(&state, peer, req, "apply", "GIT_STASH_APPLY_ERROR").await
}

/// `POST /git/stash-pop` — apply + drop (write).
pub async fn stash_pop(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<GitStashIndexRequest>,
) -> impl IntoResponse {
    run_stash_index_write(&state, peer, req, "pop", "GIT_STASH_POP_ERROR").await
}

/// `POST /git/stash-drop` — delete a stash (write, destructive).
pub async fn stash_drop(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<GitStashIndexRequest>,
) -> impl IntoResponse {
    run_stash_index_write(&state, peer, req, "drop", "GIT_STASH_DROP_ERROR").await
}

/// `GET /git/branch-list?cwd=...` — `git branch -a` (read).
pub async fn branch_list(
    State(state): State<AppState>,
    Query(q): Query<GitCwdQuery>,
) -> impl IntoResponse {
    let resolved = match resolve_cwd::<Vec<String>>(&q.cwd, &state, None, false) {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    let cwd = match cwd_string::<Vec<String>>(&resolved) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let cwd_for_log = cwd.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<Vec<String>, String> {
        let output =
            GitTracker::run_git_command(&cwd, &["branch", "-a", "--format=%(refname:short)"])
                .ok_or_else(|| "Failed to run git branch".to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        Ok(stdout
            .lines()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect())
    })
    .await
    .map_err(|e| format!("git branch-list task failed: {e}"));
    let body = match result {
        Ok(Ok(branches)) => {
            tracing::info!(path = %cwd_for_log, branches = branches.len(), "git branch-list ok");
            IpcBody::ok(branches)
        }
        Ok(Err(e)) => {
            tracing::warn!(path = %cwd_for_log, error = %e, "git branch-list failed");
            IpcBody::<Vec<String>>::err(e, "GIT_BRANCH_LIST_ERROR")
        }
        Err(e) => {
            tracing::error!(path = %cwd_for_log, error = %e, "git branch-list task panicked");
            IpcBody::<Vec<String>>::err(
                format!("git branch-list task failed: {e}"),
                "GIT_BRANCH_LIST_ERROR",
            )
        }
    };
    (StatusCode::OK, Json(body))
}

/// `POST /git/branch-switch` — `git checkout <name>` (write).
pub async fn branch_switch(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<GitBranchNameRequest>,
) -> impl IntoResponse {
    run_branch_name_write(
        &state,
        peer,
        req,
        "checkout",
        "GIT_BRANCH_SWITCH_ERROR",
        run_simple_checkout,
    )
    .await
}

/// `POST /git/branch-create` — `git checkout -b <name>` (write).
pub async fn branch_create(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<GitBranchNameRequest>,
) -> impl IntoResponse {
    run_branch_name_write(
        &state,
        peer,
        req,
        "checkout -b",
        "GIT_BRANCH_CREATE_ERROR",
        run_simple_checkout_b,
    )
    .await
}

// ============================ helpers ============================

/// Run a `(cwd, path) -> Result<(), String>` git write op with the standard
/// boundary/loopback/log/IpcBody wrap. Used by `stage`/`unstage`/`discard`.
async fn run_git_path_write(
    state: &AppState,
    peer: SocketAddr,
    req: GitPathRequest,
    op: impl FnOnce(&str, &str) -> Result<(), String> + Send + 'static,
    label: &'static str,
    code: &'static str,
) -> (StatusCode, Json<IpcBody<()>>) {
    let resolved = match resolve_cwd::<()>(&req.cwd, state, Some(peer), true) {
        Ok(p) => p,
        Err((st, body)) => return (st, body),
    };
    let cwd = match cwd_string::<()>(&resolved) {
        Ok(s) => s,
        Err((st, body)) => return (st, body),
    };
    let cwd_for_log = cwd.clone();
    let path = req.path;
    let result = tokio::task::spawn_blocking(move || op(&cwd, &path))
        .await
        .map_err(|e| format!("git {label} task failed: {e}"));
    let body = match result {
        Ok(Ok(())) => {
            tracing::info!(path = %cwd_for_log, op = label, "git {label} ok");
            IpcBody::<()>::ok(())
        }
        Ok(Err(e)) => {
            tracing::warn!(path = %cwd_for_log, op = label, error = %e, "git {label} failed");
            IpcBody::<()>::err(e, code)
        }
        Err(e) => {
            tracing::error!(path = %cwd_for_log, op = label, error = %e, "git {label} task panicked");
            IpcBody::<()>::err(format!("git {label} task failed: {e}"), code)
        }
    };
    (StatusCode::OK, Json(body))
}

/// Run a stash-by-index op (`apply`/`pop`/`drop`): `git stash <op> stash@{<i>}`.
async fn run_stash_index_write(
    state: &AppState,
    peer: SocketAddr,
    req: GitStashIndexRequest,
    op: &'static str,
    code: &'static str,
) -> (StatusCode, Json<IpcBody<()>>) {
    let resolved = match resolve_cwd::<()>(&req.cwd, state, Some(peer), true) {
        Ok(p) => p,
        Err((st, body)) => return (st, body),
    };
    let cwd = match cwd_string::<()>(&resolved) {
        Ok(s) => s,
        Err((st, body)) => return (st, body),
    };
    let cwd_for_log = cwd.clone();
    let index = req.index;
    let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let stash_ref = format!("stash@{{{}}}", index);
        let args: [&str; 3] = ["stash", op, &stash_ref];
        let output = GitTracker::run_git_command(&cwd, &args)
            .ok_or_else(|| format!("Failed to run git stash {op}"))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    })
    .await
    .map_err(|e| format!("git stash {op} task failed: {e}"));
    let body = match result {
        Ok(Ok(())) => {
            tracing::info!(path = %cwd_for_log, op, index, "git stash {op} ok");
            IpcBody::<()>::ok(())
        }
        Ok(Err(e)) => {
            tracing::warn!(path = %cwd_for_log, op, index, error = %e, "git stash {op} failed");
            IpcBody::<()>::err(e, code)
        }
        Err(e) => {
            tracing::error!(path = %cwd_for_log, op, index, error = %e, "git stash {op} task panicked");
            IpcBody::<()>::err(format!("git stash {op} task failed: {e}"), code)
        }
    };
    (StatusCode::OK, Json(body))
}

/// Run a branch-name write op (`switch`/`create`). `runner` builds the actual
/// git command for the op (e.g. `checkout` vs `checkout -b`).
async fn run_branch_name_write(
    state: &AppState,
    peer: SocketAddr,
    req: GitBranchNameRequest,
    label: &'static str,
    code: &'static str,
    runner: fn(&str, &str) -> Result<(), String>,
) -> (StatusCode, Json<IpcBody<()>>) {
    let resolved = match resolve_cwd::<()>(&req.cwd, state, Some(peer), true) {
        Ok(p) => p,
        Err((st, body)) => return (st, body),
    };
    let cwd = match cwd_string::<()>(&resolved) {
        Ok(s) => s,
        Err((st, body)) => return (st, body),
    };
    let cwd_for_log = cwd.clone();
    let name = req.name;
    let name_for_log = name.clone();
    let result = tokio::task::spawn_blocking(move || runner(&cwd, &name))
        .await
        .map_err(|e| format!("git {label} task failed: {e}"));
    let body = match result {
        Ok(Ok(())) => {
            tracing::info!(path = %cwd_for_log, op = label, name = %name_for_log, "git {label} ok");
            IpcBody::<()>::ok(())
        }
        Ok(Err(e)) => {
            tracing::warn!(path = %cwd_for_log, op = label, name = %name_for_log, error = %e, "git {label} failed");
            IpcBody::<()>::err(e, code)
        }
        Err(e) => {
            tracing::error!(path = %cwd_for_log, op = label, error = %e, "git {label} task panicked");
            IpcBody::<()>::err(format!("git {label} task failed: {e}"), code)
        }
    };
    (StatusCode::OK, Json(body))
}

/// `git checkout <name>` (branch-switch desktop parity). F-007: the previous
/// local re-implementation built `["checkout", "--", name]`, which makes
/// `name` a PATHSPEC, not a branch — the switch never happened, and a branch
/// name colliding with a worktree path silently reverted that file's local
/// changes and returned success. The fix refuses any `name` that is not a
/// resolvable branch ref BEFORE running git, so git's pathspec fallback can
/// never trigger: `checkout <name>` with a non-branch name is an error, not a
/// file revert.
fn run_simple_checkout(cwd: &str, name: &str) -> Result<(), String> {
    let Some(is_remote) = resolve_branch_ref(cwd, name)? else {
        return Err(format!(
            "'{name}' is not a branch; refusing checkout (a branch switch must target a branch, not a pathspec)"
        ));
    };
    // Remote-tracking refs (e.g. `origin/feature`) must go through
    // `--track` so git creates a local tracking branch — a plain
    // `checkout <remote-ref>` lands in detached HEAD instead.
    git_tracker::git_checkout_branch(cwd, name, is_remote)
}

/// `git checkout -b <name>` (branch-create desktop parity). F-008: the
/// previous local re-implementation built `["checkout", "-b", "--", name]` —
/// `-b` consumes `--` as the branch name and `name` as the start ref, so the
/// route could NEVER succeed (git: "a branch '--' cannot be created"). The
/// fix delegates to the SAME [`git_tracker::git_create_branch`] the desktop
/// `git_create_branch` command calls, after refusing option-shaped names
/// (`--detach` & co. would be parsed as flags — no legitimate branch starts
/// with `-`, git's check-ref-format rejects it).
fn run_simple_checkout_b(cwd: &str, name: &str) -> Result<(), String> {
    if name.trim().is_empty() || name.starts_with('-') {
        return Err(format!(
            "invalid branch name '{name}': branch names must be non-empty and must not start with '-'"
        ));
    }
    git_tracker::git_create_branch(cwd, name, None)
}

/// Whether `name` resolves as a branch ref in the repo at `cwd`, and if so
/// whether it is remote-tracking. Returns `Some(false)` for a local branch
/// (`refs/heads/<name>`), `Some(true)` for a remote-tracking branch
/// (`refs/remotes/<name>`), `None` for anything else. Local wins when both
/// exist (mirrors `git checkout <name>` ambiguity resolution). Refuses
/// option-shaped names and anything git would treat as a pathspec instead of
/// a ref. Uses `--verify` + `--quiet` with the fully-qualified ref so no
/// ambiguity with worktree files is possible and no ref-name can be parsed
/// as an option.
fn resolve_branch_ref(cwd: &str, name: &str) -> Result<Option<bool>, String> {
    if name.trim().is_empty() || name.starts_with('-') {
        return Ok(None);
    }
    for (ref_name, is_remote) in [
        (format!("refs/heads/{name}"), false),
        (format!("refs/remotes/{name}"), true),
    ] {
        let output =
            GitTracker::run_git_command(cwd, &["rev-parse", "--verify", "--quiet", &ref_name])
                .ok_or_else(|| "Failed to run git rev-parse".to_string())?;
        if output.status.success() {
            return Ok(Some(is_remote));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests;
