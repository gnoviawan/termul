//! AD-7 / AD-16: one seq authority, atomic assign + fan-out, registration
//! under the seq lock behind a writer barrier.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;

use super::*;
use crate::acp::session_persistence::{SessionPersistence, SessionRegistration};
use crate::web::ws::SequencedEvent;

fn temp_dir(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!("termul-log-integrity-{label}-{nanos}"));
    std::fs::create_dir_all(&path).unwrap();
    path
}

async fn relay_with_session(
    label: &str,
    sid: &str,
) -> (Arc<WsRelaySink>, Arc<SessionPersistence>, PathBuf) {
    let root = temp_dir(label);
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    persistence
        .register_session(SessionRegistration {
            session_id: sid.to_string(),
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    let relay = Arc::new(WsRelaySink::with_persistence(64, persistence.clone()));
    (relay, persistence, root)
}

fn chunk(sid: &str, text: &str) -> AcpEvent {
    AcpEvent {
        sid: Some(sid.to_string()),
        type_: "acp:tool_call",
        payload: json!({"sessionId": sid, "text": text}),
    }
}

fn drain(rx: &mut tokio::sync::mpsc::UnboundedReceiver<SequencedEvent>) -> Vec<SequencedEvent> {
    let mut out = Vec::new();
    while let Ok(event) = rx.try_recv() {
        // Agent-level `seq = 0` nudges (chat_history_changed) are not log events.
        if event.seq > 0 {
            out.push(event);
        }
    }
    out
}

/// A title record and relay events assigned concurrently never collide on a
/// seq, and the subscriber receives them in seq order with no hole.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_host_record_and_relay_events_get_distinct_contiguous_seqs() {
    let (relay, persistence, root) = relay_with_session("concurrent", "sess-c").await;
    let (_client, mut rx, _replay, head) = relay.subscribe("sess-c", None, None).await;
    assert_eq!(head.unwrap().head_seq, 0);

    let mut workers = Vec::new();
    for worker in 0..4 {
        let relay = Arc::clone(&relay);
        workers.push(std::thread::spawn(move || {
            for n in 0..50 {
                relay.emit(&chunk("sess-c", &format!("{worker}-{n}")));
            }
        }));
    }
    let titler = {
        let relay = Arc::clone(&relay);
        std::thread::spawn(move || {
            for n in 0..20 {
                relay
                    .record_host_event(
                        "sess-c",
                        "local_title_generated",
                        json!({"sessionId": "sess-c", "title": format!("t{n}")}),
                    )
                    .unwrap();
            }
        })
    };
    for worker in workers {
        worker.join().unwrap();
    }
    titler.join().unwrap();

    let live: Vec<u64> = drain(&mut rx).iter().map(|event| event.seq).collect();
    assert_eq!(
        live,
        (1..=220).collect::<Vec<u64>>(),
        "live stream is the contiguous seq run, in order"
    );
    assert_eq!(relay.session_watermark("sess-c"), 220);

    persistence.flush_session("sess-c").await.unwrap();
    let durable: Vec<u64> = persistence
        .replay_after("sess-c", 0)
        .unwrap()
        .iter()
        .map(|record| record.seq)
        .collect();
    assert_eq!(durable, live, "the durable log carries the same seqs");
    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

/// A host record with no writer installed fails closed: nothing allocated,
/// persisted or delivered.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn host_record_without_a_writer_allocates_nothing() {
    let (relay, persistence, root) = relay_with_session("no-writer", "sess-w").await;
    persistence.shutdown().await.unwrap();
    let (_client, mut rx, _replay, _head) = relay.subscribe("sess-w", None, None).await;

    let error = relay
        .record_host_event("sess-w", "agent_switch", json!({"sessionId": "sess-w"}))
        .unwrap_err();
    assert!(matches!(
        error,
        crate::acp::session_persistence::SessionPersistenceError::SessionNotFound
    ));
    assert_eq!(relay.session_watermark("sess-w"), 0);
    assert!(drain(&mut rx).is_empty());
    let _ = std::fs::remove_dir_all(root);
}

/// Registration happens under the seq lock: whatever a snapshot subscriber
/// misses in the snapshot it receives live, exactly once, with no hole —
/// even while events are being published.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn snapshot_and_live_stream_partition_the_log_exactly() {
    let (relay, persistence, root) = relay_with_session("snapshot", "sess-s").await;
    for n in 0..30 {
        relay.emit(&chunk("sess-s", &format!("pre-{n}")));
    }
    let publisher = {
        let relay = Arc::clone(&relay);
        std::thread::spawn(move || {
            for n in 0..200 {
                relay.emit(&chunk("sess-s", &format!("live-{n}")));
                if n % 7 == 0 {
                    std::thread::yield_now();
                }
            }
        })
    };
    let (_client, mut rx, snapshot, head) = relay.subscribe_snapshot("sess-s").await.unwrap();
    publisher.join().unwrap();

    let snapshot_seqs: Vec<u64> = snapshot.iter().map(|event| event.seq).collect();
    assert!(snapshot_seqs.iter().all(|seq| *seq <= head.head_seq));
    let live_seqs: Vec<u64> = drain(&mut rx).iter().map(|event| event.seq).collect();
    assert!(
        live_seqs.iter().all(|seq| *seq > head.head_seq),
        "no live event at or below the head"
    );
    let all: BTreeSet<u64> = snapshot_seqs.iter().chain(&live_seqs).copied().collect();
    assert_eq!(
        all.len(),
        snapshot_seqs.len() + live_seqs.len(),
        "no event is delivered twice"
    );
    assert_eq!(
        all,
        (1..=230).collect::<BTreeSet<u64>>(),
        "no hole between snapshot and live"
    );

    // Quiesced: the snapshot of the full log equals the durable replay.
    persistence.flush_session("sess-s").await.unwrap();
    let (_c2, _rx2, again, head2) = relay.subscribe_snapshot("sess-s").await.unwrap();
    assert_eq!(head2.head_seq, 230);
    assert_eq!(head2.log_epoch, head.log_epoch);
    assert_eq!(
        again.iter().map(|event| event.seq).collect::<Vec<_>>(),
        persistence
            .replay_after("sess-s", 0)
            .unwrap()
            .iter()
            .map(|record| record.seq)
            .collect::<Vec<_>>()
    );
    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

/// The shutdown `interrupted` marker takes its seq from the relay's
/// allocator, so the relay's frontier moves with the durable log.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn interrupted_marker_seq_comes_from_the_relay_allocator() {
    let (relay, persistence, root) = relay_with_session("marker", "sess-m").await;
    relay.record_user_prompt(
        "sess-m",
        json!({"sessionId": "sess-m", "turnId": "turn-1", "content": []}),
    );
    relay.emit(&chunk("sess-m", "work"));
    persistence.flush_session("sess-m").await.unwrap();
    assert_eq!(relay.session_watermark("sess-m"), 2);

    persistence.shutdown().await.unwrap();

    let records = persistence.replay_after("sess-m", 0).unwrap();
    let marker = records.last().expect("marker appended");
    assert_eq!(marker.type_, "prompt_complete");
    assert_eq!(marker.seq, 3);
    assert_eq!(relay.session_watermark("sess-m"), 3);
    let _ = std::fs::remove_dir_all(root);
}

/// A host record nudges history refetch once: exactly one `seq = 0`
/// `chat_history_changed` per record (not one per code path that touches it).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn host_record_notifies_history_changed_exactly_once() {
    let (relay, persistence, root) = relay_with_session("history-nudge", "sess-h").await;
    let (_client, mut rx, _replay, _head) = relay.subscribe("sess-h", None, None).await;

    for (type_, payload) in [
        ("agent_switch", json!({"sessionId": "sess-h"})),
        (
            "local_title_generated",
            json!({"sessionId": "sess-h", "title": "t"}),
        ),
    ] {
        relay.record_host_event("sess-h", type_, payload).unwrap();
        let mut nudges = 0;
        let mut logged = Vec::new();
        while let Ok(event) = rx.try_recv() {
            if event.seq == 0 {
                assert_eq!(event.type_, "chat_history_changed");
                nudges += 1;
            } else {
                logged.push(event.type_);
            }
        }
        assert_eq!(nudges, 1, "{type_}: one history nudge");
        assert_eq!(logged, vec![type_.to_string()], "{type_}: one live record");
    }
    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}
