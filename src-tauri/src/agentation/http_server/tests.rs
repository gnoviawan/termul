use super::*;
use tower::ServiceExt;

fn test_state() -> AppState {
    AppState {
        store: Arc::new(SqliteStore::open_in_memory().unwrap()),
        canvas_pool: None,
    }
}

#[tokio::test]
async fn canvas_mcp_route_rejects_get() {
    // Mirrors the daemon contract: only POST is a JSON-RPC transport.
    let app = router(test_state());
    let resp = app
        .oneshot(
            axum::http::Request::builder()
                .method("GET")
                .uri("/canvas/mcp")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::METHOD_NOT_ALLOWED);
}

#[tokio::test]
async fn canvas_mcp_routes_proxy_to_live_pool_daemons() {
    // Live pool + FakeSpawner echo daemons: a JSON-RPC POST round-trips
    // through BOTH the global route (active daemon) and the id-scoped route
    // (that canvas id's daemon — proven per-project by TWO marked echo
    // daemons); an unknown id reports the typed 502 DAEMON_DOWN (the
    // "canvas closed" signal).
    use crate::canvas::managed::{spawn_daemon_from_command, CanvasDaemon};
    use crate::canvas::tests::{fake_daemon_command_with_port, FakeKind};
    use crate::canvas::{CanvasError, DaemonSpawner};
    use futures_util::future::BoxFuture;
    use futures_util::FutureExt;
    use std::sync::Arc;
    use std::time::Duration;

    /// Spawns daemons whose handshake announces a per-doc port, so two
    /// canvases can point at two distinguishable echo servers.
    struct RoutingSpawner {
        port_a: u16,
        port_b: u16,
    }
    impl DaemonSpawner for RoutingSpawner {
        fn spawn(
            &self,
            doc_key: &str,
            allow_origin: &str,
        ) -> BoxFuture<'static, Result<Arc<CanvasDaemon>, CanvasError>> {
            let port = if doc_key.ends_with("doc-a.op") {
                self.port_a
            } else {
                self.port_b
            };
            let doc_key = doc_key.to_string();
            let allow_origin = allow_origin.to_string();
            async move {
                spawn_daemon_from_command(
                    &doc_key,
                    &allow_origin,
                    fake_daemon_command_with_port(FakeKind::HandshakeThenSleep, port),
                    Duration::from_secs(10),
                )
                .await
            }
            .boxed()
        }
    }

    let (addr_a, server_a) = crate::canvas::tests::spawn_echo_server_marked("echo-a").await;
    let (addr_b, server_b) = crate::canvas::tests::spawn_echo_server_marked("echo-b").await;
    let dir = tempfile::tempdir().expect("tempdir");
    let doc_a = dir.path().join("doc-a.op");
    let doc_b = dir.path().join("doc-b.op");
    std::fs::write(&doc_a, b"{}").expect("write doc a");
    std::fs::write(&doc_b, b"{}").expect("write doc b");

    let pool = Arc::new(crate::canvas::pool::CanvasDaemonPool::new(Arc::new(
        RoutingSpawner {
            port_a: addr_a.port(),
            port_b: addr_b.port(),
        },
    )));
    pool.acquire(&doc_a.to_string_lossy(), "http://127.0.0.1:5180", "proj-a")
        .await
        .expect("acquire a");
    pool.acquire(&doc_b.to_string_lossy(), "http://127.0.0.1:5180", "proj-b")
        .await
        .expect("acquire b");
    let id_a = crate::canvas::canvas_id_for_project("proj-a");
    let id_b = crate::canvas::canvas_id_for_project("proj-b");

    let state = AppState {
        store: Arc::new(SqliteStore::open_in_memory().unwrap()),
        canvas_pool: Some(pool),
    };
    let app = router(state);

    let mcp_post = |uri: String, bearer: Option<&str>| {
        let mut builder = axum::http::Request::builder()
            .method("POST")
            .uri(uri)
            .header("content-type", "application/json");
        if let Some(bearer) = bearer {
            builder = builder.header("authorization", format!("Bearer {bearer}"));
        }
        builder
            .body(axum::body::Body::from(
                r#"{"jsonrpc":"2.0","method":"tools/list","id":1}"#,
            ))
            .unwrap()
    };
    let post_body = |resp: axum::response::Response| async move {
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice::<serde_json::Value>(&body).unwrap()
    };

    // The fake daemons' managed (handshake) token — the required bearer.
    let managed_token = "c0ffee";

    // No bearer → 401 (the agentation canvas auth layer; the router is
    // reachable from arbitrary browser-tab origins, so the gate matters).
    let resp = app
        .clone()
        .oneshot(mcp_post(format!("/canvas/{id_a}/mcp"), None))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    let parsed = post_body(resp).await;
    assert_eq!(parsed["code"], "UNAUTHORIZED");
    assert_eq!(
        parsed["error"], "agentation canvas MCP requires the canvas daemon bearer token",
        "rejection names the agentation canvas auth layer"
    );

    // Wrong bearer → 401 (both routes).
    for uri in [format!("/canvas/{id_a}/mcp"), "/canvas/mcp".to_string()] {
        let status = app
            .clone()
            .oneshot(mcp_post(uri.clone(), Some("wrong-token")))
            .await
            .unwrap()
            .status();
        assert_eq!(status, StatusCode::UNAUTHORIZED, "wrong bearer on {uri}");
    }

    // Id-scoped with the correct bearer: each project's agents reach THAT
    // project's daemon.
    let parsed = post_body(
        app.clone()
            .oneshot(mcp_post(format!("/canvas/{id_a}/mcp"), Some(managed_token)))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(parsed["proxied"], true);
    assert_eq!(parsed["echo"], "echo-a", "proj-a's id routes to echo-a");

    let parsed = post_body(
        app.clone()
            .oneshot(mcp_post(format!("/canvas/{id_b}/mcp"), Some(managed_token)))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(parsed["proxied"], true);
    assert_eq!(parsed["echo"], "echo-b", "proj-b's id routes to echo-b");

    // Global route with the correct bearer → the ACTIVE (last-opened) daemon.
    let parsed = post_body(
        app.clone()
            .oneshot(mcp_post("/canvas/mcp".to_string(), Some(managed_token)))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(parsed["proxied"], true);
    assert_eq!(parsed["echo"], "echo-b", "global route follows the active daemon");

    // Unknown canvas id → no target daemon → typed 502 DAEMON_DOWN (the
    // "canvas closed" signal, not an auth failure).
    let resp = app
        .oneshot(mcp_post("/canvas/cvdeadbeefdeadbeef/mcp".to_string(), Some(managed_token)))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
    let parsed = post_body(resp).await;
    assert_eq!(parsed["code"], "DAEMON_DOWN");

    drop(dir);
    server_a.abort();
    server_b.abort();
}

#[tokio::test]
async fn canvas_mcp_route_reports_daemon_down_without_pool() {
    let app = router(test_state());
    let resp = app
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/canvas/mcp")
                .header("content-type", "application/json")
                .body(axum::body::Body::from(
                    r#"{"jsonrpc":"2.0","method":"tools/list","id":1}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(parsed["code"], "DAEMON_DOWN");
    assert_eq!(parsed["success"], false);
}

#[tokio::test]
async fn test_create_session_route() {
    let app = router(test_state());
    let resp = app
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/sessions")
                .header("content-type", "application/json")
                .body(axum::body::Body::from(r#"{"url":"https://example.com"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);
}

#[tokio::test]
async fn test_list_sessions_route() {
    let app = router(test_state());
    let resp = app
        .oneshot(
            axum::http::Request::builder()
                .method("GET")
                .uri("/sessions")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn test_full_annotation_lifecycle() {
    let state = test_state();
    let app = router(state.clone());

    // Create session
    let resp = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/sessions")
                .header("content-type", "application/json")
                .body(axum::body::Body::from(r#"{"url":"https://test.com"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let session: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let session_id = session["id"].as_str().unwrap();

    // Add annotation
    let app2 = router(state.clone());
    let resp = app2
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri(format!("/sessions/{session_id}/annotations"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        r#"{"x":10,"y":20,"comment":"Fix this","element":"button","elementPath":"body > button","timestamp":12345}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);

    // Get pending
    let app3 = router(state.clone());
    let resp = app3
        .oneshot(
            axum::http::Request::builder()
                .method("GET")
                .uri(format!("/sessions/{session_id}/pending"))
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let pending: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(pending["count"], 1);
}
