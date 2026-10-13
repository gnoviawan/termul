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
        let path = std::env::temp_dir().join(format!("termul-web-diffstat-{label}-{nanos}"));
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
        workspace_manifest: None,
        acp_catalog: None,
        acp_install: None,
        store: None,
        web_auth: None,
        allow_remote_writes: false,
        shared_live_writes_denied: false,
        connections: Default::default(),
    }
}

async fn post_diff_stat(
    state: AppState,
    cwd: &std::path::Path,
    peer: SocketAddr,
) -> IpcBody<GitDiffStat> {
    let bytes = serde_json::to_vec(&serde_json::json!({ "cwd": cwd.to_string_lossy() }))
        .expect("serialize body");
    let resp = axum::Router::new()
        .route("/git/diff-stat", post(get_diff_stat))
        .with_state(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/git/diff-stat")
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

fn git(repo: &std::path::Path, args: &[&str]) {
    let out =
        GitTracker::run_git_command(repo.to_str().unwrap(), args).expect("git command should run");
    assert!(
        out.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
}

fn init_repo(repo: &std::path::Path) {
    git(repo, &["init", "-q"]);
    git(repo, &["config", "user.email", "t@example.com"]);
    git(repo, &["config", "user.name", "Test"]);
    git(repo, &["config", "commit.gpgsign", "false"]);
    git(repo, &["config", "core.autocrlf", "false"]);
}

#[tokio::test]
async fn diff_stat_returns_tracked_and_untracked_totals() {
    if git_missing() {
        return;
    }
    let root = TempDir::new("ok");
    init_repo(root.path());
    std::fs::write(root.path().join("a.txt"), "l1\nl2\n").expect("write");
    git(root.path(), &["add", "-A"]);
    git(root.path(), &["commit", "-q", "-m", "base"]);
    std::fs::write(root.path().join("a.txt"), "l1\nl2\nl3\nl4\n").expect("write");
    std::fs::write(root.path().join("new.txt"), "x\ny\nz").expect("write");

    let body = post_diff_stat(test_state(root.path()), root.path(), loopback()).await;
    assert!(body.success, "diff stat should succeed: {:?}", body.error);
    assert_eq!(
        body.data,
        Some(GitDiffStat {
            added: 5,
            removed: 0
        })
    );
}

#[tokio::test]
async fn diff_stat_serializes_added_and_removed_keys() {
    let body = IpcBody::ok(GitDiffStat {
        added: 2,
        removed: 1,
    });
    assert_eq!(
        serde_json::to_value(body).expect("serialize"),
        serde_json::json!({ "success": true, "data": { "added": 2, "removed": 1 } })
    );
}

#[tokio::test]
async fn diff_stat_rejects_cwd_outside_project_root() {
    let outside = TempDir::new("outside");
    let inside = TempDir::new("inside");
    let body = post_diff_stat(test_state(inside.path()), outside.path(), loopback()).await;
    assert!(!body.success, "outside-root must be rejected");
    assert_eq!(body.code.as_deref(), Some("OUTSIDE_PROJECT_ROOT"));
}

#[tokio::test]
async fn diff_stat_reports_error_code_for_non_repo() {
    if git_missing() {
        return;
    }
    let root = TempDir::new("not-a-repo");
    let body = post_diff_stat(test_state(root.path()), root.path(), loopback()).await;
    assert!(!body.success, "a non-repo cwd must fail");
    assert_eq!(body.code.as_deref(), Some("GIT_DIFF_STAT_ERROR"));
    assert!(body.error.is_some());
}

#[tokio::test]
async fn diff_stat_admits_non_loopback_peer_without_remote_writes() {
    if git_missing() {
        return;
    }
    let root = TempDir::new("remote-read");
    init_repo(root.path());
    std::fs::write(root.path().join("new.txt"), "a\nb\n").expect("write");
    let state = test_state(root.path());
    assert!(
        !state.allow_remote_writes,
        "read route must not need the write flag"
    );

    let lan = SocketAddr::from(([192, 168, 1, 50], 40000));
    let body = post_diff_stat(state, root.path(), lan).await;
    assert!(body.success, "LAN peer may read the stat: {:?}", body.error);
    assert_eq!(
        body.data,
        Some(GitDiffStat {
            added: 2,
            removed: 0
        })
    );
}
