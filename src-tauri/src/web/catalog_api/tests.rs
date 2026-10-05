use super::*;
use crate::acp::AcpCatalogService;
use crate::web::ws::HistoryMode;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::routing::{get, post};
use std::sync::Arc;
use tower::ServiceExt;

/// Temp directory removed on drop (including panic paths).
struct TempDir(std::path::PathBuf);
impl TempDir {
    fn new(label: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "termul-catalog-api-{label}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).expect("create temp dir");
        Self(path)
    }
    fn path(&self) -> &std::path::Path {
        &self.0
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn state_with_store(root: &std::path::Path) -> AppState {
    let store = AcpCatalogService::open(root.join("catalog"))
        .await
        .expect("open store");
    let pty = crate::web::test_pty_manager();
    AppState {
        acp: Arc::new(crate::acp::AcpManager::new(vec![])),
        terminal_events: pty.terminal_events(),
        cwd_tracker: pty.cwd_tracker(),
        git_tracker: pty.git_tracker(),
        exit_code_tracker: pty.exit_code_tracker(),
        pty,
        relay: Arc::new(crate::web::sink::WsRelaySink::new()),
        registry: Arc::new(crate::web::project_registry::ProjectRegistry::new()),
        registry_persistence: None,
        projects_file: None,
        history_mode: HistoryMode::LiveOnly,
        project_root: Arc::new(parking_lot::RwLock::new(std::env::temp_dir())),
        pending_oauth_flows: std::sync::Arc::new(parking_lot::RwLock::new(
            std::collections::HashMap::new(),
        )),
        oauth_base_url: "http://127.0.0.1".to_string(),
        workspace_manifest: None,
        acp_catalog: Some(store),
        acp_install: None,
        store: None,
        web_auth: None,
        allow_remote_writes: false,
        shared_live_writes_denied: false,
    }
}

async fn state_without_store() -> AppState {
    let pty = crate::web::test_pty_manager();
    AppState {
        acp: Arc::new(crate::acp::AcpManager::new(vec![])),
        terminal_events: pty.terminal_events(),
        cwd_tracker: pty.cwd_tracker(),
        git_tracker: pty.git_tracker(),
        exit_code_tracker: pty.exit_code_tracker(),
        pty,
        relay: Arc::new(crate::web::sink::WsRelaySink::new()),
        registry: Arc::new(crate::web::project_registry::ProjectRegistry::new()),
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
    }
}

fn test_router(state: AppState) -> axum::Router {
    axum::Router::new()
        .route("/acp/catalog", get(super::list))
        .route("/acp/catalog/opt-in", post(set_opt_in))
        .with_state(state)
}

async fn body_as_json<T: serde::de::DeserializeOwned>(body: Body) -> T {
    let bytes = axum::body::to_bytes(body, usize::MAX)
        .await
        .expect("read body");
    serde_json::from_slice(&bytes).expect("deserialize IpcBody")
}

// ---- Degraded mode (None store) ----

#[tokio::test]
async fn get_catalog_degraded_returns_unavailable() {
    let state = state_without_store().await;
    let resp = test_router(state)
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/acp/catalog")
                .body(Body::empty())
                .expect("build request"),
        )
        .await
        .expect("router response");
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<AcpCatalog> = body_as_json(resp.into_body()).await;
    assert!(!body.success);
    assert_eq!(body.code.as_deref(), Some("ACP_CATALOG_UNAVAILABLE"));
}

#[tokio::test]
async fn set_opt_in_degraded_returns_unavailable() {
    let state = state_without_store().await;
    let loopback = std::net::SocketAddr::from(([127, 0, 0, 1], 54321));
    let resp = test_router(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/acp/catalog/opt-in")
                .header("content-type", "application/json")
                .extension(ConnectInfo(loopback))
                .body(Body::from(br#"{"enabled":true}"#.to_vec()))
                .expect("build request"),
        )
        .await
        .expect("router response");
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(!body.success);
    assert_eq!(body.code.as_deref(), Some("ACP_CATALOG_UNAVAILABLE"));
}

// ---- Happy path ----

#[tokio::test]
async fn get_catalog_happy_path_returns_resolved_catalog() {
    let dir = TempDir::new("get-happy");
    let state = state_with_store(dir.path()).await;
    let resp = test_router(state)
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/acp/catalog")
                .body(Body::empty())
                .expect("build request"),
        )
        .await
        .expect("router response");
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<AcpCatalog> = body_as_json(resp.into_body()).await;
    assert!(body.success, "catalog get must succeed");
    let catalog = body.data.unwrap();
    assert!(!catalog.agents.is_empty(), "bundled catalog is not empty");
    // Host capability present.
    assert!(!catalog.host.os.is_empty());
    assert!(!catalog.host.arch.is_empty());
    // Runtimes present.
    // Every agent has the expected fields.
    for agent in &catalog.agents {
        assert!(!agent.id.is_empty());
        assert!(!agent.name.is_empty());
        assert!(!agent.version.is_empty());
    }
}

#[tokio::test]
async fn get_catalog_with_refresh_query_force_refreshes() {
    let dir = TempDir::new("get-refresh");
    let state = state_with_store(dir.path()).await;
    let resp = test_router(state)
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/acp/catalog?refresh=true")
                .body(Body::empty())
                .expect("build request"),
        )
        .await
        .expect("router response");
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<AcpCatalog> = body_as_json(resp.into_body()).await;
    assert!(body.success);
}

#[tokio::test]
async fn set_opt_in_happy_path_persists_flag() {
    let dir = TempDir::new("set-opt-in");
    let state = state_with_store(dir.path()).await;
    let loopback = std::net::SocketAddr::from(([127, 0, 0, 1], 54321));
    let resp = test_router(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/acp/catalog/opt-in")
                .header("content-type", "application/json")
                .extension(ConnectInfo(loopback))
                .body(Body::from(br#"{"enabled":true}"#.to_vec()))
                .expect("build request"),
        )
        .await
        .expect("router response");
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(body.success, "set_opt_in must succeed");
    // Verify the flag was persisted.
    let service = state.acp_catalog.as_ref().unwrap();
    assert!(service.is_opt_in(), "opt-in should be true after POST");
}

#[tokio::test]
async fn set_opt_in_rejects_extra_field_as_validation_error() {
    let dir = TempDir::new("set-opt-in-reject");
    let state = state_with_store(dir.path()).await;
    let loopback = std::net::SocketAddr::from(([127, 0, 0, 1], 54321));
    let resp = test_router(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/acp/catalog/opt-in")
                .header("content-type", "application/json")
                .extension(ConnectInfo(loopback))
                .body(Body::from(br#"{"enabled":true,"extra":"junk"}"#.to_vec()))
                .expect("build request"),
        )
        .await
        .expect("router response");
    assert_eq!(
        resp.status(),
        StatusCode::OK,
        "deny_unknown_fields rejection must surface as 200 + IpcBody::err (Patch 1)"
    );
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(!body.success);
    assert_eq!(body.code.as_deref(), Some("VALIDATION_ERROR"));
}

/// F-005 regression: the opt-in POST is a host-state write — a
/// non-loopback peer without `--allow-remote-writes` must be refused
/// (FORBIDDEN) and the flag must not change. Previously the route had no
/// guard, so any remote client could flip the persistent CDN-augmentation
/// opt-in.
#[tokio::test]
async fn set_opt_in_refused_from_non_loopback_peer() {
    let dir = TempDir::new("set-opt-in-guard");
    let state = state_with_store(dir.path()).await;
    let remote = std::net::SocketAddr::from(([192, 168, 1, 50], 40000));
    let resp = test_router(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/acp/catalog/opt-in")
                .header("content-type", "application/json")
                .extension(ConnectInfo(remote))
                .body(Body::from(br#"{"enabled":true}"#.to_vec()))
                .expect("build request"),
        )
        .await
        .expect("router response");
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(!body.success, "remote peer must be refused");
    assert_eq!(body.code.as_deref(), Some("FORBIDDEN"));
    // The flag must still be off — the guard fired before the mutation.
    let service = state.acp_catalog.as_ref().unwrap();
    assert!(
        !service.is_opt_in(),
        "guard must fire before opt-in persists"
    );
}

#[tokio::test]
async fn set_opt_in_rejects_malformed_json() {
    let dir = TempDir::new("set-opt-in-malformed");
    let state = state_with_store(dir.path()).await;
    let loopback = std::net::SocketAddr::from(([127, 0, 0, 1], 54321));
    let resp = test_router(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/acp/catalog/opt-in")
                .header("content-type", "application/json")
                .extension(ConnectInfo(loopback))
                .body(Body::from(b"{ not valid json".to_vec()))
                .expect("build request"),
        )
        .await
        .expect("router response");
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(!body.success);
    assert_eq!(body.code.as_deref(), Some("VALIDATION_ERROR"));
}

// ---- Serde shape tests ----

#[test]
fn acp_catalog_wire_shape_is_camel_case() {
    let catalog = AcpCatalog {
        host: crate::acp::HostCapability {
            os: "linux".to_string(),
            arch: "x86_64".to_string(),
            runtimes: crate::acp::CatalogRuntimeAvailability {
                npx: true,
                uvx: false,
                node: true,
                bun: false,
                python3: true,
                npm: true,
                node_major: Some(22),
                claude_cli: true,
                unavailable_reason: None,
            },
        },
        agents: vec![crate::acp::CatalogAgent {
            id: "test".to_string(),
            name: "Test".to_string(),
            version: "1.0.0".to_string(),
            description: "test".to_string(),
            source: crate::acp::CatalogSource::Bundled,
            distribution: serde_json::json!({ "npx": { "package": "test@1.0.0" } }),
            runtime_requirements: vec!["npx".to_string()],
            status: crate::acp::SupportedAcpAgentStatus::Ready,
            platform_targets: vec![crate::acp::PlatformTarget {
                os: "linux".to_string(),
                arch: "x86_64".to_string(),
            }],
            installed: None,
        }],
    };
    let value = serde_json::to_value(&catalog).unwrap();
    // camelCase fields.
    assert!(value["host"]["runtimes"]["npx"].is_boolean());
    assert!(value["agents"][0]["runtimeRequirements"].is_array());
    assert!(value["agents"][0]["platformTargets"].is_array());
    assert_eq!(value["agents"][0]["status"], "ready");
    assert_eq!(value["agents"][0]["source"], "bundled");
}
