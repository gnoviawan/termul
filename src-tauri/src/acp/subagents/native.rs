//! Records for ACP subagent sessions: the RFD form (`subagent_update`) and
//! the AIR draft form (`subagent_spawned` + `subagent_state_update`). The
//! driver's router (`manager/native_subagents.rs`) owns the child session
//! routes and the dispatch cards; this module reads the wire into the record.

use serde_json::{Map, Value};

use super::{
    bounded_text, count, Subagent, SubagentCaps, SubagentEnd, SubagentEndReason, SubagentSource,
    SubagentState, SubagentStop, SubagentTranscript, SubagentUsage, MAX_PROMPT_CHARS,
    MAX_TEXT_CHARS,
};

const FALLBACK_TITLE: &str = "Subagent";

/// The wire carried a `state` the RFD form does not define.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct MalformedState;

/// One RFD `state` snapshot, with the usage an idle snapshot reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RfdState {
    pub state: SubagentState,
    pub usage: Option<SubagentUsage>,
}

/// A new record for child session `child`, announced on chat `root`.
pub(crate) fn new_record(
    root: &str,
    child: &str,
    parent_id: Option<String>,
    dispatch_tool_call_id: &str,
    source: SubagentSource,
    now_ms: u64,
) -> Subagent {
    Subagent {
        id: child.to_string(),
        root_session_id: root.to_string(),
        parent_id,
        dispatch_tool_call_id: dispatch_tool_call_id.to_string(),
        source,
        title: FALLBACK_TITLE.to_string(),
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
        caps: SubagentCaps {
            stop: None,
            transcript: SubagentTranscript::Live,
            live_progress: true,
            usage: source == SubagentSource::AcpRfd,
        },
    }
}

/// The `state` of a `subagent_update`: `Ok(None)` when omitted (unchanged).
/// `null` clears the current activity, which the record shows as unknown.
pub(crate) fn rfd_state(update: &Map<String, Value>) -> Result<Option<RfdState>, MalformedState> {
    let Some(value) = update.get("state") else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(Some(RfdState {
            state: SubagentState::Unknown,
            usage: None,
        }));
    }
    let snapshot = value.as_object().ok_or(MalformedState)?;
    let state = match snapshot.get("state").and_then(Value::as_str) {
        Some("running") => SubagentState::Running,
        Some("requires_action") => SubagentState::RequiresAction,
        Some("unknown") => SubagentState::Unknown,
        Some("idle") => SubagentState::Idle {
            end: idle_end(snapshot),
        },
        _ => return Err(MalformedState),
    };
    let usage = state
        .is_idle()
        .then(|| snapshot.get("usage").and_then(idle_usage))
        .flatten();
    Ok(Some(RfdState { state, usage }))
}

/// Why an idle child stopped. No stop reason (or a malformed one) is an end
/// the agent could not explain: the stream ended, the process died, a worker
/// restarted.
fn idle_end(snapshot: &Map<String, Value>) -> SubagentEnd {
    let (reason, error) = match snapshot.get("stopReason").and_then(Value::as_str) {
        None => (SubagentEndReason::Unexplained, None),
        Some("cancelled") => (SubagentEndReason::Cancelled, None),
        Some("error") => {
            let error = snapshot.get("error");
            let message = error
                .and_then(|error| bounded_text(error.get("message"), MAX_TEXT_CHARS))
                .or_else(|| bounded_text(error, MAX_TEXT_CHARS));
            (SubagentEndReason::Failed, message.map(str::to_string))
        }
        Some(_) => (SubagentEndReason::Completed, None),
    };
    SubagentEnd { reason, error }
}

fn idle_usage(value: &Value) -> Option<SubagentUsage> {
    let usage = value.as_object()?;
    let field = |key: &str| usage.get(key).and_then(count);
    let usage = SubagentUsage {
        input_tokens: field("inputTokens"),
        output_tokens: field("outputTokens"),
        total_tokens: field("totalTokens"),
        tool_uses: None,
        duration_ms: None,
    };
    (usage != SubagentUsage::default()).then_some(usage)
}

/// Apply one RFD `subagent_update` upsert to `record`. Omitted fields stay;
/// `null` clears. A cleared or missing title falls back to the description.
/// `announce` is the update that created the record.
pub(crate) fn apply_rfd(
    record: &mut Subagent,
    update: &Map<String, Value>,
    state: Option<RfdState>,
    announce: bool,
    now_ms: u64,
) {
    if let Some(description) = update.get("description") {
        record.description = bounded_text(Some(description), MAX_TEXT_CHARS).map(str::to_string);
    }
    let title = update.get("title");
    if title.is_some() || announce {
        record.title = bounded_text(title, MAX_TEXT_CHARS)
            .map(str::to_string)
            .or_else(|| record.description.clone())
            .unwrap_or_else(|| FALLBACK_TITLE.to_string());
    }
    match update.get("capabilities") {
        None => {}
        Some(Value::Object(capabilities)) => {
            record.caps.stop = capabilities
                .get("cancel")
                .is_some_and(Value::is_object)
                .then_some(SubagentStop::SessionCancel);
        }
        Some(_) => record.caps.stop = None,
    }
    let Some(RfdState { state, usage }) = state else {
        return;
    };
    if let Some(usage) = usage {
        let current = record.usage.get_or_insert_with(SubagentUsage::default);
        current.input_tokens = usage.input_tokens.or(current.input_tokens);
        current.output_tokens = usage.output_tokens.or(current.output_tokens);
        current.total_tokens = usage.total_tokens.or(current.total_tokens);
    }
    record.set_state(state, now_ms);
}

/// Fill an AIR `subagent_spawned` announce into `record`.
pub(crate) fn apply_air_spawn(record: &mut Subagent, update: &Map<String, Value>) {
    record.title = bounded_text(update.get("name"), MAX_TEXT_CHARS)
        .unwrap_or(FALLBACK_TITLE)
        .to_string();
    record.prompt = bounded_text(update.get("task"), MAX_PROMPT_CHARS).map(str::to_string);
}

/// An AIR `subagent_state_update` state. `disconnected` means the child can
/// no longer be observed, which is not an end.
pub(crate) fn air_state(state: &str) -> Option<SubagentState> {
    match state {
        "completed" => Some(SubagentState::idle(SubagentEndReason::Completed)),
        "failed" => Some(SubagentState::idle(SubagentEndReason::Failed)),
        "cancelled" => Some(SubagentState::idle(SubagentEndReason::Cancelled)),
        "disconnected" => Some(SubagentState::Unknown),
        _ => None,
    }
}

/// The child's model from its `config_option_update`: the current value of
/// the option whose category or id is `model`.
pub(crate) fn child_model(update: &Map<String, Value>) -> Option<String> {
    update
        .get("configOptions")?
        .as_array()?
        .iter()
        .find(|option| {
            option.get("category").and_then(Value::as_str) == Some("model")
                || option.get("id").and_then(Value::as_str) == Some("model")
        })
        .and_then(|option| bounded_text(option.get("currentValue"), MAX_TEXT_CHARS))
        .map(str::to_string)
}
