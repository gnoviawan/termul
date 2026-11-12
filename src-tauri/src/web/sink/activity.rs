//! Where the relay keeps chat activity ([`crate::web::chat_activity`]) up to
//! date: every numbered session event, every pending-prompt change and read
//! marker move re-derives the session's record, and a changed record goes to
//! every `chat_activity` watcher.
//!
//! Lock order: the activity table is taken before the ticket tables, the
//! read markers and the persisted session catalog it reads, and after the
//! watch hub (whose state closure reads it). Nothing here holds the table
//! while calling into the hub.

use serde_json::Value;

use crate::web::chat_activity::{ActivityEvent, ActivityInputs, ChatActivity};
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
        let Some(event) = ActivityEvent::parse(type_, payload) else {
            return;
        };
        let changed = self
            .chat_activity
            .observe(sid, seq, event, || self.activity_inputs(sid));
        self.announce_activity(sid, changed);
    }

    /// Re-derive the activity of `sid` (its read marker moved, its log
    /// adopted the persisted epoch).
    pub fn refresh_chat_activity(&self, sid: &str) {
        let changed = self
            .chat_activity
            .refresh(sid, || self.activity_inputs(sid));
        self.announce_activity(sid, changed);
    }

    /// A pending prompt was answered or released: re-derive every session
    /// shown as needing the user.
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

    /// The session was deleted: drop its record and read marker, and tell the
    /// watchers.
    pub(super) fn forget_activity(&self, sid: &str) {
        self.chat_reads.forget(sid);
        if self.chat_activity.forget(sid) {
            tracing::info!(
                session = %crate::logging::redact_session_id(sid),
                "chat activity forgotten with its deleted session"
            );
            publish_chat_activity(self, sid);
        }
    }

    /// Drop the activity record of a chat deleted through the desktop command.
    /// Activity-only: does not release tickets or rendezvous (unlike
    /// [`Self::forget_session`]).
    pub fn forget_chat_activity(&self, sid: &str) {
        self.forget_activity(sid);
    }

    /// Whether `sid` has a pending prompt, its read marker, its log epoch and
    /// its project.
    fn activity_inputs(&self, sid: &str) -> ActivityInputs {
        let permission = self
            .rendezvous()
            .is_some_and(|rendezvous| !rendezvous.pending_requests(sid).is_empty());
        let question = || {
            self.question_rendezvous()
                .is_some_and(|rendezvous| !rendezvous.pending_requests(sid).is_empty())
        };
        let elicitation = || !self.elicitations.pending_requests(sid).is_empty();
        let project_id = self
            .persistence
            .as_ref()
            .and_then(|persistence| persistence.metadata(sid).ok())
            .and_then(|metadata| metadata.project_id);
        ActivityInputs {
            needs_you: permission || question() || elicitation(),
            read: self.chat_reads.get(sid),
            log_epoch: self.log_head(sid).map(|head| head.log_epoch),
            project_id,
        }
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
