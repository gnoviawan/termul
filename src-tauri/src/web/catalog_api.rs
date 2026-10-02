//! HTTP handlers for the host-owned ACP catalog (CAP-6 / Story 8).
//!
//! Mirrors the desktop `#[tauri::command] acp_list_catalog` +
//! `acp_set_catalog_opt_in` handlers over HTTP so the web/remote client can
//! resolve the catalog through the same `IpcBody<T>` contract.
//!
//! - **`GET /acp/catalog`** — list the resolved catalog. Optional
//!   `?refresh=true` query forces a fresh probe (bypassing the 60s TTL).
//! - **`POST /acp/catalog/opt-in`** — set the host opt-in flag that gates the
//!   CDN registry augmentation. Body: `{ enabled: boolean }`
//!   (`deny_unknown_fields` rejects extra fields loudly).
//!
//! The read `GET` is open (no loopback guard — mirrors `GET /projects`:
//! read-only host introspection). The opt-in `POST` mirrors the
//! `set_default_project` posture (any connected client until Epic 2 wires auth).
//!
//! Degrade-mode (`acp_catalog: None`) returns `IpcBody::err(...,
//! "ACP_CATALOG_UNAVAILABLE")`.

use axum::{
    body::Bytes,
    extract::{ConnectInfo, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use std::net::SocketAddr;
use tracing::{debug, info, warn};

use crate::acp::{AcpCatalog, SetCatalogOptInRequest};
use crate::web::fs_api::{check_local_only, IpcBody};
use crate::web::ws::AppState;

/// `GET /acp/catalog?refresh=true` query params.
#[derive(Debug, Deserialize)]
pub struct CatalogQuery {
    /// When `true`, force-refresh the probe cache (bypass the 60s TTL). When
    /// absent / `false`, serve the cached catalog if fresh.
    #[serde(default)]
    pub refresh: Option<bool>,
}

/// `GET /acp/catalog` — list the resolved ACP catalog.
///
/// Returns the host's OS/arch/runtime availability + per-agent resolved
/// `SupportedAcpAgentStatus`. The catalog is credential-free, path-free,
/// read-only host introspection — never carries `AgentConfig.env` (API keys)
/// or resolved absolute executable paths. The web client never probes
/// `@tauri-apps/plugin-os` or PATH locally — the host is the single source of
/// truth.
///
/// Degrade-mode (`acp_catalog: None`) returns
/// `IpcBody::err(..., "ACP_CATALOG_UNAVAILABLE")`.
pub async fn list(
    State(state): State<AppState>,
    Query(query): Query<CatalogQuery>,
) -> impl IntoResponse {
    let refresh = query.refresh.unwrap_or(false);
    let Some(service) = state.acp_catalog.as_ref() else {
        // Degraded mode — no host store attached.
        return (
            StatusCode::OK,
            Json(IpcBody::<AcpCatalog>::err(
                "acp catalog store is unavailable",
                "ACP_CATALOG_UNAVAILABLE",
            )),
        );
    };
    match service.list_catalog(refresh).await {
        Ok(mut catalog) => {
            // Overlay host-installed state so installed agents report `ready`
            // with their resolved command/args — the host is the single
            // source of truth (the web has no renderer persistence).
            if let Some(install) = state.acp_install.as_ref() {
                let installed = install.installed_agents();
                crate::acp::overlay_installed(&mut catalog, &installed);
            }
            debug!(
                target: "termul::web::catalog_api",
                agents = catalog.agents.len(),
                "get: resolved catalog"
            );
            (StatusCode::OK, Json(IpcBody::ok(catalog)))
        }
        Err(error) => {
            warn!(
                target: "termul::web::catalog_api",
                error = %error,
                "get: catalog resolution failed"
            );
            (
                StatusCode::OK,
                Json(IpcBody::<AcpCatalog>::err(
                    error.to_string(),
                    "CATALOG_LOAD_FAILED",
                )),
            )
        }
    }
}

/// `POST /acp/catalog/opt-in` — set the host opt-in flag.
///
/// Body: `SetCatalogOptInRequest { enabled: boolean }` with
/// `deny_unknown_fields` so an over-serialized payload (`{ enabled: true,
/// extra: "junk" }`) is rejected loudly as `VALIDATION_ERROR` (NOT silently
/// dropped). The opt-in gates the CDN registry augmentation: when enabled,
/// the next `GET /acp/catalog` includes CDN entries tagged
/// `source: 'registry'` (if the fetch succeeds); when disabled, only bundled
/// entries are served.
///
/// Degrade-mode (`acp_catalog: None`) returns
/// `IpcBody::err(..., "ACP_CATALOG_UNAVAILABLE")`.
///
/// Manual body deserialization so a `deny_unknown_fields` rejection surfaces
/// as 200 + `IpcBody::err(VALIDATION_ERROR)` — NOT a 4xx JsonRejection (which
/// the renderer would map to `NETWORK_ERROR`, masking the validation failure).
/// Mirrors the `workspace_api::write` handler pattern.
pub async fn set_opt_in(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    body: Bytes,
) -> impl IntoResponse {
    // F-005: mutating the host opt-in flag is a host-state write (it
    // persists across restarts and gates CDN registry fetches). The module
    // doc's "mirrors the set_default_project posture" claim went stale when
    // that route gained `check_local_only` — this route must carry the SAME
    // guard: non-loopback peers are refused unless `--allow-remote-writes`,
    // and shared-live deployment mode denies all writes.
    if let Some(forbidden) = check_local_only::<()>(
        peer,
        state.allow_remote_writes,
        state.shared_live_writes_denied,
        "/acp/catalog/opt-in",
    ) {
        return (StatusCode::OK, Json(forbidden));
    }
    let req: SetCatalogOptInRequest = match serde_json::from_slice(&body) {
        Ok(req) => req,
        Err(error) => {
            warn!(
                target: "termul::web::catalog_api",
                error = %error,
                "set_opt_in: payload validation failed (deny_unknown_fields or malformed JSON)"
            );
            return (
                StatusCode::OK,
                Json(IpcBody::<()>::err(
                    format!("payload validation failed: {error}"),
                    "VALIDATION_ERROR",
                )),
            );
        }
    };
    let Some(service) = state.acp_catalog.as_ref() else {
        return (
            StatusCode::OK,
            Json(IpcBody::<()>::err(
                "acp catalog store is unavailable",
                "ACP_CATALOG_UNAVAILABLE",
            )),
        );
    };
    match service.set_opt_in(req.enabled) {
        Ok(()) => {
            info!(
                target: "termul::web::catalog_api",
                enabled = req.enabled,
                "set_opt_in: persisted"
            );
            (StatusCode::OK, Json(IpcBody::<()>::ok(())))
        }
        Err(error) => {
            warn!(
                target: "termul::web::catalog_api",
                error = %error,
                "set_opt_in: persistence failed"
            );
            (
                StatusCode::OK,
                Json(IpcBody::<()>::err(
                    error.to_string(),
                    "ACP_CATALOG_OPT_IN_FAILED",
                )),
            )
        }
    }
}

#[cfg(test)]
mod tests;
