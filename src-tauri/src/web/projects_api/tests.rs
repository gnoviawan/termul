use super::*;
use crate::acp::RootCheck;
use crate::web::project_registry::test_host::TestHost;
use crate::web::project_registry::{ProjectRegistry, ProjectSummary};
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::Request;
use serde::de::DeserializeOwned;
use std::net::SocketAddr;
use std::sync::Arc;
use tower::ServiceExt;

const LOOPBACK: [u8; 4] = [127, 0, 0, 1];
const LAN: [u8; 4] = [10, 0, 0, 5];

fn state_for(host: &TestHost) -> AppState {
    let pty = Arc::clone(&host.pty);
    AppState {
        acp: Arc::clone(&host.acp),
        terminal_events: pty.terminal_events(),
        cwd_tracker: pty.cwd_tracker(),
        git_tracker: pty.git_tracker(),
        exit_code_tracker: pty.exit_code_tracker(),
        pty,
        relay: Arc::clone(&host.relay),
        registry: Arc::clone(&host.registry),
        history_mode: crate::web::ws::HistoryMode::LiveOnly,
        pending_oauth_flows: Arc::new(parking_lot::RwLock::new(std::collections::HashMap::new())),
        oauth_base_url: "http://127.0.0.1".to_string(),
        workspace_manifest: None,
        acp_catalog: None,
        acp_install: None,
        store: None,
        web_auth: None,
        allow_remote_writes: false,
        shared_live_writes_denied: false,
        connections: Default::default(),
    }
}

fn app(state: AppState) -> axum::Router {
    axum::Router::new()
        .route("/projects", axum::routing::get(list).post(create_project))
        .route("/projects/default", axum::routing::post(set_default_project))
        .route(
            "/projects/{projectId}",
            axum::routing::put(update_project).delete(remove_project),
        )
        .with_state(state)
}

async fn call<T: DeserializeOwned>(
    app: &axum::Router,
    method: &str,
    uri: &str,
    body: Option<serde_json::Value>,
    peer: [u8; 4],
) -> IpcBody<T> {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .extension(ConnectInfo(SocketAddr::from((peer, 54321))))
        .body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
        .expect("build request");
    let response = app.clone().oneshot(request).await.expect("router response");
    assert_eq!(response.status(), 200, "app-level failures ride in the body");
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("read body");
    serde_json::from_slice(&bytes).expect("parse body")
}

fn new_project(host: &TestHost, id: &str) -> serde_json::Value {
    serde_json::json!({
        "id": id, "name": format!("Project {id}"),
        "path": host.project_dir, "color": "blue"
    })
}

#[tokio::test]
async fn get_projects_lists_the_registry_and_is_an_empty_success_when_empty() {
    let host = TestHost::new(&[], true).await;
    let app = app(state_for(&host));
    let empty: IpcBody<ProjectListPayload> = call(&app, "GET", "/projects", None, LAN).await;
    assert!(empty.success);
    assert!(empty.data.unwrap().projects.is_empty());

    host.add_project("p-1").await;
    assert!(host.registry.set_default_project("p-1"));
    let listed: IpcBody<ProjectListPayload> = call(&app, "GET", "/projects", None, LAN).await;
    let data = listed.data.unwrap();
    assert_eq!(data.default_project_id.as_deref(), Some("p-1"));
    assert!(data.projects[0].is_default);
}

#[tokio::test]
async fn a_durable_registry_serves_what_a_restart_reloads() {
    let host = TestHost::new(&[], true).await;
    let app_one = app(state_for(&host));
    let added: IpcBody<ProjectSummary> =
        call(&app_one, "POST", "/projects", Some(new_project(&host, "my-api")), LOOPBACK).await;
    assert!(added.success, "{added:?}");
    let stored = added.data.unwrap();
    assert_eq!(stored.id, "my-api");
    assert_eq!(
        stored.path.as_deref(),
        Some(std::fs::canonicalize(&host.project_dir).unwrap().to_str().unwrap())
    );

    // A new server process over the same file lists the project.
    let reopened = Arc::new(
        ProjectRegistry::open_durable(&host.registry_file, RootCheck::Strict).unwrap(),
    );
    let mut state = state_for(&host);
    state.registry = reopened;
    let listed: IpcBody<ProjectListPayload> =
        call(&app(state), "GET", "/projects", None, LAN).await;
    assert_eq!(listed.data.unwrap().projects[0].id, "my-api");
}

#[tokio::test]
async fn add_is_idempotent_and_refuses_a_different_path() {
    let host = TestHost::new(&[], true).await;
    let app = app(state_for(&host));
    let first: IpcBody<ProjectSummary> =
        call(&app, "POST", "/projects", Some(new_project(&host, "p-1")), LOOPBACK).await;
    let repeat: IpcBody<ProjectSummary> =
        call(&app, "POST", "/projects", Some(new_project(&host, "p-1")), LOOPBACK).await;
    assert!(first.success && repeat.success);
    assert_eq!(host.registry.len(), 1);

    let mut moved = new_project(&host, "p-1");
    moved["path"] = serde_json::json!(host.project_dir.parent().unwrap());
    let refused: IpcBody<ProjectSummary> =
        call(&app, "POST", "/projects", Some(moved), LOOPBACK).await;
    assert!(!refused.success);
    assert_eq!(refused.code.as_deref(), Some("DUPLICATE"));

    let mut bad = new_project(&host, "p-2");
    bad["path"] = serde_json::json!("/definitely/not/a/dir");
    let invalid: IpcBody<ProjectSummary> =
        call(&app, "POST", "/projects", Some(bad), LOOPBACK).await;
    assert_eq!(invalid.code.as_deref(), Some("VALIDATION_ERROR"));
    assert_eq!(host.registry.len(), 1);
}

#[tokio::test]
async fn a_failed_registry_write_is_persist_failed_and_changes_nothing() {
    let host = TestHost::new(&[], true).await;
    let app = app(state_for(&host));
    std::fs::create_dir(&host.registry_file).unwrap();
    let refused: IpcBody<ProjectSummary> =
        call(&app, "POST", "/projects", Some(new_project(&host, "p-1")), LOOPBACK).await;
    assert_eq!(refused.code.as_deref(), Some("PERSIST_FAILED"));
    assert!(host.registry.is_empty());
}

#[tokio::test]
async fn update_patches_fields_and_archive_clears_the_default() {
    let host = TestHost::new(&[], true).await;
    host.add_project("p-1").await;
    assert!(host.registry.set_default_project("p-1"));
    let app = app(state_for(&host));

    let renamed: IpcBody<()> = call(
        &app,
        "PUT",
        "/projects/p-1",
        Some(serde_json::json!({ "name": "Renamed", "color": "red" })),
        LOOPBACK,
    )
    .await;
    assert!(renamed.success);
    assert_eq!(host.registry.get("p-1").unwrap().name, "Renamed");

    let archived: IpcBody<()> = call(
        &app,
        "PUT",
        "/projects/p-1",
        Some(serde_json::json!({ "isArchived": true })),
        LOOPBACK,
    )
    .await;
    assert!(archived.success);
    assert_eq!(host.registry.snapshot().default_project_id, None);

    let missing: IpcBody<()> = call(
        &app,
        "PUT",
        "/projects/ghost",
        Some(serde_json::json!({ "name": "x" })),
        LOOPBACK,
    )
    .await;
    assert_eq!(missing.code.as_deref(), Some("NOT_FOUND"));
}

#[tokio::test]
async fn delete_removes_and_an_absent_id_is_ok() {
    let host = TestHost::new(&[], true).await;
    host.add_project("p-1").await;
    let app = app(state_for(&host));
    let removed: IpcBody<()> = call(&app, "DELETE", "/projects/p-1", None, LOOPBACK).await;
    assert!(removed.success);
    assert!(host.registry.is_empty());
    let again: IpcBody<()> = call(&app, "DELETE", "/projects/p-1", None, LOOPBACK).await;
    assert!(again.success, "removing an absent project is ok");
}

#[tokio::test]
async fn set_default_is_explicit_and_validates_the_target() {
    let host = TestHost::new(&[], true).await;
    host.add_project("p-1").await;
    let app = app(state_for(&host));
    let ok: IpcBody<()> = call(
        &app,
        "POST",
        "/projects/default",
        Some(serde_json::json!({ "projectId": "p-1" })),
        LOOPBACK,
    )
    .await;
    assert!(ok.success);
    assert_eq!(host.registry.snapshot().default_project_id.as_deref(), Some("p-1"));

    let unknown: IpcBody<()> = call(
        &app,
        "POST",
        "/projects/default",
        Some(serde_json::json!({ "projectId": "ghost" })),
        LOOPBACK,
    )
    .await;
    assert_eq!(unknown.code.as_deref(), Some("NOT_FOUND"));
}

#[tokio::test]
async fn project_writes_refuse_a_lan_peer_unless_remote_writes_are_allowed() {
    let host = TestHost::new(&[], true).await;
    host.add_project("p-1").await;
    let denied = app(state_for(&host));
    for (method, uri, body) in [
        ("POST", "/projects", Some(new_project(&host, "p-2"))),
        ("PUT", "/projects/p-1", Some(serde_json::json!({ "name": "x" }))),
        ("DELETE", "/projects/p-1", None),
        (
            "POST",
            "/projects/default",
            Some(serde_json::json!({ "projectId": "p-1" })),
        ),
    ] {
        let reply: IpcBody<serde_json::Value> = call(&denied, method, uri, body, LAN).await;
        assert_eq!(reply.code.as_deref(), Some("FORBIDDEN"), "{method} {uri}");
    }
    assert_eq!(host.registry.len(), 1);
    assert_eq!(host.registry.get("p-1").unwrap().name, "Project p-1");

    let mut state = state_for(&host);
    state.allow_remote_writes = true;
    let admitted: IpcBody<()> = call(&app(state), "DELETE", "/projects/p-1", None, LAN).await;
    assert!(admitted.success);
    assert!(host.registry.is_empty());
}

#[tokio::test]
async fn busy_remove_lists_the_entities_over_http_and_cascade_stops_them() {
    let host = TestHost::new(&[("a1", "s-1", "p-1")], true).await;
    host.add_project("p-1").await;
    let terminal = host.spawn_terminal("p-1").await;
    let app = app(state_for(&host));

    let refused: IpcBody<()> = call(&app, "DELETE", "/projects/p-1", None, LOOPBACK).await;
    assert!(!refused.success);
    assert_eq!(refused.code.as_deref(), Some("PROJECT_BUSY"));
    assert_eq!(
        refused.details,
        Some(serde_json::json!({ "sessions": ["s-1"], "terminals": [terminal] }))
    );
    assert!(host.registry.contains("p-1"));
    assert_eq!(host.live_sessions("a1"), ["s-1"]);

    let cascaded: IpcBody<()> =
        call(&app, "DELETE", "/projects/p-1?cascade=true", None, LOOPBACK).await;
    assert!(cascaded.success, "{cascaded:?}");
    assert!(!host.registry.contains("p-1"));
    assert!(host.live_sessions("a1").is_empty());
    assert!(host.pty.get(&terminal).is_none());
    host.pty.kill_all().await;
}

#[tokio::test]
async fn busy_archive_over_http_honors_cascade_in_the_body() {
    let host = TestHost::new(&[("a1", "s-1", "p-1")], true).await;
    host.add_project("p-1").await;
    let app = app(state_for(&host));

    let refused: IpcBody<()> = call(
        &app,
        "PUT",
        "/projects/p-1",
        Some(serde_json::json!({ "isArchived": true })),
        LOOPBACK,
    )
    .await;
    assert_eq!(refused.code.as_deref(), Some("PROJECT_BUSY"));
    assert_eq!(
        refused.details,
        Some(serde_json::json!({ "sessions": ["s-1"], "terminals": [] }))
    );
    assert!(!host.registry.get("p-1").unwrap().is_archived);

    let archived: IpcBody<()> = call(
        &app,
        "PUT",
        "/projects/p-1",
        Some(serde_json::json!({ "isArchived": true, "cascade": true })),
        LOOPBACK,
    )
    .await;
    assert!(archived.success);
    assert!(host.registry.get("p-1").unwrap().is_archived);
    assert!(host.live_sessions("a1").is_empty());
}
