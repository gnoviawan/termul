use super::*;
use crate::acp::AcpManager;
use crate::trackers::git_tracker::GitTracker;
use crate::web::project_registry::ProjectRegistry;
use crate::web::sink::WsRelaySink;
use crate::web::test_pty_manager;
use crate::web::ws::HistoryMode;
use axum::body::Body;
use axum::http::Request;
use axum::routing::{get, post};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tower::ServiceExt;

/// Temp dir removed on drop (panic-safe).
struct TempDir {
    path: std::path::PathBuf,
}
impl TempDir {
    fn new(label: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("termul-web-wt-{label}-{nanos}"));
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
        workspace_manifest: None,
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
    }
}

fn test_router(state: AppState) -> axum::Router {
    axum::Router::new()
        .route("/worktree/list", post(list))
        .route("/worktree/create", post(create))
        .route("/worktree/remove", post(remove))
        .route("/worktree/branches", get(branches))
        .route("/worktree/check-dirty", get(check_dirty))
        .route("/worktree/resolve-base-branch", post(resolve_base_branch))
        .route("/worktree/copy-include-files", post(copy_include_files))
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

/// Init a bare git repo + initial commit so worktree ops have a valid HEAD.
/// The returned `RepoFixture` owns the `TempDir` and keeps it alive for the
/// test body; the `PathBuf` is borrowed from it. When the fixture is dropped
/// (end of test), the temp dir is removed — no `std::mem::forget` leak.
/// Each fixture gets a unique nanos-stamped dir under the OS temp dir.
fn init_repo(tag: &str) -> RepoFixture {
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
    let out = GitTracker::run_git_command(
        path.to_str().unwrap(),
        &["commit", "--allow-empty", "-m", "init"],
    )
    .expect("git commit");
    assert!(
        out.status.success(),
        "initial commit failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    RepoFixture { _dir: dir, path }
}

/// Owns the `TempDir` so the repo survives the test body; drops (removing
/// the temp dir) when the fixture goes out of scope at test teardown. This
/// replaces the old `std::mem::forget(dir)` pattern that accumulated
/// `%TEMP%\termul-web-wt-*` dirs across CI runs.
struct RepoFixture {
    _dir: TempDir,
    path: std::path::PathBuf,
}

impl RepoFixture {
    fn path(&self) -> &std::path::Path {
        &self.path
    }
}

// ----- Containment + loopback guards -----

#[tokio::test]
async fn list_rejects_project_path_outside_project_root() {
    let outside = TempDir::new("outside-list");
    let inside = TempDir::new("inside-list");
    let state = test_state(inside.path());
    let resp = post_json(
        state,
        "/worktree/list",
        &serde_json::json!({ "projectPath": outside.path().to_string_lossy() }),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<Vec<GitWorktreeEntry>> = body_as(resp.into_body()).await;
    assert!(!body.success, "outside-root must be rejected");
    assert_eq!(body.code.as_deref(), Some("OUTSIDE_PROJECT_ROOT"));
}

#[tokio::test]
async fn create_refused_from_non_loopback_peer() {
    if git_missing() {
        return;
    }
    let repo = init_repo("create-guard");
    let state = test_state(
        repo.path()
            .parent()
            .unwrap_or_else(|| std::path::Path::new(".")),
    );
    let remote = SocketAddr::from(([192, 168, 1, 50], 40000));
    let resp = post_json_from(
        state,
        "/worktree/create",
        &serde_json::json!({
            "projectPath": repo.path().to_string_lossy(),
            "name": "wt1",
            "branch": "chat/wt1",
            "isNewBranch": true
        }),
        remote,
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<GitWorktreeEntry> = body_as(resp.into_body()).await;
    assert!(!body.success, "non-loopback create must be refused");
    assert_eq!(body.code.as_deref(), Some("FORBIDDEN"));
}

#[tokio::test]
async fn remove_refused_from_non_loopback_peer() {
    let inside = TempDir::new("rm-guard");
    let state = test_state(inside.path());
    let remote = SocketAddr::from(([192, 168, 1, 51], 40001));
    let resp = post_json_from(
        state,
        "/worktree/remove",
        &serde_json::json!({
            "projectPath": inside.path().to_string_lossy(),
            "worktreePath": inside.path().to_string_lossy(),
            "force": false
        }),
        remote,
    )
    .await;
    let body: IpcBody<()> = body_as(resp.into_body()).await;
    assert!(!body.success);
    assert_eq!(body.code.as_deref(), Some("FORBIDDEN"));
}

#[tokio::test]
async fn copy_include_files_refused_from_non_loopback_peer() {
    let inside = TempDir::new("copy-guard");
    let state = test_state(inside.path());
    let remote = SocketAddr::from(([192, 168, 1, 52], 40002));
    let resp = post_json_from(
        state,
        "/worktree/copy-include-files",
        &serde_json::json!({
            "projectPath": inside.path().to_string_lossy(),
            "worktreePath": inside.path().to_string_lossy()
        }),
        remote,
    )
    .await;
    let body: IpcBody<IncludeCopyResult> = body_as(resp.into_body()).await;
    assert!(!body.success);
    assert_eq!(body.code.as_deref(), Some("FORBIDDEN"));
}

// ----- Read routes (containment only, no loopback guard) -----

#[tokio::test]
async fn list_returns_entries_for_a_git_repo() {
    if git_missing() {
        return;
    }
    let repo = init_repo("list-ok");
    let state = test_state(
        repo.path()
            .parent()
            .unwrap_or_else(|| std::path::Path::new(".")),
    );
    let resp = post_json(
        state,
        "/worktree/list",
        &serde_json::json!({ "projectPath": repo.path().to_string_lossy() }),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<Vec<GitWorktreeEntry>> = body_as(resp.into_body()).await;
    assert!(body.success, "list should succeed: {:?}", body.error);
    // A freshly-init'd repo with one commit has one worktree (the main one).
    let entries = body.data.expect("entries");
    assert!(!entries.is_empty(), "expected at least one worktree entry");
}

#[tokio::test]
async fn branches_returns_at_least_one_branch() {
    if git_missing() {
        return;
    }
    let repo = init_repo("branches-ok");
    let state = test_state(
        repo.path()
            .parent()
            .unwrap_or_else(|| std::path::Path::new(".")),
    );
    let uri = format!(
        "/worktree/branches?projectPath={}",
        urlencoding(&repo.path().to_string_lossy())
    );
    let resp = get_request(state, &uri).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<Vec<BranchEntry>> = body_as(resp.into_body()).await;
    assert!(body.success, "{:?}", body.error);
    let entries = body.data.expect("branches");
    assert!(!entries.is_empty(), "expected at least one branch");
}

#[tokio::test]
async fn resolve_base_branch_returns_default_base() {
    if git_missing() {
        return;
    }
    let repo = init_repo("base-ok");
    let state = test_state(
        repo.path()
            .parent()
            .unwrap_or_else(|| std::path::Path::new(".")),
    );
    let resp = post_json(
        state,
        "/worktree/resolve-base-branch",
        &serde_json::json!({ "projectPath": repo.path().to_string_lossy() }),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<BaseBranchInfo> = body_as(resp.into_body()).await;
    assert!(body.success, "{:?}", body.error);
    let info = body.data.expect("base branch info");
    assert!(
        !info.default_base.is_empty(),
        "default base must be non-empty"
    );
}

// ----- Write routes (loopback-guarded) -----

#[tokio::test]
async fn create_then_list_then_remove_roundtrips() {
    if git_missing() {
        return;
    }
    let repo = init_repo("cud");
    let state = test_state(
        repo.path()
            .parent()
            .unwrap_or_else(|| std::path::Path::new(".")),
    );

    // Create a worktree
    let resp = post_json(
        state.clone(),
        "/worktree/create",
        &serde_json::json!({
            "projectPath": repo.path().to_string_lossy(),
            "name": "wt-rt",
            "branch": "chat/wt-rt",
            "isNewBranch": true
        }),
    )
    .await;
    let body: IpcBody<GitWorktreeEntry> = body_as(resp.into_body()).await;
    assert!(body.success, "create failed: {:?}", body.error);
    let entry = body.data.expect("entry");
    assert_eq!(entry.branch, "chat/wt-rt");

    // List — should include the new worktree
    let resp = post_json(
        state.clone(),
        "/worktree/list",
        &serde_json::json!({ "projectPath": repo.path().to_string_lossy() }),
    )
    .await;
    let body: IpcBody<Vec<GitWorktreeEntry>> = body_as(resp.into_body()).await;
    assert!(body.success, "list failed: {:?}", body.error);
    let entries = body.data.expect("entries");
    assert!(
        entries.iter().any(|e| e.branch == "chat/wt-rt"),
        "expected the created worktree in the list"
    );

    // Remove the worktree
    let resp = post_json(
        state.clone(),
        "/worktree/remove",
        &serde_json::json!({
            "projectPath": repo.path().to_string_lossy(),
            "worktreePath": entry.path,
            "force": true
        }),
    )
    .await;
    let body: IpcBody<()> = body_as(resp.into_body()).await;
    assert!(body.success, "remove failed: {:?}", body.error);
}

#[tokio::test]
async fn check_dirty_returns_clean_for_fresh_worktree() {
    if git_missing() {
        return;
    }
    let repo = init_repo("dirty-ok");
    let state = test_state(
        repo.path()
            .parent()
            .unwrap_or_else(|| std::path::Path::new(".")),
    );

    // Create a worktree so check-dirty has a valid path to probe
    let resp = post_json(
        state.clone(),
        "/worktree/create",
        &serde_json::json!({
            "projectPath": repo.path().to_string_lossy(),
            "name": "wt-dirty",
            "branch": "chat/wt-dirty",
            "isNewBranch": true
        }),
    )
    .await;
    let body: IpcBody<GitWorktreeEntry> = body_as(resp.into_body()).await;
    assert!(body.success, "create failed: {:?}", body.error);
    let entry = body.data.expect("entry");

    let uri = format!(
        "/worktree/check-dirty?worktreePath={}",
        urlencoding(&entry.path)
    );
    let resp = get_request(state, &uri).await;
    let body: IpcBody<DirtyStatus> = body_as(resp.into_body()).await;
    assert!(body.success, "{:?}", body.error);
    let status = body.data.expect("dirty status");
    assert!(!status.has_changes, "fresh worktree should be clean");
}

#[tokio::test]
async fn copy_include_files_returns_outcome_for_fresh_worktree() {
    if git_missing() {
        return;
    }
    let repo = init_repo("copy-ok");
    let state = test_state(
        repo.path()
            .parent()
            .unwrap_or_else(|| std::path::Path::new(".")),
    );

    let resp = post_json(
        state.clone(),
        "/worktree/create",
        &serde_json::json!({
            "projectPath": repo.path().to_string_lossy(),
            "name": "wt-copy",
            "branch": "chat/wt-copy",
            "isNewBranch": true
        }),
    )
    .await;
    let body: IpcBody<GitWorktreeEntry> = body_as(resp.into_body()).await;
    assert!(body.success, "create failed: {:?}", body.error);
    let entry = body.data.expect("entry");

    let resp = post_json(
        state,
        "/worktree/copy-include-files",
        &serde_json::json!({
            "projectPath": repo.path().to_string_lossy(),
            "worktreePath": entry.path
        }),
    )
    .await;
    let body: IpcBody<IncludeCopyResult> = body_as(resp.into_body()).await;
    assert!(body.success, "copy-include-files failed: {:?}", body.error);
    let outcome = body.data.expect("outcome");
    // No .worktree-include file → ran=0, copied=0
    assert_eq!(outcome.ran, 0, "no .worktree-include → ran=0");
    assert_eq!(outcome.copied, 0, "no .worktree-include → copied=0");
}

// ----- Production-router integration (Fix 14) -----
//
// The handler tests above use a hand-built `test_router`. These tests build
// the REAL production `router::router(...)` (the same function `serve_router`
// calls) and drive a `oneshot` request per route, asserting the response is
// an `IpcBody` JSON (not the SPA static fallback). This catches a regression
// that drops or swaps a route in only the production `router()` function
// (the parity-checklist TS test only greps `router.rs` source text; this is
// the runtime catch).

/// Build the production `router()` with a test AppState rooted at `root`.
fn production_router(root: &std::path::Path) -> axum::Router {
    let pty = crate::web::test_pty_manager();
    let project_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    crate::web::router::router(
        Arc::new(AcpManager::new(vec![])),
        pty.clone(),
        pty.terminal_events(),
        pty.cwd_tracker(),
        pty.git_tracker(),
        pty.exit_code_tracker(),
        Arc::new(WsRelaySink::new()),
        Arc::new(ProjectRegistry::new()),
        None,
        None,
        project_root,
        HistoryMode::LiveOnly,
        None,
        None,
        None,
        None,
        false,
        false,
        "http://127.0.0.1".to_string(),
        None,
        // No canvas pool on this fixture — the /canvas/* routes degrade.
        None,
    )
}

#[tokio::test]
async fn production_router_serves_worktree_list_as_ipcbody_not_spa_fallback() {
    if git_missing() {
        return;
    }
    let repo = init_repo("prod-router-list");
    let app = production_router(
        repo.path()
            .parent()
            .unwrap_or_else(|| std::path::Path::new(".")),
    );
    let bytes =
        serde_json::to_vec(&serde_json::json!({ "projectPath": repo.path().to_string_lossy() }))
            .expect("serialize");
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/worktree/list")
                .header("content-type", "application/json")
                .extension(ConnectInfo(loopback()))
                .body(Body::from(bytes))
                .expect("build request"),
        )
        .await
        .expect("router response");
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<Vec<GitWorktreeEntry>> = body_as(resp.into_body()).await;
    assert!(
        body.success,
        "production router should serve /worktree/list as IpcBody, not SPA fallback: {:?}",
        body.error
    );
    assert!(
        !body.data.as_deref().unwrap_or_default().is_empty(),
        "fresh repo should have at least one worktree entry"
    );
}

#[tokio::test]
async fn production_router_serves_worktree_branches_as_ipcbody_not_spa_fallback() {
    if git_missing() {
        return;
    }
    let repo = init_repo("prod-router-branches");
    let app = production_router(
        repo.path()
            .parent()
            .unwrap_or_else(|| std::path::Path::new(".")),
    );
    let uri = format!(
        "/worktree/branches?projectPath={}",
        urlencoding(&repo.path().to_string_lossy())
    );
    let resp = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(&uri)
                .body(Body::empty())
                .expect("build request"),
        )
        .await
        .expect("router response");
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<Vec<BranchEntry>> = body_as(resp.into_body()).await;
    assert!(
        body.success,
        "production router should serve /worktree/branches as IpcBody, not SPA fallback: {:?}",
        body.error
    );
    assert!(
        !body.data.as_deref().unwrap_or_default().is_empty(),
        "fresh repo should have at least one branch"
    );
}

#[tokio::test]
async fn production_router_serves_worktree_resolve_base_branch_as_ipcbody() {
    if git_missing() {
        return;
    }
    let repo = init_repo("prod-router-base");
    let app = production_router(
        repo.path()
            .parent()
            .unwrap_or_else(|| std::path::Path::new(".")),
    );
    let bytes =
        serde_json::to_vec(&serde_json::json!({ "projectPath": repo.path().to_string_lossy() }))
            .expect("serialize");
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/worktree/resolve-base-branch")
                .header("content-type", "application/json")
                .extension(ConnectInfo(loopback()))
                .body(Body::from(bytes))
                .expect("build request"),
        )
        .await
        .expect("router response");
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<BaseBranchInfo> = body_as(resp.into_body()).await;
    assert!(
        body.success,
        "production router should serve /worktree/resolve-base-branch as IpcBody: {:?}",
        body.error
    );
}

#[tokio::test]
async fn production_router_does_not_swallow_unregistered_path_as_ipcbody() {
    // An unregistered path under /worktree/ must NOT return an IpcBody — it
    // should fall through to the SPA static fallback (404 in the test env
    // where dist-web/ is absent). This distinguishes the registered routes
    // from the fallback.
    let repo = init_repo("prod-router-404");
    let app = production_router(
        repo.path()
            .parent()
            .unwrap_or_else(|| std::path::Path::new(".")),
    );
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/worktree/nonexistent-route")
                .header("content-type", "application/json")
                .extension(ConnectInfo(loopback()))
                .body(Body::from(
                    serde_json::to_vec(&serde_json::json!({})).expect("serialize"),
                ))
                .expect("build request"),
        )
        .await
        .expect("router response");
    // The SPA fallback returns 404 when dist-web/ is absent (test env) or
    // index.html when present. Either way, it's NOT a 200 IpcBody.
    // A 200 here would mean the route was accidentally registered as a
    // catch-all. We assert the status is NOT OK-with-IpcBody by checking
    // that the body is NOT a valid IpcBody success.
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("read body");
    let text = String::from_utf8_lossy(&bytes);
    // The fallback body is either 404 "Not Found" or an HTML index — never
    // a JSON `{"success":...}` IpcBody.
    assert!(
        !text.contains("\"success\""),
        "unregistered /worktree/nonexistent-route must not return an IpcBody JSON, got: {text}"
    );
}
