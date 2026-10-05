use super::*;
use crate::acp::AcpManager;
use crate::web::project_registry::ProjectRegistry;
use crate::web::sink::WsRelaySink;
use crate::web::test_pty_manager;
use crate::web::ws::HistoryMode;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::routing::{get, post};
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
        let path = std::env::temp_dir().join(format!("termul-web-gitapi-{label}-{nanos}"));
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
        registry: Arc::new(ProjectRegistry::new()),
        registry_persistence: None,
        projects_file: None,
        history_mode: HistoryMode::LiveOnly,
        project_root: Arc::new(parking_lot::RwLock::new(
            root.canonicalize().unwrap_or_else(|_| root.to_path_buf()),
        )),
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
    }
}

fn test_router(state: AppState) -> axum::Router {
    axum::Router::new()
        .route("/git/status", post(get_status))
        .route("/git/diff", post(get_diff))
        .route("/git/stage", post(stage))
        .route("/git/unstage", post(unstage))
        .route("/git/discard", post(discard))
        .route("/git/log", post(get_log))
        .route("/git/commit", post(commit))
        .route("/git/push", post(push))
        .route("/git/commit-context", post(get_commit_context))
        .route("/git/checkout-branch", post(checkout_branch))
        .route("/git/create-branch", post(create_branch))
        .route("/git/stash-save", post(stash_save))
        .route("/git/stash-list", get(stash_list))
        .route("/git/stash-apply", post(stash_apply))
        .route("/git/stash-pop", post(stash_pop))
        .route("/git/stash-drop", post(stash_drop))
        .route("/git/branch-list", get(branch_list))
        .route("/git/branch-switch", post(branch_switch))
        .route("/git/branch-create", post(branch_create))
        .with_state(state)
}

async fn body_as<T: serde::de::DeserializeOwned>(body: Body) -> IpcBody<T> {
    let bytes = axum::body::to_bytes(body, usize::MAX)
        .await
        .expect("read body");
    serde_json::from_slice(&bytes).expect("deserialize IpcBody")
}

fn loopback() -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], 54321))
}

async fn post_json(
    state: AppState,
    uri: &str,
    body: &serde_json::Value,
) -> axum::http::Response<Body> {
    post_json_from(state, uri, body, loopback()).await
}

async fn post_json_from(
    state: AppState,
    uri: &str,
    body: &serde_json::Value,
    peer: SocketAddr,
) -> axum::http::Response<Body> {
    let bytes = serde_json::to_vec(body).expect("serialize body");
    test_router(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(uri)
                .header("content-type", "application/json")
                .extension(ConnectInfo(peer))
                .body(Body::from(bytes))
                .expect("build request"),
        )
        .await
        .expect("router response")
}

async fn get_request(state: AppState, uri: &str) -> axum::http::Response<Body> {
    test_router(state)
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(uri)
                .body(Body::empty())
                .expect("build request"),
        )
        .await
        .expect("router response")
}

fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            ' ' => out.push_str("%20"),
            '\\' => out.push_str("%5C"),
            _ if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~' | '/' | ':') => {
                out.push(c)
            }
            _ => {
                let mut buf = [0u8; 4];
                for b in c.encode_utf8(&mut buf).as_bytes() {
                    out.push_str(&format!("%{:02X}", b));
                }
            }
        }
    }
    out
}

/// Skip the test when git is unavailable in the host env.
fn git_missing() -> bool {
    GitTracker::run_git_command(std::env::temp_dir().to_str().unwrap(), &["--version"]).is_none()
}

fn init_repo(tag: &str) -> PathBuf {
    let dir = TempDir::new(tag);
    let path = dir.path().to_path_buf();
    for args in [
        ["init", "-q"].as_slice(),
        ["config", "user.email", "t@example.com"].as_slice(),
        ["config", "user.name", "Test"].as_slice(),
        ["config", "commit.gpgsign", "false"].as_slice(),
        ["config", "core.autocrlf", "false"].as_slice(),
    ] {
        let out = GitTracker::run_git_command(path.to_str().unwrap(), args)
            .expect("git command should run");
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }
    // Leak the TempDir wrapper so the repo survives the test body — the
    // directory lives under the OS temp dir and is cleaned up by the OS.
    std::mem::forget(dir);
    path
}

#[tokio::test]
async fn get_status_returns_empty_list_for_clean_repo() {
    if git_missing() {
        return;
    }
    let repo = init_repo("status-clean");
    let state = test_state(repo.parent().unwrap_or_else(|| std::path::Path::new(".")));
    let resp = post_json(
        state,
        "/git/status",
        &serde_json::json!({ "cwd": repo.to_string_lossy() }),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<Vec<GitStatusDetail>> = body_as(resp.into_body()).await;
    assert!(body.success, "git status should succeed: {:?}", body.error);
    assert!(body.data.unwrap_or_default().is_empty());
}

#[tokio::test]
async fn get_status_reports_untracked_file() {
    if git_missing() {
        return;
    }
    let repo = init_repo("status-untracked");
    std::fs::write(repo.join("a.txt"), "x").expect("write");
    let state = test_state(repo.parent().unwrap_or_else(|| std::path::Path::new(".")));
    let resp = post_json(
        state,
        "/git/status",
        &serde_json::json!({ "cwd": repo.to_string_lossy() }),
    )
    .await;
    let body: IpcBody<Vec<GitStatusDetail>> = body_as(resp.into_body()).await;
    assert!(body.success, "{:?}", body.error);
    let rows = body.data.expect("entries");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].status, "untracked");
    assert!(!rows[0].staged);
}

#[tokio::test]
async fn get_status_rejects_cwd_outside_project_root() {
    let outside = TempDir::new("outside");
    let inside = TempDir::new("inside");
    let state = test_state(inside.path());
    let resp = post_json(
        state,
        "/git/status",
        &serde_json::json!({ "cwd": outside.path().to_string_lossy() }),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<Vec<GitStatusDetail>> = body_as(resp.into_body()).await;
    assert!(!body.success, "outside-root must be rejected");
    assert_eq!(body.code.as_deref(), Some("OUTSIDE_PROJECT_ROOT"));
}

#[tokio::test]
async fn stage_refused_from_non_loopback_peer() {
    if git_missing() {
        return;
    }
    let repo = init_repo("stage-guard");
    std::fs::write(repo.join("a.txt"), "x").expect("write");
    let state = test_state(repo.parent().unwrap_or_else(|| std::path::Path::new(".")));
    let remote = SocketAddr::from(([192, 168, 1, 50], 40000));
    let resp = post_json_from(
        state,
        "/git/stage",
        &serde_json::json!({ "cwd": repo.to_string_lossy(), "path": "a.txt" }),
        remote,
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as(resp.into_body()).await;
    assert!(!body.success);
    assert_eq!(body.code.as_deref(), Some("FORBIDDEN"));
}

/// `--allow-remote-writes`: a non-loopback peer is ADMITTED on `/git/stage`
/// (the shared `check_local_only` opt-in branch reached via
/// `resolve_cwd`). Mirrors `stage_refused_from_non_loopback_peer` with
/// the flag on.
#[tokio::test]
async fn stage_admitted_from_non_loopback_peer_when_opt_in() {
    if git_missing() {
        return;
    }
    let repo = init_repo("stage-opt-in");
    std::fs::write(repo.join("a.txt"), "x").expect("write");
    let mut state = test_state(repo.parent().unwrap_or_else(|| std::path::Path::new(".")));
    state.allow_remote_writes = true;
    let remote = SocketAddr::from(([192, 168, 1, 50], 40000));
    let resp = post_json_from(
        state,
        "/git/stage",
        &serde_json::json!({ "cwd": repo.to_string_lossy(), "path": "a.txt" }),
        remote,
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as(resp.into_body()).await;
    assert!(
        body.success,
        "opt-in must admit non-loopback stage: {:?}",
        body.error
    );
}

#[tokio::test]
async fn stage_then_unstage_roundtrips() {
    if git_missing() {
        return;
    }
    let repo = init_repo("stage-roundtrip");
    std::fs::write(repo.join("a.txt"), "one\n").expect("write");
    let git = |args: &[&str]| {
        let out = GitTracker::run_git_command(repo.to_str().unwrap(), args).expect("git");
        assert!(
            out.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    };
    git(&["add", "-A"]);
    git(&["commit", "-qm", "init"]);
    std::fs::write(repo.join("a.txt"), "two\n").expect("modify");

    let state = test_state(repo.parent().unwrap_or_else(|| std::path::Path::new(".")));
    let resp = post_json(
        state.clone(),
        "/git/stage",
        &serde_json::json!({ "cwd": repo.to_string_lossy(), "path": "a.txt" }),
    )
    .await;
    let body: IpcBody<()> = body_as(resp.into_body()).await;
    assert!(body.success, "stage failed: {:?}", body.error);

    let resp = post_json(
        state,
        "/git/unstage",
        &serde_json::json!({ "cwd": repo.to_string_lossy(), "path": "a.txt" }),
    )
    .await;
    let body: IpcBody<()> = body_as(resp.into_body()).await;
    assert!(body.success, "unstage failed: {:?}", body.error);
}

#[tokio::test]
async fn get_log_returns_empty_for_fresh_repo() {
    if git_missing() {
        return;
    }
    let repo = init_repo("log-empty");
    let state = test_state(repo.parent().unwrap_or_else(|| std::path::Path::new(".")));
    let resp = post_json(
        state,
        "/git/log",
        &serde_json::json!({ "cwd": repo.to_string_lossy() }),
    )
    .await;
    let body: IpcBody<Vec<GitCommit>> = body_as(resp.into_body()).await;
    assert!(body.success, "{:?}", body.error);
    assert!(body.data.unwrap_or_default().is_empty());
}

#[tokio::test]
async fn commit_context_for_fresh_repo_has_no_head() {
    if git_missing() {
        return;
    }
    let repo = init_repo("ctx-nohead");
    let state = test_state(repo.parent().unwrap_or_else(|| std::path::Path::new(".")));
    let resp = post_json(
        state,
        "/git/commit-context",
        &serde_json::json!({ "cwd": repo.to_string_lossy() }),
    )
    .await;
    let body: IpcBody<GitCommitContext> = body_as(resp.into_body()).await;
    assert!(body.success, "{:?}", body.error);
    let ctx = body.data.expect("context");
    assert!(!ctx.has_head);
    assert_eq!(ctx.staged_count, 0);
}

#[tokio::test]
async fn branch_list_returns_branches() {
    if git_missing() {
        return;
    }
    let repo = init_repo("branch-list");
    // A fresh `git init` repo has no commits and therefore no branches yet
    // (`git branch` lists only refs that exist). Create an empty initial
    // commit so the default branch comes into existence and is listed.
    let committed = GitTracker::run_git_command(
        repo.to_str().unwrap(),
        &["commit", "--allow-empty", "-m", "init"],
    )
    .map(|c| c.status.success())
    .unwrap_or(false);
    assert!(committed, "initial commit should succeed");
    let state = test_state(repo.parent().unwrap_or_else(|| std::path::Path::new(".")));
    let uri = format!(
        "/git/branch-list?cwd={}",
        urlencoding(&repo.to_string_lossy())
    );
    let resp = get_request(state, &uri).await;
    let body: IpcBody<Vec<String>> = body_as(resp.into_body()).await;
    assert!(body.success, "{:?}", body.error);
    // After the initial commit the default branch (main/master/whatever
    // git is configured for) exists and is listed.
    let branches = body.data.unwrap_or_default();
    assert!(
        !branches.is_empty(),
        "expected at least one branch after the initial commit, got: {branches:?}"
    );
}

#[tokio::test]
async fn stash_list_returns_empty_for_no_stashes() {
    if git_missing() {
        return;
    }
    let repo = init_repo("stash-empty");
    let state = test_state(repo.parent().unwrap_or_else(|| std::path::Path::new(".")));
    let uri = format!(
        "/git/stash-list?cwd={}",
        urlencoding(&repo.to_string_lossy())
    );
    let resp = get_request(state, &uri).await;
    let body: IpcBody<Vec<GitStashInfoDto>> = body_as(resp.into_body()).await;
    assert!(body.success, "{:?}", body.error);
    assert!(body.data.unwrap_or_default().is_empty());
}

/// F-007 regression: `POST /git/branch-switch` must actually switch the
/// branch. The previous `["checkout", "--", name]` arg vector made `name`
/// a pathspec: the switch never happened and a name colliding with a
/// worktree path silently reverted that file's changes with success:true.
/// Spec (desktop parity, commands.rs `git_checkout`): `git checkout <name>`
/// switches HEAD to the named branch.
#[tokio::test]
async fn branch_switch_actually_switches_branch() {
    if git_missing() {
        return;
    }
    let repo = init_repo("branch-switch-f007");
    GitTracker::run_git_command(
        repo.to_str().unwrap(),
        &["commit", "--allow-empty", "-qm", "init"],
    )
    .expect("commit runs");
    let state = test_state(repo.parent().unwrap_or_else(|| std::path::Path::new(".")));
    // Create a target branch up front so the switch has something to switch to.
    GitTracker::run_git_command(repo.to_str().unwrap(), &["branch", "feature"])
        .expect("branch runs");
    let resp = post_json(
        state,
        "/git/branch-switch",
        &serde_json::json!({ "cwd": repo.to_string_lossy(), "name": "feature" }),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as(resp.into_body()).await;
    assert!(
        body.success,
        "branch-switch should succeed: {:?}",
        body.error
    );
    // HEAD must now be on `feature` — the actual contract.
    let head =
        GitTracker::run_git_command(repo.to_str().unwrap(), &["symbolic-ref", "--short", "HEAD"])
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
    assert_eq!(head, "feature", "HEAD must be on the switched branch");
}

/// F-007 data-loss half: the colliding-name hazard itself. When the
/// requested name matches a worktree file but no branch, plain
/// `git checkout <name>` (the desktop parity arg vector) is ambiguous and
/// git acts on the PATHSPEC, reverting the file — the SAME data loss the
/// old `checkout -- <name>` implementation had. The route contract is
/// "switch branch", so the route must resolve the name as a ref only and
/// REFUSE anything that is not a branch. Verified against git: with a
/// branch named `feature` present, `checkout feature` keeps the dirty
/// file; with a FILE named `a.txt` and no such branch, `checkout a.txt`
/// reverts it. The fix (`is_branch_name` pre-check) refuses the latter.
#[tokio::test]
async fn branch_switch_name_colliding_with_file_never_reverts_it() {
    if git_missing() {
        return;
    }
    let repo = init_repo("branch-switch-collide-f007");
    std::fs::write(repo.join("a.txt"), "committed\n").expect("write");
    GitTracker::run_git_command(repo.to_str().unwrap(), &["add", "-A"]).expect("add runs");
    GitTracker::run_git_command(repo.to_str().unwrap(), &["commit", "-qm", "init"])
        .expect("commit runs");
    std::fs::write(repo.join("a.txt"), "precious-local-edit\n").expect("modify");
    let state = test_state(repo.parent().unwrap_or_else(|| std::path::Path::new(".")));
    // No branch named a.txt exists -> the route must refuse the switch,
    // and the local edit must survive.
    let resp = post_json(
        state,
        "/git/branch-switch",
        &serde_json::json!({ "cwd": repo.to_string_lossy(), "name": "a.txt" }),
    )
    .await;
    let body: IpcBody<()> = body_as(resp.into_body()).await;
    assert!(
        !body.success,
        "switching to a name that is a file, not a branch, must fail (git ambiguity)"
    );
    let content = std::fs::read_to_string(repo.join("a.txt")).expect("read");
    assert_eq!(
        content, "precious-local-edit\n",
        "local changes must survive a refused branch switch"
    );
}

/// Remote-tracking branch regression: `POST /git/branch-switch` with a
/// remote-tracking ref (`origin/feature`) must create a LOCAL tracking
/// branch via `checkout --track`, not land in detached HEAD. The earlier
/// `is_branch_name` check admitted remote refs but always passed
/// `is_remote=false`, so `checkout origin/feature` detached HEAD at the
/// remote tip and returned success.
#[tokio::test]
async fn branch_switch_remote_tracking_creates_local_tracking_branch() {
    if git_missing() {
        return;
    }
    // A real `origin` remote is required: `checkout --track origin/feature`
    // DWIMs only when `remote.origin.fetch` maps refs/remotes/origin/* —
    // a bare update-ref is not recognized as a remote-tracking branch.
    let remote = init_repo("branch-switch-remote-src");
    GitTracker::run_git_command(
        remote.to_str().unwrap(),
        &["commit", "--allow-empty", "-qm", "init"],
    )
    .expect("remote commit runs");
    GitTracker::run_git_command(remote.to_str().unwrap(), &["branch", "feature"])
        .expect("remote branch runs");
    let repo = init_repo("branch-switch-remote");
    GitTracker::run_git_command(
        repo.to_str().unwrap(),
        &["commit", "--allow-empty", "-qm", "init"],
    )
    .expect("commit runs");
    GitTracker::run_git_command(
        repo.to_str().unwrap(),
        &["remote", "add", "origin", remote.to_str().unwrap()],
    )
    .expect("remote add runs");
    GitTracker::run_git_command(repo.to_str().unwrap(), &["fetch", "-q", "origin"])
        .expect("fetch runs");
    let state = test_state(repo.parent().unwrap_or_else(|| std::path::Path::new(".")));
    let resp = post_json(
        state,
        "/git/branch-switch",
        &serde_json::json!({ "cwd": repo.to_string_lossy(), "name": "origin/feature" }),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as(resp.into_body()).await;
    assert!(
        body.success,
        "remote branch-switch should succeed: {:?}",
        body.error
    );
    // HEAD must be on a NEW local `feature` branch — never detached.
    let head =
        GitTracker::run_git_command(repo.to_str().unwrap(), &["symbolic-ref", "--short", "HEAD"])
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
    assert_eq!(
        head, "feature",
        "remote checkout must create local tracking branch, got HEAD={head}"
    );
    // And it must track the remote ref.
    let upstream = GitTracker::run_git_command(
        repo.to_str().unwrap(),
        &["rev-parse", "--abbrev-ref", "feature@{upstream}"],
    )
    .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    .unwrap_or_default();
    assert_eq!(
        upstream, "origin/feature",
        "local branch must track the remote ref"
    );
}

/// F-008 regression: `POST /git/branch-create` must actually create and
/// check out the branch. The previous `["checkout", "-b", "--", name]`
/// consumed `--` as the branch name — the route could never succeed.
#[tokio::test]
async fn branch_create_actually_creates_and_switches() {
    if git_missing() {
        return;
    }
    let repo = init_repo("branch-create-f008");
    GitTracker::run_git_command(
        repo.to_str().unwrap(),
        &["commit", "--allow-empty", "-qm", "init"],
    )
    .expect("commit runs");
    let state = test_state(repo.parent().unwrap_or_else(|| std::path::Path::new(".")));
    let resp = post_json(
        state,
        "/git/branch-create",
        &serde_json::json!({ "cwd": repo.to_string_lossy(), "name": "newbr" }),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as(resp.into_body()).await;
    assert!(
        body.success,
        "branch-create should succeed: {:?}",
        body.error
    );
    let head =
        GitTracker::run_git_command(repo.to_str().unwrap(), &["symbolic-ref", "--short", "HEAD"])
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
    assert_eq!(head, "newbr", "HEAD must be on the created branch");
}

#[tokio::test]
async fn get_status_rejects_path_traversal_cwd() {
    let dir = TempDir::new("traversal");
    let state = test_state(dir.path());
    // A `..` component is rejected by resolve_request_path regardless of
    // project_root containment — defense-in-depth against traversal.
    let resp = post_json(
        state,
        "/git/status",
        &serde_json::json!({ "cwd": "../escape" }),
    )
    .await;
    let body: IpcBody<Vec<GitStatusDetail>> = body_as(resp.into_body()).await;
    assert!(!body.success);
    assert_eq!(body.code.as_deref(), Some("PATH_TRAVERSAL"));
}
