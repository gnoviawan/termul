use super::*;
use crate::acp::AcpManager;
use crate::web::project_registry::{ProjectRegistry, ProjectSummary};
use crate::web::sink::WsRelaySink;
use crate::web::test_pty_manager;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tower::ServiceExt;

/// Temp directory removed on drop (including panic paths). Mirrors the
/// `TempDir` helper in `router.rs` tests.
struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new(label: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("termul-web-fsapi-{label}-{nanos}"));
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

fn test_state() -> AppState {
    // Default: no project root bound (legacy behavior preserved for tests
    // that do not exercise the PR-S4 boundary). PR-S4 tests use
    // `test_state_with_root` to set an explicit project root.
    test_state_with_root(std::env::temp_dir().as_path())
}

/// `AppState` with `allow_remote_writes: true` — the standalone
/// `termul-server` `--allow-remote-writes` opt-in. Used by the
/// guard-relaxation tests (non-loopback peer + flag on → succeeds).
fn test_state_remote_writes() -> AppState {
    let mut state = test_state();
    state.allow_remote_writes = true;
    state
}

/// `AppState` with `shared_live_writes_denied: true` — the desktop
/// shared-live deployment mode. All writes are refused before peer
/// evaluation (cloudflared-loopback-bypass mitigation).
fn test_state_shared_live() -> AppState {
    let mut state = test_state();
    state.shared_live_writes_denied = true;
    state
}

/// `AppState` with `allow_remote_writes: true` AND an explicit
/// `project_root` boundary — for the remote-containment tests (a
/// non-loopback peer admitted via the opt-in is confined to this root).
fn test_state_remote_writes_with_root(root: &Path) -> AppState {
    let mut state = test_state_with_root(root);
    state.allow_remote_writes = true;
    state
}

/// PR-S4: build an `AppState` with the project-root boundary set to
/// `root`. This is the containment boundary for the OPERATION routes
/// (`/git/*`, `/skills`, `/search/content` — enforced by
/// `git_api::ensure_within_project_boundary`, which accepts the default
/// `project_root` or any registered, non-archived project root). The `/fs/*` browse/read
/// routes are intentionally broader (no `project_root` containment —
/// ADR-007). Tests that previously used the default `test_state()` keep
/// working because the default root is the OS temp dir (and the existing
/// tests only touch temp dirs).
fn test_state_with_root(root: &Path) -> AppState {
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
        history_mode: crate::web::ws::HistoryMode::LiveOnly,
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

/// Deserialize an `IpcBody<T>` from a response body. Panics on failure
/// (test-only).
async fn body_as_json<T: serde::de::DeserializeOwned>(body: Body) -> T {
    let bytes = axum::body::to_bytes(body, usize::MAX)
        .await
        .expect("read body");
    serde_json::from_slice(&bytes).expect("deserialize IpcBody")
}

/// Minimal percent-encoding for the characters we care about in test
/// query strings (spaces, backslashes, colons, and anything non-path-safe).
fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            ' ' => out.push_str("%20"),
            '\\' => out.push_str("%5C"),
            ':' => out.push_str("%3A"),
            _ if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~' | '/') => {
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

/// Build a router with all fs_api routes (no static fallback) for tests.
/// Also registers `/git/status` + `/skills` so the
/// `fs_containment_boundary_relationship` test can exercise the `/fs/*`
/// breadth vs the operations containment on one router (ADR-007).
fn test_router(state: AppState) -> axum::Router {
    axum::Router::new()
        .route("/fs/mkdir", axum::routing::post(mkdir))
        .route("/fs/write", axum::routing::post(write))
        .route("/fs/ls", axum::routing::get(ls))
        .route("/fs/browse", axum::routing::get(browse))
        .route("/fs/read", axum::routing::get(read))
        .route("/fs/info", axum::routing::get(info))
        .route("/fs/delete", axum::routing::post(delete))
        .route("/fs/rename", axum::routing::post(rename))
        .route("/fs/copy", axum::routing::post(copy))
        .route("/git/init", axum::routing::post(git_init))
        .route(
            "/git/status",
            axum::routing::post(crate::web::git_api::get_status),
        )
        .route("/skills", axum::routing::get(crate::web::skills_api::list))
        .route("/shells", axum::routing::get(shells))
        .with_state(state)
}

async fn get_request(state: AppState, uri: &str) -> axum::http::Response<Body> {
    get_request_from(state, uri, SocketAddr::from(([127, 0, 0, 1], 54321))).await
}

/// GET with an explicit peer address (for loopback-guard tests on read
/// routes like `/fs/info` that now apply `check_local_only`).
async fn get_request_from(
    state: AppState,
    uri: &str,
    peer: SocketAddr,
) -> axum::http::Response<Body> {
    test_router(state)
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(uri)
                .extension(ConnectInfo(peer))
                .body(Body::empty())
                .expect("build request"),
        )
        .await
        .expect("router response")
}

/// POST JSON with a loopback peer (the default for the fs write routes
/// which now require `ConnectInfo<SocketAddr>` — Patch D).
async fn post_json(
    state: AppState,
    uri: &str,
    body: &serde_json::Value,
) -> axum::http::Response<Body> {
    post_json_from(state, uri, body, SocketAddr::from(([127, 0, 0, 1], 54321))).await
}

/// POST JSON with an explicit peer address (Patch D: the localhost guard
/// rejects non-loopback peers on `/fs/mkdir` + `/fs/write`).
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

#[tokio::test]
async fn mkdir_creates_recursive_dir() {
    let dir = TempDir::new("mkdir");
    let target = dir.path().join("a/b/c");
    let req_body = serde_json::json!({ "path": target.to_string_lossy() });
    let resp = post_json(test_state(), "/fs/mkdir", &req_body).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(body.success, "mkdir should succeed: {:?}", body.error);
    assert!(target.is_dir(), "target dir must exist");
}

#[tokio::test]
async fn mkdir_is_idempotent_when_dir_exists() {
    let dir = TempDir::new("mkdir-idem");
    let target = dir.path().join("exists");
    fs::create_dir_all(&target).expect("pre-create");
    let req_body = serde_json::json!({ "path": target.to_string_lossy() });
    let resp = post_json(test_state(), "/fs/mkdir", &req_body).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(
        body.success,
        "idempotent mkdir should succeed: {:?}",
        body.error
    );
}

#[tokio::test]
async fn mkdir_returns_failure_body_on_invalid_path() {
    // Target a child of a path that is itself a file — `create_dir_all`
    // fails because the parent isn't a directory.
    let dir = TempDir::new("mkdir-fail");
    let file_as_parent = dir.path().join("not-a-dir");
    fs::write(&file_as_parent, "x").expect("write file");
    let target = file_as_parent.join("child");
    let req_body = serde_json::json!({ "path": target.to_string_lossy() });
    let resp = post_json(test_state(), "/fs/mkdir", &req_body).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(!body.success, "mkdir under a file should fail");
    assert_eq!(body.code.as_deref(), Some("MKDIR_ERROR"));
    assert!(body.error.is_some(), "error message must be present");
}

#[tokio::test]
async fn write_creates_file() {
    let dir = TempDir::new("write");
    let target = dir.path().join("README.md");
    let req_body = serde_json::json!({ "path": target.to_string_lossy(), "content": "# hello" });
    let resp = post_json(test_state(), "/fs/write", &req_body).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(body.success, "write should succeed: {:?}", body.error);
    let written = fs::read_to_string(&target).expect("file written");
    assert_eq!(written, "# hello");
}

#[tokio::test]
async fn write_returns_failure_when_parent_missing() {
    let dir = TempDir::new("write-fail");
    let target = dir.path().join("no-such-parent/child.txt");
    let req_body = serde_json::json!({ "path": target.to_string_lossy(), "content": "x" });
    let resp = post_json(test_state(), "/fs/write", &req_body).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(!body.success, "write with missing parent should fail");
    assert_eq!(body.code.as_deref(), Some("WRITE_ERROR"));
}

#[tokio::test]
async fn ls_empty_dir_returns_empty_array() {
    let dir = TempDir::new("ls-empty");
    let uri = format!("/fs/ls?path={}", urlencoding(&dir.path().to_string_lossy()));
    let resp = get_request(test_state(), &uri).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<Vec<DirectoryEntryDto>> = body_as_json(resp.into_body()).await;
    assert!(
        body.success,
        "ls on empty dir should succeed: {:?}",
        body.error
    );
    assert!(body.data.unwrap_or_default().is_empty());
}

#[tokio::test]
async fn ls_missing_dir_returns_read_error() {
    let dir = TempDir::new("ls-missing");
    let missing = dir.path().join("does-not-exist");
    let uri = format!("/fs/ls?path={}", urlencoding(&missing.to_string_lossy()));
    let resp = get_request(test_state(), &uri).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<Vec<DirectoryEntryDto>> = body_as_json(resp.into_body()).await;
    assert!(!body.success, "ls on missing dir should fail");
    assert_eq!(body.code.as_deref(), Some("READ_ERROR"));
}

#[tokio::test]
async fn ls_nonempty_dir_returns_sorted_entries() {
    let dir = TempDir::new("ls-nonempty");
    fs::write(dir.path().join("zfile.txt"), "x").expect("write z");
    fs::create_dir_all(dir.path().join("adir")).expect("mkdir adir");
    fs::write(dir.path().join("bfile.md"), "y").expect("write b");
    let uri = format!("/fs/ls?path={}", urlencoding(&dir.path().to_string_lossy()));
    let resp = get_request(test_state(), &uri).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<Vec<DirectoryEntryDto>> = body_as_json(resp.into_body()).await;
    assert!(body.success, "ls should succeed: {:?}", body.error);
    let entries = body.data.expect("entries");
    // Directories first, then files A-Z.
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0].r#type, "directory");
    assert_eq!(entries[0].name, "adir");
    assert_eq!(entries[1].r#type, "file");
    assert_eq!(entries[1].name, "bfile.md");
    assert_eq!(entries[2].r#type, "file");
    assert_eq!(entries[2].name, "zfile.txt");
    // extension should be populated for files.
    assert_eq!(entries[1].extension.as_deref(), Some(".md"));
    assert!(entries[0].extension.is_none(), "dirs have no extension");
}

#[tokio::test]
async fn browse_returns_entries_like_ls() {
    let dir = TempDir::new("browse");
    fs::create_dir_all(dir.path().join("subdir")).expect("mkdir");
    fs::write(dir.path().join("file.txt"), "x").expect("write");
    let uri = format!(
        "/fs/browse?path={}",
        urlencoding(&dir.path().to_string_lossy())
    );
    let resp = get_request(test_state(), &uri).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<Vec<DirectoryEntryDto>> = body_as_json(resp.into_body()).await;
    assert!(body.success, "browse should succeed: {:?}", body.error);
    let entries = body.data.expect("entries");
    assert_eq!(entries.len(), 2);
    // Directory first.
    assert_eq!(entries[0].r#type, "directory");
}

#[tokio::test]
async fn git_init_creates_dot_git_in_cwd() {
    let dir = TempDir::new("gitinit");
    let req_body = serde_json::json!({ "cwd": dir.path().to_string_lossy() });
    let resp = post_json(test_state(), "/git/init", &req_body).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    // Git may or may not be installed in CI; if it's missing the handler
    // returns a failure body (code GIT_INIT_ERROR), which we accept — but
    // when git IS present the repo must be initialized.
    if body.success {
        assert!(dir.path().join(".git").exists(), ".git must exist");
    } else {
        // Expected only when git is unavailable on the host.
        assert_eq!(body.code.as_deref(), Some("GIT_INIT_ERROR"));
    }
}

/// F-002 regression: `POST /git/init` is a WRITE route — a non-loopback
/// peer without `--allow-remote-writes` must be refused (FORBIDDEN)
/// before any git process runs. Previously the handler executed on the
/// raw cwd with zero guards: any authenticated peer could `git init`
/// any host path.
#[tokio::test]
async fn git_init_refused_from_non_loopback_peer() {
    let dir = TempDir::new("gitinit-guard");
    let req_body = serde_json::json!({ "cwd": dir.path().to_string_lossy() });
    let remote = SocketAddr::from(([192, 168, 1, 50], 40000));
    let resp = post_json_from(test_state(), "/git/init", &req_body, remote).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(!body.success, "non-loopback git init must be refused");
    assert_eq!(body.code.as_deref(), Some("FORBIDDEN"));
    // Nothing was created — the guard fired before any filesystem work.
    assert!(!dir.path().join(".git").exists());
}

/// F-002 second half: `..` traversal in the cwd must be rejected with
/// PATH_TRAVERSAL (the handler previously passed the raw string to git).
#[tokio::test]
async fn git_init_rejects_path_traversal_cwd() {
    let req_body = serde_json::json!({ "cwd": "../escape" });
    let resp = post_json(test_state(), "/git/init", &req_body).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(!body.success, "traversal cwd must be rejected");
    assert_eq!(body.code.as_deref(), Some("PATH_TRAVERSAL"));
}

/// F-002 third: even a loopback (or opted-in remote) peer is confined to
/// the registered project root — `git init` outside the boundary is
/// OUTSIDE_PROJECT_ROOT, matching every other `/git/*` route.
#[tokio::test]
async fn git_init_rejects_cwd_outside_project_root() {
    let outside = TempDir::new("gitinit-outside");
    let inside = TempDir::new("gitinit-inside");
    let state = test_state_with_root(inside.path());
    let req_body = serde_json::json!({ "cwd": outside.path().to_string_lossy() });
    let resp = post_json(state, "/git/init", &req_body).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(!body.success, "outside-root git init must be rejected");
    assert_eq!(body.code.as_deref(), Some("OUTSIDE_PROJECT_ROOT"));
    assert!(!outside.path().join(".git").exists());
}

#[tokio::test]
async fn shells_returns_detected_shells() {
    let resp = get_request(test_state(), "/shells").await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<crate::DetectedShells> = body_as_json(resp.into_body()).await;
    assert!(body.success, "shells should succeed: {:?}", body.error);
    let data = body.data.expect("DetectedShells");
    // On the test host at least one shell should be detected (Windows:
    // cmd/powershell; Unix: something from $SHELL). If not, the default
    // is still Some on Windows.
    assert!(!data.available.is_empty() || data.default.is_some());
}

/// Patch D: a non-loopback peer is refused on `/fs/write` (200 + IpcResult
/// `code: "FORBIDDEN"`). The localhost guard keeps the fs write surface
/// safe even when the server is bound to `0.0.0.0`.
#[tokio::test]
async fn write_refused_from_non_loopback_peer() {
    let dir = TempDir::new("write-guard");
    let target = dir.path().join("README.md");
    let req_body = serde_json::json!({ "path": target.to_string_lossy(), "content": "# hi" });
    // Non-loopback peer (a random LAN-ish address).
    let remote = SocketAddr::from(([192, 168, 1, 50], 40000));
    let resp = post_json_from(test_state(), "/fs/write", &req_body, remote).await;
    assert_eq!(resp.status(), StatusCode::OK, "guard returns 200+IpcResult");
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(!body.success, "non-loopback write must be refused");
    assert_eq!(body.code.as_deref(), Some("FORBIDDEN"));
    assert!(body.error.unwrap_or_default().contains("localhost-only"));
    // The file must NOT have been written.
    assert!(!target.exists(), "guard must reject before writing");
}

/// Patch D: a non-loopback peer is refused on `/fs/mkdir` as well.
#[tokio::test]
async fn mkdir_refused_from_non_loopback_peer() {
    let dir = TempDir::new("mkdir-guard");
    let target = dir.path().join("newdir");
    let req_body = serde_json::json!({ "path": target.to_string_lossy() });
    let remote = SocketAddr::from(([10, 0, 0, 5], 50000));
    let resp = post_json_from(test_state(), "/fs/mkdir", &req_body, remote).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(!body.success);
    assert_eq!(body.code.as_deref(), Some("FORBIDDEN"));
    assert!(!target.exists(), "guard must reject before mkdir");
}

/// `--allow-remote-writes`: a non-loopback peer is ADMITTED on `/fs/mkdir`
/// (the operator opt-in relaxes the CWE-306 loopback guard). Mirrors
/// `mkdir_refused_from_non_loopback_peer` with the flag flipped.
#[tokio::test]
async fn mkdir_admitted_from_non_loopback_peer_when_opt_in() {
    let dir = TempDir::new("mkdir-opt-in");
    let target = dir.path().join("newdir");
    let req_body = serde_json::json!({ "path": target.to_string_lossy() });
    let remote = SocketAddr::from(([10, 0, 0, 5], 50000));
    let resp = post_json_from(test_state_remote_writes(), "/fs/mkdir", &req_body, remote).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(
        body.success,
        "opt-in must admit non-loopback peer: {:?}",
        body.error
    );
    assert!(target.is_dir(), "target dir must exist");
}

/// `--allow-remote-writes`: a non-loopback peer is ADMITTED on `/fs/write`
/// (covers the template-file write step of remote project scaffolding).
#[tokio::test]
async fn write_admitted_from_non_loopback_peer_when_opt_in() {
    let dir = TempDir::new("write-opt-in");
    let target = dir.path().join("README.md");
    let req_body = serde_json::json!({ "path": target.to_string_lossy(), "content": "ok" });
    let remote = SocketAddr::from(([10, 0, 0, 5], 50000));
    let resp = post_json_from(test_state_remote_writes(), "/fs/write", &req_body, remote).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(
        body.success,
        "opt-in must admit non-loopback peer: {:?}",
        body.error
    );
    assert!(target.exists(), "file written");
}

/// Shared-live deployment mode: a loopback peer is REFUSED (the
/// cloudflared-bypass mitigation — writes denied before peer eval).
#[tokio::test]
async fn mkdir_refused_in_shared_live_mode_even_from_loopback() {
    let dir = TempDir::new("mkdir-shared-live");
    let target = dir.path().join("newdir");
    let req_body = serde_json::json!({ "path": target.to_string_lossy() });
    // Even a loopback peer is refused in shared-live mode.
    let loopback = SocketAddr::from(([127, 0, 0, 1], 54321));
    let resp = post_json_from(test_state_shared_live(), "/fs/mkdir", &req_body, loopback).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(!body.success, "shared-live must refuse even loopback");
    assert_eq!(body.code.as_deref(), Some("FORBIDDEN"));
    assert!(!target.exists(), "shared-live must not create the dir");
}

/// Remote containment: a non-loopback peer admitted via the opt-in is
/// REFUSED with `OUTSIDE_PROJECT_ROOT` when targeting a path outside the
/// configured project_root (ADR-007 breadth applies to loopback only).
#[tokio::test]
async fn mkdir_remote_refused_outside_project_root_when_opt_in() {
    // project_root = a dedicated temp dir; target is OUTSIDE it.
    let root = TempDir::new("mkdir-confine-root");
    let outside = TempDir::new("mkdir-confine-outside");
    let target = outside.path().join("newdir");
    let req_body = serde_json::json!({ "path": target.to_string_lossy() });
    let remote = SocketAddr::from(([10, 0, 0, 5], 50000));
    let resp = post_json_from(
        test_state_remote_writes_with_root(root.path()),
        "/fs/mkdir",
        &req_body,
        remote,
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(
        !body.success,
        "remote peer outside project_root must be refused"
    );
    assert_eq!(body.code.as_deref(), Some("OUTSIDE_PROJECT_ROOT"));
    assert!(!target.exists(), "must not create outside project_root");
}

/// Remote containment (positive): a non-loopback peer admitted via the
/// opt-in SUCCEEDS when the target is INSIDE project_root.
#[tokio::test]
async fn mkdir_remote_admitted_inside_project_root_when_opt_in() {
    let root = TempDir::new("mkdir-confine-ok");
    let target = root.path().join("newdir");
    let req_body = serde_json::json!({ "path": target.to_string_lossy() });
    let remote = SocketAddr::from(([10, 0, 0, 5], 50000));
    let resp = post_json_from(
        test_state_remote_writes_with_root(root.path()),
        "/fs/mkdir",
        &req_body,
        remote,
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(
        body.success,
        "remote peer inside project_root must succeed: {:?}",
        body.error
    );
    assert!(target.is_dir(), "target dir must exist");
}

/// Remote containment: a loopback peer can still write OUTSIDE
/// project_root (ADR-007 breadth preserved for local callers).
#[tokio::test]
async fn mkdir_loopback_allows_outside_project_root() {
    let root = TempDir::new("mkdir-breadth-root");
    let outside = TempDir::new("mkdir-breadth-outside");
    let target = outside.path().join("newdir");
    let req_body = serde_json::json!({ "path": target.to_string_lossy() });
    let loopback = SocketAddr::from(([127, 0, 0, 1], 54321));
    // allow_remote_writes = false, shared_live = false (default test_state_with_root).
    let resp = post_json_from(
        test_state_with_root(root.path()),
        "/fs/mkdir",
        &req_body,
        loopback,
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(
        body.success,
        "loopback must keep ADR-007 breadth: {:?}",
        body.error
    );
    assert!(target.is_dir(), "target dir must exist");
}

/// Patch D: loopback peers are still allowed (the happy path through the
/// guard — `127.0.0.1` and `::1` both pass).
#[tokio::test]
async fn write_allowed_from_loopback_ipv6() {
    let dir = TempDir::new("write-loopback-v6");
    let target = dir.path().join("README.md");
    let req_body = serde_json::json!({ "path": target.to_string_lossy(), "content": "ok" });
    let loopback_v6 = SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 1], 54321));
    let resp = post_json_from(test_state(), "/fs/write", &req_body, loopback_v6).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(body.success, "::1 is loopback: {:?}", body.error);
    assert!(target.exists(), "file written");
}

/// Patch C: a directory with one unreadable entry (dangling symlink) still
/// returns success with the readable entries — the whole listing does not
/// fail. `entry.metadata()` follows the link and fails on a dangling
/// target; `symlink_metadata` returns the symlink's own metadata (type =
/// symlink, reported as `file` here per the conservative default). The
/// readable sibling must still be present.
#[tokio::test]
async fn list_dir_resilient_to_broken_symlink() {
    let dir = TempDir::new("broken-symlink");
    fs::write(dir.path().join("real.txt"), "x").expect("write real");
    // Create a dangling symlink pointing at a non-existent target.
    let dangling = dir.path().join("dangling");
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("/this/does/not/exist", &dangling).expect("symlink");
    }
    #[cfg(windows)]
    {
        // jsdom-style: use std::os::windows::symlink_file (requires the
        // `Developer Mode` or admin on some Windows; if it fails we skip
        // the assertion rather than failing the test — the resilience
        // path is still exercised via the `metadata().or_else(symlink_metadata)`
        // fallback in `list_dir`, and the cross-platform contract is
        // covered by the sibling `list_dir_resilient_to_stat_error` test
        // which forces a stat failure without a symlink.
        let _ = dangling;
    }
    let uri = format!("/fs/ls?path={}", urlencoding(&dir.path().to_string_lossy()));
    let resp = get_request(test_state(), &uri).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<Vec<DirectoryEntryDto>> = body_as_json(resp.into_body()).await;
    assert!(
        body.success,
        "listing must succeed even with an unreadable child: {:?}",
        body.error
    );
    let entries = body.data.expect("entries");
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    assert!(
        names.contains(&"real.txt"),
        "readable entry present: {names:?}"
    );
    // The dangling symlink is either surfaced (unix) or absent (windows
    // when symlink creation failed) — in both cases the listing succeeds.
}

/// Patch C (cross-platform): when a child's `metadata()` fails, the entry is
/// still surfaced via `symlink_metadata()` (or conservative defaults). We
// cannot easily force `metadata()` to fail cross-platform without a
// symlink, so this test asserts the docstring contract directly: an entry
// whose metadata is `None` is still included with conservative defaults
// via `entry_dto`.
#[tokio::test]
async fn entry_dto_defaults_when_metadata_none() {
    let dir = TempDir::new("entry-dto-defaults");
    let parent = dir.path();
    let dto = entry_dto(parent, "unreadable".to_string(), None);
    assert_eq!(dto.name, "unreadable");
    assert_eq!(dto.r#type, "file");
    assert_eq!(dto.size, 0);
    assert_eq!(dto.modified_at, 0);
    // extension is derived from the name (no metadata needed).
    assert_eq!(dto.extension.as_deref(), None);
}

/// Patch B: `get_extension` + `should_ignore` use the entry NAME (not the
/// full path). A `node_modules` subdir at `C:/proj/node_modules` must be
/// flagged `ignored: true`, and a file `readme` under a dir named `v2.0`
/// must get extension `None` (no garbage `.0/readme`).
#[tokio::test]
async fn entry_dto_uses_name_not_full_path() {
    let dir = TempDir::new("entry-dto-name");
    // `node_modules` subdir — must be flagged ignored.
    let nm_dto = entry_dto(
        dir.path(),
        "node_modules".to_string(),
        fs::metadata(dir.path()).ok().as_ref(),
    );
    assert_eq!(nm_dto.ignored, Some(true));

    // A file `readme` under a parent named `v2.0`: extension must be None
    // (no `.` in `readme`), NOT the path-derived `.0/readme`.
    let parent_v2 = dir.path().join("v2.0");
    fs::create_dir_all(&parent_v2).expect("mkdir v2.0");
    let readme_dto = entry_dto(
        &parent_v2,
        "readme".to_string(),
        fs::metadata(&parent_v2).ok().as_ref(),
    );
    assert_eq!(readme_dto.extension, None, "no garbage extension from path");
    assert_eq!(readme_dto.r#type, "directory");
}

/// Patch B: a leading-dot file (`.gitignore`) matches the desktop impl —
/// the whole name is returned as the extension (desktop `getExtension`
/// does NOT return `None` for `idx == 0`).
#[tokio::test]
async fn get_extension_dotfile_matches_desktop() {
    assert_eq!(get_extension(".gitignore").as_deref(), Some(".gitignore"));
    assert_eq!(get_extension(".env").as_deref(), Some(".env"));
    // Regular files keep the leading-dot extension.
    assert_eq!(get_extension("README.md").as_deref(), Some(".md"));
    // No extension.
    assert_eq!(get_extension("README").as_deref(), None);
}

/// Patch J: cross-runtime IpcResult-shape round-trip. The Rust handler
/// emits `DirectoryEntryDto` with `#[serde(rename_all = "camelCase")]` —
/// this test asserts the EXACT serde JSON bytes (field names `modifiedAt`,
/// `type`, `ignored`, `extension`, `size`) round-trip through a
/// deserialize-then-re-inspect cycle, catching a field rename (e.g.
/// `modified_at` ↔ `modifiedAt`) that per-side tests would miss.
#[tokio::test]
async fn directory_entry_dto_round_trips_camel_case() {
    let dir = TempDir::new("round-trip");
    fs::write(dir.path().join("README.md"), "x").expect("write");
    let uri = format!("/fs/ls?path={}", urlencoding(&dir.path().to_string_lossy()));
    let resp = get_request(test_state(), &uri).await;
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("read body");
    // The raw handler JSON: must use camelCase keys, NOT snake_case.
    let raw = String::from_utf8_lossy(&bytes);
    assert!(
        raw.contains("\"modifiedAt\""),
        "camelCase modifiedAt must be in the wire JSON: {raw}"
    );
    assert!(
        !raw.contains("\"modified_at\""),
        "snake_case modified_at must NOT be in the wire JSON: {raw}"
    );
    assert!(raw.contains("\"type\""), "type field present: {raw}");
    // Round-trip: the exact handler bytes deserialize into the DTO struct.
    let body: IpcBody<Vec<DirectoryEntryDto>> =
        serde_json::from_slice(&bytes).expect("deserialize IpcBody from raw handler bytes");
    assert!(body.success);
    let entries = body.data.expect("entries");
    assert_eq!(entries.len(), 1);
    let entry = &entries[0];
    assert_eq!(entry.name, "README.md");
    assert_eq!(entry.r#type, "file");
    assert_eq!(entry.extension.as_deref(), Some(".md"));
    // `modifiedAt` field is populated (not zero) — proves the camelCase
    // serde rename round-trips into the struct field `modified_at`.
    assert!(
        entry.modified_at > 0,
        "modifiedAt populated: {}",
        entry.modified_at
    );
    // Re-serialize and assert the camelCase key is preserved on the way out.
    let re = serde_json::to_string(entry).expect("re-serialize");
    assert!(
        re.contains("\"modifiedAt\""),
        "re-serialize keeps camelCase: {re}"
    );
}

/// Paths outside the configured `project_root` are now allowed (the
/// prefix-containment jail was removed by spec-remove-web-fs-path-jail).
/// `mkdir` creates the directory even when it lives outside the root.
#[tokio::test]
async fn mkdir_allows_path_outside_project_root() {
    let root = TempDir::new("mkdir-root");
    let outside = TempDir::new("mkdir-outside");
    let target = outside.path().join("newdir");
    let req_body = serde_json::json!({ "path": target.to_string_lossy() });
    let resp = post_json(test_state_with_root(root.path()), "/fs/mkdir", &req_body).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(
        body.success,
        "mkdir outside root should succeed: {:?}",
        body.error
    );
    assert!(target.is_dir(), "directory outside root must be created");
}

/// Explicit `..` traversal components in the request path must be
/// rejected even when the result would coincidentally land inside root
/// (defense-in-depth — never trust raw client paths).
#[tokio::test]
async fn mkdir_rejects_traversal_sequence_in_path() {
    let root = TempDir::new("mkdir-trav-root");
    // Build a path that starts inside the root but escapes via `..`.
    // canonicalize at test-build time so the test is platform-agnostic.
    let inside = root.path().join("sub");
    fs::create_dir_all(&inside).expect("mkdir inside");
    let traversal = inside.join("..").join("..").join("etc");
    let req_body = serde_json::json!({ "path": traversal.to_string_lossy() });
    let resp = post_json(test_state_with_root(root.path()), "/fs/mkdir", &req_body).await;
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(!body.success, "traversal must be refused");
    assert_eq!(body.code.as_deref(), Some("PATH_TRAVERSAL"));
}

/// Paths outside the configured `project_root` are now allowed (the
/// prefix-containment jail was removed by spec-remove-web-fs-path-jail).
/// `write` creates the file even when it lives outside the root.
#[tokio::test]
async fn write_allows_path_outside_project_root() {
    let root = TempDir::new("write-root");
    let outside = TempDir::new("write-outside");
    let target = outside.path().join("evil.txt");
    let req_body = serde_json::json!({ "path": target.to_string_lossy(), "content": "pwn" });
    let resp = post_json(test_state_with_root(root.path()), "/fs/write", &req_body).await;
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(
        body.success,
        "write outside root should succeed: {:?}",
        body.error
    );
    assert!(target.exists(), "file outside root must be written");
    assert_eq!(fs::read_to_string(&target).unwrap(), "pwn");
}

/// Paths outside the configured `project_root` are now allowed (the
/// prefix-containment jail was removed by spec-remove-web-fs-path-jail).
/// `ls` returns entries for a directory outside the root.
#[tokio::test]
async fn ls_allows_path_outside_project_root() {
    let root = TempDir::new("ls-root");
    let outside = TempDir::new("ls-outside");
    fs::write(outside.path().join("marker.txt"), "x").expect("write marker");
    let uri = format!(
        "/fs/ls?path={}",
        urlencoding(&outside.path().to_string_lossy())
    );
    let resp = get_request(test_state_with_root(root.path()), &uri).await;
    let body: IpcBody<Vec<DirectoryEntryDto>> = body_as_json(resp.into_body()).await;
    assert!(
        body.success,
        "ls outside root should succeed: {:?}",
        body.error
    );
    let entries = body.data.expect("entries");
    assert!(
        entries.iter().any(|e| e.name == "marker.txt"),
        "outside-root entry must be listed"
    );
}

/// A symlink that lives INSIDE the project root but points OUTSIDE is now
/// followed (the prefix-containment jail was removed by
/// spec-remove-web-fs-path-jail). `/fs/browse` resolves the link and
/// returns entries from the target directory.
#[tokio::test]
async fn browse_allows_symlink_pointing_outside_root() {
    let root = TempDir::new("browse-sym-root");
    let outside = TempDir::new("browse-sym-outside");
    fs::write(outside.path().join("external.txt"), "x").expect("write external marker");
    let link = root.path().join("evil_link");
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(outside.path(), &link).expect("symlink");
    }
    #[cfg(windows)]
    {
        // On Windows, directory symlinks require elevation/dev mode;
        // skip the assertion if creation fails (the traversal-rejection
        // path is still exercised by the other tests in this module).
        if std::os::windows::fs::symlink_dir(outside.path(), &link).is_err() {
            eprintln!("skipping: cannot create symlink on this Windows host");
            return;
        }
    }
    let uri = format!("/fs/browse?path={}", urlencoding(&link.to_string_lossy()));
    let resp = get_request(test_state_with_root(root.path()), &uri).await;
    let body: IpcBody<Vec<DirectoryEntryDto>> = body_as_json(resp.into_body()).await;
    assert!(
        body.success,
        "browse via symlink outside root should succeed: {:?}",
        body.error
    );
    let entries = body.data.expect("entries");
    assert!(
        entries.iter().any(|e| e.name == "external.txt"),
        "external entry via symlink must be listed"
    );
}

/// Patch I: git-init failure path is explicitly asserted. The existing
/// `git_init_creates_dot_git_in_cwd` test conditionally skips the failure
/// branch when git is present. This test forces a non-zero git exit by
/// passing a `cwd` that doesn't exist — `run_git_command` fails to spawn
/// git in a non-existent cwd, and the handler returns
/// `{success:false, code:"GIT_INIT_ERROR"}` with a non-empty error.
#[tokio::test]
async fn git_init_returns_error_for_nonexistent_cwd() {
    let dir = TempDir::new("gitinit-nonexistent");
    let cwd = dir.path().join("does-not-exist");
    let req_body = serde_json::json!({ "cwd": cwd.to_string_lossy() });
    let resp = post_json(test_state(), "/git/init", &req_body).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    // Either git is missing (GIT_INIT_ERROR) OR git ran but failed in the
    // non-existent cwd (GIT_INIT_ERROR). Either way: failure + non-empty
    // error + the stable code.
    assert!(!body.success, "git init in a non-existent cwd must fail");
    assert_eq!(body.code.as_deref(), Some("GIT_INIT_ERROR"));
    let err = body.error.expect("error message present");
    assert!(!err.trim().is_empty(), "error must be non-empty: {err:?}");
}

/// `/fs/read` returns the file content + size + modifiedAt for an existing
/// text file inside the project root.
#[tokio::test]
async fn read_returns_file_content() {
    let root = TempDir::new("read-root");
    let file = root.path().join("note.txt");
    fs::write(&file, "hello world").expect("write file");
    let uri = format!("/fs/read?path={}", urlencoding(&file.to_string_lossy()));
    let resp = get_request(test_state_with_root(root.path()), &uri).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<FileContentDto> = body_as_json(resp.into_body()).await;
    assert!(body.success, "read inside root must succeed");
    let fc = body.data.expect("content present");
    assert_eq!(fc.content, "hello world");
    assert_eq!(fc.encoding, "utf-8");
    assert_eq!(fc.size, "hello world".len() as u64);
    assert!(fc.modified_at > 0, "modifiedAt must be populated");
}

/// `/fs/read` allows a path outside the project root (the prefix-containment
/// jail was removed by spec-remove-web-fs-path-jail; matches `/fs/ls`).
#[tokio::test]
async fn read_allows_path_outside_project_root() {
    let root = TempDir::new("read-root");
    let outside = TempDir::new("read-outside");
    let target = outside.path().join("evil.txt");
    fs::write(&target, "pwn").expect("write outside file");
    let uri = format!("/fs/read?path={}", urlencoding(&target.to_string_lossy()));
    let resp = get_request(test_state_with_root(root.path()), &uri).await;
    let body: IpcBody<FileContentDto> = body_as_json(resp.into_body()).await;
    assert!(
        body.success,
        "read outside root should succeed: {:?}",
        body.error
    );
    assert_eq!(body.data.expect("content").content, "pwn");
}

/// `/fs/read` rejects explicit `..` traversal components (defense-in-depth).
#[tokio::test]
async fn read_rejects_traversal_sequence_in_path() {
    let root = TempDir::new("read-trav-root");
    let inside = root.path().join("sub");
    fs::create_dir_all(&inside).expect("mkdir inside");
    let traversal = inside.join("..").join("..").join("etc");
    let uri = format!(
        "/fs/read?path={}",
        urlencoding(&traversal.to_string_lossy())
    );
    let resp = get_request(test_state_with_root(root.path()), &uri).await;
    let body: IpcBody<FileContentDto> = body_as_json(resp.into_body()).await;
    assert!(!body.success, "traversal must be refused");
    let code = body.code.as_deref().unwrap_or("");
    assert!(
        code == "PATH_TRAVERSAL" || code == "OUTSIDE_ROOT",
        "expected PATH_TRAVERSAL or OUTSIDE_ROOT, got {code:?}"
    );
}

/// `/fs/read` refuses a directory (cannot read a dir as a file) with
/// `READ_ERROR`, never returning a directory listing.
#[tokio::test]
async fn read_rejects_directory() {
    let root = TempDir::new("read-dir-root");
    let dir_path = root.path().join("a-dir");
    fs::create_dir_all(&dir_path).expect("mkdir");
    let uri = format!("/fs/read?path={}", urlencoding(&dir_path.to_string_lossy()));
    let resp = get_request(test_state_with_root(root.path()), &uri).await;
    let body: IpcBody<FileContentDto> = body_as_json(resp.into_body()).await;
    assert!(!body.success, "reading a directory must fail");
    assert_eq!(body.code.as_deref(), Some("READ_ERROR"));
}

/// `/fs/read` refuses a binary file (NUL/control bytes in the first 512
/// bytes) with `BINARY_FILE`, mirroring the renderer's `isBinaryFile`.
#[tokio::test]
async fn read_rejects_binary_file() {
    let root = TempDir::new("read-bin-root");
    let file = root.path().join("blob.bin");
    // Leading NUL byte (0x00) — caught by the binary sample scan.
    fs::write(&file, [0x00u8, 0x01, 0x02, 0x03]).expect("write binary");
    let uri = format!("/fs/read?path={}", urlencoding(&file.to_string_lossy()));
    let resp = get_request(test_state_with_root(root.path()), &uri).await;
    let body: IpcBody<FileContentDto> = body_as_json(resp.into_body()).await;
    assert!(!body.success, "binary file must be refused");
    assert_eq!(body.code.as_deref(), Some("BINARY_FILE"));
}

/// `/fs/read` refuses a non-UTF-8 text file with `READ_ERROR` instead of
/// lossy-decoding it (matches desktop `readTextFile`, which fails on
/// invalid UTF-8). Prevents the editor from saving U+FFFD replacement
/// characters back over the original bytes.
#[tokio::test]
async fn read_rejects_non_utf8_text_file() {
    let root = TempDir::new("read-latin1-root");
    let file = root.path().join("latin1.txt");
    // 0xE9 (Latin-1 `é`) is > 0x08 so it clears the binary sample scan,
    // but it is not valid UTF-8 (0xE9 is a 3-byte lead expecting two
    // continuation bytes). Previously this was lossy-decoded to U+FFFD.
    fs::write(&file, [0xE9u8]).expect("write latin-1");
    let uri = format!("/fs/read?path={}", urlencoding(&file.to_string_lossy()));
    let resp = get_request(test_state_with_root(root.path()), &uri).await;
    let body: IpcBody<FileContentDto> = body_as_json(resp.into_body()).await;
    assert!(
        !body.success,
        "non-UTF-8 text must be refused, not lossy-decoded"
    );
    assert_eq!(body.code.as_deref(), Some("READ_ERROR"));
}

/// `/fs/read` refuses a file larger than `MAX_FILE_SIZE` (1 MiB) with
/// `FILE_TOO_LARGE` BEFORE reading any bytes (matches the desktop
/// facade's size guard).
#[tokio::test]
async fn read_rejects_file_too_large() {
    let root = TempDir::new("read-large-root");
    let file = root.path().join("huge.txt");
    // One byte over the 1 MiB cap; refused before the read.
    let bytes = vec![b'x'; (MAX_FILE_SIZE + 1) as usize];
    fs::write(&file, &bytes).expect("write large file");
    let uri = format!("/fs/read?path={}", urlencoding(&file.to_string_lossy()));
    let resp = get_request(test_state_with_root(root.path()), &uri).await;
    let body: IpcBody<FileContentDto> = body_as_json(resp.into_body()).await;
    assert!(
        !body.success,
        "oversized file must be refused before reading"
    );
    assert_eq!(body.code.as_deref(), Some("FILE_TOO_LARGE"));
}

/// `/fs/info` returns metadata for an existing text file: size, modifiedAt,
/// `type:"file"`, `isBinary:false`.
#[tokio::test]
async fn info_returns_file_metadata() {
    let root = TempDir::new("info-root");
    let file = root.path().join("note.txt");
    fs::write(&file, "hello world").expect("write file");
    let uri = format!("/fs/info?path={}", urlencoding(&file.to_string_lossy()));
    let resp = get_request(test_state_with_root(root.path()), &uri).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<FileInfoDto> = body_as_json(resp.into_body()).await;
    assert!(
        body.success,
        "info on existing file must succeed: {:?}",
        body.error
    );
    let info = body.data.expect("FileInfo present");
    assert_eq!(info.size, "hello world".len() as u64);
    assert!(info.modified_at > 0, "modifiedAt must be populated");
    assert_eq!(info.r#type, "file");
    assert!(!info.is_binary, "text file must not be binary");
}

/// `/fs/info` returns metadata for a directory: `type:"directory"`,
/// `isBinary:false`, `size` from `fs::metadata`.
#[tokio::test]
async fn info_returns_directory_metadata() {
    let root = TempDir::new("info-dir-root");
    let dir_path = root.path().join("a-dir");
    fs::create_dir_all(&dir_path).expect("mkdir");
    let uri = format!("/fs/info?path={}", urlencoding(&dir_path.to_string_lossy()));
    let resp = get_request(test_state_with_root(root.path()), &uri).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<FileInfoDto> = body_as_json(resp.into_body()).await;
    assert!(
        body.success,
        "info on directory must succeed: {:?}",
        body.error
    );
    let info = body.data.expect("FileInfo present");
    assert_eq!(info.r#type, "directory");
    assert!(!info.is_binary, "directory must not be binary");
}

/// `/fs/info` detects a binary file (control bytes 0x00-0x08 in the first
/// 512 bytes) — mirrors the renderer's `isBinaryFile` + the `/fs/read`
/// sample scan.
#[tokio::test]
async fn info_detects_binary_file() {
    let root = TempDir::new("info-bin-root");
    let file = root.path().join("blob.bin");
    fs::write(&file, [0x00u8, 0x01, 0x02, 0x03]).expect("write binary");
    let uri = format!("/fs/info?path={}", urlencoding(&file.to_string_lossy()));
    let resp = get_request(test_state_with_root(root.path()), &uri).await;
    let body: IpcBody<FileInfoDto> = body_as_json(resp.into_body()).await;
    assert!(body.success, "info on binary file must succeed");
    assert!(
        body.data.expect("FileInfo").is_binary,
        "binary file must be flagged"
    );
}

/// `/fs/info` rejects explicit `..` traversal components (defense-in-depth,
/// matches `/fs/read`).
#[tokio::test]
async fn info_rejects_traversal_sequence_in_path() {
    let root = TempDir::new("info-trav-root");
    let inside = root.path().join("sub");
    fs::create_dir_all(&inside).expect("mkdir inside");
    let traversal = inside.join("..").join("..").join("etc");
    let uri = format!(
        "/fs/info?path={}",
        urlencoding(&traversal.to_string_lossy())
    );
    let resp = get_request(test_state_with_root(root.path()), &uri).await;
    let body: IpcBody<FileInfoDto> = body_as_json(resp.into_body()).await;
    assert!(!body.success, "traversal must be refused");
    assert_eq!(body.code.as_deref(), Some("PATH_TRAVERSAL"));
}

/// `/fs/info` returns a stable `STAT_ERROR` for a missing path (no throw
/// past the handler).
#[tokio::test]
async fn info_returns_stat_error_for_missing_path() {
    let root = TempDir::new("info-missing-root");
    let missing = root.path().join("does-not-exist");
    let uri = format!("/fs/info?path={}", urlencoding(&missing.to_string_lossy()));
    let resp = get_request(test_state_with_root(root.path()), &uri).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<FileInfoDto> = body_as_json(resp.into_body()).await;
    assert!(!body.success, "missing path must fail");
    assert_eq!(body.code.as_deref(), Some("STAT_ERROR"));
}

/// `/fs/info` echoes the requested path verbatim (not the resolved
/// absolute path) so the client receives the same `path` it sent —
/// matching desktop `getFileInfo` and avoiding host-path leakage.
#[tokio::test]
async fn info_echoes_requested_path_not_resolved() {
    let root = TempDir::new("info-path-root");
    let file = root.path().join("note.txt");
    fs::write(&file, "hello").expect("write file");
    let requested = file.to_string_lossy().to_string();
    let uri = format!("/fs/info?path={}", urlencoding(&requested));
    let resp = get_request(test_state_with_root(root.path()), &uri).await;
    let body: IpcBody<FileInfoDto> = body_as_json(resp.into_body()).await;
    assert!(body.success);
    assert_eq!(body.data.expect("FileInfo").path, requested);
}

/// `/fs/info` applies the loopback guard (defense-in-depth for reads).
#[tokio::test]
async fn info_refused_from_non_loopback_peer() {
    let root = TempDir::new("info-loopback-root");
    let file = root.path().join("note.txt");
    fs::write(&file, "hello").expect("write file");
    let uri = format!("/fs/info?path={}", urlencoding(&file.to_string_lossy()));
    let resp = get_request_from(
        test_state_with_root(root.path()),
        &uri,
        SocketAddr::from(([10, 0, 0, 5], 54321)),
    )
    .await;
    let body: IpcBody<FileInfoDto> = body_as_json(resp.into_body()).await;
    assert!(!body.success, "non-loopback peer must be refused");
    assert_eq!(body.code.as_deref(), Some("FORBIDDEN"));
}

/// `/fs/delete` removes a file inside the project root.
#[tokio::test]
async fn delete_removes_file() {
    let root = TempDir::new("delete-root");
    let file = root.path().join("doomed.txt");
    fs::write(&file, "bye").expect("write file");
    let req_body = serde_json::json!({ "path": file.to_string_lossy() });
    let resp = post_json(test_state_with_root(root.path()), "/fs/delete", &req_body).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(body.success, "delete must succeed");
    assert!(!file.exists(), "file must be gone after delete");
}

/// `/fs/delete` removes a non-empty directory only when `recursive: true`.
#[tokio::test]
async fn delete_removes_dir_recursive() {
    let root = TempDir::new("delete-rec-root");
    let dir = root.path().join("tree");
    fs::create_dir_all(dir.join("child")).expect("mkdir tree");
    fs::write(dir.join("child").join("f.txt"), "x").expect("write child");
    let req_body = serde_json::json!({ "path": dir.to_string_lossy(), "recursive": true });
    let resp = post_json(test_state_with_root(root.path()), "/fs/delete", &req_body).await;
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(body.success, "recursive delete must succeed");
    assert!(!dir.exists(), "dir must be gone after recursive delete");
}

/// `/fs/delete` allows a path outside the project root (the jail was
/// removed; matches `mkdir`/`write`). The file is actually removed.
#[tokio::test]
async fn delete_allows_path_outside_project_root() {
    let root = TempDir::new("delete-root");
    let outside = TempDir::new("delete-outside");
    let target = outside.path().join("evil.txt");
    fs::write(&target, "pwn").expect("write outside");
    let req_body = serde_json::json!({ "path": target.to_string_lossy() });
    let resp = post_json(test_state_with_root(root.path()), "/fs/delete", &req_body).await;
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(
        body.success,
        "delete outside root should succeed: {:?}",
        body.error
    );
    assert!(!target.exists(), "file outside root must be deleted");
}

/// `/fs/delete` is loopback-guarded: a non-loopback peer is refused with
/// `FORBIDDEN` (Patch D, same as `mkdir`/`write`).
#[tokio::test]
async fn delete_rejects_non_loopback_peer() {
    let root = TempDir::new("delete-peer-root");
    let file = root.path().join("doomed.txt");
    fs::write(&file, "bye").expect("write file");
    let req_body = serde_json::json!({ "path": file.to_string_lossy() });
    let resp = post_json_from(
        test_state_with_root(root.path()),
        "/fs/delete",
        &req_body,
        SocketAddr::from(([192, 168, 1, 10], 54321)),
    )
    .await;
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(!body.success, "non-loopback delete must be refused");
    assert_eq!(body.code.as_deref(), Some("FORBIDDEN"));
    assert!(file.exists(), "refused delete must not remove the file");
}

/// `/fs/rename` moves a file inside the project root.
#[tokio::test]
async fn rename_moves_file() {
    let root = TempDir::new("rename-root");
    let from = root.path().join("a.txt");
    let to = root.path().join("b.txt");
    fs::write(&from, "payload").expect("write from");
    let req_body =
        serde_json::json!({ "from": from.to_string_lossy(), "to": to.to_string_lossy() });
    let resp = post_json(test_state_with_root(root.path()), "/fs/rename", &req_body).await;
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(body.success, "rename must succeed");
    assert!(!from.exists(), "source must be gone after rename");
    assert!(to.exists(), "destination must exist after rename");
    assert_eq!(fs::read_to_string(&to).unwrap(), "payload");
}

/// `/fs/rename` is loopback-guarded: a non-loopback peer is refused with
/// `FORBIDDEN` (same guard as `delete`/`mkdir`/`write`). The source is
/// not moved.
#[tokio::test]
async fn rename_rejects_non_loopback_peer() {
    let root = TempDir::new("rename-peer-root");
    let from = root.path().join("a.txt");
    let to = root.path().join("b.txt");
    fs::write(&from, "payload").expect("write from");
    let req_body =
        serde_json::json!({ "from": from.to_string_lossy(), "to": to.to_string_lossy() });
    let resp = post_json_from(
        test_state_with_root(root.path()),
        "/fs/rename",
        &req_body,
        SocketAddr::from(([192, 168, 1, 10], 54321)),
    )
    .await;
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(!body.success, "non-loopback rename must be refused");
    assert_eq!(body.code.as_deref(), Some("FORBIDDEN"));
    assert!(from.exists(), "refused rename must not move the source");
    assert!(
        !to.exists(),
        "refused rename must not create the destination"
    );
}

/// `/fs/rename` allows a destination outside the project root (the jail
/// was removed; matches `mkdir`/`write`). The source is actually moved.
#[tokio::test]
async fn rename_allows_destination_outside_root() {
    let root = TempDir::new("rename-root");
    let outside = TempDir::new("rename-outside");
    let from = root.path().join("a.txt");
    let to = outside.path().join("b.txt");
    fs::write(&from, "payload").expect("write from");
    let req_body =
        serde_json::json!({ "from": from.to_string_lossy(), "to": to.to_string_lossy() });
    let resp = post_json(test_state_with_root(root.path()), "/fs/rename", &req_body).await;
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(
        body.success,
        "rename to outside root should succeed: {:?}",
        body.error
    );
    assert!(!from.exists(), "source must be gone after rename");
    assert!(to.exists(), "destination must exist after rename");
    assert_eq!(fs::read_to_string(&to).unwrap(), "payload");
}

/// `/fs/copy` duplicates a file inside the project root (source kept).
#[tokio::test]
async fn copy_duplicates_file() {
    let root = TempDir::new("copy-root");
    let from = root.path().join("orig.txt");
    let to = root.path().join("dup.txt");
    fs::write(&from, "payload").expect("write from");
    let req_body =
        serde_json::json!({ "from": from.to_string_lossy(), "to": to.to_string_lossy() });
    let resp = post_json(test_state_with_root(root.path()), "/fs/copy", &req_body).await;
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(body.success, "copy must succeed");
    assert!(from.exists(), "source must remain after copy");
    assert!(to.exists(), "destination must exist after copy");
    assert_eq!(fs::read_to_string(&to).unwrap(), "payload");
}

/// `/fs/copy` is loopback-guarded: a non-loopback peer is refused with
/// `FORBIDDEN` (same guard as `delete`/`rename`). No copy is written.
#[tokio::test]
async fn copy_rejects_non_loopback_peer() {
    let root = TempDir::new("copy-peer-root");
    let from = root.path().join("orig.txt");
    let to = root.path().join("dup.txt");
    fs::write(&from, "payload").expect("write from");
    let req_body =
        serde_json::json!({ "from": from.to_string_lossy(), "to": to.to_string_lossy() });
    let resp = post_json_from(
        test_state_with_root(root.path()),
        "/fs/copy",
        &req_body,
        SocketAddr::from(([192, 168, 1, 10], 54321)),
    )
    .await;
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(!body.success, "non-loopback copy must be refused");
    assert_eq!(body.code.as_deref(), Some("FORBIDDEN"));
    assert!(from.exists(), "refused copy must not remove the source");
    assert!(!to.exists(), "refused copy must not create the destination");
}

/// `/fs/copy` allows a destination outside the project root (the jail was
/// removed; matches `mkdir`/`write`). The source is kept and the copy is
/// written outside.
#[tokio::test]
async fn copy_allows_destination_outside_root() {
    let root = TempDir::new("copy-root");
    let outside = TempDir::new("copy-outside");
    let from = root.path().join("orig.txt");
    let to = outside.path().join("dup.txt");
    fs::write(&from, "payload").expect("write from");
    let req_body =
        serde_json::json!({ "from": from.to_string_lossy(), "to": to.to_string_lossy() });
    let resp = post_json(test_state_with_root(root.path()), "/fs/copy", &req_body).await;
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(
        body.success,
        "copy to outside root should succeed: {:?}",
        body.error
    );
    assert!(from.exists(), "source must remain after copy");
    assert!(to.exists(), "destination must exist after copy");
    assert_eq!(fs::read_to_string(&to).unwrap(), "payload");
}

/// `/fs/delete` rejects explicit `..` components with `PATH_TRAVERSAL`
/// (defense-in-depth — matches `mkdir`).
#[tokio::test]
async fn delete_rejects_traversal_sequence_in_path() {
    let root = TempDir::new("delete-trav-root");
    let inside = root.path().join("sub");
    fs::create_dir_all(&inside).expect("mkdir inside");
    let traversal = inside.join("..").join("..").join("etc");
    let req_body = serde_json::json!({ "path": traversal.to_string_lossy() });
    let resp = post_json(test_state_with_root(root.path()), "/fs/delete", &req_body).await;
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(!body.success, "traversal delete must be refused");
    assert_eq!(body.code.as_deref(), Some("PATH_TRAVERSAL"));
}

/// `/fs/rename` rejects explicit `..` components in either endpoint with
/// `PATH_TRAVERSAL` (defense-in-depth — matches `mkdir`).
#[tokio::test]
async fn rename_rejects_traversal_sequence_in_path() {
    let root = TempDir::new("rename-trav-root");
    let inside = root.path().join("sub");
    fs::create_dir_all(&inside).expect("mkdir inside");
    let traversal_from = inside.join("..").join("..").join("etc");
    let req_body = serde_json::json!({
        "from": traversal_from.to_string_lossy(),
        "to": root.path().join("x.txt").to_string_lossy()
    });
    let resp = post_json(test_state_with_root(root.path()), "/fs/rename", &req_body).await;
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(!body.success, "traversal rename must be refused");
    assert_eq!(body.code.as_deref(), Some("PATH_TRAVERSAL"));
}

/// `/fs/copy` rejects explicit `..` components with `PATH_TRAVERSAL`
/// (defense-in-depth — matches `mkdir`).
#[tokio::test]
async fn copy_rejects_traversal_sequence_in_path() {
    let root = TempDir::new("copy-trav-root");
    let inside = root.path().join("sub");
    fs::create_dir_all(&inside).expect("mkdir inside");
    let traversal_from = inside.join("..").join("..").join("etc");
    let req_body = serde_json::json!({
        "from": traversal_from.to_string_lossy(),
        "to": root.path().join("x.txt").to_string_lossy()
    });
    let resp = post_json(test_state_with_root(root.path()), "/fs/copy", &req_body).await;
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(!body.success, "traversal copy must be refused");
    assert_eq!(body.code.as_deref(), Some("PATH_TRAVERSAL"));
}

/// Boundary-relationship test (ADR-007): the `/fs/*` browse/read surface
/// is intentionally broader than the `/git/*` and `/skills` operation
/// surface. `/fs/ls` accepts a path outside `project_root` (intentional
/// breadth — desktop parity, directory picker, editor reads), while
/// `/git/status` and `/skills` reject the same outside path with
/// `OUTSIDE_PROJECT_ROOT` (server-side operations confined to
/// `project_root` via `ensure_within_project_boundary`).
#[tokio::test]
async fn fs_containment_boundary_relationship() {
    let root = TempDir::new("boundary-root");
    let inside = root.path().join("inside");
    fs::create_dir_all(&inside).expect("mkdir inside");
    fs::write(inside.join("marker.txt"), "x").expect("write inside marker");
    let outside = TempDir::new("boundary-outside");
    fs::write(outside.path().join("marker.txt"), "x").expect("write marker");
    let state = test_state_with_root(root.path());

    // --- WITHIN project_root: all routes accept (no OUTSIDE_PROJECT_ROOT) ---

    // `/fs/ls` within project_root SUCCEEDS.
    let ls_uri = format!("/fs/ls?path={}", urlencoding(&inside.to_string_lossy()));
    let resp = get_request(state.clone(), &ls_uri).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<Vec<DirectoryEntryDto>> = body_as_json(resp.into_body()).await;
    assert!(
        body.success,
        "/fs/ls inside project_root must succeed: {:?}",
        body.error
    );
    let entries = body.data.expect("entries");
    assert!(
        entries.iter().any(|e| e.name == "marker.txt"),
        "inside-root entry must be listed: {entries:?}"
    );

    // `/git/status` within project_root is NOT rejected with
    // OUTSIDE_PROJECT_ROOT (it may fail with a git error if the dir is
    // not a repo, but the boundary check must pass).
    let resp = post_json(
        state.clone(),
        "/git/status",
        &serde_json::json!({ "cwd": inside.to_string_lossy() }),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<serde_json::Value> = body_as_json(resp.into_body()).await;
    assert_ne!(
        body.code.as_deref(),
        Some("OUTSIDE_PROJECT_ROOT"),
        "/git/status inside project_root must not be rejected with OUTSIDE_PROJECT_ROOT"
    );

    // `/skills` within project_root is NOT rejected with
    // OUTSIDE_PROJECT_ROOT.
    let skills_uri = format!(
        "/skills?projectRoot={}",
        urlencoding(&inside.to_string_lossy())
    );
    let resp = get_request(state.clone(), &skills_uri).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<serde_json::Value> = body_as_json(resp.into_body()).await;
    assert_ne!(
        body.code.as_deref(),
        Some("OUTSIDE_PROJECT_ROOT"),
        "/skills inside project_root must not be rejected with OUTSIDE_PROJECT_ROOT"
    );

    // --- OUTSIDE project_root: /fs accepts (intentional breadth),
    //     operations reject (OUTSIDE_PROJECT_ROOT) ---
    let ls_uri = format!(
        "/fs/ls?path={}",
        urlencoding(&outside.path().to_string_lossy())
    );
    let resp = get_request(state.clone(), &ls_uri).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<Vec<DirectoryEntryDto>> = body_as_json(resp.into_body()).await;
    assert!(
        body.success,
        "/fs/ls outside project_root must succeed (ADR-007 breadth): {:?}",
        body.error
    );
    let entries = body.data.expect("entries");
    assert!(
        entries.iter().any(|e| e.name == "marker.txt"),
        "outside-root entry must be listed: {entries:?}"
    );

    // `POST /git/status { cwd: <outside> }` REJECTS with
    // `OUTSIDE_PROJECT_ROOT` — operations stay confined to project_root.
    let resp = post_json(
        state.clone(),
        "/git/status",
        &serde_json::json!({ "cwd": outside.path().to_string_lossy() }),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(
        !body.success,
        "/git/status outside project_root must be rejected"
    );
    assert_eq!(body.code.as_deref(), Some("OUTSIDE_PROJECT_ROOT"));

    // `GET /skills?projectRoot=<outside>` REJECTS with
    // `OUTSIDE_PROJECT_ROOT` — skills stay confined to project_root.
    let skills_uri = format!(
        "/skills?projectRoot={}",
        urlencoding(&outside.path().to_string_lossy())
    );
    let resp = get_request(state, &skills_uri).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(
        !body.success,
        "/skills outside project_root must be rejected"
    );
    assert_eq!(body.code.as_deref(), Some("OUTSIDE_PROJECT_ROOT"));
}

/// CAP-2: a web client that switched to a non-default registered project
/// (per-connection `switch_project`) can still run git/skills operations.
/// The containment boundary follows ANY registered project root, not just
/// the host default. An unregistered path is still rejected.
#[tokio::test]
async fn operations_accept_registered_non_default_project() {
    let root = TempDir::new("registered-default");
    let registered = TempDir::new("registered-other");
    let outside = TempDir::new("registered-unregistered");
    fs::write(registered.path().join("marker.txt"), "x").expect("write marker");
    fs::write(outside.path().join("marker.txt"), "x").expect("write marker");
    let state = test_state_with_root(root.path());

    // Seed the registry with two projects: `root` (default) and
    // `registered` (non-default, outside `root`). The `set` call's
    // `rebind_project_root` is a no-op here (no handle registered in
    // test state), so `project_root` stays as `root`.
    state.registry.set(
        vec![
            ProjectSummary {
                id: "default".to_string(),
                name: "Default".to_string(),
                color: "blue".to_string(),
                path: Some(root.path().to_string_lossy().into_owned()),
                is_archived: false,
                is_default: true,
            },
            ProjectSummary {
                id: "registered".to_string(),
                name: "Registered".to_string(),
                color: "green".to_string(),
                path: Some(registered.path().to_string_lossy().into_owned()),
                is_archived: false,
                is_default: false,
            },
        ],
        Some("default".to_string()),
    );

    // `/git/status` on the registered (non-default) project is NOT
    // rejected — it's a registered project root.
    let resp = post_json(
        state.clone(),
        "/git/status",
        &serde_json::json!({ "cwd": registered.path().to_string_lossy() }),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<serde_json::Value> = body_as_json(resp.into_body()).await;
    assert_ne!(
        body.code.as_deref(),
        Some("OUTSIDE_PROJECT_ROOT"),
        "/git/status on registered non-default project must not be rejected"
    );

    // `/skills` on the registered (non-default) project is NOT rejected.
    let skills_uri = format!(
        "/skills?projectRoot={}",
        urlencoding(&registered.path().to_string_lossy())
    );
    let resp = get_request(state.clone(), &skills_uri).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<serde_json::Value> = body_as_json(resp.into_body()).await;
    assert_ne!(
        body.code.as_deref(),
        Some("OUTSIDE_PROJECT_ROOT"),
        "/skills on registered non-default project must not be rejected"
    );

    // An unregistered path (outside both root and registered) is still
    // rejected — the boundary only follows registered projects.
    let resp = post_json(
        state.clone(),
        "/git/status",
        &serde_json::json!({ "cwd": outside.path().to_string_lossy() }),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(
        !body.success,
        "/git/status on unregistered path must be rejected"
    );
    assert_eq!(body.code.as_deref(), Some("OUTSIDE_PROJECT_ROOT"));

    // `/fs/ls` on the registered (non-default) project also succeeds —
    // intentional breadth (always accepted, registered or not).
    let ls_uri = format!(
        "/fs/ls?path={}",
        urlencoding(&registered.path().to_string_lossy())
    );
    let resp = get_request(state, &ls_uri).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<Vec<DirectoryEntryDto>> = body_as_json(resp.into_body()).await;
    assert!(body.success, "/fs/ls on registered project must succeed");
}
