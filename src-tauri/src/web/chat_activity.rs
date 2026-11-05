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
    /// Nothing to show: the chat leaves the state. A turn end matters only
    /// while it is unread, so a read one is not remembered.
    #[must_use]
    pub fn is_idle(&self) -> bool {
        !self.busy && !self.needs_you && !self.unread
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
    /// The turn ended (`prompt_complete`).
    TurnEnded,
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
    /// The activity meaning of a session event of wire type `type_`.
    #[must_use]
    pub fn parse(type_: &str, payload: &Value) -> Option<Self> {
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
            "prompt_complete" => Some(Self::TurnEnded),
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

/// What a record is derived from besides the session's events, read under the
/// table's lock.
#[derive(Debug, Default)]
pub struct ActivityInputs {
    /// The session has a pending permission, question or elicitation.
    pub needs_you: bool,
    /// The session's read marker.
    pub read: Option<ReadMark>,
    /// The epoch the session's log stands under now. A turn end is stamped
    /// with it when derived, not when observed: a turn can end under a
    /// placeholder epoch before persistence registers the session, and the
    /// seqs carry over to the persisted epoch it adopts.
    pub log_epoch: Option<String>,
}

/// The facts the relay saw for one chat, and the record last published.
#[derive(Debug, Default)]
struct Entry {
    agent_id: Option<String>,
    turn_open: bool,
    agent_working: bool,
    /// The seq of the newest `prompt_complete`.
    turn_end: Option<u64>,
    shown: ChatActivity,
}

impl Entry {
    fn apply(&mut self, event: ActivityEvent, seq: u64) {
        match event {
            ActivityEvent::TurnOpened { agent_id } => {
                self.take_over(agent_id);
                self.turn_open = true;
            }
            ActivityEvent::TurnEnded => {
                self.turn_open = false;
                self.turn_end = Some(seq);
            }
            // A chat resumed on another live agent: the previous agent can
            // still report its work on the chat ended, which is not the new
            // agent's work.
            ActivityEvent::Working { agent_id, working } => {
                if working || self.owned_by(agent_id.as_deref()) {
                    self.take_over(agent_id);
                    self.agent_working = working;
                }
            }
            ActivityEvent::Closed => {
                self.turn_open = false;
                self.agent_working = false;
            }
            // A prompt does not show which agent the chat moved to: a
            // previous agent can still withdraw one.
            ActivityEvent::Prompt { agent_id } => {
                if self.agent_id.is_none() {
                    self.agent_id = agent_id;
                }
            }
        }
    }

    fn owned_by(&self, agent_id: Option<&str>) -> bool {
        match (self.agent_id.as_deref(), agent_id) {
            (Some(owner), Some(agent_id)) => owner == agent_id,
            _ => true,
        }
    }

    /// `agent_id` works on the chat now. When it is not the owner, the chat
    /// moved to it, and the previous agent's work outside a turn ended.
    fn take_over(&mut self, agent_id: Option<String>) {
        let Some(agent_id) = agent_id else {
            return;
        };
        if !self.owned_by(Some(&agent_id)) {
            self.agent_working = false;
        }
        self.agent_id = Some(agent_id);
    }

    fn derive(&self, inputs: ActivityInputs) -> ChatActivity {
        let turn_end = self
            .turn_end
            .zip(inputs.log_epoch)
            .map(|(seq, log_epoch)| TurnEnd { log_epoch, seq });
        ChatActivity {
            busy: self.turn_open || self.agent_working,
            needs_you: inputs.needs_you,
            unread: turn_end
                .as_ref()
                .is_some_and(|end| !end.read_by(inputs.read.as_ref())),
            turn_end,
        }
    }
}

/// Where a deleted session's applied seq stands: past every event, so an
/// agent's late event cannot bring the chat back.
const DELETED: u64 = u64::MAX;

#[derive(Default)]
struct Table {
    entries: HashMap<String, Entry>,
    /// The seq of the newest event applied per session. An event is numbered
    /// under the log lock but observed after it, so two threads can observe
    /// a session's events out of seq order: the older one is stale. A deleted
    /// session stands at [`DELETED`].
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
    /// is read under this table's lock. Returns the record when it changed.
    pub fn observe(
        &self,
        session_id: &str,
        seq: u64,
        event: ActivityEvent,
        inputs: impl FnOnce() -> ActivityInputs,
    ) -> Option<ChatActivity> {
        let mut table = self.table.lock();
        let applied = table.applied.entry(session_id.to_string()).or_default();
        if *applied >= seq {
            return None;
        }
        *applied = seq;
        let entry = table.entries.entry(session_id.to_string()).or_default();
        entry.apply(event, seq);
        Self::rederive(&mut table.entries, session_id, inputs)
    }

    /// Re-derive the record of `session_id` (a prompt answered, a read marker
    /// moved, the log epoch adopted). Returns the record when it changed.
    pub fn refresh(
        &self,
        session_id: &str,
        inputs: impl FnOnce() -> ActivityInputs,
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
        inputs: impl FnOnce() -> ActivityInputs,
    ) -> Option<ChatActivity> {
        let entry = entries.get_mut(session_id)?;
        let derived = entry.derive(inputs());
        let changed = derived != entry.shown;
        entry.shown = derived.clone();
        if derived.is_idle() {
            entries.remove(session_id);
        }
        changed.then_some(derived)
    }

    /// The agent `agent_id` is gone: none of its sessions works any more.
    /// Returns those sessions, for the caller to re-derive.
    pub fn agent_ended(&self, agent_id: &str) -> Vec<String> {
        let mut table = self.table.lock();
        table
            .entries
            .iter_mut()
            .filter(|(_, entry)| entry.agent_id.as_deref() == Some(agent_id))
            .map(|(session_id, entry)| {
                entry.turn_open = false;
                entry.agent_working = false;
                session_id.clone()
            })
            .collect()
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

    /// Drop a deleted session and ignore its later events. Returns whether it
    /// was shown as anything.
    pub fn forget(&self, session_id: &str) -> bool {
        let mut table = self.table.lock();
        table.applied.insert(session_id.to_string(), DELETED);
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
