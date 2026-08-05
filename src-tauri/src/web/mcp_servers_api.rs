use std::path::{Path, PathBuf};

use axum::{extract::State, Json};
use serde_json::Value;
use tokio::fs;

use crate::acp::atomic_file;

use crate::web::fs_api::IpcBody;
use crate::web::ws::AppState;

const MAX_REGISTRY_BYTES: usize = 1024 * 1024;
const FILE_NAME: &str = "mcp-servers.json";

fn registry_path(project_root: &Path) -> PathBuf {
    project_root.join(".termul").join(FILE_NAME)
}

pub async fn get(State(state): State<AppState>) -> Json<IpcBody<Value>> {
    let path = registry_path(&state.project_root);
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

pub async fn put(State(state): State<AppState>, Json(value): Json<Value>) -> Json<IpcBody<()>> {
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

    let path = registry_path(&state.project_root);
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
            project_root: Arc::new(dir),
            workspace_manifest: None,
        };
        axum::Router::new()
            .route("/mcp-servers", get(super::get).put(super::put))
            .with_state(state)
    }

    #[tokio::test]
    async fn put_then_get_round_trips_registry() {
        let dir = std::env::temp_dir().join(format!("termul-mcp-api-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir).await;
        let app = test_app(dir.clone());
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/mcp-servers")
                    .header("content-type", "application/json")
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
        let response = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/mcp-servers")
                    .header("content-type", "application/json")
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
}
