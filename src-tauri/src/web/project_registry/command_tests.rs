//! The command service against a whole host: idempotent add, the busy
//! refusal, and the cascade that stops sessions and terminals.

use super::test_host::TestHost;
use super::*;
use crate::acp::events;

fn add_request(id: &str, path: &str) -> AddProject {
    AddProject {
        id: id.to_string(),
        name: "Project".to_string(),
        path: path.to_string(),
        color: "green".to_string(),
        is_archived: false,
    }
}

fn busy_details(error: &ProjectCommandError) -> serde_json::Value {
    assert_eq!(error.http_code(), "PROJECT_BUSY");
    assert_eq!(error.ws_code(), crate::web::ws::WsErrorCode::ProjectBusy);
    error.details().expect("busy refusals carry details")
}

#[tokio::test]
async fn a_repeated_add_is_ok_without_a_duplicate_row_and_never_repoints() {
    let host = TestHost::new(&[], true).await;
    let path = host.project_dir.to_string_lossy().into_owned();
    let first = host.host().add(add_request("p-1", &path)).await.unwrap();
    let again = host.host().add(add_request("p-1", &path)).await.unwrap();
    assert_eq!(first, again);
    assert_eq!(host.registry.len(), 1);

    let other = host.project_dir.parent().unwrap().to_string_lossy().into_owned();
    let refused = host.host().add(add_request("p-1", &other)).await.unwrap_err();
    assert!(matches!(refused, ProjectCommandError::Duplicate { .. }));
    assert_eq!(refused.http_code(), "DUPLICATE");
    assert_eq!(
        host.registry.get("p-1").unwrap().path.as_deref(),
        first.path.as_deref(),
        "a refused add never overwrites"
    );
}

#[tokio::test]
async fn add_refuses_the_reserved_id_and_an_unusable_path_and_persists_nothing() {
    let host = TestHost::new(&[], true).await;
    let path = host.project_dir.to_string_lossy().into_owned();
    let reserved = host
        .host()
        .add(add_request(crate::acp::session_persistence::UNASSIGNED_PROJECT_ID, &path))
        .await
        .unwrap_err();
    assert_eq!(reserved, ProjectCommandError::Reserved);

    let missing = host
        .host()
        .add(add_request("p-1", "/definitely/not/a/dir"))
        .await
        .unwrap_err();
    assert!(matches!(missing, ProjectCommandError::InvalidPath(_)));
    assert_eq!(missing.http_code(), "VALIDATION_ERROR");
    assert!(host.registry.is_empty());
    assert!(!host.registry_file.exists());
}

#[tokio::test]
async fn a_failed_write_replies_an_error_and_leaves_the_registry_alone() {
    let host = TestHost::new(&[], true).await;
    host.add_project("p-1").await;
    std::fs::remove_file(&host.registry_file).unwrap();
    std::fs::create_dir(&host.registry_file).unwrap();
    let before = host.registry.snapshot();

    let path = host.project_dir.to_string_lossy().into_owned();
    let error = host.host().add(add_request("p-2", &path)).await.unwrap_err();
    assert!(matches!(error, ProjectCommandError::Persist(_)));
    assert_eq!(error.http_code(), "PERSIST_FAILED");
    assert_eq!(host.registry.snapshot(), before);
}

#[tokio::test]
async fn removing_an_absent_id_is_ok() {
    let host = TestHost::new(&[], true).await;
    host.host().remove("ghost", false).await.unwrap();
    host.host().remove("ghost", true).await.unwrap();
}

#[tokio::test]
async fn updating_an_unknown_project_is_not_found() {
    let host = TestHost::new(&[], true).await;
    let error = host
        .host()
        .update(UpdateProject {
            project_id: "ghost".to_string(),
            name: Some("x".to_string()),
            color: None,
            is_archived: None,
            path: None,
            cascade: false,
        })
        .await
        .unwrap_err();
    assert!(matches!(error, ProjectCommandError::NotFound(_)));
}

#[tokio::test]
async fn remove_is_refused_busy_listing_the_entities_and_stops_nothing() {
    let host = TestHost::new(
        &[("a1", "s-1", "p-1"), ("a1", "s-2", "p-2"), ("a2", "s-3", "p-1")],
        true,
    )
    .await;
    host.add_project("p-1").await;
    host.add_project("p-2").await;
    let terminal = host.spawn_terminal("p-1").await;
    let other_terminal = host.spawn_terminal("p-2").await;
    let before = host.registry.snapshot();

    let error = host.host().remove("p-1", false).await.unwrap_err();
    let details = busy_details(&error);
    let mut sessions: Vec<String> = details["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    sessions.sort();
    assert_eq!(sessions, ["s-1", "s-3"], "only p-1's sessions are listed");
    assert_eq!(details["terminals"], serde_json::json!([terminal]));

    assert_eq!(host.registry.snapshot(), before, "the registry is unchanged");
    assert_eq!(host.live_sessions("a1"), ["s-1", "s-2"]);
    assert_eq!(host.live_sessions("a2"), ["s-3"]);
    assert!(host.pty.get(&terminal).is_some(), "nothing was stopped");
    assert!(host.pty.get(&other_terminal).is_some());
    assert!(!host.registry.is_removing("p-1"), "the removal mark is released");
    host.pty.kill_all().await;
}

#[tokio::test]
async fn cascade_stops_sessions_and_terminals_then_removes() {
    let host = TestHost::new(
        &[("a1", "s-1", "p-1"), ("a1", "s-2", "p-2"), ("a2", "s-3", "p-1")],
        true,
    )
    .await;
    host.add_project("p-1").await;
    host.add_project("p-2").await;
    host.registry.commit_set_default("p-1").unwrap();
    let terminal = host.spawn_terminal("p-1").await;
    let other_terminal = host.spawn_terminal("p-2").await;

    host.host().remove("p-1", true).await.unwrap();

    assert!(!host.registry.contains("p-1"));
    assert_eq!(
        host.registry.snapshot().default_project_id,
        None,
        "removing the default clears it"
    );
    // The reopened file agrees: the removal is durable.
    let reopened =
        ProjectRegistry::open_durable(&host.registry_file, RootCheck::Strict).unwrap();
    assert!(!reopened.contains("p-1") && reopened.contains("p-2"));

    assert_eq!(host.live_sessions("a1"), ["s-2"], "p-2's session is untouched");
    assert!(
        host.acp.list_agents().iter().any(|a| a.0 == "a1"),
        "a1 still serves p-2"
    );
    assert!(
        !host.acp.list_agents().iter().any(|a| a.0 == "a2"),
        "a2 had no other session: it is stopped"
    );
    let mut closed = host.sink.sids_of(events::EVENT_SESSION_CLOSED);
    closed.sort();
    assert_eq!(closed, [Some("s-1".to_string()), Some("s-3".to_string())]);
    assert!(host.pty.get(&terminal).is_none(), "the bound PTY is gone");
    assert!(host.pty.get(&other_terminal).is_some());
    host.pty.kill_all().await;
}

#[tokio::test]
async fn archive_is_guarded_like_remove_and_cascade_archives_in_place() {
    let host = TestHost::new(&[("a1", "s-1", "p-1")], true).await;
    host.add_project("p-1").await;
    host.registry.commit_set_default("p-1").unwrap();
    let archive = |cascade| UpdateProject {
        project_id: "p-1".to_string(),
        name: None,
        color: None,
        is_archived: Some(true),
        path: None,
        cascade,
    };

    let error = host.host().update(archive(false)).await.unwrap_err();
    assert_eq!(busy_details(&error)["sessions"], serde_json::json!(["s-1"]));
    assert!(!host.registry.get("p-1").unwrap().is_archived);
    assert_eq!(host.live_sessions("a1"), ["s-1"]);

    host.host().update(archive(true)).await.unwrap();
    let project = host.registry.get("p-1").unwrap();
    assert!(project.is_archived, "archived, not removed");
    assert_eq!(host.registry.snapshot().default_project_id, None);
    assert!(host.live_sessions("a1").is_empty());

    // Restoring needs no guard and an already-archived project is not busy.
    host.host()
        .update(UpdateProject {
            project_id: "p-1".to_string(),
            name: None,
            color: None,
            is_archived: Some(false),
            path: None,
            cascade: false,
        })
        .await
        .unwrap();
    assert!(!host.registry.get("p-1").unwrap().is_archived);
}

/// A second directory next to the fixture's project, canonicalized as the
/// registry stores roots.
fn another_root(host: &TestHost) -> (String, String) {
    let dir = host.project_dir.parent().unwrap().join("moved");
    std::fs::create_dir_all(&dir).unwrap();
    let canonical = std::fs::canonicalize(&dir).unwrap().to_string_lossy().into_owned();
    (dir.to_string_lossy().into_owned(), canonical)
}

fn move_request(path: &str, cascade: bool) -> UpdateProject {
    UpdateProject {
        project_id: "p-1".to_string(),
        name: None,
        color: None,
        is_archived: None,
        path: Some(path.to_string()),
        cascade,
    }
}

#[tokio::test]
async fn update_moves_the_root_of_a_project_nothing_is_bound_to() {
    let host = TestHost::new(&[], true).await;
    host.add_project("p-1").await;
    let (requested, canonical) = another_root(&host);

    host.host().update(move_request(&requested, false)).await.unwrap();

    assert_eq!(host.registry.get("p-1").unwrap().path.as_deref(), Some(canonical.as_str()));
    let reloaded =
        ProjectRegistry::open_durable(&host.registry_file, RootCheck::Strict).unwrap();
    assert_eq!(
        reloaded.get("p-1").unwrap().path.as_deref(),
        Some(canonical.as_str()),
        "the move is persisted"
    );
}

#[tokio::test]
async fn update_refuses_a_bad_root_like_add_and_changes_nothing() {
    let host = TestHost::new(&[], true).await;
    host.add_project("p-1").await;
    let before = host.registry.snapshot();

    let missing = host
        .host()
        .update(move_request("/definitely/not/a/dir", false))
        .await
        .unwrap_err();
    assert!(matches!(missing, ProjectCommandError::InvalidPath(_)));
    assert_eq!(missing.http_code(), "VALIDATION_ERROR");

    let (requested, _) = another_root(&host);
    let reserved = host
        .host()
        .update(UpdateProject {
            project_id: crate::acp::session_persistence::UNASSIGNED_PROJECT_ID.to_string(),
            ..move_request(&requested, false)
        })
        .await
        .unwrap_err();
    assert_eq!(reserved, ProjectCommandError::Reserved);

    let ghost = host
        .host()
        .update(UpdateProject {
            project_id: "ghost".to_string(),
            ..move_request(&requested, false)
        })
        .await
        .unwrap_err();
    assert!(matches!(ghost, ProjectCommandError::NotFound(_)));
    assert_eq!(host.registry.snapshot(), before);
}

#[tokio::test]
async fn moving_a_busy_root_is_guarded_like_archive_and_cascade_moves_in_place() {
    let host = TestHost::new(&[("a1", "s-1", "p-1")], true).await;
    host.add_project("p-1").await;
    let terminal = host.spawn_terminal("p-1").await;
    let original = host.registry.get("p-1").unwrap().path;
    let (requested, canonical) = another_root(&host);

    let error = host.host().update(move_request(&requested, false)).await.unwrap_err();
    let details = busy_details(&error);
    assert_eq!(details["sessions"], serde_json::json!(["s-1"]));
    assert_eq!(details["terminals"], serde_json::json!([terminal]));
    assert_eq!(host.registry.get("p-1").unwrap().path, original, "the root stays");
    assert_eq!(host.live_sessions("a1"), ["s-1"], "nothing was stopped");
    assert!(host.pty.get(&terminal).is_some());

    host.host().update(move_request(&requested, true)).await.unwrap();
    assert_eq!(host.registry.get("p-1").unwrap().path.as_deref(), Some(canonical.as_str()));
    assert!(host.live_sessions("a1").is_empty(), "the bound session was stopped");
    assert!(host.pty.get(&terminal).is_none(), "the bound terminal was stopped");
    assert!(!host.registry.is_removing("p-1"));
    host.pty.kill_all().await;
}

#[tokio::test]
async fn repeating_the_current_root_is_not_a_move_even_when_the_project_is_busy() {
    let host = TestHost::new(&[("a1", "s-1", "p-1")], true).await;
    host.add_project("p-1").await;
    let current = host.registry.get("p-1").unwrap().path.unwrap();
    let before = host.registry.snapshot();

    host.host().update(move_request(&current, false)).await.unwrap();
    // The same directory spelled as the operator typed it.
    let typed = host.project_dir.to_string_lossy().into_owned();
    host.host().update(move_request(&typed, false)).await.unwrap();

    assert_eq!(host.registry.snapshot(), before);
    assert_eq!(host.live_sessions("a1"), ["s-1"]);
}

#[tokio::test]
async fn a_session_that_cannot_be_stopped_keeps_the_project_and_is_listed() {
    // `close_works = false`: the agent refuses `session/close`, and another
    // project's session keeps the agent from being killed.
    let host =
        TestHost::new(&[("a1", "s-1", "p-1"), ("a1", "s-2", "p-2")], false).await;
    host.add_project("p-1").await;
    host.add_project("p-2").await;
    let terminal = host.spawn_terminal("p-1").await;
    let before = host.registry.snapshot();

    let error = host.host().remove("p-1", true).await.unwrap_err();
    let details = busy_details(&error);
    assert_eq!(
        details["sessions"],
        serde_json::json!(["s-1"]),
        "the leftover is listed"
    );
    assert_eq!(
        details["terminals"],
        serde_json::json!([]),
        "the terminal that did stop is not"
    );
    assert_eq!(host.registry.snapshot(), before, "the project stays");
    assert!(host.pty.get(&terminal).is_none());
    assert!(!host.registry.is_removing("p-1"));
}

#[tokio::test]
async fn a_session_or_terminal_that_started_during_a_removal_is_flagged() {
    let host = TestHost::new(&[], true).await;
    host.add_project("p-1").await;
    assert!(host.registry.is_active("p-1"));
    assert!(!host.registry.project_left_while_starting("p-1", true));

    // The entity started before the mark; the removal is still running.
    let guard = host.registry.begin_removal("p-1").expect("removal");
    assert!(host.registry.project_left_while_starting("p-1", true));
    assert!(host.registry.project_left_while_starting("p-1", false));
    drop(guard);
    assert!(!host.registry.project_left_while_starting("p-1", true));

    // The removal finished before the entity did: the project is gone.
    host.host().remove("p-1", false).await.unwrap();
    assert!(host.registry.project_left_while_starting("p-1", true));
    // A project that was never active (unassigned, archived) is not held to it.
    assert!(!host.registry.project_left_while_starting("p-1", false));
}

#[tokio::test]
async fn a_second_removal_of_the_same_project_is_refused_while_one_runs() {
    let host = TestHost::new(&[], true).await;
    host.add_project("p-1").await;
    let guard = host.registry.begin_removal("p-1").expect("first removal");
    assert!(host.registry.is_removing("p-1"));

    let error = host.host().remove("p-1", false).await.unwrap_err();
    assert!(matches!(error, ProjectCommandError::Busy { .. }));
    assert!(host.registry.contains("p-1"));

    drop(guard);
    assert!(!host.registry.is_removing("p-1"));
    host.host().remove("p-1", false).await.unwrap();
    assert!(!host.registry.contains("p-1"));
}

#[tokio::test]
async fn set_default_is_explicit_and_needs_a_switchable_project() {
    let host = TestHost::new(&[], true).await;
    host.add_project("p-1").await;
    assert_eq!(host.registry.snapshot().default_project_id, None);

    set_default_project(&host.registry, &host.relay, "p-1").unwrap();
    assert_eq!(host.registry.snapshot().default_project_id.as_deref(), Some("p-1"));
    let missing = set_default_project(&host.registry, &host.relay, "ghost").unwrap_err();
    assert!(matches!(missing, ProjectCommandError::NotFound(_)));
    assert_eq!(host.registry.snapshot().default_project_id.as_deref(), Some("p-1"));
}
