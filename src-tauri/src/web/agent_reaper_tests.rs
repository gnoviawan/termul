//! Tests for the host idle agent reaper (issue #837): the reap decision reads
//! only host-observed activity (turns, tickets, agent terminals, last-active
//! stamp) — never connections, subscriptions or presence.

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;

use crate::acp::{AcpManager, AgentId};
use crate::web::agent_reaper::{
    install_agent_idle_baseline, reap_idle_agents, reset_agent_idle_window_for_tests,
    resolved_agent_idle_window, run_agent_idle_reaper, set_agent_idle_window_override,
    IDLE_WINDOW_TEST_LOCK,
    DEFAULT_SWEEP_INTERVAL,
};
use crate::web::sink::WsRelaySink;

const WINDOW: Duration = Duration::from_secs(30);

fn set(sessions: &[&str]) -> HashSet<String> {
    sessions.iter().map(|s| (*s).to_string()).collect()
}

fn ago(secs: u64) -> Instant {
    Instant::now()
        .checked_sub(Duration::from_secs(secs))
        .expect("monotonic clock far enough from its origin")
}

/// Let the fake driver task drain commands the reaper queued just before the
/// stop (the real driver is a thread; the fixture is a tokio task that only
/// progresses when the runtime polls it, which `kill`'s return does not do).
async fn let_fake_driver_drain() {
    for _ in 0..5 {
        tokio::task::yield_now().await;
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

fn quiet_agent(
    manager: &Arc<AcpManager>,
    name: &str,
    sessions: &[&str],
    ephemeral: bool,
) -> (AgentId, Arc<crate::acp::manager::ReapRecord>) {
    let agent_id = AgentId(name.to_string());
    let record = manager.install_test_agent_with_reap_state(
        agent_id.clone(),
        set(sessions),
        false,
        ephemeral,
    );
    record.activity.lock().last_active_at = ago(60);
    (agent_id, record)
}

/// A process-only prewarm agent quiet for the whole window is stopped.
#[tokio::test]
async fn quiet_sessionless_agent_is_reaped_after_the_window() {
    let manager = Arc::new(AcpManager::new(vec![]));
    let (agent_id, record) = quiet_agent(&manager, "agent-idle", &[], false);

    let reaped = reap_idle_agents(&manager, Instant::now(), WINDOW).await;
    assert_eq!(reaped, vec![agent_id]);
    assert!(
        manager.list_agents().is_empty(),
        "removed from the registry"
    );
    let_fake_driver_drain().await;
    assert!(*record.shut_down.lock(), "agent received Shutdown");
}

/// An agent whose last activity is younger than the window is kept, and is
/// reaped only once the window has passed.
#[tokio::test]
async fn agent_is_reaped_only_after_the_whole_window_is_quiet() {
    let manager = Arc::new(AcpManager::new(vec![]));
    let (agent_id, record) = quiet_agent(&manager, "agent-recent", &["s1"], false);
    record.activity.lock().last_active_at = ago(10);

    let now = Instant::now();
    assert!(reap_idle_agents(&manager, now, WINDOW).await.is_empty());
    assert_eq!(manager.list_agents(), vec![agent_id.clone()]);

    // Observed 10 seconds later the quiet span is still short of the window.
    assert!(
        reap_idle_agents(&manager, now + Duration::from_secs(10), WINDOW)
            .await
            .is_empty()
    );
    // And once the window since the last activity has fully elapsed.
    let reaped = reap_idle_agents(&manager, now + Duration::from_secs(21), WINDOW).await;
    assert_eq!(reaped, vec![agent_id]);
}

/// An idle durable session (nothing running, nothing pending) does not pin the
/// agent: its history is on disk and reopens on a fresh agent.
#[tokio::test]
async fn idle_durable_session_does_not_pin_the_agent() {
    let manager = Arc::new(AcpManager::new(vec![]));
    let (agent_id, record) = quiet_agent(&manager, "agent-durable", &["s1"], false);

    let reaped = reap_idle_agents(&manager, Instant::now(), WINDOW).await;
    assert_eq!(reaped, vec![agent_id]);
    assert!(
        record.disposed.lock().is_empty(),
        "durable sessions are not disposed"
    );
}

/// Every kind of live evidence blocks the reap, however stale `last_active_at`.
#[tokio::test]
async fn running_evidence_blocks_the_reap() {
    type Edit = fn(&mut crate::acp::AgentActivity);
    let cases: [(&str, Edit); 6] = [
        ("active turn", |a| a.active_turns = 1),
        ("pending approval", |a| a.pending_permissions = 1),
        ("pending question", |a| a.pending_questions = 1),
        ("pending elicitation", |a| a.pending_elicitations = 1),
        ("running agent terminal", |a| a.running_terminals = 1),
        ("reopen in flight", |a| a.reopens_in_flight = 1),
    ];
    for (name, edit) in cases {
        let manager = Arc::new(AcpManager::new(vec![]));
        let (agent_id, record) = quiet_agent(&manager, "agent-busy", &["s1"], false);
        edit(&mut record.activity.lock());

        let reaped =
            reap_idle_agents(&manager, Instant::now() + Duration::from_secs(3600), WINDOW).await;
        assert!(reaped.is_empty(), "{name} must block the reap");
        assert_eq!(manager.list_agents(), vec![agent_id], "{name}");
        let_fake_driver_drain().await;
        assert!(
            !*record.shut_down.lock(),
            "{name}: agent must not be stopped"
        );
    }
}

/// A subscriber (or presence) on the session never pins an otherwise quiet
/// agent: the reaper takes no relay or presence input at all.
#[tokio::test]
async fn a_live_subscriber_does_not_pin_a_quiet_agent() {
    let manager = Arc::new(AcpManager::new(vec![]));
    let relay = Arc::new(WsRelaySink::new());
    let (agent_id, _record) = quiet_agent(&manager, "agent-viewed", &["s1"], false);
    relay.seed_session_for_test("s1");
    let (_client, _rx, _replay, _head) = relay
        .subscribe("s1", None, None, &CancellationToken::new())
        .await;
    assert_eq!(relay.session_subscriber_count("s1"), 1);

    let reaped = reap_idle_agents(&manager, Instant::now(), WINDOW).await;
    assert_eq!(reaped, vec![agent_id]);
}

/// The re-probe immediately before the stop aborts the reap when a turn began
/// after the first probe.
#[tokio::test]
async fn reprobe_before_the_stop_aborts_when_a_turn_begins() {
    let manager = Arc::new(AcpManager::new(vec![]));
    let (agent_id, record) = quiet_agent(&manager, "agent-racy", &["s1"], false);
    // Probe 1 (quiet) passes; the turn lands as probe 2 (the re-probe) runs.
    *record.turn_begins_at_probe.lock() = Some(2);

    let reaped = reap_idle_agents(&manager, Instant::now(), WINDOW).await;
    assert!(reaped.is_empty());
    assert_eq!(manager.list_agents(), vec![agent_id]);
    let_fake_driver_drain().await;
    assert!(!*record.shut_down.lock(), "the agent must not be stopped");
    assert_eq!(*record.probes.lock(), 2);
}

/// An unsubscribed ephemeral warm-pool session is disposed first, then the
/// agent is stopped.
#[tokio::test]
async fn ephemeral_session_is_disposed_then_agent_stopped() {
    let manager = Arc::new(AcpManager::new(vec![]));
    let (agent_id, record) = quiet_agent(&manager, "agent-warm", &["warm"], true);

    let reaped = reap_idle_agents(&manager, Instant::now(), WINDOW).await;
    assert_eq!(reaped, vec![agent_id]);
    let_fake_driver_drain().await;
    assert_eq!(*record.disposed.lock(), vec!["warm".to_string()]);
    assert!(*record.shut_down.lock());
}

/// Loop behavior with a tiny window + sweep: a quiet agent disappears once the
/// window elapses, and the loop exits when the shutdown future resolves.
#[tokio::test]
async fn reaper_loop_reaps_quiet_agent_and_exits_on_shutdown() {
    assert_eq!(DEFAULT_SWEEP_INTERVAL, Duration::from_secs(60));
    let manager = Arc::new(AcpManager::new(vec![]));
    let agent_id = AgentId("agent-loop".to_string());
    let record =
        manager.install_test_agent_with_reap_state(agent_id.clone(), HashSet::new(), false, false);
    // Fresh stamp: the agent is only reapable once the (tiny) window passed.
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
    let handle = tokio::spawn(run_agent_idle_reaper(
        manager.clone(),
        || Duration::from_millis(150),
        Duration::from_millis(20),
        Box::pin(async move {
            let _ = stop_rx.await;
        }),
    ));

    for _ in 0..100 {
        if manager.list_agents().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        manager.list_agents().is_empty(),
        "quiet agent reaped by the loop"
    );
    let_fake_driver_drain().await;
    assert!(*record.shut_down.lock());

    let _ = stop_tx.send(());
    tokio::time::timeout(Duration::from_secs(5), handle)
        .await
        .expect("loop exits on shutdown")
        .expect("loop task joins");
}

/// A sweep that captured its window once would keep the long window and leave
/// the agent up after the closure starts returning a tiny window.
#[tokio::test]
async fn reaper_loop_reads_the_window_on_each_sweep() {
    let manager = Arc::new(AcpManager::new(vec![]));
    let agent_id = AgentId("agent-reread".to_string());
    let _record =
        manager.install_test_agent_with_reap_state(agent_id, HashSet::new(), false, false);
    let secs = Arc::new(AtomicU64::new(60_000));
    let secs_for_loop = Arc::clone(&secs);
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
    let handle = tokio::spawn(run_agent_idle_reaper(
        manager.clone(),
        move || Duration::from_millis(secs_for_loop.load(Ordering::Relaxed).max(1)),
        Duration::from_millis(15),
        Box::pin(async move {
            let _ = stop_rx.await;
        }),
    ));

    tokio::time::sleep(Duration::from_millis(60)).await;
    assert_eq!(
        manager.list_agents().len(),
        1,
        "long window keeps the agent"
    );

    secs.store(1, Ordering::Relaxed);
    for _ in 0..100 {
        if manager.list_agents().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(15)).await;
    }
    assert!(
        manager.list_agents().is_empty(),
        "the next sweep uses the new window"
    );

    let _ = stop_tx.send(());
    tokio::time::timeout(Duration::from_secs(5), handle)
        .await
        .expect("loop exits on shutdown")
        .expect("loop task joins");
}

/// One test owns the process-wide window so the cases cannot race each other.
#[tokio::test]
async fn agent_idle_window_precedence_setting_then_env_lock_then_operator() {
    let _guard = IDLE_WINDOW_TEST_LOCK.lock().await;
    reset_agent_idle_window_for_tests();
    let open = resolved_agent_idle_window();
    assert_eq!(open.secs, 1800);
    assert_eq!(open.source, "default");

    set_agent_idle_window_override(Some(3600));
    let setting = resolved_agent_idle_window();
    assert_eq!(setting.secs, 3600);
    assert_eq!(setting.source, "setting");

    install_agent_idle_baseline(45, Some("env"));
    let locked = resolved_agent_idle_window();
    assert_eq!(locked.secs, 45);
    assert_eq!(locked.source, "env");

    set_agent_idle_window_override(None);
    install_agent_idle_baseline(120, Some("operator"));
    let operator = resolved_agent_idle_window();
    assert_eq!(operator.secs, 120);
    assert_eq!(operator.source, "operator");

    reset_agent_idle_window_for_tests();
    assert_eq!(resolved_agent_idle_window().source, "default");
}
