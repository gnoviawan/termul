//! Tauri event payloads emitted by the ACP backend to the renderer.
//!
//! Every payload derives `Serialize + Clone` and uses `#[serde(rename_all =
//! "camelCase")]` so the wire shape matches the renderer contract. Schema
//! sub-objects (from `agent_client_protocol::schema`) are embedded directly and
//! keep their own protocol-defined serialization.
//!
//! Event names are namespaced under `acp:` and centralized as `const` strings
//! so the manager and any future renderer bridge stay in sync.

use crate::acp::config::{AgentId, SessionId};
use agent_client_protocol::schema::{
    AgentCapabilities, AvailableCommand, ContentBlock, PermissionOption, Plan, SessionConfigOption,
    SessionMode, SessionModeId, SessionModelState, StopReason, ToolCall, ToolCallUpdate,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Event name: an agent subprocess was spawned and `initialize` completed.
pub const EVENT_AGENT_SPAWNED: &str = "acp:agent_spawned";
/// Event name: a new session was created for an agent.
pub const EVENT_SESSION_CREATED: &str = "acp:session_created";
/// Event name: a streamed message/thought chunk arrived during a prompt turn.
pub const EVENT_MESSAGE_CHUNK: &str = "acp:message_chunk";
/// Event name: a new tool call was initiated by the agent.
pub const EVENT_TOOL_CALL: &str = "acp:tool_call";
/// Event name: an update to an in-flight tool call.
pub const EVENT_TOOL_CALL_UPDATE: &str = "acp:tool_call_update";
/// Event name: the agent's execution plan changed.
pub const EVENT_PLAN_UPDATE: &str = "acp:plan_update";
/// Event name: available slash-commands changed.
pub const EVENT_COMMANDS_UPDATE: &str = "acp:commands_update";
/// Event name: the active session mode changed.
pub const EVENT_MODE_UPDATE: &str = "acp:mode_update";
/// Event name: session configuration options changed.
pub const EVENT_CONFIG_OPTIONS_UPDATE: &str = "acp:config_options_update";
/// Event name: the agent requested a permission decision from the user.
pub const EVENT_PERMISSION_REQUEST: &str = "acp:permission_request";
/// Event name: a prompt turn finished with a stop reason.
pub const EVENT_PROMPT_COMPLETE: &str = "acp:prompt_complete";
/// Event name: a non-fatal error occurred while talking to the agent.
pub const EVENT_AGENT_ERROR: &str = "acp:agent_error";
/// Event name: a session was closed (explicitly, or because its agent
/// disconnected/crashed).
pub const EVENT_SESSION_CLOSED: &str = "acp:session_closed";
/// Event name: the agent process disconnected/exited.
pub const EVENT_AGENT_DISCONNECTED: &str = "acp:agent_disconnected";
/// Event name: the agent requires authentication before it can be used. Emitted
/// when `initialize` advertised auth methods that could not be satisfied
/// automatically (multiple methods, or a single-method `authenticate` failed).
pub const EVENT_AUTH_REQUIRED: &str = "acp:auth_required";

/// Which side a streamed content chunk belongs to.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChunkRole {
    /// A chunk echoing the user's own message.
    User,
    /// A chunk of the agent's visible response.
    Agent,
    /// A chunk of the agent's internal reasoning.
    Thought,
}

/// `acp:agent_spawned`
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSpawnedEvent {
    pub agent_id: AgentId,
    pub capabilities: AgentCapabilities,
}

/// One authentication method advertised by the agent in its `initialize`
/// response, flattened to the fields the renderer needs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthMethodInfo {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// `acp:auth_required`
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthRequiredEvent {
    pub agent_id: AgentId,
    pub methods: Vec<AuthMethodInfo>,
    /// Optional detail (e.g. the error string from a failed single-method
    /// `authenticate` attempt).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// `acp:session_created`
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCreatedEvent {
    pub agent_id: AgentId,
    pub session_id: SessionId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modes: Option<agent_client_protocol::schema::SessionModeState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<SessionModelState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_options: Option<Vec<SessionConfigOption>>,
}

/// `acp:message_chunk`
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageChunkEvent {
    pub agent_id: AgentId,
    pub session_id: SessionId,
    pub role: ChunkRole,
    pub content: ContentBlock,
}

/// `acp:tool_call`
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallEvent {
    pub agent_id: AgentId,
    pub session_id: SessionId,
    pub tool_call: ToolCall,
}

/// `acp:tool_call_update`
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallUpdateEvent {
    pub agent_id: AgentId,
    pub session_id: SessionId,
    pub update: ToolCallUpdate,
}

/// `acp:plan_update`
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanUpdateEvent {
    pub agent_id: AgentId,
    pub session_id: SessionId,
    pub plan: Plan,
}

/// `acp:commands_update`
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandsUpdateEvent {
    pub agent_id: AgentId,
    pub session_id: SessionId,
    pub available_commands: Vec<AvailableCommand>,
}

/// `acp:mode_update`
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeUpdateEvent {
    pub agent_id: AgentId,
    pub session_id: SessionId,
    pub current_mode_id: SessionModeId,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub available_modes: Vec<SessionMode>,
}

/// `acp:config_options_update`
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigOptionsUpdateEvent {
    pub agent_id: AgentId,
    pub session_id: SessionId,
    pub config_options: Vec<SessionConfigOption>,
}

/// `acp:permission_request`
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequestEvent {
    pub agent_id: AgentId,
    pub session_id: SessionId,
    /// Correlation id used by `acp_respond_permission` to route the user's choice
    /// back to the waiting agent request.
    pub request_id: String,
    pub tool_call: ToolCallUpdate,
    pub options: Vec<PermissionOption>,
}

/// `acp:prompt_complete`
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptCompleteEvent {
    pub agent_id: AgentId,
    pub session_id: SessionId,
    pub stop_reason: StopReason,
}

/// `acp:agent_error`
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentErrorEvent {
    pub agent_id: AgentId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<SessionId>,
    pub message: String,
}

/// `acp:agent_disconnected`
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDisconnectedEvent {
    pub agent_id: AgentId,
}

/// `acp:session_closed`
///
/// Emitted when a session ends — either via an explicit close or because the
/// owning agent disconnected/crashed while the session was active.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionClosedEvent {
    pub agent_id: AgentId,
    pub session_id: SessionId,
}

/// Emit a payload to the renderer, logging (but not propagating) any error.
///
/// Emission failures are non-fatal: they only mean no renderer is listening, so
/// we must never let them tear down the agent driver thread.
pub fn emit<P: Serialize + Clone>(app: &AppHandle, event: &str, payload: P) {
    if let Err(e) = app.emit(event, payload) {
        log::error!("[acp] failed to emit event {event}: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_spawned_serializes_camel_case() {
        let event = AgentSpawnedEvent {
            agent_id: AgentId("agent-1".to_string()),
            capabilities: AgentCapabilities::default(),
        };
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(value["agentId"], "agent-1");
        // AgentCapabilities serializes load_session as camelCase `loadSession`.
        assert_eq!(value["capabilities"]["loadSession"], false);
    }

    #[test]
    fn session_created_omits_none_fields() {
        let event = SessionCreatedEvent {
            agent_id: AgentId("agent-1".to_string()),
            session_id: SessionId::new("sess-1"),
            modes: None,
            models: None,
            config_options: None,
        };
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(value["agentId"], "agent-1");
        assert_eq!(value["sessionId"], "sess-1");
        assert!(value.get("modes").is_none());
        assert!(value.get("configOptions").is_none());
    }

    #[test]
    fn message_chunk_serializes_role_and_content() {
        let event = MessageChunkEvent {
            agent_id: AgentId("a".to_string()),
            session_id: SessionId::new("s"),
            role: ChunkRole::Agent,
            content: ContentBlock::Text(agent_client_protocol::schema::TextContent::new("hi")),
        };
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(value["role"], "agent");
        assert_eq!(value["content"]["type"], "text");
        assert_eq!(value["content"]["text"], "hi");
    }

    #[test]
    fn permission_request_serializes_request_id() {
        let event = PermissionRequestEvent {
            agent_id: AgentId("a".to_string()),
            session_id: SessionId::new("s"),
            request_id: "req-7".to_string(),
            tool_call: agent_client_protocol::schema::ToolCallUpdate::new(
                "tc-1",
                agent_client_protocol::schema::ToolCallUpdateFields::new(),
            ),
            options: vec![],
        };
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(value["requestId"], "req-7");
        assert_eq!(value["sessionId"], "s");
    }

    #[test]
    fn prompt_complete_serializes_stop_reason_snake_case() {
        let event = PromptCompleteEvent {
            agent_id: AgentId("a".to_string()),
            session_id: SessionId::new("s"),
            stop_reason: StopReason::EndTurn,
        };
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(value["stopReason"], "end_turn");
    }
}
