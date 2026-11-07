use super::*;
use crate::acp::AcpManager;
use crate::web::sink::WsRelaySink;
use crate::web::test_pty_manager;
use axum::body::Body;
use axum::http::Request;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tower::ServiceExt;

fn test_state() -> AppState {
    test_state_with(false, false)
}

fn test_state_with(allow_remote_writes: bool, shared_live_writes_denied: bool) -> AppState {
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
        server_admin: None,
        allow_remote_writes,
        shared_live_writes_denied,
        pending_oauth_flows: std::sync::Arc::new(parking_lot::RwLock::new(
            std::collections::HashMap::new(),
        )),
        oauth_base_url: "http://127.0.0.1".to_string(),
        connections: Default::default(),
    }
}

fn test_router(state: AppState) -> axum::Router {
    axum::Router::new()
        .route("/log/diagnostics", diagnostics_route())
        .route("/log/report-bug", report_bug_route())
        .with_state(state)
}

async fn post(
    state: AppState,
    uri: &str,
    body: &serde_json::Value,
    peer: SocketAddr,
) -> axum::http::Response<Body> {
    test_router(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(uri)
                .header("content-type", "application/json")
                .extension(ConnectInfo(peer))
                .body(Body::from(
                    serde_json::to_vec(body).expect("serialize body"),
                ))
                .expect("build request"),
        )
        .await
        .expect("router response")
}

async fn body_as_json(body: Body) -> serde_json::Value {
    let bytes = axum::body::to_bytes(body, usize::MAX)
        .await
        .expect("read body");
    serde_json::from_slice(&bytes).expect("deserialize IpcBody")
}

const LOOPBACK: SocketAddr =
    SocketAddr::new(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), 54321);

fn remote_peer() -> SocketAddr {
    SocketAddr::from(([192, 168, 1, 50], 40000))
}

// ---------------------------------------------------------------------------
// POST /log/diagnostics (route level — collect never spawns a process, so the
// real handler is safe to run end-to-end)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn diagnostics_succeeds_on_loopback() {
    let resp = post(
        test_state(),
        "/log/diagnostics",
        &serde_json::json!({}),
        LOOPBACK,
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body = body_as_json(resp.into_body()).await;
    assert_eq!(body["success"], true, "{body}");
    let data = &body["data"];
    // The BugReportContext contract (camelCase, mirrors
    // src/shared/types/bug-report.types.ts).
    assert!(data["appVersion"].as_str().is_some_and(|v| !v.is_empty()));
    assert!(data["os"].is_string());
    assert!(data["arch"].is_string());
    assert!(data["channel"].is_string());
    assert!(data["runId"].is_string());
    assert!(data["collectedAt"].is_string());
    assert!(data["logAvailable"].is_boolean());
    assert!(data["logTruncated"].is_boolean());
    assert!(data["logTail"].is_string());
    assert!(
        data.get("app_version").is_none() && data.get("log_tail").is_none(),
        "wire keys must be camelCase: {data}"
    );
}

#[tokio::test]
async fn diagnostics_refused_from_non_loopback_without_opt_in() {
    let resp = post(
        test_state(),
        "/log/diagnostics",
        &serde_json::json!({}),
        remote_peer(),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body = body_as_json(resp.into_body()).await;
    assert_eq!(body["success"], false);
    assert_eq!(body["code"], "FORBIDDEN");
}

#[tokio::test]
async fn diagnostics_refused_for_every_peer_in_shared_live_mode() {
    // Desktop shared-live denies ALL writes — even a loopback peer (a
    // cloudflared tunnel forwards public traffic from loopback).
    let resp = post(
        test_state_with(true, true),
        "/log/diagnostics",
        &serde_json::json!({}),
        LOOPBACK,
    )
    .await;
    let body = body_as_json(resp.into_body()).await;
    assert_eq!(body["success"], false);
    assert_eq!(body["code"], "FORBIDDEN");
}

#[tokio::test]
async fn diagnostics_admits_remote_peer_with_opt_in() {
    let resp = post(
        test_state_with(true, false),
        "/log/diagnostics",
        &serde_json::json!({}),
        remote_peer(),
    )
    .await;
    let body = body_as_json(resp.into_body()).await;
    assert_eq!(body["success"], true, "{body}");
}

// ---------------------------------------------------------------------------
// POST /log/report-bug (guard paths only at route level — an admitted request
// would spawn a REAL `gh` and could file a real issue on an authenticated
// host; the admitted path is covered through `report_bug_inner`'s injectable
// seam below, and `submit_bug_report` itself is covered in
// `crate::diagnostics::tests`)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn report_bug_refused_from_non_loopback_without_opt_in() {
    let resp = post(
        test_state(),
        "/log/report-bug",
        &serde_json::json!({"title": "t", "body": "b"}),
        remote_peer(),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body = body_as_json(resp.into_body()).await;
    assert_eq!(body["success"], false);
    assert_eq!(body["code"], "FORBIDDEN");
}

#[tokio::test]
async fn report_bug_refused_for_every_peer_in_shared_live_mode() {
    let resp = post(
        test_state_with(true, true),
        "/log/report-bug",
        &serde_json::json!({"title": "t", "body": "b"}),
        LOOPBACK,
    )
    .await;
    let body = body_as_json(resp.into_body()).await;
    assert_eq!(body["success"], false);
    assert_eq!(body["code"], "FORBIDDEN");
}

#[tokio::test]
async fn report_bug_over_the_body_cap_is_refused_as_too_large() {
    let bytes = serde_json::to_vec(&serde_json::json!({
        "title": "t",
        "body": "x".repeat(MAX_REPORT_BODY_BYTES),
    }))
    .expect("serialize");
    let resp = test_router(test_state())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/log/report-bug")
                .header("content-type", "application/json")
                .extension(ConnectInfo(LOOPBACK))
                .body(Body::from(bytes))
                .expect("build request"),
        )
        .await
        .expect("router response");
    assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

// ---------------------------------------------------------------------------
// Injected seams: the admitted paths, without a real log file or `gh`
// ---------------------------------------------------------------------------

#[tokio::test]
async fn diagnostics_inner_admitted_passes_the_context_through() {
    let (status, Json(body)) = diagnostics_inner(LOOPBACK, &test_state(), || BugReportContext {
        app_version: "9.9.9".to_string(),
        os: "linux".to_string(),
        arch: "x86_64".to_string(),
        channel: "release".to_string(),
        run_id: "run".to_string(),
        collected_at: "now".to_string(),
        log_available: true,
        log_truncated: false,
        log_tail: "tail".to_string(),
    })
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.success, "{:?}", body.error);
    let context = body.data.expect("data");
    assert!(context.log_available);
    assert_eq!(context.app_version, "9.9.9");
    assert_eq!(context.log_tail, "tail");
}

#[tokio::test]
async fn diagnostics_inner_collect_panic_reports_the_join_error() {
    // Message parity with the desktop command: the join error detail rides
    // inside the same COLLECT_FAILED body.
    let (status, Json(body)) =
        diagnostics_inner(LOOPBACK, &test_state(), || -> BugReportContext {
            panic!("collect blew up")
        })
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(!body.success);
    assert_eq!(body.code.as_deref(), Some("COLLECT_FAILED"));
    let error = body.error.expect("error message");
    assert!(
        error.starts_with("diagnostics collection failed: "),
        "the join error detail must be included, like the desktop command: {error}"
    );
}

#[tokio::test]
async fn report_bug_inner_admitted_returns_the_submit_result() {
    let req = BugReportSubmitRequest {
        title: "the title".to_string(),
        body: "the body".to_string(),
    };
    let (status, Json(body)) = report_bug_inner(LOOPBACK, &test_state(), req, |title, body| {
        assert_eq!(title, "the title");
        assert_eq!(body, "the body");
        BugReportSubmitResult::Submitted {
            issue_url: "https://github.com/gnoviawan/termul/issues/1".to_string(),
        }
    })
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.success, "{:?}", body.error);
    match body.data.expect("data") {
        BugReportSubmitResult::Submitted { issue_url } => {
            assert_eq!(issue_url, "https://github.com/gnoviawan/termul/issues/1")
        }
        other => panic!("expected submitted, got {other:?}"),
    }
}

#[tokio::test]
async fn report_bug_inner_denied_never_runs_submit() {
    let called = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&called);
    let req = BugReportSubmitRequest {
        title: "t".to_string(),
        body: "b".to_string(),
    };
    let (_status, Json(body)) = report_bug_inner(remote_peer(), &test_state(), req, move |_, _| {
        flag.store(true, Ordering::SeqCst);
        BugReportSubmitResult::Submitted {
            issue_url: "u".to_string(),
        }
    })
    .await;
    assert!(!body.success);
    assert_eq!(body.code.as_deref(), Some("FORBIDDEN"));
    assert!(
        !called.load(Ordering::SeqCst),
        "a denied peer must never reach the gh submit"
    );
}

#[test]
fn submit_request_deserializes_the_camel_case_body() {
    let req: BugReportSubmitRequest =
        serde_json::from_str(r#"{"title":"the title","body":"the body"}"#).expect("parse");
    assert_eq!(req.title, "the title");
    assert_eq!(req.body, "the body");
}

// ---------------------------------------------------------------------------
// host_log_path resolution (best-effort candidates; never fails)
// ---------------------------------------------------------------------------

#[test]
fn log_path_candidates_follow_the_deployment_mode() {
    // Standalone `termul-server` (shared_live_writes_denied: false): only
    // the server log — a stale desktop termul.log must not be attached.
    for path in log_path_candidates(false) {
        assert!(path.ends_with("termul-server.log"), "{path:?}");
    }
    // Desktop shared-live host (true): only the desktop app_log_dir
    // termul.log — a stale termul-server.log must not win.
    for path in log_path_candidates(true) {
        assert!(path.ends_with("termul.log"), "{path:?}");
    }
    // On supported targets each mode derives its one candidate.
    #[cfg(any(unix, windows))]
    {
        let server = log_path_candidates(false);
        assert_eq!(server.len(), 1, "{server:?}");
        let desktop = log_path_candidates(true);
        assert_eq!(desktop.len(), 1, "{desktop:?}");
        #[cfg(all(unix, not(target_os = "macos")))]
        assert!(
            desktop[0]
                .to_string_lossy()
                .contains("com.termul-manager.app"),
            "desktop candidate must be the app_log_dir layout: {desktop:?}"
        );
    }
}

#[test]
fn host_log_path_only_returns_a_real_file_or_none() {
    for shared_live in [false, true] {
        if let Some(path) = host_log_path(shared_live) {
            assert!(path.is_file(), "returned candidate must exist: {path:?}");
        }
    }
}
