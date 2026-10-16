use super::*;
use std::net::SocketAddr;
use std::time::Duration;

#[test]
fn validates_numeric_dimensions() {
    assert_eq!(u16_field(&json!({ "cols": 80 }), "cols"), Ok(80));
    assert!(u16_field(&json!({ "cols": 0 }), "cols").is_err());
}

#[test]
fn u16_rejects_negative_and_overflow() {
    assert!(u16_field(&json!({ "rows": -1 }), "rows").is_err());
    assert!(u16_field(&json!({ "rows": 70000 }), "rows").is_err());
}

#[test]
fn string_field_rejects_empty_and_missing() {
    assert!(string_field(&json!({ "terminalId": "" }), "terminalId").is_err());
    assert!(string_field(&json!({}), "terminalId").is_err());
    assert_eq!(
        string_field(&json!({ "terminalId": "t1" }), "terminalId"),
        Ok("t1")
    );
}

#[test]
fn context_authorize_and_detach_roundtrip() {
    let mut ctx = ConnectionContext {
        authorized: Arc::new(RwLock::new(HashSet::new())),
        attachments: HashMap::new(),
        // Tests exercise post-gate behavior on an already-authed connection.
        authed: true,
        identity: None,
        capabilities: write_capabilities(),
        capability_policy: loopback_policy(),
        presence: None,
        client_id: "test-conn-1".to_string(),
    };
    ctx.authorize("t1");
    assert!(ctx.is_authorized("t1"));
    assert!(!ctx.is_authorized("t2"));
    let state = gate_test_state(None);
    ctx.detach("t1", &state);
    assert!(!ctx.is_authorized("t1"));
}

#[test]
fn string_field_validates_structural_ids() {
    // Structural validation applies to `terminalId` on every arm (a missing
    // terminal id reveals nothing about any terminal, so VALIDATION_ERROR
    // is allowed there). Claims deliberately do NOT use this path: on
    // attach/rotate/revoke a missing or empty claim flows through
    // verification and fails with the generic UNAUTHORIZED like any bad
    // credential (contract: no response distinguishes "missing" from
    // "invalid"). The handler-level wiring of that behavior needs a live
    // PtyManager (deferred seam); this test pins the helper only.
    assert!(string_field(&json!({ "terminalId": "" }), "terminalId").is_err());
    assert!(string_field(&json!({}), "terminalId").is_err());
    assert_eq!(
        string_field(&json!({ "terminalId": "t1" }), "terminalId"),
        Ok("t1")
    );
}

#[test]
fn connection_gate_routes_authenticate_pre_auth() {
    // `authenticate` is always routed — it is the way in.
    assert_eq!(
        connection_gate(false, "authenticate"),
        ConnectionGate::Authenticate
    );
    assert_eq!(
        connection_gate(true, "authenticate"),
        ConnectionGate::Authenticate
    );
}

#[test]
fn connection_gate_refuses_every_pre_auth_op() {
    // QA repro (P1): a pre-auth spawn/write/attach/… must be refused
    // before any handler runs — no PTY is ever created pre-auth.
    for ty in [
        "spawn",
        "write",
        "resize",
        "kill",
        "attach",
        "detach",
        "rotate_claim",
        "revoke_claim",
        "get_cwd",
        "get_git_branch",
        "get_git_status",
        "get_exit_code",
        "unknown-future-op",
    ] {
        assert_eq!(
            connection_gate(false, ty),
            ConnectionGate::Refuse,
            "pre-auth {ty} must be refused"
        );
    }
}

#[test]
fn connection_gate_allows_all_ops_post_auth() {
    for ty in ["spawn", "write", "attach", "unknown-future-op"] {
        assert_eq!(
            connection_gate(true, ty),
            ConnectionGate::Allow,
            "post-auth {ty} must proceed"
        );
    }
}
/// Build an AppState with the given gate posture (mirrors the fs_api test
/// literal). `Some(token)` = gated server, `None` = legacy ungated.
pub(super) fn gate_test_state(token: Option<&str>) -> crate::web::ws::AppState {
    let pty = crate::web::test_pty_manager();
    crate::web::ws::AppState {
        acp: Arc::new(crate::acp::AcpManager::new(vec![])),
        terminal_events: pty.terminal_events(),
        cwd_tracker: pty.cwd_tracker(),
        git_tracker: pty.git_tracker(),
        exit_code_tracker: pty.exit_code_tracker(),
        pty,
        relay: Arc::new(crate::web::sink::WsRelaySink::new()),
        registry: crate::web::project_registry::ProjectRegistry::seeded_for_test(
            &std::path::PathBuf::from("/tmp"),
        ),
        history_mode: crate::web::ws::HistoryMode::LiveOnly,
        pending_oauth_flows: Arc::new(parking_lot::RwLock::new(std::collections::HashMap::new())),
        oauth_base_url: "http://127.0.0.1".to_string(),
        acp_catalog: None,
        acp_install: None,
        store: None,
        web_auth: token.map(|t| {
            Arc::new(crate::web::auth::WebAuth::new(
                crate::web::auth::WebAuthToken::new(t).expect("non-empty"),
            ))
        }),
        allow_remote_writes: false,
        shared_live_writes_denied: false,
        connections: Default::default(),
    }
}

fn write_capabilities() -> Capabilities {
    Capabilities {
        carrier: Carrier::TerminalWs,
        write: true,
    }
}

/// A loopback peer on a deployment that does not deny writes.
fn loopback_policy() -> CapabilityPolicy {
    capability_policy([127, 0, 0, 1], false, false)
}

fn capability_policy(
    peer: [u8; 4],
    allow_remote_writes: bool,
    shared_live_writes_denied: bool,
) -> CapabilityPolicy {
    CapabilityPolicy {
        carrier: Carrier::TerminalWs,
        peer: SocketAddr::from((peer, 40000)),
        flags: crate::web::capabilities::WriteFlags {
            allow_remote_writes,
            shared_live_writes_denied,
        },
    }
}

pub(super) fn gate_test_ctx(authed: bool) -> ConnectionContext {
    ConnectionContext {
        authorized: Arc::new(RwLock::new(HashSet::new())),
        attachments: HashMap::new(),
        authed,
        identity: None,
        capabilities: if authed {
            write_capabilities()
        } else {
            Capabilities::none(Carrier::TerminalWs)
        },
        capability_policy: loopback_policy(),
        presence: None,
        client_id: format!("test-conn-{authed}"),
    }
}

fn gate_request(id: &str, type_: &str, payload: Value) -> Request {
    Request {
        id: id.to_string(),
        type_: type_.to_string(),
        payload,
        // A ledgered op is refused without an id: stamp one like a real client.
        command_id: crate::web::command_ledger::terminal::ws_kind(type_)
            .map(|_| crate::web::command_ledger::test_clock::fresh_command_id()),
    }
}

#[tokio::test]
async fn gated_handle_refuses_pre_auth_spawn_and_validates_token() {
    // QA P1 repro, in-module: a gated connection starts un-authed; spawn
    // is refused with the generic UNAUTHORIZED before any handler runs,
    // a wrong token is refused the same way, and the correct token
    // authenticates (retry on the same connection is allowed).
    let state = gate_test_state(Some("s3cret"));
    let (tx, _rx) = mpsc::channel(8);
    let mut ctx = gate_test_ctx(false);

    let refused = handle(
        gate_request(
            "r1",
            "spawn",
            json!({"projectId": "p", "shell": "/bin/bash"}),
        ),
        &state,
        &tx,
        &mut ctx,
    )
    .await;
    assert_eq!(refused, Err(("UNAUTHORIZED", "Unauthorized".to_string())));
    assert!(!ctx.authed, "refused spawn must not authenticate");

    let wrong = handle(
        gate_request("r2", "authenticate", auth_payload(Some("WRONG"))),
        &state,
        &tx,
        &mut ctx,
    )
    .await;
    assert_eq!(wrong, Err(("UNAUTHORIZED", "Unauthorized".to_string())));
    assert!(!ctx.authed, "wrong token must not authenticate");

    let missing = handle(
        gate_request("r3", "authenticate", auth_payload(None)),
        &state,
        &tx,
        &mut ctx,
    )
    .await;
    assert_eq!(missing, Err(("UNAUTHORIZED", "Unauthorized".to_string())));
    assert!(!ctx.authed);

    let ok = handle(
        gate_request("r4", "authenticate", auth_payload(Some("s3cret"))),
        &state,
        &tx,
        &mut ctx,
    )
    .await;
    assert_eq!(ok, Ok(json!({})));
    assert!(ctx.authed, "correct token authenticates the connection");

    // Post-auth, requests dispatch normally again (unknown type reaches
    // the legacy NOT_IMPLEMENTED arm instead of the gate refusal).
    let unknown = handle(
        gate_request("r5", "bogus-op", json!({})),
        &state,
        &tx,
        &mut ctx,
    )
    .await;
    assert_eq!(
        unknown,
        Err(("NOT_IMPLEMENTED", "unknown terminal request".to_string()))
    );
}

fn auth_payload(token: Option<&str>) -> Value {
    let mut payload = json!({
        "protocolVersion": crate::web::ws::WS_PROTOCOL_VERSION,
        "deviceId": "device-a",
        "clientInstanceId": "tab-1",
    });
    if let Some(token) = token {
        payload["token"] = json!(token);
    }
    payload
}

#[tokio::test]
async fn ungated_connection_is_authed_only_after_valid_handshake() {
    // Ungated hosts no longer admit connections implicitly: requests before
    // a valid `authenticate` are refused UNAUTHORIZED, and any token passes
    // once the handshake checks succeed.
    let state = gate_test_state(None);
    let (tx, _rx) = mpsc::channel(8);
    let mut ctx = gate_test_ctx(false);

    let refused = handle(
        gate_request("r0", "spawn", json!({"projectId": "p"})),
        &state,
        &tx,
        &mut ctx,
    )
    .await;
    assert_eq!(refused, Err(("UNAUTHORIZED", "Unauthorized".to_string())));
    assert!(!ctx.authed);

    let reply = handle(
        gate_request("r1", "authenticate", auth_payload(Some("anything"))),
        &state,
        &tx,
        &mut ctx,
    )
    .await;
    assert_eq!(reply, Ok(json!({})));
    assert!(ctx.authed);
    let identity = ctx.identity.as_ref().expect("identity recorded");
    assert_eq!(identity.device_id, "device-a");
    assert_eq!(identity.client_instance_id, "tab-1");

    // Re-auth on an authed connection is an idempotent no-op success.
    let again = handle(
        gate_request("r2", "authenticate", json!({})),
        &state,
        &tx,
        &mut ctx,
    )
    .await;
    assert_eq!(again, Ok(json!({})));
}

#[tokio::test]
async fn authenticate_refuses_bad_version_and_identity_with_screaming_codes() {
    let oversized = "x".repeat(crate::web::ws::MAX_CLIENT_ID_LEN + 1);
    for token in [None, Some("s3cret")] {
        let state = gate_test_state(token);
        let (tx, _rx) = mpsc::channel(8);
        for (payload, code) in [
            // Missing version, wrong version, non-numeric version.
            (
                json!({"deviceId": "d", "clientInstanceId": "c", "token": "s3cret"}),
                "PROTOCOL_VERSION_MISMATCH",
            ),
            (
                json!({"protocolVersion": 99, "deviceId": "d", "clientInstanceId": "c", "token": "s3cret"}),
                "PROTOCOL_VERSION_MISMATCH",
            ),
            (
                json!({"protocolVersion": "1", "deviceId": "d", "clientInstanceId": "c", "token": "s3cret"}),
                "PROTOCOL_VERSION_MISMATCH",
            ),
            // Version wins over a bad identity AND a wrong token.
            (
                json!({"deviceId": "", "clientInstanceId": "", "token": "WRONG"}),
                "PROTOCOL_VERSION_MISMATCH",
            ),
            // Identity beats a wrong token.
            (
                json!({"protocolVersion": crate::web::ws::WS_PROTOCOL_VERSION, "deviceId": "", "clientInstanceId": "c", "token": "WRONG"}),
                "INVALID_CLIENT_IDENTITY",
            ),
            (
                json!({"protocolVersion": crate::web::ws::WS_PROTOCOL_VERSION, "deviceId": 5, "clientInstanceId": "c", "token": "s3cret"}),
                "INVALID_CLIENT_IDENTITY",
            ),
            (
                json!({"protocolVersion": crate::web::ws::WS_PROTOCOL_VERSION, "deviceId": "d", "token": "s3cret"}),
                "INVALID_CLIENT_IDENTITY",
            ),
            (
                json!({"protocolVersion": crate::web::ws::WS_PROTOCOL_VERSION, "deviceId": "d", "clientInstanceId": oversized, "token": "s3cret"}),
                "INVALID_CLIENT_IDENTITY",
            ),
        ] {
            let mut ctx = gate_test_ctx(false);
            let reply = handle(
                gate_request("r1", "authenticate", payload.clone()),
                &state,
                &tx,
                &mut ctx,
            )
            .await;
            let (got, message) = reply.expect_err("handshake must be refused");
            assert_eq!(got, code, "{payload}");
            assert!(!message.contains("WRONG") && !message.contains("s3cret"));
            assert!(!ctx.authed, "refusal stays pre-auth: {payload}");
            assert!(ctx.identity.is_none());
        }
    }
}

#[test]
fn unauthorized_error_is_single_generic_shape_for_all_surfaces() {
    // attach, rotate_claim and revoke_claim must all fail with the same
    // code + message shape — no distinguishing unknown terminal from
    // wrong/revoked credential from binding mismatch (CAP-3 leak fix).
    let (code, message) = unauthorized_error("t1");
    assert_eq!(code, "UNAUTHORIZED");
    // Byte-identical to the desktop error string and independent of the
    // terminal id (no input echo — nothing distinguishes failure causes).
    assert_eq!(message, "Unauthorized");
    assert_eq!(unauthorized_error("t1"), unauthorized_error("t2"));
    assert_ne!(
        code, "TERMINAL_NOT_FOUND",
        "existence-leaking code must not return"
    );
}

#[tokio::test]
async fn connection_detach_aborts_attachment_and_clears_authorization() {
    // This test pins the ConnectionContext::detach PRIMITIVE the teardown
    // relies on: aborting the attachment task and clearing authorization.
    // It does NOT drive handle() — the handler wiring (rotate_claim/
    // revoke_claim calling ctx.detach, plus the cross-connection
    // generation teardown inside attachment tasks) requires a live
    // PtyManager seam and is covered in CI integration, not here.
    let mut ctx = ConnectionContext {
        authorized: Arc::new(RwLock::new(HashSet::new())),
        attachments: HashMap::new(),
        // Tests exercise post-gate behavior on an already-authed connection.
        authed: true,
        identity: None,
        capabilities: write_capabilities(),
        capability_policy: loopback_policy(),
        presence: None,
        client_id: "test-conn-2".to_string(),
    };
    ctx.authorize("t1");

    // A live attachment task mimicking the output forwarder.
    let task = tokio::spawn(async {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    });
    ctx.attachments.insert(
        "t1".to_string(),
        Attachment {
            task,
            release: AttachmentRelease::default(),
        },
    );

    assert!(ctx.is_authorized("t1"));
    let state = gate_test_state(None);
    ctx.detach("t1", &state);

    // Output stream severed + write/resize authorization removed, and the
    // abort actually reached the task (teardown is real, not bookkeeping).
    assert!(!ctx.is_authorized("t1"));
    assert!(ctx.attachments.is_empty());
}

/// Spawn a live PTY through the handler on the OWNER context (default
/// shell + home cwd — platform-agnostic) and return its terminal id.
async fn spawn_owned(state: &crate::web::ws::AppState, owner: &mut ConnectionContext) -> String {
    let (tx, _rx) = mpsc::channel(8);
    let spawned = handle(
        gate_request("spawn-1", "spawn", json!({"projectId": "p"})),
        state,
        &tx,
        owner,
    )
    .await
    .expect("owner spawn succeeds");
    let id = spawned["id"]
        .as_str()
        .expect("spawn reply carries id")
        .to_string();
    assert!(owner.is_authorized(&id), "issuance authorizes the spawner");
    id
}

#[tokio::test]
async fn kill_requires_authorization_before_existence_check_or_force_kill() {
    // CWE-862 regression: a connection holding only the shared web token
    // must not kill another connection's PTY. The authorization check runs
    // BEFORE any existence check or force_kill and collapses to the single
    // generic UNAUTHORIZED — identical for a live foreign terminal and an
    // unknown id (existence is never revealed).
    let state = gate_test_state(None);
    let (tx, _rx) = mpsc::channel(8);
    let mut owner = gate_test_ctx(true);
    let terminal_id = spawn_owned(&state, &mut owner).await;
    let generic = Err(unauthorized_error(&terminal_id));

    // Attacker connection: authed (ungated server admits the connection)
    // but NOT authorized for the owner's terminal.
    let mut attacker = gate_test_ctx(true);
    let foreign = handle(
        gate_request("k1", "kill", json!({"terminalId": terminal_id})),
        &state,
        &tx,
        &mut attacker,
    )
    .await;
    let unknown = handle(
        gate_request("k2", "kill", json!({"terminalId": "term-never-existed"})),
        &state,
        &tx,
        &mut attacker,
    )
    .await;
    assert_eq!(foreign, generic);
    assert_eq!(unknown, generic, "unknown-terminal kill must be identical");
    assert!(
        state.pty.get(&terminal_id).is_some(),
        "a foreign kill must leave the PTY running"
    );

    // Authorized behavior preserved: the owner kills its own terminal…
    let owner_kill = handle(
        gate_request("k3", "kill", json!({"terminalId": terminal_id})),
        &state,
        &tx,
        &mut owner,
    )
    .await;
    assert_eq!(owner_kill, Ok(Value::Null));
    assert!(state.pty.get(&terminal_id).is_none());
    // …and a repeat kill collapses to the same generic UNAUTHORIZED (the
    // first kill detached the terminal — no existence leak on retry).
    let repeat = handle(
        gate_request("k4", "kill", json!({"terminalId": terminal_id})),
        &state,
        &tx,
        &mut owner,
    )
    .await;
    assert_eq!(repeat, generic);
}

#[tokio::test]
async fn resize_requires_authorization_and_collapses_with_unknown_terminal() {
    // Same contract as kill: unauthorized resize and unknown-terminal
    // resize are the identical generic UNAUTHORIZED (no existence leak),
    // and the authorized resizer is unaffected.
    let state = gate_test_state(None);
    let (tx, _rx) = mpsc::channel(8);
    let mut owner = gate_test_ctx(true);
    let terminal_id = spawn_owned(&state, &mut owner).await;
    let generic = Err(unauthorized_error(&terminal_id));

    let mut attacker = gate_test_ctx(true);
    let foreign = handle(
        gate_request(
            "r1",
            "resize",
            json!({"terminalId": terminal_id, "cols": 100, "rows": 40}),
        ),
        &state,
        &tx,
        &mut attacker,
    )
    .await;
    let unknown = handle(
        gate_request(
            "r2",
            "resize",
            json!({"terminalId": "term-never-existed", "cols": 100, "rows": 40}),
        ),
        &state,
        &tx,
        &mut attacker,
    )
    .await;
    assert_eq!(foreign, generic);
    assert_eq!(
        unknown, generic,
        "unknown-terminal resize must be identical"
    );

    // Authorized behavior preserved: the owner resizes its own terminal.
    let ok = handle(
        gate_request(
            "r3",
            "resize",
            json!({"terminalId": terminal_id, "cols": 100, "rows": 40}),
        ),
        &state,
        &tx,
        &mut owner,
    )
    .await;
    assert_eq!(ok, Ok(Value::Null));

    // Cleanup: kill the live PTY so the test doesn't leak a process.
    let _ = handle(
        gate_request("k", "kill", json!({"terminalId": terminal_id})),
        &state,
        &tx,
        &mut owner,
    )
    .await;
}

/// Story 5: `list_preserved {projectId}` on an AUTHED connection returns
/// the preserved terminals of that project — metadata plus a freshly
/// issued claim that a subsequent `attach` accepts (reattach-by-claim).
/// The re-issue replaces the prior record: the ORIGINAL spawn claim stops
/// verifying (revoke-and-reissue), so a stale pre-reload credential gains
/// nothing from the new issuance.
#[tokio::test]
async fn list_preserved_returns_terminals_and_fresh_claims_for_authed_connection() {
    let state = gate_test_state(None);
    let (tx, _rx) = mpsc::channel(16);
    let mut owner = gate_test_ctx(true);

    // Two live terminals for project-a, one for project-b.
    let spawned_a1 = handle(
        gate_request("s1", "spawn", json!({"projectId": "project-a"})),
        &state,
        &tx,
        &mut owner,
    )
    .await
    .expect("spawn a1");
    let id_a1 = spawned_a1["id"].as_str().unwrap().to_string();
    let original_claim_a1 = spawned_a1["claim"].as_str().unwrap().to_string();
    let _ = handle(
        gate_request("s2", "spawn", json!({"projectId": "project-a"})),
        &state,
        &tx,
        &mut owner,
    )
    .await
    .expect("spawn a2");
    let spawned_b = handle(
        gate_request("s3", "spawn", json!({"projectId": "project-b"})),
        &state,
        &tx,
        &mut owner,
    )
    .await
    .expect("spawn b");
    let id_b = spawned_b["id"].as_str().unwrap().to_string();

    // Fresh authed connection with ZERO authorized terminals asks for
    // project-a (the reload case: new page, no attaches yet).
    let mut reloader = gate_test_ctx(true);
    let listed = handle(
        gate_request("lp-1", "list_preserved", json!({"projectId": "project-a"})),
        &state,
        &tx,
        &mut reloader,
    )
    .await
    .expect("list_preserved succeeds");

    let terminals = listed["terminals"].as_array().expect("terminals array");
    assert_eq!(terminals.len(), 2, "both project-a PTYs preserved");
    let ids: Vec<&str> = terminals.iter().filter_map(|t| t["id"].as_str()).collect();
    assert!(ids.contains(&id_a1.as_str()));
    let entry_a1 = terminals
        .iter()
        .find(|t| t["id"].as_str() == Some(id_a1.as_str()))
        .unwrap();
    assert!(entry_a1["shell"].as_str().is_some());
    assert!(entry_a1["cwd"].as_str().is_some());
    assert!(entry_a1["pid"].as_u64().is_some());
    let fresh_claim = entry_a1["claim"].as_str().expect("fresh claim").to_string();
    assert!(!fresh_claim.is_empty());
    assert_ne!(fresh_claim, original_claim_a1);

    // The fresh claim attaches (verified reattach path), while the
    // ORIGINAL claim — held only by the pre-reload page — no longer
    // verifies (record replaced) and takes the generic UNAUTHORIZED.
    let attach_ok = handle(
        gate_request(
            "at-1",
            "attach",
            json!({"terminalId": id_a1, "claim": fresh_claim, "lastSeq": 0}),
        ),
        &state,
        &tx,
        &mut reloader,
    )
    .await;
    assert!(attach_ok.is_ok(), "fresh claim attaches: {attach_ok:?}");
    let attach_stale = handle(
        gate_request(
            "at-2",
            "attach",
            json!({"terminalId": id_a1, "claim": original_claim_a1, "lastSeq": 0}),
        ),
        &state,
        &tx,
        &mut owner,
    )
    .await;
    assert_eq!(
        attach_stale,
        Err(unauthorized_error(&id_a1)),
        "the pre-reload claim must be dead after re-issue"
    );

    // Cleanup: kill both projects' terminals so no PTY processes leak.
    for (request_id, terminal_id) in [("k1", id_a1.as_str()), ("k2", id_b.as_str())] {
        let _ = handle(
            gate_request(request_id, "kill", json!({"terminalId": terminal_id})),
            &state,
            &tx,
            &mut owner,
        )
        .await;
    }
    // a2 id discovered from the listing above.
    for entry in terminals {
        let Some(id) = entry["id"].as_str() else {
            continue;
        };
        let _ = handle(
            gate_request("kx", "kill", json!({"terminalId": id})),
            &state,
            &tx,
            &mut owner,
        )
        .await;
    }
}

/// Story 5 no-leak bars, pinned in-module:
/// 1. Pre-auth `list_preserved` takes the connection gate's single
///    generic UNAUTHORIZED (never a VALIDATION_ERROR or a count) — no
///    existence signal for un-authed clients.
/// 2. An authed connection asking for a project with NO preserved
///    terminals gets the same empty-list reply shape as any other
///    project — an unknown project is indistinguishable from an empty
///    one.
/// 3. Cross-reload listing is idempotent in PTY count: repeated
///    `list_preserved` cycles re-issue claims but never create or
///    destroy terminals (the 3-reload-cycles no-leak row).
#[tokio::test]
async fn list_preserved_refuses_unauthed_and_leaks_no_existence() {
    let state = gate_test_state(Some("s3cret"));
    let (tx, _rx) = mpsc::channel(8);

    // Pre-auth: the gate refuses with the single generic UNAUTHORIZED.
    let mut unauthed = gate_test_ctx(false);
    let refused = handle(
        gate_request(
            "lp-auth",
            "list_preserved",
            json!({"projectId": "project-a"}),
        ),
        &state,
        &tx,
        &mut unauthed,
    )
    .await;
    assert_eq!(refused, Err(("UNAUTHORIZED", "Unauthorized".to_string())));
    // A missing projectId on an AUTHED connection is a shape error
    // (nothing about any terminal is revealed — ids are structural).
    let authed_bad_shape = handle(
        gate_request("lp-shape", "list_preserved", json!({})),
        &state,
        &tx,
        &mut unauthed,
    )
    .await;
    assert_eq!(
        authed_bad_shape,
        Err(("UNAUTHORIZED", "Unauthorized".to_string()))
    );

    // Authenticate the same connection, then query with a missing
    // projectId: now VALIDATION_ERROR (structural) — the gate is the
    // only existence boundary.
    let auth = handle(
        gate_request("auth", "authenticate", auth_payload(Some("s3cret"))),
        &state,
        &tx,
        &mut unauthed,
    )
    .await;
    assert_eq!(auth, Ok(json!({})));
    let shape = handle(
        gate_request("lp-shape2", "list_preserved", json!({})),
        &state,
        &tx,
        &mut unauthed,
    )
    .await;
    assert_eq!(
        shape,
        Err(("VALIDATION_ERROR", "missing projectId".to_string()))
    );

    // Empty vs unknown project: identical reply shape, no PTY created.
    let before = state.pty.get_count();
    let empty = handle(
        gate_request(
            "lp-empty",
            "list_preserved",
            json!({"projectId": "project-none"}),
        ),
        &state,
        &tx,
        &mut unauthed,
    )
    .await
    .expect("empty list succeeds");
    assert_eq!(empty["terminals"].as_array().map(Vec::len), Some(0));
    assert_eq!(state.pty.get_count(), before, "no PTY created by listing");

    // 3 reload cycles: spawn one terminal, then list 3 times — the
    // preserved count stays 1 and the terminal id is stable each time.
    let mut owner = gate_test_ctx(true);
    let spawned = handle(
        gate_request("s", "spawn", json!({"projectId": "project-cycles"})),
        &state,
        &tx,
        &mut owner,
    )
    .await
    .expect("spawn");
    let id = spawned["id"].as_str().unwrap().to_string();
    for cycle in 0..3 {
        let listed = handle(
            gate_request(
                &format!("lp-{cycle}"),
                "list_preserved",
                json!({"projectId": "project-cycles"}),
            ),
            &state,
            &tx,
            &mut unauthed,
        )
        .await
        .expect("cycle list succeeds");
        let terminals = listed["terminals"].as_array().unwrap();
        assert_eq!(terminals.len(), 1, "cycle {cycle}: preserved count stable");
        assert_eq!(terminals[0]["id"].as_str(), Some(id.as_str()));
        let claim = terminals[0]["claim"].as_str().unwrap();
        // Each cycle's claim is fresh (re-issue) and verifies.
        assert_eq!(state.pty.verify_claim(&id, claim), Ok(()));
    }
    assert_eq!(state.pty.get_count(), before + 1, "3 cycles leaked no PTY");

    // Cleanup.
    let _ = handle(
        gate_request("k", "kill", json!({"terminalId": id})),
        &state,
        &tx,
        &mut owner,
    )
    .await;
}

/// #851a (second device): a terminal with a LIVE attachment on another
/// connection is listed WITH a SHARED claim — the owning connection keeps
/// its credential and output forwarder (no invalidation, no generation
/// bump), and the listing connection can attach read/write to the SAME
/// PTY instead of spawning a duplicate shell. The entry also carries
/// `hasLiveAttachment: true` ownership info.
#[tokio::test]
async fn list_preserved_live_attachment_offers_shared_claim_and_second_device_attaches() {
    let state = gate_test_state(None);
    let (tx, _rx) = mpsc::channel(16);
    let mut owner = gate_test_ctx(true);

    let spawned = handle(
        gate_request("s", "spawn", json!({"projectId": "project-live"})),
        &state,
        &tx,
        &mut owner,
    )
    .await
    .expect("spawn");
    let id = spawned["id"].as_str().unwrap().to_string();
    let owner_claim = spawned["claim"].as_str().unwrap().to_string();

    // The owner attaches — the forwarder task holds a live attachment.
    let attach_ok = handle(
        gate_request(
            "at",
            "attach",
            json!({"terminalId": id, "claim": owner_claim, "lastSeq": 0}),
        ),
        &state,
        &tx,
        &mut owner,
    )
    .await;
    assert!(attach_ok.is_ok(), "owner attach: {attach_ok:?}");

    // A second (different device) connection lists: the live terminal now
    // carries a SHARED claim (issue_shared — the owner's lease is untouched)
    // plus ownership info.
    let mut second_device = gate_test_ctx(true);
    let listed = handle(
        gate_request("lp", "list_preserved", json!({"projectId": "project-live"})),
        &state,
        &tx,
        &mut second_device,
    )
    .await
    .expect("list succeeds");
    let terminals = listed["terminals"].as_array().unwrap();
    assert_eq!(terminals.len(), 1);
    let shared_claim = terminals[0]["claim"]
        .as_str()
        .expect("live attachment offers a SHARED claim")
        .to_string();
    assert!(!shared_claim.is_empty());
    assert_ne!(shared_claim, owner_claim, "the shared claim is distinct");
    assert_eq!(
        terminals[0]["hasLiveAttachment"],
        json!(true),
        "ownership info marks the live attachment"
    );
    // The owner's claim still verifies — the shared issuance did NOT
    // invalidate it (no generation bump, no severance).
    assert_eq!(
        state.pty.verify_claim(&id, &owner_claim),
        Ok(()),
        "owner claim survives the second connection's listing"
    );

    // #851a acceptance: the second device attaches read/write to the SAME
    // PTY with its shared claim — authorized, no UNAUTHORIZED, no spawn.
    let second_attach = handle(
        gate_request(
            "at2",
            "attach",
            json!({"terminalId": id, "claim": shared_claim, "lastSeq": 0}),
        ),
        &state,
        &tx,
        &mut second_device,
    )
    .await;
    assert!(
        second_attach.is_ok(),
        "second device attach: {second_attach:?}"
    );
    // The second device is now authorized for write access on the terminal.
    assert!(second_device.is_authorized(&id));
    // The write succeeds (the second device co-owns the PTY).
    let write_ok = handle(
        gate_request(
            "w2",
            "write",
            json!({"terminalId": id, "data": "echo hi\r"}),
        ),
        &state,
        &tx,
        &mut second_device,
    )
    .await;
    assert!(write_ok.is_ok(), "second device write: {write_ok:?}");
    // And the OWNER's credential still verifies after all of it.
    assert_eq!(state.pty.verify_claim(&id, &owner_claim), Ok(()));

    // Owner detaches (its forwarder releases the attachment accounting).
    let detached = handle(
        gate_request("d", "detach", json!({"terminalId": id})),
        &state,
        &tx,
        &mut owner,
    )
    .await;
    assert_eq!(detached, Ok(json!(null)));
    let listed2 = handle(
        gate_request(
            "lp2",
            "list_preserved",
            json!({"projectId": "project-live"}),
        ),
        &state,
        &tx,
        &mut second_device,
    )
    .await
    .expect("second list succeeds");
    let terminals2 = listed2["terminals"].as_array().unwrap();
    assert_eq!(terminals2.len(), 1);
    assert!(
        terminals2[0]["claim"].as_str().is_some(),
        "the terminal stays attachable after the owner detaches"
    );

    // Cleanup.
    let _ = handle(
        gate_request("k", "kill", json!({"terminalId": id})),
        &state,
        &tx,
        &mut owner,
    )
    .await;
}

pub(super) async fn attach_terminal(
    state: &crate::web::ws::AppState,
    tx: &mpsc::Sender<Message>,
    ctx: &mut ConnectionContext,
    terminal_id: &str,
    claim: &str,
) {
    let attached = handle(
        gate_request(
            "attach",
            "attach",
            json!({"terminalId": terminal_id, "claim": claim, "lastSeq": 0}),
        ),
        state,
        tx,
        ctx,
    )
    .await;
    assert!(attached.is_ok(), "attach: {attached:?}");
}

fn live_attachments(state: &crate::web::ws::AppState, terminal_id: &str) -> usize {
    state
        .pty
        .get(terminal_id)
        .expect("terminal exists")
        .live_attachments
        .load(Ordering::Acquire)
}

/// PTY-F1: attaching the same terminal twice on ONE connection used to leak a
/// `live_attachments` count (the replaced forwarder was aborted without its
/// release), so the terminal reported a live attachment forever after the
/// socket closed and was never auto-reaped.
#[tokio::test]
async fn audit_f1_reattach_same_connection_leaks_attachment_count() {
    let state = gate_test_state(None);
    let (tx, _rx) = mpsc::channel(256);
    let mut conn = gate_test_ctx(true);
    let spawned = handle(
        gate_request("s", "spawn", json!({"projectId": "audit-f1"})),
        &state,
        &tx,
        &mut conn,
    )
    .await
    .expect("spawn");
    let id = spawned["id"].as_str().unwrap().to_string();
    let claim = spawned["claim"].as_str().unwrap().to_string();

    attach_terminal(&state, &tx, &mut conn, &id, &claim).await;
    attach_terminal(&state, &tx, &mut conn, &id, &claim).await;
    assert_eq!(
        live_attachments(&state, &id),
        1,
        "re-attach replaces the forwarder: exactly one live attachment"
    );

    // Socket closes: cleanup releases the single live attachment.
    conn.release_all(&state);
    assert_eq!(live_attachments(&state, &id), 0);
    assert!(!state.pty.get(&id).unwrap().has_live_attachment());
    let _ = state.pty.force_kill(&id).await;
}

/// A re-attach on one connection swaps its attachment: the new one is counted
/// before the old one is released, so another connection's `list_preserved`
/// can never observe zero live attachments mid-swap (which would reissue the
/// claim and sever the fresh forwarder).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reattach_swap_never_exposes_a_zero_attachment_count() {
    let state = gate_test_state(None);
    let (tx, _rx) = mpsc::channel(1024);
    let mut conn = gate_test_ctx(true);
    let spawned = handle(
        gate_request("s", "spawn", json!({"projectId": "reattach-swap"})),
        &state,
        &tx,
        &mut conn,
    )
    .await
    .expect("spawn");
    let id = spawned["id"].as_str().unwrap().to_string();
    let claim = spawned["claim"].as_str().unwrap().to_string();
    attach_terminal(&state, &tx, &mut conn, &id, &claim).await;

    let instance = state.pty.get(&id).expect("terminal exists");
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    // Start barrier: the observer raises `polling` right before its first
    // sample, and the first re-attach only starts once it is up — otherwise
    // the whole swap loop could finish before the observer ever ran.
    let polling = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let observer = {
        let (instance, stop, polling) = (instance.clone(), stop.clone(), polling.clone());
        tokio::task::spawn_blocking(move || {
            let (mut samples, mut zero_seen, mut max_count) = (0u64, false, 0usize);
            polling.store(true, Ordering::Release);
            while !stop.load(Ordering::Acquire) {
                let count = instance.live_attachments.load(Ordering::Acquire);
                samples += 1;
                zero_seen |= count == 0;
                max_count = max_count.max(count);
            }
            (samples, zero_seen, max_count)
        })
    };
    while !polling.load(Ordering::Acquire) {
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    }
    let mut reattaches = 0u32;
    for _ in 0..300 {
        attach_terminal(&state, &tx, &mut conn, &id, &claim).await;
        reattaches += 1;
    }
    stop.store(true, Ordering::Release);
    let (samples, zero_seen, max_count) = observer.await.unwrap();
    assert!(reattaches > 0, "swaps were exercised");
    assert!(samples > 0, "the observer sampled the count while swapping");
    assert!(max_count >= 1, "the observer saw the live attachment");
    assert!(
        !zero_seen,
        "the attachment count touched zero during a re-attach swap \
         ({samples} samples, {reattaches} re-attaches, max count {max_count})"
    );
    assert_eq!(live_attachments(&state, &id), 1);

    conn.release_all(&state);
    let _ = state.pty.force_kill(&id).await;
}

/// An attach whose reply cannot be sent (outbound receiver already dropped)
/// fails with `NETWORK_ERROR` and releases the attachment count it took — no
/// forwarder exists, so a leaked count would pin the terminal forever.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn attach_with_dead_reply_channel_releases_its_attachment_count() {
    let state = gate_test_state(None);
    let (tx, rx) = mpsc::channel(1024);
    let mut conn = gate_test_ctx(true);
    let spawned = handle(
        gate_request("s", "spawn", json!({"projectId": "attach-dead-reply"})),
        &state,
        &tx,
        &mut conn,
    )
    .await
    .expect("spawn");
    let id = spawned["id"].as_str().unwrap().to_string();
    let claim = spawned["claim"].as_str().unwrap().to_string();
    let before = live_attachments(&state, &id);
    assert_eq!(before, 0);

    drop(rx);
    let attached = handle(
        gate_request(
            "attach",
            "attach",
            json!({"terminalId": id, "claim": claim, "lastSeq": 0}),
        ),
        &state,
        &tx,
        &mut conn,
    )
    .await;
    assert_eq!(attached.unwrap_err().0, "NETWORK_ERROR");
    assert_eq!(live_attachments(&state, &id), before);
    assert!(conn.attachments.is_empty(), "no forwarder registered");

    let _ = state.pty.force_kill(&id).await;
}

/// The connection task being cancelled at the replay `send` (outbound queue
/// full, reader gone slow) must not leak the attachment count either.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_attach_during_replay_send_releases_its_attachment_count() {
    let state = gate_test_state(None);
    let (tx, _rx) = mpsc::channel(1);
    let mut conn = gate_test_ctx(true);
    // Spawn needs room for its own reply only; fill the queue afterwards.
    let (setup_tx, _setup_rx) = mpsc::channel(1024);
    let spawned = handle(
        gate_request("s", "spawn", json!({"projectId": "attach-cancelled"})),
        &state,
        &setup_tx,
        &mut conn,
    )
    .await
    .expect("spawn");
    let id = spawned["id"].as_str().unwrap().to_string();
    let claim = spawned["claim"].as_str().unwrap().to_string();
    tx.send(Message::Text("fill".into())).await.unwrap();

    let attach = handle(
        gate_request(
            "attach",
            "attach",
            json!({"terminalId": id, "claim": claim, "lastSeq": 0}),
        ),
        &state,
        &tx,
        &mut conn,
    );
    // Parked on the full queue; the timeout drops (cancels) the future.
    let outcome = tokio::time::timeout(std::time::Duration::from_millis(200), attach).await;
    assert!(outcome.is_err(), "the replay send must be pending");
    assert_eq!(live_attachments(&state, &id), 0);
    assert!(conn.attachments.is_empty());

    let _ = state.pty.force_kill(&id).await;
}

/// PTY-F1 / Q2: a connection whose socket dies has its forwarder self-release
/// on the failed send; the connection cleanup that follows must NOT release
/// that attachment a second time (it would clear another viewer's live
/// attachment and let `list_preserved` replace the claim under their stream).
#[tokio::test]
async fn audit_f1_dead_socket_releases_once_and_never_another_viewers_attachment() {
    let state = gate_test_state(None);
    let (tx_a, rx_a) = mpsc::channel(256);
    let (tx_b, _rx_b) = mpsc::channel(256);
    let mut a = gate_test_ctx(true);
    let mut b = gate_test_ctx(true);
    let spawned = handle(
        gate_request("s", "spawn", json!({"projectId": "audit-f1-dead"})),
        &state,
        &tx_a,
        &mut a,
    )
    .await
    .expect("spawn");
    let id = spawned["id"].as_str().unwrap().to_string();
    let claim_a = spawned["claim"].as_str().unwrap().to_string();
    attach_terminal(&state, &tx_a, &mut a, &id, &claim_a).await;

    // Second viewer joins through list_preserved's shared claim.
    let listed = handle(
        gate_request(
            "lp",
            "list_preserved",
            json!({"projectId": "audit-f1-dead"}),
        ),
        &state,
        &tx_b,
        &mut b,
    )
    .await
    .expect("list");
    let claim_b = listed["terminals"][0]["claim"]
        .as_str()
        .unwrap()
        .to_string();
    attach_terminal(&state, &tx_b, &mut b, &id, &claim_b).await;
    assert_eq!(live_attachments(&state, &id), 2);

    // A's socket dies (receiver gone); PTY output makes A's forwarder fail
    // its send and self-release.
    drop(rx_a);
    handle(
        gate_request("w", "write", json!({"terminalId": id, "data": "echo hi\r"})),
        &state,
        &tx_b,
        &mut b,
    )
    .await
    .expect("write");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while live_attachments(&state, &id) != 1 {
        assert!(
            std::time::Instant::now() < deadline,
            "A's forwarder never self-released (count={})",
            live_attachments(&state, &id)
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }

    // Connection A's cleanup runs afterwards: B's attachment must survive.
    a.release_all(&state);
    assert_eq!(
        live_attachments(&state, &id),
        1,
        "cleanup double-released A's attachment and cleared B's"
    );
    b.release_all(&state);
    assert_eq!(live_attachments(&state, &id), 0);
    let _ = state.pty.force_kill(&id).await;
}

// ---------------------------------------------------------------------------
// Capabilities (view-only matrix) + presence
// ---------------------------------------------------------------------------

fn handshake_payload(device: &str) -> Value {
    json!({
        "protocolVersion": crate::web::ws::WS_PROTOCOL_VERSION,
        "deviceId": device,
        "clientInstanceId": "tab-1",
    })
}

#[tokio::test]
async fn authenticate_resolves_capabilities_from_the_peer_and_registers_presence() {
    let state = gate_test_state(None);
    let (tx, _rx) = mpsc::channel(8);
    let cases = [
        ([127, 0, 0, 1], false, false, true),
        ([192, 168, 1, 50], false, false, false),
        ([192, 168, 1, 50], true, false, true),
        ([127, 0, 0, 1], false, true, false),
    ];
    for (peer, allow, denied, may_write) in cases {
        let mut ctx = gate_test_ctx(false);
        ctx.capability_policy = capability_policy(peer, allow, denied);
        assert!(
            !ctx.capabilities.write,
            "nothing granted before authenticate"
        );
        assert!(state.relay.presence().device("phone").is_none());
        handle(
            gate_request("a", "authenticate", handshake_payload("phone")),
            &state,
            &tx,
            &mut ctx,
        )
        .await
        .expect("authenticate");
        assert_eq!(
            ctx.capabilities.write, may_write,
            "peer={peer:?} allow={allow} denied={denied}"
        );
        assert_eq!(ctx.capabilities.carrier, Carrier::TerminalWs);
        let presence = state.relay.presence().device("phone").expect("registered");
        assert_eq!(presence.connections, 1);
        assert!(presence.carriers.contains("terminal_ws"));
        // Connection teardown (context drop) unregisters the device.
        drop(ctx);
        assert!(state.relay.presence().device("phone").is_none());
    }
}

#[tokio::test]
async fn view_only_terminal_connection_is_refused_every_mutation() {
    let state = gate_test_state(None);
    let (tx, _rx) = mpsc::channel(8);
    let mut ctx = gate_test_ctx(true);
    ctx.capabilities = Capabilities::none(Carrier::TerminalWs);
    ctx.authorize("t1");
    for mutation in [
        "spawn",
        "write",
        "resize",
        "kill",
        "rotate_claim",
        "revoke_claim",
        // Re-issues (replaces) the claim of every unattached terminal.
        "list_preserved",
    ] {
        let refused = handle(
            gate_request(
                "m",
                mutation,
                json!({ "terminalId": "t1", "projectId": "p" }),
            ),
            &state,
            &tx,
            &mut ctx,
        )
        .await
        .expect_err(mutation);
        assert_eq!(refused.0, "FORBIDDEN", "{mutation}");
        assert_eq!(
            refused.0.to_ascii_lowercase(),
            crate::web::ws::WsErrorCode::Forbidden.as_str()
        );
    }
    // `attach` passes the capability gate: a bad claim is the generic
    // UNAUTHORIZED, never FORBIDDEN.
    let attach = handle(
        gate_request(
            "att",
            "attach",
            json!({ "terminalId": "t1", "claim": "not-a-valid-claim" }),
        ),
        &state,
        &tx,
        &mut ctx,
    )
    .await;
    assert!(
        matches!(&attach, Err((code, _)) if *code == "UNAUTHORIZED"),
        "attach must reach claim verification: {attach:?}"
    );
    // Reads and detach bookkeeping stay available.
    for view in [
        "get_cwd",
        "get_git_branch",
        "get_git_status",
        "get_exit_code",
        "detach",
    ] {
        let outcome = handle(
            gate_request("v", view, json!({ "terminalId": "t1", "projectId": "p" })),
            &state,
            &tx,
            &mut ctx,
        )
        .await;
        assert!(
            !matches!(&outcome, Err((code, _)) if *code == "FORBIDDEN"),
            "{view} must not be refused for a view-only connection"
        );
    }
}

#[tokio::test]
async fn write_capable_terminal_connection_passes_the_capability_gate() {
    let state = gate_test_state(None);
    let (tx, _rx) = mpsc::channel(8);
    let mut ctx = gate_test_ctx(true);
    // `list_preserved` needs no terminal and no PTY: it must run.
    let outcome = handle(
        gate_request("o", "list_preserved", json!({ "projectId": "p" })),
        &state,
        &tx,
        &mut ctx,
    )
    .await;
    assert!(outcome.is_ok(), "{outcome:?}");
}

/// A PTY lives until it is killed or exits, so the requests that once drove
/// renderer-ref reaping are gone: an authed, write-capable connection gets the
/// unknown-request answer for each.
#[tokio::test]
async fn retired_reaper_requests_are_unknown() {
    let state = gate_test_state(None);
    let (tx, _rx) = mpsc::channel(8);
    let mut ctx = gate_test_ctx(true);
    ctx.authorize("t1");
    for retired in [
        "add_renderer_ref",
        "remove_renderer_ref",
        "set_protected",
        "update_orphan_detection",
    ] {
        let outcome = handle(
            gate_request(
                "r",
                retired,
                json!({ "terminalId": "t1", "rendererId": "r", "protected": false }),
            ),
            &state,
            &tx,
            &mut ctx,
        )
        .await;
        assert_eq!(
            outcome,
            Err(("NOT_IMPLEMENTED", "unknown terminal request".to_string())),
            "{retired}"
        );
    }
}

// ---------------------------------------------------------------------------
// Host stop (AD-19) on the terminal carrier
// ---------------------------------------------------------------------------

use crate::web::connection_runtime::{CLOSE_DRAIN_TIMEOUT, SOCKET_DRAIN_BOUND};
use crate::web::ws::harness::carrier::{pair, Peer};

/// Serve a fault-carrier socket through the production `serve_socket` under a
/// shutdown lease, as `terminal_ws_upgrade` does.
fn serve_carrier(state: &crate::web::ws::AppState) -> (Peer, tokio::task::JoinHandle<()>) {
    let (carrier, peer) = pair();
    let lease = state.connections.shutdown.admit();
    let task = tokio::spawn(serve_socket(
        lease,
        carrier,
        state.clone(),
        SocketAddr::from(([127, 0, 0, 1], 0)),
    ));
    (peer, task)
}

/// The next reply frame for request `id`, skipping lifecycle events.
async fn terminal_reply(peer: &mut Peer, id: &str) -> Value {
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(10), peer.next_frame())
            .await
            .expect("no frame in time")
            .expect("socket closed before the reply");
        if let Message::Text(text) = frame {
            let value: Value = serde_json::from_str(&text).expect("json frame");
            if value["id"] == id {
                return value;
            }
        }
    }
}

async fn authenticate_carrier(peer: &mut Peer) {
    peer.send_json(&json!({
        "id": "auth",
        "type": "authenticate",
        "payload": handshake_payload("device-stop"),
    }));
    let reply = terminal_reply(peer, "auth").await;
    assert_eq!(reply["success"], true, "{reply}");
}

/// Stopping the host closes an open terminal socket with `Close(1001)`, ends
/// its task, and releases the live attachment exactly once (CAP-16): the
/// cleanup after the interrupted read loop runs once, so the terminal reports
/// no live viewer afterwards.
#[tokio::test]
async fn host_stop_closes_the_terminal_socket_and_releases_its_attachment_once() {
    let state = gate_test_state(None);
    let (mut peer, task) = serve_carrier(&state);
    authenticate_carrier(&mut peer).await;
    peer.send_json(&json!({"id": "s", "type": "spawn", "payload": {"projectId": "stop-attach"}}));
    let spawned = terminal_reply(&mut peer, "s").await;
    let id = spawned["data"]["id"].as_str().unwrap().to_string();
    let claim = spawned["data"]["claim"].as_str().unwrap().to_string();
    peer.send_json(&json!({
        "id": "a",
        "type": "attach",
        "payload": {"terminalId": id, "claim": claim, "lastSeq": 0},
    }));
    let attached = terminal_reply(&mut peer, "a").await;
    assert_eq!(attached["success"], true, "{attached}");
    assert_eq!(live_attachments(&state, &id), 1);

    state.connections.shutdown.begin();
    assert_eq!(
        state.connections.shutdown.drain(SOCKET_DRAIN_BOUND).await,
        0
    );
    let close = peer.wait_close().await.expect("close frame");
    assert_eq!(close, (1001, "host stopping".to_string()));
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("terminal socket task outlived the drain")
        .expect("terminal socket task did not panic");
    assert_eq!(
        live_attachments(&state, &id),
        0,
        "the attachment was not released (or was released into another viewer's count)"
    );
    let _ = state.pty.force_kill(&id).await;
}

/// A terminal peer that stopped reading cannot take the close: the socket
/// gives up after the close drain timeout and the drain completes, bounded.
#[tokio::test(start_paused = true)]
async fn host_stop_does_not_wait_forever_on_a_stalled_terminal_peer() {
    let state = gate_test_state(None);
    let (mut peer, task) = serve_carrier(&state);
    authenticate_carrier(&mut peer).await;
    peer.stall_writes();

    state.connections.shutdown.begin();
    let started = tokio::time::Instant::now();
    assert_eq!(
        state.connections.shutdown.drain(SOCKET_DRAIN_BOUND).await,
        0
    );
    assert_eq!(started.elapsed(), CLOSE_DRAIN_TIMEOUT);
    task.await.expect("terminal socket task did not panic");
    assert!(
        peer.close.is_none(),
        "a stalled peer cannot have received a close"
    );
}

/// An attach whose cursor belongs to another epoch replays the WHOLE retained
/// log with `reset: true` and the terminal's current `logEpoch`, instead of
/// skipping to the foreign cursor; the same cursor under the current epoch
/// resumes without a reset.
#[tokio::test]
async fn attach_with_a_foreign_log_epoch_replays_everything_with_reset() {
    let state = gate_test_state(None);
    let (tx, mut rx) = mpsc::channel(64);
    let mut owner = gate_test_ctx(true);
    let spawned = handle(
        gate_request("s", "spawn", json!({"projectId": "project-epoch"})),
        &state,
        &tx,
        &mut owner,
    )
    .await
    .expect("spawn");
    let id = spawned["id"].as_str().unwrap().to_string();
    let claim = spawned["claim"].as_str().unwrap().to_string();
    let instance = state.pty.get(&id).expect("instance");
    // Seed the retained log with chunks allocated like the flusher's.
    let mut last = 0;
    for byte in b"ab".iter().copied() {
        let mut log = instance.output_log.write();
        last = instance
            .next_output_seq
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            + 1;
        log.push_back(crate::pty::manager::TerminalOutputChunk {
            seq: last,
            data: vec![byte],
        });
    }
    let retained: Vec<u64> = instance.output_log.read().iter().map(|c| c.seq).collect();

    async fn replay_frame(rx: &mut mpsc::Receiver<Message>) -> Value {
        loop {
            let Message::Text(text) = rx.recv().await.expect("a frame") else {
                continue;
            };
            let frame: Value = serde_json::from_str(&text).unwrap();
            if frame["type"] == "replay" {
                return frame;
            }
        }
    }
    let chunk_seqs = |frame: &Value| -> Vec<u64> {
        frame["chunks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|chunk| chunk["seq"].as_u64().unwrap())
            .collect()
    };

    let reply = handle(
        gate_request(
            "at-foreign",
            "attach",
            json!({"terminalId": id, "claim": claim, "lastSeq": last, "logEpoch": "epoch-of-another-spawn"}),
        ),
        &state,
        &tx,
        &mut owner,
    )
    .await
    .expect("attach");
    let frame = replay_frame(&mut rx).await;
    assert_eq!(frame["reset"], true);
    assert_eq!(frame["logEpoch"], json!(instance.log_epoch));
    assert!(
        chunk_seqs(&frame).starts_with(&retained),
        "every retained chunk is replayed from the start: {:?} vs {retained:?}",
        chunk_seqs(&frame)
    );
    assert_eq!(reply["reset"], true);
    assert_eq!(reply["logEpoch"], json!(instance.log_epoch));

    // The same cursor under the current epoch resumes: no reset, nothing at or below it.
    let reply = handle(
        gate_request(
            "at-current",
            "attach",
            json!({"terminalId": id, "claim": claim, "lastSeq": last, "logEpoch": instance.log_epoch}),
        ),
        &state,
        &tx,
        &mut owner,
    )
    .await
    .expect("attach");
    let frame = replay_frame(&mut rx).await;
    assert_eq!(frame["reset"], false);
    assert!(chunk_seqs(&frame).iter().all(|seq| *seq > last));
    assert_eq!(reply["reset"], false);
}
