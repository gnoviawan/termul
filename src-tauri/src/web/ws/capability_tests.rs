#![allow(clippy::unwrap_used, clippy::expect_used)]
//! View-only matrix, answer-by-ticket from an unsubscribed socket, and device
//! presence on `/ws` — exercised through `handle_request` and through a real
//! socket against the production router seam (`ws_upgrade`).

use super::tests::{
    auth_frame, handle_sync_with_access, test_access, test_env, test_outbound, test_policy,
    ws_read_frame, ws_test_app_state, ws_write_frame,
};
use super::*;
use tokio_util::sync::CancellationToken;

const MUTATIONS: &[&str] = &[
    "spawn_agent",
    "kill_agent",
    "create_session",
    "load_session",
    "resume_session",
    "close_session",
    "dispose_ephemeral_session",
    "promote_session",
    "register_discovered_session",
    "delete_session",
    "send_prompt",
    "cancel_prompt",
    "set_mode",
    "set_model",
    "set_config_option",
    "respond_permission",
    "answer_question",
    "add_project",
    "update_project",
    "remove_project",
    "set_default_project",
    "set_catalog_opt_in",
    "install_acp_agent",
    "authenticate_agent",
    "logout_agent",
    "delete_agent_session",
    "respond_elicitation",
    "acp_deliver_auth_redirect",
    "record_agent_switch",
];

/// A view-only peer on the `/ws` carrier: non-loopback, no opt-in.
fn view_only_access() -> ConnectionAccess {
    ConnectionAccess::granted(test_policy([192, 168, 1, 50], false, false))
}

fn frame(id: &str, type_: &str, payload: Value) -> String {
    json!({ "id": id, "type": type_, "payload": payload }).to_string()
}

fn code(reply: &WsReply) -> String {
    reply.err.as_ref().map(|e| e.code.clone()).unwrap_or_default()
}

#[test]
fn view_only_connection_is_refused_every_mutation_with_forbidden() {
    let mut access = view_only_access();
    for type_ in MUTATIONS {
        let mut authed = true;
        let reply = handle_sync_with_access(
            &frame("m", type_, json!({})),
            &mut authed,
            &mut Some(ClientIdentity {
                device_id: "phone".into(),
                client_instance_id: "tab".into(),
            }),
            &mut access,
            None,
        );
        assert!(!reply.ok, "{type_} must not run for a view-only connection");
        assert_eq!(code(&reply), "forbidden", "{type_}");
    }
}

#[test]
fn view_only_connection_keeps_reads_ping_and_subscribe() {
    let mut access = view_only_access();
    for (type_, payload) in [
        ("ping", json!({})),
        ("list_agents", json!({})),
        ("list_sessions", json!({ "agentId": "a1" })),
        ("list_persisted_sessions", json!({})),
        ("store_read", json!({ "key": "settings/theme" })),
        ("subscribe", json!({ "sessionId": "missing" })),
        ("watch_project", json!({ "projectId": "missing" })),
        ("unwatch_project", json!({ "projectId": "missing" })),
    ] {
        let mut authed = true;
        let reply = handle_sync_with_access(
            &frame("r", type_, payload),
            &mut authed,
            &mut None,
            &mut access,
            None,
        );
        assert_ne!(code(&reply), "forbidden", "{type_} is a view-level request");
    }
}

#[test]
fn view_only_store_writes_only_under_the_device_prefix() {
    let mut access = view_only_access();
    let mut identity = Some(ClientIdentity {
        device_id: "phone".into(),
        client_instance_id: "tab".into(),
    });
    let run = |type_: &str, payload: Value, access: &mut ConnectionAccess, identity: &mut Option<ClientIdentity>| {
        let mut authed = true;
        handle_sync_with_access(&frame("s", type_, payload), &mut authed, identity, access, None)
    };
    // Own namespace: passes the capability gate (the harness has no store, so
    // the handler then answers STORE_UNAVAILABLE — anything but `forbidden`).
    for type_ in ["store_write", "store_delete"] {
        let own = run(type_, json!({ "key": "device/phone/layout", "value": 1 }), &mut access, &mut identity);
        assert_ne!(code(&own), "forbidden", "{type_} on the own device prefix");
        for key in ["settings/theme", "device/tablet/layout", "device/phone"] {
            let other = run(type_, json!({ "key": key, "value": 1 }), &mut access, &mut identity);
            assert_eq!(code(&other), "forbidden", "{type_} on `{key}`");
        }
    }
}

#[test]
fn write_capable_connection_is_not_refused() {
    let mut access = test_access();
    for type_ in MUTATIONS {
        let mut authed = true;
        let reply = handle_sync_with_access(
            &frame("m", type_, json!({})),
            &mut authed,
            &mut None,
            &mut access,
            None,
        );
        assert_ne!(code(&reply), "forbidden", "{type_} on a loopback standalone peer");
    }
}

#[test]
fn authenticate_resolves_capabilities_once_from_peer_and_deployment_flags() {
    let cases = [
        // (peer, allow_remote_writes, shared_live_writes_denied, may_write)
        ([127, 0, 0, 1], false, false, true),
        ([192, 168, 1, 50], false, false, false),
        ([192, 168, 1, 50], true, false, true),
        ([127, 0, 0, 1], false, true, false),
        ([192, 168, 1, 50], true, true, false),
    ];
    for (peer, allow, denied, may_write) in cases {
        let mut access = ConnectionAccess::new(test_policy(peer, allow, denied));
        assert!(!access.capabilities().write, "nothing is granted before authenticate");
        let mut authed = false;
        let mut identity = None;
        let reply = handle_sync_with_access(
            &auth_frame("a", None),
            &mut authed,
            &mut identity,
            &mut access,
            None,
        );
        assert!(reply.ok);
        assert_eq!(access.capabilities().write, may_write, "peer={peer:?} allow={allow} denied={denied}");
        let create = handle_sync_with_access(
            &frame("c", "create_session", json!({})),
            &mut authed,
            &mut identity,
            &mut access,
            None,
        );
        assert_eq!(code(&create) == "forbidden", !may_write);
    }
}

#[tokio::test]
async fn send_prompt_fast_path_enforces_the_capability_check() {
    let relay = Arc::new(WsRelaySink::new());
    let acp = Arc::new(AcpManager::new(vec![]));
    let registry = Arc::new(ProjectRegistry::new());
    let (tx, mut rx) = test_outbound();
    let subscribed = Arc::new(Subscriptions::default());
    let mut conn = ConnState::authenticated(view_only_access());
    conn.subscriptions = Arc::clone(&subscribed);
    let exec = KeyedExecutor::new(CancellationToken::new());
    let alive = dispatch_connection_text(r#"{"id":"p1","type":"send_prompt","payload":{"agentId":"a","sessionId":"s","text":"hi","turnId":"t"}}"#, &mut conn, &test_env(&acp, &relay, &registry, &tx, &subscribed), &exec)
    .await;
    assert!(alive);
    let Some(Outbound::Reply(reply)) = rx.recv().await else {
        panic!("expected a reply frame");
    };
    assert_eq!(code(&reply), "forbidden");
    assert!(rx.try_recv().is_err(), "no turn was started");
}

// ---------------------------------------------------------------------------
// Real-socket tests against the production `ws_upgrade` handler
// ---------------------------------------------------------------------------

async fn serve(state: AppState) -> (u16, tokio::task::JoinHandle<()>) {
    let app = axum::Router::new()
        .route("/ws", axum::routing::get(ws_upgrade))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    (port, server)
}

/// Upgrade, consume `auth_required`, and authenticate as `device`.
async fn connect_authenticated(port: u16, device: &str) -> tokio::net::TcpStream {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let request = format!(
        "GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut headers = Vec::new();
    let mut byte = [0u8; 1];
    while !headers.ends_with(b"\r\n\r\n") {
        stream.read_exact(&mut byte).await.unwrap();
        headers.push(byte[0]);
    }
    assert!(String::from_utf8_lossy(&headers).contains("101"));
    let (_, first) = ws_read_frame(&mut stream).await;
    assert!(String::from_utf8_lossy(&first).contains("auth_required"));
    let reply = request_reply(
        &mut stream,
        &json!({
            "id": "auth",
            "type": "authenticate",
            "payload": {
                "protocolVersion": WS_PROTOCOL_VERSION,
                "deviceId": device,
                "clientInstanceId": "t1",
            }
        })
        .to_string(),
    )
    .await;
    assert_eq!(reply["ok"], true, "{reply}");
    stream
}

async fn request_reply(stream: &mut tokio::net::TcpStream, text: &str) -> Value {
    ws_write_frame(stream, 0x1, text.as_bytes()).await;
    loop {
        let (opcode, payload) = ws_read_frame(stream).await;
        if opcode != 0x1 {
            continue;
        }
        let value: Value = serde_json::from_slice(&payload).unwrap();
        // Skip pushed events; replies carry `ok`.
        if value.get("ok").is_some() {
            return value;
        }
    }
}

async fn wait_for(mut condition: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("condition met within timeout");
}

#[tokio::test]
async fn real_socket_view_only_connection_is_refused_and_tracked_in_presence() {
    let mut state = ws_test_app_state();
    state.shared_live_writes_denied = true;
    let relay = Arc::clone(&state.relay);
    let (port, server) = serve(state).await;

    let mut stream = connect_authenticated(port, "phone").await;
    let presence = relay.presence().device("phone").expect("registered at authenticate");
    assert_eq!(presence.connections, 1);

    let refused = request_reply(
        &mut stream,
        r#"{"id":"c1","type":"create_session","payload":{}}"#,
    )
    .await;
    assert_eq!(refused["ok"], false);
    assert_eq!(refused["err"]["code"], "forbidden");
    let allowed = request_reply(&mut stream, r#"{"id":"p1","type":"ping","payload":{}}"#).await;
    assert_eq!(allowed["ok"], true);

    // A second connection of the same device aggregates; closing both clears it.
    let second = connect_authenticated(port, "phone").await;
    assert_eq!(relay.presence().device("phone").unwrap().connections, 2);
    drop(second);
    wait_for(|| relay.presence().device("phone").is_some_and(|p| p.connections == 1)).await;
    drop(stream);
    wait_for(|| relay.presence().device("phone").is_none()).await;
    server.abort();
}

#[tokio::test]
async fn real_socket_unsubscribed_connection_answers_by_ticket_then_already_resolved() {
    use crate::web::sink::{AcpEvent, EventSink};
    let state = ws_test_app_state();
    let relay = Arc::clone(&state.relay);
    relay.set_rendezvous(Arc::new(crate::web::permissions::PermissionRendezvous::default()));
    relay.set_question_rendezvous(Arc::new(crate::web::permissions::QuestionRendezvous::default()));
    relay.seed_session_for_test("sess-1");
    // A pending approval + question exist; NO socket subscribes to sess-1.
    relay.emit(&AcpEvent {
        sid: Some("sess-1".to_string()),
        type_: "acp:permission_request",
        payload: json!({
            "agentId": "a1", "sessionId": "sess-1", "requestId": "perm-1",
            "toolCall": { "toolCallId": "tc-1" }, "options": [{ "optionId": "allow" }]
        }),
    });
    relay.emit(&AcpEvent {
        sid: Some("sess-1".to_string()),
        type_: "acp:question_request",
        payload: json!({
            "agentId": "a1", "sessionId": "sess-1", "questionId": "q-1",
            "question": "Q", "options": [{ "value": "plan-a", "label": "Plan A" }]
        }),
    });
    let (port, server) = serve(state).await;

    // Fresh socket 1: no `subscribe`, no `agentId` — answers by ticket.
    let mut first = connect_authenticated(port, "laptop").await;
    let approved = request_reply(
        &mut first,
        r#"{"id":"r1","type":"respond_permission","payload":{"requestId":"perm-1","optionId":"allow"}}"#,
    )
    .await;
    assert_eq!(approved["ok"], true, "{approved}");
    let answered = request_reply(
        &mut first,
        r#"{"id":"r2","type":"answer_question","payload":{"questionId":"q-1","values":["plan-a"]}}"#,
    )
    .await;
    assert_eq!(answered["ok"], true, "{answered}");

    // A different fresh socket answering the same tickets is too late.
    let mut second = connect_authenticated(port, "tablet").await;
    let late = request_reply(
        &mut second,
        r#"{"id":"r3","type":"respond_permission","payload":{"requestId":"perm-1","optionId":"allow"}}"#,
    )
    .await;
    assert_eq!(late["err"]["code"], "already_resolved");
    let late_question = request_reply(
        &mut second,
        r#"{"id":"r4","type":"answer_question","payload":{"questionId":"q-1","values":["plan-a"]}}"#,
    )
    .await;
    assert_eq!(late_question["err"]["code"], "already_resolved");
    // A ticket that never existed stays `stale`.
    let unknown = request_reply(
        &mut second,
        r#"{"id":"r5","type":"respond_permission","payload":{"requestId":"perm-never"}}"#,
    )
    .await;
    assert_eq!(unknown["err"]["code"], "stale");
    server.abort();
}

#[tokio::test]
async fn real_socket_view_only_connection_cannot_answer_a_ticket() {
    use crate::web::sink::{AcpEvent, EventSink};
    let mut state = ws_test_app_state();
    state.shared_live_writes_denied = true;
    let relay = Arc::clone(&state.relay);
    relay.set_rendezvous(Arc::new(crate::web::permissions::PermissionRendezvous::default()));
    relay.seed_session_for_test("sess-1");
    relay.emit(&AcpEvent {
        sid: Some("sess-1".to_string()),
        type_: "acp:permission_request",
        payload: json!({
            "agentId": "a1", "sessionId": "sess-1", "requestId": "perm-1",
            "toolCall": { "toolCallId": "tc-1" }, "options": [{ "optionId": "allow" }]
        }),
    });
    let (port, server) = serve(state).await;
    let mut viewer = connect_authenticated(port, "phone").await;
    let refused = request_reply(
        &mut viewer,
        r#"{"id":"r1","type":"respond_permission","payload":{"requestId":"perm-1","optionId":"allow"}}"#,
    )
    .await;
    assert_eq!(refused["err"]["code"], "forbidden");
    // The ticket is untouched: still outstanding.
    assert!(relay.rendezvous().unwrap().session_for_request("perm-1").is_some());
    server.abort();
}
