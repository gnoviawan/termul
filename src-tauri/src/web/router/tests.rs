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
        false,
        false,
        None,
    )
}

#[tokio::test]
async fn factory_key_http_requires_active_gate_even_on_loopback() {
    let dir = TempDir::new("factory-key");
    for method in ["GET", "POST"] {
        let response = test_router_with_fixture(dir.path())
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri("/acp/factory-key")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"config":{},"key":"candidate"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
    assert!(requires_token("/acp/factory-key"));
}

#[tokio::test]
async fn factory_key_http_requires_correct_bearer_when_gated() {
    let dir = TempDir::new("factory-key-gated");
    let auth = Arc::new(WebAuth::new(
        crate::web::auth::WebAuthToken::new("test-token").unwrap(),
    ));
    let app = router_with_static(
        Arc::new(AcpManager::new(vec![])),
        crate::web::test_pty_manager(),
        Arc::new(WsRelaySink::new()),
        Arc::new(crate::web::project_registry::ProjectRegistry::new()),
        dir.path(),
        std::env::temp_dir(),
        false,
        false,
        Some(auth),
    );
    for method in ["GET", "POST"] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri("/acp/factory-key")
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    let response = app
        .oneshot(
            Request::builder()
                .uri("/acp/factory-key")
                .header("authorization", "Bearer test-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn health_returns_capability_json_for_loopback_peer() {
    // Default fixture: `allow_remote_writes=false`,
    // `shared_live_writes_denied=false`. A loopback peer (the default for
    // a same-origin browser) is admitted by `check_local_only` regardless
    // of the opt-in, so `/health` reports `allowRemoteWrites:true`.
    let dir = TempDir::new("health");
    let resp = test_router_with_fixture(dir.path())
        .oneshot(
            Request::builder()
                .uri("/health")
                .extension(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 54321))))
                .body(Body::empty())
                .expect("build request"),
        )
        .await
        .expect("router response");
    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("read body");
    let parsed: serde_json::Value = serde_json::from_slice(&body).expect("health body is JSON");
    assert_eq!(parsed["status"], "ok");
    assert_eq!(
        parsed["allowRemoteWrites"], true,
        "loopback peer must be admitted even without the opt-in (mirrors check_local_only)"
    );
}

/// Non-loopback peer WITHOUT the opt-in → `allowRemoteWrites:false`. This
/// is the tunnel/LAN client whose server denies writes; the client must
/// hide the picker so it never reaches a launch that `FORBIDDEN`s.
#[tokio::test]
async fn health_reports_denied_for_non_loopback_without_opt_in() {
    let dir = TempDir::new("health-remote");
    let app = router_with_static(
        Arc::new(AcpManager::new(vec![])),
        crate::web::test_pty_manager(),
        Arc::new(WsRelaySink::new()),
        Arc::new(crate::web::project_registry::ProjectRegistry::new()),
        dir.path(),
        std::env::temp_dir(),
        false, // allow_remote_writes (no opt-in)
        false, // shared_live_writes_denied (standalone)
        None,  // web_auth (ungated)
    );
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/health")
                .extension(ConnectInfo(SocketAddr::from(([192, 168, 1, 50], 40000))))
                .body(Body::empty())
                .expect("build request"),
        )
        .await
        .expect("router response");
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("read body");
    let parsed: serde_json::Value = serde_json::from_slice(&body).expect("health body is JSON");
    assert_eq!(
        parsed["allowRemoteWrites"], false,
        "non-loopback peer without opt-in must be denied"
    );
}

/// Desktop shared-live (`shared_live_writes_denied=true`) reports `false`
/// for EVERY peer — even a loopback peer — because the deployment-mode
/// deny takes precedence. The client keeps the picker hidden on this path
/// (writes are genuinely denied server-side).
#[tokio::test]
async fn health_reports_denied_for_all_peers_when_shared_live() {
    let dir = TempDir::new("health-shared-live");
    let app = router_with_static(
        Arc::new(AcpManager::new(vec![])),
        crate::web::test_pty_manager(),
        Arc::new(WsRelaySink::new()),
        Arc::new(crate::web::project_registry::ProjectRegistry::new()),
        dir.path(),
        std::env::temp_dir(),
        true, // allow_remote_writes (would admit non-loopback on standalone)
        true, // shared_live_writes_denied (desktop shared-live overrides)
        None, // web_auth (ungated)
    );
    // Even a loopback peer is denied on shared-live.
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/health")
                .extension(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 54321))))
                .body(Body::empty())
                .expect("build request"),
        )
        .await
        .expect("router response");
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("read body");
    let parsed: serde_json::Value = serde_json::from_slice(&body).expect("health body is JSON");
    assert_eq!(
        parsed["allowRemoteWrites"], false,
        "shared-live deny must override loopback peer + allow_remote_writes"
    );
}

/// `allow_remote_writes=true` + `shared_live_writes_denied=false` → a
/// non-loopback peer is ADMITTED (`allowRemoteWrites:true`). This is the
/// standalone `termul-server --allow-remote-writes` posture.
#[tokio::test]
async fn health_reports_admitted_for_non_loopback_with_opt_in() {
    let dir = TempDir::new("health-opt-in");
    let app = router_with_static(
        Arc::new(AcpManager::new(vec![])),
        crate::web::test_pty_manager(),
        Arc::new(WsRelaySink::new()),
        Arc::new(crate::web::project_registry::ProjectRegistry::new()),
        dir.path(),
        std::env::temp_dir(),
        true,  // allow_remote_writes (opt-in)
        false, // shared_live_writes_denied (standalone, not shared-live)
        None,  // web_auth (ungated)
    );
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/health")
                .extension(ConnectInfo(SocketAddr::from(([10, 0, 0, 5], 50000))))
                .body(Body::empty())
                .expect("build request"),
        )
        .await
        .expect("router response");
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("read body");
    let parsed: serde_json::Value = serde_json::from_slice(&body).expect("health body is JSON");
    assert_eq!(
        parsed["allowRemoteWrites"], true,
        "non-loopback peer with opt-in must be admitted"
    );
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
    fs::write(dir.path().join("assets/app.js"), "console.log('fixture');").expect("write asset");

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

// --- web auth gate middleware (CAP-1 interim, QA remediation Story 1) ---

fn gated_router_with_fixture(dir: &Path) -> Router {
    router_with_static(
        Arc::new(AcpManager::new(vec![])),
        crate::web::test_pty_manager(),
        Arc::new(WsRelaySink::new()),
        Arc::new(crate::web::project_registry::ProjectRegistry::new()),
        dir,
        std::env::temp_dir(),
        false,
        false,
        Some(Arc::new(WebAuth::new(
            crate::web::auth::WebAuthToken::new("t0ken").expect("non-empty"),
        ))),
    )
}

#[test]
fn requires_token_covers_api_prefixes_and_public_paths() {
    for public in [
        "/health",
        "/ws",
        "/terminal/ws",
        "/oauth/callback",
        "/",
        "/index.html",
        "/assets/app.js",
        "/some/deep/client-route",
    ] {
        assert!(!requires_token(public), "{public} must stay public");
    }
    for gated in [
        "/projects",
        "/projects/default",
        "/projects/p-1",
        "/mcp-servers",
        "/mcp-servers/probe",
        "/mcp-servers/oauth/start",
        "/fs/ls",
        "/git/status",
        "/search/content",
        "/skills",
        "/skills/x",
        "/log/frontend-error",
        "/shells",
        "/workspace/p-1",
        "/acp/catalog",
        "/acp/install",
        "/worktree/list",
    ] {
        assert!(requires_token(gated), "{gated} must require the token");
    }
}
/// Drift fence: axum exposes no route enumeration, so scan this file's
/// source for route-registration literals (`$path` = the first string argument) and assert EVERY registered route
/// is either public or under a gated prefix. A future route added outside
/// the allowlist fails this test instead of shipping ungated.
#[test]
fn every_registered_route_is_public_or_gated() {
    let src = include_str!("../router.rs");
    let mut checked = 0usize;
    let mut rest = src;
    while let Some(pos) = rest.find(".route(\"") {
        let after = &rest[pos + ".route(\"".len()..];
        let end = after.find('"').expect("route path literal terminates");
        let path = &after[..end];
        assert!(
            PUBLIC_PATHS.contains(&path) || requires_token(path),
            "route {path} is neither public nor under a gated prefix"
        );
        checked += 1;
        rest = &after[end..];
    }
    assert!(
        checked > 20,
        "route scan must find the full table ({checked})"
    );
}

#[tokio::test]
async fn gated_router_refuses_query_param_token() {
    // The `?token=` query fallback was removed: bearer credentials must
    // not travel in URL query strings (access logs, proxies, Referer).
    // A correct token in the query alone is NOT accepted.
    let dir = TempDir::new("gated-query-token");
    let resp = gated_router_with_fixture(dir.path())
        .oneshot(
            Request::builder()
                .uri("/projects?token=t0ken")
                .body(Body::empty())
                .expect("build request"),
        )
        .await
        .expect("router response");
    assert_eq!(
        resp.status(),
        StatusCode::UNAUTHORIZED,
        "query-param tokens must not authenticate API routes"
    );
}

#[tokio::test]
async fn gated_router_refuses_api_without_token() {
    let dir = TempDir::new("gated-no-token");
    let resp = gated_router_with_fixture(dir.path())
        .oneshot(
            Request::builder()
                .uri("/projects")
                .body(Body::empty())
                .expect("build request"),
        )
        .await
        .expect("router response");
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("read body");
    let parsed: serde_json::Value = serde_json::from_slice(&body).expect("401 body is JSON");
    // IpcBody-shaped failure the renderer's REST helpers parse.
    assert_eq!(parsed["success"], false);
    assert_eq!(parsed["code"], "UNAUTHORIZED");
    assert_eq!(parsed["error"], "Unauthorized");
}

#[tokio::test]
async fn gated_router_admits_bearer_token() {
    let dir = TempDir::new("gated-token");
    for req in [
        // Canonical form.
        Request::builder()
            .uri("/projects")
            .header("Authorization", "Bearer t0ken")
            .body(Body::empty())
            .expect("build request"),
        // RFC 7235 case-insensitive scheme.
        Request::builder()
            .uri("/projects")
            .header("Authorization", "bearer t0ken")
            .body(Body::empty())
            .expect("build request"),
    ] {
        let resp = gated_router_with_fixture(dir.path())
            .oneshot(req)
            .await
            .expect("router response");
        assert_eq!(resp.status(), StatusCode::OK, "valid token must pass");
    }
    // Wrong token is refused.
    let resp = gated_router_with_fixture(dir.path())
        .oneshot(
            Request::builder()
                .uri("/projects")
                .header("Authorization", "Bearer WRONG")
                .body(Body::empty())
                .expect("build request"),
        )
        .await
        .expect("router response");
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn gated_router_public_paths_pass_without_token() {
    let dir = TempDir::new("gated-public");
    fs::write(
        dir.path().join("index.html"),
        "<!doctype html><html><body>termul-web-fixture</body></html>",
    )
    .expect("write index.html");
    let app = gated_router_with_fixture(dir.path());
    // /health passes.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/health")
                .extension(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 54321))))
                .body(Body::empty())
                .expect("build request"),
        )
        .await
        .expect("router response");
    assert_eq!(resp.status(), StatusCode::OK);
    // Static/SPA paths pass (the login page must load).
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
    // /ws passes the middleware (the non-WS GET then fails the upgrade
    // with a 4xx — NOT a 401 from the gate).
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/ws")
                .body(Body::empty())
                .expect("build request"),
        )
        .await
        .expect("router response");
    assert!(resp.status().is_client_error());
    assert_ne!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn ungated_router_admits_api_without_token() {
    // Frozen contract: an ungated server answers API routes without any
    // token (legacy behavior).
    let dir = TempDir::new("ungated-api");
    let resp = test_router_with_fixture(dir.path())
        .oneshot(
            Request::builder()
                .uri("/projects")
                .body(Body::empty())
                .expect("build request"),
        )
        .await
        .expect("router response");
    assert_eq!(resp.status(), StatusCode::OK);
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
                .extension(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 54321))))
                .body(Body::empty())
                .expect("build request"),
        )
        .await
        .expect("router response");
    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("read body");
    // The probe now returns JSON (capability body), not the bare "OK"
    // string — assert it's the handler's JSON, not the dropped static file.
    let parsed: serde_json::Value =
        serde_json::from_slice(&body).expect("health body is JSON, not the static file");
    assert_eq!(parsed["status"], "ok");
}
