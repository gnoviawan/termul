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
        project_root: Arc::new(parking_lot::RwLock::new(std::env::temp_dir())),
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
        shared_live_writes_denied: false,
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
