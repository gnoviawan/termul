//! Where the relay hands non-log state to the watch hub: index changes the
//! relay itself sees (session lifecycle, titles, switches) and agent
//! lifecycle events. None of them is sent as a `seq = 0` event: the relay sends
//! no such event except the `auth_required` handshake frame.

use serde_json::Value;
use tracing::debug;

use crate::web::watch::{
    publish_agent_event, publish_chat_history, publish_worktree_branch_renamed,
    AGENT_ROSTER_EVENTS, AGENT_TRANSIENT_EVENTS,
};

use super::WsRelaySink;

impl WsRelaySink {
    /// CAP-2: history is host-owned. When a session is created, finalized, or
    /// its title metadata changes at the host (regardless of which client
    /// drove it), every `chat_history` watcher is told which session changed
    /// so sidebars refetch the host index. `session_info_update` covers
    /// agent-supplied titles; `local_title_generated` covers background title
    /// generation. Only fires when durable persistence is attached (live-only
    /// mode has nothing to refetch).
    pub(super) fn notify_history_for(&self, sid: Option<&str>, type_: &str) {
        if self.persistence().is_some()
            && matches!(
                type_,
                "session_created"
                    | "session_closed"
                    | "session_info_update"
                    | "local_title_generated"
                    // CAP-2 (spec-in-chat-agent-switch): a durable switch
                    // marker mutates last_seq/last_activity_at, so it changes
                    // the index like a title does.
                    | "agent_switch"
            )
        {
            let changed: Vec<&str> = sid.into_iter().collect();
            publish_chat_history(self, &changed);
        }
    }

    /// Issue #1727: whether `sid`'s durable index entry has no title yet, so
    /// the next `user_prompt` the writer appends derives it. `false` without
    /// persistence or for a session the catalog does not know.
    pub fn index_title_unset(&self, sid: &str) -> bool {
        self.persistence()
            .and_then(|persistence| persistence.metadata(sid).ok())
            .is_some_and(|metadata| metadata.title.is_none())
    }

    /// Issue #1727: the first `user_prompt` titles the session when the
    /// writer appends it, which is not an event `notify_history_for` sees.
    /// Call once that prompt is durable (after `flush_prompt_record`), with
    /// `was_untitled` read by [`Self::index_title_unset`] before the prompt
    /// was recorded. Publishes one `chat_history` delta only when the title
    /// went from unset to set, so later prompts never nudge the watchers.
    pub fn notify_prompt_title(&self, sid: &str, was_untitled: bool) {
        if !was_untitled {
            return;
        }
        let titled = self
            .persistence()
            .and_then(|persistence| persistence.metadata(sid).ok())
            .is_some_and(|metadata| metadata.title.is_some());
        if titled {
            debug!(
                "[history] first prompt titled session {}; notifying chat_history",
                crate::logging::redact_session_id(sid)
            );
            publish_chat_history(self, &[sid]);
        }
    }

    /// Agent-level events (no session) go to a watch, never out as `seq = 0`:
    /// lifecycle events (`agent_spawned`, `agent_crashed`, `agent_error`,
    /// `agent_disconnected`) and `browser_open_request` to the `agents` watch,
    /// `worktree_branch_renamed` to the `chat_history` watch (it rewrites
    /// `worktree_branch` on the sessions of that worktree). Returns `true` when
    /// the event was one of them and has been handed to the hub.
    pub(super) fn route_agent_event(&self, type_: &str, payload: &Value) -> bool {
        if AGENT_ROSTER_EVENTS.contains(&type_) || AGENT_TRANSIENT_EVENTS.contains(&type_) {
            publish_agent_event(self, type_, payload);
            return true;
        }
        if type_ == "worktree_branch_renamed" {
            publish_worktree_branch_renamed(self, payload);
            return true;
        }
        false
    }
}
