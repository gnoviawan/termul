use super::*;
use serde_json::json;

fn temp_dir(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "termul-sweep-{label}-{}-{}",
        std::process::id(),
        now_millis()
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

async fn registered(root: &Path, session_id: &str) -> Arc<SessionPersistence> {
    let cwd = root.join("cwd");
    fs::create_dir_all(&cwd).unwrap();
    let persistence = SessionPersistence::open(root.join("store")).await.unwrap();
    register(&persistence, session_id, &cwd).await;
    persistence
}

async fn register(persistence: &SessionPersistence, session_id: &str, cwd: &Path) {
    persistence
        .register_session(SessionRegistration {
            session_id: session_id.to_string(),
            stable_agent_namespace: Some("config:one".to_string()),
            runtime_agent_id: Some("runtime-1".to_string()),
            project_id: Some("project-1".to_string()),
            cwd: cwd.to_path_buf(),
            ..Default::default()
        })
        .await
        .unwrap();
}

fn event(session_id: &str, seq: u64, type_: &str, payload: Value) -> PersistedEventRecord {
    PersistedEventRecord {
        schema_version: SESSION_SCHEMA_VERSION,
        session_id: session_id.to_string(),
        seq,
        type_: type_.to_string(),
        recorded_at: 1_000 + seq,
        payload,
    }
}

fn user_prompt(persistence: &SessionPersistence, session_id: &str, seq: u64, turn_id: &str) {
    persistence
        .enqueue_event(event(
            session_id,
            seq,
            "user_prompt",
            json!({"sessionId": session_id, "turnId": turn_id, "content": []}),
        ))
        .unwrap();
}

fn chunk(persistence: &SessionPersistence, session_id: &str, seq: u64) {
    persistence
        .enqueue_event(event(
            session_id,
            seq,
            "message_chunk",
            json!({
                "sessionId": session_id,
                "role": "agent",
                "content": {"type": "text", "text": "partial"},
            }),
        ))
        .unwrap();
}

fn complete(persistence: &SessionPersistence, session_id: &str, seq: u64, turn_id: &str) {
    persistence
        .enqueue_event(event(
            session_id,
            seq,
            "prompt_complete",
            json!({"sessionId": session_id, "turnId": turn_id, "stopReason": "end_turn"}),
        ))
        .unwrap();
}

fn messages_path(persistence: &SessionPersistence, session_id: &str) -> PathBuf {
    let metadata = persistence.metadata(session_id).unwrap();
    persistence
        .inner
        .root
        .join(metadata.storage_key)
        .join(MESSAGES_FILE)
}

fn terminators(persistence: &SessionPersistence, session_id: &str) -> Vec<PersistedEventRecord> {
    persistence
        .replay_after(session_id, 0)
        .unwrap()
        .into_iter()
        .filter(|record| record.type_ == "prompt_complete")
        .collect()
}

async fn crash_and_reopen(persistence: Arc<SessionPersistence>, root: &Path) -> Arc<SessionPersistence> {
    persistence.flush_session("session-1").await.ok();
    drop(persistence);
    SessionPersistence::open(root.join("store")).await.unwrap()
}

/// A host crash mid-turn leaves the open turn terminated by exactly one
/// `interrupted` record at the next seq; a second host start adds nothing.
#[tokio::test]
async fn sweep_terminates_open_turn_once_and_is_idempotent() {
    let root = temp_dir("open-turn");
    let persistence = registered(&root, "session-1").await;
    user_prompt(&persistence, "session-1", 1, "turn-1");
    chunk(&persistence, "session-1", 2);
    complete(&persistence, "session-1", 3, "turn-1");
    user_prompt(&persistence, "session-1", 4, "turn-2");
    chunk(&persistence, "session-1", 5);
    persistence.flush_session("session-1").await.unwrap();
    let activity_before = persistence.metadata("session-1").unwrap().last_activity_at;

    let reopened = crash_and_reopen(persistence, &root).await;
    let markers = terminators(&reopened, "session-1");
    assert_eq!(markers.len(), 2, "one real + one interrupted terminator");
    let marker = markers.last().unwrap();
    assert_eq!(marker.payload["stopReason"], "interrupted");
    assert_eq!(marker.payload["turnId"], "turn-2");
    assert_eq!(marker.seq, 6);
    let metadata = reopened.metadata("session-1").unwrap();
    assert_eq!(metadata.last_seq, 6);
    assert_eq!(metadata.status, PersistedSessionStatus::Closed);
    assert_eq!(
        metadata.last_activity_at, activity_before,
        "the sweep must not reorder the history list"
    );
    assert!(reopened
        .completed_turn_ids("session-1")
        .unwrap()
        .contains("turn-2"));
    let bytes_after_first = fs::read(messages_path(&reopened, "session-1")).unwrap();

    drop(reopened);
    let again = SessionPersistence::open(root.join("store")).await.unwrap();
    assert_eq!(terminators(&again, "session-1").len(), 2);
    assert_eq!(
        fs::read(messages_path(&again, "session-1")).unwrap(),
        bytes_after_first,
        "a second host start must add nothing"
    );
    let _ = fs::remove_dir_all(root);
}

/// Closed turns, empty sessions and prompt-less logs are left byte-for-byte
/// alone; only the crashed session gains a terminator.
#[tokio::test]
async fn sweep_leaves_clean_and_empty_sessions_untouched() {
    let root = temp_dir("clean");
    let persistence = registered(&root, "session-1").await;
    let cwd = root.join("cwd");
    register(&persistence, "session-empty", &cwd).await;
    register(&persistence, "session-chatter", &cwd).await;
    user_prompt(&persistence, "session-1", 1, "turn-1");
    complete(&persistence, "session-1", 2, "turn-1");
    for seq in 1..=100 {
        chunk(&persistence, "session-chatter", seq);
    }
    persistence.flush_session("session-1").await.unwrap();
    persistence.flush_session("session-chatter").await.unwrap();
    let before: Vec<Vec<u8>> = ["session-1", "session-empty", "session-chatter"]
        .iter()
        .map(|id| fs::read(messages_path(&persistence, id)).unwrap())
        .collect();

    drop(persistence);
    let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
    let after: Vec<Vec<u8>> = ["session-1", "session-empty", "session-chatter"]
        .iter()
        .map(|id| fs::read(messages_path(&reopened, id)).unwrap())
        .collect();
    assert_eq!(before, after);
    assert_eq!(reopened.metadata("session-1").unwrap().last_seq, 2);
    let _ = fs::remove_dir_all(root);
}

/// A crash can tear the final write; the repair runs before the sweep, so the
/// terminator lands after the last intact record and the log parses.
#[tokio::test]
async fn sweep_runs_after_torn_tail_repair() {
    let root = temp_dir("torn");
    let persistence = registered(&root, "session-1").await;
    user_prompt(&persistence, "session-1", 1, "turn-1");
    chunk(&persistence, "session-1", 2);
    persistence.flush_session("session-1").await.unwrap();
    let log = messages_path(&persistence, "session-1");
    drop(persistence);
    fs::OpenOptions::new()
        .append(true)
        .open(&log)
        .unwrap()
        .write_all(b"{\"schemaVersion\":1,\"sessionId\":\"sess")
        .unwrap();

    let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
    let records = reopened.replay_after("session-1", 0).unwrap();
    let seqs: Vec<u64> = records.iter().map(|record| record.seq).collect();
    assert_eq!(seqs, vec![1, 2, 3]);
    let marker = records.last().unwrap();
    assert_eq!(marker.type_, "prompt_complete");
    assert_eq!(marker.payload["stopReason"], "interrupted");
    assert_eq!(marker.payload["turnId"], "turn-1");
    let _ = fs::remove_dir_all(root);
}

/// An open turn whose run of chunks is longer than the first tail window is
/// still found, and a stale-low metadata `last_seq` cannot make the marker
/// reuse a seq.
#[tokio::test]
async fn sweep_finds_open_turn_behind_a_long_chunk_run() {
    let root = temp_dir("long-run");
    let persistence = registered(&root, "session-1").await;
    user_prompt(&persistence, "session-1", 1, "turn-1");
    for seq in 2..=200 {
        chunk(&persistence, "session-1", seq);
    }
    persistence.flush_session("session-1").await.unwrap();
    drop(persistence);
    // Metadata lagging the log frontier, as after a crash between flushes.
    let metadata_path = fs::read_dir(root.join("store"))
        .unwrap()
        .flatten()
        .map(|entry| entry.path().join(METADATA_FILE))
        .find(|path| path.is_file())
        .unwrap();
    let mut metadata: SessionMetadata =
        serde_json::from_slice(&fs::read(&metadata_path).unwrap()).unwrap();
    metadata.last_seq = 150;
    fs::write(&metadata_path, serde_json::to_vec(&metadata).unwrap()).unwrap();

    let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
    let markers = terminators(&reopened, "session-1");
    assert_eq!(markers.len(), 1);
    assert_eq!(markers[0].seq, 201);
    assert_eq!(markers[0].payload["turnId"], "turn-1");
    assert_eq!(reopened.metadata("session-1").unwrap().last_seq, 201);
    let _ = fs::remove_dir_all(root);
}

/// After the sweep the session accepts the next turn on its normal writer
/// path: the swept seq is below the next one and the log stays valid.
#[tokio::test]
async fn swept_session_accepts_next_turn() {
    let root = temp_dir("next-turn");
    let persistence = registered(&root, "session-1").await;
    user_prompt(&persistence, "session-1", 1, "turn-1");
    persistence.flush_session("session-1").await.unwrap();

    let reopened = crash_and_reopen(persistence, &root).await;
    reopened.reopen_writer("session-1").await.unwrap();
    user_prompt(&reopened, "session-1", 3, "turn-2");
    complete(&reopened, "session-1", 4, "turn-2");
    reopened.flush_session("session-1").await.unwrap();
    let ids = reopened.completed_turn_ids("session-1").unwrap();
    assert!(ids.contains("turn-1") && ids.contains("turn-2"));
    assert_eq!(terminators(&reopened, "session-1").len(), 2);
    let _ = fs::remove_dir_all(root);
}

fn complete_with(
    persistence: &SessionPersistence,
    seq: u64,
    payload: Value,
) {
    persistence
        .enqueue_event(event("session-1", seq, "prompt_complete", payload))
        .unwrap();
}

/// A completion naming ANOTHER turn (or none) does not close the open prompt:
/// the gate must agree with `last_unmatched_user_prompt` and still sweep it.
#[tokio::test]
async fn sweep_treats_mismatched_or_turnless_completion_as_still_open() {
    for (label, payload) in [
        (
            "other-turn",
            json!({"sessionId": "session-1", "turnId": "turn-other", "stopReason": "end_turn"}),
        ),
        (
            "no-turn",
            json!({"sessionId": "session-1", "stopReason": "end_turn"}),
        ),
    ] {
        let root = temp_dir(label);
        let persistence = registered(&root, "session-1").await;
        user_prompt(&persistence, "session-1", 1, "turn-1");
        complete_with(&persistence, 2, payload);
        persistence.flush_session("session-1").await.unwrap();

        let reopened = crash_and_reopen(persistence, &root).await;
        let markers = terminators(&reopened, "session-1");
        assert_eq!(markers.len(), 2, "{label}: the open turn gains a terminator");
        assert_eq!(markers[1].payload["stopReason"], "interrupted", "{label}");
        assert_eq!(markers[1].payload["turnId"], "turn-1", "{label}");
        let _ = fs::remove_dir_all(root);
    }
}

/// A legacy turnless `user_prompt` is closed by any later completion and is
/// left alone; an open one is swept without a `turnId`.
#[tokio::test]
async fn sweep_handles_legacy_turnless_prompts() {
    let root = temp_dir("turnless");
    let persistence = registered(&root, "session-1").await;
    let turnless = |seq: u64| {
        event(
            "session-1",
            seq,
            "user_prompt",
            json!({"sessionId": "session-1", "turnId": null, "content": []}),
        )
    };
    persistence.enqueue_event(turnless(1)).unwrap();
    complete_with(
        &persistence,
        2,
        json!({"sessionId": "session-1", "stopReason": "end_turn"}),
    );
    persistence.enqueue_event(turnless(3)).unwrap();
    persistence.flush_session("session-1").await.unwrap();

    let reopened = crash_and_reopen(persistence, &root).await;
    let markers = terminators(&reopened, "session-1");
    assert_eq!(markers.len(), 2, "only the open turnless prompt is swept");
    assert_eq!(markers[1].seq, 4);
    assert!(markers[1].payload.get("turnId").is_none());
    let _ = fs::remove_dir_all(root);
}
