use super::*;
use crate::acp::session_persistence::{SessionPersistence, SessionRegistration};
use crate::web::WsRelaySink;
use agent_client_protocol::schema::v1::{ContentBlock, TextContent};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

/// Zero is meaningless for the three strictly-positive timeouts and must
/// be rejected at the IPC boundary (the resolvers also filter it
/// defensively). Rejection happens BEFORE the override is stored, so
/// these assertions never mutate the shared override statics.
#[test]
fn zero_overrides_are_rejected_for_strictly_positive_timeouts() {
    assert!(acp_set_turn_idle_timeout(Some(0)).is_err());
    assert!(acp_set_session_new_timeout(Some(0)).is_err());
    assert!(acp_set_session_reopen_timeout(Some(0)).is_err());
}

/// Regression: the desktop `acp_send_prompt` command persists an accepted
/// non-ephemeral prompt through `WsRelaySink` before dispatch (matching the
/// WS `send_prompt` handler ordering). This exercises the extracted
/// `persist_accepted_prompt` helper directly: it must write one durable
/// `user_prompt` record whose payload shape (`{agentId, sessionId, turnId,
/// content}`) matches the web path byte-for-byte — including the
/// client-minted `turnId`, which the payload fold uses to materialize the
/// `turn:<turnId>` bubble id the optimistic renderer bubble already holds.
/// The command body calls this helper BEFORE `AcpManager::send_prompt` and
/// only when `is_ephemeral_session` returns `false`; those ordering +
/// ephemeral-skip invariants are enforced by the command body structure (a
/// full `acp_send_prompt` unit test would need a real `AcpManager` + Tauri
/// `State`, which is not constructible here).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn persist_accepted_prompt_writes_durable_user_prompt_with_desktop_payload() {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("termul-acp-prompt-persist-{stamp}"));
    std::fs::create_dir_all(&root).unwrap();
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    persistence
        .register_session(SessionRegistration {
            session_id: "sess-desktop".to_string(),
            stable_agent_namespace: None,
            runtime_agent_id: None,
            project_id: None,
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    let relay = Arc::new(WsRelaySink::with_persistence(8, persistence.clone()));
    let blocks = vec![ContentBlock::Text(TextContent::new("hello world"))];
    persist_accepted_prompt(
        &relay,
        &AgentId("agent-1".to_string()),
        &SessionId("sess-desktop".to_string()),
        &blocks,
        Some("turn-desktop-1"),
    )
    .await
    .unwrap();

    // The durable frontier advanced: one user_prompt record at seq 1.
    assert_eq!(persistence.last_seq("sess-desktop").unwrap(), 1);
    let metadata = persistence.metadata("sess-desktop").unwrap();
    assert_eq!(metadata.message_count, 1);
    // First-message title provenance is established from the user_prompt.
    assert!(metadata.title.is_some(), "title derived from user_prompt");

    // The durable record carries the desktop payload shape (matches the
    // WS `send_prompt` handler): agentId, sessionId, turnId, content.
    let records = persistence
        .replay_after_async("sess-desktop".to_string(), 0)
        .await
        .unwrap();
    assert_eq!(records.len(), 1);
    let record = &records[0];
    assert_eq!(record.type_, "user_prompt");
    assert_eq!(record.seq, 1);
    assert_eq!(record.payload["agentId"], "agent-1");
    assert_eq!(record.payload["sessionId"], "sess-desktop");
    assert_eq!(
        record.payload["turnId"], "turn-desktop-1",
        "desktop path persists the client-minted turnId so the materialized \
             bubble id-matches the renderer's optimistic `turn:<turnId>` bubble"
    );
    let content = record.payload["content"].as_array().unwrap();
    assert_eq!(content.len(), 1);
    assert_eq!(content[0]["text"], "hello world");

    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

/// A caller that omits the client turn-id (`None`) keeps the legacy
/// `turnId: null` shape — the payload fold then materializes the
/// `user:seq-*` fallback id.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn persist_accepted_prompt_without_turn_id_writes_null() {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("termul-acp-prompt-persist-null-{stamp}"));
    std::fs::create_dir_all(&root).unwrap();
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    persistence
        .register_session(SessionRegistration {
            session_id: "sess-no-turn".to_string(),
            stable_agent_namespace: None,
            runtime_agent_id: None,
            project_id: None,
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    let relay = Arc::new(WsRelaySink::with_persistence(8, persistence.clone()));
    let blocks = vec![ContentBlock::Text(TextContent::new("hi"))];
    persist_accepted_prompt(
        &relay,
        &AgentId("agent-1".to_string()),
        &SessionId("sess-no-turn".to_string()),
        &blocks,
        None,
    )
    .await
    .unwrap();

    let records = persistence
        .replay_after_async("sess-no-turn".to_string(), 0)
        .await
        .unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].type_, "user_prompt");
    assert!(records[0].payload["turnId"].is_null());

    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

/// CAP-2 (spec-in-chat-agent-switch): the desktop command writes the
/// durable `agent_switch` record with the camelCase payload matching the
/// WS `record_agent_switch` route byte-for-byte. Exercises the manager's
/// `record_agent_switch` (the command's delegation target — a full
/// command unit test would need a Tauri `State`, which is not
/// constructible here; the manager-with-persistence setup mirrors the
/// ws.rs tests).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn record_agent_switch_writes_durable_marker_with_desktop_payload() {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("termul-acp-switch-persist-{stamp}"));
    std::fs::create_dir_all(&root).unwrap();
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    persistence
        .register_session(SessionRegistration {
            session_id: "sess-switch".to_string(),
            stable_agent_namespace: Some("config:omp".to_string()),
            runtime_agent_id: Some("runtime-1".to_string()),
            project_id: None,
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    let manager = Arc::new(AcpManager::with_persistence(vec![], persistence.clone()));

    manager
        .record_agent_switch(
            "sess-switch".to_string(),
            AgentSwitchRecord {
                session_id: "sess-switch".to_string(),
                from_config_id: "omp".to_string(),
                to_config_id: "claude".to_string(),
                new_session_id: "sess-switch-new".to_string(),
                summary_text: "Handoff summary".to_string(),
            },
        )
        .await
        .unwrap();

    // The durable frontier advanced: one agent_switch record at seq 1.
    assert_eq!(persistence.last_seq("sess-switch").unwrap(), 1);
    let metadata = persistence.metadata("sess-switch").unwrap();
    // Switches are not messages: message_count stays unchanged.
    assert_eq!(metadata.message_count, 0);

    // The durable record carries the shared camelCase payload shape
    // (matches the WS `record_agent_switch` handler byte-for-byte).
    let records = persistence.replay_after("sess-switch", 0).unwrap();
    assert_eq!(records.len(), 1);
    let record = &records[0];
    assert_eq!(record.type_, "agent_switch");
    assert_eq!(record.seq, 1);
    assert_eq!(record.payload["sessionId"], "sess-switch");
    assert_eq!(record.payload["fromConfigId"], "omp");
    assert_eq!(record.payload["toConfigId"], "claude");
    assert_eq!(record.payload["newSessionId"], "sess-switch-new");
    assert_eq!(record.payload["summaryText"], "Handoff summary");

    // The fold materializes exactly one marker (one durable record).
    let payload = persistence
        .session_payload_async("sess-switch")
        .await
        .unwrap();
    assert_eq!(payload.switches.len(), 1);
    assert_eq!(payload.switches[0].id, "switch:seq-1");

    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

/// CAP-2: an unknown session fails closed BEFORE any durable write (the
/// command's not-found pre-check contract).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn record_agent_switch_unknown_session_fails_closed() {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("termul-acp-switch-nf-{stamp}"));
    std::fs::create_dir_all(&root).unwrap();
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    persistence
        .register_session(SessionRegistration {
            session_id: "sess-known".to_string(),
            stable_agent_namespace: None,
            runtime_agent_id: None,
            project_id: None,
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    let manager = Arc::new(AcpManager::with_persistence(vec![], persistence.clone()));

    let error = manager
        .record_agent_switch(
            "sess-absent".to_string(),
            AgentSwitchRecord {
                session_id: "sess-absent".to_string(),
                from_config_id: "omp".to_string(),
                to_config_id: "claude".to_string(),
                new_session_id: "sess-new".to_string(),
                summary_text: "summary".to_string(),
            },
        )
        .await
        .unwrap_err();
    // Unknown session surfaces as a write failure; the known session is
    // untouched (no durable record, no seq advance).
    assert!(!error.is_empty());
    assert!(persistence
        .replay_after("sess-known", 0)
        .unwrap()
        .is_empty());
    assert_eq!(persistence.last_seq("sess-known").unwrap(), 0);

    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}
