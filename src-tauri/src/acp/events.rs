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
use agent_client_protocol::schema::v1::{
    AgentCapabilities, AvailableCommand, ContentBlock, EnumOption, Meta, PermissionOption, Plan,
    SessionConfigKind, SessionConfigOption, SessionConfigOptionCategory,
    SessionConfigSelectOptions, SessionMode, SessionModeId, StopReason, ToolCall, ToolCallUpdate,
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

/// A single selectable model advertised by an ACP agent.
///
/// Mirror of the pre-1.3 schema `SessionModel` wire shape (`{ modelId, name,
/// description? }`). Models are no longer a dedicated protocol type since ACP
/// 0.14 — they are a `SessionConfigOption` with `category = "model"` — so
/// Termul reconstructs this legacy view from `config_options` to keep the
/// renderer's Model Picker contract byte-compatible.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionModel {
    pub model_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Snapshot of an agent's model selector, derived from its `config_options`.
///
/// Wire-identical to the pre-1.3 schema `SessionModelState`
/// (`{ currentModelId, availableModels[] }`).
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionModelState {
    pub current_model_id: String,
    pub available_models: Vec<SessionModel>,
}

/// Derive the legacy `SessionModelState` view from an agent's
/// `config_options`: find the `select`-kind option whose `category` is
/// `Model` and map its `currentValue` + `options[]` to the old shape.
///
/// Returns `None` when the agent advertises no model selector (either no
/// `config_options` or no `Model`-category `select` option).
#[allow(clippy::module_name_repetitions)]
pub(crate) fn models_from_config_options(
    opts: Option<&[SessionConfigOption]>,
) -> Option<SessionModelState> {
    let opts = opts?;
    let opt = opts
        .iter()
        .find(|o| o.category == Some(SessionConfigOptionCategory::Model))?;
    let select = match &opt.kind {
        SessionConfigKind::Select(s) => s,
        _ => return None,
    };
    let current_model_id = select.current_value.0.as_ref().to_string();
    let available_models = match &select.options {
        SessionConfigSelectOptions::Ungrouped(items) => items
            .iter()
            .map(|o| SessionModel {
                model_id: o.value.0.as_ref().to_string(),
                name: o.name.clone(),
                description: o.description.clone(),
            })
            .collect::<Vec<_>>(),
        // Flatten grouped model selectors (e.g. models organized by provider)
        // into the same flat `available_models` list the picker expects.
        SessionConfigSelectOptions::Grouped(groups) => groups
            .iter()
            .flat_map(|g| g.options.iter())
            .map(|o| SessionModel {
                model_id: o.value.0.as_ref().to_string(),
                name: o.name.clone(),
                description: o.description.clone(),
            })
            .collect(),
        // Future-proof against new `SessionConfigSelectOptions` variants the
        // schema may add (the enum is `#[non_exhaustive]`); none today.
        _ => return None,
    };
    if available_models.is_empty() {
        return None;
    }
    Some(SessionModelState {
        current_model_id,
        available_models,
    })
}

/// Derive the agent-advertised configId of the Model selector from a session's
/// `config_options` (the `id` of the `select`-kind option whose `category` is
/// `Model`). Returns `None` when the agent advertises no model selector.
///
/// ACP 0.14 made model selection a `session/set_config_option` call, whose
/// `configId` is the agent-provided option id (conventionally `"model"` but not
/// guaranteed). This extracts the real id so `set_model` targets it precisely.
#[allow(clippy::module_name_repetitions)]
pub(crate) fn model_config_id_from_options(opts: Option<&[SessionConfigOption]>) -> Option<String> {
    let opts = opts?;
    let opt = opts
        .iter()
        .find(|o| o.category == Some(SessionConfigOptionCategory::Model))?;
    Some(opt.id.0.as_ref().to_string())
}

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
/// Event name: an agent asked a structured question (issue #411).
///
/// The renderer shows a morphing `AskUserQuestion` panel (choice cards,
/// checkboxes, approval buttons) instead of a free-text prompt; the user's
/// answer flows back via `acp_answer_question` (desktop) or `answer_question`
/// (web), mirroring the permission machinery exactly-once.
pub const EVENT_QUESTION_REQUEST: &str = "acp:question_request";
/// Event name: the agent requested structured user input (elicitation).
pub const EVENT_ELICITATION_REQUEST: &str = "acp:elicitation_request";
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
/// Event name: a durable agent-switch marker was recorded (CAP-2). Emitted
/// synthetically by the host after the `agent_switch` record is durable —
/// the record is the transcript authority, the event is live-only delivery.
pub const EVENT_AGENT_SWITCH: &str = "acp:agent_switch";
/// Event name: the agent reported context window utilization (and optional cost).
pub const EVENT_USAGE_UPDATE: &str = "acp:usage_update";
/// Event name: the agent tried to open a browser URL on a headless host and
/// the POSIX browser shim captured it (spec-acp-terminal-auth). Agent-level
/// (`sid = None`); the payload carries `{agentId, url}` so the renderer can
/// show the auth URL + paste-back affordance.
#[cfg(unix)]
pub const EVENT_BROWSER_OPEN_REQUEST: &str = "acp:browser_open_request";

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

/// An authentication method advertised by the agent in its `initialize`
/// response, propagated verbatim (opaque `id`/`name`/optional `description`)
/// plus the method `type` discriminator so the renderer can present the right
/// action — a Sign-in button for `agent`, a terminal tab for `terminal`, or an
/// env-var prompt for `env_var` — and call `authenticate(methodId)` before
/// `session/new`.
/// Wire contract (camelCase): `{id, name, description?, type, args?, env?}`
/// where `type` ∈ `'agent' | 'terminal' | 'env_var'`. `args: string[]` and
/// `env: Record<string,string>` are present only for `terminal` methods (the
/// command argv + env the renderer must run in a real terminal). `env_var`
/// forwards `type` only — the renderer shows a disabled "not supported" entry
/// (respawn-with-env is out of scope). No agent-type filtering is applied —
/// every advertised method is forwarded.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthMethodInfo {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Method discriminator: `'agent'` (browser/in-app), `'terminal'` (run
    /// `args` in a terminal), or `'env_var'` (supply env vars — forwarded as
    /// type-only; the renderer disables it).
    pub r#type: String,
    /// Terminal-method argv (present only when `type == "terminal"`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    /// Terminal-method env (present only when `type == "terminal"`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<std::collections::HashMap<String, String>>,
}

/// `acp:browser_open_request` — the POSIX browser shim captured an agent's
/// browser-open URL on a headless host (spec-acp-terminal-auth). Agent-level
/// (`sid = None`); the renderer shows the URL + a paste-back field for the
/// failed loopback redirect.
#[cfg(unix)]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserOpenRequestEvent {
    pub agent_id: AgentId,
    /// The full auth URL the agent tried to open (carries OAuth state — the
    /// renderer needs it verbatim; it is never logged).
    pub url: String,
}

/// `acp:agent_spawned`
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSpawnedEvent {
    pub agent_id: AgentId,
    pub capabilities: AgentCapabilities,
    /// Every authentication method the agent advertised at `initialize` (empty
    /// when the agent requires no authentication). Always serialized (as `[]`
    /// when empty) so the renderer sees a stable field.
    pub auth_methods: Vec<AuthMethodInfo>,
    /// True only when the host validated and prepared authentication for its
    /// managed Claude ACP installation before starting the agent.
    pub host_auth_ready: bool,
}

/// `acp:session_created`
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCreatedEvent {
    pub agent_id: AgentId,
    pub session_id: SessionId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modes: Option<agent_client_protocol::schema::v1::SessionModeState>,
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
    /// ACP `messageId`. Chunks with the same id belong to one message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
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

/// `acp:question_request` (issue #411)
///
/// A structured question from an agent. `question_id` is a stable correlation
/// id generated server-side (`q-{uuid}`) — the user's answer routes back
/// through it exactly once. `options` carry an explicit `cardinality`
/// (`single` | `multi` | absent → `single`) so the renderer can morph the
/// input area into choice cards, checkboxes, or approval buttons.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskUserQuestionEvent {
    pub agent_id: AgentId,
    pub session_id: SessionId,
    pub question_id: String,
    pub question: String,
    pub options: Vec<QuestionOption>,
}

/// `acp:elicitation_request`
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElicitationRequestEvent {
    pub agent_id: AgentId,
    pub session_id: SessionId,
    pub request_id: String,
    /// `form` or `url`.
    pub mode: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub fields: Vec<ElicitationField>,
    /// `_meta["cognition.ai/allowOther"] == true` — when set, the renderer adds
    /// an "Other" free-text affordance to each question card; its text submits
    /// as a non-option value (issue #935). Always serialized so the renderer
    /// sees a stable boolean.
    pub allow_other: bool,
}

/// One selectable option of an `enum`/`multi-enum` [`ElicitationField`].
///
/// `value` is the wire value that round-trips in the elicitation `content` map;
/// `label` is the human-readable text; `description` is optional context
/// (omitted from the wire when absent — mirrors [`QuestionOption`]).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElicitationOption {
    pub value: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// One primitive field of an elicitation form.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElicitationField {
    pub name: String,
    /// `string`, `number`, `integer`, `boolean`, `enum`, or `multi-enum`.
    /// `multi-enum` is a multi-select (`type:"array"`) property whose answer
    /// flows back as a string array.
    pub kind: String,
    pub required: bool,
    /// Property `title` — the header chip for question-style elicitations
    /// (issue #935); the renderer falls back to `name` when absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Property `description` — the question/help text under the chip.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub options: Vec<ElicitationOption>,
}

/// Map an untitled `enum` string (single-select `enum` or multi-select
/// `items.enum`) to the option contract: `value`/`label` are the raw string,
/// `description` is absent.
fn elicitation_plain_option(value: &str) -> ElicitationOption {
    ElicitationOption {
        value: value.to_string(),
        label: value.to_string(),
        description: None,
    }
}

/// Map a titled [`EnumOption`] (single-select `oneOf` or multi-select
/// `items.anyOf`) to the option contract (issue #935).
///
/// `value` is the wire `const` (it round-trips in `content`). `label` is the
/// option's `title` ONLY when a real `description` is also present — Devin's
/// `ask_user_question` puts the label in `const` and the descriptive sentence
/// in `title` (`{const:"Red",title:"Use the red color"}`), so with no
/// `description` field the label falls back to `const`. `description` is
/// `option.description ?? option.title` (always present for titled options).
///
/// Known trade-off: a spec-conformant `{const:"us",title:"United States"}`
/// (opaque const, no description) shows the const as the label — the two
/// wire shapes are indistinguishable without a `description`, and Devin's
/// shape is the one this renderer was built against.
fn elicitation_enum_option(option: &EnumOption) -> ElicitationOption {
    let (label, description) = match &option.description {
        Some(description) => (option.title.clone(), description.clone()),
        None => (option.value.clone(), option.title.clone()),
    };
    ElicitationOption {
        value: option.value.clone(),
        label,
        description: Some(description),
    }
}

/// Drop duplicate option values (first wins) — two options sharing a `const`
/// would collide as React keys and toggle together in the renderer.
fn dedupe_options(options: &mut Vec<ElicitationOption>) {
    let mut seen = std::collections::HashSet::new();
    options.retain(|option| seen.insert(option.value.clone()));
}

/// Extract the `cognition.ai/allowOther` flag from an elicitation request's
/// `_meta` (issue #935). Only a literal boolean `true` enables the renderer's
/// "Other" free-text affordance — absent, `false`, and non-boolean values all
/// read as `false`.
pub(crate) fn elicitation_allow_other(meta: Option<&Meta>) -> bool {
    meta.and_then(|meta| meta.get("cognition.ai/allowOther"))
        == Some(&serde_json::Value::Bool(true))
}

/// Flatten a form schema into the primitive fields the chat dialog can render.
///
/// `allow_other` is the request's `cognition.ai/allowOther` flag: an enum-like
/// field with an empty option list is only representable when free text can
/// stand in for the missing options.
///
/// Returns `None` when a **required** property uses a schema variant the dialog
/// cannot represent (unknown property `type`, or a multi-select whose `items`
/// is neither plain strings nor titled `anyOf` options) — the caller cancels
/// the elicitation. Unrepresentable *optional* properties are dropped, not
/// fatal.
///
/// Field order: `schema.properties` is a `BTreeMap` (lexicographic, so `q10`
/// would sort before `q2`); the agent's declared order survives only in
/// `required` — required fields emit first in `required` order, then the
/// optional remainder in schema order.
pub(crate) fn elicitation_fields(
    schema: &agent_client_protocol::schema::v1::ElicitationSchema,
    allow_other: bool,
) -> Option<Vec<ElicitationField>> {
    use agent_client_protocol::schema::v1::{ElicitationPropertySchema, MultiSelectItems};
    let required = schema.required.clone().unwrap_or_default();
    let mut by_name: std::collections::BTreeMap<String, ElicitationField> = schema
        .properties
        .iter()
        .filter_map(|(name, property)| {
            let (kind, title, description, mut options) = match property {
                ElicitationPropertySchema::String(value) => {
                    let mut options: Vec<ElicitationOption> = value
                        .enum_values
                        .clone()
                        .unwrap_or_default()
                        .iter()
                        .map(|option| elicitation_plain_option(option))
                        .collect();
                    if options.is_empty() {
                        if let Some(one_of) = &value.one_of {
                            options = one_of.iter().map(elicitation_enum_option).collect();
                        }
                    }
                    let kind = if options.is_empty() { "string" } else { "enum" };
                    (
                        kind.to_string(),
                        value.title.clone(),
                        value.description.clone(),
                        options,
                    )
                }
                ElicitationPropertySchema::Number(value) => (
                    "number".to_string(),
                    value.title.clone(),
                    value.description.clone(),
                    Vec::new(),
                ),
                ElicitationPropertySchema::Integer(value) => (
                    "integer".to_string(),
                    value.title.clone(),
                    value.description.clone(),
                    Vec::new(),
                ),
                ElicitationPropertySchema::Boolean(value) => (
                    "boolean".to_string(),
                    value.title.clone(),
                    value.description.clone(),
                    Vec::new(),
                ),
                ElicitationPropertySchema::Array(value) => {
                    // Multi-select (`type:"array"`): `items` decides whether the
                    // option list is representable — plain `enum` strings and
                    // titled `anyOf` options both map to `multi-enum`; any other
                    // `items` shape is unrepresentable (drop this field; the
                    // required check below cancels the request if it was
                    // required) — issue #935.
                    let options: Vec<ElicitationOption> = match &value.items {
                        MultiSelectItems::String(items) => items
                            .values
                            .iter()
                            .map(|item| elicitation_plain_option(item))
                            .collect(),
                        MultiSelectItems::Titled(items) => {
                            items.options.iter().map(elicitation_enum_option).collect()
                        }
                        _ => return None,
                    };
                    // An option-less multi-select is unanswerable when free
                    // text cannot stand in (no Other affordance) — treat it
                    // as unrepresentable rather than emitting a dead field.
                    if options.is_empty() && !allow_other {
                        return None;
                    }
                    (
                        "multi-enum".to_string(),
                        value.title.clone(),
                        value.description.clone(),
                        options,
                    )
                }
                ElicitationPropertySchema::Other(_) | _ => {
                    return None;
                }
            };
            dedupe_options(&mut options);
            Some((
                name.clone(),
                ElicitationField {
                    required: required.iter().any(|field| field == name),
                    name: name.clone(),
                    kind,
                    title,
                    description,
                    options,
                },
            ))
        })
        .collect();
    let covered: std::collections::HashSet<&str> = by_name.keys().map(String::as_str).collect();
    if required.iter().any(|name| !covered.contains(name.as_str())) {
        return None;
    }
    // Required fields first in the agent's declared `required` order (the
    // only order preserved through the BTreeMap properties map), then the
    // optional remainder in schema order.
    let mut fields: Vec<ElicitationField> = Vec::with_capacity(by_name.len());
    for name in &required {
        if let Some(field) = by_name.remove(name) {
            fields.push(field);
        }
    }
    fields.extend(by_name.into_values());
    Some(fields)
}

/// One selectable option of an [`AskUserQuestionEvent`].
///
/// `value` is the opaque id the agent consumes (stable, single-use); `label`
/// is the human-readable text; `description` is optional context; `cardinality`
/// is `single` (default) or `multi`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    pub value: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cardinality: Option<String>,
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

/// `acp:agent_switch` (CAP-2) — the live fan-out of a durable agent-switch
/// marker. Emitted only after `SessionPersistence::append_agent_switch`
/// flushed the record; the durable record (not this event) is the transcript
/// authority, so replay dedup is the watermark guard's job.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSwitchEvent {
    pub agent_id: AgentId,
    pub session_id: SessionId,
    pub from_config_id: String,
    pub to_config_id: String,
    /// The NEW session id the conversation continues in (CAP-7 reopen reads
    /// this from the durable record; the event mirrors it for live clients).
    pub new_session_id: String,
    pub summary_text: String,
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
mod tests;
