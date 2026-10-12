//! Table-style resend tests of every ledgered HTTP route: the first run's
//! effect happens once, the same-id resend replays without running again, and
//! the ledger holds exactly one outcome (a kind typo that left a route
//! unledgered would leave none). Plus the request-boundary refusals.

use super::*;

/// One outcome recorded, nothing in flight, nothing bare.
fn recorded_once(ledger: &CommandLedger) {
    assert_eq!(ledger.counts(), (0, 1, 0));
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).expect("read file")
}

fn stash_count(repo: &Path) -> usize {
    git(repo, &["stash", "list"]).lines().count()
}

/// A host over `repo` and its ledger.
fn host_and_ledger(root: &Path) -> (Router, Arc<CommandLedger>) {
    let state = host(root);
    let ledger = Arc::clone(state.relay.ledger());
    (app(state), ledger)
}

#[tokio::test]
async fn fs_copy_resend_does_not_overwrite_again() {
    let dir = TempDir::new("copy");
    let (from, to) = (dir.path().join("a.txt"), dir.path().join("b.txt"));
    std::fs::write(&from, "source").unwrap();
    let (app, ledger) = host_and_ledger(dir.path());
    let body = json!({ "from": path_str(&from), "to": path_str(&to) });

    assert!(ok(&send(&app, "POST", "/fs/copy", body.clone(), Some("cp-1")).await));
    std::fs::write(&to, "edited since").unwrap();
    assert!(ok(&send(&app, "POST", "/fs/copy", body, Some("cp-1")).await));
    assert_eq!(read(&to), "edited since");
    recorded_once(&ledger);
}

#[tokio::test]
async fn git_discard_resend_does_not_discard_again() {
    let dir = TempDir::new("discard");
    let repo = repo(&dir);
    let (app, ledger) = host_and_ledger(&repo);
    let body = json!({ "cwd": path_str(&repo), "path": "a.txt" });

    std::fs::write(repo.join("a.txt"), "dirty\n").unwrap();
    assert!(ok(&send(&app, "POST", "/git/discard", body.clone(), Some("dis-1")).await));
    assert_eq!(read(&repo.join("a.txt")), "one\n");
    std::fs::write(repo.join("a.txt"), "dirty again\n").unwrap();
    assert!(ok(&send(&app, "POST", "/git/discard", body, Some("dis-1")).await));
    assert_eq!(read(&repo.join("a.txt")), "dirty again\n", "the resend must not discard");
    recorded_once(&ledger);
}

/// A repo whose `a.txt` has one stash entry holding "stashed\n".
fn repo_with_stash(dir: &TempDir) -> PathBuf {
    let repo = repo(dir);
    std::fs::write(repo.join("a.txt"), "stashed\n").unwrap();
    git(&repo, &["stash"]);
    assert_eq!(read(&repo.join("a.txt")), "one\n");
    repo
}

#[tokio::test]
async fn git_stash_apply_resend_does_not_apply_again() {
    let dir = TempDir::new("apply");
    let repo = repo_with_stash(&dir);
    let (app, ledger) = host_and_ledger(&repo);
    let body = json!({ "cwd": path_str(&repo), "index": 0 });

    assert!(ok(&send(&app, "POST", "/git/stash-apply", body.clone(), Some("ap-1")).await));
    assert_eq!(read(&repo.join("a.txt")), "stashed\n");
    git(&repo, &["checkout", "--", "a.txt"]);
    assert!(ok(&send(&app, "POST", "/git/stash-apply", body, Some("ap-1")).await));
    assert_eq!(read(&repo.join("a.txt")), "one\n", "the resend must not apply again");
    recorded_once(&ledger);
}

#[tokio::test]
async fn git_stash_pop_resend_does_not_pop_again() {
    let dir = TempDir::new("pop");
    let repo = repo_with_stash(&dir);
    let (app, ledger) = host_and_ledger(&repo);
    let body = json!({ "cwd": path_str(&repo), "index": 0 });

    assert!(ok(&send(&app, "POST", "/git/stash-pop", body.clone(), Some("pop-1")).await));
    assert_eq!(stash_count(&repo), 0);
    git(&repo, &["checkout", "--", "a.txt"]);
    // A second pop would fail (no stash): the replay is the original success.
    assert!(ok(&send(&app, "POST", "/git/stash-pop", body, Some("pop-1")).await));
    assert_eq!(read(&repo.join("a.txt")), "one\n");
    recorded_once(&ledger);
}

#[tokio::test]
async fn git_stash_drop_resend_does_not_drop_the_next_stash() {
    let dir = TempDir::new("drop");
    let repo = repo_with_stash(&dir);
    let (app, ledger) = host_and_ledger(&repo);
    let body = json!({ "cwd": path_str(&repo), "index": 0 });

    assert!(ok(&send(&app, "POST", "/git/stash-drop", body.clone(), Some("drop-1")).await));
    assert_eq!(stash_count(&repo), 0);
    // A new stash now sits at index 0, exactly where a re-run would strike.
    std::fs::write(repo.join("a.txt"), "newer\n").unwrap();
    git(&repo, &["stash"]);
    assert!(ok(&send(&app, "POST", "/git/stash-drop", body, Some("drop-1")).await));
    assert_eq!(stash_count(&repo), 1, "the resend must not drop the newer stash");
    recorded_once(&ledger);
}

/// A repo with `a.txt` (four lines) committed and two separated unstaged hunks.
fn repo_with_two_hunks(dir: &TempDir) -> PathBuf {
    let repo = repo(dir);
    std::fs::write(repo.join("a.txt"), "one\ntwo\nthree\nfour\n").unwrap();
    git(&repo, &["commit", "-qam", "four lines"]);
    std::fs::write(repo.join("a.txt"), "one\nTWO\nthree\nFOUR\n").unwrap();
    repo
}

const HUNK1: &str = "--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n";

#[tokio::test]
async fn stage_hunk_resend_does_not_stage_again() {
    let dir = TempDir::new("stage-hunk");
    let repo = repo_with_two_hunks(&dir);
    let (app, ledger) = host_and_ledger(&repo);
    let body = json!({ "cwd": path_str(&repo), "path": "a.txt", "hunkPatch": HUNK1 });

    assert!(ok(&send(&app, "POST", "/git/stage-hunk", body.clone(), Some("sh-1")).await));
    assert!(git(&repo, &["diff", "--cached", "--", "a.txt"]).contains("+TWO"));
    git(&repo, &["reset", "-q"]);
    assert!(ok(&send(&app, "POST", "/git/stage-hunk", body, Some("sh-1")).await));
    assert!(git(&repo, &["diff", "--cached", "--", "a.txt"]).is_empty());
    recorded_once(&ledger);
}

#[tokio::test]
async fn unstage_hunk_resend_does_not_unstage_again() {
    let dir = TempDir::new("unstage-hunk");
    let repo = repo_with_two_hunks(&dir);
    git(&repo, &["add", "a.txt"]);
    let (app, ledger) = host_and_ledger(&repo);
    let body = json!({ "cwd": path_str(&repo), "path": "a.txt", "hunkPatch": HUNK1 });

    assert!(ok(&send(&app, "POST", "/git/unstage-hunk", body.clone(), Some("uh-1")).await));
    assert!(!git(&repo, &["diff", "--cached", "--", "a.txt"]).contains("+TWO"));
    git(&repo, &["add", "a.txt"]);
    assert!(ok(&send(&app, "POST", "/git/unstage-hunk", body, Some("uh-1")).await));
    assert!(
        git(&repo, &["diff", "--cached", "--", "a.txt"]).contains("+TWO"),
        "the resend must not unstage again"
    );
    recorded_once(&ledger);
}

#[tokio::test]
async fn a_rejected_hunk_replays_its_code_but_none_of_the_patch_text() {
    let dir = TempDir::new("hunk-secret");
    let repo = repo_with_two_hunks(&dir);
    let (app, ledger) = host_and_ledger(&repo);
    let patch = "--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-SECRETPATCHTEXT\n+other\n";
    let body = json!({ "cwd": path_str(&repo), "path": "a.txt", "hunkPatch": patch });

    let first = send(&app, "POST", "/git/stage-hunk", body.clone(), Some("hs-1")).await;
    assert!(!ok(&first), "{}", first.text);
    let resend = send(&app, "POST", "/git/stage-hunk", body, Some("hs-1")).await;
    assert!(!ok(&resend));
    assert_eq!(code(&resend), code(&first), "the original code is replayed");
    assert!(!resend.text.contains("SECRETPATCHTEXT"), "{}", resend.text);
    assert_eq!(resend.json()["error"], RECEIPT_ONLY_REJECTION_MESSAGE);
    recorded_once(&ledger);
}

#[tokio::test]
async fn workspace_write_resend_answers_updated_not_a_conflict_with_itself() {
    let dir = TempDir::new("workspace");
    let mut state = host(dir.path());
    state.workspace_manifest = Some(
        crate::acp::WorkspaceManifestService::open(dir.path().join("manifests"))
            .await
            .expect("open manifest store"),
    );
    let ledger = Arc::clone(state.relay.ledger());
    let app = app(state);
    let body = json!({
        "basedRevision": null,
        "manifest": { "projectId": "p1", "revision": 0, "updatedAt": 0 },
    });

    let first = send(&app, "POST", "/workspace/p1/write", body.clone(), Some("ws-1")).await;
    assert_eq!(first.json()["data"]["status"], "updated", "{}", first.text);
    let resend = send(&app, "POST", "/workspace/p1/write", body.clone(), Some("ws-1")).await;
    assert_eq!(resend.json()["data"], first.json()["data"]);
    recorded_once(&ledger);
    // Without the id the same stale write is the conflict it always was.
    let bare = send(&app, "POST", "/workspace/p1/write", body, None).await;
    assert_eq!(bare.json()["data"]["status"], "conflict", "{}", bare.text);
}

#[tokio::test]
async fn worktree_rename_branch_resend_does_not_rename_again() {
    let dir = TempDir::new("rename-branch");
    let repo = repo(&dir);
    let (app, ledger) = host_and_ledger(&repo);
    let create = json!({
        "projectPath": path_str(&repo),
        "name": "wt-rn",
        "branch": "chat/old",
        "isNewBranch": true,
    });
    let entry = send(&app, "POST", "/worktree/create", create, Some("rn-create")).await.json()["data"].clone();
    let rename = json!({
        "worktreePath": entry["path"],
        "oldBranch": "chat/old",
        "newBranch": "chat/new",
    });

    let first = send(&app, "POST", "/worktree/rename-branch", rename.clone(), Some("rn-1")).await;
    assert!(ok(&first), "{}", first.text);
    assert_eq!(git(&repo, &["branch", "--list", "chat/new"]).trim(), "+ chat/new");
    // A second rename would fail (`chat/old` is gone): the replay is the success.
    let resend = send(&app, "POST", "/worktree/rename-branch", rename, Some("rn-1")).await;
    assert!(ok(&resend), "{}", resend.text);
    assert_eq!(ledger.counts(), (0, 2, 0), "create + rename are recorded once each");
}

#[tokio::test]
async fn acp_install_resend_replays_the_recorded_outcome() {
    let dir = TempDir::new("install");
    let mut state = host(dir.path());
    let catalog = crate::acp::AcpCatalogService::open(dir.path().join("catalog"))
        .await
        .expect("open catalog");
    state.acp_install = Some(
        crate::acp::AcpInstallService::open(dir.path().join("installs"), catalog)
            .await
            .expect("open installs"),
    );
    let ledger = Arc::clone(state.relay.ledger());
    let app = app(state);
    let body = json!({ "agentId": "does-not-exist" });

    let first = send(&app, "POST", "/acp/install", body.clone(), Some("in-1")).await;
    assert_eq!(code(&first), "CATALOG_AGENT_NOT_FOUND", "{}", first.text);
    let resend = send(&app, "POST", "/acp/install", body, Some("in-1")).await;
    assert_eq!(code(&resend), "CATALOG_AGENT_NOT_FOUND");
    recorded_once(&ledger);
}

#[tokio::test]
async fn a_malformed_expected_head_is_refused_before_it_reaches_git() {
    let dir = TempDir::new("head-injection");
    let repo = repo(&dir);
    std::fs::write(repo.join("a.txt"), "two\n").unwrap();
    git(&repo, &["add", "a.txt"]);
    let (app, ledger) = host_and_ledger(&repo);
    let victim = dir.path().join("pwned.txt");

    for head in [
        format!("--output={}", victim.display()),
        "HEAD".to_string(),
        "deadbeef".to_string(),
    ] {
        let body = json!({ "cwd": path_str(&repo), "summary": "x", "expectedHead": head });
        // With an id (the resend lookup path) and without.
        for id in [Some("inj-1"), None] {
            let reply = send(&app, "POST", "/git/commit", body.clone(), id).await;
            assert_eq!(code(&reply), "VALIDATION_ERROR", "{head}: {}", reply.text);
        }
    }
    assert!(!victim.exists(), "an option-shaped expectedHead must not reach git");
    assert_eq!(commit_count(&repo), 1);
    assert_eq!(ledger.counts(), (0, 0, 0), "a refused request is not recorded");
}

#[tokio::test]
async fn a_guard_refusal_is_released_so_a_retry_after_the_turn_ends_runs() {
    let dir = TempDir::new("guard-release");
    let repo = repo(&dir);
    let state = host(&repo);
    let acp = Arc::clone(&state.acp);
    let ledger = Arc::clone(state.relay.ledger());
    let app = app(state);
    let session = |active: bool| {
        acp.install_test_agent_with_session_roots(
            crate::acp::AgentId("agent-1".to_string()),
            vec![("session-1".to_string(), repo.clone(), active)],
        );
    };
    let body = json!({ "cwd": path_str(&repo), "branch": "feature/guarded", "startRef": "main" });

    // A turn is running in the checkout: refused, nothing recorded.
    session(true);
    let refused = send(&app, "POST", "/git/create-branch", body.clone(), Some("gr-1")).await;
    assert_eq!(code(&refused), "destructive_op_blocked", "{}", refused.text);
    assert_eq!(ledger.counts(), (0, 0, 0), "a refusal must not be recorded");
    assert!(git(&repo, &["branch", "--list", "feature/guarded"]).is_empty());

    // The turn ended: the same id now runs.
    session(false);
    let retried = send(&app, "POST", "/git/create-branch", body.clone(), Some("gr-1")).await;
    assert!(ok(&retried), "{}", retried.text);
    assert_eq!(git(&repo, &["branch", "--show-current"]), "feature/guarded");
    recorded_once(&ledger);

    // A new turn starts: the settled success replays before the guard runs.
    session(true);
    let replayed = send(&app, "POST", "/git/create-branch", body, Some("gr-1")).await;
    assert!(ok(&replayed), "{}", replayed.text);
}

#[tokio::test]
async fn a_commit_id_reused_with_a_different_amend_or_expected_head_conflicts() {
    let dir = TempDir::new("commit-fingerprint");
    let repo = repo(&dir);
    std::fs::write(repo.join("a.txt"), "two\n").unwrap();
    git(&repo, &["add", "a.txt"]);
    let head = git(&repo, &["rev-parse", "HEAD"]);
    let (app, _) = host_and_ledger(&repo);
    let commit = |amend: bool, head: &str| {
        json!({ "cwd": path_str(&repo), "summary": "s", "amend": amend, "expectedHead": head })
    };

    assert!(ok(&send(&app, "POST", "/git/commit", commit(false, &head), Some("cf-1")).await));
    let amend = send(&app, "POST", "/git/commit", commit(true, &head), Some("cf-1")).await;
    assert_eq!(code(&amend), "COMMAND_CONFLICT", "{}", amend.text);
    let other_head = send(&app, "POST", "/git/commit", commit(false, &"a".repeat(40)), Some("cf-1")).await;
    assert_eq!(code(&other_head), "COMMAND_CONFLICT", "{}", other_head.text);
    assert_eq!(commit_count(&repo), 2);
}

#[test]
fn one_request_has_one_fingerprint_on_every_constructor() {
    // The `/ws` payload form and the field form (HTTP/Tauri) agree, including
    // on padding and blank values.
    let ws = Fingerprint::of("install_acp_agent", &json!({ "agentId": "agent-1" }));
    assert_eq!(ws, Fingerprint::of_fields("install_acp_agent", [("agentId", "agent-1")]));
    assert_eq!(ws, Fingerprint::of_fields("install_acp_agent", [("agentId", "  agent-1 ")]));
    assert_eq!(
        Fingerprint::of("install_acp_agent", &json!({ "agentId": "  " })),
        Fingerprint::of_fields("install_acp_agent", [("agentId", "")]),
    );
    assert_ne!(ws, Fingerprint::of_fields("install_acp_agent", [("agentId", "agent-2")]));
}
