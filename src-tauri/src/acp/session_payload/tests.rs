use super::*;
use crate::acp::session_persistence::SESSION_SCHEMA_VERSION;
use serde_json::json;

fn metadata() -> SessionMetadata {
    SessionMetadata {
        schema_version: SESSION_SCHEMA_VERSION,
        storage_key: "0a0b0c0d-0e0f-4a0b-8c0d-0e0f10111213".to_string(),
        session_id: "session-1".to_string(),
        stable_agent_namespace: Some("config:claude".to_string()),
        runtime_agent_id: Some("runtime-1".to_string()),
        project_id: Some("project-1".to_string()),
        cwd: "/work/project".to_string(),
        title: Some("Chat title".to_string()),
        title_source: None,
        created_at: 100,
        last_activity_at: 900,
        status: PersistedSessionStatus::Active,
        message_count: 0,
        tool_count: 0,
        last_seq: 0,
        discovered: false,
        worktree_path: Some("/work/project/.termul/worktrees/chat/abc123".to_string()),
        worktree_branch: Some("chat/abc123".to_string()),
    }
}

fn record(seq: u64, type_: &str, payload: Value) -> PersistedEventRecord {
    PersistedEventRecord {
        schema_version: SESSION_SCHEMA_VERSION,
        session_id: "session-1".to_string(),
        seq,
        type_: type_.to_string(),
        recorded_at: 100 + seq,
        payload,
    }
}

fn user_prompt(seq: u64, turn_id: Option<&str>, text: &str) -> PersistedEventRecord {
    let mut payload = json!({
        "agentId": "runtime-1",
        "sessionId": "session-1",
        "content": [{"type": "text", "text": text}],
    });
    if let Some(turn_id) = turn_id {
        payload["turnId"] = json!(turn_id);
    }
    record(seq, "user_prompt", payload)
}

fn chunk(seq: u64, role: &str, text: &str) -> PersistedEventRecord {
    record(
        seq,
        "message_chunk",
        json!({
            "agentId": "runtime-1",
            "sessionId": "session-1",
            "role": role,
            "content": {"type": "text", "text": text},
        }),
    )
}

fn tool_call(seq: u64) -> PersistedEventRecord {
    record(
        seq,
        "tool_call",
        json!({
            "agentId": "runtime-1",
            "sessionId": "session-1",
            "toolCall": {"toolCallId": "t-1", "kind": "execute", "status": "completed"},
        }),
    )
}

fn tool_call_update(seq: u64) -> PersistedEventRecord {
    record(
        seq,
        "tool_call_update",
        json!({
            "agentId": "runtime-1",
            "sessionId": "session-1",
            "update": {"toolCallId": "t-1", "status": "completed"},
        }),
    )
}

fn prompt_complete(seq: u64, turn_id: &str) -> PersistedEventRecord {
    record(
        seq,
        "prompt_complete",
        json!({"sessionId": "session-1", "turnId": turn_id, "stopReason": "end_turn"}),
    )
}

#[test]
fn full_transcript_folds_into_renderer_bubbles() {
    let records = vec![
        user_prompt(1, Some("turn-1"), "hello"),
        chunk(2, "agent", "Hel"),
        chunk(3, "agent", "lo "),
        chunk(4, "thought", "thinking…"),
        tool_call(5),
        chunk(6, "agent", "world"),
        tool_call_update(7),
        chunk(8, "agent", "!"),
        prompt_complete(9, "turn-1"),
        user_prompt(10, Some("turn-2"), "next"),
        chunk(11, "agent", "reply"),
        prompt_complete(12, "turn-2"),
    ];
    let mut meta = metadata();
    meta.last_seq = 12;
    let payload = materialize_session_payload(&meta, &records);

    let ids: Vec<&str> = payload
        .messages
        .iter()
        .map(|message| message.id.as_str())
        .collect();
    assert_eq!(
        ids,
        vec![
            "turn:turn-1",
            "snapshot:agent:2",
            "snapshot:thought:4",
            // tool_call at seq 5 splits; tool_call_update at 7 does NOT.
            "snapshot:agent:6",
            "turn:turn-2",
            "snapshot:agent:11",
        ]
    );
    let seqs: Vec<u64> = payload.messages.iter().map(|message| message.seq).collect();
    assert_eq!(seqs, vec![1, 2, 4, 6, 10, 11]);
    let timestamps: Vec<u64> = payload
        .messages
        .iter()
        .map(|message| message.timestamp)
        .collect();
    assert_eq!(timestamps, vec![101, 102, 104, 106, 110, 111]);
    // Text coalescing within a run (appendBlocks semantics).
    assert_eq!(
        payload.messages[1].blocks,
        vec![json!({"type":"text","text":"Hello "})]
    );
    assert_eq!(
        payload.messages[3].blocks,
        vec![json!({"type":"text","text":"world!"})]
    );
    assert_eq!(payload.messages[1].role, "agent");
    assert_eq!(payload.messages[2].role, "thought");
    assert!(payload.messages.iter().all(|message| !message.streaming));
    assert_eq!(payload.metadata.message_count, 6);
    assert_eq!(payload.metadata.last_seq, 12);
}

#[test]
fn metadata_maps_agent_config_prefix_and_fallbacks() {
    let meta = metadata();
    let payload = materialize_session_payload(&meta, &[]);
    assert_eq!(
        serde_json::to_value(&payload.metadata).unwrap(),
        json!({
            "id": "session-1",
            "agentId": "runtime-1",
            "agentConfigId": "claude",
            "title": "Chat title",
            "cwd": "/work/project",
            "projectId": "project-1",
            "createdAt": 100,
            "lastActivityAt": 900,
            "messageCount": 0,
            "lastSeq": 0,
            "status": "active",
            "worktreePath": "/work/project/.termul/worktrees/chat/abc123",
            "worktreeBranch": "chat/abc123",
        })
    );
}

#[test]
fn metadata_omits_agent_config_id_without_config_prefix() {
    let mut meta = metadata();
    meta.stable_agent_namespace = Some("opaque-namespace".to_string());
    let payload = materialize_session_payload(&meta, &[]);
    let value = serde_json::to_value(&payload.metadata).unwrap();
    assert!(
        value.get("agentConfigId").is_none(),
        "agentConfigId must be omitted, not null: {value}"
    );
}

#[test]
fn metadata_falls_back_for_missing_optional_fields() {
    let mut meta = metadata();
    meta.stable_agent_namespace = None;
    meta.runtime_agent_id = None;
    meta.project_id = None;
    meta.title = None;
    meta.status = PersistedSessionStatus::Error;
    let payload = materialize_session_payload(&meta, &[]);
    assert_eq!(payload.metadata.agent_id, "");
    assert_eq!(payload.metadata.agent_config_id, None);
    assert_eq!(payload.metadata.project_id, "");
    assert_eq!(payload.metadata.title, "Untitled Chat");
    assert_eq!(payload.metadata.status, PersistedSessionStatus::Error);
    let value = serde_json::to_value(&payload).unwrap();
    assert_eq!(value["metadata"]["status"], "error");
}

#[test]
fn user_prompt_without_turn_id_falls_back_to_seq_id() {
    let records = vec![user_prompt(3, None, "no turn id")];
    let payload = materialize_session_payload(&metadata(), &records);
    assert_eq!(payload.messages.len(), 1);
    assert_eq!(payload.messages[0].id, "user:seq-3");
    assert_eq!(payload.messages[0].role, "user");
    assert_eq!(payload.messages[0].seq, 3);
}

#[test]
fn user_prompt_with_empty_turn_id_falls_back_to_seq_id() {
    let records = vec![user_prompt(5, Some(""), "empty turn id")];
    let payload = materialize_session_payload(&metadata(), &records);
    assert_eq!(payload.messages[0].id, "user:seq-5");
}

#[test]
fn user_prompt_strips_handoff_preamble_from_legacy_records() {
    // spec-agent-switch-separator-redesign: pre-fix handoff prompts
    // persisted `summary + --- + draft` as the user bubble; materialize
    // must show only the draft so the wire framing never replays.
    let wire = "# Conversation handoff\n\nYou are taking over a conversation previously handled by OMP.\n\nUser: hi\nAgent: hello\n\n---\n\ncontinue the work";
    let records = vec![user_prompt(7, Some("turn-7"), wire)];
    let payload = materialize_session_payload(&metadata(), &records);
    assert_eq!(payload.messages.len(), 1);
    let msg = &payload.messages[0];
    assert_eq!(msg.role, "user");
    let text = msg.blocks[0]
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("");
    assert_eq!(text, "continue the work");
    assert!(!text.contains("# Conversation handoff"));
}

#[test]
fn user_prompt_folds_summary_only_handoff_to_boundary_row() {
    // A summary-only switch persisted the summary with no draft — the
    // record folds to a boundary row (no blocks, handoff_boundary=true):
    // never renders, but keeps the switch turn's reply visible.
    let summary_only = "# Conversation handoff\n\nYou are taking over a conversation previously handled by OMP.\n\nUser: hi\nAgent: hello";
    let records = vec![user_prompt(8, Some("turn-8"), summary_only)];
    let payload = materialize_session_payload(&metadata(), &records);
    assert_eq!(payload.messages.len(), 1);
    let msg = &payload.messages[0];
    assert_eq!(msg.role, "user");
    assert!(msg.blocks.is_empty());
    assert!(msg.handoff_boundary);
}

#[test]
fn user_prompt_with_handoff_like_text_replays_verbatim() {
    // Exact-prefix gate: text merely BEGINNING with the header line is
    // user-authored, not wire framing — never strip or drop it.
    let records = vec![user_prompt(
        6,
        Some("turn-6"),
        "# Conversation handoff! my notes",
    )];
    let payload = materialize_session_payload(&metadata(), &records);
    let text = payload.messages[0].blocks[0]
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("");
    assert_eq!(text, "# Conversation handoff! my notes");
}

#[test]
fn user_prompt_without_handoff_header_replays_verbatim() {
    // Non-handoff text never touched, even when it contains '---'.
    let records = vec![user_prompt(9, Some("turn-9"), "check this --- divider")];
    let payload = materialize_session_payload(&metadata(), &records);
    let text = payload.messages[0].blocks[0]
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("");
    assert_eq!(text, "check this --- divider");
}

#[test]
fn role_change_splits_chunk_runs() {
    let records = vec![
        chunk(1, "agent", "a"),
        chunk(2, "thought", "t"),
        chunk(3, "agent", "b"),
    ];
    let payload = materialize_session_payload(&metadata(), &records);
    assert_eq!(
        payload
            .messages
            .iter()
            .map(|message| message.id.as_str())
            .collect::<Vec<_>>(),
        vec!["snapshot:agent:1", "snapshot:thought:2", "snapshot:agent:3"]
    );
}

#[test]
fn prompt_complete_splits_consecutive_agent_runs() {
    let records = vec![
        chunk(1, "agent", "first"),
        prompt_complete(2, "turn-1"),
        chunk(3, "agent", "second"),
    ];
    let payload = materialize_session_payload(&metadata(), &records);
    assert_eq!(payload.messages.len(), 2);
    assert_eq!(payload.messages[0].id, "snapshot:agent:1");
    assert_eq!(payload.messages[1].id, "snapshot:agent:3");
}

#[test]
fn tool_call_update_never_splits_the_open_run() {
    let records = vec![
        chunk(1, "agent", "a"),
        tool_call_update(2),
        chunk(3, "agent", "b"),
    ];
    let payload = materialize_session_payload(&metadata(), &records);
    assert_eq!(payload.messages.len(), 1);
    assert_eq!(payload.messages[0].id, "snapshot:agent:1");
    assert_eq!(payload.messages[0].seq, 1);
    assert_eq!(
        payload.messages[0].blocks,
        vec![json!({"type":"text","text":"ab"})]
    );
}

#[test]
fn non_text_blocks_append_without_coalescing() {
    let records = vec![
        record(
            1,
            "message_chunk",
            json!({"role":"agent","content":{"type":"text","text":"a"}}),
        ),
        record(
            2,
            "message_chunk",
            json!({"role":"agent","content":{"type":"resource","resource":{"uri":"file:///x"}}}),
        ),
        record(
            3,
            "message_chunk",
            json!({"role":"agent","content":{"type":"text","text":"b"}}),
        ),
    ];
    let payload = materialize_session_payload(&metadata(), &records);
    assert_eq!(payload.messages.len(), 1);
    assert_eq!(
        payload.messages[0].blocks,
        vec![
            json!({"type":"text","text":"a"}),
            json!({"type":"resource","resource":{"uri":"file:///x"}}),
            json!({"type":"text","text":"b"}),
        ]
    );
}

#[test]
fn chunks_without_content_are_skipped() {
    let records = vec![
        record(1, "message_chunk", json!({"role":"agent"})),
        record(
            2,
            "message_chunk",
            json!({"role":"agent","content":Value::Null}),
        ),
        chunk(3, "agent", "real"),
    ];
    let payload = materialize_session_payload(&metadata(), &records);
    assert_eq!(payload.messages.len(), 1);
    assert_eq!(payload.messages[0].id, "snapshot:agent:3");
}

#[test]
fn empty_text_chunk_never_opens_a_bubble() {
    let records = vec![
        record(
            1,
            "message_chunk",
            json!({"role":"agent","content":{"type":"text","text":""}}),
        ),
        chunk(2, "agent", "content"),
    ];
    let payload = materialize_session_payload(&metadata(), &records);
    assert_eq!(payload.messages.len(), 1);
    assert_eq!(payload.messages[0].id, "snapshot:agent:2");
}

#[test]
fn empty_registered_session_yields_empty_messages() {
    let payload = materialize_session_payload(&metadata(), &[]);
    assert!(payload.messages.is_empty());
    assert_eq!(payload.metadata.id, "session-1");
    assert_eq!(payload.metadata.message_count, 0);
    let value = serde_json::to_value(&payload).unwrap();
    assert_eq!(value["messages"], json!([]));
}

#[test]
fn double_materialization_is_identical() {
    let records = vec![
        user_prompt(1, Some("turn-1"), "hi"),
        chunk(2, "agent", "a"),
        tool_call(3),
        chunk(4, "agent", "b"),
        prompt_complete(5, "turn-1"),
        user_prompt(6, None, "again"),
        chunk(7, "thought", "hmm"),
    ];
    let mut meta = metadata();
    meta.last_seq = 7;
    let first = serde_json::to_value(materialize_session_payload(&meta, &records)).unwrap();
    let second = serde_json::to_value(materialize_session_payload(&meta, &records)).unwrap();
    assert_eq!(first, second, "materialization must be deterministic");
}

#[test]
fn materialized_payload_preserves_worktree_binding() {
    // CAP-4/6: the worktree path + branch must survive materialization
    // so history reopen and post-reload resume reattach to the bound
    // worktree (not the project root) and the indicator can render.
    let payload = materialize_session_payload(&metadata(), &[]);
    assert_eq!(
        payload.metadata.worktree_path.as_deref(),
        Some("/work/project/.termul/worktrees/chat/abc123")
    );
    assert_eq!(
        payload.metadata.worktree_branch.as_deref(),
        Some("chat/abc123")
    );
}

fn agent_switch(seq: u64) -> PersistedEventRecord {
    record(
        seq,
        "agent_switch",
        json!({
            "sessionId": "session-1",
            "fromConfigId": "omp",
            "toConfigId": "claude",
            "newSessionId": "session-2",
            "summaryText": "Handoff summary",
        }),
    )
}

#[test]
fn agent_switch_folds_into_switches_array_with_full_identity() {
    let records = vec![user_prompt(1, Some("turn-1"), "hello"), agent_switch(2)];
    let mut meta = metadata();
    meta.last_seq = 2;
    let payload = materialize_session_payload(&meta, &records);
    // The marker is a sibling of `messages`, never a ChatMessage.
    assert_eq!(payload.messages.len(), 1);
    assert_eq!(payload.switches.len(), 1);
    let switch = &payload.switches[0];
    assert_eq!(switch.id, "switch:seq-2");
    assert_eq!(switch.from_config_id, "omp");
    assert_eq!(switch.to_config_id, "claude");
    assert_eq!(switch.new_session_id, "session-2");
    assert_eq!(switch.summary_text, "Handoff summary");
    assert_eq!(switch.seq, 2);
    assert_eq!(switch.timestamp, 102);
    // The wire shape is camelCase with a stable id key.
    let value = serde_json::to_value(&payload).unwrap();
    assert_eq!(value["switches"][0]["id"], "switch:seq-2");
    assert_eq!(value["switches"][0]["fromConfigId"], "omp");
    assert_eq!(value["switches"][0]["toConfigId"], "claude");
    assert_eq!(value["switches"][0]["newSessionId"], "session-2");
    assert_eq!(value["switches"][0]["summaryText"], "Handoff summary");
    assert_eq!(value["switches"][0]["seq"], 2);
    // Switches are not messages: the count reflects bubbles only.
    assert_eq!(payload.metadata.message_count, 1);
    assert_eq!(payload.metadata.last_seq, 2);
}

#[test]
fn agent_switch_splits_open_chunk_run_into_fresh_bubble() {
    // Chunks 2+3 coalesce; the switch at 4 splits; the next agent's
    // chunk at 5 opens a FRESH bubble (never coalesced into the old
    // agent's run).
    let records = vec![
        user_prompt(1, Some("turn-1"), "hi"),
        chunk(2, "agent", "Hel"),
        chunk(3, "agent", "lo"),
        agent_switch(4),
        chunk(5, "agent", "New agent reply"),
    ];
    let payload = materialize_session_payload(&metadata(), &records);
    let ids: Vec<&str> = payload
        .messages
        .iter()
        .map(|message| message.id.as_str())
        .collect();
    assert_eq!(
        ids,
        vec!["turn:turn-1", "snapshot:agent:2", "snapshot:agent:5"]
    );
    // Coalescing still holds within each run.
    assert_eq!(
        payload.messages[1].blocks,
        vec![json!({"type":"text","text":"Hello"})]
    );
    assert_eq!(payload.messages[2].blocks[0]["text"], "New agent reply");
    assert_eq!(payload.switches.len(), 1);
    assert_eq!(payload.switches[0].seq, 4);
}

#[test]
fn agent_switch_absent_yields_empty_switches() {
    // Pre-feature payloads: no `agent_switch` records → empty array,
    // rendering unchanged.
    let records = vec![
        user_prompt(1, Some("turn-1"), "hello"),
        chunk(2, "agent", "hi"),
    ];
    let payload = materialize_session_payload(&metadata(), &records);
    assert!(payload.switches.is_empty());
    let value = serde_json::to_value(&payload).unwrap();
    assert_eq!(value["switches"], json!([]));
}

#[test]
fn corrupt_agent_switch_record_degrades_never_panics() {
    // Missing `newSessionId` (and missing summary) must degrade to
    // empty strings, not panic or fail the fold.
    let records = vec![record(
        3,
        "agent_switch",
        json!({"sessionId": "session-1", "fromConfigId": "omp", "toConfigId": "claude"}),
    )];
    let payload = materialize_session_payload(&metadata(), &records);
    assert_eq!(payload.switches.len(), 1);
    let switch = &payload.switches[0];
    assert_eq!(switch.new_session_id, "");
    assert_eq!(switch.summary_text, "");
    assert_eq!(switch.from_config_id, "omp");
    assert_eq!(switch.seq, 3);
}

#[test]
fn multiple_switches_stay_in_seq_order() {
    let records = vec![
        agent_switch(2),
        agent_switch(5),
        agent_switch(8),
        user_prompt(9, Some("turn-9"), "after"),
    ];
    let payload = materialize_session_payload(&metadata(), &records);
    let seqs: Vec<u64> = payload.switches.iter().map(|s| s.seq).collect();
    assert_eq!(seqs, vec![2, 5, 8]);
    let ids: Vec<&str> = payload.switches.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(ids, vec!["switch:seq-2", "switch:seq-5", "switch:seq-8"]);
}

#[test]
fn switch_materialization_is_deterministic() {
    let records = vec![
        user_prompt(1, Some("turn-1"), "hi"),
        chunk(2, "agent", "a"),
        agent_switch(3),
        chunk(4, "agent", "b"),
        user_prompt(5, Some("turn-2"), "next"),
    ];
    let mut meta = metadata();
    meta.last_seq = 5;
    let first = serde_json::to_value(materialize_session_payload(&meta, &records)).unwrap();
    let second = serde_json::to_value(materialize_session_payload(&meta, &records)).unwrap();
    assert_eq!(
        first, second,
        "switch materialization must be deterministic"
    );
}
