//! Tool mappers for agents that report each subagent as one plain tool call
//! with no child traffic. Each claims only its own agent's wire form:
//!
//! - Cursor: a `Task: <description>` call whose `rawInput._toolName` is
//!   `"task"`. Its `completed` update carries `rawOutput.durationMs` and
//!   `isBackground`, or `rawOutput.error` on failure. A `cursor/task` request
//!   follows with the subagent's model ([`apply_cursor_task`]).
//! - OpenCode: the `task` tool, kind `think`, `rawInput {description,
//!   prompt, subagent_type}`. Its result carries `rawOutput.metadata
//!   {sessionId, model {providerID, modelID}, background?, jobId?}`.
//! - Gemini CLI: the `invoke_agent` tool, kind `think`, titled
//!   `Delegating to agent '<name>'`, with no `rawInput`. Its content is the
//!   subagent's final report. Only claimed on a Gemini CLI connection.
//!
//! None of these agents can stop one subagent or stream its progress.

use serde_json::{Map, Value};

use super::registry::SubagentRecords;
use super::tools::{apply_tool, MappedToolEvent, ToolEvent, ToolMapper, ToolView};
use super::{
    bounded_id, bounded_text, count, AgentFamily, Subagent, SubagentCaps, SubagentSource,
    SubagentTranscript, MAX_PROMPT_CHARS, MAX_TEXT_CHARS,
};

pub(super) const CURSOR_TASK: ToolMapper = ToolMapper {
    source: SubagentSource::CursorTask,
    claims: claims_cursor,
    apply: apply_cursor,
};

pub(super) const OPENCODE_TASK: ToolMapper = ToolMapper {
    source: SubagentSource::OpencodeTask,
    claims: claims_opencode,
    apply: apply_opencode,
};

pub(super) const GEMINI_AGENT: ToolMapper = ToolMapper {
    source: SubagentSource::GeminiAgent,
    claims: claims_gemini,
    apply: apply_gemini,
};

/// Cursor reports the duration, so the record has usage.
const CURSOR_CAPS: SubagentCaps = SubagentCaps {
    stop: None,
    transcript: SubagentTranscript::Final,
    live_progress: false,
    usage: true,
};

const FINAL_ONLY_CAPS: SubagentCaps = SubagentCaps {
    stop: None,
    transcript: SubagentTranscript::Final,
    live_progress: false,
    usage: false,
};

/// Cursor's subagent type when the model named none.
const CURSOR_UNSPECIFIED_ROLE: &str = "unspecified";
/// Gemini CLI's `invoke_agent` title (`DelegateInvocation.getDescription`).
const GEMINI_DELEGATE_PREFIX: &str = "Delegating to agent '";
const GEMINI_DELEGATE_SUFFIX: char = '\'';

fn claims_cursor(event: &ToolEvent) -> bool {
    event
        .input()
        .and_then(|input| input.get("_toolName"))
        .and_then(Value::as_str)
        == Some("task")
}

fn apply_cursor(
    records: &mut SubagentRecords,
    root: &str,
    event: &ToolEvent,
    now_ms: u64,
) -> MappedToolEvent {
    let source = CURSOR_TASK.source;
    apply_tool(
        records,
        root,
        event,
        now_ms,
        source,
        CURSOR_CAPS,
        absorb_cursor,
    )
}

/// Cursor's `rawOutput`: `{durationMs, isBackground}` or `{error}`, both on
/// a `completed` update.
fn absorb_cursor(view: &mut ToolView, event: &ToolEvent) {
    if view.role.as_deref() == Some(CURSOR_UNSPECIFIED_ROLE) {
        view.role = None;
    }
    let Some(output) = event.raw_output.and_then(Value::as_object) else {
        return;
    };
    absorb_error(view, output);
    if let Some(duration) = output.get("durationMs").and_then(count) {
        view.set_duration(duration);
    }
}

/// Cursor's subagent type: a name, or `{custom: name}`.
fn cursor_role(value: Option<&Value>) -> Option<&str> {
    let value = value?;
    let role = bounded_text(Some(value), MAX_TEXT_CHARS)
        .or_else(|| bounded_text(value.get("custom"), MAX_TEXT_CHARS))?;
    (role != CURSOR_UNSPECIFIED_ROLE).then_some(role)
}

/// Apply Cursor's `cursor/task` request, which follows a task's `completed`
/// update: `{toolCallId, description, prompt, subagentType, model?,
/// agentId?, durationMs?}`, with no session id. Returns the record when it
/// changed.
pub(crate) fn apply_cursor_task(
    records: &mut SubagentRecords,
    params: &Value,
    now_ms: u64,
) -> Option<Subagent> {
    let Some(call) = bounded_id(params.get("toolCallId")) else {
        log::warn!("[acp] cursor/task without a usable toolCallId; ignored");
        return None;
    };
    let redacted = crate::logging::redact_session_id(call);
    let Some(root) = records.root_of(call).map(str::to_string) else {
        log::info!("[acp] cursor/task for untracked tool call {redacted}; ignored");
        return None;
    };
    let source = records.get(&root, call).map(|tracked| tracked.source());
    if source != Some(SubagentSource::CursorTask) {
        log::warn!(
            "[acp] cursor/task for tool call {redacted}, which is not a Cursor task; ignored"
        );
        return None;
    }
    if let Some(agent) = bounded_id(params.get("agentId")) {
        log::info!(
            "[acp] Cursor task {redacted} ran as agent {}",
            crate::logging::redact_session_id(agent)
        );
    }
    records.update_dispatch(&root, call, |entry| {
        let view = &mut entry.view;
        if let Some(model) = bounded_text(params.get("model"), MAX_TEXT_CHARS) {
            view.model = Some(model.to_string());
        }
        if let Some(duration) = params.get("durationMs").and_then(count) {
            view.set_duration(duration);
        }
        if let Some(role) = cursor_role(params.get("subagentType")) {
            view.role = Some(role.to_string());
        }
        view.fill(&mut entry.record, now_ms);
    })
}

fn claims_opencode(event: &ToolEvent) -> bool {
    event.kind == Some("think")
        && event.input().is_some_and(|input| {
            bounded_text(input.get("subagent_type"), MAX_TEXT_CHARS).is_some()
                && bounded_text(input.get("prompt"), MAX_PROMPT_CHARS).is_some()
        })
}

fn apply_opencode(
    records: &mut SubagentRecords,
    root: &str,
    event: &ToolEvent,
    now_ms: u64,
) -> MappedToolEvent {
    let source = OPENCODE_TASK.source;
    apply_tool(
        records,
        root,
        event,
        now_ms,
        source,
        FINAL_ONLY_CAPS,
        absorb_opencode,
    )
}

/// OpenCode's `rawOutput`: `{output, metadata}` when completed, `{error,
/// metadata}` when failed. A background launch completes at launch with
/// `metadata.background`.
fn absorb_opencode(view: &mut ToolView, event: &ToolEvent) {
    let Some(output) = event.raw_output.and_then(Value::as_object) else {
        return;
    };
    absorb_error(view, output);
    let Some(metadata) = output.get("metadata").and_then(Value::as_object) else {
        return;
    };
    view.background |= metadata.get("background") == Some(&Value::Bool(true));
    let model = metadata.get("model");
    let model = bounded_text(model, MAX_TEXT_CHARS)
        .or_else(|| bounded_text(model.and_then(|model| model.get("modelID")), MAX_TEXT_CHARS));
    if let Some(model) = model {
        view.model = Some(model.to_string());
    }
}

fn absorb_error(view: &mut ToolView, output: &Map<String, Value>) {
    if let Some(error) = bounded_text(output.get("error"), MAX_TEXT_CHARS) {
        view.error = Some(error.to_string());
    }
}

/// The subagent name in a Gemini CLI `invoke_agent` title.
fn gemini_agent_name(title: Option<&str>) -> Option<&str> {
    let name = title?
        .strip_prefix(GEMINI_DELEGATE_PREFIX)?
        .strip_suffix(GEMINI_DELEGATE_SUFFIX)?;
    let valid = !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'));
    valid.then_some(name)
}

fn claims_gemini(event: &ToolEvent) -> bool {
    if event.kind != Some("think") || gemini_agent_name(event.title).is_none() {
        return false;
    }
    if event.agent != AgentFamily::GeminiCli {
        log::info!(
            "[acp] tool call {} looks like a Gemini CLI subagent, but the agent is not Gemini CLI; not a subagent",
            crate::logging::redact_session_id(event.id)
        );
        return false;
    }
    true
}

fn apply_gemini(
    records: &mut SubagentRecords,
    root: &str,
    event: &ToolEvent,
    now_ms: u64,
) -> MappedToolEvent {
    let source = GEMINI_AGENT.source;
    apply_tool(
        records,
        root,
        event,
        now_ms,
        source,
        FINAL_ONLY_CAPS,
        absorb_gemini,
    )
}

/// The title names the subagent; it is the only field Gemini CLI sends.
fn absorb_gemini(view: &mut ToolView, event: &ToolEvent) {
    if let Some(name) = gemini_agent_name(event.title) {
        view.input_title = Some(name.to_string());
        view.role = Some(name.to_string());
    }
}

#[cfg(test)]
#[path = "agent_tools_tests.rs"]
mod agent_tools_tests;
