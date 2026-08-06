//! Axum router for the ACP web server (standalone `termul-server` + desktop).
//!
//! Exposes `/health`, the live WS upgrade at `/ws`, and static serving of the
//! web client: from disk `ServeDir` in dev (`dist-web/` on disk) or the
//! embedded `rust-embed` bundle in release. The `/ws` route is registered
//! explicitly AHEAD of the static fallback so it is not shadowed by the static
//! mount (AC1).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::{
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Router,
};

use crate::acp::{AcpCatalogService, AcpManager, FileProjectRegistry, WorkspaceManifestService};
use crate::pty::PtyManager;
use crate::trackers::{CwdTracker, ExitCodeTracker, GitTracker, TerminalEventHub};
use crate::web::catalog_api;
use crate::web::fs_api;
use crate::web::git_api;
use crate::web::log_api;
use crate::web::mcp_probe_api;
use crate::web::mcp_servers_api;
use crate::web::search_api;
use crate::web::skills_api;
use crate::web::project_registry::ProjectRegistry;
use crate::web::projects_api;
use crate::web::sink::WsRelaySink;
use crate::web::terminal_ws::terminal_ws_upgrade;
use crate::web::workspace_api;
use crate::web::ws::{ws_upgrade, AppState, HistoryMode};

use super::assets;

/// Build the ACP web-server Axum router (serves the web client + WS + health).
///
/// `ws_relay` is threaded into the router state so `/ws` can subscribe clients
/// and replay cursors (Story 1.4). The `/ws` + `/health` routes are registered
/// BEFORE the static fallback so the static mount cannot shadow them (AC1).
///
/// `project_root` (PR-S4) is the boundary the fs_api routes enforce — see
/// `crate::web::fs_api::check_within_root`. Resolved by the caller from
/// `ServerConfig::project_root` (or its default).
///
/// The static fallback serves from disk `ServeDir` in dev (`dist-web/` on disk)
/// or from the embedded `Assets` bundle in release — see
/// [`assets::static_fallback`].
#[allow(clippy::too_many_arguments)]
pub fn router(
    acp: Arc<AcpManager>,
    pty: Arc<PtyManager>,
    terminal_events: TerminalEventHub,
    cwd_tracker: Arc<CwdTracker>,
    git_tracker: Arc<GitTracker>,
    exit_code_tracker: Arc<ExitCodeTracker>,
    ws_relay: Arc<WsRelaySink>,
    registry: Arc<ProjectRegistry>,
    registry_persistence: Option<Arc<parking_lot::Mutex<FileProjectRegistry>>>,
    projects_file: Option<PathBuf>,
    project_root: PathBuf,
    history_mode: HistoryMode,
    workspace_manifest: Option<Arc<WorkspaceManifestService>>,
    acp_catalog: Option<Arc<AcpCatalogService>>,
) -> Router {
    let mut r = Router::new()
        .route("/health", get(health_check))
        .route("/ws", get(ws_upgrade))
        .route("/terminal/ws", get(terminal_ws_upgrade))
        // Project list mirror (Epic-4 bridge): the web client reads the
        // desktop's non-archived + archived projects here. Registered AHEAD of
        // the static fallback so the SPA mount cannot shadow it.
        .route("/projects", get(projects_api::list))
        // Explicit host-default change (Epic 7 — cross-client workspace
        // continuity). Mirrors the `set_default_project` WS request + the
        // `set_host_default_project` Tauri command (transport parity).
        .route("/projects/default", post(projects_api::set_default_project))
        .route(
            "/mcp-servers",
            get(mcp_servers_api::get).put(mcp_servers_api::put),
        )
        // On-demand MCP client probe (web parity): runs on the termul-server
        // host where stdio commands execute. Mirrors the `acp_probe_mcp_server`
        // Tauri command; returns the same `IpcBody<ProbeResult>` shape.
        .route("/mcp-servers/probe", post(mcp_probe_api::probe))
        // Project-creation fs/git/shell routes (Story: Web/remote project
        // creation). Registered AHEAD of the static fallback so `/health` +
        // `/ws` keep priority and the SPA fallback cannot shadow them.
        .route("/fs/mkdir", post(fs_api::mkdir))
        .route("/fs/write", post(fs_api::write))
        .route("/fs/ls", get(fs_api::ls))
        .route("/fs/browse", get(fs_api::browse))
        .route("/fs/read", get(fs_api::read))
        .route("/fs/delete", post(fs_api::delete))
        .route("/fs/rename", post(fs_api::rename))
        .route("/fs/copy", post(fs_api::copy))
        .route("/git/init", post(fs_api::git_init))
        // Git web routes (CAP-1: Web & Mobile 1:1 Parity). Each mirrors a
        // desktop `#[tauri::command] git_*` handler; see `web/git_api.rs`.
        // Registered AHEAD of the static fallback so the SPA mount cannot
        // shadow them. Write routes are loopback-guarded inside the handler.
        .route("/git/status", post(git_api::get_status))
        .route("/git/diff", post(git_api::get_diff))
        .route("/git/stage", post(git_api::stage))
        .route("/git/unstage", post(git_api::unstage))
        .route("/git/discard", post(git_api::discard))
        .route("/git/log", post(git_api::get_log))
        .route("/git/commit", post(git_api::commit))
        .route("/git/push", post(git_api::push))
        .route("/git/commit-context", post(git_api::get_commit_context))
        .route("/git/checkout-branch", post(git_api::checkout_branch))
        .route("/git/create-branch", post(git_api::create_branch))
        .route("/git/stash-save", post(git_api::stash_save))
        .route("/git/stash-list", get(git_api::stash_list))
        .route("/git/stash-apply", post(git_api::stash_apply))
        .route("/git/stash-pop", post(git_api::stash_pop))
        .route("/git/stash-drop", post(git_api::stash_drop))
        .route("/git/branch-list", get(git_api::branch_list))
        .route("/git/branch-switch", post(git_api::branch_switch))
        .route("/git/branch-create", post(git_api::branch_create))
        // Search web routes (CAP-2: Web & Mobile 1:1 Parity). Each mirrors a
        // desktop `#[tauri::command] search_*` handler; see `web/search_api.rs`.
        .route("/search/rg-info", get(search_api::rg_info))
        .route("/search/content", post(search_api::content))
        .route("/search/cancel", post(search_api::cancel))
        // Skills web routes (CAP-2): `GET /skills` + `GET /skills/:name`.
        .route("/skills", get(skills_api::list))
        .route("/skills/{name}", get(skills_api::read))
        // Frontend error forwarding (CAP-2): `POST /log/frontend-error`.
        // Loopback-only (enforced inside the handler).
        .route("/log/frontend-error", post(log_api::frontend_error))
        .route("/shells", get(fs_api::shells))
        // Workspace manifest web routes (CAP-5: Web & Mobile 1:1 Parity).
        // Each mirrors a desktop `#[tauri::command] workspace_manifest_*`
        // handler; see `web/workspace_api.rs`. Registered AHEAD of the static
        // fallback so the SPA mount cannot shadow them. Write + delete are
        // loopback-guarded inside the handler.
        .route("/workspace/{projectId}", get(workspace_api::get))
        .route("/workspace/{projectId}/write", post(workspace_api::write))
        .route("/workspace/{projectId}/delete", post(workspace_api::delete))
        // ACP catalog web routes (CAP-6: Web & Mobile 1:1 Parity). Each
        // mirrors a desktop `#[tauri::command] acp_*_catalog` handler; see
        // `web/catalog_api.rs`. Registered AHEAD of the static fallback so
        // the SPA mount cannot shadow them. The read `GET` is open (read-only
        // host introspection, mirrors `GET /projects`); the `POST` opt-in
        // mirrors `set_default_project` posture (any connected client until
        // Epic 2).
        .route("/acp/catalog", get(catalog_api::list))
        .route("/acp/catalog/opt-in", post(catalog_api::set_opt_in));
    // Static fallback: disk ServeDir in dev (dist-web/ on disk) or the embedded
    // bundle in release. `/health` + `/ws` are registered above so the static
    // mount cannot shadow them (Story 1.3 AC1).
    if assets::dist_web_ready() {
        r = r.fallback_service(assets::static_service());
    } else {
        r = r.fallback(assets::serve_embedded);
    }
    r.with_state(AppState {
        acp,
        pty,
        terminal_events,
        cwd_tracker,
        git_tracker,
        exit_code_tracker,
        relay: ws_relay,
        registry,
        registry_persistence,
        projects_file: projects_file.map(Arc::new),
        history_mode,
        workspace_manifest,
        acp_catalog,
        project_root: Arc::new(project_root),
    })
}

/// Same as [`router`], but with an injectable static-root for unit tests.
///
/// Patch 9: this variant ALWAYS sets `workspace_manifest: None` so the
/// `/workspace/*` routes run in degraded fresh-only mode (get → `Ok(None)`;
/// write → `WORKSPACE_MANIFEST_UNAVAILABLE`; delete → `Ok(())`). It is
/// intended for tests/dev only — production callers must use [`router`]
/// (which threads the real `WorkspaceManifestService`) so the web/remote
/// client gets a live manifest store. Adding a `workspace_manifest`
/// parameter here would break every test call site for no real benefit
/// (the tests do not exercise the manifest routes); the doc comment
/// surfaces the degraded behavior loudly enough that a production caller
/// won't silently pick this variant.
pub fn router_with_static(
    acp: Arc<AcpManager>,
    pty: Arc<PtyManager>,
    ws_relay: Arc<WsRelaySink>,
    registry: Arc<ProjectRegistry>,
    static_dir: &Path,
    project_root: PathBuf,
) -> Router {
    Router::new()
        .route("/health", get(health_check))
        .route("/ws", get(ws_upgrade))
        .route("/terminal/ws", get(terminal_ws_upgrade))
        .route("/projects", get(projects_api::list))
        .route("/projects/default", post(projects_api::set_default_project))
        .route(
            "/mcp-servers",
            get(mcp_servers_api::get).put(mcp_servers_api::put),
        )
        .route("/mcp-servers/probe", post(mcp_probe_api::probe))
        .route("/fs/mkdir", post(fs_api::mkdir))
        .route("/fs/write", post(fs_api::write))
        .route("/fs/ls", get(fs_api::ls))
        .route("/fs/browse", get(fs_api::browse))
        .route("/fs/read", get(fs_api::read))
        .route("/fs/delete", post(fs_api::delete))
        .route("/fs/rename", post(fs_api::rename))
        .route("/fs/copy", post(fs_api::copy))
        .route("/git/init", post(fs_api::git_init))
        .route("/git/status", post(git_api::get_status))
        .route("/git/diff", post(git_api::get_diff))
        .route("/git/stage", post(git_api::stage))
        .route("/git/unstage", post(git_api::unstage))
        .route("/git/discard", post(git_api::discard))
        .route("/git/log", post(git_api::get_log))
        .route("/git/commit", post(git_api::commit))
        .route("/git/push", post(git_api::push))
        .route("/git/commit-context", post(git_api::get_commit_context))
        .route("/git/checkout-branch", post(git_api::checkout_branch))
        .route("/git/create-branch", post(git_api::create_branch))
        .route("/git/stash-save", post(git_api::stash_save))
        .route("/git/stash-list", get(git_api::stash_list))
        .route("/git/stash-apply", post(git_api::stash_apply))
        .route("/git/stash-pop", post(git_api::stash_pop))
        .route("/git/stash-drop", post(git_api::stash_drop))
        .route("/git/branch-list", get(git_api::branch_list))
        .route("/git/branch-switch", post(git_api::branch_switch))
        .route("/git/branch-create", post(git_api::branch_create))
        .route("/search/rg-info", get(search_api::rg_info))
        .route("/search/content", post(search_api::content))
        .route("/search/cancel", post(search_api::cancel))
        .route("/skills", get(skills_api::list))
        .route("/skills/{name}", get(skills_api::read))
        .route("/log/frontend-error", post(log_api::frontend_error))
        .route("/shells", get(fs_api::shells))
        .route("/workspace/{projectId}", get(workspace_api::get))
        .route("/workspace/{projectId}/write", post(workspace_api::write))
        .route("/workspace/{projectId}/delete", post(workspace_api::delete))
        .route("/acp/catalog", get(catalog_api::list))
        .route("/acp/catalog/opt-in", post(catalog_api::set_opt_in))
        .fallback_service(assets::static_service_from(static_dir))
        .with_state(AppState {
            acp,
            terminal_events: pty.terminal_events(),
            cwd_tracker: pty.cwd_tracker(),
            git_tracker: pty.git_tracker(),
            exit_code_tracker: pty.exit_code_tracker(),
            pty,
            relay: ws_relay,
            registry,
            registry_persistence: None,
            projects_file: None,
            history_mode: HistoryMode::LiveOnly,
            workspace_manifest: None,
            acp_catalog: None,
            project_root: Arc::new(project_root),
        })
}

/// Liveness probe for the ACP web server.
async fn health_check() -> impl IntoResponse {
    (StatusCode::OK, "OK")
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tower::ServiceExt;

    /// Temp directory removed on drop (including panic paths).
    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(label: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let path = std::env::temp_dir().join(format!("termul-web-assets-{label}-{nanos}"));
            fs::create_dir_all(&path).expect("create temp dir");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn test_router_with_fixture(dir: &Path) -> Router {
        // PR-S4: `router_with_static` now requires a project root for the
        // fs_api boundary. The fixture tests under `assets.rs` only exercise
        // `/health` and `/ws` (no fs routes), so any existing directory works;
        // we pass the OS temp dir for symmetry with the legacy default.
        router_with_static(
            Arc::new(AcpManager::new(vec![])),
            crate::web::test_pty_manager(),
            Arc::new(WsRelaySink::new()),
            Arc::new(crate::web::project_registry::ProjectRegistry::new()),
            dir,
            std::env::temp_dir(),
        )
    }

    #[tokio::test]
    async fn health_returns_ok() {
        let dir = TempDir::new("health");
        let resp = test_router_with_fixture(dir.path())
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("read body");
        assert_eq!(&body[..], b"OK");
    }

    #[tokio::test]
    async fn ws_route_no_longer_returns_501_placeholder() {
        let dir = TempDir::new("ws");
        let resp = test_router_with_fixture(dir.path())
            .oneshot(
                Request::builder()
                    .uri("/ws")
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        // Story 1.4: /ws is now a live WS upgrade handler. A non-WS GET (no
        // Upgrade headers) is rejected with a 4xx (400/426) — NOT the old 501
        // placeholder (AC1).
        assert_ne!(
            resp.status(),
            StatusCode::NOT_IMPLEMENTED,
            "/ws must not return the old 501 placeholder"
        );
        assert!(
            resp.status().is_client_error(),
            "/ws non-WS request should be a 4xx rejection, got {}",
            resp.status()
        );
    }

    #[tokio::test]
    async fn root_serves_index_html_from_fixture() {
        let dir = TempDir::new("root");
        fs::write(
            dir.path().join("index.html"),
            "<!doctype html><html><body>termul-web-fixture</body></html>",
        )
        .expect("write index.html");
        fs::create_dir_all(dir.path().join("assets")).expect("assets dir");
        fs::write(dir.path().join("assets/app.js"), "console.log('fixture');")
            .expect("write asset");

        let app = test_router_with_fixture(dir.path());

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/")
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("read body");
        let text = String::from_utf8_lossy(&body);
        assert!(
            text.contains("termul-web-fixture"),
            "expected fixture marker in body, got: {text}"
        );

        let asset = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/assets/app.js")
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("asset response");
        assert_eq!(asset.status(), StatusCode::OK);

        // SPA fallback: unmatched path still returns index.html
        let spa = app
            .oneshot(
                Request::builder()
                    .uri("/some/deep/client-route")
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("spa response");
        assert_eq!(spa.status(), StatusCode::OK);
        let spa_body = axum::body::to_bytes(spa.into_body(), usize::MAX)
            .await
            .expect("read spa body");
        assert!(String::from_utf8_lossy(&spa_body).contains("termul-web-fixture"));
    }

    #[tokio::test]
    async fn missing_dist_web_yields_404_not_503_stub() {
        let dir = TempDir::new("missing");
        // Empty dir — no index.html
        let resp = test_router_with_fixture(dir.path())
            .oneshot(
                Request::builder()
                    .uri("/")
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("read body");
        let text = String::from_utf8_lossy(&body);
        assert!(
            !text.contains("Static bundle not embedded yet"),
            "must not return the old 503 stub text, got: {text}"
        );
    }

    #[tokio::test]
    async fn nonexistent_static_root_yields_404() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let missing = std::env::temp_dir().join(format!("termul-web-assets-absent-{nanos}"));
        assert!(!missing.exists(), "path must not exist");

        let resp = test_router_with_fixture(&missing)
            .oneshot(
                Request::builder()
                    .uri("/")
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn api_routes_keep_priority_over_static_fallback() {
        let dir = TempDir::new("priority");
        fs::write(dir.path().join("index.html"), "<html>fixture</html>").expect("index");
        // Even if someone drops health.html, /health must stay the probe.
        fs::write(dir.path().join("health"), "not-the-probe").expect("health file");

        let resp = test_router_with_fixture(dir.path())
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("read body");
        assert_eq!(&body[..], b"OK");
    }
}
