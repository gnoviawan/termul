use super::limits::{TerminalLimitError, TerminalLimitScope};
use super::*;

fn options(project: &str) -> SpawnOptions {
    SpawnOptions {
        project_id: Some(project.to_string()),
        ..Default::default()
    }
}

/// A long-lived cheap child: no shell start-up cost, dies on kill.
#[cfg(unix)]
fn sleeper(project: &str) -> SpawnOptions {
    SpawnOptions {
        project_id: Some(project.to_string()),
        program: Some("sleep".to_string()),
        args: Some(vec!["300".to_string()]),
        ..Default::default()
    }
}

fn limit_of(error: SpawnError) -> TerminalLimitError {
    match error {
        SpawnError::Limit(limit) => limit,
        other => panic!("expected a terminal limit refusal, got {other:?}"),
    }
}

/// No spawn holds a slot and the live count matches the tracked terminals.
fn assert_no_slot_leak(manager: &PtyManager, tracked: usize) {
    assert!(
        manager.pending_spawns.lock().is_empty(),
        "no in-flight reservation may outlive its spawn"
    );
    assert_eq!(manager.live_terminal_count(), tracked);
    assert_eq!(manager.get_all().len(), tracked);
}

#[tokio::test]
async fn the_per_project_cap_refuses_the_next_spawn_without_leaking_a_slot() {
    let manager = crate::web::test_pty_manager();
    manager.set_max_terminals_per_project(2);
    let first = manager.spawn(options("a"), None).await.expect("first");
    let second = manager.spawn(options("a"), None).await.expect("second");

    let refused = manager.spawn(options("a"), None).await.unwrap_err();
    assert_eq!(refused.code(), TERMINAL_LIMIT_CODE);
    let limit = limit_of(refused);
    assert_eq!(limit.scope, TerminalLimitScope::Project);
    assert_eq!((limit.per_project, limit.global), (2, GLOBAL_TERMINAL_LIMIT));
    assert_no_slot_leak(&manager, 2);
    // A refused spawn issued no claim: only the two live terminals have one.
    assert_eq!(manager.claims.generation(&first.info.id), Some(0));
    assert_eq!(manager.claims.generation(&second.info.id), Some(0));

    manager.force_kill(&first.info.id).await.unwrap();
    manager.force_kill(&second.info.id).await.unwrap();
}

#[tokio::test]
async fn the_refusal_names_both_limits() {
    let manager = crate::web::test_pty_manager();
    manager.set_max_terminals_per_project(1);
    let held = manager.spawn(options("a"), None).await.expect("held");

    let message = manager.spawn(options("a"), None).await.unwrap_err().to_string();
    assert!(message.contains("1 per project"), "{message}");
    assert!(message.contains(&format!("{GLOBAL_TERMINAL_LIMIT} total")), "{message}");

    manager.force_kill(&held.info.id).await.unwrap();
}

#[tokio::test]
async fn a_full_project_does_not_limit_another_project() {
    let manager = crate::web::test_pty_manager();
    manager.set_max_terminals_per_project(1);
    let a = manager.spawn(options("a"), None).await.expect("a");

    assert!(manager.spawn(options("a"), None).await.is_err());
    let b = manager.spawn(options("b"), None).await.expect("another project is unaffected");

    manager.force_kill(&a.info.id).await.unwrap();
    manager.force_kill(&b.info.id).await.unwrap();
}

#[tokio::test]
async fn killing_a_terminal_frees_its_slot() {
    let manager = crate::web::test_pty_manager();
    manager.set_max_terminals_per_project(1);
    let first = manager.spawn(options("a"), None).await.expect("first");
    assert!(manager.spawn(options("a"), None).await.is_err());

    manager.force_kill(&first.info.id).await.unwrap();
    assert_no_slot_leak(&manager, 0);
    let again = manager.spawn(options("a"), None).await.expect("slot is free");

    manager.force_kill(&again.info.id).await.unwrap();
}

#[tokio::test]
async fn a_failed_spawn_frees_its_slot() {
    let manager = crate::web::test_pty_manager();
    manager.set_max_terminals_per_project(1);
    let missing = std::env::temp_dir().join(format!("termul-no-such-dir-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&missing);

    let failed = manager
        .spawn(
            SpawnOptions {
                cwd: Some(missing.to_string_lossy().into_owned()),
                ..options("a")
            },
            None,
        )
        .await
        .unwrap_err();
    assert!(matches!(failed, SpawnError::Failed(_)), "{failed:?}");
    assert_eq!(failed.code(), "SPAWN_FAILED");
    assert_no_slot_leak(&manager, 0);

    // The failure held nothing: the single slot is still available.
    let ok = manager.spawn(options("a"), None).await.expect("slot is free");
    manager.force_kill(&ok.info.id).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_spawns_never_exceed_the_cap() {
    let manager = crate::web::test_pty_manager();
    manager.set_max_terminals_per_project(3);

    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..8 {
        let manager = Arc::clone(&manager);
        tasks.spawn(async move { manager.spawn(options("a"), None).await });
    }
    let mut spawned = Vec::new();
    let mut refused = 0;
    while let Some(joined) = tasks.join_next().await {
        match joined.unwrap() {
            Ok(terminal) => spawned.push(terminal.info.id),
            Err(error) => {
                limit_of(error);
                refused += 1;
            }
        }
    }
    assert_eq!((spawned.len(), refused), (3, 5));
    assert_no_slot_leak(&manager, 3);

    for id in spawned {
        manager.force_kill(&id).await.unwrap();
    }
}

#[cfg(unix)]
#[tokio::test]
async fn the_global_cap_refuses_the_thirty_first_terminal() {
    let manager = crate::web::test_pty_manager();
    manager.set_max_terminals_per_project(GLOBAL_TERMINAL_LIMIT);
    let mut ids = Vec::new();
    for index in 0..GLOBAL_TERMINAL_LIMIT {
        // Spread over projects, with some terminals bound to none at all.
        let spawn_options = if index % 5 == 0 {
            SpawnOptions {
                program: Some("sleep".to_string()),
                args: Some(vec!["300".to_string()]),
                ..Default::default()
            }
        } else {
            sleeper(&format!("project-{}", index % 3))
        };
        ids.push(manager.spawn(spawn_options, None).await.expect("under the cap").info.id);
    }

    let limit = limit_of(manager.spawn(sleeper("fresh"), None).await.unwrap_err());
    assert_eq!(limit.scope, TerminalLimitScope::Global);
    assert!(manager.is_limit_reached());
    assert_no_slot_leak(&manager, GLOBAL_TERMINAL_LIMIT);

    manager.force_kill(&ids.pop().unwrap()).await.unwrap();
    assert!(!manager.is_limit_reached());
    let replacement = manager.spawn(sleeper("fresh"), None).await.expect("slot is free");
    ids.push(replacement.info.id);

    for id in ids {
        manager.force_kill(&id).await.unwrap();
    }
}

#[cfg(unix)]
#[tokio::test]
async fn an_exited_terminal_that_is_still_tracked_counts_toward_no_cap() {
    let manager = crate::web::test_pty_manager();
    manager.set_max_terminals_per_project(1);
    let exiting = manager
        .spawn(
            SpawnOptions {
                project_id: Some("a".to_string()),
                program: Some("sh".to_string()),
                args: Some(vec!["-c".to_string(), "exit 0".to_string()]),
                ..Default::default()
            },
            None,
        )
        .await
        .expect("spawn");
    let instance = manager.get(&exiting.info.id).expect("tracked");
    for _ in 0..100 {
        if instance.has_exited() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(instance.has_exited(), "the short-lived child exits");

    // Still tracked and attachable, but its slot is free.
    assert_eq!(manager.get_all().len(), 1);
    assert_eq!(manager.live_terminal_count(), 0);
    let next = manager.spawn(sleeper("a"), None).await.expect("exited PTY holds no slot");

    manager.force_kill(&exiting.info.id).await.unwrap();
    manager.force_kill(&next.info.id).await.unwrap();
}

#[tokio::test]
async fn the_per_project_cap_counts_detached_terminals_and_the_listing_returns_them() {
    let manager = crate::web::test_pty_manager();
    manager.set_max_terminals_per_project(2);
    let one = manager.spawn(options("a"), None).await.expect("one");
    let two = manager.spawn(options("a"), None).await.expect("two");
    let other = manager.spawn(options("b"), None).await.expect("other");

    // Nothing is attached (a closed pane only detaches): both still count and
    // both are listed, while a refused spawn adds nothing to the listing.
    assert!(!manager.get(&one.info.id).unwrap().has_live_attachment());
    assert!(manager.spawn(options("a"), None).await.is_err());
    let mut listed: Vec<String> = manager
        .list_preserved("a")
        .into_iter()
        .map(|terminal| terminal.info.id)
        .collect();
    listed.sort();
    let mut expected = vec![one.info.id.clone(), two.info.id.clone()];
    expected.sort();
    assert_eq!(listed, expected);
    assert_eq!(manager.list_preserved("b").len(), 1);

    for id in [&one.info.id, &two.info.id, &other.info.id] {
        manager.force_kill(id).await.unwrap();
    }
}

#[tokio::test]
async fn a_refused_spawn_emits_no_terminal_event() {
    let manager = crate::web::test_pty_manager();
    manager.set_max_terminals_per_project(1);
    let held = manager.spawn(options("a"), None).await.expect("held");
    let mut events = manager.terminal_events().subscribe();
    while events.try_recv().is_ok() {}

    assert!(manager.spawn(options("a"), None).await.is_err());
    assert!(events.try_recv().is_err(), "a refusal publishes nothing");

    manager.force_kill(&held.info.id).await.unwrap();
}

#[test]
fn the_per_project_cap_has_a_floor_of_one() {
    let manager = crate::web::test_pty_manager();
    assert_eq!(
        manager.max_terminals_per_project(),
        crate::web::config::DEFAULT_MAX_TERMINALS_PER_PROJECT
    );
    manager.set_max_terminals_per_project(0);
    assert_eq!(manager.max_terminals_per_project(), 1);
}
