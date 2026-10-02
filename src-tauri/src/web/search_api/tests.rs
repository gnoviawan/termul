use super::*;
use crate::acp::AcpManager;
use crate::web::project_registry::ProjectRegistry;
use crate::web::sink::WsRelaySink;
use crate::web::test_pty_manager;
use axum::body::Body;
use axum::http::Request;
use axum::routing::{get, post};
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
        .route("/search/rg-info", get(rg_info))
        .route("/search/content", post(content))
        .route("/search/cancel", post(cancel))
        .with_state(state)
}

async fn get_request(state: AppState, uri: &str) -> axum::http::Response<Body> {
    test_router(state)
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(uri)
                .body(Body::empty())
                .expect("build request"),
        )
        .await
        .expect("router response")
}

async fn post_json(
    state: AppState,
    uri: &str,
    body: &serde_json::Value,
) -> axum::http::Response<Body> {
    let bytes = serde_json::to_vec(body).expect("serialize body");
    test_router(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(uri)
                .header("content-type", "application/json")
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
async fn rg_info_returns_info() {
    let resp = get_request(test_state(), "/search/rg-info").await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<RgInfoResponse> = body_as_json(resp.into_body()).await;
    assert!(body.success, "rg-info should succeed: {:?}", body.error);
    let data = body.data.expect("RgInfoResponse");
    assert!(!data.resolved_path.is_empty());
}

#[tokio::test]
async fn content_search_empty_query_returns_empty() {
    let req = serde_json::json!({
        "scopeRoot": "/tmp",
        "rootPath": "/tmp",
        "query": ""
    });
    let resp = post_json(test_state(), "/search/content", &req).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<FileSearchResponse> = body_as_json(resp.into_body()).await;
    assert!(body.success, "empty query should succeed: {:?}", body.error);
    let data = body.data.expect("FileSearchResponse");
    assert!(data.results.is_empty());
}

#[tokio::test]
async fn content_search_too_long_query_rejected() {
    let huge_query = "x".repeat(MAX_SEARCH_QUERY_LEN + 10);
    let req = serde_json::json!({
        "scopeRoot": "/tmp",
        "rootPath": "/tmp",
        "query": huge_query
    });
    let resp = post_json(test_state(), "/search/content", &req).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<FileSearchResponse> = body_as_json(resp.into_body()).await;
    assert!(!body.success, "too-long query should be rejected");
    assert_eq!(body.code.as_deref(), Some("QUERY_TOO_LONG"));
}

#[tokio::test]
async fn cancel_unknown_search_id_returns_success() {
    let req = serde_json::json!({ "searchId": "nonexistent-id" });
    let resp = post_json(test_state(), "/search/cancel", &req).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(body.success, "cancel of unknown id should succeed");
}
