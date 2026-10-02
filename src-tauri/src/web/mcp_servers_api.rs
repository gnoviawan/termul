use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use axum::{
    extract::{ConnectInfo, State},
    Json,
};
use serde_json::Value;
use tokio::fs;

use crate::acp::atomic_file;

use crate::web::fs_api::{check_local_only, IpcBody};
use crate::web::ws::AppState;

pub(crate) const MAX_REGISTRY_BYTES: usize = 1024 * 1024;
pub(crate) const FILE_NAME: &str = "mcp-servers.json";

/// Resolve `{project_root}/.termul/mcp-servers.json`.
///
/// Shared by the web `PUT /mcp-servers` handler and the desktop
/// `remote_sync_mcp_registry` Tauri command so the desktop→project-file sync
/// writes the exact file the web route reads (CAP-7 — registry sync gap).
pub(crate) fn registry_path(project_root: &Path) -> PathBuf {
    project_root.join(".termul").join(FILE_NAME)
}

pub async fn get(State(state): State<AppState>) -> Json<IpcBody<Value>> {
    // CAP-1: lock-read the live project_root so the MCP registry file
    // (.termul/mcp-servers.json) follows the active project on a switch.
    let project_root = state.project_root.read().clone();
    let path = registry_path(&project_root);
    match fs::read(&path).await {
        Ok(bytes) if bytes.len() > MAX_REGISTRY_BYTES => Json(IpcBody::err(
            "MCP registry exceeds the 1 MiB limit",
            "MCP_REGISTRY_TOO_LARGE",
        )),
        Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(value) if value.is_array() => {
                tracing::info!(
                    entries = value.as_array().map_or(0, Vec::len),
                    "loaded MCP registry"
                );
                Json(IpcBody::ok(value))
            }
            Ok(_) | Err(_) => {
                tracing::warn!("MCP registry file is malformed");
                Json(IpcBody::err(
                    "MCP registry file is malformed",
                    "MCP_REGISTRY_INVALID",
                ))
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Json(IpcBody::ok(Value::Array(Vec::new())))
        }
        Err(error) => {
            tracing::error!(error = %error, "failed to read MCP registry");
            Json(IpcBody::err(
                "Failed to read MCP registry",
                "MCP_REGISTRY_READ_ERROR",
            ))
        }
    }
}
pub async fn put(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(value): Json<Value>,
) -> Json<IpcBody<()>> {
    // F-004: this route writes {project_root}/.termul/mcp-servers.json — a
    // host-state mutation that also defines MCP stdio commands the host later
    // spawns. It must carry the SAME `check_local_only` guard as every other
    // mutation route (fs/git writes, workspace, /acp/install, /projects/*):
    // non-loopback peers are refused unless `--allow-remote-writes`, and
    // shared-live deployment mode denies all writes. Previously the handler
    // took no peer context at all, so a LAN client could write the registry
    // while its HTTP twins returned FORBIDDEN.
    if let Some(forbidden) = check_local_only::<()>(
        peer,
        state.allow_remote_writes,
        state.shared_live_writes_denied,
        "/mcp-servers",
    ) {
        return Json(forbidden);
    }
    let Some(entries) = value.as_array() else {
        return Json(IpcBody::err(
            "MCP registry must be a JSON array",
            "MCP_REGISTRY_INVALID",
        ));
    };
    let bytes = match serde_json::to_vec(&value) {
        Ok(bytes) if bytes.len() <= MAX_REGISTRY_BYTES => bytes,
        Ok(_) => {
            return Json(IpcBody::err(
                "MCP registry exceeds the 1 MiB limit",
                "MCP_REGISTRY_TOO_LARGE",
            ));
        }
        Err(_) => {
            return Json(IpcBody::err(
                "MCP registry is not serializable",
                "MCP_REGISTRY_INVALID",
            ));
        }
    };

    // CAP-1: lock-read the live project_root (follows the active project).
    let project_root = state.project_root.read().clone();
    let path = registry_path(&project_root);
    let write_path = path.clone();
    let write_result =
        tokio::task::spawn_blocking(move || atomic_file::replace(&write_path, &bytes)).await;
    match write_result {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            tracing::error!(error = %error, "failed to atomically persist MCP registry");
            return Json(IpcBody::err(
                "Failed to persist MCP registry",
                "MCP_REGISTRY_WRITE_ERROR",
            ));
        }
        Err(error) => {
            tracing::error!(error = %error, "MCP registry write task failed");
            return Json(IpcBody::err(
                "Failed to persist MCP registry",
                "MCP_REGISTRY_WRITE_ERROR",
            ));
        }
    }
    tracing::info!(entries = entries.len(), "persisted MCP registry");
    Json(IpcBody::ok(()))
}

#[cfg(test)]
mod tests;
