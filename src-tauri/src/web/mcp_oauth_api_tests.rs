#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::*;
use crate::acp::safe_url::UnsafeUrl;

fn refusal(raw: &str) -> Option<UnsafeUrl> {
    match remote_auth_url(raw) {
        Err(mcp_oauth::McpOAuthError::UnsafeUrl(refused)) => Some(refused),
        _ => None,
    }
}

#[test]
fn https_authorization_url_reaches_the_remote_browser_with_its_state() {
    assert_eq!(
        remote_auth_url("https://auth.example.com/authorize?client_id=c&state=xyz123").unwrap(),
        (
            "https://auth.example.com/authorize?client_id=c&state=xyz123".to_string(),
            "xyz123".to_string()
        )
    );
}

#[test]
fn authorization_url_without_state_is_refused() {
    let error = remote_auth_url("https://auth.example.com/authorize?client_id=c").unwrap_err();
    assert_eq!(
        error.to_string(),
        "Auth URL failed: authorization URL missing state parameter"
    );
}

#[test]
fn unsafe_authorization_url_is_refused_before_the_response_is_built() {
    assert_eq!(
        refusal("javascript:alert(1)//?state=xyz"),
        Some(UnsafeUrl::SchemeNotAllowed)
    );
    assert_eq!(
        refusal("file:///etc/passwd?state=xyz"),
        Some(UnsafeUrl::SchemeNotAllowed)
    );
    assert_eq!(
        refusal("http://auth.example.com/authorize?state=xyz"),
        Some(UnsafeUrl::HttpNotLoopback)
    );
}

#[test]
fn loopback_authorization_url_is_refused_for_the_remote_browser() {
    for raw in [
        "http://127.0.0.1:4100/authorize?state=xyz",
        "http://localhost:4100/authorize?state=xyz",
        "http://[::1]:4100/authorize?state=xyz",
    ] {
        assert_eq!(refusal(raw), Some(UnsafeUrl::LoopbackForRemote), "{raw}");
    }
}

#[test]
fn start_failure_codes_name_the_unsafe_url_refusal() {
    let unsafe_url = remote_auth_url("javascript:alert(1)").unwrap_err();
    assert_eq!(start_error_code(&unsafe_url), "MCP_UNSAFE_URL");
    assert_eq!(
        unsafe_url.to_string(),
        "refused an unsafe link: only https links are allowed"
    );
    let discovery = mcp_oauth::McpOAuthError::DiscoveryFailed("down".to_string());
    assert_eq!(start_error_code(&discovery), "OAUTH_START_FAILED");
}

mod routes {
    use std::sync::Arc;

    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use serde_json::{json, Value};
    use tower::ServiceExt;

    use crate::acp::AcpManager;
    use crate::web::mcp_registry::STORE_KEY;
    use crate::web::project_registry::{ProjectRegistry, ProjectSummary};
    use crate::web::sink::WsRelaySink;
    use crate::web::store::{Precondition, StorePolicy, WebStore};
    use crate::web::test_pty_manager;
    use crate::web::ws::{AppState, ClientIdentity, HistoryMode};

    const LOOPBACK: std::net::SocketAddr =
        std::net::SocketAddr::new(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), 54321);

    fn app(registry: Arc<ProjectRegistry>, store: Option<Arc<WebStore>>) -> axum::Router {
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
            pending_oauth_flows: Arc::new(parking_lot::RwLock::new(
                std::collections::HashMap::new(),
            )),
            oauth_base_url: "http://127.0.0.1".to_string(),
            acp_catalog: None,
            acp_install: None,
            store,
            web_auth: None,
            allow_remote_writes: false,
            shared_live_writes_denied: false,
            connections: Default::default(),
            server_admin: None,
        };
        axum::Router::new()
            .route(
                "/mcp-servers/oauth/start",
                axum::routing::post(super::oauth_start),
            )
            .route(
                "/mcp-servers/oauth/status",
                axum::routing::post(super::oauth_status),
            )
            .route(
                "/mcp-servers/oauth/disconnect",
                axum::routing::post(super::oauth_disconnect),
            )
            .with_state(state)
    }

    fn store_with(dir: &std::path::Path, servers: Value) -> Arc<WebStore> {
        let store = WebStore::open(dir.join("store.json"), StorePolicy::default()).unwrap();
        let client = ClientIdentity {
            device_id: "browser".into(),
            client_instance_id: "tab".into(),
        };
        store
            .write(
                STORE_KEY,
                json!({ "_version": 1, "data": servers }),
                Precondition::default(),
                &client,
                1,
            )
            .unwrap();
        Arc::new(store)
    }

    fn request(route: &str, project_id: &str, server_url: &str) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(format!("/mcp-servers/oauth/{route}"))
            .header("content-type", "application/json")
            .extension(axum::extract::ConnectInfo(LOOPBACK))
            .body(Body::from(
                json!({ "projectId": project_id, "serverUrl": server_url }).to_string(),
            ))
            .unwrap()
    }

    async fn code_of(app: &axum::Router, request: Request<Body>) -> Value {
        let response = app.clone().oneshot(request).await.unwrap();
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        body["code"].clone()
    }

    /// The host list authorizes a URL for every project: one configured
    /// while project A was open is authorized for project B. A URL that is
    /// not listed, or whose entry is off or stdio, is not.
    #[tokio::test]
    async fn start_authorizes_urls_of_the_host_list_for_every_project() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (dir.path().join("a"), dir.path().join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let registry =
            ProjectRegistry::with_roots_for_test(&[("pa", a.as_path()), ("pb", b.as_path())]);
        let store = store_with(
            dir.path(),
            json!([
                { "id": "h", "type": "http", "name": "H", "url": "http://127.0.0.1:1/mcp/" },
                { "id": "off", "type": "sse", "name": "Off", "url": "http://127.0.0.1:2/sse",
                  "enabled": false }
            ]),
        );
        let app = app(registry, Some(store));

        for project in ["pa", "pb"] {
            // Authorized: it fails later, at discovery against a closed port.
            assert_eq!(
                code_of(&app, request("start", project, "http://127.0.0.1:1/mcp")).await,
                "OAUTH_START_FAILED",
                "{project}"
            );
        }
        for url in ["http://127.0.0.1:2/sse", "http://127.0.0.1:3/other"] {
            assert_eq!(
                code_of(&app, request("start", "pb", url)).await,
                "UNAUTHORIZED_SERVER_URL",
                "{url}"
            );
        }
    }

    #[tokio::test]
    async fn start_authorizes_nothing_without_a_stored_list() {
        let dir = tempfile::tempdir().unwrap();
        let registry = ProjectRegistry::with_roots_for_test(&[("pa", dir.path())]);
        let empty = Arc::new(
            WebStore::open(dir.path().join("store.json"), StorePolicy::default()).unwrap(),
        );
        for store in [None, Some(empty)] {
            let app = app(registry.clone(), store);
            assert_eq!(
                code_of(&app, request("start", "pa", "http://127.0.0.1:1/mcp")).await,
                "UNAUTHORIZED_SERVER_URL"
            );
        }
    }

    /// Unknown, archived and pathless projects are refused `NOT_FOUND` by
    /// start, status and disconnect alike.
    #[tokio::test]
    async fn unknown_archived_and_pathless_projects_are_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let registry = ProjectRegistry::with_roots_for_test(&[("archived", dir.path())]);
        assert!(registry.update("archived", None, None, Some(true)));
        registry.upsert(ProjectSummary {
            id: "nopath".to_string(),
            name: "No path".to_string(),
            color: "blue".to_string(),
            path: None,
            is_archived: false,
            is_default: false,
        });
        let store = store_with(
            dir.path(),
            json!([{ "id": "h", "type": "http", "name": "H", "url": "https://mcp.example.com" }]),
        );
        let app = app(registry, Some(store));

        for project in ["archived", "nopath", "never-registered", ""] {
            for route in ["start", "status", "disconnect"] {
                assert_eq!(
                    code_of(&app, request(route, project, "https://mcp.example.com")).await,
                    "NOT_FOUND",
                    "{route} {project}"
                );
            }
        }
    }
}
