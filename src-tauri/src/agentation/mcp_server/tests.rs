use super::*;

fn test_server() -> AgentationMcpServer {
    AgentationMcpServer::new(Arc::new(SqliteStore::open_in_memory().unwrap()))
}

async fn setup_with_annotation() -> (AgentationMcpServer, String, String) {
    let store = Arc::new(SqliteStore::open_in_memory().unwrap());
    let session = store.create_session("https://test.com", None);
    let ann = store
        .add_annotation(
            &session.id,
            &AnnotationInput {
                x: 10.0,
                y: 20.0,
                comment: "Fix button".to_string(),
                element: "button".to_string(),
                element_path: "body > button".to_string(),
                timestamp: 12345,
                ..Default::default()
            },
        )
        .unwrap();
    let server = AgentationMcpServer::new(store);
    (server, session.id, ann.id)
}

#[tokio::test]
async fn test_list_sessions() {
    let server = test_server();
    let result = server.list_sessions().await;
    assert!(result.contains("sessions"));
}

#[tokio::test]
async fn test_get_session() {
    let (server, sid, _) = setup_with_annotation().await;
    let result = server
        .get_session(Parameters(GetSessionInput {
            session_id: sid.clone(),
        }))
        .await;
    assert!(result.contains(&sid));
}

#[tokio::test]
async fn test_get_pending() {
    let (server, sid, _) = setup_with_annotation().await;
    let result = server
        .get_pending(Parameters(GetPendingInput { session_id: sid }))
        .await;
    assert!(result.contains("count"));
    assert!(result.contains("1"));
}

#[tokio::test]
async fn test_get_all_pending() {
    let (server, _, _) = setup_with_annotation().await;
    let result = server.get_all_pending().await;
    assert!(result.contains("count"));
    assert!(result.contains("1"));
}

#[tokio::test]
async fn test_acknowledge() {
    let (server, _, aid) = setup_with_annotation().await;
    let result = server
        .acknowledge(Parameters(AcknowledgeInput { annotation_id: aid }))
        .await;
    assert!(result.contains("acknowledged"));
    assert!(result.contains("true"));
}

#[tokio::test]
async fn test_resolve() {
    let (server, _, aid) = setup_with_annotation().await;
    let result = server
        .resolve(Parameters(ResolveInput {
            annotation_id: aid,
            summary: Some("Fixed the button color".to_string()),
        }))
        .await;
    assert!(result.contains("resolved"));
    assert!(result.contains("true"));
}

#[tokio::test]
async fn test_dismiss() {
    let (server, _, aid) = setup_with_annotation().await;
    let result = server
        .dismiss(Parameters(DismissInput {
            annotation_id: aid,
            reason: "Not a real issue".to_string(),
        }))
        .await;
    assert!(result.contains("dismissed"));
    assert!(result.contains("true"));
}

#[tokio::test]
async fn test_reply() {
    let (server, _, aid) = setup_with_annotation().await;
    let result = server
        .reply(Parameters(ReplyInput {
            annotation_id: aid,
            message: "Looking into this".to_string(),
        }))
        .await;
    assert!(result.contains("replied"));
    assert!(result.contains("true"));
}

#[tokio::test]
async fn test_watch_annotations_drain() {
    let (server, sid, _) = setup_with_annotation().await;
    let result = server
        .watch_annotations(Parameters(WatchAnnotationsInput {
            session_id: Some(sid),
            batch_window_seconds: Some(1),
            timeout_seconds: Some(2),
        }))
        .await;
    // Should drain pending immediately
    assert!(result.contains("count"));
    assert!(result.contains("1"));
}
