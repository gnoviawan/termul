#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Requests that act with the host's own credentials (Claude account
//! management, SSH sessions, SFTP, profiles, keys and the `ssh` event watch)
//! are refused `forbidden`
//! for every connection that is not `host_local`, and the `authenticate`
//! reply tells the client what it was granted.

use super::tests::{auth_frame, gated_policy, handle_sync_with_access};
use super::*;
use crate::web::capabilities::HOST_LOCAL_WS_REQUESTS;

fn frame(type_: &str) -> String {
    json!({ "id": "h", "type": type_, "payload": { "accountId": "ab12", "name": "Work" } })
        .to_string()
}

/// Every request that acts with the host's credentials: Claude account
/// management, every SSH request, and the `ssh` event watch.
fn host_local_frames() -> Vec<(String, String)> {
    HOST_LOCAL_WS_REQUESTS
        .iter()
        .chain(SSH_WS_REQUESTS)
        .map(|type_| ((*type_).to_string(), frame(type_)))
        .chain(std::iter::once((
            "watch ssh".to_string(),
            json!({ "id": "h", "type": "watch", "payload": { "watch": "ssh" } }).to_string(),
        )))
        .collect()
}

fn code(reply: &WsReply) -> String {
    reply.err.as_ref().map(|e| e.code.clone()).unwrap_or_default()
}

const HOST_CREDENTIAL: &str = "host-local-credential";

fn gate() -> Arc<WebAuth> {
    let gate = WebAuth::new(crate::web::auth::WebAuthToken::new("s3cret-token").expect("non-empty"));
    gate.set_host_local_credential(
        crate::web::auth::WebAuthToken::new(HOST_CREDENTIAL).expect("non-empty"),
    );
    Arc::new(gate)
}

/// Authenticate a connection from `policy` (presenting the host-local
/// credential), then send every host-local request on it. Returns the
/// `authenticate` payload and each request's code.
fn run(policy: CapabilityPolicy, gated: bool) -> (Value, Vec<(String, String)>) {
    run_presenting(policy, gated, Some(HOST_CREDENTIAL))
}

fn run_presenting(
    policy: CapabilityPolicy,
    gated: bool,
    host_credential: Option<&str>,
) -> (Value, Vec<(String, String)>) {
    let gate = gated.then(gate);
    let mut access = ConnectionAccess::new(policy);
    let mut authed = false;
    let mut identity = None;
    let mut frame: Value = serde_json::from_str(&auth_frame("a", gated.then_some("s3cret-token")))
        .expect("auth frame");
    if let Some(credential) = host_credential {
        frame["payload"]["hostLocalToken"] = json!(credential);
    }
    let auth = handle_sync_with_access(
        &frame.to_string(),
        &mut authed,
        &mut identity,
        &mut access,
        gate.as_ref(),
    );
    assert!(auth.ok, "authenticate: {:?}", auth.err);
    let codes = host_local_frames()
        .into_iter()
        .map(|(type_, text)| {
            let mut authed = true;
            let reply = handle_sync_with_access(
                &text,
                &mut authed,
                &mut None,
                &mut access,
                gate.as_ref(),
            );
            (type_, code(&reply))
        })
        .collect();
    (auth.payload.unwrap(), codes)
}

#[test]
fn a_remote_view_only_client_is_refused_and_told_it_holds_nothing() {
    let (auth, codes) = run(gated_policy([192, 168, 1, 50], false, false, true), true);
    assert_eq!(auth["capabilities"], json!({ "write": false, "hostLocal": false }));
    for (type_, code) in codes {
        assert_eq!(code, "forbidden", "{type_}");
    }
}

#[test]
fn a_remote_writer_admitted_by_opt_in_is_still_refused() {
    let (auth, codes) = run(gated_policy([192, 168, 1, 50], true, false, true), true);
    assert_eq!(auth["capabilities"], json!({ "write": true, "hostLocal": false }));
    for (type_, code) in codes {
        assert_eq!(code, "forbidden", "{type_}");
    }
}

#[test]
fn a_loopback_client_of_an_ungated_host_is_refused() {
    let (auth, codes) = run(gated_policy([127, 0, 0, 1], false, false, false), false);
    assert_eq!(auth["capabilities"], json!({ "write": true, "hostLocal": false }));
    for (type_, code) in codes {
        assert_eq!(code, "forbidden", "{type_}");
    }
}

#[test]
fn a_shared_live_tunnel_client_is_refused() {
    let (_auth, codes) = run(gated_policy([127, 0, 0, 1], false, true, true), true);
    for (type_, code) in codes {
        assert_eq!(code, "forbidden", "{type_}");
    }
}

#[test]
fn a_loopback_client_holding_the_token_and_the_host_credential_passes_the_check() {
    let (auth, codes) = run(gated_policy([127, 0, 0, 1], false, false, true), true);
    assert_eq!(auth["capabilities"], json!({ "write": true, "hostLocal": true }));
    // The harness host has no Account store, so each handler answers with
    // its own refusal: anything but `forbidden` proves the check let it in.
    for (type_, code) in codes {
        assert_ne!(code, "forbidden", "{type_}");
    }
}

#[test]
fn a_loopback_client_with_only_the_bearer_token_is_refused() {
    for presented in [None, Some("a-guess"), Some("s3cret-token")] {
        let (auth, codes) = run_presenting(gated_policy([127, 0, 0, 1], false, false, true), true, presented);
        assert_eq!(auth["capabilities"], json!({ "write": true, "hostLocal": false }), "{presented:?}");
        for (type_, code) in codes {
            assert_eq!(code, "forbidden", "{type_} with {presented:?}");
        }
    }
}

#[test]
fn a_client_behind_a_same_host_proxy_is_refused_even_with_the_credential() {
    let (auth, codes) = run(gated_policy([127, 0, 0, 1], false, false, true).through_proxy(true), true);
    assert_eq!(auth["capabilities"], json!({ "write": true, "hostLocal": false }));
    for (type_, code) in codes {
        assert_eq!(code, "forbidden", "{type_}");
    }
}

#[test]
fn the_refusal_names_the_host_local_requirement() {
    let mut access = ConnectionAccess::granted(gated_policy([192, 168, 1, 50], true, false, true));
    let mut authed = true;
    let reply = handle_sync_with_access(
        &frame("rename_claude_account"),
        &mut authed,
        &mut None,
        &mut access,
        None,
    );
    assert_eq!(
        reply.err.unwrap().message,
        "`rename_claude_account` uses this host's credentials; only a client on the host itself that presented the host-local credential may send it"
    );
}

#[test]
fn a_remote_writer_cannot_watch_ssh_events() {
    let mut access = ConnectionAccess::granted(gated_policy([192, 168, 1, 50], true, false, true));
    let mut authed = true;
    let reply = handle_sync_with_access(
        r#"{"id":"w","type":"watch","payload":{"watch":"ssh"}}"#,
        &mut authed,
        &mut None,
        &mut access,
        None,
    );
    let err = reply.err.unwrap();
    assert_eq!(err.code, "forbidden");
    assert!(err.message.contains("uses this host's credentials"), "{}", err.message);
}
