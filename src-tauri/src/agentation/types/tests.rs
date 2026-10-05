use super::*;

#[test]
fn test_generate_id_format() {
    let id = generate_id();
    assert!(id.contains('-'), "ID should contain a dash: {id}");
    let parts: Vec<&str> = id.split('-').collect();
    assert_eq!(parts.len(), 2);
    assert!(!parts[0].is_empty(), "timestamp part should be non-empty");
    assert_eq!(parts[1].len(), 6, "random part should be 6 chars");
}

#[test]
fn test_radix36() {
    assert_eq!(radix36(0), "0");
    assert_eq!(radix36(1), "1");
    assert_eq!(radix36(10), "a");
    assert_eq!(radix36(35), "z");
    assert_eq!(radix36(36), "10");
}

#[test]
fn test_event_type_as_str() {
    assert_eq!(
        AFSEventType::AnnotationCreated.as_str(),
        "annotation.created"
    );
    assert_eq!(AFSEventType::SessionClosed.as_str(), "session.closed");
    assert_eq!(AFSEventType::ThreadMessage.as_str(), "thread.message");
}
