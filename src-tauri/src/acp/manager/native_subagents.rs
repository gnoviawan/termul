//! The driver's raw `session/update` router, for every agent.
//!
//! **Subagent sessions.** From version 0.78 Claude Agent ACP runs each
//! subagent in its own ACP session when the client advertises
//! `clientCapabilities.subagents`. Versions 0.78-0.89 send the AIR draft
//! form; 0.90 and newer send the RFD form to clients that are not AIR
//! clients, which Termul is not. Termul advertises the capability only to
//! 0.78 through 0.99, the versions whose wire was verified, but routes the
//! subagent updates of any agent that sends them.
//!
//! In both forms the agent does not send a dispatch tool call to the chat. It
//! announces each subagent on its parent session, sends the subagent's own
//! traffic under the child session id, and reports the subagent's state:
//!
//! - AIR: `subagent_spawned`, then `subagent_state_update` with an end state.
//! - RFD: `subagent_update` upserts (title, description, capabilities, and a
//!   `state` of `running`, `requires_action`, `idle` or `unknown`).
//!   `session_message` records replace the launch call: the prompt from
//!   parent to child, and the child's reply.
//!
//! The router synthesizes a dispatch card on the chat that carries the
//! subagent's record (`crate::acp::subagents`), and stamps the child's tool
//! calls and text with `_meta.claudeCode.parentToolUseId` so they group under
//! it.
//!
//! **Tool calls.** An agent tool call on a chat session goes through the tool
//! mappers (`crate::acp::subagents::map_tool_event`), which stamp a dispatch
//! call with its record or a steering call with its control marker. Agent-sent
//! copies of those host keys are stripped first.

use std::sync::Arc;

use agent_client_protocol::schema::v1::SessionNotification;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::acp::config::{AgentConfig, AgentId};
use crate::acp::session::{ChildRoute, DriverState};
use crate::acp::session_persistence::SessionPersistence;
use crate::acp::subagents::{
    self, bounded_id, native, Subagent, SubagentEndReason, SubagentSource, SubagentState,
    SUBAGENT_META_KEY,
};
use crate::web::EventSink;

/// `clientCapabilities` key that turns the native form on.
const SUBAGENTS_CAPABILITY_KEY: &str = "subagents";
const CLAUDE_PACKAGE_NAME: &str = "@agentclientprotocol/claude-agent-acp";
/// First adapter version verified to send native subagent sessions.
const NATIVE_SUBAGENTS_MIN: (u64, u64, u64) = (0, 78, 0);
/// First adapter version past the verified wire (0.78 through 0.99). A 1.0
/// may change the RFD form, so it keeps the legacy behavior until verified.
const NATIVE_SUBAGENTS_UNVERIFIED: (u64, u64, u64) = (1, 0, 0);
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
pub(super) enum SessionRoute {
    /// The typed handler takes the update unchanged.
    PassThrough,
    /// Claimed. Each value is a `session/update` params object addressed to
    /// a chat session; an empty list drops the update.
    Claimed(Vec<Value>),
}

/// True when `config` launches a Claude adapter version verified to send
/// native subagent sessions. Other versions keep the legacy behavior (no
/// capability).
pub(super) fn uses_native_subagents(config: &AgentConfig) -> bool {
    let Some(version) = claude_adapter_version(config) else {
        return false;
    };
    if version >= NATIVE_SUBAGENTS_UNVERIFIED {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            let (major, minor, patch) = version;
            log::info!(
                "[acp] Claude adapter {major}.{minor}.{patch} is newer than the verified native subagent range (0.78-0.99); not advertising subagents"
            );
        });
        return false;
    }
    version >= NATIVE_SUBAGENTS_MIN
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
pub(super) async fn deliver_session_update(
    state: &Mutex<DriverState>,
    persistence: Option<&Arc<SessionPersistence>>,
    sinks: &[Arc<dyn EventSink>],
    agent_id: &AgentId,
    params: &Value,
) -> Result<bool, agent_client_protocol::Error> {
    let now = crate::acp::session_persistence::now_millis();
    let SessionRoute::Claimed(updates) = route_session_update(state, params, now) else {
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
            Err(error) => log::warn!("[acp] dropped a routed session update: {error}"),
        }
    }
    Ok(true)
}

/// Route one raw `session/update`. `now_ms` is the host clock for records.
/// A message chunk on a chat session costs one lock and no copy.
pub(super) fn route_session_update(
    state: &Mutex<DriverState>,
    params: &Value,
    now_ms: u64,
) -> SessionRoute {
    let Some(session_id) = params.get("sessionId").and_then(Value::as_str) else {
        return SessionRoute::PassThrough;
    };
    let Some(update) = params.get("update").and_then(Value::as_object) else {
        return SessionRoute::PassThrough;
    };
    let kind = update
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match kind {
        "subagent_spawned" => air_spawned(state, session_id, update, now_ms),
        "subagent_state_update" => air_state_update(state, update, now_ms),
        "subagent_update" => rfd_update(state, session_id, update, now_ms),
        "session_message" => rfd_message(state, session_id, update),
        _ => {
            let mut state = state.lock();
            if let Some(route) = state.subagent_route(session_id) {
                if kind == "config_option_update" {
                    return child_config(&mut state, session_id, update);
                }
                if !CHILD_HISTORY_KINDS.contains(&kind) {
                    return SessionRoute::Claimed(Vec::new());
                }
                return SessionRoute::Claimed(vec![rerouted(params, &route)]);
            }
            if !matches!(kind, "tool_call" | "tool_call_update") {
                return SessionRoute::PassThrough;
            }
            chat_tool_event(&mut state, session_id, kind, params, update, now_ms)
        }
    }
}

/// An agent tool call on a chat session: strip spoofed host keys, then let
/// the tool mappers stamp it and report the dispatches it changed. During a
/// `session/load` replay window the typed handler drops replayed history, so
/// the mappers skip it.
fn chat_tool_event(
    state: &mut DriverState,
    session_id: &str,
    kind: &str,
    params: &Value,
    update: &Map<String, Value>,
    now_ms: u64,
) -> SessionRoute {
    let spoofed = subagents::has_spoofed_meta(update);
    let mapped = if state.in_replay_window(session_id) {
        subagents::MappedToolEvent::default()
    } else {
        subagents::map_tool_event(state.subagent_records(), session_id, kind, update, now_ms)
    };
    if !spoofed && mapped.is_empty() {
        return SessionRoute::PassThrough;
    }
    let mut params = params.clone();
    if spoofed {
        subagents::strip_spoofed_meta(&mut params["update"]);
        log::warn!(
            "[acp] session {}: dropped agent-sent subagent keys from a tool call",
            crate::logging::redact_session_id(session_id)
        );
    }
    if let Some((key, value)) = mapped.stamp {
        meta_object(&mut params["update"]).insert(key.to_string(), value);
    }
    let mut routed = vec![params];
    routed.extend(
        mapped
            .changed
            .iter()
            .map(|record| record_update(record, None, None)),
    );
    SessionRoute::Claimed(routed)
}

/// `update._meta`, created as an object when missing.
fn meta_object(update: &mut Value) -> &mut Map<String, Value> {
    if !update["_meta"].is_object() {
        update["_meta"] = json!({});
    }
    update["_meta"]
        .as_object_mut()
        .expect("`_meta` was just made an object")
}

/// A `tool_call_update` on the record's dispatch that carries the record,
/// and the dispatch `status` and `title` when they changed.
fn record_update(record: &Subagent, status: Option<&str>, title: Option<&str>) -> Value {
    let mut update = json!({
        "sessionUpdate": "tool_call_update",
        "toolCallId": record.dispatch_tool_call_id,
        "_meta": { SUBAGENT_META_KEY: record.meta_value() },
    });
    if let Some(status) = status {
        update["status"] = json!(status);
    }
    if let Some(title) = title {
        update["title"] = json!(title);
    }
    json!({ "sessionId": record.root_session_id, "update": update })
}

/// The dispatch card status for a subagent state. A cancelled subagent is not
/// an error, so its card does not show as failed; the record carries the real
/// end. An unobservable child leaves the status as it was.
fn card_status(state: &SubagentState) -> Option<&'static str> {
    match state {
        SubagentState::Running | SubagentState::RequiresAction => Some("in_progress"),
        SubagentState::Idle { end } if end.reason == SubagentEndReason::Failed => Some("failed"),
        SubagentState::Idle { .. } => Some("completed"),
        SubagentState::Unknown => None,
    }
}

fn air_spawned(
    state: &Mutex<DriverState>,
    parent: &str,
    update: &Map<String, Value>,
    now_ms: u64,
) -> SessionRoute {
    let Some(child) = bounded_id(update.get("subagentSessionId")) else {
        log::warn!("[acp] subagent_spawned has no usable subagentSessionId; dropped");
        return SessionRoute::Claimed(Vec::new());
    };
    announce(
        &mut state.lock(),
        parent,
        child,
        SubagentSource::AcpAir,
        now_ms,
        |record| native::apply_air_spawn(record, update),
    )
}

fn air_state_update(
    state: &Mutex<DriverState>,
    update: &Map<String, Value>,
    now_ms: u64,
) -> SessionRoute {
    let Some(child) = bounded_id(update.get("subagentSessionId")) else {
        log::warn!("[acp] subagent_state_update has no usable subagentSessionId; dropped");
        return SessionRoute::Claimed(Vec::new());
    };
    let raw_state = update
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let Some(next) = native::air_state(raw_state) else {
        log::warn!(
            "[acp] native subagent {} sent an unknown state; dropped",
            crate::logging::redact_session_id(child)
        );
        return SessionRoute::Claimed(Vec::new());
    };
    change(&mut state.lock(), child, |record| {
        record.set_state(next, now_ms);
    })
}

/// RFD `subagent_update`: the announce, or an upsert of a known child's
/// title, description, capabilities and state.
fn rfd_update(
    state: &Mutex<DriverState>,
    parent: &str,
    update: &Map<String, Value>,
    now_ms: u64,
) -> SessionRoute {
    let child = bounded_id(update.get("sessionId"));
    let (Some(child), Ok(next)) = (child, native::rfd_state(update)) else {
        log::warn!("[acp] subagent_update has no usable sessionId or state; dropped");
        return SessionRoute::Claimed(Vec::new());
    };
    let mut state = state.lock();
    if state.subagent_route(child).is_some() {
        return change(&mut state, child, |record| {
            native::apply_rfd(record, update, next, false, now_ms);
        });
    }
    if !next.as_ref().is_some_and(|next| next.state.is_working()) {
        log::warn!(
            "[acp] native subagent {} reported a state before it was announced; dropped",
            crate::logging::redact_session_id(child)
        );
        return SessionRoute::Claimed(Vec::new());
    }
    announce(
        &mut state,
        parent,
        child,
        SubagentSource::AcpRfd,
        now_ms,
        |record| native::apply_rfd(record, update, next, true, now_ms),
    )
}

/// A child's `config_option_update` never reaches the chat; a model change
/// updates the child's record.
fn child_config(state: &mut DriverState, child: &str, update: &Map<String, Value>) -> SessionRoute {
    let Some(model) = native::child_model(update) else {
        return SessionRoute::Claimed(Vec::new());
    };
    change(state, child, |record| record.model = Some(model))
}

/// RFD `session_message`. Only a child's message to its own parent (the
/// launch reply, or a hand-back report) reaches the chat, as the content of
/// the child's card. A prompt to a child is dropped. Each linked message
/// comes as two views; only the recipient's view counts.
fn rfd_message(
    state: &Mutex<DriverState>,
    view: &str,
    update: &Map<String, Value>,
) -> SessionRoute {
    let recipient = bounded_id(update.get("recipientSessionId"));
    let content = update.get("content").and_then(Value::as_array);
    let (Some(recipient), Some(content)) = (recipient, content) else {
        log::warn!("[acp] session_message has no usable recipientSessionId or content; dropped");
        return SessionRoute::Claimed(Vec::new());
    };
    let sender_route = bounded_id(update.get("senderSessionId"))
        .and_then(|sender| state.lock().subagent_route(sender));
    let Some(route) =
        sender_route.filter(|route| recipient == view && route.parent_session_id == recipient)
    else {
        return SessionRoute::Claimed(Vec::new());
    };
    let content: Vec<Value> = content
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
        .map(|block| json!({ "type": "content", "content": block }))
        .collect();
    if content.is_empty() {
        return SessionRoute::Claimed(Vec::new());
    }
    SessionRoute::Claimed(vec![json!({
        "sessionId": route.root_session_id,
        "update": {
            "sessionUpdate": "tool_call_update",
            "toolCallId": route.dispatch_id,
            "content": content,
        }
    })])
}

/// Register `child` under `parent`, create its record with `fill`, and
/// synthesize its dispatch card on the chat.
fn announce(
    state: &mut DriverState,
    parent: &str,
    child: &str,
    source: SubagentSource,
    now_ms: u64,
    fill: impl FnOnce(&mut Subagent),
) -> SessionRoute {
    let Some(route) = state.register_subagent(parent, child) else {
        log::warn!("[acp] native subagent names its own session as parent; dropped");
        return SessionRoute::Claimed(Vec::new());
    };
    let parent_id = route
        .parent_dispatch_id
        .is_some()
        .then(|| route.parent_session_id.clone());
    let record = state.subagent_records().upsert(
        &route.root_session_id,
        &route.dispatch_id,
        || subagents::DispatchEntry {
            record: native::new_record(
                &route.root_session_id,
                child,
                parent_id,
                &route.dispatch_id,
                source,
                now_ms,
            ),
            view: subagents::ToolView::default(),
        },
        |entry| fill(&mut entry.record),
    );
    let Some(record) = record else {
        return SessionRoute::Claimed(Vec::new());
    };
    sync_route(state, child, &record.state);
    let mut meta = Map::new();
    meta.insert(SUBAGENT_META_KEY.to_string(), record.meta_value());
    if let Some(parent_dispatch) = &route.parent_dispatch_id {
        meta.insert(
            "claudeCode".to_string(),
            json!({ "parentToolUseId": parent_dispatch }),
        );
    }
    SessionRoute::Claimed(vec![json!({
        "sessionId": route.root_session_id,
        "update": {
            "sessionUpdate": "tool_call",
            "toolCallId": route.dispatch_id,
            "title": record.title,
            "kind": "think",
            "status": card_status(&record.state).unwrap_or("in_progress"),
            "_meta": meta,
        }
    })])
}

/// Apply `edit` to the record of announced child `child` and report the
/// change on its dispatch card. An unchanged record (a repeated end report:
/// the adapter re-sends current states after `session/load`) reports
/// nothing, so the card keeps its first `endedAt`.
fn change(state: &mut DriverState, child: &str, edit: impl FnOnce(&mut Subagent)) -> SessionRoute {
    let Some(route) = state.subagent_route(child) else {
        log::warn!(
            "[acp] native subagent {} reported before it was announced; dropped",
            crate::logging::redact_session_id(child)
        );
        return SessionRoute::Claimed(Vec::new());
    };
    let records = state.subagent_records();
    let Some(before) = records
        .record(&route.root_session_id, &route.dispatch_id)
        .cloned()
    else {
        log::warn!(
            "[acp] native subagent {} has no record (evicted); dropped",
            crate::logging::redact_session_id(child)
        );
        return SessionRoute::Claimed(Vec::new());
    };
    let after = records.upsert(
        &route.root_session_id,
        &route.dispatch_id,
        || subagents::DispatchEntry {
            record: before.clone(),
            view: subagents::ToolView::default(),
        },
        |entry| edit(&mut entry.record),
    );
    let Some(after) = after else {
        log::debug!(
            "[acp] native subagent {} reported no change; ignored",
            crate::logging::redact_session_id(child)
        );
        return SessionRoute::Claimed(Vec::new());
    };
    sync_route(state, child, &after.state);
    let status = (before.state != after.state)
        .then(|| card_status(&after.state))
        .flatten();
    let title = (before.title != after.title).then_some(after.title.as_str());
    SessionRoute::Claimed(vec![record_update(&after, status, title)])
}

/// Keep the child route's work flag (the idle reaper's evidence) in step
/// with its record: an unobservable child no longer counts as working.
fn sync_route(state: &mut DriverState, child: &str, record_state: &SubagentState) {
    if record_state.is_working() {
        state.resume_subagent(child);
    } else {
        state.end_subagent(child);
    }
}

/// A child update re-addressed to its chat, stamped with its dispatch.
/// Agent-sent copies of the host's subagent keys are dropped.
fn rerouted(params: &Value, route: &ChildRoute) -> Value {
    let mut params = params.clone();
    params["sessionId"] = Value::String(route.root_session_id.clone());
    let update = &mut params["update"];
    if subagents::strip_spoofed_meta(update) {
        log::warn!(
            "[acp] session {}: dropped agent-sent subagent keys from child traffic",
            crate::logging::redact_session_id(&route.root_session_id)
        );
    }
    let meta = meta_object(update);
    if !meta.get("claudeCode").is_some_and(Value::is_object) {
        meta.insert("claudeCode".to_string(), json!({}));
    }
    meta["claudeCode"]["parentToolUseId"] = Value::String(route.dispatch_id.clone());
    params
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
