//! Canvas web routes: `POST /canvas/open` / `/canvas/close` (`IpcBody`
//! envelope, HTTP 200 for app-level failures like their Tauri command twins),
//! the persistence routes of `canvas_persistence_api`, and the same-origin
//! `/canvas/<id>/*` figcraft bundle.
//!
//! Registered AHEAD of the static fallback, so the SPA mount cannot shadow
//! any of it. Doc paths on `/canvas/open` must lie inside the opening
//! project's own registered root (`canvas::doc_path`).
//! Auth split (browser iframes cannot send `Authorization: Bearer` headers):
//! - the API routes stay behind the outer bearer `web_auth_gate`
//!   (`"/canvas/"` in `GATED_PREFIXES` — the renderer facades already hold
//!   the web auth token);
//! - `/canvas/<id>/*` (the bundle) is EXEMPT from the bearer gate
//!   (`canvas::bundle_path::is_bundle_path`) and authenticated by
//!   `static_server::serve_bundle`: the token segment of
//!   `/canvas/<id>/<token>/` must constant-time-match the token minted by
//!   the project's open.
//!
//! `POST /canvas/open` mounts the figcraft editor: it mints the project's
//! bundle token (`static_server::open_canvas`) and `/canvas/<id>/*` then
//! serves the embedded bundle. `POST /canvas/close` revokes the token, so
//! stale iframe URLs stop authenticating.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{ConnectInfo, Request, State};
use axum::response::{Json, Response};
use axum::routing::{any, get, post};
use axum::Router;
use serde::Deserialize;

use crate::canvas::doc_path::resolve_doc_path;
use crate::canvas::persistence::CloseOutcome;
use crate::canvas::static_server::{
    close_canvas, open_canvas, same_origin_base, serve_bundle, CanvasOpenInfo, OpenRequest,
};
use crate::web::capabilities::WriteFlags;
use crate::web::fs_api::{check_local_only, IpcBody};
use crate::web::project_registry::ProjectRegistry;

/// Router state: the project-root boundary for doc-path validation (`None`
/// in test compositions skips validation) and the deployment's write flags.
#[derive(Clone)]
pub struct CanvasState {
    pub boundary: Option<CanvasProjectBoundary>,
    /// Deployment flags for the shared write predicate: `/canvas/open` and
    /// `/canvas/close` write the document, so they are write routes like the
    /// fs/git ones.
    pub write_flags: WriteFlags,
}

/// Project-root boundary for the web doc-path validation on open: the path
/// is accepted when it is within the opening project's registered,
/// non-archived root (`canvas::doc_path`).
#[derive(Clone)]
pub struct CanvasProjectBoundary {
    pub registry: Arc<ProjectRegistry>,
}

/// The shared write predicate for the canvas open/close routes.
pub(crate) fn check_canvas_write<T>(
    state: &CanvasState,
    peer: SocketAddr,
    route: &str,
) -> Option<IpcBody<T>> {
    check_local_only::<T>(
        peer,
        state.write_flags.allow_remote_writes,
        state.write_flags.shared_live_writes_denied,
        route,
    )
}

/// `POST /canvas/open` body: `{ "docPath": "...", "projectId": "...",
/// "clientInstanceId": "...", "autosaveMs"?: n, "autosaveMaxMs"?: n, "leaseGraceMs"?: n,
/// "maxMounted"?: n, "crashTimeouts"?: n }`.
#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CanvasOpenRequest {
    doc_path: String,
    project_id: String,
    #[serde(flatten)]
    request: OpenRequest,
}

/// `POST /canvas/close` body: `{ "projectId": "...", "mountSeq": n,
/// "discard"?: bool }`.
#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CanvasCloseRequest {
    project_id: String,
    mount_seq: u64,
    #[serde(default)]
    discard: Option<bool>,
}

/// Build the canvas sub-router with its state APPLIED — generic over the
/// caller's outer router state so it merges into both `router()` and
/// `router_with_static()` like any stateless router.
pub fn canvas_router<S>(state: CanvasState) -> Router<S> {
    Router::new()
        .route("/canvas/open", post(open))
        .route("/canvas/close", post(close))
        .merge(crate::web::canvas_persistence_api::persistence_routes())
        // The iframe src is `/canvas/<id>/<token>/` (the trailing slash keeps
        // the bundle's relative asset URLs, token included, inside the
        // prefix). The shorter forms are registered so they answer 401
        // rather than fall through to the SPA.
        .route("/canvas/{id}", get(bundle))
        .route("/canvas/{id}/", get(bundle))
        .route("/canvas/{id}/{*rest}", any(bundle))
        .with_state(state)
}

/// `/canvas/<id>/<token>[/...]` — the figcraft bundle, gated by the
/// canvas's token.
async fn bundle(request: Request) -> Response {
    serve_bundle(request.method(), request.uri(), request.headers())
}

/// `POST /canvas/open` — validate the doc path against the project's root,
/// then return the same-origin bundle base plus the project's minted canvas
/// token (the twin of the `canvas_open` Tauri command).
async fn open(
    State(state): State<CanvasState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<CanvasOpenRequest>,
) -> Json<IpcBody<CanvasOpenInfo>> {
    if let Some(forbidden) = check_canvas_write(&state, peer, "/canvas/open") {
        return Json(forbidden);
    }
    let log_project_id = crate::commands::sanitize_log_field(&req.project_id);
    let registry = state
        .boundary
        .as_ref()
        .map(|boundary| boundary.registry.as_ref());
    let doc_key = match resolve_doc_path(&req.doc_path, &req.project_id, registry) {
        Ok(path) => path,
        Err(err) => {
            tracing::warn!(
                target: "termul::web::canvas",
                "canvas open rejected project_id={log_project_id}: {}",
                err.message
            );
            return Json(IpcBody::err(err.message, err.code));
        }
    };
    match open_canvas(same_origin_base(), &req.project_id, doc_key, req.request).await {
        Ok(info) => {
            tracing::info!(
                target: "termul::web::canvas",
                "canvas open (web) project_id={log_project_id} canvas_id={}",
                info.canvas_id
            );
            Json(IpcBody::ok(info))
        }
        Err(err) => {
            tracing::warn!(
                target: "termul::web::canvas",
                "canvas open failed project_id={log_project_id} code={}",
                err.code
            );
            Json(IpcBody::err(err.message, err.code))
        }
    }
}

/// `POST /canvas/close` — unmount this tab's mount `mountSeq` through the
/// AD-31 sequence (`static_server::close_canvas`, shared with
/// `canvas_close`); a mount a newer open replaced is left alone. A
/// failed save answers `SAVE_FAILED` and keeps the mount; `discard: true` is
/// the user's explicit choice to drop unsaved changes. Idempotent.
async fn close(
    State(state): State<CanvasState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<CanvasCloseRequest>,
) -> Json<IpcBody<CloseOutcome>> {
    if let Some(forbidden) = check_canvas_write(&state, peer, "/canvas/close") {
        return Json(forbidden);
    }
    let mode = crate::commands::close_mode(req.discard);
    let project_id = crate::commands::sanitize_log_field(&req.project_id);
    tracing::info!(
        target: "termul::web::canvas",
        "canvas close (web) project_id={project_id} mount_seq={} mode={mode:?}",
        req.mount_seq
    );
    match close_canvas(&req.project_id, req.mount_seq, mode).await {
        Ok(outcome) => {
            if outcome.discarded {
                tracing::warn!(
                    target: "termul::web::canvas",
                    "canvas closed project_id={project_id}: unsaved changes discarded by the user"
                );
            } else {
                tracing::info!(
                    target: "termul::web::canvas",
                    "canvas closed project_id={project_id} unmounted={} saved={}",
                    outcome.unmounted,
                    outcome.saved_version.as_deref().unwrap_or("none")
                );
            }
            Json(IpcBody::ok(outcome))
        }
        Err(err) => {
            tracing::warn!(
                target: "termul::web::canvas",
                "canvas close refused project_id={project_id} code={}: {}",
                err.code,
                err.message
            );
            Json(IpcBody::err(err.message, err.code))
        }
    }
}
