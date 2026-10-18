//! Web transport of `canvas::persistence` (spine AD-23, AD-31), the twins of
//! the `canvas_read_document` / `canvas_document_loaded` /
//! `canvas_dirty_changed` / `canvas_write_snapshot` Tauri commands:
//!
//! - `POST /canvas/read-document` `{projectId, mountSeq}` → `{bytes}`;
//! - `POST /canvas/document-loaded` `{projectId, mountSeq, ack}` → view;
//! - `POST /canvas/dirty-changed` `{projectId, mountSeq, dirty,
//!   contentVersion}` → outcome, answered once the autosave debounce settles;
//! - `POST /canvas/write-snapshot` `{projectId, mountSeq, snapshot}` →
//!   `{view, markSaved}`.
//!
//! Merged into `canvas_api::canvas_router`, so they sit behind the outer
//! bearer gate and the shared canvas write predicate like `/canvas/open`.
//! Document bytes are never logged.

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, DefaultBodyLimit, State};
use axum::response::Json;
use axum::routing::post;
use axum::Router;
use serde::Deserialize;

use crate::canvas::persistence::{
    self, canvas_mounts, DirtyOutcome, DocumentBytes, PersistenceView, WriteOutcome,
};
use crate::canvas::CanvasError;
use crate::web::canvas_api::{check_canvas_write, CanvasState};
use crate::web::fs_api::IpcBody;

/// The web routes this module serves; `canvas_api` exempts them from the
/// `ct` gate and the router keeps them behind the bearer gate.
pub const PERSISTENCE_ROUTES: &[&str] = &[
    "/canvas/read-document",
    "/canvas/document-loaded",
    "/canvas/dirty-changed",
    "/canvas/write-snapshot",
];

/// A snapshot is a whole `.figcraft` file as base64 inside JSON.
const MAX_SNAPSHOT_BODY_BYTES: usize = 256 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MountRequest {
    project_id: String,
    mount_seq: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadedRequest {
    project_id: String,
    mount_seq: u64,
    ack: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirtyRequest {
    project_id: String,
    mount_seq: u64,
    dirty: bool,
    content_version: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotRequest {
    project_id: String,
    mount_seq: u64,
    snapshot: String,
}

pub fn persistence_routes() -> Router<CanvasState> {
    Router::new()
        .route("/canvas/read-document", post(read_document))
        .route("/canvas/document-loaded", post(document_loaded))
        .route("/canvas/dirty-changed", post(dirty_changed))
        .route(
            "/canvas/write-snapshot",
            post(write_snapshot).layer(DefaultBodyLimit::max(MAX_SNAPSHOT_BODY_BYTES)),
        )
}

fn body<T>(operation: &str, project_id: &str, result: Result<T, CanvasError>) -> Json<IpcBody<T>> {
    Json(match result {
        Ok(value) => IpcBody::ok(value),
        Err(err) => {
            tracing::warn!(
                target: "termul::web::canvas",
                "canvas {operation} failed project_id={} code={}",
                crate::commands::sanitize_log_field(project_id),
                err.code
            );
            IpcBody::err(err.message, err.code)
        }
    })
}

async fn read_document(
    State(state): State<CanvasState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<MountRequest>,
) -> Json<IpcBody<DocumentBytes>> {
    if let Some(forbidden) = check_canvas_write(&state, peer, "/canvas/read-document") {
        return Json(forbidden);
    }
    let result = persistence::read_document(canvas_mounts(), &req.project_id, req.mount_seq).await;
    body("read document", &req.project_id, result)
}

async fn document_loaded(
    State(state): State<CanvasState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<LoadedRequest>,
) -> Json<IpcBody<PersistenceView>> {
    if let Some(forbidden) = check_canvas_write(&state, peer, "/canvas/document-loaded") {
        return Json(forbidden);
    }
    let result = persistence::document_loaded(
        canvas_mounts(),
        &req.project_id,
        req.mount_seq,
        req.ack.as_deref(),
    );
    body("document loaded", &req.project_id, result)
}

async fn dirty_changed(
    State(state): State<CanvasState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<DirtyRequest>,
) -> Json<IpcBody<DirtyOutcome>> {
    if let Some(forbidden) = check_canvas_write(&state, peer, "/canvas/dirty-changed") {
        return Json(forbidden);
    }
    let result = persistence::dirty_changed(
        canvas_mounts(),
        &req.project_id,
        req.mount_seq,
        req.dirty,
        &req.content_version,
    )
    .await;
    body("dirty changed", &req.project_id, result)
}

async fn write_snapshot(
    State(state): State<CanvasState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<SnapshotRequest>,
) -> Json<IpcBody<WriteOutcome>> {
    if let Some(forbidden) = check_canvas_write(&state, peer, "/canvas/write-snapshot") {
        return Json(forbidden);
    }
    let result = persistence::write_snapshot(
        canvas_mounts(),
        &req.project_id,
        req.mount_seq,
        &req.snapshot,
    )
    .await;
    if let Ok(outcome) = &result {
        let project_id = crate::commands::sanitize_log_field(&req.project_id);
        match (&outcome.mark_saved, &outcome.view.save_error) {
            (Some(version), _) => tracing::info!(
                target: "termul::web::canvas",
                "canvas saved project_id={project_id} content_version={version}"
            ),
            (None, Some(error)) => tracing::warn!(
                target: "termul::web::canvas",
                "canvas save failed project_id={project_id}: {error}"
            ),
            (None, None) => {}
        }
    }
    body("write snapshot", &req.project_id, result)
}
