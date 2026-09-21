use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use axum::{extract::{ConnectInfo, State}, Json};
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
    if let Some(forbidden) =
        check_local_only::<()>(peer, state.allow_remote_writes, state.shared_live_writes_denied, "/mcp-servers")
    {
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
mod tests {
    use super::*;
    use crate::acp::AcpManager;
    use crate::web::project_registry::ProjectRegistry;
    use crate::web::sink::WsRelaySink;
    use crate::web::test_pty_manager;
    use crate::web::ws::HistoryMode;
    use axum::body::{to_bytes, Body};
    use axum::http::{Request, StatusCode};
    use axum::routing::get;
    use std::sync::Arc;
    use tower::ServiceExt;

    fn test_app(dir: PathBuf) -> axum::Router {
        let pty = test_pty_manager();
        let state = AppState { acp: Arc::new(AcpManager::new(vec![])),
        terminal_events: pty.terminal_events(),
        cwd_tracker: pty.cwd_tracker(),
        git_tracker: pty.git_tracker(),
        exit_code_tracker: pty.exit_code_tracker(),
        pty,
        relay: Arc::new(WsRelaySink::new()),
        registry: Arc::new(ProjectRegistry::new()),
        registry_persistence: None,
        projects_file: None,
        history_mode: HistoryMode::LiveOnly,
        project_root: Arc::new(parking_lot::RwLock::new(dir)),
        pending_oauth_flows: std::sync::Arc::new(parking_lot::RwLock::new(std::collections::HashMap::new())),
        oauth_base_url: "http://127.0.0.1".to_string(),
        workspace_manifest: None,
        acp_catalog: None,
        acp_install: None,
        store: None, web_auth: None, allow_remote_writes: false, shared_live_writes_denied: false,  };
        axum::Router::new()
            .route("/mcp-servers", get(super::get).put(super::put))
            .with_state(state)
    }

    #[tokio::test]
    async fn put_then_get_round_trips_registry() {
        let dir = std::env::temp_dir().join(format!("termul-mcp-api-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir).await;
        let app = test_app(dir.clone());
        let loopback = std::net::SocketAddr::from(([127, 0, 0, 1], 54321));
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/mcp-servers")
                    .header("content-type", "application/json")
                    .extension(axum::extract::ConnectInfo(loopback))
                    .body(Body::from(r#"[{"id":"one","type":"stdio","name":"fs","command":"npx","enabled":true}]"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/mcp-servers")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["success"], true);
        assert_eq!(value["data"][0]["name"], "fs");
        let _ = fs::remove_dir_all(dir).await;
    }

    #[tokio::test]
    async fn rejects_non_array_payload() {
        let dir =
            std::env::temp_dir().join(format!("termul-mcp-api-invalid-{}", std::process::id()));
        let app = test_app(dir.clone());
        let loopback = std::net::SocketAddr::from(([127, 0, 0, 1], 54321));
        let response = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/mcp-servers")
                    .header("content-type", "application/json")
                    .extension(axum::extract::ConnectInfo(loopback))
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["success"], false);
        assert_eq!(value["code"], "MCP_REGISTRY_INVALID");
        let _ = fs::remove_dir_all(dir).await;
    }

    /// F-004 regression: `PUT /mcp-servers` is a host-state write — a
    /// non-loopback peer without `--allow-remote-writes` must be refused
    /// (FORBIDDEN) and nothing may be written to disk. Previously the handler
    /// had no peer context at all, so LAN clients wrote the MCP registry
    /// (deferred command execution definitions) while sibling mutation
    /// routes returned FORBIDDEN.
    #[tokio::test]
    async fn put_refused_from_non_loopback_peer() {
        let dir = std::env::temp_dir().join(format!(
            "termul-mcp-api-guard-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir).await;
        let app = test_app(dir.clone());
        let remote = std::net::SocketAddr::from(([192, 168, 1, 50], 40000));
        let response = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/mcp-servers")
                    .header("content-type", "application/json")
                    .extension(axum::extract::ConnectInfo(remote))
                    .body(Body::from(
                        r#"[{"id":"x","type":"stdio","name":"evil","command":"sh","enabled":true}]"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["success"], false, "remote peer must be refused");
        assert_eq!(value["code"], "FORBIDDEN");
        // The registry file must not exist — the guard fired before the write.
        assert!(
            !dir.join(".termul").join(FILE_NAME).exists(),
            "guard must fire before the registry is persisted"
        );
        let _ = fs::remove_dir_all(dir).await;
    }

    /// F-004: shared-live deployment mode denies ALL writes regardless of
    /// peer — even loopback (cloudflared forwards public traffic as
    /// loopback).
    #[tokio::test]
    async fn put_refused_in_shared_live_mode() {
        let dir = std::env::temp_dir().join(format!(
            "termul-mcp-api-sharedlive-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir).await;
        let pty = test_pty_manager();
        let state = AppState {
            acp: Arc::new(AcpManager::new(vec![])),
            terminal_events: pty.terminal_events(),
            cwd_tracker: pty.cwd_tracker(),
            git_tracker: pty.git_tracker(),
            exit_code_tracker: pty.exit_code_tracker(),
            pty,
            relay: Arc::new(WsRelaySink::new()),
            registry: Arc::new(ProjectRegistry::new()),
            registry_persistence: None,
            projects_file: None,
            history_mode: HistoryMode::LiveOnly,
            project_root: Arc::new(parking_lot::RwLock::new(dir.clone())),
            pending_oauth_flows: std::sync::Arc::new(parking_lot::RwLock::new(
                std::collections::HashMap::new(),
            )),
            oauth_base_url: "http://127.0.0.1".to_string(),
            workspace_manifest: None,
            acp_catalog: None,
            acp_install: None,
            store: None,
            web_auth: None,
            allow_remote_writes: false,
            shared_live_writes_denied: true,
        };
        let app = axum::Router::new()
            .route("/mcp-servers", get(super::get).put(super::put))
            .with_state(state);
        let loopback = std::net::SocketAddr::from(([127, 0, 0, 1], 54321));
        let response = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/mcp-servers")
                    .header("content-type", "application/json")
                    .extension(axum::extract::ConnectInfo(loopback))
                    .body(Body::from(
                        r#"[{"id":"x","type":"stdio","name":"evil","command":"sh","enabled":true}]"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["success"], false, "shared-live denies all writes");
        assert_eq!(value["code"], "FORBIDDEN");
        assert!(
            !dir.join(".termul").join(FILE_NAME).exists(),
            "shared-live guard must fire before the registry is persisted"
        );
        let _ = fs::remove_dir_all(dir).await;
    }
}
