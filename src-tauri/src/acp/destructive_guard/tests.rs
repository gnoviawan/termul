use super::*;
use crate::acp::config::AgentId;

fn agent(id: &str) -> AgentId {
    AgentId(id.to_string())
}

fn manager() -> AcpManager {
    AcpManager::new(vec![])
}

#[tokio::test]
async fn active_turn_inside_the_target_blocks() {
    let root = tempfile::tempdir().unwrap();
    let worktree = root.path().join("wt");
    let nested = worktree.join("packages/app");
    std::fs::create_dir_all(&nested).unwrap();

    let acp = manager();
    acp.install_test_agent_with_session_roots(
        agent("a1"),
        vec![("s1".to_string(), nested.clone(), true)],
    );

    let blocked = ensure_no_active_turn_under(&acp, &worktree)
        .await
        .expect_err("a session working under the worktree is mid-turn");
    assert_eq!(blocked.target, std::fs::canonicalize(&worktree).unwrap());
    let message = blocked.to_string();
    assert!(
        message.starts_with(DESTRUCTIVE_OP_BLOCKED),
        "the message leads with the stable code: {message}"
    );
}

#[tokio::test]
async fn idle_sessions_do_not_block() {
    let root = tempfile::tempdir().unwrap();
    let worktree = root.path().join("wt");
    std::fs::create_dir_all(&worktree).unwrap();

    let acp = manager();
    acp.install_test_agent_with_session_roots(
        agent("a1"),
        vec![("s1".to_string(), worktree.clone(), false)],
    );
    ensure_no_active_turn_under(&acp, &worktree)
        .await
        .expect("an idle session never blocks");
}

#[tokio::test]
async fn a_sibling_sharing_a_name_prefix_is_not_inside_the_target() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("wt");
    let sibling = root.path().join("wt-other");
    std::fs::create_dir_all(&target).unwrap();
    std::fs::create_dir_all(&sibling).unwrap();

    let acp = manager();
    acp.install_test_agent_with_session_roots(
        agent("a1"),
        vec![("s1".to_string(), sibling.clone(), true)],
    );
    ensure_no_active_turn_under(&acp, &target)
        .await
        .expect("/x/wt-other is not inside /x/wt");

    // A session above the target is not inside it either.
    let parent_acp = manager();
    parent_acp.install_test_agent_with_session_roots(
        agent("a2"),
        vec![("s2".to_string(), root.path().to_path_buf(), true)],
    );
    ensure_no_active_turn_under(&parent_acp, &target)
        .await
        .expect("an ancestor cwd is not inside the target");
}

#[tokio::test]
async fn symlinked_paths_are_compared_canonically() {
    #[cfg(unix)]
    {
        let root = tempfile::tempdir().unwrap();
        let real = root.path().join("real");
        std::fs::create_dir_all(&real).unwrap();
        let link = root.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let acp = manager();
        acp.install_test_agent_with_session_roots(
            agent("a1"),
            vec![("s1".to_string(), real.clone(), true)],
        );
        // The target reached through the symlink is the same directory.
        assert!(ensure_no_active_turn_under(&acp, &link).await.is_err());
    }
}

#[tokio::test]
async fn only_the_session_inside_the_target_decides() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("wt");
    let other = root.path().join("main");
    std::fs::create_dir_all(&target).unwrap();
    std::fs::create_dir_all(&other).unwrap();

    let acp = manager();
    // Busy session elsewhere, idle session inside the target, on two agents.
    acp.install_test_agent_with_session_roots(
        agent("busy-elsewhere"),
        vec![("s-main".to_string(), other.clone(), true)],
    );
    acp.install_test_agent_with_session_roots(
        agent("idle-inside"),
        vec![("s-wt".to_string(), target.clone(), false)],
    );
    ensure_no_active_turn_under(&acp, &target)
        .await
        .expect("the busy session is outside the target");
}

#[tokio::test]
async fn persisted_session_cwd_counts_when_the_driver_reports_no_root() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("wt");
    std::fs::create_dir_all(&target).unwrap();
    let store = crate::acp::SessionPersistence::open(root.path().join("sessions"))
        .await
        .unwrap();
    store
        .register_session(crate::acp::SessionRegistration {
            session_id: "s1".to_string(),
            runtime_agent_id: Some("a1".to_string()),
            cwd: target.clone(),
            ..Default::default()
        })
        .await
        .unwrap();

    let acp = AcpManager::with_persistence(vec![], store.clone());
    // `install_test_agent_with_mid_turn_session` answers SessionIds +
    // IsTurnActive but not SessionRoots: the guard falls back to the
    // persisted metadata cwd.
    acp.install_test_agent_with_mid_turn_session(
        agent("a1"),
        std::collections::HashSet::from(["s1".to_string()]),
        true,
    );
    assert!(ensure_no_active_turn_under(&acp, &target).await.is_err());

    let idle_acp = AcpManager::with_persistence(vec![], store.clone());
    idle_acp.install_test_agent_with_mid_turn_session(
        agent("a1"),
        std::collections::HashSet::from(["s1".to_string()]),
        false,
    );
    ensure_no_active_turn_under(&idle_acp, &target)
        .await
        .expect("idle");
    store.shutdown().await.unwrap();
}

#[tokio::test]
async fn git_toplevel_resolves_the_work_tree_root_and_falls_back_outside_a_repo() {
    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("repo");
    let sub = repo.join("a/b");
    std::fs::create_dir_all(&sub).unwrap();
    let Some(init) = crate::trackers::git_tracker::GitTracker::run_git_command(
        repo.to_str().unwrap(),
        &["init", "-q"],
    ) else {
        return; // git cannot run on this machine
    };
    assert!(
        init.status.success(),
        "git init failed: {}",
        String::from_utf8_lossy(&init.stderr)
    );
    assert_eq!(
        std::fs::canonicalize(git_toplevel(&sub).await).unwrap(),
        std::fs::canonicalize(&repo).unwrap()
    );
    let plain = root.path().join("plain");
    std::fs::create_dir_all(&plain).unwrap();
    assert_eq!(git_toplevel(&plain).await, plain);

    // A session at the repo root blocks a checkout named from a subdirectory.
    let acp = manager();
    acp.install_test_agent_with_session_roots(
        agent("a1"),
        vec![("s1".to_string(), repo.clone(), true)],
    );
    assert!(ensure_no_active_turn_in_checkout(&acp, &sub).await.is_err());
    assert!(ensure_no_active_turn_under(&acp, &sub).await.is_ok());
}

#[tokio::test]
async fn a_session_in_a_nested_linked_worktree_does_not_block_the_enclosing_tree() {
    use crate::trackers::git_tracker::GitTracker;
    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let run = |args: &[&str]| {
        GitTracker::run_git_command(repo.to_str().unwrap(), args)
            .filter(|out| out.status.success())
            .is_some()
    };
    if !(run(&["init", "-q"])
        && run(&["config", "user.email", "t@example.com"])
        && run(&["config", "user.name", "T"])
        && run(&["config", "commit.gpgsign", "false"])
        && run(&["commit", "--allow-empty", "-qm", "init"]))
    {
        return; // git unavailable
    }
    let repo = std::fs::canonicalize(&repo).unwrap();
    let nested = repo.join(".termul/worktrees/wt");
    std::fs::create_dir_all(nested.parent().unwrap()).unwrap();
    assert!(
        GitTracker::run_git_command(
            repo.to_str().unwrap(),
            &["worktree", "add", "-q", "-b", "wt", nested.to_str().unwrap()],
        )
        .is_some_and(|out| out.status.success()),
        "git worktree add"
    );
    let nested = std::fs::canonicalize(&nested).unwrap();

    // Busy only inside the nested linked worktree.
    let acp = manager();
    acp.install_test_agent_with_session_roots(
        agent("a1"),
        vec![("s1".to_string(), nested.join("."), true)],
    );
    ensure_no_active_turn_under(&acp, &repo)
        .await
        .expect("a checkout in the main tree does not rewrite the linked worktree");
    ensure_no_active_turn_in_checkout(&acp, &repo)
        .await
        .expect("same through the checkout entry point");
    // Removing the nested worktree itself IS blocked by that session.
    assert!(ensure_no_active_turn_under(&acp, &nested).await.is_err());

    // Busy in the main tree: still blocks.
    let main_busy = manager();
    main_busy.install_test_agent_with_session_roots(
        agent("a2"),
        vec![("s2".to_string(), repo.clone(), true)],
    );
    assert!(ensure_no_active_turn_under(&main_busy, &repo).await.is_err());
}
