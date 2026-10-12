//! The desktop entry points (git checkout/switch/create-branch and the
//! worktree removals) refuse a destructive op while a session inside the
//! work tree is mid-turn, with the same text/code as the HTTP routes.

use super::super::worktree::{
    worktree_remove_all_managed_guarded, worktree_remove_guarded,
};
use super::super::IpcResult;
use super::*;
use crate::acp::AgentId;
use crate::trackers::git_tracker::GitTracker;
use std::path::{Path, PathBuf};

fn git(repo: &Path, args: &[&str]) {
    let out = GitTracker::run_git_command(repo.to_str().unwrap(), args).expect("git runs");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

fn head(repo: &Path) -> String {
    GitTracker::run_git_command(repo.to_str().unwrap(), &["symbolic-ref", "--short", "HEAD"])
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

fn repo(dir: &tempfile::TempDir) -> Option<PathBuf> {
    let path = dir.path().join("repo");
    std::fs::create_dir_all(&path).unwrap();
    GitTracker::run_git_command(path.to_str().unwrap(), &["--version"])?;
    git(&path, &["init", "-q"]);
    for kv in [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"]] {
        git(&path, &["config", kv[0], kv[1]]);
    }
    git(&path, &["commit", "--allow-empty", "-qm", "init"]);
    git(&path, &["branch", "feature"]);
    Some(std::fs::canonicalize(path).unwrap())
}

fn manager_with_session(root: &Path, active: bool) -> AcpManager {
    let acp = AcpManager::new(vec![]);
    acp.install_test_agent_with_session_roots(
        AgentId("a1".to_string()),
        vec![("s1".to_string(), root.to_path_buf(), active)],
    );
    acp
}

fn assert_blocked(result: Result<(), String>) {
    let error = result.expect_err("must be refused");
    assert!(error.starts_with("destructive_op_blocked"), "{error}");
}

#[tokio::test]
async fn checkout_and_switch_are_refused_mid_turn_and_allowed_when_idle() {
    let dir = tempfile::tempdir().unwrap();
    let Some(repo) = repo(&dir) else { return };
    let cwd = repo.to_string_lossy().to_string();
    let before = head(&repo);

    let busy = manager_with_session(&repo, true);
    assert_blocked(checkout_branch_guarded(&busy, cwd.clone(), "feature".into(), false).await);
    assert_blocked(branch_switch_guarded(&busy, cwd.clone(), "feature".into()).await);
    assert_eq!(head(&repo), before, "a refused checkout must not touch the tree");

    let idle = manager_with_session(&repo, false);
    branch_switch_guarded(&idle, cwd.clone(), "feature".into()).await.expect("idle switch");
    assert_eq!(head(&repo), "feature");
    checkout_branch_guarded(&idle, cwd, before.clone(), false).await.expect("idle checkout");
    assert_eq!(head(&repo), before);
}

#[tokio::test]
async fn create_branch_guards_only_a_start_ref_other_than_head() {
    let dir = tempfile::tempdir().unwrap();
    let Some(repo) = repo(&dir) else { return };
    let cwd = repo.to_string_lossy().to_string();
    let busy = Arc::new(manager_with_session(&repo, true));
    let ledger = Arc::new(crate::web::command_ledger::CommandLedger::new(
        std::time::Duration::from_secs(600),
    ));
    let create = |name: String, start_ref: Option<String>, id: Option<&str>| {
        create_branch_ledgered(
            &ledger,
            Arc::clone(&busy),
            cwd.clone(),
            name,
            start_ref,
            id.map(str::to_string),
        )
    };

    assert_blocked(create("topic".into(), Some("feature".into()), None).await);
    for head_ref in [None, Some("HEAD".to_string()), Some("  ".to_string())] {
        let name = format!("from-head-{}", head_ref.as_deref().unwrap_or("none").trim());
        create(name, head_ref, None)
            .await
            .expect("branching from HEAD leaves the tree alone");
    }
}

/// A refusal is released, not recorded: the same `commandId` runs once the turn
/// ends, and a settled success replays before the guard is consulted.
#[tokio::test]
async fn create_branch_refusal_is_released_and_a_settled_success_replays_past_the_guard() {
    let dir = tempfile::tempdir().unwrap();
    let Some(repo) = repo(&dir) else { return };
    let cwd = repo.to_string_lossy().to_string();
    let ledger = Arc::new(crate::web::command_ledger::CommandLedger::new(
        std::time::Duration::from_secs(600),
    ));
    let run = |active: bool| {
        create_branch_ledgered(
            &ledger,
            Arc::new(manager_with_session(&repo, active)),
            cwd.clone(),
            "topic".into(),
            Some("feature".into()),
            Some("cmd-1".into()),
        )
    };

    assert_blocked(run(true).await);
    assert_eq!(ledger.counts(), (0, 0, 0), "a refusal must not be recorded");
    run(false).await.expect("the id is free once the turn ended");
    assert_eq!(head(&repo), "topic");
    run(true).await.expect("a settled success replays before the guard runs");
}

#[test]
fn start_ref_classification() {
    assert!(!start_ref_rewrites_tree(None));
    assert!(!start_ref_rewrites_tree(Some("")));
    assert!(!start_ref_rewrites_tree(Some(" HEAD ")));
    assert!(start_ref_rewrites_tree(Some("feature")));
    assert!(start_ref_rewrites_tree(Some("HEAD~1")));
}

// ---------------------------------------------------------------------------
// Worktree removal
// ---------------------------------------------------------------------------

/// A repo with a managed worktree at `<repo>/.termul/worktrees/<name>`.
fn repo_with_worktree(dir: &tempfile::TempDir, name: &str) -> Option<(PathBuf, PathBuf)> {
    let repo = dir.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    GitTracker::run_git_command(repo.to_str().unwrap(), &["--version"])?;
    git(&repo, &["init", "-q"]);
    for kv in [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"]] {
        git(&repo, &[ "config", kv[0], kv[1]]);
    }
    git(&repo, &["commit", "--allow-empty", "-qm", "init"]);
    let repo = std::fs::canonicalize(repo).unwrap();
    let worktree = repo.join(".termul/worktrees").join(name);
    std::fs::create_dir_all(worktree.parent().unwrap()).unwrap();
    git(&repo, &["worktree", "add", "-q", "-b", name, worktree.to_str().unwrap()]);
    Some((repo, std::fs::canonicalize(worktree).unwrap()))
}

fn code_of<T>(result: &Result<IpcResult<T>, String>) -> Option<String> {
    result.as_ref().ok().and_then(|r| r.code.clone())
}

#[tokio::test]
async fn worktree_remove_is_refused_mid_turn_then_allowed_when_idle() {
    let dir = tempfile::tempdir().unwrap();
    let Some((repo, worktree)) = repo_with_worktree(&dir, "wt1") else { return };
    let project = repo.to_string_lossy().to_string();
    let path = worktree.to_string_lossy().to_string();

    let busy = manager_with_session(&worktree.join("."), true);
    let refused = worktree_remove_guarded(&busy, project.clone(), path.clone(), true).await;
    assert_eq!(code_of(&refused).as_deref(), Some("destructive_op_blocked"));
    assert!(refused.unwrap().error.unwrap().starts_with("destructive_op_blocked"));
    assert!(worktree.exists(), "a refused removal leaves the worktree");

    let idle = manager_with_session(&worktree, false);
    let removed = worktree_remove_guarded(&idle, project, path, true).await.unwrap();
    assert!(removed.success, "{:?}", removed.error);
    assert!(!worktree.exists());
}

#[tokio::test]
async fn remove_all_managed_is_refused_as_a_whole_and_ignores_unmanaged_paths() {
    let dir = tempfile::tempdir().unwrap();
    let Some((repo, worktree)) = repo_with_worktree(&dir, "wt2") else { return };
    let project = repo.to_string_lossy().to_string();
    let list = serde_json::json!([{ "path": worktree.to_string_lossy(), "name": "wt2" }]).to_string();

    let busy = manager_with_session(&worktree, true);
    let refused = worktree_remove_all_managed_guarded(&busy, project.clone(), list.clone()).await;
    assert_eq!(code_of(&refused).as_deref(), Some("destructive_op_blocked"));
    assert!(worktree.exists());

    // A busy session in the project checkout (an unmanaged path) must not
    // block removal of the managed worktree: it is not removed by the batch.
    let busy_in_repo = manager_with_session(&repo, true);
    let unmanaged_list = serde_json::json!([
        { "path": repo.to_string_lossy(), "name": "main" },
        { "path": worktree.to_string_lossy(), "name": "wt2" },
    ])
    .to_string();
    let result = worktree_remove_all_managed_guarded(&busy_in_repo, project, unmanaged_list)
        .await
        .unwrap();
    assert!(result.success, "{:?}", result.error);
    assert!(!worktree.exists());
}
