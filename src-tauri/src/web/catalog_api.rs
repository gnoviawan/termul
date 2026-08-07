//! HTTP handlers for the host-owned ACP catalog (CAP-6 / Story 8).
//!
//! Mirrors the desktop `#[tauri::command] acp_list_catalog` +
//! `acp_set_catalog_opt_in` handlers over HTTP so the web/remote client can
//! resolve the catalog through the same `IpcBody<T>` contract.
//!
//! - **`GET /acp/catalog`** — list the resolved catalog. Optional
//!   `?refresh=true` query forces a fresh probe (bypassing the 60s TTL).
//! - **`POST /acp/catalog/opt-in`** — set the host opt-in flag that gates the
//!   CDN registry augmentation. Body: `{ enabled: boolean }`
//!   (`deny_unknown_fields` rejects extra fields loudly).
//!
//! The read `GET` is open (no loopback guard — mirrors `GET /projects`:
//! read-only host introspection). The opt-in `POST` mirrors the
//! `set_default_project` posture (any connected client until Epic 2 wires auth).
//!
//! Degrade-mode (`acp_catalog: None`) returns `IpcBody::err(...,
//! "ACP_CATALOG_UNAVAILABLE")`.

use axum::{
    body::Bytes,
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use tracing::{debug, info, warn};

use crate::acp::{AcpCatalog, SetCatalogOptInRequest};
use crate::web::fs_api::IpcBody;
use crate::web::ws::AppState;

/// `GET /acp/catalog?refresh=true` query params.
#[derive(Debug, Deserialize)]
pub struct CatalogQuery {
    /// When `true`, force-refresh the probe cache (bypass the 60s TTL). When
    /// absent / `false`, serve the cached catalog if fresh.
    #[serde(default)]
    pub refresh: Option<bool>,
}

/// `GET /acp/catalog` — list the resolved ACP catalog.
///
/// Returns the host's OS/arch/runtime availability + per-agent resolved
/// `SupportedAcpAgentStatus`. The catalog is credential-free, path-free,
/// read-only host introspection — never carries `AgentConfig.env` (API keys)
/// or resolved absolute executable paths. The web client never probes
/// `@tauri-apps/plugin-os` or PATH locally — the host is the single source of
/// truth.
///
/// Degrade-mode (`acp_catalog: None`) returns
/// `IpcBody::err(..., "ACP_CATALOG_UNAVAILABLE")`.
pub async fn list(
    State(state): State<AppState>,
    Query(query): Query<CatalogQuery>,
) -> impl IntoResponse {
    let refresh = query.refresh.unwrap_or(false);
    let Some(service) = state.acp_catalog.as_ref() else {
        // Degraded mode — no host store attached.
        return (
            StatusCode::OK,
            Json(IpcBody::<AcpCatalog>::err(
                "acp catalog store is unavailable",
                "ACP_CATALOG_UNAVAILABLE",
            )),
        );
    };
    match service.list_catalog(refresh).await {
        Ok(mut catalog) => {
            // Overlay host-installed state so installed agents report `ready`
            // with their resolved command/args — the host is the single
            // source of truth (the web has no renderer persistence).
            if let Some(install) = state.acp_install.as_ref() {
                let installed = install.installed_agents();
                crate::acp::overlay_installed(&mut catalog, &installed);
            }
            debug!(
                target: "termul::web::catalog_api",
                agents = catalog.agents.len(),
                "get: resolved catalog"
            );
            (StatusCode::OK, Json(IpcBody::ok(catalog)))
        }
        Err(error) => {
            warn!(
                target: "termul::web::catalog_api",
                error = %error,
                "get: catalog resolution failed"
            );
            (
                StatusCode::OK,
                Json(IpcBody::<AcpCatalog>::err(
                    error.to_string(),
                    "CATALOG_LOAD_FAILED",
                )),
            )
        }
    }
}

/// `POST /acp/catalog/opt-in` — set the host opt-in flag.
///
/// Body: `SetCatalogOptInRequest { enabled: boolean }` with
/// `deny_unknown_fields` so an over-serialized payload (`{ enabled: true,
/// extra: "junk" }`) is rejected loudly as `VALIDATION_ERROR` (NOT silently
/// dropped). The opt-in gates the CDN registry augmentation: when enabled,
/// the next `GET /acp/catalog` includes CDN entries tagged
/// `source: 'registry'` (if the fetch succeeds); when disabled, only bundled
/// entries are served.
///
/// Degrade-mode (`acp_catalog: None`) returns
/// `IpcBody::err(..., "ACP_CATALOG_UNAVAILABLE")`.
///
/// Manual body deserialization so a `deny_unknown_fields` rejection surfaces
/// as 200 + `IpcBody::err(VALIDATION_ERROR)` — NOT a 4xx JsonRejection (which
/// the renderer would map to `NETWORK_ERROR`, masking the validation failure).
/// Mirrors the `workspace_api::write` handler pattern.
pub async fn set_opt_in(
    State(state): State<AppState>,
    body: Bytes,
) -> impl IntoResponse {
    let req: SetCatalogOptInRequest = match serde_json::from_slice(&body) {
        Ok(req) => req,
        Err(error) => {
            warn!(
                target: "termul::web::catalog_api",
                error = %error,
                "set_opt_in: payload validation failed (deny_unknown_fields or malformed JSON)"
            );
            return (
                StatusCode::OK,
                Json(IpcBody::<()>::err(
                    format!("payload validation failed: {error}"),
                    "VALIDATION_ERROR",
                )),
            );
        }
    };
    let Some(service) = state.acp_catalog.as_ref() else {
        return (
            StatusCode::OK,
            Json(IpcBody::<()>::err(
                "acp catalog store is unavailable",
                "ACP_CATALOG_UNAVAILABLE",
            )),
        );
    };
    match service.set_opt_in(req.enabled) {
        Ok(()) => {
            info!(
                target: "termul::web::catalog_api",
                enabled = req.enabled,
                "set_opt_in: persisted"
            );
            (StatusCode::OK, Json(IpcBody::<()>::ok(())))
        }
        Err(error) => {
            warn!(
                target: "termul::web::catalog_api",
                error = %error,
                "set_opt_in: persistence failed"
            );
            (
                StatusCode::OK,
                Json(IpcBody::<()>::err(
                    error.to_string(),
                    "ACP_CATALOG_OPT_IN_FAILED",
                )),
            )
        }
    }
}

#[cfg(test)]
mod tests {
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
            workspace_manifest: None,
            acp_catalog: Some(store),
            acp_install: None,
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
            workspace_manifest: None,
            acp_catalog: None,
            acp_install: None,
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
        let resp = test_router(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/acp/catalog/opt-in")
                    .header("content-type", "application/json")
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
        let resp = test_router(state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/acp/catalog/opt-in")
                    .header("content-type", "application/json")
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

    // ---- deny_unknown_fields rejection ----

    #[tokio::test]
    async fn set_opt_in_rejects_extra_field_as_validation_error() {
        let dir = TempDir::new("set-opt-in-reject");
        let state = state_with_store(dir.path()).await;
        let resp = test_router(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/acp/catalog/opt-in")
                    .header("content-type", "application/json")
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

    #[tokio::test]
    async fn set_opt_in_rejects_malformed_json() {
        let dir = TempDir::new("set-opt-in-malformed");
        let state = state_with_store(dir.path()).await;
        let resp = test_router(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/acp/catalog/opt-in")
                    .header("content-type", "application/json")
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
}
