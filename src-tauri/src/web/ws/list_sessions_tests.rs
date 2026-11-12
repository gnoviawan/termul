#![allow(clippy::unwrap_used, clippy::expect_used)]
//! In server mode (`Carrier::Ws`) a client must not pick an arbitrary folder
//! through `list_sessions.cwd`. The host derives the listing folder from the
//! active project (or a cwd that belongs to it). Desktop IPC still accepts cwd.

use std::path::Path;
use std::sync::Arc;

use super::tests::{route, test_env, test_outbound};
use super::*;
use crate::web::project_registry::ProjectRegistry;

fn env_with(registry: Arc<ProjectRegistry>, carrier: Carrier) -> (HandlerEnv, OutboundSender) {
    let acp = Arc::new(AcpManager::new(vec![]));
    let relay = Arc::new(WsRelaySink::new());
    let (tx, _rx) = test_outbound();
    let env = HandlerEnv {
        carrier,
        ..test_env(
            &acp,
            &relay,
            &registry,
            &tx,
            &Arc::new(Subscriptions::default()),
        )
    };
    (env, tx)
}

async fn list_sessions(env: &HandlerEnv, payload: Value) -> WsReply {
    let frame = json!({ "id": "r1", "type": "list_sessions", "payload": payload });
    route(&frame.to_string(), env).await
}

fn err(reply: &WsReply) -> (String, String) {
    let err = reply.err.as_ref().expect("a refusal");
    (err.code.clone(), err.message.clone())
}

fn registry_with_default(id: &str, root: &Path) -> Arc<ProjectRegistry> {
    let registry = ProjectRegistry::with_roots_for_test(&[(id, root)]);
    assert!(registry.set_default_project(id));
    registry
}

/// The test: a remote client cannot redirect the listing to a folder that is
/// not a registered project (or inside one).
#[tokio::test]
async fn list_sessions_on_ws_rejects_a_cwd_outside_every_project() {
    let root = tempfile::tempdir().unwrap();
    let registry = registry_with_default("p-1", root.path());
    let (env, _tx) = env_with(registry, Carrier::Ws);

    let reply = list_sessions(
        &env,
        json!({ "agentId": "a1", "cwd": "/tmp/not-a-project" }),
    )
    .await;
    let (code, message) = err(&reply);
    assert_eq!(code, "unsupported");
    assert!(
        message.contains("registered project") || message.contains("active project"),
        "refusal must name the project-folder rule"
    );
}

#[tokio::test]
async fn list_sessions_on_ws_rejects_a_cwd_of_another_project_when_project_id_is_set() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let registry = ProjectRegistry::with_roots_for_test(&[("p-a", a.path()), ("p-b", b.path())]);
    assert!(registry.set_default_project("p-a"));
    let (env, _tx) = env_with(registry, Carrier::Ws);

    let reply = list_sessions(
        &env,
        json!({
            "agentId": "a1",
            "projectId": "p-a",
            "cwd": b.path().to_string_lossy(),
        }),
    )
    .await;
    let (code, message) = err(&reply);
    assert_eq!(code, "unsupported");
    assert!(
        message.contains("active project"),
        "refusal must name the active project"
    );
}

/// Desktop IPC still lets the local client pass cwd; an unknown agent is the
/// only reason this harness refuses (there is no live agent), not the folder.
#[tokio::test]
async fn list_sessions_on_desktop_ipc_still_accepts_client_cwd() {
    let root = tempfile::tempdir().unwrap();
    let registry = registry_with_default("p-1", root.path());
    let (env, _tx) = env_with(registry, Carrier::Ipc);

    let reply = list_sessions(
        &env,
        json!({ "agentId": "a1", "cwd": "/tmp/not-a-project" }),
    )
    .await;
    let (code, message) = err(&reply);
    assert_ne!(code, "unsupported");
    assert!(
        !message.contains("registered project") && !message.contains("active project"),
        "desktop must not apply the server-mode cwd rule"
    );
}

#[test]
fn resolve_list_sessions_cwd_uses_the_project_folder_not_a_client_path() {
    let root = tempfile::tempdir().unwrap();
    let registry = registry_with_default("p-1", root.path());
    let expected = registry.switch_context("p-1").unwrap().cwd;

    let resolved =
        resolve_list_sessions_cwd(Carrier::Ws, &registry, None, Some("/tmp/not-a-project"));
    assert!(
        resolved.is_err(),
        "a foreign cwd must not resolve, got {resolved:?}"
    );

    let omitted = resolve_list_sessions_cwd(Carrier::Ws, &registry, None, None)
        .expect("default project folder");
    assert_eq!(omitted.as_deref(), Some(expected.as_str()));

    let worktree = format!("{}/.worktrees/feat", expected);
    let inside = resolve_list_sessions_cwd(Carrier::Ws, &registry, Some("p-1"), Some(&worktree))
        .expect("a folder inside the project is the active folder");
    assert_eq!(inside.as_deref(), Some(worktree.as_str()));

    let desktop =
        resolve_list_sessions_cwd(Carrier::Ipc, &registry, None, Some("/tmp/not-a-project"))
            .expect("desktop passes cwd through");
    assert_eq!(desktop.as_deref(), Some("/tmp/not-a-project"));
}
