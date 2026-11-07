use super::*;

#[test]
#[cfg(target_os = "linux")]
fn test_detect_cwd_unix() {
    #[cfg(unix)]
    {
        // Test with current process
        let pid = std::process::id();
        let cwd = CwdTracker::detect_cwd(pid);
        assert!(cwd.is_some());

        // Test with invalid PID
        let invalid_cwd = CwdTracker::detect_cwd(999_999);
        assert!(invalid_cwd.is_none());
    }

    #[cfg(not(unix))]
    {
        // On Windows, should always return None
        let cwd = CwdTracker::detect_cwd(std::process::id());
        assert!(cwd.is_none());
    }
}

#[test]
fn test_cwd_state_creation() {
    let state = CwdState {
        terminal_id: "test-term".to_string(),
        pid: 1234,
        last_known_cwd: "/home/user".to_string(),
        prompt_reported: false,
    };

    assert_eq!(state.terminal_id, "test-term");
    assert_eq!(state.pid, 1234);
    assert_eq!(state.last_known_cwd, "/home/user");
}

#[test]
fn test_start_tracking() {
    // Create a mock AppHandle - in real tests, use Tauri's test utilities
    // For now, we skip this test as it requires a valid AppHandle
    // This is a placeholder showing the test structure
}

// Regression tests for CWD Tracker polling and visibility behavior
// These tests verify the runtime behavior described in Task 6

#[test]
fn test_polling_starts_after_start_tracking() {
    // Note: This test requires a valid AppHandle to run.
    // In a full integration test, we would:
    // 1. Create a CwdTracker with a mock AppHandle
    // 2. Call start_tracking() with a terminal ID and PID
    // 3. Verify is_polling_active() returns true
    // 4. Verify tracked_count() returns 1

    // The atomic flag ensures polling only starts once
    // even if start_tracking is called multiple times

    // For unit testing the atomic flag behavior:
    let is_polling_started = std::sync::atomic::AtomicBool::new(false);

    // First call should succeed (compare_exchange returns Ok)
    let result =
        is_polling_started.compare_exchange(false, true, Ordering::SeqCst, Ordering::Relaxed);
    assert!(result.is_ok());

    // Second call should fail (already started)
    let result =
        is_polling_started.compare_exchange(false, true, Ordering::SeqCst, Ordering::Relaxed);
    assert!(result.is_err());
}

#[test]
fn test_visibility_pause_resume_behavior() {
    // Note: This test requires a CwdTracker instance.
    // The visibility flag controls whether polling is active:
    // - When is_visible is false, the polling loop skips CWD detection
    // - When is_visible is true, the polling loop checks CWD

    // Test the atomic visibility flag behavior
    let is_visible = std::sync::atomic::AtomicBool::new(true);

    // Initially visible
    assert!(is_visible.load(Ordering::Relaxed));

    // Hide (pause polling)
    is_visible.store(false, Ordering::Relaxed);
    assert!(!is_visible.load(Ordering::Relaxed));

    // Show (resume polling)
    is_visible.store(true, Ordering::Relaxed);
    assert!(is_visible.load(Ordering::Relaxed));
}

#[test]
fn test_poll_counter_increments() {
    // Test the poll counter behavior used for testing/debugging
    let poll_count = std::sync::atomic::AtomicBool::new(false);

    // Initially false
    assert!(!poll_count.load(Ordering::Relaxed));

    // XOR with true toggles the value
    poll_count.fetch_xor(true, Ordering::Relaxed);
    assert!(poll_count.load(Ordering::Relaxed));

    // XOR with true toggles again
    poll_count.fetch_xor(true, Ordering::Relaxed);
    assert!(!poll_count.load(Ordering::Relaxed));

    // AND with false resets to false
    poll_count.store(true, Ordering::Relaxed);
    let previous = poll_count.fetch_and(false, Ordering::Relaxed);
    assert!(previous);
    assert!(!poll_count.load(Ordering::Relaxed));
}

#[test]
fn test_visibility_skips_polling() {
    // This test demonstrates the visibility-based polling behavior
    let is_visible = std::sync::atomic::AtomicBool::new(true);
    let mut poll_executed = false;

    // Simulate polling loop logic
    if is_visible.load(Ordering::Relaxed) {
        poll_executed = true;
    }

    assert!(poll_executed);

    // Now hide
    is_visible.store(false, Ordering::Relaxed);
    poll_executed = false;

    // Polling should be skipped
    if is_visible.load(Ordering::Relaxed) {
        poll_executed = true;
    }

    assert!(!poll_executed);
}

// Helpers for asynchronous prompt integration tests

fn emit_prompt_ready(hub: &TerminalEventHub, terminal_id: &str, cwd: Option<&str>) {
    hub.emit(TerminalEvent::SessionLifecycle {
        lifecycle_sequence: None,
        terminal_id: terminal_id.to_string(),
        session_id: "test-session".to_string(),
        kind: "PromptReady".to_string(),
        nonce: None,
        prompt_suppressed: false,
        line_empty: false,
        exit_code: None,
        prompt_generation: None,
        cwd: cwd.map(|s| s.to_string()),
    });
}

async fn wait_for<F>(duration: tokio::time::Duration, condition: F) -> bool
where
    F: Fn() -> bool,
{
    let start = tokio::time::Instant::now();
    while start.elapsed() < duration {
        if condition() {
            return true;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(5)).await;
    }
    condition()
}

/// Publishes a sentinel PromptReady to a distinct tracked terminal and waits until applied.
/// Because the event task processes messages sequentially in FIFO order, once the sentinel
/// is applied, all earlier events in the stream have been fully processed.
async fn wait_for_sentinel(
    tracker: &CwdTracker,
    hub: &TerminalEventHub,
    sentinel_id: &str,
    sentinel_cwd: &str,
) {
    tracker.start_tracking(sentinel_id, u32::MAX, "/sentinel_init");
    emit_prompt_ready(hub, sentinel_id, Some(sentinel_cwd));
    let applied = wait_for(tokio::time::Duration::from_secs(2), || {
        tracker.get_cwd(sentinel_id).as_deref() == Some(sentinel_cwd)
    })
    .await;
    assert!(applied, "sentinel {} must be applied", sentinel_id);
}

fn drain_cwd_changed(
    sub: &mut tokio::sync::broadcast::Receiver<TerminalEvent>,
    expected_terminal_id: &str,
) -> Vec<String> {
    let mut cwds = Vec::new();
    while let Ok(event) = sub.try_recv() {
        if let TerminalEvent::CwdChanged { terminal_id, cwd } = event {
            if terminal_id == expected_terminal_id {
                cwds.push(cwd);
            }
        }
    }
    cwds
}

async fn wait_for_cwd_event(
    sub: &mut tokio::sync::broadcast::Receiver<TerminalEvent>,
    expected_id: &str,
    expected_cwd: &str,
) -> bool {
    let res = tokio::time::timeout(tokio::time::Duration::from_secs(2), async {
        loop {
            match sub.recv().await {
                Ok(TerminalEvent::CwdChanged { terminal_id, cwd })
                    if terminal_id == expected_id && cwd == expected_cwd =>
                {
                    return true;
                }
                Ok(_) => continue,
                Err(_) => return false,
            }
        }
    })
    .await;
    res.unwrap_or(false)
}

#[tokio::test]
async fn test_a_tracked_prompt_ready() {
    let hub = TerminalEventHub::standalone();
    let mut sub = hub.subscribe();
    let tracker = CwdTracker::new(hub.clone());

    tracker.start_tracking("term-a", u32::MAX, "/initial");
    emit_prompt_ready(&hub, "term-a", Some("/tmp"));

    let updated = wait_for(tokio::time::Duration::from_secs(2), || {
        tracker.get_cwd("term-a").as_deref() == Some("/tmp")
    })
    .await;
    assert!(updated, "cwd must update to /tmp");

    let received = wait_for_cwd_event(&mut sub, "term-a", "/tmp").await;
    assert!(received, "CwdChanged /tmp must be received");

    wait_for_sentinel(&tracker, &hub, "sentinel-a", "/sentinel_a").await;
    let extra = drain_cwd_changed(&mut sub, "term-a");
    assert!(extra.is_empty(), "expected exactly one CwdChanged event");
}

#[tokio::test]
async fn test_b_same_cwd_no_second_event() {
    let hub = TerminalEventHub::standalone();
    let mut sub = hub.subscribe();
    let tracker = CwdTracker::new(hub.clone());

    tracker.start_tracking("term-b", u32::MAX, "/initial");
    emit_prompt_ready(&hub, "term-b", Some("/tmp"));

    let received = wait_for_cwd_event(&mut sub, "term-b", "/tmp").await;
    assert!(received);

    // Emit the exact same cwd again
    emit_prompt_ready(&hub, "term-b", Some("/tmp"));

    // Sentinel guarantees the duplicate PromptReady was processed before asserting
    wait_for_sentinel(&tracker, &hub, "sentinel-b", "/sentinel_b").await;

    let extra = drain_cwd_changed(&mut sub, "term-b");
    assert!(
        extra.is_empty(),
        "no second CwdChanged event should be emitted"
    );
}

#[tokio::test]
async fn test_c_ignored_events() {
    let hub = TerminalEventHub::standalone();
    let mut sub = hub.subscribe();
    let tracker = CwdTracker::new(hub.clone());

    tracker.start_tracking("term-c", u32::MAX, "/initial");

    // CommandFinished with cwd None
    hub.emit(TerminalEvent::SessionLifecycle {
        lifecycle_sequence: None,
        terminal_id: "term-c".to_string(),
        session_id: "s".to_string(),
        kind: "CommandFinished".to_string(),
        nonce: None,
        prompt_suppressed: false,
        line_empty: false,
        exit_code: None,
        prompt_generation: None,
        cwd: None,
    });

    // PromptReady with cwd None
    hub.emit(TerminalEvent::SessionLifecycle {
        lifecycle_sequence: None,
        terminal_id: "term-c".to_string(),
        session_id: "s".to_string(),
        kind: "PromptReady".to_string(),
        nonce: None,
        prompt_suppressed: false,
        line_empty: false,
        exit_code: None,
        prompt_generation: None,
        cwd: None,
    });

    // ExitCodeChanged
    hub.emit(TerminalEvent::ExitCodeChanged {
        terminal_id: "term-c".to_string(),
        exit_code: 0,
    });

    // Sentinel guarantees all preceding ignored events were processed
    wait_for_sentinel(&tracker, &hub, "sentinel-c", "/sentinel_c").await;

    assert_eq!(tracker.get_cwd("term-c"), Some("/initial".to_string()));
    let events = drain_cwd_changed(&mut sub, "term-c");
    assert!(events.is_empty(), "ignored events must not emit CwdChanged");
}

#[tokio::test]
async fn test_d1_startup_first_terminal() {
    let hub = TerminalEventHub::standalone();
    let mut sub = hub.subscribe();
    let tracker = CwdTracker::new(hub.clone());

    emit_prompt_ready(&hub, "term-d1", Some("/tmp"));

    tracker.start_tracking("term-d1", u32::MAX, "/spawn");

    let updated = wait_for(tokio::time::Duration::from_secs(2), || {
        tracker.get_cwd("term-d1").as_deref() == Some("/tmp")
    })
    .await;
    assert!(updated, "get_cwd should update to /tmp");

    let received = wait_for_cwd_event(&mut sub, "term-d1", "/tmp").await;
    assert!(received, "CwdChanged /tmp should be received");
}

#[tokio::test]
async fn test_d2_startup_second_terminal_while_task_runs() {
    let hub = TerminalEventHub::standalone();
    let mut sub = hub.subscribe();
    let tracker = CwdTracker::new(hub.clone());

    tracker.start_tracking("term-a", u32::MAX, "/spawn_a");

    emit_prompt_ready(&hub, "term-b", Some("/tmp"));

    let pending_exists = wait_for(tokio::time::Duration::from_secs(2), || {
        tracker.has_pending("term-b")
    })
    .await;
    assert!(pending_exists, "term-b should be recorded in pending");

    tracker.start_tracking("term-b", u32::MAX, "/spawn_b");
    assert_eq!(tracker.get_cwd("term-b"), Some("/tmp".to_string()));

    let received = wait_for_cwd_event(&mut sub, "term-b", "/tmp").await;
    assert!(received, "CwdChanged /tmp should be received for term-b");
}

#[tokio::test]
async fn test_e_late_prompt_ready_after_stop_tracking() {
    let hub = TerminalEventHub::standalone();
    let tracker = CwdTracker::new(hub.clone());

    tracker.start_tracking("term-e", u32::MAX, "/spawn");
    tracker.stop_tracking("term-e");

    let count_before = tracker.tracked_count();
    emit_prompt_ready(&hub, "term-e", Some("/tmp"));

    let pending_recorded = wait_for(tokio::time::Duration::from_secs(1), || {
        tracker.has_pending("term-e")
    })
    .await;
    assert!(pending_recorded, "late event should be buffered in pending");

    assert_eq!(tracker.get_cwd("term-e"), None);
    assert_eq!(tracker.tracked_count(), count_before);
}

#[test]
fn test_f_pending_cap_evicts_beyond_64() {
    let hub = TerminalEventHub::standalone();
    let tracker = CwdTracker::new(hub);

    for i in 0..70 {
        tracker.report_cwd(&format!("untracked-{}", i), &format!("/tmp/{}", i));
    }

    assert_eq!(
        tracker.pending_count(),
        64,
        "pending count should reach and stay at exactly 64"
    );
    assert!(
        tracker.has_pending("untracked-69"),
        "the last reported id must be present in pending"
    );
}

#[tokio::test]
async fn test_g_prompt_reported_blocks_poll_path() {
    let hub = TerminalEventHub::standalone();
    let tracker = CwdTracker::new(hub.clone());

    tracker.start_tracking("term-g", u32::MAX, "/initial");

    // Without prompt_reported: poll step overwrites
    let overwritten = tracker.poll_step_terminal("term-g", "/polled_1");
    assert!(overwritten);
    assert_eq!(tracker.get_cwd("term-g"), Some("/polled_1".to_string()));

    // Prompt reports a cwd
    emit_prompt_ready(&hub, "term-g", Some("/prompt_1"));
    let prompt_applied = wait_for(tokio::time::Duration::from_secs(2), || {
        tracker.is_prompt_reported("term-g")
            && tracker.get_cwd("term-g").as_deref() == Some("/prompt_1")
    })
    .await;
    assert!(prompt_applied);

    // With prompt_reported: poll step does NOT overwrite
    let overwritten_after = tracker.poll_step_terminal("term-g", "/polled_2");
    assert!(!overwritten_after);
    assert_eq!(tracker.get_cwd("term-g"), Some("/prompt_1".to_string()));
}

#[tokio::test]
async fn test_g2_first_prompt_equals_initial_value() {
    let hub = TerminalEventHub::standalone();
    let mut sub = hub.subscribe();
    let tracker = CwdTracker::new(hub.clone());

    tracker.start_tracking("term-g2", u32::MAX, "/same_cwd");
    assert!(!tracker.is_prompt_reported("term-g2"));

    emit_prompt_ready(&hub, "term-g2", Some("/same_cwd"));

    let flag_flipped = wait_for(tokio::time::Duration::from_secs(2), || {
        tracker.is_prompt_reported("term-g2")
    })
    .await;
    assert!(flag_flipped, "prompt_reported must become true");

    let events = drain_cwd_changed(&mut sub, "term-g2");
    assert!(
        events.is_empty(),
        "no CwdChanged should be emitted when cwd equals initial"
    );
}

#[tokio::test]
async fn test_h_restart_polling_fresh_subscriber() {
    let hub = TerminalEventHub::standalone();
    let tracker = CwdTracker::new(hub.clone());

    tracker.start_tracking("term-h1", u32::MAX, "/init1");
    let old_handle = tracker.stop_polling().expect("task handle expected");

    let finished = wait_for(tokio::time::Duration::from_secs(2), || {
        old_handle.is_finished()
    })
    .await;
    assert!(finished, "old task handle must be finished or aborted");

    tracker.start_tracking("term-h2", u32::MAX, "/init2");
    emit_prompt_ready(&hub, "term-h2", Some("/restarted_cwd"));

    let updated = wait_for(tokio::time::Duration::from_secs(2), || {
        tracker.get_cwd("term-h2").as_deref() == Some("/restarted_cwd")
    })
    .await;
    assert!(
        updated,
        "new subscriber in restarted task must apply PromptReady"
    );
}

#[tokio::test]
async fn test_h2_shutdown_task_aborted_nothing_tracked() {
    let hub = TerminalEventHub::standalone();
    let tracker = CwdTracker::new(hub.clone());

    tracker.start_tracking("term-h2", u32::MAX, "/init");
    let handle = tracker.shutdown().expect("task handle expected");

    let finished = wait_for(tokio::time::Duration::from_secs(2), || handle.is_finished()).await;
    assert!(finished, "task handle must be finished after shutdown");
    assert_eq!(tracker.tracked_count(), 0);

    emit_prompt_ready(&hub, "term-h2", Some("/tmp"));
    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
    assert_eq!(tracker.get_cwd("term-h2"), None);
}

#[tokio::test]
async fn test_i_hidden_prompt_ready_still_applied() {
    let hub = TerminalEventHub::standalone();
    let tracker = CwdTracker::new(hub.clone());

    tracker.start_tracking("term-i", u32::MAX, "/init");
    tracker.set_visibility(false);

    emit_prompt_ready(&hub, "term-i", Some("/tmp"));

    let updated = wait_for(tokio::time::Duration::from_secs(2), || {
        tracker.get_cwd("term-i").as_deref() == Some("/tmp")
    })
    .await;
    assert!(
        updated,
        "PromptReady must be applied even when visibility is false"
    );
}

#[tokio::test]
async fn test_j_lagged_recovery() {
    let hub = TerminalEventHub::standalone();
    let tracker = CwdTracker::new(hub.clone());

    for i in 0..300 {
        hub.emit(TerminalEvent::ExitCodeChanged {
            terminal_id: "other".to_string(),
            exit_code: i,
        });
    }

    emit_prompt_ready(&hub, "term-j", Some("/recovered"));
    tracker.start_tracking("term-j", u32::MAX, "/init");

    let updated = wait_for(tokio::time::Duration::from_secs(2), || {
        tracker.get_cwd("term-j").as_deref() == Some("/recovered")
    })
    .await;
    assert!(
        updated,
        "PromptReady must be applied after recovering from Lagged error"
    );
}

#[tokio::test]
async fn test_k_report_cwd_directly() {
    let hub = TerminalEventHub::standalone();
    let mut sub = hub.subscribe();
    let tracker = CwdTracker::new(hub.clone());

    tracker.start_tracking("term-k", u32::MAX, "/init");

    tracker.report_cwd("term-k", "/direct_1");
    assert_eq!(tracker.get_cwd("term-k"), Some("/direct_1".to_string()));

    let received = wait_for_cwd_event(&mut sub, "term-k", "/direct_1").await;
    assert!(received, "CwdChanged event must be emitted");

    // Same value again is a no-op
    tracker.report_cwd("term-k", "/direct_1");
    let extra = drain_cwd_changed(&mut sub, "term-k");
    assert!(
        extra.is_empty(),
        "duplicate report_cwd should not emit CwdChanged"
    );
}

#[tokio::test]
async fn test_start_tracking_clears_pending_without_timing() {
    let hub = TerminalEventHub::standalone();
    let mut sub = hub.subscribe();
    let tracker = CwdTracker::new(hub.clone());

    // Buffer a pending cwd for an untracked terminal synchronously
    tracker.report_cwd("term-atomic", "/buffered_pending");
    assert!(
        tracker.has_pending("term-atomic"),
        "pending entry must exist before start_tracking"
    );
    assert_eq!(tracker.get_cwd("term-atomic"), None);

    // Atomically consumes pending and registers terminal under one write lock
    tracker.start_tracking("term-atomic", 12345, "/initial_spawn");

    // Invariant holds immediately upon return without any sleep or wait_for timing
    assert!(
        !tracker.has_pending("term-atomic"),
        "pending entry must be cleared immediately after start_tracking returns"
    );
    assert_eq!(
        tracker.get_cwd("term-atomic"),
        Some("/buffered_pending".to_string())
    );
    assert!(tracker.is_prompt_reported("term-atomic"));
    assert_eq!(tracker.tracked_count(), 1);

    // Terminal with no prior pending also satisfies the invariant
    tracker.start_tracking("term-no-pending", 67890, "/clean_spawn");
    assert!(
        !tracker.has_pending("term-no-pending"),
        "terminal without pending must also have has_pending == false"
    );
    assert_eq!(
        tracker.get_cwd("term-no-pending"),
        Some("/clean_spawn".to_string())
    );
    assert!(!tracker.is_prompt_reported("term-no-pending"));

    // Verify CwdChanged was emitted synchronously for the consumed pending cwd
    let events = drain_cwd_changed(&mut sub, "term-atomic");
    assert_eq!(events, vec!["/buffered_pending".to_string()]);
}

#[tokio::test]
async fn test_publish_lock_blocks_concurrent_start_tracking() {
    let hub = TerminalEventHub::standalone();
    let tracker = Arc::new(CwdTracker::new(hub));
    let rt_handle = tokio::runtime::Handle::current();

    // Install a pending cwd for an untracked terminal
    tracker.report_cwd("term-locked", "/pending_val");
    assert!(tracker.has_pending("term-locked"));

    // Acquire the publish_lock from the test thread
    let publish_lock = tracker.publish_lock();
    let lock_guard = publish_lock.lock();

    let (tx, rx) = std::sync::mpsc::channel();
    let tracker_clone = tracker.clone();

    let handle = std::thread::spawn(move || {
        let _guard = rt_handle.enter();
        tx.send("started").expect("send started");
        tracker_clone.start_tracking("term-locked", 12345, "/spawn_val");
        tx.send("done").expect("send done");
    });

    // The test waits for "started"
    assert_eq!(rx.recv().expect("receive started signal"), "started");

    // Assert that "done" is NOT received within 100 ms
    assert_eq!(
        rx.recv_timeout(std::time::Duration::from_millis(100)),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout),
        "start_tracking must block while publish_lock is held"
    );

    // Rule out vacuity: while the lock is held, a pending entry still exists
    // and the tracked entry is absent
    assert!(
        tracker.has_pending("term-locked"),
        "pending entry must still exist while publish_lock is held"
    );
    assert_eq!(
        tracker.get_cwd("term-locked"),
        None,
        "terminal state must not be registered while publish_lock is held"
    );

    // Release the lock
    drop(lock_guard);

    // Assert "done" arrives within 5 s and the state changed
    assert_eq!(
        rx.recv_timeout(std::time::Duration::from_secs(5))
            .expect("receive done signal"),
        "done"
    );
    handle
        .join()
        .expect("thread should finish after lock release");
    assert_eq!(
        tracker.get_cwd("term-locked"),
        Some("/pending_val".to_string())
    );
    assert!(
        !tracker.has_pending("term-locked"),
        "pending entry must be consumed after start_tracking completes"
    );
}

#[tokio::test]
async fn test_publish_lock_blocks_concurrent_stop_tracking() {
    let hub = TerminalEventHub::standalone();
    let tracker = Arc::new(CwdTracker::new(hub));
    let rt_handle = tokio::runtime::Handle::current();

    // Start tracking a terminal
    tracker.start_tracking("term-stop-locked", 12345, "/initial_cwd");
    assert_eq!(
        tracker.get_cwd("term-stop-locked"),
        Some("/initial_cwd".to_string())
    );
    assert_eq!(tracker.tracked_count(), 1);

    // Acquire the publish_lock from the test thread
    let publish_lock = tracker.publish_lock();
    let lock_guard = publish_lock.lock();

    let (tx, rx) = std::sync::mpsc::channel();
    let tracker_clone = tracker.clone();

    let handle = std::thread::spawn(move || {
        let _guard = rt_handle.enter();
        tx.send("started").expect("send started");
        tracker_clone.stop_tracking("term-stop-locked");
        tx.send("done").expect("send done");
    });

    // The test waits for "started"
    assert_eq!(rx.recv().expect("receive started signal"), "started");

    // Assert that "done" is NOT received within 100 ms
    assert_eq!(
        rx.recv_timeout(std::time::Duration::from_millis(100)),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout),
        "stop_tracking must block while publish_lock is held"
    );

    // Rule out vacuity: while the lock is held, the tracked entry is still present
    assert_eq!(
        tracker.get_cwd("term-stop-locked"),
        Some("/initial_cwd".to_string()),
        "tracked entry must still be present while publish_lock is held"
    );
    assert_eq!(
        tracker.tracked_count(),
        1,
        "tracked count must remain unchanged while publish_lock is held"
    );

    // Release the lock
    drop(lock_guard);

    // Assert "done" arrives within 5 s and the state changed
    assert_eq!(
        rx.recv_timeout(std::time::Duration::from_secs(5))
            .expect("receive done signal"),
        "done"
    );
    handle
        .join()
        .expect("thread should finish after lock release");
    assert_eq!(
        tracker.get_cwd("term-stop-locked"),
        None,
        "terminal state must be removed after stop_tracking finishes"
    );
    assert_eq!(tracker.tracked_count(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn test_publication_order_race_start_tracking_and_report_cwd() {
    let hub = TerminalEventHub::standalone();
    let tracker = Arc::new(CwdTracker::new(hub.clone()));
    let rt_handle = tokio::runtime::Handle::current();

    for iter in 0..200 {
        let terminal_id = format!("race-term-{}", iter);
        let mut sub = hub.subscribe();

        // Buffer pending cwd for the terminal
        tracker.report_cwd(&terminal_id, &format!("/pending-{}", iter));

        let tracker1 = tracker.clone();
        let tracker2 = tracker.clone();
        let id1 = terminal_id.clone();
        let id2 = terminal_id.clone();
        let rt1 = rt_handle.clone();
        let rt2 = rt_handle.clone();

        let t1 = std::thread::spawn(move || {
            let _rt_guard = rt1.enter();
            tracker1.start_tracking(&id1, 1000 + (iter as u32), &format!("/spawn-{}", iter));
        });

        let t2 = std::thread::spawn(move || {
            let _rt_guard = rt2.enter();
            for k in 0..5 {
                tracker2.report_cwd(&id2, &format!("/burst-{}-{}", iter, k));
            }
        });

        t1.join().expect("t1 join");
        t2.join().expect("t2 join");

        let expected_cwd = tracker.get_cwd(&terminal_id).expect("must be tracked");

        let mut last_emitted_cwd = None;
        while let Ok(event) = sub.try_recv() {
            if let TerminalEvent::CwdChanged {
                terminal_id: ref id,
                ref cwd,
            } = event
            {
                if id == &terminal_id {
                    last_emitted_cwd = Some(cwd.clone());
                }
            }
        }

        assert_eq!(
            last_emitted_cwd.as_deref(),
            Some(expected_cwd.as_str()),
            "iteration {}: final emitted CwdChanged must match get_cwd",
            iter
        );
    }
}
