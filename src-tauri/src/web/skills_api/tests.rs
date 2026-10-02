use super::*;
use crate::acp::AcpManager;
use crate::web::project_registry::ProjectRegistry;
use crate::web::sink::WsRelaySink;
use crate::web::test_pty_manager;
use axum::body::Body;
use axum::http::Request;
use axum::routing::get;
use std::sync::Arc;
use tower::ServiceExt;

fn test_state() -> AppState {
    let pty = test_pty_manager();
    AppState {
        acp: Arc::new(AcpManager::new(vec![])),
        terminal_events: pty.terminal_events(),
        cwd_tracker: pty.cwd_tracker(),
        git_tracker: pty.git_tracker(),
        exit_code_tracker: pty.exit_code_tracker(),
        pty,
        relay: Arc::new(WsRelaySink::new()),
        registry: Arc::new(ProjectRegistry::new()),
        registry_persistence: None,
        projects_file: None,
        history_mode: crate::web::ws::HistoryMode::LiveOnly,
        project_root: Arc::new(parking_lot::RwLock::new(
            std::env::temp_dir()
                .canonicalize()
                .unwrap_or_else(|_| std::env::temp_dir()),
        )),
        workspace_manifest: None,
        acp_catalog: None,
        acp_install: None,
        store: None,
        web_auth: None,
        allow_remote_writes: false,
        shared_live_writes_denied: false,
        pending_oauth_flows: std::sync::Arc::new(parking_lot::RwLock::new(
            std::collections::HashMap::new(),
        )),
        oauth_base_url: "http://127.0.0.1".to_string(),
    }
}

fn test_router(state: AppState) -> axum::Router {
    axum::Router::new()
        .route("/skills", get(list))
        .route("/skills/{name}", get(read))
        .with_state(state)
}

async fn get_request(state: AppState, uri: &str) -> axum::http::Response<Body> {
    test_router(state)
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(uri)
                .body(Body::empty())
                .expect("build request"),
        )
        .await
        .expect("router response")
}

async fn body_as_json<T: serde::de::DeserializeOwned>(body: Body) -> T {
    let bytes = axum::body::to_bytes(body, usize::MAX)
        .await
        .expect("read body");
    serde_json::from_slice(&bytes).expect("deserialize IpcBody")
}

#[tokio::test]
async fn list_skills_returns_array() {
    let resp = get_request(test_state(), "/skills").await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<Vec<AgentSkillSummary>> = body_as_json(resp.into_body()).await;
    assert!(body.success, "skills list should succeed: {:?}", body.error);
    // May be empty on a CI host without ~/.agents/skills, but the body
    // must be a success with an array.
    let _ = body.data.expect("data array");
}

#[tokio::test]
async fn list_skills_degrades_on_scan_failure() {
    // A non-existent project root — list_agent_skills rejects relative
    // paths, but an absolute non-existing path still scans (project
    // skills dir just doesn't exist → empty). Global skills may still
    // be found. The route must never throw.
    let resp = get_request(
        test_state(),
        "/skills?projectRoot=/nonexistent/absolute/path",
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<Vec<AgentSkillSummary>> = body_as_json(resp.into_body()).await;
    assert!(body.success, "must degrade gracefully: {:?}", body.error);
}

#[tokio::test]
async fn list_skills_rejects_project_root_outside_project_root() {
    // A projectRoot that exists but is outside the server's project_root
    // (temp_dir's parent) must be rejected with OUTSIDE_PROJECT_ROOT.
    let state = test_state();
    // CAP-1: project_root is now `Arc<RwLock<PathBuf>>` — lock-read to
    // derive the "outside" path (temp_dir's parent) for the test.
    let root = state.project_root.read().clone();
    let outside = root
        .parent()
        .map(std::path::Path::to_path_buf)
        .unwrap_or_else(|| std::path::PathBuf::from("/"));
    let uri = format!("/skills?projectRoot={}", outside.display());
    let resp = get_request(state, &uri).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<Vec<AgentSkillSummary>> = body_as_json(resp.into_body()).await;
    assert!(
        !body.success,
        "outside-project-root projectRoot must be rejected"
    );
    assert_eq!(body.code.as_deref(), Some("OUTSIDE_PROJECT_ROOT"));
}

#[tokio::test]
async fn read_skill_not_found_returns_error() {
    let resp = get_request(test_state(), "/skills/nonexistent-skill-12345").await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<AgentSkillContent> = body_as_json(resp.into_body()).await;
    // A nonexistent skill must return a failure body (never throw).
    assert!(
        !body.success,
        "nonexistent skill should not be found: {:?}",
        body.data
    );
    assert_eq!(body.code.as_deref(), Some("SKILL_NOT_FOUND"));
}
