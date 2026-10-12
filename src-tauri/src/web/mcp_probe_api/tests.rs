use super::*;
use crate::acp::AcpManager;
use crate::web::project_registry::ProjectRegistry;
use crate::web::sink::WsRelaySink;
use crate::web::test_pty_manager;
use crate::web::ws::HistoryMode;
use axum::body::{to_bytes, Body};
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode};
use axum::routing::post;
use std::net::SocketAddr;
use std::sync::Arc;
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};
use tower::ServiceExt;

const LOOPBACK: ([u8; 4], u16) = ([127, 0, 0, 1], 54321);
const REMOTE: ([u8; 4], u16) = ([203, 0, 113, 9], 40000);

fn test_app() -> axum::Router {
    test_app_with(false, false)
}

fn test_app_with(allow_remote_writes: bool, shared_live_writes_denied: bool) -> axum::Router {
    let pty = test_pty_manager();
    let state = AppState {
        acp: Arc::new(AcpManager::new(vec![])),
        terminal_events: pty.terminal_events(),
        cwd_tracker: pty.cwd_tracker(),
        git_tracker: pty.git_tracker(),
        exit_code_tracker: pty.exit_code_tracker(),
        pty,
        relay: Arc::new(WsRelaySink::new()),
        registry: Arc::new(ProjectRegistry::new()),
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
        allow_remote_writes,
        shared_live_writes_denied,
    };
    axum::Router::new()
        .route("/mcp-servers/probe", post(super::probe))
        .with_state(state)
}

async fn body_as_json(body: Body) -> Value {
    let bytes = to_bytes(body, usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes).expect("deserialize IpcBody")
}

#[tokio::test]
async fn malformed_config_returns_invalid_config_error() {
    let app = test_app();
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/mcp-servers/probe")
                .header("content-type", "application/json")
                .extension(ConnectInfo(SocketAddr::from(LOOPBACK)))
                // `name` is a required field — this must fail to deserialize.
                .body(Body::from(r#"{"type":"stdio","command":"npx"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let value: Value = body_as_json(response.into_body()).await;
    assert_eq!(value["success"], false);
    assert_eq!(value["code"], "MCP_PROBE_INVALID_CONFIG");
}

#[tokio::test]
async fn unreachable_stdio_server_returns_disconnected_result() {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let bogus = format!("this-binary-definitely-does-not-exist-{nanos}");
    let payload = serde_json::json!({
        "type": "stdio",
        "name": "ghost",
        "command": bogus,
        "args": [],
        "env": []
    });
    let app = test_app();
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/mcp-servers/probe")
                .header("content-type", "application/json")
                .extension(ConnectInfo(SocketAddr::from(LOOPBACK)))
                .body(Body::from(payload.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let value: Value = body_as_json(response.into_body()).await;
    assert_eq!(value["success"], true);
    assert_eq!(value["data"]["status"], "disconnected");
    let error = value["data"]["error"].as_str().expect("error string");
    assert!(
        !error.contains(&bogus) || error.contains("spawn failed"),
        "error must not echo the bogus command verbatim: {error}"
    );
    assert!(error.contains("spawn failed"));
}

/// Probe config whose stdio command would create `marker` if it were spawned.
fn marker_probe_payload(marker: &std::path::Path) -> Value {
    serde_json::json!({
        "type": "stdio",
        "name": "spawn-canary",
        "command": "sh",
        "args": ["-c", format!("touch {}", marker.display())],
        "env": []
    })
}

async fn post_probe(
    app: axum::Router,
    peer: ([u8; 4], u16),
    payload: &Value,
) -> axum::response::Response {
    app.oneshot(
        Request::builder()
            .method("POST")
            .uri("/mcp-servers/probe")
            .header("content-type", "application/json")
            .extension(ConnectInfo(SocketAddr::from(peer)))
            .body(Body::from(payload.to_string()))
            .unwrap(),
    )
    .await
    .unwrap()
}

fn unique_marker(label: &str) -> std::path::PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    std::env::temp_dir().join(format!("termul-probe-canary-{label}-{nanos}"))
}

/// D8-F1: a non-loopback peer without `--allow-remote-writes`, and ANY peer in
/// shared-live mode, is refused with `FORBIDDEN` and the stdio command is never
/// spawned (no marker file appears even after the 10 s probe window would have
/// let a spawned `touch` finish).
#[tokio::test]
async fn refused_postures_return_forbidden_and_never_spawn() {
    for (label, peer, allow_remote, shared_live) in [
        ("remote", REMOTE, false, false),
        ("shared-live-loopback", LOOPBACK, false, true),
        ("shared-live-optin", REMOTE, true, true),
    ] {
        let marker = unique_marker(label);
        let response = post_probe(
            test_app_with(allow_remote, shared_live),
            peer,
            &marker_probe_payload(&marker),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK, "{label}");
        let value = body_as_json(response.into_body()).await;
        assert_eq!(value["success"], false, "{label}");
        assert_eq!(value["code"], "FORBIDDEN", "{label}");
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert!(!marker.exists(), "{label}: refused probe must not spawn");
    }
}

/// Admitted postures (loopback by default; remote with the opt-in) still probe.
#[tokio::test]
async fn admitted_postures_still_run_the_probe() {
    for (label, peer, allow_remote) in [("loopback", LOOPBACK, false), ("remote-optin", REMOTE, true)]
    {
        let marker = unique_marker(label);
        let response = post_probe(
            test_app_with(allow_remote, false),
            peer,
            &marker_probe_payload(&marker),
        )
        .await;
        let value = body_as_json(response.into_body()).await;
        assert_eq!(value["success"], true, "{label}");
        assert_ne!(value["code"], "FORBIDDEN", "{label}");
        // The canary proves the admitted probe really spawned the command (a
        // probe that "succeeded" without spawning would pass the asserts above).
        let mut spawned = false;
        for _ in 0..50 {
            if marker.exists() {
                spawned = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        let _ = std::fs::remove_file(&marker);
        assert!(spawned, "{label}: admitted probe must spawn the command");
    }
}

async fn post_raw_probe(
    app: axum::Router,
    peer: ([u8; 4], u16),
    body: &'static str,
) -> axum::response::Response {
    app.oneshot(
        Request::builder()
            .method("POST")
            .uri("/mcp-servers/probe")
            .header("content-type", "application/json")
            .extension(ConnectInfo(SocketAddr::from(peer)))
            .body(Body::from(body))
            .unwrap(),
    )
    .await
    .unwrap()
}

/// The write guard runs BEFORE the body is parsed: a refused peer sending
/// invalid JSON still gets `FORBIDDEN`, while an admitted peer sending the same
/// body gets the parse error.
#[tokio::test]
async fn guard_runs_before_body_parse_for_invalid_json() {
    let denied = post_raw_probe(test_app_with(false, false), REMOTE, "{not json").await;
    assert_eq!(denied.status(), StatusCode::OK);
    let value = body_as_json(denied.into_body()).await;
    assert_eq!(value["success"], false);
    assert_eq!(value["code"], "FORBIDDEN");

    let allowed = post_raw_probe(test_app_with(false, false), LOOPBACK, "{not json").await;
    assert_eq!(allowed.status(), StatusCode::OK);
    let value = body_as_json(allowed.into_body()).await;
    assert_eq!(value["success"], false);
    assert_eq!(value["code"], "MCP_PROBE_INVALID_CONFIG");
}
