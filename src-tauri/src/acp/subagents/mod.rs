//! The canonical subagent record, and the mappers that build it from each
//! agent's wire form. Mirrors `src/shared/types/subagent.ts`; keep the two in
//! step.
//!
//! The record rides the subagent's dispatch tool call as
//! `_meta["termul/subagent"]`, on live events and in the durable tool-call
//! log, so live, reopened, desktop and web chats read one record. The host
//! sends the full record whenever it changes.
//!
//! - [`registry`] keeps the records per chat on the connection's driver state.
//! - [`native`] maps ACP subagent sessions (RFD and AIR forms); the driver's
//!   router (`manager/native_subagents.rs`) owns the child session routes.
//! - [`tools`] maps the dispatch tool calls of agents without subagent
//!   sessions, through the ordered [`tools::TOOL_MAPPERS`] chain: Codex
//!   collab, Claude meta, the Cursor, OpenCode and Gemini CLI mappers in
//!   [`agent_tools`], then a conservative heuristic.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

mod agent_tools;
mod codex_collab;
pub(crate) mod native;
mod registry;
mod tools;

pub(crate) use agent_tools::apply_cursor_task;
pub(crate) use registry::{DispatchEntry, SubagentRecords};
pub(crate) use tools::{map_tool_event, MappedToolEvent, ToolView};

/// Longest id (session, tool call, thread) the host keeps.
pub(crate) const MAX_ID_CHARS: usize = 512;
/// Longest title, description, role, model, file path or error kept.
pub(crate) const MAX_TEXT_CHARS: usize = 512;
/// Longest prompt kept.
pub(crate) const MAX_PROMPT_CHARS: usize = 8_000;

/// `_meta` key on a dispatch tool call that carries its [`Subagent`].
pub(crate) const SUBAGENT_META_KEY: &str = "termul/subagent";
/// `_meta` key on a call that steers existing subagents ([`SubagentControl`]).
pub(crate) const SUBAGENT_CONTROL_META_KEY: &str = "termul/subagentControl";

/// The agent on a connection, for mappers whose wire form alone is too
/// generic to claim a call. Read from `initialize` `agentInfo.name`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum AgentFamily {
    #[default]
    Other,
    GeminiCli,
}

impl AgentFamily {
    pub(crate) fn from_agent_name(name: Option<&str>) -> Self {
        match name {
            Some("gemini-cli") => Self::GeminiCli,
            _ => Self::Other,
        }
    }
}

/// Which mapper produced the record.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum SubagentSource {
    AcpRfd,
    AcpAir,
    ClaudeMeta,
    CodexCollab,
    CursorTask,
    OpencodeTask,
    GeminiAgent,
    ToolHeuristic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SubagentEndReason {
    Completed,
    Cancelled,
    Failed,
    Unexplained,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct SubagentEnd {
    pub reason: SubagentEndReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Current work state (ACP RFD semantics). `Idle` ends the current work and
/// is the only state with an end; an idle child may run again. `Unknown`
/// means the agent cannot observe the child: neither an end nor a failure.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "activity", rename_all = "snake_case")]
pub(crate) enum SubagentState {
    Running,
    RequiresAction,
    Idle { end: SubagentEnd },
    Unknown,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubagentUsage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_uses: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum SubagentStop {
    /// `session/cancel` with the child session id (RFD `capabilities.cancel`).
    SessionCancel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SubagentTranscript {
    /// The subagent's own tool calls and text stream in under its dispatch.
    Live,
    /// Only its result arrives.
    Final,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubagentCaps {
    pub stop: Option<SubagentStop>,
    pub transcript: SubagentTranscript,
    /// The source reports state changes as they happen, so `Running` holds
    /// across turns. When false, the state only mirrors the dispatch tool
    /// call, whose completion a cancelled turn can lose.
    pub live_progress: bool,
    pub usage: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Subagent {
    /// Child session id, or the dispatch tool call id when the subagent has
    /// no session of its own. Never changes for one subagent.
    pub id: String,
    /// The chat session the subagent belongs to.
    pub root_session_id: String,
    /// The subagent that spawned this one (nested subagents).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    /// The tool call that represents the subagent in the chat.
    pub dispatch_tool_call_id: String,
    pub source: SubagentSource,
    pub title: String,
    /// Role or purpose, when the agent states one apart from the title.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Agent type (`subagent_type`), when the agent names one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    /// The task the parent gave the subagent (bounded).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    /// The dispatch returned at launch; the subagent continues after it.
    pub background: bool,
    #[serde(flatten)]
    pub state: SubagentState,
    /// Host clock (epoch ms) when the host first saw the subagent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    /// Host clock (epoch ms) when the current work ended.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<SubagentUsage>,
    /// File that receives a background subagent's output.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_file: Option<String>,
    pub caps: SubagentCaps,
}

/// A call that steers existing subagents instead of starting one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubagentControl {
    pub subagent_ids: Vec<String>,
}

impl SubagentState {
    pub(crate) fn is_idle(&self) -> bool {
        matches!(self, Self::Idle { .. })
    }

    /// The child is working: its foreground work has not ended.
    pub(crate) fn is_working(&self) -> bool {
        matches!(self, Self::Running | Self::RequiresAction)
    }

    pub(crate) fn idle(reason: SubagentEndReason) -> Self {
        Self::Idle {
            end: SubagentEnd {
                reason,
                error: None,
            },
        }
    }
}

impl Subagent {
    /// Move to `next`. Entering idle stamps `ended_at`; idle to idle keeps the
    /// first stamp, so a repeated end report changes nothing; any other state
    /// clears it.
    pub(crate) fn set_state(&mut self, next: SubagentState, now_ms: u64) {
        if !next.is_idle() {
            self.ended_at = None;
        } else if !self.state.is_idle() || self.ended_at.is_none() {
            self.ended_at = Some(now_ms);
        }
        self.state = next;
    }

    /// The record as its `_meta` value.
    pub(crate) fn meta_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

/// Remove the host's own `_meta` keys from an agent-sent update: only the
/// host may write a subagent record or control marker. True when one was
/// present.
pub(crate) fn strip_spoofed_meta(update: &mut Value) -> bool {
    let Some(meta) = update.get_mut("_meta").and_then(Value::as_object_mut) else {
        return false;
    };
    let record = meta.remove(SUBAGENT_META_KEY).is_some();
    let control = meta.remove(SUBAGENT_CONTROL_META_KEY).is_some();
    record || control
}

/// True when an agent-sent update carries one of the host's `_meta` keys.
pub(crate) fn has_spoofed_meta(update: &Map<String, Value>) -> bool {
    update
        .get("_meta")
        .and_then(Value::as_object)
        .is_some_and(|meta| {
            meta.contains_key(SUBAGENT_META_KEY) || meta.contains_key(SUBAGENT_CONTROL_META_KEY)
        })
}

/// A non-empty id no longer than [`MAX_ID_CHARS`].
pub(crate) fn bounded_id(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= MAX_ID_CHARS)
}

/// Trimmed non-blank text, cut to `max` characters.
pub(crate) fn bounded_text(value: Option<&Value>, max: usize) -> Option<&str> {
    let text = value.and_then(Value::as_str)?.trim();
    if text.is_empty() {
        return None;
    }
    let end = text
        .char_indices()
        .nth(max)
        .map_or(text.len(), |(index, _)| index);
    Some(&text[..end])
}

/// A finite non-negative count. `None` for anything else.
pub(crate) fn count(value: &Value) -> Option<u64> {
    if let Some(count) = value.as_u64() {
        return Some(count);
    }
    let float = value.as_f64()?;
    // Saturating cast: a huge finite float becomes u64::MAX.
    (float.is_finite() && float >= 0.0).then_some(float as u64)
}

/// Log the start, background launch, and end of a subagent. Ids are
/// redacted; prompts and content are never logged.
pub(crate) fn log_transition(before: Option<&Subagent>, after: &Subagent) {
    let id = crate::logging::redact_session_id(&after.id);
    let root = crate::logging::redact_session_id(&after.root_session_id);
    let source = serde_json::to_value(after.source).unwrap_or(Value::Null);
    let source = source.as_str().unwrap_or("unknown");
    if before.is_none() {
        log::info!("[acp] subagent {id} ({source}) started in chat {root}");
    }
    if after.background && !before.is_some_and(|before| before.background) {
        log::info!("[acp] subagent {id} ({source}) runs in the background");
    }
    if before.is_some_and(|before| before.state == after.state) {
        return;
    }
    match &after.state {
        SubagentState::Idle { end } => {
            let reason = serde_json::to_value(end.reason).unwrap_or(Value::Null);
            log::info!(
                "[acp] subagent {id} ({source}) ended: {}",
                reason.as_str().unwrap_or("unknown")
            );
        }
        SubagentState::Unknown => {
            log::info!("[acp] subagent {id} ({source}) can no longer be observed");
        }
        SubagentState::Running if before.is_some_and(|before| before.state.is_idle()) => {
            log::info!("[acp] subagent {id} ({source}) runs again");
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests;
