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
    extract::{ConnectInfo, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use tracing::{error, info, warn};

use crate::web::fs_api::{check_local_only, resolve_request_path, IpcBody};
use crate::web::git_api::ensure_within_project_boundary;
use crate::web::ws::AppState;
use crate::worktree::{
    BaseBranchInfo, BranchEntry, DirtyStatus, GitWorktreeEntry, IncludeCopyResult,
    WorktreeError, WorktreeManager,
};

/// `POST /worktree/list { projectPath }` body.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeProjectPathRequest {
    pub project_path: String,
}

/// `POST /worktree/create { projectPath, name, branch, isNewBranch, startRef?, targetPath? }` body.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCreateRequest {
    pub project_path: String,
    pub name: String,
    pub branch: String,
    pub is_new_branch: bool,
    pub start_ref: Option<String>,
    pub target_path: Option<String>,
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
            if let Some(forbidden) = check_local_only::<T>(peer, state.allow_remote_writes, state.shared_live_writes_denied, "/worktree/*") {
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
    let resolved = match resolve_project_path::<Vec<GitWorktreeEntry>>(&req.project_path, &state, None, false) {
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
pub async fn create(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<WorktreeCreateRequest>,
) -> impl IntoResponse {
    let resolved = match resolve_project_path::<GitWorktreeEntry>(&req.project_path, &state, Some(peer), true) {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    let project_path = match path_string::<GitWorktreeEntry>(&resolved) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    // If a custom target_path was provided, boundary-check it too (the default
    // is `<project>/.termul/worktrees/<name>/` which is inside the boundary).
    let target_path = match req.target_path.as_deref() {
        Some(tp) => match resolve_project_path::<GitWorktreeEntry>(tp, &state, Some(peer), true) {
            Ok(p) => match path_string::<GitWorktreeEntry>(&p) {
                Ok(s) => Some(s),
                Err(resp) => return resp,
            },
            Err(resp) => return resp,
        },
        None => None,
    };
    let path_for_log = project_path.clone();
    let name = req.name;
    let branch = req.branch;
    let is_new_branch = req.is_new_branch;
    let start_ref = req.start_ref;
    let result = tokio::task::spawn_blocking(move || {
        WorktreeManager::create(
            &project_path,
            &name,
            &branch,
            is_new_branch,
            start_ref.as_deref(),
            target_path.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("worktree create task failed: {e}"));
    let body = match result {
        Ok(Ok(entry)) => {
            info!(path = %path_for_log, branch = %entry.branch, "worktree create ok");
            IpcBody::ok(entry)
        }
        Ok(Err(e)) => {
            warn!(path = %path_for_log, error = %e, "worktree create failed");
            worktree_err::<GitWorktreeEntry>(e)
        }
        Err(e) => {
            error!(path = %path_for_log, error = %e, "worktree create task panicked");
            IpcBody::<GitWorktreeEntry>::err(
                format!("worktree create task failed: {e}"),
                "WORKTREE_CREATE_ERROR",
            )
        }
    };
    (StatusCode::OK, Json(body))
}

/// `POST /worktree/remove` — remove a worktree (write, loopback-guarded).
/// Mirrors `worktree_remove` → `WorktreeManager::remove`.
pub async fn remove(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<WorktreeRemoveRequest>,
) -> impl IntoResponse {
    let project_resolved = match resolve_project_path::<()>(&req.project_path, &state, Some(peer), true) {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    let project_path = match path_string::<()>(&project_resolved) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let worktree_resolved = match resolve_project_path::<()>(&req.worktree_path, &state, Some(peer), true) {
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
    let resolved = match resolve_project_path::<Vec<BranchEntry>>(&q.project_path, &state, None, false) {
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
    let resolved = match resolve_project_path::<DirtyStatus>(&q.worktree_path, &state, None, false) {
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
    let resolved = match resolve_project_path::<BaseBranchInfo>(&req.project_path, &state, None, false) {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    let project_path = match path_string::<BaseBranchInfo>(&resolved) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let path_for_log = project_path.clone();
    let result =
        tokio::task::spawn_blocking(move || WorktreeManager::resolve_default_base_branch(&project_path))
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
    let project_resolved = match resolve_project_path::<IncludeCopyResult>(&req.project_path, &state, Some(peer), true) {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    let project_path = match path_string::<IncludeCopyResult>(&project_resolved) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let worktree_resolved = match resolve_project_path::<IncludeCopyResult>(&req.worktree_path, &state, Some(peer), true) {
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
mod tests {
    use super::*;
    use crate::acp::AcpManager;
    use crate::trackers::git_tracker::GitTracker;
    use crate::web::project_registry::ProjectRegistry;
    use crate::web::sink::WsRelaySink;
    use crate::web::test_pty_manager;
    use crate::web::ws::HistoryMode;
    use axum::body::Body;
    use axum::http::Request;
    use axum::routing::{get, post};
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tower::ServiceExt;

    /// Temp dir removed on drop (panic-safe).
    struct TempDir {
        path: std::path::PathBuf,
    }
    impl TempDir {
        fn new(label: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let path = std::env::temp_dir().join(format!("termul-web-wt-{label}-{nanos}"));
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
        AppState { acp: Arc::new(AcpManager::new(vec![])),
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
        project_root: Arc::new(parking_lot::RwLock::new(
            root.canonicalize().unwrap_or_else(|_| root.to_path_buf()),
        )),
        workspace_manifest: None,
        acp_catalog: None,
        acp_install: None,
        store: None, allow_remote_writes: false, shared_live_writes_denied: false,  }
    }

    fn test_router(state: AppState) -> axum::Router {
        axum::Router::new()
            .route("/worktree/list", post(list))
            .route("/worktree/create", post(create))
            .route("/worktree/remove", post(remove))
            .route("/worktree/branches", get(branches))
            .route("/worktree/check-dirty", get(check_dirty))
            .route("/worktree/resolve-base-branch", post(resolve_base_branch))
            .route("/worktree/copy-include-files", post(copy_include_files))
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

    /// Init a bare git repo + initial commit so worktree ops have a valid HEAD.
    /// The returned `RepoFixture` owns the `TempDir` and keeps it alive for the
    /// test body; the `PathBuf` is borrowed from it. When the fixture is dropped
    /// (end of test), the temp dir is removed — no `std::mem::forget` leak.
    /// Each fixture gets a unique nanos-stamped dir under the OS temp dir.
    fn init_repo(tag: &str) -> RepoFixture {
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
        let out = GitTracker::run_git_command(path.to_str().unwrap(), &["commit", "--allow-empty", "-m", "init"])
            .expect("git commit");
        assert!(out.status.success(), "initial commit failed: {}", String::from_utf8_lossy(&out.stderr));
        RepoFixture { _dir: dir, path }
    }

    /// Owns the `TempDir` so the repo survives the test body; drops (removing
    /// the temp dir) when the fixture goes out of scope at test teardown. This
    /// replaces the old `std::mem::forget(dir)` pattern that accumulated
    /// `%TEMP%\termul-web-wt-*` dirs across CI runs.
    struct RepoFixture {
        _dir: TempDir,
        path: std::path::PathBuf,
    }

    impl RepoFixture {
        fn path(&self) -> &std::path::Path {
            &self.path
        }
    }

    // ----- Containment + loopback guards -----

    #[tokio::test]
    async fn list_rejects_project_path_outside_project_root() {
        let outside = TempDir::new("outside-list");
        let inside = TempDir::new("inside-list");
        let state = test_state(inside.path());
        let resp = post_json(
            state,
            "/worktree/list",
            &serde_json::json!({ "projectPath": outside.path().to_string_lossy() }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<Vec<GitWorktreeEntry>> = body_as(resp.into_body()).await;
        assert!(!body.success, "outside-root must be rejected");
        assert_eq!(body.code.as_deref(), Some("OUTSIDE_PROJECT_ROOT"));
    }

    #[tokio::test]
    async fn create_refused_from_non_loopback_peer() {
        if git_missing() {
            return;
        }
        let repo = init_repo("create-guard");
        let state = test_state(repo.path().parent().unwrap_or_else(|| std::path::Path::new(".")));
        let remote = SocketAddr::from(([192, 168, 1, 50], 40000));
        let resp = post_json_from(
            state,
            "/worktree/create",
            &serde_json::json!({
                "projectPath": repo.path().to_string_lossy(),
                "name": "wt1",
                "branch": "chat/wt1",
                "isNewBranch": true
            }),
            remote,
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<GitWorktreeEntry> = body_as(resp.into_body()).await;
        assert!(!body.success, "non-loopback create must be refused");
        assert_eq!(body.code.as_deref(), Some("FORBIDDEN"));
    }

    #[tokio::test]
    async fn remove_refused_from_non_loopback_peer() {
        let inside = TempDir::new("rm-guard");
        let state = test_state(inside.path());
        let remote = SocketAddr::from(([192, 168, 1, 51], 40001));
        let resp = post_json_from(
            state,
            "/worktree/remove",
            &serde_json::json!({
                "projectPath": inside.path().to_string_lossy(),
                "worktreePath": inside.path().to_string_lossy(),
                "force": false
            }),
            remote,
        )
        .await;
        let body: IpcBody<()> = body_as(resp.into_body()).await;
        assert!(!body.success);
        assert_eq!(body.code.as_deref(), Some("FORBIDDEN"));
    }

    #[tokio::test]
    async fn copy_include_files_refused_from_non_loopback_peer() {
        let inside = TempDir::new("copy-guard");
        let state = test_state(inside.path());
        let remote = SocketAddr::from(([192, 168, 1, 52], 40002));
        let resp = post_json_from(
            state,
            "/worktree/copy-include-files",
            &serde_json::json!({
                "projectPath": inside.path().to_string_lossy(),
                "worktreePath": inside.path().to_string_lossy()
            }),
            remote,
        )
        .await;
        let body: IpcBody<IncludeCopyResult> = body_as(resp.into_body()).await;
        assert!(!body.success);
        assert_eq!(body.code.as_deref(), Some("FORBIDDEN"));
    }

    // ----- Read routes (containment only, no loopback guard) -----

    #[tokio::test]
    async fn list_returns_entries_for_a_git_repo() {
        if git_missing() {
            return;
        }
        let repo = init_repo("list-ok");
        let state = test_state(repo.path().parent().unwrap_or_else(|| std::path::Path::new(".")));
        let resp = post_json(
            state,
            "/worktree/list",
            &serde_json::json!({ "projectPath": repo.path().to_string_lossy() }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<Vec<GitWorktreeEntry>> = body_as(resp.into_body()).await;
        assert!(body.success, "list should succeed: {:?}", body.error);
        // A freshly-init'd repo with one commit has one worktree (the main one).
        let entries = body.data.expect("entries");
        assert!(!entries.is_empty(), "expected at least one worktree entry");
    }

    #[tokio::test]
    async fn branches_returns_at_least_one_branch() {
        if git_missing() {
            return;
        }
        let repo = init_repo("branches-ok");
        let state = test_state(repo.path().parent().unwrap_or_else(|| std::path::Path::new(".")));
        let uri = format!(
            "/worktree/branches?projectPath={}",
            urlencoding(&repo.path().to_string_lossy())
        );
        let resp = get_request(state, &uri).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<Vec<BranchEntry>> = body_as(resp.into_body()).await;
        assert!(body.success, "{:?}", body.error);
        let entries = body.data.expect("branches");
        assert!(!entries.is_empty(), "expected at least one branch");
    }

    #[tokio::test]
    async fn resolve_base_branch_returns_default_base() {
        if git_missing() {
            return;
        }
        let repo = init_repo("base-ok");
        let state = test_state(repo.path().parent().unwrap_or_else(|| std::path::Path::new(".")));
        let resp = post_json(
            state,
            "/worktree/resolve-base-branch",
            &serde_json::json!({ "projectPath": repo.path().to_string_lossy() }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<BaseBranchInfo> = body_as(resp.into_body()).await;
        assert!(body.success, "{:?}", body.error);
        let info = body.data.expect("base branch info");
        assert!(!info.default_base.is_empty(), "default base must be non-empty");
    }

    // ----- Write routes (loopback-guarded) -----

    #[tokio::test]
    async fn create_then_list_then_remove_roundtrips() {
        if git_missing() {
            return;
        }
        let repo = init_repo("cud");
        let state = test_state(repo.path().parent().unwrap_or_else(|| std::path::Path::new(".")));

        // Create a worktree
        let resp = post_json(
            state.clone(),
            "/worktree/create",
            &serde_json::json!({
                "projectPath": repo.path().to_string_lossy(),
                "name": "wt-rt",
                "branch": "chat/wt-rt",
                "isNewBranch": true
            }),
        )
        .await;
        let body: IpcBody<GitWorktreeEntry> = body_as(resp.into_body()).await;
        assert!(body.success, "create failed: {:?}", body.error);
        let entry = body.data.expect("entry");
        assert_eq!(entry.branch, "chat/wt-rt");

        // List — should include the new worktree
        let resp = post_json(
            state.clone(),
            "/worktree/list",
            &serde_json::json!({ "projectPath": repo.path().to_string_lossy() }),
        )
        .await;
        let body: IpcBody<Vec<GitWorktreeEntry>> = body_as(resp.into_body()).await;
        assert!(body.success, "list failed: {:?}", body.error);
        let entries = body.data.expect("entries");
        assert!(
            entries.iter().any(|e| e.branch == "chat/wt-rt"),
            "expected the created worktree in the list"
        );

        // Remove the worktree
        let resp = post_json(
            state.clone(),
            "/worktree/remove",
            &serde_json::json!({
                "projectPath": repo.path().to_string_lossy(),
                "worktreePath": entry.path,
                "force": true
            }),
        )
        .await;
        let body: IpcBody<()> = body_as(resp.into_body()).await;
        assert!(body.success, "remove failed: {:?}", body.error);
    }

    #[tokio::test]
    async fn check_dirty_returns_clean_for_fresh_worktree() {
        if git_missing() {
            return;
        }
        let repo = init_repo("dirty-ok");
        let state = test_state(repo.path().parent().unwrap_or_else(|| std::path::Path::new(".")));

        // Create a worktree so check-dirty has a valid path to probe
        let resp = post_json(
            state.clone(),
            "/worktree/create",
            &serde_json::json!({
                "projectPath": repo.path().to_string_lossy(),
                "name": "wt-dirty",
                "branch": "chat/wt-dirty",
                "isNewBranch": true
            }),
        )
        .await;
        let body: IpcBody<GitWorktreeEntry> = body_as(resp.into_body()).await;
        assert!(body.success, "create failed: {:?}", body.error);
        let entry = body.data.expect("entry");

        let uri = format!(
            "/worktree/check-dirty?worktreePath={}",
            urlencoding(&entry.path)
        );
        let resp = get_request(state, &uri).await;
        let body: IpcBody<DirtyStatus> = body_as(resp.into_body()).await;
        assert!(body.success, "{:?}", body.error);
        let status = body.data.expect("dirty status");
        assert!(!status.has_changes, "fresh worktree should be clean");
    }

    #[tokio::test]
    async fn copy_include_files_returns_outcome_for_fresh_worktree() {
        if git_missing() {
            return;
        }
        let repo = init_repo("copy-ok");
        let state = test_state(repo.path().parent().unwrap_or_else(|| std::path::Path::new(".")));

        let resp = post_json(
            state.clone(),
            "/worktree/create",
            &serde_json::json!({
                "projectPath": repo.path().to_string_lossy(),
                "name": "wt-copy",
                "branch": "chat/wt-copy",
                "isNewBranch": true
            }),
        )
        .await;
        let body: IpcBody<GitWorktreeEntry> = body_as(resp.into_body()).await;
        assert!(body.success, "create failed: {:?}", body.error);
        let entry = body.data.expect("entry");

        let resp = post_json(
            state,
            "/worktree/copy-include-files",
            &serde_json::json!({
                "projectPath": repo.path().to_string_lossy(),
                "worktreePath": entry.path
            }),
        )
        .await;
        let body: IpcBody<IncludeCopyResult> = body_as(resp.into_body()).await;
        assert!(body.success, "copy-include-files failed: {:?}", body.error);
        let outcome = body.data.expect("outcome");
        // No .worktree-include file → ran=0, copied=0
        assert_eq!(outcome.ran, 0, "no .worktree-include → ran=0");
        assert_eq!(outcome.copied, 0, "no .worktree-include → copied=0");
    }

    // ----- Production-router integration (Fix 14) -----
    //
    // The handler tests above use a hand-built `test_router`. These tests build
    // the REAL production `router::router(...)` (the same function `serve_router`
    // calls) and drive a `oneshot` request per route, asserting the response is
    // an `IpcBody` JSON (not the SPA static fallback). This catches a regression
    // that drops or swaps a route in only the production `router()` function
    // (the parity-checklist TS test only greps `router.rs` source text; this is
    // the runtime catch).

    /// Build the production `router()` with a test AppState rooted at `root`.
    fn production_router(root: &std::path::Path) -> axum::Router {
        let pty = crate::web::test_pty_manager();
        let project_root = root
            .canonicalize()
            .unwrap_or_else(|_| root.to_path_buf());
        crate::web::router::router(
            Arc::new(AcpManager::new(vec![])),
            pty.clone(),
            pty.terminal_events(),
            pty.cwd_tracker(),
            pty.git_tracker(),
            pty.exit_code_tracker(),
            Arc::new(WsRelaySink::new()),
            Arc::new(ProjectRegistry::new()),
            None,
            None,
            project_root,
            HistoryMode::LiveOnly,
            None,
            None,
            None,
            None,
            false,
            false,
        )
    }

    #[tokio::test]
    async fn production_router_serves_worktree_list_as_ipcbody_not_spa_fallback() {
        if git_missing() {
            return;
        }
        let repo = init_repo("prod-router-list");
        let app = production_router(
            repo.path().parent().unwrap_or_else(|| std::path::Path::new(".")),
        );
        let bytes = serde_json::to_vec(
            &serde_json::json!({ "projectPath": repo.path().to_string_lossy() }),
        )
        .expect("serialize");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/worktree/list")
                    .header("content-type", "application/json")
                    .extension(ConnectInfo(loopback()))
                    .body(Body::from(bytes))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<Vec<GitWorktreeEntry>> = body_as(resp.into_body()).await;
        assert!(
            body.success,
            "production router should serve /worktree/list as IpcBody, not SPA fallback: {:?}",
            body.error
        );
        assert!(
            !body.data.as_deref().unwrap_or_default().is_empty(),
            "fresh repo should have at least one worktree entry"
        );
    }

    #[tokio::test]
    async fn production_router_serves_worktree_branches_as_ipcbody_not_spa_fallback() {
        if git_missing() {
            return;
        }
        let repo = init_repo("prod-router-branches");
        let app = production_router(
            repo.path().parent().unwrap_or_else(|| std::path::Path::new(".")),
        );
        let uri = format!(
            "/worktree/branches?projectPath={}",
            urlencoding(&repo.path().to_string_lossy())
        );
        let resp = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(&uri)
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<Vec<BranchEntry>> = body_as(resp.into_body()).await;
        assert!(
            body.success,
            "production router should serve /worktree/branches as IpcBody, not SPA fallback: {:?}",
            body.error
        );
        assert!(
            !body.data.as_deref().unwrap_or_default().is_empty(),
            "fresh repo should have at least one branch"
        );
    }

    #[tokio::test]
    async fn production_router_serves_worktree_resolve_base_branch_as_ipcbody() {
        if git_missing() {
            return;
        }
        let repo = init_repo("prod-router-base");
        let app = production_router(
            repo.path().parent().unwrap_or_else(|| std::path::Path::new(".")),
        );
        let bytes = serde_json::to_vec(
            &serde_json::json!({ "projectPath": repo.path().to_string_lossy() }),
        )
        .expect("serialize");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/worktree/resolve-base-branch")
                    .header("content-type", "application/json")
                    .extension(ConnectInfo(loopback()))
                    .body(Body::from(bytes))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<BaseBranchInfo> = body_as(resp.into_body()).await;
        assert!(
            body.success,
            "production router should serve /worktree/resolve-base-branch as IpcBody: {:?}",
            body.error
        );
    }

    #[tokio::test]
    async fn production_router_does_not_swallow_unregistered_path_as_ipcbody() {
        // An unregistered path under /worktree/ must NOT return an IpcBody — it
        // should fall through to the SPA static fallback (404 in the test env
        // where dist-web/ is absent). This distinguishes the registered routes
        // from the fallback.
        let repo = init_repo("prod-router-404");
        let app = production_router(
            repo.path().parent().unwrap_or_else(|| std::path::Path::new(".")),
        );
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/worktree/nonexistent-route")
                    .header("content-type", "application/json")
                    .extension(ConnectInfo(loopback()))
                    .body(Body::from(
                        serde_json::to_vec(&serde_json::json!({})).expect("serialize"),
                    ))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        // The SPA fallback returns 404 when dist-web/ is absent (test env) or
        // index.html when present. Either way, it's NOT a 200 IpcBody.
        // A 200 here would mean the route was accidentally registered as a
        // catch-all. We assert the status is NOT OK-with-IpcBody by checking
        // that the body is NOT a valid IpcBody success.
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("read body");
        let text = String::from_utf8_lossy(&bytes);
        // The fallback body is either 404 "Not Found" or an HTML index — never
        // a JSON `{"success":...}` IpcBody.
        assert!(
            !text.contains("\"success\""),
            "unregistered /worktree/nonexistent-route must not return an IpcBody JSON, got: {text}"
        );
    }
}
