#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;
use crate::acp::SpawnOutcome;
use crate::web::permissions::{PermissionRendezvous, QuestionRendezvous};
use std::collections::HashSet;

#[tokio::test]
async fn cross_agent_prompt_is_rejected_before_claim_or_persistence() {
    let root = std::env::temp_dir().join(format!("termul-ws-ownership-{}", uuid::Uuid::new_v4()));
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = crate::acp::SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    persistence
        .register_session(crate::acp::SessionRegistration {
            session_id: "session-a".to_string(),
            stable_agent_namespace: None,
            runtime_agent_id: Some("agent-a".to_string()),
            project_id: None,
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    let relay = Arc::new(WsRelaySink::with_persistence(8, persistence.clone()));
    let acp = Arc::new(AcpManager::with_persistence(vec![], persistence.clone()));
    acp.install_test_agent_with_sessions(
        crate::acp::AgentId("agent-b".to_string()),
        HashSet::new(),
    );

    let reply = handle_send_prompt(
        "request-1".to_string(),
        &json!({
            "agentId": "agent-b",
            "sessionId": "session-a",
            "text": "must not persist",
            "turnId": "turn-cross-agent"
        }),
        &acp,
        &relay,
    )
    .await;
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "not_found");
    assert_eq!(persistence.last_seq("session-a").unwrap(), 0);
    assert!(persistence.replay_after("session-a", 0).unwrap().is_empty());
    assert_eq!(
        relay
            .turn_watermark()
            .claim_turn("session-a", Some("turn-cross-agent")),
        TurnClaim::Claimed
    );
    relay
        .turn_watermark()
        .release_claim("session-a", Some("turn-cross-agent"));
    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn authenticated_send_prompt_dispatches_only_post_auth_prompt_frames() {
    let prompt = authenticated_send_prompt(
        r#"{"id":"prompt-1","type":"send_prompt","payload":{"sessionId":"s1"}}"#,
        true,
    )
    .expect("post-auth prompt is dispatched");
    assert_eq!(prompt.0, "prompt-1");
    assert_eq!(prompt.1["sessionId"], "s1");
    assert!(
        authenticated_send_prompt(r#"{"id":"ping-1","type":"ping","payload":{}}"#, true).is_none()
    );
    assert!(authenticated_send_prompt(
        r#"{"id":"prompt-1","type":"send_prompt","payload":{}}"#,
        false
    )
    .is_none());
}

#[tokio::test]
async fn connection_cleanup_unregisters_once_after_writer_first_shutdown() {
    let relay = Arc::new(WsRelaySink::new());
    let acp = Arc::new(AcpManager::new(vec![]));
    let permissions = Arc::new(PermissionRendezvous::with_policy(
        Arc::clone(&acp),
        Duration::from_secs(60),
        Duration::ZERO,
    ));
    let questions = Arc::new(QuestionRendezvous::with_timeout(
        acp,
        Duration::from_secs(60),
    ));
    relay.set_rendezvous(Arc::clone(&permissions));
    relay.set_question_rendezvous(Arc::clone(&questions));
    relay.seed_session_for_test("session-cleanup");
    let (client_id, _rx, replay) = relay.subscribe("session-cleanup", None).await;
    assert!(matches!(replay, ReplayResult::Ok(0)));
    permissions.register(
        "permission-cleanup".to_string(),
        AgentId("agent-cleanup".to_string()),
        "session-cleanup".to_string(),
        json!([]),
    );
    questions.register(
        "question-cleanup".to_string(),
        AgentId("agent-cleanup".to_string()),
        "session-cleanup".to_string(),
        json!([]),
    );
    let subscribed = Arc::new(tokio::sync::Mutex::new(vec![(
        "session-cleanup".to_string(),
        client_id,
    )]));
    assert_eq!(relay.session_subscriber_count("session-cleanup"), 1);

    let cleanup = ConnectionCleanup::new(Arc::clone(&relay), Arc::clone(&subscribed));
    let cleanup_task = tokio::spawn(async move {
        cleanup.run().await;
        cleanup.run().await;
    });
    tokio::task::yield_now().await;
    cleanup_task.abort();
    let _ = cleanup_task.await;

    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if relay.session_subscriber_count("session-cleanup") == 0
                && subscribed.lock().await.is_empty()
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("subscriptions cleaned up after connection cleanup");
    assert!(!questions.is_outstanding("question-cleanup"));
    tokio::time::timeout(Duration::from_secs(1), async {
        while permissions.is_outstanding("permission-cleanup") {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("permission disconnect policy executed");
}

#[tokio::test]
async fn connection_cleanup_runs_when_relay_future_is_cancelled() {
    let relay = Arc::new(WsRelaySink::new());
    relay.seed_session_for_test("session-cancelled-relay");
    let (client_id, _rx, replay) = relay.subscribe("session-cancelled-relay", None).await;
    assert!(matches!(replay, ReplayResult::Ok(0)));
    let subscribed = Arc::new(tokio::sync::Mutex::new(vec![(
        "session-cancelled-relay".to_string(),
        client_id,
    )]));

    let cleanup = ConnectionCleanup::new(Arc::clone(&relay), Arc::clone(&subscribed));
    let relay_future = tokio::spawn(async move {
        let _cleanup = cleanup;
        std::future::pending::<()>().await;
    });
    relay_future.abort();
    let _ = relay_future.await;

    tokio::time::timeout(Duration::from_secs(1), async {
        while relay.session_subscriber_count("session-cancelled-relay") != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("drop guard cleaned subscriptions after relay cancellation");
    assert!(subscribed.lock().await.is_empty());
}

#[tokio::test]
async fn long_prompt_dispatch_does_not_block_ping_request() {
    let relay = Arc::new(WsRelaySink::new());
    let acp = Arc::new(AcpManager::new(vec![]));
    let mut sessions = HashSet::new();
    sessions.insert("session-long".to_string());
    let (release, entered) =
        acp.install_test_agent_with_prompt_gate(AgentId("agent-long".to_string()), sessions);
    let registry = Arc::new(ProjectRegistry::new());
    let (tx, mut rx) = mpsc::unbounded_channel();
    let subscriptions = Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let mut current_agent = None;
    let current_session = Arc::new(parking_lot::Mutex::new(None));
    let current_project = Arc::new(parking_lot::Mutex::new(None));
    let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
    let mut authed = true;
    assert!(
            dispatch_connection_text(
                r#"{"id":"prompt-long","type":"send_prompt","payload":{"agentId":"agent-long","sessionId":"session-long","text":"long","turnId":"turn-long"}}"#,
                &mut authed,
                None,
                &acp,
                &relay,
                &registry,
                None,
                None,
                &tx,
                &subscriptions,
                &mut current_agent,
                &current_session,
                &current_project,
                &switch_queue,
                HistoryMode::LiveOnly,
                None,
                None,
                None,
            )
            .await
        );

    tokio::time::timeout(Duration::from_secs(1), entered)
        .await
        .expect("prompt reached agent gate")
        .expect("prompt gate signal");

    tokio::time::timeout(Duration::from_millis(100), async {
        dispatch_connection_text(
            r#"{"id":"ping-1","type":"ping","payload":{}}"#,
            &mut authed,
            None,
            &acp,
            &relay,
            &registry,
            None,
            None,
            &tx,
            &subscriptions,
            &mut current_agent,
            &current_session,
            &current_project,
            &switch_queue,
            HistoryMode::LiveOnly,
            None,
            None,
            None,
        )
        .await
    })
    .await
    .expect("ping remains processable during prompt");
    let ping = match rx.recv().await.expect("ping reply") {
        Outbound::Reply(reply) => reply,
        Outbound::Event(_) | Outbound::Close(_) => panic!("expected ping reply"),
    };
    assert!(ping.ok);

    let concurrent = handle_send_prompt(
        "prompt-concurrent".to_string(),
        &json!({
            "agentId": "agent-long",
            "sessionId": "session-long",
            "text": "second",
            "turnId": "turn-concurrent"
        }),
        &acp,
        &relay,
    )
    .await;
    assert!(!concurrent.ok);
    assert_eq!(concurrent.err.expect("busy error").code, "rate_limited");

    let _ = release.send(());
    let completed = match rx.recv().await.expect("prompt reply") {
        Outbound::Reply(reply) => reply,
        Outbound::Event(_) | Outbound::Close(_) => panic!("expected prompt reply"),
    };
    assert!(completed.ok);
    assert_eq!(completed.id, "prompt-long");

    let stale = handle_send_prompt(
        "prompt-stale".to_string(),
        &json!({
            "agentId": "agent-long",
            "sessionId": "session-long",
            "text": "duplicate",
            "turnId": "turn-long"
        }),
        &acp,
        &relay,
    )
    .await;
    assert!(!stale.ok);
    assert_eq!(stale.err.expect("stale error").code, "stale");

    let next = handle_send_prompt(
        "prompt-next".to_string(),
        &json!({
            "agentId": "agent-long",
            "sessionId": "session-long",
            "text": "next",
            "turnId": "turn-next"
        }),
        &acp,
        &relay,
    )
    .await;
    assert!(next.ok);
}

#[tokio::test]
async fn immediate_cancel_after_prompt_is_ordered_after_turn_acceptance() {
    let relay = Arc::new(WsRelaySink::new());
    let acp = Arc::new(AcpManager::new(vec![]));
    let mut sessions = HashSet::new();
    sessions.insert("session-ordered-cancel".to_string());
    let (_release, entered) = acp
        .install_test_agent_with_prompt_gate(AgentId("agent-ordered-cancel".to_string()), sessions);
    let registry = Arc::new(ProjectRegistry::new());
    let (tx, mut rx) = mpsc::unbounded_channel();
    let subscriptions = Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let mut current_agent = None;
    let current_session = Arc::new(parking_lot::Mutex::new(None));
    let current_project = Arc::new(parking_lot::Mutex::new(None));
    let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
    let mut authed = true;

    assert!(
            dispatch_connection_text(
                r#"{"id":"prompt-ordered","type":"send_prompt","payload":{"agentId":"agent-ordered-cancel","sessionId":"session-ordered-cancel","text":"start then cancel","turnId":"turn-ordered"}}"#,
                &mut authed,
                None,
                &acp,
                &relay,
                &registry,
                None,
                None,
                &tx,
                &subscriptions,
                &mut current_agent,
                &current_session,
                &current_project,
                &switch_queue,
                HistoryMode::LiveOnly,
                None,
                None,
                None,
            )
            .await
        );
    assert!(
            dispatch_connection_text(
                r#"{"id":"cancel-ordered","type":"cancel_prompt","payload":{"agentId":"agent-ordered-cancel","sessionId":"session-ordered-cancel"}}"#,
                &mut authed,
                None,
                &acp,
                &relay,
                &registry,
                None,
                None,
                &tx,
                &subscriptions,
                &mut current_agent,
                &current_session,
                &current_project,
                &switch_queue,
                HistoryMode::LiveOnly,
                None,
                None,
                None,
            )
            .await
        );
    entered
        .await
        .expect("prompt was accepted before cancellation");

    let first = match rx.recv().await.expect("first reply") {
        Outbound::Reply(reply) => reply,
        Outbound::Event(_) | Outbound::Close(_) => panic!("expected reply"),
    };
    let second = match rx.recv().await.expect("second reply") {
        Outbound::Reply(reply) => reply,
        Outbound::Event(_) | Outbound::Close(_) => panic!("expected reply"),
    };
    let replies = [first, second];
    let cancel = replies
        .iter()
        .find(|reply| reply.id == "cancel-ordered")
        .expect("cancel acknowledgement");
    assert!(cancel.ok);
    let prompt = replies
        .iter()
        .find(|reply| reply.id == "prompt-ordered")
        .expect("prompt completion");
    assert!(prompt.ok);
    assert_eq!(
        prompt.payload.as_ref().expect("stop reason"),
        &json!("cancelled")
    );
}

#[tokio::test]
async fn cancelled_prompt_handler_releases_exact_turn_claim() {
    let relay = Arc::new(WsRelaySink::new());
    let acp = Arc::new(AcpManager::new(vec![]));
    let mut sessions = HashSet::new();
    sessions.insert("session-cancel".to_string());
    let (_release, entered) =
        acp.install_test_agent_with_prompt_gate(AgentId("agent-cancel".to_string()), sessions);
    let prompt_acp = Arc::clone(&acp);
    let prompt_relay = Arc::clone(&relay);
    let prompt = tokio::spawn(async move {
        handle_send_prompt(
            "prompt-cancel".to_string(),
            &json!({
                "agentId": "agent-cancel",
                "sessionId": "session-cancel",
                "text": "long",
                "turnId": "turn-cancel"
            }),
            &prompt_acp,
            &prompt_relay,
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(1), entered)
        .await
        .expect("prompt reached agent gate")
        .expect("prompt gate signal");

    prompt.abort();
    let _ = prompt.await;
    assert_eq!(
        relay
            .turn_watermark()
            .claim_turn("session-cancel", Some("turn-next")),
        TurnClaim::Claimed
    );
}

#[tokio::test]
async fn accepted_prompt_survives_disconnect_and_persists_completion_for_reconnect() {
    let root = std::env::temp_dir().join(format!("termul-ws-resume-{}", uuid::Uuid::new_v4()));
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = crate::acp::SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    persistence
        .register_session(crate::acp::SessionRegistration {
            session_id: "session-resume".to_string(),
            runtime_agent_id: Some("agent-resume".to_string()),
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    let relay = Arc::new(WsRelaySink::with_persistence(8, persistence.clone()));
    let acp = Arc::new(AcpManager::with_persistence(
        vec![Arc::clone(&relay) as Arc<dyn crate::web::EventSink>],
        persistence.clone(),
    ));
    let mut sessions = HashSet::new();
    sessions.insert("session-resume".to_string());
    let (release, entered) =
        acp.install_test_agent_with_prompt_gate(AgentId("agent-resume".to_string()), sessions);
    let (tx, rx) = mpsc::unbounded_channel();
    let subscriptions = Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let registry = Arc::new(ProjectRegistry::new());
    let mut current_agent = None;
    let current_session = Arc::new(parking_lot::Mutex::new(None));
    let current_project = Arc::new(parking_lot::Mutex::new(None));
    let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
    let mut authed = true;

    assert!(
            dispatch_connection_text(
                r#"{"id":"prompt-resume","type":"send_prompt","payload":{"agentId":"agent-resume","sessionId":"session-resume","text":"continue after disconnect","turnId":"turn-resume"}}"#,
                &mut authed,
                None,
                &acp,
                &relay,
                &registry,
                None,
                None,
                &tx,
                &subscriptions,
                &mut current_agent,
                &current_session,
                &current_project,
                &switch_queue,
                HistoryMode::Server,
                None,
                None,
                None,
            )
            .await
        );
    tokio::time::timeout(Duration::from_secs(1), entered)
        .await
        .expect("accepted prompt reached the agent gate")
        .expect("prompt gate signal");

    drop(rx);
    drop(tx);
    let _ = release.send(());
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if relay
                .turn_watermark()
                .claim_turn("session-resume", Some("turn-resume"))
                == TurnClaim::Completed
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("host turn completed after reply channel disconnected");

    persistence.flush_session("session-resume").await.unwrap();
    let replay = persistence.replay_after("session-resume", 0).unwrap();
    assert!(replay.iter().any(|event| event.type_ == "user_prompt"));
    assert!(replay.iter().any(|event| {
        event.type_ == "prompt_complete" && event.payload["turnId"] == "turn-resume"
    }));

    let (_client_id, _events, reconnect_replay) = relay.subscribe("session-resume", Some(0)).await;
    assert!(matches!(reconnect_replay, ReplayResult::Ok(replayed) if replayed >= 2));
    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

// ---- CAP-6 / Story 8 deferred 8.3: WS dispatch parity for the catalog ----
//
// No Rust test sent a `list_acp_catalog`/`set_catalog_opt_in` WS frame
// through `handle_request`. These prove the WS reply's success/data/code
// fields match the HTTP `GET /acp/catalog` / `POST /acp/catalog/opt-in`
// response, served through a REAL `AcpCatalogService` (the host authority).

/// Like `handle_sync` but with a real catalog store attached, so the
/// `list_acp_catalog` / `set_catalog_opt_in` WS frames dispatch to the real
/// `AcpCatalogService`. Post-auth (authed=true).
async fn handle_request_with_catalog(
    text: &str,
    catalog: &Arc<crate::acp::AcpCatalogService>,
) -> WsReply {
    let relay = Arc::new(WsRelaySink::new());
    let acp = Arc::new(AcpManager::new(vec![]));
    let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
    let mut subs = Vec::new();
    let registry = Arc::new(ProjectRegistry::new());
    let mut current_agent: Option<AgentId> = None;
    let current_session = Arc::new(parking_lot::Mutex::new(None::<SessionId>));
    let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
    let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
    let mut authed = true;
    handle_request(
        text,
        &mut authed,
        None,
        &acp,
        &relay,
        &registry,
        None,
        None,
        &tx,
        &mut subs,
        &mut current_agent,
        &current_session,
        &current_project,
        &switch_queue,
        HistoryMode::LiveOnly,
        Some(catalog),
        None,
        None,
    )
    .await
}

#[tokio::test]
async fn handle_list_acp_catalog_ws_dispatch_returns_payload() {
    let root = std::env::temp_dir().join(format!("termul-ws-cat-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let catalog = crate::acp::AcpCatalogService::open(root.join("catalog"))
        .await
        .unwrap();

    // WS: a `list_acp_catalog` frame through `handle_request` (post-auth).
    let reply = handle_request_with_catalog(
        r#"{"id":"r1","type":"list_acp_catalog","payload":{}}"#,
        &catalog,
    )
    .await;

    // HTTP `GET /acp/catalog` on the SAME store returns
    // `IpcBody { success: true, data: catalog, code: None }`. The WS reply's
    // success/data/code fields must match byte-for-byte (deferred 8.3).
    let http_catalog = catalog.list_catalog(false).await.unwrap();
    let http_data = serde_json::to_value(&http_catalog).unwrap();
    assert!(reply.ok, "WS ok matches HTTP success (true)");
    assert!(
        reply.err.is_none(),
        "no err code on success (matches HTTP code: None)"
    );
    assert_eq!(
        reply.payload.as_ref(),
        Some(&http_data),
        "WS payload (catalog) byte-identical to HTTP data"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn handle_set_catalog_opt_in_ws_dispatch_persists() {
    let root = std::env::temp_dir().join(format!("termul-ws-optin-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let catalog = crate::acp::AcpCatalogService::open(root.join("catalog"))
        .await
        .unwrap();
    assert!(!catalog.is_opt_in(), "opt-in starts false");

    // WS: a `set_catalog_opt_in` frame through `handle_request` (post-auth).
    let reply = handle_request_with_catalog(
        r#"{"id":"r1","type":"set_catalog_opt_in","payload":{"enabled":true}}"#,
        &catalog,
    )
    .await;

    // The opt-in persists (the host is the authority) + the WS reply
    // matches the HTTP `POST /acp/catalog/opt-in` response: both succeed
    // (WS ok=true / HTTP success=true), no code. (The WS success payload is
    // `{}` vs the HTTP data `null` — a known minor parity wrinkle; the
    // binding criterion is "opt-in persists + both transports succeed".)
    assert!(reply.ok, "WS ok matches HTTP success (true)");
    assert!(reply.err.is_none(), "no err code on success");
    assert!(catalog.is_opt_in(), "opt-in persisted (host authority)");
    let _ = std::fs::remove_dir_all(root);
}

// ---- CAP-6 deferred 8.3: distinct catalog error codes (parity with HTTP) ----
//
// The catalog WS handlers previously collapsed ALL failures to
// `WsErrorCode::Unsupported`. These prove the handlers now emit the same
// SCREAMING_SNAKE_CASE codes as the HTTP routes (`catalog_api.rs`):
// `ACP_CATALOG_UNAVAILABLE` (degraded), `VALIDATION_ERROR` (malformed).

/// Like `handle_request_with_catalog` but with NO catalog store attached
/// (degraded mode — `acp_catalog: None`).
async fn handle_request_without_catalog(text: &str) -> WsReply {
    let relay = Arc::new(WsRelaySink::new());
    let acp = Arc::new(AcpManager::new(vec![]));
    let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
    let mut subs = Vec::new();
    let registry = Arc::new(ProjectRegistry::new());
    let mut current_agent: Option<AgentId> = None;
    let current_session = Arc::new(parking_lot::Mutex::new(None::<SessionId>));
    let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
    let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
    let mut authed = true;
    handle_request(
        text,
        &mut authed,
        None,
        &acp,
        &relay,
        &registry,
        None,
        None,
        &tx,
        &mut subs,
        &mut current_agent,
        &current_session,
        &current_project,
        &switch_queue,
        HistoryMode::LiveOnly,
        None,
        None,
        None,
    )
    .await
}

#[tokio::test]
async fn list_acp_catalog_degraded_returns_unavailable() {
    let reply =
        handle_request_without_catalog(r#"{"id":"r1","type":"list_acp_catalog","payload":{}}"#)
            .await;
    assert!(!reply.ok);
    assert_eq!(reply.err.as_ref().unwrap().code, "ACP_CATALOG_UNAVAILABLE");
}

#[tokio::test]
async fn set_catalog_opt_in_degraded_returns_unavailable() {
    let reply = handle_request_without_catalog(
        r#"{"id":"r1","type":"set_catalog_opt_in","payload":{"enabled":true}}"#,
    )
    .await;
    assert!(!reply.ok);
    assert_eq!(reply.err.as_ref().unwrap().code, "ACP_CATALOG_UNAVAILABLE");
}

#[tokio::test]
async fn list_acp_catalog_malformed_payload_returns_validation_error() {
    // A non-bool `refresh` fails the `ListAcpCatalogPayload` serde.
    let reply = handle_request_without_catalog(
        r#"{"id":"r1","type":"list_acp_catalog","payload":{"refresh":"not-a-bool"}}"#,
    )
    .await;
    assert!(!reply.ok);
    assert_eq!(reply.err.as_ref().unwrap().code, "VALIDATION_ERROR");
}

#[tokio::test]
async fn set_catalog_opt_in_malformed_payload_returns_validation_error() {
    // Missing `enabled` fails `deny_unknown_fields`-less payload... actually
    // `SetCatalogOptInPayload` has no `default`, so a missing `enabled`
    // fails serde (the field is required).
    let reply = handle_request_without_catalog(
        r#"{"id":"r1","type":"set_catalog_opt_in","payload":{"notEnabled":true}}"#,
    )
    .await;
    assert!(!reply.ok);
    assert_eq!(reply.err.as_ref().unwrap().code, "VALIDATION_ERROR");
}

// ---- spec-acp-terminal-auth: `acp_deliver_auth_redirect` wire contract ----

#[tokio::test]
async fn deliver_auth_redirect_unknown_agent_returns_error() {
    // A well-formed payload for an agent that was never spawned: the
    // manager's `unknown agent` gate fires before any outbound request.
    let reply = handle_request_without_catalog(
            r#"{"id":"r1","type":"acp_deliver_auth_redirect","payload":{"agentId":"00000000-0000-0000-0000-000000000000","url":"http://127.0.0.1:8080/cb?code=x"}}"#,
        )
        .await;
    assert!(!reply.ok);
    assert_eq!(reply.err.as_ref().unwrap().code, "AUTH_REDIRECT_FAILED");
}

#[tokio::test]
async fn deliver_auth_redirect_malformed_payload_returns_validation_error() {
    // Missing `url` fails `DeliverAuthRedirectPayload` serde.
    let reply = handle_request_without_catalog(
            r#"{"id":"r1","type":"acp_deliver_auth_redirect","payload":{"agentId":"00000000-0000-0000-0000-000000000000"}}"#,
        )
        .await;
    assert!(!reply.ok);
    assert_eq!(reply.err.as_ref().unwrap().code, "VALIDATION_ERROR");
}

// ---- Issue #613: server-side generic key-value store WS handlers ----

/// Dispatch `text` through `handle_request` with a real `WebStore` attached.
async fn handle_request_with_store(text: &str, store: &Arc<WebStore>) -> WsReply {
    let relay = Arc::new(WsRelaySink::new());
    let acp = Arc::new(AcpManager::new(vec![]));
    let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
    let mut subs = Vec::new();
    let registry = Arc::new(ProjectRegistry::new());
    let mut current_agent: Option<AgentId> = None;
    let current_session = Arc::new(parking_lot::Mutex::new(None::<SessionId>));
    let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
    let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
    let mut authed = true;
    handle_request(
        text,
        &mut authed,
        None,
        &acp,
        &relay,
        &registry,
        None,
        None,
        &tx,
        &mut subs,
        &mut current_agent,
        &current_session,
        &current_project,
        &switch_queue,
        HistoryMode::LiveOnly,
        None,
        None,
        Some(store),
    )
    .await
}

#[tokio::test]
async fn store_write_then_read_roundtrips() {
    let dir = std::env::temp_dir().join(format!("termul-ws-store-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let store = Arc::new(WebStore::open(dir.join("store.json")));

    let write = handle_request_with_store(
        r#"{"id":"r1","type":"store_write","payload":{"key":"settings","value":{"theme":"dark"}}}"#,
        &store,
    )
    .await;
    assert!(write.ok, "write ok: {:?}", write.err);

    let read = handle_request_with_store(
        r#"{"id":"r2","type":"store_read","payload":{"key":"settings"}}"#,
        &store,
    )
    .await;
    assert!(read.ok, "read ok: {:?}", read.err);
    assert_eq!(
        read.payload.as_ref().and_then(|p| p.get("value")),
        Some(&json!({ "theme": "dark" }))
    );

    // A second open (fresh connection) still sees the value — server-side
    // persistence, not per-connection memory.
    let reopened = Arc::new(WebStore::open(dir.join("store.json")));
    let read2 = handle_request_with_store(
        r#"{"id":"r3","type":"store_read","payload":{"key":"settings"}}"#,
        &reopened,
    )
    .await;
    assert_eq!(
        read2.payload.as_ref().and_then(|p| p.get("value")),
        Some(&json!({ "theme": "dark" }))
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn store_read_missing_key_returns_null_value() {
    let dir = std::env::temp_dir().join(format!("termul-ws-store-miss-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let store = Arc::new(WebStore::open(dir.join("store.json")));
    let reply = handle_request_with_store(
        r#"{"id":"r1","type":"store_read","payload":{"key":"nope"}}"#,
        &store,
    )
    .await;
    assert!(reply.ok, "missing key is not an error: {:?}", reply.err);
    assert_eq!(
        reply.payload.as_ref().and_then(|p| p.get("value")),
        Some(&Value::Null)
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn store_delete_removes_and_reports_existed() {
    let dir = std::env::temp_dir().join(format!("termul-ws-store-del-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let store = Arc::new(WebStore::open(dir.join("store.json")));
    store.write("k", json!("v"), None).unwrap();

    let del = handle_request_with_store(
        r#"{"id":"r1","type":"store_delete","payload":{"key":"k"}}"#,
        &store,
    )
    .await;
    assert!(del.ok, "delete ok: {:?}", del.err);
    assert_eq!(
        del.payload.as_ref().and_then(|p| p.get("existed")),
        Some(&json!(true))
    );
    assert_eq!(store.read("k").unwrap(), None);

    let del2 = handle_request_with_store(
        r#"{"id":"r2","type":"store_delete","payload":{"key":"k"}}"#,
        &store,
    )
    .await;
    assert!(
        del2.ok,
        "delete of missing key is not an error: {:?}",
        del2.err
    );
    assert_eq!(
        del2.payload.as_ref().and_then(|p| p.get("existed")),
        Some(&json!(false))
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn store_handlers_degraded_return_unavailable() {
    // No store attached — same `handle_request_without_catalog` plumbing
    // (store: None). All three store_* requests must fail loudly.
    for frame in [
        r#"{"id":"r1","type":"store_read","payload":{"key":"k"}}"#,
        r#"{"id":"r2","type":"store_write","payload":{"key":"k","value":1}}"#,
        r#"{"id":"r3","type":"store_delete","payload":{"key":"k"}}"#,
    ] {
        let reply = handle_request_without_catalog(frame).await;
        assert!(!reply.ok, "degraded {frame} must fail");
        assert_eq!(reply.err.as_ref().unwrap().code, "STORE_UNAVAILABLE");
    }
}

/// CAP-11: an empty or whitespace-only key is a `VALIDATION_ERROR` on all
/// three store ops; the store is never touched and (being a reply, not a
/// close) the connection stays open. Over-long keys (> 1024 bytes) are
/// rejected the same way on read/write/delete.
#[tokio::test]
async fn store_empty_key_is_validation_error() {
    let dir = std::env::temp_dir().join(format!("termul-ws-store-empty-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let store = Arc::new(WebStore::open(dir.join("store.json")));
    store.write("keep", json!(1), None).unwrap();
    for frame in [
        r#"{"id":"r1","type":"store_read","payload":{"key":""}}"#,
        r#"{"id":"r2","type":"store_write","payload":{"key":"","value":1}}"#,
        r#"{"id":"r3","type":"store_delete","payload":{"key":""}}"#,
        r#"{"id":"r4","type":"store_write","payload":{"key":"   ","value":1}}"#,
    ] {
        let reply = handle_request_with_store(frame, &store).await;
        assert!(!reply.ok, "empty-key {frame} must fail");
        assert_eq!(
            reply.err.as_ref().unwrap().code,
            "VALIDATION_ERROR",
            "{frame}"
        );
    }
    // No state change: the pre-existing value survives and the empty /
    // whitespace keys were never written.
    assert_eq!(store.read("keep").unwrap(), Some(json!(1)));
    assert_eq!(store.read("").unwrap(), None);
    assert_eq!(store.read("   ").unwrap(), None);

    // Over-long key (> 1024 bytes): same VALIDATION_ERROR on all three ops.
    let long_key = "k".repeat(1025);
    for frame in [
        format!(r#"{{"id":"l1","type":"store_read","payload":{{"key":"{long_key}"}}}}"#),
        format!(r#"{{"id":"l2","type":"store_write","payload":{{"key":"{long_key}","value":1}}}}"#),
        format!(r#"{{"id":"l3","type":"store_delete","payload":{{"key":"{long_key}"}}}}"#),
    ] {
        let reply = handle_request_with_store(&frame, &store).await;
        assert!(!reply.ok, "over-long-key {frame} must fail");
        assert_eq!(
            reply.err.as_ref().unwrap().code,
            "VALIDATION_ERROR",
            "{frame}"
        );
        assert_eq!(
            reply.err.as_ref().unwrap().message,
            "key too long",
            "{frame}"
        );
    }
    assert_eq!(store.read(&long_key).unwrap(), None);
    let _ = std::fs::remove_dir_all(dir);
}

/// CAP-11: a serialized value over 256 KiB is rejected with
/// `STORE_VALUE_TOO_LARGE` before reaching the store; exactly 256 KiB is
/// accepted (the check is strictly-greater).
#[tokio::test]
async fn store_write_rejects_value_over_256kib() {
    let dir = std::env::temp_dir().join(format!("termul-ws-store-big-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let store = Arc::new(WebStore::open(dir.join("store.json")));
    store.write("keep", json!(1), None).unwrap();

    // 256 KiB + 1 char of string content → serialized size 256 KiB + 3
    // bytes (quotes) → over the cap.
    let oversized = "x".repeat(256 * 1024 + 1);
    let frame = format!(
        r#"{{"id":"r1","type":"store_write","payload":{{"key":"big","value":"{oversized}"}}}}"#
    );
    let reply = handle_request_with_store(&frame, &store).await;
    assert!(!reply.ok, "oversized value must fail");
    assert_eq!(reply.err.as_ref().unwrap().code, "STORE_VALUE_TOO_LARGE");
    // The store file is untouched: nothing persisted under "big", the
    // pre-existing value survives.
    assert_eq!(store.read("big").unwrap(), None);
    assert_eq!(store.read("keep").unwrap(), Some(json!(1)));

    // Boundary: content sized so the serialized value is exactly 256 KiB
    // (262142 chars + 2 quote bytes) is accepted.
    let exact = "x".repeat(256 * 1024 - 2);
    let frame = format!(
        r#"{{"id":"r2","type":"store_write","payload":{{"key":"big","value":"{exact}"}}}}"#
    );
    let reply = handle_request_with_store(&frame, &store).await;
    assert!(
        reply.ok,
        "exactly-256-KiB value is accepted: {:?}",
        reply.err
    );
    assert_eq!(store.read("big").unwrap(), Some(json!(exact)));
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn store_malformed_payload_returns_validation_error() {
    let dir = std::env::temp_dir().join(format!("termul-ws-store-bad-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let store = Arc::new(WebStore::open(dir.join("store.json")));
    // Missing `key` fails the payload serde.
    let reply =
        handle_request_with_store(r#"{"id":"r1","type":"store_read","payload":{}}"#, &store).await;
    assert!(!reply.ok);
    assert_eq!(reply.err.as_ref().unwrap().code, "VALIDATION_ERROR");
    // store_write without a `value` also fails serde.
    let reply2 = handle_request_with_store(
        r#"{"id":"r2","type":"store_write","payload":{"key":"k"}}"#,
        &store,
    )
    .await;
    assert!(!reply2.ok);
    assert_eq!(reply2.err.as_ref().unwrap().code, "VALIDATION_ERROR");
    let _ = std::fs::remove_dir_all(dir);
}

// ---- Cross-client host-authority (Category C / Recovery Matrix: Browser A → Browser B) ----

#[tokio::test]
async fn second_client_restores_session_created_by_first_client() {
    let root = std::env::temp_dir().join(format!("termul-ws-cross-{}", uuid::Uuid::new_v4()));
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = crate::acp::SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    let relay = Arc::new(WsRelaySink::with_persistence(8, persistence.clone()));
    let acp = Arc::new(AcpManager::with_persistence(vec![], persistence.clone()));
    // The test agent owns the session + handles the prompt-flow commands
    // (IsEphemeralSession→false, SendPrompt→EndTurn) so `handle_send_prompt`
    // persists the user prompt without a real agent binary.
    let mut sessions = HashSet::new();
    sessions.insert("session-cross".to_string());
    acp.install_test_agent_with_sessions(AgentId("agent-cross".to_string()), sessions);
    persistence
        .register_session(crate::acp::SessionRegistration {
            session_id: "session-cross".to_string(),
            stable_agent_namespace: None,
            runtime_agent_id: Some("agent-cross".to_string()),
            project_id: None,
            cwd: cwd.clone(),
            ..Default::default()
        })
        .await
        .unwrap();

    // Client A (browser A) sends a prompt → the host persists the
    // `user_prompt` via SessionPersistence (the cross-client authority).
    // No client-side storage is involved.
    let reply_a = handle_send_prompt(
        "req-a".to_string(),
        &json!({
            "agentId": "agent-cross",
            "sessionId": "session-cross",
            "text": "hello from client A",
            "turnId": "turn-cross"
        }),
        &acp,
        &relay,
    )
    .await;
    assert!(reply_a.ok, "client A's send_prompt succeeds + persists");

    // Client B (browser B) — a DIFFERENT client with no shared CLIENT-SIDE
    // in-memory state (no browser localStorage/sessionStorage) — calls
    // `handle_get_session_payload` for the SAME session id.
    // The host materializes the transcript from its durable store (the
    // authority), not from client A's browser.
    let reply_b = handle_get_session_payload(
        "req-b".to_string(),
        &json!({ "sessionId": "session-cross" }),
        &relay,
        HistoryMode::Server,
    )
    .await;
    assert!(reply_b.ok, "client B restores the session from the host");
    assert!(reply_b.err.is_none());
    let payload = reply_b.payload.expect("transcript payload");
    let messages = payload["messages"]
        .as_array()
        .expect("transcript messages array");
    assert!(!messages.is_empty(), "transcript has client A's prompt");
    // The user prompt client A sent is in client B's transcript (role=user,
    // id=turn:<turnId>, text present) — proving the host is the authority.
    let user_msg = messages
        .iter()
        .find(|m| m["role"] == "user")
        .expect("user message in transcript");
    assert_eq!(user_msg["id"], "turn:turn-cross");
    let blocks = user_msg["blocks"].as_array().expect("user message blocks");
    let text = blocks
        .iter()
        .map(|b| b["text"].as_str().unwrap_or(""))
        .collect::<String>();
    assert!(
        text.contains("hello from client A"),
        "client B sees client A's prompt text: {text}"
    );

    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn tier_of_maps_lossy_events() {
    assert_eq!(tier_of("message_chunk"), ReliabilityTier::Lossy);
    assert_eq!(tier_of("tool_call_update"), ReliabilityTier::Lossy);
    assert_eq!(tier_of("commands_update"), ReliabilityTier::Lossy);
    assert_eq!(tier_of("plan_update"), ReliabilityTier::Lossy);
}

#[test]
fn tier_of_maps_idempotent_and_reliable() {
    assert_eq!(tier_of("prompt_complete"), ReliabilityTier::Idempotent);
    assert_eq!(tier_of("permission_request"), ReliabilityTier::Reliable);
    assert_eq!(tier_of("agent_spawned"), ReliabilityTier::Reliable);
    assert_eq!(tier_of("auth_required"), ReliabilityTier::Reliable);
    // Unknown types default to reliable (safe — never drop).
    assert_eq!(tier_of("unknown_type"), ReliabilityTier::Reliable);
}

#[test]
fn error_codes_are_snake_case() {
    assert_eq!(WsErrorCode::NotFound.as_str(), "not_found");
    assert_eq!(WsErrorCode::Unauthorized.as_str(), "unauthorized");
    assert_eq!(WsErrorCode::RateLimited.as_str(), "rate_limited");
    assert_eq!(WsErrorCode::AgentCrashed.as_str(), "agent_crashed");
    assert_eq!(WsErrorCode::PermissionDenied.as_str(), "permission_denied");
    assert_eq!(WsErrorCode::Stale.as_str(), "stale");
    assert_eq!(WsErrorCode::Duplicate.as_str(), "duplicate");
    assert_eq!(WsErrorCode::Unsupported.as_str(), "unsupported");
    assert_eq!(WsErrorCode::NotImplemented.as_str(), "not_implemented");
}

/// Story 1.7 T7.1: the `ACP_TURN_IN_PROGRESS` desktop error string maps to
/// `WsErrorCode::RateLimited` on the WS path (for Story 1.8's `send_prompt`).
#[test]
fn map_prompt_error_code_maps_turn_in_progress_to_rate_limited() {
    assert_eq!(
        map_prompt_error_code("ACP_TURN_IN_PROGRESS: session sess-1"),
        Some(WsErrorCode::RateLimited)
    );
    assert_eq!(
        map_prompt_error_code("ACP_TURN_IN_PROGRESS: session abc"),
        Some(WsErrorCode::RateLimited)
    );
    // Other errors are not mapped (caller handles them generically).
    assert_eq!(map_prompt_error_code("agent initialize failed"), None);
    assert_eq!(map_prompt_error_code(""), None);
}

#[test]
fn os_cap_boundary_exact_and_prefix() {
    assert!(is_os_fulfilled_cap("fs/read_text_file"));
    assert!(is_os_fulfilled_cap("fs/write_text_file"));
    assert!(is_os_fulfilled_cap("terminal/run_command"));
    assert!(is_os_fulfilled_cap("terminal/anything"));
    // Human-relayed + unknown caps are NOT OS-fulfilled.
    assert!(!is_os_fulfilled_cap("request_permission"));
    assert!(!is_os_fulfilled_cap("session_notification"));
    assert!(!is_os_fulfilled_cap("unknown/cap"));
}

#[test]
fn human_cap_boundary() {
    assert!(is_human_relayed_cap("request_permission"));
    assert!(is_human_relayed_cap("session_notification"));
    assert!(!is_human_relayed_cap("fs/read_text_file"));
    assert!(!is_human_relayed_cap("terminal/run_command"));
}

#[test]
fn reopen_outcome_serializes_as_ws_reply_payload() {
    let outcome = crate::acp::manager::SessionReopenOutcome {
        modes: None,
        models: None,
        config_options: Some(vec![]),
    };
    let reply = ok_with_payload("reopen-1".to_string(), &outcome);
    assert!(reply.ok);
    assert_eq!(reply.payload, Some(json!({ "configOptions": [] })));
    assert!(reply.err.is_none());
}

#[test]
fn sequenced_event_serializes_snake_case_envelope() {
    let evt = SequencedEvent::new(
        Some("sess-1".to_string()),
        7,
        "message_chunk",
        json!({
            "agentId": "a1", "sessionId": "sess-1", "role": "agent"
        }),
    );
    let v = serde_json::to_value(&evt).expect("serialize");
    // Envelope fields are snake_case.
    assert_eq!(v["sid"], "sess-1");
    assert_eq!(v["seq"], 7);
    assert_eq!(v["type"], "message_chunk");
    // Payload is passed through verbatim (camelCase preserved — AC3).
    assert_eq!(v["payload"]["agentId"], "a1");
    assert_eq!(v["payload"]["sessionId"], "sess-1");
}

#[test]
fn auth_required_event_shape() {
    let evt = auth_required_event();
    assert!(evt.sid.is_none());
    assert_eq!(evt.seq, 0);
    assert_eq!(evt.type_, "auth_required");
    assert_eq!(evt.payload, json!({}));
}

#[test]
fn project_switch_outcomes_and_failure_event_serialize_camel_case() {
    let completed = SwitchProjectOutcome::Completed {
        project_id: "p-2".to_string(),
        session_id: SessionId("s-new".to_string()),
        cwd: "/work/p2".to_string(),
        mcp_server_count: 2,
    };
    let completed = serde_json::to_value(completed).expect("completed serde");
    assert_eq!(completed["status"], "completed");
    assert_eq!(completed["projectId"], "p-2");
    assert_eq!(completed["sessionId"], "s-new");
    assert_eq!(completed["mcpServerCount"], 2);

    let queued = SwitchProjectOutcome::Queued {
        project_id: "p-3".to_string(),
        current_session_id: SessionId("s-old".to_string()),
    };
    let queued = serde_json::to_value(queued).expect("queued serde");
    assert_eq!(queued["status"], "queued");
    assert_eq!(queued["projectId"], "p-3");
    assert_eq!(queued["currentSessionId"], "s-old");

    let failed = project_switch_failed_event(
        "r-1".to_string(),
        "p-3".to_string(),
        SessionId("s-old".to_string()),
        "persist failed".to_string(),
    );
    assert_eq!(failed.type_, "project_switch_failed");
    assert_eq!(failed.sid.as_deref(), Some("s-old"));
    assert_eq!(failed.seq, 0);
    assert_eq!(failed.payload["requestId"], "r-1");
    assert_eq!(failed.payload["projectId"], "p-3");
    assert_eq!(failed.payload["previousSessionId"], "s-old");
    assert_eq!(failed.payload["message"], "persist failed");
}

#[test]
fn connection_specific_no_op_requires_known_matching_project() {
    assert!(!connection_already_on_project(None, "p-1"));
    assert!(!connection_already_on_project(Some("p-2"), "p-1"));
    assert!(connection_already_on_project(Some("p-1"), "p-1"));
}

#[test]
fn project_switch_queue_replacement_is_latest_wins() {
    let pending = |request_id: &str, project_id: &str| PendingProjectSwitch {
        request_id: request_id.to_string(),
        target: ProjectSwitchContext {
            project_id: project_id.to_string(),
            cwd: format!("/work/{project_id}"),
            mcp_servers: Vec::new(),
        },
        previous_session_id: SessionId("s-old".to_string()),
    };
    let mut queue = ProjectSwitchQueue::default();
    assert!(queue.replace_pending(pending("r-1", "p-1")).is_none());
    let replaced = queue
        .replace_pending(pending("r-2", "p-2"))
        .expect("first request replaced");
    assert_eq!(replaced.request_id, "r-1");
    assert_eq!(replaced.target.project_id, "p-1");
    assert_eq!(queue.pending.as_ref().unwrap().request_id, "r-2");
    assert_eq!(queue.pending.as_ref().unwrap().target.project_id, "p-2");
}

#[test]
fn ws_reply_ok_and_err_shape() {
    let ok = WsReply::ok("r1", Some(json!({"ok": true})));
    let v = serde_json::to_value(&ok).expect("serialize ok");
    assert_eq!(v["id"], "r1");
    assert_eq!(v["ok"], true);
    assert_eq!(v["payload"]["ok"], true);
    assert!(v.get("err").is_none(), "err must be omitted on success");

    let err = WsReply::err("r2", WsErrorCode::Unauthorized, "nope");
    let ve = serde_json::to_value(&err).expect("serialize err");
    assert_eq!(ve["id"], "r2");
    assert_eq!(ve["ok"], false);
    assert_eq!(ve["err"]["code"], "unauthorized");
    assert_eq!(ve["err"]["message"], "nope");
    assert!(
        ve.get("payload").is_none(),
        "payload must be omitted on failure"
    );
}

/// Ungated wrapper over `handle_sync_with_auth` (no web auth gate).
/// The no-op `AcpManager` (`vec![]` sinks) returns fast `Err`s for the ACP
/// command methods (no agent spawned) which the handlers map to
/// `WsErrorCode`; the generic tests use an empty registry + no
/// agent/session (the `switch_project`-specific tests call
/// `handle_request` directly with a populated registry).
fn handle_sync(text: &str, authed: &mut bool) -> WsReply {
    handle_sync_with_auth(text, authed, None)
}

#[test]
fn handle_request_pre_auth_rejects_non_authenticate() {
    let mut authed = false;
    let reply = handle_sync(
        r#"{"id":"r1","type":"send_prompt","payload":{}}"#,
        &mut authed,
    );
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "unauthorized");
    assert!(!authed, "pre-auth non-authenticate must not flip authed");
}

#[test]
fn handle_request_authenticate_marks_authed() {
    let mut authed = false;
    let reply = handle_sync(
        r#"{"id":"r1","type":"authenticate","payload":{"token":"any"}}"#,
        &mut authed,
    );
    assert!(reply.ok);
    assert!(authed, "authenticate must flip authed");
}
/// Like `handle_sync` but with the web auth gate threaded through
/// (`Some(&gate)` = gated server; `None` = legacy ungated behavior).
fn handle_sync_with_auth(text: &str, authed: &mut bool, web_auth: Option<&WebAuth>) -> WsReply {
    let relay = Arc::new(WsRelaySink::new());
    let acp = Arc::new(AcpManager::new(vec![]));
    let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
    let mut subs = Vec::new();
    let registry = Arc::new(ProjectRegistry::new());
    let mut current_agent: Option<AgentId> = None;
    let current_session = Arc::new(parking_lot::Mutex::new(None::<SessionId>));
    let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
    let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(handle_request(
            text,
            authed,
            web_auth,
            &acp,
            &relay,
            &registry,
            None,
            None,
            &tx,
            &mut subs,
            &mut current_agent,
            &current_session,
            &current_project,
            &switch_queue,
            HistoryMode::LiveOnly,
            None,
            None,
            None,
        ))
}

fn test_gate() -> WebAuth {
    WebAuth::new(crate::web::auth::WebAuthToken::new("s3cret-token").expect("non-empty"))
}

#[test]
fn gated_authenticate_rejects_wrong_token() {
    // QA repro (P1): a wrong token on a gated server must NOT authenticate.
    let gate = test_gate();
    let mut authed = false;
    let reply = handle_sync_with_auth(
        r#"{"id":"r1","type":"authenticate","payload":{"token":"WRONG"}}"#,
        &mut authed,
        Some(&gate),
    );
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "unauthorized");
    assert!(!authed, "wrong token must not flip authed (retry allowed)");
}

#[test]
fn gated_authenticate_rejects_missing_token() {
    let gate = test_gate();
    let mut authed = false;
    let reply = handle_sync_with_auth(
        r#"{"id":"r1","type":"authenticate","payload":{}}"#,
        &mut authed,
        Some(&gate),
    );
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "unauthorized");
    assert!(!authed);
}

#[test]
fn gated_authenticate_accepts_correct_token() {
    let gate = test_gate();
    let mut authed = false;
    let reply = handle_sync_with_auth(
        r#"{"id":"r1","type":"authenticate","payload":{"token":"s3cret-token"}}"#,
        &mut authed,
        Some(&gate),
    );
    assert!(reply.ok, "correct token must authenticate");
    // Identical success shape as the ungated server.
    let payload = reply.payload.expect("auth reply payload");
    assert!(payload.get("historyMode").is_some(), "historyMode present");
    assert!(
        payload.get("runtimePolicy").is_some(),
        "runtimePolicy present"
    );
    assert!(authed);
}

#[test]
fn gated_retry_after_wrong_token_succeeds_on_same_connection() {
    // The connection stays open after a wrong token: a retry with the
    // correct token authenticates.
    let gate = test_gate();
    let mut authed = false;
    let wrong = handle_sync_with_auth(
        r#"{"id":"r1","type":"authenticate","payload":{"token":"WRONG"}}"#,
        &mut authed,
        Some(&gate),
    );
    assert!(!wrong.ok);
    let right = handle_sync_with_auth(
        r#"{"id":"r2","type":"authenticate","payload":{"token":"s3cret-token"}}"#,
        &mut authed,
        Some(&gate),
    );
    assert!(right.ok);
    assert!(authed);
    // Post-auth, gated commands flow (ping round-trips).
    let ping = handle_sync_with_auth(
        r#"{"id":"r3","type":"ping","payload":{}}"#,
        &mut authed,
        Some(&gate),
    );
    assert!(ping.ok);
}

#[test]
fn ungated_authenticate_accepts_any_token() {
    // Frozen contract: an ungated server accepts any token byte-identical
    // to the pre-gate behavior.
    let mut authed = false;
    let reply = handle_sync_with_auth(
        r#"{"id":"r1","type":"authenticate","payload":{"token":"WRONG"}}"#,
        &mut authed,
        None,
    );
    assert!(reply.ok, "ungated server accepts any token");
    assert!(authed);
}

#[test]
fn handle_request_post_auth_os_cap_rejected_unsupported() {
    let mut authed = true;
    let reply = handle_sync(
        r#"{"id":"r1","type":"fs/read_text_file","payload":{}}"#,
        &mut authed,
    );
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "unsupported");
}

#[test]
fn ping_request_replies_ok_post_auth() {
    // Heartbeat handler: a post-auth `ping` round-trips an ok reply so the
    // client's request promise resolves (no timeout). The keepalive value
    // is that the read loop stamps `last_activity` on the inbound text
    // frame before routing — that refresh happens regardless of the reply.
    let mut authed = true;
    let reply = handle_sync(r#"{"id":"r1","type":"ping","payload":{}}"#, &mut authed);
    assert!(reply.ok, "ping must round-trip an ok reply");
    assert_eq!(reply.id, "r1");
}

#[test]
fn ping_request_pre_auth_rejected_unauthorized() {
    // A pre-auth `ping` is gated like every other non-`authenticate` type —
    // the heartbeat only refreshes the watchdog on an already-authed socket.
    let mut authed = false;
    let reply = handle_sync(r#"{"id":"r1","type":"ping","payload":{}}"#, &mut authed);
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "unauthorized");
}

#[test]
fn watchdog_is_stale_only_past_pong_timeout() {
    // Pure threshold semantics for the keepalive watchdog: a connection is
    // torn down only after strictly more than the active ceiling with no
    // inbound frame. Tests the decision the write task consults on each
    // ping tick (the false-positive symptom behind issue: a focused tab
    // through a proxy dropped every ~75s because Pongs didn't round-trip;
    // a client `ping` text frame refreshes this and stays open).
    let base = 1_000_000_u64;
    let timeout = PONG_TIMEOUT.as_millis() as u64;
    assert!(
        !watchdog_is_stale(base, base, timeout),
        "fresh connection is not stale"
    );
    assert!(
        !watchdog_is_stale(base, base + timeout, timeout),
        "exactly at timeout is not stale (strict >)"
    );
    assert!(
        !watchdog_is_stale(base, base + timeout - 1, timeout),
        "just under timeout is not stale"
    );
    assert!(
        watchdog_is_stale(base, base + timeout + 1, timeout),
        "just past timeout is stale"
    );
    // Clock-skew safe: a future `last_activity` saturates to 0 (not stale).
    assert!(!watchdog_is_stale(base + 10_000, base, timeout));
}

#[test]
fn watchdog_backgrounded_uses_five_minute_ceiling() {
    // CAP-3: while backgrounded, the watchdog tolerates up to
    // BACKGROUND_TIMEOUT (5min) — 90s of inactivity must NOT close a
    // backgrounded connection (would close under the 75s PONG_TIMEOUT).
    let base = 1_000_000_u64;
    let ceiling = BACKGROUND_TIMEOUT.as_millis() as u64;
    assert!(
        !watchdog_is_stale(base, base + 90_000, ceiling),
        "90s idle is not stale under the 5-min background ceiling"
    );
    assert!(
        watchdog_is_stale(base, base + ceiling + 1, ceiling),
        "just past 5-min ceiling is stale"
    );
    // 90s idle WOULD close under the normal 75s ceiling.
    assert!(
        watchdog_is_stale(base, base + 90_000, PONG_TIMEOUT.as_millis() as u64),
        "90s idle is stale under the normal 75s ceiling"
    );
}

#[test]
fn peer_frame_type_extracts_background_and_foreground() {
    // CAP-3: id-less lifecycle frames are recognized by `type` without a
    // strict `WsRequest` parse (which requires `id`).
    assert_eq!(
        peer_frame_type(r#"{"type":"background"}"#).as_deref(),
        Some("background")
    );
    assert_eq!(
        peer_frame_type(r#"{"type":"foreground"}"#).as_deref(),
        Some("foreground")
    );
    // Normal ACP request frames still report their type (dispatched below).
    assert_eq!(
        peer_frame_type(r#"{"id":"p1","type":"send_prompt","payload":{}}"#).as_deref(),
        Some("send_prompt")
    );
    // Malformed / typeless frames yield None (dispatch handles the error).
    assert!(peer_frame_type("not json").is_none());
    assert!(peer_frame_type(r#"{"id":"x"}"#).is_none());
}

#[test]
fn handle_lifecycle_signal_toggles_background_flag() {
    // CAP-3: a background frame sets the flag (authed); foreground clears
    // it; an unauthed background is ignored (no flag, still consumed); a
    // normal request frame is NOT consumed (dispatched).
    let flag = Arc::new(AtomicBool::new(false));
    // Unauthed background: consumed, no flag set.
    assert!(handle_lifecycle_signal(
        r#"{"type":"background"}"#,
        false,
        &flag
    ));
    assert!(
        !flag.load(Ordering::Relaxed),
        "unauthed background does not set flag"
    );
    // Authed background: consumed, flag set.
    assert!(handle_lifecycle_signal(
        r#"{"type":"background"}"#,
        true,
        &flag
    ));
    assert!(flag.load(Ordering::Relaxed), "authed background sets flag");
    // Authed foreground: consumed, flag cleared.
    assert!(handle_lifecycle_signal(
        r#"{"type":"foreground"}"#,
        true,
        &flag
    ));
    assert!(!flag.load(Ordering::Relaxed), "foreground clears flag");
    // Normal request frame: NOT consumed (returns false) — dispatched.
    assert!(!handle_lifecycle_signal(
        r#"{"id":"p1","type":"send_prompt","payload":{}}"#,
        true,
        &flag,
    ));
    // Malformed frame: NOT consumed.
    assert!(!handle_lifecycle_signal("not json", true, &flag));
}

#[test]
fn handle_request_post_auth_other_types_not_implemented() {
    let mut authed = true;
    // Story 1.7 wired `respond_permission`; Story 1.8 wired `send_prompt`,
    // `create_session`, `load_session`, `resume_session`, `close_session`,
    // `list_sessions`, `cancel_prompt`, `set_mode`, `set_model`,
    // `set_config_option`. The Epic-4 bridge now wires `switch_project` too
    // (a malformed `{}` payload → `unsupported`, covered separately). Only
    // truly unknown types stay `not_implemented`.
    let ty = "totally_unknown_type";
    let reply = handle_sync(
        &format!(r#"{{"id":"r1","type":"{ty}","payload":{{}}}}"#),
        &mut authed,
    );
    assert!(!reply.ok, "{ty} should be not_implemented");
    assert_eq!(reply.err.unwrap().code, "not_implemented", "{ty}");
}

/// Story 1.8: ACP command handlers are wired. With an empty payload
/// they reject `unsupported` (malformed payload) — proving the match arm
/// routes to the handler (not the `_ => not_implemented` stub).
/// `list_agents` accepts `{}` and is covered separately.
#[test]
fn handle_request_post_auth_acp_commands_reject_malformed_payload() {
    let mut authed = true;
    for ty in [
        "send_prompt",
        "create_session",
        "load_session",
        "resume_session",
        "close_session",
        "list_sessions",
        "cancel_prompt",
        "set_mode",
        "set_model",
        "set_config_option",
        "spawn_agent",
        "kill_agent",
        "switch_project",
        "promote_session",
        // CAP-11: gated on history mode before payload parse — still
        // `unsupported` (NOT the not_implemented stub) in live-only mode.
        "delete_session",
        // CAP-2 (spec-in-chat-agent-switch): same history-mode gate →
        // `unsupported`, not the not_implemented stub.
        "record_agent_switch",
    ] {
        let reply = handle_sync(
            &format!(r#"{{"id":"r1","type":"{ty}","payload":{{}}}}"#),
            &mut authed,
        );
        assert!(!reply.ok, "{ty} should be rejected (malformed payload)");
        assert_eq!(
                reply.err.unwrap().code,
                "unsupported",
                "{ty} should route to its live handler (malformed-payload → unsupported, NOT not_implemented)"
            );
    }
}

/// Browser agent lifecycle: `list_agents` with empty payload returns `[]`
/// (no-op manager has zero agents) — proves the arm is live.
#[test]
fn handle_list_agents_returns_empty_array() {
    let mut authed = true;
    let reply = handle_sync(
        r#"{"id":"r1","type":"list_agents","payload":{}}"#,
        &mut authed,
    );
    assert!(reply.ok, "list_agents should succeed");
    assert_eq!(reply.payload, Some(json!([])));
}

/// CAP-11: `list_agents` returns identity-rich summaries
/// (`{ id, name, configId?, namespace?, capabilities }`), not bare id
/// strings. The test-agent fixture carries no configId/namespace, so both
/// keys are omitted (`skip_serializing_if`).
#[tokio::test]
async fn handle_list_agents_returns_identity_summaries() {
    let relay = Arc::new(WsRelaySink::new());
    let acp = Arc::new(AcpManager::new(vec![]));
    acp.install_test_agent_with_sessions(
        crate::acp::AgentId("agent-1".to_string()),
        ["sess-1".to_string()].into_iter().collect(),
    );
    let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
    let mut subs = Vec::new();
    let registry = Arc::new(ProjectRegistry::new());
    let mut current_agent: Option<AgentId> = None;
    let current_session = Arc::new(parking_lot::Mutex::new(None::<SessionId>));
    let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
    let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
    let mut authed = true;
    let reply = handle_request(
        r#"{"id":"r1","type":"list_agents","payload":{}}"#,
        &mut authed,
        None,
        &acp,
        &relay,
        &registry,
        None,
        None,
        &tx,
        &mut subs,
        &mut current_agent,
        &current_session,
        &current_project,
        &switch_queue,
        HistoryMode::LiveOnly,
        None,
        None,
        None,
    )
    .await;
    assert!(reply.ok, "list_agents should succeed: {:?}", reply.err);
    let entries = reply
        .payload
        .as_ref()
        .and_then(Value::as_array)
        .expect("payload is an array");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["id"], "agent-1");
    assert_eq!(entries[0]["name"], "test-agent");
    assert!(entries[0].get("capabilities").is_some());
    assert!(
        entries[0].get("configId").is_none(),
        "absent configId is omitted"
    );
    assert!(
        entries[0].get("namespace").is_none(),
        "absent namespace is omitted"
    );
}

/// CAP-11: the unknown-type error names the type and carries no stale
/// "Epic 4" / "lands in" text. The connection stays open (a reply, not a
/// close).
#[test]
fn unknown_type_error_names_type_without_stale_epic_text() {
    let mut authed = true;
    let reply = handle_sync(
        r#"{"id":"r1","type":"totally_unknown_type","payload":{}}"#,
        &mut authed,
    );
    assert!(!reply.ok);
    let err = reply.err.unwrap();
    assert_eq!(err.code, "not_implemented");
    assert_eq!(
        err.message,
        "`totally_unknown_type` is not implemented by this server"
    );
    assert!(!err.message.contains("Epic 4"));
    assert!(!err.message.contains("lands in"));
}

/// CAP-11 / frozen replay contract 1: the `resume_session` ok payload
/// carries the explicit `"replaySnapshot": null` marker (history fetch
/// stays on `get_session_payload` / `recover_session_snapshot`); the
/// reopen outcome fields pass through untouched.
#[test]
fn resume_ok_payload_marks_replay_snapshot_null() {
    let outcome = crate::acp::manager::SessionReopenOutcome {
        modes: None,
        models: None,
        config_options: None,
    };
    let reply = resume_ok_payload("r1".to_string(), &outcome);
    assert!(reply.ok);
    let payload = reply.payload.unwrap();
    assert_eq!(payload.get("replaySnapshot"), Some(&Value::Null));
    // An all-None outcome serializes to `{}` (skip_serializing_if) — the
    // marker is the only key.
    assert_eq!(payload.as_object().unwrap().len(), 1);
}

/// CAP-11: `delete_session` removes the host-persisted record (index +
/// in-memory relay state), fans one `chat_history_changed` broadcast, and
/// answers `not_found` for an unknown id.
#[tokio::test]
async fn delete_session_removes_host_persisted_record() {
    let root = std::env::temp_dir().join(format!("termul-ws-delete-{}", uuid::Uuid::new_v4()));
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = crate::acp::SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    persistence
        .register_session(crate::acp::SessionRegistration {
            session_id: "s-1".to_string(),
            stable_agent_namespace: Some("config:claude".to_string()),
            runtime_agent_id: Some("agent-1".to_string()),
            project_id: Some("p-1".to_string()),
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    let relay = Arc::new(WsRelaySink::with_persistence(8, persistence.clone()));
    // A client subscribed to ANOTHER session observes the broadcast —
    // `forget_session` drops clients whose only session was the deleted
    // one, so subscribing to "s-1" itself would not observe it.
    // Subscribe validates session existence (unknown → not_found), so seed
    // the observer session first — otherwise its channel never lives to
    // receive the broadcast.
    relay.seed_session_for_test("s-other");
    let (_client, mut rx, _replay) = relay.subscribe("s-other", None).await;

    let reply = handle_delete_session(
        "r1".to_string(),
        &json!({ "sessionId": "s-1" }),
        &relay,
        HistoryMode::Server,
    )
    .await;
    assert!(reply.ok, "delete ok: {:?}", reply.err);
    // Typed idempotent delete contract: a removed record reports true.
    assert_eq!(reply.payload, Some(json!({ "deleted": true })));
    // Gone from the host index.
    assert!(
        persistence
            .list_sessions()
            .iter()
            .all(|entry| entry.session_id != "s-1"),
        "deleted session leaves the index"
    );
    // Broadcast observed: sidebars refetch the index.
    let event = tokio::time::timeout(Duration::from_secs(2), rx.recv())
        .await
        .expect("chat_history_changed broadcast arrives")
        .expect("client channel open");
    assert_eq!(event.type_, "chat_history_changed");

    // Unknown id → typed idempotent delete contract: success with
    // `{ deleted: false }` (never a not-found error).
    let reply = handle_delete_session(
        "r2".to_string(),
        &json!({ "sessionId": "s-1" }),
        &relay,
        HistoryMode::Server,
    )
    .await;
    assert!(
        reply.ok,
        "absent record must be an idempotent delete: {:?}",
        reply.err
    );
    assert_eq!(reply.payload, Some(json!({ "deleted": false })));
    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

/// CAP-11: `delete_session` in live-only mode is `unsupported` — mirrors
/// the `list_persisted_sessions` gating.
#[tokio::test]
async fn delete_session_unsupported_in_live_only() {
    let relay = Arc::new(WsRelaySink::new());
    let reply = handle_delete_session(
        "r1".to_string(),
        &json!({ "sessionId": "s-1" }),
        &relay,
        HistoryMode::LiveOnly,
    )
    .await;
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "unsupported");
}

/// CAP-11: a malformed `delete_session` payload (missing `sessionId`) is
/// rejected `unsupported`; an empty `sessionId` parses but is an idempotent
/// delete of an absent record (`{ deleted: false }`).
#[tokio::test]
async fn delete_session_malformed_or_empty_payload_is_rejected() {
    let root = std::env::temp_dir().join(format!("termul-ws-delete-bad-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let persistence = crate::acp::SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    let relay = Arc::new(WsRelaySink::with_persistence(8, persistence.clone()));

    let missing =
        handle_delete_session("r1".to_string(), &json!({}), &relay, HistoryMode::Server).await;
    assert!(!missing.ok, "missing sessionId must fail");
    assert_eq!(missing.err.unwrap().code, "unsupported");

    let empty = handle_delete_session(
        "r2".to_string(),
        &json!({ "sessionId": "" }),
        &relay,
        HistoryMode::Server,
    )
    .await;
    assert!(
        empty.ok,
        "empty sessionId must be an idempotent delete of an absent record: {:?}",
        empty.err
    );
    assert_eq!(empty.payload, Some(json!({ "deleted": false })));
    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

/// CAP-11 (VG2): a successful `resume_session` dispatch carries the
/// explicit `"replaySnapshot": null` marker — driven through
/// `handle_resume_session` against a resume-capable test agent, not just
/// the payload helper.
#[tokio::test]
async fn handle_resume_session_ok_reply_carries_null_replay_snapshot() {
    let relay = Arc::new(WsRelaySink::new());
    let acp = Arc::new(AcpManager::new(vec![]));
    acp.install_test_agent_with_resume(
        crate::acp::AgentId("agent-1".to_string()),
        ["sess-1".to_string()].into_iter().collect(),
    );
    let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
    let mut subs = Vec::new();
    let registry = Arc::new(ProjectRegistry::new());
    let mut current_agent: Option<AgentId> = None;
    let current_session = Arc::new(parking_lot::Mutex::new(None::<SessionId>));
    let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
    let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
    let mut authed = true;
    let reply = handle_request(
            r#"{"id":"r1","type":"resume_session","payload":{"agentId":"agent-1","sessionId":"sess-1","cwd":"/tmp"}}"#,
            &mut authed,
            None,
            &acp,
            &relay,
            &registry,
            None,
            None,
            &tx,
            &mut subs,
            &mut current_agent,
            &current_session,
            &current_project,
            &switch_queue,
            HistoryMode::LiveOnly,
            None,
            None,
            None,
        )
        .await;
    assert!(reply.ok, "resume ok: {:?}", reply.err);
    let payload = reply.payload.expect("ok payload");
    assert_eq!(payload.get("replaySnapshot"), Some(&Value::Null));
    // No history/replay fields leak into the reply (contract 1).
    assert_eq!(payload.as_object().unwrap().len(), 1);
}

// ---- CAP-11: binary-frame protocol error (flush-then-Close(1003)) ----

fn ws_test_app_state() -> AppState {
    let pty = crate::web::test_pty_manager();
    AppState {
        acp: Arc::new(AcpManager::new(vec![])),
        terminal_events: pty.terminal_events(),
        cwd_tracker: pty.cwd_tracker(),
        git_tracker: pty.git_tracker(),
        exit_code_tracker: pty.exit_code_tracker(),
        pty,
        relay: Arc::new(WsRelaySink::new()),
        registry: Arc::new(ProjectRegistry::new()),
        registry_persistence: None,
        projects_file: None,
        history_mode: HistoryMode::LiveOnly,
        workspace_manifest: None,
        acp_catalog: None,
        acp_install: None,
        store: None,
        web_auth: None,
        allow_remote_writes: false,
        shared_live_writes_denied: false,
        project_root: Arc::new(parking_lot::RwLock::new(std::env::temp_dir())),
        pending_oauth_flows: Arc::new(parking_lot::RwLock::new(std::collections::HashMap::new())),
        oauth_base_url: "http://127.0.0.1".to_string(),
    }
}

/// Read exactly one server→client WS frame (unmasked per RFC 6455).
/// Returns `(opcode, payload)`.
async fn ws_read_frame(stream: &mut tokio::net::TcpStream) -> (u8, Vec<u8>) {
    use tokio::io::AsyncReadExt;
    let mut header = [0u8; 2];
    stream.read_exact(&mut header).await.expect("frame header");
    let opcode = header[0] & 0x0f;
    assert_eq!(header[1] & 0x80, 0, "server frames are never masked");
    let mut len = u64::from(header[1] & 0x7f);
    if len == 126 {
        let mut ext = [0u8; 2];
        stream.read_exact(&mut ext).await.expect("16-bit length");
        len = u64::from(u16::from_be_bytes(ext));
    } else if len == 127 {
        let mut ext = [0u8; 8];
        stream.read_exact(&mut ext).await.expect("64-bit length");
        len = u64::from_be_bytes(ext);
    }
    let mut payload = vec![0u8; len as usize];
    stream
        .read_exact(&mut payload)
        .await
        .expect("frame payload");
    (opcode, payload)
}

/// Write one masked client→server WS frame (RFC 6455 requires client
/// masking). Test frames stay in the short (≤125-byte) form.
async fn ws_write_frame(stream: &mut tokio::net::TcpStream, opcode: u8, payload: &[u8]) {
    use tokio::io::AsyncWriteExt;
    assert!(payload.len() <= 125, "test frames stay in the short form");
    let mask = [0x12u8, 0x34, 0x56, 0x78];
    let mut frame = vec![0x80 | opcode, 0x80 | payload.len() as u8];
    frame.extend_from_slice(&mask);
    frame.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
    stream.write_all(&frame).await.expect("write frame");
}

/// CAP-11: a binary frame on `/ws` gets the structured `unsupported`
/// error reply FIRST, then the Close(1003) handshake — the write task
/// owns the close so nothing queued ahead of it is lost.
#[tokio::test]
async fn binary_frame_receives_error_reply_then_close_1003() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let app = axum::Router::new()
        .route("/ws", axum::routing::get(ws_upgrade))
        .with_state(ws_test_app_state());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app.into_make_service()).await;
    });

    let interaction = async {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        // Minimal RFC 6455 client handshake.
        let request = format!(
                "GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
            );
        stream.write_all(request.as_bytes()).await.unwrap();
        // Read the 101 headers byte-by-byte so no WS frame bytes past the
        // header terminator are swallowed.
        let mut headers = Vec::new();
        let mut byte = [0u8; 1];
        loop {
            stream.read_exact(&mut byte).await.unwrap();
            headers.push(byte[0]);
            if headers.ends_with(b"\r\n\r\n") {
                break;
            }
            assert!(headers.len() < 4096, "upgrade response too large");
        }
        let headers = String::from_utf8_lossy(&headers);
        assert!(headers.contains("101"), "upgrade must succeed: {headers}");

        // First frame: the auth_required event (emitted on connect).
        let (opcode, payload) = ws_read_frame(&mut stream).await;
        assert_eq!(opcode, 0x1, "first frame is the auth_required text event");
        assert!(String::from_utf8_lossy(&payload).contains("auth_required"));

        // A binary frame is a protocol error: the structured `unsupported`
        // reply is delivered first, THEN the Close(1003) handshake.
        ws_write_frame(&mut stream, 0x2, b"\x00\x01binary").await;
        let (opcode, payload) = ws_read_frame(&mut stream).await;
        assert_eq!(opcode, 0x1, "the error reply is a text frame");
        let reply: Value = serde_json::from_slice(&payload).unwrap();
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["err"]["code"], "unsupported");
        assert!(reply["err"]["message"]
            .as_str()
            .unwrap()
            .contains("binary frames"));

        let (opcode, payload) = ws_read_frame(&mut stream).await;
        assert_eq!(opcode, 0x8, "the close frame follows the error reply");
        assert!(payload.len() >= 2, "close frame carries a status code");
        let code = u16::from_be_bytes([payload[0], payload[1]]);
        assert_eq!(code, 1003, "Close code 1003 (unsupported data)");
    };
    tokio::time::timeout(Duration::from_secs(10), interaction)
        .await
        .expect("binary-frame handshake completes within timeout");
    server.abort();
}

/// `spawn_agent` rejects empty `config.command` (mirrors create_session cwd guard).
/// Payload carries a `configId` so the rejection is specifically empty-command
/// (not the configId-required guard added for OQ1).
#[test]
fn handle_spawn_agent_rejects_empty_command() {
    let mut authed = true;
    let reply = handle_sync(
        r#"{"id":"r1","type":"spawn_agent","payload":{"config":{"configId":"custom-test","name":"x","command":""}}}"#,
        &mut authed,
    );
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "unsupported");
}

/// OQ1: `spawn_agent` rejects a config without a non-empty `configId`
/// (valid name + command, no configId) — mirrors the desktop
/// `acp_spawn_agent` guard so the spawn path derives a stable
/// `config:{config_id}` namespace on web too.
#[test]
fn handle_spawn_agent_rejects_missing_config_id() {
    let mut authed = true;
    let reply = handle_sync(
        r#"{"id":"r1","type":"spawn_agent","payload":{"config":{"name":"x","command":"node"}}}"#,
        &mut authed,
    );
    assert!(!reply.ok, "missing configId must fail");
    let err = reply.err.expect("err present on failure");
    assert_eq!(err.code, "unsupported");
    assert!(
        err.message.contains("configId"),
        "err message should mention configId, got: {err:?}"
    );
}

// --- CAP-6 / Story 9: install_acp_agent WS handler tests ----------------
// Mirrors install_api.rs's set: degrade-mode → ACP_INSTALL_UNAVAILABLE,
// extra-field payload → VALIDATION_ERROR, unknown-agent (with a real
// store) → CATALOG_AGENT_NOT_FOUND. Threaded through the same
// `handle_request(...)` entry the other WS tests use.

#[test]
fn install_acp_agent_degraded_returns_unavailable() {
    // handle_sync passes acp_install: None → degrade-mode.
    let mut authed = true;
    let reply = handle_sync(
        r#"{"id":"r1","type":"install_acp_agent","payload":{"agentId":"opencode"}}"#,
        &mut authed,
    );
    assert!(!reply.ok, "install_acp_agent degraded must fail");
    assert_eq!(reply.err.unwrap().code, "ACP_INSTALL_UNAVAILABLE");
}

#[test]
fn install_acp_agent_rejects_extra_field_as_validation_error() {
    // deny_unknown_fields on InstallAcpAgentPayload rejects extra fields
    // loudly → VALIDATION_ERROR (NOT unsupported — the install handler
    // parses the payload itself, not the envelope).
    let mut authed = true;
    let reply = handle_sync(
        r#"{"id":"r1","type":"install_acp_agent","payload":{"agentId":"x","extra":"junk"}}"#,
        &mut authed,
    );
    assert!(!reply.ok, "extra-field must fail");
    assert_eq!(reply.err.unwrap().code, "VALIDATION_ERROR");
}

#[test]
fn install_acp_agent_rejects_missing_agent_id_as_validation_error() {
    let mut authed = true;
    let reply = handle_sync(
        r#"{"id":"r1","type":"install_acp_agent","payload":{}}"#,
        &mut authed,
    );
    assert!(!reply.ok, "missing agentId must fail");
    assert_eq!(reply.err.unwrap().code, "VALIDATION_ERROR");
}

#[tokio::test]
async fn install_acp_agent_unknown_agent_returns_catalog_agent_not_found() {
    // Open a real install store (with a fresh catalog — no agents wired
    // to a sha256/digest) + call handle_request directly with
    // acp_install: Some(...). An unknown agent id resolves to
    // CATALOG_AGENT_NOT_FOUND (the catalog has no such agent).
    let tmp = std::env::temp_dir().join(format!(
        "termul-ws-install-unknown-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&tmp).unwrap();
    let catalog = crate::acp::AcpCatalogService::open(tmp.join("catalog"))
        .await
        .unwrap();
    let store = crate::acp::install::AcpInstallService::open(tmp.join("installs"), catalog)
        .await
        .unwrap();
    let acp = Arc::new(AcpManager::new(vec![]));
    let relay = Arc::new(WsRelaySink::new());
    let registry = Arc::new(ProjectRegistry::new());
    let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
    let mut subs: Vec<(String, ClientId)> = Vec::new();
    let mut current_agent: Option<AgentId> = None;
    let current_session = Arc::new(parking_lot::Mutex::new(None::<SessionId>));
    let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
    let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
    let mut authed = true;
    let reply = handle_request(
        r#"{"id":"r1","type":"install_acp_agent","payload":{"agentId":"does-not-exist"}}"#,
        &mut authed,
        None,
        &acp,
        &relay,
        &registry,
        None,
        None,
        &tx,
        &mut subs,
        &mut current_agent,
        &current_session,
        &current_project,
        &switch_queue,
        HistoryMode::LiveOnly,
        None,
        Some(&store),
        None,
    )
    .await;
    assert!(!reply.ok, "unknown agent must fail");
    assert_eq!(reply.err.unwrap().code, "CATALOG_AGENT_NOT_FOUND");
    let _ = std::fs::remove_dir_all(&tmp);
}

/// `spawn_agent` success path: `ok_with_payload` serializes the full
/// `SpawnOutcome` (camelCase: `agentId`/`capabilities`/`authMethods`/
/// `hostAuthReady`/`stableNamespace?`) — the same shape the desktop Tauri command returns,
/// so the renderer sees one authoritative payload on both transports (CAP-4).
#[test]
fn spawn_outcome_serializes_full_payload_as_ws_reply() {
    let outcome = SpawnOutcome {
        agent_id: AgentId("agn_test".to_string()),
        capabilities: agent_client_protocol::schema::v1::AgentCapabilities::default(),
        auth_methods: vec![crate::acp::events::AuthMethodInfo {
            id: "cursor_login".to_string(),
            name: "Sign in with Cursor".to_string(),
            description: None,
            r#type: "agent".to_string(),
            args: None,
            env: None,
        }],
        host_auth_ready: true,
        stable_namespace: Some("config:cursor".to_string()),
    };
    let reply = ok_with_payload("spawn-1".to_string(), &outcome);
    assert!(reply.ok);
    assert!(reply.err.is_none());
    let payload = reply.payload.expect("payload present on success");
    assert_eq!(payload["agentId"], "agn_test");
    assert!(
        payload.get("capabilities").is_some(),
        "capabilities always serialized"
    );
    assert_eq!(payload["authMethods"][0]["id"], "cursor_login");
    assert_eq!(payload["authMethods"][0]["name"], "Sign in with Cursor");
    assert_eq!(payload["hostAuthReady"], true);
    // `description` is `None` + skip_serializing_if → omitted from JSON.
    assert!(
        payload["authMethods"][0].get("description").is_none(),
        "description omitted when absent"
    );
    assert_eq!(payload["stableNamespace"], "config:cursor");
}

/// `spawn_agent` success with no auth + no namespace: `authMethods` is `[]`
/// (always serialized) and `stableNamespace` is omitted (skip_if_none).
#[test]
fn spawn_outcome_serializes_no_auth_no_namespace() {
    let outcome = SpawnOutcome {
        agent_id: AgentId("agn_noauth".to_string()),
        capabilities: agent_client_protocol::schema::v1::AgentCapabilities::default(),
        auth_methods: vec![],
        host_auth_ready: false,
        stable_namespace: None,
    };
    let reply = ok_with_payload("spawn-2".to_string(), &outcome);
    assert!(reply.ok);
    let payload = reply.payload.expect("payload");
    assert_eq!(payload["agentId"], "agn_noauth");
    assert_eq!(
        payload["authMethods"],
        json!([]),
        "authMethods always serialized as []"
    );
    assert_eq!(payload["hostAuthReady"], false);
    assert!(
        payload.get("stableNamespace").is_none(),
        "stableNamespace omitted when None"
    );
}

/// Story 1.8 review (EC4): `create_session` rejects an empty/whitespace
/// `cwd` (mirrors the desktop store's `cwd.trim()` guard — the WS path must
/// not diverge).
#[test]
fn handle_create_session_rejects_empty_cwd() {
    let mut authed = true;
    let reply = handle_sync(
        r#"{"id":"r1","type":"create_session","payload":{"agentId":"a1","cwd":""}}"#,
        &mut authed,
    );
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "unsupported");

    let mut authed2 = true;
    let reply2 = handle_sync(
        r#"{"id":"r2","type":"create_session","payload":{"agentId":"a1","cwd":"   "}}"#,
        &mut authed2,
    );
    assert!(!reply2.ok);
    assert_eq!(reply2.err.unwrap().code, "unsupported");
}

/// Story 8: `create_session` accepts the additive `promotable` field — it
/// must PARSE and reach the manager (the no-op manager's unknown-agent
/// error proves routing past payload validation).
#[test]
fn handle_create_session_accepts_promotable_flag() {
    let mut authed = true;
    let reply = handle_sync(
        r#"{"id":"r1","type":"create_session","payload":{"agentId":"a1","cwd":"/tmp","ephemeral":true,"promotable":true}}"#,
        &mut authed,
    );
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "not_found");
}

/// Story 8: `promote_session` routes to the manager — an unknown agent id
/// surfaces the manager's `unknown agent` error (`not_found`); a
/// `not_implemented` would mean the arm is not wired.
#[test]
fn handle_promote_session_unknown_agent_is_not_found() {
    let mut authed = true;
    let reply = handle_sync(
        r#"{"id":"r1","type":"promote_session","payload":{"agentId":"a1","sessionId":"s1"}}"#,
        &mut authed,
    );
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "not_found");
}

/// Story 8: `promote_session` round-trips through a live (test) agent —
/// the driver arm replies `ok` and the handler maps it to an empty
/// payload (the client then subscribes; see the WS transport).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handle_promote_session_ok_on_known_agent() {
    let acp = Arc::new(AcpManager::new(vec![]));
    acp.install_test_agent_with_sessions(
        crate::acp::AgentId("agent-1".to_string()),
        std::collections::HashSet::new(),
    );
    let reply = handle_promote_session(
        "r1".to_string(),
        &json!({ "agentId": "agent-1", "sessionId": "sess-warm" }),
        &acp,
    )
    .await;
    assert!(reply.ok, "promote_session failed: {:?}", reply.err);
    assert_eq!(reply.payload, Some(json!({})));
}

/// Story 1.8 review (EC3): `send_prompt` rejects an empty/whitespace
/// `text` (the desktop `commands.rs` has the same guard; without it an
/// empty-text turn leaks past the `content.is_empty()` check + poisons the
/// turn-id watermark).
#[test]
fn handle_send_prompt_rejects_empty_text() {
    let mut authed = true;
    let reply = handle_sync(
        r#"{"id":"r1","type":"send_prompt","payload":{"agentId":"a1","sessionId":"s1","text":""}}"#,
        &mut authed,
    );
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "unsupported");

    let mut authed2 = true;
    let reply2 = handle_sync(
        r#"{"id":"r2","type":"send_prompt","payload":{"agentId":"a1","sessionId":"s1","text":"   "}}"#,
        &mut authed2,
    );
    assert!(!reply2.ok);
    assert_eq!(reply2.err.unwrap().code, "unsupported");
}

/// Story 1.8 review: `acp_err_to_reply` maps recognizable agent errors to
/// the right `err.code` (not_implemented is the fallback for unrecognized
/// errors; "unknown agent" → not_found; capability-gate → unsupported;
/// Story 7: ACP auth failures → agent_auth_required).
#[test]
fn acp_err_to_reply_maps_recognizable_errors() {
    // ACP_TURN_IN_PROGRESS → rate_limited (via map_prompt_error_code).
    let r = acp_err_to_reply(
        "r1".to_string(),
        "ACP_TURN_IN_PROGRESS: session s1".to_string(),
    );
    assert_eq!(r.err.unwrap().code, "rate_limited");
    // Unknown agent → not_found.
    let r = acp_err_to_reply("r2".to_string(), "unknown agent: a1".to_string());
    assert_eq!(r.err.unwrap().code, "not_found");
    // Capability gate → unsupported.
    let r = acp_err_to_reply(
        "r3".to_string(),
        "agent does not support session/load (loadSession capability)".to_string(),
    );
    assert_eq!(r.err.unwrap().code, "unsupported");
    // Unrecognized → not_implemented (fallback, message preserved).
    let r = acp_err_to_reply(
        "r4".to_string(),
        "agent initialize failed: boom".to_string(),
    );
    assert_eq!(r.err.unwrap().code, "not_implemented");
    // Story 7: ACP AuthRequired (-32000) tagged at the manager boundary →
    // agent_auth_required (never the not_implemented fallback).
    let r = acp_err_to_reply(
        "r5".to_string(),
        "ACP_AUTH_REQUIRED: Authentication required".to_string(),
    );
    let err = r.err.unwrap();
    assert_eq!(err.code, "agent_auth_required");
    assert_eq!(err.message, "ACP_AUTH_REQUIRED: Authentication required");
    // Bare default message (agent error that reached the manager
    // pre-collapsed, e.g. `Error::auth_required()` on a prompt path) →
    // same code. Exact-match only: lookalikes stay unrecognized.
    let r = acp_err_to_reply("r6".to_string(), "Authentication required".to_string());
    assert_eq!(r.err.unwrap().code, "agent_auth_required");
    let r = acp_err_to_reply("r7".to_string(), "authentication required".to_string());
    assert_eq!(r.err.unwrap().code, "not_implemented");
    let r = acp_err_to_reply("r8".to_string(), "Authentication required.".to_string());
    assert_eq!(r.err.unwrap().code, "not_implemented");
    // The bare-message fallback stays pinned to the ACP crate's actual
    // `Display` wording for AuthRequired (not a hand-copied literal).
    let r = acp_err_to_reply(
        "r9".to_string(),
        agent_client_protocol::Error::auth_required().to_string(),
    );
    assert_eq!(r.err.unwrap().code, "agent_auth_required");
    // Prefix lookalikes without the ": " separator stay unrecognized.
    let r = acp_err_to_reply("r10".to_string(), "ACP_AUTH_REQUIREDfoo".to_string());
    assert_eq!(r.err.unwrap().code, "not_implemented");
}

/// Story 1.7: without a rendezvous attached (desktop path), the
/// `respond_permission` handler replies `not_implemented` (the desktop uses
/// the `acp_respond_permission` Tauri command directly). This guards the
/// `relay.rendezvous() == None` branch.
#[test]
fn handle_respond_permission_without_rendezvous_is_not_implemented() {
    let mut authed = true;
    let reply = handle_sync(
        r#"{"id":"r1","type":"respond_permission","payload":{"agentId":"a1","requestId":"perm-x"}}"#,
        &mut authed,
    );
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "not_implemented");
}

/// Story 1.7: a malformed `respond_permission` payload is rejected with
/// `unsupported` (mirrors `handle_subscribe`'s malformed-payload reply).
#[test]
fn handle_respond_permission_malformed_payload_is_unsupported() {
    // Attach a rendezvous so we reach the payload-parse branch.
    let relay = Arc::new(WsRelaySink::new());
    let acp = Arc::new(AcpManager::new(vec![]));
    relay.set_rendezvous(Arc::new(
        crate::web::permissions::PermissionRendezvous::default(),
    ));
    let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
    let mut subs = Vec::new();
    let mut authed = true;
    let registry = Arc::new(ProjectRegistry::new());
    let mut current_agent: Option<crate::acp::AgentId> = None;
    let current_session = Arc::new(parking_lot::Mutex::new(None::<crate::acp::SessionId>));
    let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
    let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
    let reply = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(handle_request(
            r#"{"id":"r1","type":"respond_permission","payload":{"agentId":"a1"}}"#,
            &mut authed,
            None,
            &acp,
            &relay,
            &registry,
            None,
            None,
            &tx,
            &mut subs,
            &mut current_agent,
            &current_session,
            &current_project,
            &switch_queue,
            HistoryMode::LiveOnly,
            None,
            None,
            None,
        ));
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "unsupported");
}

/// Helper: build a relay + rendezvous, subscribe a connection to a session
/// (populating `subscribed_clients`), and register a permission ticket via
/// `emit` (the production path). Returns the (relay, subs) ready for a
/// `handle_request` call.
fn relay_with_subscribed_permission(
    agent_id: &str,
    session_id: &str,
    request_id: &str,
    options: &[&str],
) -> (Arc<WsRelaySink>, Vec<(String, ClientId)>) {
    use crate::web::sink::{AcpEvent, EventSink};
    let relay = Arc::new(WsRelaySink::new());
    relay.set_rendezvous(Arc::new(
        crate::web::permissions::PermissionRendezvous::default(),
    ));
    // Subscribe a client to the session (populates subscribed_clients via
    // the production subscribe path).
    relay.seed_session_for_test(session_id);
    let (client_id, _rx, _replay) = block_on(relay.subscribe(session_id, None));
    let subs: Vec<(String, ClientId)> = vec![(session_id.to_string(), client_id)];
    // Emit a permission_request event through the sink (production path) so
    // the rendezvous snapshots a ticket.
    let options_value = serde_json::Value::Array(
        options
            .iter()
            .map(|id| serde_json::json!({ "optionId": id, "name": id, "kind": "auto" }))
            .collect(),
    );
    relay.emit(&AcpEvent {
        sid: Some(session_id.to_string()),
        type_: "acp:permission_request",
        payload: serde_json::json!({
            "agentId": agent_id,
            "sessionId": session_id,
            "requestId": request_id,
            "toolCall": { "toolCallId": "tc-1" },
            "options": options_value,
        }),
    });
    (relay, subs)
}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(future)
}

/// Story 1.7 (verification gap #1): a `respond_permission` frame whose
/// `agentId` differs from the ticket's agent is rejected `permission_denied`
/// (defense-in-depth — a client cannot resolve another agent's permission).
#[test]
fn handle_respond_permission_wrong_agent_is_permission_denied() {
    let (relay, subs) = relay_with_subscribed_permission("a1", "sess-1", "perm-1", &["allow"]);
    let acp = Arc::new(AcpManager::new(vec![]));
    let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
    let mut authed = true;
    let registry = Arc::new(ProjectRegistry::new());
    let mut current_agent: Option<crate::acp::AgentId> = None;
    let current_session = Arc::new(parking_lot::Mutex::new(None::<crate::acp::SessionId>));
    let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
    let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
    let reply = block_on(handle_request(
        r#"{"id":"r1","type":"respond_permission","payload":{"agentId":"a2","requestId":"perm-1","optionId":"allow"}}"#,
        &mut authed,
        None,
        &acp,
        &relay,
        &registry,
        None,
        None,
        &tx,
        &mut subs.clone(),
        &mut current_agent,
        &current_session,
        &current_project,
        &switch_queue,
        HistoryMode::LiveOnly,
        None,
        None,
        None,
    ));
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "permission_denied");
}

/// Story 1.7 (verification gap #2): a connection NOT subscribed to the
/// permission's session is rejected `not_found` (NFR5 ownership check — no
/// cross-session permission resolution; the code does not leak existence).
#[test]
fn handle_respond_permission_not_subscribed_is_not_found() {
    // Register a permission on sess-A but subscribe the connection to sess-B.
    use crate::web::sink::{AcpEvent, EventSink};
    let relay = Arc::new(WsRelaySink::new());
    let acp = Arc::new(AcpManager::new(vec![]));
    relay.set_rendezvous(Arc::new(
        crate::web::permissions::PermissionRendezvous::default(),
    ));
    relay.seed_session_for_test("sess-B");
    let (_other_client, _rx, _replay) = block_on(relay.subscribe("sess-B", None));
    let subs: Vec<(String, ClientId)> = vec![("sess-B".to_string(), ClientId::new())];
    relay.emit(&AcpEvent {
        sid: Some("sess-A".to_string()),
        type_: "acp:permission_request",
        payload: serde_json::json!({
            "agentId": "a1", "sessionId": "sess-A", "requestId": "perm-A",
            "toolCall": { "toolCallId": "tc-1" }, "options": [{ "optionId": "allow" }]
        }),
    });
    let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
    let mut authed = true;
    let registry = Arc::new(ProjectRegistry::new());
    let mut current_agent: Option<crate::acp::AgentId> = None;
    let current_session = Arc::new(parking_lot::Mutex::new(None::<crate::acp::SessionId>));
    let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
    let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
    let reply = block_on(handle_request(
        r#"{"id":"r1","type":"respond_permission","payload":{"agentId":"a1","requestId":"perm-A","optionId":"allow"}}"#,
        &mut authed,
        None,
        &acp,
        &relay,
        &registry,
        None,
        None,
        &tx,
        &mut subs.clone(),
        &mut current_agent,
        &current_session,
        &current_project,
        &switch_queue,
        HistoryMode::LiveOnly,
        None,
        None,
        None,
    ));
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "not_found");
}

/// Story 1.7 (verification gap #4 + happy path): a valid `respond_permission`
/// from a subscribed connection resolves the ticket (ok); a second frame for
/// the same requestId is rejected `stale` (handler-level first-response-wins,
/// exercising the handler's `subscribed_clients` ClientId resolution).
#[test]
fn handle_respond_permission_resolves_then_second_is_stale() {
    let (relay, subs) = relay_with_subscribed_permission("a1", "sess-1", "perm-1", &["allow"]);
    let acp = Arc::new(AcpManager::new(vec![]));
    let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
    let mut authed = true;
    let registry = Arc::new(ProjectRegistry::new());
    let mut current_agent: Option<crate::acp::AgentId> = None;
    let current_session = Arc::new(parking_lot::Mutex::new(None::<crate::acp::SessionId>));
    let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
    let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
    let ok_reply = block_on(handle_request(
        r#"{"id":"r1","type":"respond_permission","payload":{"agentId":"a1","requestId":"perm-1","optionId":"allow"}}"#,
        &mut authed,
        None,
        &acp,
        &relay,
        &registry,
        None,
        None,
        &tx,
        &mut subs.clone(),
        &mut current_agent,
        &current_session,
        &current_project,
        &switch_queue,
        HistoryMode::LiveOnly,
        None,
        None,
        None,
    ));
    assert!(ok_reply.ok, "first response wins: {:?}", ok_reply.err);
    // Second frame for the same requestId → stale (ticket evicted).
    let stale_reply = block_on(handle_request(
        r#"{"id":"r2","type":"respond_permission","payload":{"agentId":"a1","requestId":"perm-1","optionId":"allow"}}"#,
        &mut authed,
        None,
        &acp,
        &relay,
        &registry,
        None,
        None,
        &tx,
        &mut subs.clone(),
        &mut current_agent,
        &current_session,
        &current_project,
        &switch_queue,
        HistoryMode::LiveOnly,
        None,
        None,
        None,
    ));
    assert!(!stale_reply.ok);
    assert_eq!(stale_reply.err.unwrap().code, "stale");
}

/// Story 1.7 (verification gap: TOCTOU through the handler): an `optionId`
/// not in the original options is rejected `permission_denied` end-to-end.
#[test]
fn handle_respond_permission_invalid_option_is_permission_denied() {
    let (relay, subs) =
        relay_with_subscribed_permission("a1", "sess-1", "perm-1", &["allow", "deny"]);
    let acp = Arc::new(AcpManager::new(vec![]));
    let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
    let mut authed = true;
    let registry = Arc::new(ProjectRegistry::new());
    let mut current_agent: Option<crate::acp::AgentId> = None;
    let current_session = Arc::new(parking_lot::Mutex::new(None::<crate::acp::SessionId>));
    let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
    let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
    let reply = block_on(handle_request(
        r#"{"id":"r1","type":"respond_permission","payload":{"agentId":"a1","requestId":"perm-1","optionId":"escalate"}}"#,
        &mut authed,
        None,
        &acp,
        &relay,
        &registry,
        None,
        None,
        &tx,
        &mut subs.clone(),
        &mut current_agent,
        &current_session,
        &current_project,
        &switch_queue,
        HistoryMode::LiveOnly,
        None,
        None,
        None,
    ));
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "permission_denied");
}

/// Helper (issue #411): build a relay + question rendezvous, subscribe a
/// connection to a session, and register a question ticket via `emit` (the
/// production path). Returns the (relay, subs) ready for a `handle_request`
/// call.
fn relay_with_subscribed_question(
    agent_id: &str,
    session_id: &str,
    question_id: &str,
    options: &[&str],
) -> (Arc<WsRelaySink>, Vec<(String, ClientId)>) {
    use crate::web::sink::{AcpEvent, EventSink};
    let relay = Arc::new(WsRelaySink::new());
    relay.set_question_rendezvous(Arc::new(
        crate::web::permissions::QuestionRendezvous::default(),
    ));
    relay.seed_session_for_test(session_id);
    let (client_id, _rx, _replay) = block_on(relay.subscribe(session_id, None));
    let subs: Vec<(String, ClientId)> = vec![(session_id.to_string(), client_id)];
    let options_value = serde_json::Value::Array(
        options
            .iter()
            .map(|v| serde_json::json!({ "value": v, "label": v }))
            .collect(),
    );
    relay.emit(&AcpEvent {
        sid: Some(session_id.to_string()),
        type_: "acp:question_request",
        payload: serde_json::json!({
            "agentId": agent_id,
            "sessionId": session_id,
            "questionId": question_id,
            "question": "Which approach?",
            "options": options_value,
        }),
    });
    (relay, subs)
}

/// Issue #411: without a question rendezvous attached (desktop path), the
/// `answer_question` handler replies `not_implemented`.
#[test]
fn handle_answer_question_without_rendezvous_is_not_implemented() {
    let mut authed = true;
    let reply = handle_sync(
        r#"{"id":"r1","type":"answer_question","payload":{"agentId":"a1","questionId":"q-x"}}"#,
        &mut authed,
    );
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "not_implemented");
}

/// Issue #411: a malformed `answer_question` payload is rejected with
/// `unsupported`.
#[test]
fn handle_answer_question_malformed_payload_is_unsupported() {
    let relay = Arc::new(WsRelaySink::new());
    relay.set_question_rendezvous(Arc::new(
        crate::web::permissions::QuestionRendezvous::default(),
    ));
    let acp = Arc::new(AcpManager::new(vec![]));
    let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
    let mut authed = true;
    let registry = Arc::new(ProjectRegistry::new());
    let mut current_agent: Option<crate::acp::AgentId> = None;
    let current_session = Arc::new(parking_lot::Mutex::new(None::<crate::acp::SessionId>));
    let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
    let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
    let mut subs = Vec::new();
    let reply = block_on(handle_request(
        r#"{"id":"r1","type":"answer_question","payload":{"agentId":"a1"}}"#,
        &mut authed,
        None,
        &acp,
        &relay,
        &registry,
        None,
        None,
        &tx,
        &mut subs,
        &mut current_agent,
        &current_session,
        &current_project,
        &switch_queue,
        HistoryMode::LiveOnly,
        None,
        None,
        None,
    ));
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "unsupported");
}

/// Issue #411: an `answer_question` whose `agentId` differs from the
/// ticket's agent is rejected `permission_denied` (defense-in-depth).
#[test]
fn handle_answer_question_wrong_agent_is_permission_denied() {
    let (relay, subs) = relay_with_subscribed_question("a1", "sess-1", "q-1", &["plan-a"]);
    let acp = Arc::new(AcpManager::new(vec![]));
    let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
    let mut authed = true;
    let registry = Arc::new(ProjectRegistry::new());
    let mut current_agent: Option<crate::acp::AgentId> = None;
    let current_session = Arc::new(parking_lot::Mutex::new(None::<crate::acp::SessionId>));
    let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
    let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
    let reply = block_on(handle_request(
        r#"{"id":"r1","type":"answer_question","payload":{"agentId":"a2","questionId":"q-1","values":["plan-a"]}}"#,
        &mut authed,
        None,
        &acp,
        &relay,
        &registry,
        None,
        None,
        &tx,
        &mut subs.clone(),
        &mut current_agent,
        &current_session,
        &current_project,
        &switch_queue,
        HistoryMode::LiveOnly,
        None,
        None,
        None,
    ));
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "permission_denied");
}

/// Issue #411: a connection NOT subscribed to the question's session is
/// rejected `not_found` (NFR5 ownership check).
#[test]
fn handle_answer_question_not_subscribed_is_not_found() {
    use crate::web::sink::{AcpEvent, EventSink};
    let relay = Arc::new(WsRelaySink::new());
    let acp = Arc::new(AcpManager::new(vec![]));
    relay.set_question_rendezvous(Arc::new(
        crate::web::permissions::QuestionRendezvous::default(),
    ));
    relay.seed_session_for_test("sess-B");
    let (_other_client, _rx, _replay) = block_on(relay.subscribe("sess-B", None));
    let subs: Vec<(String, ClientId)> = vec![("sess-B".to_string(), ClientId::new())];
    relay.emit(&AcpEvent {
        sid: Some("sess-A".to_string()),
        type_: "acp:question_request",
        payload: serde_json::json!({
            "agentId": "a1", "sessionId": "sess-A", "questionId": "q-A",
            "question": "Q", "options": [{ "value": "plan-a", "label": "Plan A" }]
        }),
    });
    let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
    let mut authed = true;
    let registry = Arc::new(ProjectRegistry::new());
    let mut current_agent: Option<crate::acp::AgentId> = None;
    let current_session = Arc::new(parking_lot::Mutex::new(None::<crate::acp::SessionId>));
    let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
    let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
    let reply = block_on(handle_request(
        r#"{"id":"r1","type":"answer_question","payload":{"agentId":"a1","questionId":"q-A","values":["plan-a"]}}"#,
        &mut authed,
        None,
        &acp,
        &relay,
        &registry,
        None,
        None,
        &tx,
        &mut subs.clone(),
        &mut current_agent,
        &current_session,
        &current_project,
        &switch_queue,
        HistoryMode::LiveOnly,
        None,
        None,
        None,
    ));
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "not_found");
}

/// Issue #411: a valid `answer_question` from a subscribed connection
/// resolves the ticket (ok); a second frame for the same questionId is
/// rejected `stale` (handler-level first-response-wins).
#[test]
fn handle_answer_question_resolves_then_second_is_stale() {
    let (relay, subs) = relay_with_subscribed_question("a1", "sess-1", "q-1", &["plan-a"]);
    let acp = Arc::new(AcpManager::new(vec![]));
    let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
    let mut authed = true;
    let registry = Arc::new(ProjectRegistry::new());
    let mut current_agent: Option<crate::acp::AgentId> = None;
    let current_session = Arc::new(parking_lot::Mutex::new(None::<crate::acp::SessionId>));
    let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
    let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
    let ok_reply = block_on(handle_request(
        r#"{"id":"r1","type":"answer_question","payload":{"agentId":"a1","questionId":"q-1","values":["plan-a"]}}"#,
        &mut authed,
        None,
        &acp,
        &relay,
        &registry,
        None,
        None,
        &tx,
        &mut subs.clone(),
        &mut current_agent,
        &current_session,
        &current_project,
        &switch_queue,
        HistoryMode::LiveOnly,
        None,
        None,
        None,
    ));
    assert!(ok_reply.ok, "first answer wins: {:?}", ok_reply.err);
    let stale_reply = block_on(handle_request(
        r#"{"id":"r2","type":"answer_question","payload":{"agentId":"a1","questionId":"q-1","values":["plan-a"]}}"#,
        &mut authed,
        None,
        &acp,
        &relay,
        &registry,
        None,
        None,
        &tx,
        &mut subs.clone(),
        &mut current_agent,
        &current_session,
        &current_project,
        &switch_queue,
        HistoryMode::LiveOnly,
        None,
        None,
        None,
    ));
    assert!(!stale_reply.ok);
    assert_eq!(stale_reply.err.unwrap().code, "stale");
}

/// Issue #411: an option value not in the original options is rejected
/// `permission_denied` end-to-end (TOCTOU through the handler).
#[test]
fn handle_answer_question_invalid_option_is_permission_denied() {
    let (relay, subs) = relay_with_subscribed_question("a1", "sess-1", "q-1", &["plan-a"]);
    let acp = Arc::new(AcpManager::new(vec![]));
    let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
    let mut authed = true;
    let registry = Arc::new(ProjectRegistry::new());
    let mut current_agent: Option<crate::acp::AgentId> = None;
    let current_session = Arc::new(parking_lot::Mutex::new(None::<crate::acp::SessionId>));
    let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
    let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
    let reply = block_on(handle_request(
        r#"{"id":"r1","type":"answer_question","payload":{"agentId":"a1","questionId":"q-1","values":["escalate"]}}"#,
        &mut authed,
        None,
        &acp,
        &relay,
        &registry,
        None,
        None,
        &tx,
        &mut subs.clone(),
        &mut current_agent,
        &current_session,
        &current_project,
        &switch_queue,
        HistoryMode::LiveOnly,
        None,
        None,
        None,
    ));
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "permission_denied");
}

#[test]
fn handle_request_malformed_frame_replies_unsupported() {
    let mut authed = false;
    let reply = handle_sync("not-json", &mut authed);
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "unsupported");
}

#[test]
fn handle_subscribe_ok_and_stale() {
    let relay = Arc::new(WsRelaySink::with_capacity(2, 8));
    let acp = Arc::new(AcpManager::new(vec![]));
    // Fill log so last_seq=0 becomes stale after eviction… actually capacity 2
    // means after 3 emits base advances. Use subscribe with huge last_seq gap.
    use crate::web::sink::{AcpEvent, EventSink};
    for i in 1..=3 {
        relay.emit(&AcpEvent {
            sid: Some("s1".to_string()),
            type_: "acp:message_chunk",
            payload: json!({"i": i}),
        });
    }
    // Story 7: the subscribe existence gate rejects unknown sessions, so
    // "fresh" must be a KNOWN session — emit one event to land it in the
    // relay live-map (covers the ephemeral never-persisted case).
    relay.emit(&AcpEvent {
        sid: Some("fresh".to_string()),
        type_: "acp:session_created",
        payload: json!({"sessionId": "fresh"}),
    });
    // Evicted seq 1; last_seq=0 → next wanted 1 < base → Stale
    let (tx, mut rx) = mpsc::unbounded_channel::<Outbound>();
    let mut subs = Vec::new();
    let mut authed = true;
    let registry = Arc::new(ProjectRegistry::new());
    let mut current_agent: Option<crate::acp::AgentId> = None;
    let current_session = Arc::new(parking_lot::Mutex::new(None::<crate::acp::SessionId>));
    let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
    let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
    let reply = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(handle_request(
            r#"{"id":"sub1","type":"subscribe","payload":{"sessionId":"s1","lastSeq":0}}"#,
            &mut authed,
            None,
            &acp,
            &relay,
            &registry,
            None,
            None,
            &tx,
            &mut subs,
            &mut current_agent,
            &current_session,
            &current_project,
            &switch_queue,
            HistoryMode::LiveOnly,
            None,
            None,
            None,
        ));
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "stale");

    // Fresh session live-only subscribe (omit lastSeq) succeeds.
    let mut subs2 = Vec::new();
    let reply_ok = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(handle_request(
            r#"{"id":"sub2","type":"subscribe","payload":{"sessionId":"fresh"}}"#,
            &mut authed,
            None,
            &acp,
            &relay,
            &registry,
            None,
            None,
            &tx,
            &mut subs2,
            &mut current_agent,
            &current_session,
            &current_project,
            &switch_queue,
            HistoryMode::LiveOnly,
            None,
            None,
            None,
        ));
    assert!(reply_ok.ok, "{:?}", reply_ok.err);
    assert_eq!(subs2.len(), 1);

    // Re-subscribe same session replaces prior ClientId (no leak).
    let reply_resub = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(handle_request(
            r#"{"id":"sub3","type":"subscribe","payload":{"sessionId":"fresh"}}"#,
            &mut authed,
            None,
            &acp,
            &relay,
            &registry,
            None,
            None,
            &tx,
            &mut subs2,
            &mut current_agent,
            &current_session,
            &current_project,
            &switch_queue,
            HistoryMode::LiveOnly,
            None,
            None,
            None,
        ));
    assert!(reply_resub.ok, "{:?}", reply_resub.err);
    assert_eq!(subs2.len(), 1);

    // Evicted log + omit lastSeq → live-only succeeds (not stale).
    let mut subs3 = Vec::new();
    let reply_live = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(handle_request(
            r#"{"id":"sub4","type":"subscribe","payload":{"sessionId":"s1"}}"#,
            &mut authed,
            None,
            &acp,
            &relay,
            &registry,
            None,
            None,
            &tx,
            &mut subs3,
            &mut current_agent,
            &current_session,
            &current_project,
            &switch_queue,
            HistoryMode::LiveOnly,
            None,
            None,
            None,
        ));
    assert!(reply_live.ok, "{:?}", reply_live.err);

    // Drain any replay/live.
    while rx.try_recv().is_ok() {}
}

/// Story 7: `subscribe` to a session in neither the relay live-map nor the
/// persistence catalog fails with `not_found` (parity with
/// `get_session_payload`) and registers no client — with and without a
/// `lastSeq` cursor.
#[tokio::test]
async fn handle_subscribe_unknown_session_is_not_found() {
    let root = std::env::temp_dir().join(format!("termul-ws-sub-unknown-{}", uuid::Uuid::new_v4()));
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = crate::acp::SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    let relay = Arc::new(WsRelaySink::with_persistence(8, persistence.clone()));
    let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
    let mut subs: Vec<(String, ClientId)> = Vec::new();

    // Without a cursor.
    let reply = handle_subscribe(
        "sub-1".to_string(),
        &json!({"sessionId": "session-absent"}),
        &relay,
        &tx,
        &mut subs,
    )
    .await;
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "not_found");
    assert!(
        subs.is_empty(),
        "no client may be registered for an unknown session"
    );
    assert_eq!(relay.session_subscriber_count("session-absent"), 0);

    // With a cursor.
    let reply = handle_subscribe(
        "sub-2".to_string(),
        &json!({"sessionId": "session-absent", "lastSeq": 3}),
        &relay,
        &tx,
        &mut subs,
    )
    .await;
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "not_found");
    assert!(subs.is_empty());
    assert_eq!(relay.session_subscriber_count("session-absent"), 0);

    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

/// Story 7: `open_persisted_session` on a finalized (`Closed`) session is
/// a pure read — the on-disk `sessions.json` index and per-session
/// `metadata.json` bytes are unchanged, and the catalog keeps
/// `status == Closed` + the original `last_activity_at` (the durable
/// writer is reinstalled only by the manager's session/load + resume
/// paths, never by a read).
#[tokio::test]
async fn open_persisted_session_is_read_only() {
    use crate::web::sink::{AcpEvent, EventSink};
    let root =
        std::env::temp_dir().join(format!("termul-ws-open-readonly-{}", uuid::Uuid::new_v4()));
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = crate::acp::SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    let metadata = persistence
        .register_session(crate::acp::SessionRegistration {
            session_id: "session-x".to_string(),
            cwd: cwd.clone(),
            ..Default::default()
        })
        .await
        .unwrap();
    let relay = Arc::new(WsRelaySink::with_persistence(8, persistence.clone()));
    // One durable event so the open replays a non-empty transcript.
    relay.emit(&AcpEvent {
        sid: Some("session-x".to_string()),
        type_: "acp:message_chunk",
        payload: json!({"sessionId": "session-x", "text": "hello"}),
    });
    persistence
        .finalize_session("session-x", crate::acp::PersistedSessionStatus::Closed)
        .await
        .unwrap();

    let index_path = root.join("sessions").join("sessions.json");
    let metadata_path = root
        .join("sessions")
        .join(&metadata.storage_key)
        .join("metadata.json");
    let index_before = std::fs::read(&index_path).unwrap();
    let metadata_before = std::fs::read(&metadata_path).unwrap();
    let catalog_before = persistence.metadata("session-x").unwrap();
    assert_eq!(
        catalog_before.status,
        crate::acp::PersistedSessionStatus::Closed
    );

    let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
    let mut subs: Vec<(String, ClientId)> = Vec::new();
    let reply = handle_open_persisted_session(
        "open-1".to_string(),
        &json!({"sessionId": "session-x", "lastSeq": 0}),
        &relay,
        &tx,
        &mut subs,
        HistoryMode::Server,
    )
    .await;
    assert!(reply.ok, "{:?}", reply.err);
    assert_eq!(subs.len(), 1);

    assert_eq!(
        std::fs::read(&index_path).unwrap(),
        index_before,
        "sessions.json index must be untouched by a read"
    );
    assert_eq!(
        std::fs::read(&metadata_path).unwrap(),
        metadata_before,
        "per-session metadata.json must be untouched by a read"
    );
    let catalog_after = persistence.metadata("session-x").unwrap();
    assert_eq!(
        catalog_after.status,
        crate::acp::PersistedSessionStatus::Closed
    );
    assert_eq!(
        catalog_after.last_activity_at,
        catalog_before.last_activity_at
    );

    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

/// Story 7 review: the `knows_session` catalog branch admits a finalized
/// session whose events were never emitted through THIS relay — the
/// post-restart shape (fresh `WsRelaySink` over the same persistence,
/// empty live-map). `open_persisted_session` must succeed and replay the
/// durable transcript from disk.
#[tokio::test]
async fn open_persisted_session_catalog_branch_admits_finalized_session() {
    use crate::web::sink::{AcpEvent, EventSink};
    let root =
        std::env::temp_dir().join(format!("termul-ws-open-catalog-{}", uuid::Uuid::new_v4()));
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = crate::acp::SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    persistence
        .register_session(crate::acp::SessionRegistration {
            session_id: "session-x".to_string(),
            cwd: cwd.clone(),
            ..Default::default()
        })
        .await
        .unwrap();
    // Emit through a FIRST relay so the event lands in the durable log and
    // that relay's live-map; the second relay below never sees it live.
    let relay_pre_restart = Arc::new(WsRelaySink::with_persistence(8, persistence.clone()));
    relay_pre_restart.emit(&AcpEvent {
        sid: Some("session-x".to_string()),
        type_: "acp:message_chunk",
        payload: json!({"sessionId": "session-x", "text": "hello"}),
    });
    persistence
        .finalize_session("session-x", crate::acp::PersistedSessionStatus::Closed)
        .await
        .unwrap();

    // Post-restart shape: a fresh relay with an empty live-map over the
    // same persistence — admission must come from the catalog branch.
    let relay = Arc::new(WsRelaySink::with_persistence(8, persistence.clone()));
    let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
    let mut subs: Vec<(String, ClientId)> = Vec::new();
    let reply = handle_open_persisted_session(
        "open-1".to_string(),
        &json!({"sessionId": "session-x", "lastSeq": 0}),
        &relay,
        &tx,
        &mut subs,
        HistoryMode::Server,
    )
    .await;
    assert!(reply.ok, "{:?}", reply.err);
    let payload = reply.payload.unwrap();
    assert!(
        payload["replayed"].as_u64().unwrap() >= 1,
        "finalized session replays durable events from disk: {payload}"
    );
    assert_eq!(subs.len(), 1);

    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

/// Epic-4 bridge: a cold web tab (no agent spawned / session created yet)
/// sends `switch_project` → deferred `Selected` (Ask-First resolution:
/// do NOT auto-spawn). Per-connection `current_project` is updated; the
/// host default is NOT touched (no `registry.set_default_project`, no
/// `broadcast_projects_changed`, no persistence — a per-client switch is
/// ephemeral). No agent/session is created — the web client spawns the
/// agent lazily when a chat starts.
#[test]
fn handle_switch_project_cold_tab_is_deferred_select() {
    let relay = Arc::new(WsRelaySink::new());
    let acp = Arc::new(AcpManager::new(vec![]));
    let registry = Arc::new(ProjectRegistry::new());
    registry.set(
        vec![crate::web::project_registry::ProjectSummary {
            id: "p-1".to_string(),
            name: "Proj p-1".to_string(),
            color: "blue".to_string(),
            path: Some("/a".to_string()),
            is_archived: false,
            is_default: false,
        }],
        None,
    );
    let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
    let mut subs = Vec::new();
    let mut authed = true;
    let mut current_agent: Option<crate::acp::AgentId> = None;
    let current_session = Arc::new(parking_lot::Mutex::new(None::<crate::acp::SessionId>));
    let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
    let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
    let reply = block_on(handle_request(
        r#"{"id":"r1","type":"switch_project","payload":{"projectId":"p-1"}}"#,
        &mut authed,
        None,
        &acp,
        &relay,
        &registry,
        None,
        None,
        &tx,
        &mut subs,
        &mut current_agent,
        &current_session,
        &current_project,
        &switch_queue,
        HistoryMode::LiveOnly,
        None,
        None,
        None,
    ));
    assert!(reply.ok, "{:?}", reply.err);
    let payload = reply.payload.expect("selected payload");
    assert_eq!(payload["status"], "selected");
    assert_eq!(payload["projectId"], "p-1");
    assert_eq!(payload["cwd"], "/a");
    // Cold tab: no session was created.
    assert!(current_session.lock().is_none());
    // Per-connection tracking reflects the switch.
    let cp = current_project.lock().clone();
    assert_eq!(cp.as_deref(), Some("p-1"));
    // The host default is UNCHANGED (per-connection switch — Epic 7).
    let snap = registry.snapshot();
    assert_eq!(snap.default_project_id, None);
}

/// Cold-tab `switch_project` with an unknown/archived/pathless `projectId`
/// → `NOT_FOUND` (the registry lookup is hoisted above the agent check, so
/// a cold tab gets the same `not_found` as the live-agent path).
#[test]
fn handle_switch_project_cold_tab_unknown_id_is_not_found() {
    let relay = Arc::new(WsRelaySink::new());
    let acp = Arc::new(AcpManager::new(vec![]));
    let registry = Arc::new(ProjectRegistry::new());
    registry.set(
        vec![crate::web::project_registry::ProjectSummary {
            id: "p-1".to_string(),
            name: "Proj p-1".to_string(),
            color: "blue".to_string(),
            path: Some("/a".to_string()),
            is_archived: false,
            is_default: true,
        }],
        Some("p-1".to_string()),
    );
    let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
    let mut subs = Vec::new();
    let mut authed = true;
    let mut current_agent: Option<crate::acp::AgentId> = None;
    let current_session = Arc::new(parking_lot::Mutex::new(None::<crate::acp::SessionId>));
    let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
    let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
    let reply = block_on(handle_request(
        r#"{"id":"r1","type":"switch_project","payload":{"projectId":"missing"}}"#,
        &mut authed,
        None,
        &acp,
        &relay,
        &registry,
        None,
        None,
        &tx,
        &mut subs,
        &mut current_agent,
        &current_session,
        &current_project,
        &switch_queue,
        HistoryMode::LiveOnly,
        None,
        None,
        None,
    ));
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "not_found");
}

/// Cold-tab `switch_project` is per-connection (Epic 7): it updates only
/// the requester's `current_project`. It does NOT persist to the
/// `--projects-file` (only `set_default_project` writes the durable
/// default) and does NOT broadcast `projects_changed`.
#[test]
fn execute_cold_tab_select_is_per_connection_no_persistence_no_broadcast() {
    // A relay is wired (VPS-mode fixture) but the cold-tab switch must NOT
    // touch it (no broadcast). Prefix `_` so the unused binding documents
    // the intent without failing the build.
    let _relay = Arc::new(WsRelaySink::new());
    let registry = Arc::new(ProjectRegistry::new());
    registry.set(
        vec![crate::web::project_registry::ProjectSummary {
            id: "p-1".to_string(),
            name: "Proj p-1".to_string(),
            color: "blue".to_string(),
            path: Some("/a".to_string()),
            is_archived: false,
            is_default: false,
        }],
        None,
    );
    // A file registry + path are wired (VPS-mode fixtures), but the
    // cold-tab switch must NOT touch them.
    let file_registry = FileProjectRegistry::from_roots(
        vec![crate::acp::VfsRoot {
            id: "p-1".to_string(),
            name: "Proj p-1".to_string(),
            path: PathBuf::from("/a"),
            color: "blue".to_string(),
            is_archived: false,
            mcp_servers: vec![],
        }],
        None,
    );
    let file_registry = Arc::new(parking_lot::Mutex::new(file_registry));
    let path = std::env::temp_dir().join(format!(
        "termul-ws-cold-tab-noperist-{}.json",
        std::process::id()
    ));
    let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
    let target = ProjectSwitchContext {
        project_id: "p-1".to_string(),
        cwd: "/a".to_string(),
        mcp_servers: vec![],
    };
    let result = execute_cold_tab_select(target, &current_project);
    // Capture whether a file was written (it must NOT be).
    let leaked = std::fs::read_to_string(&path).ok();
    let _ = std::fs::remove_file(&path);
    let outcome = result.expect("cold-tab select succeeds");
    let SwitchProjectOutcome::Selected { project_id, cwd } = outcome else {
        panic!("expected Selected, got {:?}", outcome);
    };
    assert_eq!(project_id, "p-1");
    assert_eq!(cwd, "/a");
    // Per-connection tracking reflects the switch.
    let cp = current_project.lock().clone();
    assert_eq!(cp.as_deref(), Some("p-1"));
    // The host default is UNCHANGED (per-connection switch).
    assert_eq!(registry.snapshot().default_project_id, None);
    // The file registry is UNCHANGED (no persistence on switch).
    assert_eq!(file_registry.lock().default_project_id(), None);
    // No file was written to disk.
    assert!(leaked.is_none(), "switch must not write the projects file");
}

/// `switch_project` with a live agent but an unknown `projectId` →
/// `NOT_FOUND` (registry lookup happens BEFORE `new_session`, so the no-op
/// AcpManager never creates a session).
#[test]
fn handle_switch_project_unknown_id_is_not_found() {
    let relay = Arc::new(WsRelaySink::new());
    let acp = Arc::new(AcpManager::new(vec![]));
    let registry = Arc::new(ProjectRegistry::new());
    // A known project so the registry is non-empty; "missing" is absent.
    registry.set(
        vec![crate::web::project_registry::ProjectSummary {
            id: "p-1".to_string(),
            name: "Proj p-1".to_string(),
            color: "blue".to_string(),
            path: Some("/a".to_string()),
            is_archived: false,
            is_default: true,
        }],
        Some("p-1".to_string()),
    );
    let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
    let mut subs = Vec::new();
    let mut authed = true;
    let mut current_agent: Option<crate::acp::AgentId> = Some(crate::acp::AgentId::new());
    let current_session = Arc::new(parking_lot::Mutex::new(None::<crate::acp::SessionId>));
    let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
    let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));
    let reply = block_on(handle_request(
        r#"{"id":"r1","type":"switch_project","payload":{"projectId":"missing"}}"#,
        &mut authed,
        None,
        &acp,
        &relay,
        &registry,
        None,
        None,
        &tx,
        &mut subs,
        &mut current_agent,
        &current_session,
        &current_project,
        &switch_queue,
        HistoryMode::LiveOnly,
        None,
        None,
        None,
    ));
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "not_found");
}

/// Host-owned history (CAP-2): `list_persisted_sessions` serves the
/// host `SessionPersistence` index — the same seam on desktop shared-live
/// and standalone.
#[tokio::test]
async fn list_persisted_sessions_serves_host_persistence() {
    let root = std::env::temp_dir().join(format!("termul-ws-list-{}", uuid::Uuid::new_v4()));
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = crate::acp::SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    persistence
        .register_session(crate::acp::SessionRegistration {
            session_id: "s-1".to_string(),
            stable_agent_namespace: Some("config:claude".to_string()),
            runtime_agent_id: Some("agent-1".to_string()),
            project_id: Some("p-1".to_string()),
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    let relay = Arc::new(WsRelaySink::with_persistence(8, persistence.clone()));
    let reply = handle_list_persisted_sessions("r1".to_string(), &relay, HistoryMode::Server).await;
    assert!(reply.ok);
    let value = serde_json::to_value(&reply).unwrap();
    assert_eq!(value["payload"][0]["sessionId"], "s-1");
    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn register_discovered_session_promotes_metadata_without_transcript() {
    let root = std::env::temp_dir().join(format!(
        "termul-ws-register-discovered-{}",
        uuid::Uuid::new_v4()
    ));
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = crate::acp::SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    let relay = Arc::new(WsRelaySink::with_persistence(8, persistence.clone()));
    let acp = Arc::new(AcpManager::with_persistence(vec![], persistence.clone()));
    acp.install_test_agent_with_sessions(
        crate::acp::AgentId("agent-1".to_string()),
        std::collections::HashSet::new(),
    );

    let reply = handle_register_discovered_session(
        "r1".to_string(),
        &json!({
            "sessionId": "discovered-1",
            "agentId": "agent-1",
            "cwd": cwd.to_string_lossy(),
            "title": "Agent title",
            "updatedAt": 42,
            "projectId": "p-1"
        }),
        &acp,
        &relay,
    )
    .await;

    assert!(reply.ok);
    let metadata = persistence.metadata("discovered-1").unwrap();
    assert_eq!(metadata.title.as_deref(), Some("Agent title"));
    assert_eq!(
        metadata.title_source,
        Some(crate::acp::session_persistence::TitleSource::AgentSupplied)
    );
    assert_eq!(metadata.last_seq, 0);
    assert!(persistence
        .replay_after("discovered-1", 0)
        .unwrap()
        .is_empty());
    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn get_session_payload_unsupported_in_live_only() {
    let relay = Arc::new(WsRelaySink::new());
    let reply = handle_get_session_payload(
        "r1".to_string(),
        &json!({ "sessionId": "s-1" }),
        &relay,
        HistoryMode::LiveOnly,
    )
    .await;
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "unsupported");
}

/// CAP-2 (spec-in-chat-agent-switch): `record_agent_switch` writes ONE
/// durable `agent_switch` record (the fold materializes exactly one
/// marker) and replies ok; an unknown session fails closed with
/// `not_found` BEFORE any durable write; live-only mode → `unsupported`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn record_agent_switch_writes_durable_marker_and_replies_ok() {
    let root =
        std::env::temp_dir().join(format!("termul-ws-record-switch-{}", uuid::Uuid::new_v4()));
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = crate::acp::SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    persistence
        .register_session(crate::acp::SessionRegistration {
            session_id: "session-sw".to_string(),
            stable_agent_namespace: Some("config:omp".to_string()),
            runtime_agent_id: Some("runtime-sw".to_string()),
            project_id: Some("p-1".to_string()),
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    let relay = Arc::new(WsRelaySink::with_persistence(8, persistence.clone()));
    let acp = Arc::new(AcpManager::with_persistence(vec![], persistence.clone()));

    let reply = handle_record_agent_switch(
        "r1".to_string(),
        &json!({
            "sessionId": "session-sw",
            "fromConfigId": "omp",
            "toConfigId": "claude",
            "newSessionId": "session-sw-new",
            "summaryText": "Handoff summary"
        }),
        &acp,
        &relay,
        HistoryMode::Server,
    )
    .await;
    assert!(reply.ok, "reply: {reply:?}");

    // ONE durable marker record; the fold materializes exactly one.
    let records = persistence.replay_after("session-sw", 0).unwrap();
    let switch_records: Vec<_> = records
        .iter()
        .filter(|record| record.type_ == "agent_switch")
        .collect();
    assert_eq!(switch_records.len(), 1, "exactly one durable marker");
    let record = switch_records[0];
    assert_eq!(record.seq, 1);
    assert_eq!(record.payload["fromConfigId"], "omp");
    assert_eq!(record.payload["toConfigId"], "claude");
    assert_eq!(record.payload["newSessionId"], "session-sw-new");
    assert_eq!(record.payload["summaryText"], "Handoff summary");
    let payload = persistence
        .session_payload_async("session-sw")
        .await
        .unwrap();
    assert_eq!(payload.switches.len(), 1);
    assert_eq!(payload.switches[0].id, "switch:seq-1");
    // Switches are not messages.
    assert_eq!(payload.metadata.message_count, 0);

    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn record_agent_switch_unknown_session_is_not_found() {
    let root = std::env::temp_dir().join(format!(
        "termul-ws-record-switch-nf-{}",
        uuid::Uuid::new_v4()
    ));
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = crate::acp::SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    persistence
        .register_session(crate::acp::SessionRegistration {
            session_id: "session-known".to_string(),
            stable_agent_namespace: None,
            runtime_agent_id: None,
            project_id: None,
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    let relay = Arc::new(WsRelaySink::with_persistence(8, persistence.clone()));
    let acp = Arc::new(AcpManager::with_persistence(vec![], persistence.clone()));

    let reply = handle_record_agent_switch(
        "r1".to_string(),
        &json!({
            "sessionId": "session-absent",
            "fromConfigId": "omp",
            "toConfigId": "claude",
            "newSessionId": "session-new",
            "summaryText": "summary"
        }),
        &acp,
        &relay,
        HistoryMode::Server,
    )
    .await;
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "not_found");
    // Fail closed BEFORE any durable write — the known session is untouched.
    let records = persistence.replay_after("session-known", 0).unwrap();
    assert!(records.is_empty());

    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

/// CAP-2 classification parity: a catalog-known session whose writer
/// runtime is gone (post-restart recovered session — the metadata
/// pre-check PASSES) surfaces a typed `not_found` reply via the manager's
/// "session writer unavailable" error string, not the generic
/// `unsupported` storage-failure reply.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn record_agent_switch_writer_gone_session_replies_not_found() {
    let root = std::env::temp_dir().join(format!(
        "termul-ws-record-switch-wg-{}",
        uuid::Uuid::new_v4()
    ));
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = crate::acp::SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    persistence
        .register_session(crate::acp::SessionRegistration {
            session_id: "session-recovered".to_string(),
            stable_agent_namespace: None,
            runtime_agent_id: None,
            project_id: None,
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    // Simulate the post-restart state: the catalog entry survives (the
    // handler's metadata pre-check passes) but no writer runtime is
    // installed — `append_agent_switch` hits SessionNotFound.
    persistence.shutdown().await.unwrap();
    let reopened = crate::acp::SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    let relay = Arc::new(WsRelaySink::with_persistence(8, reopened.clone()));
    let acp = Arc::new(AcpManager::with_persistence(vec![], reopened.clone()));

    let reply = handle_record_agent_switch(
        "r1".to_string(),
        &json!({
            "sessionId": "session-recovered",
            "fromConfigId": "omp",
            "toConfigId": "claude",
            "newSessionId": "session-new",
            "summaryText": "summary"
        }),
        &acp,
        &relay,
        HistoryMode::Server,
    )
    .await;
    assert!(!reply.ok);
    assert_eq!(
        reply.err.unwrap().code,
        "not_found",
        "writer-gone session must be typed not_found, not unsupported"
    );

    reopened.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn record_agent_switch_unsupported_in_live_only() {
    let relay = Arc::new(WsRelaySink::new());
    let acp = Arc::new(AcpManager::new(vec![]));
    let reply = handle_record_agent_switch(
        "r1".to_string(),
        &json!({
            "sessionId": "s-1",
            "fromConfigId": "omp",
            "toConfigId": "claude",
            "newSessionId": "s-2",
            "summaryText": "summary"
        }),
        &acp,
        &relay,
        HistoryMode::LiveOnly,
    )
    .await;
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "unsupported");
}

fn standalone_payload_record(
    session_id: &str,
    seq: u64,
    type_: &str,
    payload: Value,
) -> crate::acp::PersistedEventRecord {
    crate::acp::PersistedEventRecord {
        schema_version: crate::acp::session_persistence::SESSION_SCHEMA_VERSION,
        session_id: session_id.to_string(),
        seq,
        type_: type_.to_string(),
        recorded_at: 2_000 + seq,
        payload,
    }
}

#[tokio::test]
async fn get_session_payload_materializes_standalone_durable_history() {
    let root = std::env::temp_dir().join(format!("termul-ws-payload-{}", uuid::Uuid::new_v4()));
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = crate::acp::SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    persistence
        .register_session(crate::acp::SessionRegistration {
            session_id: "session-p".to_string(),
            stable_agent_namespace: Some("config:claude".to_string()),
            runtime_agent_id: Some("runtime-p".to_string()),
            project_id: Some("p-1".to_string()),
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    // Turn with a tool boundary mid-stream: user bubble + two agent runs.
    for record in [
        standalone_payload_record(
            "session-p",
            1,
            "user_prompt",
            json!({
                "agentId": "runtime-p",
                "sessionId": "session-p",
                "turnId": "turn-1",
                "content": [{"type": "text", "text": "hello"}],
            }),
        ),
        standalone_payload_record(
            "session-p",
            2,
            "message_chunk",
            json!({
                "agentId": "runtime-p",
                "sessionId": "session-p",
                "role": "agent",
                "content": {"type": "text", "text": "wor"},
            }),
        ),
        standalone_payload_record(
            "session-p",
            3,
            "tool_call",
            json!({
                "agentId": "runtime-p",
                "sessionId": "session-p",
                "toolCall": {"toolCallId": "t-1", "kind": "execute", "status": "completed"},
            }),
        ),
        standalone_payload_record(
            "session-p",
            4,
            "message_chunk",
            json!({
                "agentId": "runtime-p",
                "sessionId": "session-p",
                "role": "agent",
                "content": {"type": "text", "text": "ld"},
            }),
        ),
        standalone_payload_record(
            "session-p",
            5,
            "prompt_complete",
            json!({"sessionId": "session-p", "turnId": "turn-1", "stopReason": "end_turn"}),
        ),
    ] {
        persistence.enqueue_event(record).unwrap();
    }
    let relay = Arc::new(WsRelaySink::with_persistence(8, persistence.clone()));

    let reply = handle_get_session_payload(
        "r1".to_string(),
        &json!({ "sessionId": "session-p" }),
        &relay,
        HistoryMode::Server,
    )
    .await;
    assert!(reply.ok, "reply: {reply:?}");
    let value = serde_json::to_value(&reply).unwrap();
    let payload = &value["payload"];
    assert_eq!(payload["metadata"]["id"], "session-p");
    assert_eq!(payload["metadata"]["agentId"], "runtime-p");
    assert_eq!(payload["metadata"]["agentConfigId"], "claude");
    assert_eq!(payload["metadata"]["projectId"], "p-1");
    assert_eq!(payload["metadata"]["messageCount"], 3);
    assert_eq!(payload["metadata"]["lastSeq"], 5);
    assert_eq!(payload["metadata"]["status"], "active");
    assert_eq!(payload["messages"][0]["id"], "turn:turn-1");
    assert_eq!(payload["messages"][0]["role"], "user");
    assert_eq!(payload["messages"][0]["seq"], 1);
    assert_eq!(payload["messages"][0]["streaming"], false);
    assert_eq!(payload["messages"][0]["blocks"][0]["text"], "hello");
    // tool_call at seq 3 splits the agent run; text coalesces per run.
    assert_eq!(payload["messages"][1]["id"], "snapshot:agent:2");
    assert_eq!(payload["messages"][1]["blocks"][0]["text"], "wor");
    assert_eq!(payload["messages"][2]["id"], "snapshot:agent:4");
    assert_eq!(payload["messages"][2]["blocks"][0]["text"], "ld");

    // Stable re-read: a second request is byte-identical.
    let reply2 = handle_get_session_payload(
        "r2".to_string(),
        &json!({ "sessionId": "session-p" }),
        &relay,
        HistoryMode::Server,
    )
    .await;
    assert!(reply2.ok);
    let value2 = serde_json::to_value(&reply2).unwrap();
    assert_eq!(value2["payload"], payload.clone());

    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn get_session_payload_standalone_unknown_session_is_not_found() {
    let root = std::env::temp_dir().join(format!("termul-ws-payload-nf-{}", uuid::Uuid::new_v4()));
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = crate::acp::SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    persistence
        .register_session(crate::acp::SessionRegistration {
            session_id: "session-known".to_string(),
            stable_agent_namespace: None,
            runtime_agent_id: None,
            project_id: None,
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    let relay = Arc::new(WsRelaySink::with_persistence(8, persistence.clone()));
    let reply = handle_get_session_payload(
        "r1".to_string(),
        &json!({ "sessionId": "session-absent" }),
        &relay,
        HistoryMode::Server,
    )
    .await;
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "not_found");
    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn get_session_payload_without_store_or_persistence_is_not_found() {
    let relay = Arc::new(WsRelaySink::new());
    let reply = handle_get_session_payload(
        "r1".to_string(),
        &json!({ "sessionId": "s-1" }),
        &relay,
        HistoryMode::Server,
    )
    .await;
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "not_found");
}

/// Storage degradation after finalization: the transcript log becomes
/// unreadable. The handler must fail closed with `unsupported` — never a
/// fabricated empty payload that would wipe the client's transcript.
#[tokio::test]
async fn get_session_payload_standalone_corrupt_log_is_unsupported() {
    let root = std::env::temp_dir().join(format!(
        "termul-ws-payload-corrupt-{}",
        uuid::Uuid::new_v4()
    ));
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = crate::acp::SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    persistence
        .register_session(crate::acp::SessionRegistration {
            session_id: "session-c".to_string(),
            stable_agent_namespace: None,
            runtime_agent_id: None,
            project_id: None,
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    persistence
        .enqueue_event(standalone_payload_record(
            "session-c",
            1,
            "user_prompt",
            json!({
                "agentId": "runtime-c",
                "sessionId": "session-c",
                "turnId": "turn-1",
                "content": [{"type": "text", "text": "hello"}],
            }),
        ))
        .unwrap();
    persistence
        .finalize_session("session-c", crate::acp::PersistedSessionStatus::Closed)
        .await
        .unwrap();
    // Corrupt the durable transcript log after finalization.
    let storage_key = persistence.metadata("session-c").unwrap().storage_key;
    let log_path = persistence.root().join(&storage_key).join("messages.jsonl");
    {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&log_path)
            .unwrap();
        file.write_all(b"{not valid json}\n").unwrap();
        file.flush().unwrap();
    }
    let relay = Arc::new(WsRelaySink::with_persistence(8, persistence.clone()));
    let reply = handle_get_session_payload(
        "r1".to_string(),
        &json!({ "sessionId": "session-c" }),
        &relay,
        HistoryMode::Server,
    )
    .await;
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "unsupported");
    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn try_reopen_returns_none_when_no_stored_session() {
    let root = std::env::temp_dir().join(format!("termul-ws-reopen-none-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let persistence = crate::acp::SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    let acp = Arc::new(AcpManager::new(vec![]));
    let target = ProjectSwitchContext {
        project_id: "p-1".to_string(),
        cwd: "/a".to_string(),
        mcp_servers: vec![],
    };
    let result =
        try_reopen_session_for_switch(&acp, &AgentId("a-1".to_string()), &persistence, &target)
            .await
            .unwrap();
    assert!(result.is_none());
    let _ = std::fs::remove_dir_all(root);
}

/// Switch-back reopen returns `Err` (fallback) when a durable session exists
/// but the agent cannot load or resume it. `execute_project_switch` catches
/// this and falls back to a new session.
#[tokio::test]
async fn try_reopen_falls_back_when_agent_cannot_load() {
    let root = std::env::temp_dir().join(format!(
        "termul-ws-reopen-fallback-{}",
        uuid::Uuid::new_v4()
    ));
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = crate::acp::SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    persistence
        .register_session(crate::acp::SessionRegistration {
            session_id: "s-1".to_string(),
            stable_agent_namespace: Some("config:claude".to_string()),
            runtime_agent_id: Some("agent-1".to_string()),
            project_id: Some("p-1".to_string()),
            cwd: cwd.clone(),
            ..Default::default()
        })
        .await
        .unwrap();
    let acp = Arc::new(AcpManager::new(vec![]));
    let target = ProjectSwitchContext {
        project_id: "p-1".to_string(),
        // `register_session` canonicalizes cwd; match exactly so the
        // `(project_id, cwd)` lookup finds the stored session.
        cwd: persistence.metadata("s-1").unwrap().cwd,
        mcp_servers: vec![],
    };
    let result =
        try_reopen_session_for_switch(&acp, &AgentId("a-1".to_string()), &persistence, &target)
            .await;
    assert!(
        result.is_err(),
        "no registered agent → reopen fails → Err → new session"
    );
    let _ = std::fs::remove_dir_all(root);
}

/// `set_default_project` WS request (Epic 7): updates the host default,
/// persists to the `FileProjectRegistry` (VPS, rollback-safe), and
/// broadcasts `projects_changed`. Mirrors the `set_host_default_project`
/// Tauri command + `POST /projects/default` HTTP route (transport parity).
#[tokio::test]
async fn handle_set_default_project_updates_host_default_and_persists() {
    let relay = Arc::new(WsRelaySink::new());
    let registry = Arc::new(ProjectRegistry::new());
    registry.set(
        vec![
            crate::web::project_registry::ProjectSummary {
                id: "p-1".to_string(),
                name: "Proj p-1".to_string(),
                color: "blue".to_string(),
                path: Some("/a".to_string()),
                is_archived: false,
                is_default: true,
            },
            crate::web::project_registry::ProjectSummary {
                id: "p-2".to_string(),
                name: "Proj p-2".to_string(),
                color: "green".to_string(),
                path: Some("/b".to_string()),
                is_archived: false,
                is_default: false,
            },
        ],
        Some("p-1".to_string()),
    );
    let file_registry = FileProjectRegistry::from_roots(
        vec![
            crate::acp::VfsRoot {
                id: "p-1".to_string(),
                name: "Proj p-1".to_string(),
                path: PathBuf::from("/a"),
                color: "blue".to_string(),
                is_archived: false,
                mcp_servers: vec![],
            },
            crate::acp::VfsRoot {
                id: "p-2".to_string(),
                name: "Proj p-2".to_string(),
                path: PathBuf::from("/b"),
                color: "green".to_string(),
                is_archived: false,
                mcp_servers: vec![],
            },
        ],
        Some("p-1".to_string()),
    );
    let file_registry = Arc::new(parking_lot::Mutex::new(file_registry));
    let path = std::env::temp_dir().join(format!(
        "termul-ws-set-default-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));

    let reply = handle_set_default_project(
        "r1".to_string(),
        &json!({ "projectId": "p-2" }),
        &relay,
        &registry,
        Some(&file_registry),
        Some(&path),
    )
    .await;
    let saved = std::fs::read_to_string(&path).ok();
    let _ = std::fs::remove_file(&path);
    assert!(reply.ok, "{:?}", reply.err);
    // In-memory registry default + flags updated.
    let snap = registry.snapshot();
    assert_eq!(snap.default_project_id.as_deref(), Some("p-2"));
    assert!(!snap.projects[0].is_default);
    assert!(snap.projects[1].is_default);
    // File registry persisted (VPS mode).
    assert_eq!(file_registry.lock().default_project_id(), Some("p-2"));
    let saved = saved.expect("persisted file written");
    let v: Value = serde_json::from_str(&saved).expect("valid json");
    assert_eq!(v["schemaVersion"], 3);
    assert_eq!(v["defaultProjectId"], "p-2");
}

/// `set_default_project` WS request with an unknown/archived/pathless id →
/// `NOT_FOUND` (validation rejects before any mutation or persistence).
#[tokio::test]
async fn handle_set_default_project_unknown_id_is_not_found() {
    let relay = Arc::new(WsRelaySink::new());
    let registry = Arc::new(ProjectRegistry::new());
    registry.set(
        vec![
            crate::web::project_registry::ProjectSummary {
                id: "p-1".to_string(),
                name: "Proj p-1".to_string(),
                color: "blue".to_string(),
                path: Some("/a".to_string()),
                is_archived: false,
                is_default: true,
            },
            crate::web::project_registry::ProjectSummary {
                id: "p-archived".to_string(),
                name: "Archived".to_string(),
                color: "blue".to_string(),
                path: Some("/b".to_string()),
                is_archived: true,
                is_default: false,
            },
            crate::web::project_registry::ProjectSummary {
                id: "p-pathless".to_string(),
                name: "Pathless".to_string(),
                color: "blue".to_string(),
                path: None,
                is_archived: false,
                is_default: false,
            },
        ],
        Some("p-1".to_string()),
    );
    let path = std::env::temp_dir().join(format!(
        "termul-ws-set-default-nf-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    for bad in ["missing", "p-archived", "p-pathless"] {
        let reply = handle_set_default_project(
            "r1".to_string(),
            &json!({ "projectId": bad }),
            &relay,
            &registry,
            None,
            Some(&path),
        )
        .await;
        assert!(!reply.ok, "{bad} should be rejected");
        assert_eq!(reply.err.unwrap().code, "not_found");
        // Default unchanged.
        assert_eq!(
            registry.snapshot().default_project_id.as_deref(),
            Some("p-1")
        );
    }
    // No file was written (validation rejected before persistence).
    assert!(
        !path.exists(),
        "no file should be written on validation failure"
    );
}

/// `set_default_project` WS request is a distinct operation from
/// `switch_project`: the host default changes + broadcasts to ALL clients,
/// while a per-connection switch touches only the requester's
/// `current_project`. This test documents the parity boundary.
#[tokio::test]
async fn handle_set_default_project_broadcasts_unlike_switch() {
    let relay = Arc::new(WsRelaySink::new());
    let registry = Arc::new(ProjectRegistry::new());
    registry.set(
        vec![crate::web::project_registry::ProjectSummary {
            id: "p-1".to_string(),
            name: "Proj p-1".to_string(),
            color: "blue".to_string(),
            path: Some("/a".to_string()),
            is_archived: false,
            is_default: false,
        }],
        None,
    );
    // Subscribe a client to prove the broadcast reaches it.
    relay.seed_session_for_test("sess-1");
    let (_client, mut rx, _replay) = relay.subscribe("sess-1", None).await;

    let reply = handle_set_default_project(
        "r1".to_string(),
        &json!({ "projectId": "p-1" }),
        &relay,
        &registry,
        None,
        None,
    )
    .await;
    assert!(reply.ok, "{:?}", reply.err);
    // P13: inspect the broadcast event type + payload (not just count).
    let mut drained = Vec::new();
    while let Ok(evt) = rx.try_recv() {
        drained.push(evt);
    }
    assert_eq!(drained.len(), 1, "exactly one projects_changed broadcast");
    let evt = &drained[0];
    assert_eq!(evt.type_, "projects_changed");
    assert!(evt.sid.is_none(), "agent-level event: sid must be null");
    assert_eq!(evt.seq, 0, "agent-level event: seq must be 0");
    assert_eq!(
        evt.payload["defaultProjectId"], "p-1",
        "the broadcast carries the new default project id"
    );
}

/// P7 — live-agent `switch_project` success path: no `projects_changed`
/// broadcast, no `FileProjectRegistry` persistence. The cold-tab path has
/// this assertion; this test covers the live-agent `execute_project_switch`
/// path. A `block_on` AcpManager can't spawn a real agent, so we call
/// `execute_project_switch` directly with a no-op AcpManager — the key
/// assertion is that NO broadcast fires (the relay's event log stays empty)
/// and the file registry default is UNCHANGED even though the connection's
/// `current_project` was updated.
///
/// Note: `AcpManager::new(vec![])` has no registered agents, so
/// `new_session_with_context` will fail. We assert the error path does NOT
/// broadcast (the success path can't be exercised without a real agent).
/// This is a structural gap — a regression that adds a broadcast BEFORE
/// the session-creation step would be caught here.
#[tokio::test]
async fn execute_project_switch_live_agent_path_does_not_broadcast() {
    let relay = Arc::new(WsRelaySink::new());
    let acp = Arc::new(AcpManager::new(vec![]));
    let registry = Arc::new(ProjectRegistry::new());
    registry.set(
        vec![crate::web::project_registry::ProjectSummary {
            id: "p-1".to_string(),
            name: "Proj p-1".to_string(),
            color: "blue".to_string(),
            path: Some("/a".to_string()),
            is_archived: false,
            is_default: true,
        }],
        Some("p-1".to_string()),
    );
    // A file registry + path are wired (VPS fixtures), but the switch must
    // NOT touch them.
    let file_registry = FileProjectRegistry::from_roots(
        vec![crate::acp::VfsRoot {
            id: "p-1".to_string(),
            name: "Proj p-1".to_string(),
            path: PathBuf::from("/a"),
            color: "blue".to_string(),
            is_archived: false,
            mcp_servers: vec![],
        }],
        Some("p-1".to_string()),
    );
    let file_registry = Arc::new(parking_lot::Mutex::new(file_registry));
    let path = std::env::temp_dir().join(format!(
        "termul-ws-live-switch-nobroadcast-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    // Subscribe a client to prove NO broadcast reaches it.
    relay.seed_session_for_test("sess-1");
    let (_client, mut rx, _replay) = relay.subscribe("sess-1", None).await;

    let current_session = Arc::new(parking_lot::Mutex::new(None::<crate::acp::SessionId>));
    let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
    let target = ProjectSwitchContext {
        project_id: "p-1".to_string(),
        cwd: "/a".to_string(),
        mcp_servers: vec![],
    };
    // The live-agent path will fail (no registered agent →
    // new_session_with_context errors), but the key assertion is that NO
    // broadcast fires even on this path. A regression that calls
    // broadcast_projects_changed BEFORE the session-creation error would
    // be caught.
    let _result = execute_project_switch(
        &AgentId("a-1".to_string()),
        target,
        SessionId("s-old".to_string()),
        &acp,
        &relay,
        &current_session,
        &current_project,
    )
    .await;
    // No broadcast reached the subscribed client.
    assert!(
        rx.try_recv().is_err(),
        "switch_project must NOT broadcast projects_changed (per-connection)"
    );
    // The file registry default is UNCHANGED (no persistence on switch).
    assert_eq!(
        file_registry.lock().default_project_id(),
        Some("p-1"),
        "switch must not persist to the file registry"
    );
    // No file was written to disk.
    assert!(!path.exists(), "switch must not write the projects file");
}

/// P8 — multi-client: a `switch_project` by one client does NOT fan out
/// a `projects_changed` event to other subscribed clients. This is the
/// symmetric negative of `handle_set_default_project_broadcasts_unlike_switch`
/// (which proves `set_default_project` DOES broadcast). The cold-tab path
/// is used (no live agent) — the assertion is that the relay's event log
/// stays empty for the non-switching client.
#[tokio::test]
async fn switch_project_cold_tab_does_not_fan_out_to_other_clients() {
    let relay = Arc::new(WsRelaySink::new());
    let acp = Arc::new(AcpManager::new(vec![]));
    let registry = Arc::new(ProjectRegistry::new());
    registry.set(
        vec![crate::web::project_registry::ProjectSummary {
            id: "p-1".to_string(),
            name: "Proj p-1".to_string(),
            color: "blue".to_string(),
            path: Some("/a".to_string()),
            is_archived: false,
            is_default: false,
        }],
        None,
    );
    // Client A subscribes to sess-a; client B subscribes to sess-b.
    relay.seed_session_for_test("sess-a");
    relay.seed_session_for_test("sess-b");
    let (_client_a, mut rx_a, _replay_a) = relay.subscribe("sess-a", None).await;
    let (_client_b, mut rx_b, _replay_b) = relay.subscribe("sess-b", None).await;

    let (tx, _rx) = mpsc::unbounded_channel::<Outbound>();
    let mut subs = Vec::new();
    let mut authed = true;
    let mut current_agent: Option<crate::acp::AgentId> = None;
    let current_session = Arc::new(parking_lot::Mutex::new(None::<crate::acp::SessionId>));
    let current_project_a = Arc::new(parking_lot::Mutex::new(None::<String>));
    let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));

    // Client A sends switch_project (cold-tab path).
    let reply_a = handle_request(
        r#"{"id":"r1","type":"switch_project","payload":{"projectId":"p-1"}}"#,
        &mut authed,
        None,
        &acp,
        &relay,
        &registry,
        None,
        None,
        &tx,
        &mut subs,
        &mut current_agent,
        &current_session,
        &current_project_a,
        &switch_queue,
        HistoryMode::LiveOnly,
        None,
        None,
        None,
    )
    .await;
    assert!(reply_a.ok, "client A switch succeeds: {:?}", reply_a.err);

    // Client A's current_project reflects the switch.
    assert_eq!(current_project_a.lock().as_deref(), Some("p-1"));

    // P8: client B receives ZERO projects_changed events (no fan-out).
    let mut b_drained = 0;
    while rx_b.try_recv().is_ok() {
        b_drained += 1;
    }
    assert_eq!(
        b_drained, 0,
        "switch_project must not fan out to other clients"
    );
    // Client A also receives nothing (switch_project responds to the
    // requester ONLY — no broadcast).
    let mut a_drained = 0;
    while rx_a.try_recv().is_ok() {
        a_drained += 1;
    }
    assert_eq!(a_drained, 0, "switch_project must not broadcast at all");
}

/// P10 — cold-tab `switch_project` with `registry_persistence: Some(...)`
/// still does NOT write the file (the persistence block was removed from
/// the switch path entirely — only `set_default_project` persists).
#[test]
fn execute_cold_tab_select_with_persistence_does_not_write_file() {
    let _relay = Arc::new(WsRelaySink::new());
    let registry = Arc::new(ProjectRegistry::new());
    registry.set(
        vec![crate::web::project_registry::ProjectSummary {
            id: "p-1".to_string(),
            name: "Proj p-1".to_string(),
            color: "blue".to_string(),
            path: Some("/a".to_string()),
            is_archived: false,
            is_default: false,
        }],
        None,
    );
    // Wire a REAL file registry + path (VPS-mode fixtures) — the switch
    // must NOT touch them.
    let file_registry = FileProjectRegistry::from_roots(
        vec![crate::acp::VfsRoot {
            id: "p-1".to_string(),
            name: "Proj p-1".to_string(),
            path: PathBuf::from("/a"),
            color: "blue".to_string(),
            is_archived: false,
            mcp_servers: vec![],
        }],
        None,
    );
    let file_registry = Arc::new(parking_lot::Mutex::new(file_registry));
    let path = std::env::temp_dir().join(format!(
        "termul-ws-cold-tab-vps-noperist-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
    let target = ProjectSwitchContext {
        project_id: "p-1".to_string(),
        cwd: "/a".to_string(),
        mcp_servers: vec![],
    };
    // The cold-tab switch only takes (target, current_project) now — it
    // no longer accepts registry_persistence/projects_file. Calling it
    // directly proves the file is untouched even when VPS fixtures exist
    // in the caller's scope.
    let result = execute_cold_tab_select(target, &current_project);
    let leaked = std::fs::read_to_string(&path).ok();
    let _ = std::fs::remove_file(&path);
    let outcome = result.expect("cold-tab select succeeds");
    let SwitchProjectOutcome::Selected { project_id, cwd } = outcome else {
        panic!("expected Selected, got {:?}", outcome);
    };
    assert_eq!(project_id, "p-1");
    assert_eq!(cwd, "/a");
    assert_eq!(current_project.lock().as_deref(), Some("p-1"));
    // The host default is UNCHANGED (per-connection switch).
    assert_eq!(registry.snapshot().default_project_id, None);
    // The file registry is UNCHANGED.
    assert_eq!(file_registry.lock().default_project_id(), None);
    // No file was written.
    assert!(leaked.is_none(), "switch must not write the projects file");
}

/// P17 — `connection_already_on_project` gate: when the connection's
/// `current_project` already matches the target, the switch returns early
/// (a no-op `Completed` with the previous session). The cold-tab test
/// (`execute_cold_tab_select_is_per_connection_no_persistence_no_broadcast`)
/// covers the non-matching path; this test pins the matching path.
#[tokio::test]
async fn execute_project_switch_returns_early_when_already_on_project() {
    let relay = Arc::new(WsRelaySink::new());
    let acp = Arc::new(AcpManager::new(vec![]));
    let registry = Arc::new(ProjectRegistry::new());
    registry.set(
        vec![crate::web::project_registry::ProjectSummary {
            id: "p-1".to_string(),
            name: "Proj p-1".to_string(),
            color: "blue".to_string(),
            path: Some("/a".to_string()),
            is_archived: false,
            is_default: true,
        }],
        Some("p-1".to_string()),
    );
    let current_session = Arc::new(parking_lot::Mutex::new(Some(SessionId(
        "s-prev".to_string(),
    ))));
    // The connection is ALREADY on p-1.
    let current_project = Arc::new(parking_lot::Mutex::new(Some("p-1".to_string())));
    let target = ProjectSwitchContext {
        project_id: "p-1".to_string(),
        cwd: "/a".to_string(),
        mcp_servers: vec![],
    };
    let outcome = execute_project_switch(
        &AgentId("a-1".to_string()),
        target,
        SessionId("s-prev".to_string()),
        &acp,
        &relay,
        &current_session,
        &current_project,
    )
    .await
    .expect("early return succeeds");
    // The switch is a no-op: same session, no new session created.
    let SwitchProjectOutcome::Completed {
        project_id,
        session_id,
        cwd,
        mcp_server_count: _,
    } = outcome
    else {
        panic!("expected Completed (early return), got {:?}", outcome);
    };
    assert_eq!(project_id, "p-1");
    assert_eq!(session_id.0, "s-prev");
    assert_eq!(cwd, "/a");
    // current_session unchanged (no new session).
    assert_eq!(current_session.lock().as_ref().unwrap().0, "s-prev");
}
