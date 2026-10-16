use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use tracing::{error, info, warn};

use super::{path_string, resolve_project_path, worktree_err, WorktreeProjectPathRequest};
use crate::web::fs_api::IpcBody;
use crate::web::ws::AppState;
use crate::worktree::{GitignoreDir, SymlinkResult, WorktreeManager};

/// `POST /worktree/{create,ensure}-symlinks { projectPath, worktreePath, symlinkDirs }` body.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSymlinksRequest {
    pub project_path: String,
    pub worktree_path: String,
    pub symlink_dirs: Vec<String>,
}

/// `POST /worktree/parse-gitignore` — the simple `.gitignore` directory
/// entries that can be symlinked into a worktree (read-only).
pub async fn parse_gitignore(
    State(state): State<AppState>,
    Json(req): Json<WorktreeProjectPathRequest>,
) -> impl IntoResponse {
    let resolved =
        match resolve_project_path::<Vec<GitignoreDir>>(&req.project_path, &state, None, false) {
            Ok(p) => p,
            Err(resp) => return resp,
        };
    let project_path = match path_string::<Vec<GitignoreDir>>(&resolved) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let path_for_log = project_path.clone();
    let result =
        tokio::task::spawn_blocking(move || WorktreeManager::parse_gitignore_dirs(&project_path))
            .await;
    let body = match result {
        Ok(Ok(dirs)) => {
            info!(path = %path_for_log, count = dirs.len(), "worktree parse-gitignore ok");
            IpcBody::ok(dirs)
        }
        Ok(Err(e)) => {
            warn!(path = %path_for_log, error = %e, "worktree parse-gitignore failed");
            worktree_err::<Vec<GitignoreDir>>(e)
        }
        Err(e) => {
            error!(path = %path_for_log, error = %e, "worktree parse-gitignore task panicked");
            IpcBody::<Vec<GitignoreDir>>::err(
                format!("worktree parse-gitignore task failed: {e}"),
                "WORKTREE_PARSE_GITIGNORE_ERROR",
            )
        }
    };
    (StatusCode::OK, Json(body))
}

/// `POST /worktree/create-symlinks` — link each project-root directory in
/// `symlinkDirs` into the worktree.
pub async fn create_symlinks(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<WorktreeSymlinksRequest>,
) -> impl IntoResponse {
    link_dirs(
        &state,
        peer,
        req,
        "create-symlinks",
        WorktreeManager::create_symlinks,
    )
    .await
}

/// `POST /worktree/ensure-symlinks` — create whichever links in `symlinkDirs`
/// are missing; existing ones are left untouched.
pub async fn ensure_symlinks(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<WorktreeSymlinksRequest>,
) -> impl IntoResponse {
    link_dirs(
        &state,
        peer,
        req,
        "ensure-symlinks",
        WorktreeManager::ensure_symlinks,
    )
    .await
}

async fn link_dirs(
    state: &AppState,
    peer: SocketAddr,
    req: WorktreeSymlinksRequest,
    route: &'static str,
    link: fn(&str, &str, &[String]) -> Vec<SymlinkResult>,
) -> (StatusCode, Json<IpcBody<Vec<SymlinkResult>>>) {
    let project_resolved = match resolve_project_path::<Vec<SymlinkResult>>(
        &req.project_path,
        state,
        Some(peer),
        true,
    ) {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    let project_path = match path_string::<Vec<SymlinkResult>>(&project_resolved) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let worktree_resolved = match resolve_project_path::<Vec<SymlinkResult>>(
        &req.worktree_path,
        state,
        Some(peer),
        true,
    ) {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    let worktree_path = match path_string::<Vec<SymlinkResult>>(&worktree_resolved) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let path_for_log = worktree_path.clone();
    let dirs = req.symlink_dirs;
    let result =
        tokio::task::spawn_blocking(move || link(&project_path, &worktree_path, &dirs)).await;
    let body = match result {
        Ok(results) => {
            let count = |status: &str| results.iter().filter(|r| r.status == status).count();
            let (created, skipped, failed) = (count("created"), count("skipped"), count("failed"));
            if failed > 0 {
                warn!(path = %path_for_log, route, created, skipped, failed, "worktree symlinks partly failed");
            } else {
                info!(path = %path_for_log, route, created, skipped, "worktree symlinks ok");
            }
            IpcBody::ok(results)
        }
        Err(e) => {
            error!(path = %path_for_log, route, error = %e, "worktree symlinks task panicked");
            IpcBody::<Vec<SymlinkResult>>::err(
                format!("worktree {route} task failed: {e}"),
                "WORKTREE_SYMLINKS_ERROR",
            )
        }
    };
    (StatusCode::OK, Json(body))
}

#[cfg(test)]
#[path = "symlinks_tests.rs"]
mod tests;
