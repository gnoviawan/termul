use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode};
use axum::routing::{get, post};
use serde_json::{json, Value};
use tower::ServiceExt;

use crate::web::ws::{AppState, HistoryMode};

/// `GET /mcp-catalog/search?<query>` against the embedded dev fixture.
pub(crate) async fn http_search(query: &str) -> Value {
    let response = axum::Router::new()
        .route("/mcp-catalog/search", get(super::search))
        .oneshot(
            Request::builder()
                .uri(format!("/mcp-catalog/search?{query}"))
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    serde_json::from_slice(&bytes).expect("IpcBody json")
}

#[tokio::test]
async fn search_returns_a_page_of_rows() {
    let body = http_search("query=hooka&limit=5").await;
    assert_eq!(body["success"], true);
    let data = &body["data"];
    assert_eq!(data["total"], 1);
    assert_eq!(data["nextCursor"], Value::Null);
    assert!(data["updatedAt"].is_string());
    assert_eq!(data["sample"], true);
    let row = &data["items"][0];
    assert_eq!(row["name"], "to.hooka/mcp");
    assert_eq!(row["version"], "0.1.2");
    assert_eq!(row["status"], "active");
    assert_eq!(
        row["defaultOption"],
        serde_json::json!({ "kind": "package", "index": 0 })
    );
    assert!(row["state"] == "installable" || row["state"] == "needs-runtime");
}

#[tokio::test]
async fn search_pages_with_the_returned_cursor() {
    let first = http_search("limit=20").await;
    assert_eq!(first["data"]["total"], 24);
    assert_eq!(first["data"]["items"].as_array().unwrap().len(), 20);
    assert_eq!(first["data"]["nextCursor"], "20");
    let second = http_search("limit=20&cursor=20").await;
    assert_eq!(second["data"]["items"].as_array().unwrap().len(), 4);
    assert_eq!(second["data"]["nextCursor"], Value::Null);
}

#[tokio::test]
async fn invalid_requests_are_validation_errors() {
    for query in ["limit=0", "limit=abc", "cursor=nope", "unknown=1"] {
        let body = http_search(query).await;
        assert_eq!(body["success"], false, "{query}");
        assert_eq!(body["code"], "VALIDATION_ERROR", "{query}");
    }
}

pub(crate) async fn http_status() -> Value {
    let response = axum::Router::new()
        .route("/mcp-catalog/status", get(super::status))
        .oneshot(
            Request::builder()
                .uri("/mcp-catalog/status")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    serde_json::from_slice(&bytes).expect("IpcBody json")
}

fn state(allow_remote_writes: bool, shared_live_writes_denied: bool) -> AppState {
    let pty = crate::web::test_pty_manager();
    AppState {
        acp: Arc::new(crate::acp::AcpManager::new(vec![])),
        terminal_events: pty.terminal_events(),
        cwd_tracker: pty.cwd_tracker(),
        git_tracker: pty.git_tracker(),
        exit_code_tracker: pty.exit_code_tracker(),
        pty,
        relay: Arc::new(crate::web::sink::WsRelaySink::new()),
        registry: crate::web::project_registry::ProjectRegistry::seeded_for_test(
            &std::env::temp_dir(),
        ),
        history_mode: HistoryMode::LiveOnly,
        pending_oauth_flows: Arc::new(parking_lot::RwLock::new(std::collections::HashMap::new())),
        oauth_base_url: "http://127.0.0.1".to_string(),
        acp_catalog: None,
        acp_install: None,
        store: None,
        web_auth: None,
        allow_remote_writes,
        shared_live_writes_denied,
        connections: Default::default(),
    }
}

async fn http_set_sync(state: AppState, peer: [u8; 4], body: &str) -> Value {
    let response = axum::Router::new()
        .route("/mcp-catalog/sync", post(super::set_sync))
        .with_state(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/mcp-catalog/sync")
                .header("content-type", "application/json")
                .extension(ConnectInfo(SocketAddr::from((peer, 54321))))
                .body(Body::from(body.to_string()))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    serde_json::from_slice(&bytes).expect("IpcBody json")
}

#[tokio::test]
async fn status_names_the_sample_catalog_and_its_size() {
    let body = http_status().await;
    assert_eq!(body["success"], true);
    assert_eq!(body["data"]["sample"], true);
    assert_eq!(body["data"]["servers"], 24);
    assert_eq!(body["data"]["updatedAt"], "2026-10-31T10:35:51.229Z");
    assert_eq!(body["data"]["sync"], json!({ "state": "disabled" }));
}

#[tokio::test]
async fn set_sync_is_a_write_that_shared_live_and_remote_peers_cannot_make() {
    let enabled = r#"{"enabled":false}"#;
    for (state, peer) in [
        (state(true, true), [127, 0, 0, 1]),
        (state(false, false), [192, 168, 1, 20]),
    ] {
        let body = http_set_sync(state, peer, enabled).await;
        assert_eq!(body["success"], false);
        assert_eq!(body["code"], "FORBIDDEN");
    }
}

#[tokio::test]
async fn set_sync_validates_its_body_before_reaching_the_service() {
    let body = http_set_sync(
        state(false, false),
        [127, 0, 0, 1],
        r#"{"enabled":true,"x":1}"#,
    )
    .await;
    assert_eq!(body["code"], "VALIDATION_ERROR");
    let body = http_set_sync(state(false, false), [127, 0, 0, 1], r#"{"enabled":true}"#).await;
    assert_eq!(body["code"], "MCP_CATALOG_SYNC_UNAVAILABLE");
}

pub(crate) const FIXED_ICON: &[u8] = b"\x89PNG\r\n\x1a\nfixture";

/// Every icon this process serves in tests is [`FIXED_ICON`].
pub(crate) async fn with_fixed_icons() {
    let dir = tempfile::tempdir().expect("icon dir").keep();
    crate::mcp_catalog::McpCatalogService::shared()
        .await
        .attach_fixed_icon(
            dir,
            crate::mcp_catalog::Icon {
                content_type: crate::mcp_catalog::IconType::Png,
                bytes: FIXED_ICON.into(),
            },
        );
}

pub(crate) async fn http_icon(encoded_name: &str) -> axum::response::Response {
    with_fixed_icons().await;
    axum::Router::new()
        .route("/mcp-catalog/icon/{*name}", get(super::icon))
        .oneshot(
            Request::builder()
                .uri(format!("/mcp-catalog/icon/{encoded_name}"))
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response")
}

#[tokio::test]
async fn rows_say_whether_the_host_has_a_logo_without_the_url() {
    let body = http_search("query=abmeter").await;
    let row = &body["data"]["items"][0];
    assert_eq!(row["name"], "ai.abmeter/abmeter");
    assert_eq!(row["hasIcon"], true);
    assert!(!body.to_string().contains("abmeter.ai/"));
    let hooka = http_search("query=hooka").await;
    assert_eq!(hooka["data"]["items"][0]["hasIcon"], false);
}

#[tokio::test]
async fn the_icon_route_serves_inert_image_bytes() {
    let response = http_icon("ai.abmeter%2Fabmeter").await;
    assert_eq!(response.status(), StatusCode::OK);
    let headers = response.headers().clone();
    assert_eq!(headers["content-type"], "image/png");
    assert_eq!(headers["x-content-type-options"], "nosniff");
    assert_eq!(
        headers["content-security-policy"],
        "default-src 'none'; style-src 'unsafe-inline'; sandbox"
    );
    assert_eq!(headers["cache-control"], "private, max-age=86400");
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    assert_eq!(&bytes[..], FIXED_ICON);

    let unescaped = http_icon("ai.abmeter/abmeter").await;
    assert_eq!(unescaped.status(), StatusCode::OK);
}

#[tokio::test]
async fn servers_without_a_logo_are_not_found() {
    for name in ["to.hooka%2Fmcp", "io.example%2Fmissing"] {
        let response = http_icon(name).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{name}");
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let body: Value = serde_json::from_slice(&bytes).expect("IpcBody json");
        assert_eq!(body["success"], false);
        assert_eq!(body["code"], "NOT_FOUND");
    }
}
