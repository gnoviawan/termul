//! Renderer-shaped session payload materializer for standalone durable history.
//!
//! The standalone `termul-server` persists ACP session events as JSONL records
//! (`SessionPersistence`). `get_session_payload` must reply with the exact
//! `SessionPayload { metadata, messages }` shape the renderer's
//! `loadSessionPayload` consumes (the same shape the desktop
//! `ChatHistoryStore` serves). This module is the PURE fold of durable
//! records into that shape — transport-neutral, no I/O, no clock reads: the
//! output is a deterministic function of the records + metadata so repeated
//! reads produce identical ids, seqs, ordering, and shape (the renderer uses
//! message ids as dedup/merge keys).
//!
//! # Fold semantics (mirror the renderer's live bubbles)
//!
//! - `user_prompt` → a `user` bubble with id `turn:<turnId>` (fallback
//!   `user:seq-<seq>` when the record carries no turn id).
//! - `message_chunk` runs fold into `agent` / `thought` bubbles with id
//!   `snapshot:<role>:<firstSeq>` — the same dialect as the renderer's
//!   `installTransportRecovery`. A run splits on role change, `tool_call`, or
//!   `prompt_complete`; `tool_call_update` NEVER splits (updates preserve the
//!   original card seq). Consecutive text content coalesces into the trailing
//!   text block (`appendBlocks` semantics).
//! - Message `seq` = the run's first record seq; `timestamp` = the run's
//!   first `recorded_at`; `streaming` is always `false` (restored transcripts
//!   never shimmer).
//! - Tool cards are intentionally NOT materialized: desktop history payloads
//!   also persist only `ChatMessage[]` (`toolCalls` is a live-only store
//!   slice), and the durable tool DTO whitelist stays untouched.

use serde::Serialize;
use serde_json::Value;

use crate::acp::session_persistence::{
    PersistedEventRecord, PersistedSessionStatus, SessionMetadata,
};

/// The renderer session-metadata shape (`SessionIndexEntry` in
/// `acp-history-persistence.ts`). camelCase keys; `agentConfigId` is omitted
/// when absent (never `null`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionPayloadMetadata {
    pub id: String,
    pub agent_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_config_id: Option<String>,
    pub title: String,
    pub cwd: String,
    pub project_id: String,
    pub created_at: u64,
    pub last_activity_at: u64,
    pub message_count: u64,
    pub last_seq: u64,
    pub status: PersistedSessionStatus,
    /// Worktree the chat runs in (CAP-4/6). Carried through the materialized
    /// payload so history reopen + post-reload resume preserve the worktree
    /// binding the agent reattaches to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_branch: Option<String>,
}

/// The renderer `ChatMessage` shape. camelCase keys; `seq` always present
/// (standalone history is seq-native — there is no pre-seq legacy).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaterializedChatMessage {
    pub id: String,
    pub role: &'static str,
    pub blocks: Vec<Value>,
    pub streaming: bool,
    pub timestamp: u64,
    pub seq: u64,
}

/// The renderer `SessionPayload` shape served by `get_session_payload`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaterializedSessionPayload {
    pub metadata: SessionPayloadMetadata,
    pub messages: Vec<MaterializedChatMessage>,
}

/// Materialize the renderer-shaped payload for one session from its durable
/// metadata + seq-sorted records. Pure: identical input → identical output.
#[must_use]
pub fn materialize_session_payload(
    metadata: &SessionMetadata,
    records: &[PersistedEventRecord],
) -> MaterializedSessionPayload {
    let messages = fold_messages(records);
    let payload_metadata = SessionPayloadMetadata {
        id: metadata.session_id.clone(),
        agent_id: metadata.runtime_agent_id.clone().unwrap_or_default(),
        // The renderer maps `config:<id>` namespaces back to the bare config
        // id; anything else (absent or unprefixed) omits the key.
        agent_config_id: metadata
            .stable_agent_namespace
            .as_deref()
            .and_then(|namespace| namespace.strip_prefix("config:"))
            .map(str::to_string),
        title: metadata
            .title
            .clone()
            .unwrap_or_else(|| "Untitled Chat".to_string()),
        cwd: metadata.cwd.clone(),
        project_id: metadata.project_id.clone().unwrap_or_default(),
        created_at: metadata.created_at,
        last_activity_at: metadata.last_activity_at,
        message_count: messages.len() as u64,
        // Derive the cursor from the replayed records themselves (not the
        // separately-read metadata) so the payload can never advertise a
        // `lastSeq` that disagrees with the messages it carries when a writer
        // lands an event between the metadata read and the replay.
        last_seq: records
            .last()
            .map_or(metadata.last_seq, |record| record.seq),
        status: metadata.status.clone(),
        worktree_path: metadata.worktree_path.clone(),
        worktree_branch: metadata.worktree_branch.clone(),
    };
    MaterializedSessionPayload {
        metadata: payload_metadata,
        messages,
    }
}

/// Fold seq-sorted durable records into renderer bubbles.
pub(crate) fn fold_messages(records: &[PersistedEventRecord]) -> Vec<MaterializedChatMessage> {
    let mut messages: Vec<MaterializedChatMessage> = Vec::new();
    // Role of the agent/thought run still open for coalescing (`None` after a
    // user bubble, a split, or before the first chunk).
    let mut open_role: Option<&'static str> = None;

    for record in records {
        match record.type_.as_str() {
            "user_prompt" => {
                open_role = None;
                let turn_id = record
                    .payload
                    .get("turnId")
                    .and_then(Value::as_str)
                    .filter(|turn_id| !turn_id.is_empty());
                let id = turn_id.map_or_else(
                    || format!("user:seq-{}", record.seq),
                    |turn_id| format!("turn:{turn_id}"),
                );
                let blocks = record
                    .payload
                    .get("content")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                messages.push(MaterializedChatMessage {
                    id,
                    role: "user",
                    blocks,
                    streaming: false,
                    timestamp: record.recorded_at,
                    seq: record.seq,
                });
            }
            "message_chunk" => {
                let role = if record.payload.get("role").and_then(Value::as_str) == Some("thought")
                {
                    "thought"
                } else {
                    "agent"
                };
                let Some(content) = record
                    .payload
                    .get("content")
                    .filter(|content| !content.is_null())
                else {
                    // Mirrors the renderer's `if (!content) continue`.
                    continue;
                };
                if open_role == Some(role) {
                    // Same run still open: coalesce into the trailing bubble
                    // (`appendBlocks` semantics).
                    if let Some(last) = messages.last_mut() {
                        append_block(&mut last.blocks, content.clone());
                    }
                    continue;
                }
                if is_empty_text_block(content) {
                    // Mirrors the renderer: an empty text chunk may never OPEN
                    // a bubble (avoids restoring a flashing empty message).
                    continue;
                }
                open_role = Some(role);
                messages.push(MaterializedChatMessage {
                    id: format!("snapshot:{role}:{}", record.seq),
                    role,
                    blocks: vec![content.clone()],
                    streaming: false,
                    timestamp: record.recorded_at,
                    seq: record.seq,
                });
            }
            // Split boundaries: a tool card or a completed turn forces the
            // following chunk run into a fresh bubble.
            "tool_call" | "prompt_complete" => {
                open_role = None;
            }
            // `tool_call_update` never splits (updates preserve the original
            // card seq); every other durable event (session_info_update,
            // mode/plan/commands updates, …) carries no transcript content.
            _ => {}
        }
    }
    messages
}

/// `appendBlocks` semantics: text coalesces into a trailing text block; every
/// other block appends.
fn append_block(blocks: &mut Vec<Value>, incoming: Value) {
    if is_text_block(&incoming) {
        if let Some(last) = blocks.last_mut() {
            if is_text_block(last) {
                let merged = format!("{}{}", block_text(last), block_text(&incoming));
                if let Some(object) = last.as_object_mut() {
                    object.insert("text".to_string(), Value::String(merged));
                    return;
                }
            }
        }
    }
    blocks.push(incoming);
}

fn is_text_block(block: &Value) -> bool {
    block.get("type").and_then(Value::as_str) == Some("text")
}

fn block_text(block: &Value) -> &str {
    block.get("text").and_then(Value::as_str).unwrap_or("")
}

/// True for a text block whose text is absent or empty (the renderer ignores
/// such a chunk when it would open a new bubble).
fn is_empty_text_block(block: &Value) -> bool {
    is_text_block(block) && block_text(block).is_empty()
}

#[cfg(test)]
mod tests {
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
}
