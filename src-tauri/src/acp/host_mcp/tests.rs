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
