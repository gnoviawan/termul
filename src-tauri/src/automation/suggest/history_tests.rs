use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;

use super::*;
use crate::acp::session_persistence::{
    PersistedEventRecord, SessionRegistration, SESSION_SCHEMA_VERSION,
};

const SESSION: &str = "chat-1";

async fn chat_with_one_prompt(root: &Path) -> Arc<SessionPersistence> {
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    persistence
        .register_session(SessionRegistration {
            session_id: SESSION.to_string(),
            project_id: Some("p1".to_string()),
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    persistence
        .enqueue_event(PersistedEventRecord {
            schema_version: SESSION_SCHEMA_VERSION,
            session_id: SESSION.to_string(),
            seq: 1,
            type_: "user_prompt".to_string(),
            recorded_at: 1_000,
            payload: json!({
                "content": [{ "type": "text", "text": "summarize the open PRs" }]
            }),
        })
        .unwrap();
    persistence.flush_session(SESSION).await.unwrap();
    persistence
}

#[tokio::test]
async fn a_chat_log_that_failed_to_read_is_read_again() {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("termul-suggest-history-{stamp}"));
    let persistence = chat_with_one_prompt(&root).await;
    let storage_key = persistence.metadata(SESSION).unwrap().storage_key;
    let log = persistence.root().join(storage_key).join("messages.jsonl");
    let moved = log.with_extension("away");
    let history = SessionHistory::new(persistence.clone());

    std::fs::rename(&log, &moved).unwrap();
    assert_eq!(history.prompts("p1", 0), vec![]);

    std::fs::rename(&moved, &log).unwrap();
    assert_eq!(
        history.prompts("p1", 0),
        vec![Prompt {
            at_ms: 1_000,
            text: "summarize the open PRs".to_string(),
        }]
    );
    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}
