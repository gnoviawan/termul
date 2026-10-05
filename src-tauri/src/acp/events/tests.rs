use super::*;
use agent_client_protocol::schema::v1::SessionConfigSelectOption;

#[test]
fn agent_spawned_serializes_camel_case() {
    let event = AgentSpawnedEvent {
        agent_id: AgentId("agent-1".to_string()),
        capabilities: AgentCapabilities::default(),
        auth_methods: Vec::new(),
        host_auth_ready: true,
    };
    let value = serde_json::to_value(&event).unwrap();
    assert_eq!(value["agentId"], "agent-1");
    assert_eq!(value["hostAuthReady"], true);
    // AgentCapabilities serializes load_session as camelCase `loadSession`.
    assert_eq!(value["capabilities"]["loadSession"], false);
    // An agent with no advertised methods still carries an empty array so
    // the renderer sees a stable `authMethods` field.
    assert_eq!(value["authMethods"], serde_json::json!([]));
}

#[test]
fn agent_spawned_serializes_full_auth_methods() {
    let event = AgentSpawnedEvent {
        agent_id: AgentId("agent-1".to_string()),
        capabilities: AgentCapabilities::default(),
        auth_methods: vec![
            AuthMethodInfo {
                id: "cursor_login".to_string(),
                name: "Sign in with Cursor".to_string(),
                description: Some("Opens the Cursor login flow".to_string()),
                r#type: "agent".to_string(),
                args: None,
                env: None,
                args_mode: None,
            },
            AuthMethodInfo {
                id: "api_key".to_string(),
                name: "API key".to_string(),
                description: None,
                r#type: "agent".to_string(),
                args: None,
                env: None,
                args_mode: None,
            },
        ],
        host_auth_ready: false,
    };
    let value = serde_json::to_value(&event).unwrap();
    let methods = value["authMethods"].as_array().unwrap();
    assert_eq!(methods.len(), 2);
    assert_eq!(methods[0]["id"], "cursor_login");
    assert_eq!(methods[0]["name"], "Sign in with Cursor");
    assert_eq!(methods[0]["description"], "Opens the Cursor login flow");
    assert_eq!(methods[1]["id"], "api_key");
    assert_eq!(methods[1]["name"], "API key");
    // Absent description is omitted from the wire (not `null`).
    assert!(methods[1].get("description").is_none());
    // `type` is always serialized; `args`/`env` are omitted for non-terminal.
    assert_eq!(methods[0]["type"], "agent");
    assert!(methods[0].get("args").is_none());
    assert!(methods[0].get("env").is_none());
    assert!(methods[0].get("argsMode").is_none());
}

#[test]
fn auth_method_serializes_args_mode_for_terminal_login() {
    let method = AuthMethodInfo {
        id: "opencode-login".to_string(),
        name: "Login".to_string(),
        description: None,
        r#type: "terminal".to_string(),
        args: Some(vec!["auth".to_string(), "login".to_string()]),
        env: None,
        args_mode: Some("replace".to_string()),
    };
    let value = serde_json::to_value(&method).unwrap();
    assert_eq!(value["argsMode"], "replace");
    assert_eq!(value["args"], serde_json::json!(["auth", "login"]));
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
        content: ContentBlock::Text(agent_client_protocol::schema::v1::TextContent::new("hi")),
        message_id: Some("msg-1".to_string()),
    };
    let value = serde_json::to_value(&event).unwrap();
    assert_eq!(value["role"], "agent");
    assert_eq!(value["content"]["type"], "text");
    assert_eq!(value["content"]["text"], "hi");
    assert_eq!(value["messageId"], "msg-1");
}

#[test]
fn message_chunk_omits_message_id_when_absent() {
    let event = MessageChunkEvent {
        agent_id: AgentId("a".to_string()),
        session_id: SessionId::new("s"),
        role: ChunkRole::Agent,
        content: ContentBlock::Text(agent_client_protocol::schema::v1::TextContent::new("hi")),
        message_id: None,
    };
    let value = serde_json::to_value(&event).unwrap();
    assert!(value.get("messageId").is_none());
}

#[test]
fn permission_request_serializes_request_id() {
    let event = PermissionRequestEvent {
        agent_id: AgentId("a".to_string()),
        session_id: SessionId::new("s"),
        request_id: "req-7".to_string(),
        tool_call: agent_client_protocol::schema::v1::ToolCallUpdate::new(
            "tc-1",
            agent_client_protocol::schema::v1::ToolCallUpdateFields::new(),
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
    assert!(
        value.get("turnId").is_none(),
        "turnId must be absent when None"
    );
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

/// CAP-2: `AgentSwitchEvent` serializes camelCase with the full marker
/// identity (config ids + the NEW session id + summary text).
#[test]
fn agent_switch_serializes_camel_case() {
    let event = AgentSwitchEvent {
        agent_id: AgentId("a1".to_string()),
        session_id: SessionId::new("sess-old"),
        from_config_id: "omp".to_string(),
        to_config_id: "claude".to_string(),
        new_session_id: "sess-new".to_string(),
        summary_text: "Handoff summary".to_string(),
    };
    let value = serde_json::to_value(&event).unwrap();
    assert_eq!(value["agentId"], "a1");
    assert_eq!(value["sessionId"], "sess-old");
    assert_eq!(value["fromConfigId"], "omp");
    assert_eq!(value["toConfigId"], "claude");
    assert_eq!(value["newSessionId"], "sess-new");
    assert_eq!(value["summaryText"], "Handoff summary");
    assert_eq!(EVENT_AGENT_SWITCH, "acp:agent_switch");
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

/// Issue #411: `AskUserQuestionEvent` serializes camelCase with a stable
/// `questionId`, and `QuestionOption` carries value/label/description/
/// cardinality (omitting absent optionals).
#[test]
fn ask_user_question_serializes_camel_case() {
    let event = AskUserQuestionEvent {
        agent_id: AgentId("a1".to_string()),
        session_id: SessionId::new("sess-1"),
        question_id: "q-7".to_string(),
        question: "Which approach?".to_string(),
        options: vec![
            QuestionOption {
                value: "plan-a".to_string(),
                label: "Plan A".to_string(),
                description: Some("Fast, iterative".to_string()),
                cardinality: None,
            },
            QuestionOption {
                value: "both".to_string(),
                label: "Both".to_string(),
                description: None,
                cardinality: Some("multi".to_string()),
            },
        ],
    };
    let value = serde_json::to_value(&event).unwrap();
    assert_eq!(value["agentId"], "a1");
    assert_eq!(value["sessionId"], "sess-1");
    assert_eq!(value["questionId"], "q-7");
    assert_eq!(value["question"], "Which approach?");
    assert_eq!(value["options"][0]["value"], "plan-a");
    assert_eq!(value["options"][0]["label"], "Plan A");
    assert_eq!(value["options"][0]["description"], "Fast, iterative");
    // cardinality absent when None (single is the default)
    assert!(value["options"][0].get("cardinality").is_none());
    assert_eq!(value["options"][1]["value"], "both");
    assert_eq!(value["options"][1]["cardinality"], "multi");
    assert!(value["options"][1].get("description").is_none());
    assert_eq!(EVENT_QUESTION_REQUEST, "acp:question_request");
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

/// Build a Model-category `select` option for the derivation tests.
fn model_select_option(
    id: &'static str,
    current: &'static str,
    opts: &'static [(&'static str, &'static str)],
) -> SessionConfigOption {
    SessionConfigOption::select(
        id,
        "Model",
        current,
        opts.iter()
            .map(|(v, n)| SessionConfigSelectOption::new(*v, *n))
            .collect::<Vec<SessionConfigSelectOption>>(),
    )
    .category(SessionConfigOptionCategory::Model)
}

#[test]
fn models_from_config_options_derives_ungrouped() {
    let opts = vec![model_select_option(
        "model",
        "m1",
        &[("m1", "Model 1"), ("m2", "Model 2")],
    )];
    let state = models_from_config_options(Some(&opts)).expect("model option present");
    assert_eq!(state.current_model_id, "m1");
    assert_eq!(state.available_models.len(), 2);
    assert_eq!(state.available_models[0].model_id, "m1");
    assert_eq!(state.available_models[0].name, "Model 1");
    assert_eq!(state.available_models[1].model_id, "m2");
}

#[test]
fn models_from_config_options_returns_none_without_model_category() {
    // A non-Model-category select option must not populate the picker.
    let opt = SessionConfigOption::select(
        "mode",
        "Mode",
        "build",
        Vec::<SessionConfigSelectOption>::new(),
    )
    .category(SessionConfigOptionCategory::Mode);
    assert!(models_from_config_options(Some(&[opt])).is_none());
    assert!(models_from_config_options(None).is_none());
    assert!(models_from_config_options(Some(&[])).is_none());
}

#[test]
fn model_config_id_from_options_uses_advertised_id() {
    // CodeRabbit finding: an agent may use a configId other than "model"
    // for its Model selector. The helper must surface the real id.
    let opts = vec![model_select_option("llm_model", "m1", &[("m1", "M1")])];
    assert_eq!(
        model_config_id_from_options(Some(&opts)),
        Some("llm_model".to_string())
    );
    // Falls back to None when no Model-category option is advertised.
    let non_model = SessionConfigOption::select(
        "mode",
        "Mode",
        "build",
        Vec::<SessionConfigSelectOption>::new(),
    )
    .category(SessionConfigOptionCategory::Mode);
    assert_eq!(model_config_id_from_options(Some(&[non_model])), None);
}
