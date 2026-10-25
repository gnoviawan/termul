//! #1300: closing a terminal must not wait on the PTY teardown chain. `kill`
//! and `force_kill` detach the terminal from the registry and signal its child
//! synchronously, then run the slow teardown (child-exit poll, reader/flusher
//! joins, tracker cleanup) on a background task. `kill_all` (app-exit safety
//! net) stays synchronous.

use super::*;

fn long_lived(project: &str) -> SpawnOptions {
    SpawnOptions {
        project_id: Some(project.to_string()),
        program: Some("sleep".to_string()),
        args: Some(vec!["300".to_string()]),
        ..Default::default()
    }
}

/// Swap the real reader thread for one that sleeps `delay`, forcing the
/// teardown's reader join to take a known, observable amount of time. The real
/// reader handle is dropped (detached); its thread still exits on its own once
/// the child is killed and the PTY hits EOF, so nothing leaks.
async fn make_teardown_slow(instance: &TerminalInstance, delay: Duration) {
    let slow = std::thread::spawn(move || std::thread::sleep(delay));
    *instance.reader_handle.lock().await = Some(slow);
}

/// Poll until `cond` holds or the timeout elapses; returns whether it held.
async fn eventually<F>(timeout: Duration, mut cond: F) -> bool
where
    F: FnMut() -> bool,
{
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if cond() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    cond()
}

#[cfg(unix)]
#[tokio::test]
async fn kill_returns_before_the_teardown_finishes_and_detaches_immediately() {
    let manager = crate::web::test_pty_manager();
    let spawned = manager.spawn(long_lived("a"), None).await.expect("spawn");
    let id = spawned.info.id.clone();
    let instance = manager.get(&id).expect("tracked");

    // A teardown that would block for 1.5s if the caller awaited it.
    make_teardown_slow(&instance, Duration::from_millis(1500)).await;

    let started = Instant::now();
    manager.kill(&id).await.expect("kill");
    let kill_elapsed = started.elapsed();

    // The caller returns promptly — it no longer awaits the teardown join.
    assert!(
        kill_elapsed < Duration::from_millis(500),
        "kill blocked on the teardown: {kill_elapsed:?}"
    );

    // The terminal is already gone: unlisted, uncounted and unattachable.
    assert!(manager.get(&id).is_none());
    assert_eq!(manager.live_terminal_count(), 0);
    assert_eq!(manager.get_count(), 0);
    assert!(manager.list_preserved("a", None).is_empty());

    // The background teardown still completes: it joins the (slow) reader
    // thread, reaps the child and clears the claim record.
    assert!(
        eventually(Duration::from_secs(10), || manager
            .claims
            .generation(&id)
            .is_none())
        .await,
        "the background teardown never finished"
    );
    assert!(
        instance.reader_handle.lock().await.is_none(),
        "reader thread not joined"
    );
    assert!(instance.child.lock().await.is_none(), "child not reaped");
}

#[cfg(unix)]
#[tokio::test]
async fn force_kill_returns_before_the_teardown_finishes_and_detaches_immediately() {
    let manager = crate::web::test_pty_manager();
    let spawned = manager.spawn(long_lived("a"), None).await.expect("spawn");
    let id = spawned.info.id.clone();
    let instance = manager.get(&id).expect("tracked");

    make_teardown_slow(&instance, Duration::from_millis(1500)).await;

    let started = Instant::now();
    manager.force_kill(&id).await.expect("force_kill");
    let kill_elapsed = started.elapsed();

    assert!(
        kill_elapsed < Duration::from_millis(500),
        "force_kill blocked on the teardown: {kill_elapsed:?}"
    );
    assert!(manager.get(&id).is_none());
    assert_eq!(manager.live_terminal_count(), 0);
    assert!(manager.list_preserved("a", None).is_empty());

    assert!(
        eventually(Duration::from_secs(10), || manager
            .claims
            .generation(&id)
            .is_none())
        .await,
        "the background teardown never finished"
    );
    assert!(
        instance.reader_handle.lock().await.is_none(),
        "reader thread not joined"
    );
}

/// Unknown ids still fail fast on both paths (the detach is driven by removal
/// from the registry, so a missing terminal is an error, not a silent no-op).
#[cfg(unix)]
#[tokio::test]
async fn killing_an_unknown_terminal_still_errors() {
    let manager = crate::web::test_pty_manager();
    assert!(manager.kill("nope").await.is_err());
    assert!(manager.force_kill("nope").await.is_err());
}

/// `kill_all` is the app-exit safety net: it must still WAIT for each
/// terminal's teardown so processes and threads are gone before the app exits.
#[cfg(unix)]
#[tokio::test]
async fn kill_all_still_waits_for_the_teardown() {
    let manager = crate::web::test_pty_manager();
    let spawned = manager.spawn(long_lived("a"), None).await.expect("spawn");
    let id = spawned.info.id.clone();
    let instance = manager.get(&id).expect("tracked");

    make_teardown_slow(&instance, Duration::from_millis(800)).await;

    let started = Instant::now();
    manager.kill_all().await;
    let elapsed = started.elapsed();

    // kill_all awaited the slow reader join, so by the time it returns the
    // teardown has already finished.
    assert!(
        elapsed >= Duration::from_millis(600),
        "kill_all returned before the teardown it must wait for: {elapsed:?}"
    );
    assert!(
        instance.reader_handle.lock().await.is_none(),
        "kill_all returned before joining the reader thread"
    );
    assert!(manager.get(&id).is_none());
    assert_eq!(manager.get_count(), 0);
}

/// `kill_all` also waits for teardowns already detached by `kill`, so exit
/// does not cut one off mid-join.
#[cfg(unix)]
#[tokio::test]
async fn kill_all_waits_for_teardowns_detached_by_kill() {
    let manager = crate::web::test_pty_manager();
    let spawned = manager.spawn(long_lived("a"), None).await.expect("spawn");
    let id = spawned.info.id.clone();
    let instance = manager.get(&id).expect("tracked");

    make_teardown_slow(&instance, Duration::from_millis(800)).await;
    manager.kill(&id).await.expect("kill");

    manager.kill_all().await;

    assert!(
        instance.reader_handle.lock().await.is_none(),
        "kill_all returned before the detached teardown joined the reader"
    );
    assert!(manager.claims.generation(&id).is_none());
}
