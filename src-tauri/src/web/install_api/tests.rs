use super::*;
use crate::acp::install::AcpInstallService;
use crate::acp::AcpCatalogService;
use crate::web::ws::HistoryMode;
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode};
use axum::routing::post;
use std::net::SocketAddr;
use std::sync::Arc;
use tower::ServiceExt;

/// Loopback peer used by the `ConnectInfo<SocketAddr>` extractor in tests.
fn loopback_peer() -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], 54321))
}

/// Build a `POST /acp/install` request carrying the loopback
/// `ConnectInfo` extension the handler now requires.
fn install_request(body: &'static [u8]) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/acp/install")
        .header("content-type", "application/json")
        .extension(ConnectInfo(loopback_peer()))
        .body(Body::from(body.to_vec()))
        .expect("build request")
}

/// Temp directory removed on drop (including panic paths).
struct TempDir(std::path::PathBuf);
impl TempDir {
    fn new(label: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "termul-install-api-{label}-{}-{nanos}",
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
    let catalog = AcpCatalogService::open(root.join("catalog"))
        .await
        .expect("open catalog");
    let store = AcpInstallService::open(root.join("installs"), catalog)
        .await
        .expect("open install store");
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
        acp_install: Some(store),
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
        .route("/acp/install", post(super::install))
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
async fn install_degraded_returns_unavailable() {
    let state = state_without_store().await;
    let resp = test_router(state)
        .oneshot(install_request(br#"{"agentId":"opencode"}"#))
        .await
        .expect("router response");
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<InstallOutcome> = body_as_json(resp.into_body()).await;
    assert!(!body.success);
    assert_eq!(body.code.as_deref(), Some(code::ACP_INSTALL_UNAVAILABLE));
}

// ---- Loopback guard (CWE-306) ----

#[tokio::test]
async fn install_rejects_non_loopback_peer() {
    let dir = TempDir::new("install-remote-peer");
    let state = state_with_store(dir.path()).await;
    // A LAN peer on a `0.0.0.0` bind must not reach the install route.
    let resp = test_router(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/acp/install")
                .header("content-type", "application/json")
                .extension(ConnectInfo(SocketAddr::from(([10, 0, 0, 5], 54321))))
                .body(Body::from(br#"{"agentId":"opencode"}"#.to_vec()))
                .expect("build request"),
        )
        .await
        .expect("router response");
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<InstallOutcome> = body_as_json(resp.into_body()).await;
    assert!(!body.success);
    assert_eq!(body.code.as_deref(), Some("FORBIDDEN"));
}

/// `--allow-remote-writes`: a non-loopback peer is ADMITTED past the
/// loopback guard on `/acp/install` (proven by the request reaching
/// validation, not `FORBIDDEN`). Mirrors the refusal test with the flag on.
#[tokio::test]
async fn install_admits_non_loopback_peer_when_opt_in() {
    let dir = TempDir::new("install-opt-in");
    let mut state = state_with_store(dir.path()).await;
    state.allow_remote_writes = true;
    // An over-serialized body carrying an excluded field surfaces as
    // VALIDATION_ERROR ONLY if the guard admitted the peer — a refused
    // peer would return FORBIDDEN before any validation.
    let resp = test_router(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/acp/install")
                .header("content-type", "application/json")
                .extension(ConnectInfo(SocketAddr::from(([10, 0, 0, 5], 54321))))
                .body(Body::from(
                    br#"{"agentId":"opencode","extra":"junk"}"#.to_vec(),
                ))
                .expect("build request"),
        )
        .await
        .expect("router response");
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<InstallOutcome> = body_as_json(resp.into_body()).await;
    assert!(
        body.success || body.code.as_deref() != Some("FORBIDDEN"),
        "opt-in must admit non-loopback peer past the guard (got code={:?})",
        body.code
    );
    assert_eq!(
        body.code.as_deref(),
        Some(code::VALIDATION_ERROR),
        "admitted peer reaches validation, not the guard"
    );
}

// ---- deny_unknown_fields rejection ----

#[tokio::test]
async fn install_rejects_extra_field_as_validation_error() {
    let dir = TempDir::new("install-reject");
    let state = state_with_store(dir.path()).await;
    let resp = test_router(state)
        .oneshot(install_request(br#"{"agentId":"opencode","extra":"junk"}"#))
        .await
        .expect("router response");
    assert_eq!(
        resp.status(),
        StatusCode::OK,
        "deny_unknown_fields rejection must surface as 200 + IpcBody::err"
    );
    let body: IpcBody<InstallOutcome> = body_as_json(resp.into_body()).await;
    assert!(!body.success);
    assert_eq!(body.code.as_deref(), Some(code::VALIDATION_ERROR));
}

#[tokio::test]
async fn install_rejects_malformed_json() {
    let dir = TempDir::new("install-malformed");
    let state = state_with_store(dir.path()).await;
    let resp = test_router(state)
        .oneshot(install_request(b"{ not valid json"))
        .await
        .expect("router response");
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<InstallOutcome> = body_as_json(resp.into_body()).await;
    assert!(!body.success);
    assert_eq!(body.code.as_deref(), Some(code::VALIDATION_ERROR));
}

// ---- Empty agentId → VALIDATION_ERROR (via is_safe_agent_id) ----

#[tokio::test]
async fn install_rejects_empty_agent_id_as_validation_error() {
    let dir = TempDir::new("install-empty-id");
    let state = state_with_store(dir.path()).await;
    let resp = test_router(state)
        .oneshot(install_request(br#"{"agentId":""}"#))
        .await
        .expect("router response");
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<InstallOutcome> = body_as_json(resp.into_body()).await;
    assert!(!body.success);
    assert_eq!(body.code.as_deref(), Some(code::VALIDATION_ERROR));
}

// ---- Agent not in catalog → CATALOG_AGENT_NOT_FOUND ----

#[tokio::test]
async fn install_unknown_agent_returns_catalog_agent_not_found() {
    let dir = TempDir::new("install-unknown");
    let state = state_with_store(dir.path()).await;
    let resp = test_router(state)
        .oneshot(install_request(br#"{"agentId":"does-not-exist"}"#))
        .await
        .expect("router response");
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<InstallOutcome> = body_as_json(resp.into_body()).await;
    assert!(!body.success);
    assert_eq!(body.code.as_deref(), Some("CATALOG_AGENT_NOT_FOUND"));
}

// ---- Serde shape tests ----

#[test]
fn install_request_rejects_unknown_fields_serde() {
    let payload = serde_json::json!({ "agentId": "opencode", "extra": "junk" });
    let result: Result<InstallRequest, _> = serde_json::from_value(payload);
    assert!(result.is_err());
}

#[test]
fn install_outcome_serializes_camel_case() {
    let outcome = InstallOutcome {
        command: "/path/to/opencode".to_string(),
        args: vec!["acp".to_string()],
    };
    let value = serde_json::to_value(&outcome).unwrap();
    assert_eq!(value["command"], "/path/to/opencode");
    assert_eq!(value["args"][0], "acp");
}
