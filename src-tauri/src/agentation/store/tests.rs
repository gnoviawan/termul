use super::*;

fn test_store() -> SqliteStore {
    SqliteStore::open_in_memory().unwrap()
}

#[test]
fn test_create_and_get_session() {
    let store = test_store();
    let session = store.create_session("https://example.com", None);
    assert_eq!(session.url, "https://example.com");
    assert_eq!(session.status, SessionStatus::Active);
    let got = store.get_session(&session.id).unwrap();
    assert_eq!(got.id, session.id);
}

#[test]
fn test_add_and_get_annotation() {
    let store = test_store();
    let session = store.create_session("https://example.com", None);
    let input = AnnotationInput {
        x: 10.0,
        y: 20.0,
        comment: "Fix this button".to_string(),
        element: "button".to_string(),
        element_path: "body > div > button".to_string(),
        timestamp: 1234567890,
        ..Default::default()
    };
    let ann = store.add_annotation(&session.id, &input).unwrap();
    assert_eq!(ann.comment, "Fix this button");
    assert_eq!(ann.status, AnnotationStatus::Pending);
    assert_eq!(ann.session_id, session.id);

    let got = store.get_annotation(&ann.id).unwrap();
    assert_eq!(got.comment, "Fix this button");
}

#[test]
fn test_pending_annotations() {
    let store = test_store();
    let session = store.create_session("https://example.com", None);
    for i in 0..3 {
        store
            .add_annotation(
                &session.id,
                &AnnotationInput {
                    x: 0.0,
                    y: i as f64,
                    comment: format!("Issue {i}"),
                    element: "div".to_string(),
                    element_path: "body > div".to_string(),
                    timestamp: i,
                    ..Default::default()
                },
            )
            .unwrap();
    }
    let pending = store.get_pending_annotations(&session.id);
    assert_eq!(pending.len(), 3);
}

#[test]
fn test_update_status() {
    let store = test_store();
    let session = store.create_session("https://example.com", None);
    let ann = store
        .add_annotation(
            &session.id,
            &AnnotationInput {
                x: 0.0,
                y: 0.0,
                comment: "test".to_string(),
                element: "div".to_string(),
                element_path: "div".to_string(),
                timestamp: 0,
                ..Default::default()
            },
        )
        .unwrap();
    let updated = store
        .update_annotation_status(&ann.id, AnnotationStatus::Resolved, Some("agent"))
        .unwrap();
    assert_eq!(updated.status, AnnotationStatus::Resolved);
    assert_eq!(updated.resolved_by.as_deref(), Some("agent"));
    assert!(updated.resolved_at.is_some());
}

#[test]
fn test_thread_message() {
    let store = test_store();
    let session = store.create_session("https://example.com", None);
    let ann = store
        .add_annotation(
            &session.id,
            &AnnotationInput {
                x: 0.0,
                y: 0.0,
                comment: "test".to_string(),
                element: "div".to_string(),
                element_path: "div".to_string(),
                timestamp: 0,
                ..Default::default()
            },
        )
        .unwrap();
    let updated = store
        .add_thread_message(&ann.id, ThreadRole::Agent, "Working on it")
        .unwrap();
    assert!(updated.thread.is_some());
    assert_eq!(updated.thread.unwrap().len(), 1);
}

#[test]
fn test_delete_annotation() {
    let store = test_store();
    let session = store.create_session("https://example.com", None);
    let ann = store
        .add_annotation(
            &session.id,
            &AnnotationInput {
                x: 0.0,
                y: 0.0,
                comment: "test".to_string(),
                element: "div".to_string(),
                element_path: "div".to_string(),
                timestamp: 0,
                ..Default::default()
            },
        )
        .unwrap();
    let deleted = store.delete_annotation(&ann.id).unwrap();
    assert_eq!(deleted.id, ann.id);
    assert!(store.get_annotation(&ann.id).is_none());
}

#[test]
fn test_event_bus() {
    let bus = EventBus::new(16);
    let mut rx = bus.subscribe();
    let ev = bus.emit(
        AFSEventType::AnnotationCreated,
        "sess1",
        serde_json::json!({"id":"a1"}),
    );
    assert_eq!(ev.sequence, 1);
    let received = rx.try_recv().unwrap();
    assert_eq!(received.event_type, AFSEventType::AnnotationCreated);
    assert_eq!(received.session_id, "sess1");
}

#[test]
fn test_events_since() {
    let store = test_store();
    let session = store.create_session("https://example.com", None);
    store
        .add_annotation(
            &session.id,
            &AnnotationInput {
                x: 0.0,
                y: 0.0,
                comment: "test".to_string(),
                element: "div".to_string(),
                element_path: "div".to_string(),
                timestamp: 0,
                ..Default::default()
            },
        )
        .unwrap();
    let events = store.get_events_since(&session.id, 0);
    assert!(events.len() >= 2); // session.created + annotation.created
}
