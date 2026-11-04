//! Host-owned activity of every agent chat: what a chat list shows for it.
//!
//! Session events reach only the connections subscribed to the session, so a
//! surface that has not opened a chat never sees its turn start or end. The
//! relay derives, from the events it numbers, one record per chat and serves
//! it to every `chat_activity` watcher, whatever the watcher subscribed to:
//!
//! - `busy`: a prompt turn is open (`user_prompt` recorded, no
//!   `prompt_complete` yet) or the agent works outside a turn
//!   (`agent_working`). A closed session or a dead agent works on nothing.
//! - `needsYou`: the relay holds a pending permission, question or
//!   elicitation of the session (the list a subscribing client installs).
//! - `unread`: the newest turn end this host saw is past the shared last-read
//!   marker ([`crate::web::chat_reads`]). `turnEnd` is that turn end, so the
//!   surface showing the chat can mark it read.
//!
//! Records live in memory, like the read markers they are compared with.

use std::collections::{BTreeMap, HashMap};

use parking_lot::Mutex;
use serde_json::{json, Value};

use crate::web::chat_reads::ReadMark;

/// A turn end: the `prompt_complete` seq in one log incarnation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnEnd {
    pub log_epoch: String,
    pub seq: u64,
}

impl TurnEnd {
    fn read_by(&self, mark: Option<&ReadMark>) -> bool {
        mark.is_some_and(|mark| mark.log_epoch == self.log_epoch && mark.seq >= self.seq)
    }
}

/// What every surface shows for one chat.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChatActivity {
    pub busy: bool,
    pub needs_you: bool,
    pub unread: bool,
    pub turn_end: Option<TurnEnd>,
}

impl ChatActivity {
    /// Nothing to show and no turn end to remember: the chat leaves the state.
    #[must_use]
    pub fn is_idle(&self) -> bool {
        !self.busy && !self.needs_you && !self.unread && self.turn_end.is_none()
    }

    /// The record inside the watch state: `{busy, needsYou, unread, turnEnd}`.
    #[must_use]
    pub fn to_record(&self) -> Value {
        json!({
            "busy": self.busy,
            "needsYou": self.needs_you,
            "unread": self.unread,
            "turnEnd": self.turn_end.as_ref().map(|end| json!({
                "seq": end.seq,
                "logEpoch": end.log_epoch,
            })),
        })
    }

    /// The watch delta: the record plus `sessionId`.
    #[must_use]
    pub fn to_wire(&self, session_id: &str) -> Value {
        let mut record = self.to_record();
        record["sessionId"] = json!(session_id);
        record
    }
}

/// A session event, as far as chat activity is concerned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActivityEvent {
    /// The host accepted a prompt (`user_prompt`).
    TurnOpened { agent_id: Option<String> },
    /// The turn ended (`prompt_complete`) at `end`.
    TurnEnded { end: Option<TurnEnd> },
    /// `agent_working` (work outside a prompt turn).
    Working {
        agent_id: Option<String>,
        working: bool,
    },
    /// `session_closed`: no process works on the chat any more.
    Closed,
    /// A pending prompt was raised or withdrawn: only `needsYou` can change.
    Prompt { agent_id: Option<String> },
}

impl ActivityEvent {
    /// The activity meaning of a session event of wire type `type_`. `end`
    /// gives the turn end a `prompt_complete` stands at.
    pub fn parse(
        type_: &str,
        payload: &Value,
        end: impl FnOnce() -> Option<TurnEnd>,
    ) -> Option<Self> {
        let agent_id = || {
            payload
                .get("agentId")
                .and_then(Value::as_str)
                .map(str::to_string)
        };
        match type_ {
            "user_prompt" => Some(Self::TurnOpened {
                agent_id: agent_id(),
            }),
            "prompt_complete" => Some(Self::TurnEnded { end: end() }),
            "agent_working" => Some(Self::Working {
                agent_id: agent_id(),
                working: payload
                    .get("working")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            }),
            "session_closed" => Some(Self::Closed),
            "permission_request"
            | "question_request"
            | "elicitation_request"
            | "question_cancelled" => Some(Self::Prompt {
                agent_id: agent_id(),
            }),
            _ => None,
        }
    }
}

/// The facts the relay saw for one chat, and the record last published.
#[derive(Debug, Default)]
struct Entry {
    agent_id: Option<String>,
    turn_open: bool,
    agent_working: bool,
    turn_end: Option<TurnEnd>,
    shown: ChatActivity,
}

impl Entry {
    fn apply(&mut self, event: ActivityEvent) {
        match event {
            ActivityEvent::TurnOpened { agent_id } => {
                self.agent_id = agent_id.or(self.agent_id.take());
                self.turn_open = true;
            }
            ActivityEvent::TurnEnded { end } => {
                self.turn_open = false;
                if end.is_some() {
                    self.turn_end = end;
                }
            }
            ActivityEvent::Working { agent_id, working } => {
                self.agent_id = agent_id.or(self.agent_id.take());
                self.agent_working = working;
            }
            ActivityEvent::Closed => {
                self.turn_open = false;
                self.agent_working = false;
            }
            ActivityEvent::Prompt { agent_id } => {
                self.agent_id = agent_id.or(self.agent_id.take());
            }
        }
    }

    fn derive(&self, needs_you: bool, read: Option<&ReadMark>) -> ChatActivity {
        ChatActivity {
            busy: self.turn_open || self.agent_working,
            needs_you,
            unread: self.turn_end.as_ref().is_some_and(|end| !end.read_by(read)),
            turn_end: self.turn_end.clone(),
        }
    }
}

#[derive(Default)]
struct Table {
    entries: HashMap<String, Entry>,
    /// The seq of the newest event applied per session. An event is numbered
    /// under the log lock but observed after it, so two threads can observe
    /// a session's events out of seq order: the older one is stale.
    applied: HashMap<String, u64>,
}

/// Per-session chat activity of one host.
#[derive(Default)]
pub struct ChatActivities {
    table: Mutex<Table>,
}

impl ChatActivities {
    /// Record `event`, numbered `seq`, for `session_id`, then re-derive its
    /// record. An event older than one already applied is ignored. `inputs`
    /// reads, under this table's lock, whether the session has a pending
    /// prompt and its read marker. Returns the record when it changed.
    pub fn observe(
        &self,
        session_id: &str,
        seq: u64,
        event: ActivityEvent,
        inputs: impl FnOnce() -> (bool, Option<ReadMark>),
    ) -> Option<ChatActivity> {
        let mut table = self.table.lock();
        let applied = table.applied.entry(session_id.to_string()).or_default();
        if *applied >= seq {
            return None;
        }
        *applied = seq;
        let entry = table.entries.entry(session_id.to_string()).or_default();
        entry.apply(event);
        Self::rederive(&mut table.entries, session_id, inputs)
    }

    /// Re-derive the record of `session_id` (a prompt answered, a read marker
    /// moved). Returns the record when it changed.
    pub fn refresh(
        &self,
        session_id: &str,
        inputs: impl FnOnce() -> (bool, Option<ReadMark>),
    ) -> Option<ChatActivity> {
        let mut table = self.table.lock();
        if !table.entries.contains_key(session_id) {
            return None;
        }
        Self::rederive(&mut table.entries, session_id, inputs)
    }

    fn rederive(
        entries: &mut HashMap<String, Entry>,
        session_id: &str,
        inputs: impl FnOnce() -> (bool, Option<ReadMark>),
    ) -> Option<ChatActivity> {
        let entry = entries.get_mut(session_id)?;
        let (needs_you, read) = inputs();
        let derived = entry.derive(needs_you, read.as_ref());
        let changed = derived != entry.shown;
        entry.shown = derived.clone();
        if derived.is_idle() {
            entries.remove(session_id);
        }
        changed.then_some(derived)
    }

    /// The agent `agent_id` is gone: none of its sessions works any more.
    /// Returns every session id the table holds, so the caller re-derives
    /// them all (the agent's pending prompts were released too).
    pub fn agent_ended(&self, agent_id: &str) -> Vec<String> {
        let mut table = self.table.lock();
        for entry in table.entries.values_mut() {
            if entry.agent_id.as_deref() == Some(agent_id) {
                entry.turn_open = false;
                entry.agent_working = false;
            }
        }
        table.entries.keys().cloned().collect()
    }

    /// The sessions currently shown as needing the user.
    #[must_use]
    pub fn needing_you(&self) -> Vec<String> {
        self.table
            .lock()
            .entries
            .iter()
            .filter(|(_, entry)| entry.shown.needs_you)
            .map(|(session_id, _)| session_id.clone())
            .collect()
    }

    /// Drop a deleted session. Returns whether it was shown as anything.
    pub fn forget(&self, session_id: &str) -> bool {
        let mut table = self.table.lock();
        table.applied.remove(session_id);
        table
            .entries
            .remove(session_id)
            .is_some_and(|entry| !entry.shown.is_idle())
    }

    /// The record of `session_id` as last derived (idle when unknown).
    #[must_use]
    pub fn get(&self, session_id: &str) -> ChatActivity {
        self.table
            .lock()
            .entries
            .get(session_id)
            .map(|entry| entry.shown.clone())
            .unwrap_or_default()
    }

    /// Every non-idle record, by session id.
    #[must_use]
    pub fn snapshot(&self) -> BTreeMap<String, ChatActivity> {
        self.table
            .lock()
            .entries
            .iter()
            .filter(|(_, entry)| !entry.shown.is_idle())
            .map(|(session_id, entry)| (session_id.clone(), entry.shown.clone()))
            .collect()
    }
}

#[cfg(test)]
#[path = "chat_activity_tests.rs"]
mod tests;
