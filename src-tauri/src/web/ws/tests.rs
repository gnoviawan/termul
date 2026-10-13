#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;
use crate::acp::{AgentId, SpawnOutcome};
use crate::web::permissions::{PermissionRendezvous, QuestionRendezvous, TurnClaim};
use std::collections::HashSet;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

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

#[tokio::test]
async fn connection_cleanup_unregisters_once_after_writer_first_shutdown() {
    let relay = Arc::new(WsRelaySink::new());
    let acp = Arc::new(AcpManager::new(vec![]));
    let permissions = Arc::new(PermissionRendezvous::new(Arc::clone(&acp)));
    let questions = Arc::new(QuestionRendezvous::new(acp));
    relay.set_rendezvous(Arc::clone(&permissions));
    relay.set_question_rendezvous(Arc::clone(&questions));
    relay.seed_session_for_test("session-cleanup");
    let (client_id, _rx, replay, _) = relay.subscribe("session-cleanup", None, None, &CancellationToken::new()).await;
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
    let subscribed = subscriptions_with("session-cleanup", client_id);
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
                && subscribed.is_empty()
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("subscriptions cleaned up after connection cleanup");
    // The last subscriber is gone, but a pending approval or question belongs
    // to the session, not to a connection: it stays answerable.
    assert!(permissions.is_outstanding("permission-cleanup"));
    assert!(questions.is_outstanding("question-cleanup"));
}

#[tokio::test]
async fn connection_cleanup_runs_when_relay_future_is_cancelled() {
    let relay = Arc::new(WsRelaySink::new());
    relay.seed_session_for_test("session-cancelled-relay");
    let (client_id, _rx, replay, _) = relay.subscribe("session-cancelled-relay", None, None, &CancellationToken::new()).await;
    assert!(matches!(replay, ReplayResult::Ok(0)));
    let subscribed = subscriptions_with("session-cancelled-relay", client_id);

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
    assert!(subscribed.is_empty());
}

/// A flooding connection past the in-flight cap is refused with a code the
/// client does not read as "a prompt turn is in progress" (`rate_limited`).
#[tokio::test]
async fn requests_past_the_inflight_cap_are_refused_without_rate_limited() {
    let relay = Arc::new(WsRelaySink::new());
    let acp = Arc::new(AcpManager::new(vec![]));
    let registry = Arc::new(ProjectRegistry::new());
    let (tx, mut rx) = test_outbound();
    let mut conn = ConnState::authenticated(test_access());
    let exec = KeyedExecutor::new(CancellationToken::new());
    for _ in 0..MAX_INFLIGHT_REQUESTS {
        exec.submit(None, std::future::pending::<()>()).expect("under the cap");
    }

    let env = test_env(&acp, &relay, &registry, &tx, &conn.subscriptions);
    let alive = dispatch_connection_text(
        r#"{"id":"flood","type":"ping","payload":{}}"#,
        &mut conn,
        &env,
        &exec,
    )
    .await;
    assert!(alive, "a refused request does not close the connection");
    let Some(Outbound::Reply(reply)) = rx.recv().await else {
        panic!("expected a reply frame");
    };
    assert!(!reply.ok);
    let err = reply.err.expect("error");
    assert_eq!(err.code, "unsupported");
    assert_ne!(err.code, "rate_limited");
    assert!(err.message.contains("too many requests"), "{}", err.message);
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
    let (tx, mut rx) = test_outbound();
    let subscriptions = Arc::new(Subscriptions::default());
    let mut conn = ConnState::authenticated(test_access());
    conn.subscriptions = Arc::clone(&subscriptions);
    let exec = KeyedExecutor::new(CancellationToken::new());
    assert!(
            dispatch_connection_text(r#"{"id":"prompt-long","type":"send_prompt","payload":{"agentId":"agent-long","sessionId":"session-long","text":"long","turnId":"turn-long"}}"#, &mut conn, &test_env(&acp, &relay, &registry, &tx, &subscriptions), &exec)
            .await
        );

    tokio::time::timeout(Duration::from_secs(1), entered)
        .await
        .expect("prompt reached agent gate")
        .expect("prompt gate signal");

    tokio::time::timeout(Duration::from_millis(100), async {
        dispatch_connection_text(r#"{"id":"ping-1","type":"ping","payload":{}}"#, &mut conn, &test_env(&acp, &relay, &registry, &tx, &subscriptions), &exec)
        .await
    })
    .await
    .expect("ping remains processable during prompt");
    let ping = match rx.recv().await.expect("ping reply") {
        Outbound::Reply(reply) => reply,
        Outbound::Event(_) | Outbound::Gap(_) | Outbound::Watch(_) | Outbound::Close(_) => panic!("expected ping reply"),
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

    // Same turnId resent while the turn is running (a dropped reply): a
    // receipt, never rate_limited.
    let resend_in_flight = handle_send_prompt(
        "prompt-resend".to_string(),
        &json!({
            "agentId": "agent-long",
            "sessionId": "session-long",
            "text": "long",
            "turnId": "turn-long"
        }),
        &acp,
        &relay,
    )
    .await;
    assert!(resend_in_flight.ok, "{:?}", resend_in_flight.err);
    assert_eq!(
        resend_in_flight.payload,
        Some(json!({"receipt": "in_progress"}))
    );

    let _ = release.send(());
    let completed = match rx.recv().await.expect("prompt reply") {
        Outbound::Reply(reply) => reply,
        Outbound::Event(_) | Outbound::Gap(_) | Outbound::Watch(_) | Outbound::Close(_) => panic!("expected prompt reply"),
    };
    assert!(completed.ok);
    assert_eq!(completed.id, "prompt-long");
    assert_eq!(completed.payload, Some(json!("end_turn")));

    // Same turnId after completion: `accepted`, never stale.
    let resend_done = handle_send_prompt(
        "prompt-done-resend".to_string(),
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
    assert!(resend_done.ok, "{:?}", resend_done.err);
    assert_eq!(resend_done.payload, Some(json!({"receipt": "accepted"})));

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
    let (tx, mut rx) = test_outbound();
    let subscriptions = Arc::new(Subscriptions::default());
    let mut conn = ConnState::authenticated(test_access());
    conn.subscriptions = Arc::clone(&subscriptions);
    let exec = KeyedExecutor::new(CancellationToken::new());

    assert!(
            dispatch_connection_text(r#"{"id":"prompt-ordered","type":"send_prompt","payload":{"agentId":"agent-ordered-cancel","sessionId":"session-ordered-cancel","text":"start then cancel","turnId":"turn-ordered"}}"#, &mut conn, &test_env(&acp, &relay, &registry, &tx, &subscriptions), &exec)
            .await
        );
    assert!(
            dispatch_connection_text(r#"{"id":"cancel-ordered","type":"cancel_prompt","payload":{"agentId":"agent-ordered-cancel","sessionId":"session-ordered-cancel"}}"#, &mut conn, &test_env(&acp, &relay, &registry, &tx, &subscriptions), &exec)
            .await
        );
    entered
        .await
        .expect("prompt was accepted before cancellation");

    let first = match rx.recv().await.expect("first reply") {
        Outbound::Reply(reply) => reply,
        Outbound::Event(_) | Outbound::Gap(_) | Outbound::Watch(_) | Outbound::Close(_) => panic!("expected reply"),
    };
    let second = match rx.recv().await.expect("second reply") {
        Outbound::Reply(reply) => reply,
        Outbound::Event(_) | Outbound::Gap(_) | Outbound::Watch(_) | Outbound::Close(_) => panic!("expected reply"),
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
    let (tx, rx) = test_outbound();
    let subscriptions = Arc::new(Subscriptions::default());
    let registry = Arc::new(ProjectRegistry::new());
    let mut conn = ConnState::authenticated(test_access());
    conn.subscriptions = Arc::clone(&subscriptions);
    let exec = KeyedExecutor::new(CancellationToken::new());

    assert!(
            dispatch_connection_text(r#"{"id":"prompt-resume","type":"send_prompt","payload":{"agentId":"agent-resume","sessionId":"session-resume","text":"continue after disconnect","turnId":"turn-resume"}}"#, &mut conn, &HandlerEnv { history_mode: HistoryMode::Server, ..test_env(&acp, &relay, &registry, &tx, &subscriptions) }, &exec)
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

    let (_client_id, _events, reconnect_replay, _) = relay.subscribe("session-resume", Some(0), None, &CancellationToken::new()).await;
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
    let (tx, _rx) = test_outbound();
    let subs = Arc::new(Subscriptions::default());
    let registry = Arc::new(ProjectRegistry::new());
    route(text, &HandlerEnv { acp_catalog: Some(catalog.clone()), ..test_env(&acp, &relay, &registry, &tx, &subs) })
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
    let (tx, _rx) = test_outbound();
    let subs = Arc::new(Subscriptions::default());
    let registry = Arc::new(ProjectRegistry::new());
    route(text, &test_env(&acp, &relay, &registry, &tx, &subs))
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

// ---- Issue #613 / #1073: server-side generic key-value store WS handlers ----

fn store_identity(device: &str) -> Arc<std::sync::OnceLock<ClientIdentity>> {
    let identity = Arc::new(std::sync::OnceLock::new());
    let _ = identity.set(ClientIdentity {
        device_id: device.to_string(),
        client_instance_id: format!("tab-{device}"),
    });
    identity
}

fn open_store(label: &str) -> (Arc<WebStore>, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("termul-ws-store-{label}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let store = WebStore::open(dir.join("store.json"), crate::web::store::StorePolicy::default()).unwrap();
    (Arc::new(store), dir)
}

/// Dispatch `text` through `route_request` with a real `WebStore` attached,
/// as device `dev-a`.
async fn handle_request_with_store(text: &str, store: &Arc<WebStore>) -> WsReply {
    let relay = Arc::new(WsRelaySink::new());
    let acp = Arc::new(AcpManager::new(vec![]));
    let (tx, _rx) = test_outbound();
    let subs = Arc::new(Subscriptions::default());
    let registry = Arc::new(ProjectRegistry::new());
    route(
        text,
        &HandlerEnv {
            store: Some(store.clone()),
            identity: store_identity("dev-a"),
            ..test_env(&acp, &relay, &registry, &tx, &subs)
        },
    )
    .await
}

#[tokio::test]
async fn store_write_then_read_roundtrips_with_a_stamp() {
    let (store, dir) = open_store("roundtrip");
    let write = handle_request_with_store(
        r#"{"id":"r1","type":"store_write","payload":{"key":"device/dev-a/settings","value":{"theme":"dark"}}}"#,
        &store,
    )
    .await;
    assert!(write.ok, "write ok: {:?}", write.err);
    assert_eq!(write.payload, Some(json!({ "revision": 1 })));

    let read = handle_request_with_store(
        r#"{"id":"r2","type":"store_read","payload":{"key":"device/dev-a/settings"}}"#,
        &store,
    )
    .await;
    assert_eq!(
        read.payload,
        Some(json!({ "value": { "theme": "dark" }, "revision": 1, "clientInstanceId": "tab-dev-a" }))
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn store_read_missing_key_is_revision_zero_with_a_null_value() {
    let (store, dir) = open_store("miss");
    let reply = handle_request_with_store(
        r#"{"id":"r1","type":"store_read","payload":{"key":"device/dev-a/nope"}}"#,
        &store,
    )
    .await;
    assert!(reply.ok, "missing key is not an error: {:?}", reply.err);
    assert_eq!(
        reply.payload,
        Some(json!({ "value": null, "revision": 0, "clientInstanceId": null }))
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn store_delete_removes_and_reports_existed() {
    let (store, dir) = open_store("del");
    handle_request_with_store(
        r#"{"id":"w","type":"store_write","payload":{"key":"device/dev-a/k","value":"v"}}"#,
        &store,
    )
    .await;
    for (id, existed) in [("r1", true), ("r2", false)] {
        let del = handle_request_with_store(
            &format!(r#"{{"id":"{id}","type":"store_delete","payload":{{"key":"device/dev-a/k"}}}}"#),
            &store,
        )
        .await;
        assert!(del.ok, "delete ok: {:?}", del.err);
        assert_eq!(del.payload, Some(json!({ "existed": existed })));
    }
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
    let (store, dir) = open_store("empty");
    for frame in [
        r#"{"id":"r1","type":"store_read","payload":{"key":""}}"#,
        r#"{"id":"r2","type":"store_write","payload":{"key":"","value":1}}"#,
        r#"{"id":"r3","type":"store_delete","payload":{"key":""}}"#,
        r#"{"id":"r4","type":"store_write","payload":{"key":"   ","value":1}}"#,
    ] {
        let reply = handle_request_with_store(frame, &store).await;
        assert!(!reply.ok, "empty-key {frame} must fail");
        assert_eq!(reply.err.as_ref().unwrap().code, "VALIDATION_ERROR", "{frame}");
    }

    // Over-long key (> 1024 bytes): same VALIDATION_ERROR on all three ops.
    let long_key = "k".repeat(1025);
    for frame in [
        format!(r#"{{"id":"l1","type":"store_read","payload":{{"key":"{long_key}"}}}}"#),
        format!(r#"{{"id":"l2","type":"store_write","payload":{{"key":"{long_key}","value":1}}}}"#),
        format!(r#"{{"id":"l3","type":"store_delete","payload":{{"key":"{long_key}"}}}}"#),
    ] {
        let reply = handle_request_with_store(&frame, &store).await;
        assert!(!reply.ok, "over-long-key {frame} must fail");
        assert_eq!(reply.err.as_ref().unwrap().code, "VALIDATION_ERROR", "{frame}");
        assert_eq!(reply.err.as_ref().unwrap().message, "key too long", "{frame}");
    }
    assert!(!dir.join("store.json").exists(), "a refused request never writes the file");
    let _ = std::fs::remove_dir_all(dir);
}

/// CAP-11: a serialized value over 256 KiB is rejected with
/// `STORE_VALUE_TOO_LARGE` before reaching the store; exactly 256 KiB is
/// accepted (the check is strictly-greater).
#[tokio::test]
async fn store_write_rejects_value_over_256kib() {
    let (store, dir) = open_store("big");
    // 256 KiB + 1 char of string content → serialized size 256 KiB + 3
    // bytes (quotes) → over the cap.
    let oversized = "x".repeat(256 * 1024 + 1);
    let frame = format!(
        r#"{{"id":"r1","type":"store_write","payload":{{"key":"device/dev-a/big","value":"{oversized}"}}}}"#
    );
    let reply = handle_request_with_store(&frame, &store).await;
    assert!(!reply.ok, "oversized value must fail");
    assert_eq!(reply.err.as_ref().unwrap().code, "STORE_VALUE_TOO_LARGE");
    assert!(!dir.join("store.json").exists(), "the file is untouched");

    // Boundary: content sized so the serialized value is exactly 256 KiB
    // (262142 chars + 2 quote bytes) is accepted.
    let exact = "x".repeat(256 * 1024 - 2);
    let frame = format!(
        r#"{{"id":"r2","type":"store_write","payload":{{"key":"device/dev-a/big","value":"{exact}"}}}}"#
    );
    let reply = handle_request_with_store(&frame, &store).await;
    assert!(reply.ok, "exactly-256-KiB value is accepted: {:?}", reply.err);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn store_malformed_payload_returns_validation_error() {
    let (store, dir) = open_store("bad");
    for frame in [
        // Missing `key`.
        r#"{"id":"r1","type":"store_read","payload":{}}"#,
        // store_write without a `value`.
        r#"{"id":"r2","type":"store_write","payload":{"key":"device/dev-a/k"}}"#,
        // A flat-protocol field the scoped store does not know.
        r#"{"id":"r3","type":"store_write","payload":{"key":"device/dev-a/k","value":1,"unknown":true}}"#,
        r#"{"id":"r4","type":"store_write","payload":{"key":"device/dev-a/k","value":1,"baseRevision":-1}}"#,
    ] {
        let reply = handle_request_with_store(frame, &store).await;
        assert!(!reply.ok, "{frame}");
        assert_eq!(reply.err.as_ref().unwrap().code, "VALIDATION_ERROR", "{frame}");
    }
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

/// A loopback, write-capable connection — what a standalone server's local
/// browser gets. Tests that need a view-only peer build their own policy.
pub(super) fn test_policy(peer: [u8; 4], allow_remote_writes: bool, shared_live_writes_denied: bool) -> CapabilityPolicy {
    CapabilityPolicy {
        carrier: Carrier::Ws,
        peer: SocketAddr::from((peer, 40000)),
        flags: crate::web::capabilities::WriteFlags {
            allow_remote_writes,
            shared_live_writes_denied,
        },
    }
}

pub(super) fn test_access() -> ConnectionAccess {
    ConnectionAccess::granted(test_policy([127, 0, 0, 1], false, false))
}

/// A bounded outbound queue sized like the connection's, for handler tests.
pub(super) fn test_outbound() -> (OutboundSender, OutboundReceiver) {
    outbound_channel(
        OUTBOUND_QUEUE_CAPACITY,
        crate::web::config::DEFAULT_OVERFLOW_TOLERANCE,
    )
}

/// Subscriptions already holding `client_id` for `session_id`.
fn subscriptions_with(session_id: impl AsRef<str>, client_id: ClientId) -> Arc<Subscriptions> {
    let subscriptions = Arc::new(Subscriptions::default());
    subscriptions.replace(session_id.as_ref(), &[], client_id);
    subscriptions
}

/// A handler environment over the given host pieces (no persistence, catalog,
/// install service or store); override fields with struct-update syntax.
pub(super) fn test_env(
    acp: &Arc<AcpManager>,
    relay: &Arc<WsRelaySink>,
    registry: &Arc<ProjectRegistry>,
    out_tx: &OutboundSender,
    subscriptions: &Arc<Subscriptions>,
) -> HandlerEnv {
    HandlerEnv {
        acp: Arc::clone(acp),
        relay: Arc::clone(relay),
        registry: Arc::clone(registry),
        pty: crate::web::test_pty_manager(),
        history_mode: HistoryMode::LiveOnly,
        acp_catalog: None,
        acp_install: None,
        store: None,
        identity: Arc::new(std::sync::OnceLock::new()),
        web_auth: None,
        out_tx: out_tx.clone(),
        subscriptions: Arc::clone(subscriptions),
        connection_id: ClientId::new(),
    }
}

/// Route one request frame to its handler, as an authenticated, write-capable
/// connection (the pre-auth gate and capability check run in
/// `dispatch_connection_text`, covered separately).
pub(super) async fn route(text: &str, env: &HandlerEnv) -> WsReply {
    route_request(serde_json::from_str(text).expect("request frame"), env).await
}

/// Ungated wrapper over `handle_sync_with_auth` (no web auth gate).
/// The no-op `AcpManager` (`vec![]` sinks) returns fast `Err`s for the ACP
/// command methods (no agent spawned) which the handlers map to
/// `WsErrorCode`; the generic tests use an empty registry + no
/// agent/session.
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
        &auth_frame("r1", Some("any")),
        &mut authed,
    );
    assert!(reply.ok);
    assert!(authed, "authenticate must flip authed");
}
/// Like `handle_sync` but with the web auth gate threaded through
/// (`Some(&gate)` = gated server; `None` = legacy ungated behavior).
fn handle_sync_with_auth(text: &str, authed: &mut bool, web_auth: Option<&Arc<WebAuth>>) -> WsReply {
    let mut identity = None;
    handle_sync_with_identity(text, authed, &mut identity, web_auth)
}

/// Like `handle_sync_with_auth` but exposes the per-connection identity
/// out-param so tests can assert what the handshake recorded.
fn handle_sync_with_identity(
    text: &str,
    authed: &mut bool,
    identity: &mut Option<ClientIdentity>,
    web_auth: Option<&Arc<WebAuth>>,
) -> WsReply {
    handle_sync_with_access(text, authed, identity, &mut test_access(), web_auth)
}

/// Like `handle_sync_with_identity` with an explicit per-connection access
/// (capabilities + presence) — the view-only matrix tests pass a restricted one.
pub(super) fn handle_sync_with_access(
    text: &str,
    authed: &mut bool,
    identity: &mut Option<ClientIdentity>,
    access: &mut ConnectionAccess,
    web_auth: Option<&Arc<WebAuth>>,
) -> WsReply {
    // A ledgered request type is stamped with a fresh `command_id`, like a client's.
    let text = crate::web::command_ledger::test_clock::stamp_ws_text(text);
    handle_sync_unstamped(&text, authed, identity, access, web_auth)
}

/// Dispatch `text` exactly as sent (no `command_id` is added): for the tests of
/// what the host does with a request that carries none.
fn handle_sync_unstamped(
    text: &str,
    authed: &mut bool,
    identity: &mut Option<ClientIdentity>,
    access: &mut ConnectionAccess,
    web_auth: Option<&Arc<WebAuth>>,
) -> WsReply {
    let relay = Arc::new(WsRelaySink::new());
    let acp = Arc::new(AcpManager::new(vec![]));
    let (tx, mut rx) = test_outbound();
    let registry = Arc::new(ProjectRegistry::new());
    let mut conn = ConnState::new(*access, Arc::new(Subscriptions::default()));
    conn.authed = *authed;
    if let Some(presented) = identity.take() {
        let _ = conn.identity.set(presented);
    }
    let env = HandlerEnv {
        web_auth: web_auth.cloned(),
        identity: Arc::clone(&conn.identity),
        ..test_env(&acp, &relay, &registry, &tx, &conn.subscriptions)
    };
    let reply = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(async {
            let exec = KeyedExecutor::new(CancellationToken::new());
            assert!(dispatch_connection_text(text, &mut conn, &env, &exec).await);
            match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
                Ok(Some(Outbound::Reply(reply))) => reply,
                _ => panic!("expected a reply frame"),
            }
        });
    *authed = conn.authed;
    *identity = conn.identity.get().cloned();
    *access = conn.access;
    reply
}

/// A `/ws` `authenticate` frame carrying a valid handshake (current
/// protocol version + fixed identity) and an optional token.
pub(super) fn auth_frame(id: &str, token: Option<&str>) -> String {
    let mut payload = json!({
        "protocolVersion": WS_PROTOCOL_VERSION,
        "deviceId": "device-a",
        "clientInstanceId": "tab-1",
    });
    if let Some(token) = token {
        payload["token"] = json!(token);
    }
    json!({"id": id, "type": "authenticate", "payload": payload}).to_string()
}

/// An `authenticate` frame with a caller-built payload.
fn auth_frame_with(id: &str, payload: Value) -> String {
    json!({"id": id, "type": "authenticate", "payload": payload}).to_string()
}

fn test_gate() -> Arc<WebAuth> {
    Arc::new(WebAuth::new(
        crate::web::auth::WebAuthToken::new("s3cret-token").expect("non-empty"),
    ))
}

#[test]
fn gated_authenticate_rejects_wrong_token() {
    // QA repro (P1): a wrong token on a gated server must NOT authenticate.
    let gate = test_gate();
    let mut authed = false;
    let reply = handle_sync_with_auth(
        &auth_frame("r1", Some("WRONG")),
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
        &auth_frame("r1", None),
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
        &auth_frame("r1", Some("s3cret-token")),
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
        &auth_frame("r1", Some("WRONG")),
        &mut authed,
        Some(&gate),
    );
    assert!(!wrong.ok);
    let right = handle_sync_with_auth(
        &auth_frame("r2", Some("s3cret-token")),
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
        &auth_frame("r1", Some("WRONG")),
        &mut authed,
        None,
    );
    assert!(reply.ok, "ungated server accepts any token");
    assert!(authed);
}

fn err_code(reply: &WsReply) -> &str {
    &reply.err.as_ref().expect("err present").code
}

#[test]
fn authenticate_success_records_identity_and_reports_protocol_version() {
    let mut authed = false;
    let mut identity = None;
    let reply = handle_sync_with_identity(
        &auth_frame("r1", Some("any")),
        &mut authed,
        &mut identity,
        None,
    );
    assert!(reply.ok);
    assert!(authed);
    assert_eq!(
        identity,
        Some(ClientIdentity {
            device_id: "device-a".to_string(),
            client_instance_id: "tab-1".to_string(),
        })
    );
    let payload = reply.payload.expect("auth reply payload");
    assert_eq!(payload["protocolVersion"], json!(WS_PROTOCOL_VERSION));
    assert!(payload.get("historyMode").is_some());
    assert!(payload.get("runtimePolicy").is_some());
}

#[test]
fn authenticate_version_missing_or_wrong_is_refused_pre_auth() {
    for gate in [None, Some(test_gate())] {
        for payload in [
            json!({"deviceId": "d", "clientInstanceId": "c", "token": "s3cret-token"}),
            json!({"protocolVersion": 0, "deviceId": "d", "clientInstanceId": "c", "token": "s3cret-token"}),
            json!({"protocolVersion": WS_PROTOCOL_VERSION + 1, "deviceId": "d", "clientInstanceId": "c", "token": "s3cret-token"}),
            json!({"protocolVersion": "1", "deviceId": "d", "clientInstanceId": "c", "token": "s3cret-token"}),
            json!({"protocolVersion": null, "deviceId": "d", "clientInstanceId": "c", "token": "s3cret-token"}),
        ] {
            let mut authed = false;
            let mut identity = None;
            let reply = handle_sync_with_identity(
                &auth_frame_with("r1", payload.clone()),
                &mut authed,
                &mut identity,
                gate.as_ref(),
            );
            assert!(!reply.ok, "{payload}");
            assert_eq!(err_code(&reply), "protocol_version_mismatch", "{payload}");
            assert!(!authed, "mismatch must stay pre-auth: {payload}");
            assert!(identity.is_none(), "mismatch must not record identity");
        }
    }
}

#[test]
fn authenticate_bad_identity_is_refused_pre_auth() {
    let oversized = "x".repeat(MAX_CLIENT_ID_LEN + 1);
    // 65 two-byte characters: 65 chars but 130 bytes — the limit is in bytes.
    let oversized_bytes = "\u{e9}".repeat(MAX_CLIENT_ID_LEN / 2 + 1);
    let cases = [
        json!({"protocolVersion": WS_PROTOCOL_VERSION, "deviceId": oversized_bytes, "clientInstanceId": "c"}),
        // Control characters could forge log lines.
        json!({"protocolVersion": WS_PROTOCOL_VERSION, "deviceId": "d\nforged log line", "clientInstanceId": "c"}),
        json!({"protocolVersion": WS_PROTOCOL_VERSION, "deviceId": "d", "clientInstanceId": "c\u{7}"}),
        json!({"protocolVersion": WS_PROTOCOL_VERSION, "clientInstanceId": "c"}),
        json!({"protocolVersion": WS_PROTOCOL_VERSION, "deviceId": "", "clientInstanceId": "c"}),
        json!({"protocolVersion": WS_PROTOCOL_VERSION, "deviceId": 7, "clientInstanceId": "c"}),
        json!({"protocolVersion": WS_PROTOCOL_VERSION, "deviceId": oversized, "clientInstanceId": "c"}),
        json!({"protocolVersion": WS_PROTOCOL_VERSION, "deviceId": "d"}),
        json!({"protocolVersion": WS_PROTOCOL_VERSION, "deviceId": "d", "clientInstanceId": ""}),
        json!({"protocolVersion": WS_PROTOCOL_VERSION, "deviceId": "d", "clientInstanceId": ["c"]}),
        json!({"protocolVersion": WS_PROTOCOL_VERSION, "deviceId": "d", "clientInstanceId": oversized}),
    ];
    for payload in cases {
        let mut authed = false;
        let mut identity = None;
        let reply = handle_sync_with_identity(
            &auth_frame_with("r1", payload.clone()),
            &mut authed,
            &mut identity,
            None,
        );
        assert!(!reply.ok, "{payload}");
        assert_eq!(err_code(&reply), "invalid_client_identity", "{payload}");
        assert!(!authed);
        assert!(identity.is_none());
    }
}

#[test]
fn authenticate_accepts_identity_at_the_length_limit_verbatim() {
    let max = "é".repeat(MAX_CLIENT_ID_LEN / 2);
    assert_eq!(max.len(), MAX_CLIENT_ID_LEN);
    let mut authed = false;
    let mut identity = None;
    let reply = handle_sync_with_identity(
        &auth_frame_with(
            "r1",
            json!({"protocolVersion": WS_PROTOCOL_VERSION, "deviceId": max, "clientInstanceId": " tab "}),
        ),
        &mut authed,
        &mut identity,
        None,
    );
    assert!(reply.ok);
    let identity = identity.expect("identity recorded");
    assert_eq!(identity.device_id, max);
    assert_eq!(identity.client_instance_id, " tab ", "ids stored as received");
}

#[test]
fn authenticate_checks_version_then_identity_then_token() {
    let gate = test_gate();
    // Wrong token AND bad version: the stale tab hears about the version.
    let mut authed = false;
    let reply = handle_sync_with_auth(
        &auth_frame_with(
            "r1",
            json!({"deviceId": "", "clientInstanceId": "", "token": "WRONG"}),
        ),
        &mut authed,
        Some(&gate),
    );
    assert_eq!(err_code(&reply), "protocol_version_mismatch");
    // The version-mismatch refusal never echoes the presented token.
    let mismatch_serialized = serde_json::to_string(&reply).expect("serialize");
    assert!(!mismatch_serialized.contains("WRONG"));
    // Valid version, bad identity, wrong token: identity beats token.
    let reply = handle_sync_with_auth(
        &auth_frame_with(
            "r2",
            json!({"protocolVersion": WS_PROTOCOL_VERSION, "deviceId": "", "clientInstanceId": "c", "token": "WRONG"}),
        ),
        &mut authed,
        Some(&gate),
    );
    assert_eq!(err_code(&reply), "invalid_client_identity");
    // Valid handshake, wrong token: unchanged unauthorized.
    let reply = handle_sync_with_auth(&auth_frame("r3", Some("WRONG")), &mut authed, Some(&gate));
    assert_eq!(err_code(&reply), "unauthorized");
    assert!(!authed);
    // The unauthorized refusal never echoes the presented token either.
    let serialized = serde_json::to_string(&reply).expect("serialize");
    assert!(!serialized.contains("WRONG"));
}

#[test]
fn post_auth_authenticate_is_idempotent_ok_without_revalidation() {
    let mut authed = true;
    let reply = handle_sync(r#"{"id":"r1","type":"authenticate","payload":{}}"#, &mut authed);
    assert!(reply.ok);
    assert!(authed);
}

#[test]
fn ws_error_code_wire_strings_for_handshake_capability_and_reserved_codes() {
    for (code, wire) in [
        (WsErrorCode::ProtocolVersionMismatch, "protocol_version_mismatch"),
        (WsErrorCode::InvalidClientIdentity, "invalid_client_identity"),
        (WsErrorCode::TerminalLimit, "terminal_limit"),
        (WsErrorCode::ProjectBusy, "project_busy"),
        (WsErrorCode::OutcomeUnknown, "outcome_unknown"),
        (WsErrorCode::DestructiveOpBlocked, "destructive_op_blocked"),
        (WsErrorCode::ProviderQuotaExceeded, "provider_quota_exceeded"),
        (WsErrorCode::ProviderSessionLimit, "provider_session_limit"),
        (WsErrorCode::ProviderRequestRejected, "provider_request_rejected"),
        (WsErrorCode::Forbidden, "forbidden"),
        (WsErrorCode::AlreadyResolved, "already_resolved"),
    ] {
        assert_eq!(code.as_str(), wire);
    }
}

#[test]
fn ws_request_parses_command_id_and_reply_skips_unset_visible_at() {
    let with: WsRequest = serde_json::from_str(
        r#"{"id":"r1","type":"write","payload":{},"command_id":"cmd-1"}"#,
    )
    .expect("parse");
    assert_eq!(with.command_id.as_deref(), Some("cmd-1"));
    let without: WsRequest =
        serde_json::from_str(r#"{"id":"r1","type":"ping","payload":{}}"#).expect("parse");
    assert_eq!(without.command_id, None);

    let plain = serde_json::to_value(WsReply::ok("r1", None)).expect("serialize");
    assert!(plain.get("visible_at").is_none());
    let mut stamped = WsReply::ok("r1", None);
    stamped.visible_at = Some(json!(42));
    let stamped = serde_json::to_value(&stamped).expect("serialize");
    assert_eq!(stamped["visible_at"], json!(42));
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
    // `set_config_option`. Unknown types, and the removed legacy
    // `switch_project`, stay `not_implemented`.
    for ty in ["totally_unknown_type", "switch_project"] {
        let reply = handle_sync(
            &format!(r#"{{"id":"r1","type":"{ty}","payload":{{}}}}"#),
            &mut authed,
        );
        assert!(!reply.ok, "{ty} should be not_implemented");
        assert_eq!(reply.err.unwrap().code, "not_implemented", "{ty}");
    }
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
    let (tx, _rx) = test_outbound();
    let subs = Arc::new(Subscriptions::default());
    let registry = Arc::new(ProjectRegistry::new());
    let reply = route(r#"{"id":"r1","type":"list_agents","payload":{}}"#, &test_env(&acp, &relay, &registry, &tx, &subs))
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
    // Issue #837: the owned-session set is part of every summary now.
    assert_eq!(entries[0]["ownsSession"], json!(["sess-1"]));
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
/// in-memory relay state), publishes one `chat_history` delta, and
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
    // A connection watching the chat-history index observes the delta; it
    // needs no session subscription.
    let (out, mut rx) = outbound_channel(16, 15);
    relay
        .watches()
        .subscribe(crate::web::watch::WatchKind::ChatHistory, "", &out, || json!([]))
        .expect("watch");
    let _state = rx.try_recv().expect("full-state frame");

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
    // Delta observed: sidebars refetch the index.
    let Ok(Outbound::Watch(frame)) = rx.try_recv() else {
        panic!("expected a chat_history delta");
    };
    assert_eq!(frame.delta_value(), Some(&json!({ "changed": ["s-1"] })));

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
    let (tx, _rx) = test_outbound();
    let subs = Arc::new(Subscriptions::default());
    let registry = Arc::new(ProjectRegistry::new());
    let reply = route(r#"{"id":"r1","type":"resume_session","payload":{"agentId":"agent-1","sessionId":"sess-1","cwd":"/tmp"}}"#, &test_env(&acp, &relay, &registry, &tx, &subs))
        .await;
    assert!(reply.ok, "resume ok: {:?}", reply.err);
    let payload = reply.payload.expect("ok payload");
    assert_eq!(payload.get("replaySnapshot"), Some(&Value::Null));
    // No history/replay fields leak into the reply (contract 1).
    assert_eq!(payload.as_object().unwrap().len(), 1);
}

// ---- CAP-11: binary-frame protocol error (flush-then-Close(1003)) ----

pub(super) fn ws_test_app_state() -> AppState {
    let pty = crate::web::test_pty_manager();
    AppState {
        acp: Arc::new(AcpManager::new(vec![])),
        terminal_events: pty.terminal_events(),
        cwd_tracker: pty.cwd_tracker(),
        git_tracker: pty.git_tracker(),
        exit_code_tracker: pty.exit_code_tracker(),
        pty,
        relay: Arc::new(WsRelaySink::new()),
        registry: crate::web::project_registry::ProjectRegistry::seeded_for_test(
            &std::env::temp_dir(),
        ),
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
        pending_oauth_flows: Arc::new(parking_lot::RwLock::new(std::collections::HashMap::new())),
        oauth_base_url: "http://127.0.0.1".to_string(),
        connections: Default::default(),
    }
}

/// Read exactly one server→client WS frame (unmasked per RFC 6455).
/// Returns `(opcode, payload)`.
pub(super) async fn ws_read_frame(stream: &mut tokio::net::TcpStream) -> (u8, Vec<u8>) {
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
/// masking). A text frame of a ledgered request type is stamped with a fresh
/// `command_id` like a client's (`test_clock::stamp_ws_text`); frames up to 64 KiB.
pub(super) async fn ws_write_frame(stream: &mut tokio::net::TcpStream, opcode: u8, payload: &[u8]) {
    use tokio::io::AsyncWriteExt;
    let stamped;
    let payload = match (opcode, std::str::from_utf8(payload)) {
        (0x1, Ok(text)) => {
            stamped = crate::web::command_ledger::test_clock::stamp_ws_text(text);
            stamped.as_bytes()
        }
        _ => payload,
    };
    assert!(payload.len() <= 0xFFFF, "test frames fit the 16-bit length form");
    let mask = [0x12u8, 0x34, 0x56, 0x78];
    let mut frame = vec![0x80 | opcode];
    if payload.len() <= 125 {
        frame.push(0x80 | payload.len() as u8);
    } else {
        frame.push(0x80 | 126);
        frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    }
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
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        ).await;
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
    assert_eq!(reply.err.unwrap().code, "invalid_agent_config");
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
    assert_eq!(err.code, "invalid_agent_config");
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
    let (tx, _rx) = test_outbound();
    let subs = Arc::new(Subscriptions::default());
    let reply = route(r#"{"id":"r1","type":"install_acp_agent","payload":{"agentId":"does-not-exist"}}"#, &HandlerEnv { acp_install: Some(store.clone()), ..test_env(&acp, &relay, &registry, &tx, &subs) })
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
    let (tx, _rx) = test_outbound();
    let subs = Arc::new(Subscriptions::default());
    let registry = Arc::new(ProjectRegistry::new());
    let reply = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(route(r#"{"id":"r1","type":"respond_permission","payload":{"agentId":"a1"}}"#, &test_env(&acp, &relay, &registry, &tx, &subs)));
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
) -> (Arc<WsRelaySink>, Arc<Subscriptions>) {
    use crate::web::sink::{AcpEvent, EventSink};
    let relay = Arc::new(WsRelaySink::new());
    relay.set_rendezvous(Arc::new(
        crate::web::permissions::PermissionRendezvous::default(),
    ));
    // Subscribe a client to the session (populates subscribed_clients via
    // the production subscribe path).
    relay.seed_session_for_test(session_id);
    let (client_id, _rx, _replay, _) = block_on(relay.subscribe(session_id, None, None, &CancellationToken::new()));
    let subs = subscriptions_with(session_id, client_id);
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
    let (tx, _rx) = test_outbound();
    let registry = Arc::new(ProjectRegistry::new());
    let reply = block_on(route(r#"{"id":"r1","type":"respond_permission","payload":{"agentId":"a2","requestId":"perm-1","optionId":"allow"}}"#, &test_env(&acp, &relay, &registry, &tx, &subs)));
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "permission_denied");
}

/// Answer by ticket: a connection NOT subscribed to the permission's session
/// (a fresh socket after a reconnect) resolves the pending approval — the
/// ticket, not the subscription, authorizes the answer.
#[test]
fn handle_respond_permission_needs_no_subscription() {
    // Register a permission on sess-A but subscribe the connection to sess-B.
    use crate::web::sink::{AcpEvent, EventSink};
    let relay = Arc::new(WsRelaySink::new());
    let acp = Arc::new(AcpManager::new(vec![]));
    relay.set_rendezvous(Arc::new(
        crate::web::permissions::PermissionRendezvous::default(),
    ));
    relay.seed_session_for_test("sess-B");
    let (_other_client, _rx, _replay, _) = block_on(relay.subscribe("sess-B", None, None, &CancellationToken::new()));
    let subs = subscriptions_with("sess-B", ClientId::new());
    relay.emit(&AcpEvent {
        sid: Some("sess-A".to_string()),
        type_: "acp:permission_request",
        payload: serde_json::json!({
            "agentId": "a1", "sessionId": "sess-A", "requestId": "perm-A",
            "toolCall": { "toolCallId": "tc-1" }, "options": [{ "optionId": "allow" }]
        }),
    });
    let (tx, _rx) = test_outbound();
    let registry = Arc::new(ProjectRegistry::new());
    let reply = block_on(route(r#"{"id":"r1","type":"respond_permission","payload":{"agentId":"a1","requestId":"perm-A","optionId":"allow"}}"#, &test_env(&acp, &relay, &registry, &tx, &subs)));
    assert!(reply.ok, "ticket-only answer: {:?}", reply.err);
}

/// Story 1.7 (verification gap #4 + happy path): a valid `respond_permission`
/// from a subscribed connection resolves the ticket (ok); a second frame for
/// the same requestId is rejected `already_resolved` (handler-level
/// first-response-wins; the resolved ticket is remembered by a bounded
/// tombstone, even for a different connection).
#[test]
fn handle_respond_permission_resolves_then_second_is_already_resolved() {
    let (relay, subs) = relay_with_subscribed_permission("a1", "sess-1", "perm-1", &["allow"]);
    let acp = Arc::new(AcpManager::new(vec![]));
    let (tx, _rx) = test_outbound();
    let registry = Arc::new(ProjectRegistry::new());
    let ok_reply = block_on(route(r#"{"id":"r1","type":"respond_permission","payload":{"agentId":"a1","requestId":"perm-1","optionId":"allow"}}"#, &test_env(&acp, &relay, &registry, &tx, &subs)));
    assert!(ok_reply.ok, "first response wins: {:?}", ok_reply.err);
    // Second frame for the same requestId → already_resolved (tombstone).
    let stale_reply = block_on(route(r#"{"id":"r2","type":"respond_permission","payload":{"agentId":"a1","requestId":"perm-1","optionId":"allow"}}"#, &test_env(&acp, &relay, &registry, &tx, &subs)));
    assert!(!stale_reply.ok);
    assert_eq!(stale_reply.err.unwrap().code, "already_resolved");
}

/// Story 1.7 (verification gap: TOCTOU through the handler): an `optionId`
/// not in the original options is rejected `permission_denied` end-to-end.
#[test]
fn handle_respond_permission_invalid_option_is_permission_denied() {
    let (relay, subs) =
        relay_with_subscribed_permission("a1", "sess-1", "perm-1", &["allow", "deny"]);
    let acp = Arc::new(AcpManager::new(vec![]));
    let (tx, _rx) = test_outbound();
    let registry = Arc::new(ProjectRegistry::new());
    let reply = block_on(route(r#"{"id":"r1","type":"respond_permission","payload":{"agentId":"a1","requestId":"perm-1","optionId":"escalate"}}"#, &test_env(&acp, &relay, &registry, &tx, &subs)));
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
) -> (Arc<WsRelaySink>, Arc<Subscriptions>) {
    use crate::web::sink::{AcpEvent, EventSink};
    let relay = Arc::new(WsRelaySink::new());
    relay.set_question_rendezvous(Arc::new(
        crate::web::permissions::QuestionRendezvous::default(),
    ));
    relay.seed_session_for_test(session_id);
    let (client_id, _rx, _replay, _) = block_on(relay.subscribe(session_id, None, None, &CancellationToken::new()));
    let subs = subscriptions_with(session_id, client_id);
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
    let (tx, _rx) = test_outbound();
    let registry = Arc::new(ProjectRegistry::new());
    let subs = Arc::new(Subscriptions::default());
    let reply = block_on(route(r#"{"id":"r1","type":"answer_question","payload":{"agentId":"a1"}}"#, &test_env(&acp, &relay, &registry, &tx, &subs)));
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "unsupported");
}

/// Issue #411: an `answer_question` whose `agentId` differs from the
/// ticket's agent is rejected `permission_denied` (defense-in-depth).
#[test]
fn handle_answer_question_wrong_agent_is_permission_denied() {
    let (relay, subs) = relay_with_subscribed_question("a1", "sess-1", "q-1", &["plan-a"]);
    let acp = Arc::new(AcpManager::new(vec![]));
    let (tx, _rx) = test_outbound();
    let registry = Arc::new(ProjectRegistry::new());
    let reply = block_on(route(r#"{"id":"r1","type":"answer_question","payload":{"agentId":"a2","questionId":"q-1","values":["plan-a"]}}"#, &test_env(&acp, &relay, &registry, &tx, &subs)));
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "permission_denied");
}

/// Answer by ticket: a connection NOT subscribed to the question's session
/// resolves it — the ticket, not the subscription, authorizes the answer.
#[test]
fn handle_answer_question_needs_no_subscription() {
    use crate::web::sink::{AcpEvent, EventSink};
    let relay = Arc::new(WsRelaySink::new());
    let acp = Arc::new(AcpManager::new(vec![]));
    relay.set_question_rendezvous(Arc::new(
        crate::web::permissions::QuestionRendezvous::default(),
    ));
    relay.seed_session_for_test("sess-B");
    let (_other_client, _rx, _replay, _) = block_on(relay.subscribe("sess-B", None, None, &CancellationToken::new()));
    let subs = subscriptions_with("sess-B", ClientId::new());
    relay.emit(&AcpEvent {
        sid: Some("sess-A".to_string()),
        type_: "acp:question_request",
        payload: serde_json::json!({
            "agentId": "a1", "sessionId": "sess-A", "questionId": "q-A",
            "question": "Q", "options": [{ "value": "plan-a", "label": "Plan A" }]
        }),
    });
    let (tx, _rx) = test_outbound();
    let registry = Arc::new(ProjectRegistry::new());
    let reply = block_on(route(r#"{"id":"r1","type":"answer_question","payload":{"agentId":"a1","questionId":"q-A","values":["plan-a"]}}"#, &test_env(&acp, &relay, &registry, &tx, &subs)));
    assert!(reply.ok, "ticket-only answer: {:?}", reply.err);
}

/// Issue #411: a valid `answer_question` from a subscribed connection
/// resolves the ticket (ok); a second frame for the same questionId is
/// rejected `already_resolved` (handler-level first-response-wins).
#[test]
fn handle_answer_question_resolves_then_second_is_already_resolved() {
    let (relay, subs) = relay_with_subscribed_question("a1", "sess-1", "q-1", &["plan-a"]);
    let acp = Arc::new(AcpManager::new(vec![]));
    let (tx, _rx) = test_outbound();
    let registry = Arc::new(ProjectRegistry::new());
    let ok_reply = block_on(route(r#"{"id":"r1","type":"answer_question","payload":{"agentId":"a1","questionId":"q-1","values":["plan-a"]}}"#, &test_env(&acp, &relay, &registry, &tx, &subs)));
    assert!(ok_reply.ok, "first answer wins: {:?}", ok_reply.err);
    let stale_reply = block_on(route(r#"{"id":"r2","type":"answer_question","payload":{"agentId":"a1","questionId":"q-1","values":["plan-a"]}}"#, &test_env(&acp, &relay, &registry, &tx, &subs)));
    assert!(!stale_reply.ok);
    assert_eq!(stale_reply.err.unwrap().code, "already_resolved");
}

/// Issue #411: an option value not in the original options is rejected
/// `permission_denied` end-to-end (TOCTOU through the handler).
#[test]
fn handle_answer_question_invalid_option_is_permission_denied() {
    let (relay, subs) = relay_with_subscribed_question("a1", "sess-1", "q-1", &["plan-a"]);
    let acp = Arc::new(AcpManager::new(vec![]));
    let (tx, _rx) = test_outbound();
    let registry = Arc::new(ProjectRegistry::new());
    let reply = block_on(route(r#"{"id":"r1","type":"answer_question","payload":{"agentId":"a1","questionId":"q-1","values":["escalate"]}}"#, &test_env(&acp, &relay, &registry, &tx, &subs)));
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
    let (tx, mut rx) = test_outbound();
    let subs = Arc::new(Subscriptions::default());
    let registry = Arc::new(ProjectRegistry::new());
    let reply = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(route(r#"{"id":"sub1","type":"subscribe","payload":{"sessionId":"s1","lastSeq":0}}"#, &test_env(&acp, &relay, &registry, &tx, &subs)));
    assert!(!reply.ok);
    assert_eq!(reply.err.unwrap().code, "stale");

    // Fresh session live-only subscribe (omit lastSeq) succeeds.
    let subs2 = Arc::new(Subscriptions::default());
    let reply_ok = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(route(r#"{"id":"sub2","type":"subscribe","payload":{"sessionId":"fresh"}}"#, &test_env(&acp, &relay, &registry, &tx, &subs2)));
    assert!(reply_ok.ok, "{:?}", reply_ok.err);
    assert_eq!(subs2.len(), 1);

    // Re-subscribe same session replaces prior ClientId (no leak).
    let reply_resub = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(route(r#"{"id":"sub3","type":"subscribe","payload":{"sessionId":"fresh"}}"#, &test_env(&acp, &relay, &registry, &tx, &subs2)));
    assert!(reply_resub.ok, "{:?}", reply_resub.err);
    assert_eq!(subs2.len(), 1);

    // Evicted log + omit lastSeq → live-only succeeds (not stale).
    let subs3 = Arc::new(Subscriptions::default());
    let reply_live = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(route(r#"{"id":"sub4","type":"subscribe","payload":{"sessionId":"s1"}}"#, &test_env(&acp, &relay, &registry, &tx, &subs3)));
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
    let (tx, _rx) = test_outbound();
    let subs = Arc::new(Subscriptions::default());

    // Without a cursor.
    let reply = handle_subscribe(
        "sub-1".to_string(),
        &json!({"sessionId": "session-absent"}),
        &relay,
        &tx,
        &subs,
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
        &subs,
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

    let (tx, _rx) = test_outbound();
    let subs = Arc::new(Subscriptions::default());
    let reply = handle_open_persisted_session(
        "open-1".to_string(),
        &json!({"sessionId": "session-x", "lastSeq": 0}),
        &relay,
        &tx,
        &subs,
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
    let (tx, _rx) = test_outbound();
    let subs = Arc::new(Subscriptions::default());
    let reply = handle_open_persisted_session(
        "open-1".to_string(),
        &json!({"sessionId": "session-x", "lastSeq": 0}),
        &relay,
        &tx,
        &subs,
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
    let acp = Arc::new(AcpManager::with_persistence(vec![relay.clone()], persistence.clone()));

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

/// `recover_session_snapshot`'s reply `watermark` is the log head (the
/// allocated seq frontier) the registration was made at, so live events resume
/// right after it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recover_session_snapshot_reply_watermark_is_the_log_head() {
    use crate::web::sink::{AcpEvent, EventSink};
    let root = std::env::temp_dir().join(format!("termul-ws-snap-head-{}", uuid::Uuid::new_v4()));
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = crate::acp::SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    persistence
        .register_session(crate::acp::SessionRegistration {
            session_id: "session-head".to_string(),
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    let relay = Arc::new(WsRelaySink::with_persistence(8, persistence.clone()));
    for n in 0..3 {
        relay.emit(&AcpEvent {
            sid: Some("session-head".to_string()),
            type_: "acp:tool_call",
            payload: json!({"sessionId": "session-head", "n": n}),
        });
    }
    // A non-durable event consumes a seq without reaching the JSONL: the head
    // is the allocated frontier, not the durable one.
    relay.emit(&AcpEvent {
        sid: Some("session-head".to_string()),
        type_: "acp:permission_request",
        payload: json!({"sessionId": "session-head"}),
    });
    let subs = Arc::new(Subscriptions::default());
    let (out_tx, _out_rx) = test_outbound();

    let reply = handle_recover_session_snapshot(
        "r1".to_string(),
        &json!({ "sessionId": "session-head" }),
        &relay,
        &out_tx,
        &subs,
        HistoryMode::Server,
    )
    .await;
    assert!(reply.ok, "{reply:?}");
    let payload = reply.payload.unwrap();
    assert_eq!(payload["watermark"], 4);
    assert_eq!(payload["watermark"], relay.session_watermark("session-head"));
    let seqs: Vec<u64> = payload["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|event| event["seq"].as_u64().unwrap())
        .collect();
    assert_eq!(seqs, vec![1, 2, 3], "snapshot holds the durable events up to the head");

    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

/// The subscription a snapshot registers feeds the connection through the same
/// bounded channel: a reliable event that finds it full closes THIS connection
/// (the phone resumes by cursor) instead of vanishing.
#[tokio::test]
async fn recover_session_snapshot_subscription_closes_the_connection_on_reliable_overflow() {
    use crate::web::sink::{AcpEvent, EventSink};
    let root = std::env::temp_dir().join(format!("termul-ws-snap-overflow-{}", uuid::Uuid::new_v4()));
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = crate::acp::SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    persistence
        .register_session(crate::acp::SessionRegistration {
            session_id: "session-overflow".to_string(),
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    let relay = Arc::new(WsRelaySink::with_persistence(8, persistence.clone()));
    relay.emit(&AcpEvent {
        sid: Some("session-overflow".to_string()),
        type_: "acp:tool_call",
        payload: json!({"sessionId": "session-overflow", "n": 0}),
    });
    let subs = Arc::new(Subscriptions::default());
    let (out_tx, _out_rx) = test_outbound();
    let reply = handle_recover_session_snapshot(
        "r1".to_string(),
        &json!({ "sessionId": "session-overflow" }),
        &relay,
        &out_tx,
        &subs,
        HistoryMode::Server,
    )
    .await;
    assert!(reply.ok, "{reply:?}");
    assert!(!out_tx.closing().is_cancelled());

    // No await between emits: the forwarder cannot drain the channel.
    for n in 1..=400 {
        relay.emit(&AcpEvent {
            sid: Some("session-overflow".to_string()),
            type_: "acp:tool_call",
            payload: json!({"sessionId": "session-overflow", "n": n}),
        });
    }
    assert!(
        out_tx.closing().is_cancelled(),
        "a reliable event that finds the subscription full must close the connection"
    );
    assert_eq!(relay.session_subscriber_count("session-overflow"), 0);

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
    // installed — the relay's host record hits SessionNotFound.
    persistence.shutdown().await.unwrap();
    let reopened = crate::acp::SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    let relay = Arc::new(WsRelaySink::with_persistence(8, reopened.clone()));
    let acp = Arc::new(AcpManager::with_persistence(vec![relay.clone()], reopened.clone()));

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

fn project_summary_for_test(
    id: &str,
    path: Option<&str>,
    archived: bool,
) -> crate::web::project_registry::ProjectSummary {
    crate::web::project_registry::ProjectSummary {
        id: id.to_string(),
        name: format!("Proj {id}"),
        color: "blue".to_string(),
        path: path.map(str::to_string),
        is_archived: archived,
        is_default: false,
    }
}

/// `set_default_project` WS request (Epic 7): updates the host default and
/// writes it through to the durable registry file. Mirrors the
/// `set_host_default_project` Tauri command + `POST /projects/default` HTTP
/// route (transport parity).
#[tokio::test]
async fn handle_set_default_project_updates_host_default_and_persists() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("projects.json");
    let registry = Arc::new(ProjectRegistry::open_durable(&file, crate::acp::RootCheck::Lenient).unwrap());
    registry.set(
        vec![
            project_summary_for_test("p-1", Some("/a"), false),
            project_summary_for_test("p-2", Some("/b"), false),
        ],
        Some("p-1".to_string()),
    );
    let acp = Arc::new(AcpManager::new(vec![]));
    let relay = Arc::new(WsRelaySink::new());
    let (tx, _rx) = test_outbound();
    let env = test_env(&acp, &relay, &registry, &tx, &Arc::new(Subscriptions::default()));

    let reply = route(
        r#"{"id":"r1","type":"set_default_project","payload":{"projectId":"p-2"}}"#,
        &env,
    )
    .await;
    assert!(reply.ok, "{:?}", reply.err);
    let snap = registry.snapshot();
    assert_eq!(snap.default_project_id.as_deref(), Some("p-2"));
    assert!(!snap.projects[0].is_default);
    assert!(snap.projects[1].is_default);
    let saved: Value = serde_json::from_slice(&std::fs::read(&file).expect("persisted")).unwrap();
    assert_eq!(saved["schemaVersion"], 4);
    assert_eq!(saved["defaultProjectId"], "p-2");
}

/// `set_default_project` WS request with an unknown/archived/pathless id →
/// `NOT_FOUND` (validation rejects before any mutation or persistence).
#[tokio::test]
async fn handle_set_default_project_unknown_id_is_not_found() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("projects.json");
    let registry = Arc::new(ProjectRegistry::open_durable(&file, crate::acp::RootCheck::Lenient).unwrap());
    registry.set(
        vec![
            project_summary_for_test("p-1", Some("/a"), false),
            project_summary_for_test("p-archived", Some("/b"), true),
            project_summary_for_test("p-pathless", None, false),
        ],
        Some("p-1".to_string()),
    );
    let written = std::fs::read(&file).unwrap();
    let acp = Arc::new(AcpManager::new(vec![]));
    let relay = Arc::new(WsRelaySink::new());
    let (tx, _rx) = test_outbound();
    let env = test_env(&acp, &relay, &registry, &tx, &Arc::new(Subscriptions::default()));
    for bad in ["missing", "p-archived", "p-pathless"] {
        let reply = handle_set_default_project(
            "r1".to_string(),
            &json!({ "projectId": bad }),
            &env,
        )
        .await;
        assert!(!reply.ok, "{bad} should be rejected");
        assert_eq!(reply.err.unwrap().code, "not_found");
        assert_eq!(registry.snapshot().default_project_id.as_deref(), Some("p-1"));
    }
    assert_eq!(std::fs::read(&file).unwrap(), written, "nothing was rewritten");
}

/// `set_default_project` changes the host default and publishes the project
/// state (carrying the new default) to every `projects` watcher.
#[tokio::test]
async fn handle_set_default_project_publishes_to_all_watchers() {
    let relay = Arc::new(WsRelaySink::new());
    let registry = Arc::new(ProjectRegistry::new());
    registry.set(vec![project_summary_for_test("p-1", Some("/a"), false)], None);
    // A watcher with no session subscription proves the delta reaches it.
    let (out, mut rx) = outbound_channel(16, 15);
    relay
        .watches()
        .subscribe(crate::web::watch::WatchKind::Projects, "", &out, || json!(null))
        .expect("watch");
    let _state = rx.try_recv().expect("full-state frame");
    let acp = Arc::new(AcpManager::new(vec![]));
    let (tx, _out) = test_outbound();
    let env = test_env(&acp, &relay, &registry, &tx, &Arc::new(Subscriptions::default()));

    let reply = handle_set_default_project(
        "r1".to_string(),
        &json!({ "projectId": "p-1" }),
        &env,
    )
    .await;
    assert!(reply.ok, "{:?}", reply.err);
    let mut deltas = Vec::new();
    while let Ok(Outbound::Watch(frame)) = rx.try_recv() {
        deltas.push(frame);
    }
    assert_eq!(deltas.len(), 1, "exactly one projects delta");
    let delta = deltas[0].delta_value().expect("delta");
    assert_eq!(
        delta["defaultProjectId"], "p-1",
        "the delta carries the new default project id"
    );
    assert_eq!(delta["projects"][0]["id"], "p-1");
}

// ---- Issue #837: resume_session split-brain guard at the WS boundary ----

/// A `resume_session` dispatched at a duplicate agent while the ORIGINAL
/// owning agent still has a turn in flight is rejected with the additive
/// `session_owned_by_other` code (the wire mapping of
/// `ACP_SESSION_OWNED_BY_OTHER`) and never reaches `session/resume`.
#[tokio::test]
async fn handle_resume_session_rejected_mid_turn_maps_to_session_owned_by_other() {
    let relay = Arc::new(WsRelaySink::new());
    let acp = Arc::new(AcpManager::new(vec![]));
    // Original agent owns the session, turn in flight.
    acp.install_test_agent_with_mid_turn_session(
        crate::acp::AgentId("agent-original".to_string()),
        ["sess-mid".to_string()].into_iter().collect(),
        true,
    );
    // Duplicate (reload-spawned) agent, resume-capable.
    acp.install_test_agent_with_resume(
        crate::acp::AgentId("agent-duplicate".to_string()),
        [].into_iter().collect(),
    );
    let (tx, _rx) = test_outbound();
    let subs = Arc::new(Subscriptions::default());
    let registry = Arc::new(ProjectRegistry::new());
    let reply = route(r#"{"id":"r1","type":"resume_session","payload":{"agentId":"agent-duplicate","sessionId":"sess-mid","cwd":"/tmp"}}"#, &test_env(&acp, &relay, &registry, &tx, &subs))
    .await;
    assert!(!reply.ok, "mid-turn cross-agent resume must fail");
    let err = reply.err.expect("err envelope");
    assert_eq!(err.code, "session_owned_by_other");
    assert!(
        err.message.contains("ACP_SESSION_OWNED_BY_OTHER"),
        "message carries the stable prefix: {}",
        err.message
    );
    assert!(
        err.message.contains("agent-original"),
        "message names the owning agent: {}",
        err.message
    );
}

/// `list_agents` carries the issue-#837 payload extension: every summary
/// includes the agent's owned-session set (`ownsSession`), so a reloading web
/// client can resolve which live agent owns the session it is reopening.
#[tokio::test]
async fn handle_list_agents_reports_owned_sessions() {
    let relay = Arc::new(WsRelaySink::new());
    let acp = Arc::new(AcpManager::new(vec![]));
    acp.install_test_agent_with_resume(
        crate::acp::AgentId("agent-1".to_string()),
        ["sess-1".to_string()].into_iter().collect(),
    );
    let (tx, _rx) = test_outbound();
    let subs = Arc::new(Subscriptions::default());
    let registry = Arc::new(ProjectRegistry::new());
    let reply = route(r#"{"id":"r1","type":"list_agents","payload":{}}"#, &test_env(&acp, &relay, &registry, &tx, &subs))
    .await;
    assert!(reply.ok, "list_agents should succeed: {:?}", reply.err);
    let entries = reply
        .payload
        .as_ref()
        .and_then(Value::as_array)
        .expect("payload is an array");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["id"], "agent-1");
    assert_eq!(entries[0]["ownsSession"], json!(["sess-1"]));
}

// ---- watch / unwatch of a project's file changes (`fs`) ----

fn watch_fixture(
    id: &str,
) -> (
    Arc<WsRelaySink>,
    Arc<ProjectRegistry>,
    std::path::PathBuf,
    OutboundSender,
    OutboundReceiver,
) {
    let dir = std::env::temp_dir()
        .join(format!("termul-ws-watch-{id}-{}", std::process::id()))
        .to_path_buf();
    std::fs::create_dir_all(&dir).unwrap();
    let dir = dir.canonicalize().unwrap();
    let registry = ProjectRegistry::seeded_for_test(&dir);
    let (tx, rx) = test_outbound();
    (Arc::new(WsRelaySink::new()), registry, dir, tx, rx)
}

fn reply_code(reply: &WsReply) -> Option<String> {
    serde_json::to_value(reply)
        .unwrap()
        .get("err")
        .and_then(|e| e.get("code"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Route one `watch` / `unwatch` request over the given fixture.
async fn watch_request(
    fixture: &(Arc<WsRelaySink>, Arc<ProjectRegistry>, std::path::PathBuf, OutboundSender, OutboundReceiver),
    type_: &str,
    payload: Value,
) -> WsReply {
    let (relay, registry, _dir, tx, _rx) = fixture;
    let acp = Arc::new(AcpManager::new(vec![]));
    let subs = Arc::new(Subscriptions::default());
    let frame = json!({ "id": type_, "type": type_, "payload": payload });
    route(&frame.to_string(), &test_env(&acp, relay, registry, tx, &subs)).await
}

#[tokio::test]
async fn fs_watch_and_unwatch_manage_the_connections_subscription() {
    let fixture = watch_fixture("ok");
    let relay = Arc::clone(&fixture.0);
    let project = crate::web::project_registry::SEEDED_PROJECT_ID;
    let payload = json!({ "watch": "fs", "scope": project });

    let reply = watch_request(&fixture, "watch", payload.clone()).await;
    assert!(reply.ok, "watch of a registered project succeeds");
    assert_eq!(relay.fs_watches().subscriber_count(project), 1);
    assert_eq!(
        relay.watches().subscriber_count(crate::web::watch::WatchKind::Fs, project),
        1
    );

    let reply = watch_request(&fixture, "unwatch", payload.clone()).await;
    assert!(reply.ok);
    assert_eq!(relay.fs_watches().watched_project_count(), 0);
    assert_eq!(
        relay.watches().subscriber_count(crate::web::watch::WatchKind::Fs, project),
        0
    );

    // Idempotent for a registered project.
    assert!(watch_request(&fixture, "unwatch", payload).await.ok);
    let _ = std::fs::remove_dir_all(&fixture.2);
}

#[tokio::test]
async fn fs_watch_refuses_unknown_archived_and_malformed_and_unwatch_is_idempotent() {
    let fixture = watch_fixture("refuse");
    let relay = Arc::clone(&fixture.0);
    let registry = Arc::clone(&fixture.1);
    let project = crate::web::project_registry::SEEDED_PROJECT_ID;

    let unknown = json!({ "watch": "fs", "scope": "nope" });
    let w = watch_request(&fixture, "watch", unknown.clone()).await;
    assert_eq!(reply_code(&w).as_deref(), Some("not_found"));
    // Unwatch is idempotent: an id the connection never watched is a success.
    assert!(watch_request(&fixture, "unwatch", unknown).await.ok);
    assert!(registry.update(project, None, None, Some(true)));
    let w = watch_request(&fixture, "watch", json!({ "watch": "fs", "scope": project })).await;
    assert_eq!(reply_code(&w).as_deref(), Some("not_found"), "archived project");

    // No scope, a blank scope, an unknown watch: refused as unsupported.
    for payload in [
        json!({ "watch": "fs" }),
        json!({ "watch": "fs", "scope": "  " }),
        json!({ "watch": "nope" }),
        json!({}),
    ] {
        let w = watch_request(&fixture, "watch", payload.clone()).await;
        assert_eq!(reply_code(&w).as_deref(), Some("unsupported"), "{payload}");
        let u = watch_request(&fixture, "unwatch", payload).await;
        assert_eq!(reply_code(&u).as_deref(), Some("unsupported"));
    }
    assert_eq!(relay.fs_watches().watched_project_count(), 0);
    let _ = std::fs::remove_dir_all(&fixture.2);
}

/// Connection close releases the connection's watch through the same cleanup
/// that reaps its session subscriptions — also when the cleanup is dropped
/// without `run()`.
#[tokio::test]
async fn connection_cleanup_releases_fs_watch_subscriptions() {
    let fixture = watch_fixture("cleanup");
    let relay = Arc::clone(&fixture.0);
    let tx = fixture.3.clone();
    let project = crate::web::project_registry::SEEDED_PROJECT_ID;
    let subscribed = Arc::new(Subscriptions::default());

    for use_run in [true, false] {
        let reply =
            watch_request(&fixture, "watch", json!({ "watch": "fs", "scope": project })).await;
        assert!(reply.ok);
        assert_eq!(relay.fs_watches().subscriber_count(project), 1);
        let cleanup = ConnectionCleanup::new(Arc::clone(&relay), Arc::clone(&subscribed))
            .with_watch_conn(tx.clone());
        if use_run {
            cleanup.run().await;
        } else {
            drop(cleanup);
        }
        assert_eq!(relay.fs_watches().subscriber_count(project), 0);
        assert_eq!(relay.fs_watches().watched_project_count(), 0);
        assert_eq!(
            relay.watches().subscriber_count(crate::web::watch::WatchKind::Fs, project),
            0
        );
    }
    let _ = std::fs::remove_dir_all(&fixture.2);
}

/// A client that unwatches after its project was archived/removed (which
/// already ended the watch) still gets a success.
#[tokio::test]
async fn unwatch_after_the_project_was_archived_succeeds() {
    let fixture = watch_fixture("gone");
    let relay = Arc::clone(&fixture.0);
    let registry = Arc::clone(&fixture.1);
    let project = crate::web::project_registry::SEEDED_PROJECT_ID;
    let payload = json!({ "watch": "fs", "scope": project });
    assert!(watch_request(&fixture, "watch", payload.clone()).await.ok);
    // Archive only once the watcher is live, so a LIVE subscription is what
    // gets ended (not a task that finds the project gone on first lookup).
    assert!(relay.fs_watches().wait_armed(project, Duration::from_secs(10)).await);
    assert!(registry.update(project, None, None, Some(true)));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    while relay.fs_watches().watched_project_count() != 0 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(relay.fs_watches().watched_project_count(), 0);
    assert_eq!(
        relay.watches().subscriber_count(crate::web::watch::WatchKind::Fs, project),
        0,
        "the host released the hub subscription with its notice"
    );

    let u = watch_request(&fixture, "unwatch", payload).await;
    assert!(u.ok, "unwatch after the project vanished must succeed");
    let _ = std::fs::remove_dir_all(&fixture.2);
}

/// The log epoch travels on the wire: `subscribe`, `recover_session_snapshot`
/// and `get_session_cursor` all report `(logEpoch, headSeq)`, and a cursor
/// under another epoch or ahead of the head is answered `stale` without
/// registering anything.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn log_epoch_rides_subscribe_snapshot_and_cursor_replies() {
    use crate::web::sink::{AcpEvent, EventSink};
    let root = std::env::temp_dir().join(format!("termul-ws-epoch-{}", uuid::Uuid::new_v4()));
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = crate::acp::SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    persistence
        .register_session(crate::acp::SessionRegistration {
            session_id: "session-epoch".to_string(),
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    let relay = Arc::new(WsRelaySink::with_persistence(8, persistence.clone()));
    for n in 0..3 {
        relay.emit(&AcpEvent {
            sid: Some("session-epoch".to_string()),
            type_: "acp:tool_call",
            payload: json!({"sessionId": "session-epoch", "n": n}),
        });
    }
    let epoch = persistence.log_epoch("session-epoch").unwrap();
    let (tx, _rx) = test_outbound();
    let subs = Arc::new(Subscriptions::default());

    // Cursor reply: the epoch the watermark is valid under + the allocated frontier.
    let reply = handle_get_session_cursor(
        "c1".to_string(),
        &json!({ "sessionId": "session-epoch" }),
        &relay,
        HistoryMode::Server,
    )
    .await;
    assert!(reply.ok, "{reply:?}");
    let payload = reply.payload.unwrap();
    assert_eq!(payload["logEpoch"], json!(epoch));
    assert_eq!(payload["headSeq"], 3);

    // A session the host does not know has no log: neither epoch nor head.
    let reply = handle_get_session_cursor(
        "c2".to_string(),
        &json!({ "sessionId": "session-never-seen" }),
        &relay,
        HistoryMode::Server,
    )
    .await;
    assert!(reply.ok, "{reply:?}");
    let payload = reply.payload.unwrap();
    assert_eq!(payload["watermark"], 0);
    assert!(payload.get("logEpoch").is_none(), "{payload}");
    assert!(payload.get("headSeq").is_none(), "{payload}");

    // Same epoch, cursor below the head: resumes and reports the head.
    let reply = handle_subscribe(
        "s1".to_string(),
        &json!({"sessionId": "session-epoch", "lastSeq": 1, "logEpoch": epoch}),
        &relay,
        &tx,
        &subs,
    )
    .await;
    assert!(reply.ok, "{reply:?}");
    let payload = reply.payload.unwrap();
    assert_eq!(payload["logEpoch"], json!(epoch));
    assert_eq!(payload["headSeq"], 3);
    assert_eq!(payload["replayed"], 2);
    assert_eq!(subs.len(), 1);

    // Another epoch, and a cursor ahead of the head: stale, nothing registered.
    let other_subs = Arc::new(Subscriptions::default());
    for (id, body) in [
        ("s2", json!({"sessionId": "session-epoch", "lastSeq": 1, "logEpoch": "epoch-from-before-restart"})),
        ("s3", json!({"sessionId": "session-epoch", "lastSeq": 50, "logEpoch": epoch})),
    ] {
        let reply = handle_subscribe(id.to_string(), &body, &relay, &tx, &other_subs).await;
        assert!(!reply.ok);
        assert_eq!(reply.err.unwrap().code, "stale", "{id}");
    }
    assert!(other_subs.is_empty());
    assert_eq!(relay.session_subscriber_count("session-epoch"), 1);

    // Snapshot reply: the epoch to continue under.
    let reply = handle_recover_session_snapshot(
        "r1".to_string(),
        &json!({ "sessionId": "session-epoch" }),
        &relay,
        &tx,
        &subs,
        HistoryMode::Server,
    )
    .await;
    assert!(reply.ok, "{reply:?}");
    let payload = reply.payload.unwrap();
    assert_eq!(payload["logEpoch"], json!(epoch));
    assert_eq!(payload["headSeq"], 3);
    assert_eq!(payload["watermark"], 3);

    // A cursor sent without an epoch is checked against the head only.
    let bare_subs = Arc::new(Subscriptions::default());
    let reply = handle_subscribe(
        "s0".to_string(),
        &json!({"sessionId": "session-epoch", "lastSeq": 1}),
        &relay,
        &tx,
        &bare_subs,
    )
    .await;
    assert!(reply.ok, "{reply:?}");
    let payload = reply.payload.unwrap();
    assert_eq!(payload["logEpoch"], json!(epoch));
    assert_eq!(payload["headSeq"], 3);
    assert_eq!(payload["replayed"], 2);
    let reply = handle_subscribe(
        "s0b".to_string(),
        &json!({"sessionId": "session-epoch", "lastSeq": 50}),
        &relay,
        &tx,
        &bare_subs,
    )
    .await;
    assert!(!reply.ok, "{reply:?}");
    assert_eq!(reply.err.unwrap().code, "stale");

    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

/// Enforcement (AD-5): a ledgered request without a `command_id` is refused with
/// the stable `invalid_command_id` before it runs; idempotent types and reads
/// need none, and `send_prompt` keeps its optional `turnId`.
#[test]
fn a_ledgered_request_without_a_command_id_is_refused_and_the_rest_runs_as_before() {
    let unstamped = |text: &str| {
        let mut authed = true;
        handle_sync_unstamped(
            text,
            &mut authed,
            &mut None,
            &mut test_access(),
            None,
        )
    };

    for (kind, payload) in [
        ("create_session", r#"{"agentId":"a1","cwd":"/tmp"}"#),
        ("spawn_agent", r#"{"config":{"name":"n","command":"c","args":[],"env":{}}}"#),
        ("close_session", r#"{"agentId":"a1","sessionId":"s1"}"#),
        ("install_acp_agent", r#"{"agentId":"x"}"#),
    ] {
        let reply = unstamped(&format!(r#"{{"id":"r1","type":"{kind}","payload":{payload}}}"#));
        assert!(!reply.ok, "{kind}");
        assert_eq!(reply.err.unwrap().code, "invalid_command_id", "{kind}");
    }

    // Idempotent and read types are not ledgered: no id needed.
    for kind in ["list_agents", "kill_agent", "set_mode"] {
        let reply = unstamped(&format!(r#"{{"id":"r1","type":"{kind}","payload":{{"agentId":"a1","sessionId":"s1","modeId":"m"}}}}"#));
        assert_ne!(
            reply.err.map(|error| error.code),
            Some("invalid_command_id".to_string()),
            "{kind}"
        );
    }

    // A turnless `send_prompt` is still served (it is refused for other
    // reasons here: there is no such agent), never as an id refusal.
    let prompt = unstamped(
        r#"{"id":"r1","type":"send_prompt","payload":{"agentId":"a1","sessionId":"s1","text":"hi"}}"#,
    );
    assert_ne!(
        prompt.err.map(|error| error.code),
        Some("invalid_command_id".to_string())
    );
}
