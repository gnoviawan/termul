//! Native subagent sessions for Claude Agent ACP (the AIR draft form that
//! adapter versions 0.78–0.89 send when the client advertises
//! `clientCapabilities.subagents`).
//!
//! In that form the adapter does not send the `Agent`/`Task` tool call to the
//! chat. It announces each subagent with `subagent_spawned`, sends the
//! subagent's own traffic under the child session id, and reports the real
//! end with `subagent_state_update`. The driver turns that into the shape the
//! chat already renders: a synthesized dispatch card that stays running until
//! the subagent ends, with the child's tool calls and text stamped with
//! `_meta.claudeCode.parentToolUseId` so they group under it.

use std::sync::Arc;

use agent_client_protocol::schema::v1::SessionNotification;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::acp::config::{AgentConfig, AgentId};
use crate::acp::session::{ChildRoute, DriverState};
use crate::acp::session_persistence::SessionPersistence;
use crate::web::EventSink;

/// `clientCapabilities` key that turns the native form on.
const SUBAGENTS_CAPABILITY_KEY: &str = "subagents";
/// The renderer's host lifecycle marker (`subagent-lifecycle.ts`).
const TERMUL_SUBAGENT_META_KEY: &str = "termul/subagent";
const CLAUDE_PACKAGE_NAME: &str = "@agentclientprotocol/claude-agent-acp";
/// First adapter version verified to send the AIR draft form.
const AIR_FORM_MIN: (u64, u64, u64) = (0, 78, 0);
/// From this version the adapter sends the RFD form (`subagent_update`,
/// `session_message`) to clients that are not AIR clients.
const RFD_FORM_MIN: (u64, u64, u64) = (0, 90, 0);
const MAX_ID_CHARS: usize = 512;
const MAX_NAME_CHARS: usize = 512;
const MAX_TASK_CHARS: usize = 8_000;
/// Child updates that are chat history. Child state updates (usage, mode,
/// commands, config, plan, session info) would overwrite the chat's own.
const CHILD_HISTORY_KINDS: [&str; 5] = [
    "agent_message_chunk",
    "agent_thought_chunk",
    "user_message_chunk",
    "tool_call",
    "tool_call_update",
];

/// `session/update` as raw JSON. Registered before the typed handler: the
/// v1 schema has no variant for the native subagent updates, so the typed
/// parse would fail on them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(transparent)]
pub(super) struct RawSessionUpdate(pub(super) Value);

impl agent_client_protocol::JsonRpcMessage for RawSessionUpdate {
    fn matches_method(method: &str) -> bool {
        method == "session/update"
    }

    fn method(&self) -> &str {
        "session/update"
    }

    fn to_untyped_message(
        &self,
    ) -> Result<agent_client_protocol::UntypedMessage, agent_client_protocol::Error> {
        agent_client_protocol::UntypedMessage::new("session/update", &self.0)
    }

    fn parse_message(
        method: &str,
        params: &impl serde::Serialize,
    ) -> Result<Self, agent_client_protocol::Error> {
        if method != "session/update" {
            return Err(agent_client_protocol::Error::method_not_found());
        }
        agent_client_protocol::util::json_cast_params(params)
    }
}

impl agent_client_protocol::JsonRpcNotification for RawSessionUpdate {}

/// What the driver does with one raw `session/update`.
#[derive(Debug, PartialEq)]
pub(super) enum NativeRoute {
    /// Not native subagent traffic: the typed handler takes it unchanged.
    PassThrough,
    /// Claimed. Each value is a `session/update` params object addressed to
    /// a chat session; an empty list drops the update.
    Claimed(Vec<Value>),
}

/// True when `config` launches a Claude adapter version that sends the AIR
/// draft form. Other versions keep the legacy behavior (no capability).
pub(super) fn uses_air_native_subagents(config: &AgentConfig) -> bool {
    claude_adapter_version(config).is_some_and(|v| v >= AIR_FORM_MIN && v < RFD_FORM_MIN)
}

/// Add `subagents: {}` to the serialized `initialize` client capabilities.
pub(super) fn advertise_subagents(initialize: &mut Value) {
    if let Some(caps) = initialize
        .get_mut("clientCapabilities")
        .and_then(Value::as_object_mut)
    {
        caps.insert(SUBAGENTS_CAPABILITY_KEY.to_string(), json!({}));
    }
}

/// Route one raw `session/update` and fan out what it claims through the
/// typed notification path. Returns false when the typed handler must take
/// the update unchanged.
pub(super) async fn deliver_native_update(
    state: &Mutex<DriverState>,
    persistence: Option<&Arc<SessionPersistence>>,
    sinks: &[Arc<dyn EventSink>],
    agent_id: &AgentId,
    params: &Value,
) -> Result<bool, agent_client_protocol::Error> {
    let now = crate::acp::session_persistence::now_millis();
    let NativeRoute::Claimed(updates) = route_session_update(state, params, now) else {
        return Ok(false);
    };
    for value in updates {
        match serde_json::from_value::<SessionNotification>(value) {
            Ok(notification) => {
                super::handle_session_notification(
                    state,
                    persistence,
                    sinks,
                    agent_id,
                    notification,
                )
                .await?;
            }
            Err(error) => log::warn!("[acp] dropped a routed subagent update: {error}"),
        }
    }
    Ok(true)
}

/// Route one raw `session/update`. `now_ms` stamps the end of a subagent.
pub(super) fn route_session_update(
    state: &Mutex<DriverState>,
    params: &Value,
    now_ms: u64,
) -> NativeRoute {
    let Some(session_id) = params.get("sessionId").and_then(Value::as_str) else {
        return NativeRoute::PassThrough;
    };
    let Some(update) = params.get("update").and_then(Value::as_object) else {
        return NativeRoute::PassThrough;
    };
    let kind = update
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match kind {
        "subagent_spawned" => spawned(state, session_id, update),
        "subagent_state_update" => state_update(state, update, now_ms),
        // RFD form: never advertised to such versions, so never expected.
        // Drop instead of failing the typed parse.
        "subagent_update" | "session_message" => {
            log::debug!("[acp] dropped native subagent update {kind} (RFD form is not enabled)");
            NativeRoute::Claimed(Vec::new())
        }
        _ => {
            let Some(route) = state.lock().subagent_route(session_id) else {
                return NativeRoute::PassThrough;
            };
            if !CHILD_HISTORY_KINDS.contains(&kind) {
                return NativeRoute::Claimed(Vec::new());
            }
            NativeRoute::Claimed(vec![rerouted(params, &route)])
        }
    }
}

fn spawned(state: &Mutex<DriverState>, parent: &str, update: &Map<String, Value>) -> NativeRoute {
    let Some(child) = bounded_id(update.get("subagentSessionId")) else {
        log::warn!("[acp] subagent_spawned has no usable subagentSessionId; dropped");
        return NativeRoute::Claimed(Vec::new());
    };
    let Some(route) = state.lock().register_subagent(parent, child) else {
        log::warn!("[acp] subagent_spawned names its own session as parent; dropped");
        return NativeRoute::Claimed(Vec::new());
    };
    let name = bounded_text(update.get("name"), MAX_NAME_CHARS).unwrap_or("Subagent");
    let task = bounded_text(update.get("task"), MAX_TASK_CHARS).unwrap_or(name);
    log::info!(
        "[acp] native subagent {} spawned in session {}{}",
        crate::logging::redact_session_id(child),
        crate::logging::redact_session_id(&route.root_session_id),
        if route.parent_dispatch_id.is_some() {
            " (nested)"
        } else {
            ""
        }
    );
    let mut meta = Map::new();
    meta.insert(
        TERMUL_SUBAGENT_META_KEY.to_string(),
        json!({ "state": "running", "sessionId": child }),
    );
    if let Some(parent_dispatch) = &route.parent_dispatch_id {
        meta.insert(
            "claudeCode".to_string(),
            json!({ "parentToolUseId": parent_dispatch }),
        );
    }
    NativeRoute::Claimed(vec![json!({
        "sessionId": route.root_session_id,
        "update": {
            "sessionUpdate": "tool_call",
            "toolCallId": route.dispatch_id,
            "title": name,
            "kind": "think",
            "status": "in_progress",
            "rawInput": { "description": name, "prompt": task },
            "_meta": meta,
        }
    })])
}

fn state_update(
    state: &Mutex<DriverState>,
    update: &Map<String, Value>,
    now_ms: u64,
) -> NativeRoute {
    let Some(child) = bounded_id(update.get("subagentSessionId")) else {
        log::warn!("[acp] subagent_state_update has no usable subagentSessionId; dropped");
        return NativeRoute::Claimed(Vec::new());
    };
    let raw_state = update
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let Some((lifecycle, status)) = end_state(raw_state) else {
        log::warn!(
            "[acp] native subagent {} sent an unknown state; dropped",
            crate::logging::redact_session_id(child)
        );
        return NativeRoute::Claimed(Vec::new());
    };
    let Some(route) = state.lock().end_subagent(child) else {
        log::warn!(
            "[acp] native subagent {} ended before it was announced; dropped",
            crate::logging::redact_session_id(child)
        );
        return NativeRoute::Claimed(Vec::new());
    };
    log::info!(
        "[acp] native subagent {} ended: {raw_state}",
        crate::logging::redact_session_id(child)
    );
    NativeRoute::Claimed(vec![json!({
        "sessionId": route.root_session_id,
        "update": {
            "sessionUpdate": "tool_call_update",
            "toolCallId": route.dispatch_id,
            "status": status,
            "_meta": {
                TERMUL_SUBAGENT_META_KEY: {
                    "state": lifecycle,
                    "endedAt": now_ms,
                    "sessionId": child,
                }
            },
        }
    })])
}

/// Lifecycle state and tool-call status for an AIR end state. A cancelled
/// subagent is not an error, so its card does not show as failed; the
/// lifecycle marker carries the real end.
fn end_state(state: &str) -> Option<(&'static str, &'static str)> {
    match state {
        "completed" => Some(("completed", "completed")),
        "failed" | "disconnected" => Some(("failed", "failed")),
        "cancelled" => Some(("cancelled", "completed")),
        _ => None,
    }
}

/// A child update re-addressed to its chat, stamped with its dispatch.
fn rerouted(params: &Value, route: &ChildRoute) -> Value {
    let mut params = params.clone();
    params["sessionId"] = Value::String(route.root_session_id.clone());
    let update = &mut params["update"];
    if !update["_meta"].is_object() {
        update["_meta"] = json!({});
    }
    if !update["_meta"]["claudeCode"].is_object() {
        update["_meta"]["claudeCode"] = json!({});
    }
    update["_meta"]["claudeCode"]["parentToolUseId"] = Value::String(route.dispatch_id.clone());
    params
}

fn bounded_id(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= MAX_ID_CHARS)
}

fn bounded_text(value: Option<&Value>, max: usize) -> Option<&str> {
    let text = value.and_then(Value::as_str)?.trim();
    if text.is_empty() {
        return None;
    }
    let end = text
        .char_indices()
        .nth(max)
        .map_or(text.len(), |(index, _)| index);
    Some(&text[..end])
}

/// The Claude adapter version `config` launches: from an exact
/// `@agentclientprotocol/claude-agent-acp@X.Y.Z` argument, or from the
/// `package.json` above a launched `claude-agent-acp` entry point.
fn claude_adapter_version(config: &AgentConfig) -> Option<(u64, u64, u64)> {
    let candidates = std::iter::once(&config.command).chain(config.args.iter());
    for arg in candidates {
        if let Some(version) = crate::acp::claude_agent::parse_pinned_claude_package(arg) {
            return parse_semver(&version);
        }
        if arg.contains("claude-agent-acp") {
            if let Some(version) = installed_package_version(std::path::Path::new(arg)) {
                return Some(version);
            }
        }
    }
    None
}

fn installed_package_version(entry: &std::path::Path) -> Option<(u64, u64, u64)> {
    for dir in entry.ancestors().skip(1).take(6) {
        let Ok(manifest) = std::fs::read_to_string(dir.join("package.json")) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&manifest) else {
            continue;
        };
        if value.get("name").and_then(Value::as_str) != Some(CLAUDE_PACKAGE_NAME) {
            continue;
        }
        return parse_semver(value.get("version")?.as_str()?);
    }
    None
}

pub(super) fn parse_semver(version: &str) -> Option<(u64, u64, u64)> {
    let core = version.split(['-', '+']).next()?;
    let mut parts = core.split('.').map(|part| part.parse::<u64>().ok());
    let version = (parts.next()??, parts.next()??, parts.next()??);
    parts.next().is_none().then_some(version)
}
