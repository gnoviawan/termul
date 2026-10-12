//! AD-19 execution-model cases on the fault carrier: per-entity request order,
//! a slow handler that must not block other entities, bounded outbound with
//! close-on-full, and the host-stop close on the `/ws` carrier.

use agent_client_protocol::schema::v1::StopReason;

use super::relay_liveness_tests::emit_chunk;
use super::*;
use crate::acp::manager::{FakeAuth, FakeTurn};
use crate::web::connection_runtime::{CLOSE_DRAIN_TIMEOUT, SOCKET_DRAIN_BOUND};

const SLOW: Duration = Duration::from_secs(30);

fn slow_auth_host() -> Host {
    Host::new(|acp, sessions| {
        acp.install_test_agent_with_scripts(
            AgentId(AGENT.to_string()),
            sessions,
            vec![FakeTurn::Stop(StopReason::EndTurn)],
            false,
            vec![FakeAuth::ok_after(SLOW)],
        );
    })
}

fn authenticate_agent() -> Value {
    json!({"agentId": AGENT, "methodId": "oauth"})
}

/// Requests naming the same entity run in arrival order even when the first
/// is slow; a request naming no entity is answered meanwhile.
#[tokio::test(start_paused = true)]
async fn same_entity_requests_run_in_arrival_order_while_other_requests_are_served() {
    let host = slow_auth_host();
    let mut conn = host.connect();
    conn.authenticate().await;
    let started = tokio::time::Instant::now();

    conn.send_request("first", "authenticate_agent", authenticate_agent());
    conn.send_request("second", "authenticate_agent", authenticate_agent());

    let ping = conn.request("ping", "ping", json!({})).await;
    assert_eq!(ping["ok"], true, "{ping}");
    assert!(started.elapsed() < SLOW, "a keyless request waited for the slow handler");

    // The second request is instant on its own, but queued behind the first.
    let second = conn.peer.wait_reply("second").await;
    assert_eq!(second["ok"], true, "{second}");
    assert!(
        started.elapsed() >= SLOW,
        "the second request on one agent overtook the first"
    );
    let first = conn.peer.wait_reply("first").await;
    assert_eq!(first["ok"], true, "{first}");
}

/// A slow handler on one entity (an agent's auth) never blocks a prompt on
/// another (a session).
#[tokio::test(start_paused = true)]
async fn a_slow_handler_on_another_entity_does_not_block_a_prompt() {
    let host = slow_auth_host();
    let mut conn = host.connect();
    conn.authenticate().await;
    conn.subscribe("sub").await;
    let started = tokio::time::Instant::now();

    conn.send_request("slow", "authenticate_agent", authenticate_agent());
    let prompt = conn
        .request(
            "p1",
            "send_prompt",
            json!({"agentId": AGENT, "sessionId": SESSION, "text": "hi", "turnId": "t1"}),
        )
        .await;
    assert_eq!(prompt["ok"], true, "{prompt}");
    assert!(
        started.elapsed() < SLOW,
        "the prompt waited for an unrelated slow handler"
    );
    let slow = conn.peer.wait_reply("slow").await;
    assert_eq!(slow["ok"], true, "{slow}");
}

/// `send_prompt` then `cancel_prompt` sent back to back on one session stay in
/// order: the cancel lands on the turn the prompt started (it would be a no-op
/// if it overtook the accept), and the held turn ends `cancelled`.
#[tokio::test(start_paused = true)]
async fn send_prompt_then_cancel_prompt_on_one_session_stay_ordered() {
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let (entered_tx, _entered_rx) = tokio::sync::oneshot::channel();
    let host = Host::new(|acp, sessions| {
        acp.install_test_agent_with_turns(
            AgentId(AGENT.to_string()),
            sessions,
            vec![FakeTurn::Hold {
                release: release_rx,
                entered: entered_tx,
            }],
            false,
        );
    });
    let mut conn = host.connect();
    conn.authenticate().await;
    conn.subscribe("sub").await;

    conn.send_prompt_request("p1", "turn-1");
    conn.send_request(
        "c1",
        "cancel_prompt",
        json!({"agentId": AGENT, "sessionId": SESSION}),
    );

    let cancel = tokio::time::timeout(Duration::from_secs(60), conn.peer.wait_reply("c1"))
        .await
        .expect("cancel_prompt was never answered");
    assert_eq!(cancel["ok"], true, "{cancel}");
    let complete = tokio::time::timeout(
        Duration::from_secs(60),
        conn.peer.wait_event("prompt_complete"),
    )
    .await
    .expect("the cancel never reached the running turn: it overtook send_prompt");
    assert_eq!(complete["payload"]["stopReason"], "cancelled", "{complete}");
    drop(release_tx);
}

/// A peer that stops draining while events keep coming is closed once its
/// bounded queue stayed full for the overflow tolerance; a healthy peer on the
/// same session is unaffected.
#[tokio::test(start_paused = true)]
async fn a_peer_whose_queue_stays_full_is_closed_and_a_healthy_peer_is_not() {
    let mut host = slow_auth_host();
    // The tolerance comes from the host's connection runtime (AppState), not a
    // constant: a small one closes the peer after that many full windows.
    host.state.connections = crate::web::connection_runtime::ConnectionRuntime::new(3);
    let mut stalled = host.connect();
    stalled.authenticate().await;
    stalled.subscribe("sub").await;
    let mut healthy = host.connect();
    healthy.authenticate().await;
    healthy.subscribe("sub").await;
    stalled.peer.stall_writes();

    // One frame in the blocked send plus a full queue, then more.
    for _ in 0..(OUTBOUND_QUEUE_CAPACITY + 8) {
        emit_chunk(&host);
        tokio::task::yield_now().await;
    }
    healthy.peer.read_for(Duration::from_secs(1)).await;
    assert!(!stalled.relay_finished().await, "closed before the tolerance elapsed");

    let tolerance = host.state.connections.overflow_tolerance;
    assert_eq!(tolerance, 3);
    healthy
        .peer
        .read_for(FULL_QUEUE_ATTEMPT * tolerance as u32 + Duration::from_secs(1))
        .await;
    assert!(
        stalled.relay_finished().await,
        "a peer that kept its queue full for {tolerance} attempts was not closed"
    );
    assert!(!healthy.relay_finished().await, "the healthy peer was closed");
    assert!(
        healthy.peer.events_of("message_chunk").len() > OUTBOUND_QUEUE_CAPACITY,
        "the healthy peer lost events"
    );
}

/// A reply that cannot be queued closes the connection instead of vanishing.
#[tokio::test(start_paused = true)]
async fn a_reply_that_cannot_be_queued_closes_the_connection() {
    let host = slow_auth_host();
    let mut conn = host.connect();
    conn.authenticate().await;
    conn.subscribe("sub").await;
    conn.peer.stall_writes();

    // The blocked send takes one frame; fill the queue exactly (no failed
    // attempt yet).
    emit_chunk(&host);
    Conn::settle().await;
    // The subscription's own channel sits between the sink and the queue: let
    // the forwarder move each chunk across so the queue itself fills.
    for _ in 0..OUTBOUND_QUEUE_CAPACITY {
        emit_chunk(&host);
        Conn::settle().await;
    }
    assert!(!conn.relay_finished().await);

    conn.send_request("ping", "ping", json!({}));
    conn.peer
        .read_for(FULL_QUEUE_ATTEMPT * 20)
        .await;
    assert!(
        conn.relay_finished().await,
        "the reply neither queued nor closed the connection"
    );
}

/// A handler that panics closes the connection (a request without a reply
/// cannot be left dangling); other connections are unaffected.
#[tokio::test(start_paused = true)]
async fn a_panicking_handler_closes_the_connection() {
    let host = slow_auth_host();
    let mut bystander = host.connect();
    bystander.authenticate().await;
    let mut conn = host.connect();
    conn.authenticate().await;

    conn.send_request("boom", "panic_for_test", json!({}));
    conn.peer.read_for(Duration::from_secs(1)).await;
    assert!(conn.relay_finished().await, "the connection survived a handler panic");
    let pong = bystander.request("ping", "ping", json!({})).await;
    assert_eq!(pong["ok"], true, "{pong}");
}

/// Host stop on the `/ws` carrier: the socket gets `Close(1001)` ahead of its
/// queue and the relay ends; the drain returns once it has.
#[tokio::test(start_paused = true)]
async fn host_stop_closes_an_open_socket_with_1001() {
    let host = slow_auth_host();
    let mut conn = host.connect();
    conn.authenticate().await;

    host.state.connections.shutdown.begin();
    let close = conn.peer.wait_close().await.expect("close frame");
    assert_eq!(close, (1001, "host stopping".to_string()));
    assert_eq!(host.state.connections.shutdown.drain(SOCKET_DRAIN_BOUND).await, 0);
    assert!(conn.relay_finished().await, "the relay outlived the drain");
}

/// A peer that stopped reading cannot take the close: the socket gives up
/// after the close drain timeout and the drain still completes, bounded.
#[tokio::test(start_paused = true)]
async fn host_stop_does_not_wait_forever_on_a_stalled_peer() {
    let host = slow_auth_host();
    let mut conn = host.connect();
    conn.authenticate().await;
    conn.peer.stall_writes();

    host.state.connections.shutdown.begin();
    let started = tokio::time::Instant::now();
    assert_eq!(host.state.connections.shutdown.drain(SOCKET_DRAIN_BOUND).await, 0);
    assert_eq!(started.elapsed(), CLOSE_DRAIN_TIMEOUT);
    assert!(conn.relay_finished().await);
    assert!(conn.peer.close.is_none(), "a stalled peer cannot have received a close");
}
