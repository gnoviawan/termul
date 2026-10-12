//! Relay-level `seq = 0` broadcasts that are not session logs: the
//! `chat_history_changed` / `projects_changed` nudges clients answer by
//! refetching. They live apart from the session log so the watch hub can
//! retire them without touching the log path.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::web::project_registry::ProjectsChangedPayload;
use crate::web::watch::{publish_agent_event, publish_chat_history, AGENT_ROSTER_EVENTS};
use crate::web::ws::{tier_of, SequencedEvent};

use super::fanout::ClientId;
use super::{fan_out, EventSink, WsRelaySink};

impl WsRelaySink {
    /// CAP-2: history is now host-owned. When a session is created,
    /// finalized, or its title metadata changes at the host (regardless of
    /// which client drove it), notify every connected client so sidebars
    /// refetch the host index instead of depending on a desktop renderer
    /// save. `session_info_update` covers agent-supplied titles;
    /// `local_title_generated` covers background title generation. Only
    /// fires when durable persistence is attached (live-only mode has
    /// nothing to refetch).
    pub(super) fn notify_history_for(&self, sid: Option<&str>, type_: &str) {
        if self.persistence().is_some()
            && matches!(
                type_,
                "session_created"
                    | "session_closed"
                    | "session_info_update"
                    | "local_title_generated"
                    // CAP-2 (spec-in-chat-agent-switch): a durable switch
                    // marker mutates last_seq/last_activity_at, so the live
                    // fan-out triggers the same index refetch as a title
                    // change.
                    | "agent_switch"
                    // Story 16 (CAP-5): a worktree branch rename rewrites
                    // `worktree_branch` on every session of that worktree, so
                    // web clients refetch the index the same way.
                    | "worktree_branch_renamed"
            )
        {
            self.notify_history_changed();
            // The `chat_history` watch carries the same change, naming the session.
            let changed: Vec<&str> = sid.into_iter().collect();
            publish_chat_history(self, &changed);
        }
    }

    /// Agent-level lifecycle events (`agent_spawned`, `agent_crashed`,
    /// `agent_error`, `agent_disconnected`, no session) also go to the
    /// `agents` watch.
    pub(super) fn publish_agent_roster_event(&self, type_: &str, payload: &Value) {
        if AGENT_ROSTER_EVENTS.contains(&type_) {
            publish_agent_event(self, type_, payload);
        }
    }

    /// Agent-level `chat_history_changed` fan-out (mirrors
    /// `broadcast_chat_history_changed`, but callable from inside `emit` where
    /// no `Arc<Self>` is available). Empty payload; clients refetch the index.
    fn notify_history_changed(&self) {
        let type_ = "chat_history_changed";
        let se = SequencedEvent::new(None, 0, type_, json!({}));
        let tier = tier_of(type_);
        let targets: Vec<ClientId> = self.clients.lock().keys().copied().collect();
        for client_id in targets {
            self.enqueue(client_id, se.clone(), tier);
        }
    }
}

/// Broadcast a `projects_changed` agent-level event to every connected client.
///
/// Called by the `remote_sync_projects` command (desktop-hosted push — the
/// desktop's active IS the default) and the explicit `set_default_project`
/// operation (Tauri command + WS request + HTTP route) after they update the
/// [`crate::web::project_registry::ProjectRegistry`]. The event is agent-level
/// (`sid: None`, `seq: 0`) so [`WsRelaySink::emit`] fans it out to ALL connected
/// clients (the wire `type` is `projects_changed` — the `acp:` prefix is
/// stripped by `emit`). The payload carries only the new `defaultProjectId`;
/// the web client refetches `GET /projects` for the full list. On the initial
/// load a client seeds `activeProjectId` from `defaultProjectId`; on subsequent
/// events it preserves its own `activeProjectId` (no silent retarget).
///
/// `default_project_id` is `None` when the host has no default project.
pub fn broadcast_projects_changed(relay: &Arc<WsRelaySink>, default_project_id: Option<&str>) {
    // Use the typed `ProjectsChangedPayload` (single source of truth for the
    // wire shape) rather than hand-rolled `json!` — its `skip_serializing_if`
    // omits `defaultProjectId` when `None` (the web client ignores the payload
    // + refetches `GET /projects`, so omit-vs-null is cosmetic, but the
    // struct stays the canonical shape if fields are added later).
    let payload = ProjectsChangedPayload {
        default_project_id: default_project_id.map(str::to_string),
    };
    // Clone into a concrete `Arc<WsRelaySink>` first so `Arc::clone` infers
    // `T = WsRelaySink` (not `dyn EventSink`); the unsized coercion to
    // `Arc<dyn EventSink>` then happens at the vec push.
    let relay_arc: Arc<WsRelaySink> = Arc::clone(relay);
    let sinks: Vec<Arc<dyn EventSink>> = vec![relay_arc];
    fan_out(&sinks, None, "acp:projects_changed", &payload);
}

/// Broadcast a `chat_history_changed` agent-level event to every connected
/// client.
///
/// Called after desktop history mutations or compatibility sync requests. The event is
/// agent-level (`sid: None`, `seq: 0`) so [`WsRelaySink::emit`] fans it out to
/// ALL connected clients (the wire `type` is `chat_history_changed` — the
/// `acp:` prefix is stripped by `emit`). The payload is empty `{}`; the web
/// client refetches the session index (`list_persisted_sessions`) for the full
/// list (the desktop is the source of truth).
pub fn broadcast_chat_history_changed(relay: &Arc<WsRelaySink>) {
    let payload = serde_json::json!({});
    let relay_arc: Arc<WsRelaySink> = Arc::clone(relay);
    let sinks: Vec<Arc<dyn EventSink>> = vec![relay_arc];
    fan_out(&sinks, None, "acp:chat_history_changed", &payload);
}
