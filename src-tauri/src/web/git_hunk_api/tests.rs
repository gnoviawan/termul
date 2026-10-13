use super::*;
use crate::acp::AcpManager;
use crate::trackers::GitTracker;
use crate::web::sink::WsRelaySink;
use crate::web::test_pty_manager;
use crate::web::ws::HistoryMode;
use axum::body::Body;
use axum::http::Request;
use axum::routing::post;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tower::ServiceExt;

fn unique_dir(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let path = std::env::temp_dir().join(format!("termul-web-hunkapi-{label}-{nanos}"));
    std::fs::create_dir_all(&path).expect("create temp dir");
    path
}

fn test_state(root: &std::path::Path) -> AppState {
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
            &root.canonicalize().unwrap_or_else(|_| root.to_path_buf()),
        ),
        history_mode: HistoryMode::LiveOnly,
        pending_oauth_flows: std::sync::Arc::new(parking_lot::RwLock::new(
            std::collections::HashMap::new(),
        )),
        oauth_base_url: "http://127.0.0.1".to_string(),
        acp_catalog: None,
        acp_install: None,
        store: None,
        web_auth: None,
        allow_remote_writes: false,
        shared_live_writes_denied: false,
        connections: Default::default(),
    }
}

fn test_router(state: AppState) -> axum::Router {
    axum::Router::new()
        .route("/git/stage-hunk", post(stage_hunk))
        .route("/git/unstage-hunk", post(unstage_hunk))
        .with_state(state)
}

fn loopback() -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], 54321))
}

fn remote() -> SocketAddr {
    SocketAddr::from(([192, 168, 1, 50], 40000))
}

async fn post_json(
    state: AppState,
    uri: &str,
    body: &serde_json::Value,
    peer: SocketAddr,
) -> IpcBody<()> {
    let bytes = serde_json::to_vec(body).expect("serialize body");
    let resp = test_router(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .header(
                    crate::web::command_ledger::COMMAND_ID_HEADER,
                    crate::web::command_ledger::test_clock::fresh_command_id(),
                )
                .uri(uri)
                .header("content-type", "application/json")
                .extension(ConnectInfo(peer))
                .body(Body::from(bytes))
                .expect("build request"),
        )
        .await
        .expect("router response");
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("read body");
    serde_json::from_slice(&bytes).expect("deserialize IpcBody")
}

fn git_missing() -> bool {
    GitTracker::run_git_command(std::env::temp_dir().to_str().unwrap(), &["--version"]).is_none()
}

fn git(repo: &std::path::Path, args: &[&str]) -> String {
    let out = GitTracker::run_git_command(repo.to_str().unwrap(), args).expect("git");
    assert!(
        out.status.success(),
        "git {:?}: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn init_repo(tag: &str) -> PathBuf {
    let path = unique_dir(tag);
    for args in [
        ["init", "-q"].as_slice(),
        ["config", "user.email", "t@example.com"].as_slice(),
        ["config", "user.name", "Test"].as_slice(),
        ["config", "commit.gpgsign", "false"].as_slice(),
        ["config", "core.autocrlf", "false"].as_slice(),
    ] {
        git(&path, args);
    }
    path
}

/// Repo with `a.txt` committed and two separated unstaged hunks.
fn repo_with_two_hunks(tag: &str) -> PathBuf {
    let repo = init_repo(tag);
    std::fs::write(repo.join("a.txt"), "one\ntwo\nthree\nfour\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-qm", "init"]);
    std::fs::write(repo.join("a.txt"), "one\nTWO\nthree\nFOUR\n").unwrap();
    repo
}

fn hunk1_patch() -> &'static str {
    "--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n"
}

fn state_for(repo: &std::path::Path) -> AppState {
    test_state(repo.parent().unwrap_or_else(|| std::path::Path::new(".")))
}

fn req(repo: &std::path::Path, path: &str, patch: &str) -> serde_json::Value {
    serde_json::json!({ "cwd": repo.to_string_lossy(), "path": path, "hunkPatch": patch })
}

fn cached_diff(repo: &std::path::Path) -> String {
    git(repo, &["diff", "--cached", "--", "a.txt"])
}

#[tokio::test]
async fn stage_hunk_stages_only_that_hunk_then_unstage_reverses_it() {
    if git_missing() {
        return;
    }
    let repo = repo_with_two_hunks("roundtrip");
    let state = state_for(&repo);

    let body = post_json(
        state.clone(),
        "/git/stage-hunk",
        &req(&repo, "a.txt", hunk1_patch()),
        loopback(),
    )
    .await;
    assert!(body.success, "stage-hunk should succeed: {:?}", body.error);
    let staged = cached_diff(&repo);
    assert!(
        staged.contains("+TWO") && staged.contains("-two"),
        "{staged}"
    );
    assert!(
        !staged.contains("FOUR"),
        "hunk 2 must stay unstaged: {staged}"
    );
    let unstaged = git(&repo, &["diff", "--", "a.txt"]);
    assert!(unstaged.contains("+FOUR"), "{unstaged}");

    let body = post_json(
        state,
        "/git/unstage-hunk",
        &req(&repo, "a.txt", hunk1_patch()),
        loopback(),
    )
    .await;
    assert!(
        body.success,
        "unstage-hunk should succeed: {:?}",
        body.error
    );
    assert!(cached_diff(&repo).trim().is_empty());
    std::fs::remove_dir_all(&repo).ok();
}

#[tokio::test]
async fn hunk_routes_refused_from_non_loopback_peer_and_repo_untouched() {
    if git_missing() {
        return;
    }
    let repo = repo_with_two_hunks("guard");
    for uri in ["/git/stage-hunk", "/git/unstage-hunk"] {
        let body = post_json(
            state_for(&repo),
            uri,
            &req(&repo, "a.txt", hunk1_patch()),
            remote(),
        )
        .await;
        assert!(!body.success);
        assert_eq!(body.code.as_deref(), Some("FORBIDDEN"), "{uri}");
    }
    assert!(cached_diff(&repo).trim().is_empty());
    std::fs::remove_dir_all(&repo).ok();
}

#[tokio::test]
async fn hunk_route_refused_when_shared_live_writes_denied() {
    if git_missing() {
        return;
    }
    let repo = repo_with_two_hunks("shared-live");
    let mut state = state_for(&repo);
    state.shared_live_writes_denied = true;
    let body = post_json(
        state,
        "/git/stage-hunk",
        &req(&repo, "a.txt", hunk1_patch()),
        loopback(),
    )
    .await;
    assert!(!body.success);
    assert_eq!(body.code.as_deref(), Some("FORBIDDEN"));
    assert!(cached_diff(&repo).trim().is_empty());
    std::fs::remove_dir_all(&repo).ok();
}

#[tokio::test]
async fn stage_hunk_admitted_from_non_loopback_peer_when_opt_in() {
    if git_missing() {
        return;
    }
    let repo = repo_with_two_hunks("opt-in");
    let mut state = state_for(&repo);
    state.allow_remote_writes = true;
    let body = post_json(
        state,
        "/git/stage-hunk",
        &req(&repo, "a.txt", hunk1_patch()),
        remote(),
    )
    .await;
    assert!(body.success, "opt-in must admit: {:?}", body.error);
    assert!(cached_diff(&repo).contains("+TWO"));
    std::fs::remove_dir_all(&repo).ok();
}

#[tokio::test]
async fn hunk_route_rejects_cwd_outside_project_root() {
    let outside = unique_dir("outside");
    let inside = unique_dir("inside");
    let state = test_state(&inside);
    let body = post_json(
        state,
        "/git/stage-hunk",
        &req(&outside, "a.txt", hunk1_patch()),
        loopback(),
    )
    .await;
    assert!(!body.success);
    assert_eq!(body.code.as_deref(), Some("OUTSIDE_PROJECT_ROOT"));
    std::fs::remove_dir_all(&outside).ok();
    std::fs::remove_dir_all(&inside).ok();
}

#[tokio::test]
async fn hunk_route_classifies_validation_failures_as_invalid_hunk_patch() {
    if git_missing() {
        return;
    }
    let repo = repo_with_two_hunks("invalid");
    let cases = [
        // Header names a different path than the request.
        (
            "a.txt",
            "--- a/secret.txt\n+++ b/secret.txt\n@@ -1,1 +1,1 @@\n-one\n+two\n",
        ),
        // Missing ---/+++ headers.
        ("a.txt", "@@ -1,1 +1,1 @@\n-one\n+two\n"),
        // Unsafe request path.
        (
            "../escape.txt",
            "--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b\n",
        ),
    ];
    for (path, patch) in cases {
        let body = post_json(
            state_for(&repo),
            "/git/stage-hunk",
            &req(&repo, path, patch),
            loopback(),
        )
        .await;
        assert!(!body.success, "{path}");
        assert_eq!(body.code.as_deref(), Some("INVALID_HUNK_PATCH"), "{path}");
    }
    assert!(cached_diff(&repo).trim().is_empty());
    std::fs::remove_dir_all(&repo).ok();
}

#[tokio::test]
async fn hunk_route_classifies_stale_hunk_as_does_not_apply() {
    if git_missing() {
        return;
    }
    let repo = repo_with_two_hunks("stale");
    // Context/removed lines do not exist in the index.
    let stale = "--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n nope\n-missing\n+TWO\n gone\n";
    let body = post_json(
        state_for(&repo),
        "/git/stage-hunk",
        &req(&repo, "a.txt", stale),
        loopback(),
    )
    .await;
    assert!(!body.success);
    assert_eq!(body.code.as_deref(), Some("HUNK_DOES_NOT_APPLY"));

    // Unstaging a hunk that was never staged is equally stale.
    let body = post_json(
        state_for(&repo),
        "/git/unstage-hunk",
        &req(&repo, "a.txt", hunk1_patch()),
        loopback(),
    )
    .await;
    assert!(!body.success);
    assert_eq!(body.code.as_deref(), Some("HUNK_DOES_NOT_APPLY"));
    std::fs::remove_dir_all(&repo).ok();
}

#[test]
fn classify_hunk_error_maps_every_class() {
    use HunkOp::{Stage, Unstage};
    for msg in [
        "Refusing hunk patch for unsafe path: ../x",
        "Hunk patch path 'b.txt' does not match expected 'a.txt'",
        "Hunk patch is missing its --- or +++ header",
    ] {
        assert_eq!(
            classify_hunk_error(Stage, msg),
            "INVALID_HUNK_PATCH",
            "{msg}"
        );
    }
    assert_eq!(
        classify_hunk_error(
            Unstage,
            "error: patch failed: a.txt:1\nerror: a.txt: patch does not apply"
        ),
        "HUNK_DOES_NOT_APPLY"
    );
    assert_eq!(
        classify_hunk_error(Stage, "error: a.txt: patch does not apply"),
        "HUNK_DOES_NOT_APPLY"
    );
    assert_eq!(
        classify_hunk_error(Stage, "git apply timed out after 30000ms"),
        "GIT_TIMEOUT"
    );
    assert_eq!(
        classify_hunk_error(Stage, "Failed to spawn git apply: boom"),
        "GIT_STAGE_HUNK_ERROR"
    );
    assert_eq!(
        classify_hunk_error(Unstage, "git apply wait failed: boom"),
        "GIT_UNSTAGE_HUNK_ERROR"
    );
    assert_eq!(
        classify_hunk_error(Unstage, "something unexpected"),
        "GIT_UNSTAGE_HUNK_ERROR"
    );
}
