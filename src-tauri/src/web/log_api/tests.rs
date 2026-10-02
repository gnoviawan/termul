use super::*;
use crate::acp::AcpManager;
use crate::web::project_registry::ProjectRegistry;
use crate::web::sink::WsRelaySink;
use crate::web::test_pty_manager;
use axum::body::Body;
use axum::http::Request;
use axum::routing::post;
use std::sync::Arc;
use tower::ServiceExt;

fn test_state() -> AppState {
    let pty = test_pty_manager();
    AppState {
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
        history_mode: crate::web::ws::HistoryMode::LiveOnly,
        project_root: Arc::new(parking_lot::RwLock::new(
            std::env::temp_dir()
                .canonicalize()
                .unwrap_or_else(|_| std::env::temp_dir()),
        )),
        workspace_manifest: None,
        acp_catalog: None,
        acp_install: None,
        store: None,
        web_auth: None,
        allow_remote_writes: false,
        shared_live_writes_denied: false,
        pending_oauth_flows: std::sync::Arc::new(parking_lot::RwLock::new(
            std::collections::HashMap::new(),
        )),
        oauth_base_url: "http://127.0.0.1".to_string(),
    }
}

fn test_router(state: AppState) -> axum::Router {
    axum::Router::new()
        .route("/log/frontend-error", post(frontend_error))
        .with_state(state)
}

async fn post_json(
    state: AppState,
    body: &serde_json::Value,
    peer: SocketAddr,
) -> axum::http::Response<Body> {
    let bytes = serde_json::to_vec(body).expect("serialize body");
    test_router(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/log/frontend-error")
                .header("content-type", "application/json")
                .extension(ConnectInfo(peer))
                .body(Body::from(bytes))
                .expect("build request"),
        )
        .await
        .expect("router response")
}

async fn body_as_json<T: serde::de::DeserializeOwned>(body: Body) -> T {
    let bytes = axum::body::to_bytes(body, usize::MAX)
        .await
        .expect("read body");
    serde_json::from_slice(&bytes).expect("deserialize IpcBody")
}

#[tokio::test]
async fn frontend_error_succeeds_on_loopback() {
    let req = serde_json::json!({
        "level": "error",
        "message": "test error",
        "source": "test",
    });
    let peer = SocketAddr::from(([127, 0, 0, 1], 54321));
    let resp = post_json(test_state(), &req, peer).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(body.success, "log should succeed: {:?}", body.error);
}

#[tokio::test]
async fn frontend_error_refused_from_non_loopback() {
    let req = serde_json::json!({
        "message": "test",
    });
    let peer = SocketAddr::from(([192, 168, 1, 50], 40000));
    let resp = post_json(test_state(), &req, peer).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(!body.success, "non-loopback must be refused");
    assert_eq!(body.code.as_deref(), Some("FORBIDDEN"));
}

#[tokio::test]
async fn frontend_error_warn_level_succeeds() {
    let req = serde_json::json!({
        "level": "warn",
        "message": "warning test",
    });
    let peer = SocketAddr::from(([127, 0, 0, 1], 54321));
    let resp = post_json(test_state(), &req, peer).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(body.success);
}

#[tokio::test]
async fn frontend_error_info_level_succeeds() {
    // Story 8 (web honesty): the info level is the destination for
    // benign noise (idle reconnect churn, idempotent not-found races);
    // it must be accepted and not fall through to the error branch.
    let req = serde_json::json!({
        "level": "info",
        "message": "benign noise test",
    });
    let peer = SocketAddr::from(([127, 0, 0, 1], 54321));
    let resp = post_json(test_state(), &req, peer).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(body.success, "info level should log: {:?}", body.error);
}
