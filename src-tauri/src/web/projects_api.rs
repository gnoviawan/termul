//! HTTP handlers for the project registry: `GET /projects` and the project
//! commands (`POST /projects`, `PUT /projects/{id}`, `DELETE /projects/{id}`,
//! `POST /projects/default`).
//!
//! Reads come from the host's durable [`ProjectRegistry`]; every mutation goes
//! through the shared command service (`web::project_registry::commands`), the
//! same one the `/ws` requests and the desktop use. The body mirrors the
//! `IpcResult<T>` contract over HTTP (HTTP 200 for both success AND app-level
//! failures — matching the other web routes), so the renderer's
//! `webServerProjects.list()` (which maps non-2xx → `NETWORK_ERROR`) sees
//! success/failure in the body, not the status code. A `PROJECT_BUSY` refusal
//! carries the bound sessions/terminals in `details`.
//!
//! Carries NO env-var values — [`ProjectSummary`] redacts-by-omission (frozen
//! constraint). Only the identity/display fields a project switcher needs.

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, Query, State};
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::web::fs_api::check_local_only;
use crate::web::project_registry::{
    set_default_project as set_registry_default, AddProject, ProjectCommandError, ProjectHost,
    ProjectListPayload, ProjectSummary, UpdateProject,
};
use crate::web::ws::AppState;

/// HTTP response body mirroring the renderer-side `IpcResult<T>` shape. Kept
/// local (mirrors `fs_api::IpcBody`) so this module stays self-contained.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IpcBody<T> {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// Structured context for `code` (additive): a `PROJECT_BUSY` refusal lists
    /// `{"sessions":[sessionId…],"terminals":[terminalId…]}`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl<T> IpcBody<T> {
    fn ok(data: T) -> Self {
        Self {
            success: true,
            data: Some(data),
            error: None,
            code: None,
            details: None,
        }
    }

    fn err(error: impl Into<String>, code: impl Into<String>) -> Self {
        Self {
            success: false,
            data: None,
            error: Some(error.into()),
            code: Some(code.into()),
            details: None,
        }
    }

    /// A refused project command: its message, HTTP code and `details`.
    fn refused(error: &ProjectCommandError) -> Self {
        Self {
            details: error.details(),
            ..Self::err(error.message(), error.http_code())
        }
    }
}

/// `POST /projects/default` request body — the explicit host-default change
/// (Epic 7). Mirrors the `set_default_project` WS request payload + the
/// `set_host_default_project` Tauri command argument.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetDefaultProjectRequest {
    pub project_id: String,
}

/// `POST /projects` request body — register a project. `id` is client-minted;
/// the host canonicalizes + validates the path. Mirrors the `add_project` WS
/// request payload.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertProjectRequest {
    pub id: String,
    pub name: String,
    pub path: String,
    pub color: String,
    #[serde(default)]
    pub is_archived: bool,
}

/// `PUT /projects/{id}` request body — patch a project's display fields and
/// archive/restore it (`isArchived`). All fields optional (partial update).
/// `cascade: true` lets an archive stop the project's live sessions and
/// terminals instead of being refused `PROJECT_BUSY`. Mirrors the
/// `update_project` WS request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProjectRequest {
    pub name: Option<String>,
    pub color: Option<String>,
    pub is_archived: Option<bool>,
    #[serde(default)]
    pub cascade: bool,
}

/// `DELETE /projects/{id}` query — `?cascade=true` stops the project's live
/// sessions and terminals instead of refusing `PROJECT_BUSY`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveProjectQuery {
    #[serde(default)]
    pub cascade: bool,
}

/// `GET /projects` → the host's project list.
///
/// Snapshots the registry (a short clone under the lock) and returns it. An
/// empty list is a valid success (no project registered yet) — the web client
/// renders an empty sidebar, NOT an error.
pub async fn list(State(state): State<AppState>) -> impl IntoResponse {
    let payload: ProjectListPayload = state.registry.snapshot();
    Json(IpcBody::ok(payload))
}

/// The command service over this request's host pieces.
fn project_host(state: &AppState) -> ProjectHost<'_> {
    ProjectHost {
        registry: &state.registry,
        acp: &state.acp,
        pty: &state.pty,
        relay: &state.relay,
    }
}

/// Write guard shared by the project mutation routes: the shared predicate
/// (`fs_api::check_local_only`) wrapped in this module's `Json` response.
fn check_project_write_guard<T>(
    state: &AppState,
    peer: SocketAddr,
    route: &str,
) -> Option<Json<IpcBody<T>>> {
    check_local_only::<T>(
        peer,
        state.allow_remote_writes,
        state.shared_live_writes_denied,
        route,
    )
    .map(|refused| {
        Json(IpcBody::<T>::err(
            refused.error.unwrap_or_default(),
            refused.code.unwrap_or_default(),
        ))
    })
}

/// `POST /projects/default` → set the host's default project (Epic 7).
///
/// Validates the target is switchable (unknown/archived/pathless → `NOT_FOUND`),
/// persists, and notifies every connected client. Mirrors the
/// `set_default_project` WS request + the `set_host_default_project` Tauri
/// command (transport parity).
///
/// # Malformed body (P14)
///
/// Axum's `Json` extractor returns HTTP 422 (Unprocessable Entity) for a
/// malformed JSON body BEFORE this handler runs — so a `VALIDATION_ERROR`
/// code in the body is never produced. The 422 response is a transport-level
/// rejection, not an `IpcBody` success/failure. Clients map non-2xx →
/// `NETWORK_ERROR` (per `webServerProjects.setDefaultProject`).
///
/// Body: `{ "projectId": "<id>" }`.
pub async fn set_default_project(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<SetDefaultProjectRequest>,
) -> impl IntoResponse {
    // This route mutates host state and notifies ALL connected clients: the
    // shared write predicate guards it like every other host-state write
    // (CWE-306).
    if let Some(err) = check_project_write_guard(&state, peer, "/projects/default") {
        return err;
    }
    match set_registry_default(&state.registry, &state.relay, &req.project_id) {
        Ok(()) => Json(IpcBody::ok(())),
        Err(error) => Json(IpcBody::refused(&error)),
    }
}

/// `POST /projects` → register a project (idempotent by `id`). Returns the
/// stored `ProjectSummary`.
pub async fn create_project(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<UpsertProjectRequest>,
) -> impl IntoResponse {
    if let Some(err) = check_project_write_guard(&state, peer, "/projects") {
        return err;
    }
    let added = project_host(&state)
        .add(AddProject {
            id: req.id,
            name: req.name,
            path: req.path,
            color: req.color,
            is_archived: req.is_archived,
        })
        .await;
    match added {
        Ok(project) => Json(IpcBody::<ProjectSummary>::ok(project)),
        Err(error) => Json(IpcBody::refused(&error)),
    }
}

/// `PUT /projects/{id}` → patch a project's display fields / archive state.
pub async fn update_project(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    axum::extract::Path(project_id): axum::extract::Path<String>,
    Json(req): Json<UpdateProjectRequest>,
) -> impl IntoResponse {
    if let Some(err) = check_project_write_guard(&state, peer, "/projects/{id}") {
        return err;
    }
    let updated = project_host(&state)
        .update(UpdateProject {
            project_id,
            name: req.name,
            color: req.color,
            is_archived: req.is_archived,
            cascade: req.cascade,
        })
        .await;
    match updated {
        Ok(()) => Json(IpcBody::ok(())),
        Err(error) => Json(IpcBody::refused(&error)),
    }
}

/// `DELETE /projects/{id}` → remove a project (an absent id is ok).
pub async fn remove_project(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    axum::extract::Path(project_id): axum::extract::Path<String>,
    Query(query): Query<RemoveProjectQuery>,
) -> impl IntoResponse {
    if let Some(err) = check_project_write_guard(&state, peer, "/projects/{id}") {
        return err;
    }
    match project_host(&state).remove(&project_id, query.cascade).await {
        Ok(()) => Json(IpcBody::ok(())),
        Err(error) => Json(IpcBody::refused(&error)),
    }
}
#[cfg(test)]
mod tests;
