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

    let worktree = root.path().join(".worktrees/feat");
    std::fs::create_dir_all(&worktree).unwrap();
    let inside = resolve_list_sessions_cwd(
        Carrier::Ws,
        &registry,
        Some("p-1"),
        Some(worktree.to_str().unwrap()),
    )
    .expect("a folder inside the project is the active folder");
    assert_eq!(
        inside.as_deref(),
        Some(worktree.canonicalize().unwrap().to_str().unwrap())
    );

    let desktop =
        resolve_list_sessions_cwd(Carrier::Ipc, &registry, None, Some("/tmp/not-a-project"))
            .expect("desktop passes cwd through");
    assert_eq!(desktop.as_deref(), Some("/tmp/not-a-project"));
}

fn sibling_dirs() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
    let parent = tempfile::tempdir().unwrap();
    let proj = parent.path().join("proj");
    let foreign = parent.path().join("foreign");
    std::fs::create_dir(&proj).unwrap();
    std::fs::create_dir(&foreign).unwrap();
    (parent, proj, foreign)
}

fn must_refuse(result: Result<Option<String>, String>, label: &str) {
    assert!(result.is_err(), "{label} must be refused, got {result:?}");
}

fn assert_ws_unsupported(reply: &WsReply, label: &str) {
    let (code, message) = err(reply);
    assert_eq!(code, "unsupported", "{label}");
    assert!(
        message.contains("active project") || message.contains("registered project"),
        "{label}: refusal must name the project-folder rule"
    );
}

/// Without `projectId`, a cwd inside any registered project is accepted,
/// not only the default one. Both sides are canonicalized first.
#[test]
fn resolve_list_sessions_cwd_without_project_id_accepts_any_registered_project() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let registry = ProjectRegistry::with_roots_for_test(&[("p-a", a.path()), ("p-b", b.path())]);
    assert!(registry.set_default_project("p-a"));
    let inside_b = b.path().join("sub");
    std::fs::create_dir(&inside_b).unwrap();

    let resolved = resolve_list_sessions_cwd(
        Carrier::Ws,
        &registry,
        None,
        Some(inside_b.to_str().unwrap()),
    )
    .expect("a cwd inside a non-default registered project is allowed");
    assert_eq!(
        resolved.as_deref(),
        Some(inside_b.canonicalize().unwrap().to_str().unwrap())
    );
}

/// `..` (including doubled slashes and a climb through a subfolder) must not
/// walk out of the project, with or without an explicit projectId. Plain-text
/// prefix checks used to allow this.
#[test]
fn resolve_list_sessions_cwd_rejects_a_dotdot_escape() {
    let (_parent, proj, foreign) = sibling_dirs();
    let registry = registry_with_default("default", &proj);
    assert!(
        foreign.exists(),
        "the foreign folder exists so canonicalize would succeed"
    );
    std::fs::create_dir(proj.join("sub")).unwrap();

    let cases = [
        format!("{}/../foreign", proj.display()),
        format!("{}//..//..", proj.display()),
        format!("{}/sub/../../foreign", proj.display()),
    ];
    for escape in cases {
        must_refuse(
            resolve_list_sessions_cwd(Carrier::Ws, &registry, Some("default"), Some(&escape)),
            &format!("projectId + `{escape}`"),
        );
        must_refuse(
            resolve_list_sessions_cwd(Carrier::Ws, &registry, None, Some(&escape)),
            &format!("no projectId + `{escape}`"),
        );
    }
}

/// On Windows, `<root>\..\..` is a real climb once canonicalize runs. On
/// Unix a backslash is not a separator, so the path usually does not exist
/// and is refused for that reason. Either way the client cwd is rejected.
#[test]
fn resolve_list_sessions_cwd_rejects_a_windows_backslash_dotdot_escape() {
    let (_parent, proj, foreign) = sibling_dirs();
    let registry = registry_with_default("default", &proj);
    let escape = format!("{}\\..\\foreign", proj.display());
    let climb = format!("{}\\..\\..", proj.display());
    for path in [escape, climb] {
        must_refuse(
            resolve_list_sessions_cwd(Carrier::Ws, &registry, Some("default"), Some(&path)),
            &format!("projectId + `{path}`"),
        );
        must_refuse(
            resolve_list_sessions_cwd(Carrier::Ws, &registry, None, Some(&path)),
            &format!("no projectId + `{path}`"),
        );
    }
    let _ = foreign;
}

/// A symlink inside the project (`<root>/link-secret`) that points at a
/// folder outside it must not be treated as the listing folder, with or
/// without projectId.
#[cfg(unix)]
#[test]
fn resolve_list_sessions_cwd_rejects_a_symlink_escape() {
    let (_parent, proj, foreign) = sibling_dirs();
    let link = proj.join("link-secret");
    std::os::unix::fs::symlink(&foreign, &link).unwrap();
    let registry = registry_with_default("default", &proj);
    let path = link.to_str().unwrap();

    must_refuse(
        resolve_list_sessions_cwd(Carrier::Ws, &registry, Some("default"), Some(path)),
        "projectId + symlink escape",
    );
    must_refuse(
        resolve_list_sessions_cwd(Carrier::Ws, &registry, None, Some(path)),
        "no projectId + symlink escape",
    );
}

#[test]
fn resolve_list_sessions_cwd_rejects_a_nonexistent_path() {
    let root = tempfile::tempdir().unwrap();
    let registry = registry_with_default("p-1", root.path());
    let missing = root.path().join("no-such-dir");
    must_refuse(
        resolve_list_sessions_cwd(
            Carrier::Ws,
            &registry,
            Some("p-1"),
            Some(missing.to_str().unwrap()),
        ),
        "projectId + missing path",
    );
    must_refuse(
        resolve_list_sessions_cwd(
            Carrier::Ws,
            &registry,
            None,
            Some(missing.to_str().unwrap()),
        ),
        "no projectId + missing path",
    );
}

/// A regular file inside the project is not a listing folder, with or
/// without projectId. Canonicalize succeeds; the directory check refuses it.
#[test]
fn resolve_list_sessions_cwd_rejects_a_regular_file() {
    let root = tempfile::tempdir().unwrap();
    let registry = registry_with_default("p-1", root.path());
    let file = root.path().join("file.txt");
    std::fs::write(&file, "not a folder").unwrap();
    must_refuse(
        resolve_list_sessions_cwd(
            Carrier::Ws,
            &registry,
            Some("p-1"),
            Some(file.to_str().unwrap()),
        ),
        "projectId + regular file",
    );
    must_refuse(
        resolve_list_sessions_cwd(Carrier::Ws, &registry, None, Some(file.to_str().unwrap())),
        "no projectId + regular file",
    );
}

#[tokio::test]
async fn list_sessions_on_ws_rejects_a_dotdot_escape() {
    let (_parent, proj, _foreign) = sibling_dirs();
    let registry = registry_with_default("default", &proj);
    let (env, _tx) = env_with(registry, Carrier::Ws);
    std::fs::create_dir(proj.join("sub")).unwrap();

    for (cwd, project_id) in [
        (format!("{}/../foreign", proj.display()), Some("default")),
        (format!("{}//..//..", proj.display()), None),
        (
            format!("{}/sub/../../foreign", proj.display()),
            Some("default"),
        ),
        (format!("{}/sub/../../foreign", proj.display()), None),
    ] {
        let mut payload = json!({ "agentId": "a1", "cwd": cwd });
        if let Some(id) = project_id {
            payload["projectId"] = json!(id);
        }
        let reply = list_sessions(&env, payload).await;
        assert_ws_unsupported(&reply, &cwd);
    }
}

/// `list_sessions` is a read, so a view-only peer may call it. The cwd
/// check must still run for that peer; it must not be skipped as a write
/// gate would skip a write-only check.
#[test]
fn list_sessions_on_ws_rejects_a_dotdot_escape_for_a_view_only_peer() {
    let (_parent, proj, _foreign) = sibling_dirs();
    let registry = registry_with_default("default", &proj);
    let escape = format!("{}/../foreign", proj.display());
    let access =
        ConnectionAccess::granted(super::tests::test_policy([192, 168, 1, 50], false, false));
    let reply = list_sessions_with_access(
        registry,
        access,
        json!({ "agentId": "a1", "projectId": "default", "cwd": escape }),
    );
    assert_ws_unsupported(&reply, "view-only `..` escape");
}

fn list_sessions_with_access(
    registry: Arc<ProjectRegistry>,
    access: ConnectionAccess,
    payload: Value,
) -> WsReply {
    use std::time::Duration;
    use tokio_util::sync::CancellationToken;

    let acp = Arc::new(AcpManager::new(vec![]));
    let relay = Arc::new(WsRelaySink::new());
    let (tx, mut rx) = test_outbound();
    let subscriptions = Arc::new(Subscriptions::default());
    let mut conn = ConnState::new(access, Arc::clone(&subscriptions));
    conn.authed = true;
    let env = HandlerEnv {
        carrier: Carrier::Ws,
        ..test_env(&acp, &relay, &registry, &tx, &subscriptions)
    };
    let text = json!({ "id": "r1", "type": "list_sessions", "payload": payload }).to_string();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let exec = KeyedExecutor::new(CancellationToken::new());
            assert!(dispatch_connection_text(&text, &mut conn, &env, &exec).await);
            match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
                Ok(Some(Outbound::Reply(reply))) => reply,
                _other => panic!("expected a reply frame, got a non-reply outbound"),
            }
        })
}
