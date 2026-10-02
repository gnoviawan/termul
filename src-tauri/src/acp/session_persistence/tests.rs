use super::*;
use serde_json::json;

fn temp_dir(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "termul-sessions-{label}-{}-{}",
        std::process::id(),
        now_millis()
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

async fn registered(root: &Path) -> (Arc<SessionPersistence>, SessionMetadata) {
    let cwd = root.join("cwd");
    fs::create_dir_all(&cwd).unwrap();
    let persistence = SessionPersistence::open(root.join("store")).await.unwrap();
    let metadata = persistence
        .register_session(SessionRegistration {
            session_id: "session-1".to_string(),
            stable_agent_namespace: Some("config:one".to_string()),
            runtime_agent_id: Some("runtime-1".to_string()),
            project_id: Some("project-1".to_string()),
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    (persistence, metadata)
}

fn record(seq: u64, type_: &str) -> PersistedEventRecord {
    PersistedEventRecord {
        schema_version: SESSION_SCHEMA_VERSION,
        session_id: "session-1".to_string(),
        seq,
        type_: type_.to_string(),
        recorded_at: now_millis(),
        payload: json!({"sessionId":"session-1","content":[{"type":"text","text":"hello"}]}),
    }
}

#[test]
fn normalize_title_uses_first_line_sanitizes_and_bounds_to_48() {
    assert_eq!(
        normalize_title("  **`Fix login bug`**  \nignored explanation"),
        "Fix login bug"
    );
    assert_eq!(
        normalize_title("Sure! Here's the title:\nFix login bug"),
        "Fix login bug"
    );
    assert_eq!(normalize_title("Title: Fix login bug"), "Fix login bug");
    let long = "a".repeat(60);
    let normalized = normalize_title(&long);
    assert_eq!(normalized.chars().count(), 49);
    assert!(normalized.ends_with('…'));
    assert_eq!(normalize_title(" \nsecond line"), "second line");
    assert_eq!(normalize_title(" \n \r"), "Untitled Chat");
}

#[tokio::test]
async fn register_discovered_session_is_metadata_only_agent_supplied_and_idempotent() {
    let root = temp_dir("discovered");
    let cwd = root.join("cwd");
    fs::create_dir_all(&cwd).unwrap();
    let persistence = SessionPersistence::open(root.join("store")).await.unwrap();
    let registration = SessionRegistration {
        session_id: "discovered-1".into(),
        stable_agent_namespace: Some("config:test".into()),
        runtime_agent_id: Some("agent-1".into()),
        project_id: Some("project-1".into()),
        cwd,
        ..Default::default()
    };
    let first = persistence
        .register_discovered_session(registration.clone(), Some("Agent title".into()), Some(42))
        .await
        .unwrap();
    assert_eq!(first.status, PersistedSessionStatus::Active);
    persistence.shutdown().await.unwrap();
    let persistence = SessionPersistence::open(root.join("store")).await.unwrap();
    let second = persistence
        .register_discovered_session(registration.clone(), Some("Replacement".into()), Some(99))
        .await
        .unwrap();
    assert_eq!(first.storage_key, second.storage_key);
    assert_eq!(second.title.as_deref(), Some("Replacement"));
    assert_eq!(second.title_source, Some(TitleSource::AgentSupplied));
    assert_eq!(second.status, PersistedSessionStatus::Active);
    assert_eq!(second.runtime_agent_id.as_deref(), Some("agent-1"));
    assert_eq!(second.message_count, 0);
    assert_eq!(second.tool_count, 0);
    assert_eq!(second.last_seq, 0);
    assert!(persistence
        .replay_after("discovered-1", 0)
        .unwrap()
        .is_empty());
    let mut conflicting = registration;
    conflicting.stable_agent_namespace = Some("config:other".into());
    let conflict = persistence
        .register_discovered_session(conflicting, Some("Wrong owner".into()), Some(100))
        .await
        .unwrap_err();
    assert!(conflict
        .to_string()
        .contains("conflicts with an existing session scope"));
    assert_eq!(
        persistence
            .metadata("discovered-1")
            .unwrap()
            .title
            .as_deref(),
        Some("Replacement")
    );
    persistence.shutdown().await.unwrap();
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn first_run_registers_and_round_trips_interleaved_replay() {
    let root = temp_dir("roundtrip");
    let (persistence, metadata) = registered(&root).await;
    for (seq, type_) in [
        (1, "user_prompt"),
        (2, "message_chunk"),
        (3, "tool_call"),
        (4, "message_chunk"),
        (5, "tool_call_update"),
        (6, "prompt_complete"),
    ] {
        persistence.enqueue_event(record(seq, type_)).unwrap();
    }
    persistence.flush_session("session-1").await.unwrap();
    assert_eq!(
        persistence
            .replay_after("session-1", 2)
            .unwrap()
            .iter()
            .map(|r| r.seq)
            .collect::<Vec<_>>(),
        vec![3, 4, 5, 6]
    );
    persistence.shutdown().await.unwrap();

    let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
    assert_eq!(reopened.last_seq("session-1").unwrap(), 6);
    assert_eq!(
        reopened.metadata("session-1").unwrap().storage_key,
        metadata.storage_key
    );
    let _ = fs::remove_dir_all(root);
}

#[cfg(target_os = "windows")]
#[tokio::test]
async fn register_session_strips_verbatim_cwd_prefix_on_windows() {
    // `canonicalize()` prepends `\\?\` on Windows. The persisted `cwd`
    // must be stripped so `session/resume` passes a tool-friendly path
    // to the agent (whose cwd→dir sanitizer keeps `?` → illegal folder
    // name → `mkdir` ENOENT → resume skipped). This test creates a real
    // temp dir, canonicalizes it (so the verbatim prefix is present in
    // the `PathBuf`), and asserts the persisted `cwd` has no prefix.
    let root = temp_dir("verbatim-strip");
    let cwd = root.join("cwd");
    fs::create_dir_all(&cwd).unwrap();
    // `canonicalize()` yields `\\?\C:\…\cwd` on Windows.
    let canonical_cwd = cwd.canonicalize().unwrap();
    assert!(
        canonical_cwd.to_string_lossy().starts_with(r"\\?\"),
        "sanity: canonicalize should produce a verbatim prefix on Windows"
    );
    let persistence = SessionPersistence::open(root.join("store")).await.unwrap();
    let metadata = persistence
        .register_session(SessionRegistration {
            session_id: "session-verbatim".to_string(),
            stable_agent_namespace: Some("config:test".to_string()),
            runtime_agent_id: Some("runtime-1".to_string()),
            project_id: Some("project-1".to_string()),
            cwd: canonical_cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(
        !metadata.cwd.starts_with(r"\\?\"),
        "persisted cwd must not carry the verbatim prefix, got: {}",
        metadata.cwd
    );
    // `recover()` must heal a verbatim cwd persisted by an older build.
    // Manually corrupt the metadata on disk AFTER shutdown (which
    // persists the in-memory stripped metadata), so the reopen step
    // actually tests recover() healing a legacy verbatim prefix.
    persistence.shutdown().await.unwrap();
    {
        let metadata_path = persistence
            .session_dir(&metadata.storage_key)
            .unwrap()
            .join(METADATA_FILE);
        let mut corrupt = metadata.clone();
        corrupt.cwd = format!(r"\\?\{}", corrupt.cwd);
        let bytes = serde_json::to_vec_pretty(&corrupt).unwrap();
        std::fs::write(&metadata_path, &bytes).unwrap();
    }
    let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
    let healed = reopened.metadata("session-verbatim").unwrap();
    assert!(
        !healed.cwd.starts_with(r"\\?\"),
        "recover() must strip a verbatim prefix from a legacy persisted cwd, got: {}",
        healed.cwd
    );
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn concurrent_queue_serializes_unique_sequences() {
    let root = temp_dir("serialize");
    let (persistence, _) = registered(&root).await;
    let sequence = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let mut producers = Vec::new();
    for _ in 0..8 {
        let persistence = Arc::clone(&persistence);
        let sequence = Arc::clone(&sequence);
        producers.push(tokio::spawn(async move {
            for _ in 0..25 {
                let seq = sequence.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                persistence
                    .enqueue_event(record(seq, "message_chunk"))
                    .unwrap();
            }
        }));
    }
    for producer in producers {
        producer.await.unwrap();
    }
    persistence.flush_session("session-1").await.unwrap();
    let replay = persistence.replay_after("session-1", 0).unwrap();
    assert_eq!(replay.len(), 200);
    assert_eq!(
        replay.iter().map(|record| record.seq).collect::<Vec<_>>(),
        (1..=200).collect::<Vec<_>>()
    );
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn different_sessions_progress_independently_and_finalize_drains_prior_writes() {
    let root = temp_dir("independent");
    let (persistence, _) = registered(&root).await;
    let cwd2 = root.join("cwd2");
    fs::create_dir_all(&cwd2).unwrap();
    persistence
        .register_session(SessionRegistration {
            session_id: "session-2".into(),
            stable_agent_namespace: None,
            runtime_agent_id: None,
            project_id: None,
            cwd: cwd2,
            ..Default::default()
        })
        .await
        .unwrap();
    for seq in 1..=50 {
        persistence
            .enqueue_event(record(seq, "message_chunk"))
            .unwrap();
        let mut other = record(seq, "message_chunk");
        other.session_id = "session-2".into();
        persistence.enqueue_event(other).unwrap();
    }
    persistence
        .finalize_session("session-1", PersistedSessionStatus::Closed)
        .await
        .unwrap();
    assert!(
        !persistence.inner.sessions.lock().contains_key("session-1"),
        "finalization must remove the dead writer runtime"
    );
    assert_eq!(
        persistence.metadata("session-1").unwrap().status,
        PersistedSessionStatus::Closed,
        "finalized metadata remains available for listing/replay"
    );
    persistence.flush_session("session-2").await.unwrap();
    assert_eq!(persistence.replay_after("session-1", 0).unwrap().len(), 50);
    assert_eq!(persistence.replay_after("session-2", 0).unwrap().len(), 50);
    assert_eq!(
        persistence.metadata("session-1").unwrap().status,
        PersistedSessionStatus::Closed
    );
    assert!(matches!(
        persistence.enqueue_event(record(51, "message_chunk")),
        Err(SessionPersistenceError::SessionNotFound)
    ));
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn failed_finalize_removes_writer_and_retains_read_only_catalog() {
    let root = temp_dir("finalize-failure");
    let (persistence, metadata) = registered(&root).await;
    persistence
        .enqueue_event(record(1, "message_chunk"))
        .unwrap();
    let session_dir = root.join("store").join(&metadata.storage_key);
    fs::remove_file(session_dir.join(METADATA_FILE)).unwrap();
    fs::create_dir(session_dir.join(METADATA_FILE)).unwrap();

    assert!(persistence
        .finalize_session("session-1", PersistedSessionStatus::Closed)
        .await
        .is_err());
    assert!(!persistence.inner.sessions.lock().contains_key("session-1"));
    assert_eq!(
        persistence.metadata("session-1").unwrap().status,
        PersistedSessionStatus::Closed
    );
    assert!(matches!(
        persistence.enqueue_event(record(2, "message_chunk")),
        Err(SessionPersistenceError::SessionNotFound)
    ));
    let replay = persistence.replay_after("session-1", 0).unwrap();
    assert_eq!(replay.len(), 1);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn durable_payload_redacts_secret_fields_and_bounds_titles() {
    let root = temp_dir("redaction");
    let (persistence, metadata) = registered(&root).await;
    let mut event = record(1, "tool_call");
    event.payload = json!({
        "agentId":"a", "sessionId":"session-1",
        "toolCall": {"toolCallId":"t", "title":"ordinary-text-token-123",
            "kind":"execute", "status":"pending",
            "rawInput":{"apiKey":"secret"}, "headers":{"Authorization":"bearer"},
            "content":[{"type":"content","content":{"type":"text","text":"ordinary-text-token-123"}}]}
    });
    persistence.enqueue_event(event).unwrap();
    let mut title = record(2, "session_info_update");
    title.payload = json!({"sessionId":"session-1", "title": format!("  {}  ", "x".repeat(100)), "token":"secret"});
    persistence.enqueue_event(title).unwrap();
    persistence.flush_session("session-1").await.unwrap();
    let records = persistence.replay_after("session-1", 0).unwrap();
    let serialized = serde_json::to_string(&records).unwrap();
    assert!(!serialized.contains("secret"));
    assert!(!serialized.contains("rawInput"));
    assert!(!serialized.contains("Authorization"));
    assert!(!serialized.contains("ordinary-text-token-123"));
    assert!(serialized.contains("toolCallId"));
    assert!(serialized.contains("execute"));
    assert_eq!(
        persistence
            .metadata("session-1")
            .unwrap()
            .title
            .unwrap()
            .chars()
            .count(),
        49
    );
    let tool_log = fs::read_to_string(
        root.join("store")
            .join(metadata.storage_key)
            .join(TOOL_CALLS_FILE),
    )
    .unwrap();
    assert!(!tool_log.contains("apiKey"));
    assert!(!tool_log.contains("ordinary-text-token-123"));
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn completed_turn_ids_recover_after_restart() {
    let root = temp_dir("completed-turns");
    let (persistence, _) = registered(&root).await;
    let mut complete = record(1, "prompt_complete");
    complete.payload = json!({"sessionId":"session-1", "turnId":"turn-1", "stopReason":"end_turn"});
    persistence.enqueue_event(complete).unwrap();
    persistence.shutdown().await.unwrap();
    let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
    assert!(reopened
        .completed_turn_ids("session-1")
        .unwrap()
        .contains("turn-1"));
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn future_index_version_is_rejected_without_rewrite() {
    let root = temp_dir("future");
    let store = root.join("store");
    fs::create_dir_all(&store).unwrap();
    let path = store.join(INDEX_FILE);
    let bytes = br#"{"schemaVersion":99,"sessions":[]}"#;
    fs::write(&path, bytes).unwrap();
    assert!(matches!(
        SessionPersistence::open(store).await,
        Err(SessionPersistenceError::UnsupportedVersion { found: 99 })
    ));
    assert_eq!(fs::read(path).unwrap(), bytes);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn overflowing_index_and_metadata_versions_are_rejected_without_rewrite() {
    let root = temp_dir("version-overflow");
    let store = root.join("store");
    fs::create_dir_all(&store).unwrap();
    let index = store.join(INDEX_FILE);
    let overflow = u64::from(u32::MAX) + 1;
    let index_bytes = format!(r#"{{"schemaVersion":{overflow},"sessions":[]}}"#);
    fs::write(&index, index_bytes.as_bytes()).unwrap();
    assert!(matches!(
        SessionPersistence::open(store.clone()).await,
        Err(SessionPersistenceError::UnsupportedVersion { found }) if found == overflow
    ));
    assert_eq!(fs::read(&index).unwrap(), index_bytes.as_bytes());

    fs::remove_file(&index).unwrap();
    let key = Uuid::new_v4().to_string();
    let dir = store.join(&key);
    fs::create_dir_all(&dir).unwrap();
    let metadata = dir.join(METADATA_FILE);
    let metadata_bytes = format!(r#"{{"schemaVersion":{overflow},"storageKey":"{key}"}}"#);
    fs::write(&metadata, metadata_bytes.as_bytes()).unwrap();
    assert!(matches!(
        SessionPersistence::open(store).await,
        Err(SessionPersistenceError::UnsupportedVersion { found }) if found == overflow
    ));
    assert_eq!(fs::read(metadata).unwrap(), metadata_bytes.as_bytes());
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn corrupt_index_is_backed_up_and_rebuilt() {
    let root = temp_dir("corrupt-index");
    let (persistence, _) = registered(&root).await;
    persistence.shutdown().await.unwrap();
    let index = root.join("store").join(INDEX_FILE);
    fs::write(&index, b"bad json").unwrap();
    let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
    assert_eq!(reopened.list_sessions().len(), 1);
    let backups = fs::read_dir(root.join("store"))
        .unwrap()
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().contains("corrupt-"))
        .count();
    assert_eq!(backups, 1);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn torn_final_tail_repairs_but_middle_corruption_quarantines() {
    let root = temp_dir("tails");
    let (persistence, metadata) = registered(&root).await;
    persistence
        .enqueue_event(record(1, "message_chunk"))
        .unwrap();
    persistence.flush_session("session-1").await.unwrap();
    persistence.shutdown().await.unwrap();
    let log = root
        .join("store")
        .join(&metadata.storage_key)
        .join(MESSAGES_FILE);
    fs::OpenOptions::new()
        .append(true)
        .open(&log)
        .unwrap()
        .write_all(b"{torn")
        .unwrap();
    let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
    assert_eq!(reopened.last_seq("session-1").unwrap(), 1);
    reopened.shutdown().await.unwrap();
    fs::write(&log, b"bad\n{}\n").unwrap();
    let quarantined = SessionPersistence::open(root.join("store")).await.unwrap();
    assert!(quarantined.list_sessions().is_empty());
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn corrupt_metadata_isolated_from_other_session() {
    let root = temp_dir("metadata-isolation");
    let (persistence, first) = registered(&root).await;
    let cwd2 = root.join("cwd2");
    fs::create_dir_all(&cwd2).unwrap();
    let second = persistence
        .register_session(SessionRegistration {
            session_id: "session-2".into(),
            stable_agent_namespace: None,
            runtime_agent_id: None,
            project_id: None,
            cwd: cwd2,
            ..Default::default()
        })
        .await
        .unwrap();
    persistence.shutdown().await.unwrap();
    fs::write(
        root.join("store")
            .join(first.storage_key)
            .join(METADATA_FILE),
        b"bad",
    )
    .unwrap();
    let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
    assert_eq!(reopened.list_sessions().len(), 1);
    assert_eq!(reopened.list_sessions()[0].storage_key, second.storage_key);
    assert!(!reopened.list_sessions()[0].resume_eligible);
    let _ = fs::remove_dir_all(root);
}

fn payload_record(seq: u64, type_: &str, payload: Value) -> PersistedEventRecord {
    PersistedEventRecord {
        schema_version: SESSION_SCHEMA_VERSION,
        session_id: "session-1".to_string(),
        seq,
        type_: type_.to_string(),
        recorded_at: 1_000 + seq,
        payload,
    }
}

fn enqueue_turn(
    persistence: &SessionPersistence,
    seq: u64,
    turn_id: &str,
    prompt: &str,
    reply: &str,
) {
    persistence
        .enqueue_event(payload_record(
            seq,
            "user_prompt",
            json!({
                "agentId": "runtime-1",
                "sessionId": "session-1",
                "turnId": turn_id,
                "content": [{"type": "text", "text": prompt}],
            }),
        ))
        .unwrap();
    persistence
        .enqueue_event(payload_record(
            seq + 1,
            "message_chunk",
            json!({
                "agentId": "runtime-1",
                "sessionId": "session-1",
                "role": "agent",
                "content": {"type": "text", "text": reply},
            }),
        ))
        .unwrap();
    persistence
        .enqueue_event(payload_record(
            seq + 2,
            "prompt_complete",
            json!({"sessionId": "session-1", "turnId": turn_id, "stopReason": "end_turn"}),
        ))
        .unwrap();
}

#[tokio::test]
async fn session_payload_round_trips_materialized_transcript() {
    let root = temp_dir("payload-roundtrip");
    let (persistence, _) = registered(&root).await;
    enqueue_turn(&persistence, 1, "turn-1", "hello", "world");
    // tool_call between text runs splits the agent bubble.
    persistence
        .enqueue_event(payload_record(
            4,
            "tool_call",
            json!({
                "agentId": "runtime-1",
                "sessionId": "session-1",
                "toolCall": {"toolCallId": "t-1", "kind": "execute", "status": "completed"},
            }),
        ))
        .unwrap();
    persistence
        .enqueue_event(payload_record(
            5,
            "message_chunk",
            json!({
                "agentId": "runtime-1",
                "sessionId": "session-1",
                "role": "agent",
                "content": {"type": "text", "text": "after tool"},
            }),
        ))
        .unwrap();
    persistence
        .enqueue_event(payload_record(
            6,
            "prompt_complete",
            json!({"sessionId": "session-1", "turnId": "turn-1", "stopReason": "end_turn"}),
        ))
        .unwrap();

    let payload = persistence
        .session_payload_async("session-1")
        .await
        .unwrap();
    assert_eq!(payload.metadata.id, "session-1");
    assert_eq!(payload.metadata.agent_config_id.as_deref(), Some("one"));
    assert_eq!(payload.metadata.agent_id, "runtime-1");
    assert_eq!(payload.metadata.project_id, "project-1");
    assert_eq!(payload.metadata.status, PersistedSessionStatus::Active);
    assert_eq!(payload.metadata.message_count, 3);
    assert_eq!(payload.metadata.last_seq, 6);
    assert_eq!(
        payload
            .messages
            .iter()
            .map(|message| (message.id.as_str(), message.seq))
            .collect::<Vec<_>>(),
        vec![
            ("turn:turn-1", 1),
            ("snapshot:agent:2", 2),
            ("snapshot:agent:5", 5),
        ]
    );
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn session_payload_async_unknown_session_is_not_found() {
    let root = temp_dir("payload-not-found");
    let (persistence, _) = registered(&root).await;
    let error = persistence
        .session_payload_async("missing")
        .await
        .unwrap_err();
    assert!(matches!(error, SessionPersistenceError::SessionNotFound));
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn restart_downgrades_active_to_closed_without_writer() {
    let root = temp_dir("restart-downgrade");
    let (persistence, _) = registered(&root).await;
    enqueue_turn(&persistence, 1, "turn-1", "hello", "world");
    assert_eq!(
        persistence.metadata("session-1").unwrap().status,
        PersistedSessionStatus::Active
    );
    persistence.shutdown().await.unwrap();

    let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
    let metadata = reopened.metadata("session-1").unwrap();
    assert_eq!(
        metadata.status,
        PersistedSessionStatus::Closed,
        "restarted host must not claim the dead agent's session is active"
    );
    assert!(
        !reopened.inner.sessions.lock().contains_key("session-1"),
        "no writer runtime may be reinstalled after restart"
    );
    assert!(matches!(
        reopened.enqueue_event(record(4, "message_chunk")),
        Err(SessionPersistenceError::SessionNotFound)
    ));
    // The payload stays fetchable read-only after the downgrade.
    let payload = reopened.session_payload_async("session-1").await.unwrap();
    assert_eq!(payload.metadata.status, PersistedSessionStatus::Closed);
    assert_eq!(payload.messages.len(), 2);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn session_payload_survives_reopen_identically() {
    let root = temp_dir("payload-reopen");
    let (persistence, _) = registered(&root).await;
    enqueue_turn(&persistence, 1, "turn-1", "hello", "world");
    let before = serde_json::to_value(
        persistence
            .session_payload_async("session-1")
            .await
            .unwrap(),
    )
    .unwrap();
    persistence.shutdown().await.unwrap();

    let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
    let after =
        serde_json::to_value(reopened.session_payload_async("session-1").await.unwrap()).unwrap();
    // `status` is expected to differ (Active → Closed across restart); the
    // transcript itself must survive byte-identically.
    assert_eq!(before["messages"], after["messages"]);
    assert_eq!(before["metadata"]["id"], after["metadata"]["id"]);
    assert_eq!(before["metadata"]["lastSeq"], after["metadata"]["lastSeq"]);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn session_payload_tail_reads_only_last_n_messages_from_long_session() {
    let root = temp_dir("payload-tail");
    let (persistence, _) = registered(&root).await;
    // Enqueue 10 turns (30 records: user_prompt + message_chunk +
    // prompt_complete per turn). Each turn produces 2 folded messages
    // (user + agent), so the full payload has 20 messages.
    for i in 0..10u64 {
        let seq = i * 3 + 1;
        enqueue_turn(
            &persistence,
            seq,
            &format!("turn-{i}"),
            &format!("prompt-{i}"),
            &format!("reply-{i}"),
        );
    }
    persistence.flush_session("session-1").await.unwrap();

    // Tail with limit 5: should return the last 5 folded messages.
    let tail = persistence
        .session_payload_tail_async("session-1", 5)
        .await
        .unwrap();
    assert_eq!(tail.messages.len(), 5);
    // The last 5 messages are turns 7 (agent), 8 (user+agent), 9 (user+agent).
    // Verify the last message is the agent reply of turn 9.
    let last = tail.messages.last().unwrap();
    assert_eq!(last.role, "agent");
    assert_eq!(last.seq, 9 * 3 + 2); // message_chunk seq of turn 9
                                     // Verify the first tail message is turn 7's agent reply.
    let first = tail.messages.first().unwrap();
    assert_eq!(first.role, "agent");
    assert_eq!(first.seq, 7 * 3 + 2);

    // Tail with limit 50 (exceeds the 20-message session): returns all 20.
    let big_tail = persistence
        .session_payload_tail_async("session-1", 50)
        .await
        .unwrap();
    assert_eq!(big_tail.messages.len(), 20);

    // The tail must match the tail of the full payload (same ids + seqs).
    let full = persistence
        .session_payload_async("session-1")
        .await
        .unwrap();
    let full_tail: Vec<_> = full.messages.iter().rev().take(5).rev().collect();
    assert_eq!(
        tail.messages
            .iter()
            .map(|m| (m.id.as_str(), m.seq))
            .collect::<Vec<_>>(),
        full_tail
            .iter()
            .map(|m| (m.id.as_str(), m.seq))
            .collect::<Vec<_>>(),
        "tail payload ids+seqs must match the full payload's last 5 messages"
    );

    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn session_payload_tail_with_tool_calls_includes_matching_tail_range() {
    let root = temp_dir("payload-tail-tools");
    let (persistence, _) = registered(&root).await;
    // Turn 1: user + agent + tool_call + agent + prompt_complete.
    enqueue_turn(&persistence, 1, "turn-1", "hello", "world");
    persistence
        .enqueue_event(payload_record(
            4,
            "tool_call",
            json!({
                "agentId": "runtime-1",
                "sessionId": "session-1",
                "toolCall": {"toolCallId": "t-1", "kind": "execute", "status": "completed"},
            }),
        ))
        .unwrap();
    persistence
        .enqueue_event(payload_record(
            5,
            "message_chunk",
            json!({
                "agentId": "runtime-1",
                "sessionId": "session-1",
                "role": "agent",
                "content": {"type": "text", "text": "after tool"},
            }),
        ))
        .unwrap();
    persistence
        .enqueue_event(payload_record(
            6,
            "prompt_complete",
            json!({"sessionId": "session-1", "turnId": "turn-1", "stopReason": "end_turn"}),
        ))
        .unwrap();
    // Turn 2: another user + agent.
    enqueue_turn(&persistence, 7, "turn-2", "again", "reply2");
    persistence.flush_session("session-1").await.unwrap();

    // Full payload: 4 messages (user, agent, agent, user, agent) → actually
    // turn-1 has 3 (user, agent, agent-after-tool) + turn-2 has 2 (user,
    // agent) = 5 messages.
    let full = persistence
        .session_payload_async("session-1")
        .await
        .unwrap();
    assert_eq!(full.messages.len(), 5);

    // Tail limit 2: last 2 messages (turn-2 user + agent).
    let tail = persistence
        .session_payload_tail_async("session-1", 2)
        .await
        .unwrap();
    assert_eq!(tail.messages.len(), 2);
    // The tool call from turn-1 (seq 4) is older than the tail's oldest
    // message (seq 7) and should NOT appear in the tail records.
    // (Tool calls are not materialized into messages by the fold, but the
    // tail records must not include the old tool call — it would be
    // filtered by the seq-range guard.)
    assert_eq!(tail.messages[0].id, "turn:turn-2");
    assert_eq!(tail.messages[1].id, "snapshot:agent:8");

    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn session_payload_tail_handles_long_agent_run_with_many_chunks() {
    // records. The tail must include all chunks and produce a single
    // folded agent bubble (not split or truncated). The fold-boundary
    // check must correctly fall back to full replay when the tail starts
    // mid-run, so the bubble id matches the full payload.
    let root = temp_dir("payload-tail-many-chunks");
    let (persistence, _) = registered(&root).await;
    // Turn 1: user_prompt + 1 chunk + prompt_complete.
    enqueue_turn(&persistence, 1, "turn-1", "hello", "world");
    // Turn 2: user_prompt + 6 chunks (no tool_call or prompt_complete
    // between them → they coalesce into one agent bubble) + prompt_complete.
    persistence
        .enqueue_event(payload_record(
            4,
            "user_prompt",
            json!({
                "agentId": "runtime-1",
                "sessionId": "session-1",
                "turnId": "turn-2",
                "content": [{"type": "text", "text": "again"}],
            }),
        ))
        .unwrap();
    for i in 0..6u64 {
        persistence
            .enqueue_event(payload_record(
                5 + i,
                "message_chunk",
                json!({
                    "agentId": "runtime-1",
                    "sessionId": "session-1",
                    "role": "agent",
                    "content": {"type": "text", "text": format!("chunk-{i}")},
                }),
            ))
            .unwrap();
    }
    persistence
        .enqueue_event(payload_record(
            11,
            "prompt_complete",
            json!({"sessionId": "session-1", "turnId": "turn-2", "stopReason": "end_turn"}),
        ))
        .unwrap();
    persistence.flush_session("session-1").await.unwrap();

    // Full payload: 3 messages (user-1, agent-1, user-2 + agent-2).
    // Wait — turn-2 has user_prompt(4) + 6 chunks(5-10) + prompt_complete(11).
    // Fold: user_prompt(1) + agent(2) + user_prompt(4) + agent(5-10 coalesced) = 4 messages.
    let full = persistence
        .session_payload_async("session-1")
        .await
        .unwrap();
    assert_eq!(full.messages.len(), 4);
    // The last message is the coalesced agent bubble from chunks 5-10.
    assert_eq!(full.messages[3].role, "agent");
    assert_eq!(full.messages[3].seq, 5); // first chunk's seq

    // Tail limit 2: last 2 messages (user-2 + agent-2 coalesced).
    let tail = persistence
        .session_payload_tail_async("session-1", 2)
        .await
        .unwrap();
    assert_eq!(tail.messages.len(), 2);
    assert_eq!(tail.messages[0].id, "turn:turn-2");
    assert_eq!(tail.messages[1].id, "snapshot:agent:5");
    // The tail's agent bubble id must match the full payload's.
    assert_eq!(tail.messages[1].id, full.messages[3].id);

    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn session_payload_tail_meta_record_at_window_edge_preserves_run_head() {
    // Regression: a tail window whose first non-tool record is a
    // non-boundary meta event (plan_update/usage_update/…) followed by a
    // `message_chunk` that continues a run opened BEFORE the window must
    // still mint the run's true `snapshot:<role>:<runStartSeq>` id and
    // carry its full content. Otherwise the head bubble id never appears
    // in the full payload and the renderer's `loadOlderMessages` anchor
    // (`findIndex` by id) misses — scroll-back silently stalls.
    let root = temp_dir("payload-tail-meta-edge");
    let (persistence, _) = registered(&root).await;
    persistence
        .enqueue_event(payload_record(
            1,
            "user_prompt",
            json!({
                "agentId": "runtime-1",
                "sessionId": "session-1",
                "turnId": "turn-1",
                "content": [{"type": "text", "text": "hello"}],
            }),
        ))
        .unwrap();
    // Long agent run with a plan_update meta record in the middle:
    // chunks at seqs 2,3, plan_update at 4, then chunks 5-7 continuing
    // the same run. Enqueue order is file order — the writer requires
    // strictly increasing seqs.
    for (seq, type_, payload) in [
        (
            2u64,
            "message_chunk",
            json!({
                "agentId": "runtime-1",
                "sessionId": "session-1",
                "role": "agent",
                "content": {"type": "text", "text": "part1 "},
            }),
        ),
        (
            3,
            "message_chunk",
            json!({
                "agentId": "runtime-1",
                "sessionId": "session-1",
                "role": "agent",
                "content": {"type": "text", "text": "part2 "},
            }),
        ),
        (
            4,
            "plan_update",
            json!({
                "sessionId": "session-1",
                "plan": [{"content": "step", "status": "in_progress"}],
            }),
        ),
        (
            5,
            "message_chunk",
            json!({
                "agentId": "runtime-1",
                "sessionId": "session-1",
                "role": "agent",
                "content": {"type": "text", "text": "part3 "},
            }),
        ),
        (
            6,
            "message_chunk",
            json!({
                "agentId": "runtime-1",
                "sessionId": "session-1",
                "role": "agent",
                "content": {"type": "text", "text": "part4 "},
            }),
        ),
        (
            7,
            "message_chunk",
            json!({
                "agentId": "runtime-1",
                "sessionId": "session-1",
                "role": "agent",
                "content": {"type": "text", "text": "part5"},
            }),
        ),
    ] {
        persistence
            .enqueue_event(payload_record(seq, type_, payload))
            .unwrap();
    }
    persistence
        .enqueue_event(payload_record(
            8,
            "prompt_complete",
            json!({"sessionId": "session-1", "turnId": "turn-1", "stopReason": "end_turn"}),
        ))
        .unwrap();
    persistence.flush_session("session-1").await.unwrap();

    // File order (messages.jsonl, 8 lines): user_prompt@1, chunk@2,
    // chunk@3, plan_update@4, chunk@5, chunk@6, chunk@7, prompt_complete@8.
    // limit=1 → max_lines=5 → window = last 5 lines = [plan_update@4,
    // chunk@5..7, prompt_complete@8] — the edge is a meta record and the
    // first chunk continues the run started at seq 2.
    let tail = persistence
        .session_payload_tail_async("session-1", 1)
        .await
        .unwrap();
    let full = persistence
        .session_payload_async("session-1")
        .await
        .unwrap();
    assert_eq!(full.messages.len(), 2);
    let expected = full.messages.last().unwrap();
    assert_eq!(tail.messages.len(), 1);
    assert_eq!(
        tail.messages[0].id, expected.id,
        "tail head must reuse the full-fold run id (snapshot:agent:2), not a window-local mint"
    );
    assert_eq!(tail.messages[0].id, "snapshot:agent:2");
    assert_eq!(
        tail.messages[0].blocks, expected.blocks,
        "the tail head must carry the run's full content, not just the in-window chunks"
    );

    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn session_payload_tail_corrupt_newline_record_returns_error_not_partial() {
    // A malformed newline-terminated line in messages.jsonl must surface
    // as CorruptSession — NOT a partial tail payload. Only the final
    // unterminated line (no trailing newline) is tolerated.
    let root = temp_dir("payload-tail-corrupt");
    let (persistence, _) = registered(&root).await;
    enqueue_turn(&persistence, 1, "turn-1", "hello", "world");
    persistence.flush_session("session-1").await.unwrap();

    // Corrupt messages.jsonl: append a malformed newline-terminated line
    // (valid JSON line followed by a garbage line with a newline).
    let metadata = persistence.metadata("session-1").unwrap();
    let messages_path = persistence
        .session_dir(&metadata.storage_key)
        .unwrap()
        .join(MESSAGES_FILE);
    let original = fs::read(&messages_path).unwrap();
    let mut corrupted = original;
    corrupted.extend_from_slice(b"{\"broken\":\n"); // malformed + newline-terminated
    fs::write(&messages_path, &corrupted).unwrap();

    // The tail read must fail with CorruptSession, not return a partial payload.
    let result = persistence.session_payload_tail_async("session-1", 5).await;
    assert!(
        matches!(result, Err(SessionPersistenceError::CorruptSession)),
        "expected CorruptSession for malformed newline-terminated record, got: {result:?}"
    );

    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn session_payload_readable_after_finalize_removes_writer() {
    let root = temp_dir("payload-finalized");
    let (persistence, _) = registered(&root).await;
    enqueue_turn(&persistence, 1, "turn-1", "hello", "world");
    persistence
        .finalize_session("session-1", PersistedSessionStatus::Closed)
        .await
        .unwrap();
    // Finalization removed the writer; the flush barrier short-circuits and
    // the payload is served read-only from the durable log.
    let payload = persistence
        .session_payload_async("session-1")
        .await
        .unwrap();
    assert_eq!(payload.metadata.status, PersistedSessionStatus::Closed);
    assert_eq!(payload.messages.len(), 2);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn session_payload_corrupt_log_fails_closed() {
    let root = temp_dir("payload-corrupt");
    let (persistence, _) = registered(&root).await;
    enqueue_turn(&persistence, 1, "turn-1", "hello", "world");
    persistence
        .finalize_session("session-1", PersistedSessionStatus::Closed)
        .await
        .unwrap();
    // Simulate storage degradation: append an invalid record to the
    // transcript log. The read must surface an error — never fabricate an
    // empty payload that would wipe the client's transcript.
    let storage_key = persistence.metadata("session-1").unwrap().storage_key;
    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(persistence.root().join(&storage_key).join(MESSAGES_FILE))
        .unwrap();
    file.write_all(b"{not valid json}\n").unwrap();
    file.flush().unwrap();
    drop(file);
    let error = persistence
        .session_payload_async("session-1")
        .await
        .unwrap_err();
    assert!(
        matches!(error, SessionPersistenceError::CorruptSession),
        "a malformed durable record must surface as CorruptSession, got: {error}"
    );
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn restart_preserves_error_status_without_downgrade() {
    let root = temp_dir("restart-error");
    let (persistence, _) = registered(&root).await;
    enqueue_turn(&persistence, 1, "turn-1", "hello", "world");
    persistence
        .finalize_session("session-1", PersistedSessionStatus::Error)
        .await
        .unwrap();
    persistence.shutdown().await.unwrap();

    let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
    assert_eq!(
        reopened.metadata("session-1").unwrap().status,
        PersistedSessionStatus::Error,
        "only Active sessions downgrade on restart; Error must survive as-is"
    );
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn open_rejects_a_file_root() {
    // Degraded-mode source: callers must be able to detect an unusable
    // sessions root at startup (the desktop then boots live-only).
    let root = temp_dir("open-file-root");
    let file_path = root.join("not-a-dir");
    fs::write(&file_path, b"x").unwrap();
    let error = match SessionPersistence::open(file_path).await {
        Ok(_) => panic!("a non-directory root must not open"),
        Err(error) => error,
    };
    assert!(
        matches!(error, SessionPersistenceError::Io(_)),
        "a non-directory root must surface as an IO error, got: {error}"
    );
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn delete_session_removes_live_writer_directory_and_index_entry() {
    let root = temp_dir("delete-live");
    let (persistence, _) = registered(&root).await;
    enqueue_turn(&persistence, 1, "turn-1", "hello", "world");
    let storage_key = persistence.metadata("session-1").unwrap().storage_key;
    persistence.delete_session("session-1").await.unwrap();
    assert!(matches!(
        persistence.metadata("session-1"),
        Err(SessionPersistenceError::SessionNotFound)
    ));
    assert!(persistence.list_sessions().is_empty());
    assert!(!persistence.root().join(&storage_key).exists());
    // The writer runtime is gone with the session.
    assert!(matches!(
        persistence.enqueue_event(record(4, "message_chunk")),
        Err(SessionPersistenceError::SessionNotFound)
    ));
    persistence.shutdown().await.unwrap();
    // Nothing must resurrect on reopen.
    let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
    assert!(reopened.list_sessions().is_empty());
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn delete_session_works_for_finalized_and_unknown_ids() {
    let root = temp_dir("delete-finalized");
    let (persistence, _) = registered(&root).await;
    enqueue_turn(&persistence, 1, "turn-1", "hello", "world");
    persistence
        .finalize_session("session-1", PersistedSessionStatus::Closed)
        .await
        .unwrap();
    persistence.delete_session("session-1").await.unwrap();
    assert!(matches!(
        persistence.delete_session("session-1").await,
        Err(SessionPersistenceError::SessionNotFound)
    ));
    assert!(matches!(
        persistence.delete_session("missing").await,
        Err(SessionPersistenceError::SessionNotFound)
    ));
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn find_most_recent_for_project_filters_and_orders() {
    let root = temp_dir("find-project");
    let cwd = root.join("cwd");
    fs::create_dir_all(&cwd).unwrap();
    let persistence = SessionPersistence::open(root.join("store")).await.unwrap();
    for (session_id, project, namespace) in [
        ("a", Some("project-1"), Some("config:one")),
        ("b", Some("project-1"), Some("config:two")),
        ("c", Some("project-2"), Some("config:one")),
        // No stable namespace but a runtime agent id — still an identity.
        ("d", Some("project-1"), None),
    ] {
        persistence
            .register_session(SessionRegistration {
                session_id: session_id.to_string(),
                stable_agent_namespace: namespace.map(str::to_string),
                runtime_agent_id: Some(format!("runtime-{session_id}")),
                project_id: project.map(str::to_string),
                cwd: cwd.clone(),
                ..Default::default()
            })
            .await
            .unwrap();
    }
    // Deterministic activity ordering via explicit recorded_at.
    let bump = |session_id: &str, recorded_at: u64| PersistedEventRecord {
        schema_version: SESSION_SCHEMA_VERSION,
        session_id: session_id.to_string(),
        seq: 1,
        type_: "message_chunk".to_string(),
        recorded_at,
        payload: json!({"sessionId": session_id, "role": "agent", "content": [{"type": "text", "text": "hi"}]}),
    };
    persistence.enqueue_event(bump("a", 1_000)).unwrap();
    persistence.enqueue_event(bump("b", 3_000)).unwrap();
    persistence.enqueue_event(bump("d", 5_000)).unwrap();
    for session_id in ["a", "b", "d"] {
        persistence.flush_session(session_id).await.unwrap();
    }

    let cwd_str = persistence.metadata("a").unwrap().cwd;
    let hit = persistence
        .find_most_recent_for_project("project-1", &cwd_str, None)
        .unwrap();
    assert_eq!(hit.session_id, "d", "most recent activity wins");
    let narrowed = persistence
        .find_most_recent_for_project("project-1", &cwd_str, Some("config:one"))
        .unwrap();
    assert_eq!(narrowed.session_id, "a");
    assert!(persistence
        .find_most_recent_for_project("project-1", &cwd_str, Some("config:missing"))
        .is_none());
    assert!(persistence
        .find_most_recent_for_project("project-9", &cwd_str, None)
        .is_none());
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn unclean_exit_still_downgrades_active_on_restart() {
    let root = temp_dir("restart-crash");
    let (persistence, _) = registered(&root).await;
    enqueue_turn(&persistence, 1, "turn-1", "hello", "world");
    // Durable on disk, but NO finalize/shutdown: simulates a kill/crash, so
    // the on-disk status stays `Active` behind a dead host process.
    persistence.flush_session("session-1").await.unwrap();
    drop(persistence);

    let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
    assert_eq!(
        reopened.metadata("session-1").unwrap().status,
        PersistedSessionStatus::Closed,
        "an unclean shutdown must not leave a dead session claiming Active"
    );
    let payload = reopened.session_payload_async("session-1").await.unwrap();
    assert_eq!(payload.messages.len(), 2);
    let _ = fs::remove_dir_all(root);
}

// --- TitleSource precedence (AD-1/AD-5) ---

/// Helper: enqueue a `local_title_generated` event for the default session.
fn enqueue_local_title(persistence: &SessionPersistence, seq: u64, title: &str) {
    persistence
        .enqueue_event(payload_record(
            seq,
            "local_title_generated",
            json!({"sessionId":"session-1","title":title}),
        ))
        .unwrap();
}

/// Helper: enqueue a `session_info_update` event for the default session.
fn enqueue_session_info_update(persistence: &SessionPersistence, seq: u64, title: &str) {
    persistence
        .enqueue_event(payload_record(
            seq,
            "session_info_update",
            json!({"sessionId":"session-1","title":title}),
        ))
        .unwrap();
}

/// `user_prompt` sets `title_source = DerivedFirstMessage` (AD-5) so the
/// host can detect "first turn, no background title yet" and trigger
/// background title generation.
#[tokio::test]
async fn user_prompt_sets_derived_first_message_title_source() {
    let root = temp_dir("title-derived");
    let (persistence, _) = registered(&root).await;
    persistence
        .enqueue_event(payload_record(
            1,
            "user_prompt",
            json!({
                "agentId":"runtime-1","sessionId":"session-1","turnId":"turn-1",
                "content":[{"type":"text","text":"how do I center a div?"}],
            }),
        ))
        .unwrap();
    persistence.flush_session("session-1").await.unwrap();
    let metadata = persistence.metadata("session-1").unwrap();
    assert_eq!(metadata.title.as_deref(), Some("how do I center a div?"));
    assert_eq!(
        metadata.title_source,
        Some(TitleSource::DerivedFirstMessage),
        "user_prompt must stamp DerivedFirstMessage provenance"
    );
    let _ = fs::remove_dir_all(root);
}

/// A legacy framed handoff `user_prompt` (summary + --- + draft) must
/// mint the title from the DRAFT, not the wire header —
/// spec-agent-switch-separator-redesign.
#[tokio::test]
async fn user_prompt_handoff_record_titles_from_draft() {
    let root = temp_dir("title-handoff");
    let (persistence, _) = registered(&root).await;
    persistence
            .enqueue_event(payload_record(
                1,
                "user_prompt",
                json!({
                    "agentId":"runtime-1","sessionId":"session-1","turnId":"turn-1",
                    "content":[{"type":"text","text":"# Conversation handoff\n\nYou are taking over.\n\n---\n\nfinish the login form"}],
                }),
            ))
            .unwrap();
    persistence.flush_session("session-1").await.unwrap();
    let metadata = persistence.metadata("session-1").unwrap();
    assert_eq!(metadata.title.as_deref(), Some("finish the login form"));
    let _ = fs::remove_dir_all(root);
}

/// A summary-only framed handoff derives no draft — Untitled, never the
/// wire header.
#[tokio::test]
async fn user_prompt_summary_only_handoff_titles_untitled() {
    let root = temp_dir("title-handoff-only");
    let (persistence, _) = registered(&root).await;
    persistence
        .enqueue_event(payload_record(
            1,
            "user_prompt",
            json!({
                "agentId":"runtime-1","sessionId":"session-1","turnId":"turn-1",
                "content":[{"type":"text","text":"# Conversation handoff\n\nYou are taking over."}],
            }),
        ))
        .unwrap();
    persistence.flush_session("session-1").await.unwrap();
    let metadata = persistence.metadata("session-1").unwrap();
    assert_eq!(metadata.title.as_deref(), Some("Untitled Chat"));
    let _ = fs::remove_dir_all(root);
}

/// `local_title_generated` sets `title_source = BackgroundGenerated` and
/// overwrites the DerivedFirstMessage title (AD-1 precedence).
#[tokio::test]
async fn local_title_generated_sets_background_generated() {
    let root = temp_dir("title-bg");
    let (persistence, _) = registered(&root).await;
    // First user prompt stamps DerivedFirstMessage.
    persistence
        .enqueue_event(payload_record(
            1,
            "user_prompt",
            json!({
                "agentId":"runtime-1","sessionId":"session-1","turnId":"turn-1",
                "content":[{"type":"text","text":"how do I center a div?"}],
            }),
        ))
        .unwrap();
    // Background title gen succeeds and durably overwrites.
    enqueue_local_title(&persistence, 2, "Centering a div with CSS");
    persistence.flush_session("session-1").await.unwrap();
    let metadata = persistence.metadata("session-1").unwrap();
    assert_eq!(metadata.title.as_deref(), Some("Centering a div with CSS"));
    assert_eq!(
        metadata.title_source,
        Some(TitleSource::BackgroundGenerated),
        "local_title_generated must stamp BackgroundGenerated provenance"
    );
    let _ = fs::remove_dir_all(root);
}

/// After `title_source == BackgroundGenerated`, a later
/// `session_info_update` from the agent must NOT overwrite the title
/// (AD-1: background wins over agent-supplied).
#[tokio::test]
async fn session_info_update_does_not_overwrite_background_generated() {
    let root = temp_dir("title-protect-bg");
    let (persistence, _) = registered(&root).await;
    persistence
        .enqueue_event(payload_record(
            1,
            "user_prompt",
            json!({
                "agentId":"runtime-1","sessionId":"session-1","turnId":"turn-1",
                "content":[{"type":"text","text":"how do I center a div?"}],
            }),
        ))
        .unwrap();
    enqueue_local_title(&persistence, 2, "Background title");
    // Agent emits its own title AFTER background gen.
    enqueue_session_info_update(&persistence, 3, "Agent's pick");
    persistence.flush_session("session-1").await.unwrap();
    let metadata = persistence.metadata("session-1").unwrap();
    assert_eq!(
        metadata.title.as_deref(),
        Some("Background title"),
        "BackgroundGenerated title must survive a later session_info_update"
    );
    assert_eq!(
        metadata.title_source,
        Some(TitleSource::BackgroundGenerated),
        "title_source must stay BackgroundGenerated after a suppressed overwrite"
    );
    let _ = fs::remove_dir_all(root);
}

/// Without protection, `session_info_update` stamps `AgentSupplied` (so a
/// subsequent background title can still win).
#[tokio::test]
async fn session_info_update_stamps_agent_supplied_when_unprotected() {
    let root = temp_dir("title-agent");
    let (persistence, _) = registered(&root).await;
    // Native agent title with no prior background title.
    enqueue_session_info_update(&persistence, 1, "Agent title");
    persistence.flush_session("session-1").await.unwrap();
    let metadata = persistence.metadata("session-1").unwrap();
    assert_eq!(metadata.title.as_deref(), Some("Agent title"));
    assert_eq!(
        metadata.title_source,
        Some(TitleSource::AgentSupplied),
        "unprotected session_info_update must stamp AgentSupplied provenance"
    );
    let _ = fs::remove_dir_all(root);
}

/// Replay after restart reproduces the BackgroundGenerated title and a later
/// replayed `session_info_update` still does not overwrite it (AD-1 durable
/// defense survives restart).
#[tokio::test]
async fn replay_preserves_background_title_and_suppresses_later_session_info() {
    let root = temp_dir("title-replay");
    let store = root.join("store");
    {
        let (persistence, _) = registered(&root).await;
        persistence
            .enqueue_event(payload_record(
                1,
                "user_prompt",
                json!({
                    "agentId":"runtime-1","sessionId":"session-1","turnId":"turn-1",
                    "content":[{"type":"text","text":"orig prompt"}],
                }),
            ))
            .unwrap();
        enqueue_local_title(&persistence, 2, "Replayed background title");
        // A later agent session_info_update arrives before shutdown.
        enqueue_session_info_update(&persistence, 3, "Late agent title");
        persistence.shutdown().await.unwrap();
    }
    let reopened = SessionPersistence::open(store).await.unwrap();
    let metadata = reopened.metadata("session-1").unwrap();
    assert_eq!(
        metadata.title.as_deref(),
        Some("Replayed background title"),
        "replay must surface the background-generated title, not the suppressed agent title"
    );
    assert_eq!(
        metadata.title_source,
        Some(TitleSource::BackgroundGenerated),
        "title_source must survive restart"
    );
    let _ = fs::remove_dir_all(root);
}

/// `local_title_generated` is a durable event: replay returns it so a
/// reconnecting client can reconstruct the title history.
#[tokio::test]
async fn local_title_generated_is_durable_and_replayable() {
    let root = temp_dir("title-durable");
    let (persistence, _) = registered(&root).await;
    persistence
        .enqueue_event(payload_record(
            1,
            "user_prompt",
            json!({
                "agentId":"runtime-1","sessionId":"session-1","turnId":"turn-1",
                "content":[{"type":"text","text":"hello"}],
            }),
        ))
        .unwrap();
    enqueue_local_title(&persistence, 2, "Hello chat");
    persistence.flush_session("session-1").await.unwrap();
    let records = persistence.replay_after("session-1", 0).unwrap();
    assert!(records.iter().any(|record| {
        record.type_ == "local_title_generated"
            && record.payload.get("title").and_then(Value::as_str) == Some("Hello chat")
    }));
    let _ = fs::remove_dir_all(root);
}

/// `reopen_writer` reinstalls a writer for a finalized (catalog-retained)
/// session so `enqueue_event` succeeds again and the catalog status flips
/// back to `Active`. Mirrors the `LoadSession`/`ResumeSession` reopen path.
#[tokio::test]
async fn reopen_writer_reinstalls_writer_for_finalized_session() {
    let root = temp_dir("reopen-finalized");
    let (persistence, _) = registered(&root).await;
    // Enqueue one event then finalize — finalize removes the writer but
    // keeps the catalog entry (read-only listing + last_seq still resolve).
    persistence.enqueue_event(record(1, "user_prompt")).unwrap();
    persistence
        .finalize_session("session-1", PersistedSessionStatus::Closed)
        .await
        .unwrap();
    assert!(!persistence.inner.sessions.lock().contains_key("session-1"));
    assert_eq!(
        persistence.metadata("session-1").unwrap().status,
        PersistedSessionStatus::Closed
    );
    // enqueue_event fails with SessionNotFound — the writer is gone.
    assert!(matches!(
        persistence.enqueue_event(record(2, "message_chunk")),
        Err(SessionPersistenceError::SessionNotFound)
    ));

    // reopen_writer reinstalls the writer and flips status to Active.
    persistence.reopen_writer("session-1").await.unwrap();
    assert!(persistence.inner.sessions.lock().contains_key("session-1"));
    assert_eq!(
        persistence.metadata("session-1").unwrap().status,
        PersistedSessionStatus::Active
    );
    // enqueue_event now succeeds; the new seq advances past the prior
    // last_seq (1) so the durable frontier is monotonic.
    persistence
        .enqueue_event(record(2, "message_chunk"))
        .unwrap();
    persistence.flush_session("session-1").await.unwrap();
    assert_eq!(persistence.last_seq("session-1").unwrap(), 2);
    let _ = fs::remove_dir_all(root);
}

/// `reopen_writer` is idempotent: calling it twice for an already-open
/// session installs a single writer (no duplicate runtime entries).
#[tokio::test]
async fn reopen_writer_is_idempotent() {
    let root = temp_dir("reopen-idempotent");
    let (persistence, _) = registered(&root).await;
    // First call: writer already present (register_session installed it),
    // so reopen_writer short-circuits at the idempotent guard.
    persistence.reopen_writer("session-1").await.unwrap();
    assert!(persistence.inner.sessions.lock().contains_key("session-1"));
    // Second call: still idempotent — single writer, no error.
    persistence.reopen_writer("session-1").await.unwrap();
    assert!(persistence.inner.sessions.lock().contains_key("session-1"));

    // Finalize then reopen twice — still idempotent after a real reopen.
    persistence
        .finalize_session("session-1", PersistedSessionStatus::Closed)
        .await
        .unwrap();
    assert!(!persistence.inner.sessions.lock().contains_key("session-1"));
    persistence.reopen_writer("session-1").await.unwrap();
    let first_tx = persistence
        .inner
        .sessions
        .lock()
        .get("session-1")
        .map(|runtime| runtime.tx.clone());
    persistence.reopen_writer("session-1").await.unwrap();
    let second_tx = persistence
        .inner
        .sessions
        .lock()
        .get("session-1")
        .map(|runtime| runtime.tx.clone());
    assert!(
        first_tx.is_some() && second_tx.is_some(),
        "writer must remain installed after idempotent reopen"
    );
    // Same channel handle — reopen short-circuited, did not spawn a second writer.
    assert!(
        first_tx
            .as_ref()
            .map(|tx| tx.same_channel(second_tx.as_ref().unwrap()))
            .unwrap_or(false),
        "idempotent reopen must not replace the existing writer channel"
    );
    let _ = fs::remove_dir_all(root);
}

/// `reopen_writer` surfaces `SessionNotFound` for a session that is absent
/// from the catalog (e.g. deleted or never registered) — it must NOT
/// fabricate a writer for an unknown id.
#[tokio::test]
async fn reopen_writer_session_not_found_for_unknown_session() {
    let root = temp_dir("reopen-unknown");
    let (persistence, _) = registered(&root).await;
    assert!(matches!(
        persistence.reopen_writer("never-registered").await,
        Err(SessionPersistenceError::SessionNotFound)
    ));
    let _ = fs::remove_dir_all(root);
}

fn agent_switch_record() -> AgentSwitchRecord {
    AgentSwitchRecord {
        session_id: "session-1".to_string(),
        from_config_id: "omp".to_string(),
        to_config_id: "claude".to_string(),
        new_session_id: "session-2".to_string(),
        summary_text: "Handoff summary".to_string(),
    }
}

/// CAP-2: `append_agent_switch` writes ONE durable `agent_switch` record
/// with a writer-assigned seq, the fold materializes it, and
/// `message_count` is unchanged (a switch is not a message). Round-trips
/// through reopen.
#[tokio::test]
async fn append_agent_switch_is_durable_and_folds_once() {
    let root = temp_dir("switch-durable");
    let (persistence, _) = registered(&root).await;
    persistence
        .enqueue_event(payload_record(
            1,
            "user_prompt",
            json!({
                "agentId":"runtime-1","sessionId":"session-1","turnId":"turn-1",
                "content":[{"type":"text","text":"hello"}],
            }),
        ))
        .unwrap();
    // Flush so the queued user_prompt is durable BEFORE reading the
    // baseline (enqueue is async; metadata lags until the writer runs).
    persistence.flush_session("session-1").await.unwrap();
    let message_count_before = persistence.metadata("session-1").unwrap().message_count;
    let seq = persistence
        .append_agent_switch("session-1", agent_switch_record())
        .await
        .unwrap();
    assert_eq!(
        seq, 2,
        "writer assigns the next seq (after the user prompt)"
    );
    persistence.flush_session("session-1").await.unwrap();
    assert_eq!(persistence.last_seq("session-1").unwrap(), 2);
    // Switches are not messages: message_count must not move.
    assert_eq!(
        persistence.metadata("session-1").unwrap().message_count,
        message_count_before
    );

    // The fold materializes exactly ONE switch with the full identity.
    let payload = persistence
        .session_payload_async("session-1")
        .await
        .unwrap();
    assert_eq!(payload.switches.len(), 1);
    assert_eq!(payload.switches[0].id, "switch:seq-2");
    assert_eq!(payload.switches[0].from_config_id, "omp");
    assert_eq!(payload.switches[0].to_config_id, "claude");
    assert_eq!(payload.switches[0].new_session_id, "session-2");
    assert_eq!(payload.switches[0].summary_text, "Handoff summary");
    assert_eq!(payload.switches[0].seq, 2);
    // The durable record payload is the camelCase wire shape.
    let records = persistence.replay_after("session-1", 0).unwrap();
    let switch_record = records
        .iter()
        .find(|record| record.type_ == "agent_switch")
        .expect("durable agent_switch record");
    assert_eq!(switch_record.payload["sessionId"], "session-1");
    assert_eq!(switch_record.payload["fromConfigId"], "omp");
    assert_eq!(switch_record.payload["toConfigId"], "claude");
    assert_eq!(switch_record.payload["newSessionId"], "session-2");
    assert_eq!(switch_record.payload["summaryText"], "Handoff summary");

    // Reopen round-trip: a fresh persistence over the same root reads the
    // same switch back (restart/reopen parity).
    persistence.shutdown().await.unwrap();
    let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
    let reopened_payload = reopened.session_payload_async("session-1").await.unwrap();
    assert_eq!(reopened_payload.switches, payload.switches);
    let _ = fs::remove_dir_all(root);
}

/// CAP-2: the synthetic live fan-out event is NOT durable —
/// `is_durable_event("agent_switch")` is false, so `enqueue_event`
/// (the `WsRelaySink::emit` path) drops it. ONE durable record per
/// switch; the writer command is the sole durable author.
#[test]
fn agent_switch_live_event_is_not_durable() {
    assert!(!is_durable_event("agent_switch"));
    assert!(is_durable_event("message_chunk"));
    assert!(is_durable_event("user_prompt"));
}

/// CAP-2: the writer-assigned seq cannot collide with queued records —
/// a switch recorded between two message enqueues takes the next seq.
#[tokio::test]
async fn append_agent_switch_assigns_monotonic_seq_between_queued_events() {
    let root = temp_dir("switch-seq");
    let (persistence, _) = registered(&root).await;
    persistence
        .enqueue_event(payload_record(
            1,
            "user_prompt",
            json!({
                "agentId":"runtime-1","sessionId":"session-1","turnId":"turn-1",
                "content":[{"type":"text","text":"hello"}],
            }),
        ))
        .unwrap();
    let seq = persistence
        .append_agent_switch("session-1", agent_switch_record())
        .await
        .unwrap();
    assert_eq!(seq, 2);
    // A subsequent enqueue lands after the switch (no collision).
    persistence
        .enqueue_event(payload_record(
            3,
            "message_chunk",
            json!({"agentId":"runtime-1","sessionId":"session-1","role":"agent",
                       "content":{"type":"text","text":"reply"}}),
        ))
        .unwrap();
    persistence.flush_session("session-1").await.unwrap();
    assert_eq!(persistence.last_seq("session-1").unwrap(), 3);
    // The durable log has no holes and exactly one switch.
    let records = persistence.replay_after("session-1", 0).unwrap();
    let seqs: Vec<u64> = records.iter().map(|record| record.seq).collect();
    assert_eq!(seqs, vec![1, 2, 3]);
    assert_eq!(
        records
            .iter()
            .filter(|record| record.type_ == "agent_switch")
            .count(),
        1
    );
    let _ = fs::remove_dir_all(root);
}

/// CAP-2: `session_payload_tail_async` retains a switch inside the tail
/// window (mirroring the toolCalls retain rule) so the separator renders
/// on a tail-first reopen, and drops switches older than the window.
#[tokio::test]
async fn tail_payload_retains_switch_inside_window() {
    let root = temp_dir("switch-tail");
    let (persistence, _) = registered(&root).await;
    // 6 turns: user + agent each, with a switch between turn 3 and 4.
    for turn in 1..=3 {
        persistence
            .enqueue_event(payload_record(
                turn * 2 - 1,
                "user_prompt",
                json!({
                    "agentId":"runtime-1","sessionId":"session-1",
                    "turnId":format!("turn-{turn}"),
                    "content":[{"type":"text","text":format!("u{turn}")}],
                }),
            ))
            .unwrap();
        persistence
            .enqueue_event(payload_record(
                turn * 2,
                "message_chunk",
                json!({"agentId":"runtime-1","sessionId":"session-1","role":"agent",
                           "content":{"type":"text","text":format!("a{turn}")}}),
            ))
            .unwrap();
    }
    persistence
        .append_agent_switch("session-1", agent_switch_record())
        .await
        .unwrap();
    for turn in 4..=6 {
        persistence
            .enqueue_event(payload_record(
                turn * 2,
                "user_prompt",
                json!({
                    "agentId":"runtime-1","sessionId":"session-1",
                    "turnId":format!("turn-{turn}"),
                    "content":[{"type":"text","text":format!("u{turn}")}],
                }),
            ))
            .unwrap();
        persistence
            .enqueue_event(payload_record(
                turn * 2 + 1,
                "message_chunk",
                json!({"agentId":"runtime-1","sessionId":"session-1","role":"agent",
                           "content":{"type":"text","text":format!("a{turn}")}}),
            ))
            .unwrap();
    }
    persistence.flush_session("session-1").await.unwrap();
    // The switch sits at seq 7 (after turn 3's chunk at 6).
    assert_eq!(persistence.last_seq("session-1").unwrap(), 13);

    // Full materialize: one switch at seq 7.
    let full = persistence
        .session_payload_async("session-1")
        .await
        .unwrap();
    assert_eq!(full.switches.len(), 1);
    assert_eq!(full.switches[0].seq, 7);
    // 6 turns × (user bubble + agent reply bubble) = 12 messages.
    assert_eq!(full.messages.len(), 12);

    // Tail with limit 4: keeps the last 4 messages. The oldest kept
    // message is a8's bubble (seq 8 area); the switch at seq 7 is OLDER
    // than the window → dropped (scrolled-away history).
    let tail = persistence
        .session_payload_tail_async("session-1", 4)
        .await
        .unwrap();
    assert!(tail.messages.len() <= 4);
    assert!(
        tail.switches.is_empty(),
        "switch older than the tail window is dropped"
    );

    // Tail with limit 12: the whole conversation fits; the switch stays.
    let tail_all = persistence
        .session_payload_tail_async("session-1", 12)
        .await
        .unwrap();
    assert_eq!(tail_all.messages.len(), 12);
    assert_eq!(tail_all.switches.len(), 1);
    assert_eq!(tail_all.switches[0].seq, 7);
    let _ = fs::remove_dir_all(root);
}

/// CAP-2: `replay_tail`'s fold-boundary check counts `agent_switch` as a
/// boundary, so a tail starting at a post-switch `message_chunk` does
/// NOT fall back to a full replay (the switch guarantees the chunk opens
/// a fresh bubble — matching the full fold's ids).
#[tokio::test]
async fn replay_tail_treats_agent_switch_as_fold_boundary() {
    let root = temp_dir("switch-boundary");
    let (persistence, _) = registered(&root).await;
    // A long pre-switch run: 20 chunks of one coalesced bubble.
    persistence
        .enqueue_event(payload_record(
            1,
            "user_prompt",
            json!({
                "agentId":"runtime-1","sessionId":"session-1","turnId":"turn-1",
                "content":[{"type":"text","text":"hello"}],
            }),
        ))
        .unwrap();
    for seq in 2..=21 {
        persistence
            .enqueue_event(payload_record(
                seq,
                "message_chunk",
                json!({"agentId":"runtime-1","sessionId":"session-1","role":"agent",
                           "content":{"type":"text","text":"x"}}),
            ))
            .unwrap();
    }
    persistence
        .append_agent_switch("session-1", agent_switch_record())
        .await
        .unwrap();
    // Post-switch: a fresh agent run of 5 chunks.
    for seq in 23..=27 {
        persistence
            .enqueue_event(payload_record(
                seq,
                "message_chunk",
                json!({"agentId":"runtime-1","sessionId":"session-1","role":"agent",
                           "content":{"type":"text","text":"y"}}),
            ))
            .unwrap();
    }
    persistence.flush_session("session-1").await.unwrap();

    // `load_jsonl_tail` reads the last `limit*4` lines; with 27 records
    // a small limit still lands the window before the switch (the
    // full-replay fallback then correctly returns every record). The
    // invariant that matters: whatever window comes back, the fold
    // opens a FRESH bubble at the first post-switch chunk using the id
    // the full fold assigns — never a mis-split.
    let tail = persistence.replay_tail("session-1", 2).unwrap();
    assert!(
        tail.iter().any(|r| r.type_ == "agent_switch"),
        "tail (or its full-replay fallback) retains the switch record"
    );
    let payload = crate::acp::session_payload::materialize_session_payload(
        &persistence.metadata("session-1").unwrap(),
        &tail,
    );
    assert!(
        payload.messages.iter().any(|m| m.id == "snapshot:agent:23"),
        "post-switch bubble id matches the full fold"
    );
    assert_eq!(payload.switches.len(), 1);

    // The boundary arm itself: craft a window whose FIRST record is a
    // post-switch chunk with the switch immediately before it inside the
    // set — the arm must find the boundary and skip the full replay.
    // (window = [switch(22), chunk(23)] → first message is 23, boundary
    // at 22 < 23 present → no fallback; the fold's ids still match.)
    let window = vec![
        persistence
            .replay_after("session-1", 0)
            .unwrap()
            .into_iter()
            .find(|r| r.type_ == "agent_switch")
            .unwrap(),
        persistence
            .replay_after("session-1", 22)
            .unwrap()
            .into_iter()
            .find(|r| r.seq == 23)
            .unwrap(),
    ];
    let window_payload = crate::acp::session_payload::materialize_session_payload(
        &persistence.metadata("session-1").unwrap(),
        &window,
    );
    assert!(window_payload
        .messages
        .iter()
        .any(|m| m.id == "snapshot:agent:23"));
    assert_eq!(window_payload.switches.len(), 1);
    let _ = fs::remove_dir_all(root);
}
