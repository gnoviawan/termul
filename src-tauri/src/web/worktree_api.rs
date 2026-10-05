//! HTTP handlers for worktree operations exposed to the web/remote client
//! (CAP — Web worktree parity).
//!
//! Mirrors the desktop `#[tauri::command] worktree_*` handlers in
//! `commands.rs` over HTTP, reusing the SAME `WorktreeManager` impl the Tauri
//! commands call (`WorktreeManager::list` / `create` / `remove` / `branches` /
//! `check_dirty` / `resolve_default_base_branch` / `copy_worktree_include_files`).
//! Each route:
//!
//! - enforces `resolve_request_path` (inherited from `fs_api`) for `..`
//!   rejection + canonicalization, then a project-root containment check
//!   (`ensure_within_project_boundary`) — the web server is a security boundary
//!   the desktop commands do not need.
//! - enforces `check_local_only` (loopback guard) on WRITE routes (`create` /
//!   `remove` / `copy-include-files`), matching the git_api mutation pattern.
//!   Read routes (`list` / `branches` / `check-dirty` / `resolve-base-branch`)
//!   enforce containment only.
//! - wraps results in `IpcBody<T>` (`{ success, data } | { success, error, code }`)
//!   so the renderer facade swaps transparently with the desktop `IpcResult<T>`.
//! - runs blocking `WorktreeManager` calls on `tokio::task::spawn_blocking`
//!   (template: `git_api.rs`).
//! - logs at route boundaries via `tracing` (the standalone server's logger;
//!   a no-op when no subscriber is installed on the desktop shared-live path).
//!
//! The 7 launch-flow routes ship here. The 8 advanced ops (symlinks,
//! `parseGitignore`, `mergePreview/Execute`, `archive`/`restore`,
//! `removeAllManaged`) are deferred — see `deferred-work.md`.

use std::net::SocketAddr;
use std::path::Path;

use axum::{
    body::Body,
    extract::{ConnectInfo, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures::StreamExt;
use serde::Deserialize;
use tokio_stream::wrappers::UnboundedReceiverStream;
use tracing::{error, info, warn};

use crate::web::fs_api::{check_local_only, resolve_request_path, IpcBody};
use crate::web::git_api::ensure_within_project_boundary;
use crate::web::ws::AppState;
use crate::worktree::{
    BaseBranchInfo, BranchEntry, DirtyStatus, GitWorktreeEntry, IncludeCopyResult, WorktreeError,
    WorktreeManager,
};

/// `POST /worktree/list { projectPath }` body.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeProjectPathRequest {
    pub project_path: String,
}

/// `POST /worktree/create { projectPath, name, branch, isNewBranch, startRef?, targetPath?, streamProgress? }` body.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCreateRequest {
    pub project_path: String,
    pub name: String,
    pub branch: String,
    pub is_new_branch: bool,
    pub start_ref: Option<String>,
    pub target_path: Option<String>,
    /// Renderer-generated correlation id, echoed into progress frames and the
    /// `tracing` boundary logs so concurrent creates cannot cross-talk.
    pub progress_id: Option<String>,
    /// When true the response is `application/x-ndjson`: `{"type":"preparing"}`,
    /// then `{"type":"progress","progressId":...,"line":...}` per git stderr
    /// line, then a final `{"type":"result","result":IpcBody<GitWorktreeEntry>}`.
    /// The request-scoped stream is used instead of the WS relay because the
    /// chat session (and its relay subscription) does not exist yet during
    /// launch.
    pub stream_progress: Option<bool>,
}

/// `POST /worktree/remove { projectPath, worktreePath, force }` body.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRemoveRequest {
    pub project_path: String,
    pub worktree_path: String,
    pub force: bool,
}

/// `GET /worktree/branches?projectPath=...` query.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeProjectPathQuery {
    pub project_path: String,
}

/// `GET /worktree/check-dirty?worktreePath=...` query.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreePathQuery {
    pub worktree_path: String,
}

/// `POST /worktree/copy-include-files { projectPath, worktreePath }` body.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCopyIncludeRequest {
    pub project_path: String,
    pub worktree_path: String,
}

/// `(StatusCode, Json<IpcBody<T>>)` — the uniform route-error return type.
type RouteErr<T> = (StatusCode, Json<IpcBody<T>>);

/// Resolve + boundary-check a request path. On failure returns the
/// `(StatusCode, Json<IpcBody::err>)` to send directly; on success returns the
/// resolved `PathBuf`. `peer` is the request peer for the loopback write guard
/// (`Some` on write routes, `None` on read routes). Mirrors
/// `git_api::resolve_cwd` — kept self-contained so the worktree module does not
/// depend on git_api's private helpers.
fn resolve_project_path<T>(
    req_path: &str,
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
                "/worktree/*",
            ) {
                return Err((StatusCode::OK, Json(forbidden)));
            }
        }
    }
    // 2) `..` rejection + canonicalization.
    let resolved = match resolve_request_path(Path::new(req_path)) {
        Ok(safe) => safe,
        Err((msg, code)) => {
            return Err((StatusCode::OK, Json(IpcBody::<T>::err(msg, code))));
        }
    };
    // 3) project_root containment (web-server security boundary). Lock-read the
    //    RwLock for the duration of the `starts_with` check (sync — no `.await`
    //    under the guard). The boundary may have been rebound by a project
    //    switch since the last request.
    let outside_err = {
        let project_root = state.project_root.read();
        ensure_within_project_boundary::<T>(&resolved, &project_root, &state.registry)
    };
    if let Some(err) = outside_err {
        return Err((StatusCode::OK, Json(err)));
    }
    Ok(resolved)
}

/// Convert a resolved `PathBuf` to a tool-friendly `String`. Mirrors the desktop
/// `validate_project_path` behavior of stripping the Windows verbatim (`\\?\`)
/// prefix so `git.exe` receives a path it understands. Returns an `IpcBody::err`
/// (`INVALID_PATH_ENCODING`) when the path resolves to empty.
fn path_string<T>(resolved: &std::path::Path) -> Result<String, RouteErr<T>> {
    let lossy = resolved.to_string_lossy();
    let simplified = crate::path_validation::strip_verbatim_prefix(&lossy).into_owned();
    if simplified.is_empty() {
        return Err((
            StatusCode::OK,
            Json(IpcBody::<T>::err(
                "path resolved to empty string",
                "INVALID_PATH_ENCODING",
            )),
        ));
    }
    Ok(simplified)
}

/// Map a `WorktreeError` to an `IpcBody::err` (mirrors the desktop Tauri command
/// error mapping: `e.to_string()` for the message, `e.error_code()` for the code).
fn worktree_err<T>(e: WorktreeError) -> IpcBody<T> {
    IpcBody::<T>::err(e.to_string(), e.error_code())
}

// ============================ Route handlers ============================

/// `POST /worktree/list` — list all worktrees for a git repo (read-only).
/// Mirrors `worktree_list` → `WorktreeManager::list`.
pub async fn list(
    State(state): State<AppState>,
    Json(req): Json<WorktreeProjectPathRequest>,
) -> impl IntoResponse {
    let resolved =
        match resolve_project_path::<Vec<GitWorktreeEntry>>(&req.project_path, &state, None, false)
        {
            Ok(p) => p,
            Err(resp) => return resp,
        };
    let project_path = match path_string::<Vec<GitWorktreeEntry>>(&resolved) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let path_for_log = project_path.clone();
    // Normalize the project root for the info-leak filter: strip the Windows
    // verbatim (`\\?\`) prefix so `starts_with` matches git's output (which
    // carries no verbatim prefix). Both sides must share the same non-verbatim
    // representation or a logically-matching path would be rejected on Windows.
    let project_root_for_filter =
        crate::path_validation::strip_verbatim_prefix(&resolved.to_string_lossy()).into_owned();
    let result = tokio::task::spawn_blocking(move || WorktreeManager::list(&project_path))
        .await
        .map_err(|e| format!("worktree list task failed: {e}"));
    let body = match result {
        Ok(Ok(entries)) => {
            // Info-leak guard: filter out any worktree whose path is outside the
            // resolved project root. A worktree checked out to an arbitrary
            // outside path would otherwise disclose that path to the web client.
            // The `WorktreeManager::list` call runs git on the project root;
            // the returned entries should all be within the boundary, but a
            // pre-existing worktree created outside (e.g. via the desktop
            // client's custom targetPath) would slip through. Filter defensively.
            let filtered: Vec<GitWorktreeEntry> = entries
                .into_iter()
                .filter(|e| {
                    let entry = crate::path_validation::strip_verbatim_prefix(&e.path);
                    std::path::Path::new(entry.as_ref()).starts_with(&project_root_for_filter)
                })
                .collect();
            let kept = filtered.len();
            info!(path = %path_for_log, count = kept, "worktree list ok");
            IpcBody::ok(filtered)
        }
        Ok(Err(e)) => {
            warn!(path = %path_for_log, error = %e, "worktree list failed");
            worktree_err::<Vec<GitWorktreeEntry>>(e)
        }
        Err(e) => {
            error!(path = %path_for_log, error = %e, "worktree list task panicked");
            IpcBody::<Vec<GitWorktreeEntry>>::err(
                format!("worktree list task failed: {e}"),
                "WORKTREE_LIST_ERROR",
            )
        }
    };
    (StatusCode::OK, Json(body))
}

/// `POST /worktree/create` — create a new worktree (write, loopback-guarded).
/// Mirrors `worktree_create` → `WorktreeManager::create`.
///
/// With `streamProgress: true` the response is NDJSON instead of a single JSON
/// body — see `WorktreeCreateRequest::stream_progress`. Guard/validation
/// failures still return the regular `IpcBody` JSON envelope.
pub async fn create(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<WorktreeCreateRequest>,
) -> Response {
    let resolved =
        match resolve_project_path::<GitWorktreeEntry>(&req.project_path, &state, Some(peer), true)
        {
            Ok(p) => p,
            Err(resp) => return resp.into_response(),
        };
    let project_path = match path_string::<GitWorktreeEntry>(&resolved) {
        Ok(s) => s,
        Err(resp) => return resp.into_response(),
    };
    // If a custom target_path was provided, boundary-check it too (the default
    // is `<project>/.termul/worktrees/<name>/` which is inside the boundary).
    let target_path = match req.target_path.as_deref() {
        Some(tp) => match resolve_project_path::<GitWorktreeEntry>(tp, &state, Some(peer), true) {
            Ok(p) => match path_string::<GitWorktreeEntry>(&p) {
                Ok(s) => Some(s),
                Err(resp) => return resp.into_response(),
            },
            Err(resp) => return resp.into_response(),
        },
        None => None,
    };
    let path_for_log = project_path.clone();
    let name = req.name;
    let branch = req.branch;
    let is_new_branch = req.is_new_branch;
    let start_ref = req.start_ref;

    if req.stream_progress == Some(true) {
        return create_streaming(
            path_for_log,
            project_path,
            name,
            branch,
            is_new_branch,
            start_ref,
            target_path,
            req.progress_id,
        );
    }

    // `name`/`branch`/`start_ref`/`target_path` move into the blocking task
    // below; keep copies for the boundary logs.
    let name_for_log = name.clone();
    let branch_for_log = branch.clone();
    let start_ref_for_log = start_ref.clone();
    let target_path_for_log = target_path.clone();

    info!(
        path = %path_for_log,
        name = %name_for_log,
        branch = %branch_for_log,
        is_new_branch = %is_new_branch,
        start_ref = ?start_ref_for_log,
        target_path = ?target_path_for_log,
        "worktree create start"
    );

    let result = tokio::task::spawn_blocking(move || {
        WorktreeManager::create(
            &project_path,
            &name,
            &branch,
            is_new_branch,
            start_ref.as_deref(),
            target_path.as_deref(),
            None,
        )
    })
    .await
    .map_err(|e| format!("worktree create task failed: {e}"));
    let body = match result {
        Ok(Ok(entry)) => {
            info!(path = %path_for_log, name = %name_for_log, branch = %entry.branch, "worktree create ok");
            IpcBody::ok(entry)
        }
        Ok(Err(e)) => {
            warn!(path = %path_for_log, name = %name_for_log, branch = %branch_for_log, is_new_branch = %is_new_branch, start_ref = ?start_ref_for_log, target_path = ?target_path_for_log, error = %e, "worktree create failed");
            worktree_err::<GitWorktreeEntry>(e)
        }
        Err(e) => {
            error!(path = %path_for_log, name = %name_for_log, branch = %branch_for_log, is_new_branch = %is_new_branch, start_ref = ?start_ref_for_log, target_path = ?target_path_for_log, error = %e, "worktree create task panicked");
            IpcBody::<GitWorktreeEntry>::err(
                format!("worktree create task failed: {e}"),
                "WORKTREE_CREATE_ERROR",
            )
        }
    };
    (StatusCode::OK, Json(body)).into_response()
}

/// Streaming variant of `create`: runs `git worktree add` on a blocking
/// thread, forwarding each stderr line as an NDJSON frame followed by
/// the final `IpcBody` result frame. A watcher task awaits the blocking join
/// handle so a panic still produces a terminal `result` error frame instead of
/// silently ending the stream.
#[allow(clippy::too_many_arguments)]
fn create_streaming(
    path_for_log: String,
    project_path: String,
    name: String,
    branch: String,
    is_new_branch: bool,
    start_ref: Option<String>,
    target_path: Option<String>,
    progress_id: Option<String>,
) -> Response {
    info!(path = %path_for_log, name = %name, branch = %branch, is_new_branch = %is_new_branch, start_ref = ?start_ref, target_path = ?target_path, progress_id = ?progress_id, "worktree create (streaming) start");
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let panic_tx = tx.clone();
    let panic_path = path_for_log.clone();
    let panic_name = name.clone();
    let panic_branch = branch.clone();
    let panic_start_ref = start_ref.clone();
    let panic_target_path = target_path.clone();
    let handle = tokio::task::spawn_blocking(move || {
        let pid = progress_id.as_deref();
        let send = |frame: serde_json::Value| {
            let _ = tx.send(frame.to_string());
        };
        send(serde_json::json!({"type": "preparing", "progressId": pid}));
        let result = {
            let mut on_line = |line: &str| {
                send(serde_json::json!({"type": "progress", "progressId": pid, "line": line}));
            };
            WorktreeManager::create(
                &project_path,
                &name,
                &branch,
                is_new_branch,
                start_ref.as_deref(),
                target_path.as_deref(),
                Some(&mut on_line),
            )
        };
        let body = match result {
            Ok(entry) => {
                info!(path = %path_for_log, name = %name, branch = %entry.branch, "worktree create ok");
                IpcBody::ok(entry)
            }
            Err(e) => {
                warn!(path = %path_for_log, name = %name, branch = %branch, is_new_branch = %is_new_branch, start_ref = ?start_ref, target_path = ?target_path, error = %e, "worktree create failed");
                worktree_err::<GitWorktreeEntry>(e)
            }
        };
        send(serde_json::json!({"type": "result", "result": body}));
        // `tx` drops here → the stream ends once `panic_tx` is dropped below.
    });
    // A panicked blocking task drops its `tx` without a result frame; the
    // watcher reports it as a terminal error frame so the client does not have
    // to infer failure from a truncated stream.
    tokio::spawn(async move {
        if let Err(e) = handle.await {
            error!(path = %panic_path, name = %panic_name, branch = %panic_branch, is_new_branch = %is_new_branch, start_ref = ?panic_start_ref, target_path = ?panic_target_path, error = %e, "worktree create task panicked");
            let body =
                worktree_err::<GitWorktreeEntry>(WorktreeError::IoError(e.to_string()));
            let _ = panic_tx
                .send(serde_json::json!({"type": "result", "result": body}).to_string());
        }
    });
    let stream = UnboundedReceiverStream::new(rx).map(|line| {
        Ok::<axum::body::Bytes, std::convert::Infallible>(axum::body::Bytes::from(format!(
            "{line}\n"
        )))
    });
    (
        [
            (header::CONTENT_TYPE, "application/x-ndjson"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        Body::from_stream(stream),
    )
        .into_response()
}

/// `POST /worktree/remove` — remove a worktree (write, loopback-guarded).
/// Mirrors `worktree_remove` → `WorktreeManager::remove`.
pub async fn remove(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<WorktreeRemoveRequest>,
) -> impl IntoResponse {
    let project_resolved =
        match resolve_project_path::<()>(&req.project_path, &state, Some(peer), true) {
            Ok(p) => p,
            Err(resp) => return resp,
        };
    let project_path = match path_string::<()>(&project_resolved) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let worktree_resolved =
        match resolve_project_path::<()>(&req.worktree_path, &state, Some(peer), true) {
            Ok(p) => p,
            Err(resp) => return resp,
        };
    let worktree_path = match path_string::<()>(&worktree_resolved) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let path_for_log = worktree_path.clone();
    let force = req.force;
    let result = tokio::task::spawn_blocking(move || {
        WorktreeManager::remove(&project_path, &worktree_path, force)
    })
    .await
    .map_err(|e| format!("worktree remove task failed: {e}"));
    let body = match result {
        Ok(Ok(())) => {
            info!(path = %path_for_log, force, "worktree remove ok");
            IpcBody::<()>::ok(())
        }
        Ok(Err(e)) => {
            warn!(path = %path_for_log, error = %e, "worktree remove failed");
            worktree_err::<()>(e)
        }
        Err(e) => {
            error!(path = %path_for_log, error = %e, "worktree remove task panicked");
            IpcBody::<()>::err(
                format!("worktree remove task failed: {e}"),
                "WORKTREE_REMOVE_ERROR",
            )
        }
    };
    (StatusCode::OK, Json(body))
}

/// `GET /worktree/branches?projectPath=...` — list local + remote branches (read-only).
/// Mirrors `worktree_branches` → `WorktreeManager::branches`.
pub async fn branches(
    State(state): State<AppState>,
    Query(q): Query<WorktreeProjectPathQuery>,
) -> impl IntoResponse {
    let resolved =
        match resolve_project_path::<Vec<BranchEntry>>(&q.project_path, &state, None, false) {
            Ok(p) => p,
            Err(resp) => return resp,
        };
    let project_path = match path_string::<Vec<BranchEntry>>(&resolved) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let path_for_log = project_path.clone();
    let result = tokio::task::spawn_blocking(move || WorktreeManager::branches(&project_path))
        .await
        .map_err(|e| format!("worktree branches task failed: {e}"));
    let body = match result {
        Ok(Ok(entries)) => {
            info!(path = %path_for_log, count = entries.len(), "worktree branches ok");
            IpcBody::ok(entries)
        }
        Ok(Err(e)) => {
            warn!(path = %path_for_log, error = %e, "worktree branches failed");
            worktree_err::<Vec<BranchEntry>>(e)
        }
        Err(e) => {
            error!(path = %path_for_log, error = %e, "worktree branches task panicked");
            IpcBody::<Vec<BranchEntry>>::err(
                format!("worktree branches task failed: {e}"),
                "WORKTREE_BRANCHES_ERROR",
            )
        }
    };
    (StatusCode::OK, Json(body))
}

/// `GET /worktree/check-dirty?worktreePath=...` — dirty status for a worktree (read-only).
/// Mirrors `worktree_check_dirty` → `WorktreeManager::check_dirty`.
pub async fn check_dirty(
    State(state): State<AppState>,
    Query(q): Query<WorktreePathQuery>,
) -> impl IntoResponse {
    let resolved = match resolve_project_path::<DirtyStatus>(&q.worktree_path, &state, None, false)
    {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    let worktree_path = match path_string::<DirtyStatus>(&resolved) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let path_for_log = worktree_path.clone();
    let result = tokio::task::spawn_blocking(move || WorktreeManager::check_dirty(&worktree_path))
        .await
        .map_err(|e| format!("worktree check-dirty task failed: {e}"));
    let body = match result {
        Ok(Ok(status)) => {
            info!(path = %path_for_log, has_changes = status.has_changes, "worktree check-dirty ok");
            IpcBody::ok(status)
        }
        Ok(Err(e)) => {
            warn!(path = %path_for_log, error = %e, "worktree check-dirty failed");
            worktree_err::<DirtyStatus>(e)
        }
        Err(e) => {
            error!(path = %path_for_log, error = %e, "worktree check-dirty task panicked");
            IpcBody::<DirtyStatus>::err(
                format!("worktree check-dirty task failed: {e}"),
                "WORKTREE_CHECK_DIRTY_ERROR",
            )
        }
    };
    (StatusCode::OK, Json(body))
}

/// `POST /worktree/resolve-base-branch` — resolve the default base branch (read-only).
/// Mirrors `worktree_resolve_base_branch` → `WorktreeManager::resolve_default_base_branch`.
pub async fn resolve_base_branch(
    State(state): State<AppState>,
    Json(req): Json<WorktreeProjectPathRequest>,
) -> impl IntoResponse {
    let resolved =
        match resolve_project_path::<BaseBranchInfo>(&req.project_path, &state, None, false) {
            Ok(p) => p,
            Err(resp) => return resp,
        };
    let project_path = match path_string::<BaseBranchInfo>(&resolved) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let path_for_log = project_path.clone();
    let result = tokio::task::spawn_blocking(move || {
        WorktreeManager::resolve_default_base_branch(&project_path)
    })
    .await
    .map_err(|e| format!("worktree resolve-base-branch task failed: {e}"));
    let body = match result {
        Ok(Ok(info)) => {
            info!(
                path = %path_for_log,
                default_base = %info.default_base,
                is_detached = info.is_detached,
                "worktree resolve-base-branch ok"
            );
            IpcBody::ok(info)
        }
        Ok(Err(e)) => {
            warn!(path = %path_for_log, error = %e, "worktree resolve-base-branch failed");
            worktree_err::<BaseBranchInfo>(e)
        }
        Err(e) => {
            error!(path = %path_for_log, error = %e, "worktree resolve-base-branch task panicked");
            IpcBody::<BaseBranchInfo>::err(
                format!("worktree resolve-base-branch task failed: {e}"),
                "WORKTREE_RESOLVE_BASE_BRANCH_ERROR",
            )
        }
    };
    (StatusCode::OK, Json(body))
}

/// `POST /worktree/copy-include-files` — carry over `.worktree-include` files (write, loopback-guarded).
/// Mirrors `worktree_copy_include_files` → `WorktreeManager::copy_worktree_include_files`.
pub async fn copy_include_files(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<WorktreeCopyIncludeRequest>,
) -> impl IntoResponse {
    let project_resolved = match resolve_project_path::<IncludeCopyResult>(
        &req.project_path,
        &state,
        Some(peer),
        true,
    ) {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    let project_path = match path_string::<IncludeCopyResult>(&project_resolved) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let worktree_resolved = match resolve_project_path::<IncludeCopyResult>(
        &req.worktree_path,
        &state,
        Some(peer),
        true,
    ) {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    let worktree_path = match path_string::<IncludeCopyResult>(&worktree_resolved) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let path_for_log = worktree_path.clone();
    let result = tokio::task::spawn_blocking(move || {
        WorktreeManager::copy_worktree_include_files(&project_path, &worktree_path)
    })
    .await
    .map_err(|e| format!("worktree copy-include-files task failed: {e}"));
    let body = match result {
        Ok(Ok(outcome)) => {
            info!(
                path = %path_for_log,
                ran = outcome.ran,
                copied = outcome.copied,
                skipped = outcome.skipped.len(),
                "worktree copy-include-files ok"
            );
            IpcBody::ok(outcome)
        }
        Ok(Err(e)) => {
            warn!(path = %path_for_log, error = %e, "worktree copy-include-files failed");
            worktree_err::<IncludeCopyResult>(e)
        }
        Err(e) => {
            error!(path = %path_for_log, error = %e, "worktree copy-include-files task panicked");
            IpcBody::<IncludeCopyResult>::err(
                format!("worktree copy-include-files task failed: {e}"),
                "WORKTREE_COPY_INCLUDE_FILES_ERROR",
            )
        }
    };
    (StatusCode::OK, Json(body))
}

#[cfg(test)]
mod tests;
