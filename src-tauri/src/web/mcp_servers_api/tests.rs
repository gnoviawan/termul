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
        project_root: Arc::new(parking_lot::RwLock::new(dir)),
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
                .body(Body::from(
                    r#"[{"id":"one","type":"stdio","name":"fs","command":"npx","enabled":true}]"#,
                ))
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
    let dir = std::env::temp_dir().join(format!("termul-mcp-api-invalid-{}", std::process::id()));
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
    let dir = std::env::temp_dir().join(format!("termul-mcp-api-guard-{}", std::process::id()));
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
    let dir =
        std::env::temp_dir().join(format!("termul-mcp-api-sharedlive-{}", std::process::id()));
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
