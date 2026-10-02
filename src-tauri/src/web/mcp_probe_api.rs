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

use axum::{extract::State, Json};
use serde_json::Value;

use crate::acp::mcp_probe::{self, McpServerConfig, ProbeResult};
use crate::web::fs_api::IpcBody;
use crate::web::ws::AppState;

/// `POST /mcp-servers/probe` — body: `McpServerConfig` → `IpcBody<ProbeResult>`.
pub async fn probe(
    _state: State<AppState>,
    Json(value): Json<Value>,
) -> Json<IpcBody<ProbeResult>> {
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
    // The probe is stateless and owns no registry handle, so AppState is not
    // consulted. (Kept in the signature for routing-state symmetry with the
    // sibling `mcp_servers_api` routes and future per-project scoping.)
    let result = mcp_probe::probe(server).await;
    Json(IpcBody::ok(result))
}

#[cfg(test)]
mod tests;
