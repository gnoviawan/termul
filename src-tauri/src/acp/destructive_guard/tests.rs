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
