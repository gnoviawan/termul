//! `POST /git/diff-stat { cwd }` — web transport for the shared
//! [`git_tracker::git_get_diff_stat`] (desktop twin: the `git_get_diff_stat`
//! Tauri command).
//!
//! READ route: `resolve_cwd(.., None, false)` canonicalizes the cwd, rejects
//! `..`, and enforces the project-root boundary (`OUTSIDE_PROJECT_ROOT`) with
//! no loopback / remote-write gate, like the other `/git/*` read routes.
//!
//! Reply is `IpcBody<GitDiffStat>`: `{ success: true, data: { added, removed, files } }`
//! or `{ success: false, error, code }` with the shared `DiffStatError::code()`.
//! Boundary events are logged via `tracing`; file contents are never logged.

use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};

use crate::trackers::git_tracker::{self, GitDiffStat};
use crate::web::fs_api::IpcBody;
use crate::web::git_api::{cwd_string, resolve_cwd, GitCwdRequest};
use crate::web::ws::AppState;

pub async fn get_diff_stat(
    State(state): State<AppState>,
    Json(req): Json<GitCwdRequest>,
) -> impl IntoResponse {
    let resolved = match resolve_cwd::<GitDiffStat>(&req.cwd, &state, None, false) {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    let cwd = match cwd_string::<GitDiffStat>(&resolved) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let cwd_for_log = cwd.clone();
    let result = tokio::task::spawn_blocking(move || git_tracker::git_get_diff_stat(&cwd)).await;
    let body = match result {
        Ok(Ok(stat)) => {
            tracing::info!(
                path = %cwd_for_log,
                added = stat.added,
                removed = stat.removed,
                "git diff stat ok"
            );
            IpcBody::ok(stat)
        }
        Ok(Err(e)) => {
            tracing::warn!(path = %cwd_for_log, error = %e, "git diff stat failed");
            IpcBody::<GitDiffStat>::err(e.to_string(), e.code())
        }
        Err(e) => {
            tracing::error!(path = %cwd_for_log, error = %e, "git diff stat task panicked");
            IpcBody::<GitDiffStat>::err(
                format!("git diff stat task failed: {e}"),
                "GIT_DIFF_STAT_ERROR",
            )
        }
    };
    (StatusCode::OK, Json(body))
}

#[cfg(test)]
mod tests;
