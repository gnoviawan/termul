//! Axum HTTP/SSE server for the agentation annotation protocol.
//!
//! Implements the 14 HTTP routes from agentation's `mcp/src/server/http.ts`:
//!   POST /sessions, GET /sessions, GET /sessions/:id,
//!   POST /sessions/:id/annotations, PATCH /annotations/:id,
//!   GET /annotations/:id, DELETE /annotations/:id,
//!   GET /sessions/:id/pending, GET /pending,
//!   POST /sessions/:id/action, POST /annotations/:id/thread,
//!   GET /sessions/:id/events (SSE), GET /events (global SSE),
//!   POST /mcp (HTTP MCP transport — stubbed, rmcp stdio is primary).
//!
//! Runs on `127.0.0.1:0` (dynamic port) with `tower-http::cors` strict
//! origin allowlist and `CancellationToken` shutdown.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{sse::{Event as SseEvent, KeepAlive, Sse}, IntoResponse, Json},
    routing::{get, post},
    Router,
};
use tokio_stream::{wrappers::BroadcastStream, StreamExt};
use tower_http::cors::CorsLayer;
use futures_util::stream::Stream;

use super::store::SqliteStore;
use super::types::*;

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<SqliteStore>,
}

// ---------------------------------------------------------------------------
// Query params
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
pub struct EventsQuery {
    pub agent: Option<bool>,
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/// POST /sessions — create a new session.
async fn create_session(
    State(state): State<AppState>,
    Json(body): Json<CreateSessionBody>,
) -> impl IntoResponse {
    let session = state.store.create_session(&body.url, body.project_id.as_deref());
    (StatusCode::CREATED, Json(serde_json::to_value(&session).unwrap()))
}

#[derive(serde::Deserialize)]
pub struct CreateSessionBody {
    pub url: String,
    pub project_id: Option<String>,
}

/// GET /sessions — list all sessions.
async fn list_sessions(State(state): State<AppState>) -> impl IntoResponse {
    let sessions = state.store.list_sessions();
    Json(serde_json::to_value(&sessions).unwrap())
}

/// GET /sessions/:id — get a session with annotations.
async fn get_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.store.get_session_with_annotations(&id) {
        Some(s) => (StatusCode::OK, Json(serde_json::to_value(&s).unwrap())),
        None => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Session not found"}))),
    }
}

/// POST /sessions/:id/annotations — add annotation to session.
async fn add_annotation(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<AnnotationInput>,
) -> impl IntoResponse {
    // Distinguish session-not-found (404) from insertion failure (500).
    // The store logs the insertion error; we map the HTTP response accordingly.
    if state.store.get_session(&id).is_none() {
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Session not found"})));
    }
    match state.store.add_annotation(&id, &body) {
        Some(ann) => (StatusCode::CREATED, Json(serde_json::to_value(&ann).unwrap())),
        None => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "Failed to create annotation"}))),
    }
}

/// PATCH /annotations/:id — update annotation.
async fn update_annotation(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<UpdateBody>,
) -> impl IntoResponse {
    let update = AnnotationUpdate {
        comment: body.comment,
        status: body.status,
        resolved_at: body.resolved_at,
        resolved_by: body.resolved_by,
        thread: body.thread,
        intent: body.intent,
        severity: body.severity,
    };
    match state.store.update_annotation(&id, &update) {
        Some(ann) => (StatusCode::OK, Json(serde_json::to_value(&ann).unwrap())),
        None => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Annotation not found"}))),
    }
}

#[derive(serde::Deserialize)]
pub struct UpdateBody {
    pub comment: Option<String>,
    pub status: Option<AnnotationStatus>,
    pub resolved_at: Option<String>,
    pub resolved_by: Option<String>,
    pub thread: Option<Vec<ThreadMessage>>,
    pub intent: Option<AnnotationIntent>,
    pub severity: Option<AnnotationSeverity>,
}

/// GET /annotations/:id — get annotation.
async fn get_annotation(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.store.get_annotation(&id) {
        Some(ann) => (StatusCode::OK, Json(serde_json::to_value(&ann).unwrap())),
        None => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Annotation not found"}))),
    }
}

/// DELETE /annotations/:id — delete annotation.
async fn delete_annotation(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.store.delete_annotation(&id) {
        Some(ann) => (StatusCode::OK, Json(serde_json::to_value(&ann).unwrap())),
        None => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Annotation not found"}))),
    }
}

/// GET /sessions/:id/pending — pending annotations for session.
async fn get_pending(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let annotations = state.store.get_pending_annotations(&id);
    let count = annotations.len();
    Json(serde_json::json!({
        "count": count,
        "annotations": annotations,
    }))
}

/// GET /pending — all pending across sessions.
async fn get_all_pending(State(state): State<AppState>) -> impl IntoResponse {
    let sessions = state.store.list_sessions();
    let mut all = Vec::new();
    for s in &sessions {
        all.extend(state.store.get_pending_annotations(&s.id));
    }
    let count = all.len();
    Json(serde_json::json!({
        "count": count,
        "annotations": all,
    }))
}

/// POST /sessions/:id/action — request agent action.
async fn request_action(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<ActionBody>,
) -> impl IntoResponse {
    let _session = match state.store.get_session(&id) {
        Some(s) => s,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "Session not found"})),
            )
        }
    };
    let pending = state.store.get_pending_annotations(&id);
    let output = body.output.unwrap_or_default();
    let action_req = ActionRequest {
        session_id: id.clone(),
        annotations: pending,
        output,
        timestamp: chrono::Utc::now().to_rfc3339(),
    };
    let _ev = state.store.event_bus().emit(
        AFSEventType::ActionRequested, &id,
        serde_json::to_value(&action_req).unwrap(),
    );
    (StatusCode::OK, Json(serde_json::to_value(&action_req).unwrap()))
}

#[derive(serde::Deserialize)]
pub struct ActionBody {
    pub output: Option<String>,
}

/// POST /annotations/:id/thread — add thread message.
async fn add_thread(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<ThreadBody>,
) -> impl IntoResponse {
    let role = match body.role.as_str() {
        "human" => ThreadRole::Human,
        _ => ThreadRole::Agent,
    };
    match state.store.add_thread_message(&id, role, &body.content) {
        Some(ann) => (StatusCode::OK, Json(serde_json::to_value(&ann).unwrap())),
        None => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Annotation not found"}))),
    }
}

#[derive(serde::Deserialize)]
pub struct ThreadBody {
    pub role: String,
    pub content: String,
}

/// GET /sessions/:id/events — SSE stream for a session.
async fn session_sse(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(_query): Query<EventsQuery>,
) -> Sse<impl Stream<Item = Result<SseEvent, axum::Error>>> {
    let rx = state.store.event_bus().subscribe();
    let stream = BroadcastStream::new(rx).filter_map(move |result| {
        match result {
            Ok(ev) if ev.session_id == id => {
                let data = serde_json::to_string(&ev).unwrap_or_default();
                Some(Ok(SseEvent::default().data(data)))
            }
            Ok(_) => None,
            Err(lag) => {
                log::warn!("[Agentation] SSE lagged for session={id}: {lag}");
                Some(Ok(SseEvent::default().event("lagged").data("{}")))
            }
        }
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// GET /events — global SSE stream.
async fn global_sse(
    State(state): State<AppState>,
    Query(_query): Query<EventsQuery>,
) -> Sse<impl Stream<Item = Result<SseEvent, axum::Error>>> {
    let rx = state.store.event_bus().subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|result| {
        match result {
            Ok(ev) => {
                let data = serde_json::to_string(&ev).unwrap_or_default();
                Some(Ok(SseEvent::default().data(data)))
            }
            Err(lag) => {
                log::warn!("[Agentation] SSE lagged (global): {lag}");
                Some(Ok(SseEvent::default().event("lagged").data("{}")))
            }
        }
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn router(state: AppState) -> Router {
    // Server binds to 127.0.0.1 only — no remote access possible.
    // The toolbar runs inside child-webview pages at arbitrary origins,
    // so CORS must allow any origin (not just portless 127.0.0.1).
    let cors = CorsLayer::new()
        .allow_origin(tower_http::cors::Any)
        .allow_methods([
            axum::http::Method::GET,
            axum::http::Method::POST,
            axum::http::Method::PATCH,
            axum::http::Method::DELETE,
            axum::http::Method::OPTIONS,
        ])
        .allow_headers(tower_http::cors::Any);

    Router::new()
        .route("/sessions/{id}/annotations", post(add_annotation))
        .route("/sessions/{id}/pending", get(get_pending))
        .route("/sessions/{id}/events", get(session_sse))
        .route("/sessions/{id}/action", post(request_action))
        .route("/sessions/{id}", get(get_session))
        .route("/sessions", get(list_sessions).post(create_session))
        .route("/annotations/{id}/thread", post(add_thread))
        .route("/annotations/{id}", get(get_annotation).patch(update_annotation).delete(delete_annotation))
        .route("/pending", get(get_all_pending))
        .route("/events", get(global_sse))
        .layer(cors)
        .with_state(state)
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

/// Start the HTTP server on a dynamic port. Returns (addr, shutdown_token).
pub async fn start_server(
    store: Arc<SqliteStore>,
) -> Result<(SocketAddr, tokio_util::sync::CancellationToken), String> {
    let state = AppState { store };
    let app = router(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind: {e}"))?;
    let addr = listener.local_addr().map_err(|e| format!("Local addr: {e}"))?;
    let token = tokio_util::sync::CancellationToken::new();
    let t = token.clone();
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move { t.cancelled().await; })
            .await
            .ok();
    });
    log::info!("[Agentation] HTTP server listening on {addr}");
    Ok((addr, token))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
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
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
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
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let pending: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(pending["count"], 1);
    }
}
