//! Log epochs: a replay cursor `(logEpoch, lastSeq)` is only honoured against
//! the log incarnation it was issued under.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;

use super::*;
use crate::acp::session_persistence::{SessionPersistence, SessionRegistration};

fn event(sid: &str) -> AcpEvent {
    AcpEvent {
        sid: Some(sid.to_string()),
        type_: "acp:tool_call",
        payload: json!({"sessionId": sid}),
    }
}

/// A temp directory removed when the test ends.
struct TempRoot(PathBuf);

impl std::ops::Deref for TempRoot {
    type Target = PathBuf;
    fn deref(&self) -> &PathBuf {
        &self.0
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn temp_dir(label: &str) -> TempRoot {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!("termul-epoch-{label}-{nanos}"));
    std::fs::create_dir_all(&path).unwrap();
    TempRoot(path)
}

async fn durable_relay(
    label: &str,
    sid: &str,
) -> (Arc<WsRelaySink>, Arc<SessionPersistence>, TempRoot) {
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

/// The same epoch with a cursor at or below the head resumes; the reply head
/// is the allocated frontier.
#[tokio::test]
async fn cursor_under_the_current_epoch_resumes_and_returns_the_head() {
    let relay = WsRelaySink::new();
    for _ in 0..3 {
        relay.emit(&event("s"));
    }
    let epoch = relay.log_head("s").unwrap().log_epoch;

    let (_client, _rx, replay, head) = relay.subscribe("s", Some(2), Some(&epoch)).await;

    assert_eq!(replay, ReplayResult::Ok(1));
    let head = head.expect("a registered subscription reports the head");
    assert_eq!((head.log_epoch, head.head_seq), (epoch, 3));
}

/// A cursor from another epoch (the host restarted without durable history)
/// is `Stale` and registers nothing.
#[tokio::test]
async fn cursor_under_another_epoch_is_stale_and_unregistered() {
    let relay = WsRelaySink::new();
    relay.emit(&event("s"));

    let (_client, _rx, replay, head) = relay
        .subscribe("s", Some(1), Some("epoch-from-before-restart"))
        .await;

    assert_eq!(replay, ReplayResult::Stale);
    assert!(head.is_none());
    assert_eq!(relay.session_subscriber_count("s"), 0);
}

/// A cursor ahead of the head belongs to some other log: `Stale`, no silent
/// empty replay that would swallow the next events as duplicates.
#[tokio::test]
async fn cursor_ahead_of_the_head_is_stale_without_registering() {
    let relay = WsRelaySink::new();
    for _ in 0..3 {
        relay.emit(&event("s"));
    }

    let (_client, _rx, replay, _) = relay.subscribe("s", Some(10), None).await;

    assert_eq!(replay, ReplayResult::Stale);
    assert_eq!(relay.session_subscriber_count("s"), 0);
}

/// A durable session's epoch is the one persisted in its metadata, shared by
/// the relay's log and `log_head`, and survives a host restart; an
/// ahead-of-head cursor is stale there too.
#[tokio::test]
async fn durable_epoch_is_persisted_and_survives_a_restart() {
    let (relay, persistence, root) = durable_relay("durable", "sess-d").await;
    relay.emit(&event("sess-d"));
    let epoch = persistence
        .log_epoch("sess-d")
        .expect("minted at registration");
    assert_eq!(relay.log_head("sess-d").unwrap().log_epoch, epoch);
    persistence.flush_session("sess-d").await.unwrap();

    let (_c, _rx, replay, _) = relay.subscribe("sess-d", Some(9), Some(&epoch)).await;
    assert_eq!(
        replay,
        ReplayResult::Stale,
        "cursor ahead of a durable head"
    );

    let reopened = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    assert_eq!(
        reopened.log_epoch("sess-d").as_deref(),
        Some(epoch.as_str())
    );
    let restarted = WsRelaySink::with_persistence(64, reopened);
    let (_c, _rx, replay, head) = restarted.subscribe("sess-d", Some(1), Some(&epoch)).await;
    assert_eq!(replay, ReplayResult::Ok(0));
    assert_eq!(head.unwrap().log_epoch, epoch);
}

/// A legacy metadata file without `logEpoch` gets one when loaded, and it is
/// persisted on that load: reopening again sees the same epoch (a failure to
/// persist would mint a different one every time).
#[tokio::test]
async fn legacy_metadata_without_an_epoch_is_minted_and_persisted_on_load() {
    let (_relay, persistence, root) = durable_relay("legacy", "sess-l").await;
    persistence.flush_session("sess-l").await.unwrap();
    let storage_key = persistence.metadata("sess-l").unwrap().storage_key;
    drop(persistence);
    let metadata_path = root
        .join("sessions")
        .join(&storage_key)
        .join("metadata.json");
    let mut metadata: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&metadata_path).unwrap()).unwrap();
    metadata.as_object_mut().unwrap().remove("logEpoch");
    std::fs::write(&metadata_path, serde_json::to_vec(&metadata).unwrap()).unwrap();

    let first = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    let epoch = first.log_epoch("sess-l").expect("minted on load");
    assert!(!epoch.is_empty());
    let on_disk: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&metadata_path).unwrap()).unwrap();
    assert_eq!(
        on_disk["logEpoch"],
        json!(epoch),
        "persisted by the load itself"
    );

    let second = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    assert_eq!(second.log_epoch("sess-l").as_deref(), Some(epoch.as_str()));
    let third = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    assert_eq!(third.log_epoch("sess-l").as_deref(), Some(epoch.as_str()));
}

/// The agent's first events can beat `register_session`: the relay then holds
/// the log under a process-minted epoch, and must report the persisted one as
/// soon as the session is registered.
#[tokio::test]
async fn events_before_registration_adopt_the_persisted_epoch() {
    let root = temp_dir("prereg");
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    let relay = Arc::new(WsRelaySink::with_persistence(64, persistence.clone()));
    relay.emit(&event("sess-p"));
    let before = relay.log_head("sess-p").expect("state exists").log_epoch;

    persistence
        .register_session(SessionRegistration {
            session_id: "sess-p".to_string(),
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();

    let persisted = persistence
        .log_epoch("sess-p")
        .expect("minted at registration");
    assert_ne!(
        before, persisted,
        "the process-minted epoch was a placeholder"
    );
    assert_eq!(relay.log_head("sess-p").unwrap().log_epoch, persisted);
    relay.emit(&event("sess-p"));
    let (_c, _rx, replay, head) = relay.subscribe("sess-p", Some(1), Some(&persisted)).await;
    assert!(matches!(replay, ReplayResult::Ok(_)), "{replay:?}");
    assert_eq!(head.unwrap().log_epoch, persisted);
}

/// A non-durable event (permission_request) takes a seq that never reaches the
/// JSONL. After a restart the allocator resumes from the durable frontier and
/// would hand the same seq to a different event, so the epoch must rotate for
/// such a session — and only for such a session, and only once.
#[tokio::test]
async fn restart_rotates_the_epoch_when_the_frontier_had_run_ahead_of_the_disk() {
    let (relay, persistence, root) = durable_relay("ahead", "sess-a").await;
    relay.emit(&event("sess-a"));
    let permission = AcpEvent {
        sid: Some("sess-a".to_string()),
        type_: "acp:permission_request",
        payload: json!({"sessionId": "sess-a", "requestId": "r1", "options": []}),
    };
    relay.emit(&permission);
    persistence.flush_session("sess-a").await.unwrap();
    let before = persistence.log_epoch("sess-a").unwrap();
    assert_eq!(
        relay.log_head("sess-a").unwrap().head_seq,
        2,
        "seq 2 is live-only"
    );
    assert_eq!(
        persistence.last_seq("sess-a").unwrap(),
        1,
        "and never on disk"
    );
    drop((relay, persistence));

    let reopened = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    let after = reopened.log_epoch("sess-a").unwrap();
    assert_ne!(
        before, after,
        "a cursor at the old seq 2 must not resume in the new log"
    );
    let restarted = WsRelaySink::with_persistence(64, reopened);
    let (_c, _rx, replay, _) = restarted.subscribe("sess-a", Some(2), Some(&before)).await;
    assert_eq!(replay, ReplayResult::Stale);

    let again = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    assert_eq!(
        again.log_epoch("sess-a").as_deref(),
        Some(after.as_str()),
        "the rotation cleared the mark: the next restart keeps the epoch"
    );
}

/// A live-only event that beats `register_session` finds no catalog entry to
/// mark. The relay remembers the mark and applies it when the session
/// registers, so the epoch still rotates on the next restart.
#[tokio::test]
async fn live_only_event_before_registration_still_rotates_the_epoch_on_restart() {
    let root = temp_dir("prereg-ahead");
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    let relay = Arc::new(WsRelaySink::with_persistence(64, persistence.clone()));
    relay.emit(&AcpEvent {
        sid: Some("sess-r".to_string()),
        type_: "acp:permission_request",
        payload: json!({"sessionId": "sess-r", "requestId": "r1", "options": []}),
    });
    persistence
        .register_session(SessionRegistration {
            session_id: "sess-r".to_string(),
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    relay.note_session_registered_inherent("sess-r");
    persistence.flush_session("sess-r").await.unwrap();
    let before = persistence.log_epoch("sess-r").unwrap();
    drop((relay, persistence));

    let reopened = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    assert_ne!(
        reopened.log_epoch("sess-r").unwrap(),
        before,
        "the seq the permission request took never reached the disk"
    );
}

/// A session with no writer (finalized) gets its head-ahead mark written
/// inline, and a session whose directory is gone never gets it back.
#[tokio::test]
async fn inline_head_ahead_mark_is_written_but_never_recreates_a_removed_directory() {
    let (_relay, persistence, root) = durable_relay("inline", "sess-i").await;
    persistence
        .finalize_session(
            "sess-i",
            crate::acp::session_persistence::PersistedSessionStatus::Closed,
        )
        .await
        .unwrap();
    let storage_key = persistence.metadata("sess-i").unwrap().storage_key;
    let dir = root.join("sessions").join(&storage_key);
    let on_disk = |dir: &std::path::Path| -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(dir.join("metadata.json")).unwrap()).unwrap()
    };

    persistence.note_head_ahead_of_durable("sess-i");
    assert_eq!(on_disk(&dir)["headAheadOfDurable"], json!(true));

    let (_relay2, persistence2, root2) = durable_relay("inline-gone", "sess-g").await;
    persistence2
        .finalize_session(
            "sess-g",
            crate::acp::session_persistence::PersistedSessionStatus::Closed,
        )
        .await
        .unwrap();
    let gone = root2
        .join("sessions")
        .join(persistence2.metadata("sess-g").unwrap().storage_key);
    std::fs::remove_dir_all(&gone).unwrap();
    persistence2.note_head_ahead_of_durable("sess-g");
    assert!(!gone.exists(), "a removed session directory stays removed");
}

/// An inline write that fails clears the flag again, so the next live-only
/// event retries and the mark still reaches the disk.
#[tokio::test]
async fn failed_inline_head_ahead_write_is_retried_by_the_next_call() {
    let (_relay, persistence, root) = durable_relay("retry", "sess-t").await;
    persistence
        .finalize_session(
            "sess-t",
            crate::acp::session_persistence::PersistedSessionStatus::Closed,
        )
        .await
        .unwrap();
    let dir = root
        .join("sessions")
        .join(persistence.metadata("sess-t").unwrap().storage_key);
    let file = dir.join("metadata.json");
    let original = std::fs::read(&file).unwrap();
    // A directory where the file belongs: the atomic replace cannot succeed.
    std::fs::remove_file(&file).unwrap();
    std::fs::create_dir(&file).unwrap();

    persistence.note_head_ahead_of_durable("sess-t");
    assert!(file.is_dir(), "the write failed");

    std::fs::remove_dir(&file).unwrap();
    std::fs::write(&file, original).unwrap();
    persistence.note_head_ahead_of_durable("sess-t");
    let on_disk: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(
        on_disk["headAheadOfDurable"],
        json!(true),
        "retried and persisted"
    );
}

/// A queued mark write that fails in the live writer is retried after the
/// writer's next command, so the mark still reaches the disk once the disk
/// recovers.
#[tokio::test]
async fn writer_retries_a_failed_head_ahead_write_after_its_next_command() {
    let (relay, persistence, root) = durable_relay("wretry", "sess-w").await;
    let file = root
        .join("sessions")
        .join(persistence.metadata("sess-w").unwrap().storage_key)
        .join("metadata.json");
    let original = std::fs::read(&file).unwrap();
    // A directory where the file belongs: the writer's atomic replace fails.
    std::fs::remove_file(&file).unwrap();
    std::fs::create_dir(&file).unwrap();

    persistence.note_head_ahead_of_durable("sess-w");
    // The writer is FIFO: once this flush returns, the mark write has run (and failed).
    assert!(persistence.flush_session("sess-w").await.is_err());
    std::fs::remove_dir(&file).unwrap();
    std::fs::write(&file, original).unwrap();

    // An append does not write metadata itself; the retry does.
    relay.emit(&event("sess-w"));
    let mut persisted = false;
    for _ in 0..100 {
        let on_disk: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        if on_disk["headAheadOfDurable"] == json!(true) {
            persisted = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(
        persisted,
        "the writer retried the mark after the disk recovered"
    );
}

/// The pre-registration buffer holds a bounded number of records. A burst
/// larger than that loses its oldest records for good, so the seq frontier
/// is ahead of the disk and the epoch must rotate on restart.
#[tokio::test]
async fn pre_registration_buffer_overflow_rotates_the_epoch_on_restart() {
    let root = temp_dir("prereg-overflow");
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    let relay = Arc::new(WsRelaySink::with_persistence(64, persistence.clone()));
    // More than the 256-record buffer can hold.
    for _ in 0..300 {
        relay.emit(&event("sess-o"));
    }
    persistence
        .register_session(SessionRegistration {
            session_id: "sess-o".to_string(),
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    relay.note_session_registered_inherent("sess-o");
    persistence.flush_session("sess-o").await.unwrap();
    let before = persistence.log_epoch("sess-o").unwrap();
    drop((relay, persistence));

    let reopened = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    assert_ne!(
        reopened.log_epoch("sess-o").unwrap(),
        before,
        "the evicted records never reached the disk"
    );
}
