//! `POST /worktree/create` under the command ledger: one effect shared by the
//! plain JSON reply and the NDJSON progress stream, the by-existence entity
//! lookup of a resend, and the admission (`X-Command-Id`).
//!
//! A resend of a create that already ran is answered with a plain `IpcBody`
//! even when it asked for the stream (the client reads a non-NDJSON reply as
//! the result); only the run that executes streams progress frames.

use std::sync::Arc;

use axum::{
    body::Body,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures::StreamExt;
use tokio::sync::{mpsc, oneshot};
use tracing::{error, info, warn};

use super::scope::path_key;
use super::worktree_err;
use crate::web::command_ledger::{fingerprint_of, run_http, Settled};
use crate::web::fs_api::IpcBody;
use crate::web::ws::AppState;
use crate::worktree::{GitWorktreeEntry, WorktreeManager};

/// The resolved arguments of one create.
pub(super) struct CreateArgs {
    /// `projectPath` as the client sent it (fingerprinted, never the resolved form).
    pub raw_project_path: String,
    pub project_path: String,
    pub name: String,
    pub branch: String,
    pub is_new_branch: bool,
    pub start_ref: Option<String>,
    /// `targetPath` as sent, when present.
    pub raw_target_path: Option<String>,
    /// The resolved `targetPath`, when present.
    pub target_path: Option<String>,
    pub progress_id: Option<String>,
    pub stream_progress: bool,
}

/// A comparison key for a worktree path: canonical when it exists (git lists
/// resolved paths; the request may name a symlinked one), else as given.
fn canonical_key(path: &str) -> String {
    let canonical = std::fs::canonicalize(path).map_or_else(|_| path.to_string(), |p| p.to_string_lossy().into_owned());
    path_key(&canonical)
}

/// The worktree a resend created: one on `branch` at the path `create` uses.
pub(crate) async fn existing_entity(
    project_path: String,
    name: String,
    branch: String,
    target_path: Option<String>,
) -> Option<Settled> {
    let entries = tokio::task::spawn_blocking({
        let project_path = project_path.clone();
        move || WorktreeManager::list(&project_path)
    })
    .await
    .ok()?
    .ok()?;
    let target = canonical_key(&WorktreeManager::target_path(
        &project_path,
        &name,
        target_path.as_deref(),
    ));
    let entry = entries
        .into_iter()
        .find(|entry| entry.branch == branch && canonical_key(&entry.path) == target)?;
    Some(Settled::Accepted {
        payload: serde_json::to_value(entry).ok(),
        visible_at: None,
    })
}

/// Create the worktree. `frames` receives the NDJSON frames (`preparing`,
/// `progress` per git stderr line, the final `result`) of a streaming request.
async fn create_effect(
    args: CreateArgs,
    frames: Option<mpsc::UnboundedSender<String>>,
) -> IpcBody<GitWorktreeEntry> {
    let CreateArgs {
        project_path,
        name,
        branch,
        is_new_branch,
        start_ref,
        target_path,
        progress_id,
        ..
    } = args;
    let path_for_log = project_path.clone();
    info!(path = %path_for_log, name = %name, branch = %branch, is_new_branch = %is_new_branch, start_ref = ?start_ref, target_path = ?target_path, progress_id = ?progress_id, "worktree create start");
    let (log_name, log_branch, log_start, log_target) = (
        name.clone(),
        branch.clone(),
        start_ref.clone(),
        target_path.clone(),
    );
    let sender = frames.clone();
    let joined = tokio::task::spawn_blocking(move || {
        let pid = progress_id.as_deref();
        let send = |frame: serde_json::Value| {
            if let Some(tx) = &sender {
                let _ = tx.send(frame.to_string());
            }
        };
        send(serde_json::json!({"type": "preparing", "progressId": pid}));
        let mut on_line = |line: &str| {
            send(serde_json::json!({"type": "progress", "progressId": pid, "line": line}));
        };
        let progress: Option<&mut dyn FnMut(&str)> =
            if sender.is_some() { Some(&mut on_line) } else { None };
        WorktreeManager::create(
            &project_path,
            &name,
            &branch,
            is_new_branch,
            start_ref.as_deref(),
            target_path.as_deref(),
            progress,
        )
    })
    .await;
    let body = match joined {
        Ok(Ok(entry)) => {
            info!(path = %path_for_log, name = %log_name, branch = %entry.branch, "worktree create ok");
            IpcBody::ok(entry)
        }
        Ok(Err(e)) => {
            warn!(path = %path_for_log, name = %log_name, branch = %log_branch, is_new_branch = %is_new_branch, start_ref = ?log_start, target_path = ?log_target, error = %e, "worktree create failed");
            worktree_err::<GitWorktreeEntry>(e)
        }
        Err(e) => {
            error!(path = %path_for_log, name = %log_name, branch = %log_branch, is_new_branch = %is_new_branch, start_ref = ?log_start, target_path = ?log_target, error = %e, "worktree create task panicked");
            IpcBody::<GitWorktreeEntry>::err(
                format!("worktree create task failed: {e}"),
                "WORKTREE_CREATE_ERROR",
            )
        }
    };
    if let Some(tx) = frames {
        let _ = tx.send(serde_json::json!({"type": "result", "result": &body}).to_string());
    }
    body
}

/// Admit the create under its `commandId` (when it has one) and run it.
/// `started` fires when this call executes the create (not a replay).
async fn admit(
    ledger: &Arc<crate::web::command_ledger::CommandLedger>,
    headers: &HeaderMap,
    args: CreateArgs,
    frames: Option<mpsc::UnboundedSender<String>>,
    started: Option<oneshot::Sender<()>>,
) -> IpcBody<GitWorktreeEntry> {
    let lookup = {
        let (project, name, branch, target) = (
            args.project_path.clone(),
            args.name.clone(),
            args.branch.clone(),
            args.target_path.clone(),
        );
        move || existing_entity(project.clone(), name.clone(), branch.clone(), target.clone())
    };
    let mut fields = vec![
        ("projectPath", args.raw_project_path.clone()),
        ("name", args.name.clone()),
        ("branch", args.branch.clone()),
    ];
    if let Some(target) = &args.raw_target_path {
        fields.push(("targetPath", target.clone()));
    }
    let fields: Vec<(&str, &str)> = fields.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let fingerprint = fingerprint_of("worktree_create", &fields);
    run_http(ledger, headers, "worktree_create", fingerprint, lookup, async move {
        if let Some(started) = started {
            let _ = started.send(());
        }
        create_effect(args, frames).await
    })
    .await
}

/// The `POST /worktree/create` reply for resolved `args`.
pub(super) async fn create(state: &AppState, headers: &HeaderMap, args: CreateArgs) -> Response {
    let ledger = Arc::clone(state.relay.ledger());
    if !args.stream_progress {
        let body = admit(&ledger, headers, args, None, None).await;
        return (StatusCode::OK, Json(body)).into_response();
    }
    let (tx, rx) = mpsc::unbounded_channel::<String>();
    let (started_tx, started_rx) = oneshot::channel();
    let headers = headers.clone();
    let mut task = tokio::spawn(async move {
        admit(&ledger, &headers, args, Some(tx), Some(started_tx)).await
    });
    tokio::select! {
        Ok(()) = started_rx => {
            let stream = tokio_stream::wrappers::UnboundedReceiverStream::new(rx).map(|line| {
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
        joined = &mut task => {
            let body = joined.unwrap_or_else(|e| {
                error!(error = %e, "worktree create admission task failed");
                IpcBody::<GitWorktreeEntry>::err(
                    format!("worktree create task failed: {e}"),
                    "WORKTREE_CREATE_ERROR",
                )
            });
            (StatusCode::OK, Json(body)).into_response()
        }
    }
}

/// Whether the worktree at `worktree_path` is already removed: git lists none
/// there AND nothing is left on disk (`false` when the list cannot be read). A
/// path git does not list but that still exists (a detached worktree `list`
/// filters out) is not gone.
pub(super) fn is_gone(project_path: &str, worktree_path: &str) -> bool {
    let key = canonical_key(worktree_path);
    !std::path::Path::new(worktree_path).exists()
        && WorktreeManager::list(project_path)
            .is_ok_and(|entries| entries.iter().all(|entry| canonical_key(&entry.path) != key))
}
