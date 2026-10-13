//! PTY lifetime rule: a live PTY ends only by an explicit kill, a process exit
//! or host shutdown. Detaching never ends it; an exited PTY expires by TTL.

use super::*;

fn project_options(project: &str) -> SpawnOptions {
    SpawnOptions {
        project_id: Some(project.to_string()),
        program: Some("sleep".to_string()),
        args: Some(vec!["300".to_string()]),
        ..Default::default()
    }
}

fn echo_then_exit(project: &str) -> SpawnOptions {
    SpawnOptions {
        project_id: Some(project.to_string()),
        program: Some("sh".to_string()),
        args: Some(vec!["-c".to_string(), "echo lifetime-marker".to_string()]),
        ..Default::default()
    }
}

async fn wait_for_exit(instance: &TerminalInstance) {
    for _ in 0..100 {
        if instance.has_exited() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("the short-lived child never exited");
}

#[cfg(unix)]
#[tokio::test]
async fn a_live_detached_pty_is_never_swept_however_old() {
    let manager = crate::web::test_pty_manager();
    let spawned = manager
        .spawn(project_options("a"), None)
        .await
        .expect("spawn");
    let instance = manager.get(&spawned.info.id).expect("tracked");
    assert!(!instance.has_web_attachment(), "nobody is attached");

    // A zero TTL is the harshest possible window: any age exceeds it.
    tokio::time::sleep(Duration::from_millis(60)).await;
    let removed = manager.exit_sweep().remove_expired(Duration::ZERO).await;

    assert!(removed.is_empty());
    assert!(manager.get(&spawned.info.id).is_some());
    assert!(!instance.has_exited());
    assert_eq!(manager.live_terminal_count(), 1);
    assert_eq!(manager.list_preserved("a").len(), 1);

    manager.force_kill(&spawned.info.id).await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn closing_a_pane_only_drops_the_attachment() {
    let manager = crate::web::test_pty_manager();
    let spawned = manager
        .spawn(project_options("a"), None)
        .await
        .expect("spawn");
    let instance = manager.get(&spawned.info.id).expect("tracked");

    instance.add_web_attachment();
    instance.add_web_attachment();
    instance.remove_web_attachment();
    assert!(
        instance.has_web_attachment(),
        "a second viewer is still attached"
    );
    instance.remove_web_attachment();

    assert!(!instance.has_web_attachment());
    assert!(!instance.has_exited());
    assert!(manager.get(&spawned.info.id).is_some());
    assert_eq!(manager.live_terminal_count(), 1);
    // Removing more than was added never underflows the count.
    instance.remove_web_attachment();
    assert!(!instance.has_web_attachment());

    manager.force_kill(&spawned.info.id).await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn an_exited_pty_keeps_its_output_until_the_ttl_then_expires() {
    let manager = crate::web::test_pty_manager();
    let spawned = manager
        .spawn(echo_then_exit("a"), None)
        .await
        .expect("spawn");
    let id = spawned.info.id.clone();
    let instance = manager.get(&id).expect("tracked");
    wait_for_exit(&instance).await;
    assert!(instance.exited_for().is_some());

    // Within the TTL it stays tracked and a late client replays its output.
    let removed = manager
        .exit_sweep()
        .remove_expired(Duration::from_secs(600))
        .await;
    assert!(removed.is_empty());
    assert!(manager.get(&id).is_some());
    let replay = instance.subscribe_from(0, None);
    let output: Vec<u8> = replay.chunks.iter().flat_map(|c| c.data.clone()).collect();
    assert!(
        String::from_utf8_lossy(&output).contains("lifetime-marker"),
        "an exited PTY still replays its output within the TTL"
    );
    assert_eq!(manager.list_preserved("a").len(), 1);
    assert_eq!(manager.live_terminal_count(), 0);

    // Past the TTL it is removed and every per-terminal record goes with it.
    tokio::time::sleep(Duration::from_millis(80)).await;
    let removed = manager
        .exit_sweep()
        .remove_expired(Duration::from_millis(40))
        .await;
    assert_eq!(removed, vec![id.clone()]);
    assert!(manager.get(&id).is_none());
    assert!(manager.claims.generation(&id).is_none());
    assert_eq!(manager.get_count(), 0);
    assert_eq!(manager.live_terminal_count(), 0);
    assert!(manager.pending_spawns.lock().is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn the_sweep_removes_only_the_exited_pty_and_frees_no_live_slot() {
    let manager = crate::web::test_pty_manager();
    manager.set_max_terminals_per_project(2);
    let live = manager
        .spawn(project_options("a"), None)
        .await
        .expect("live");
    let exiting = manager
        .spawn(echo_then_exit("a"), None)
        .await
        .expect("exiting");
    wait_for_exit(&manager.get(&exiting.info.id).unwrap()).await;
    tokio::time::sleep(Duration::from_millis(60)).await;

    let removed = manager.exit_sweep().remove_expired(Duration::ZERO).await;

    assert_eq!(removed, vec![exiting.info.id.clone()]);
    assert!(manager.get(&live.info.id).is_some());
    // The exited PTY held no slot, so removing it changes no live count and
    // a project at 1 live of 2 still accepts exactly one more.
    assert_eq!(manager.live_terminal_count(), 1);
    let next = manager
        .spawn(project_options("a"), None)
        .await
        .expect("room");
    assert!(manager.spawn(project_options("a"), None).await.is_err());

    manager.force_kill(&live.info.id).await.unwrap();
    manager.force_kill(&next.info.id).await.unwrap();
}
