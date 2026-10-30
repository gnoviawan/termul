//! Tests for the setup-mode router (gh-1105): token gating on `/setup/*`,
//! the health flag, validate/apply semantics, and the SPA fallback.

use super::*;
use crate::web::origin::OriginPolicy;
use axum::body::Body;
use axum::http::Request;
use std::fs;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tower::ServiceExt;

const SETUP_TOKEN: &str = "setup-token_0123-ABC";

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
        let path = std::env::temp_dir().join(format!("termul-web-setup-{label}-{nanos}"));
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

/// Build the setup router against a fixture static dir + a recording
/// restart hook (the real hook re-execs the process — never run it in tests).
/// `web_auth` = the `resolve` result threaded in by `server_main`:
/// `(token_text, operator_configured)`.
fn test_router(
    dir: &Path,
    state_dir: &Path,
    web_auth: Option<(&str, bool)>,
    restarts: &Arc<AtomicUsize>,
) -> Router {
    let restart_counter = Arc::clone(restarts);
    let state = SetupState {
        setup_token: SETUP_TOKEN.to_string(),
        defaults: ServerSetupAnswers {
            host: "127.0.0.1".to_string(),
            port: 8080,
            sessions_dir: PathBuf::from("/srv/termul/sessions"),
            projects_file: PathBuf::from("/srv/termul/projects.json"),
            allow_remote_writes: false,
            update_channel: None,
            update_interval_secs: 21600,
        },
        state_dir: state_dir.to_path_buf(),
        web_auth_token: web_auth.map(|(token, _)| token.to_string()),
        web_auth_configured: web_auth.is_some_and(|(_, configured)| configured),
        restart_hook: Arc::new(move |_| {
            restart_counter.fetch_add(1, Ordering::SeqCst);
        }),
        apply_in_flight: Arc::new(AtomicBool::new(false)),
    };
    router_with_static(state, dir, OriginPolicy::default())
}

fn fixture_dir(label: &str) -> TempDir {
    let dir = TempDir::new(label);
    fs::write(
        dir.path().join("index.html"),
        "<!doctype html><html><body>termul-setup-fixture</body></html>",
    )
    .expect("write index.html");
    dir
}

async fn body_json(response: Response) -> serde_json::Value {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("read body");
    serde_json::from_slice(&bytes).expect("JSON body")
}

fn answers_json(host: &str, port: u16) -> String {
    serde_json::json!({
        "host": host,
        "port": port,
        "sessionsDir": "/srv/termul/sessions",
        "projectsFile": "/srv/termul/projects.json",
        "allowRemoteWrites": false,
        "updateChannel": null,
        "updateIntervalSecs": 21600,
    })
    .to_string()
}

fn setup_post(path: &str, token: Option<&str>, body: &str) -> Request<Body> {
    let builder = Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/json");
    let builder = match token {
        Some(token) => builder.header("authorization", format!("Bearer {token}")),
        None => builder,
    };
    builder.body(Body::from(body.to_string())).unwrap()
}

// --- /health ----------------------------------------------------------------

#[tokio::test]
async fn health_reports_setup_required() {
    let dir = fixture_dir("health");
    let state_dir = TempDir::new("health-state");
    let restarts = Arc::new(AtomicUsize::new(0));
    let resp = test_router(dir.path(), state_dir.path(), None, &restarts)
        .oneshot(Request::builder().uri("/health").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let parsed = body_json(resp).await;
    assert_eq!(parsed["status"], "ok");
    assert_eq!(
        parsed["setupRequired"], true,
        "the setup router's /health must advertise setupRequired so the \
         client's pre-auth gate mounts the wizard"
    );
    assert_eq!(
        parsed["allowRemoteWrites"], false,
        "setup mode mounts no write routes — nothing can write"
    );
    assert_eq!(
        parsed["caseInsensitivePaths"],
        cfg!(any(windows, target_os = "macos")),
    );
}

// --- token gate --------------------------------------------------------------

#[tokio::test]
async fn setup_routes_reject_missing_or_wrong_token() {
    let dir = fixture_dir("gate");
    let state_dir = TempDir::new("gate-state");
    let restarts = Arc::new(AtomicUsize::new(0));
    let app = test_router(dir.path(), state_dir.path(), None, &restarts);

    for uri in ["/setup/status", "/setup/validate", "/setup/apply"] {
        let resp = app
            .clone()
            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED, "GET {uri}");
        let parsed = body_json(resp).await;
        assert_eq!(parsed["code"], "UNAUTHORIZED");
    }

    // Wrong tokens (query + bearer forms) are also refused.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/setup/status?setup=wrong-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/setup/status")
                .header("authorization", "Bearer wrong-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn setup_status_accepts_query_and_bearer_token() {
    let dir = fixture_dir("status");
    let state_dir = TempDir::new("status-state");
    let restarts = Arc::new(AtomicUsize::new(0));
    let app = test_router(dir.path(), state_dir.path(), None, &restarts);

    for uri in [
        format!("/setup/status?setup={SETUP_TOKEN}"),
        // `?setup=` may sit alongside other query params.
        format!("/setup/status?x=1&setup={SETUP_TOKEN}&y=2"),
    ] {
        let resp = app
            .clone()
            .oneshot(Request::builder().uri(&uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK, "{uri}");
        let parsed = body_json(resp).await;
        assert_eq!(parsed["success"], true, "{parsed}");
        assert_eq!(parsed["data"]["setupRequired"], true);
        assert_eq!(parsed["data"]["defaults"]["port"], 8080);
        assert_eq!(parsed["data"]["defaults"]["host"], "127.0.0.1");
        assert_eq!(
            parsed["data"]["defaults"]["sessionsDir"], "/srv/termul/sessions",
            "GET /setup/status returns the ServerSetupAnswers defaults"
        );
    }

    let resp = app
        .oneshot(
            Request::builder()
                .uri("/setup/status")
                .header("authorization", format!("Bearer {SETUP_TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
}

// --- /setup/validate ---------------------------------------------------------

#[tokio::test]
async fn validate_returns_per_field_errors_and_writes_nothing() {
    let dir = fixture_dir("validate");
    let state_dir = TempDir::new("validate-state");
    let restarts = Arc::new(AtomicUsize::new(0));
    let app = test_router(dir.path(), state_dir.path(), None, &restarts);

    // `updateChannel` must stay a valid enum spelling — an invalid one fails
    // serde before the handler. A set channel with a 0 interval produces the
    // `updateIntervalSecs` field error instead.
    let bad = serde_json::json!({
        "host": "10.0.0.5",
        "port": 0,
        "sessionsDir": "",
        "projectsFile": "",
        "allowRemoteWrites": false,
        "updateChannel": "stable",
        "updateIntervalSecs": 0,
    })
    .to_string();
    let resp = app
        .clone()
        .oneshot(setup_post("/setup/validate", Some(SETUP_TOKEN), &bad))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK, "validate is a dry-run probe — 200 either way");
    let parsed = body_json(resp).await;
    assert_eq!(parsed["success"], true, "{parsed}");
    assert_eq!(parsed["data"]["ok"], false);
    for field in ["host", "port", "sessionsDir", "projectsFile", "updateIntervalSecs"] {
        assert!(
            parsed["data"]["fieldErrors"][field].is_string(),
            "expected a field error for {field}: {parsed}"
        );
    }
    // Nothing is persisted by a dry run.
    assert!(!server_config_file::server_config_path(state_dir.path()).exists());

    let good = answers_json("0.0.0.0", 9090);
    let resp = app
        .oneshot(setup_post("/setup/validate", Some(SETUP_TOKEN), &good))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let parsed = body_json(resp).await;
    assert_eq!(parsed["data"]["ok"], true);
    assert_eq!(parsed["data"]["fieldErrors"], serde_json::json!({}));
}

// --- /setup/apply ------------------------------------------------------------

#[tokio::test]
async fn apply_writes_config_replies_and_schedules_restart() {
    let dir = fixture_dir("apply");
    let state_dir = TempDir::new("apply-state");
    let restarts = Arc::new(AtomicUsize::new(0));
    let app = test_router(
        dir.path(),
        state_dir.path(),
        Some(("file-web-auth-token", false)),
        &restarts,
    );

    let resp = app
        .oneshot(setup_post(
            &format!("/setup/apply?setup={SETUP_TOKEN}"),
            None, // token via `?setup=` query — the printed-URL form
            &answers_json("0.0.0.0", 9090),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let parsed = body_json(resp).await;
    assert_eq!(parsed["success"], true, "{parsed}");
    assert_eq!(parsed["data"]["ok"], true);
    assert_eq!(parsed["data"]["host"], "0.0.0.0");
    assert_eq!(parsed["data"]["port"], 9090);
    assert_eq!(
        parsed["data"]["webAuthToken"], "file-web-auth-token",
        "a non-loopback post-setup bind is gated by the persisted token — \
         the reply hands it to the client for `#token=`"
    );
    assert_eq!(
        restarts.load(Ordering::SeqCst),
        1,
        "a successful apply schedules the self-restart"
    );

    // server-config.json was written with the validated answers.
    let path = server_config_file::server_config_path(state_dir.path());
    assert!(path.exists(), "apply must write server-config.json");
    let written: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(written["host"], "0.0.0.0");
    assert_eq!(written["port"], 9090);
    assert_eq!(written["sessionsDir"], "/srv/termul/sessions");
}

#[tokio::test]
async fn apply_omits_web_auth_token_for_loopback_post_setup() {
    let dir = fixture_dir("apply-loopback");
    let state_dir = TempDir::new("apply-loopback-state");
    let restarts = Arc::new(AtomicUsize::new(0));
    // A generated/loaded token (configured=false) is only demanded on a
    // non-loopback post-setup bind — a loopback answer must not leak it.
    let app = test_router(
        dir.path(),
        state_dir.path(),
        Some(("file-web-auth-token", false)),
        &restarts,
    );
    let resp = app
        .oneshot(setup_post(
            "/setup/apply",
            Some(SETUP_TOKEN),
            &answers_json("127.0.0.1", 8080),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let parsed = body_json(resp).await;
    assert_eq!(parsed["data"]["ok"], true);
    assert!(
        parsed["data"].get("webAuthToken").is_none(),
        "loopback post-setup bind with no configured token is ungated: {parsed}"
    );
}

#[tokio::test]
async fn apply_includes_configured_token_even_on_loopback() {
    let dir = fixture_dir("apply-configured");
    let state_dir = TempDir::new("apply-configured-state");
    let restarts = Arc::new(AtomicUsize::new(0));
    // An operator-configured token keeps gating a loopback post-setup bind
    // (`resolve` honors it on any bind), so the reply still hands it over.
    let app = test_router(
        dir.path(),
        state_dir.path(),
        Some(("configured-token", true)),
        &restarts,
    );
    let resp = app
        .oneshot(setup_post(
            "/setup/apply",
            Some(SETUP_TOKEN),
            &answers_json("127.0.0.1", 8080),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let parsed = body_json(resp).await;
    assert_eq!(parsed["data"]["webAuthToken"], "configured-token");
}

/// An ungated setup boot (e.g. explicit `--host 127.0.0.1`) carries no
/// resolved token — but a PUBLIC post-setup bind will still gate. The apply
/// must mint + persist `<state_dir>/web-auth-token` NOW (the same secret the
/// re-exec'd `resolve` loads) and hand it to the client, or the browser
/// would land on a gated origin with no credential.
#[tokio::test]
async fn apply_mints_the_gate_token_when_ungated_boot_goes_public() {
    let dir = fixture_dir("apply-mint");
    let state_dir = TempDir::new("apply-mint-state");
    let restarts = Arc::new(AtomicUsize::new(0));
    let app = test_router(dir.path(), state_dir.path(), None, &restarts);

    let resp = app
        .oneshot(setup_post(
            "/setup/apply",
            Some(SETUP_TOKEN),
            &answers_json("0.0.0.0", 9090),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let parsed = body_json(resp).await;
    let token = parsed["data"]["webAuthToken"]
        .as_str()
        .expect("a public post-setup bind must issue a token");
    assert!(!token.is_empty());
    // The persisted file is what the re-exec'd `resolve` loads — same secret.
    let file = std::fs::read_to_string(
        state_dir
            .path()
            .join(crate::web::auth::WEB_AUTH_TOKEN_FILE),
    )
    .expect("web-auth-token file persisted");
    assert_eq!(file.trim(), token);
    assert_eq!(restarts.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn apply_rejects_invalid_answers_and_writes_nothing() {
    let dir = fixture_dir("apply-invalid");
    let state_dir = TempDir::new("apply-invalid-state");
    let restarts = Arc::new(AtomicUsize::new(0));
    let app = test_router(dir.path(), state_dir.path(), None, &restarts);

    let bad = answers_json("127.0.0.1", 0); // port 0 is invalid
    let resp = app
        .oneshot(setup_post("/setup/apply", Some(SETUP_TOKEN), &bad))
        .await
        .unwrap();
    assert_eq!(
        resp.status(),
        StatusCode::OK,
        "a validation verdict rides the 200 IpcBody envelope like the dry-run"
    );
    let parsed = body_json(resp).await;
    assert_eq!(parsed["success"], true, "{parsed}");
    assert_eq!(parsed["data"]["ok"], false);
    assert!(parsed["data"]["fieldErrors"]["port"].is_string(), "{parsed}");
    assert!(!server_config_file::server_config_path(state_dir.path()).exists());
    assert_eq!(restarts.load(Ordering::SeqCst), 0, "no restart on rejection");
}

/// A successful apply latches `apply_in_flight` for the rest of the boot —
/// a second apply during the pending-restart window must be refused
/// (it would write a config the caller is never redirected to).
#[tokio::test]
async fn apply_allows_one_apply_then_conflicts() {
    let dir = fixture_dir("apply-once");
    let state_dir = TempDir::new("apply-once-state");
    let restarts = Arc::new(AtomicUsize::new(0));
    let app = test_router(dir.path(), state_dir.path(), None, &restarts);

    let first = app
        .clone()
        .oneshot(setup_post(
            "/setup/apply",
            Some(SETUP_TOKEN),
            &answers_json("127.0.0.1", 8080),
        ))
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(body_json(first).await["data"]["ok"], true);

    let second = app
        .oneshot(setup_post(
            "/setup/apply",
            Some(SETUP_TOKEN),
            &answers_json("127.0.0.1", 9090),
        ))
        .await
        .unwrap();
    assert_eq!(second.status(), StatusCode::CONFLICT);
    let parsed = body_json(second).await;
    assert_eq!(parsed["code"], "SETUP_APPLY_IN_PROGRESS", "{parsed}");
    assert_eq!(
        restarts.load(Ordering::SeqCst),
        1,
        "only the first apply may schedule a restart"
    );
}

/// A FAILED apply must release the latch — a validation or write failure
/// leaves the server running, so retrying has to stay possible (the latch
/// only stays set on the success path, where a restart is pending).
#[tokio::test]
async fn apply_releases_the_latch_after_a_failed_apply() {
    let dir = fixture_dir("apply-retry");
    let state_dir = TempDir::new("apply-retry-state");
    let restarts = Arc::new(AtomicUsize::new(0));
    let app = test_router(dir.path(), state_dir.path(), None, &restarts);

    // Rejected by validation — writes nothing, must not lock the route.
    let bad = answers_json("127.0.0.1", 0);
    let resp = app
        .clone()
        .oneshot(setup_post("/setup/apply", Some(SETUP_TOKEN), &bad))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(body_json(resp).await["data"]["ok"], false);

    // A follow-up VALID apply still goes through — the failed one released
    // the latch instead of wedging the server.
    let resp = app
        .oneshot(setup_post(
            "/setup/apply",
            Some(SETUP_TOKEN),
            &answers_json("127.0.0.1", 8080),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(body_json(resp).await["data"]["ok"], true);
    assert_eq!(restarts.load(Ordering::SeqCst), 1);
}

// --- origin layer + SPA fallback ---------------------------------------------

#[tokio::test]
async fn origin_layer_rejects_foreign_post_origin() {
    let dir = fixture_dir("origin");
    let state_dir = TempDir::new("origin-state");
    let restarts = Arc::new(AtomicUsize::new(0));
    let app = test_router(dir.path(), state_dir.path(), None, &restarts);

    // A browser POST carrying a foreign Origin is refused by origin::layer
    // BEFORE the setup-token gate — even with a valid token.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/setup/validate")
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {SETUP_TOKEN}"))
                .header("origin", "http://evil.example:9999")
                .header("host", "127.0.0.1:8080")
                .body(Body::from(answers_json("127.0.0.1", 8080)))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);

    // A same-origin POST passes the origin layer and reaches the gate.
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/setup/validate")
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {SETUP_TOKEN}"))
                .header("origin", "http://127.0.0.1:8080")
                .header("host", "127.0.0.1:8080")
                .body(Body::from(answers_json("127.0.0.1", 8080)))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn spa_fallback_serves_the_onboarding_page_without_a_token() {
    let dir = fixture_dir("spa");
    let state_dir = TempDir::new("spa-state");
    let restarts = Arc::new(AtomicUsize::new(0));
    let app = test_router(dir.path(), state_dir.path(), None, &restarts);

    // The bootstrap URL `/?setup=<token>` loads the SPA unauthenticated —
    // the token only gates the /setup/* API.
    for uri in ["/", "/?setup=whatever", "/some/client-route"] {
        let resp = app
            .clone()
            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK, "{uri}");
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("body");
        assert!(
            String::from_utf8_lossy(&body).contains("termul-setup-fixture"),
            "{uri} should serve index.html"
        );
    }
}

// --- token extraction helpers --------------------------------------------------

#[test]
fn setup_query_token_parses_the_setup_param() {
    assert_eq!(
        setup_query_token("setup=abc123").as_deref(),
        Some("abc123")
    );
    assert_eq!(
        setup_query_token("a=1&setup=t_ok&b=2").as_deref(),
        Some("t_ok")
    );
    // Percent-escapes decode before comparison.
    assert_eq!(
        setup_query_token("setup=a%2Db").as_deref(),
        Some("a-b")
    );
    assert_eq!(setup_query_token("other=1"), None);
    assert_eq!(setup_query_token(""), None);
}

#[test]
fn percent_decode_only_decodes_hex_escapes() {
    assert_eq!(percent_decode("plain-text_1"), "plain-text_1");
    assert_eq!(percent_decode("a%2Db%5F"), "a-b_");
    // A bare `+` stays literal — it can never belong to a base64url token.
    assert_eq!(percent_decode("a+b"), "a+b");
    // Truncated/invalid escapes pass through untouched.
    assert_eq!(percent_decode("a%2"), "a%2");
    assert_eq!(percent_decode("a%zz"), "a%zz");
}

#[test]
fn setup_gate_compares_in_constant_time_shape() {
    let gate = SetupGate {
        token: SETUP_TOKEN.to_string(),
    };
    assert!(gate.accepts(SETUP_TOKEN));
    assert!(!gate.accepts("wrong"));
    assert!(!gate.accepts(""));
    // A different-length candidate never matches (ct_eq length check).
    assert!(!gate.accepts(&format!("{SETUP_TOKEN}x")));
}
