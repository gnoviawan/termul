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
        registry: crate::web::project_registry::ProjectRegistry::seeded_for_test(
            &root.canonicalize().unwrap_or_else(|_| root.to_path_buf()),
        ),
        history_mode: HistoryMode::LiveOnly,
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
        ProjectRegistry::seeded_for_test(&project_root),
        HistoryMode::LiveOnly,
        None,
        None,
        None,
        false,
        false,
        "http://127.0.0.1".to_string(),
        None,
        // No canvas pool on this fixture — the /canvas/* routes degrade.
        None,
        crate::web::origin::OriginPolicy::default(),
        crate::web::connection_runtime::ConnectionRuntime::default(),
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
                .header(
                    crate::web::command_ledger::COMMAND_ID_HEADER,
                    crate::web::command_ledger::test_clock::fresh_command_id(),
                )
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
                .header(
                    crate::web::command_ledger::COMMAND_ID_HEADER,
                    crate::web::command_ledger::test_clock::fresh_command_id(),
                )
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
                .header(
                    crate::web::command_ledger::COMMAND_ID_HEADER,
                    crate::web::command_ledger::test_clock::fresh_command_id(),
                )
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

// ----- Server topologies: launching a chat into an EXISTING worktree is a read -----
//
// The renderer write gate (CAP-15 / AD-9) disables "New worktree" on a server
// that refuses remote writes, but "launch into an existing worktree" must stay
// available: it only needs `/worktree/list`, which is containment-checked and
// never loopback-guarded. These tests pin that per host topology.

/// Create a worktree through an admitting (loopback, default) state, then list
/// it under the topology state `(allow_remote_writes, shared_live_writes_denied)`
/// from `peer`. Returns the topology state's `/worktree/create` outcome code
/// (for the write-refusal assertions) after asserting the list succeeded.
async fn assert_existing_worktree_listed_under(
    tag: &str,
    allow_remote_writes: bool,
    shared_live_writes_denied: bool,
    peer: SocketAddr,
) -> Option<String> {
    let repo = init_repo(tag);
    let admitting = test_state(
        repo.path()
            .parent()
            .unwrap_or_else(|| std::path::Path::new(".")),
    );
    let created = post_json(
        admitting.clone(),
        "/worktree/create",
        &serde_json::json!({
            "projectPath": repo.path().to_string_lossy(),
            "name": "wt-existing",
            "branch": "chat/wt-existing",
            "isNewBranch": true
        }),
    )
    .await;
    let created: IpcBody<GitWorktreeEntry> = body_as(created.into_body()).await;
    assert!(created.success, "setup create failed: {:?}", created.error);
    let entry = created.data.expect("created entry");

    let topology = AppState {
        allow_remote_writes,
        shared_live_writes_denied,
        ..admitting
    };

    // Separator/trailing-slash agnostic compare (Windows reports `/`, create `\`).
    let norm = |p: &str| p.replace('\\', "/").trim_end_matches('/').to_string();

    // Existing-worktree launch needs the list read: admitted, entry returned.
    let resp = post_json_from(
        topology.clone(),
        "/worktree/list",
        &serde_json::json!({ "projectPath": repo.path().to_string_lossy() }),
        peer,
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let listed: IpcBody<Vec<GitWorktreeEntry>> = body_as(resp.into_body()).await;
    assert!(listed.success, "list must be admitted: {:?}", listed.error);
    let entries = listed.data.expect("entries");
    assert!(
        entries
            .iter()
            .any(|e| e.branch == "chat/wt-existing" && norm(&e.path) == norm(&entry.path)),
        "expected the existing worktree {} in {:?}",
        entry.path,
        entries
    );

    // Probe the write route under the same topology.
    let resp = post_json_from(
        topology,
        "/worktree/create",
        &serde_json::json!({
            "projectPath": repo.path().to_string_lossy(),
            "name": "wt-new",
            "branch": "chat/wt-new",
            "isNewBranch": true
        }),
        peer,
    )
    .await;
    let body: IpcBody<GitWorktreeEntry> = body_as(resp.into_body()).await;
    if body.success {
        None
    } else {
        Some(body.code.unwrap_or_default())
    }
}

#[tokio::test]
async fn existing_worktree_listed_but_create_refused_on_shared_live() {
    if git_missing() {
        return;
    }
    // Desktop shared-live: writes denied for every peer, even loopback.
    let create =
        assert_existing_worktree_listed_under("topo-shared-live", false, true, loopback()).await;
    assert_eq!(create.as_deref(), Some("FORBIDDEN"));
}

#[tokio::test]
async fn existing_worktree_listed_but_create_refused_on_server_without_opt_in() {
    if git_missing() {
        return;
    }
    // `termul-server` without `--allow-remote-writes`, LAN peer.
    let lan = SocketAddr::from(([192, 168, 1, 60], 40010));
    let create =
        assert_existing_worktree_listed_under("topo-server-closed", false, false, lan).await;
    assert_eq!(create.as_deref(), Some("FORBIDDEN"));
}

#[tokio::test]
async fn existing_worktree_listed_on_server_with_allow_remote_writes() {
    if git_missing() {
        return;
    }
    // `termul-server --allow-remote-writes`, LAN peer: the list read is admitted
    // exactly as in the read-only topologies (writes are admitted here too).
    let lan = SocketAddr::from(([192, 168, 1, 61], 40011));
    let create = assert_existing_worktree_listed_under("topo-server-open", true, false, lan).await;
    assert_ne!(create.as_deref(), Some("FORBIDDEN"));
}

// ----- Outside-project-folder worktrees (AD-9 / CAP-14) -----

/// Add a worktree for a new branch at `target` (outside the repo).
fn add_worktree_at(repo: &std::path::Path, target: &std::path::Path, branch: &str) {
    let out = GitTracker::run_git_command(
        repo.to_str().unwrap(),
        &["worktree", "add", "-b", branch, target.to_str().unwrap()],
    )
    .expect("git worktree add");
    assert!(
        out.status.success(),
        "git worktree add failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[tokio::test]
async fn list_flags_outside_project_root_worktree_instead_of_dropping_it() {
    if git_missing() {
        return;
    }
    let repo = init_repo("list-outside");
    let outside = TempDir::new("list-outside-wt");
    let outside_wt = outside.path().join("elsewhere-wt");
    add_worktree_at(repo.path(), &outside_wt, "outside-branch");

    let state = test_state(repo.path());
    let resp = post_json(
        state,
        "/worktree/list",
        &serde_json::json!({ "projectPath": repo.path().to_string_lossy() }),
    )
    .await;
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("read body");
    let json: serde_json::Value = serde_json::from_slice(&bytes).expect("json");
    assert_eq!(json["success"], serde_json::json!(true), "{json}");
    let rows = json["data"].as_array().expect("data array");
    let outside_row = rows
        .iter()
        .find(|r| r["branch"] == serde_json::json!("outside-branch"))
        .expect("outside-root worktree must be listed, not filtered");
    assert_eq!(outside_row["outsideProjectRoot"], serde_json::json!(true));
    let main_row = rows
        .iter()
        .find(|r| r["branch"] != serde_json::json!("outside-branch"))
        .expect("main worktree");
    assert!(
        main_row.get("outsideProjectRoot").is_none(),
        "in-root rows carry no flag: {main_row}"
    );
}

#[tokio::test]
async fn act_routes_still_refuse_an_outside_root_worktree() {
    if git_missing() {
        return;
    }
    let repo = init_repo("act-outside");
    let outside = TempDir::new("act-outside-wt");
    let outside_wt = outside.path().join("elsewhere-wt");
    add_worktree_at(repo.path(), &outside_wt, "outside-act");
    let wt = outside_wt.to_string_lossy().to_string();

    // check-dirty (read) is refused by containment.
    let uri = format!("/worktree/check-dirty?worktreePath={}", urlencoding(&wt));
    let resp = get_request(test_state(repo.path()), &uri).await;
    let body: IpcBody<DirtyStatus> = body_as(resp.into_body()).await;
    assert!(
        !body.success,
        "check-dirty on outside worktree must be refused"
    );

    // remove (write) is refused too; the worktree stays on disk.
    let resp = post_json(
        test_state(repo.path()),
        "/worktree/remove",
        &serde_json::json!({
            "projectPath": repo.path().to_string_lossy(),
            "worktreePath": wt,
            "force": true
        }),
    )
    .await;
    let body: IpcBody<()> = body_as(resp.into_body()).await;
    assert!(!body.success, "remove of outside worktree must be refused");
    assert!(outside_wt.exists(), "outside worktree must be untouched");
}

#[tokio::test]
async fn remove_is_blocked_while_a_session_in_the_worktree_is_mid_turn() {
    if git_missing() {
        return;
    }
    let repo = init_repo("rm-guard-active");
    let parent = repo.path().parent().unwrap_or_else(|| std::path::Path::new("."));
    let state = test_state(parent);
    let resp = post_json(
        state.clone(),
        "/worktree/create",
        &serde_json::json!({
            "projectPath": repo.path().to_string_lossy(),
            "name": "wt-guard",
            "branch": "chat/wt-guard",
            "isNewBranch": true
        }),
    )
    .await;
    let created: IpcBody<GitWorktreeEntry> = body_as(resp.into_body()).await;
    let entry = created.data.expect("entry");
    let worktree = std::path::PathBuf::from(&entry.path);
    let remove_body = serde_json::json!({
        "projectPath": repo.path().to_string_lossy(),
        "worktreePath": entry.path,
        "force": true
    });

    // A turn is running in a subdirectory of the worktree.
    let nested = worktree.join("src");
    std::fs::create_dir_all(&nested).expect("nested");
    state.acp.install_test_agent_with_session_roots(
        crate::acp::AgentId("agent-1".to_string()),
        vec![("session-1".to_string(), nested, true)],
    );
    let resp = post_json(state.clone(), "/worktree/remove", &remove_body).await;
    let body: IpcBody<()> = body_as(resp.into_body()).await;
    assert!(!body.success);
    assert_eq!(body.code.as_deref(), Some("destructive_op_blocked"));
    assert!(worktree.exists(), "the worktree must survive a refused removal");

    // The same session idle: removal proceeds.
    state.acp.install_test_agent_with_session_roots(
        crate::acp::AgentId("agent-1".to_string()),
        vec![("session-1".to_string(), worktree.join("src"), false)],
    );
    let resp = post_json(state, "/worktree/remove", &remove_body).await;
    let body: IpcBody<()> = body_as(resp.into_body()).await;
    assert!(body.success, "idle session must not block: {:?}", body.error);
}
