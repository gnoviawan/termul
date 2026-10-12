//! What each watch observes: its full state for a new subscriber, and the
//! deltas the mutation sites publish.
//!
//! - `projects`: state = the project list + `defaultProjectId` (what
//!   `GET /projects` returns); a delta is the replacement state.
//! - `chat_history`: state = the persisted-session index summaries (what
//!   `list_persisted_sessions` returns); a delta is `{"changed": [sessionId]}`
//!   (an empty list means "the index changed in bulk"), and the client
//!   refetches.
//! - `agents`: state = the live agent summaries; a delta is
//!   `{"event": "<agent event type>", "payload": <event payload>}` for an
//!   agent that spawned, crashed, failed or disconnected, or
//!   `{"event": "agent_removed", "payload": {"agentId"}}` for one removed by an
//!   intentional kill (which emits no lifecycle event). Applying a delta is
//!   idempotent, so one that overlaps a freshly read state does no harm.

use serde_json::{json, Value};

use crate::acp::AcpManager;
use crate::web::project_registry::ProjectRegistry;
use crate::web::sink::WsRelaySink;
use crate::web::ws::HistoryMode;

use super::WatchKind;

/// Agent-level event types the roster watch carries. They are no longer sent
/// as `seq = 0` events.
pub const AGENT_ROSTER_EVENTS: &[&str] = &[
    "agent_spawned",
    "agent_crashed",
    "agent_error",
    "agent_disconnected",
];

/// Full state of the `projects` watch.
#[must_use]
pub fn projects_state(registry: &ProjectRegistry) -> Value {
    serde_json::to_value(registry.snapshot()).unwrap_or_else(|_| json!({ "projects": [] }))
}

/// Full state of the `chat_history` watch: the index a `list_persisted_sessions`
/// reply carries, empty when the host keeps no durable history.
#[must_use]
pub fn chat_history_state(relay: &WsRelaySink, history_mode: HistoryMode) -> Value {
    let entries = match (history_mode, relay.persistence()) {
        (HistoryMode::Server, Some(persistence)) => persistence.list_sessions(),
        _ => Vec::new(),
    };
    serde_json::to_value(entries).unwrap_or_else(|_| json!([]))
}

/// Full state of the `agents` watch: the live agent summaries.
#[must_use]
pub fn agents_state(acp: &AcpManager) -> Value {
    serde_json::to_value(acp.list_agent_summaries()).unwrap_or_else(|_| json!([]))
}

/// The registry changed: send every `projects` subscriber the new state. The
/// state is read under the hub lock, so the last publish always carries the
/// final registry.
pub fn publish_projects(relay: &WsRelaySink, registry: &ProjectRegistry) {
    relay
        .watches()
        .publish(WatchKind::Projects, "", || projects_state(registry));
}

/// The persisted-session index changed for `changed` (empty: in bulk).
pub fn publish_chat_history(relay: &WsRelaySink, changed: &[&str]) {
    relay.watches().publish(WatchKind::ChatHistory, "", || {
        json!({ "changed": changed })
    });
}

/// An agent was removed from the roster by an intentional kill, which emits no
/// lifecycle event: the delta is `{"event": "agent_removed", "payload":
/// {"agentId": ...}}`.
pub fn publish_agent_removed(relay: &WsRelaySink, agent_id: &str) {
    relay.watches().publish(WatchKind::Agents, "", || {
        json!({ "event": "agent_removed", "payload": { "agentId": agent_id } })
    });
}

/// An agent-level lifecycle event happened: send it to every `agents`
/// subscriber. `type_` is one of [`AGENT_ROSTER_EVENTS`].
pub fn publish_agent_event(relay: &WsRelaySink, type_: &str, payload: &Value) {
    relay.watches().publish(WatchKind::Agents, "", || {
        json!({ "event": type_, "payload": payload })
    });
}
