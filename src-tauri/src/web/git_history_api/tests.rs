use super::*;
use crate::acp::AcpManager;
use crate::trackers::GitTracker;
use crate::web::sink::WsRelaySink;
use crate::web::test_pty_manager;
use crate::web::ws::HistoryMode;
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::Request;
use axum::routing::post;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tower::ServiceExt;

/// Temp dir removed on drop (panic-safe).
struct TempDir {
    path: PathBuf,
}
impl TempDir {
    fn new(label: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("termul-web-commitdetail-{label}-{nanos}"));
        std::fs::create_dir_all(&path).expect("create temp dir");
        Self { path }
    }
    fn path(&self) -> &std::path::Path {
        &self.path
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
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

async fn post_detail(
    state: AppState,
    cwd: &std::path::Path,
    hash: &str,
    peer: SocketAddr,
) -> IpcBody<GitCommitDetail> {
    let bytes = serde_json::to_vec(&serde_json::json!({
        "cwd": cwd.to_string_lossy(),
        "hash": hash
    }))
    .expect("serialize body");
    let resp = axum::Router::new()
        .route("/git/commit-detail", post(get_commit_detail))
        .with_state(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/git/commit-detail")
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

fn loopback() -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], 54321))
}

fn git_missing() -> bool {
    GitTracker::run_git_command(std::env::temp_dir().to_str().unwrap(), &["--version"]).is_none()
}

fn git(repo: &std::path::Path, args: &[&str]) -> String {
    let out =
        GitTracker::run_git_command(repo.to_str().unwrap(), args).expect("git command should run");
    assert!(
        out.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn repo_with_commit(root: &std::path::Path) -> String {
    git(root, &["init", "-q"]);
    git(root, &["config", "user.email", "t@example.com"]);
    git(root, &["config", "user.name", "Test"]);
    git(root, &["config", "commit.gpgsign", "false"]);
    git(root, &["config", "core.autocrlf", "false"]);
    std::fs::write(root.join("a.txt"), "l1\nl2\n").expect("write");
    git(root, &["add", "-A"]);
    git(root, &["commit", "-q", "-m", "Add a\n\nBody text."]);
    git(root, &["rev-parse", "HEAD"])
}

#[tokio::test]
async fn commit_detail_returns_message_and_files() {
    if git_missing() {
        return;
    }
    let root = TempDir::new("ok");
    let hash = repo_with_commit(root.path());

    let body = post_detail(test_state(root.path()), root.path(), &hash[..8], loopback()).await;
    assert!(body.success, "detail should succeed: {:?}", body.error);
    let detail = body.data.expect("data");
    assert_eq!(detail.hash, hash);
    assert_eq!(detail.message, "Add a\n\nBody text.");
    assert_eq!(detail.author_email, "t@example.com");
    assert_eq!(detail.files.len(), 1);
    assert_eq!(detail.files[0].path, "a.txt");
    assert_eq!(detail.files[0].added, Some(2));
}

#[tokio::test]
async fn commit_detail_serializes_camel_case_keys() {
    let detail: GitCommitDetail = serde_json::from_value(serde_json::json!({
        "hash": "h",
        "authorEmail": "e",
        "message": "m",
        "parents": [],
        "files": [{ "path": "p", "oldPath": null, "status": "M", "added": 1, "removed": null }],
        "filesTruncated": false
    }))
    .expect("deserialize detail");
    let body = IpcBody::ok(detail);
    let value = serde_json::to_value(body).expect("serialize");
    assert_eq!(value["data"]["authorEmail"], "e");
    assert_eq!(value["data"]["filesTruncated"], false);
    assert_eq!(
        value["data"]["files"][0]["oldPath"],
        serde_json::Value::Null
    );
    assert_eq!(
        value["data"]["files"][0]["removed"],
        serde_json::Value::Null
    );
    assert_eq!(value["data"]["files"][0]["status"], "M");
}

#[tokio::test]
async fn commit_detail_rejects_cwd_outside_project_root() {
    let outside = TempDir::new("outside");
    let inside = TempDir::new("inside");
    let body = post_detail(
        test_state(inside.path()),
        outside.path(),
        "abcd",
        loopback(),
    )
    .await;
    assert!(!body.success, "outside-root must be rejected");
    assert_eq!(body.code.as_deref(), Some("OUTSIDE_PROJECT_ROOT"));
}

#[tokio::test]
async fn commit_detail_refuses_a_non_hash() {
    let root = TempDir::new("bad-hash");
    let body = post_detail(test_state(root.path()), root.path(), "--all", loopback()).await;
    assert!(!body.success);
    assert_eq!(body.code.as_deref(), Some("INVALID_COMMIT_HASH"));
}

#[tokio::test]
async fn commit_detail_admits_non_loopback_peer_without_remote_writes() {
    if git_missing() {
        return;
    }
    let root = TempDir::new("remote-read");
    let hash = repo_with_commit(root.path());
    let state = test_state(root.path());
    assert!(
        !state.allow_remote_writes,
        "read route must not need the write flag"
    );

    let lan = SocketAddr::from(([192, 168, 1, 50], 40000));
    let body = post_detail(state, root.path(), &hash, lan).await;
    assert!(
        body.success,
        "LAN peer may read the detail: {:?}",
        body.error
    );
}

async fn post_file_diff(state: AppState, body: serde_json::Value) -> IpcBody<GitCommitFileDiff> {
    let bytes = serde_json::to_vec(&body).expect("serialize body");
    let resp = axum::Router::new()
        .route("/git/commit-file-diff", post(get_commit_file_diff))
        .with_state(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/git/commit-file-diff")
                .header("content-type", "application/json")
                .extension(ConnectInfo(loopback()))
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

#[tokio::test]
async fn commit_file_diff_returns_the_unified_diff() {
    if git_missing() {
        return;
    }
    let root = TempDir::new("file-diff");
    let hash = repo_with_commit(root.path());
    let body = post_file_diff(
        test_state(root.path()),
        serde_json::json!({ "cwd": root.path().to_string_lossy(), "hash": hash, "path": "a.txt" }),
    )
    .await;
    assert!(body.success, "file diff should succeed: {:?}", body.error);
    let result = body.data.expect("data");
    assert!(!result.too_large);
    assert!(result.diff.contains("+l1"), "{}", result.diff);
}

#[tokio::test]
async fn commit_file_diff_serializes_too_large_in_camel_case() {
    let body = IpcBody::ok(GitCommitFileDiff {
        diff: String::new(),
        too_large: true,
    });
    let value = serde_json::to_value(body).expect("serialize");
    assert_eq!(value["data"]["diff"], "");
    assert_eq!(value["data"]["tooLarge"], true);
}

#[tokio::test]
async fn commit_file_diff_refuses_a_blob_hash_without_running_its_content() {
    if git_missing() {
        return;
    }
    let root = TempDir::new("file-diff-blob");
    repo_with_commit(root.path());
    let target = root.path().join("pwned");
    std::fs::write(
        root.path().join("payload.tmp"),
        format!("--output={}", target.display()),
    )
    .expect("write payload");
    let blob = git(root.path(), &["hash-object", "-w", "payload.tmp"]);

    let body = post_file_diff(
        test_state(root.path()),
        serde_json::json!({ "cwd": root.path().to_string_lossy(), "hash": blob, "path": "a.txt" }),
    )
    .await;
    assert!(!body.success);
    assert_eq!(body.code.as_deref(), Some("GIT_COMMIT_DETAIL_ERROR"));
    assert!(!target.exists(), "blob content must never reach git");
}

#[tokio::test]
async fn commit_file_diff_refuses_an_unsafe_path() {
    let root = TempDir::new("file-diff-unsafe");
    let body = post_file_diff(
        test_state(root.path()),
        serde_json::json!({ "cwd": root.path().to_string_lossy(), "hash": "abcd", "path": "../x" }),
    )
    .await;
    assert!(!body.success);
    assert_eq!(body.code.as_deref(), Some("INVALID_PATH"));
}
