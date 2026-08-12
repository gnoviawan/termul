//! Host-injected `termul_plan` MCP tool — first-class plan UI for every ACP agent.
//!
//! Termul auto-injects a host-side MCP server into every `session/new`
//! `mcp_servers` list (see `AcpManager::new_session_with_context`). The agent
//! discovers it like any MCP tool and calls it instead of a built-in todo
//! tool. When called, the host updates a per-session plan cache and emits a
//! synthetic `acp:plan_update` event via `events::fan_out` so the existing
//! renderer `PlanPanel` renders it — no translation of agents' own tools.
//!
//! Architecture (see `spec-acp-host-todo-plan-tool.md`):
//! - `parent` — in-process TCP listener on `127.0.0.1:<ephemeral>` (one shared
//!   across sessions, started lazily). Per-call frame: `{token, session_id,
//!   todos}`; verifies the token, maps todos → `PlanEntry`, emits the event.
//! - `child` — `--internal-mcp-plan-server` subcommand entrypoint. The agent
//!   spawns `current_exe()` with this flag (the McpServer::Stdio config built
//!   in `new_session_with_context`). Runs an rmcp MCP SERVER over stdio
//!   exposing `termul_plan`; on each call, opens a fresh TCP connection to the
//!   parent, forwards the input, returns the parent's reply.
//!
//! Desktop + standalone parity: no `tauri-plugin-mcp-bridge` / `AppHandle` —
//! pure `rmcp` + tokio, works on both binaries.

pub mod child;
pub mod parent;

use std::collections::HashMap;
use std::sync::Arc;

use agent_client_protocol::schema::v1::{Plan, PlanEntry, PlanEntryPriority, PlanEntryStatus};
use parking_lot::Mutex;
use rmcp::schemars;
use serde::{Deserialize, Serialize};

use crate::acp::config::{AgentId, SessionId};
use crate::acp::events::{self, PlanUpdateEvent};
use crate::web::EventSink;

/// The MCP tool names the agent sees in `tools/list`.
pub const TERMUL_PLAN_TOOL_NAME: &str = "termul_plan";
pub const TERMUL_SET_TITLE_TOOL_NAME: &str = "termul_set_session_title";

/// Human-readable descriptions shown to the agent in `tools/list`.
pub const TERMUL_PLAN_TOOL_DESCRIPTION: &str = "Update the execution plan / todo list shown \
    in the Termul plan panel. Call this instead of a built-in todo tool so the user sees a \
    unified plan UI across all agents.";
pub const TERMUL_SET_TITLE_TOOL_DESCRIPTION: &str = "Set a concise title for the current \
    Termul chat session. Call this during the first turn as soon as the user's intent is clear.";

/// The hidden subcommand flag the child detects in argv (passed as the sole
/// arg of the injected `McpServer::Stdio`). The agent spawns
/// `current_exe() --internal-mcp-plan-server` with the connection info in env.
pub const CHILD_ARG: &str = "--internal-mcp-plan-server";

/// True when the current process was spawned as the host-injected plan child
/// (the agent spawned `current_exe() --internal-mcp-plan-server`). Used by
/// BOTH binaries' `main` to branch BEFORE Tauri/app init. Matches the flag at
/// ANY position in argv (the standalone binary collects args into a Vec, the
/// desktop binary reads `args().nth(1)` — this helper unifies the rule so the
/// two entrypoints can't drift).
#[must_use]
pub fn is_child_invocation() -> bool {
    std::env::args().skip(1).any(|arg| arg == CHILD_ARG)
}

/// Env vars set on the injected `McpServer::Stdio` (carrying connection info
/// to the child). Prefixed `TERMUL_PLAN_` to avoid collisions with agent env.
pub const ENV_PORT: &str = "TERMUL_PLAN_PORT";
pub const ENV_TOKEN: &str = "TERMUL_PLAN_TOKEN";
pub const ENV_SESSION_ID: &str = "TERMUL_PLAN_SESSION_ID";
pub const ENV_AGENT_ID: &str = "TERMUL_PLAN_AGENT_ID";

/// Input the agent sends to `termul_plan` (the `arguments` of `tools/call`).
/// Also re-used as the parent–child TCP frame body (one todo per plan entry).
#[derive(Debug, Clone, Deserialize, Serialize, schemars::JsonSchema)]
pub struct TermulPlanInput {
    /// The complete list of plan entries — each update is a FULL REPLACE
    /// (matches the ACP `plan_update` semantics the renderer already enforces).
    pub todos: Vec<TermulPlanTodo>,
}

/// Input the agent sends to `termul_set_session_title`.
#[derive(Debug, Clone, Deserialize, Serialize, schemars::JsonSchema)]
pub struct TermulSetTitleInput {
    /// Concise title for the current chat session.
    pub title: String,
}

/// One todo item. `status`/`priority` are optional strings (the agent may omit
/// them); the host maps unknown/absent values to ACP defaults.
#[derive(Debug, Clone, Deserialize, Serialize, schemars::JsonSchema)]
pub struct TermulPlanTodo {
    /// Human-readable description of the task.
    pub content: String,
    /// Optional status: `"pending"` | `"in_progress"` | `"completed"`.
    /// Unknown/absent → `Pending`.
    #[serde(default)]
    pub status: Option<String>,
    /// Optional priority: `"high"` | `"medium"` | `"low"`.
    /// Unknown/absent → `Low`.
    #[serde(default)]
    pub priority: Option<String>,
}

/// Parent-bound TCP frame. One frame per connection (request/response).
/// Carries a `session_id` that is a HOST-GENERATED PROVISIONAL id (not the
/// real ACP session_id, which the agent generates during `session/new` and the
/// host doesn't know at injection time). The parent binds the provisional id
/// → real `session_id` after the `session/new` response arrives, then emits
/// the plan_update for the real id. The `token` authenticates the child.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FrameKind {
    #[default]
    Plan,
    SetTitle,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FrameRequest {
    pub token: String,
    pub session_id: String,
    #[serde(default)]
    pub kind: FrameKind,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub todos: Vec<TermulPlanTodo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// Parent reply frame (one per connection).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FrameReply {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl FrameReply {
    #[must_use]
    pub fn ok() -> Self {
        Self {
            ok: true,
            error: None,
        }
    }

    #[must_use]
    pub fn err(msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(msg.into()),
        }
    }
}

/// Map the agent's todo input → ACP `PlanEntry` list, preserving order.
/// Unknown `status`/`priority` strings fall back to `Pending`/`Low` (the ACP
/// enums are `#[non_exhaustive]`; only the three named variants are produced).
#[must_use]
pub fn map_todos_to_plan_entries(todos: &[TermulPlanTodo]) -> Vec<PlanEntry> {
    todos
        .iter()
        .map(|todo| {
            let priority = match todo
                .priority
                .as_deref()
                .map(str::trim)
                .unwrap_or("")
                .to_ascii_lowercase()
                .as_str()
            {
                "high" => PlanEntryPriority::High,
                "medium" => PlanEntryPriority::Medium,
                _ => PlanEntryPriority::Low,
            };
            let status = match todo
                .status
                .as_deref()
                .map(str::trim)
                .unwrap_or("")
                .to_ascii_lowercase()
                .as_str()
            {
                "in_progress" | "inprogress" | "in-progress" => PlanEntryStatus::InProgress,
                "completed" | "done" | "complete" => PlanEntryStatus::Completed,
                _ => PlanEntryStatus::Pending,
            };
            PlanEntry::new(todo.content.clone(), priority, status)
        })
        .collect()
}

/// In-memory plan cache (per session). v1 is emit-and-cache; durable
/// persistence across resume is deferred (Ask First). Kept as a seam so a
/// future persistence layer can read the latest plan without re-deriving it.
#[derive(Default)]
pub struct PlanStore {
    inner: Mutex<HashMap<String, Vec<PlanEntry>>>,
}

impl PlanStore {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Replace the cached plan for a session (full-replace semantics).
    pub fn set(&self, session_id: &str, entries: Vec<PlanEntry>) {
        self.inner.lock().insert(session_id.to_string(), entries);
    }

    /// Read the cached plan for a session (clone).
    #[must_use]
    pub fn get(&self, session_id: &str) -> Option<Vec<PlanEntry>> {
        self.inner.lock().get(session_id).cloned()
    }

    /// Drop the cached plan for a session (on close/dispose).
    pub fn drop_session(&self, session_id: &str) {
        self.inner.lock().remove(session_id);
    }
}

/// Emit a synthetic `acp:plan_update` for a session. Respects the empty-entries
/// = clear contract: passing `entries: vec![]` emits a `Plan` with an empty
/// list, which the renderer's `_onPlanUpdate` maps to `dropPlanForSession`.
///
/// `agent_id` is the Termul-side `AgentId` (used for the wire event payload);
/// the renderer keys plan state by `session_id`.
pub fn emit_plan_update(
    sinks: &[Arc<dyn EventSink>],
    agent_id: &AgentId,
    session_id: &SessionId,
    entries: Vec<PlanEntry>,
) {
    let plan = Plan::new(entries);
    let event = PlanUpdateEvent {
        agent_id: agent_id.clone(),
        session_id: session_id.clone(),
        plan,
    };
    events::fan_out(
        sinks,
        Some(session_id.0.as_str()),
        events::EVENT_PLAN_UPDATE,
        &event,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::web::sink::AcpEvent;
    use serde_json::Value;
    use std::sync::Mutex as StdMutex;

    /// Test sink that captures every emitted event (for plan_update assertions).
    #[derive(Default)]
    struct CapturingSink {
        events: StdMutex<Vec<(String, Value)>>,
    }

    impl EventSink for CapturingSink {
        fn emit(&self, event: &AcpEvent) {
            let type_ = event.type_.to_string();
            let payload = event.payload.clone();
            self.events.lock().unwrap().push((type_, payload));
        }
    }

    fn make_ids() -> (AgentId, SessionId) {
        (AgentId::new(), SessionId::new("sess-test"))
    }

    #[test]
    fn map_todos_preserves_order_and_maps_status_priority() {
        let todos = vec![
            TermulPlanTodo {
                content: "a".into(),
                status: Some("in_progress".into()),
                priority: Some("high".into()),
            },
            TermulPlanTodo {
                content: "b".into(),
                status: Some("completed".into()),
                priority: Some("medium".into()),
            },
            TermulPlanTodo {
                content: "c".into(),
                status: None,
                priority: None,
            },
        ];
        let entries = map_todos_to_plan_entries(&todos);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].content, "a");
        assert_eq!(entries[0].status, PlanEntryStatus::InProgress);
        assert_eq!(entries[0].priority, PlanEntryPriority::High);
        assert_eq!(entries[1].status, PlanEntryStatus::Completed);
        assert_eq!(entries[1].priority, PlanEntryPriority::Medium);
        // Defaults: Pending + Low.
        assert_eq!(entries[2].status, PlanEntryStatus::Pending);
        assert_eq!(entries[2].priority, PlanEntryPriority::Low);
    }

    #[test]
    fn map_todos_unknown_status_priority_falls_back() {
        let todos = vec![TermulPlanTodo {
            content: "x".into(),
            status: Some("bogus".into()),
            priority: Some("nope".into()),
        }];
        let entries = map_todos_to_plan_entries(&todos);
        assert_eq!(entries[0].status, PlanEntryStatus::Pending);
        assert_eq!(entries[0].priority, PlanEntryPriority::Low);
    }

    #[test]
    fn emit_plan_update_fires_event_with_entries() {
        let sink = Arc::new(CapturingSink::default());
        let sinks: Vec<Arc<dyn EventSink>> = vec![sink.clone()];
        let (agent_id, session_id) = make_ids();
        let todos = vec![
            TermulPlanTodo {
                content: "one".into(),
                status: None,
                priority: None,
            },
            TermulPlanTodo {
                content: "two".into(),
                status: None,
                priority: None,
            },
            TermulPlanTodo {
                content: "three".into(),
                status: None,
                priority: None,
            },
        ];
        let entries = map_todos_to_plan_entries(&todos);
        emit_plan_update(&sinks, &agent_id, &session_id, entries);

        let captured = sink.events.lock().unwrap();
        assert_eq!(captured.len(), 1);
        let (type_, payload) = &captured[0];
        assert_eq!(type_, events::EVENT_PLAN_UPDATE);
        assert_eq!(payload["agentId"], agent_id.0);
        assert_eq!(payload["sessionId"], session_id.0);
        assert_eq!(payload["plan"]["entries"].as_array().unwrap().len(), 3);
        assert_eq!(payload["plan"]["entries"][0]["content"], "one");
    }

    #[test]
    fn emit_plan_update_empty_entries_emits_clear() {
        // The renderer's `_onPlanUpdate` treats `entries.length === 0` as
        // "clear the plan" (dropPlanForSession). Verify the host emits exactly
        // that shape for an empty todos list.
        let sink = Arc::new(CapturingSink::default());
        let sinks: Vec<Arc<dyn EventSink>> = vec![sink.clone()];
        let (agent_id, session_id) = make_ids();
        emit_plan_update(&sinks, &agent_id, &session_id, vec![]);

        let captured = sink.events.lock().unwrap();
        assert_eq!(captured.len(), 1);
        let (type_, payload) = &captured[0];
        assert_eq!(type_, events::EVENT_PLAN_UPDATE);
        let entries = payload["plan"]["entries"].as_array().unwrap();
        assert!(
            entries.is_empty(),
            "empty todos must emit an empty entries array"
        );
    }

    #[test]
    fn title_frame_round_trips_with_kind_and_title() {
        let frame = FrameRequest {
            token: "token".into(),
            session_id: "provisional".into(),
            kind: FrameKind::SetTitle,
            todos: Vec::new(),
            title: Some("Fix login bug".into()),
        };
        let value = serde_json::to_value(&frame).unwrap();
        assert_eq!(value["kind"], "set_title");
        assert_eq!(value["title"], "Fix login bug");
        let decoded: FrameRequest = serde_json::from_value(value).unwrap();
        assert_eq!(decoded.kind, FrameKind::SetTitle);
        assert_eq!(decoded.title.as_deref(), Some("Fix login bug"));
    }

    #[test]
    fn frame_reply_serializes_ok_and_err() {
        let ok = serde_json::to_value(FrameReply::ok()).unwrap();
        assert_eq!(ok["ok"], true);
        assert!(ok.get("error").is_none() || ok["error"].is_null());

        let err = serde_json::to_value(FrameReply::err("auth rejected")).unwrap();
        assert_eq!(err["ok"], false);
        assert_eq!(err["error"], "auth rejected");
    }
}
