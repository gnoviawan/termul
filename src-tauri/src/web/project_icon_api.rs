//! `POST /project/icon` — web-parity route for `project_icon_resolve`.
//!
//! Read-route posture (mirrors `git_api::get_commit_context`): `resolve_cwd`
//! canonicalizes the request cwd, rejects `..`, and enforces the project-root
//! boundary (`ensure_within_project_boundary` — the registered-project
//! boundary covers any project the client switched to). No `check_local_only`
//! — like the other `/git/*` read routes, LAN peers may resolve icons for
//! in-boundary projects (the remote fetch itself is guarded: https-only,
//! bounded redirects/size, `image/*` MIME, refused local hosts).
//!
//! Reply is `IpcBody<Option<ProjectIcon>>`: `{success:true, data:{…}|null}`.
//! `None` means "render the monogram" — every resolver failure is
//! best-effort and already logged inside `crate::project_icon`.

use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;

use crate::project_icon::ProjectIcon;
use crate::web::fs_api::IpcBody;
use crate::web::git_api::resolve_cwd;
use crate::web::ws::AppState;

#[derive(Debug, Deserialize)]
pub struct ProjectIconRequest {
    pub cwd: String,
}

pub async fn resolve_icon(
    State(state): State<AppState>,
    Json(req): Json<ProjectIconRequest>,
) -> impl IntoResponse {
    let resolved = match resolve_cwd::<Option<ProjectIcon>>(&req.cwd, &state, None, false) {
        Ok(path) => path,
        Err(resp) => return resp,
    };
    (
        StatusCode::OK,
        Json(IpcBody::ok(crate::project_icon::resolve(resolved).await)),
    )
}
