//! Tool mappers: subagents that agents report as a dispatch tool call
//! (`tool_call` / `tool_call_update` on the chat session) instead of an ACP
//! subagent session.

use serde_json::{Map, Value};

use super::registry::{DispatchEntry, SubagentRecords};
use super::{
    bounded_id, bounded_text, codex_collab, count, Subagent, SubagentCaps, SubagentControl,
    SubagentEndReason, SubagentSource, SubagentState, SubagentTranscript, SubagentUsage,
    MAX_PROMPT_CHARS, MAX_TEXT_CHARS, SUBAGENT_META_KEY,
};

/// `rawInput` keys that name a subagent, in title order.
const TASK_NAME_KEYS: [&str; 4] = ["description", "task", "name", "title"];
const ROLE_KEYS: [&str; 2] = ["subagent_type", "subagentType"];
/// `rawInput` flags of a dispatch that asks for a background launch.
const BACKGROUND_INPUT_KEYS: [&str; 3] = ["run_in_background", "is_background", "background"];
/// Claude `toolResponse.status` values of a background launch receipt.
const BACKGROUND_LAUNCH_STATUSES: [&str; 2] = ["async_launched", "remote_launched"];
/// Claude `toolResponse` usage fields, and the record field each fills.
const CLAUDE_USAGE_FIELDS: [&str; 3] = ["totalTokens", "totalDurationMs", "totalToolUseCount"];

/// The tool mappers, in the order they are asked about a call the host has
/// not classified yet. The first whose `claims` accepts the call owns it for
/// the rest of its events. To support another agent's dispatch form, add its
/// mapper before [`TOOL_HEURISTIC`], which must stay last.
pub(crate) const TOOL_MAPPERS: &[ToolMapper] = &[codex_collab::MAPPER, CLAUDE_META, TOOL_HEURISTIC];

/// One way to read subagents from tool calls.
pub(crate) struct ToolMapper {
    /// The source of the records it builds; later events of a call go to the
    /// mapper with the call's source.
    pub source: SubagentSource,
    /// True when the event shows this mapper's signal (unclassified calls).
    pub claims: fn(&ToolEvent) -> bool,
    /// Apply one event of a call this mapper owns.
    pub apply: fn(&mut SubagentRecords, &str, &ToolEvent, u64) -> MappedToolEvent,
}

/// Claude Agent ACP `Agent`/`Task` calls (`_meta.claudeCode`).
const CLAUDE_META: ToolMapper = ToolMapper {
    source: SubagentSource::ClaudeMeta,
    claims: claims_claude,
    apply: apply_claude,
};

/// Any other agent's dispatch call (Cursor `Task`, OpenCode `task`, ...),
/// recognized from its `rawInput` alone.
const TOOL_HEURISTIC: ToolMapper = ToolMapper {
    source: SubagentSource::ToolHeuristic,
    claims: claims_heuristic,
    apply: apply_heuristic,
};

/// What the host adds for one agent tool event.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct MappedToolEvent {
    /// A `_meta` entry for the event itself: its record when it changed, or
    /// its control marker.
    pub stamp: Option<(&'static str, Value)>,
    /// Records of other dispatches that this event changed.
    pub changed: Vec<Subagent>,
}

impl MappedToolEvent {
    pub(crate) fn is_empty(&self) -> bool {
        self.stamp.is_none() && self.changed.is_empty()
    }

    pub(crate) fn record(record: Option<Subagent>) -> Self {
        Self {
            stamp: record.map(|record| (SUBAGENT_META_KEY, record.meta_value())),
            changed: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum ToolStatus {
    #[default]
    Pending,
    InProgress,
    Completed,
    Failed,
}

impl ToolStatus {
    fn parse(value: Option<&Value>) -> Option<Self> {
        match value?.as_str()? {
            "pending" => Some(Self::Pending),
            "in_progress" => Some(Self::InProgress),
            "completed" => Some(Self::Completed),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}

/// The fields of one agent tool event that the mappers read.
pub(crate) struct ToolEvent<'a> {
    pub id: &'a str,
    pub title: Option<&'a str>,
    /// `None` on an update that leaves the status unchanged.
    pub status: Option<ToolStatus>,
    pub raw_input: Option<&'a Map<String, Value>>,
    pub raw_output: Option<&'a Value>,
    /// `_meta.claudeCode`.
    pub claude: Option<&'a Map<String, Value>>,
}

impl<'a> ToolEvent<'a> {
    /// `None` without a usable `toolCallId`.
    pub(crate) fn parse(kind: &str, update: &'a Map<String, Value>) -> Option<Self> {
        let id = bounded_id(update.get("toolCallId"))?;
        let status = ToolStatus::parse(update.get("status"))
            .or((kind == "tool_call").then_some(ToolStatus::Pending));
        Some(Self {
            id,
            title: bounded_text(update.get("title"), MAX_TEXT_CHARS),
            status,
            raw_input: update.get("rawInput").and_then(Value::as_object),
            raw_output: update.get("rawOutput"),
            claude: update
                .get("_meta")
                .and_then(|meta| meta.get("claudeCode"))
                .and_then(Value::as_object),
        })
    }

    /// `rawInput` when it carries fields (Claude first sends `{}`).
    pub(crate) fn input(&self) -> Option<&'a Map<String, Value>> {
        self.raw_input.filter(|input| !input.is_empty())
    }
}

/// Map one agent `tool_call`/`tool_call_update` (`kind`) on chat `root`.
pub(crate) fn map_tool_event(
    records: &mut SubagentRecords,
    root: &str,
    kind: &str,
    update: &Map<String, Value>,
    now_ms: u64,
) -> MappedToolEvent {
    let Some(event) = ToolEvent::parse(kind, update) else {
        return MappedToolEvent::default();
    };
    let mapper = match records.get(root, event.id) {
        Some(tracked) => {
            let source = tracked.source();
            TOOL_MAPPERS.iter().find(|mapper| mapper.source == source)
        }
        None => TOOL_MAPPERS.iter().find(|mapper| (mapper.claims)(&event)),
    };
    mapper.map_or_else(MappedToolEvent::default, |mapper| {
        (mapper.apply)(records, root, &event, now_ms)
    })
}

/// What a tool mapper read from a call's events so far. A later event adds
/// or replaces fields; a background launch stays one.
#[derive(Debug, Clone, Default)]
pub(crate) struct ToolView {
    tool_title: Option<String>,
    input_title: Option<String>,
    input_description: Option<String>,
    role: Option<String>,
    prompt: Option<String>,
    pub status: ToolStatus,
    background: bool,
    output_file: Option<String>,
    usage: Option<SubagentUsage>,
    usage_warned: bool,
    /// Codex agent threads the call names.
    pub threads: Vec<String>,
}

fn first_text<'a>(input: &'a Map<String, Value>, keys: &[&str], max: usize) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| bounded_text(input.get(*key), max))
}

impl ToolView {
    /// Read the fields every tool form shares.
    pub(crate) fn absorb(&mut self, event: &ToolEvent) {
        if let Some(title) = event.title {
            self.tool_title = Some(title.to_string());
        }
        if let Some(status) = event.status {
            self.status = status;
        }
        if let Some(input) = event.input() {
            let text = |keys: &[&str], max| first_text(input, keys, max).map(str::to_string);
            self.input_title = text(&TASK_NAME_KEYS, MAX_TEXT_CHARS);
            self.input_description = text(&["description"], MAX_TEXT_CHARS);
            self.role = text(&ROLE_KEYS, MAX_TEXT_CHARS);
            self.prompt = text(&["prompt"], MAX_PROMPT_CHARS);
            self.background |= BACKGROUND_INPUT_KEYS
                .iter()
                .any(|key| input.get(*key) == Some(&Value::Bool(true)));
        }
        self.background |= event
            .raw_output
            .and_then(|output| output.get("isBackground"))
            == Some(&Value::Bool(true));
    }

    /// Read Claude's `_meta.claudeCode.toolResponse`: the launch receipt of
    /// a background subagent, its output file, and its usage.
    fn absorb_claude(&mut self, event: &ToolEvent) {
        let Some(response) = event
            .claude
            .and_then(|claude| claude.get("toolResponse"))
            .and_then(Value::as_object)
        else {
            return;
        };
        let launch_status = response.get("status").and_then(Value::as_str);
        self.background |= response.get("isAsync") == Some(&Value::Bool(true))
            || launch_status.is_some_and(|status| BACKGROUND_LAUNCH_STATUSES.contains(&status));
        if let Some(file) = bounded_text(response.get("outputFile"), MAX_TEXT_CHARS) {
            self.output_file = Some(file.to_string());
        }
        for field in CLAUDE_USAGE_FIELDS {
            let Some(value) = response.get(field).filter(|value| !value.is_null()) else {
                continue;
            };
            let Some(value) = count(value) else {
                if !self.usage_warned {
                    self.usage_warned = true;
                    log::warn!(
                        "[acp] subagent {} reported an invalid {field} in toolResponse; ignored",
                        crate::logging::redact_session_id(event.id)
                    );
                }
                continue;
            };
            let usage = self.usage.get_or_insert_with(SubagentUsage::default);
            match field {
                "totalTokens" => usage.total_tokens = Some(value),
                "totalDurationMs" => usage.duration_ms = Some(value),
                _ => usage.tool_uses = Some(value),
            }
        }
    }

    pub(crate) fn title(&self) -> String {
        self.input_title
            .as_deref()
            .or(self.tool_title.as_deref())
            .unwrap_or("Subagent")
            .to_string()
    }

    /// Copy the descriptive fields onto `record`.
    pub(crate) fn describe(&self, record: &mut Subagent) {
        record.title = self.title();
        record.description = self
            .input_description
            .clone()
            .filter(|description| *description != record.title);
        record.role.clone_from(&self.role);
        record.prompt.clone_from(&self.prompt);
    }

    /// The state the tool status implies. A background launch completes its
    /// call at launch and keeps running.
    fn state(&self) -> SubagentState {
        match self.status {
            ToolStatus::Pending | ToolStatus::InProgress => SubagentState::Running,
            ToolStatus::Completed if self.background => SubagentState::Running,
            ToolStatus::Completed => SubagentState::idle(SubagentEndReason::Completed),
            ToolStatus::Failed => SubagentState::idle(SubagentEndReason::Failed),
        }
    }
}

/// A new dispatch record for tool call `call` of chat `root`.
pub(crate) fn new_entry(
    root: &str,
    call: &str,
    source: SubagentSource,
    caps: SubagentCaps,
    now_ms: u64,
) -> DispatchEntry {
    DispatchEntry {
        record: Subagent {
            id: call.to_string(),
            root_session_id: root.to_string(),
            parent_id: None,
            dispatch_tool_call_id: call.to_string(),
            source,
            title: "Subagent".to_string(),
            description: None,
            role: None,
            prompt: None,
            background: false,
            state: SubagentState::Running,
            started_at: Some(now_ms),
            ended_at: None,
            model: None,
            usage: None,
            output_file: None,
            caps,
        },
        view: ToolView::default(),
    }
}

/// `rawInput` names a subagent: an agent type, or both a description and a
/// prompt. Reasoning (`think`) calls have neither.
fn looks_like_dispatch(event: &ToolEvent) -> bool {
    event.input().is_some_and(|input| {
        first_text(input, &ROLE_KEYS, MAX_TEXT_CHARS).is_some()
            || (first_text(input, &["description"], MAX_TEXT_CHARS).is_some()
                && first_text(input, &["prompt"], MAX_PROMPT_CHARS).is_some())
    })
}

fn claims_claude(event: &ToolEvent) -> bool {
    let Some(claude) = event.claude else {
        return false;
    };
    let tool_name = claude.get("toolName").and_then(Value::as_str);
    matches!(tool_name, Some("Agent" | "Task")) || looks_like_dispatch(event)
}

fn claims_heuristic(event: &ToolEvent) -> bool {
    looks_like_dispatch(event)
}

fn apply_claude(
    records: &mut SubagentRecords,
    root: &str,
    event: &ToolEvent,
    now_ms: u64,
) -> MappedToolEvent {
    let caps = SubagentCaps {
        stop: None,
        transcript: SubagentTranscript::Live,
        live_progress: false,
        usage: true,
    };
    apply_tool(records, root, event, now_ms, CLAUDE_META.source, caps)
}

fn apply_heuristic(
    records: &mut SubagentRecords,
    root: &str,
    event: &ToolEvent,
    now_ms: u64,
) -> MappedToolEvent {
    let caps = SubagentCaps {
        stop: None,
        transcript: SubagentTranscript::Final,
        live_progress: false,
        usage: false,
    };
    apply_tool(records, root, event, now_ms, TOOL_HEURISTIC.source, caps)
}

fn apply_tool(
    records: &mut SubagentRecords,
    root: &str,
    event: &ToolEvent,
    now_ms: u64,
    source: SubagentSource,
    caps: SubagentCaps,
) -> MappedToolEvent {
    let record = records.upsert(
        root,
        event.id,
        || new_entry(root, event.id, source, caps, now_ms),
        |entry| {
            entry.view.absorb(event);
            if source == SubagentSource::ClaudeMeta {
                entry.view.absorb_claude(event);
            }
            let view = &entry.view;
            let record = &mut entry.record;
            view.describe(record);
            record.background = view.background;
            record.output_file.clone_from(&view.output_file);
            record.usage.clone_from(&view.usage);
            record.set_state(view.state(), now_ms);
        },
    );
    MappedToolEvent::record(record)
}

/// The control marker value naming `subagent_ids`.
pub(crate) fn control_value(subagent_ids: &[String]) -> Value {
    let control = SubagentControl {
        subagent_ids: subagent_ids.to_vec(),
    };
    serde_json::to_value(control).unwrap_or(Value::Null)
}

#[cfg(test)]
#[path = "tools_tests.rs"]
mod tools_tests;
