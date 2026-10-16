use super::*;
use crate::acp::AcpManager;
use crate::web::sink::WsRelaySink;
use crate::web::test_pty_manager;
use axum::body::Body;
use axum::http::Request;
use std::sync::Arc;
use tower::ServiceExt;

fn test_state() -> AppState {
    let pty = test_pty_manager();
    AppState {
        acp: Arc::new(AcpManager::new(vec![])),
        terminal_events: pty.terminal_events(),
        cwd_tracker: pty.cwd_tracker(),
        git_tracker: pty.git_tracker(),
        exit_code_tracker: pty.exit_code_tracker(),
        pty,
        relay: Arc::new(WsRelaySink::new()),
        registry: crate::web::project_registry::ProjectRegistry::seeded_for_test(
            &std::env::temp_dir()
                .canonicalize()
                .unwrap_or_else(|_| std::env::temp_dir()),
        ),
        history_mode: crate::web::ws::HistoryMode::LiveOnly,
        acp_catalog: None,
        acp_install: None,
        store: None,
        web_auth: None,
        allow_remote_writes: false,
        shared_live_writes_denied: false,
        pending_oauth_flows: std::sync::Arc::new(parking_lot::RwLock::new(
            std::collections::HashMap::new(),
        )),
        oauth_base_url: "http://127.0.0.1".to_string(),
        connections: Default::default(),
    }
}

fn test_router(state: AppState) -> axum::Router {
    axum::Router::new()
        .route("/log/frontend-error", route())
        .with_state(state)
}

async fn post_json(
    state: AppState,
    body: &serde_json::Value,
    peer: SocketAddr,
) -> axum::http::Response<Body> {
    post_bytes(
        state,
        serde_json::to_vec(body).expect("serialize body"),
        peer,
    )
    .await
}

async fn post_bytes(
    state: AppState,
    bytes: Vec<u8>,
    peer: SocketAddr,
) -> axum::http::Response<Body> {
    test_router(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/log/frontend-error")
                .header("content-type", "application/json")
                .extension(ConnectInfo(peer))
                .body(Body::from(bytes))
                .expect("build request"),
        )
        .await
        .expect("router response")
}

async fn body_as_json<T: serde::de::DeserializeOwned>(body: Body) -> T {
    let bytes = axum::body::to_bytes(body, usize::MAX)
        .await
        .expect("read body");
    serde_json::from_slice(&bytes).expect("deserialize IpcBody")
}

#[tokio::test]
async fn frontend_error_succeeds_on_loopback() {
    let req = serde_json::json!({
        "level": "error",
        "message": "test error",
        "source": "test",
    });
    let peer = SocketAddr::from(([127, 0, 0, 1], 54321));
    let resp = post_json(test_state(), &req, peer).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(body.success, "log should succeed: {:?}", body.error);
}

#[tokio::test]
async fn frontend_error_refused_from_non_loopback() {
    let req = serde_json::json!({
        "message": "test",
    });
    let peer = SocketAddr::from(([192, 168, 1, 50], 40000));
    let resp = post_json(test_state(), &req, peer).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(!body.success, "non-loopback must be refused");
    assert_eq!(body.code.as_deref(), Some("FORBIDDEN"));
}

#[tokio::test]
async fn frontend_error_warn_level_succeeds() {
    let req = serde_json::json!({
        "level": "warn",
        "message": "warning test",
    });
    let peer = SocketAddr::from(([127, 0, 0, 1], 54321));
    let resp = post_json(test_state(), &req, peer).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(body.success);
}

#[tokio::test]
async fn frontend_error_info_level_succeeds() {
    // Story 8 (web honesty): the info level is the destination for
    // benign noise (idle reconnect churn, idempotent not-found races);
    // it must be accepted and not fall through to the error branch.
    let req = serde_json::json!({
        "level": "info",
        "message": "benign noise test",
    });
    let peer = SocketAddr::from(([127, 0, 0, 1], 54321));
    let resp = post_json(test_state(), &req, peer).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(body.success, "info level should log: {:?}", body.error);
}

#[derive(Clone, Default)]
struct Captured(Arc<parking_lot::Mutex<Vec<u8>>>);

impl std::io::Write for Captured {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Captured {
    type Writer = Self;

    fn make_writer(&'a self) -> Self {
        self.clone()
    }
}

/// The real shared-live router: bearer gate on, every host write denied.
fn gated_shared_live_router() -> axum::Router {
    let token = crate::web::auth::WebAuthToken::new("test-token").expect("non-empty");
    crate::web::router::router_with_static(
        Arc::new(AcpManager::new(vec![])),
        test_pty_manager(),
        Arc::new(WsRelaySink::new()),
        Arc::new(crate::web::project_registry::ProjectRegistry::new()),
        &std::env::temp_dir(),
        false,
        true,
        Some(Arc::new(crate::web::auth::WebAuth::new(token))),
        crate::web::origin::OriginPolicy::default(),
    )
}

#[tokio::test]
async fn frontend_error_from_an_authenticated_remote_peer_reaches_the_log() {
    let captured = Captured::default();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(captured.clone())
        .with_ansi(false)
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);
    // With a single registered dispatcher, tracing-core computes a callsite's
    // interest from the registering thread's default alone, so a parallel test
    // reaching the same `warn!` with no subscriber disables it for every thread.
    let _second_dispatcher = tracing::Dispatch::new(tracing::subscriber::NoSubscriber::default());
    let req = serde_json::json!({
        "level": "warn",
        "message": "sw skipped",
        "source": "pwa-register",
    });
    let peer = SocketAddr::from(([192, 168, 1, 50], 40000));

    let resp = gated_shared_live_router()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/log/frontend-error")
                .header("content-type", "application/json")
                .header("authorization", "Bearer test-token")
                .extension(ConnectInfo(peer))
                .body(Body::from(serde_json::to_vec(&req).expect("serialize")))
                .expect("build request"),
        )
        .await
        .expect("router response");

    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(
        body.success,
        "authenticated remote log refused: {:?}",
        body.error
    );
    let logged = String::from_utf8(captured.0.lock().clone()).expect("utf-8 log");
    assert!(
        logged.contains("WARN") && logged.contains("[frontend] [pwa-register] sw skipped"),
        "log was: {logged}"
    );
}

#[tokio::test]
async fn frontend_error_over_the_body_cap_is_refused_as_too_large() {
    let message = "x".repeat(MAX_BODY_BYTES);
    let bytes = serde_json::to_vec(&serde_json::json!({ "message": message })).expect("serialize");
    let peer = SocketAddr::from(([127, 0, 0, 1], 54321));

    let resp = post_bytes(test_state(), bytes, peer).await;

    assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[test]
fn line_budget_drops_past_its_window_quota_until_the_window_resets() {
    let start = Instant::now();
    let mut budget = LineBudget::new(2, Duration::from_secs(60));

    let spent: Vec<_> = (0..4).map(|_| budget.take(start)).collect();
    let next_window = budget.take(start + Duration::from_secs(60));

    assert_eq!(
        spent,
        vec![
            Ok(()),
            Ok(()),
            Err(Dropped { in_window: 1 }),
            Err(Dropped { in_window: 2 }),
        ]
    );
    assert_eq!(next_window, Ok(()));
}
