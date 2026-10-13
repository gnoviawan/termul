//! What each watch observes: its full state for a new subscriber, and the
//! deltas the mutation sites publish.
//!
//! - `projects`: state = the project list + `defaultProjectId` (what
//!   `GET /projects` returns); a delta is the replacement state.
//! - `chat_history`: state = the persisted-session index summaries (what
//!   `list_persisted_sessions` returns); a delta is `{"changed": [sessionId]}`
//!   (an empty list means "the index changed in bulk"), and the client
//!   refetches. A worktree branch rename adds `"event":
//!   "worktree_branch_renamed"` and the rename as `"payload"` to the delta.
//! - `agents`: state = the live agent summaries; a delta is
//!   `{"event": "<agent event type>", "payload": <event payload>}` for an
//!   agent that spawned, crashed, failed or disconnected (a kill or an idle
//!   reap is announced as `agent_disconnected` with a `reason`). Applying a
//!   delta is idempotent, so one that overlaps a freshly read state does no
//!   harm.
//!   The transient `browser_open_request` (`{agentId, url}`) belongs to no
//!   session log either and rides the same delta shape; it is not part of the
//!   roster state.
//! - `fs` (scope = project id): state = `{root}`; a delta is `{root, paths}`
//!   for one debounced batch of changes, or `{ended, reason}` once the
//!   project is no longer watchable (the host releases the subscription).
//!   A `reset` state frame tells the client to refresh its trees.
//! - `store` (scope = key): state and delta = `{exists, value}`, the value
//!   the key holds after the write or delete.
//! - `terminals` (scope = project id): state and delta = `{terminals:
//!   [{terminalId, projectId, cwd, attached}]}`, the project's terminals
//!   (detached ones included), without claim credentials.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::acp::AcpManager;
use crate::pty::PtyManager;
use crate::web::project_registry::ProjectRegistry;
use crate::web::sink::WsRelaySink;
use crate::web::store::{unix_ms, Stamped, WebStore};
use crate::web::ws::{ClientIdentity, HistoryMode};

use super::WatchKind;

/// Agent-level event types the roster watch carries. They are not sent as
/// `seq = 0` events.
pub const AGENT_ROSTER_EVENTS: &[&str] = &[
    "agent_spawned",
    "agent_crashed",
    "agent_error",
    "agent_disconnected",
];

/// Agent-level events that are not roster changes but still belong to no
/// session log: they reach clients as `agents` deltas too (never as `seq = 0`
/// events). A missed one is not repaired by the state, as before.
pub const AGENT_TRANSIENT_EVENTS: &[&str] = &["browser_open_request"];

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

/// An agent-level lifecycle event happened: send it to every `agents`
/// subscriber. `type_` is one of [`AGENT_ROSTER_EVENTS`].
pub fn publish_agent_event(relay: &WsRelaySink, type_: &str, payload: &Value) {
    relay.watches().publish(WatchKind::Agents, "", || {
        json!({ "event": type_, "payload": payload })
    });
}

/// Full state of the `fs` watch: the canonical root being watched.
#[must_use]
pub fn fs_state(root: &std::path::Path) -> Value {
    json!({ "root": root.display().to_string() })
}

/// `{exists, value}` of `key` in the store, read for `identity`: the state and
/// delta of a `store` watch. An unreadable store reads as absent.
#[must_use]
pub fn store_state(store: &WebStore, key: &str, identity: &ClientIdentity) -> Value {
    match store.read(key, identity, unix_ms()) {
        Ok(Stamped {
            value: Some(value), ..
        }) => json!({ "exists": true, "value": value }),
        Ok(_) | Err(_) => json!({ "exists": false }),
    }
}

/// The key changed (written or deleted by `identity`): send every subscriber
/// the value the key holds now. The value is read under the hub lock, so the
/// last publish always carries the final value whatever order concurrent
/// writers publish in. Only a key every subscriber may read is watched: a
/// shared key, or the device key of the one device that holds it.
pub fn publish_store(
    relay: &WsRelaySink,
    store: &WebStore,
    key: &str,
    identity: &ClientIdentity,
) {
    relay
        .watches()
        .publish(WatchKind::Store, key, || store_state(store, key, identity));
}

/// Full state and delta of the `terminals` watch for `project_id`.
#[must_use]
pub fn terminals_state(pty: &PtyManager, project_id: &str) -> Value {
    json!({ "terminals": pty.terminal_set(project_id) })
}

/// The terminal set of `project_id` changed (spawn, kill, reap, attach or
/// detach): send every subscriber the set as it is now.
pub fn publish_terminals(relay: &WsRelaySink, pty: &PtyManager, project_id: &str) {
    relay
        .watches()
        .publish(WatchKind::Terminals, project_id, || {
            terminals_state(pty, project_id)
        });
}

/// A worktree branch was renamed: every `chat_history` subscriber learns the
/// index changed in bulk (the host rewrote `worktree_branch` on the sessions
/// of that worktree) and gets the rename itself under `event` / `payload`.
pub fn publish_worktree_branch_renamed(relay: &WsRelaySink, payload: &Value) {
    relay.watches().publish(WatchKind::ChatHistory, "", || {
        json!({
            "changed": Vec::<String>::new(),
            "event": "worktree_branch_renamed",
            "payload": payload,
        })
    });
}

/// Route every change of a project's terminal set to its `terminals` watchers.
/// The observer holds the manager weakly: the manager owns it.
pub fn attach_terminal_set_observer(pty: &Arc<PtyManager>, relay: &Arc<WsRelaySink>) {
    let observed_pty = Arc::downgrade(pty);
    let observed_relay = Arc::clone(relay);
    pty.set_terminal_set_observer(Arc::new(move |project_id| {
        if let Some(pty) = observed_pty.upgrade() {
            publish_terminals(&observed_relay, &pty, project_id);
        }
    }));
}
