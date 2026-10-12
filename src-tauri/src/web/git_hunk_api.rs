//! HTTP handlers for per-hunk stage/unstage exposed to the web/remote client
//! (`POST /git/stage-hunk`, `POST /git/unstage-hunk`).
//!
//! Mirrors the desktop `git_stage_hunk` / `git_unstage_hunk` Tauri commands
//! over HTTP, calling the SAME `git_tracker::git_stage_hunk` /
//! `git_unstage_hunk` functions (no git logic lives in the transport). Each
//! route is a WRITE route: `resolve_cwd(.., Some(peer), true)` applies the
//! loopback / `--allow-remote-writes` / shared-live denial guard
//! (`check_local_only`) before any filesystem work, then root containment.
//!
//! The shared functions return `Result<(), String>`; this adapter maps the
//! error text onto stable codes via [`classify_hunk_error`] (AD-7 recorded
//! exception: the typed-error rewrite is out of scope for the transport).
//! Patch bodies are never logged — only the op, cwd and outcome code.
//!
//! Lives in its own module because `web/git_api.rs` is a no-net-growth file.

use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::Deserialize;

use crate::trackers::git_tracker;
use crate::web::command_ledger::{fingerprint_of, no_entity, run_http};
use crate::web::fs_api::IpcBody;
use crate::web::git_api::{cwd_string, resolve_cwd};
use crate::web::ws::AppState;

/// `POST /git/stage-hunk | unstage-hunk { cwd, path, hunkPatch }` body.
/// Mirrors the desktop command args (`cwd`, `path`, `hunkPatch`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHunkRequest {
    pub cwd: String,
    pub path: String,
    pub hunk_patch: String,
}

/// Which hunk operation a request performs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HunkOp {
    Stage,
    Unstage,
}

impl HunkOp {
    fn label(self) -> &'static str {
        match self {
            HunkOp::Stage => "stage-hunk",
            HunkOp::Unstage => "unstage-hunk",
        }
    }

    fn fallback_code(self) -> &'static str {
        match self {
            HunkOp::Stage => "GIT_STAGE_HUNK_ERROR",
            HunkOp::Unstage => "GIT_UNSTAGE_HUNK_ERROR",
        }
    }
}

/// Map a `git_stage_hunk` / `git_unstage_hunk` error string to a stable code.
///
/// Classification keys off the exact validation strings in
/// `git_tracker::commands` and the `git apply` failure text; anything else
/// (spawn/wait errors, task panics, unknown stderr) falls back to the
/// per-op code.
pub(crate) fn classify_hunk_error(op: HunkOp, err: &str) -> &'static str {
    if err.starts_with("Refusing hunk patch for unsafe path")
        || (err.starts_with("Hunk patch path '") && err.contains("does not match expected"))
        || err.starts_with("Hunk patch is missing its --- or +++ header")
    {
        "INVALID_HUNK_PATCH"
    } else if err.starts_with("git apply timed out after") {
        "GIT_TIMEOUT"
    } else if err.contains("patch does not apply") || err.contains("patch failed:") {
        "HUNK_DOES_NOT_APPLY"
    } else {
        op.fallback_code()
    }
}

/// `POST /git/stage-hunk` — `git apply --cached --recount` of one hunk
/// (write, loopback-guarded).
pub async fn stage_hunk(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<GitHunkRequest>,
) -> impl IntoResponse {
    run_hunk_write(&state, peer, &headers, req, HunkOp::Stage).await
}

/// `POST /git/unstage-hunk` — reverse-apply of one staged hunk to the index
/// (write, loopback-guarded).
pub async fn unstage_hunk(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<GitHunkRequest>,
) -> impl IntoResponse {
    run_hunk_write(&state, peer, &headers, req, HunkOp::Unstage).await
}

async fn run_hunk_write(
    state: &AppState,
    peer: SocketAddr,
    headers: &HeaderMap,
    req: GitHunkRequest,
    op: HunkOp,
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
    let label = op.label();
    let kind = match op {
        HunkOp::Stage => "git_stage_hunk",
        HunkOp::Unstage => "git_unstage_hunk",
    };
    let GitHunkRequest {
        cwd: raw_cwd,
        path,
        hunk_patch,
    } = req;
    // The fingerprint names the file, never the patch.
    let body = run_http(
        state.relay.ledger(),
        headers,
        kind,
        fingerprint_of(kind, &[("cwd", &raw_cwd), ("path", &path)]),
        no_entity(),
        async move {
            let result = tokio::task::spawn_blocking(move || match op {
                HunkOp::Stage => git_tracker::git_stage_hunk(&cwd, &path, &hunk_patch),
                HunkOp::Unstage => git_tracker::git_unstage_hunk(&cwd, &path, &hunk_patch),
            })
            .await;
            // Outcome logs carry op + cwd + code only: git's stderr (and the
            // patch) can echo file content, so neither is ever logged.
            match result {
                Ok(Ok(())) => {
                    tracing::info!(path = %cwd_for_log, op = label, "git {label} ok");
                    IpcBody::<()>::ok(())
                }
                Ok(Err(e)) => {
                    let code = classify_hunk_error(op, &e);
                    tracing::warn!(path = %cwd_for_log, op = label, code, "git {label} failed");
                    IpcBody::<()>::err(e, code)
                }
                Err(e) => {
                    let code = op.fallback_code();
                    tracing::error!(path = %cwd_for_log, op = label, code, "git {label} task panicked");
                    IpcBody::<()>::err(format!("git {label} task failed: {e}"), code)
                }
            }
        },
    )
    .await;
    (StatusCode::OK, Json(body))
}

#[cfg(test)]
mod tests;
