use super::*;
use tower::ServiceExt;

fn test_state() -> AppState {
    AppState {
        store: Arc::new(SqliteStore::open_in_memory().unwrap()),
    }
}

#[tokio::test]
async fn test_create_session_route() {
    let app = router(test_state());
    let resp = app
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/sessions")
                .header("content-type", "application/json")
                .body(axum::body::Body::from(r#"{"url":"https://example.com"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);
}

#[tokio::test]
async fn test_list_sessions_route() {
    let app = router(test_state());
    let resp = app
        .oneshot(
            axum::http::Request::builder()
                .method("GET")
                .uri("/sessions")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn test_full_annotation_lifecycle() {
    let state = test_state();
    let app = router(state.clone());

    // Create session
    let resp = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/sessions")
                .header("content-type", "application/json")
                .body(axum::body::Body::from(r#"{"url":"https://test.com"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let session: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let session_id = session["id"].as_str().unwrap();

    // Add annotation
    let app2 = router(state.clone());
    let resp = app2
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri(format!("/sessions/{session_id}/annotations"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        r#"{"x":10,"y":20,"comment":"Fix this","element":"button","elementPath":"body > button","timestamp":12345}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);

    // Get pending
    let app3 = router(state.clone());
    let resp = app3
        .oneshot(
            axum::http::Request::builder()
                .method("GET")
                .uri(format!("/sessions/{session_id}/pending"))
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let pending: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(pending["count"], 1);
}
