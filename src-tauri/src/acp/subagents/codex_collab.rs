//! Codex ACP subagents without subagent sessions ("hidden mode"). Codex
//! reports them as collaboration tool calls (`spawnAgent`, `wait`,
//! `sendInput`, `closeAgent`, ...; `rawInput.senderThreadId` or
//! `rawInput.agentsStates`) and activity cards (`rawInput.agentThreadId` with
//! `rawInput.activityKind`). Agent state arrives on other calls than the
//! spawn, keyed by agent thread id, so the host keeps each thread's state per
//! chat and folds it into the spawn's record.
//!
//! - A spawn call is a dispatch; its record id is its tool call id.
//! - A `started` activity card whose thread no known dispatch names is a
//!   dispatch too (the agent was spawned outside a visible spawn call). It
//!   stays one even if a spawn naming its thread arrives later.
//! - Every other collab call and card steers existing subagents and gets the
//!   control marker.

use std::collections::HashMap;

use serde_json::{Map, Value};

use super::registry::{DispatchEntry, SubagentRecords, Tracked};
use super::tools::{control_value, new_entry, MappedToolEvent, ToolEvent, ToolMapper, ToolStatus};
use super::{
    bounded_text, SubagentCaps, SubagentEndReason, SubagentSource, SubagentState,
    SubagentTranscript, MAX_ID_CHARS, SUBAGENT_CONTROL_META_KEY,
};

pub(super) const MAPPER: ToolMapper = ToolMapper {
    source: SubagentSource::CodexCollab,
    claims,
    apply,
};

const CAPS: SubagentCaps = SubagentCaps {
    stop: None,
    transcript: SubagentTranscript::None,
    live_progress: false,
    usage: false,
};

/// The state of one Codex agent thread.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ThreadState {
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl ThreadState {
    /// `agentsStates[*].status`.
    fn from_status(status: &str) -> Option<Self> {
        match status {
            "pendingInit" | "running" => Some(Self::Running),
            "completed" => Some(Self::Completed),
            "errored" | "notFound" => Some(Self::Failed),
            "interrupted" | "shutdown" => Some(Self::Cancelled),
            _ => None,
        }
    }

    /// An activity card's `activityKind`.
    fn from_activity(kind: &str) -> Option<Self> {
        match kind {
            "started" | "interacted" => Some(Self::Running),
            "completed" => Some(Self::Completed),
            "interrupted" => Some(Self::Cancelled),
            _ => None,
        }
    }

    /// A completed agent that is later shut down (`closeAgent`) stays
    /// completed.
    fn then(prev: Option<Self>, next: Self) -> Self {
        if prev == Some(Self::Completed) && next == Self::Cancelled {
            Self::Completed
        } else {
            next
        }
    }
}

fn is_collab(input: &Map<String, Value>) -> bool {
    input.contains_key("senderThreadId") || input.contains_key("agentsStates")
}

/// An activity card: (thread id, activity kind).
fn activity(input: &Map<String, Value>) -> Option<(&str, &str)> {
    let thread = bounded_text(input.get("agentThreadId"), MAX_ID_CHARS)?;
    let kind = bounded_text(input.get("activityKind"), MAX_ID_CHARS)?;
    Some((thread, kind))
}

fn is_spawn_title(title: Option<&str>) -> bool {
    title.is_some_and(|title| {
        title
            .chars()
            .filter(|ch| !matches!(ch, '_' | '-') && !ch.is_whitespace())
            .flat_map(char::to_lowercase)
            .eq("spawnagent".chars())
    })
}

/// Thread ids a collab call names: receivers, then `agentsStates` keys.
fn thread_ids(input: &Map<String, Value>) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    let receivers = input
        .get("receiverThreadIds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str);
    let states = input
        .get("agentsStates")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|states| states.keys().map(String::as_str));
    for id in receivers.chain(states) {
        if !id.is_empty() && id.len() <= MAX_ID_CHARS && !ids.iter().any(|known| known == id) {
            ids.push(id.to_string());
        }
    }
    ids
}

/// Thread states the call reports.
fn reported_states(input: &Map<String, Value>) -> Vec<(String, ThreadState)> {
    if let Some((thread, kind)) = activity(input) {
        return ThreadState::from_activity(kind)
            .map(|state| vec![(thread.to_string(), state)])
            .unwrap_or_default();
    }
    input
        .get("agentsStates")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter(|(thread, _)| !thread.is_empty() && thread.len() <= MAX_ID_CHARS)
        .filter_map(|(thread, value)| {
            let status = value.get("status").and_then(Value::as_str)?;
            Some((thread.clone(), ThreadState::from_status(status)?))
        })
        .collect()
}

fn claims(event: &ToolEvent) -> bool {
    event
        .raw_input
        .is_some_and(|input| is_collab(input) || activity(input).is_some())
}

/// True when a known Codex dispatch of `root` names `thread`.
fn named(records: &SubagentRecords, root: &str, thread: &str) -> bool {
    records
        .dispatches(root, SubagentSource::CodexCollab)
        .any(|entry| entry.view.threads.iter().any(|known| known == thread))
}

fn apply(
    records: &mut SubagentRecords,
    root: &str,
    event: &ToolEvent,
    now_ms: u64,
) -> MappedToolEvent {
    let input = event.raw_input;
    let card = input.and_then(activity);
    let mut changed_threads = Vec::new();
    for (thread, state) in input.map(reported_states).unwrap_or_default() {
        let prev = records
            .codex_threads(root)
            .and_then(|threads| threads.get(&thread).copied());
        if records.set_codex_thread(root, &thread, ThreadState::then(prev, state)) {
            changed_threads.push(thread);
        }
    }
    let is_dispatch = match records.get(root, event.id) {
        Some(Tracked::Dispatch(_)) => true,
        Some(Tracked::Control { .. }) => false,
        None => match card {
            Some((thread, "started")) => !named(records, root, thread),
            Some(_) => false,
            None => input.is_some_and(is_collab) && is_spawn_title(event.title),
        },
    };
    let states = records.codex_threads(root).cloned().unwrap_or_default();
    let mut mapped = if is_dispatch {
        let record = records.upsert(
            root,
            event.id,
            || new_entry(root, event.id, SubagentSource::CodexCollab, CAPS, now_ms),
            |entry| {
                entry.view.absorb(event);
                let named = match (card, input) {
                    (Some((thread, _)), _) => vec![thread.to_string()],
                    (None, Some(input)) => thread_ids(input),
                    (None, None) => Vec::new(),
                };
                if !named.is_empty() {
                    entry.view.threads = named;
                }
                refresh(entry, &states, now_ms);
            },
        );
        MappedToolEvent::record(record)
    } else {
        let subagent_ids = control_ids(records, root, event, input, card);
        let marker = control_value(&subagent_ids);
        records.set_control(root, event.id, SubagentSource::CodexCollab, subagent_ids);
        MappedToolEvent {
            stamp: Some((SUBAGENT_CONTROL_META_KEY, marker)),
            changed: Vec::new(),
        }
    };
    if !changed_threads.is_empty() {
        mapped.changed = records.update_dispatches(root, SubagentSource::CodexCollab, |entry| {
            let affected = entry.record.id != event.id
                && entry
                    .view
                    .threads
                    .iter()
                    .any(|thread| changed_threads.contains(thread));
            if affected {
                refresh(entry, &states, now_ms);
            }
        });
    }
    mapped
}

/// Record ids of the dispatches a control call names. A status-only update
/// keeps the ids its call named before.
fn control_ids(
    records: &SubagentRecords,
    root: &str,
    event: &ToolEvent,
    input: Option<&Map<String, Value>>,
    card: Option<(&str, &str)>,
) -> Vec<String> {
    let Some(input) = input else {
        return match records.get(root, event.id) {
            Some(Tracked::Control { subagent_ids, .. }) => subagent_ids.clone(),
            _ => Vec::new(),
        };
    };
    let mut threads = thread_ids(input);
    if let Some((thread, _)) = card {
        threads.push(thread.to_string());
    }
    records
        .dispatches(root, SubagentSource::CodexCollab)
        .filter(|entry| {
            entry
                .view
                .threads
                .iter()
                .any(|known| threads.contains(known))
        })
        .map(|entry| entry.record.id.clone())
        .collect()
}

/// Rebuild a Codex dispatch record from its call and its threads' states:
/// the aggregate of the known thread states (running, then failed, then
/// cancelled, then completed), or the call's own status until one is known.
fn refresh(entry: &mut DispatchEntry, states: &HashMap<String, ThreadState>, now_ms: u64) {
    let known: Vec<ThreadState> = entry
        .view
        .threads
        .iter()
        .filter_map(|thread| states.get(thread).copied())
        .collect();
    let record = &mut entry.record;
    entry.view.describe(record);
    record.background = true;
    record.caps.live_progress = !known.is_empty();
    let state = match aggregate(&known) {
        Some(ThreadState::Running) => SubagentState::Running,
        Some(ThreadState::Failed) => SubagentState::idle(SubagentEndReason::Failed),
        Some(ThreadState::Cancelled) => SubagentState::idle(SubagentEndReason::Cancelled),
        Some(ThreadState::Completed) => SubagentState::idle(SubagentEndReason::Completed),
        None => match entry.view.status {
            ToolStatus::Pending | ToolStatus::InProgress => SubagentState::Running,
            ToolStatus::Completed => SubagentState::idle(SubagentEndReason::Completed),
            ToolStatus::Failed => SubagentState::idle(SubagentEndReason::Failed),
        },
    };
    record.set_state(state, now_ms);
}

fn aggregate(states: &[ThreadState]) -> Option<ThreadState> {
    if states.is_empty() {
        return None;
    }
    [
        ThreadState::Running,
        ThreadState::Failed,
        ThreadState::Cancelled,
    ]
    .into_iter()
    .find(|state| states.contains(state))
    .or(Some(ThreadState::Completed))
}

#[cfg(test)]
#[path = "codex_collab_tests.rs"]
mod codex_collab_tests;
