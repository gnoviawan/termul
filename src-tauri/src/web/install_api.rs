//! HTTP handler for the host-owned verified-atomic ACP install (CAP-6 / Story 9).
//!
//! Mirrors the desktop `#[tauri::command] acp_install_agent` handler over HTTP
//! so the web/remote client can install a catalog agent through the same
//! `IpcBody<T>` contract.
//!
//! - **`POST /acp/install`** — install an agent. Body: `{ agentId: string }`
//!   (`deny_unknown_fields` rejects extra fields loudly). The host resolves
//!   the agent by id from the catalog, downloads the HTTPS archive, verifies
//!   `sha256`, extracts safely, atomically activates, serializes per-agent,
//!   records the installed-agents manifest, and returns
//!   `{ command: absolute_path, args: string[] }`.
//!
//! The request carries ONLY `{ agentId }`; the host never accepts
//! browser-supplied URLs, commands, executable paths, or args — the trusted
//! catalog is the single source of both the archive URL and its expected
//! digest.
//!
//! Degrade-mode (`acp_install: None`) returns
//! `IpcBody::err(..., code::ACP_INSTALL_UNAVAILABLE)`. HTTP 200 for both success
//! AND app-level failures (mirrors `catalog_api.rs`); only transport/parse
//! failures become non-200 (renderer maps to `NETWORK_ERROR`).

use axum::{
    body::Bytes,
    extract::{ConnectInfo, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use std::net::SocketAddr;
use tracing::{info, warn};

use crate::acp::install::{code, InstallOutcome, InstallRequest};
use crate::web::fs_api::{check_local_only, IpcBody};
use crate::web::ws::AppState;

/// `POST /acp/install` — install a catalog agent.
///
/// Manual body deserialization so a `deny_unknown_fields` rejection surfaces as
/// 200 + `IpcBody::err(VALIDATION_ERROR)` — NOT a 4xx JsonRejection (which the
/// renderer would map to `NETWORK_ERROR`, masking the validation failure).
/// Mirrors the `catalog_api::set_opt_in` handler pattern.
///
/// Degrade-mode (`acp_install: None`) returns
/// `IpcBody::err(..., code::ACP_INSTALL_UNAVAILABLE)`.
///
/// Loopback-only guard (CWE-306): the install route mutates host state
/// (downloads + verifies + atomically activates an agent binary + records the
/// installed-agents manifest), so a LAN peer on a `0.0.0.0` bind must not
/// reach it. Mirrors the fs/git/workspace write routes' `check_local_only`.
pub async fn install(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    body: Bytes,
) -> impl IntoResponse {
    if let Some(forbidden) = check_local_only::<InstallOutcome>(
        peer,
        state.allow_remote_writes,
        state.shared_live_writes_denied,
        "/acp/install",
    ) {
        return (StatusCode::OK, Json(forbidden));
    }
    let req: InstallRequest = match serde_json::from_slice(&body) {
        Ok(req) => req,
        Err(error) => {
            warn!(
                target: "termul::web::install_api",
                session = crate::logging::run_id(),
                error = %error,
                "install: payload validation failed (deny_unknown_fields or malformed JSON)"
            );
            return (
                StatusCode::OK,
                Json(IpcBody::<InstallOutcome>::err(
                    format!("payload validation failed: {error}"),
                    code::VALIDATION_ERROR,
                )),
            );
        }
    };
    let Some(service) = state.acp_install.as_ref() else {
        return (
            StatusCode::OK,
            Json(IpcBody::<InstallOutcome>::err(
                "acp install store is unavailable",
                code::ACP_INSTALL_UNAVAILABLE,
            )),
        );
    };
    match service.install_by_id(&req.agent_id).await {
        Ok(outcome) => {
            info!(
                target: "termul::web::install_api",
                session = crate::logging::run_id(),
                agent = %req.agent_id,
                "install: success"
            );
            (StatusCode::OK, Json(IpcBody::ok(outcome)))
        }
        Err(error) => {
            let code = error.code();
            warn!(
                target: "termul::web::install_api",
                session = crate::logging::run_id(),
                agent = %req.agent_id,
                code,
                msg = %error.message,
                "install: failure"
            );
            (
                StatusCode::OK,
                Json(IpcBody::<InstallOutcome>::err(error.message, code)),
            )
        }
    }
}

#[cfg(test)]
mod tests;
