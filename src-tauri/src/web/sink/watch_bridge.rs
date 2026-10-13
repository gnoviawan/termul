//! Where the relay hands non-log state to the watch hub: index changes the
//! relay itself sees (session lifecycle, titles, switches) and agent
//! lifecycle events. None of them is sent as a `seq = 0` event: the relay sends
//! no such event except the `auth_required` handshake frame.

use serde_json::Value;

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
