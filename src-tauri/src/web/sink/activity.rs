//! Where the relay keeps chat activity ([`crate::web::chat_activity`]) up to
//! date: every numbered session event, every pending-prompt change and read
//! marker move re-derives the session's record, and a changed record goes to
//! every `chat_activity` watcher.
//!
//! Lock order: the activity table is taken before the ticket tables and the
//! read markers it reads, and after the watch hub (whose state closure reads
//! it). Nothing here holds the table while calling into the hub.

use serde_json::Value;

use crate::web::chat_activity::{ActivityEvent, ChatActivity, TurnEnd};
use crate::web::chat_reads::ReadMark;
use crate::web::watch::publish_chat_activity;

use super::WsRelaySink;

impl WsRelaySink {
    /// The host-owned activity of every agent chat.
    #[must_use]
    pub fn chat_activity(&self) -> &crate::web::chat_activity::ChatActivities {
        &self.chat_activity
    }

    /// A session event was numbered at `seq`: fold it into the session's
    /// activity.
    pub(super) fn observe_activity(&self, sid: &str, type_: &str, payload: &Value, seq: u64) {
        let turn_end = || {
            self.log_head(sid).map(|head| TurnEnd {
                log_epoch: head.log_epoch,
                seq,
            })
        };
        let Some(event) = ActivityEvent::parse(type_, payload, turn_end) else {
            return;
        };
        let changed = self
            .chat_activity
            .observe(sid, seq, event, || self.activity_inputs(sid));
        self.announce_activity(sid, changed);
    }

    /// Re-derive the activity of `sid` (its read marker moved).
    pub fn refresh_chat_activity(&self, sid: &str) {
        let changed = self
            .chat_activity
            .refresh(sid, || self.activity_inputs(sid));
        self.announce_activity(sid, changed);
    }

    /// A pending prompt was answered: re-derive every session shown as
    /// needing the user.
    pub fn refresh_pending_chat_activity(&self) {
        for sid in self.chat_activity.needing_you() {
            self.refresh_chat_activity(&sid);
        }
    }

    /// The agent `agent_id` died: its sessions work on nothing and its
    /// pending prompts are gone.
    pub(super) fn end_agent_activity(&self, agent_id: &str) {
        for sid in self.chat_activity.agent_ended(agent_id) {
            self.refresh_chat_activity(&sid);
        }
    }

    /// The session was deleted: drop its record and tell the watchers.
    pub(super) fn forget_activity(&self, sid: &str) {
        if self.chat_activity.forget(sid) {
            tracing::info!(
                session = %crate::logging::redact_session_id(sid),
                "chat activity forgotten with its deleted session"
            );
            publish_chat_activity(self, sid);
        }
    }

    /// Whether `sid` has a pending prompt, and its read marker.
    fn activity_inputs(&self, sid: &str) -> (bool, Option<ReadMark>) {
        let permission = self
            .rendezvous()
            .is_some_and(|rendezvous| !rendezvous.pending_requests(sid).is_empty());
        let question = || {
            self.question_rendezvous()
                .is_some_and(|rendezvous| !rendezvous.pending_requests(sid).is_empty())
        };
        let elicitation = || !self.elicitations.pending_requests(sid).is_empty();
        let needs_you = permission || question() || elicitation();
        (needs_you, self.chat_reads.get(sid))
    }

    fn announce_activity(&self, sid: &str, changed: Option<ChatActivity>) {
        let Some(activity) = changed else {
            return;
        };
        tracing::debug!(
            session = %crate::logging::redact_session_id(sid),
            busy = activity.busy,
            needs_you = activity.needs_you,
            unread = activity.unread,
            "chat activity changed"
        );
        publish_chat_activity(self, sid);
    }
}
