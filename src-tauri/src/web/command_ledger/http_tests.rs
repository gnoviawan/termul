//! Fault tests of the domain carriers: HTTP routes driven through axum with
//! `X-Command-Id`, a lost reply is simulated by sending the same request
//! again. Real files and real git repositories, no mocks.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{HeaderMap, Request, StatusCode};
use axum::routing::{get, post};
use axum::Router;
use serde_json::{json, Value};
use tower::ServiceExt;

use super::test_clock::{fresh_command_id, ManualClock};
use super::*;
use crate::acp::AcpManager;
use crate::web::fs_api::{self, IpcBody};
use crate::web::sink::WsRelaySink;
use crate::web::ws::AppState;
use crate::web::{git_api, test_pty_manager, worktree_api};

const RETENTION: Duration = Duration::from_secs(600);
const LOOPBACK: ([u8; 4], u16) = ([127, 0, 0, 1], 54321);

struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("termul-http-ledger-{label}-{nanos}"));
        std::fs::create_dir_all(&path).expect("temp dir");
        Self(path.canonicalize().expect("canonical temp dir"))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A host state over `root` with its own ledger (the "host"): build a second
/// one over the same files to model a restart.
fn host_with(root: &Path, relay: WsRelaySink) -> AppState {
    let pty = test_pty_manager();
    AppState {
        acp: Arc::new(AcpManager::new(vec![])),
        terminal_events: pty.terminal_events(),
        cwd_tracker: pty.cwd_tracker(),
        git_tracker: pty.git_tracker(),
        exit_code_tracker: pty.exit_code_tracker(),
        pty,
        relay: Arc::new(relay),
        registry: crate::web::project_registry::ProjectRegistry::seeded_for_test(root),
        history_mode: crate::web::ws::HistoryMode::LiveOnly,
        pending_oauth_flows: Arc::new(parking_lot::RwLock::new(Default::default())),
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

fn host(root: &Path) -> AppState {
    host_with(root, WsRelaySink::new())
}

/// A host whose ledger clock the test drives: advancing it past the retention
/// evicts outcomes to bare ids (a resend then finds `Unknown`).
fn evictable_host(root: &Path) -> (AppState, Arc<ManualClock>) {
    let clock = Arc::new(ManualClock::default());
    let ledger = CommandLedger::with_clock(RETENTION, clock.clone());
    (host_with(root, WsRelaySink::new().with_ledger(ledger)), clock)
}

fn evict(clock: &ManualClock) {
    clock.advance(RETENTION + Duration::from_secs(1));
}

fn app(state: AppState) -> Router {
    Router::new()
        .route("/fs/write", post(fs_api::write))
        .route("/fs/read", get(fs_api::read))
        .route("/fs/rename", post(fs_api::rename))
        .route("/fs/copy", post(fs_api::copy))
        .route("/fs/delete", post(fs_api::delete))
        .route("/git/commit", post(git_api::commit))
        .route("/git/stash-save", post(git_api::stash_save))
        .route("/git/create-branch", post(git_api::create_branch))
        .route("/git/discard", post(git_api::discard))
        .route("/git/stash-apply", post(git_api::stash_apply))
        .route("/git/stash-pop", post(git_api::stash_pop))
        .route("/git/stash-drop", post(git_api::stash_drop))
        .route("/git/stage-hunk", post(crate::web::git_hunk_api::stage_hunk))
        .route("/git/unstage-hunk", post(crate::web::git_hunk_api::unstage_hunk))
        .route(
            "/worktree/rename-branch",
            post(crate::web::worktree_rename_api::rename_branch),
        )
        .route("/acp/install", post(crate::web::install_api::install))
        .route("/worktree/create", post(worktree_api::create))
        .route("/worktree/remove", post(worktree_api::remove))
        .with_state(state)
}

struct Reply {
    status: StatusCode,
    content_type: String,
    text: String,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_str(&self.text)
            .unwrap_or_else(|e| panic!("not a JSON body ({e}): {}", self.text))
    }

    /// The `{"type":"result"}` frame of an NDJSON reply.
    fn result_frame(&self) -> Value {
        self.text
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .find(|frame| frame["type"] == "result")
            .unwrap_or_else(|| panic!("no result frame in: {}", self.text))["result"]
            .clone()
    }
}

/// Send a request. A write without an explicit `id` is stamped with a fresh one
/// (a ledgered route refuses a bare request); [`send_unstamped`] sends none.
async fn send(app: &Router, method: &str, uri: &str, body: Value, id: Option<&str>) -> Reply {
    let minted;
    let id = match id {
        Some(id) => Some(id),
        None if method != "GET" => {
            minted = fresh_command_id();
            Some(minted.as_str())
        }
        None => None,
    };
    send_from(app, method, uri, body, id, SocketAddr::from(LOOPBACK)).await
}

/// Send a request with no `X-Command-Id` header at all.
async fn send_unstamped(app: &Router, method: &str, uri: &str, body: Value) -> Reply {
    send_from(app, method, uri, body, None, SocketAddr::from(LOOPBACK)).await
}

async fn send_from(
    app: &Router,
    method: &str,
    uri: &str,
    body: Value,
    id: Option<&str>,
    peer: SocketAddr,
) -> Reply {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .extension(ConnectInfo(peer));
    if let Some(id) = id {
        request = request.header("x-command-id", id);
    }
    let response = app
        .clone()
        .oneshot(
            request
                .body(if method == "GET" {
                    Body::empty()
                } else {
                    Body::from(serde_json::to_vec(&body).expect("body"))
                })
                .expect("request"),
        )
        .await
        .expect("response");
    let status = response.status();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    Reply {
        status,
        content_type,
        text: String::from_utf8_lossy(&bytes).into_owned(),
    }
}

fn path_str(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn git(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .expect("git runs");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

/// A repository with one commit (`a.txt`) and a configured identity.
fn repo(dir: &TempDir) -> PathBuf {
    let root = dir.path().join("repo");
    std::fs::create_dir_all(&root).expect("repo dir");
    git(&root, &["init", "-q", "-b", "main"]);
    git(&root, &["config", "user.email", "t@example.test"]);
    git(&root, &["config", "user.name", "Test"]);
    git(&root, &["config", "commit.gpgsign", "false"]);
    std::fs::write(root.join("a.txt"), "one\n").expect("seed");
    git(&root, &["add", "a.txt"]);
    git(&root, &["commit", "-q", "-m", "seed"]);
    root
}

fn commit_count(repo: &Path) -> usize {
    git(repo, &["rev-list", "--count", "HEAD"]).parse().expect("count")
}

fn ok(reply: &Reply) -> bool {
    reply.json()["success"] == true
}

fn code(reply: &Reply) -> String {
    reply.json()["code"].as_str().unwrap_or_default().to_string()
}

#[tokio::test]
async fn a_lost_reply_to_a_rename_is_answered_with_the_original_outcome() {
    let dir = TempDir::new("rename");
    let (from, to) = (dir.path().join("a.txt"), dir.path().join("b.txt"));
    std::fs::write(&from, "x").unwrap();
    let app = app(host(dir.path()));
    let body = json!({ "from": path_str(&from), "to": path_str(&to) });

    let first = send(&app, "POST", "/fs/rename", body.clone(), Some("rename-1")).await;
    assert!(ok(&first), "{}", first.text);
    // The reply is lost; the client resends. The source is gone, so running
    // it again would fail: the ledger answers the first outcome instead.
    let resend = send(&app, "POST", "/fs/rename", body.clone(), Some("rename-1")).await;
    assert!(ok(&resend), "{}", resend.text);
    assert_eq!(resend.status, StatusCode::OK);
    assert!(to.exists() && !from.exists());

    // A ledgered route refuses a request without a commandId, before it runs.
    let bare = send_unstamped(&app, "POST", "/fs/rename", body).await;
    assert_eq!(code(&bare), "INVALID_COMMAND_ID");
}

#[tokio::test]
async fn a_rejection_replays_its_original_code_and_a_different_request_conflicts() {
    let dir = TempDir::new("conflict");
    let missing = dir.path().join("nope.txt");
    let app = app(host(dir.path()));
    let body = json!({ "from": path_str(&missing), "to": path_str(&dir.path().join("c.txt")) });

    let first = send(&app, "POST", "/fs/rename", body.clone(), Some("c-1")).await;
    assert_eq!(code(&first), "RENAME_ERROR");
    // Even after the missing source appears, the recorded rejection is replayed.
    std::fs::write(&missing, "x").unwrap();
    let resend = send(&app, "POST", "/fs/rename", body, Some("c-1")).await;
    assert_eq!(code(&resend), "RENAME_ERROR");
    assert!(missing.exists(), "a replayed rejection must not execute");

    let other = json!({ "from": path_str(&missing), "to": path_str(&dir.path().join("d.txt")) });
    let conflict = send(&app, "POST", "/fs/rename", other, Some("c-1")).await;
    assert_eq!(code(&conflict), "COMMAND_CONFLICT");
    assert!(missing.exists());
}

#[tokio::test]
async fn a_malformed_command_id_is_refused_before_anything_runs() {
    let dir = TempDir::new("badid");
    let (from, to) = (dir.path().join("a.txt"), dir.path().join("b.txt"));
    std::fs::write(&from, "x").unwrap();
    let state = host(dir.path());
    let ledger = Arc::clone(state.relay.ledger());
    let app = app(state);
    let body = json!({ "from": path_str(&from), "to": path_str(&to) });

    for bad in ["has space", &"x".repeat(129), "semi;colon"] {
        let reply = send(&app, "POST", "/fs/rename", body.clone(), Some(bad)).await;
        assert_eq!(code(&reply), "INVALID_COMMAND_ID", "{bad}");
    }
    assert!(from.exists() && !to.exists());
    assert_eq!(ledger.counts(), (0, 0, 0));
}

#[tokio::test]
async fn a_refused_write_leaves_no_ledger_entry() {
    let dir = TempDir::new("guard");
    let (from, to) = (dir.path().join("a.txt"), dir.path().join("b.txt"));
    std::fs::write(&from, "x").unwrap();
    let state = host(dir.path());
    let ledger = Arc::clone(state.relay.ledger());
    let app = app(state);
    let body = json!({ "from": path_str(&from), "to": path_str(&to) });
    let lan = SocketAddr::from(([192, 168, 1, 9], 4000));

    let refused = send_from(&app, "POST", "/fs/rename", body.clone(), Some("g-1"), lan).await;
    assert_eq!(code(&refused), "FORBIDDEN");
    assert_eq!(ledger.counts(), (0, 0, 0), "a guard refusal must not be recorded");
    // The same id from an allowed peer still executes.
    let allowed = send(&app, "POST", "/fs/rename", body, Some("g-1")).await;
    assert!(ok(&allowed));
    assert!(to.exists());
}

#[tokio::test]
async fn concurrent_requests_with_one_id_execute_once() {
    let dir = TempDir::new("race");
    let (from, to) = (dir.path().join("a.txt"), dir.path().join("b.txt"));
    std::fs::write(&from, "x").unwrap();
    let app = app(host(dir.path()));
    let body = json!({ "from": path_str(&from), "to": path_str(&to) });

    let (a, b) = tokio::join!(
        send(&app, "POST", "/fs/rename", body.clone(), Some("race-1")),
        send(&app, "POST", "/fs/rename", body.clone(), Some("race-1")),
    );
    // One ran, the other waited for it: both see success, not a ENOENT.
    assert!(ok(&a), "{}", a.text);
    assert!(ok(&b), "{}", b.text);
    assert!(to.exists() && !from.exists());
}

#[tokio::test]
async fn a_resend_after_eviction_of_a_non_create_is_outcome_unknown_and_not_run() {
    let dir = TempDir::new("evict");
    let (from, to) = (dir.path().join("a.txt"), dir.path().join("b.txt"));
    std::fs::write(&from, "x").unwrap();
    let clock = Arc::new(ManualClock::default());
    let ledger = CommandLedger::with_clock(RETENTION, clock.clone());
    let app = app(host_with(dir.path(), WsRelaySink::new().with_ledger(ledger)));
    let body = json!({ "from": path_str(&from), "to": path_str(&to) });

    assert!(ok(&send(&app, "POST", "/fs/copy", body.clone(), Some("ev-1")).await));
    std::fs::remove_file(&to).unwrap();
    clock.advance(RETENTION + Duration::from_secs(1));

    let resend = send(&app, "POST", "/fs/copy", body, Some("ev-1")).await;
    assert_eq!(code(&resend), "OUTCOME_UNKNOWN");
    assert!(!to.exists(), "an evicted non-create command is never re-executed");
}

#[tokio::test]
async fn a_resend_while_the_first_run_is_going_answers_an_in_progress_receipt() {
    let ledger = Arc::new(
        CommandLedger::new(RETENTION).with_in_flight_wait(Duration::from_millis(40)),
    );
    let mut headers = HeaderMap::new();
    headers.insert(COMMAND_ID_HEADER, "slow-1".parse().unwrap());
    let started = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let first = {
        let (ledger, headers) = (Arc::clone(&ledger), headers.clone());
        let (started, release) = (Arc::clone(&started), Arc::clone(&release));
        tokio::spawn(async move {
            run_http(
                &ledger,
                &headers,
                "fs_write",
                fingerprint_of("fs_write", &[("path", "/p")]),
                no_entity(),
                async move {
                    started.notify_one();
                    release.notified().await;
                    IpcBody::<()>::ok(())
                },
            )
            .await
        })
    };
    started.notified().await;

    let resend: IpcBody<()> = run_http(
        &ledger,
        &headers,
        "fs_write",
        fingerprint_of("fs_write", &[("path", "/p")]),
        no_entity(),
        async { panic!("a resend must not execute") },
    )
    .await;
    assert!(resend.success);
    assert_eq!(resend.receipt.as_deref(), Some("in_progress"));
    assert!(resend.data.is_none());

    release.notify_one();
    assert!(first.await.unwrap().success);
    // Settled now: the resend gets the original outcome.
    let after: IpcBody<()> = run_http(
        &ledger,
        &headers,
        "fs_write",
        fingerprint_of("fs_write", &[("path", "/p")]),
        no_entity(),
        async { panic!("a resend must not execute") },
    )
    .await;
    assert!(after.success && after.receipt.is_none());
}

#[tokio::test]
async fn a_stale_expected_hash_refuses_the_write_and_changes_nothing() {
    let dir = TempDir::new("expected");
    let file = dir.path().join("note.txt");
    std::fs::write(&file, "v1").unwrap();
    let app = app(host(dir.path()));
    let uri = format!("/fs/read?path={}", path_str(&file));

    let read = send(&app, "GET", &uri, Value::Null, None).await;
    let hash = read.json()["data"]["contentHash"].as_str().unwrap().to_string();
    assert_eq!(hash.len(), 64);

    // Someone else edits the file after our read.
    std::fs::write(&file, "v1-edited-elsewhere").unwrap();
    let stale = send(
        &app,
        "POST",
        "/fs/write",
        json!({ "path": path_str(&file), "content": "mine", "expected": { "sha256": hash } }),
        None,
    )
    .await;
    assert_eq!(code(&stale), "PRECONDITION_FAILED");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "v1-edited-elsewhere");

    // A write that names the current hash lands and leaves no temp file.
    let current = send(&app, "GET", &uri, Value::Null, None).await.json()["data"]
        ["contentHash"]
        .as_str()
        .unwrap()
        .to_string();
    let fresh = send(
        &app,
        "POST",
        "/fs/write",
        json!({ "path": path_str(&file), "content": "mine", "expected": { "sha256": current } }),
        None,
    )
    .await;
    assert!(ok(&fresh), "{}", fresh.text);
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "mine");
    let leftovers: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

#[tokio::test]
async fn expected_absent_only_creates_a_new_file() {
    let dir = TempDir::new("absent");
    let file = dir.path().join("new.txt");
    let app = app(host(dir.path()));
    let create = json!({ "path": path_str(&file), "content": "first", "expected": "absent" });

    assert!(ok(&send(&app, "POST", "/fs/write", create.clone(), None).await));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "first");
    // A different write over the now-existing file is stale.
    let again = send(
        &app,
        "POST",
        "/fs/write",
        json!({ "path": path_str(&file), "content": "second", "expected": "absent" }),
        None,
    )
    .await;
    assert_eq!(code(&again), "PRECONDITION_FAILED");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "first");
}

#[tokio::test]
async fn a_resend_of_an_applied_write_answers_ok_even_after_the_ledger_is_gone() {
    let dir = TempDir::new("applied");
    let file = dir.path().join("note.txt");
    std::fs::write(&file, "v1").unwrap();
    let hash = {
        let app = app(host(dir.path()));
        let uri = format!("/fs/read?path={}", path_str(&file));
        send(&app, "GET", &uri, Value::Null, None).await.json()["data"]["contentHash"]
            .as_str()
            .unwrap()
            .to_string()
    };
    let write = json!({ "path": path_str(&file), "content": "v2", "expected": { "sha256": hash } });

    let before_restart = app(host(dir.path()));
    assert!(ok(&send(&before_restart, "POST", "/fs/write", write.clone(), Some("w-1")).await));
    // Same host: the ledger replays the original outcome.
    assert!(ok(&send(&before_restart, "POST", "/fs/write", write.clone(), Some("w-1")).await));

    // The host restarted (empty ledger): `expected` no longer matches, but the
    // file already holds the content this command wrote.
    let after_restart = app(host(dir.path()));
    let resend = send(&after_restart, "POST", "/fs/write", write.clone(), Some("w-1")).await;
    assert!(ok(&resend), "{}", resend.text);
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "v2");

    // A different writer's content is still refused for the same stale hash.
    std::fs::write(&file, "v3-other").unwrap();
    let other = send(&after_restart, "POST", "/fs/write", write, Some("w-2")).await;
    assert_eq!(code(&other), "PRECONDITION_FAILED");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "v3-other");
}

#[tokio::test]
async fn a_replayed_write_never_writes_a_second_body_and_the_ledger_holds_no_content() {
    let dir = TempDir::new("content");
    let file = dir.path().join("secret.txt");
    let state = host(dir.path());
    let ledger = Arc::clone(state.relay.ledger());
    let app = app(state);

    let first = send(
        &app,
        "POST",
        "/fs/write",
        json!({ "path": path_str(&file), "content": "TOP-SECRET-ONE" }),
        Some("sec-1"),
    )
    .await;
    assert!(ok(&first));
    // Content is not part of the request's identity: same command, replayed.
    let resend = send(
        &app,
        "POST",
        "/fs/write",
        json!({ "path": path_str(&file), "content": "TOP-SECRET-TWO" }),
        Some("sec-1"),
    )
    .await;
    assert!(ok(&resend));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "TOP-SECRET-ONE");
    assert!(!resend.text.contains("TOP-SECRET"), "{}", resend.text);
    assert_eq!(ledger.counts(), (0, 1, 0));
}

#[tokio::test]
async fn deleting_an_absent_path_is_ok_with_or_without_a_command_id() {
    let dir = TempDir::new("delete");
    let file = dir.path().join("a.txt");
    std::fs::write(&file, "x").unwrap();
    let app = app(host(dir.path()));
    let body = json!({ "path": path_str(&file) });

    assert!(ok(&send(&app, "POST", "/fs/delete", body.clone(), Some("del-1")).await));
    assert!(ok(&send(&app, "POST", "/fs/delete", body.clone(), Some("del-2")).await));
    // Deleting nothing is the outcome asked for (AD-5), for a first run too.
    assert!(ok(&send(&app, "POST", "/fs/delete", body, None).await));
}

#[tokio::test]
async fn a_commit_resend_never_commits_twice_and_a_stale_head_commits_nothing() {
    let dir = TempDir::new("commit");
    let repo = repo(&dir);
    let head0 = git(&repo, &["rev-parse", "HEAD"]);
    std::fs::write(repo.join("a.txt"), "two\n").unwrap();
    git(&repo, &["add", "a.txt"]);
    let cwd = path_str(&repo);
    let commit = json!({ "cwd": cwd, "summary": "second", "expectedHead": head0 });

    let host_one = app(host(&repo));
    let first = send(&host_one, "POST", "/git/commit", commit.clone(), Some("commit-1")).await;
    assert!(ok(&first), "{}", first.text);
    assert_eq!(commit_count(&repo), 2);
    let resend = send(&host_one, "POST", "/git/commit", commit.clone(), Some("commit-1")).await;
    assert!(ok(&resend), "{}", resend.text);
    assert_eq!(commit_count(&repo), 2, "the resend must not commit again");
    assert!(git(&repo, &["log", "-1", "--format=%B"]).contains("Termul-Command-Id: commit-1"));

    // Host restart: nothing is staged any more (a second commit would fail),
    // and `expectedHead` is behind. The trailer finds the commit already made.
    let host_two = app(host(&repo));
    let after_restart = send(&host_two, "POST", "/git/commit", commit.clone(), Some("commit-1")).await;
    assert!(ok(&after_restart), "{}", after_restart.text);
    assert_eq!(commit_count(&repo), 2);

    // A different command on a stale head is refused and changes nothing.
    std::fs::write(repo.join("a.txt"), "three\n").unwrap();
    git(&repo, &["add", "a.txt"]);
    let stale = send(&host_two, "POST", "/git/commit", commit, Some("commit-2")).await;
    assert_eq!(code(&stale), "PRECONDITION_FAILED");
    assert_eq!(commit_count(&repo), 2);
    assert_eq!(git(&repo, &["diff", "--cached", "--name-only"]), "a.txt");

    // The current head commits.
    let head1 = git(&repo, &["rev-parse", "HEAD"]);
    let fresh = json!({ "cwd": path_str(&repo), "summary": "third", "expectedHead": head1 });
    assert!(ok(&send(&host_two, "POST", "/git/commit", fresh, Some("commit-3")).await));
    assert_eq!(commit_count(&repo), 3);
}

#[tokio::test]
async fn an_empty_expected_head_means_an_unborn_branch() {
    let dir = TempDir::new("unborn");
    let root = dir.path().join("fresh");
    std::fs::create_dir_all(&root).unwrap();
    git(&root, &["init", "-q", "-b", "main"]);
    git(&root, &["config", "user.email", "t@example.test"]);
    git(&root, &["config", "user.name", "Test"]);
    std::fs::write(root.join("a.txt"), "x\n").unwrap();
    git(&root, &["add", "a.txt"]);
    let app = app(host(&root));
    let commit = |head: &str| json!({ "cwd": path_str(&root), "summary": "init", "expectedHead": head });

    let wrong = send(&app, "POST", "/git/commit", commit(&"d".repeat(40)), Some("u-1")).await;
    assert_eq!(code(&wrong), "PRECONDITION_FAILED");
    let right = send(&app, "POST", "/git/commit", commit(""), Some("u-2")).await;
    assert!(ok(&right), "{}", right.text);
    assert_eq!(commit_count(&root), 1);
}

#[tokio::test]
async fn a_stash_save_resend_does_not_stash_again() {
    let dir = TempDir::new("stash");
    let repo = repo(&dir);
    std::fs::write(repo.join("a.txt"), "dirty\n").unwrap();
    let app = app(host(&repo));
    let body = json!({ "cwd": path_str(&repo) });

    assert!(ok(&send(&app, "POST", "/git/stash-save", body.clone(), Some("stash-1")).await));
    assert_eq!(git(&repo, &["stash", "list"]).lines().count(), 1);
    // Someone dirties the tree again; a re-executed save would stash a second entry.
    std::fs::write(repo.join("a.txt"), "dirty again\n").unwrap();
    assert!(ok(&send(&app, "POST", "/git/stash-save", body, Some("stash-1")).await));
    assert_eq!(git(&repo, &["stash", "list"]).lines().count(), 1);
    assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "dirty again\n");
}

#[tokio::test]
async fn a_create_branch_for_an_existing_branch_with_a_fresh_id_keeps_its_real_error() {
    let dir = TempDir::new("branch-fresh");
    let repo = repo(&dir);
    git(&repo, &["branch", "feature/x"]);
    let body = json!({ "cwd": path_str(&repo), "branch": "feature/x" });
    let state = host(&repo);
    let ledger = Arc::clone(state.relay.ledger());

    // Existence is not proof THIS command created it: the error stands, and the
    // ledger records the rejection, never a success.
    let reply = send(&app(state), "POST", "/git/create-branch", body, Some("br-fresh")).await;
    assert_eq!(code(&reply), "GIT_CREATE_BRANCH_ERROR", "{}", reply.text);
    assert_eq!(git(&repo, &["branch", "--show-current"]), "main", "no checkout happened");
    assert_eq!(ledger.counts(), (0, 1, 0));
}

#[tokio::test]
async fn a_create_branch_resend_after_eviction_is_outcome_unknown_not_found_by_existence() {
    let dir = TempDir::new("branch");
    let repo = repo(&dir);
    let body = json!({ "cwd": path_str(&repo), "branch": "feature/x" });
    let (state, clock) = evictable_host(&repo);
    let app = app(state);

    assert!(ok(&send(&app, "POST", "/git/create-branch", body.clone(), Some("br-1")).await));
    evict(&clock);
    // A branch cannot carry a command stamp: existence proves nothing about
    // THIS command, so the evicted resend is unknown, not "found".
    let resend = send(&app, "POST", "/git/create-branch", body.clone(), Some("br-1")).await;
    assert_eq!(code(&resend), "OUTCOME_UNKNOWN", "{}", resend.text);

    // An id the ledger never saw runs and gets the real error.
    let other = send(&app, "POST", "/git/create-branch", body, Some("br-2")).await;
    assert_eq!(code(&other), "GIT_CREATE_BRANCH_ERROR");
}

#[tokio::test]
async fn a_worktree_create_resend_replays_and_never_finds_a_worktree_by_existence() {
    let dir = TempDir::new("worktree");
    let repo = repo(&dir);
    let body = json!({
        "projectPath": path_str(&repo),
        "name": "wt1",
        "branch": "chat/one",
        "isNewBranch": true,
    });

    let (state, clock) = evictable_host(&repo);
    let host_one = app(state);
    let first = send(&host_one, "POST", "/worktree/create", body.clone(), Some("wt-1")).await;
    assert!(ok(&first), "{}", first.text);
    let entry = first.json()["data"].clone();
    assert_eq!(entry["branch"], "chat/one");

    // Lost reply, same host: the recorded outcome.
    let resend = send(&host_one, "POST", "/worktree/create", body.clone(), Some("wt-1")).await;
    assert_eq!(resend.json()["data"], entry);

    // Outcome evicted: a worktree cannot carry a command stamp, so the resend
    // is unknown and not run (never "found by existence").
    evict(&clock);
    let after_eviction = send(&host_one, "POST", "/worktree/create", body.clone(), Some("wt-1")).await;
    assert_eq!(code(&after_eviction), "OUTCOME_UNKNOWN", "{}", after_eviction.text);

    // The same id with a changed request (here the start ref) is a conflict.
    let changed = json!({
        "projectPath": path_str(&repo),
        "name": "wt1",
        "branch": "chat/one",
        "isNewBranch": true,
        "startRef": "main",
    });
    let conflict = send(&host_one, "POST", "/worktree/create", changed, Some("wt-1")).await;
    assert_eq!(code(&conflict), "COMMAND_CONFLICT");
    let flipped = json!({
        "projectPath": path_str(&repo),
        "name": "wt1",
        "branch": "chat/one",
        "isNewBranch": false,
    });
    let conflict = send(&host_one, "POST", "/worktree/create", flipped, Some("wt-1")).await;
    assert_eq!(code(&conflict), "COMMAND_CONFLICT");

    // A NEW id for the same branch is a real conflict, not a resend: the
    // original refusal stands.
    let fresh_id = send(&host_one, "POST", "/worktree/create", body.clone(), Some("wt-2")).await;
    assert_eq!(code(&fresh_id), "BRANCH_ALREADY_HAS_WORKTREE");
    let bare = send_unstamped(&host_one, "POST", "/worktree/create", body).await;
    assert_eq!(code(&bare), "INVALID_COMMAND_ID");
}

#[tokio::test]
async fn a_streamed_worktree_create_replays_as_a_plain_ipc_body() {
    let dir = TempDir::new("ndjson");
    let repo = repo(&dir);
    let body = json!({
        "projectPath": path_str(&repo),
        "name": "wt2",
        "branch": "chat/two",
        "isNewBranch": true,
        "streamProgress": true,
        "progressId": "p1",
    });
    let app = app(host(&repo));

    let first = send(&app, "POST", "/worktree/create", body.clone(), Some("wt-s1")).await;
    assert!(first.content_type.contains("application/x-ndjson"), "{}", first.content_type);
    assert!(first.text.contains("\"type\":\"preparing\""), "{}", first.text);
    let result = first.result_frame();
    assert_eq!(result["success"], true, "{result}");

    let resend = send(&app, "POST", "/worktree/create", body, Some("wt-s1")).await;
    assert!(resend.content_type.contains("application/json"), "{}", resend.content_type);
    assert!(!resend.content_type.contains("ndjson"));
    assert_eq!(resend.json()["success"], true);
    assert_eq!(resend.json()["data"]["path"], result["data"]["path"]);
}

#[tokio::test]
async fn a_worktree_remove_resend_answers_ok_when_it_is_already_gone() {
    let dir = TempDir::new("wtremove");
    let repo = repo(&dir);
    let app = app(host(&repo));
    let create = json!({
        "projectPath": path_str(&repo),
        "name": "wt3",
        "branch": "chat/three",
        "isNewBranch": true,
    });
    let entry = send(&app, "POST", "/worktree/create", create, Some("wt-r0")).await.json()["data"].clone();
    let remove = json!({
        "projectPath": path_str(&repo),
        "worktreePath": entry["path"],
        "force": true,
    });

    assert!(ok(&send(&app, "POST", "/worktree/remove", remove.clone(), Some("wt-r1")).await));
    let again = send(&app, "POST", "/worktree/remove", remove, Some("wt-r2")).await;
    assert!(ok(&again), "{}", again.text);
}

#[tokio::test]
async fn removing_a_path_git_does_not_list_but_that_exists_keeps_the_original_error() {
    let dir = TempDir::new("wtremove-existing");
    let repo = repo(&dir);
    let plain = repo.join(".termul/worktrees/plain");
    std::fs::create_dir_all(&plain).unwrap();
    std::fs::write(plain.join("keep.txt"), "x").unwrap();
    let app = app(host(&repo));
    let remove = json!({
        "projectPath": path_str(&repo),
        "worktreePath": path_str(&plain),
        "force": true,
    });

    for id in [Some("wt-p1"), None] {
        let reply = send(&app, "POST", "/worktree/remove", remove.clone(), id).await;
        assert!(!ok(&reply), "a leftover directory is not a removed worktree: {}", reply.text);
    }
    assert!(plain.join("keep.txt").exists());
}

#[test]
fn credential_and_secret_kinds_are_never_admitted() {
    // Not in the table: no class, so no id is ever recorded for them.
    for kind in ["factory_key_save", "oauth_start", "log_frontend_error", "mcp_probe"] {
        assert!(domain_class(kind).is_none(), "{kind}");
    }
    // Kinds whose request carries content never store their error text (a git
    // or io message can echo the patch/file content).
    for kind in [
        "fs_write",
        "git_commit",
        "git_discard",
        "git_stash_save",
        "git_stage_hunk",
        "git_unstage_hunk",
    ] {
        let (_, class) = domain_class(kind).unwrap_or_else(|| panic!("{kind} has no class"));
        assert!(class.ledgered(), "{kind}");
        assert!(!class.stores_payload(), "{kind}");
    }
    for kind in [
        "fs_rename",
        "fs_copy",
        "git_stash_apply",
        "git_stash_pop",
        "git_stash_drop",
        "git_create_branch",
        "worktree_create",
        "worktree_rename_branch",
        "install_acp_agent",
    ] {
        let (_, class) = domain_class(kind).unwrap_or_else(|| panic!("{kind} has no class"));
        assert!(class.ledgered(), "{kind}");
        assert!(class.stores_payload(), "{kind}");
    }
}

/// Enforcement (AD-5): every ledgered domain kind is refused without an id on
/// BOTH carriers (HTTP header, Tauri argument), its effect never runs and
/// nothing is recorded; the naturally idempotent kinds are never refused.
#[tokio::test]
async fn every_ledgered_domain_kind_refuses_a_request_without_a_command_id() {
    let kinds = [
        "fs_write", "fs_rename", "fs_copy", "git_commit", "git_discard", "git_stash_save",
        "git_stash_apply", "git_stash_pop", "git_stash_drop", "git_stage_hunk",
        "git_unstage_hunk", "git_create_branch", "worktree_create", "worktree_rename_branch",
        "install_acp_agent",
    ];
    let ledger = Arc::new(CommandLedger::new(RETENTION));
    let runs = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    for kind in kinds {
        let (_, class) = domain_class(kind).unwrap_or_else(|| panic!("{kind} has no class"));
        assert!(class.ledgered(), "{kind}");

        let counter = Arc::clone(&runs);
        let body = run_http(
            &ledger,
            &HeaderMap::new(),
            kind,
            fingerprint_of(kind, &[("cwd", "/repo")]),
            no_entity(),
            async move {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                IpcBody::ok(())
            },
        )
        .await;
        assert_eq!(body.code.as_deref(), Some("INVALID_COMMAND_ID"), "{kind}: http");

        let counter = Arc::clone(&runs);
        let refused = run_domain(
            &ledger,
            kind,
            None,
            fingerprint_of(kind, &[("cwd", "/repo")]),
            no_entity(),
            async move {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            },
        )
        .await
        .unwrap_err();
        assert!(refused.starts_with("invalid_command_id"), "{kind}: tauri {refused}");
    }
    assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 0, "no effect ran");
    assert_eq!(ledger.counts(), (0, 0, 0), "a refusal leaves no entry");

    // A kind that is not ledgered runs without an id.
    let counter = Arc::clone(&runs);
    let body = run_http(
        &ledger,
        &HeaderMap::new(),
        "git_stage",
        fingerprint_of("git_stage", &[("cwd", "/repo")]),
        no_entity(),
        async move {
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            IpcBody::ok(())
        },
    )
    .await;
    assert!(body.success);
    assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[tokio::test]
async fn the_tauri_carrier_replays_errors_and_flags_a_conflict() {
    let ledger = Arc::new(CommandLedger::new(RETENTION));
    let runs = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let run = |kind_fields: &'static [(&'static str, &'static str)], id: Option<&str>, fail: bool| {
        let (ledger, runs) = (Arc::clone(&ledger), Arc::clone(&runs));
        let id = id.map(str::to_string);
        async move {
            run_domain(
                &ledger,
                "git_stash_save",
                id,
                fingerprint_of("git_stash_save", kind_fields),
                no_entity(),
                async move {
                    runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    if fail {
                        Err("precondition_failed: HEAD moved".to_string())
                    } else {
                        Ok(())
                    }
                },
            )
            .await
        }
    };

    let first = run(&[("cwd", "/repo")], Some("t-1"), true).await;
    assert_eq!(first.unwrap_err(), "precondition_failed: HEAD moved");
    let replay = run(&[("cwd", "/repo")], Some("t-1"), false).await;
    // A receipt-only kind (stash save) replays its code prefix, not its text.
    let replayed = replay.unwrap_err();
    assert!(replayed.starts_with("precondition_failed"), "{replayed}");
    assert!(!replayed.contains("HEAD moved"), "{replayed}");
    assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 1);

    let conflict = run(&[("cwd", "/other")], Some("t-1"), false).await.unwrap_err();
    assert!(conflict.starts_with("command_conflict"), "{conflict}");
    let invalid = run(&[("cwd", "/repo")], Some("bad id"), false).await.unwrap_err();
    assert!(invalid.starts_with("invalid_command_id"), "{invalid}");
    // No id: refused before it runs, nothing recorded.
    let missing = run(&[("cwd", "/repo")], None, false).await.unwrap_err();
    assert!(missing.starts_with("invalid_command_id"), "{missing}");
    assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 1);
}

mod routes;
