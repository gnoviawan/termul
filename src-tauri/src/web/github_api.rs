//! `POST /github/{context,items,item,checks,check-log,merge,comment,checkout-pr}`:
//! web transport for the shared [`GithubService`] (desktop twins: the
//! `github_*` Tauri commands). The body is the request object
//! `lib/github-api.ts` sends.
//!
//! Every route resolves `cwd` with `resolve_cwd(.., None, false)` (canonical
//! cwd inside a registered project). `merge`, `comment` and `checkout-pr` are
//! writes: the remote-write guard runs first, so a LAN peer cannot change
//! GitHub or a worktree without `--allow-remote-writes`.
//!
//! Replies are `IpcBody<T>` with the service's `GH_*` codes. Logs carry the
//! op, cwd and code, never bodies or `gh` output.

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, State};
use axum::{http::StatusCode, Json};

use crate::github::*;
use crate::web::fs_api::{check_local_only, IpcBody};
use crate::web::git_api::{cwd_string, resolve_cwd};
use crate::web::ws::AppState;

type Reply<T> = (StatusCode, Json<IpcBody<T>>);

async fn run<T: Send + 'static>(
    state: &AppState,
    op: &'static str,
    cwd: &str,
    call: impl FnOnce(&GithubService, String) -> Result<T, GithubError> + Send + 'static,
) -> Reply<T> {
    let resolved = match resolve_cwd::<T>(cwd, state, None, false) {
        Ok(path) => path,
        Err(reply) => return reply,
    };
    let cwd = match cwd_string::<T>(&resolved) {
        Ok(cwd) => cwd,
        Err(reply) => return reply,
    };
    let cwd_for_log = cwd.clone();
    let result = tokio::task::spawn_blocking(move || call(&GithubService::shared(), cwd)).await;
    let body = match result {
        Ok(Ok(data)) => {
            tracing::info!(op, path = %cwd_for_log, "github op ok");
            IpcBody::ok(data)
        }
        Ok(Err(error)) => {
            tracing::warn!(op, path = %cwd_for_log, code = error.code(), error = %error, "github op failed");
            IpcBody::<T>::err(error.to_string(), error.code())
        }
        Err(error) => {
            tracing::error!(op, path = %cwd_for_log, error = %error, "github op task panicked");
            IpcBody::<T>::err(format!("github {op} task failed: {error}"), "GH_FAILED")
        }
    };
    (StatusCode::OK, Json(body))
}

pub async fn context(
    State(state): State<AppState>,
    Json(req): Json<GithubContextRequest>,
) -> Reply<GithubContext> {
    run(&state, "context", &req.cwd, |service, cwd| {
        service.context(&cwd)
    })
    .await
}

pub async fn list_items(
    State(state): State<AppState>,
    Json(req): Json<GithubListRequest>,
) -> Reply<GithubListResult> {
    let cwd = req.cwd.clone();
    run(&state, "list_items", &cwd, move |service, cwd| {
        service.list_items(&GithubListRequest { cwd, ..req })
    })
    .await
}

pub async fn get_item(
    State(state): State<AppState>,
    Json(req): Json<GithubItemRequest>,
) -> Reply<GithubItemDetail> {
    let cwd = req.cwd.clone();
    run(&state, "get_item", &cwd, move |service, cwd| {
        service.get_item(&GithubItemRequest { cwd, ..req })
    })
    .await
}

pub async fn get_checks(
    State(state): State<AppState>,
    Json(req): Json<GithubChecksRequest>,
) -> Reply<GithubChecksResult> {
    let cwd = req.cwd.clone();
    run(&state, "get_checks", &cwd, move |service, cwd| {
        service.get_checks(&GithubChecksRequest { cwd, ..req })
    })
    .await
}

pub async fn get_check_log(
    State(state): State<AppState>,
    Json(req): Json<GithubCheckLogRequest>,
) -> Reply<GithubCheckLog> {
    let cwd = req.cwd.clone();
    run(&state, "get_check_log", &cwd, move |service, cwd| {
        service.get_check_log(&GithubCheckLogRequest { cwd, ..req })
    })
    .await
}

/// The reply refusing a write from a peer the remote-write guard rejects.
fn write_refused<T>(state: &AppState, peer: SocketAddr, route: &str) -> Option<Reply<T>> {
    check_local_only::<T>(
        peer,
        state.allow_remote_writes,
        state.shared_live_writes_denied,
        route,
    )
    .map(|forbidden| (StatusCode::OK, Json(forbidden)))
}

pub async fn merge(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<GithubMergeRequest>,
) -> Reply<GithubMergeResult> {
    if let Some(refused) = write_refused(&state, peer, "/github/merge") {
        return refused;
    }
    let cwd = req.cwd.clone();
    run(&state, "merge", &cwd, move |service, cwd| {
        service.merge(&GithubMergeRequest { cwd, ..req })
    })
    .await
}

pub async fn comment(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<GithubCommentRequest>,
) -> Reply<GithubCommentResult> {
    if let Some(refused) = write_refused(&state, peer, "/github/comment") {
        return refused;
    }
    let cwd = req.cwd.clone();
    run(&state, "comment", &cwd, move |service, cwd| {
        service.comment(&GithubCommentRequest { cwd, ..req })
    })
    .await
}

/// The service accepts only Termul chat worktrees of the resolved project.
pub async fn checkout_pr(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<GithubCheckoutPrRequest>,
) -> Reply<GithubCheckoutPrResult> {
    if let Some(refused) = write_refused(&state, peer, "/github/checkout-pr") {
        return refused;
    }
    let cwd = req.cwd.clone();
    run(&state, "checkout_pr", &cwd, move |service, cwd| {
        service.checkout_pr(&GithubCheckoutPrRequest { cwd, ..req })
    })
    .await
}

#[cfg(test)]
mod tests;
