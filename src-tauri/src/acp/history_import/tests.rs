use super::*;
use crate::acp::session_persistence::SessionPersistenceError;

fn temp_dir(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "termul-history-import-{label}-{}-{}",
        std::process::id(),
        crate::acp::session_persistence::now_millis()
    ));
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn legacy_payload(session_id: &str, cwd: &str, status: &str, messages: Value) -> Value {
    json!({
        "metadata": {
            "id": session_id,
            "agentId": "agent-1",
            "agentConfigId": "claude-1",
            "title": "Legacy title",
            "cwd": cwd,
            "projectId": "project-1",
            "createdAt": 1_700_000_000_000_u64,
            "lastActivityAt": 1_700_000_060_000_u64,
            "messageCount": 3,
            "lastSeq": 0,
            "status": status,
        },
        "messages": messages,
    })
}

fn turn_messages() -> Value {
    json!([
        {
            "id": "turn:turn-1",
            "role": "user",
            "blocks": [{"type": "text", "text": "hello"}],
            "streaming": false,
            "timestamp": 1_700_000_010_000_u64,
        },
        {
            "id": "snap-agent",
            "role": "agent",
            "blocks": [{"type": "text", "text": "world"}, {"type": "text", "text": " again"}],
            "streaming": false,
            "timestamp": 1_700_000_020_000_u64,
        },
    ])
}

async fn setup(label: &str) -> (PathBuf, Arc<SessionPersistence>, Arc<ChatHistoryStore>) {
    let root = temp_dir(label);
    std::fs::create_dir_all(root.join("cwd")).unwrap();
    let persistence = SessionPersistence::open(root.join("store")).await.unwrap();
    let chat_history = ChatHistoryStore::open(root.join("legacy")).unwrap();
    (root, persistence, chat_history)
}

#[tokio::test]
async fn imports_legacy_sessions_with_provenance_and_round_trip() {
    let (root, persistence, chat_history) = setup("roundtrip").await;
    let cwd = root.join("cwd").to_string_lossy().into_owned();
    chat_history
        .save(
            "legacy-1",
            legacy_payload("legacy-1", &cwd, "closed", turn_messages()),
        )
        .unwrap();

    assert_eq!(import_chat_history(&persistence, &chat_history).await, 1);

    let metadata = persistence.metadata("legacy-1").unwrap();
    assert_eq!(metadata.created_at, 1_700_000_000_000_u64);
    assert_eq!(metadata.title.as_deref(), Some("Legacy title"));
    assert_eq!(
        metadata.stable_agent_namespace.as_deref(),
        Some("config:claude-1")
    );
    assert_eq!(metadata.project_id.as_deref(), Some("project-1"));
    assert_eq!(metadata.status, PersistedSessionStatus::Closed);

    let payload = persistence.session_payload_async("legacy-1").await.unwrap();
    assert_eq!(payload.metadata.id, "legacy-1");
    assert_eq!(
        payload.metadata.agent_config_id.as_deref(),
        Some("claude-1")
    );
    assert_eq!(payload.metadata.created_at, 1_700_000_000_000_u64);
    assert_eq!(payload.messages.len(), 2);
    assert_eq!(payload.messages[0].id, "turn:turn-1");
    assert_eq!(payload.messages[0].role, "user");
    // The two consecutive text blocks coalesce exactly like `appendBlocks`.
    assert_eq!(payload.messages[1].role, "agent");
    assert_eq!(payload.messages[1].blocks.len(), 1);
    assert_eq!(payload.messages[1].blocks[0]["text"], "world again");
    assert_eq!(payload.messages[1].id, "snapshot:agent:2");

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn import_is_idempotent_across_runs() {
    let (root, persistence, chat_history) = setup("idempotent").await;
    let cwd = root.join("cwd").to_string_lossy().into_owned();
    chat_history
        .save(
            "legacy-1",
            legacy_payload("legacy-1", &cwd, "closed", turn_messages()),
        )
        .unwrap();

    assert_eq!(import_chat_history(&persistence, &chat_history).await, 1);
    assert_eq!(import_chat_history(&persistence, &chat_history).await, 0);
    assert_eq!(persistence.list_sessions().len(), 1);

    // Also across a host restart (catalog rebuilt from disk).
    persistence.shutdown().await.unwrap();
    let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
    assert_eq!(import_chat_history(&reopened, &chat_history).await, 0);
    assert_eq!(reopened.list_sessions().len(), 1);

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn import_skips_degraded_empty_cwd_entries() {
    let (root, persistence, chat_history) = setup("empty-cwd").await;
    chat_history
        .save(
            "legacy-broken",
            legacy_payload("legacy-broken", "", "closed", turn_messages()),
        )
        .unwrap();
    assert_eq!(import_chat_history(&persistence, &chat_history).await, 0);
    assert!(persistence.list_sessions().is_empty());
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn import_is_fail_open_on_corrupt_payload() {
    let (root, persistence, chat_history) = setup("corrupt").await;
    let cwd = root.join("cwd").to_string_lossy().into_owned();
    chat_history
        .save(
            "legacy-good",
            legacy_payload("legacy-good", &cwd, "closed", turn_messages()),
        )
        .unwrap();
    chat_history
        .save(
            "legacy-bad",
            legacy_payload("legacy-bad", &cwd, "closed", turn_messages()),
        )
        .unwrap();
    // Corrupt the second payload on disk; the store index still lists it.
    let payloads_dir = root.join("legacy").join("payloads");
    let bad_path = payloads_dir
        .read_dir()
        .unwrap()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .find(|path| {
            std::fs::read(path)
                .map(|bytes| bytes.windows(10).any(|w| w == b"legacy-bad"))
                .unwrap_or(false)
        })
        .unwrap();
    std::fs::write(&bad_path, b"{not valid json").unwrap();

    assert_eq!(
        import_chat_history(&persistence, &chat_history).await,
        1,
        "the corrupt entry is skipped; the good entry still imports"
    );
    assert_eq!(persistence.list_sessions().len(), 1);
    assert_eq!(persistence.list_sessions()[0].session_id, "legacy-good");

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn import_preserves_error_status_and_dangling_turns() {
    let (root, persistence, chat_history) = setup("error-status").await;
    let cwd = root.join("cwd").to_string_lossy().into_owned();
    // User prompt with no response: the turn never completed, so no
    // `prompt_complete` may be fabricated for it.
    let dangling = json!([{
        "id": "turn:turn-9",
        "role": "user",
        "blocks": [{"type": "text", "text": "anyone there?"}],
        "streaming": false,
        "timestamp": 1_700_000_030_000_u64,
    }]);
    chat_history
        .save(
            "legacy-err",
            legacy_payload("legacy-err", &cwd, "error", dangling),
        )
        .unwrap();
    assert_eq!(import_chat_history(&persistence, &chat_history).await, 1);

    let metadata = persistence.metadata("legacy-err").unwrap();
    assert_eq!(metadata.status, PersistedSessionStatus::Error);
    assert_eq!(
        persistence.completed_turn_ids("legacy-err").unwrap().len(),
        0,
        "an unanswered prompt must not count as a completed turn"
    );
    let enqueue = persistence.enqueue_event(PersistedEventRecord {
        schema_version: SESSION_SCHEMA_VERSION,
        session_id: "legacy-err".to_string(),
        seq: 99,
        type_: "message_chunk".to_string(),
        recorded_at: 0,
        payload: json!({}),
    });
    assert!(
        matches!(enqueue, Err(SessionPersistenceError::SessionNotFound)),
        "imported sessions are finalized archives without writers"
    );
    let _ = std::fs::remove_dir_all(root);
}

/// A user deletion of an imported session must be FINAL: without the
/// imported-id ledger the next startup import would resurrect the session
/// from the read-only legacy archive.
#[tokio::test]
async fn import_keeps_user_deletions_final() {
    let (root, persistence, chat_history) = setup("delete-final").await;
    let cwd = root.join("cwd").to_string_lossy().into_owned();
    chat_history
        .save(
            "legacy-del",
            legacy_payload("legacy-del", &cwd, "closed", turn_messages()),
        )
        .unwrap();
    assert_eq!(import_chat_history(&persistence, &chat_history).await, 1);

    // The user deletes the imported session…
    persistence.delete_session("legacy-del").await.unwrap();
    assert!(persistence.metadata("legacy-del").is_err());

    // …and a re-import (same run) must not resurrect it.
    assert_eq!(import_chat_history(&persistence, &chat_history).await, 0);
    assert!(persistence.metadata("legacy-del").is_err());

    // The ledger survives a restart, so the deletion stays final.
    persistence.shutdown().await.unwrap();
    let reopened = crate::acp::SessionPersistence::open(root.join("store"))
        .await
        .unwrap();
    assert_eq!(import_chat_history(&reopened, &chat_history).await, 0);
    assert!(reopened.metadata("legacy-del").is_err());

    let _ = std::fs::remove_dir_all(root);
}
