//! Axum router for the standalone `termul-server`.
//!
//! Exposes `/health`, the live WS upgrade at `/ws` (Story 1.4 — replaces the
//! 501 placeholder), and `ServeDir` static serving of repo-root `dist-web/`
//! (Story 1.3). Production rust-embed serving is Story 1.11. The `/ws` route
//! is registered explicitly AHEAD of the `fallback_service` static mount so it
//! is not shadowed by `ServeDir` (AC1).

use std::path::Path;
use std::sync::Arc;

use axum::{
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Router,
};

use crate::acp::AcpManager;
use crate::web::sink::WsRelaySink;
use crate::web::ws::{ws_upgrade, AppState};

use super::assets;

/// Build the standalone-server Axum router (serves repo `dist-web/`).
///
/// `ws_relay` is threaded into the router state so `/ws` can subscribe clients
/// and replay cursors (Story 1.4). The `/ws` route is registered before the
/// `fallback_service` static mount so `ServeDir` cannot shadow it (AC1).
pub fn router(acp: Arc<AcpManager>, ws_relay: Arc<WsRelaySink>) -> Router {
    Router::new()
        .route("/health", get(health_check))
        .route("/ws", get(ws_upgrade))
        .fallback_service(assets::static_service())
        .with_state(AppState { acp, relay: ws_relay })
}

/// Same as [`router`], but with an injectable static-root for unit tests.
pub fn router_with_static(
    acp: Arc<AcpManager>,
    ws_relay: Arc<WsRelaySink>,
    static_dir: &Path,
) -> Router {
    Router::new()
        .route("/health", get(health_check))
        .route("/ws", get(ws_upgrade))
        .fallback_service(assets::static_service_from(static_dir))
        .with_state(AppState { acp, relay: ws_relay })
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
        router_with_static(
            Arc::new(AcpManager::new(vec![])),
            Arc::new(WsRelaySink::new()),
            dir,
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
