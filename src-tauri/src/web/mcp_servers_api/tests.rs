use super::*;
use crate::acp::AcpManager;
use crate::web::sink::WsRelaySink;
use crate::web::test_pty_manager;
use crate::web::ws::HistoryMode;
use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use axum::routing::get;
use std::sync::Arc;
use tower::ServiceExt;

/// The seeded test project's id — every request names it.
const PROJECT_ID: &str = crate::web::project_registry::SEEDED_PROJECT_ID;
const MCP_URI: &str = "/mcp-servers?projectId=default";

fn test_app(dir: PathBuf) -> axum::Router {
    // The registered default project's directory must exist (the MCP file
    // lives under it).
    std::fs::create_dir_all(&dir).expect("create project dir");
    app_with_registry(crate::web::project_registry::ProjectRegistry::seeded_for_test(&dir))
}

fn app_with_registry(registry: Arc<crate::web::project_registry::ProjectRegistry>) -> axum::Router {
    let pty = test_pty_manager();
    let state = AppState {
        acp: Arc::new(AcpManager::new(vec![])),
        terminal_events: pty.terminal_events(),
        cwd_tracker: pty.cwd_tracker(),
        git_tracker: pty.git_tracker(),
        exit_code_tracker: pty.exit_code_tracker(),
        pty,
        relay: Arc::new(WsRelaySink::new()),
        registry,
        history_mode: HistoryMode::LiveOnly,
        pending_oauth_flows: std::sync::Arc::new(parking_lot::RwLock::new(
            std::collections::HashMap::new(),
        )),
        oauth_base_url: "http://127.0.0.1".to_string(),
        acp_catalog: None,
        acp_install: None,
        store: None,
        web_auth: None,
        allow_remote_writes: false,
        shared_live_writes_denied: false,
        connections: Default::default(),
    };
    axum::Router::new()
        .route("/mcp-servers", get(super::get).put(super::put))
        .route(
            "/mcp-servers/oauth/start",
            axum::routing::post(crate::web::mcp_oauth_api::oauth_start),
        )
        .route(
            "/mcp-servers/oauth/status",
            axum::routing::post(crate::web::mcp_oauth_api::oauth_status),
        )
        .route(
            "/mcp-servers/oauth/disconnect",
            axum::routing::post(crate::web::mcp_oauth_api::oauth_disconnect),
        )
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
                .uri(MCP_URI)
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
                .uri(MCP_URI)
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
                .uri(MCP_URI)
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
                .uri(MCP_URI)
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
    // The registered default project's directory must exist (same shape as `test_app`).
    std::fs::create_dir_all(&dir).expect("create project dir");
    let pty = test_pty_manager();
    let state = AppState {
        acp: Arc::new(AcpManager::new(vec![])),
        terminal_events: pty.terminal_events(),
        cwd_tracker: pty.cwd_tracker(),
        git_tracker: pty.git_tracker(),
        exit_code_tracker: pty.exit_code_tracker(),
        pty,
        relay: Arc::new(WsRelaySink::new()),
        registry: crate::web::project_registry::ProjectRegistry::seeded_for_test(&dir),
        history_mode: HistoryMode::LiveOnly,
        pending_oauth_flows: std::sync::Arc::new(parking_lot::RwLock::new(
            std::collections::HashMap::new(),
        )),
        oauth_base_url: "http://127.0.0.1".to_string(),
        acp_catalog: None,
        acp_install: None,
        store: None,
        web_auth: None,
        allow_remote_writes: false,
        shared_live_writes_denied: true,
        connections: Default::default(),
    };
    let app = axum::Router::new()
        .route("/mcp-servers", get(super::get).put(super::put))
        .with_state(state);
    let loopback = std::net::SocketAddr::from(([127, 0, 0, 1], 54321));
    let response = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(MCP_URI)
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

/// Unknown, archived and pathless projects have no MCP registry file: GET and
/// PUT refuse them `NOT_FOUND` (a read-then-write can never create a file
/// outside a registered project), nothing is written, and OAuth start/status/
/// disconnect refuse them too.
#[tokio::test]
async fn unknown_archived_and_pathless_projects_are_not_found() {
    let dir = std::env::temp_dir().join(format!("termul-mcp-api-notfound-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create dir");
    let registry = crate::web::project_registry::ProjectRegistry::seeded_for_test(&dir);
    // Archiving the seeded project keeps it listed but takes it out of the boundary.
    assert!(registry.update(PROJECT_ID, None, None, Some(true)));
    registry.upsert(crate::web::project_registry::ProjectSummary {
        id: "nopath".to_string(),
        name: "No path".to_string(),
        color: "blue".to_string(),
        path: None,
        is_archived: false,
        is_default: false,
    });
    let app = app_with_registry(registry);
    let loopback = std::net::SocketAddr::from(([127, 0, 0, 1], 54321));

    for project_id in [PROJECT_ID, "nopath", "never-registered", ""] {
        let uri = format!("/mcp-servers?projectId={project_id}");
        let response = app
            .clone()
            .oneshot(Request::builder().uri(&uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let value = body_json(response).await;
        assert_eq!(value["success"], false, "GET {project_id}");
        assert_eq!(value["code"], "NOT_FOUND", "GET {project_id}");

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(&uri)
                    .header("content-type", "application/json")
                    .extension(axum::extract::ConnectInfo(loopback))
                    .body(Body::from("[]"))
                    .unwrap(),
            )
            .await
            .unwrap();
        let value = body_json(response).await;
        assert_eq!(value["success"], false, "PUT {project_id}");
        assert_eq!(value["code"], "NOT_FOUND", "PUT {project_id}");

        for route in ["start", "status", "disconnect"] {
            let response = app
                .clone()
                .oneshot(oauth_request(route, project_id, "https://mcp.example.com", loopback))
                .await
                .unwrap();
            let value = body_json(response).await;
            assert_eq!(value["success"], false, "oauth {route} {project_id}");
            assert_eq!(value["code"], "NOT_FOUND", "oauth {route} {project_id}");
        }
    }
    assert!(
        !dir.join(".termul").exists(),
        "nothing may be written for a project that cannot own a file"
    );
    let _ = std::fs::remove_dir_all(dir);
}

/// Each project has its own file, and OAuth start authorizes a server URL
/// against the NAMED project's list only: a URL configured in project A is
/// refused for project B.
#[tokio::test]
async fn oauth_start_authorizes_against_the_named_projects_file_only() {
    let base = std::env::temp_dir().join(format!("termul-mcp-api-two-{}", std::process::id()));
    let (dir_a, dir_b) = (base.join("a"), base.join("b"));
    std::fs::create_dir_all(&dir_a).expect("create a");
    std::fs::create_dir_all(&dir_b).expect("create b");
    let registry = Arc::new(crate::web::project_registry::ProjectRegistry::new());
    for (id, dir) in [("pa", &dir_a), ("pb", &dir_b)] {
        registry.upsert(crate::web::project_registry::ProjectSummary {
            id: id.to_string(),
            name: id.to_string(),
            color: "blue".to_string(),
            path: Some(dir.to_string_lossy().into_owned()),
            is_archived: false,
            is_default: false,
        });
    }
    let app = app_with_registry(registry);
    let loopback = std::net::SocketAddr::from(([127, 0, 0, 1], 54321));

    // Project A configures an http server; project B's file stays empty.
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/mcp-servers?projectId=pa")
                .header("content-type", "application/json")
                .extension(axum::extract::ConnectInfo(loopback))
                .body(Body::from(
                    r#"[{"id":"h","type":"http","name":"h","url":"http://127.0.0.1:1/mcp","enabled":true}]"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(body_json(response).await["success"], true);
    assert!(dir_a.join(".termul").join(FILE_NAME).exists());
    assert!(!dir_b.join(".termul").exists(), "B's file is untouched");

    // Each project reads back only its own file.
    for (id, expected_len) in [("pa", 1), ("pb", 0)] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/mcp-servers?projectId={id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let value = body_json(response).await;
        assert_eq!(value["success"], true);
        assert_eq!(value["data"].as_array().map(Vec::len), Some(expected_len), "{id}");
    }

    // The URL is not authorized for project B (A's list does not count).
    let response = app
        .clone()
        .oneshot(oauth_request("start", "pb", "http://127.0.0.1:1/mcp", loopback))
        .await
        .unwrap();
    let value = body_json(response).await;
    assert_eq!(value["success"], false);
    assert_eq!(value["code"], "UNAUTHORIZED_SERVER_URL");

    // Authorized for A: it passes the gate (and fails later, at discovery —
    // a closed local port in a unit test — never as UNAUTHORIZED_SERVER_URL).
    let response = app
        .oneshot(oauth_request("start", "pa", "http://127.0.0.1:1/mcp", loopback))
        .await
        .unwrap();
    let value = body_json(response).await;
    assert_ne!(value["code"], "UNAUTHORIZED_SERVER_URL");
    let _ = std::fs::remove_dir_all(base);
}

async fn body_json(response: axum::response::Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap()
}

fn oauth_request(
    route: &str,
    project_id: &str,
    server_url: &str,
    peer: std::net::SocketAddr,
) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(format!("/mcp-servers/oauth/{route}"))
        .header("content-type", "application/json")
        .extension(axum::extract::ConnectInfo(peer))
        .body(Body::from(
            serde_json::json!({ "projectId": project_id, "serverUrl": server_url }).to_string(),
        ))
        .unwrap()
}
