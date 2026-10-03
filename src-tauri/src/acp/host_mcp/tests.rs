use super::*;
use crate::web::sink::AcpEvent;
use serde_json::Value;
use std::sync::Mutex as StdMutex;

/// Test sink that captures every emitted event (for plan_update assertions).
#[derive(Default)]
struct CapturingSink {
    events: StdMutex<Vec<(String, Value)>>,
}

impl EventSink for CapturingSink {
    fn emit(&self, event: &AcpEvent) {
        let type_ = event.type_.to_string();
        let payload = event.payload.clone();
        self.events.lock().unwrap().push((type_, payload));
    }
}

fn make_ids() -> (AgentId, SessionId) {
    (AgentId::new(), SessionId::new("sess-test"))
}

#[test]
fn map_todos_preserves_order_and_maps_status_priority() {
    let todos = vec![
        TermulPlanTodo {
            content: "a".into(),
            status: Some("in_progress".into()),
            priority: Some("high".into()),
        },
        TermulPlanTodo {
            content: "b".into(),
            status: Some("completed".into()),
            priority: Some("medium".into()),
        },
        TermulPlanTodo {
            content: "c".into(),
            status: None,
            priority: None,
        },
    ];
    let entries = map_todos_to_plan_entries(&todos);
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0].content, "a");
    assert_eq!(entries[0].status, PlanEntryStatus::InProgress);
    assert_eq!(entries[0].priority, PlanEntryPriority::High);
    assert_eq!(entries[1].status, PlanEntryStatus::Completed);
    assert_eq!(entries[1].priority, PlanEntryPriority::Medium);
    // Defaults: Pending + Low.
    assert_eq!(entries[2].status, PlanEntryStatus::Pending);
    assert_eq!(entries[2].priority, PlanEntryPriority::Low);
}

#[test]
fn map_todos_unknown_status_priority_falls_back() {
    let todos = vec![TermulPlanTodo {
        content: "x".into(),
        status: Some("bogus".into()),
        priority: Some("nope".into()),
    }];
    let entries = map_todos_to_plan_entries(&todos);
    assert_eq!(entries[0].status, PlanEntryStatus::Pending);
    assert_eq!(entries[0].priority, PlanEntryPriority::Low);
}

#[test]
fn emit_plan_update_fires_event_with_entries() {
    let sink = Arc::new(CapturingSink::default());
    let sinks: Vec<Arc<dyn EventSink>> = vec![sink.clone()];
    let (agent_id, session_id) = make_ids();
    let todos = vec![
        TermulPlanTodo {
            content: "one".into(),
            status: None,
            priority: None,
        },
        TermulPlanTodo {
            content: "two".into(),
            status: None,
            priority: None,
        },
        TermulPlanTodo {
            content: "three".into(),
            status: None,
            priority: None,
        },
    ];
    let entries = map_todos_to_plan_entries(&todos);
    emit_plan_update(&sinks, &agent_id, &session_id, entries);

    let captured = sink.events.lock().unwrap();
    assert_eq!(captured.len(), 1);
    let (type_, payload) = &captured[0];
    assert_eq!(type_, events::EVENT_PLAN_UPDATE);
    assert_eq!(payload["agentId"], agent_id.0);
    assert_eq!(payload["sessionId"], session_id.0);
    assert_eq!(payload["plan"]["entries"].as_array().unwrap().len(), 3);
    assert_eq!(payload["plan"]["entries"][0]["content"], "one");
}

#[test]
fn emit_plan_update_empty_entries_emits_clear() {
    // The renderer's `_onPlanUpdate` treats `entries.length === 0` as
    // "clear the plan" (dropPlanForSession). Verify the host emits exactly
    // that shape for an empty todos list.
    let sink = Arc::new(CapturingSink::default());
    let sinks: Vec<Arc<dyn EventSink>> = vec![sink.clone()];
    let (agent_id, session_id) = make_ids();
    emit_plan_update(&sinks, &agent_id, &session_id, vec![]);

    let captured = sink.events.lock().unwrap();
    assert_eq!(captured.len(), 1);
    let (type_, payload) = &captured[0];
    assert_eq!(type_, events::EVENT_PLAN_UPDATE);
    let entries = payload["plan"]["entries"].as_array().unwrap();
    assert!(
        entries.is_empty(),
        "empty todos must emit an empty entries array"
    );
}

#[test]
fn title_frame_round_trips_with_kind_and_title() {
    let frame = FrameRequest {
        token: "token".into(),
        session_id: "provisional".into(),
        kind: FrameKind::SetTitle,
        todos: Vec::new(),
        title: Some("Fix login bug".into()),
        browser_action: None,
        browser_args: None,
        browser_element: None,
    };
    let value = serde_json::to_value(&frame).unwrap();
    assert_eq!(value["kind"], "set_title");
    assert_eq!(value["title"], "Fix login bug");
    let decoded: FrameRequest = serde_json::from_value(value).unwrap();
    assert_eq!(decoded.kind, FrameKind::SetTitle);
    assert_eq!(decoded.title.as_deref(), Some("Fix login bug"));
}

#[test]
fn frame_reply_serializes_ok_and_err() {
    let ok = serde_json::to_value(FrameReply::ok()).unwrap();
    assert_eq!(ok["ok"], true);
    assert!(ok.get("error").is_none() || ok["error"].is_null());

    let err = serde_json::to_value(FrameReply::err("auth rejected")).unwrap();
    assert_eq!(err["ok"], false);
    assert_eq!(err["error"], "auth rejected");
}

// ---------------------------------------------------------------------------
// `TermulBrowserInput` deserializer matrix — replays the bug-evidence payload
// set from the 2026-10-03 live failure session verbatim (spec
// spec-acp-browser-automation-v2 CAP-1). Flat and nested forms must both
// yield readable args; a string `args` must fail with `invalid_params` naming
// the expected field.
// ---------------------------------------------------------------------------

fn browser_input(payload: Value) -> Result<TermulBrowserInput, serde_json::Error> {
    serde_json::from_value(payload)
}

#[test]
fn browser_input_flat_form_folds_unknown_top_level_keys_into_args() {
    // Bug-evidence payload 1 (flat navigate — the observed failure shape).
    let input = browser_input(serde_json::json!({
        "action": "navigate",
        "url": "https://example.com"
    }))
    .unwrap();
    assert_eq!(input.action, "navigate");
    assert_eq!(input.args["url"], "https://example.com");
    assert!(input.element.is_none());
}

#[test]
fn browser_input_nested_form_keeps_args_object() {
    // Bug-evidence payload 2 (nested navigate).
    let input = browser_input(serde_json::json!({
        "action": "navigate",
        "args": { "url": "https://example.com" }
    }))
    .unwrap();
    assert_eq!(input.action, "navigate");
    assert_eq!(input.args["url"], "https://example.com");
}

#[test]
fn browser_input_string_args_fails_with_invalid_params_naming_url() {
    // Bug-evidence payload 3 (args as a JSON string).
    let err = browser_input(serde_json::json!({
        "action": "navigate",
        "args": "{\"url\": \"https://example.com\"}"
    }))
    .expect_err("string args must be rejected");
    let msg = err.to_string();
    assert!(msg.contains("invalid_params"), "message: {msg}");
    assert!(msg.contains("url"), "must name the expected field: {msg}");
}

#[test]
fn browser_input_wait_ms_and_text_flat_forms_reach_args() {
    // Bug-evidence payload 4 (wait {ms} / wait {text} flat).
    let ms = browser_input(serde_json::json!({
        "action": "wait",
        "ms": 500
    }))
    .unwrap();
    assert_eq!(ms.args["ms"], 500);

    let text = browser_input(serde_json::json!({
        "action": "wait",
        "text": "Indonesia"
    }))
    .unwrap();
    assert_eq!(text.args["text"], "Indonesia");
}

#[test]
fn browser_input_nested_args_wins_over_flat_conflict() {
    // Flat folds only absent keys — a nested `args` value wins on conflicts.
    let input = browser_input(serde_json::json!({
        "action": "navigate",
        "url": "https://flat.example.com",
        "args": { "url": "https://nested.example.com" }
    }))
    .unwrap();
    assert_eq!(input.args["url"], "https://nested.example.com");
    assert_eq!(
        input.args.as_object().map(|m| m.len()),
        Some(1),
        "the flat value must not survive as a second entry"
    );
}

#[test]
fn browser_input_unknown_extra_keys_fold_and_are_ignored_by_argless_actions() {
    let input = browser_input(serde_json::json!({
        "action": "list_tabs",
        "foo": 1
    }))
    .unwrap();
    assert_eq!(input.args["foo"], 1);
}

#[test]
fn browser_input_new_tab_without_url_deserializes_with_null_args() {
    // Bug-evidence payload 5 (new_tab, no url): the deserializer accepts it —
    // the `invalid_params` naming 'url' comes from the act() missing-arg
    // check (no blank tab is opened).
    let input = browser_input(serde_json::json!({
        "action": "new_tab"
    }))
    .unwrap();
    assert_eq!(input.action, "new_tab");
    assert!(input.args.is_null());
}

#[test]
fn browser_input_no_params_yields_null_args() {
    let input = browser_input(serde_json::json!({ "action": "snapshot" })).unwrap();
    assert_eq!(input.action, "snapshot");
    assert!(input.args.is_null());
    assert!(input.element.is_none());
}

#[test]
fn browser_input_element_stays_top_level_and_is_not_folded() {
    let input = browser_input(serde_json::json!({
        "action": "click",
        "ref": "@e2",
        "element": "the login button"
    }))
    .unwrap();
    assert_eq!(input.element.as_deref(), Some("the login button"));
    assert_eq!(input.args["ref"], "@e2");
    assert!(
        input.args.get("element").is_none(),
        "element must not be folded into args"
    );
}

#[test]
fn browser_input_missing_action_is_rejected() {
    let err = browser_input(serde_json::json!({ "url": "https://example.com" }))
        .expect_err("missing action must be rejected");
    let msg = err.to_string();
    assert!(msg.contains("invalid_params"), "message: {msg}");
    assert!(msg.contains("action"), "must name 'action': {msg}");
}

#[test]
fn browser_input_non_string_args_object_types_are_rejected() {
    for bad in [
        serde_json::json!({ "action": "wait", "args": 500 }),
        serde_json::json!({ "action": "wait", "args": true }),
        serde_json::json!({ "action": "wait", "args": [1, 2] }),
    ] {
        let err = browser_input(bad).expect_err("non-object args must be rejected");
        let msg = err.to_string();
        assert!(msg.contains("invalid_params"), "message: {msg}");
    }
}

#[test]
fn browser_input_string_args_on_wait_names_ms_and_text() {
    let err = browser_input(serde_json::json!({
        "action": "wait",
        "args": "{\"ms\": 500}"
    }))
    .expect_err("string args must be rejected");
    let msg = err.to_string();
    assert!(msg.contains("invalid_params"), "message: {msg}");
    assert!(msg.contains("ms"), "must name 'ms': {msg}");
    assert!(msg.contains("text"), "must name 'text': {msg}");
}

#[test]
fn browser_input_flat_tab_id_folds_into_args() {
    let input = browser_input(serde_json::json!({
        "action": "close_tab",
        "tabId": "agent-1"
    }))
    .unwrap();
    assert_eq!(input.action, "close_tab");
    assert_eq!(input.args["tabId"], "agent-1");
}

#[test]
fn browser_input_nested_element_is_hoisted_when_top_level_absent() {
    let input = browser_input(serde_json::json!({
        "action": "click",
        "args": { "ref": "@e2", "element": "the login button" }
    }))
    .unwrap();
    assert_eq!(input.element.as_deref(), Some("the login button"));
    assert_eq!(input.args["ref"], "@e2");
    assert!(
        input.args.get("element").is_none(),
        "hoisted element must not stay in args"
    );
}

#[test]
fn browser_input_top_level_element_wins_over_nested() {
    let input = browser_input(serde_json::json!({
        "action": "click",
        "element": "the top-level intent",
        "args": { "ref": "@e2", "element": "the nested intent" }
    }))
    .unwrap();
    assert_eq!(input.element.as_deref(), Some("the top-level intent"));
}

#[test]
fn browser_input_non_object_body_is_rejected() {
    for bad in [
        serde_json::json!("navigate"),
        serde_json::json!(5),
        serde_json::json!([1, 2]),
    ] {
        let err = browser_input(bad).expect_err("non-object body must be rejected");
        let msg = err.to_string();
        assert!(msg.contains("invalid_params"), "message: {msg}");
        assert!(msg.contains("JSON object"), "message: {msg}");
    }
}

#[test]
fn browser_input_non_string_action_is_rejected() {
    let err = browser_input(serde_json::json!({ "action": 5, "url": "https://example.com" }))
        .expect_err("non-string action must be rejected");
    let msg = err.to_string();
    assert!(msg.contains("invalid_params"), "message: {msg}");
    assert!(msg.contains("action"), "must name 'action': {msg}");
}

#[test]
fn browser_input_non_string_element_is_rejected_top_level_and_nested() {
    let top = browser_input(serde_json::json!({ "action": "click", "element": 5 }))
        .expect_err("non-string top-level element must be rejected");
    let msg = top.to_string();
    assert!(msg.contains("invalid_params"), "message: {msg}");
    assert!(msg.contains("element"), "must name 'element': {msg}");

    let nested = browser_input(serde_json::json!({
        "action": "click",
        "args": { "element": 5 }
    }))
    .expect_err("non-string nested element must be rejected");
    let msg = nested.to_string();
    assert!(msg.contains("invalid_params"), "message: {msg}");
    assert!(msg.contains("element"), "must name 'element': {msg}");
}

#[test]
fn frame_from_flat_call_carries_folded_keys_in_browser_args() {
    // The frame the child builds for a FLAT call — `browser_args` must carry
    // the folded keys so the parent Browser arm can reconstruct them.
    let input = browser_input(serde_json::json!({
        "action": "navigate",
        "url": "https://example.com"
    }))
    .unwrap();
    let frame = FrameRequest {
        token: "t".into(),
        session_id: "p".into(),
        kind: FrameKind::Browser,
        todos: Vec::new(),
        title: None,
        browser_action: Some(input.action),
        browser_args: Some(input.args),
        browser_element: input.element,
    };
    let value = serde_json::to_value(&frame).unwrap();
    assert_eq!(value["browser_action"], "navigate");
    assert_eq!(value["browser_args"]["url"], "https://example.com");
    let decoded: FrameRequest = serde_json::from_value(value).unwrap();
    assert_eq!(decoded.browser_action.as_deref(), Some("navigate"));
    assert_eq!(
        decoded.browser_args.as_ref().and_then(|a| a.get("url")),
        Some(&serde_json::json!("https://example.com"))
    );
}
