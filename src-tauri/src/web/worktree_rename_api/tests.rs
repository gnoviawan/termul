use super::*;
use crate::acp::session_persistence::{
    SessionPersistence, SessionRegistration, WorktreeBranchSource,
};
use crate::acp::AcpManager;
use crate::web::sink::{AcpEvent, EventSink, WsRelaySink};
use crate::web::test_pty_manager;
use crate::web::ws::HistoryMode;
use crate::worktree::WorktreeManager;
use axum::body::Body;
use axum::http::Request;
use axum::routing::post;
use parking_lot::Mutex;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tower::ServiceExt;

#[derive(Default)]
struct RecordingSink {
    seen: Mutex<Vec<AcpEvent>>,
}

impl EventSink for RecordingSink {
    fn emit(&self, event: &AcpEvent) {
        self.seen.lock().push(event.clone());
    }
}

impl RecordingSink {
    fn renamed_count(&self) -> usize {
        self.seen
            .lock()
            .iter()
            .filter(|event| event.type_ == crate::acp::events::EVENT_WORKTREE_BRANCH_RENAMED)
            .count()
    }
}

fn unique_dir(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let path = std::env::temp_dir().join(format!("termul-web-wtrename-{label}-{nanos}"));
    std::fs::create_dir_all(&path).expect("create temp dir");
    path
}

fn test_state(root: &Path, acp: Arc<AcpManager>) -> AppState {
    let pty = test_pty_manager();
    AppState {
        acp,
        terminal_events: pty.terminal_events(),
        cwd_tracker: pty.cwd_tracker(),
        git_tracker: pty.git_tracker(),
        exit_code_tracker: pty.exit_code_tracker(),
        pty,
        relay: Arc::new(WsRelaySink::new()),
        registry: crate::web::project_registry::ProjectRegistry::seeded_for_test(
            &root.canonicalize().unwrap_or_else(|_| root.to_path_buf()),
        ),
        registry_persistence: None,
        projects_file: None,
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
    }
}

fn test_router(state: AppState) -> axum::Router {
    axum::Router::new()
        .route("/worktree/rename-branch", post(rename_branch))
        .with_state(state)
}

fn loopback() -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], 54321))
}

fn remote() -> SocketAddr {
    SocketAddr::from(([192, 168, 1, 50], 40000))
}

async fn post_json(state: AppState, body: &serde_json::Value, peer: SocketAddr) -> IpcBody<()> {
    let bytes = serde_json::to_vec(body).expect("serialize body");
    let resp = test_router(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/worktree/rename-branch")
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
    std::process::Command::new("git")
        .arg("--version")
        .output()
        .is_err()
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .expect("git");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

struct Fixture {
    repo: PathBuf,
    worktree: PathBuf,
    persistence: Arc<SessionPersistence>,
    sink: Arc<RecordingSink>,
    acp: Arc<AcpManager>,
    store: PathBuf,
}

/// A repo with a `chat/ab12cd34` worktree and one creator session on it,
/// wired to an `AcpManager` with durable persistence and a recording sink.
async fn fixture(label: &str) -> Fixture {
    let repo = unique_dir(label);
    git(&repo, &["init", "-q"]);
    git(&repo, &["config", "user.email", "t@example.com"]);
    git(&repo, &["config", "user.name", "Test"]);
    git(&repo, &["config", "commit.gpgsign", "false"]);
    git(&repo, &["checkout", "-q", "-b", "main"]);
    std::fs::write(repo.join("a.txt"), "a\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-qm", "init"]);
    let entry = WorktreeManager::create(
        repo.to_str().unwrap(),
        "ab12cd34",
        "chat/ab12cd34",
        true,
        Some("main"),
        None,
        None,
    )
    .expect("create worktree");
    let worktree = PathBuf::from(entry.path.trim_end_matches('/'));

    let store = unique_dir(&format!("{label}-store"));
    let persistence = SessionPersistence::open(store.join("sessions"))
        .await
        .unwrap();
    persistence
        .register_session(SessionRegistration {
            session_id: "s1".to_string(),
            stable_agent_namespace: Some("config:one".to_string()),
            runtime_agent_id: Some("runtime-1".to_string()),
            project_id: None,
            cwd: worktree.clone(),
            worktree_path: Some(entry.path),
            worktree_branch: Some("chat/ab12cd34".to_string()),
            worktree_created: true,
            ..Default::default()
        })
        .await
        .unwrap();
    let sink = Arc::new(RecordingSink::default());
    let acp = Arc::new(AcpManager::with_persistence(
        vec![sink.clone()],
        Arc::clone(&persistence),
    ));
    Fixture {
        repo,
        worktree,
        persistence,
        sink,
        acp,
        store,
    }
}

impl Fixture {
    fn state(&self) -> AppState {
        test_state(&self.repo, Arc::clone(&self.acp))
    }

    fn req(&self, old: &str, new: &str) -> serde_json::Value {
        serde_json::json!({
            "worktreePath": self.worktree.to_string_lossy(),
            "oldBranch": old,
            "newBranch": new,
        })
    }

    fn branch(&self) -> String {
        git(&self.worktree, &["symbolic-ref", "--short", "HEAD"])
    }

    fn cleanup(&self) {
        std::fs::remove_dir_all(&self.repo).ok();
        std::fs::remove_dir_all(&self.store).ok();
    }
}

#[tokio::test]
async fn rename_branch_renames_records_user_source_and_emits_once() {
    if git_missing() {
        return;
    }
    let fx = fixture("ok").await;
    let body = post_json(
        fx.state(),
        &fx.req("chat/ab12cd34", "chat/fix-login"),
        loopback(),
    )
    .await;
    assert!(body.success, "rename should succeed: {:?}", body.error);
    assert_eq!(fx.branch(), "chat/fix-login");
    let metadata = fx.persistence.metadata("s1").unwrap();
    assert_eq!(metadata.worktree_branch.as_deref(), Some("chat/fix-login"));
    assert_eq!(
        metadata.worktree_branch_source,
        Some(WorktreeBranchSource::User)
    );
    assert_eq!(fx.sink.renamed_count(), 1);
    fx.cleanup();
}

#[tokio::test]
async fn rename_branch_refused_from_non_loopback_peer_and_nothing_changes() {
    if git_missing() {
        return;
    }
    let fx = fixture("guard").await;
    let body = post_json(fx.state(), &fx.req("chat/ab12cd34", "chat/x"), remote()).await;
    assert!(!body.success);
    assert_eq!(body.code.as_deref(), Some("FORBIDDEN"));
    assert_eq!(fx.branch(), "chat/ab12cd34");
    assert_eq!(fx.sink.renamed_count(), 0);
    fx.cleanup();
}

#[tokio::test]
async fn rename_branch_refused_when_shared_live_writes_denied() {
    if git_missing() {
        return;
    }
    let fx = fixture("shared-live").await;
    let mut state = fx.state();
    state.shared_live_writes_denied = true;
    let body = post_json(state, &fx.req("chat/ab12cd34", "chat/x"), loopback()).await;
    assert!(!body.success);
    assert_eq!(body.code.as_deref(), Some("FORBIDDEN"));
    assert_eq!(fx.branch(), "chat/ab12cd34");
    assert_eq!(fx.sink.renamed_count(), 0);
    fx.cleanup();
}

#[tokio::test]
async fn rename_branch_admitted_from_non_loopback_peer_when_opt_in() {
    if git_missing() {
        return;
    }
    let fx = fixture("opt-in").await;
    let mut state = fx.state();
    state.allow_remote_writes = true;
    let body = post_json(state, &fx.req("chat/ab12cd34", "chat/remote-ok"), remote()).await;
    assert!(body.success, "opt-in must admit: {:?}", body.error);
    assert_eq!(fx.branch(), "chat/remote-ok");
    assert_eq!(fx.sink.renamed_count(), 1);
    fx.cleanup();
}

#[tokio::test]
async fn rename_branch_rejects_worktree_outside_project_root() {
    let outside = unique_dir("outside");
    let inside = unique_dir("inside");
    let state = test_state(&inside, Arc::new(AcpManager::new(vec![])));
    let body = post_json(
        state,
        &serde_json::json!({
            "worktreePath": outside.to_string_lossy(),
            "oldBranch": "chat/a",
            "newBranch": "chat/b",
        }),
        loopback(),
    )
    .await;
    assert!(!body.success);
    assert_eq!(body.code.as_deref(), Some("OUTSIDE_PROJECT_ROOT"));
    std::fs::remove_dir_all(&outside).ok();
    std::fs::remove_dir_all(&inside).ok();
}

#[tokio::test]
async fn rename_branch_maps_worktree_errors_to_stable_codes() {
    if git_missing() {
        return;
    }
    let fx = fixture("codes").await;
    git(&fx.repo, &["branch", "chat/taken"]);

    let invalid = post_json(fx.state(), &fx.req("chat/ab12cd34", "bad name"), loopback()).await;
    assert_eq!(invalid.code.as_deref(), Some("INVALID_BRANCH_NAME"));

    let exists = post_json(
        fx.state(),
        &fx.req("chat/ab12cd34", "chat/taken"),
        loopback(),
    )
    .await;
    assert_eq!(exists.code.as_deref(), Some("BRANCH_EXISTS"));

    let changed = post_json(
        fx.state(),
        &fx.req("chat/not-current", "chat/other"),
        loopback(),
    )
    .await;
    assert_eq!(changed.code.as_deref(), Some("BRANCH_CHANGED"));

    assert_eq!(fx.branch(), "chat/ab12cd34");
    assert_eq!(fx.sink.renamed_count(), 0);
    fx.cleanup();
}
