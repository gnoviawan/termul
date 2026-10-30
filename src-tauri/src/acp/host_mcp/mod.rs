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

pub mod automation_tools;
pub mod bridge;
pub mod canvas;
pub mod canvas_budget;
pub mod canvas_policy;
pub mod canvas_skill;
pub mod canvas_tools;
pub mod child;
pub mod parent;
pub mod presence;

#[cfg(test)]
mod gateway_harness;

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

/// Server `instructions` returned in the child's MCP `initialize` result.
/// Agents that connect the injected `termul` server surface this guidance in
/// model context, so it doubles as the advertisement for the chat renderer's
/// markdown affordances.
pub const TERMUL_CHAT_INSTRUCTIONS: &str = "Termul renders your markdown replies in a rich chat UI. \
Embed images and videos inline with `![alt](path)`, for generated charts, screenshots, diagrams, \
and screen recordings: paths relative to the session working directory, absolute paths, \
`file://` URLs, and https URLs render in the desktop app and on the web. A markdown link to an \
image or video file also shows it inline. \
Reference files as markdown links `[label](path)`: Termul renders them as buttons that open \
the file in its built-in editor — absolute and cwd-relative paths inside the session workspace \
roots work, a `:line` suffix (or `#L<line>` on the link target) positions the cursor, and \
bare multi-segment file paths in prose become open-in-editor links too.";

/// Offer to schedule repeatable work. Automation runs never see it: their
/// sessions get no host MCP server.
pub const AUTOMATION_SUGGESTION_INSTRUCTIONS: &str = "Repeatable work: when the user's request \
names a cadence (every day, every morning, every week, daily, weekly, remind me, each time X \
happens) or repeats a request made earlier in this chat, first finish the task, then ask once \
per chat with the `ask_user` tool: \"This looks repeatable. Want me to turn it into a scheduled \
background automation?\" with the options \"Yes, schedule it\" and \"Not now\". On yes, read \
`automation_guide` and build it with the automation tools. After either answer, do not ask \
again in this chat. Skip the question when the user is already asking for an automation.";

/// The full `instructions` of the child's `initialize` result: the chat
/// guidance, the repeatable-work offer, then the design canvas guide.
#[must_use]
pub fn session_instructions() -> String {
    format!(
        "{TERMUL_CHAT_INSTRUCTIONS}\n\n{AUTOMATION_SUGGESTION_INSTRUCTIONS}\n\n{}",
        canvas_tools::instructions()
    )
}

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
    /// Optional short kebab-case slug naming this chat's git branch (for
    /// example `fix-login-redirect`): lowercase letters, digits and single
    /// hyphens, at most 48 characters. Honoured on the first call only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
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
    /// `browser` tool call: the raw tool arguments, folded and checked by
    /// the parent, then forwarded to `browser_automation::dispatch`.
    Browser,
    /// Fetch the `browser` tool schema the child serves. Authenticated by
    /// token alone: children describe before `session/new` returns.
    Describe,
    /// `ask_user` tool call (issue #784): the parent shows the question panel
    /// and holds the reply until the user answers or the call is cancelled.
    AskUser,
    /// A figcraft control-protocol call from the canvas `Bridge` backend,
    /// routed to the renderer that holds the session's project canvas.
    Canvas,
    /// An `automation_*` tool call, answered by the host automation service
    /// for the session's project.
    Automation,
}

/// One option the agent offers in an `ask_user` question.
#[derive(Debug, Clone, Deserialize, Serialize, schemars::JsonSchema)]
pub struct TermulAskUserOption {
    /// Text shown on the choice and returned in `answers` when picked.
    pub label: String,
    /// Optional context shown under the label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Input the agent sends to `ask_user`. The answer returns as the tool result
/// `{"answers": [...], "free_text": "..." | null, "cancelled": bool}`.
#[derive(Debug, Clone, Deserialize, Serialize, schemars::JsonSchema)]
pub struct TermulAskUserInput {
    /// The question to put to the user.
    pub question: String,
    /// Choices the user can pick from. May be empty when only free text fits.
    #[serde(default)]
    pub options: Vec<TermulAskUserOption>,
    /// Allow more than one option to be picked.
    #[serde(default)]
    pub multi_select: bool,
    /// Show a free-text field next to the options. Defaults to true.
    #[serde(default = "default_allow_free_text")]
    pub allow_free_text: bool,
    /// Optional short heading shown above the question.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
}

fn default_allow_free_text() -> bool {
    true
}

/// Input the agent sends to the `browser` tool, parsed by the parent from
/// the frame's raw `browser_input`. `action` selects the verb;
/// `args` holds verb-specific fields; `element` is the agent-stated intent
/// (e.g. "the login button") surfaced in consent/audit UI.
///
/// Agents send parameters in BOTH wire forms (the tool description documents
/// both): nested under `args` (the schema shape) or flat at the tool-call top
/// level. [`TermulBrowserInput::parse`] folds unknown top-level keys into `args` —
/// a nested `args` object wins on key conflicts — and rejects a non-object
/// `args` (e.g. a JSON string) with a typed `invalid_params` error naming the
/// action's expected field. `element` is a known top-level field (consent
/// context); one nested under `args` is hoisted to it when the top-level
/// field is absent.
#[derive(Debug, Clone)]
pub struct TermulBrowserInput {
    pub action: String,
    pub args: serde_json::Value,
    pub element: Option<String>,
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

/// Log one rejection and return its agent-facing text. The log carries the
/// wire code and the rejection text only; texts name expected keys and
/// JSON types, never argument values (CWE-532).
fn reject(text: String) -> Result<TermulBrowserInput, String> {
    log::warn!("[host-mcp] browser input rejected [invalid_params]: {text}");
    Err(text)
}

fn string_field(
    value: Option<serde_json::Value>,
    key: &str,
) -> Result<Option<String>, String> {
    match value {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::String(s)) => Ok(Some(s)),
        Some(other) => Err(format!("'{key}' must be a string, not {}", json_type_name(&other))),
    }
}

impl TermulBrowserInput {
    /// Fold and check the raw tool arguments. Errors are `invalid_params`
    /// texts naming the action's expected fields.
    pub fn parse(raw: serde_json::Value) -> Result<Self, String> {
        let mut map = match raw {
            serde_json::Value::Object(map) => map,
            serde_json::Value::Null => serde_json::Map::new(),
            other => {
                return reject(format!(
                    "browser input must be a JSON object, not {}",
                    json_type_name(&other)
                ));
            }
        };
        // Extract `action` first so later errors can name its expected args.
        let action = match string_field(map.remove("action"), "action") {
            Ok(Some(action)) => action,
            Ok(None) => return reject("missing 'action'".to_string()),
            Err(text) => return reject(text),
        };
        let element = match string_field(map.remove("element"), "element") {
            Ok(element) => element,
            Err(text) => return reject(text),
        };
        let expected = crate::browser_automation::expected_args_text(&action);
        let mut args = match map.remove("args") {
            None | Some(serde_json::Value::Null) => serde_json::Map::new(),
            Some(serde_json::Value::Object(args)) => args,
            Some(other) => {
                // The action is agent-supplied: log the expected keys only.
                log::warn!(
                    "[host-mcp] browser input rejected [invalid_params]: 'args' must be a JSON object, expected={expected}"
                );
                return Err(format!(
                    "'args' must be a JSON object, not {} — {action} needs {expected}",
                    json_type_name(&other)
                ));
            }
        };
        // Fold the remaining (unknown) top-level keys into `args`; a value
        // already present from the nested `args` object wins.
        for (key, value) in map {
            args.entry(key).or_insert(value);
        }
        // Consent context may also arrive nested under `args` — hoist it to
        // the top-level `element` when that is absent.
        let element = match element {
            Some(element) => Some(element),
            None => match string_field(args.remove("element"), "element") {
                Ok(element) => element,
                Err(text) => return reject(text),
            },
        };
        let args = if args.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::Value::Object(args)
        };
        Ok(Self {
            action,
            args,
            element,
        })
    }
}

impl<'de> Deserialize<'de> for TermulBrowserInput {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = serde_json::Value::deserialize(deserializer)?;
        Self::parse(raw).map_err(|text| serde::de::Error::custom(format!("invalid_params: {text}")))
    }
}

/// The parent reads at most this much of a child's request line, newline
/// included, so a misbehaving peer cannot grow it unbounded.
pub const MAX_REQUEST_FRAME_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct FrameRequest {
    pub token: String,
    pub session_id: String,
    #[serde(default)]
    pub kind: FrameKind,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub todos: Vec<TermulPlanTodo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Branch slug from `set_session_title` (story 16). Only meaningful on a
    /// `SetTitle` frame; validated and applied host-side.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// The `browser` tool call's arguments exactly as the agent sent them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_input: Option<serde_json::Value>,
    /// The question of an `AskUser` frame.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ask: Option<TermulAskUserInput>,
    /// figcraft method of a `Canvas` frame (`engine.execute`, `node.get`, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canvas_method: Option<String>,
    /// JSON text of a `Canvas` frame's params, forwarded unparsed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canvas_params: Option<String>,
    /// The agent tool a `Canvas` frame serves, for the gateway's logs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canvas_tool: Option<String>,
    /// The tool an `Automation` frame serves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub automation_tool: Option<automation_tools::AutomationTool>,
    /// An `Automation` frame's tool arguments, parsed by the parent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub automation_input: Option<serde_json::Value>,
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
