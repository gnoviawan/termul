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
//!
//! Every change stamps the session's list with the agent's next revision, so
//! a client that hears two lists out of order keeps the newer one.

use std::collections::{HashMap, HashSet};

use agent_client_protocol::schema::v1::{Meta, SessionUpdate, StopReason, ToolCallStatus};
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

/// One session's commands as of `revision`, which grows with every change on
/// the agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundCommandList {
    pub revision: u64,
    pub commands: Vec<BackgroundCommand>,
}

/// Every session's commands on one agent as of `revision`. A session left
/// out lists none.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundCommandsSnapshot {
    pub revision: u64,
    pub sessions: HashMap<String, Vec<BackgroundCommand>>,
}

/// How a prompt turn ended, which decides what its open tool calls are.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TurnEnd {
    /// The agent ended the turn itself.
    Stopped,
    /// The turn was cancelled. A shell the agent already runs can outlive
    /// the cancel (Codex); a call that never started cannot.
    Cancelled,
    /// The prompt failed or timed out: the agent may be wedged, and its open
    /// calls say nothing about what runs.
    Failed,
}

impl TurnEnd {
    pub(crate) fn of<E>(outcome: &Result<StopReason, E>) -> Self {
        match outcome {
            Ok(StopReason::Cancelled) => Self::Cancelled,
            Ok(_) => Self::Stopped,
            Err(_) => Self::Failed,
        }
    }
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
    status: Option<ToolCallStatus>,
    terminal: bool,
    /// The host cancelled the permission this call waited on, so it never
    /// runs.
    permission_cancelled: bool,
    exited: bool,
    title: Option<String>,
    description: Option<String>,
    command: Option<String>,
}

impl Seen {
    /// Whether the call keeps running after its turn ended as `turn`.
    fn outlives(&self, turn: TurnEnd) -> bool {
        if self.permission_cancelled || self.exited {
            return false;
        }
        match turn {
            TurnEnd::Stopped => self.status.is_some_and(is_open),
            TurnEnd::Cancelled => self.terminal && self.status == Some(ToolCallStatus::InProgress),
            TurnEnd::Failed => false,
        }
    }

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
    /// Calls a subagent made: an update of one that lacks the subagent
    /// marker still never counts.
    subagent_calls: HashSet<String>,
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
    revision: u64,
}

impl BackgroundCommands {
    /// Record an update of `session_id`, in or out of a prompt turn. The
    /// caller drops subagent dispatches and replayed history. Returns the
    /// session's new list when it changed.
    pub(crate) fn note(
        &mut self,
        session_id: &str,
        update: &SessionUpdate,
        now_ms: u64,
    ) -> Option<BackgroundCommandList> {
        self.apply(session_id, update, now_ms)
            .then(|| self.changed(session_id))
    }

    fn apply(&mut self, session_id: &str, update: &SessionUpdate, now_ms: u64) -> bool {
        if is_subagent_update(update) {
            if let Some(facts) = tool_call_facts(update) {
                let session = self.sessions.entry(session_id.to_string()).or_default();
                session.seen.remove(&facts.id);
                session.subagent_calls.insert(facts.id);
            }
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
        if session.is_tracked(&facts.id) || session.subagent_calls.contains(&facts.id) {
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
        seen.status = Some(status);
        if is_open(status) {
            return false;
        }
        let backgrounded = seen.terminal && !seen.exited && !seen.permission_cancelled;
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

    /// A prompt turn of `session_id` ended as `turn`: the tool calls that
    /// outlive it keep running in the background, except a subagent dispatch
    /// (`is_dispatch`) the registry learned of after its first update. Every
    /// other open call is forgotten. Returns the session's new list when it
    /// changed.
    pub(crate) fn end_turn(
        &mut self,
        session_id: &str,
        turn: TurnEnd,
        is_dispatch: impl Fn(&str) -> bool,
    ) -> Option<BackgroundCommandList> {
        let session = self.sessions.get_mut(session_id)?;
        let mut open: Vec<(String, Seen)> = session
            .seen
            .drain()
            .filter(|(id, seen)| seen.outlives(turn) && !is_dispatch(id))
            .collect();
        if open.is_empty() {
            return None;
        }
        open.sort_by_key(|(id, seen)| (seen.first_seen_ms, id.clone()));
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
        Some(self.changed(session_id))
    }

    /// The host cancelled the permission `tool_call_id` of `session_id`
    /// waited on: the call never runs, so no turn end lists it.
    pub(crate) fn permission_cancelled(&mut self, session_id: &str, tool_call_id: &str) {
        let session = self.sessions.entry(session_id.to_string()).or_default();
        session
            .seen
            .entry(tool_call_id.to_string())
            .or_default()
            .permission_cancelled = true;
    }

    /// A prompt turn of `session_id` starts: drop its ended commands, and
    /// forget the calls opened since the last turn ended, which belong to no
    /// turn. Returns the session's new list when it changed.
    pub(crate) fn begin_turn(&mut self, session_id: &str) -> Option<BackgroundCommandList> {
        let session = self.sessions.get_mut(session_id)?;
        session.seen.clear();
        let before = session.commands.len();
        session
            .commands
            .retain(|tracked| tracked.command.state == CommandState::Running);
        (session.commands.len() != before).then(|| self.changed(session_id))
    }

    /// Forget a closed or deleted session. Returns its new, empty list when
    /// it listed any command.
    pub(crate) fn forget(&mut self, session_id: &str) -> Option<BackgroundCommandList> {
        self.sessions
            .remove(session_id)
            .filter(|session| !session.commands.is_empty())
            .map(|_| self.changed(session_id))
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

    /// Every session that lists a command, as of the current revision.
    pub(crate) fn snapshot(&self) -> BackgroundCommandsSnapshot {
        BackgroundCommandsSnapshot {
            revision: self.revision,
            sessions: self
                .sessions
                .keys()
                .map(|id| (id.clone(), self.list(id)))
                .filter(|(_, commands)| !commands.is_empty())
                .collect(),
        }
    }

    fn changed(&mut self, session_id: &str) -> BackgroundCommandList {
        self.revision += 1;
        BackgroundCommandList {
            revision: self.revision,
            commands: self.list(session_id),
        }
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
