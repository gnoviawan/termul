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
        Ok(crate::acp::UNASSIGNED_PROJECT_ID.to_string())
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
    )
    .await;

    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "not_found");
}

#[tokio::test]
async fn create_session_with_a_registered_project_reaches_the_agent() {
    // The no-op manager has no agent, so a request that passes project
    // resolution fails later with the agent error, never `not_found` for the
    // project.
    let acp = Arc::new(AcpManager::new(vec![]));
    let registry = Arc::new(registry());
    let reply = projects::handle_create_session(
        "r1".to_string(),
        &json!({"agentId": "a-1", "cwd": "/work/one", "projectId": "p-2"}),
        &acp,
        &registry,
    )
    .await;

    assert!(!reply.ok);
    let message = reply.err.unwrap().message;
    assert!(!message.contains("project 'p-2'"), "{message}");
}
