//! HTTP handler for the host-owned verified-atomic ACP install (CAP-6 / Story 9).
//!
//! Mirrors the desktop `#[tauri::command] acp_install_agent` handler over HTTP
//! so the web/remote client can install a catalog agent through the same
//! `IpcBody<T>` contract.
//!
//! - **`POST /acp/install`** — install an agent. Body: `{ agentId: string }`
//!   (`deny_unknown_fields` rejects extra fields loudly). The host resolves
//!   the agent by id from the catalog, downloads the HTTPS archive, verifies
//!   `sha256`, extracts safely, atomically activates, serializes per-agent,
//!   records the installed-agents manifest, and returns
//!   `{ command: absolute_path, args: string[] }`.
//!
//! The request carries ONLY `{ agentId }`; the host never accepts
//! browser-supplied URLs, commands, executable paths, or args — the trusted
//! catalog is the single source of both the archive URL and its expected
//! digest.
//!
//! Degrade-mode (`acp_install: None`) returns
//! `IpcBody::err(..., code::ACP_INSTALL_UNAVAILABLE)`. HTTP 200 for both success
//! AND app-level failures (mirrors `catalog_api.rs`); only transport/parse
//! failures become non-200 (renderer maps to `NETWORK_ERROR`).

use axum::{
    body::Bytes,
    extract::{ConnectInfo, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use std::net::SocketAddr;
use tracing::{info, warn};

use crate::acp::install::{code, InstallOutcome, InstallRequest};
use crate::web::fs_api::{check_local_only, IpcBody};
use crate::web::ws::AppState;

/// `POST /acp/install` — install a catalog agent.
///
/// Manual body deserialization so a `deny_unknown_fields` rejection surfaces as
/// 200 + `IpcBody::err(VALIDATION_ERROR)` — NOT a 4xx JsonRejection (which the
/// renderer would map to `NETWORK_ERROR`, masking the validation failure).
/// Mirrors the `catalog_api::set_opt_in` handler pattern.
///
/// Degrade-mode (`acp_install: None`) returns
/// `IpcBody::err(..., code::ACP_INSTALL_UNAVAILABLE)`.
///
/// Loopback-only guard (CWE-306): the install route mutates host state
/// (downloads + verifies + atomically activates an agent binary + records the
/// installed-agents manifest), so a LAN peer on a `0.0.0.0` bind must not
/// reach it. Mirrors the fs/git/workspace write routes' `check_local_only`.
pub async fn install(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    body: Bytes,
) -> impl IntoResponse {
    if let Some(forbidden) = check_local_only::<InstallOutcome>(peer, state.allow_remote_writes, state.shared_live_writes_denied, "/acp/install") {
        return (StatusCode::OK, Json(forbidden));
    }
    let req: InstallRequest = match serde_json::from_slice(&body) {
        Ok(req) => req,
        Err(error) => {
            warn!(
                target: "termul::web::install_api",
                session = crate::logging::session_id(),
                error = %error,
                "install: payload validation failed (deny_unknown_fields or malformed JSON)"
            );
            return (
                StatusCode::OK,
                Json(IpcBody::<InstallOutcome>::err(
                    format!("payload validation failed: {error}"),
                    code::VALIDATION_ERROR,
                )),
            );
        }
    };
    let Some(service) = state.acp_install.as_ref() else {
        return (
            StatusCode::OK,
            Json(IpcBody::<InstallOutcome>::err(
                "acp install store is unavailable",
                code::ACP_INSTALL_UNAVAILABLE,
            )),
        );
    };
    match service.install_by_id(&req.agent_id).await {
        Ok(outcome) => {
            info!(
                target: "termul::web::install_api",
                session = crate::logging::session_id(),
                agent = %req.agent_id,
                "install: success"
            );
            (StatusCode::OK, Json(IpcBody::ok(outcome)))
        }
        Err(error) => {
            let code = error.code();
            warn!(
                target: "termul::web::install_api",
                session = crate::logging::session_id(),
                agent = %req.agent_id,
                code,
                msg = %error.message,
                "install: failure"
            );
            (
                StatusCode::OK,
                Json(IpcBody::<InstallOutcome>::err(error.message, code)),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::AcpCatalogService;
    use crate::acp::install::AcpInstallService;
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
        AppState { acp: Arc::new(crate::acp::AcpManager::new(vec![])),
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
        pending_oauth_flows: std::sync::Arc::new(parking_lot::RwLock::new(std::collections::HashMap::new())),
        oauth_base_url: "http://127.0.0.1".to_string(),
        workspace_manifest: None,
        acp_catalog: None,
        acp_install: Some(store),
        store: None, allow_remote_writes: false, shared_live_writes_denied: false,  }
    }

    async fn state_without_store() -> AppState {
        let pty = crate::web::test_pty_manager();
        AppState { acp: Arc::new(crate::acp::AcpManager::new(vec![])),
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
        pending_oauth_flows: std::sync::Arc::new(parking_lot::RwLock::new(std::collections::HashMap::new())),
        oauth_base_url: "http://127.0.0.1".to_string(),
        workspace_manifest: None,
        acp_catalog: None,
        acp_install: None,
        store: None, allow_remote_writes: false, shared_live_writes_denied: false,  }
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
}
