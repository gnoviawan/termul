//! HTTP handler for renaming a worktree's branch by hand
//! (`POST /worktree/rename-branch`, story 16 / CAP-5).
//!
//! Mirrors the desktop `worktree_rename_branch` Tauri command over HTTP and
//! calls the SAME host function (`AcpManager::rename_worktree_branch` ->
//! `rename_and_record`): git rename through `WorktreeManager`, every session on
//! the worktree rewritten by the host `SessionPersistence` (source becomes
//! `user`), and one agent-level `worktree_branch_renamed` event fanned out
//! through the manager's sinks (so shared-live also reaches the desktop Tauri
//! sink). No git or filesystem logic lives in this transport.
//!
//! It is a WRITE route: `resolve_project_path(.., Some(peer), true)` applies the
//! loopback / `--allow-remote-writes` / shared-live denial guard before any
//! filesystem work, then root containment.
//!
//! Outcome logs carry the op and a stable code only: branch names come from
//! prompts or user text and are never logged here.
//!
//! Lives in its own module because `web/worktree_api.rs` is a no-net-growth
//! file.

use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use tracing::{info, warn};

use crate::web::command_ledger::{fingerprint_of, no_entity, run_http};
use crate::web::fs_api::IpcBody;
use crate::web::worktree_api::{path_string, resolve_project_path};
use crate::web::ws::AppState;

/// `POST /worktree/rename-branch { worktreePath, oldBranch, newBranch }` body.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRenameBranchRequest {
    pub worktree_path: String,
    pub old_branch: String,
    pub new_branch: String,
}

/// `POST /worktree/rename-branch` — rename a worktree's branch by hand
/// (write, remote-write guarded). Mirrors `worktree_rename_branch` ->
/// `AcpManager::rename_worktree_branch`.
pub async fn rename_branch(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<WorktreeRenameBranchRequest>,
) -> impl IntoResponse {
    let resolved = match resolve_project_path::<()>(&req.worktree_path, &state, Some(peer), true) {
        Ok(p) => p,
        Err((st, body)) => return (st, body),
    };
    let worktree_path = match path_string::<()>(&resolved) {
        Ok(s) => s,
        Err((st, body)) => return (st, body),
    };
    let acp = std::sync::Arc::clone(&state.acp);
    let body = run_http(
        state.relay.ledger(),
        &headers,
        "worktree_rename_branch",
        fingerprint_of(
            "worktree_rename_branch",
            &[
                ("worktreePath", &req.worktree_path),
                ("oldBranch", &req.old_branch),
                ("newBranch", &req.new_branch),
            ],
        ),
        no_entity(),
        async move {
            let result = acp
                .rename_worktree_branch(&worktree_path, &req.old_branch, &req.new_branch)
                .await;
            match result {
                Ok(()) => {
                    info!(op = "rename-branch", "worktree rename-branch ok");
                    IpcBody::<()>::ok(())
                }
                Err(e) => {
                    let code = e.error_code();
                    warn!(op = "rename-branch", code, "worktree rename-branch failed");
                    IpcBody::<()>::err(e.to_string(), code)
                }
            }
        },
    )
    .await;
    (StatusCode::OK, Json(body))
}

#[cfg(test)]
mod tests;
