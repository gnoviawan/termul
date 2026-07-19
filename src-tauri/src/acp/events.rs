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

/// Re-export the transport-neutral fan-out helper so the `acp` dispatcher emits
/// through `Vec<Arc<dyn EventSink>>` instead of `AppHandle::emit` directly
/// (Story 1.1 / architecture D2). Call sites read `events::fan_out(sinks, sid,
/// events::EVENT_*, &payload)` — the `events::` namespace is preserved, the
/// `app` parameter is gone.
///
/// The ONLY place that still calls `AppHandle::emit` for `acp:*` events is
/// `crate::web::TauriEventSink::emit` (the desktop's sink). See AC7.
pub(crate) use crate::web::fan_out;

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
/// Event name: the agent subprocess crashed (Story 1.9 FR26) — a typed crash
/// event distinct from `agent_error` (non-fatal) + `agent_disconnected`
/// (always). Emitted BEFORE `agent_disconnected` so the renderer can
/// distinguish "crash" from a clean disconnect + set `status: 'error'`.
pub const EVENT_AGENT_CRASHED: &str = "acp:agent_crashed";
/// Event name: a session was closed (explicitly, or because its agent
/// disconnected/crashed).
pub const EVENT_SESSION_CLOSED: &str = "acp:session_closed";
/// Event name: the agent process disconnected/exited.
pub const EVENT_AGENT_DISCONNECTED: &str = "acp:agent_disconnected";
/// Event name: the agent updated session metadata (e.g. title).
pub const EVENT_SESSION_INFO_UPDATE: &str = "acp:session_info_update";
/// Event name: the agent reported context window utilization (and optional cost).
pub const EVENT_USAGE_UPDATE: &str = "acp:usage_update";

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
    /// Story 1.8 T3.2 (FR11): the client turn-id echoed back so the renderer's
    /// `seenTurnIds` dedup fires (no duplicate completion on reconnect replay).
    /// `None` for the desktop path + older clients (dedup is a no-op). Serialized
    /// as `turnId` (camelCase payload); absent on the wire when `None`
    /// (`skip_serializing_if = "Option::is_none"` — byte-identical to pre-1.8
    /// desktop payloads when unset).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
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

/// `acp:agent_crashed` (Story 1.9 FR26)
///
/// Emitted when the agent subprocess crashes mid-turn (the supervisor — i.e.
/// the `run_agent` teardown — detects child exit via the SDK connection
/// resolving with `Err`). Outstanding turn oneshots fail with this event;
/// `acp-store` sets `status: 'error'` + the UI shows a manual-restart action
/// (no silent respawn, honoring ADR-003). Emitted BEFORE `agent_disconnected`.
/// `session_id` is `None` (the crash is agent-level, `sid = None`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCrashedEvent {
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

/// `acp:session_info_update`
///
/// Emitted when the agent updates session metadata (e.g. an auto-generated
/// title) via the ACP `session_info_update` notification. `title` is `None`
/// when the agent explicitly cleared it (serialized as `"title": null` on the
/// wire), and `Some(String)` when set.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfoUpdateEvent {
    pub agent_id: AgentId,
    pub session_id: SessionId,
    pub title: Option<String>,
}

/// Cumulative session cost reported by the agent (optional on `UsageUpdateEvent`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageCostEvent {
    pub amount: f64,
    pub currency: String,
}

/// `acp:usage_update`
///
/// Emitted when the agent pushes context window utilization via ACP
/// `sessionUpdate: "usage_update"`. Requires the `unstable_session_usage`
/// feature on the protocol crate.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageUpdateEvent {
    pub agent_id: AgentId,
    pub session_id: SessionId,
    pub used: u64,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<UsageCostEvent>,
}

// Story 1.1 (AC7): the legacy `events::emit(app, event, payload)` free function
// was REMOVED. All emission now goes through [`fan_out`] against the
// dispatcher's `Vec<Arc<dyn EventSink>>`. The `AppHandle`-aware path lives
// exclusively in `crate::web::TauriEventSink::emit` (the desktop's sink), so no
// new `app.emit("acp:..")` call sites may be introduced outside that sink.

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
            turn_id: None,
        };
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(value["stopReason"], "end_turn");
        // Story 1.8 T3.2: `turnId` is absent when `None` (byte-identical to
        // pre-1.8 desktop payloads — `skip_serializing_if = "Option::is_none"`).
        assert!(value.get("turnId").is_none(), "turnId must be absent when None");
    }

    #[test]
    fn prompt_complete_serializes_turn_id_when_set() {
        let event = PromptCompleteEvent {
            agent_id: AgentId("a".to_string()),
            session_id: SessionId::new("s"),
            stop_reason: StopReason::EndTurn,
            turn_id: Some("turn-123".to_string()),
        };
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(value["turnId"], "turn-123");
    }

    /// Story 1.9 FR26: `AgentCrashedEvent` serializes camelCase, omits
    /// `sessionId` when `None` (agent-level crash, `sid = None` on the wire).
    #[test]
    fn agent_crashed_serializes_camel_case() {
        let event = AgentCrashedEvent {
            agent_id: AgentId("a1".to_string()),
            session_id: None,
            message: "child exited: signal 11".to_string(),
        };
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(value["agentId"], "a1");
        assert_eq!(value["message"], "child exited: signal 11");
        assert!(
            value.get("sessionId").is_none(),
            "sessionId must be absent when None (byte-identical to pre-1.9)"
        );
        assert_eq!(EVENT_AGENT_CRASHED, "acp:agent_crashed");
    }

    /// Story 1.9 FR26: `AgentCrashedEvent` with a session id (turn-scoped
    /// crash) serializes the `sessionId` field.
    #[test]
    fn agent_crashed_serializes_session_id_when_set() {
        let event = AgentCrashedEvent {
            agent_id: AgentId("a1".to_string()),
            session_id: Some(SessionId::new("sess-1")),
            message: "turn timed out".to_string(),
        };
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(value["sessionId"], "sess-1");
    }

    #[test]
    fn session_info_update_serializes_camel_case() {
        // With a title → serialized as `"title": "T"`
        let event = SessionInfoUpdateEvent {
            agent_id: AgentId("a".to_string()),
            session_id: SessionId::new("s"),
            title: Some("T".to_string()),
        };
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(value["agentId"], "a");
        assert_eq!(value["sessionId"], "s");
        assert_eq!(value["title"], "T");

        // Without a title → serialized as `"title": null` (agent explicitly cleared)
        let event_no_title = SessionInfoUpdateEvent {
            agent_id: AgentId("a".to_string()),
            session_id: SessionId::new("s"),
            title: None,
        };
        let value = serde_json::to_value(&event_no_title).unwrap();
        assert_eq!(value["agentId"], "a");
        assert_eq!(value["sessionId"], "s");
        assert_eq!(value["title"], serde_json::Value::Null);
    }

    #[test]
    fn usage_update_serializes_camel_case() {
        let event = UsageUpdateEvent {
            agent_id: AgentId("a".to_string()),
            session_id: SessionId::new("s"),
            used: 53_000,
            size: 200_000,
            cost: Some(UsageCostEvent {
                amount: 0.045,
                currency: "USD".to_string(),
            }),
        };
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(value["agentId"], "a");
        assert_eq!(value["sessionId"], "s");
        assert_eq!(value["used"], 53_000);
        assert_eq!(value["size"], 200_000);
        assert_eq!(value["cost"]["amount"], 0.045);
        assert_eq!(value["cost"]["currency"], "USD");
    }

    #[test]
    fn usage_update_omits_none_cost() {
        let event = UsageUpdateEvent {
            agent_id: AgentId("a".to_string()),
            session_id: SessionId::new("s"),
            used: 1_000,
            size: 128_000,
            cost: None,
        };
        let value = serde_json::to_value(&event).unwrap();
        assert!(value.get("cost").is_none());
    }
}
