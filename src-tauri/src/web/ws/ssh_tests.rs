#![allow(clippy::unwrap_used, clippy::expect_used)]
//! The SSH `/ws` requests run the shared `ssh::service` operations on the
//! host's `SSHManager`: profiles land in `<state dir>/ssh-profiles.json`,
//! failures carry the service codes, and events reach `ssh` watchers.

use super::super::tests::{route, test_env, test_outbound};
use super::*;
use crate::ssh::profile_manager::STORE_FILE;

struct Host {
    dir: tempfile::TempDir,
    relay: Arc<WsRelaySink>,
    acp: Arc<AcpManager>,
    registry: Arc<ProjectRegistry>,
    subs: Arc<Subscriptions>,
}

impl Host {
    fn new(with_ssh: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let relay = Arc::new(WsRelaySink::new());
        if with_ssh {
            let weak = Arc::downgrade(&relay);
            relay.set_ssh(Arc::new(SSHManager::new(
                dir.path(),
                Arc::new(move |event, payload| {
                    if let Some(relay) = weak.upgrade() {
                        crate::web::watch::publish_ssh_event(&relay, event, payload);
                    }
                }),
            )));
        }
        Self {
            dir,
            relay,
            acp: Arc::new(AcpManager::new(vec![])),
            registry: Arc::new(ProjectRegistry::new()),
            subs: Arc::new(Subscriptions::default()),
        }
    }

    async fn send(&self, type_: &str, payload: Value) -> WsReply {
        let (tx, _rx) = test_outbound();
        let env = test_env(&self.acp, &self.relay, &self.registry, &tx, &self.subs);
        let frame = json!({ "id": "r", "type": type_, "payload": payload }).to_string();
        route(&frame, &env).await
    }

    fn stored(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.dir.path().join(STORE_FILE)).unwrap()).unwrap()
    }
}

fn profile(id: &str, name: &str) -> Value {
    json!({
        "id": id,
        "name": name,
        "host": "example.test",
        "port": 22,
        "username": "deploy",
        "authMethod": "agent",
        "privateKeyPath": null,
        "jumpHostId": null,
        "portForwards": [],
        "tags": null,
        "lastConnected": null,
        "importedFrom": null,
    })
}

fn err_code(reply: &WsReply) -> &str {
    reply.err.as_ref().map(|e| e.code.as_str()).unwrap_or("")
}

#[tokio::test]
async fn profile_crud_runs_on_the_host_store_file() {
    let host = Host::new(true);
    let reply = host.send("ssh_save_profile", json!({ "profile": profile("p1", "prod") })).await;
    assert!(reply.ok, "{:?}", reply.err);
    assert_eq!(host.stored()["profiles"][0]["name"], "prod");

    let reply = host.send("ssh_duplicate_profile", json!({ "profileId": "p1" })).await;
    assert!(reply.ok, "{:?}", reply.err);
    let copy = reply.payload.unwrap();
    assert_eq!(copy["name"], "prod (copy)");
    assert_ne!(copy["id"], "p1");

    let reply = host.send("ssh_list_profiles", json!({})).await;
    let names: Vec<String> = reply.payload.unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["name"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(names, vec!["prod", "prod (copy)"]);

    let reply = host.send("ssh_delete_profile", json!({ "profileId": "p1" })).await;
    assert!(reply.ok, "{:?}", reply.err);
    assert_eq!(host.stored()["profiles"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn a_profile_file_the_desktop_wrote_is_read_and_its_other_keys_kept() {
    let host = Host::new(true);
    std::fs::write(
        host.dir.path().join(STORE_FILE),
        serde_json::to_vec_pretty(&json!({ "profiles": [profile("old", "legacy")], "other": 1 }))
            .unwrap(),
    )
    .unwrap();
    let reply = host.send("ssh_list_profiles", json!({})).await;
    assert_eq!(reply.payload.unwrap()[0]["id"], "old");
    let reply = host.send("ssh_save_profile", json!({ "profile": profile("p2", "new") })).await;
    assert!(reply.ok, "{:?}", reply.err);
    let file = host.stored();
    assert_eq!(file["other"], 1);
    assert_eq!(file["profiles"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn failures_carry_the_service_codes() {
    let host = Host::new(true);
    let reply = host
        .send(
            "ssh_session_open",
            json!({ "request": { "sessionId": "s1", "profileId": "nope", "cols": 80, "rows": 24 } }),
        )
        .await;
    assert_eq!(err_code(&reply), "SSH_PROFILE_NOT_FOUND");
    let reply = host
        .send("sftp_list_dir", json!({ "request": { "connectionId": "s1", "remotePath": "/" } }))
        .await;
    assert_eq!(err_code(&reply), "SSH_CONNECTION_NOT_FOUND");
    let reply = host.send("ssh_delete_profile", json!({ "profileId": "nope" })).await;
    assert_eq!(err_code(&reply), "SSH_PROFILE_ERROR");
    let reply = host.send("ssh_session_cancel", json!({ "sessionId": "s1" })).await;
    assert_eq!(reply.payload, Some(json!(false)));
    let reply = host.send("ssh_session_list", json!({})).await;
    assert_eq!(reply.payload, Some(json!([])));
}

#[tokio::test]
async fn a_malformed_payload_names_the_field_and_never_echoes_a_secret() {
    let host = Host::new(true);
    let reply = host
        .send("ssh_session_open", json!({ "request": { "secret": "hunter2-secret" } }))
        .await;
    let err = reply.err.unwrap();
    assert_eq!(err.code, "SSH_INVALID_REQUEST");
    assert!(err.message.starts_with("malformed ssh_session_open payload"), "{}", err.message);
    assert!(!err.message.contains("hunter2-secret"));
}

#[tokio::test]
async fn a_host_without_ssh_answers_unsupported() {
    let host = Host::new(false);
    for type_ in SSH_WS_REQUESTS {
        let reply = host.send(type_, json!({})).await;
        assert_eq!(err_code(&reply), "unsupported", "{type_}");
    }
    let reply = host.send("watch", json!({ "watch": "ssh" })).await;
    assert_eq!(err_code(&reply), "unsupported");
}

#[tokio::test]
async fn ssh_events_reach_an_ssh_watcher_as_event_and_payload() {
    let host = Host::new(true);
    let (tx, mut rx) = test_outbound();
    let env = test_env(&host.acp, &host.relay, &host.registry, &tx, &host.subs);
    let reply = route(r#"{"id":"w","type":"watch","payload":{"watch":"ssh"}}"#, &env).await;
    assert!(reply.ok, "{:?}", reply.err);
    let Ok(Outbound::Watch(_state)) = rx.try_recv() else {
        panic!("expected the ssh state frame");
    };
    let ssh = host.relay.ssh().unwrap();
    (ssh.emit)("ssh-session-progress", json!({ "sessionId": "s1", "stage": "connecting" }));
    let Ok(Outbound::Watch(frame)) = rx.try_recv() else {
        panic!("expected an ssh delta");
    };
    assert_eq!(
        frame.delta_value(),
        Some(&json!({
            "event": "ssh-session-progress",
            "payload": { "sessionId": "s1", "stage": "connecting" }
        }))
    );
}

#[test]
fn every_ssh_request_needs_host_local() {
    use crate::web::capabilities::{ws_request_requirement, ws_requirement, Requirement};
    for type_ in SSH_WS_REQUESTS {
        assert_eq!(ws_requirement(type_), Requirement::HostLocal, "{type_}");
    }
    assert_eq!(
        ws_request_requirement("watch", &json!({ "watch": "ssh" })),
        Requirement::HostLocal
    );
    assert_eq!(
        ws_request_requirement("watch", &json!({ "watch": "projects" })),
        Requirement::View
    );
}
