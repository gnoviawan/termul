//! Agent work outside a prompt turn.
//!
//! An agent can keep working after its prompt turn ends: Claude Code wakes up
//! when a background shell or subagent finishes and runs a turn of its own,
//! and any adapter may stream updates with no prompt open. ACP v1 has no event
//! for this, so the host derives it from the updates themselves. A session is
//! working from the first such update until no tool call it started outside a
//! turn is still pending or in progress and no update arrived for
//! [`UNPROMPTED_QUIET`].
//!
//! Only real work counts: streamed message or thought text, or a tool call
//! that is pending or in progress. State updates (commands, modes, usage,
//! titles) and tool calls reported as already finished do not, so an adapter
//! that republishes state after a reopen does not look busy. Subagent traffic
//! does not count either: the chat tracks background subagents on its own,
//! and Reload and the account switch must not wait on them.
//!
//! An open tool call that reports nothing for [`UNPROMPTED_STALE`] no longer
//! holds the session: an agent can drop a call without a final status.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::v1::{Meta, SessionUpdate, ToolCallStatus};
use serde_json::Value;

use crate::acp::subagents::SUBAGENT_META_KEY;
use tokio::sync::Notify;
// Tokio's clock, so tests with paused time drive the quiet period.
use tokio::time::Instant;

/// How long a working session with no open tool call stays working after its
/// last update. Covers the model thinking between two tool calls.
pub(crate) const UNPROMPTED_QUIET: Duration = Duration::from_secs(30);

/// How long a working session with an open tool call stays working after its
/// last update. Claude Code sends a keep-alive every 30 s while a command runs.
pub(crate) const UNPROMPTED_STALE: Duration = Duration::from_secs(10 * 60);

/// One session's work outside a prompt turn.
#[derive(Debug)]
struct Work {
    /// Tool calls reported pending or in progress and not finished since.
    open_tool_calls: HashSet<String>,
    last_update: Instant,
}

impl Work {
    /// When the session stops working unless another update arrives.
    fn deadline(&self) -> Instant {
        let hold = if self.open_tool_calls.is_empty() {
            UNPROMPTED_QUIET
        } else {
            UNPROMPTED_STALE
        };
        self.last_update + hold
    }
}

/// Every session of one agent that works outside a prompt turn.
#[derive(Debug, Default)]
pub(crate) struct UnpromptedWork {
    sessions: HashMap<String, Work>,
    /// Wakes the sweeper when a session's quiet deadline appears.
    wake: Arc<Notify>,
}

/// What an update means for the tool calls of a session.
enum Effect {
    /// Streamed text or thinking.
    Activity,
    /// A tool call started or still runs.
    Opened(String),
    /// A tool call finished.
    Closed(String),
    /// An update to a tool call with no status (output, a keep-alive).
    Touched(String),
    /// Not work.
    Ignored,
}

/// Whether a subagent produced the update: its child traffic rerouted to the
/// chat (`claudeCode.parentToolUseId`) or its dispatch card (`termul/subagent`).
pub(super) fn is_subagent_update(update: &SessionUpdate) -> bool {
    let meta: Option<&Meta> = match update {
        SessionUpdate::AgentMessageChunk(chunk) | SessionUpdate::AgentThoughtChunk(chunk) => {
            chunk.meta.as_ref()
        }
        SessionUpdate::ToolCall(call) => call.meta.as_ref(),
        SessionUpdate::ToolCallUpdate(update) => update.meta.as_ref(),
        _ => None,
    };
    meta.is_some_and(|meta| {
        meta.contains_key(SUBAGENT_META_KEY)
            || meta
                .get("claudeCode")
                .and_then(|claude| claude.get("parentToolUseId"))
                .and_then(Value::as_str)
                .is_some_and(|id| !id.is_empty())
    })
}

fn effect_of(update: &SessionUpdate) -> Effect {
    if is_subagent_update(update) {
        return Effect::Ignored;
    }
    let status_effect = |id: String, status: Option<ToolCallStatus>| match status {
        Some(ToolCallStatus::Pending | ToolCallStatus::InProgress) => Effect::Opened(id),
        Some(_) => Effect::Closed(id),
        None => Effect::Touched(id),
    };
    match update {
        SessionUpdate::AgentMessageChunk(_) | SessionUpdate::AgentThoughtChunk(_) => {
            Effect::Activity
        }
        SessionUpdate::ToolCall(call) => {
            status_effect(call.tool_call_id.0.to_string(), Some(call.status))
        }
        SessionUpdate::ToolCallUpdate(update) => {
            status_effect(update.tool_call_id.0.to_string(), update.fields.status)
        }
        _ => Effect::Ignored,
    }
}

impl UnpromptedWork {
    /// Record an update that arrived while no prompt turn runs for
    /// `session_id`. Returns true when the session starts working.
    pub(crate) fn note(&mut self, session_id: &str, update: &SessionUpdate, now: Instant) -> bool {
        let effect = effect_of(update);
        let Some(work) = self.sessions.get_mut(session_id) else {
            let open_tool_calls = match effect {
                Effect::Activity => HashSet::new(),
                Effect::Opened(id) => HashSet::from([id]),
                Effect::Closed(_) | Effect::Touched(_) | Effect::Ignored => return false,
            };
            self.sessions.insert(
                session_id.to_string(),
                Work {
                    open_tool_calls,
                    last_update: now,
                },
            );
            self.wake.notify_one();
            return true;
        };
        match effect {
            Effect::Activity => {}
            Effect::Opened(id) => {
                work.open_tool_calls.insert(id);
            }
            Effect::Closed(id) => {
                // A finished call that was not open (a republished status) is
                // not activity: it must not push back the quiet deadline.
                if !work.open_tool_calls.remove(&id) {
                    return false;
                }
                if work.open_tool_calls.is_empty() {
                    self.wake.notify_one();
                }
            }
            Effect::Touched(id) => {
                // Output or a keep-alive holds the session only for an open call.
                if !work.open_tool_calls.contains(&id) {
                    return false;
                }
            }
            Effect::Ignored => return false,
        }
        work.last_update = now;
        false
    }

    /// End `session_id`'s work: a prompt turn begins or the session closes.
    /// Returns whether it was working.
    pub(crate) fn end(&mut self, session_id: &str) -> bool {
        self.sessions.remove(session_id).is_some()
    }

    /// Remove and return the sessions whose work went quiet by `now`.
    pub(crate) fn take_quiet(&mut self, now: Instant) -> Vec<String> {
        let quiet: Vec<String> = self
            .sessions
            .iter()
            .filter(|(_, work)| work.deadline() <= now)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &quiet {
            self.sessions.remove(id);
        }
        quiet
    }

    /// The earliest instant a working session can go quiet. `None` when no
    /// session works.
    pub(crate) fn next_deadline(&self) -> Option<Instant> {
        self.sessions.values().map(Work::deadline).min()
    }

    /// Sessions that work outside a prompt turn now.
    pub(crate) fn session_ids(&self) -> Vec<String> {
        self.sessions.keys().cloned().collect()
    }

    pub(crate) fn count(&self) -> usize {
        self.sessions.len()
    }

    /// The signal [`Self::note`] raises when a quiet deadline appears.
    pub(crate) fn wake(&self) -> Arc<Notify> {
        Arc::clone(&self.wake)
    }
}

#[cfg(test)]
#[path = "unprompted_tests.rs"]
mod tests;
