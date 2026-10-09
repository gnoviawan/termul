use super::*;
use agent_client_protocol::schema::v1::{
    NewSessionRequest, NewSessionResponse, SessionConfigSelectOption,
};
use agent_client_protocol::{Agent, ConnectionTo};
use serde_json::json;

fn model_select(
    config_id: &'static str,
    current: &'static str,
    options: &'static [(&'static str, &'static str)],
) -> SessionConfigOption {
    SessionConfigOption::select(
        config_id,
        "Model",
        current,
        options
            .iter()
            .map(|(value, name)| SessionConfigSelectOption::new(*value, *name))
            .collect::<Vec<SessionConfigSelectOption>>(),
    )
    .category(SessionConfigOptionCategory::Model)
}

fn legacy_state() -> SessionModelState {
    SessionModelState {
        current_model_id: "legacy-1".to_string(),
        available_models: vec![SessionModel {
            model_id: "legacy-1".to_string(),
            name: "Legacy One".to_string(),
            description: None,
        }],
    }
}

#[test]
fn parses_legacy_models_with_optional_description() {
    let result = json!({
        "sessionId": "s1",
        "models": {
            "currentModelId": "m1",
            "availableModels": [
                {"modelId": "m1", "name": "Model 1", "description": "Fast"},
                {"modelId": "m2", "name": "Model 2"}
            ]
        }
    });
    let state = legacy_models_from_value(&result).expect("legacy models parsed");
    assert_eq!(state.current_model_id, "m1");
    assert_eq!(state.available_models.len(), 2);
    assert_eq!(state.available_models[0].name, "Model 1");
    assert_eq!(
        state.available_models[0].description.as_deref(),
        Some("Fast")
    );
    assert_eq!(state.available_models[1].model_id, "m2");
    assert_eq!(state.available_models[1].description, None);
    // Same wire shape the renderer already consumes.
    assert_eq!(
        serde_json::to_value(&state).unwrap(),
        json!({
            "currentModelId": "m1",
            "availableModels": [
                {"modelId": "m1", "name": "Model 1", "description": "Fast"},
                {"modelId": "m2", "name": "Model 2"}
            ]
        })
    );
}

#[test]
fn legacy_models_name_falls_back_to_id_and_skips_bad_entries() {
    let result = json!({
        "models": {
            "currentModelId": "m1",
            "availableModels": [
                {"modelId": "m1"},
                {"name": "no id"},
                {"modelId": 7, "name": "numeric id"},
                {"modelId": "", "name": "empty id"},
                "not an object"
            ]
        }
    });
    let state = legacy_models_from_value(&result).expect("one valid entry remains");
    assert_eq!(state.available_models.len(), 1);
    assert_eq!(state.available_models[0].model_id, "m1");
    assert_eq!(state.available_models[0].name, "m1");
}

#[test]
fn duplicate_legacy_model_ids_are_collapsed() {
    let result = json!({
        "models": {
            "currentModelId": "m1",
            "availableModels": [
                {"modelId": "m1", "name": "First"},
                {"modelId": "m1", "name": "Second"},
                {"modelId": "m2", "name": "Other"}
            ]
        }
    });
    let state = legacy_models_from_value(&result).expect("legacy models parsed");
    let ids: Vec<&str> = state
        .available_models
        .iter()
        .map(|m| m.model_id.as_str())
        .collect();
    assert_eq!(ids, ["m1", "m2"]);
    assert_eq!(state.available_models[0].name, "First");
}

#[test]
fn malformed_or_empty_legacy_models_yield_none() {
    for result in [
        json!({}),
        json!({"models": null}),
        json!({"models": "nope"}),
        json!({"models": []}),
        json!({"models": {"currentModelId": "m1"}}),
        json!({"models": {"currentModelId": "m1", "availableModels": "x"}}),
        json!({"models": {"currentModelId": "m1", "availableModels": []}}),
        json!({"models": {"currentModelId": "m1", "availableModels": [{"name": "x"}]}}),
        json!({"models": {"availableModels": [{"modelId": "m1", "name": "M1"}]}}),
        json!({"models": {"currentModelId": 3, "availableModels": [{"modelId": "m1"}]}}),
        json!(null),
        json!("string result"),
    ] {
        assert_eq!(legacy_models_from_value(&result), None, "input: {result}");
    }
}

#[test]
fn config_option_wins_over_legacy_models() {
    let opts = vec![model_select("model", "m1", &[("m1", "M1"), ("m2", "M2")])];
    let resolved = resolve_models(Some(&opts), Some(legacy_state()));
    assert_eq!(resolved.models, models_from_config_options(Some(&opts)));
    assert_eq!(resolved.models.as_ref().unwrap().current_model_id, "m1");
    assert!(!resolved.legacy_only);
}

#[test]
fn empty_model_config_option_is_authoritative_over_legacy_models() {
    let opts = vec![model_select("model", "m1", &[])];
    let resolved = resolve_models(Some(&opts), Some(legacy_state()));
    assert_eq!(resolved.models, None);
    assert!(!resolved.legacy_only);
}

#[test]
fn legacy_models_used_when_no_model_config_option() {
    let mode_opt = SessionConfigOption::select(
        "mode",
        "Mode",
        "build",
        Vec::<SessionConfigSelectOption>::new(),
    )
    .category(SessionConfigOptionCategory::Mode);
    for opts in [None, Some(vec![]), Some(vec![mode_opt])] {
        let resolved = resolve_models(opts.as_deref(), Some(legacy_state()));
        assert_eq!(resolved.models, Some(legacy_state()));
        assert!(resolved.legacy_only);
    }
}

#[test]
fn neither_source_yields_none() {
    let resolved = resolve_models(None, None);
    assert_eq!(resolved.models, None);
    assert!(!resolved.legacy_only);
    let resolved = resolve_models(Some(&[]), None);
    assert_eq!(resolved.models, None);
    assert!(!resolved.legacy_only);
}

/// Drive `send_with_legacy_models` against an in-process raw-JSON agent that
/// answers `session/new` with the given result value.
async fn session_new_against(
    result: Value,
) -> Result<WithLegacyModels<NewSessionResponse>, String> {
    use agent_client_protocol::{Channel, Client, Responder};
    let (agent_channel, client_channel) = Channel::duplex();
    let agent = Agent.builder().on_receive_request(
        async move |_request: agent_client_protocol::UntypedMessage,
                    responder: Responder<Value>,
                    _cx: ConnectionTo<Client>| { responder.respond(result.clone()) },
        agent_client_protocol::on_receive_request!(),
    );
    let agent_task = tokio::task::spawn_local(async move {
        let _ = agent.connect_to(agent_channel).await;
    });
    let outcome = Client
        .builder()
        .connect_with(client_channel, async |cx: ConnectionTo<Agent>| {
            send_with_legacy_models(&cx, NewSessionRequest::new("/work")).await
        })
        .await
        .map_err(|error| error.to_string());
    agent_task.abort();
    outcome
}

#[tokio::test(flavor = "current_thread")]
async fn raw_session_new_surfaces_legacy_models_the_typed_response_drops() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let sent = session_new_against(json!({
                "sessionId": "s1",
                "models": {
                    "currentModelId": "m2",
                    "availableModels": [
                        {"modelId": "m1", "name": "Model 1"},
                        {"modelId": "m2", "name": "Model 2"}
                    ]
                }
            }))
            .await
            .expect("session/new succeeds");
            assert_eq!(sent.response.session_id.0.as_ref(), "s1");
            assert!(sent.response.config_options.is_none());
            let legacy = sent.legacy.expect("legacy models extracted");
            assert_eq!(legacy.current_model_id, "m2");
            assert_eq!(legacy.available_models.len(), 2);
            let resolved = resolve_models(sent.response.config_options.as_deref(), Some(legacy));
            assert!(resolved.legacy_only);
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn raw_session_new_without_models_still_succeeds() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let sent = session_new_against(json!({"sessionId": "s2", "models": "garbage"}))
                .await
                .expect("malformed legacy models never fail the request");
            assert_eq!(sent.response.session_id.0.as_ref(), "s2");
            assert_eq!(sent.legacy, None);
            let err = session_new_against(json!({"models": null}))
                .await
                .expect_err("a typed-invalid result still errors like the SDK would");
            assert!(!err.is_empty());
        })
        .await;
}
