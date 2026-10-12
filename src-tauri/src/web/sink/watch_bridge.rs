//! Where the relay hands non-log state to the watch hub: index changes the
//! relay itself sees (session lifecycle, titles, switches) and agent
//! lifecycle events. The history nudge and the roster events are not sent as
//! `seq = 0` events any more (`worktree_branch_renamed` itself still is).

use serde_json::Value;

use crate::web::watch::{publish_agent_event, publish_chat_history, AGENT_ROSTER_EVENTS};

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
                    // Story 16 (CAP-5): a worktree branch rename rewrites
                    // `worktree_branch` on every session of that worktree.
                    | "worktree_branch_renamed"
            )
        {
            let changed: Vec<&str> = sid.into_iter().collect();
            publish_chat_history(self, &changed);
        }
    }

    /// Agent-level lifecycle events (`agent_spawned`, `agent_crashed`,
    /// `agent_error`, `agent_disconnected`, no session) go to the `agents`
    /// watch. Returns `true` when the event was one of them and has been
    /// handed to the hub (the caller must not also fan it out as `seq = 0`).
    pub(super) fn route_agent_event(&self, type_: &str, payload: &Value) -> bool {
        if !AGENT_ROSTER_EVENTS.contains(&type_) {
            return false;
        }
        publish_agent_event(self, type_, payload);
        true
    }
}
