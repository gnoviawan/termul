//! HTTP handlers for the host-owned versioned workspace manifest (CAP-5).
//!
//! Mirrors the desktop `#[tauri::command] workspace_manifest_*` handlers over
//! HTTP so the web/remote client can load/write/delete a project's workspace
//! manifest through the same `IpcBody<T>` contract. Story 5 ships the schema,
//! persistence API, parity surfaces, and exclusion enforcement; Story 6 wires
//! the renderer to read/write/conflict-render through this contract.
//!
//! - **`GET /workspace/:projectId`** — load (returns `IpcBody::ok(None)` when
//!   no manifest exists — a workspace reload starts fresh; the success path).
//! - **`POST /workspace/:projectId/write`** — revision-checked write. Body:
//!   `{ basedRevision: number | null, manifest: WorkspaceManifest }`. Returns
//!   `IpcBody::ok(WriteOutcome)` — conflict is a SUCCESS body variant
//!   (`status: 'conflict'`), NOT an error code.
//! - **`POST /workspace/:projectId/delete`** — idempotent delete; returns
//!   `IpcBody::ok(())`.
//!
//! Write + delete are loopback-only (mirrors `log_api::frontend_error` /
//! `git_api::*`'s `ConnectInfo` guard) so a LAN client cannot mutate the
//! host's manifest store. Load is open (read-only parity with
//! `GET /projects`).
//!
//! Exclusion enforcement: `#[serde(deny_unknown_fields)]` on the manifest +
//! each descriptor struct rejects an over-serialized payload (`envVars`, raw
//! `claim`, `fullscreenPaneId`, …) loudly at the host boundary. The `write`
//! handler manually deserializes the body (via `axum::body::Bytes` + `serde_json::from_slice`)
//! so the `deny_unknown_fields` rejection is caught and mapped to a 200 +
//! `IpcBody::err(VALIDATION_ERROR)` — NOT a 4xx (Patch 1: the IpcBody contract
//! uses 200 for both success and app-level failure so the renderer maps the
//! `VALIDATION_ERROR` code, not a transport `NETWORK_ERROR`).

use std::net::SocketAddr;

use axum::{
    body::Bytes,
    extract::{ConnectInfo, Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use tracing::{debug, warn};

use crate::acp::{WorkspaceManifest, WriteOutcome};
use crate::web::fs_api::IpcBody;
use crate::web::ws::AppState;

/// `POST /workspace/:projectId/write` body. The `manifest` field carries the
/// full portable manifest; `basedRevision` is `null` for the initial write
/// (no prior revision) or the on-disk `revision` for a subsequent write.
///
/// Patch 6: `deny_unknown_fields` rejects an extra top-level field loudly so
/// an over-serialized `{ basedRevision, manifest, debug: true }` envelope
/// surfaces as `VALIDATION_ERROR` (not silently dropped).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteRequest {
    /// Caller's last-known revision. `null` = "no prior revision, treat as
    /// initial write". The host compares against the on-disk `revision` and
    /// returns `WriteOutcome::Conflict` on mismatch WITHOUT mutating state.
    pub based_revision: Option<u64>,
    /// The portable manifest payload. `deny_unknown_fields` on the struct +
    /// every descriptor rejects excluded fields (`envVars`, raw `claim`,
    /// `fullscreenPaneId`, …) loudly — mapped to `VALIDATION_ERROR`.
    pub manifest: WorkspaceManifest,
}

/// `GET /workspace/:projectId` — load a project's manifest.
///
/// Returns `IpcBody::ok(None)` when the file is missing (the success path —
/// a workspace reload starts fresh), OR when the host store is unavailable
/// (degraded fresh-only mode). A corrupt / wrong-schema-version file is
/// backed up by the service then treated as fresh — also `Ok(None)`.
pub async fn get(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> impl IntoResponse {
    let Some(service) = state.workspace_manifest.as_ref() else {
        // Degraded fresh-only mode — no host store attached.
        return (
            StatusCode::OK,
            Json(IpcBody::<Option<WorkspaceManifest>>::ok(None)),
        );
    };
    match service.load(&project_id).await {
        Ok(manifest) => {
            debug!(
                target: "termul::web::workspace_api",
                project_id = %project_id,
                revision = manifest.as_ref().map_or(0, |m| m.revision),
                "get: loaded manifest"
            );
            (StatusCode::OK, Json(IpcBody::ok(manifest)))
        }
        Err(error) => {
            warn!(
                target: "termul::web::workspace_api",
                project_id = %project_id,
                error = %error,
                "get: host load failed"
            );
            (
                StatusCode::OK,
                Json(IpcBody::<Option<WorkspaceManifest>>::err(
                    error.to_string(),
                    "WORKSPACE_MANIFEST_GET_FAILED",
                )),
            )
        }
    }
}

/// `POST /workspace/:projectId/write` — revision-checked write.
///
/// Body: `WriteRequest { basedRevision, manifest }`. The host compares
/// `basedRevision` against the on-disk `revision`; on match → apply, increment,
/// persist atomically, return `WriteOutcome::Updated`. On mismatch → return
/// `WriteOutcome::Conflict` WITHOUT mutating state. **Conflict is a SUCCESS
/// body variant** (`status: 'conflict'`), NOT an error code — the caller
/// branches on the `status` discriminator.
///
/// Loopback-only (refused from non-loopback peers) so a LAN client cannot
/// mutate the host's manifest store. An over-serialized payload carrying an
/// excluded field (`envVars`, raw `claim`, `fullscreenPaneId`) fails serde
/// `deny_unknown_fields` — Patch 1: the handler manually deserializes the
/// body so this rejection surfaces as 200 + `IpcBody::err(VALIDATION_ERROR)`
/// (NOT a 4xx — the IpcBody contract uses 200 for app-level failures so the
/// renderer maps the `VALIDATION_ERROR` code rather than a transport
/// `NETWORK_ERROR`).
pub async fn write(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(project_id): Path<String>,
    body: Bytes,
) -> impl IntoResponse {
    if let Some(forbidden) = check_local_only::<WriteOutcome>(
        peer,
        state.allow_remote_writes,
        state.shared_live_writes_denied,
        "/workspace/{id}/write",
    ) {
        return (StatusCode::OK, Json(forbidden));
    }
    // Patch 1: manual deserialization so a `deny_unknown_fields` rejection
    // (envVars / raw claim / fullscreenPaneId / extra envelope field) is
    // caught here and mapped to a 200 + `IpcBody::err(VALIDATION_ERROR)` —
    // NOT a 4xx JsonRejection (which the renderer would map to
    // `NETWORK_ERROR`, masking the validation failure).
    let req: WriteRequest = match serde_json::from_slice(&body) {
        Ok(req) => req,
        Err(error) => {
            warn!(
                target: "termul::web::workspace_api",
                project_id = %project_id,
                error = %error,
                "write: payload validation failed (deny_unknown_fields or malformed JSON)"
            );
            return (
                StatusCode::OK,
                Json(IpcBody::<WriteOutcome>::err(
                    format!("payload validation failed: {error}"),
                    "VALIDATION_ERROR",
                )),
            );
        }
    };
    let Some(service) = state.workspace_manifest.as_ref() else {
        return (
            StatusCode::OK,
            Json(IpcBody::<WriteOutcome>::err(
                "workspace manifest store is unavailable",
                "WORKSPACE_MANIFEST_UNAVAILABLE",
            )),
        );
    };
    match service
        .write(&project_id, req.based_revision, req.manifest)
        .await
    {
        Ok(outcome) => {
            // Boundary logging at the service layer already emits project_id
            // + revision + update_identity (never topology or claim).
            (StatusCode::OK, Json(IpcBody::ok(outcome)))
        }
        Err(error) => {
            warn!(
                target: "termul::web::workspace_api",
                project_id = %project_id,
                error = %error,
                "write: host write failed"
            );
            (
                StatusCode::OK,
                Json(IpcBody::<WriteOutcome>::err(
                    error.to_string(),
                    "WORKSPACE_MANIFEST_WRITE_FAILED",
                )),
            )
        }
    }
}

/// `POST /workspace/:projectId/delete` — idempotent delete. Returns
/// `IpcBody::ok(())` whether the file existed or not. Never touches the PTY /
/// agent layer (the manifest is a passive durable projection; the live process
/// layer is unaffected by stale revisions). Loopback-only.
pub async fn delete(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(project_id): Path<String>,
) -> impl IntoResponse {
    if let Some(forbidden) = check_local_only::<()>(
        peer,
        state.allow_remote_writes,
        state.shared_live_writes_denied,
        "/workspace/{id}/delete",
    ) {
        return (StatusCode::OK, Json(forbidden));
    }
    let Some(service) = state.workspace_manifest.as_ref() else {
        // Idempotent success — degraded mode has nothing to delete.
        return (StatusCode::OK, Json(IpcBody::<()>::ok(())));
    };
    match service.delete(&project_id).await {
        Ok(()) => (StatusCode::OK, Json(IpcBody::<()>::ok(()))),
        Err(error) => {
            warn!(
                target: "termul::web::workspace_api",
                project_id = %project_id,
                error = %error,
                "delete: host delete failed"
            );
            (
                StatusCode::OK,
                Json(IpcBody::<()>::err(
                    error.to_string(),
                    "WORKSPACE_MANIFEST_DELETE_FAILED",
                )),
            )
        }
    }
}

/// Localhost-only guard for write/delete routes (mirrors
/// `log_api::frontend_error` / `fs_api::check_local_only`). Returns `None`
/// when the peer is loopback OR the standalone `termul-server` operator
/// opt-in `allow_remote_writes` is set, or `Some(IpcBody::err(...))` with
/// code `"FORBIDDEN"` when remote. 200+IpcResult convention (200 with the
/// error body) so the renderer maps it to a uniform failure body. Emits a
/// durable boundary log on admission-via-opt-in and on refusal (AGENTS.md).
fn check_local_only<T>(
    peer: SocketAddr,
    allow_remote_writes: bool,
    shared_live_writes_denied: bool,
    route: &str,
) -> Option<IpcBody<T>> {
    // Deployment-mode deny FIRST (mirrors fs_api::check_local_only).
    if shared_live_writes_denied {
        tracing::warn!(
            target: "termul::web::workspace_api",
            route = route,
            peer = %peer,
            "remote-write guard REFUSED (shared-live deployment mode denies all writes)",
        );
        return Some(IpcBody::<T>::err(
            "shared-live deployment mode denies all remote writes".to_string(),
            "FORBIDDEN",
        ));
    }
    let is_loopback = peer.ip().is_loopback();
    if is_loopback || allow_remote_writes {
        if !is_loopback && allow_remote_writes {
            tracing::warn!(
                target: "termul::web::workspace_api",
                route = route,
                peer = %peer,
                "remote-write guard ADMITTED (--allow-remote-writes)",
            );
        }
        None
    } else {
        tracing::warn!(
            target: "termul::web::workspace_api",
            route = route,
            peer = %peer,
            "remote-write guard REFUSED (peer not loopback; no --allow-remote-writes)",
        );
        Some(IpcBody::<T>::err(
            format!("workspace manifest write/delete routes are localhost-only (peer {peer} is not loopback)"),
            "FORBIDDEN",
        ))
    }
}

#[cfg(test)]
mod tests;
