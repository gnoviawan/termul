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
    last_unmatched_user_prompt, PersistedEventRecord, PersistedSessionStatus, SessionMetadata,
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
    /// Issue #838: true while a prompt turn is in progress — the LAST
    /// `user_prompt` still unmatched by `prompt_complete` (later prompts
    /// supersede earlier ones) and the session status is `active`.
    /// Serialized additively (absent when false) so older clients ignore it.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub turn_active: bool,
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
    /// spec-agent-switch-separator-redesign: a summary-only handoff
    /// `user_prompt` (the record IS the wire preamble — no draft) folds to a
    /// boundary row: it never renders (no visible content) but its turn is
    /// real — the partition keeps the agent reply that follows visible
    /// instead of treating it like a synthetic greeting turn.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub handoff_boundary: bool,
}

/// One materialized agent-switch marker (CAP-2): rendered by the timeline as
/// a borderless `(from icon) → (to icon)` separator with a collapsible
/// handoff summary — never a `ChatMessage`. camelCase keys mirroring
/// `MaterializedChatMessage`'s discipline: `seq` + `timestamp` come from the
/// record envelope. `new_session_id` degrades to an empty string on a corrupt
/// record (never fails the fold).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MaterializedAgentSwitch {
    /// Stable renderer key: `switch:seq-<seq>` (virtualizer key + remount-
    /// sensitive collapse state — the ThoughtGroup stable-key lesson).
    pub id: String,
    pub from_config_id: String,
    pub to_config_id: String,
    pub new_session_id: String,
    pub summary_text: String,
    pub timestamp: u64,
    pub seq: u64,
}

/// The renderer `SessionPayload` shape served by `get_session_payload`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaterializedSessionPayload {
    pub metadata: SessionPayloadMetadata,
    pub messages: Vec<MaterializedChatMessage>,
    /// Durable agent-switch markers (CAP-2), in seq order. Sibling of
    /// `messages` — never folded into it. Always serialized (as `[]` when
    /// absent) so both transports carry a byte-identical shape; pre-feature
    /// payloads simply materialize an empty array.
    pub switches: Vec<MaterializedAgentSwitch>,
}

/// Materialize the renderer-shaped payload for one session from its durable
/// metadata + seq-sorted records. Pure: identical input → identical output.
#[must_use]
pub fn materialize_session_payload(
    metadata: &SessionMetadata,
    records: &[PersistedEventRecord],
) -> MaterializedSessionPayload {
    let (messages, switches) = fold_session_records(records);
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
        // Issue #838: "turn in progress" = the LAST `user_prompt` is still
        // unmatched (see `open_turn_from_records`), derived from the same
        // records the fold used so the payload never disagrees with the
        // messages it carries — and only while the session is `Active`: a
        // `Closed`/`Error` session cannot have a live turn (user-close
        // persists no terminal record, so the prompt stays unmatched but
        // the turn is dead — reporting it active would be self-inconsistent).
        turn_active: metadata.status == PersistedSessionStatus::Active
            && open_turn_from_records(records).is_some(),
        worktree_path: metadata.worktree_path.clone(),
        worktree_branch: metadata.worktree_branch.clone(),
    };
    MaterializedSessionPayload {
        metadata: payload_metadata,
        messages,
        switches,
    }
}

/// Issue #838: the open turn id — the turn-id of the LAST `user_prompt`
/// when it has no matching `prompt_complete` before the log ends. `None`
/// when the last prompt completed (or no prompt exists). Only the last
/// prompt can be open: an earlier unmatched `user_prompt` was superseded —
/// a newer prompt was durably accepted — or abandoned by an `agent_switch`,
/// so it can never emit `prompt_complete` again and must not hold
/// `turn_active`. A trailing `user_prompt` without a usable turn id is open
/// but unnameable: `Some(None)` from the shared scan maps to `None` here
/// (the client derives those from the transcript tail).
///
/// Delegates to `last_unmatched_user_prompt` — the same sequential scan the
/// shutdown `interrupted` marker uses — so payload liveness and the marker
/// predicate can never disagree about which turn is still open.
fn open_turn_from_records(records: &[PersistedEventRecord]) -> Option<String> {
    let pending = last_unmatched_user_prompt(records)?;
    pending
        .and_then(Value::as_str)
        .filter(|turn_id| !turn_id.is_empty())
        .map(str::to_string)
}

/// Outcome of stripping a handoff preamble from a `user_prompt` text block
/// (spec-agent-switch-separator-redesign). Shared by the materialize fold and
/// `derive_title` so both consumers apply the exact same wire framing rule.
pub(crate) enum HandoffText {
    /// Keep the block, but its text is replaced by the extracted draft.
    Draft(String),
    /// The block IS the summary — drop the block (row drops if nothing else).
    Dropped,
}

/// Strip a `# Conversation handoff\n\n…\n\n---\n\n<draft>` wire preamble.
/// `None` for non-handoff text. Requires the producer's exact `header +
/// "\n\n"` prefix so user-authored text merely beginning with the header
/// line is left untouched.
pub(crate) fn strip_handoff_display_text(text: &str) -> Option<HandoffText> {
    let body = text.strip_prefix("# Conversation handoff\n\n")?;
    Some(match body.split_once("\n\n---\n\n") {
        Some((_, draft)) => {
            let draft = draft.trim();
            if draft.is_empty() {
                HandoffText::Dropped
            } else {
                HandoffText::Draft(draft.to_string())
            }
        }
        // Handoff framing without the draft separator → the whole block is
        // the summary (a summary-only switch prompt).
        None => HandoffText::Dropped,
    })
}

/// Fold seq-sorted durable records into renderer bubbles + switch markers
/// (CAP-2). The message fold is unchanged from the pre-switch semantics; the
/// `agent_switch` arm additionally collects the marker into the sibling
/// `switches` array and splits any open `message_chunk` run so the new
/// agent's first chunk opens a fresh bubble.
pub(crate) fn fold_session_records(
    records: &[PersistedEventRecord],
) -> (Vec<MaterializedChatMessage>, Vec<MaterializedAgentSwitch>) {
    let mut messages: Vec<MaterializedChatMessage> = Vec::new();
    let mut switches: Vec<MaterializedAgentSwitch> = Vec::new();
    let mut open_role: Option<&'static str> = None;

    for record in records {
        match record.type_.as_str() {
            "agent_switch" => {
                // Split boundary: the new agent's first chunk opens a fresh
                // bubble (never coalesced into the old agent's run). The
                // marker itself is NOT a message.
                open_role = None;
                let payload_str = |key: &str| {
                    record
                        .payload
                        .get(key)
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string()
                };
                switches.push(MaterializedAgentSwitch {
                    id: format!("switch:seq-{}", record.seq),
                    from_config_id: payload_str("fromConfigId"),
                    to_config_id: payload_str("toConfigId"),
                    // Corrupt-record degradation: missing `newSessionId`
                    // degrades to empty — never panics; CAP-7 resolution
                    // (story 3) treats missing as unresolved.
                    new_session_id: payload_str("newSessionId"),
                    summary_text: payload_str("summaryText"),
                    timestamp: record.recorded_at,
                    seq: record.seq,
                });
            }
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
                let mut blocks = record
                    .payload
                    .get("content")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                // spec-agent-switch-separator-redesign: pre-fix handoff
                // prompts persisted the wire framing (`summary --- draft`)
                // as the user bubble — strip the preamble on materialize so
                // legacy records replay the draft only. Only the FIRST block
                // of a `user_prompt` can carry it (summary-only prompts have
                // no draft: the row folds away unless attachments follow).
                // Gate on the producer's exact `header + "\n\n"` prefix — a
                // bare `starts_with` would mangle user-authored text that
                // merely begins with the header line.
                // Copy the first block's text out before mutating — the
                // immutable borrow for the check cannot overlap the `as_object_mut`.
                let first_text = blocks
                    .first()
                    .filter(|b| {
                        b.get("type")
                            .and_then(Value::as_str)
                            .is_none_or(|t| t == "text")
                    })
                    .and_then(|b| b.get("text"))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                match first_text
                    .as_deref()
                    .and_then(strip_handoff_display_text)
                {
                    Some(HandoffText::Draft(draft)) => {
                        if let Some(obj) = blocks[0].as_object_mut() {
                            obj.insert("text".to_string(), Value::from(draft));
                        }
                    }
                    Some(HandoffText::Dropped) => {
                        // The first block IS the summary — drop it; keep any
                        // trailing attachment blocks.
                        if !blocks.is_empty() {
                            blocks.remove(0);
                        }
                        if blocks.is_empty() {
                            // Summary-only handoff: emit a boundary row — it
                            // renders nothing but keeps the turn's reply
                            // visible (a switch turn is real, not a hidden
                            // synthetic greeting turn).
                            messages.push(MaterializedChatMessage {
                                id,
                                role: "user",
                                blocks: Vec::new(),
                                streaming: false,
                                timestamp: record.recorded_at,
                                seq: record.seq,
                                handoff_boundary: true,
                            });
                            continue;
                        }
                    }
                    None => {}
                }
                messages.push(MaterializedChatMessage {
                    id,
                    role: "user",
                    blocks,
                    streaming: false,
                    timestamp: record.recorded_at,
                    seq: record.seq,
                    handoff_boundary: false,
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
                    handoff_boundary: false,
                });
            }
            // Split boundaries: a tool card or a completed turn forces the
            // following chunk run into a fresh bubble. Issue #842: a
            // synthetic `interrupted` marker is NOT a split — the marker
            // only terminates the *turn*, and any chunk that follows (a
            // resumed/restarted stream) continues the same bubble, so the
            // fold and the incremental `fold_step` stay in agreement.
            "tool_call" | "prompt_complete" if !is_interrupted_marker(record) => {
                open_role = None;
            }
            // `tool_call_update` never splits (updates preserve the original
            // card seq); every other durable event (session_info_update,
            // mode/plan/commands updates, …) carries no transcript content.
            _ => {}
        }
    }
    (messages, switches)
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

/// Issue #842: a synthetic `prompt_complete` with `stopReason: "interrupted"`
/// written at server shutdown. It terminates the turn but must not split an
/// open chunk run (see `fold_session_records`).
pub(crate) fn is_interrupted_marker(record: &PersistedEventRecord) -> bool {
    record.type_ == "prompt_complete"
        && record.payload.get("stopReason").and_then(Value::as_str) == Some("interrupted")
}

#[cfg(test)]
mod tests;
