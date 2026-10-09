use super::*;
use agent_client_protocol::schema::v1::{ElicitationSchema, SessionConfigSelectOption};

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
            },
            AuthMethodInfo {
                id: "api_key".to_string(),
                name: "API key".to_string(),
                description: None,
                r#type: "agent".to_string(),
                args: None,
                env: None,
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
        code: None,
        data: None,
    };
    let value = serde_json::to_value(&event).unwrap();
    assert_eq!(value["agentId"], "a1");
    assert_eq!(value["message"], "child exited: signal 11");
    assert!(
        value.get("sessionId").is_none(),
        "sessionId must be absent when None (byte-identical to pre-1.9)"
    );
    assert_eq!(EVENT_AGENT_CRASHED, "acp:agent_crashed");
    assert!(
        value.get("code").is_none() && value.get("data").is_none(),
        "code/data must be absent when None (byte-identical to pre-821)"
    );
}

/// Story 1.9 FR26: `AgentCrashedEvent` with a session id (turn-scoped
/// crash) serializes the `sessionId` field.
#[test]
fn agent_crashed_serializes_session_id_when_set() {
    let event = AgentCrashedEvent {
        agent_id: AgentId("a1".to_string()),
        session_id: Some(SessionId::new("sess-1")),
        message: "turn timed out".to_string(),
        code: None,
        data: None,
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

// ---- issue #935: multi-question elicitation fields ----

/// A titled multi-select property (`type:"array"`, `items.anyOf`) flattens to
/// `multi-enum` carrying the property `title`/`description` and structured
/// options: `value = const`, `label = title` only when a `description` is also
/// present (else `const`), `description = option.description ?? option.title`.
#[test]
fn elicitation_fields_flattens_titled_multi_enum() {
    let schema: ElicitationSchema = serde_json::from_value(serde_json::json!({
        "type": "object",
        "required": ["q1"],
        "properties": {
            "q1": {
                "type": "array",
                "title": "Features",
                "description": "Which features should I enable?",
                "minItems": 1,
                "items": {
                    "anyOf": [
                        {"const": "Logging", "title": "Enable logging"},
                        {"const": "us", "title": "United States", "description": "Use US spelling"}
                    ]
                }
            }
        }
    }))
    .expect("schema deserializes");
    let fields = elicitation_fields(&schema, false).expect("titled multi-select is representable");
    assert_eq!(fields.len(), 1);
    let field = &fields[0];
    assert_eq!(field.name, "q1");
    assert_eq!(field.kind, "multi-enum");
    assert!(field.required);
    assert_eq!(field.title.as_deref(), Some("Features"));
    assert_eq!(
        field.description.as_deref(),
        Some("Which features should I enable?")
    );
    assert_eq!(field.options.len(), 2);
    // Devin-style option: the label lives in `const`; `title` becomes the
    // description when no real `description` field exists.
    assert_eq!(field.options[0].value, "Logging");
    assert_eq!(field.options[0].label, "Logging");
    assert_eq!(
        field.options[0].description.as_deref(),
        Some("Enable logging")
    );
    // Spec-conformant option: `title` is the label once `description` exists.
    assert_eq!(field.options[1].value, "us");
    assert_eq!(field.options[1].label, "United States");
    assert_eq!(
        field.options[1].description.as_deref(),
        Some("Use US spelling")
    );
}

/// An untitled multi-select (`items: {type:"string", enum:[...]}`) flattens to
/// `multi-enum` whose options carry `value == label == string` and no
/// description.
#[test]
fn elicitation_fields_flattens_untitled_multi_enum() {
    let schema: ElicitationSchema = serde_json::from_value(serde_json::json!({
        "type": "object",
        "required": ["q1"],
        "properties": {
            "q1": {
                "type": "array",
                "items": {"type": "string", "enum": ["alpha", "beta"]}
            }
        }
    }))
    .expect("schema deserializes");
    let fields = elicitation_fields(&schema, false).expect("string multi-select is representable");
    assert_eq!(fields.len(), 1);
    let field = &fields[0];
    assert_eq!(field.name, "q1");
    assert_eq!(field.kind, "multi-enum");
    assert!(field.required);
    assert_eq!(field.options.len(), 2);
    assert_eq!(field.options[0].value, "alpha");
    assert_eq!(field.options[0].label, "alpha");
    assert!(field.options[0].description.is_none());
}

/// Every representable property kind carries `title`/`description` through to
/// the emitted field (issue #935 — the question text, never the raw `qN`
/// property name).
#[test]
fn elicitation_fields_carries_title_and_description() {
    let schema: ElicitationSchema = serde_json::from_value(serde_json::json!({
        "type": "object",
        "properties": {
            "s": {"type": "string", "title": "S", "description": "string field"},
            "n": {"type": "number", "title": "N", "description": "number field"},
            "i": {"type": "integer", "title": "I", "description": "integer field"},
            "b": {"type": "boolean", "title": "B", "description": "boolean field"},
            "e": {"type": "string", "title": "E", "description": "enum field",
                  "enum": ["x"]},
            "m": {"type": "array", "title": "M", "description": "multi field",
                  "items": {"type": "string", "enum": ["y"]}}
        }
    }))
    .expect("schema deserializes");
    let fields = elicitation_fields(&schema, false).expect("all fields representable");
    let find = |name: &str| {
        fields
            .iter()
            .find(|field| field.name == name)
            .expect("field exists")
    };
    for (name, title, description) in [
        ("s", "S", "string field"),
        ("n", "N", "number field"),
        ("i", "I", "integer field"),
        ("b", "B", "boolean field"),
        ("e", "E", "enum field"),
        ("m", "M", "multi field"),
    ] {
        let field = find(name);
        assert_eq!(field.title.as_deref(), Some(title), "{name} title");
        assert_eq!(
            field.description.as_deref(),
            Some(description),
            "{name} description"
        );
    }
    assert_eq!(find("s").kind, "string");
    assert_eq!(find("n").kind, "number");
    assert_eq!(find("i").kind, "integer");
    assert_eq!(find("b").kind, "boolean");
    assert_eq!(find("e").kind, "enum");
    assert_eq!(find("m").kind, "multi-enum");
}

/// A titled single-select (`oneOf`) maps options the same way as titled
/// multi-select `items.anyOf` (issue #935 — the Devin `ask_user_question`
/// shape: label in `const`, descriptive sentence in `title`).
#[test]
fn elicitation_fields_flattens_titled_single_enum() {
    let schema: ElicitationSchema = serde_json::from_value(serde_json::json!({
        "type": "object",
        "required": ["q0"],
        "properties": {
            "q0": {
                "type": "string",
                "title": "Color",
                "description": "Which color should I use?",
                "oneOf": [
                    {"const": "Red", "title": "Use the red color"},
                    {"const": "Blue", "title": "Use the blue color"}
                ]
            }
        }
    }))
    .expect("schema deserializes");
    let fields = elicitation_fields(&schema, false).expect("oneOf is representable");
    assert_eq!(fields.len(), 1);
    let field = &fields[0];
    assert_eq!(field.name, "q0");
    assert_eq!(field.kind, "enum");
    assert!(field.required);
    assert_eq!(field.title.as_deref(), Some("Color"));
    assert_eq!(
        field.description.as_deref(),
        Some("Which color should I use?")
    );
    assert_eq!(field.options.len(), 2);
    assert_eq!(field.options[0].value, "Red");
    assert_eq!(field.options[0].label, "Red");
    assert_eq!(
        field.options[0].description.as_deref(),
        Some("Use the red color")
    );
    assert_eq!(field.options[1].value, "Blue");
    assert_eq!(field.options[1].label, "Blue");
}

/// An untitled `enum` keeps `value == label == string` with no description.
#[test]
fn elicitation_fields_flattens_untitled_single_enum() {
    let schema: ElicitationSchema = serde_json::from_value(serde_json::json!({
        "type": "object",
        "properties": {
            "pick": {"type": "string", "enum": ["a", "b"]}
        }
    }))
    .expect("schema deserializes");
    let fields = elicitation_fields(&schema, false).expect("enum is representable");
    assert_eq!(fields.len(), 1);
    let field = &fields[0];
    assert_eq!(field.kind, "enum");
    assert_eq!(field.options.len(), 2);
    assert_eq!(field.options[0].value, "a");
    assert_eq!(field.options[0].label, "a");
    assert!(field.options[0].description.is_none());
}

/// `elicitation_allow_other` reads only a literal `true` at
/// `_meta["cognition.ai/allowOther"]` (issue #935).
#[test]
fn elicitation_allow_other_reads_meta_flag() {
    let meta = Meta::from_iter([(
        "cognition.ai/allowOther".to_string(),
        serde_json::Value::Bool(true),
    )]);
    assert!(elicitation_allow_other(Some(&meta)));

    let meta = Meta::from_iter([(
        "cognition.ai/allowOther".to_string(),
        serde_json::Value::Bool(false),
    )]);
    assert!(!elicitation_allow_other(Some(&meta)));

    // A non-boolean value does not enable the affordance.
    let meta = Meta::from_iter([(
        "cognition.ai/allowOther".to_string(),
        serde_json::Value::String("yes".to_string()),
    )]);
    assert!(!elicitation_allow_other(Some(&meta)));

    // Key absent and `_meta` absent both read as false.
    assert!(!elicitation_allow_other(Some(&Meta::new())));
    assert!(!elicitation_allow_other(None));
}

/// `ElicitationRequestEvent` serializes `allowOther` plus the per-field
/// `title`/`description`/structured `options` (issue #935); absent optionals
/// are omitted from the wire, not `null`.
#[test]
fn elicitation_request_serializes_allow_other_and_field_metadata() {
    let event = ElicitationRequestEvent {
        agent_id: AgentId("a".to_string()),
        session_id: SessionId::new("s"),
        request_id: "r-1".to_string(),
        mode: "form".to_string(),
        message: "Which color?".to_string(),
        url: None,
        allow_other: true,
        fields: vec![
            ElicitationField {
                name: "q0".to_string(),
                kind: "enum".to_string(),
                required: true,
                title: Some("Color".to_string()),
                description: Some("Which color should I use?".to_string()),
                options: vec![ElicitationOption {
                    value: "Red".to_string(),
                    label: "Red".to_string(),
                    description: Some("Use the red color".to_string()),
                }],
            },
            ElicitationField {
                name: "q1".to_string(),
                kind: "multi-enum".to_string(),
                required: false,
                title: None,
                description: None,
                options: vec![ElicitationOption {
                    value: "x".to_string(),
                    label: "x".to_string(),
                    description: None,
                }],
            },
        ],
    };
    let value = serde_json::to_value(&event).unwrap();
    assert_eq!(value["allowOther"], true);
    assert_eq!(value["fields"][0]["title"], "Color");
    assert_eq!(
        value["fields"][0]["description"],
        "Which color should I use?"
    );
    assert_eq!(value["fields"][0]["options"][0]["value"], "Red");
    assert_eq!(value["fields"][0]["options"][0]["label"], "Red");
    assert_eq!(
        value["fields"][0]["options"][0]["description"],
        "Use the red color"
    );
    assert_eq!(value["fields"][1]["kind"], "multi-enum");
    // Absent title/description and absent option description are omitted.
    assert!(value["fields"][1].get("title").is_none());
    assert!(value["fields"][1].get("description").is_none());
    assert!(value["fields"][1]["options"][0]
        .get("description")
        .is_none());
    assert_eq!(EVENT_ELICITATION_REQUEST, "acp:elicitation_request");
}

/// A required property with an unrecognized schema variant keeps the existing
/// contract: `elicitation_fields` returns `None` → the caller cancels the
/// elicitation.
#[test]
fn elicitation_fields_required_unknown_variant_returns_none() {
    let schema: ElicitationSchema = serde_json::from_value(serde_json::json!({
        "type": "object",
        "required": ["mystery"],
        "properties": {
            "mystery": {"type": "matrix", "rows": 3},
            "name": {"type": "string"}
        }
    }))
    .expect("schema deserializes");
    assert!(elicitation_fields(&schema, false).is_none());
}

/// An OPTIONAL unrepresentable property is dropped, not fatal — the surviving
/// fields still render.
#[test]
fn elicitation_fields_drops_optional_unrepresentable_field() {
    let schema: ElicitationSchema = serde_json::from_value(serde_json::json!({
        "type": "object",
        "properties": {
            "mystery": {"type": "matrix", "rows": 3},
            "name": {"type": "string", "title": "Name"}
        }
    }))
    .expect("schema deserializes");
    let fields = elicitation_fields(&schema, false)
        .expect("optional unknown variant must not cancel the request");
    assert_eq!(fields.len(), 1);
    assert_eq!(fields[0].name, "name");
    assert_eq!(fields[0].title.as_deref(), Some("Name"));
}

/// A multi-select whose `items` is an unknown shape is unrepresentable: the
/// field is dropped when optional and cancels the request when required — the
/// same treatment as an unknown property variant.
#[test]
fn elicitation_fields_multi_enum_other_items_unrepresentable() {
    // Required → the whole request is unrepresentable.
    let schema: ElicitationSchema = serde_json::from_value(serde_json::json!({
        "type": "object",
        "required": ["q1"],
        "properties": {
            "q1": {"type": "array", "items": {"type": "number"}}
        }
    }))
    .expect("schema deserializes");
    assert!(elicitation_fields(&schema, false).is_none());

    // Optional → the field is dropped, the rest still render.
    let schema: ElicitationSchema = serde_json::from_value(serde_json::json!({
        "type": "object",
        "properties": {
            "q1": {"type": "array", "items": {"type": "number"}},
            "name": {"type": "string"}
        }
    }))
    .expect("schema deserializes");
    let fields = elicitation_fields(&schema, false)
        .expect("optional unrepresentable multi-select is dropped");
    assert_eq!(fields.len(), 1);
    assert_eq!(fields[0].name, "name");
}

/// Fields emit in the agent's declared order — `required` order first
/// (`properties` is a BTreeMap, so raw iteration would sort `q10` before
/// `q2`), optional fields afterwards in schema order.
#[test]
fn elicitation_fields_orders_required_first_in_declared_order() {
    let schema: ElicitationSchema = serde_json::from_value(serde_json::json!({
        "type": "object",
        "required": ["q2", "q10"],
        "properties": {
            "q10": {"type": "string", "enum": ["a"]},
            "q2": {"type": "string", "enum": ["b"]},
            "extra": {"type": "string"}
        }
    }))
    .expect("schema deserializes");
    let fields = elicitation_fields(&schema, false).expect("all fields representable");
    let names: Vec<&str> = fields.iter().map(|field| field.name.as_str()).collect();
    assert_eq!(names, ["q2", "q10", "extra"]);
}

/// Duplicate option values collapse to one (first wins) — same-value options
/// would collide as keys and toggle together in the renderer.
#[test]
fn elicitation_fields_dedupes_option_values() {
    let schema: ElicitationSchema = serde_json::from_value(serde_json::json!({
        "type": "object",
        "properties": {
            "q0": {
                "type": "string",
                "oneOf": [
                    {"const": "Red", "title": "Use the red color"},
                    {"const": "Red", "title": "Duplicate red"}
                ]
            }
        }
    }))
    .expect("schema deserializes");
    let fields = elicitation_fields(&schema, false).expect("oneOf is representable");
    assert_eq!(fields[0].options.len(), 1);
    assert_eq!(
        fields[0].options[0].description.as_deref(),
        Some("Use the red color")
    );
}

/// A multi-select with an EMPTY option list is unrepresentable without
/// `allowOther` (nothing to pick and no free-text stand-in — a required one
/// would wedge the form) but representable with it ("Other" supplies the
/// answer).
#[test]
fn elicitation_fields_empty_multi_enum_needs_allow_other() {
    let schema = || {
        serde_json::from_value::<ElicitationSchema>(serde_json::json!({
            "type": "object",
            "required": ["q1"],
            "properties": {
                "q1": {"type": "array", "title": "Features", "items": {"anyOf": []}}
            }
        }))
        .expect("schema deserializes")
    };
    assert!(elicitation_fields(&schema(), false).is_none());
    let fields = elicitation_fields(&schema(), true).expect("allowOther makes it answerable");
    assert_eq!(fields[0].kind, "multi-enum");
    assert!(fields[0].options.is_empty());
}

/// A `required` entry absent from `properties` fails the coverage check —
/// the field can never be rendered, so the request cancels.
#[test]
fn elicitation_fields_required_name_absent_from_properties_returns_none() {
    let schema: ElicitationSchema = serde_json::from_value(serde_json::json!({
        "type": "object",
        "required": ["ghost"],
        "properties": {
            "name": {"type": "string"}
        }
    }))
    .expect("schema deserializes");
    assert!(elicitation_fields(&schema, false).is_none());
}

/// When a string property carries BOTH `enum` and `oneOf`, the `enum` values
/// win (the first non-empty option source — matching the pre-existing arm
/// order).
#[test]
fn elicitation_fields_enum_takes_precedence_over_one_of() {
    let schema: ElicitationSchema = serde_json::from_value(serde_json::json!({
        "type": "object",
        "properties": {
            "q0": {
                "type": "string",
                "enum": ["plain"],
                "oneOf": [{"const": "titled", "title": "Titled option"}]
            }
        }
    }))
    .expect("schema deserializes");
    let fields = elicitation_fields(&schema, false).expect("enum is representable");
    assert_eq!(fields[0].options.len(), 1);
    assert_eq!(fields[0].options[0].value, "plain");
}

/// gh-821: an RPC error carrying code + data flattens to the unchanged
/// `Display` message plus the structured code/data.
#[test]
fn error_detail_from_rpc_error_with_data() {
    let rpc = agent_client_protocol::Error::new(-32000, "auth")
        .data(serde_json::json!({ "reason": "login" }));
    let detail = AcpErrorDetail::from(&rpc);
    assert_eq!(detail.message, rpc.to_string());
    assert_eq!(detail.code, Some(-32000));
    assert_eq!(detail.data, Some(serde_json::json!({ "reason": "login" })));
}

/// gh-821: an RPC error without data keeps the code and leaves data absent.
#[test]
fn error_detail_from_rpc_error_without_data() {
    let rpc = agent_client_protocol::Error::internal_error();
    let detail = AcpErrorDetail::from(rpc.clone());
    assert_eq!(detail.message, rpc.to_string());
    assert_eq!(detail.code, Some(-32603));
    assert_eq!(detail.data, None);
}

/// gh-821: a plain string (timeouts, flush failures) carries no code/data.
#[test]
fn error_detail_from_string_has_no_code_or_data() {
    let detail = AcpErrorDetail::from("turn idle timeout".to_string());
    assert_eq!(detail.message, "turn idle timeout");
    assert_eq!(detail.code, None);
    assert_eq!(detail.data, None);
    assert_eq!(detail.to_string(), "turn idle timeout");
}

/// gh-821: `agent_error` / `agent_crashed` serialize code + data when set and
/// omit both keys (no `null`) when `None`.
#[test]
fn agent_error_and_crashed_serialize_code_and_data() {
    let data = serde_json::json!({ "hint": "retry" });
    let error = AgentErrorEvent {
        agent_id: AgentId("a1".to_string()),
        session_id: Some(SessionId::new("s1")),
        message: "boom".to_string(),
        code: Some(-32000),
        data: Some(data.clone()),
    };
    let value = serde_json::to_value(&error).unwrap();
    assert_eq!(value["code"], -32000);
    assert_eq!(value["data"], data);
    assert_eq!(value["message"], "boom");

    let crashed = AgentCrashedEvent {
        agent_id: AgentId("a1".to_string()),
        session_id: None,
        message: "boom".to_string(),
        code: Some(-32603),
        data: None,
    };
    let value = serde_json::to_value(&crashed).unwrap();
    assert_eq!(value["code"], -32603);
    assert!(value.get("data").is_none());

    let bare = AgentErrorEvent {
        agent_id: AgentId("a1".to_string()),
        session_id: None,
        message: "timeout".to_string(),
        code: None,
        data: None,
    };
    let value = serde_json::to_value(&bare).unwrap();
    assert!(value.get("code").is_none());
    assert!(value.get("data").is_none());
}

/// gh-821: the event builders carry the RPC code/data into both events with
/// the `Display` message unchanged (the turn-error + teardown wiring).
#[test]
fn error_detail_builds_events_with_code_and_data() {
    let rpc = agent_client_protocol::Error::new(-32000, "auth")
        .data(serde_json::json!({ "reason": "login" }));
    let detail = AcpErrorDetail::from(&rpc);

    let error = detail
        .clone()
        .into_agent_error(AgentId("a1".to_string()), Some(SessionId::new("s1")));
    let value = serde_json::to_value(&error).unwrap();
    assert_eq!(value["message"], rpc.to_string());
    assert_eq!(value["code"], -32000);
    assert_eq!(value["data"]["reason"], "login");
    assert_eq!(value["sessionId"], "s1");

    let crashed = detail.into_agent_crashed(AgentId("a1".to_string()), None);
    let value = serde_json::to_value(&crashed).unwrap();
    assert_eq!(value["code"], -32000);
    assert_eq!(value["data"]["reason"], "login");
    assert!(value.get("sessionId").is_none());
}

/// gh-821: masking (Factory Droid) drops the structured code/data along with
/// the message, so neither event leaks agent-supplied detail.
#[test]
fn masked_error_detail_drops_code_and_data() {
    let rpc = agent_client_protocol::Error::new(-32000, "secret")
        .data(serde_json::json!({ "token": "x" }));
    let masked = AcpErrorDetail::from(&rpc).masked("generic failure");
    assert_eq!(masked.message, "generic failure");
    assert_eq!(masked.code, None);
    assert_eq!(masked.data, None);

    let value = serde_json::to_value(
        masked
            .clone()
            .into_agent_crashed(AgentId("a1".to_string()), None),
    )
    .unwrap();
    assert!(value.get("code").is_none());
    assert!(value.get("data").is_none());
    let value =
        serde_json::to_value(masked.into_agent_error(AgentId("a1".to_string()), None)).unwrap();
    assert!(value.get("code").is_none());
    assert!(value.get("data").is_none());
}
