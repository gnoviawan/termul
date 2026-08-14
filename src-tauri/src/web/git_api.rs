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

fn resolve_cwd<T>(
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
            if let Some(forbidden) = check_local_only::<T>(peer) {
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
    run_git_path_write(&state, peer, req, |cwd, path| {
        git_tracker::git_stage_file(cwd, path)
    }, "stage", "GIT_STAGE_ERROR")
    .await
}

/// `POST /git/unstage` — `git reset -q HEAD -- <path>` (or `git rm --cached`
/// in a no-HEAD repo). Write, loopback-guarded.
pub async fn unstage(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<GitPathRequest>,
) -> impl IntoResponse {
    run_git_path_write(&state, peer, req, |cwd, path| {
        git_tracker::git_unstage_file(cwd, path)
    }, "unstage", "GIT_UNSTAGE_ERROR")
    .await
}

/// `POST /git/discard` — revert worktree or delete untracked. Destructive;
/// loopback-guarded.
pub async fn discard(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<GitPathRequest>,
) -> impl IntoResponse {
    run_git_path_write(&state, peer, req, |cwd, path| {
        git_tracker::git_discard_file(cwd, path)
    }, "discard", "GIT_DISCARD_ERROR")
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
    let result =
        tokio::task::spawn_blocking(move || git_tracker::git_get_log(&cwd, limit))
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
    let result =
        tokio::task::spawn_blocking(move || git_tracker::git_push_current(&cwd))
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
    let result =
        tokio::task::spawn_blocking(move || git_tracker::git_get_commit_context(&cwd))
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
            IpcBody::<()>::err(format!("git checkout task failed: {e}"), "GIT_CHECKOUT_ERROR")
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

/// `git checkout <name>` (branch-switch desktop parity).
fn run_simple_checkout(cwd: &str, name: &str) -> Result<(), String> {
    let args = ["checkout", "--", name];
    let output = GitTracker::run_git_command(cwd, &args)
        .ok_or_else(|| "Failed to run git checkout".to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// `git checkout -b <name>` (branch-create desktop parity).
fn run_simple_checkout_b(cwd: &str, name: &str) -> Result<(), String> {
    let args = ["checkout", "-b", "--", name];
    let output = GitTracker::run_git_command(cwd, &args)
        .ok_or_else(|| "Failed to run git checkout -b".to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::AcpManager;
    use crate::web::project_registry::ProjectRegistry;
    use crate::web::sink::WsRelaySink;
    use crate::web::test_pty_manager;
    use crate::web::ws::HistoryMode;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::routing::{get, post};
    use std::net::SocketAddr;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tower::ServiceExt;

    /// Temp dir removed on drop (panic-safe).
    struct TempDir {
        path: PathBuf,
    }
    impl TempDir {
        fn new(label: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let path = std::env::temp_dir().join(format!("termul-web-gitapi-{label}-{nanos}"));
            std::fs::create_dir_all(&path).expect("create temp dir");
            Self { path }
        }
        fn path(&self) -> &std::path::Path {
            &self.path
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn test_state(root: &std::path::Path) -> AppState {
        let pty = test_pty_manager();
        AppState {
            acp: Arc::new(AcpManager::new(vec![])),
            terminal_events: pty.terminal_events(),
            cwd_tracker: pty.cwd_tracker(),
            git_tracker: pty.git_tracker(),
            exit_code_tracker: pty.exit_code_tracker(),
            pty,
            relay: Arc::new(WsRelaySink::new()),
            registry: Arc::new(ProjectRegistry::new()),
            registry_persistence: None,
            projects_file: None,
            history_mode: HistoryMode::LiveOnly,
            project_root: Arc::new(parking_lot::RwLock::new(root.canonicalize().unwrap_or_else(|_| root.to_path_buf()))),
            workspace_manifest: None,
            acp_catalog: None,
            acp_install: None,
            store: None,
        }
    }

    fn test_router(state: AppState) -> axum::Router {
        axum::Router::new()
            .route("/git/status", post(get_status))
            .route("/git/diff", post(get_diff))
            .route("/git/stage", post(stage))
            .route("/git/unstage", post(unstage))
            .route("/git/discard", post(discard))
            .route("/git/log", post(get_log))
            .route("/git/commit", post(commit))
            .route("/git/push", post(push))
            .route("/git/commit-context", post(get_commit_context))
            .route("/git/checkout-branch", post(checkout_branch))
            .route("/git/create-branch", post(create_branch))
            .route("/git/stash-save", post(stash_save))
            .route("/git/stash-list", get(stash_list))
            .route("/git/stash-apply", post(stash_apply))
            .route("/git/stash-pop", post(stash_pop))
            .route("/git/stash-drop", post(stash_drop))
            .route("/git/branch-list", get(branch_list))
            .route("/git/branch-switch", post(branch_switch))
            .route("/git/branch-create", post(branch_create))
            .with_state(state)
    }

    async fn body_as<T: serde::de::DeserializeOwned>(body: Body) -> IpcBody<T> {
        let bytes = axum::body::to_bytes(body, usize::MAX)
            .await
            .expect("read body");
        serde_json::from_slice(&bytes).expect("deserialize IpcBody")
    }

    fn loopback() -> SocketAddr {
        SocketAddr::from(([127, 0, 0, 1], 54321))
    }

    async fn post_json(
        state: AppState,
        uri: &str,
        body: &serde_json::Value,
    ) -> axum::http::Response<Body> {
        post_json_from(state, uri, body, loopback()).await
    }

    async fn post_json_from(
        state: AppState,
        uri: &str,
        body: &serde_json::Value,
        peer: SocketAddr,
    ) -> axum::http::Response<Body> {
        let bytes = serde_json::to_vec(body).expect("serialize body");
        test_router(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(uri)
                    .header("content-type", "application/json")
                    .extension(ConnectInfo(peer))
                    .body(Body::from(bytes))
                    .expect("build request"),
            )
            .await
            .expect("router response")
    }

    async fn get_request(state: AppState, uri: &str) -> axum::http::Response<Body> {
        test_router(state)
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(uri)
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response")
    }

    fn urlencoding(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        for c in s.chars() {
            match c {
                ' ' => out.push_str("%20"),
                '\\' => out.push_str("%5C"),
                _ if c.is_ascii_alphanumeric()
                    || matches!(c, '-' | '_' | '.' | '~' | '/' | ':') =>
                {
                    out.push(c)
                }
                _ => {
                    let mut buf = [0u8; 4];
                    for b in c.encode_utf8(&mut buf).as_bytes() {
                        out.push_str(&format!("%{:02X}", b));
                    }
                }
            }
        }
        out
    }

    /// Skip the test when git is unavailable in the host env.
    fn git_missing() -> bool {
        GitTracker::run_git_command(std::env::temp_dir().to_str().unwrap(), &["--version"])
            .is_none()
    }

    fn init_repo(tag: &str) -> PathBuf {
        let dir = TempDir::new(tag);
        let path = dir.path().to_path_buf();
        for args in [
            ["init", "-q"].as_slice(),
            ["config", "user.email", "t@example.com"].as_slice(),
            ["config", "user.name", "Test"].as_slice(),
            ["config", "commit.gpgsign", "false"].as_slice(),
            ["config", "core.autocrlf", "false"].as_slice(),
        ] {
            let out = GitTracker::run_git_command(path.to_str().unwrap(), args)
                .expect("git command should run");
            assert!(
                out.status.success(),
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&out.stderr)
            );
        }
        // Leak the TempDir wrapper so the repo survives the test body — the
        // directory lives under the OS temp dir and is cleaned up by the OS.
        std::mem::forget(dir);
        path
    }

    #[tokio::test]
    async fn get_status_returns_empty_list_for_clean_repo() {
        if git_missing() {
            return;
        }
        let repo = init_repo("status-clean");
        let state = test_state(repo.parent().unwrap_or_else(|| std::path::Path::new(".")));
        let resp = post_json(
            state,
            "/git/status",
            &serde_json::json!({ "cwd": repo.to_string_lossy() }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<Vec<GitStatusDetail>> = body_as(resp.into_body()).await;
        assert!(body.success, "git status should succeed: {:?}", body.error);
        assert!(body.data.unwrap_or_default().is_empty());
    }

    #[tokio::test]
    async fn get_status_reports_untracked_file() {
        if git_missing() {
            return;
        }
        let repo = init_repo("status-untracked");
        std::fs::write(repo.join("a.txt"), "x").expect("write");
        let state = test_state(repo.parent().unwrap_or_else(|| std::path::Path::new(".")));
        let resp = post_json(
            state,
            "/git/status",
            &serde_json::json!({ "cwd": repo.to_string_lossy() }),
        )
        .await;
        let body: IpcBody<Vec<GitStatusDetail>> = body_as(resp.into_body()).await;
        assert!(body.success, "{:?}", body.error);
        let rows = body.data.expect("entries");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].status, "untracked");
        assert!(!rows[0].staged);
    }

    #[tokio::test]
    async fn get_status_rejects_cwd_outside_project_root() {
        let outside = TempDir::new("outside");
        let inside = TempDir::new("inside");
        let state = test_state(inside.path());
        let resp = post_json(
            state,
            "/git/status",
            &serde_json::json!({ "cwd": outside.path().to_string_lossy() }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<Vec<GitStatusDetail>> = body_as(resp.into_body()).await;
        assert!(!body.success, "outside-root must be rejected");
        assert_eq!(body.code.as_deref(), Some("OUTSIDE_PROJECT_ROOT"));
    }

    #[tokio::test]
    async fn stage_refused_from_non_loopback_peer() {
        if git_missing() {
            return;
        }
        let repo = init_repo("stage-guard");
        std::fs::write(repo.join("a.txt"), "x").expect("write");
        let state = test_state(repo.parent().unwrap_or_else(|| std::path::Path::new(".")));
        let remote = SocketAddr::from(([192, 168, 1, 50], 40000));
        let resp = post_json_from(
            state,
            "/git/stage",
            &serde_json::json!({ "cwd": repo.to_string_lossy(), "path": "a.txt" }),
            remote,
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<()> = body_as(resp.into_body()).await;
        assert!(!body.success);
        assert_eq!(body.code.as_deref(), Some("FORBIDDEN"));
    }

    #[tokio::test]
    async fn stage_then_unstage_roundtrips() {
        if git_missing() {
            return;
        }
        let repo = init_repo("stage-roundtrip");
        std::fs::write(repo.join("a.txt"), "one\n").expect("write");
        let git = |args: &[&str]| {
            let out = GitTracker::run_git_command(repo.to_str().unwrap(), args).expect("git");
            assert!(
                out.status.success(),
                "git {:?}: {}",
                args,
                String::from_utf8_lossy(&out.stderr)
            );
        };
        git(&["add", "-A"]);
        git(&["commit", "-qm", "init"]);
        std::fs::write(repo.join("a.txt"), "two\n").expect("modify");

        let state = test_state(repo.parent().unwrap_or_else(|| std::path::Path::new(".")));
        let resp = post_json(
            state.clone(),
            "/git/stage",
            &serde_json::json!({ "cwd": repo.to_string_lossy(), "path": "a.txt" }),
        )
        .await;
        let body: IpcBody<()> = body_as(resp.into_body()).await;
        assert!(body.success, "stage failed: {:?}", body.error);

        let resp = post_json(
            state,
            "/git/unstage",
            &serde_json::json!({ "cwd": repo.to_string_lossy(), "path": "a.txt" }),
        )
        .await;
        let body: IpcBody<()> = body_as(resp.into_body()).await;
        assert!(body.success, "unstage failed: {:?}", body.error);
    }

    #[tokio::test]
    async fn get_log_returns_empty_for_fresh_repo() {
        if git_missing() {
            return;
        }
        let repo = init_repo("log-empty");
        let state = test_state(repo.parent().unwrap_or_else(|| std::path::Path::new(".")));
        let resp = post_json(
            state,
            "/git/log",
            &serde_json::json!({ "cwd": repo.to_string_lossy() }),
        )
        .await;
        let body: IpcBody<Vec<GitCommit>> = body_as(resp.into_body()).await;
        assert!(body.success, "{:?}", body.error);
        assert!(body.data.unwrap_or_default().is_empty());
    }

    #[tokio::test]
    async fn commit_context_for_fresh_repo_has_no_head() {
        if git_missing() {
            return;
        }
        let repo = init_repo("ctx-nohead");
        let state = test_state(repo.parent().unwrap_or_else(|| std::path::Path::new(".")));
        let resp = post_json(
            state,
            "/git/commit-context",
            &serde_json::json!({ "cwd": repo.to_string_lossy() }),
        )
        .await;
        let body: IpcBody<GitCommitContext> = body_as(resp.into_body()).await;
        assert!(body.success, "{:?}", body.error);
        let ctx = body.data.expect("context");
        assert!(!ctx.has_head);
        assert_eq!(ctx.staged_count, 0);
    }

    #[tokio::test]
    async fn branch_list_returns_branches() {
        if git_missing() {
            return;
        }
        let repo = init_repo("branch-list");
        // A fresh `git init` repo has no commits and therefore no branches yet
        // (`git branch` lists only refs that exist). Create an empty initial
        // commit so the default branch comes into existence and is listed.
        let committed = GitTracker::run_git_command(
            repo.to_str().unwrap(),
            &["commit", "--allow-empty", "-m", "init"],
        )
        .map(|c| c.status.success())
        .unwrap_or(false);
        assert!(committed, "initial commit should succeed");
        let state = test_state(repo.parent().unwrap_or_else(|| std::path::Path::new(".")));
        let uri = format!(
            "/git/branch-list?cwd={}",
            urlencoding(&repo.to_string_lossy())
        );
        let resp = get_request(state, &uri).await;
        let body: IpcBody<Vec<String>> = body_as(resp.into_body()).await;
        assert!(body.success, "{:?}", body.error);
        // After the initial commit the default branch (main/master/whatever
        // git is configured for) exists and is listed.
        let branches = body.data.unwrap_or_default();
        assert!(
            !branches.is_empty(),
            "expected at least one branch after the initial commit, got: {branches:?}"
        );
    }

    #[tokio::test]
    async fn stash_list_returns_empty_for_no_stashes() {
        if git_missing() {
            return;
        }
        let repo = init_repo("stash-empty");
        let state = test_state(repo.parent().unwrap_or_else(|| std::path::Path::new(".")));
        let uri = format!(
            "/git/stash-list?cwd={}",
            urlencoding(&repo.to_string_lossy())
        );
        let resp = get_request(state, &uri).await;
        let body: IpcBody<Vec<GitStashInfoDto>> = body_as(resp.into_body()).await;
        assert!(body.success, "{:?}", body.error);
        assert!(body.data.unwrap_or_default().is_empty());
    }

    #[tokio::test]
    async fn get_status_rejects_path_traversal_cwd() {
        let dir = TempDir::new("traversal");
        let state = test_state(dir.path());
        // A `..` component is rejected by resolve_request_path regardless of
        // project_root containment — defense-in-depth against traversal.
        let resp = post_json(
            state,
            "/git/status",
            &serde_json::json!({ "cwd": "../escape" }),
        )
        .await;
        let body: IpcBody<Vec<GitStatusDetail>> = body_as(resp.into_body()).await;
        assert!(!body.success);
        assert_eq!(body.code.as_deref(), Some("PATH_TRAVERSAL"));
    }
}
