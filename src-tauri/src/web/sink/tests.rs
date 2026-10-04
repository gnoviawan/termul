use super::*;
use crate::acp::session_persistence::{
    now_millis, PersistedEventRecord, SessionPersistence, SessionRegistration,
    SESSION_SCHEMA_VERSION,
};
use serde::Serialize;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// Drain a receiver into a Vec in arrival order (test helper for the live
/// relay API — replaces the old `WsRelaySink::drain` recorder).
fn drain_rx(rx: &mut tokio::sync::mpsc::UnboundedReceiver<SequencedEvent>) -> Vec<SequencedEvent> {
    let mut out = Vec::new();
    while let Ok(evt) = rx.try_recv() {
        out.push(evt);
    }
    out
}

/// A minimal serializable payload for sink tests — exercises the same
/// `serde_json::to_value` path the real event structs use.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TestPayload {
    agent_id: String,
    session_id: String,
    message: String,
}

impl TestPayload {
    fn new(agent: &str, session: &str, msg: &str) -> Self {
        Self {
            agent_id: agent.to_string(),
            session_id: session.to_string(),
            message: msg.to_string(),
        }
    }
}

#[tokio::test]
async fn forget_session_removes_relay_subscription_and_replay_state() {
    let ws = Arc::new(WsRelaySink::new());
    ws.seed_session_for_test("temp");
    let (client, _rx, _) = ws.subscribe("temp", Some(0)).await;
    let sinks: Vec<Arc<dyn EventSink>> = vec![ws.clone()];
    fan_out(
        &sinks,
        Some("temp"),
        "acp:message_chunk",
        &TestPayload::new("a1", "temp", "secret"),
    );
    ws.turn_watermark().mark_seen("temp", "turn-1");
    assert_eq!(ws.session_watermark("temp"), 1);
    assert_eq!(ws.session_subscriber_count("temp"), 1);
    assert!(ws.turn_watermark().is_seen("temp", "turn-1"));
    assert!(ws.replay_gates.lock().await.contains_key("temp"));

    ws.forget_session("temp").await;

    assert_eq!(ws.session_watermark("temp"), 0);
    assert_eq!(ws.session_subscriber_count("temp"), 0);
    assert!(!ws.clients.lock().contains_key(&client));
    assert!(!ws.turn_watermark().is_seen("temp", "turn-1"));
    assert!(!ws.replay_gates.lock().await.contains_key("temp"));
}

/// Story 7 review: `subscribe` validates existence and registers under the
/// same `sessions` lock `forget_session` removes under — an unknown or
/// forgotten session yields [`ReplayResult::NotFound`] (never a silent
/// empty subscribe) on both the live-only and cursor paths, and registers
/// no client.
#[tokio::test]
async fn subscribe_unknown_or_forgotten_session_is_not_found() {
    let ws = Arc::new(WsRelaySink::new());

    let (_c, _rx, replay) = ws.subscribe("sess-absent", None).await;
    assert_eq!(replay, ReplayResult::NotFound);
    let (_c, _rx, replay) = ws.subscribe("sess-absent", Some(0)).await;
    assert_eq!(replay, ReplayResult::NotFound);
    assert_eq!(ws.session_subscriber_count("sess-absent"), 0);

    // Known → subscribe → forget → both paths now report not_found.
    ws.seed_session_for_test("sess-eph");
    let (_c, _rx, replay) = ws.subscribe("sess-eph", None).await;
    assert_eq!(replay, ReplayResult::Ok(0));
    ws.forget_session("sess-eph").await;
    let (_c, _rx, replay) = ws.subscribe("sess-eph", None).await;
    assert_eq!(replay, ReplayResult::NotFound);
    let (_c, _rx, replay) = ws.subscribe("sess-eph", Some(0)).await;
    assert_eq!(replay, ReplayResult::NotFound);
    assert_eq!(ws.session_subscriber_count("sess-eph"), 0);

    // With persistence attached an id absent from the catalog is still
    // not_found (the cursor path must not fall through to `stale` via the
    // durable-replay error branch).
    let root = temp_dir("subscribe-not-found");
    let persistence = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    let ws = Arc::new(WsRelaySink::with_persistence(8, persistence.clone()));
    let (_c, _rx, replay) = ws.subscribe("sess-absent", None).await;
    assert_eq!(replay, ReplayResult::NotFound);
    let (_c, _rx, replay) = ws.subscribe("sess-absent", Some(3)).await;
    assert_eq!(replay, ReplayResult::NotFound);
    assert_eq!(ws.session_subscriber_count("sess-absent"), 0);
    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

/// AC: `WsRelaySink` delivers session + agent-level events in emission
/// order to a subscribed client (Story 1.4 live API; was Task 8.1).
#[tokio::test]
async fn ws_relay_sink_delivers_events_in_order() {
    let ws = Arc::new(WsRelaySink::new());
    // Subscribe BEFORE emitting so the client receives events live.
    ws.seed_session_for_test("sess-1");
    let (client, mut rx, replay) = ws.subscribe("sess-1", None).await;
    assert_eq!(replay, ReplayResult::Ok(0), "fresh session has no replay");
    let sinks: Vec<Arc<dyn EventSink>> = vec![ws.clone()];
    fan_out(
        &sinks,
        Some("sess-1"),
        "acp:message_chunk",
        &TestPayload::new("a1", "sess-1", "first"),
    );
    fan_out(
        &sinks,
        Some("sess-1"),
        "acp:message_chunk",
        &TestPayload::new("a1", "sess-1", "second"),
    );
    fan_out(
        &sinks,
        None,
        "acp:agent_disconnected",
        &TestPayload::new("a1", "sess-1", "third"),
    );

    // Lossy events are pushed + flushed to the channel on enqueue (AC5/AC6),
    // so an explicit flush is a no-op here; reliable agent_disconnected is last.
    assert_eq!(
        ws.flush_lossy(client),
        0,
        "lossy ring already drained on enqueue"
    );

    let drained = drain_rx(&mut rx);
    assert_eq!(drained.len(), 3, "exactly three events were delivered");
    // Session-scoped events get monotonic seq; agent-level gets seq=0.
    assert_eq!(drained[0].type_, "message_chunk");
    assert_eq!(drained[0].sid.as_deref(), Some("sess-1"));
    assert_eq!(drained[0].seq, 1);
    assert_eq!(drained[0].payload["message"], "first");
    assert_eq!(drained[1].seq, 2);
    assert_eq!(drained[1].payload["message"], "second");
    assert_eq!(drained[2].type_, "agent_disconnected");
    assert_eq!(drained[2].seq, 0);
    assert!(
        drained[2].sid.is_none(),
        "agent-level event must carry no sid"
    );
    // camelCase wire shape is preserved end-to-end (AC3).
    assert_eq!(drained[0].payload["agentId"], "a1");
    assert_eq!(drained[0].payload["sessionId"], "sess-1");
}

/// AC: `WsRelaySink` + `TauriEventSink` in the same fan-out both receive
/// the SAME payload (Story 1.1 byte-identity invariant). We can't
/// construct a real `AppHandle` in a unit test, so a custom sink records
/// the `AcpEvent` the way `TauriEventSink` would emit it; we then assert
/// the WS relay delivered an identical `Value` to a subscribed client.
/// The relay strips the `acp:` prefix from `type_` (AC2) but passes the
/// `payload` `Value` through verbatim (AC3 — byte-identity invariant).
#[tokio::test]
async fn fan_out_delivers_identical_payload_to_every_sink() {
    /// A second recorder used as a stand-in for `TauriEventSink`'s view of
    /// the event (we can't build a real `AppHandle` here). It captures the
    /// exact `AcpEvent` handed to `emit`.
    struct CapturingSink {
        seen: Mutex<Vec<AcpEvent>>,
    }
    impl EventSink for CapturingSink {
        fn emit(&self, event: &AcpEvent) {
            self.seen.lock().push(event.clone());
        }
    }

    let ws = Arc::new(WsRelaySink::new());
    let tauri_stand_in = Arc::new(CapturingSink {
        seen: Mutex::new(Vec::new()),
    });
    let sinks: Vec<Arc<dyn EventSink>> = vec![tauri_stand_in.clone(), ws.clone()];

    // Subscribe BEFORE emitting so the WS client receives the event live.
    ws.seed_session_for_test("sess-7");
    let (_client, mut rx, _replay) = ws.subscribe("sess-7", None).await;

    fan_out(
        &sinks,
        Some("sess-7"),
        "acp:tool_call",
        &TestPayload::new("a2", "sess-7", "hello"),
    );

    let tauri_view = tauri_stand_in.seen.lock().drain(..).collect::<Vec<_>>();
    let ws_view = drain_rx(&mut rx);

    assert_eq!(tauri_view.len(), 1);
    assert_eq!(ws_view.len(), 1);
    // The relay strips the `acp:` prefix from the WS event type (AC2).
    assert_eq!(tauri_view[0].type_, "acp:tool_call");
    assert_eq!(ws_view[0].type_, "tool_call");
    assert_eq!(ws_view[0].sid.as_deref(), tauri_view[0].sid.as_deref());
    assert_eq!(
        ws_view[0].payload, tauri_view[0].payload,
        "both sinks must see the SAME serialized Value (serialize-once-fan-out-N)"
    );
    assert_eq!(ws_view[0].payload["message"], "hello");
}

/// `fan_out` with an empty sink list is a no-op (the dispatcher must not
/// panic when constructed with `vec![]`, e.g. in unit tests of the manager).
#[test]
fn fan_out_with_no_sinks_is_a_no_op() {
    let sinks: Vec<Arc<dyn EventSink>> = vec![];
    fan_out(
        &sinks,
        Some("sess-x"),
        "acp:message_chunk",
        &TestPayload::new("a", "sess-x", "m"),
    );
    // No panic, no assertion needed beyond reaching this point.
}

/// `WsRelaySink` live receiver drains only currently-queued events;
/// subsequent emits produce new events on the next drain (AC6).
#[tokio::test]
async fn ws_relay_sink_live_drain_is_incremental() {
    let ws = Arc::new(WsRelaySink::new());
    ws.seed_session_for_test("sess-d");
    let (client, mut rx, _replay) = ws.subscribe("sess-d", None).await;
    let sinks: Vec<Arc<dyn EventSink>> = vec![ws.clone()];
    fan_out(
        &sinks,
        Some("sess-d"),
        "acp:message_chunk",
        &TestPayload::new("a", "sess-d", "m1"),
    );
    // Lossy events are flushed to the channel on enqueue.
    assert_eq!(ws.lossy_ring_len_for_test(client), 0);
    let first = drain_rx(&mut rx);
    assert_eq!(first.len(), 1);
    // A second drain without a new emit yields nothing.
    let between = drain_rx(&mut rx);
    assert!(
        between.is_empty(),
        "drain must not re-deliver already-drained events"
    );
    fan_out(
        &sinks,
        Some("sess-d"),
        "acp:message_chunk",
        &TestPayload::new("a", "sess-d", "m2"),
    );
    let second = drain_rx(&mut rx);
    assert_eq!(second.len(), 1, "a new emit must produce a new event");
    assert_eq!(second[0].seq, 2);
}

/// A payload whose `Serialize` impl always errors — deterministically
/// exercises `fan_out`'s serialization-failure branch. The real-world
/// trigger is an `f64::NaN`/`Infinity` in a field like
/// `UsageCostEvent.amount`, but a custom failing serializer avoids
/// depending on `serde_json`'s float policy.
struct AlwaysFailsPayload;
impl Serialize for AlwaysFailsPayload {
    fn serialize<S>(&self, _serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        Err(<S::Error as serde::ser::Error>::custom(
            "intentional serialization failure for test",
        ))
    }
}

/// P1: a serialization failure must NOT emit a `null` payload on the wire
/// — the event is dropped (preserving the old `events::emit` semantics).
#[tokio::test]
async fn fan_out_skips_emission_when_payload_fails_to_serialize() {
    let ws = Arc::new(WsRelaySink::new());
    ws.seed_session_for_test("sess-nan");
    let (_client, mut rx, _replay) = ws.subscribe("sess-nan", None).await;
    let sinks: Vec<Arc<dyn EventSink>> = vec![ws.clone()];
    fan_out(
        &sinks,
        Some("sess-nan"),
        "acp:usage_update",
        &AlwaysFailsPayload,
    );
    assert!(
        drain_rx(&mut rx).is_empty(),
        "serialization failure must not emit a null payload"
    );
}

/// Mirrors the real event structs' `#[serde(skip_serializing_if = ...)]`
/// pattern (e.g. `SessionCreatedEvent`/`AgentErrorEvent`/`UsageUpdateEvent`)
/// without coupling this test to `crate::acp::events` internals.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkipIfPayload {
    agent_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    optional_field: Option<String>,
}

/// P2: the `Value` produced by `fan_out` must match a direct
/// `serde_json::to_value` of the same struct, including `skip_serializing_if`
/// fields (a `None` optional field must be ABSENT, not emitted as `null`).
/// This guards against any future `Value`-intermediate regression that would
/// silently break byte-identity for real event structs.
#[tokio::test]
async fn fan_out_preserves_skip_serializing_if_byte_identity() {
    let ws = Arc::new(WsRelaySink::new());
    ws.seed_session_for_test("sess-skip");
    let (_client, mut rx, _replay) = ws.subscribe("sess-skip", None).await;
    let sinks: Vec<Arc<dyn EventSink>> = vec![ws.clone()];
    let payload = SkipIfPayload {
        agent_id: "a1".to_string(),
        optional_field: None,
    };
    let direct = serde_json::to_value(&payload).unwrap();
    fan_out(&sinks, Some("sess-skip"), "acp:session_created", &payload);
    let recorded = drain_rx(&mut rx);
    assert_eq!(recorded.len(), 1);
    assert_eq!(
        recorded[0].payload, direct,
        "fan_out's Value must match direct to_value, including skip_serializing_if"
    );
    assert!(
        recorded[0].payload.get("optionalField").is_none(),
        "skipped Option::None field must be absent from the wire payload, not null"
    );
    assert_eq!(recorded[0].payload["agentId"], "a1");
}

/// P2: compile-time proof that `EventSink` and its implementations are
/// `Send + Sync` (the trait requires it, so `Arc<dyn EventSink>` can cross
/// from the Tauri command thread into each agent's dedicated driver
/// thread). A future field change that breaks this would fail to compile.
#[test]
fn event_sink_trait_and_impls_are_send_sync() {
    fn assert_send_sync<T: Send + Sync + ?Sized>() {}
    assert_send_sync::<AcpEvent>();
    assert_send_sync::<WsRelaySink>();
    assert_send_sync::<dyn EventSink>();
    assert_send_sync::<Arc<dyn EventSink>>();
    assert_send_sync::<Vec<Arc<dyn EventSink>>>();
}

/// AC11: bounded per-session ring evicts oldest events and bumps `base_seq`.
#[tokio::test]
async fn event_log_evicts_oldest_when_over_capacity() {
    let ws = Arc::new(WsRelaySink::with_capacity(2, 256));
    let sinks: Vec<Arc<dyn EventSink>> = vec![ws.clone()];
    for msg in ["a", "b", "c"] {
        fan_out(
            &sinks,
            Some("sess-evict"),
            "acp:tool_call",
            &TestPayload::new("a1", "sess-evict", msg),
        );
    }
    // Cursor pointing at evicted seq 0 must be stale (base_seq is now 2;
    // next wanted seq 1 was evicted).
    let (_c, mut rx, replay) = ws.subscribe("sess-evict", Some(0)).await;
    assert_eq!(replay, ReplayResult::Stale);
    assert!(drain_rx(&mut rx).is_empty());

    // Cursor at seq 1 → next wanted is 2, still in the ring → replay 2+3.
    let (_c2, mut rx2, replay2) = ws.subscribe("sess-evict", Some(1)).await;
    assert_eq!(replay2, ReplayResult::Ok(2));
    let drained2 = drain_rx(&mut rx2);
    assert_eq!(drained2.len(), 2);
    assert_eq!(drained2[0].seq, 2);
    assert_eq!(drained2[1].seq, 3);

    // Cursor at seq 2 → replay only seq 3.
    let (_c3, mut rx3, replay3) = ws.subscribe("sess-evict", Some(2)).await;
    assert_eq!(replay3, ReplayResult::Ok(1));
    let drained = drain_rx(&mut rx3);
    assert_eq!(drained.len(), 1);
    assert_eq!(drained[0].seq, 3);
    assert_eq!(drained[0].payload["message"], "c");
}

fn temp_dir(label: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!("termul-sink-{label}-{stamp}"));
    std::fs::create_dir_all(&path).unwrap();
    path
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn durable_replay_catches_more_than_ring_capacity_then_streams_live() {
    let root = temp_dir("replay-catchup");
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    persistence
        .register_session(SessionRegistration {
            session_id: "sess-durable".to_string(),
            stable_agent_namespace: None,
            runtime_agent_id: None,
            project_id: None,
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    let relay = Arc::new(WsRelaySink::with_persistence(2, persistence.clone()));
    let sinks: Vec<Arc<dyn EventSink>> = vec![relay.clone()];
    for index in 1..=2 {
        fan_out(
            &sinks,
            Some("sess-durable"),
            "acp:tool_call",
            &TestPayload::new("a", "sess-durable", &index.to_string()),
        );
    }
    persistence.flush_session("sess-durable").await.unwrap();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let hook = crate::acp::session_persistence::ReplayTestHook::new(entered_tx);
    persistence.set_replay_test_hook(hook.clone());
    let subscribe_relay = relay.clone();
    let subscribe =
        tokio::spawn(async move { subscribe_relay.subscribe("sess-durable", Some(0)).await });
    tokio::task::spawn_blocking(move || entered_rx.recv().unwrap())
        .await
        .unwrap();
    // The first disk snapshot is now blocked. Inject more than ring capacity,
    // forcing the handoff to detect missing 3..8 and retry durable replay.
    for index in 3..=8 {
        fan_out(
            &sinks,
            Some("sess-durable"),
            "acp:tool_call",
            &TestPayload::new("a", "sess-durable", &index.to_string()),
        );
    }
    hook.release();
    let (_client, mut rx, replay) = subscribe.await.unwrap();
    assert_eq!(replay, ReplayResult::Ok(8));
    let replayed = drain_rx(&mut rx);
    assert_eq!(
        replayed.iter().map(|event| event.seq).collect::<Vec<_>>(),
        (1..=8).collect::<Vec<_>>()
    );
    fan_out(
        &sinks,
        Some("sess-durable"),
        "acp:tool_call",
        &TestPayload::new("a", "sess-durable", "live"),
    );
    assert_eq!(rx.recv().await.unwrap().seq, 9);
    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

/// AC11: reconnect with `last_seq` replays the log tail then streams live.
#[tokio::test]
async fn cursor_replay_then_live() {
    let ws = Arc::new(WsRelaySink::new());
    let sinks: Vec<Arc<dyn EventSink>> = vec![ws.clone()];
    fan_out(
        &sinks,
        Some("sess-rp"),
        "acp:tool_call",
        &TestPayload::new("a1", "sess-rp", "one"),
    );
    fan_out(
        &sinks,
        Some("sess-rp"),
        "acp:tool_call",
        &TestPayload::new("a1", "sess-rp", "two"),
    );

    let (_c, mut rx, replay) = ws.subscribe("sess-rp", Some(1)).await;
    assert_eq!(replay, ReplayResult::Ok(1));
    let replayed = drain_rx(&mut rx);
    assert_eq!(replayed.len(), 1);
    assert_eq!(replayed[0].seq, 2);
    assert_eq!(replayed[0].payload["message"], "two");

    fan_out(
        &sinks,
        Some("sess-rp"),
        "acp:tool_call",
        &TestPayload::new("a1", "sess-rp", "three"),
    );
    let live = drain_rx(&mut rx);
    assert_eq!(live.len(), 1);
    assert_eq!(live[0].seq, 3);
}

/// AC11: lossy ring drop-oldest under pressure (ring filled without flush).
#[tokio::test]
async fn lossy_ring_drop_oldest_under_pressure() {
    let ws = Arc::new(WsRelaySink::with_capacity(4096, 2));
    ws.seed_session_for_test("sess-lossy");
    let (client, mut rx, _) = ws.subscribe("sess-lossy", None).await;
    for i in 1..=5 {
        let se = SequencedEvent::new(
            Some("sess-lossy".to_string()),
            i,
            "message_chunk",
            serde_json::json!({"message": format!("m{i}")}),
        );
        ws.push_lossy_no_flush_for_test(client, se);
    }
    assert_eq!(
        ws.lossy_ring_len_for_test(client),
        2,
        "capacity 2 keeps only newest"
    );
    assert_eq!(ws.flush_lossy(client), 2);
    let drained = drain_rx(&mut rx);
    assert_eq!(drained.len(), 2);
    assert_eq!(drained[0].seq, 4);
    assert_eq!(drained[1].seq, 5);
}

/// AC11: reliable events are never dropped even when lossy ring is full.
#[tokio::test]
async fn reliable_events_never_dropped() {
    let ws = Arc::new(WsRelaySink::with_capacity(4096, 1));
    ws.seed_session_for_test("sess-rel");
    let (client, mut rx, _) = ws.subscribe("sess-rel", None).await;
    let sinks: Vec<Arc<dyn EventSink>> = vec![ws.clone()];
    // Fill lossy ring without flush, then emit a reliable event.
    ws.push_lossy_no_flush_for_test(
        client,
        SequencedEvent::new(
            Some("sess-rel".to_string()),
            99,
            "message_chunk",
            serde_json::json!({"message": "buffered"}),
        ),
    );
    fan_out(
        &sinks,
        Some("sess-rel"),
        "acp:permission_request",
        &TestPayload::new("a1", "sess-rel", "must-arrive"),
    );
    let drained = drain_rx(&mut rx);
    assert!(
        drained.iter().any(|e| e.type_ == "permission_request"),
        "reliable event must be delivered"
    );
    assert!(
        drained.iter().any(|e| e.type_ == "message_chunk"),
        "buffered lossy is flushed before the reliable event"
    );
}

/// AC11: client on session A does not receive session B events.
#[tokio::test]
async fn cross_session_isolation() {
    let ws = Arc::new(WsRelaySink::new());
    ws.seed_session_for_test("sess-a");
    let (_ca, mut rx_a, _) = ws.subscribe("sess-a", None).await;
    ws.seed_session_for_test("sess-b");
    let (_cb, mut rx_b, _) = ws.subscribe("sess-b", None).await;
    let sinks: Vec<Arc<dyn EventSink>> = vec![ws.clone()];
    fan_out(
        &sinks,
        Some("sess-a"),
        "acp:tool_call",
        &TestPayload::new("a1", "sess-a", "only-a"),
    );
    fan_out(
        &sinks,
        Some("sess-b"),
        "acp:tool_call",
        &TestPayload::new("a1", "sess-b", "only-b"),
    );
    let a = drain_rx(&mut rx_a);
    let b = drain_rx(&mut rx_b);
    assert_eq!(a.len(), 1);
    assert_eq!(b.len(), 1);
    assert_eq!(a[0].payload["message"], "only-a");
    assert_eq!(b[0].payload["message"], "only-b");
    assert_eq!(a[0].sid.as_deref(), Some("sess-a"));
    assert_eq!(b[0].sid.as_deref(), Some("sess-b"));
}

/// Epic-4 bridge: `broadcast_projects_changed` fans an agent-level
/// `projects_changed` event (sid=null, seq=0) to every connected client.
/// A client subscribed to ANY session receives it (the web client then
/// refetches `GET /projects`).
#[tokio::test]
async fn broadcast_projects_changed_reaches_subscribed_client() {
    let relay = Arc::new(WsRelaySink::new());
    // Subscribe a client to a session so it is in the relay's client set.
    relay.seed_session_for_test("sess-1");
    let (_client, mut rx, _replay) = relay.subscribe("sess-1", None).await;

    broadcast_projects_changed(&relay, Some("p-3"));

    let drained = drain_rx(&mut rx);
    assert_eq!(drained.len(), 1, "exactly one projects_changed event");
    let evt = &drained[0];
    assert_eq!(evt.type_, "projects_changed");
    assert!(evt.sid.is_none(), "agent-level event: sid must be null");
    assert_eq!(evt.seq, 0, "agent-level event: seq must be 0");
    assert_eq!(evt.payload["defaultProjectId"], "p-3");
}

/// `broadcast_projects_changed` with no default project still fans out;
/// the `ProjectsChangedPayload` struct's `skip_serializing_if` OMITS the
/// `defaultProjectId` key entirely (not `null`).
#[tokio::test]
async fn broadcast_projects_changed_null_default_id() {
    let relay = Arc::new(WsRelaySink::new());
    relay.seed_session_for_test("sess-1");
    let (_client, mut rx, _replay) = relay.subscribe("sess-1", None).await;

    broadcast_projects_changed(&relay, None);

    let drained = drain_rx(&mut rx);
    assert_eq!(drained.len(), 1);
    assert_eq!(drained[0].type_, "projects_changed");
    // `skip_serializing_if = "Option::is_none"` → the key is omitted, not null.
    assert!(
        drained[0].payload.get("defaultProjectId").is_none(),
        "defaultProjectId must be omitted (not null) when None"
    );
}

/// `broadcast_chat_history_changed` fans an agent-level event (`sid: None`,
/// `seq: 0`) to every connected client so the web sidebar refetches the
/// session index. Mirrors `broadcast_projects_changed`.
#[tokio::test]
async fn broadcast_chat_history_changed_reaches_subscribed_client() {
    let relay = Arc::new(WsRelaySink::new());
    relay.seed_session_for_test("sess-1");
    let (_client, mut rx, _replay) = relay.subscribe("sess-1", None).await;

    broadcast_chat_history_changed(&relay);

    let drained = drain_rx(&mut rx);
    assert_eq!(drained.len(), 1);
    assert_eq!(drained[0].type_, "chat_history_changed");
    assert_eq!(drained[0].seq, 0, "agent-level event: seq must be 0");
    // The payload is empty `{}` — the web client refetches the index.
    assert!(drained[0].payload.as_object().unwrap().is_empty());
}

/// CAP-2: with host persistence attached, session lifecycle events fan an
/// agent-level `chat_history_changed` so connected sidebars refetch the
/// host-owned index (browser-origin sessions never flow through a desktop
/// renderer save).
#[tokio::test]
async fn session_lifecycle_broadcasts_history_changed_when_persistent() {
    let root = std::env::temp_dir().join(format!(
        "termul-sink-history-broadcast-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let persistence = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    let relay = Arc::new(WsRelaySink::with_persistence(8, persistence.clone()));
    relay.seed_session_for_test("sess-1");
    let (_client, mut rx, _replay) = relay.subscribe("sess-1", None).await;

    for type_ in ["acp:session_created", "acp:session_closed"] {
        relay.emit(&AcpEvent {
            sid: Some("sess-1".to_string()),
            type_,
            payload: json!({"agentId": "a-1", "sessionId": "sess-1"}),
        });
    }

    let drained = drain_rx(&mut rx);
    let notifications = drained
        .iter()
        .filter(|event| event.type_ == "chat_history_changed")
        .count();
    assert_eq!(
        notifications, 2,
        "each lifecycle event fans one chat_history_changed"
    );
    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

/// Live-only relays (no host persistence) must NOT fan history-changed
/// notifications — there is no durable index to refetch.
#[tokio::test]
async fn session_lifecycle_is_silent_without_persistence() {
    let relay = Arc::new(WsRelaySink::new());
    relay.seed_session_for_test("sess-1");
    let (_client, mut rx, _replay) = relay.subscribe("sess-1", None).await;

    relay.emit(&AcpEvent {
        sid: Some("sess-1".to_string()),
        type_: "acp:session_closed",
        payload: json!({"agentId": "a-1", "sessionId": "sess-1"}),
    });

    let drained = drain_rx(&mut rx);
    assert!(
        drained
            .iter()
            .all(|event| event.type_ != "chat_history_changed"),
        "no history notification without durable persistence"
    );
}

/// Regression: background title generation writes a durable
/// `local_title_generated` event directly through
/// `SessionPersistence::enqueue_event` (advancing durable `last_seq`)
/// BEFORE the synthetic `session_info_update` reaches the relay. The relay
/// must reconcile its cached `last_seq` with the durable frontier so it
/// assigns the NEXT unique seq — not a colliding one that the fail-closed
/// `append_record` check would reject.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn relay_reconciles_cached_seq_with_durable_frontier_after_background_title() {
    let root = temp_dir("seq-reconcile");
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    persistence
        .register_session(SessionRegistration {
            session_id: "sess-coll".to_string(),
            stable_agent_namespace: None,
            runtime_agent_id: None,
            project_id: None,
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    let relay = Arc::new(WsRelaySink::with_persistence(8, persistence.clone()));
    let sinks: Vec<Arc<dyn EventSink>> = vec![relay.clone()];

    // 1. Relay emits a session-scoped event → assigns seq 1 (durable
    //    last_seq advances to 1 via assign_and_append's enqueue).
    fan_out(
        &sinks,
        Some("sess-coll"),
        "acp:tool_call",
        &TestPayload::new("a", "sess-coll", "first"),
    );
    // Flush so the async durable writer processes the enqueued event
    // before we assert on `last_seq`.
    persistence.flush_session("sess-coll").await.unwrap();
    assert_eq!(relay.session_watermark("sess-coll"), 1);
    assert_eq!(persistence.last_seq("sess-coll").unwrap(), 1);

    // 2. The `set_session_title` MCP tool writes durable seq 2 directly
    //    through `SessionPersistence` (mirrors `record_local_title`).
    //    The relay's cached `last_seq` is still 1.
    let record = PersistedEventRecord {
        schema_version: SESSION_SCHEMA_VERSION,
        session_id: "sess-coll".to_string(),
        seq: 2,
        type_: "local_title_generated".to_string(),
        recorded_at: now_millis(),
        payload: json!({"sessionId": "sess-coll", "title": "Generated Title"}),
    };
    persistence.enqueue_event(record).unwrap();
    persistence.flush_session("sess-coll").await.unwrap();
    assert_eq!(persistence.last_seq("sess-coll").unwrap(), 2);

    // 3. Synthetic `session_info_update` through the relay must assign
    //    seq 3 (reconciled: max(cached=1, durable=2) + 1 = 3), NOT a
    //    colliding seq 2. Without reconciliation the durable enqueue
    //    would be rejected by the fail-closed `seq > last_seq` check.
    fan_out(
        &sinks,
        Some("sess-coll"),
        "acp:session_info_update",
        &TestPayload::new("a", "sess-coll", "title-sync"),
    );
    // Flush so the async durable writer processes the enqueued event
    // before we assert on `last_seq`.
    persistence.flush_session("sess-coll").await.unwrap();
    assert_eq!(
        relay.session_watermark("sess-coll"),
        3,
        "relay reconciles cached frontier with durable frontier"
    );
    assert_eq!(
        persistence.last_seq("sess-coll").unwrap(),
        3,
        "durable enqueue accepted (no collision)"
    );

    // 4. Persistence stays healthy: a subsequent flush + direct enqueue
    //    at the next seq succeeds (proving no corrupt/gapped log).
    persistence.flush_session("sess-coll").await.unwrap();
    let next_record = PersistedEventRecord {
        schema_version: SESSION_SCHEMA_VERSION,
        session_id: "sess-coll".to_string(),
        seq: 4,
        type_: "tool_call".to_string(),
        recorded_at: now_millis(),
        payload: json!({"sessionId": "sess-coll"}),
    };
    assert!(
        persistence.enqueue_event(next_record).is_ok(),
        "subsequent durable enqueue succeeds (healthy sequence)"
    );

    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

/// Story 8 (web honesty): a durable event arriving for a session whose
/// durable record is already deleted (delete won the race against a
/// still-streaming event) is an expected outcome — the enqueue rejects
/// with `SessionNotFound` and the relay routes it at info (not warn)
/// while the live fan-out to subscribers continues unaffected.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deleted_session_event_is_skipped_without_failing_the_relay() {
    let root = temp_dir("deleted-skip");
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    persistence
        .register_session(SessionRegistration {
            session_id: "sess-gone".to_string(),
            stable_agent_namespace: None,
            runtime_agent_id: None,
            project_id: None,
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    let relay = Arc::new(WsRelaySink::with_persistence(8, persistence.clone()));
    relay.seed_session_for_test("sess-gone");
    let (_client, mut rx, _replay) = relay.subscribe("sess-gone", None).await;

    // Delete the durable record, then fan an event for the (now deleted)
    // session — the durable enqueue must reject with SessionNotFound,
    // which the relay routes at info (benign) instead of warn.
    persistence.delete_session("sess-gone").await.unwrap();
    relay.emit(&AcpEvent {
        sid: Some("sess-gone".to_string()),
        type_: "acp:message_chunk",
        payload: json!({"agentId": "a-1", "sessionId": "sess-gone", "message": "late"}),
    });

    // The live path still delivered the event to subscribers (the durable
    // rejection is routing-only; it never breaks the fan-out).
    let drained = drain_rx(&mut rx);
    assert!(
        drained.iter().any(|event| event.type_ == "message_chunk"),
        "live fan-out continues after a benign durable-reject"
    );
    // The durable writer for the deleted session is gone; a direct
    // enqueue of the same event surfaces the expected SessionNotFound.
    let record = PersistedEventRecord {
        schema_version: SESSION_SCHEMA_VERSION,
        session_id: "sess-gone".to_string(),
        seq: 1,
        type_: "message_chunk".to_string(),
        recorded_at: now_millis(),
        payload: json!({"sessionId": "sess-gone"}),
    };
    assert!(
        matches!(
            persistence.enqueue_event(record),
            Err(SessionPersistenceError::SessionNotFound)
        ),
        "deleted session rejects durable enqueue (the demoted class)"
    );

    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

/// Title metadata events (`session_info_update` for agent-supplied titles,
/// `local_title_generated` for background titles) fan a
/// `chat_history_changed` notification so connected sidebars refetch the
/// host index and pick up the new title. Extends the
/// `session_lifecycle_broadcasts_history_changed_when_persistent` coverage.
#[tokio::test]
async fn title_metadata_events_broadcast_history_changed_when_persistent() {
    let root = std::env::temp_dir().join(format!(
        "termul-sink-title-broadcast-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    persistence
        .register_session(SessionRegistration {
            session_id: "sess-title".to_string(),
            stable_agent_namespace: None,
            runtime_agent_id: None,
            project_id: None,
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    let relay = Arc::new(WsRelaySink::with_persistence(8, persistence.clone()));
    let (_client, mut rx, _replay) = relay.subscribe("sess-title", None).await;

    for type_ in ["acp:session_info_update", "acp:local_title_generated"] {
        relay.emit(&AcpEvent {
            sid: Some("sess-title".to_string()),
            type_,
            payload: json!({"agentId": "a-1", "sessionId": "sess-title", "title": "T"}),
        });
    }

    let drained = drain_rx(&mut rx);
    let notifications = drained
        .iter()
        .filter(|event| event.type_ == "chat_history_changed")
        .count();
    assert_eq!(
        notifications, 2,
        "each title metadata event fans one chat_history_changed"
    );
    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

// --- Issue #836: replay holes + pre-registration buffering -------------------

/// Pure scanner: `missing_seq_ranges` finds every contiguous hole.
#[test]
fn missing_seq_ranges_finds_contiguous_holes() {
    let mut by_seq = std::collections::BTreeMap::new();
    for seq in [2u64, 3, 4, 7, 9, 10] {
        by_seq.insert(
            seq,
            SequencedEvent::new(Some("s".to_string()), seq, "message_chunk", json!({})),
        );
    }
    // cursor 0, frontier 10 → holes 1, 5..6, 8.
    let missing = missing_seq_ranges(0, 10, &by_seq);
    assert_eq!(
        missing,
        vec![
            SeqRange { start: 1, end: 1 },
            SeqRange { start: 5, end: 6 },
            SeqRange { start: 8, end: 8 },
        ]
    );
    // Fully covered within a run: 2..=4 has no holes.
    assert!(missing_seq_ranges(1, 4, &by_seq).is_empty());
    // Frontier below cursor start → empty.
    assert!(missing_seq_ranges(10, 5, &by_seq).is_empty());
}

/// Issue #836 acceptance: a session with a missing EARLY seq (dropped before
/// registration, so it exists only in the live ring) must answer
/// `subscribe(lastSeq=0)` promptly — the loop skips the hole and replays every
/// seq that DOES exist instead of spinning forever.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn subscribe_with_hole_below_durable_frontier_returns_promptly() {
    let root = temp_dir("replay-hole");
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    persistence
        .register_session(SessionRegistration {
            session_id: "sess-hole".to_string(),
            stable_agent_namespace: None,
            runtime_agent_id: None,
            project_id: None,
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    let relay = Arc::new(WsRelaySink::with_persistence(64, persistence.clone()));
    let _sinks: Vec<Arc<dyn EventSink>> = vec![relay.clone()];
    // Deterministic repro of the #836 hole shape: re-open the store (writers
    // uninstalled), emit seq 1 BEFORE re-registering (the enqueue rejects
    // with SessionNotFound → buffered, ring-only), then register + persist
    // 2..=6. Durable JSONL holds 2..=6; the live ring holds 1..=6; lastSeq=0
    // must terminate and replay everything available.
    persistence.shutdown().await.unwrap();
    let persistence2 = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    let relay2 = Arc::new(WsRelaySink::with_persistence(64, persistence2.clone()));
    let sinks2: Vec<Arc<dyn EventSink>> = vec![relay2.clone()];
    // Emit seq 1 with no registration → SessionNotFound → buffered, NOT on
    // disk. The live ring holds it.
    fan_out(
        &sinks2,
        Some("sess-hole"),
        "acp:message_chunk",
        &TestPayload::new("a", "sess-hole", "seq-1"),
    );
    // Now register + emit 2..=6 (these persist).
    persistence2
        .register_session(SessionRegistration {
            session_id: "sess-hole".to_string(),
            stable_agent_namespace: None,
            runtime_agent_id: None,
            project_id: None,
            cwd: root.join("cwd"),
            ..Default::default()
        })
        .await
        .unwrap();
    for index in 2..=6 {
        fan_out(
            &sinks2,
            Some("sess-hole"),
            "acp:message_chunk",
            &TestPayload::new("a", "sess-hole", &format!("seq-{index}")),
        );
    }
    persistence2.flush_session("sess-hole").await.unwrap();
    // The durable JSONL now holds 2..=6 (seq 1 is ring-only: registering
    // after its emit left it in the pre-registration buffer, never flushed
    // because `note_session_registered` was not called). lastSeq=0 faces a
    // hole at seq 1 — it must return promptly, not spin.
    let subscribe_relay = relay2.clone();
    let outcome = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        subscribe_relay.subscribe("sess-hole", Some(0)),
    )
    .await;
    assert!(outcome.is_ok(), "subscribe must terminate (issue #836)");
    let (client, mut rx, replay) = outcome.unwrap();
    match replay {
        ReplayResult::Ok(count) => assert_eq!(count, 6, "ring seqs 1..=6 all replay"),
        other => panic!("expected Ok, got {other:?}"),
    }
    let replayed = drain_rx(&mut rx);
    assert_eq!(
        replayed.iter().map(|event| event.seq).collect::<Vec<_>>(),
        (1..=6).collect::<Vec<_>>()
    );
    relay2.unregister_client(client);
    persistence2.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

/// Issue #836 pre-registration buffering: events emitted BEFORE
/// `note_session_registered` are buffered, and the flush lands them in the
/// durable store — so the JSONL starts at seq 1 with no hole.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pre_registration_events_are_buffered_and_flushed_on_registration() {
    let root = temp_dir("pre-reg-buffer");
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    let relay = Arc::new(WsRelaySink::with_persistence(64, persistence.clone()));
    let sinks: Vec<Arc<dyn EventSink>> = vec![relay.clone()];
    // Emit seqs 1..=2 BEFORE registration — the enqueue rejects with
    // SessionNotFound and the sink buffers them.
    for index in 1..=2 {
        fan_out(
            &sinks,
            Some("sess-prereg"),
            "acp:commands_update",
            &TestPayload::new("a", "sess-prereg", &format!("seq-{index}")),
        );
    }
    // Register, then notify the sink so it flushes the buffer.
    persistence
        .register_session(SessionRegistration {
            session_id: "sess-prereg".to_string(),
            stable_agent_namespace: None,
            runtime_agent_id: None,
            project_id: None,
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    relay.note_session_registered("sess-prereg");
    // Post-registration events persist normally.
    for index in 3..=4 {
        fan_out(
            &sinks,
            Some("sess-prereg"),
            "acp:message_chunk",
            &TestPayload::new("a", "sess-prereg", &format!("seq-{index}")),
        );
    }
    persistence.flush_session("sess-prereg").await.unwrap();
    let records = persistence.replay_after("sess-prereg", 0).unwrap();
    assert_eq!(
        records.iter().map(|record| record.seq).collect::<Vec<_>>(),
        (1..=4).collect::<Vec<_>>(),
        "buffered seqs 1..=2 flush in order before live 3..=4"
    );
    // And lastSeq=0 now replays with no hole at all.
    let (_client, mut rx, replay) = relay.subscribe("sess-prereg", Some(0)).await;
    assert!(matches!(replay, ReplayResult::Ok(4)));
    let replayed = drain_rx(&mut rx);
    assert_eq!(
        replayed.iter().map(|event| event.seq).collect::<Vec<_>>(),
        (1..=4).collect::<Vec<_>>()
    );
    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

/// Issue #847 acceptance: agent `message_chunk` events fan out to EVERY
/// subscribed client — a second subscriber (a second device) receives the
/// same chunk stream as the first. Guards the lossy-tier fan-out path that
/// the second device's live stream depends on.
#[tokio::test]
async fn agent_message_chunks_fan_out_to_every_subscriber() {
    let ws = Arc::new(WsRelaySink::new());
    ws.seed_session_for_test("sess-fanout");
    let (client_a, mut rx_a, replay_a) = ws.subscribe("sess-fanout", None).await;
    assert!(matches!(replay_a, ReplayResult::Ok(0)));
    let (client_b, mut rx_b, replay_b) = ws.subscribe("sess-fanout", None).await;
    assert!(matches!(replay_b, ReplayResult::Ok(0)));
    let sinks: Vec<Arc<dyn EventSink>> = vec![ws.clone()];
    // The exact shape `emit_session_update` produces for an agent text chunk.
    for text in ["Hello", " from", " the agent"] {
        fan_out(
            &sinks,
            Some("sess-fanout"),
            "acp:message_chunk",
            &json!({
                "agentId": "a-1",
                "sessionId": "sess-fanout",
                "role": "agent",
                "content": {"type": "text", "text": text},
            }),
        );
    }
    let drained_a = drain_rx(&mut rx_a);
    let drained_b = drain_rx(&mut rx_b);
    let seqs_a: Vec<u64> = drained_a.iter().map(|event| event.seq).collect();
    let seqs_b: Vec<u64> = drained_b.iter().map(|event| event.seq).collect();
    assert_eq!(seqs_a, vec![1, 2, 3], "first subscriber sees all chunks");
    assert_eq!(seqs_b, vec![1, 2, 3], "second subscriber sees all chunks");
    for drained in [&drained_a, &drained_b] {
        assert!(drained
            .iter()
            .all(|event| event.payload["role"] == json!("agent")));
    }
    ws.unregister_client(client_a);
    ws.unregister_client(client_b);
}
