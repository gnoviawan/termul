//! CAP-8 (spec-in-chat-agent-switch): the durable `continued_from` edge.
//! `note_continued_from` stamps the switch TARGET with its source session,
//! the field round-trips through metadata + index + payload, and the
//! one-time recovery migration backfills edges for chains recorded before
//! the host stamped the field (the `agent_switch` marker stays the
//! authority the migration reads).

use super::*;
use serde_json::json;

fn temp_dir(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "termul-continued-from-{label}-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

fn registration(session_id: &str) -> SessionRegistration {
    SessionRegistration {
        session_id: session_id.to_string(),
        stable_agent_namespace: Some("config:test".to_string()),
        runtime_agent_id: Some("agent-1".to_string()),
        project_id: Some("project-1".to_string()),
        cwd: PathBuf::from("/tmp"),
        ..Default::default()
    }
}

fn switch_record(session_id: &str, seq: u64, new_session_id: &str) -> PersistedEventRecord {
    PersistedEventRecord {
        schema_version: SESSION_SCHEMA_VERSION,
        session_id: session_id.to_string(),
        seq,
        type_: "agent_switch".to_string(),
        recorded_at: 1_000 + seq,
        payload: json!({
            "sessionId": session_id,
            "fromConfigId": "omp",
            "toConfigId": "claude",
            "newSessionId": new_session_id,
            "summaryText": "Handoff summary",
        }),
    }
}

#[tokio::test]
async fn note_continued_from_stamps_metadata_index_and_payload() {
    let root = temp_dir("stamp");
    let persistence = SessionPersistence::open(root.join("store")).await.unwrap();
    persistence
        .register_session(registration("src"))
        .await
        .unwrap();
    persistence
        .register_session(registration("dst"))
        .await
        .unwrap();

    persistence.note_continued_from("dst", "src").await.unwrap();

    assert_eq!(
        persistence.metadata("dst").unwrap().continued_from.as_deref(),
        Some("src")
    );
    let entry = persistence
        .list_sessions()
        .into_iter()
        .find(|entry| entry.session_id == "dst")
        .expect("dst index entry");
    assert_eq!(entry.continued_from.as_deref(), Some("src"));
    let payload = persistence.session_payload_async("dst").await.unwrap();
    assert_eq!(payload.metadata.continued_from.as_deref(), Some("src"));

    // The stamp survives a reopen (metadata is durable, not index-only).
    persistence.shutdown().await.unwrap();
    let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
    assert_eq!(
        reopened.metadata("dst").unwrap().continued_from.as_deref(),
        Some("src")
    );
    reopened.shutdown().await.unwrap();
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn note_continued_from_is_idempotent_and_first_write_wins() {
    let root = temp_dir("idempotent");
    let persistence = SessionPersistence::open(root.join("store")).await.unwrap();
    persistence
        .register_session(registration("src"))
        .await
        .unwrap();
    persistence
        .register_session(registration("other"))
        .await
        .unwrap();
    persistence
        .register_session(registration("dst"))
        .await
        .unwrap();

    persistence.note_continued_from("dst", "src").await.unwrap();
    persistence.note_continued_from("dst", "other").await.unwrap();
    persistence.note_continued_from("dst", "src").await.unwrap();

    assert_eq!(
        persistence.metadata("dst").unwrap().continued_from.as_deref(),
        Some("src")
    );
    persistence.shutdown().await.unwrap();
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn note_continued_from_unknown_session_is_an_error_not_a_panic() {
    let root = temp_dir("unknown");
    let persistence = SessionPersistence::open(root.join("store")).await.unwrap();
    assert!(persistence.note_continued_from("ghost", "src").await.is_err());
    persistence.shutdown().await.unwrap();
    let _ = fs::remove_dir_all(root);
}

/// Pre-feature chain: the source log carries a durable `agent_switch` but
/// the target metadata predates `continued_from`. The next `open` backfills
/// the edge and writes the migration marker.
#[tokio::test]
async fn recovery_backfills_continued_from_from_durable_switch_markers() {
    let root = temp_dir("backfill");
    let store = root.join("store");
    let persistence = SessionPersistence::open(store.clone()).await.unwrap();
    persistence
        .register_session(registration("src"))
        .await
        .unwrap();
    persistence
        .register_session(registration("dst"))
        .await
        .unwrap();
    persistence
        .enqueue_event(switch_record("src", 1, "dst"))
        .unwrap();
    persistence.flush_session("src").await.unwrap();
    persistence.shutdown().await.unwrap();

    // Pre-feature upgrade: the store predates the migration, so its marker
    // is absent (the fresh-store open above stamped it trivially).
    fs::remove_file(store.join(CONTINUED_FROM_MIGRATION_MARKER)).unwrap();
    let reopened = SessionPersistence::open(store.clone()).await.unwrap();
    assert_eq!(
        reopened.metadata("dst").unwrap().continued_from.as_deref(),
        Some("src")
    );
    assert_eq!(
        reopened
            .list_sessions()
            .into_iter()
            .find(|entry| entry.session_id == "dst")
            .unwrap()
            .continued_from
            .as_deref(),
        Some("src")
    );
    reopened.shutdown().await.unwrap();

    // The marker held: a second open does not re-run the scan but the edge
    // stays stamped (it is durable metadata now).
    let reopened_again = SessionPersistence::open(store.clone()).await.unwrap();
    assert_eq!(
        reopened_again
            .metadata("dst")
            .unwrap()
            .continued_from
            .as_deref(),
        Some("src")
    );
    reopened_again.shutdown().await.unwrap();
    let _ = fs::remove_dir_all(root);
}

/// A switch chain A→B→C backfills every hop: B continues A, C continues B.
#[tokio::test]
async fn recovery_backfills_multi_hop_chains() {
    let root = temp_dir("multi-hop");
    let store = root.join("store");
    let persistence = SessionPersistence::open(store.clone()).await.unwrap();
    for id in ["a", "b", "c"] {
        persistence.register_session(registration(id)).await.unwrap();
    }
    persistence.enqueue_event(switch_record("a", 1, "b")).unwrap();
    persistence.enqueue_event(switch_record("b", 1, "c")).unwrap();
    persistence.flush_session("a").await.unwrap();
    persistence.flush_session("b").await.unwrap();
    persistence.shutdown().await.unwrap();

    fs::remove_file(store.join(CONTINUED_FROM_MIGRATION_MARKER)).unwrap();
    let reopened = SessionPersistence::open(store.clone()).await.unwrap();
    assert_eq!(
        reopened.metadata("b").unwrap().continued_from.as_deref(),
        Some("a")
    );
    assert_eq!(
        reopened.metadata("c").unwrap().continued_from.as_deref(),
        Some("b")
    );
    // The chain's first session keeps no edge.
    assert_eq!(reopened.metadata("a").unwrap().continued_from, None);
    reopened.shutdown().await.unwrap();
    let _ = fs::remove_dir_all(root);
}

/// The newest marker wins when a log records more than one switch, and a
/// target that already carries `continued_from` is never overwritten.
#[tokio::test]
async fn recovery_respects_newest_marker_and_existing_edges() {
    let root = temp_dir("newest");
    let store = root.join("store");
    let persistence = SessionPersistence::open(store.clone()).await.unwrap();
    for id in ["src", "dst-1", "dst-2"] {
        persistence.register_session(registration(id)).await.unwrap();
    }
    persistence
        .enqueue_event(switch_record("src", 1, "dst-1"))
        .unwrap();
    persistence
        .enqueue_event(switch_record("src", 2, "dst-2"))
        .unwrap();
    persistence
        .register_session(registration("pre-stamped"))
        .await
        .unwrap();
    persistence
        .note_continued_from("pre-stamped", "elsewhere")
        .await
        .unwrap();
    // A marker naming the pre-stamped target must not repoint it.
    persistence
        .register_session(registration("other-src"))
        .await
        .unwrap();
    persistence
        .enqueue_event(switch_record("other-src", 1, "pre-stamped"))
        .unwrap();
    persistence.flush_session("src").await.unwrap();
    persistence.flush_session("other-src").await.unwrap();
    persistence.shutdown().await.unwrap();

    fs::remove_file(store.join(CONTINUED_FROM_MIGRATION_MARKER)).unwrap();
    let reopened = SessionPersistence::open(store.clone()).await.unwrap();
    // Only the newest marker's target gained an edge.
    assert_eq!(
        reopened.metadata("dst-2").unwrap().continued_from.as_deref(),
        Some("src")
    );
    assert_eq!(reopened.metadata("dst-1").unwrap().continued_from, None);
    // An existing stamp is authoritative over the migration's candidate.
    assert_eq!(
        reopened
            .metadata("pre-stamped")
            .unwrap()
            .continued_from
            .as_deref(),
        Some("elsewhere")
    );
    reopened.shutdown().await.unwrap();
    let _ = fs::remove_dir_all(root);
}
