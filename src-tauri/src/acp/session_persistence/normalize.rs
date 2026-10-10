use super::diff_stat;
use super::*;

pub(super) fn validate_and_sort(records: &mut [PersistedEventRecord]) -> Result<()> {
    records.sort_by_key(|record| record.seq);
    let mut previous = 0;
    for record in records {
        if record.seq == 0 || record.seq <= previous {
            return Err(SessionPersistenceError::CorruptSession);
        }
        previous = record.seq;
    }
    Ok(())
}

#[must_use]
pub fn is_durable_event(type_: &str) -> bool {
    // CAP-2: `agent_switch` is excluded because the ONLY durable write for a
    // switch is the host-authored `WriterCommand::AppendAgentSwitch` record
    // (the `record_local_title` precedent). The synthetic live fan-out event
    // is excluded here so `WsRelaySink::emit` → `assign_and_append` →
    // `enqueue_event` cannot append a SECOND durable record for the same
    // switch (the fold would render two separators). The durable record
    // itself flows through the writer command, never through this gate.
    !matches!(
        type_,
        "permission_request"
            | "auth_required"
            | "agent_spawned"
            | "agent_disconnected"
            | "agent_crashed"
            | "projects_changed"
            | "project_switch_completed"
            | "project_switch_failed"
            | "agent_switch"
    )
}

pub(super) fn is_tool_event(type_: &str) -> bool {
    matches!(type_, "tool_call" | "tool_call_update")
}

/// True when the record participates in the transcript fold
/// (`session_payload::fold_session_records`): boundaries (`user_prompt`,
/// `tool_call`, `prompt_complete`, `agent_switch` — CAP-2: a switch splits
/// any open chunk run so the new agent's first chunk opens a fresh bubble)
/// plus `message_chunk`s that carry content. Null-content chunks and every
/// other durable event (plan/usage/mode/session-info updates,
/// `tool_call_update`, …) are transparent — they neither open nor close a
/// coalesced run, so they may sit at a tail window edge without changing
/// bubble identity.
pub(super) fn is_fold_relevant(record: &PersistedEventRecord) -> bool {
    match record.type_.as_str() {
        "user_prompt" | "tool_call" | "prompt_complete" | "agent_switch" => true,
        "message_chunk" => record
            .payload
            .get("content")
            .is_some_and(|content| !content.is_null()),
        _ => false,
    }
}

/// The fold bucket a `message_chunk` joins — mirrors `fold_session_records`.
pub(super) fn chunk_fold_role(record: &PersistedEventRecord) -> &'static str {
    if record.payload.get("role").and_then(Value::as_str) == Some("thought") {
        "thought"
    } else {
        "agent"
    }
}

/// Issue #844c: the message-fold state tracked incrementally by
/// `append_record` (and reconstructed by the lazy heal), mirroring
/// `session_payload::fold_session_records` so `metadata.message_count` ==
/// the materialized messages length.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct FoldState {
    /// Fold role of the currently-open chunk run ("agent"/"thought"), or
    /// None when no run is open.
    pub open_role: Option<&'static str>,
}

/// One fold step: given the current state and the NEXT record (seq order),
/// return the state after it and whether the record opens a new message
/// bubble (the only events that increment `message_count`).
///
/// Mirrors `fold_session_records` exactly:
/// - `user_prompt` always opens a bubble (even a summary-only handoff, which
///   folds to a boundary row that still counts — parity with the fold's
///   `messages.push`).
/// - `message_chunk` coalesces when its role equals the open run's role
///   (null-content or empty-text may never open — transparent);
///   otherwise it opens.
/// - `tool_call` / `prompt_complete` / `agent_switch` close the run (no
///   bubble, no count).
/// - `tool_call_update` and every other durable event are transparent.
pub(crate) fn fold_step(state: FoldState, type_: &str, payload: &Value) -> (FoldState, bool) {
    match type_ {
        "user_prompt" => (FoldState { open_role: None }, true),
        "message_chunk" => {
            let role = if payload.get("role").and_then(Value::as_str) == Some("thought") {
                "thought"
            } else {
                "agent"
            };
            let Some(content) = payload.get("content").filter(|c| !c.is_null()) else {
                // Transparent: null-content chunk (mirrors the fold's
                // `continue`).
                return (state, false);
            };
            if state.open_role == Some(role) {
                // Same run still open: coalesce (no new bubble).
                return (state, false);
            }
            let opens_text = content
                .get("type")
                .and_then(Value::as_str)
                .is_none_or(|t| t == "text");
            let empty_text = opens_text
                && content
                    .get("text")
                    .and_then(Value::as_str)
                    .is_none_or(str::is_empty);
            if empty_text {
                // An empty text chunk may never open a bubble.
                return (state, false);
            }
            (FoldState { open_role: Some(role) }, true)
        }
        // Issue #842: a synthetic `interrupted` marker only terminates the
        // turn — it must NOT close the open chunk run (a resumed stream
        // continues the same bubble). Parity with `fold_session_records`.
        "prompt_complete"
            if payload.get("stopReason").and_then(Value::as_str) == Some("interrupted") =>
        {
            (state, false)
        }
        "tool_call" | "prompt_complete" | "agent_switch" => (FoldState { open_role: None }, false),
        _ => (state, false),
    }
}

/// Paths longer than this (in chars) are never persisted in a file-change
/// summary — the field is omitted instead.
pub(crate) const MAX_SUMMARY_PATH_CHARS: usize = 4096;

/// Tool kinds whose calls change files (the Changed files panel's domain).
pub(crate) fn is_file_change_kind(kind: Option<&str>) -> bool {
    matches!(kind, Some("edit" | "delete" | "move"))
}

/// Renderer `PATH_KEYS` (`tool-call-summary.ts`) — same keys, same order.
const PATH_KEYS: &[&str] = &[
    "path",
    "filePath",
    "file_path",
    "file",
    "target_file",
    "targetFile",
    "abspath",
    "absPath",
    "filename",
    "fileName",
];

/// Best-effort file path for one tool event, mirroring the renderer's
/// `toolCallPath`: `locations[0].path` → the first non-blank `rawInput`
/// `PATH_KEYS` string (trimmed) → the first diff item's `path`.
fn tool_event_path(tool: &serde_json::Map<String, Value>) -> Option<&str> {
    let location = tool
        .get("locations")
        .and_then(Value::as_array)
        .and_then(|locations| locations.first())
        .and_then(|location| location.get("path"))
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty());
    if location.is_some() {
        return location;
    }
    if let Some(input) = tool.get("rawInput").and_then(Value::as_object) {
        let from_input = PATH_KEYS.iter().find_map(|key| {
            input
                .get(*key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|path| !path.is_empty())
        });
        if from_input.is_some() {
            return from_input;
        }
    }
    tool.get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| diff_stat::is_diff_item(item))
        .find_map(|item| {
            item.get("path")
                .and_then(Value::as_str)
                .filter(|path| !path.is_empty())
        })
}

/// Add the bounded, path-only file-change summary (`locations: [{path}]`,
/// `diffStat: {added, removed}`) to a reduced tool DTO when the gate admits
/// the event: a `tool_call` whose `kind` is edit/delete/move, or a
/// `tool_call_update` whose own `kind` is one of those OR that carries diff
/// content. Fields are added only when derivable; a path that is longer than
/// [`MAX_SUMMARY_PATH_CHARS`] is omitted. Diff text, titles, `rawInput`, and
/// line numbers are never persisted — only the derived path and counts.
fn add_file_change_summary(
    type_: &str,
    tool: &serde_json::Map<String, Value>,
    reduced: &mut serde_json::Map<String, Value>,
) {
    // Gate first: the diff stat (up to a bounded LCS) is computed only for
    // events that can be admitted.
    let kind_gate = is_file_change_kind(tool.get("kind").and_then(Value::as_str));
    let admitted = match type_ {
        "tool_call" => kind_gate,
        _ => {
            kind_gate
                || tool
                    .get("content")
                    .and_then(Value::as_array)
                    .is_some_and(|items| items.iter().any(diff_stat::is_diff_item))
        }
    };
    if !admitted {
        return;
    }
    let stat = diff_stat::content_diff_stat(tool.get("content"));
    if let Some(path) =
        tool_event_path(tool).filter(|path| path.chars().count() <= MAX_SUMMARY_PATH_CHARS)
    {
        reduced.insert(
            "locations".to_string(),
            serde_json::json!([{ "path": path }]),
        );
    }
    if let Some(counts) = stat {
        reduced.insert(
            "diffStat".to_string(),
            serde_json::json!({ "added": counts.added, "removed": counts.removed }),
        );
    }
}

pub(super) fn normalize_durable_payload(type_: &str, payload: &Value) -> Value {
    if matches!(type_, "tool_call" | "tool_call_update") {
        // Strict DTO: tool-authored free-form content, arguments, output, and
        // unknown fields are never durable. Only structural routing/status
        // fields required to reconstruct the timeline are admitted, plus a
        // host-derived file-change summary for file-changing calls
        // (`add_file_change_summary`: path-only `locations` + `diffStat`
        // counts) so restored sessions can repopulate the Changed files
        // panel without persisting any diff text.
        let mut event = serde_json::Map::new();
        for field in ["agentId", "sessionId"] {
            if let Some(value) = payload.get(field) {
                event.insert(field.to_string(), value.clone());
            }
        }
        let key = if type_ == "tool_call" {
            "toolCall"
        } else {
            "update"
        };
        if let Some(tool) = payload.get(key).and_then(Value::as_object) {
            let mut reduced = serde_json::Map::new();
            for field in ["toolCallId", "kind", "status"] {
                if let Some(value) = tool.get(field) {
                    reduced.insert(field.to_string(), value.clone());
                }
            }
            add_file_change_summary(type_, tool, &mut reduced);
            event.insert(key.to_string(), Value::Object(reduced));
        }
        Value::Object(event)
    } else {
        sanitize_value(None, payload)
    }
}

pub(super) fn sanitize_value(key: Option<&str>, value: &Value) -> Value {
    if key.is_some_and(is_secret_key) {
        return Value::String("[REDACTED]".to_string());
    }
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(key, _)| !is_secret_key(key))
                .map(|(key, value)| (key.clone(), sanitize_value(Some(key), value)))
                .collect(),
        ),
        Value::Array(values) => Value::Array(
            values
                .iter()
                .map(|value| sanitize_value(None, value))
                .collect(),
        ),
        _ => value.clone(),
    }
}

pub(super) fn is_secret_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    normalized == "env"
        || normalized == "headers"
        || normalized == "authorization"
        || normalized == "auth"
        || normalized == "rawinput"
        || normalized == "rawoutput"
        || normalized.contains("secret")
        || normalized.contains("token")
        || normalized.contains("password")
        || normalized.contains("apikey")
        || normalized.contains("credential")
        || normalized.contains("cookie")
}

pub(crate) fn normalize_title(text: &str) -> String {
    fn strip_wrappers(mut value: &str) -> &str {
        loop {
            let next = value
                .trim()
                .trim_matches(['"', '\'', '`'])
                .trim_matches('_')
                .trim_matches('*')
                .trim();
            if next == value {
                return next;
            }
            value = next;
        }
    }

    let mut lines = text
        .split(['\n', '\r'])
        .map(str::trim)
        .filter(|line| !line.is_empty());
    let mut sanitized = strip_wrappers(lines.next().unwrap_or_default());
    let lowercase = sanitized.to_ascii_lowercase();
    const PREAMBLES: &[&str] = &[
        "sure! here's the title:",
        "sure, here's the title:",
        "here's the title:",
        "the title is:",
        "title:",
    ];
    if let Some(prefix) = PREAMBLES
        .iter()
        .find(|prefix| lowercase.starts_with(**prefix))
    {
        sanitized = strip_wrappers(&sanitized[prefix.len()..]);
        if sanitized.is_empty() {
            sanitized = strip_wrappers(lines.next().unwrap_or_default());
        }
    } else if lowercase == "what should we do?" {
        sanitized = strip_wrappers(lines.next().unwrap_or_default());
    }

    if sanitized.is_empty() {
        return "Untitled Chat".to_string();
    }
    let bounded: String = sanitized.chars().take(48).collect();
    if sanitized.chars().count() > 48 {
        format!("{bounded}…")
    } else {
        bounded
    }
}

pub(super) fn derive_title(payload: &Value) -> String {
    let text = payload
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find_map(|block| {
            (block.get("type").and_then(Value::as_str) == Some("text"))
                .then(|| block.get("text").and_then(Value::as_str))
                .flatten()
        })
        // spec-agent-switch-separator-redesign: a legacy framed handoff
        // `user_prompt` (`summary + --- + draft`) must title the session with
        // the draft, not the wire header — same strip the materialize fold
        // applies. `Dropped` (summary-only) → fall through to Untitled.
        .and_then(
            |text| match crate::acp::session_payload::strip_handoff_display_text(text) {
                Some(crate::acp::session_payload::HandoffText::Draft(draft)) => Some(draft),
                Some(crate::acp::session_payload::HandoffText::Dropped) => None,
                None => Some(text.to_string()),
            },
        )
        .unwrap_or_else(|| "Untitled Chat".to_string());
    normalize_title(&text)
}

#[must_use]
pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
