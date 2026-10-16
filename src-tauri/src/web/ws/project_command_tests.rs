//! `/ws` project commands against a whole host: parity with the HTTP routes
//! for idempotent add/remove, `project_busy` with its `details`, and `cascade`.

use super::tests::{route, test_env, test_outbound};
use super::*;
use crate::web::project_registry::test_host::TestHost;

fn env_for(host: &TestHost) -> HandlerEnv {
    let (tx, _rx) = test_outbound();
    HandlerEnv {
        pty: Arc::clone(&host.pty),
        ..test_env(
            &host.acp,
            &host.relay,
            &host.registry,
            &tx,
            &Arc::new(Subscriptions::default()),
        )
    }
}

async fn send(env: &HandlerEnv, kind: &str, payload: Value) -> WsReply {
    let frame = json!({ "id": "r1", "type": kind, "payload": payload });
    route(&frame.to_string(), env).await
}

fn err_of(reply: &WsReply) -> (String, Option<Value>) {
    let err = reply.err.as_ref().expect("a refusal");
    (err.code.clone(), err.details.clone())
}

#[tokio::test]
async fn add_is_idempotent_by_id_and_refuses_another_path() {
    let host = TestHost::new(&[], true).await;
    let env = env_for(&host);
    let add = json!({ "id": "p-1", "name": "One", "path": host.project_dir, "color": "red" });

    let first = send(&env, "add_project", add.clone()).await;
    let repeat = send(&env, "add_project", add).await;
    assert!(first.ok && repeat.ok);
    assert_eq!(first.payload.unwrap()["project"]["id"], "p-1");
    assert_eq!(host.registry.len(), 1);

    let moved = json!({
        "id": "p-1", "name": "One", "path": host.project_dir.parent().unwrap(), "color": "red"
    });
    assert_eq!(err_of(&send(&env, "add_project", moved).await).0, "duplicate");

    let missing_dir = json!({ "id": "p-2", "name": "Two", "path": "/no/such/dir", "color": "red" });
    assert_eq!(err_of(&send(&env, "add_project", missing_dir).await).0, "unsupported");
    assert_eq!(host.registry.len(), 1);
}

#[tokio::test]
async fn remove_of_an_absent_id_is_ok_and_update_of_one_is_not_found() {
    let host = TestHost::new(&[], true).await;
    let env = env_for(&host);
    assert!(send(&env, "remove_project", json!({ "projectId": "ghost" })).await.ok);
    let update = send(&env, "update_project", json!({ "projectId": "ghost", "name": "x" })).await;
    assert_eq!(err_of(&update).0, "not_found");
}

#[tokio::test]
async fn busy_remove_replies_project_busy_with_details_and_changes_nothing() {
    let host = TestHost::new(&[("a1", "s-1", "p-1")], true).await;
    host.add_project("p-1").await;
    let terminal = host.spawn_terminal("p-1").await;
    let env = env_for(&host);

    let reply = send(&env, "remove_project", json!({ "projectId": "p-1" })).await;
    let (code, details) = err_of(&reply);
    assert_eq!(code, "project_busy");
    assert_eq!(
        details,
        Some(json!({ "sessions": ["s-1"], "terminals": [terminal] }))
    );
    // The wire shape carries `details` inside `err`.
    let wire = serde_json::to_value(&reply).unwrap();
    assert_eq!(wire["err"]["details"]["sessions"], json!(["s-1"]));
    assert!(host.registry.contains("p-1"));
    assert_eq!(host.live_sessions("a1"), ["s-1"]);
    assert!(host.pty.get(&terminal).is_some());
    host.pty.kill_all().await;
}

#[tokio::test]
async fn cascade_remove_stops_everything_then_removes_and_fans_out() {
    let host = TestHost::new(&[("a1", "s-1", "p-1")], true).await;
    host.add_project("p-1").await;
    let terminal = host.spawn_terminal("p-1").await;
    let env = env_for(&host);

    let reply = send(
        &env,
        "remove_project",
        json!({ "projectId": "p-1", "cascade": true }),
    )
    .await;
    assert!(reply.ok);
    assert!(!host.registry.contains("p-1"));
    assert!(host.live_sessions("a1").is_empty());
    assert!(host.pty.get(&terminal).is_none());
    assert_eq!(
        host.sink.sids_of(crate::acp::events::EVENT_SESSION_CLOSED),
        vec![Some("s-1".to_string())]
    );
    host.pty.kill_all().await;
}

#[tokio::test]
async fn archive_is_guarded_and_honors_cascade_over_ws() {
    let host = TestHost::new(&[("a1", "s-1", "p-1")], true).await;
    host.add_project("p-1").await;
    let env = env_for(&host);

    let refused = send(
        &env,
        "update_project",
        json!({ "projectId": "p-1", "isArchived": true }),
    )
    .await;
    assert_eq!(err_of(&refused).0, "project_busy");
    assert!(!host.registry.get("p-1").unwrap().is_archived);

    let archived = send(
        &env,
        "update_project",
        json!({ "projectId": "p-1", "isArchived": true, "cascade": true }),
    )
    .await;
    assert!(archived.ok);
    assert!(host.registry.get("p-1").unwrap().is_archived);
    assert!(host.live_sessions("a1").is_empty());
}

#[tokio::test]
async fn unknown_payload_fields_are_still_rejected() {
    let host = TestHost::new(&[], true).await;
    host.add_project("p-1").await;
    let env = env_for(&host);
    let reply = send(
        &env,
        "remove_project",
        json!({ "projectId": "p-1", "cascadee": true }),
    )
    .await;
    assert_eq!(err_of(&reply).0, "unsupported");
    assert!(host.registry.contains("p-1"));
}
