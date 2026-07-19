//! Axum router for the standalone `termul-server` (Story 1.2 skeleton).
//!
//! This story only exposes `/health`, a WS-upgrade placeholder (501 until
//! Story 1.4), and a static-bundle stub (503 until Story 1.3/1.11). Live WS
//! relay, auth, and rust-embed serving land in later stories.

use std::sync::Arc;

use axum::{
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Router,
};

use crate::acp::AcpManager;

/// Build the standalone-server Axum router.
///
/// `acp` is held for later WS/permission routes (Stories 1.4 / 1.7); this
/// skeleton does not yet route through it.
pub fn router(acp: Arc<AcpManager>) -> Router {
    Router::new()
        .route("/health", get(health_check))
        .route("/ws", get(ws_upgrade_placeholder))
        .route("/", get(static_bundle_stub))
        .with_state(acp)
}

/// Liveness probe — mirrors `remote::server::health_check`.
async fn health_check() -> impl IntoResponse {
    (StatusCode::OK, "OK")
}

/// Placeholder until Story 1.4 wires the WS relay.
async fn ws_upgrade_placeholder() -> impl IntoResponse {
    (
        StatusCode::NOT_IMPLEMENTED,
        "WebSocket relay not implemented yet (Story 1.4)",
    )
}

/// Placeholder until Story 1.3/1.11 embed and serve `dist-web/`.
async fn static_bundle_stub() -> impl IntoResponse {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        "Static bundle not embedded yet (Story 1.3/1.11)",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    fn test_router() -> Router {
        // Empty sink list is legal for unit tests (Story 1.1).
        router(Arc::new(AcpManager::new(vec![])))
    }

    #[tokio::test]
    async fn health_returns_ok() {
        let resp = test_router()
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
    async fn ws_placeholder_returns_501() {
        let resp = test_router()
            .oneshot(
                Request::builder()
                    .uri("/ws")
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(resp.status(), StatusCode::NOT_IMPLEMENTED);
    }

    #[tokio::test]
    async fn static_stub_returns_503() {
        let resp = test_router()
            .oneshot(
                Request::builder()
                    .uri("/")
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }
}
