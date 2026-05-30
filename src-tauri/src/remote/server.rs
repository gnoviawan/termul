//! Remote terminal server – Axum 0.8 HTTP + WebSocket lifecycle.
//!
//! Manages the embedded HTTP server that provides remote terminal access:
//! - Serves the xterm.js web client from an embedded HTML file
//! - WebSocket bridge to live PTY I/O with scrollback replay (persistence)
//! - REST API to browse projects → terminals and request new terminals
//! - Lifecycle (start/stop) integrates with Tauri app shutdown
//!
//! ## Access model (no token)
//!
//! The server is reachable by `ip:port` alone (no auth token). CSWSH is
//! prevented by same-origin validation in the WebSocket handler
//! (`auth::validate_same_origin`). It binds to `127.0.0.1` by default; exposing
//! it remotely (e.g. via a tunnel) is the operator's decision and risk.
//!
//! ## Project tree
//!
//! "Projects" are a renderer-side concept (Zustand). The desktop app publishes
//! its current project→terminal tree into [`ProjectRegistry`] via a Tauri
//! command; the web client reads it from `GET /api/projects`. Requests to add a
//! terminal (`POST /api/spawn`) are forwarded to the renderer as a Tauri event,
//! which performs the real spawn through the existing pipeline.

use crate::pty::PtyManager;
use crate::remote::auth::ConnectionTracker;
use crate::remote::registry::ProjectRegistry;
use crate::remote::ws::{ws_upgrade, WsState};
use axum::{
    extract::{FromRef, State},
    http::{header, StatusCode},
    response::{Html, IntoResponse},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tracing::{error, info};

/// Max concurrent WebSocket clients per terminal.
const MAX_CONNECTIONS_PER_TERMINAL: usize = 10;

/// Event emitted to the renderer when a web client requests a new terminal.
pub const EVENT_REMOTE_SPAWN_REQUEST: &str = "remote://spawn-request";

/// Information about a terminal exposed via the REST API.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSummary {
    pub id: String,
    pub shell: String,
    pub cwd: String,
    pub pid: u32,
    pub cols: u16,
    pub rows: u16,
}

/// Body of `POST /api/spawn` — request to open a new terminal in a project.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnRequest {
    pub project_id: String,
}

/// Server handle for lifecycle management.
///
/// Dropping this struct triggers graceful shutdown via `Drop`.
pub struct RemoteServer {
    /// Shutdown signal sender – dropping this triggers graceful shutdown
    shutdown_tx: Option<oneshot::Sender<()>>,
    /// Bound address (for display in UI)
    pub addr: SocketAddr,
}

impl RemoteServer {
    /// Start the remote terminal server.
    ///
    /// Binds to `bind_addr`, spawns the Axum server in a background task, and
    /// returns a `RemoteServer` handle. Dropping the handle sends a shutdown
    /// signal to the server task.
    pub async fn start(
        pty_manager: Arc<PtyManager>,
        registry: Arc<ProjectRegistry>,
        app_handle: AppHandle,
        bind_addr: SocketAddr,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let listener = TcpListener::bind(bind_addr).await?;
        let addr = listener.local_addr()?;

        info!("Remote terminal server binding to {}", addr);

        let ws_state = WsState {
            pty_manager: Arc::clone(&pty_manager),
            connection_tracker: Arc::new(ConnectionTracker::new()),
            max_connections_per_terminal: MAX_CONNECTIONS_PER_TERMINAL,
        };

        // Build Axum router.
        // - GET  /ws            → WebSocket upgrade (same-origin enforced in handler)
        // - GET  /              → embedded xterm.js client
        // - GET  /health        → liveness probe
        // - GET  /api/terminals → flat list of live PTY terminals
        // - GET  /api/projects  → project → terminal tree (published by renderer)
        // - POST /api/spawn     → request the renderer to open a new terminal
        // - GET  /static/*      → vendored xterm.js + Urbanist assets (no CDN)
        let app = Router::new()
            .route("/ws", get(ws_upgrade))
            .route("/", get(serve_index))
            .route("/health", get(health_check))
            .route("/static/vendor/xterm.min.css", get(serve_xterm_css))
            .route("/static/vendor/xterm.min.js", get(serve_xterm_js))
            .route("/static/vendor/addon-fit.min.js", get(serve_addon_fit))
            .route("/static/vendor/addon-web-links.min.js", get(serve_addon_web_links))
            .route("/static/fonts/urbanist.css", get(serve_urbanist_css))
            .route(
                "/static/fonts/urbanist-latin.woff2",
                get(serve_urbanist_latin),
            )
            .route(
                "/static/fonts/urbanist-latin-ext.woff2",
                get(serve_urbanist_latin_ext),
            )
            .route("/api/terminals", get(list_terminals))
            .route("/api/projects", get(list_projects))
            .route("/api/spawn", post(request_spawn))
            .with_state(ApiState {
                ws_state,
                pty_manager,
                registry,
                app_handle,
            })
            .into_make_service_with_connect_info::<SocketAddr>();

        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

        tokio::spawn(async move {
            info!("Remote terminal server listening on http://{}", addr);
            info!("Open http://{} in a browser (no token required)", addr);

            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                    info!("Remote terminal server shutting down…");
                })
                .await
                .inspect_err(|e| error!("Remote server error: {}", e))
                .ok();

            info!("Remote terminal server stopped");
        });

        Ok(Self {
            shutdown_tx: Some(shutdown_tx),
            addr,
        })
    }

    /// Returns the URL a user should open in a browser to access terminals.
    pub fn url(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// Gracefully shut down the server explicitly (alternative to drop).
    #[allow(dead_code)]
    pub fn shutdown(mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
    }
}

impl Drop for RemoteServer {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
    }
}

// ── Internal state ──────────────────────────────────────────────────────────

/// Combined Axum state for WebSocket + REST handlers.
#[derive(Clone)]
struct ApiState {
    ws_state: WsState,
    pty_manager: Arc<PtyManager>,
    registry: Arc<ProjectRegistry>,
    app_handle: AppHandle,
}

// `FromRef` lets the WebSocket handler extract `State<WsState>` from `ApiState`.
impl FromRef<ApiState> for WsState {
    fn from_ref(state: &ApiState) -> Self {
        state.ws_state.clone()
    }
}

// ── REST endpoints ───────────────────────────────────────────────────────────

/// `GET /api/terminals` – flat list of all live PTY terminals.
async fn list_terminals(State(state): State<ApiState>) -> impl IntoResponse {
    let terminals: Vec<TerminalSummary> = state
        .pty_manager
        .get_all()
        .iter()
        .map(|inst| TerminalSummary {
            id: inst.id.clone(),
            shell: inst.shell.clone(),
            cwd: inst.cwd.clone(),
            pid: inst.pid,
            cols: *inst.cols.read(),
            rows: *inst.rows.read(),
        })
        .collect();

    Json(terminals)
}

/// `GET /api/projects` – project → terminal tree published by the renderer.
async fn list_projects(State(state): State<ApiState>) -> impl IntoResponse {
    Json(state.registry.snapshot())
}

/// `POST /api/spawn` – ask the renderer to open a new terminal in a project.
///
/// The server cannot spawn a project-scoped terminal directly (project metadata,
/// env vars, cwd resolution all live in the renderer), so it emits a Tauri event
/// the desktop app handles. The web client should poll `/api/projects` to see the
/// new terminal appear.
async fn request_spawn(
    State(state): State<ApiState>,
    Json(req): Json<SpawnRequest>,
) -> impl IntoResponse {
    match state.app_handle.emit(EVENT_REMOTE_SPAWN_REQUEST, &req) {
        Ok(()) => (StatusCode::ACCEPTED, Json(req)).into_response(),
        Err(e) => {
            error!("Failed to emit remote spawn request: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to forward spawn request",
            )
                .into_response()
        }
    }
}

// ── Static HTML + health ────────────────────────────────────────────────────

/// Serve the embedded xterm.js web client.
async fn serve_index() -> impl IntoResponse {
    Html(include_str!("static/index.html"))
}

// Vendored UI assets, embedded at compile time so the client never reaches out
// to a CDN (works fully offline / behind locked-down networks, no third-party
// supply-chain or privacy exposure). Long cache: these are version-pinned.
const CACHE_IMMUTABLE: &str = "public, max-age=31536000, immutable";

async fn serve_xterm_css() -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, "text/css; charset=utf-8"),
            (header::CACHE_CONTROL, CACHE_IMMUTABLE),
        ],
        include_str!("static/vendor/xterm.min.css"),
    )
}

async fn serve_xterm_js() -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, "text/javascript; charset=utf-8"),
            (header::CACHE_CONTROL, CACHE_IMMUTABLE),
        ],
        include_str!("static/vendor/xterm.min.js"),
    )
}

async fn serve_addon_fit() -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, "text/javascript; charset=utf-8"),
            (header::CACHE_CONTROL, CACHE_IMMUTABLE),
        ],
        include_str!("static/vendor/addon-fit.min.js"),
    )
}

async fn serve_addon_web_links() -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, "text/javascript; charset=utf-8"),
            (header::CACHE_CONTROL, CACHE_IMMUTABLE),
        ],
        include_str!("static/vendor/addon-web-links.min.js"),
    )
}

async fn serve_urbanist_css() -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, "text/css; charset=utf-8"),
            (header::CACHE_CONTROL, CACHE_IMMUTABLE),
        ],
        include_str!("static/fonts/urbanist.css"),
    )
}

async fn serve_urbanist_latin() -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, "font/woff2"),
            (header::CACHE_CONTROL, CACHE_IMMUTABLE),
        ],
        include_bytes!("static/fonts/urbanist-latin.woff2").as_slice(),
    )
}

async fn serve_urbanist_latin_ext() -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, "font/woff2"),
            (header::CACHE_CONTROL, CACHE_IMMUTABLE),
        ],
        include_bytes!("static/fonts/urbanist-latin-ext.woff2").as_slice(),
    )
}

/// Health check endpoint.
async fn health_check() -> impl IntoResponse {
    (StatusCode::OK, "OK")
}

// ── IPC-facing types & state wrapper ───────────────────────────────────────

/// Status of the remote terminal server, returned to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub running: bool,
    pub url: Option<String>,
    pub port: Option<u16>,
}

/// Tauri-managed wrapper around `RemoteServer` that tracks start/stop lifecycle.
pub struct RemoteServerState {
    inner: std::sync::Mutex<Option<RemoteServer>>,
    /// Project tree published by the renderer; shared with the running server.
    pub registry: Arc<ProjectRegistry>,
}

impl RemoteServerState {
    pub fn new() -> Self {
        Self {
            inner: std::sync::Mutex::new(None),
            registry: Arc::new(ProjectRegistry::new()),
        }
    }

    /// Start the remote terminal server if not already running.
    /// Binds to `127.0.0.1:0` (auto-port) by default.
    pub async fn start(
        &self,
        pty_manager: Arc<PtyManager>,
        app_handle: AppHandle,
    ) -> Result<RemoteStatus, String> {
        {
            let slot = self.inner.lock().unwrap();
            if slot.is_some() {
                return Err("Remote server is already running".to_string());
            }
        }

        let bind_addr = SocketAddr::from(([127, 0, 0, 1], 0));
        let server = RemoteServer::start(
            pty_manager,
            Arc::clone(&self.registry),
            app_handle,
            bind_addr,
        )
        .await
        .map_err(|e| format!("Failed to start remote server: {}", e))?;

        let status = RemoteStatus {
            running: true,
            url: Some(server.url()),
            port: Some(server.addr.port()),
        };

        let mut slot = self.inner.lock().unwrap();
        if slot.is_some() {
            drop(server);
            return Err("Remote server is already running".to_string());
        }
        *slot = Some(server);
        Ok(status)
    }

    /// Stop the remote terminal server if running.
    pub async fn stop(&self) -> Result<RemoteStatus, String> {
        let server = {
            let mut slot = self.inner.lock().unwrap();
            slot.take()
        };
        if let Some(server) = server {
            drop(server); // triggers graceful shutdown
            Ok(RemoteStatus {
                running: false,
                url: None,
                port: None,
            })
        } else {
            Err("Remote server is not running".to_string())
        }
    }

    /// Return the current status of the remote terminal server.
    pub fn status(&self) -> RemoteStatus {
        let slot = self.inner.lock().unwrap();
        match slot.as_ref() {
            Some(server) => RemoteStatus {
                running: true,
                url: Some(server.url()),
                port: Some(server.addr.port()),
            },
            None => RemoteStatus {
                running: false,
                url: None,
                port: None,
            },
        }
    }
}

impl Default for RemoteServerState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt; // for `oneshot`

    /// Router with only the vendored static-asset routes (no AppHandle / state
    /// needed), so we can verify each embedded asset is served correctly.
    fn static_router() -> Router {
        Router::new()
            .route("/static/vendor/xterm.min.css", get(serve_xterm_css))
            .route("/static/vendor/xterm.min.js", get(serve_xterm_js))
            .route("/static/vendor/addon-fit.min.js", get(serve_addon_fit))
            .route(
                "/static/vendor/addon-web-links.min.js",
                get(serve_addon_web_links),
            )
            .route("/static/fonts/urbanist.css", get(serve_urbanist_css))
            .route(
                "/static/fonts/urbanist-latin.woff2",
                get(serve_urbanist_latin),
            )
            .route(
                "/static/fonts/urbanist-latin-ext.woff2",
                get(serve_urbanist_latin_ext),
            )
    }

    async fn fetch(path: &str) -> (StatusCode, String, Vec<u8>) {
        let resp = static_router()
            .oneshot(
                Request::builder()
                    .uri(path)
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        let status = resp.status();
        let ctype = resp
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("read body")
            .to_vec();
        (status, ctype, body)
    }

    #[tokio::test]
    async fn vendored_assets_are_served_with_correct_types() {
        let cases = [
            ("/static/vendor/xterm.min.css", "text/css"),
            ("/static/vendor/xterm.min.js", "text/javascript"),
            ("/static/vendor/addon-fit.min.js", "text/javascript"),
            ("/static/vendor/addon-web-links.min.js", "text/javascript"),
            ("/static/fonts/urbanist.css", "text/css"),
            ("/static/fonts/urbanist-latin.woff2", "font/woff2"),
            ("/static/fonts/urbanist-latin-ext.woff2", "font/woff2"),
        ];
        for (path, expected_type) in cases {
            let (status, ctype, body) = fetch(path).await;
            assert_eq!(status, StatusCode::OK, "{path} should return 200");
            assert!(
                ctype.starts_with(expected_type),
                "{path} content-type `{ctype}` should start with `{expected_type}`"
            );
            assert!(!body.is_empty(), "{path} body should be non-empty");
        }
    }

    #[tokio::test]
    async fn vendored_woff2_have_valid_magic_bytes() {
        for path in [
            "/static/fonts/urbanist-latin.woff2",
            "/static/fonts/urbanist-latin-ext.woff2",
        ] {
            let (_, _, body) = fetch(path).await;
            assert_eq!(&body[..4], b"wOF2", "{path} should be a valid woff2 file");
        }
    }

    #[tokio::test]
    async fn index_html_references_only_local_assets() {
        // Guard against re-introducing CDN runtime deps for UI assets.
        let html = include_str!("static/index.html");
        assert!(!html.contains("cdn.jsdelivr.net"), "no jsDelivr CDN refs");
        assert!(!html.contains("fonts.googleapis.com"), "no Google Fonts CSS");
        assert!(!html.contains("fonts.gstatic.com"), "no gstatic font refs");
        assert!(
            html.contains("/static/vendor/xterm.min.js"),
            "uses local xterm js"
        );
        assert!(
            html.contains("/static/fonts/urbanist.css"),
            "uses local font css"
        );
    }
}
