//! `POST /mcp-servers/probe` — on-demand MCP client probe (web parity).
//!
//! Mirrors `mcp_servers_api.rs`'s handler shape and `IpcBody<T>` contract so
//! the renderer facade (`acp-mcp-probe.ts`) returns the same shape on desktop
//! (Tauri command) and web (HTTP route). The probe runs on the termul-server
//! host — where stdio commands execute (matches GH-287's web-parity decision).
//!
//! The route only returns `IpcBody::err` when the request body cannot be
//! deserialized into a `McpServerConfig`. A *reachable-but-disconnected*
//! server is still `IpcBody::ok(ProbeResult { status: Disconnected, .. })`
//! (the probe itself never fails — it reports its outcome).

use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, State},
    Json,
};
use serde_json::Value;

use crate::acp::mcp_probe::{self, McpServerConfig, ProbeResult};
use crate::web::fs_api::{check_local_only, IpcBody};
use crate::web::ws::AppState;

/// `POST /mcp-servers/probe` — body: `McpServerConfig` → `IpcBody<ProbeResult>`.
///
/// A stdio probe spawns an arbitrary host command, so this route sits behind
/// the same write guard as every other host-state mutation (`check_local_only`:
/// loopback peer or `--allow-remote-writes`, and never in shared-live mode).
/// The guard runs BEFORE the body is parsed or anything is spawned; the refusal
/// is the stable `FORBIDDEN` code and logs only peer/route (never the config).
pub async fn probe(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(value): Json<Value>,
) -> Json<IpcBody<ProbeResult>> {
    if let Some(forbidden) = check_local_only::<ProbeResult>(
        peer,
        state.allow_remote_writes,
        state.shared_live_writes_denied,
        "/mcp-servers/probe",
    ) {
        return Json(forbidden);
    }
    let server: McpServerConfig = match serde_json::from_value(value) {
        Ok(server) => server,
        Err(error) => {
            tracing::warn!(error = %error, "MCP probe rejected malformed config");
            return Json(IpcBody::err(
                "Malformed MCP server config",
                "MCP_PROBE_INVALID_CONFIG",
            ));
        }
    };
    let result = mcp_probe::probe(server).await;
    Json(IpcBody::ok(result))
}

#[cfg(test)]
mod tests;
