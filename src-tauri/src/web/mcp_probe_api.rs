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
mod tests {
    use super::*;
    use crate::acp::AcpManager;
    use crate::web::project_registry::ProjectRegistry;
    use crate::web::sink::WsRelaySink;
    use crate::web::test_pty_manager;
    use crate::web::ws::HistoryMode;
    use axum::body::{to_bytes, Body};
    use axum::http::{Request, StatusCode};
    use axum::routing::post;
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tower::ServiceExt;

    fn test_app() -> axum::Router {
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
            project_root: Arc::new(std::env::temp_dir()),
            workspace_manifest: None,
            acp_catalog: None,
            acp_install: None,
        };
        axum::Router::new()
            .route("/mcp-servers/probe", post(super::probe))
            .with_state(state)
    }

    async fn body_as_json(body: Body) -> Value {
        let bytes = to_bytes(body, usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).expect("deserialize IpcBody")
    }

    #[tokio::test]
    async fn malformed_config_returns_invalid_config_error() {
        let app = test_app();
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/mcp-servers/probe")
                    .header("content-type", "application/json")
                    // `name` is a required field — this must fail to deserialize.
                    .body(Body::from(r#"{"type":"stdio","command":"npx"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let value: Value = body_as_json(response.into_body()).await;
        assert_eq!(value["success"], false);
        assert_eq!(value["code"], "MCP_PROBE_INVALID_CONFIG");
    }

    #[tokio::test]
    async fn unreachable_stdio_server_returns_disconnected_result() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let bogus = format!("this-binary-definitely-does-not-exist-{nanos}");
        let payload = serde_json::json!({
            "type": "stdio",
            "name": "ghost",
            "command": bogus,
            "args": [],
            "env": []
        });
        let app = test_app();
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/mcp-servers/probe")
                    .header("content-type", "application/json")
                    .body(Body::from(payload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let value: Value = body_as_json(response.into_body()).await;
        assert_eq!(value["success"], true);
        assert_eq!(value["data"]["status"], "disconnected");
        let error = value["data"]["error"].as_str().expect("error string");
        assert!(
            !error.contains(&bogus) || error.contains("spawn failed"),
            "error must not echo the bogus command verbatim: {error}"
        );
        assert!(error.contains("spawn failed"));
    }
}
