#![allow(clippy::unwrap_used, clippy::expect_used)]
//! `create_session` project binding: the host stamps the owning project once.

use super::projects::resolve_session_project;
use super::*;
use crate::web::project_registry::ProjectSummary;

fn summary(id: &str, path: &str, archived: bool) -> ProjectSummary {
    ProjectSummary {
        id: id.to_string(),
        name: format!("Project {id}"),
        color: "blue".to_string(),
        path: Some(path.to_string()),
        is_archived: archived,
        is_default: false,
    }
}

fn registry() -> ProjectRegistry {
    let registry = ProjectRegistry::new();
    registry.set(
        vec![
            summary("p-1", "/work/one", false),
            summary("p-2", "/work/two", false),
            summary("p-old", "/work/old", true),
        ],
        None,
    );
    registry
}

#[test]
fn explicit_registered_project_wins_over_the_cwd_match() {
    let registry = registry();
    assert_eq!(
        resolve_session_project(&registry, Some("p-2"), "/work/one/src"),
        Ok("p-2".to_string())
    );
}

#[test]
fn explicit_archived_project_is_still_registered() {
    let registry = registry();
    assert_eq!(
        resolve_session_project(&registry, Some("p-old"), "/elsewhere"),
        Ok("p-old".to_string())
    );
}

#[test]
fn without_an_explicit_id_the_cwd_selects_the_registry_project() {
    let registry = registry();
    assert_eq!(
        resolve_session_project(&registry, None, "/work/one/src"),
        Ok("p-1".to_string())
    );
    assert_eq!(
        resolve_session_project(&registry, Some("  "), "/work/two"),
        Ok("p-2".to_string())
    );
}

#[test]
fn an_unmatched_cwd_is_stamped_unassigned() {
    let registry = registry();
    assert_eq!(
        resolve_session_project(&registry, None, "/somewhere/else"),
        Ok(crate::acp::session_persistence::UNASSIGNED_PROJECT_ID.to_string())
    );
}

#[test]
fn an_unknown_explicit_id_is_rejected_not_defaulted() {
    let registry = registry();
    assert_eq!(
        resolve_session_project(&registry, Some("ghost"), "/work/one"),
        Err("ghost".to_string())
    );
}

#[tokio::test]
async fn create_session_with_an_unknown_project_replies_not_found_before_touching_the_agent() {
    let acp = Arc::new(AcpManager::new(vec![]));
    let registry = Arc::new(registry());
    let reply = projects::handle_create_session(
        "r1".to_string(),
        &json!({"agentId": "a-1", "cwd": "/work/one", "projectId": "ghost"}),
        &acp,
        &registry,
        None,
    )
    .await;

    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "not_found");
}

#[tokio::test]
async fn create_session_with_a_registered_project_reaches_the_agent() {
    // The no-op manager has no agent, so a request that passes project
    // resolution fails later with the unknown-agent error (the project
    // refusal is `project '<id>' not found`).
    let acp = Arc::new(AcpManager::new(vec![]));
    let registry = Arc::new(registry());
    let reply = projects::handle_create_session(
        "r1".to_string(),
        &json!({"agentId": "a-1", "cwd": "/work/one", "projectId": "p-2"}),
        &acp,
        &registry,
        None,
    )
    .await;

    assert!(!reply.ok);
    let message = reply.err.unwrap().message;
    assert!(message.starts_with("unknown agent"), "{message}");
}

#[tokio::test]
async fn add_project_refuses_the_reserved_unassigned_id() {
    let relay = Arc::new(WsRelaySink::new());
    let registry = Arc::new(ProjectRegistry::new());
    let reply = projects::handle_add_project(
        "r1".to_string(),
        &json!({
            "id": crate::acp::session_persistence::UNASSIGNED_PROJECT_ID,
            "name": "x",
            "path": "/work/one",
            "color": "blue"
        }),
        &relay,
        &registry,
        None,
        None,
    )
    .await;

    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "unsupported");
    assert!(registry.snapshot().projects.is_empty());
}

#[test]
fn a_renderer_fed_project_with_the_reserved_id_is_never_registered() {
    let registry = ProjectRegistry::new();
    registry.set(
        vec![
            summary(
                crate::acp::session_persistence::UNASSIGNED_PROJECT_ID,
                "/work/one",
                false,
            ),
            summary("p-1", "/work/two", false),
        ],
        None,
    );
    assert!(!registry.contains(crate::acp::session_persistence::UNASSIGNED_PROJECT_ID));
    assert!(registry.contains("p-1"));
}

#[tokio::test]
async fn post_projects_refuses_the_reserved_unassigned_id() {
    use axum::extract::{ConnectInfo, State};
    use axum::response::IntoResponse;
    use axum::Json;

    let state = super::tests::ws_test_app_state();
    let registry = state.registry.clone();
    let response = crate::web::projects_api::create_project(
        State(state),
        ConnectInfo("127.0.0.1:1".parse().unwrap()),
        Json(
            serde_json::from_value(json!({
                "id": crate::acp::session_persistence::UNASSIGNED_PROJECT_ID,
                "name": "x",
                "path": "/work/one",
                "color": "blue"
            }))
            .unwrap(),
        ),
    )
    .await
    .into_response();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();

    assert_eq!(body["success"], json!(false));
    assert_eq!(body["code"], json!("VALIDATION_ERROR"));
    assert!(!registry.contains(crate::acp::session_persistence::UNASSIGNED_PROJECT_ID));
}

#[test]
fn a_default_naming_the_reserved_id_is_not_kept() {
    let registry = ProjectRegistry::new();
    registry.set(
        vec![summary("p-1", "/work/one", false)],
        Some(crate::acp::session_persistence::UNASSIGNED_PROJECT_ID.to_string()),
    );
    assert_eq!(registry.snapshot().default_project_id, None);
}

#[test]
fn upserting_the_reserved_id_never_registers_it() {
    let registry = ProjectRegistry::new();
    registry.upsert(summary(
        crate::acp::session_persistence::UNASSIGNED_PROJECT_ID,
        "/work/one",
        false,
    ));
    assert!(!registry.contains(crate::acp::session_persistence::UNASSIGNED_PROJECT_ID));
}
