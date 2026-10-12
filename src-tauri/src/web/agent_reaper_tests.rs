//! Tests for the standalone-server idle agent reaper (issue #837).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use std::time::{Duration, Instant};

use crate::acp::{AgentId, AcpManager};
use crate::web::agent_reaper::{
    agent_is_reapable, reap_idle_agents, run_agent_idle_reaper, DEFAULT_SWEEP_INTERVAL,
};
use crate::web::sink::WsRelaySink;

fn set(sessions: &[&str]) -> HashSet<String> {
    sessions.iter().map(|s| (*s).to_string()).collect()
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

/// A zero-session (process-only prewarm) agent that has been unpinned for the
/// whole (tiny) idle window is stopped by one sweep. The acceptance case for
/// the reaper: "removes an agent with no sessions after the configured idle
/// window (use a small window in test)".
#[tokio::test]
async fn reaper_removes_sessionless_agent_after_idle_window() {
    let manager = Arc::new(AcpManager::new(vec![]));
    let relay = Arc::new(WsRelaySink::new());
    let agent_id = AgentId("agent-idle".to_string());
    let record = manager.install_test_agent_with_reap_state(
        agent_id.clone(),
        set(&[]),
        false,
        false,
    );

    let mut unpinned = HashMap::new();
    // Simulate the window having already elapsed: the agent was first seen
    // unpinned 60s ago, the window is 30s.
    unpinned.insert(agent_id.clone(), Instant::now() - Duration::from_secs(60));
    let reaped = reap_idle_agents(
        &manager,
        &relay,
        &mut unpinned,
        Instant::now(),
        Duration::from_secs(30),
    )
    .await;
    assert_eq!(reaped, vec![agent_id.clone()]);
    assert!(
        manager.list_agents().is_empty(),
        "agent removed from the registry"
    );
    let_fake_driver_drain().await;
    assert!(*record.shut_down.lock(), "agent received Shutdown");
}

/// A durable session with a live WS subscriber pins the agent (the phone is
/// still reading the chat) — no reap even an hour past the window.
#[tokio::test]
async fn reaper_keeps_agent_with_subscribed_durable_session() {
    let manager = Arc::new(AcpManager::new(vec![]));
    let relay = Arc::new(WsRelaySink::new());
    manager.install_test_agent_with_reap_state(
        AgentId("agent-durable".to_string()),
        set(&["sess-chat"]),
        false,
        false,
    );
    relay.seed_session_for_test("sess-chat");
    let _keep = relay.subscribe("sess-chat", None, None).await;

    let mut unpinned = HashMap::new();
    unpinned.insert(
        AgentId("agent-durable".to_string()),
        Instant::now() - Duration::from_secs(3600),
    );
    let reaped = reap_idle_agents(
        &manager,
        &relay,
        &mut unpinned,
        Instant::now(),
        Duration::from_secs(1),
    )
    .await;
    assert!(reaped.is_empty());
    assert_eq!(manager.list_agents().len(), 1);
    std::mem::drop(_keep);
}

/// An idle durable session (no subscriber, no turn) no longer pins the agent
/// forever: the renderer reloads durable history on a fresh agent, so the
/// old owner is reaped with its process (CodeRabbit: durable forever-pin).
#[tokio::test]
async fn reaper_removes_agent_with_idle_durable_session() {
    let manager = Arc::new(AcpManager::new(vec![]));
    let relay = Arc::new(WsRelaySink::new());
    let record = manager.install_test_agent_with_reap_state(
        AgentId("agent-idle-durable".to_string()),
        set(&["sess-chat"]),
        false,
        false,
    );

    let mut unpinned = HashMap::new();
    unpinned.insert(
        AgentId("agent-idle-durable".to_string()),
        Instant::now() - Duration::from_secs(3600),
    );
    let reaped = reap_idle_agents(
        &manager,
        &relay,
        &mut unpinned,
        Instant::now(),
        Duration::from_secs(1),
    )
    .await;
    assert_eq!(reaped.len(), 1);
    assert!(manager.list_agents().is_empty(), "idle durable owner reaped");
    // Durable sessions are never disposed (the driver would refuse with
    // `session is not ephemeral`); the process stop alone reaps them.
    assert!(record.disposed.lock().is_empty());
    let_fake_driver_drain().await;
    assert!(*record.shut_down.lock());
}

/// The pre-kill re-check sees pin state that changed AFTER the sweep's first
/// evaluation: a subscriber attaching later flips the agent to "pinned", and an
/// agent that vanished is never "unpinned" (nothing to kill).
#[tokio::test]
async fn still_unpinned_recheck_observes_late_pins() {
    use crate::web::agent_reaper::agent_still_unpinned;
    let manager = Arc::new(AcpManager::new(vec![]));
    let relay = Arc::new(WsRelaySink::new());
    let agent_id = AgentId("agent-late-pin".to_string());
    manager.install_test_agent_with_reap_state(agent_id.clone(), set(&["sess-chat"]), false, false);
    relay.seed_session_for_test("sess-chat");

    assert!(agent_still_unpinned(&manager, &relay, &agent_id, &[]).await);
    let keep = relay.subscribe("sess-chat", None, None).await;
    assert!(
        !agent_still_unpinned(&manager, &relay, &agent_id, &[]).await,
        "a subscriber that arrived after the first pin check pins the agent"
    );
    std::mem::drop(keep);

    let missing = AgentId("agent-missing".to_string());
    assert!(!agent_still_unpinned(&manager, &relay, &missing, &[]).await);
}

/// A session disposed during the sweep leaves the fresh ownership listing, so a
/// subscriber that attached to it meanwhile must still pin the agent through
/// the sweep's own session ids.
#[tokio::test]
async fn still_unpinned_recheck_sees_subscriber_on_disposed_session() {
    use crate::web::agent_reaper::agent_still_unpinned;
    let manager = Arc::new(AcpManager::new(vec![]));
    let relay = Arc::new(WsRelaySink::new());
    let agent_id = AgentId("agent-disposed".to_string());
    // The ephemeral session is already gone from the manager's ownership set.
    manager.install_test_agent_with_reap_state(agent_id.clone(), set(&[]), false, false);
    relay.seed_session_for_test("sess-gone");
    let swept = vec!["sess-gone".to_string()];

    assert!(agent_still_unpinned(&manager, &relay, &agent_id, &swept).await);
    let keep = relay.subscribe("sess-gone", None, None).await;
    assert!(
        !agent_still_unpinned(&manager, &relay, &agent_id, &swept).await,
        "a subscriber on a disposed session still pins the agent"
    );
    std::mem::drop(keep);
}

/// A mid-turn session pins the agent even when the session is ephemeral (a
/// warm-pool seed whose prompt is still streaming).
#[tokio::test]
async fn reaper_keeps_agent_with_mid_turn_session() {
    let manager = Arc::new(AcpManager::new(vec![]));
    let relay = Arc::new(WsRelaySink::new());
    manager.install_test_agent_with_reap_state(
        AgentId("agent-busy".to_string()),
        set(&["sess-warm"]),
        true,
        true,
    );

    let mut unpinned = HashMap::new();
    unpinned.insert(
        AgentId("agent-busy".to_string()),
        Instant::now() - Duration::from_secs(3600),
    );
    let reaped = reap_idle_agents(
        &manager,
        &relay,
        &mut unpinned,
        Instant::now(),
        Duration::from_secs(1),
    )
    .await;
    assert!(reaped.is_empty());
}

/// An ephemeral warm-pool session with a live WS subscriber pins the agent;
/// with no subscriber it is disposed and the agent is stopped past the
/// window.
#[tokio::test]
async fn reaper_disposes_unsubscribed_ephemeral_session_and_stops_agent() {
    // No subscriber → dispose + stop.
    let manager = Arc::new(AcpManager::new(vec![]));
    let relay = Arc::new(WsRelaySink::new());
    let agent_id = AgentId("agent-warm".to_string());
    let record =
        manager.install_test_agent_with_reap_state(agent_id.clone(), set(&["sess-warm"]), false, true);

    let mut unpinned = HashMap::new();
    unpinned.insert(agent_id.clone(), Instant::now() - Duration::from_secs(60));
    let reaped = reap_idle_agents(
        &manager,
        &relay,
        &mut unpinned,
        Instant::now(),
        Duration::from_secs(30),
    )
    .await;
    assert_eq!(reaped, vec![agent_id]);
    assert_eq!(
        *record.disposed.lock(),
        vec!["sess-warm".to_string()]
    );
    let_fake_driver_drain().await;
    assert!(*record.shut_down.lock());

    // With a live subscriber the same setup must NOT reap. The session must
    // be seeded in the relay first: `subscribe` on an unknown session returns
    // `ReplayResult::NotFound` and registers nothing to pin the agent.
    let manager = Arc::new(AcpManager::new(vec![]));
    let relay = Arc::new(WsRelaySink::new());
    relay.seed_session_for_test("sess-warm");
    let _keep = relay.subscribe("sess-warm", None, None).await;
    manager.install_test_agent_with_reap_state(
        AgentId("agent-warm".to_string()),
        set(&["sess-warm"]),
        false,
        true,
    );
    let mut unpinned = HashMap::new();
    unpinned.insert(
        AgentId("agent-warm".to_string()),
        Instant::now() - Duration::from_secs(3600),
    );
    let reaped = reap_idle_agents(
        &manager,
        &relay,
        &mut unpinned,
        Instant::now(),
        Duration::from_secs(1),
    )
    .await;
    assert!(reaped.is_empty());
}

/// The reap decision is pure: any pinned session blocks the reap.
#[test]
fn agent_is_reapable_requires_all_sessions_unpinned() {
    assert!(agent_is_reapable(&[]));
    assert!(agent_is_reapable(&[("s1".to_string(), false)]));
    assert!(!agent_is_reapable(&[
        ("s1".to_string(), false),
        ("s2".to_string(), true)
    ]));
    assert!(!agent_is_reapable(&[("s1".to_string(), true)]));
}

/// End-to-end loop behavior with a tiny window + sweep: a sessionless agent
/// disappears after the window elapses, and the loop exits when the shutdown
/// future resolves.
#[tokio::test]
async fn reaper_loop_reaps_sessionless_agent_and_exits_on_shutdown() {
    let manager = Arc::new(AcpManager::new(vec![]));
    let relay = Arc::new(WsRelaySink::new());
    let agent_id = AgentId("agent-loop".to_string());
    let record =
        manager.install_test_agent_with_reap_state(agent_id, set(&[]), false, false);

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let reaper = tokio::spawn(run_agent_idle_reaper(
        manager.clone(),
        relay,
        Duration::from_secs(1), // tiny window
        DEFAULT_SWEEP_INTERVAL.min(Duration::from_millis(50)),
        Box::pin(async move {
            let _ = shutdown_rx.await;
        }),
    ));

    // Window 1s + sweep 50ms → generous 10s bound.
    let reaped_in_time = tokio::time::timeout(Duration::from_secs(10), async {
        while !manager.list_agents().is_empty() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await;
    assert!(reaped_in_time.is_ok(), "agent was reaped within the window");
    assert!(*record.shut_down.lock());

    shutdown_tx.send(()).expect("signal reaper shutdown");
    tokio::time::timeout(Duration::from_secs(5), reaper)
        .await
        .expect("reaper exits on shutdown")
        .expect("reaper task joins cleanly");
}
