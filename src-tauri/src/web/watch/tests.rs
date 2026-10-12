use std::time::Duration;

use serde_json::{json, Value};

use super::*;
use crate::web::ws::{outbound_channel, Outbound, OutboundReceiver, OutboundSender};

fn connection(capacity: usize) -> (OutboundSender, OutboundReceiver) {
    outbound_channel(capacity, 15)
}

fn next_frame(rx: &mut OutboundReceiver) -> WatchFrame {
    match rx.try_recv() {
        Ok(Outbound::Watch(frame)) => frame,
        Ok(_) => panic!("expected a watch frame"),
        Err(error) => panic!("no frame queued: {error}"),
    }
}

fn drain(rx: &mut OutboundReceiver) -> Vec<WatchFrame> {
    let mut frames = Vec::new();
    while let Ok(Outbound::Watch(frame)) = rx.try_recv() {
        frames.push(frame);
    }
    frames
}

#[tokio::test]
async fn subscribe_sends_full_state_first_then_contiguous_deltas() {
    let hub = WatchHub::new();
    let (out, mut rx) = connection(16);
    let revision = hub
        .subscribe(WatchKind::Projects, "", &out, || json!({ "projects": [] }))
        .expect("subscribe");
    assert_eq!(revision.n, 1);
    assert_eq!(revision.host_epoch, hub.host_epoch());

    hub.publish(WatchKind::Projects, "", || json!({ "projects": ["a"] }));
    hub.publish(WatchKind::Projects, "", || json!({ "projects": ["a", "b"] }));

    let state = next_frame(&mut rx);
    assert_eq!(state.revision().n, 1);
    assert_eq!(state.state_value(), Some(&json!({ "projects": [] })));
    assert!(state.delta_value().is_none());
    let first = next_frame(&mut rx);
    let second = next_frame(&mut rx);
    assert_eq!((first.revision().n, second.revision().n), (2, 3));
    assert_eq!(second.delta_value(), Some(&json!({ "projects": ["a", "b"] })));
}

#[tokio::test]
async fn frames_serialize_with_the_wire_shape() {
    let hub = WatchHub::new();
    let (out, mut rx) = connection(16);
    hub.subscribe(WatchKind::ChatHistory, "", &out, || json!([]))
        .expect("subscribe");
    hub.publish(WatchKind::ChatHistory, "", || json!({ "changed": ["s-1"] }));

    let state = serde_json::to_value(next_frame(&mut rx)).expect("serialize");
    assert_eq!(state["type"], "watch");
    assert_eq!(state["watch"], "chat_history");
    assert_eq!(state["scope"], "");
    assert_eq!(state["reset"], true);
    assert_eq!(state["state"], json!([]));
    assert_eq!(state["revision"]["hostEpoch"], json!(hub.host_epoch()));
    assert_eq!(state["revision"]["n"], 1);
    assert!(state.get("delta").is_none());

    let delta = serde_json::to_value(next_frame(&mut rx)).expect("serialize");
    assert!(delta.get("reset").is_none());
    assert!(delta.get("state").is_none());
    assert_eq!(delta["delta"], json!({ "changed": ["s-1"] }));
    assert_eq!(delta["revision"]["n"], 2);
}

#[tokio::test]
async fn a_connection_receives_each_publish_once_however_often_it_subscribed() {
    let hub = WatchHub::new();
    let (out, mut rx) = connection(16);
    hub.subscribe(WatchKind::Agents, "", &out, || json!([])).expect("first");
    hub.subscribe(WatchKind::Agents, "", &out, || json!(["fresh"])).expect("second");
    assert_eq!(hub.subscriber_count(WatchKind::Agents, ""), 1);

    hub.publish(WatchKind::Agents, "", || json!({ "event": "agent_spawned" }));

    let frames = drain(&mut rx);
    // Two state frames (one per subscribe) and exactly one delta.
    let deltas: Vec<_> = frames.iter().filter(|f| f.delta_value().is_some()).collect();
    assert_eq!(deltas.len(), 1);
    // The second subscribe restarted the stream at n = 1 with fresh state.
    assert_eq!(frames[1].revision().n, 1);
    assert_eq!(frames[1].state_value(), Some(&json!(["fresh"])));
    assert_eq!(deltas[0].revision().n, 2);
}

#[tokio::test]
async fn every_subscribed_connection_gets_its_own_revision_counter() {
    let hub = WatchHub::new();
    let (early, mut early_rx) = connection(16);
    hub.subscribe(WatchKind::Projects, "", &early, || json!(1)).expect("early");
    hub.publish(WatchKind::Projects, "", || json!(2));
    let (late, mut late_rx) = connection(16);
    hub.subscribe(WatchKind::Projects, "", &late, || json!(2)).expect("late");
    hub.publish(WatchKind::Projects, "", || json!(3));

    let early_n: Vec<u64> = drain(&mut early_rx).iter().map(|f| f.revision().n).collect();
    let late_n: Vec<u64> = drain(&mut late_rx).iter().map(|f| f.revision().n).collect();
    assert_eq!(early_n, vec![1, 2, 3]);
    assert_eq!(late_n, vec![1, 2]);
}

#[tokio::test]
async fn a_publish_with_no_subscriber_never_builds_its_delta() {
    let hub = WatchHub::new();
    hub.publish(WatchKind::Projects, "", || {
        panic!("the delta of an unwatched publish must not be built")
    });
    let (out, _rx) = connection(4);
    hub.subscribe(WatchKind::Agents, "", &out, || json!([])).expect("subscribe");
    // A different watch has no subscriber either.
    hub.publish(WatchKind::Projects, "", || {
        panic!("the delta of an unwatched publish must not be built")
    });
}

#[tokio::test]
async fn unsubscribe_and_connection_close_release_subscriptions() {
    let hub = WatchHub::new();
    let (out, mut rx) = connection(16);
    let (other, _other_rx) = connection(16);
    hub.subscribe(WatchKind::Projects, "", &out, || json!(0)).expect("projects");
    hub.subscribe(WatchKind::Agents, "", &out, || json!([])).expect("agents");
    hub.subscribe(WatchKind::Agents, "", &other, || json!([])).expect("other");

    assert!(hub.unsubscribe(WatchKind::Projects, "", &out));
    assert!(!hub.unsubscribe(WatchKind::Projects, "", &out), "already released");
    hub.publish(WatchKind::Projects, "", || json!(1));
    let after = drain(&mut rx);
    assert_eq!(after.len(), 2, "two state frames, nothing after the unsubscribe");

    hub.unsubscribe_all(&out);
    assert_eq!(hub.subscriber_count(WatchKind::Agents, ""), 1, "the other connection stays");
    hub.unsubscribe_all(&other);
    assert_eq!(hub.subscriber_count(WatchKind::Agents, ""), 0);
}

#[tokio::test]
async fn a_subscriber_whose_connection_closed_is_pruned_by_the_next_publish() {
    let hub = WatchHub::new();
    let (out, rx) = connection(16);
    hub.subscribe(WatchKind::Projects, "", &out, || json!(0)).expect("subscribe");
    drop(rx);
    hub.publish(WatchKind::Projects, "", || json!(1));
    assert_eq!(hub.subscriber_count(WatchKind::Projects, ""), 0);
}

#[tokio::test]
async fn subscribing_to_a_full_queue_registers_nothing() {
    let hub = WatchHub::new();
    let (out, mut rx) = connection(1);
    hub.subscribe(WatchKind::Projects, "", &out, || json!(0)).expect("first fits");
    let refused = hub.subscribe(WatchKind::Agents, "", &out, || json!([]));
    assert_eq!(refused, Err(SubscribeError::QueueFull));
    assert_eq!(hub.subscriber_count(WatchKind::Agents, ""), 0);
    assert_eq!(next_frame(&mut rx).revision().n, 1);
}

#[tokio::test]
async fn a_delta_dropped_for_a_full_queue_leaves_a_revision_gap_and_a_resync_marker() {
    let hub = WatchHub::new();
    let (out, mut rx) = connection(1);
    hub.subscribe(WatchKind::Projects, "", &out, || json!(0)).expect("subscribe");
    // The state frame fills the queue: the delta of n = 2 is dropped, and a
    // marker takes n = 3 and waits for room.
    hub.publish(WatchKind::Projects, "", || json!(1));

    assert_eq!(next_frame(&mut rx).revision().n, 1);
    let marker = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("the marker is queued once there is room")
        .expect("queue open");
    let Outbound::Watch(marker) = marker else {
        panic!("expected a watch frame")
    };
    assert_eq!(marker.revision().n, 3, "n = 2 was the dropped delta");
    assert_eq!(marker.delta_value(), Some(&json!({ "resync": true })));
}

#[tokio::test]
async fn a_renewed_host_epoch_shows_in_the_next_frame() {
    let hub = WatchHub::new();
    let (out, mut rx) = connection(16);
    hub.subscribe(WatchKind::Projects, "", &out, || json!(0)).expect("subscribe");
    let before = hub.host_epoch();
    let after = hub.renew_epoch();
    assert_ne!(before, after);
    hub.publish(WatchKind::Projects, "", || json!(1));

    let state = next_frame(&mut rx);
    let delta = next_frame(&mut rx);
    assert_eq!(state.revision().host_epoch, before);
    assert_eq!(delta.revision().host_epoch, after);
    assert_eq!(delta.revision().n, 2);
}

#[test]
fn watch_names_and_scopes_round_trip() {
    for kind in [WatchKind::Projects, WatchKind::ChatHistory, WatchKind::Agents] {
        assert_eq!(WatchKind::parse(kind.as_str()), Some(kind));
        assert!(kind.accepts_scope(""));
        assert!(!kind.accepts_scope("x"));
    }
    assert_eq!(WatchKind::parse("fs"), None);
}

#[tokio::test]
async fn publish_helpers_carry_the_documented_delta_shapes() {
    use crate::web::project_registry::ProjectRegistry;
    use crate::web::sink::WsRelaySink;

    let relay = WsRelaySink::new();
    let registry = ProjectRegistry::new();
    let (out, mut rx) = connection(16);
    for kind in [WatchKind::Projects, WatchKind::ChatHistory, WatchKind::Agents] {
        relay.watches().subscribe(kind, "", &out, || Value::Null).expect("subscribe");
    }
    drain(&mut rx);

    publish_projects(&relay, &registry);
    publish_chat_history(&relay, &["s-1", "s-2"]);
    publish_agent_event(&relay, "agent_disconnected", &json!({ "agentId": "a-1" }));

    let frames = drain(&mut rx);
    assert_eq!(frames.len(), 3);
    assert_eq!(frames[0].delta_value(), Some(&json!({ "projects": [] })));
    assert_eq!(frames[1].delta_value(), Some(&json!({ "changed": ["s-1", "s-2"] })));
    assert_eq!(
        frames[2].delta_value(),
        Some(&json!({ "event": "agent_disconnected", "payload": { "agentId": "a-1" } }))
    );
}

#[tokio::test]
async fn a_resync_marker_does_not_outlive_its_subscription() {
    let hub = WatchHub::new();
    let (out, mut rx) = connection(1);
    hub.subscribe(WatchKind::Projects, "", &out, || json!(0)).expect("subscribe");
    // The state frame fills the queue: this delta is dropped and a marker waits.
    hub.publish(WatchKind::Projects, "", || json!(1));
    assert_eq!(next_frame(&mut rx).revision().n, 1);

    // The client resubscribes before the marker is queued.
    hub.subscribe(WatchKind::Projects, "", &out, || json!("fresh")).expect("resubscribe");
    tokio::time::sleep(Duration::from_millis(50)).await;

    let frames = drain(&mut rx);
    assert_eq!(frames.len(), 1, "only the fresh state frame, no stale marker");
    assert_eq!(frames[0].revision().n, 1);
    assert_eq!(frames[0].state_value(), Some(&json!("fresh")));
}

#[tokio::test]
async fn subscribing_outside_a_runtime_is_refused_not_a_panic() {
    let hub = std::sync::Arc::new(WatchHub::new());
    let (out, _rx) = connection(4);
    let hub_for_thread = std::sync::Arc::clone(&hub);
    let outcome = std::thread::spawn(move || {
        hub_for_thread.subscribe(WatchKind::Projects, "", &out, || json!(0))
    })
    .join()
    .expect("no panic");
    assert_eq!(outcome, Err(SubscribeError::Closed));
    assert_eq!(hub.subscriber_count(WatchKind::Projects, ""), 0);
}
