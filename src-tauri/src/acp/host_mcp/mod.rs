//! Host-injected `plan` MCP tool — first-class plan UI for every ACP agent.
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
//!   exposing `plan`; on each call, opens a fresh TCP connection to the
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

/// Input the agent sends to `plan` (the `arguments` of `tools/call`).
/// Also re-used as the parent–child TCP frame body (one todo per plan entry).
#[derive(Debug, Clone, Deserialize, Serialize, schemars::JsonSchema)]
pub struct TermulPlanInput {
    /// The complete list of plan entries — each update is a FULL REPLACE
    /// (matches the ACP `plan_update` semantics the renderer already enforces).
    pub todos: Vec<TermulPlanTodo>,
}

/// Input the agent sends to `set_session_title`.
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
    /// `browser` tool call — action + args forwarded to
    /// `browser_automation::dispatch`; the reply carries `result`/`code`.
    Browser,
}

/// Input the agent sends to the `browser` tool. `action` selects the verb;
/// `args` holds verb-specific fields; `element` is the agent-stated intent
/// (e.g. "the login button") surfaced in consent/audit UI.
///
/// Agents send parameters in BOTH wire forms (the tool description documents
/// both): nested under `args` (the schema shape) or flat at the tool-call top
/// level. The custom `Deserialize` folds unknown top-level keys into `args` —
/// a nested `args` object wins on key conflicts — and rejects a non-object
/// `args` (e.g. a JSON string) with a typed `invalid_params` error naming the
/// action's expected field. `element` is a known top-level field (consent
/// context); one nested under `args` is hoisted to it when the top-level
/// field is absent.
#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
pub struct TermulBrowserInput {
    /// Action verb: navigate | snapshot | screenshot | click | fill | type |
    /// press | scroll | hover | wait | new_tab | list_tabs | close_tab |
    /// back | forward | reload.
    pub action: String,
    /// Action-specific args (url, ref, value, key, tabId, ms, text, dy…).
    #[serde(default)]
    pub args: serde_json::Value,
    /// Optional human-readable intent for mutating actions.
    #[serde(default)]
    pub element: Option<String>,
}

/// Fields an action reads from `args` — names the expected keys in
/// `invalid_params` messages so a mis-shaped call is diagnosable. Covers
/// every documented action; unknown verbs keep a generic answer.
fn expected_arg_fields(action: &str) -> &'static str {
    match action {
        "navigate" | "new_tab" => "'url'",
        "wait" => "'ms' or 'text'",
        "fill" => "'ref' and 'value'",
        "click" => "'ref' (optional 'tabId')",
        "hover" => "'ref'",
        "type" => "'text' (optional 'ref')",
        "press" => "'key'",
        "scroll" => "'dy' or 'ref'",
        "back" | "forward" | "reload" | "close_tab" => "'tabId' (optional)",
        "snapshot" | "screenshot" => "'tabId' (optional)",
        "list_tabs" => "no arguments",
        _ => "action-specific fields",
    }
}

fn json_type_name(value: &serde_json::Value) -> &'static str {
    match value {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "a boolean",
        serde_json::Value::Number(_) => "a number",
        serde_json::Value::String(_) => "a string",
        serde_json::Value::Array(_) => "an array",
        serde_json::Value::Object(_) => "an object",
    }
}

/// Typed rejection for a non-object `args` (e.g. a JSON string) — names the
/// action's expected field so the mis-shaped call is diagnosable.
fn non_object_args_error(action: &str, expected: &str, kind: &str) -> String {
    format!("invalid_params: 'args' must be a JSON object, not {kind} — {action} needs {expected}")
}

impl<'de> Deserialize<'de> for TermulBrowserInput {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        // Rejection logs carry the wire error code, the action, and the
        // expected field names ONLY — never argument values (CWE-532).
        let mut map = match serde_json::Value::deserialize(deserializer)? {
            serde_json::Value::Object(map) => map,
            serde_json::Value::Null => serde_json::Map::new(),
            other => {
                log::warn!(
                    "[host-mcp] browser input rejected [invalid_params]: body must be a JSON object, not {}",
                    json_type_name(&other)
                );
                return Err(serde::de::Error::custom(format!(
                    "invalid_params: browser input must be a JSON object, not {}",
                    json_type_name(&other)
                )));
            }
        };
        // Extract `action` first so later errors can name its expected args.
        let action = match map.remove("action") {
            Some(serde_json::Value::String(action)) => action,
            Some(other) => {
                log::warn!(
                    "[host-mcp] browser input rejected [invalid_params]: 'action' must be a string, not {}",
                    json_type_name(&other)
                );
                return Err(serde::de::Error::custom(format!(
                    "invalid_params: 'action' must be a string, not {}",
                    json_type_name(&other)
                )));
            }
            None => {
                log::warn!("[host-mcp] browser input rejected [invalid_params]: missing 'action'");
                return Err(serde::de::Error::custom("invalid_params: missing 'action'"));
            }
        };
        let element = match map.remove("element") {
            None | Some(serde_json::Value::Null) => None,
            Some(serde_json::Value::String(element)) => Some(element),
            Some(other) => {
                log::warn!(
                    "[host-mcp] browser input rejected [invalid_params]: 'element' must be a string, not {}",
                    json_type_name(&other)
                );
                return Err(serde::de::Error::custom(format!(
                    "invalid_params: 'element' must be a string, not {}",
                    json_type_name(&other)
                )));
            }
        };
        let expected = expected_arg_fields(&action);
        let mut args = match map.remove("args") {
            None | Some(serde_json::Value::Null) => serde_json::Map::new(),
            Some(serde_json::Value::Object(args)) => args,
            Some(other) => {
                log::warn!(
                    "[host-mcp] browser input rejected [invalid_params]: 'args' must be a JSON object, action={action} expected={expected}"
                );
                return Err(serde::de::Error::custom(non_object_args_error(
                    &action,
                    expected,
                    json_type_name(&other),
                )));
            }
        };
        // Fold the remaining (unknown) top-level keys into `args`; a value
        // already present from the nested `args` object wins.
        for (key, value) in map {
            args.entry(key).or_insert(value);
        }
        // Consent context may also arrive nested under `args` — hoist it to
        // the top-level `element` when that is absent (string values only).
        let element = match element {
            Some(element) => Some(element),
            None => match args.remove("element") {
                None | Some(serde_json::Value::Null) => None,
                Some(serde_json::Value::String(element)) => Some(element),
                Some(other) => {
                    log::warn!(
                        "[host-mcp] browser input rejected [invalid_params]: 'element' must be a string, not {}",
                        json_type_name(&other)
                    );
                    return Err(serde::de::Error::custom(format!(
                        "invalid_params: 'element' must be a string, not {}",
                        json_type_name(&other)
                    )));
                }
            },
        };
        let args = if args.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::Value::Object(args)
        };
        Ok(TermulBrowserInput {
            action,
            args,
            element,
        })
    }
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_action: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_args: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_element: Option<String>,
}

/// Parent reply frame (one per connection). `result` carries the browser
/// action's JSON result; `code` carries the typed error code for failures.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FrameReply {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
}

impl FrameReply {
    #[must_use]
    pub fn ok() -> Self {
        Self {
            ok: true,
            error: None,
            code: None,
            result: None,
        }
    }

    #[must_use]
    pub fn ok_with(result: serde_json::Value) -> Self {
        Self {
            ok: true,
            error: None,
            code: None,
            result: Some(result),
        }
    }

    #[must_use]
    pub fn err(msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(msg.into()),
            code: None,
            result: None,
        }
    }

    #[must_use]
    pub fn err_code(code: impl Into<String>, msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(msg.into()),
            code: Some(code.into()),
            result: None,
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
mod tests;
