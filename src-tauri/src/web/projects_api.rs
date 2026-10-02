//! HTTP handler for `GET /projects` — the web/remote project-list mirror.
//!
//! Returns the desktop's non-archived + archived project summaries from the
//! in-memory [`ProjectRegistry`] (Epic-4 bridge). The renderer syncs the
//! registry via the `remote_sync_projects` Tauri command; the browser reads it
//! here. The body mirrors the `IpcResult<T>` contract over HTTP (HTTP 200 for
//! both success AND app-level failures — matching the other web routes), so the
//! renderer's `webServerProjects.list()` (which maps non-2xx → `NETWORK_ERROR`)
//! sees success/failure in the body, not the status code.
//!
//! Carries NO env-var values — [`ProjectSummary`] redacts-by-omission (frozen
//! constraint). Only the identity/display fields a project switcher needs.

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, State};
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::web::project_registry::ProjectListPayload;
use crate::web::sink::broadcast_projects_changed;
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
}

impl<T> IpcBody<T> {
    fn ok(data: T) -> Self {
        Self {
            success: true,
            data: Some(data),
            error: None,
            code: None,
        }
    }

    fn err(error: impl Into<String>, code: impl Into<String>) -> Self {
        Self {
            success: false,
            data: None,
            error: Some(error.into()),
            code: Some(code.into()),
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
/// `POST /projects` request body — create / upsert a VFS root (Option B: the
/// standalone server is a first-class project-list authority). The operator /
/// web client supplies the identity + display fields + canonical path; the
/// server canonicalizes + validates the path. Mirrors the
/// `add_project` WS request payload.
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

/// `PUT /projects/{id}` request body — patch a root's display fields. All
/// fields optional (partial update). Mirrors the `update_project` WS request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProjectRequest {
    pub name: Option<String>,
    pub color: Option<String>,
    pub is_archived: Option<bool>,
}

/// `GET /projects` → the synced project list mirror.
///
/// Snapshots the registry (a short clone under the lock) and returns it. An
/// empty list is a valid success (the desktop hasn't synced yet, or the
/// standalone binary has no renderer source) — the web client renders an empty
/// sidebar, NOT an error. The registry is the source; if it is empty the
/// browser just shows nothing (the desktop will push a `projects_changed`
/// event when it syncs).
pub async fn list(State(state): State<AppState>) -> impl IntoResponse {
    let payload: ProjectListPayload = state.registry.snapshot();
    Json(IpcBody::ok(payload))
}

/// `POST /projects/default` → set the host's default project (Epic 7).
///
/// Validates the target is switchable (unknown/archived/pathless → `NOT_FOUND`),
/// updates `registry.set_default_project`, persists to `FileProjectRegistry`
/// (VPS only, with rollback on failure), and broadcasts `projects_changed`
/// carrying the new `defaultProjectId` to ALL connected clients. Mirrors the
/// `set_default_project` WS request + the `set_host_default_project` Tauri
/// command (transport parity). Desktop-hosted mode has no file registry — it
/// updates the in-memory registry + broadcasts only.
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
    // Loopback-only guard — this route mutates host state (persists the default
    // to `FileProjectRegistry` and broadcasts `projects_changed` to ALL
    // connected clients), so a LAN peer on a `0.0.0.0` bind must not reach it.
    // Mirrors the fs/git/workspace write routes' `check_local_only` (CWE-306).
    let is_loopback = peer.ip().is_loopback();
    // Deployment-mode deny FIRST: shared-live (cloudflared tunnel) cannot
    // distinguish forwarded public traffic from genuine local callers, so
    // refuse all host-state writes on this path before peer/flag evaluation.
    if state.shared_live_writes_denied {
        tracing::warn!(
            target: "termul::web::projects_api",
            route = "/projects/default",
            peer = %peer,
            "remote-write guard REFUSED (shared-live deployment mode denies all writes)",
        );
        return Json(IpcBody::<()>::err(
            "shared-live deployment mode denies all remote writes".to_string(),
            "FORBIDDEN",
        ));
    }
    if !is_loopback && !state.allow_remote_writes {
        tracing::warn!(
            target: "termul::web::projects_api",
            route = "/projects/default",
            peer = %peer,
            "remote-write guard REFUSED (peer not loopback; no --allow-remote-writes)",
        );
        return Json(IpcBody::<()>::err(
            format!("host-state write routes are localhost-only (peer {peer} is not loopback)"),
            "FORBIDDEN",
        ));
    }
    if !is_loopback && state.allow_remote_writes {
        tracing::warn!(
            target: "termul::web::projects_api",
            route = "/projects/default",
            peer = %peer,
            "remote-write guard ADMITTED (--allow-remote-writes)",
        );
    }
    let project_id = req.project_id;
    // Validate via switch_context (same path as `switch_project`).
    if state.registry.switch_context(&project_id).is_none() {
        tracing::warn!(
            target: "termul::web::projects_api",
            project_id = %project_id,
            "set_default_project: project not found or not switchable"
        );
        return Json(IpcBody::<()>::err(
            format!("project '{project_id}' not found or not switchable"),
            "NOT_FOUND",
        ));
    }
    // VPS persistence (with rollback). Desktop-hosted: registry_persistence is None.
    // The old default is captured so the in-memory-set failure path below can
    // roll the file back (P1: no split-brain — if `registry.set_default_project`
    // returns false after the file was already persisted, the file is restored
    // + re-saved before returning the error).
    let mut persisted_old_default: Option<Option<String>> = None;
    if let (Some(file_registry), Some(path)) = (
        state.registry_persistence.as_ref(),
        state.projects_file.as_deref(),
    ) {
        let persistence_result = {
            let mut file_registry = file_registry.lock();
            let old_default = file_registry.default_project_id().map(str::to_string);
            match file_registry.set_default_project(&project_id) {
                Ok(()) => match file_registry.save_atomic(path) {
                    Ok(()) => {
                        persisted_old_default = Some(old_default);
                        Ok(())
                    }
                    Err(error) => {
                        file_registry.restore_default_project(old_default);
                        Err(error)
                    }
                },
                Err(error) => Err(error),
            }
        };
        if let Err(error) = persistence_result {
            tracing::error!(
                target: "termul::web::projects_api",
                project_id = %project_id,
                error = %error,
                "set_default_project: persistence failed (rolled back)"
            );
            return Json(IpcBody::<()>::err(
                format!("failed to persist default project: {error}"),
                "PERSIST_FAILED",
            ));
        }
    }
    // Update the in-memory registry default + broadcast.
    // If the in-memory set fails (target vanished between validation and
    // commit), roll back the file registry (P1: no split-brain).
    if !state.registry.set_default_project(&project_id) {
        if let (Some(file_registry), Some(path), Some(old_default)) = (
            state.registry_persistence.as_ref(),
            state.projects_file.as_deref(),
            persisted_old_default,
        ) {
            let mut file_registry = file_registry.lock();
            file_registry.restore_default_project(old_default);
            if let Err(error) = file_registry.save_atomic(path) {
                tracing::warn!(
                    target: "termul::web::projects_api",
                    error = %error,
                    "set_default_project: failed to persist in-memory-set rollback"
                );
            }
        }
        tracing::warn!(
            target: "termul::web::projects_api",
            project_id = %project_id,
            "set_default_project: target became unavailable before commit (file rolled back)"
        );
        return Json(IpcBody::<()>::err(
            "target project became unavailable before commit".to_string(),
            "NOT_FOUND",
        ));
    }
    broadcast_projects_changed(&state.relay, Some(&project_id));
    tracing::info!(
        target: "termul::web::projects_api",
        project_id = %project_id,
        "set_default_project: host default updated + broadcast"
    );
    Json(IpcBody::ok(()))
}

/// Loopback / `--allow-remote-writes` guard shared by the project mutation
/// routes. Mirrors `set_default_project`'s write-guard posture (CWE-306):
/// shared-live deployment mode denies ALL writes; otherwise loopback is
/// admitted, and a non-loopback peer requires `--allow-remote-writes`. Returns
/// `Some(error_response)` when the peer is refused.
fn check_project_write_guard<T>(
    state: &AppState,
    peer: SocketAddr,
    route: &str,
) -> Option<Json<IpcBody<T>>> {
    let is_loopback = peer.ip().is_loopback();
    if state.shared_live_writes_denied {
        tracing::warn!(
            target: "termul::web::projects_api",
            route,
            peer = %peer,
            "remote-write guard REFUSED (shared-live deployment mode denies all writes)",
        );
        return Some(Json(IpcBody::<T>::err(
            "shared-live deployment mode denies all remote writes".to_string(),
            "FORBIDDEN",
        )));
    }
    if !is_loopback && !state.allow_remote_writes {
        tracing::warn!(
            target: "termul::web::projects_api",
            route,
            peer = %peer,
            "remote-write guard REFUSED (peer not loopback; no --allow-remote-writes)",
        );
        return Some(Json(IpcBody::<T>::err(
            format!("host-state write routes are localhost-only (peer {peer} is not loopback)"),
            "FORBIDDEN",
        )));
    }
    if !is_loopback && state.allow_remote_writes {
        tracing::warn!(
            target: "termul::web::projects_api",
            route,
            peer = %peer,
            "remote-write guard ADMITTED (--allow-remote-writes)",
        );
    }
    None
}

/// `POST /projects` → create / upsert a VFS root (Option B).
///
/// Canonicalizes + validates the path, upserts into `FileProjectRegistry`
/// (VPS, with rollback on failure) + the in-memory `ProjectRegistry`, and
/// broadcasts `projects_changed`. Desktop-hosted mode has no file registry —
/// it upserts the in-memory mirror + broadcasts only (the desktop renderer
/// is the source of truth there, but a web-client upsert still lands in the
/// mirror so the creating client sees it). Returns the upserted
/// `ProjectSummary`.
pub async fn create_project(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<UpsertProjectRequest>,
) -> impl IntoResponse {
    if let Some(err) = check_project_write_guard(&state, peer, "/projects") {
        return err;
    }
    // F-020: preserve the existing root's MCP config — an upsert that
    // re-registers a project must not wipe its file-side `mcp_servers`.
    let preserved_mcp = state
        .registry_persistence
        .as_ref()
        .map(|file_registry| {
            file_registry
                .lock()
                .roots()
                .iter()
                .find(|r| r.id == req.id)
                .map(|r| r.mcp_servers.clone())
                .unwrap_or_default()
        })
        .unwrap_or_default();
    let root = crate::acp::VfsRoot {
        id: req.id.clone(),
        name: req.name.clone(),
        path: std::path::PathBuf::from(req.path.clone()),
        color: req.color.clone(),
        is_archived: req.is_archived,
        mcp_servers: preserved_mcp,
    };
    // VPS persistence (with rollback). Desktop-hosted: registry_persistence is None.
    if let (Some(file_registry), Some(path)) = (
        state.registry_persistence.as_ref(),
        state.projects_file.as_deref(),
    ) {
        let persistence_result = {
            let mut file_registry = file_registry.lock();
            // Capture the old root (if replacing) so the in-memory-set failure
            // path can roll the file back (P1: no split-brain).
            let old_root = file_registry
                .roots()
                .iter()
                .find(|r| r.id == req.id)
                .cloned();
            match file_registry.upsert_root(root.clone()) {
                Ok(()) => match file_registry.save_atomic(path) {
                    Ok(()) => Ok((old_root, ())),
                    Err(error) => {
                        // Roll back to the old root (or remove if it was new).
                        if let Some(old) = old_root {
                            let _ = file_registry.upsert_root(old);
                        } else {
                            let _ = file_registry.remove_root(&req.id);
                        }
                        Err(error)
                    }
                },
                Err(error) => Err(error),
            }
        };
        if let Err(error) = persistence_result {
            tracing::error!(
                target: "termul::web::projects_api",
                project_id = %req.id,
                error = %error,
                "create_project: persistence failed (rolled back)"
            );
            return Json(
                IpcBody::<crate::web::project_registry::ProjectSummary>::err(
                    format!("failed to persist project: {error}"),
                    "PERSIST_FAILED",
                ),
            );
        }
    } else {
        // Desktop-hosted / no file registry: validate the path canonicalizes
        // before mirroring (fail-first, same posture as VPS `upsert_root`).
        if let Err(reason) =
            crate::acp::project_registry::validate_root_path_pub(std::path::Path::new(&req.path))
        {
            tracing::warn!(
                target: "termul::web::projects_api",
                project_id = %req.id,
                "create_project: invalid root path"
            );
            return Json(
                IpcBody::<crate::web::project_registry::ProjectSummary>::err(
                    format!("invalid root path: {reason}"),
                    "VALIDATION_ERROR",
                ),
            );
        }
    }
    // Mirror into the in-memory registry. F-020: `is_default` reflects the
    // CURRENT default (an upsert of the default project keeps its flag; an
    // archived default is cleared by `upsert` itself — P4). `upsert`
    // recomputes the flag internally regardless of what is passed here.
    let summary = crate::web::project_registry::ProjectSummary {
        id: req.id.clone(),
        name: req.name,
        color: req.color,
        path: Some(req.path),
        is_archived: req.is_archived,
        is_default: !req.is_archived
            && state.registry.snapshot().default_project_id.as_deref() == Some(req.id.as_str()),
    };
    state.registry.upsert(summary.clone());
    broadcast_projects_changed(&state.relay, None);
    tracing::info!(
        target: "termul::web::projects_api",
        project_id = %req.id,
        "create_project: project upserted + broadcast"
    );
    Json(IpcBody::<crate::web::project_registry::ProjectSummary> {
        success: true,
        data: Some(summary),
        error: None,
        code: None,
    })
}

/// `PUT /projects/{id}` → patch a project's display fields (Option B).
pub async fn update_project(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    axum::extract::Path(project_id): axum::extract::Path<String>,
    Json(req): Json<UpdateProjectRequest>,
) -> impl IntoResponse {
    if let Some(err) = check_project_write_guard(&state, peer, "/projects/{id}") {
        return err;
    }
    // VPS persistence (with rollback).
    if let (Some(file_registry), Some(path)) = (
        state.registry_persistence.as_ref(),
        state.projects_file.as_deref(),
    ) {
        let persistence_result = {
            let mut file_registry = file_registry.lock();
            let old_root = file_registry
                .roots()
                .iter()
                .find(|r| r.id == project_id)
                .cloned();
            if !file_registry.update_root(
                &project_id,
                req.name.clone(),
                req.color.clone(),
                req.is_archived,
            ) {
                None
            } else {
                match file_registry.save_atomic(path) {
                    Ok(()) => Some(Ok((old_root, ()))),
                    Err(error) => {
                        if let Some(old) = old_root {
                            let _ = file_registry.upsert_root(old);
                        }
                        Some(Err(error))
                    }
                }
            }
        };
        match persistence_result {
            None => {
                tracing::warn!(
                    target: "termul::web::projects_api",
                    project_id = %project_id,
                    "update_project: project not found"
                );
                return Json(IpcBody::<()>::err(
                    format!("project '{project_id}' not found"),
                    "NOT_FOUND",
                ));
            }
            Some(Err(error)) => {
                tracing::error!(
                    target: "termul::web::projects_api",
                    project_id = %project_id,
                    error = %error,
                    "update_project: persistence failed (rolled back)"
                );
                return Json(IpcBody::<()>::err(
                    format!("failed to persist project: {error}"),
                    "PERSIST_FAILED",
                ));
            }
            Some(Ok(_)) => {}
        }
    }
    // Mirror into the in-memory registry.
    if !state
        .registry
        .update(&project_id, req.name, req.color, req.is_archived)
    {
        tracing::warn!(
            target: "termul::web::projects_api",
            project_id = %project_id,
            "update_project: project not found in in-memory registry"
        );
        return Json(IpcBody::<()>::err(
            format!("project '{project_id}' not found"),
            "NOT_FOUND",
        ));
    }
    broadcast_projects_changed(&state.relay, None);
    tracing::info!(
        target: "termul::web::projects_api",
        project_id = %project_id,
        "update_project: project updated + broadcast"
    );
    Json(IpcBody::ok(()))
}

/// `DELETE /projects/{id}` → remove a VFS root (Option B).
pub async fn remove_project(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    axum::extract::Path(project_id): axum::extract::Path<String>,
) -> impl IntoResponse {
    if let Some(err) = check_project_write_guard(&state, peer, "/projects/{id}") {
        return err;
    }
    // VPS persistence (with rollback).
    if let (Some(file_registry), Some(path)) = (
        state.registry_persistence.as_ref(),
        state.projects_file.as_deref(),
    ) {
        let persistence_result = {
            let mut file_registry = file_registry.lock();
            let old_root = file_registry
                .roots()
                .iter()
                .find(|r| r.id == project_id)
                .cloned();
            if !file_registry.remove_root(&project_id) {
                None
            } else {
                match file_registry.save_atomic(path) {
                    Ok(()) => Some(Ok(old_root)),
                    Err(error) => {
                        if let Some(old) = old_root {
                            let _ = file_registry.upsert_root(old);
                        }
                        Some(Err(error))
                    }
                }
            }
        };
        match persistence_result {
            None => {
                tracing::warn!(
                    target: "termul::web::projects_api",
                    project_id = %project_id,
                    "remove_project: project not found"
                );
                return Json(IpcBody::<()>::err(
                    format!("project '{project_id}' not found"),
                    "NOT_FOUND",
                ));
            }
            Some(Err(error)) => {
                tracing::error!(
                    target: "termul::web::projects_api",
                    project_id = %project_id,
                    error = %error,
                    "remove_project: persistence failed (rolled back)"
                );
                return Json(IpcBody::<()>::err(
                    format!("failed to persist project removal: {error}"),
                    "PERSIST_FAILED",
                ));
            }
            Some(Ok(_)) => {}
        }
    }
    // Mirror into the in-memory registry.
    state.registry.remove(&project_id);
    broadcast_projects_changed(&state.relay, None);
    tracing::info!(
        target: "termul::web::projects_api",
        project_id = %project_id,
        "remove_project: project removed + broadcast"
    );
    Json(IpcBody::ok(()))
}
#[cfg(test)]
mod tests;
