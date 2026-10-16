//! `POST /git/commit-detail { cwd, hash }` and
//! `POST /git/commit-file-diff { cwd, hash, path, oldPath? }` — web transport
//! for the shared [`git_tracker::git_get_commit_detail`] and
//! [`git_tracker::git_get_commit_file_diff`] (desktop twins: the Tauri commands
//! of the same names). Feed the Git History detail pane and commit Diff tab.
//!
//! READ route: `resolve_cwd(.., None, false)` canonicalizes the cwd, rejects
//! `..`, and enforces the project-root boundary (`OUTSIDE_PROJECT_ROOT`) with
//! no loopback / remote-write gate, like the other `/git/*` read routes. The
//! hash is validated by the shared service before git runs.
//!
//! Reply is `IpcBody<GitCommitDetail>` or `{ success: false, error, code }`
//! with the shared `CommitDetailError::code()`. Boundary events are logged via
//! `tracing`; file contents are never read or logged.

use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;

use crate::trackers::git_tracker::{self, GitCommitDetail, GitCommitFileDiff};
use crate::web::fs_api::IpcBody;
use crate::web::git_api::{cwd_string, resolve_cwd};
use crate::web::ws::AppState;

/// `POST /git/commit-detail` body.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDetailRequest {
    pub cwd: String,
    pub hash: String,
}

pub async fn get_commit_detail(
    State(state): State<AppState>,
    Json(req): Json<GitCommitDetailRequest>,
) -> impl IntoResponse {
    let resolved = match resolve_cwd::<GitCommitDetail>(&req.cwd, &state, None, false) {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    let cwd = match cwd_string::<GitCommitDetail>(&resolved) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let cwd_for_log = cwd.clone();
    let hash = req.hash;
    let hash_for_log = hash.chars().take(40).collect::<String>();
    let result =
        tokio::task::spawn_blocking(move || git_tracker::git_get_commit_detail(&cwd, &hash)).await;
    let body = match result {
        Ok(Ok(detail)) => {
            tracing::info!(
                path = %cwd_for_log,
                hash = %detail.hash,
                files = detail.files.len(),
                truncated = detail.files_truncated,
                "git commit detail ok"
            );
            IpcBody::ok(detail)
        }
        Ok(Err(e)) => {
            tracing::warn!(path = %cwd_for_log, hash = %hash_for_log, error = %e, "git commit detail failed");
            IpcBody::<GitCommitDetail>::err(e.to_string(), e.code())
        }
        Err(e) => {
            tracing::error!(path = %cwd_for_log, error = %e, "git commit detail task panicked");
            IpcBody::<GitCommitDetail>::err(
                format!("git commit detail task failed: {e}"),
                "GIT_COMMIT_DETAIL_ERROR",
            )
        }
    };
    (StatusCode::OK, Json(body))
}

/// `POST /git/commit-file-diff` body. `oldPath` is a rename's source path.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFileDiffRequest {
    pub cwd: String,
    pub hash: String,
    pub path: String,
    pub old_path: Option<String>,
}

/// `POST /git/commit-file-diff` — one file's unified diff in a commit against
/// its first parent (read-only commit Diff tab). Same READ guard as above. The
/// reply is `{ diff, tooLarge }`; a diff over the size cap has an empty `diff`.
pub async fn get_commit_file_diff(
    State(state): State<AppState>,
    Json(req): Json<GitCommitFileDiffRequest>,
) -> impl IntoResponse {
    let resolved = match resolve_cwd::<GitCommitFileDiff>(&req.cwd, &state, None, false) {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    let cwd = match cwd_string::<GitCommitFileDiff>(&resolved) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let cwd_for_log = cwd.clone();
    let hash_for_log = req.hash.chars().take(40).collect::<String>();
    let GitCommitFileDiffRequest {
        hash,
        path,
        old_path,
        ..
    } = req;
    let result = tokio::task::spawn_blocking(move || {
        git_tracker::git_get_commit_file_diff(&cwd, &hash, &path, old_path.as_deref())
    })
    .await;
    let body = match result {
        Ok(Ok(result)) => {
            tracing::info!(path = %cwd_for_log, hash = %hash_for_log, bytes = result.diff.len(), too_large = result.too_large, "git commit file diff ok");
            IpcBody::ok(result)
        }
        Ok(Err(e)) => {
            tracing::warn!(path = %cwd_for_log, hash = %hash_for_log, error = %e, "git commit file diff failed");
            IpcBody::<GitCommitFileDiff>::err(e.to_string(), e.code())
        }
        Err(e) => {
            tracing::error!(path = %cwd_for_log, error = %e, "git commit file diff task panicked");
            IpcBody::<GitCommitFileDiff>::err(
                format!("git commit file diff task failed: {e}"),
                "GIT_COMMIT_DETAIL_ERROR",
            )
        }
    };
    (StatusCode::OK, Json(body))
}

#[cfg(test)]
mod tests;
