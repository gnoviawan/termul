use super::*;

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
        // Tests exercise post-gate behavior; the ungated posture starts
        // every connection authed.
        authed: true,
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
        "add_renderer_ref",
        "remove_renderer_ref",
        "set_protected",
        "update_orphan_detection",
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
fn gate_test_state(token: Option<&str>) -> crate::web::ws::AppState {
    let pty = crate::web::test_pty_manager();
    crate::web::ws::AppState {
        acp: Arc::new(crate::acp::AcpManager::new(vec![])),
        terminal_events: pty.terminal_events(),
        cwd_tracker: pty.cwd_tracker(),
        git_tracker: pty.git_tracker(),
        exit_code_tracker: pty.exit_code_tracker(),
        pty,
        relay: Arc::new(crate::web::sink::WsRelaySink::new()),
        registry: Arc::new(crate::web::project_registry::ProjectRegistry::new()),
        registry_persistence: None,
        projects_file: None,
        history_mode: crate::web::ws::HistoryMode::LiveOnly,
        project_root: Arc::new(parking_lot::RwLock::new(std::path::PathBuf::from("/tmp"))),
        pending_oauth_flows: Arc::new(parking_lot::RwLock::new(std::collections::HashMap::new())),
        oauth_base_url: "http://127.0.0.1".to_string(),
        workspace_manifest: None,
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
    }
}

fn gate_test_ctx(authed: bool) -> ConnectionContext {
    ConnectionContext {
        authorized: Arc::new(RwLock::new(HashSet::new())),
        attachments: HashMap::new(),
        authed,
    }
}

fn gate_request(id: &str, type_: &str, payload: Value) -> Request {
    Request {
        id: id.to_string(),
        type_: type_.to_string(),
        payload,
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
        gate_request("r2", "authenticate", json!({"token": "WRONG"})),
        &state,
        &tx,
        &mut ctx,
    )
    .await;
    assert_eq!(wrong, Err(("UNAUTHORIZED", "Unauthorized".to_string())));
    assert!(!ctx.authed, "wrong token must not authenticate");

    let missing = handle(
        gate_request("r3", "authenticate", json!({})),
        &state,
        &tx,
        &mut ctx,
    )
    .await;
    assert_eq!(missing, Err(("UNAUTHORIZED", "Unauthorized".to_string())));
    assert!(!ctx.authed);

    let ok = handle(
        gate_request("r4", "authenticate", json!({"token": "s3cret"})),
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

#[tokio::test]
async fn ungated_handle_treats_authenticate_as_noop_success() {
    // New-client/old-server tolerance: an ungated server accepts
    // `authenticate` as a no-op success, so clients that always send it
    // keep working on pre-gate deployments.
    let state = gate_test_state(None);
    let (tx, _rx) = mpsc::channel(8);
    // run() initializes ungated connections authed: true.
    let mut ctx = gate_test_ctx(true);
    let reply = handle(
        gate_request("r1", "authenticate", json!({"token": "anything"})),
        &state,
        &tx,
        &mut ctx,
    )
    .await;
    assert_eq!(reply, Ok(json!({})));
    assert!(ctx.authed);
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
        // Tests exercise post-gate behavior; the ungated posture starts
        // every connection authed.
        authed: true,
    };
    ctx.authorize("t1");

    // A live attachment task mimicking the output forwarder.
    let task = tokio::spawn(async {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    });
    ctx.attachments.insert("t1".to_string(), task);

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

/// QA round 2, spec story 5: `update_orphan_detection` is accepted on an
/// AUTHED connection with ZERO attached terminals (the settings loader
/// pushes it at boot, pre-attach), while an un-authed connection gets the
/// single generic UNAUTHORIZED via the connection gate — identical for a
/// gated connection before `authenticate`.
#[tokio::test]
async fn update_orphan_detection_accepted_on_authed_connection_with_zero_terminals() {
    let state = gate_test_state(Some("s3cret"));
    let (tx, _rx) = mpsc::channel(8);

    // Authed connection, no authorized terminals at all.
    let mut authed = gate_test_ctx(true);
    assert!(authed.authorized.read().is_empty());
    let accepted = handle(
        gate_request(
            "od-1",
            "update_orphan_detection",
            json!({"enabled": true, "timeout": 15}),
        ),
        &state,
        &tx,
        &mut authed,
    )
    .await;
    assert_eq!(accepted, Ok(Value::Null));

    // Un-authed (gated, pre-authenticate) connection: the connection gate
    // refuses before the arm — the single generic UNAUTHORIZED, no state
    // change, and the connection stays un-authed.
    let mut unauthed = gate_test_ctx(false);
    let refused = handle(
        gate_request("od-2", "update_orphan_detection", json!({"enabled": false})),
        &state,
        &tx,
        &mut unauthed,
    )
    .await;
    assert_eq!(refused, Err(("UNAUTHORIZED", "Unauthorized".to_string())));
    assert!(!unauthed.authed);
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
        gate_request("auth", "authenticate", json!({"token": "s3cret"})),
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

/// CodeRabbit (story 5 reattach): a terminal with a LIVE attachment on
/// another connection is listed WITHOUT a claim — the owning connection
/// keeps its credential and output forwarder; only after the owner's
/// connection tears down does a later listing reissue.
#[tokio::test]
async fn list_preserved_skips_terminals_with_live_attachment() {
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

    // A second (reloaded) connection lists: the live terminal carries NO
    // claim field — its owner's credential is preserved.
    let mut reloader = gate_test_ctx(true);
    let listed = handle(
        gate_request("lp", "list_preserved", json!({"projectId": "project-live"})),
        &state,
        &tx,
        &mut reloader,
    )
    .await
    .expect("list succeeds");
    let terminals = listed["terminals"].as_array().unwrap();
    assert_eq!(terminals.len(), 1);
    assert!(
        terminals[0]["claim"].is_null(),
        "live attachment: no claim offered"
    );
    // The owner's claim still verifies — the listing did not invalidate it.
    assert_eq!(
        state.pty.verify_claim(&id, &owner_claim),
        Ok(()),
        "owner claim survives the second connection's listing"
    );

    // Owner detaches (rotate-style teardown drops the attachment). A
    // subsequent listing reissues — the terminal became attachable.
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
        &mut reloader,
    )
    .await
    .expect("second list succeeds");
    let terminals2 = listed2["terminals"].as_array().unwrap();
    assert_eq!(terminals2.len(), 1);
    assert!(
        terminals2[0]["claim"].as_str().is_some(),
        "after teardown the terminal is attachable again"
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
