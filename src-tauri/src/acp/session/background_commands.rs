//! Commands an agent left running in the background.
//!
//! ACP v1 has no event for a command that outlives its tool call, so the host
//! derives it from standard updates, per session:
//!
//! - A tool call that announced a terminal (`_meta.terminal_info`) reports a
//!   final status without `_meta.terminal_exit`: the command went to the
//!   background (Claude Code's `run_in_background`). Its `terminal_exit`
//!   arrives later, outside any prompt turn.
//! - A tool call still pending or in progress when its prompt turn ends keeps
//!   running (a Codex shell, a Factory Droid background task). Its final
//!   status or `terminal_exit` ends it.
//! - A Qwen Code `background_task_completed` message chunk ends the command
//!   its `toolUseId` names.
//!
//! Subagent traffic never counts. Nothing expires on a timer: an agent that
//! never reports the end keeps the row until the session closes. An ended row
//! stays until the next prompt turn of its session starts.

use std::collections::HashMap;

use agent_client_protocol::schema::v1::{Meta, SessionUpdate, ToolCallStatus};
use serde::Serialize;
use serde_json::Value;

use super::unprompted::is_subagent_update;

/// One command the agent left running, as clients see it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundCommand {
    pub tool_call_id: String,
    /// The command's description, else its tool call title.
    pub title: String,
    pub command: Option<String>,
    /// When the tool call first appeared (wall clock).
    pub started_at_ms: u64,
    #[serde(flatten)]
    pub state: CommandState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum CommandState {
    Running,
    #[serde(rename_all = "camelCase")]
    Ended {
        ended_at_ms: u64,
    },
}

/// What ends a running command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EndSignal {
    /// Its tool call already reported a final status; only `terminal_exit`
    /// ends it.
    TerminalExit,
    /// Its tool call was left open; a final status or `terminal_exit` ends it.
    FinalStatus,
}

#[derive(Debug)]
struct Tracked {
    command: BackgroundCommand,
    end: EndSignal,
}

/// A tool call seen but not finished: what it has shown so far.
#[derive(Debug, Default)]
struct Seen {
    first_seen_ms: u64,
    open: bool,
    terminal: bool,
    exited: bool,
    title: Option<String>,
    description: Option<String>,
    command: Option<String>,
}

impl Seen {
    fn into_running(self, tool_call_id: String, end: EndSignal) -> Tracked {
        Tracked {
            command: BackgroundCommand {
                tool_call_id,
                title: self.description.or(self.title).unwrap_or_default(),
                command: self.command,
                started_at_ms: self.first_seen_ms,
                state: CommandState::Running,
            },
            end,
        }
    }
}

#[derive(Debug, Default)]
struct SessionCommands {
    seen: HashMap<String, Seen>,
    /// Ordered by when each command went to the background.
    commands: Vec<Tracked>,
}

impl SessionCommands {
    fn running_mut(&mut self, tool_call_id: &str) -> Option<&mut Tracked> {
        self.commands.iter_mut().find(|tracked| {
            tracked.command.tool_call_id == tool_call_id
                && tracked.command.state == CommandState::Running
        })
    }

    fn is_tracked(&self, tool_call_id: &str) -> bool {
        self.commands
            .iter()
            .any(|tracked| tracked.command.tool_call_id == tool_call_id)
    }
}

/// The fields of a tool call or tool call update this module reads.
struct ToolCallFacts<'a> {
    id: String,
    status: Option<ToolCallStatus>,
    title: Option<&'a str>,
    raw_input: Option<&'a Value>,
    meta: Option<&'a Meta>,
}

fn tool_call_facts(update: &SessionUpdate) -> Option<ToolCallFacts<'_>> {
    match update {
        SessionUpdate::ToolCall(call) => Some(ToolCallFacts {
            id: call.tool_call_id.0.to_string(),
            status: Some(call.status),
            title: Some(call.title.as_str()),
            raw_input: call.raw_input.as_ref(),
            meta: call.meta.as_ref(),
        }),
        SessionUpdate::ToolCallUpdate(update) => Some(ToolCallFacts {
            id: update.tool_call_id.0.to_string(),
            status: update.fields.status,
            title: update.fields.title.as_deref(),
            raw_input: update.fields.raw_input.as_ref(),
            meta: update.meta.as_ref(),
        }),
        _ => None,
    }
}

/// The tool call id a Qwen Code `background_task_completed` chunk names.
fn qwen_completed_task(update: &SessionUpdate) -> Option<&str> {
    let SessionUpdate::AgentMessageChunk(chunk) = update else {
        return None;
    };
    let meta = chunk.meta.as_ref()?;
    if meta.get("source").and_then(Value::as_str) != Some("background_task_completed") {
        return None;
    }
    meta.get("backgroundTask")?
        .get("toolUseId")?
        .as_str()
        .filter(|id| !id.is_empty())
}

fn non_empty(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn is_open(status: ToolCallStatus) -> bool {
    matches!(status, ToolCallStatus::Pending | ToolCallStatus::InProgress)
}

/// Every session's background commands on one agent.
#[derive(Debug, Default)]
pub(crate) struct BackgroundCommands {
    sessions: HashMap<String, SessionCommands>,
}

impl BackgroundCommands {
    /// Record an update of `session_id`, in or out of a prompt turn. The
    /// caller drops subagent dispatches and replayed history. Returns true
    /// when the session's list changed.
    pub(crate) fn note(&mut self, session_id: &str, update: &SessionUpdate, now_ms: u64) -> bool {
        if is_subagent_update(update) {
            return false;
        }
        if let Some(tool_call_id) = qwen_completed_task(update) {
            let Some(tracked) = self
                .sessions
                .get_mut(session_id)
                .and_then(|session| session.running_mut(tool_call_id))
            else {
                return false;
            };
            end(tracked, now_ms);
            return true;
        }
        let Some(facts) = tool_call_facts(update) else {
            return false;
        };
        let exits = facts
            .meta
            .is_some_and(|meta| meta.contains_key("terminal_exit"));
        let session = self.sessions.entry(session_id.to_string()).or_default();
        if let Some(tracked) = session.running_mut(&facts.id) {
            let ends = exits
                || (tracked.end == EndSignal::FinalStatus
                    && facts.status.is_some_and(|status| !is_open(status)));
            if ends {
                end(tracked, now_ms);
            }
            return ends;
        }
        if session.is_tracked(&facts.id) {
            return false;
        }
        let seen = session
            .seen
            .entry(facts.id.clone())
            .or_insert_with(|| Seen {
                first_seen_ms: now_ms,
                ..Seen::default()
            });
        seen.terminal |= facts
            .meta
            .is_some_and(|meta| meta.contains_key("terminal_info"));
        seen.exited |= exits;
        if let Some(title) = facts.title.filter(|title| !title.trim().is_empty()) {
            seen.title = Some(title.trim().to_string());
        }
        if let Some(input) = facts.raw_input {
            if let Some(description) = non_empty(input.get("description")) {
                seen.description = Some(description);
            }
            if let Some(command) = non_empty(input.get("command")) {
                seen.command = Some(command);
            }
        }
        let Some(status) = facts.status else {
            return false;
        };
        seen.open = is_open(status);
        if seen.open {
            return false;
        }
        let backgrounded = seen.terminal && !seen.exited;
        let Some(seen) = session.seen.remove(&facts.id).filter(|_| backgrounded) else {
            return false;
        };
        log::info!(
            "[acp] session {}: tool call {} left its command running in the background",
            crate::logging::redact_session_id(session_id),
            facts.id
        );
        session
            .commands
            .push(seen.into_running(facts.id, EndSignal::TerminalExit));
        true
    }

    /// A prompt turn of `session_id` ended (any stop reason): every tool call
    /// still open keeps running in the background, except a subagent
    /// dispatch (`is_dispatch`) the registry learned of after its first
    /// update. Returns true when the session's list changed.
    pub(crate) fn end_turn(
        &mut self,
        session_id: &str,
        is_dispatch: impl Fn(&str) -> bool,
    ) -> bool {
        let Some(session) = self.sessions.get_mut(session_id) else {
            return false;
        };
        let mut open: Vec<(String, Seen)> = session
            .seen
            .drain()
            .filter(|(id, seen)| seen.open && !is_dispatch(id))
            .collect();
        open.sort_by_key(|(id, seen)| (seen.first_seen_ms, id.clone()));
        let changed = !open.is_empty();
        for (id, seen) in open {
            log::info!(
                "[acp] session {}: tool call {} still runs after its turn ended",
                crate::logging::redact_session_id(session_id),
                id
            );
            session
                .commands
                .push(seen.into_running(id, EndSignal::FinalStatus));
        }
        changed
    }

    /// A prompt turn of `session_id` starts: drop its ended commands. Returns
    /// true when the session's list changed.
    pub(crate) fn begin_turn(&mut self, session_id: &str) -> bool {
        let Some(session) = self.sessions.get_mut(session_id) else {
            return false;
        };
        let before = session.commands.len();
        session
            .commands
            .retain(|tracked| tracked.command.state == CommandState::Running);
        session.commands.len() != before
    }

    /// Forget a closed or deleted session. Returns whether it listed any
    /// command.
    pub(crate) fn forget(&mut self, session_id: &str) -> bool {
        self.sessions
            .remove(session_id)
            .is_some_and(|session| !session.commands.is_empty())
    }

    /// The commands of `session_id`, in start order.
    pub(crate) fn list(&self, session_id: &str) -> Vec<BackgroundCommand> {
        self.sessions
            .get(session_id)
            .map(|session| {
                session
                    .commands
                    .iter()
                    .map(|tracked| tracked.command.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Every session that lists a command.
    pub(crate) fn by_session(&self) -> HashMap<String, Vec<BackgroundCommand>> {
        self.sessions
            .keys()
            .map(|id| (id.clone(), self.list(id)))
            .filter(|(_, commands)| !commands.is_empty())
            .collect()
    }

    /// Commands still running, across sessions.
    pub(crate) fn running_count(&self) -> usize {
        self.sessions
            .values()
            .flat_map(|session| &session.commands)
            .filter(|tracked| tracked.command.state == CommandState::Running)
            .count()
    }
}

fn end(tracked: &mut Tracked, now_ms: u64) {
    tracked.command.state = CommandState::Ended {
        ended_at_ms: now_ms,
    };
    log::info!(
        "[acp] background command of tool call {} ended",
        tracked.command.tool_call_id
    );
}

#[cfg(test)]
#[path = "background_commands_tests.rs"]
mod tests;
