//! Bounded-delivery cases on the fault carrier (AD-16): a slow subscriber
//! costs the host a bounded amount of memory, learns about dropped LOSSY events
//! through a `gap` frame, loses its connection (not an event) when a reliable
//! event finds no room, and hears the host's heartbeat while the queue is busy.

use super::relay_liveness_tests::emit_chunk;
use super::*;
use crate::acp::manager::FakeTurn;
use crate::web::connection_runtime::ConnectionRuntime;
use agent_client_protocol::schema::v1::StopReason;

fn host() -> Host {
    Host::new(|acp, sessions| {
        acp.install_test_agent_with_turns(
            AgentId(AGENT.to_string()),
            sessions,
            vec![FakeTurn::Stop(StopReason::EndTurn)],
            false,
        );
    })
}

/// A reliable session event (`tool_call`) numbered like any relay event.
fn emit_reliable(host: &Host, index: usize) {
    let sinks: Vec<Arc<dyn crate::web::EventSink>> = vec![host.relay.clone()];
    crate::acp::events::fan_out(
        &sinks,
        Some(SESSION),
        "acp:tool_call",
        &json!({"sessionId": SESSION, "n": index}),
    );
}

fn seqs_of(peer: &Peer, type_: &str) -> Vec<u64> {
    peer.events_of(type_)
        .iter()
        .filter_map(|event| event["seq"].as_u64())
        .collect()
}

/// The host writes a `heartbeat` on its own timer while chunks keep the queue
/// busy, so a client reads liveness without a ping round trip.
#[tokio::test(start_paused = true)]
async fn heartbeat_frames_arrive_on_a_busy_connection() {
    let host = host();
    let mut conn = host.connect();
    conn.authenticate().await;
    conn.subscribe("sub").await;
    for _ in 0..(HEARTBEAT_INTERVAL.as_secs() * 3 + 2) {
        emit_chunk(&host);
        conn.peer.read_for(Duration::from_secs(1)).await;
    }
    let beats = conn.peer.events_of("heartbeat").len();
    assert!(beats >= 3, "expected a heartbeat every {HEARTBEAT_INTERVAL:?}, saw {beats}");
    assert!(
        conn.peer.events_of("heartbeat").iter().all(|beat| beat.get("seq").is_none()),
        "a heartbeat is not a log event"
    );
    assert!(!conn.relay_finished().await);
}

/// Chunks that find the subscriber's channel full are dropped (bounded memory)
/// and one `gap` frame for the session precedes the next delivered event.
#[tokio::test(start_paused = true)]
async fn dropped_lossy_events_are_followed_by_a_gap_frame() {
    let host = host();
    let mut conn = host.connect();
    conn.authenticate().await;
    conn.subscribe("sub").await;
    // No await between emits: the forwarder cannot drain, so the channel
    // (256) fills and the rest is dropped.
    for _ in 0..300 {
        emit_chunk(&host);
    }
    Conn::settle().await;
    emit_chunk(&host);
    conn.peer.read_for(Duration::from_secs(1)).await;

    let seqs = seqs_of(&conn.peer, "message_chunk");
    assert_eq!(seqs.first(), Some(&1));
    // The channel's 256 chunks plus the one sent after the gap: nothing in
    // between was buffered.
    assert_eq!(seqs.len(), 257, "chunks above the channel bound must be dropped");
    let gaps = conn.peer.events_of("gap");
    assert_eq!(gaps.len(), 1, "exactly one gap frame: {gaps:?}");
    assert_eq!(gaps[0]["sid"], SESSION);
    assert!(gaps[0].get("seq").is_none(), "a gap is not a log event");
    let gap_at = conn
        .peer
        .events
        .iter()
        .position(|event| event["type"] == "gap")
        .expect("gap frame delivered");
    let last_before = conn.peer.events[..gap_at]
        .iter()
        .filter_map(|event| event["seq"].as_u64())
        .max();
    let first_after = conn.peer.events[gap_at..]
        .iter()
        .find_map(|event| event["seq"].as_u64());
    assert_eq!(last_before, Some(256), "everything the channel held arrived first");
    assert_eq!(first_after, Some(301), "the gap precedes the next delivered event");
    assert!(!conn.relay_finished().await, "a lossy drop never closes the connection");
}

/// A reliable event that finds the subscriber's channel full closes the
/// connection; the client resumes by cursor and receives every event it did
/// not get, contiguous. Nothing is dropped and no queue grows without bound.
#[tokio::test(start_paused = true)]
async fn reliable_overflow_closes_the_connection_and_the_cursor_resumes_it() {
    let mut host = host();
    host.state.connections = ConnectionRuntime::new(15);
    let mut stalled = host.connect();
    stalled.authenticate().await;
    let subscribed = stalled.subscribe("sub").await;
    let epoch = subscribed["payload"]["logEpoch"].as_str().unwrap().to_string();
    stalled.peer.stall_writes();

    let total = 400;
    for index in 1..=total {
        emit_reliable(&host, index);
    }
    Conn::settle().await;
    assert!(
        stalled.relay_finished().await,
        "a subscriber that cannot take reliable events must lose its connection"
    );
    assert_eq!(host.relay.session_subscriber_count(SESSION), 0);

    // The phone reconnects and resumes from the last seq it saw (none).
    let mut resumed = host.connect();
    resumed.authenticate().await;
    let reply = resumed
        .request(
            "resume",
            "subscribe",
            json!({"sessionId": SESSION, "lastSeq": 0, "logEpoch": epoch}),
        )
        .await;
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(reply["payload"]["headSeq"], total);
    resumed.peer.read_for(Duration::from_secs(1)).await;
    let seqs = seqs_of(&resumed.peer, "tool_call");
    assert_eq!(seqs, (1..=total as u64).collect::<Vec<_>>());
}
