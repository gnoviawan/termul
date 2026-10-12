use super::*;
use crate::acp::session_persistence::{SessionPersistence, SessionRegistration};
use crate::web::WsRelaySink;
use agent_client_protocol::schema::v1::{ContentBlock, TextContent};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

/// Zero is meaningless for the three strictly-positive timeouts and must
/// be rejected at the IPC boundary (the resolvers also filter it
/// defensively). Rejection happens BEFORE the override is stored, so
/// these assertions never mutate the shared override statics.
#[test]
fn zero_overrides_are_rejected_for_strictly_positive_timeouts() {
    assert!(acp_set_turn_idle_timeout(Some(0)).is_err());
    assert!(acp_set_session_new_timeout(Some(0)).is_err());
    assert!(acp_set_session_reopen_timeout(Some(0)).is_err());
}

/// Desktop prompt harness: a durable-persistence relay that is also a sink of
/// the manager (as in the app), plus the in-crate fake agent driver, which
/// reproduces the real command loop's `SendPrompt` replies.
struct DesktopEnv {
    manager: Arc<AcpManager>,
    relay: Arc<WsRelaySink>,
    persistence: Arc<SessionPersistence>,
    root: std::path::PathBuf,
}

async fn desktop_env(session: &str, turns: Vec<crate::acp::manager::FakeTurn>) -> DesktopEnv {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("termul-acp-prompt-{session}-{stamp}"));
    std::fs::create_dir_all(&root).unwrap();
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    persistence
        .register_session(SessionRegistration {
            session_id: session.to_string(),
            stable_agent_namespace: None,
            runtime_agent_id: None,
            project_id: None,
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    let relay = Arc::new(WsRelaySink::with_persistence(8, persistence.clone()));
    let manager = Arc::new(AcpManager::new(vec![relay.clone()]));
    manager.install_test_agent_with_turns(
        AgentId("agent-1".to_string()),
        std::collections::HashSet::from([session.to_string()]),
        turns,
        false,
    );
    DesktopEnv {
        manager,
        relay,
        persistence,
        root,
    }
}

async fn send(
    env: &DesktopEnv,
    session: &str,
    text: &str,
    turn_id: Option<&str>,
    display: Option<Vec<ContentBlock>>,
) -> Result<PromptReply, String> {
    send_prompt_core(
        &env.manager,
        &env.relay,
        AgentId("agent-1".to_string()),
        SessionId(session.to_string()),
        vec![ContentBlock::Text(TextContent::new(text))],
        turn_id.map(str::to_string),
        display,
    )
    .await
}

/// Regression: the desktop `acp_send_prompt` persists the accepted prompt as
/// one durable `user_prompt` whose payload shape (`{agentId, sessionId,
/// turnId, content}`) matches the web path byte-for-byte — including the
/// client-minted `turnId` (the payload fold materializes the `turn:<turnId>`
/// bubble id the optimistic renderer bubble already holds) and the display-side
/// content override.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn acp_send_prompt_writes_durable_user_prompt_with_desktop_payload() {
    let env = desktop_env("sess-desktop", Vec::new()).await;
    let reply = send(
        &env,
        "sess-desktop",
        "wire text with handoff summary",
        Some("turn-desktop-1"),
        Some(vec![ContentBlock::Text(TextContent::new("hello world"))]),
    )
    .await
    .unwrap();
    assert_eq!(serde_json::to_value(reply).unwrap(), "end_turn");

    env.persistence.flush_session("sess-desktop").await.unwrap();
    let records = env
        .persistence
        .replay_after_async("sess-desktop".to_string(), 0)
        .await
        .unwrap();
    let mut user_prompts = records.iter().filter(|r| r.type_ == "user_prompt");
    let record = user_prompts.next().expect("durable user_prompt");
    assert!(
        user_prompts.next().is_none(),
        "exactly one user_prompt record for the turn"
    );
    assert_eq!(record.seq, 1, "user_prompt is sequenced first");
    assert_eq!(record.payload["agentId"], "agent-1");
    assert_eq!(record.payload["sessionId"], "sess-desktop");
    assert_eq!(record.payload["turnId"], "turn-desktop-1");
    let content = record.payload["content"].as_array().unwrap();
    assert_eq!(content.len(), 1);
    assert_eq!(
        content[0]["text"], "hello world",
        "display content, not the wire framing, is persisted"
    );
    let metadata = env.persistence.metadata("sess-desktop").unwrap();
    assert!(metadata.title.is_some(), "title derived from user_prompt");

    env.persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(env.root);
}

/// A caller that omits the client turn-id keeps the legacy behavior: the
/// durable record has `turnId: null`, there is no dedupe, and consecutive
/// turnless prompts each run.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn acp_send_prompt_without_turn_id_keeps_legacy_behavior() {
    let env = desktop_env("sess-no-turn", Vec::new()).await;
    for _ in 0..2 {
        let reply = send(&env, "sess-no-turn", "hi", None, None).await.unwrap();
        assert_eq!(serde_json::to_value(reply).unwrap(), "end_turn");
    }
    env.persistence.flush_session("sess-no-turn").await.unwrap();
    let records = env
        .persistence
        .replay_after_async("sess-no-turn".to_string(), 0)
        .await
        .unwrap();
    let prompts: Vec<_> = records
        .iter()
        .filter(|r| r.type_ == "user_prompt")
        .collect();
    assert_eq!(prompts.len(), 2);
    assert!(prompts.iter().all(|r| r.payload["turnId"].is_null()));

    env.persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(env.root);
}

/// Dropped reply on the desktop transport: resending the same `turnId` while
/// the turn runs returns an `in_progress` receipt, after it finished an
/// `accepted` receipt — never an error, never a second run/`user_prompt`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn acp_send_prompt_resend_of_same_turn_id_returns_a_receipt() {
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let env = desktop_env(
        "sess-resend",
        vec![crate::acp::manager::FakeTurn::Hold {
            release: release_rx,
            entered: entered_tx,
        }],
    )
    .await;
    let manager = env.manager.clone();
    let relay = env.relay.clone();
    let first = tokio::spawn(async move {
        send_prompt_core(
            &manager,
            &relay,
            AgentId("agent-1".to_string()),
            SessionId("sess-resend".to_string()),
            vec![ContentBlock::Text(TextContent::new("go"))],
            Some("turn-r".to_string()),
            None,
        )
        .await
    });
    entered_rx.await.unwrap();

    let in_flight = send(&env, "sess-resend", "go", Some("turn-r"), None)
        .await
        .expect("resend while running must not error");
    assert_eq!(
        serde_json::to_value(in_flight).unwrap(),
        serde_json::json!({"receipt": "in_progress"})
    );
    // A different turn id while it runs is still a busy rejection.
    let busy = send(&env, "sess-resend", "other", Some("turn-other"), None)
        .await
        .unwrap_err();
    assert!(busy.starts_with("ACP_TURN_IN_PROGRESS"), "{busy}");

    release_tx.send(()).unwrap();
    let first = first.await.unwrap().unwrap();
    assert_eq!(serde_json::to_value(first).unwrap(), "end_turn");

    let done = send(&env, "sess-resend", "go", Some("turn-r"), None)
        .await
        .expect("resend after completion must not error");
    assert_eq!(
        serde_json::to_value(done).unwrap(),
        serde_json::json!({"receipt": "accepted"})
    );
    env.persistence.flush_session("sess-resend").await.unwrap();
    let records = env
        .persistence
        .replay_after_async("sess-resend".to_string(), 0)
        .await
        .unwrap();
    assert_eq!(
        records.iter().filter(|r| r.type_ == "user_prompt").count(),
        1,
        "resends never add a user_prompt"
    );

    env.persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(env.root);
}

/// CAP-2 (spec-in-chat-agent-switch): the desktop command writes the
/// durable `agent_switch` record with the camelCase `AgentSwitchEvent`
/// payload, the same one the WS `record_agent_switch` route records. Exercises the manager's
/// `record_agent_switch` (the command's delegation target — a full
/// command unit test would need a Tauri `State`, which is not
/// constructible here; the manager-with-persistence setup mirrors the
/// ws.rs tests).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn record_agent_switch_writes_durable_marker_with_desktop_payload() {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("termul-acp-switch-persist-{stamp}"));
    std::fs::create_dir_all(&root).unwrap();
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    persistence
        .register_session(SessionRegistration {
            session_id: "sess-switch".to_string(),
            stable_agent_namespace: Some("config:omp".to_string()),
            runtime_agent_id: Some("runtime-1".to_string()),
            project_id: None,
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    // The relay numbers the record (one seq authority).
    let relay = Arc::new(WsRelaySink::with_persistence(8, persistence.clone()));
    let manager = Arc::new(AcpManager::with_persistence(
        vec![relay.clone()],
        persistence.clone(),
    ));

    manager
        .record_agent_switch(
            "sess-switch".to_string(),
            AgentSwitchRecord {
                session_id: "sess-switch".to_string(),
                from_config_id: "omp".to_string(),
                to_config_id: "claude".to_string(),
                new_session_id: "sess-switch-new".to_string(),
                summary_text: "Handoff summary".to_string(),
            },
        )
        .await
        .unwrap();

    // The durable frontier advanced: one agent_switch record at seq 1.
    assert_eq!(persistence.last_seq("sess-switch").unwrap(), 1);
    let metadata = persistence.metadata("sess-switch").unwrap();
    // Switches are not messages: message_count stays unchanged.
    assert_eq!(metadata.message_count, 0);

    // The durable record carries the camelCase `AgentSwitchEvent` payload
    // (the request's five fields, plus `agentId`).
    let records = persistence.replay_after("sess-switch", 0).unwrap();
    assert_eq!(records.len(), 1);
    let record = &records[0];
    assert_eq!(record.type_, "agent_switch");
    assert_eq!(record.seq, 1);
    assert_eq!(record.payload["sessionId"], "sess-switch");
    assert_eq!(record.payload["fromConfigId"], "omp");
    assert_eq!(record.payload["toConfigId"], "claude");
    assert_eq!(record.payload["newSessionId"], "sess-switch-new");
    assert_eq!(record.payload["summaryText"], "Handoff summary");

    // The fold materializes exactly one marker (one durable record).
    let payload = persistence
        .session_payload_async("sess-switch")
        .await
        .unwrap();
    assert_eq!(payload.switches.len(), 1);
    assert_eq!(payload.switches[0].id, "switch:seq-1");

    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

/// CAP-2: an unknown session fails closed BEFORE any durable write (the
/// command's not-found pre-check contract).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn record_agent_switch_unknown_session_fails_closed() {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("termul-acp-switch-nf-{stamp}"));
    std::fs::create_dir_all(&root).unwrap();
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    persistence
        .register_session(SessionRegistration {
            session_id: "sess-known".to_string(),
            stable_agent_namespace: None,
            runtime_agent_id: None,
            project_id: None,
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    let relay = Arc::new(WsRelaySink::with_persistence(8, persistence.clone()));
    let manager = Arc::new(AcpManager::with_persistence(
        vec![relay.clone()],
        persistence.clone(),
    ));

    let error = manager
        .record_agent_switch(
            "sess-absent".to_string(),
            AgentSwitchRecord {
                session_id: "sess-absent".to_string(),
                from_config_id: "omp".to_string(),
                to_config_id: "claude".to_string(),
                new_session_id: "sess-new".to_string(),
                summary_text: "summary".to_string(),
            },
        )
        .await
        .unwrap_err();
    // Unknown session reaches the relay's host-record path and surfaces as
    // the distinguishable writer-unavailable classification; nothing is
    // allocated, and the known session is untouched (no durable record, no
    // seq advance).
    assert_eq!(error, "session writer unavailable");
    assert_eq!(relay.session_watermark("sess-absent"), 0);
    assert!(persistence
        .replay_after("sess-known", 0)
        .unwrap()
        .is_empty());
    assert_eq!(persistence.last_seq("sess-known").unwrap(), 0);

    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

// ---------------------------------------------------------------------------
// Shared admission for the `acp_*` commands (`run_ledgered`)
// ---------------------------------------------------------------------------

mod ledgered {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use serde_json::json;

    use super::*;
    use crate::acp::commands::run_ledgered;

    fn host() -> (Arc<WsRelaySink>, Arc<AcpManager>) {
        (
            Arc::new(WsRelaySink::new()),
            Arc::new(AcpManager::new(vec![])),
        )
    }

    /// Run `command` with `command_id` and a body that counts its executions.
    async fn run<T>(
        host: &(Arc<WsRelaySink>, Arc<AcpManager>),
        command: &'static str,
        command_id: Option<&str>,
        payload: serde_json::Value,
        runs: &Arc<AtomicUsize>,
        result: Result<T, String>,
    ) -> Result<T, String>
    where
        T: serde::Serialize + serde::de::DeserializeOwned + Send + 'static,
    {
        let runs = Arc::clone(runs);
        run_ledgered(
            &host.0,
            &host.1,
            command,
            command_id.map(str::to_string),
            payload,
            async move {
                runs.fetch_add(1, Ordering::SeqCst);
                result
            },
        )
        .await
    }

    #[tokio::test]
    async fn a_resend_with_the_same_command_id_replays_the_outcome_without_running_again() {
        let host = host();
        let runs = Arc::new(AtomicUsize::new(0));
        let payload = json!({"agentId": "a", "sessionId": "s"});

        let first = run(&host, "acp_close_session", Some("cmd-1"), payload.clone(), &runs, Ok(())).await;
        let again = run(&host, "acp_close_session", Some("cmd-1"), payload, &runs, Ok(())).await;

        assert_eq!(first, Ok(()));
        assert_eq!(again, Ok(()));
        assert_eq!(runs.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_rejection_replays_as_the_same_error_and_a_reused_id_for_another_request_conflicts() {
        let host = host();
        let runs = Arc::new(AtomicUsize::new(0));
        let payload = json!({"agentId": "a", "sessionId": "s"});

        let refused: Result<(), String> = run(
            &host,
            "acp_close_session",
            Some("cmd-1"),
            payload.clone(),
            &runs,
            Err("unknown agent: a".to_string()),
        )
        .await;
        let replay = run(&host, "acp_close_session", Some("cmd-1"), payload, &runs, Ok(())).await;
        let conflict = run(
            &host,
            "acp_close_session",
            Some("cmd-1"),
            json!({"agentId": "a", "sessionId": "other"}),
            &runs,
            Ok(()),
        )
        .await;

        assert_eq!(refused, Err("unknown agent: a".to_string()));
        assert_eq!(replay, Err("unknown agent: a".to_string()));
        assert!(conflict.unwrap_err().starts_with("command_conflict"));
        assert_eq!(runs.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_command_without_an_id_runs_every_time_and_a_malformed_id_runs_nothing() {
        let host = host();
        let runs = Arc::new(AtomicUsize::new(0));
        let payload = json!({"agentId": "a", "sessionId": "s"});

        for _ in 0..2 {
            let ok = run(&host, "acp_close_session", None, payload.clone(), &runs, Ok(())).await;
            assert_eq!(ok, Ok(()));
        }
        let malformed = run(&host, "acp_close_session", Some("not valid!"), payload, &runs, Ok(())).await;

        assert!(malformed.unwrap_err().starts_with("invalid_command_id"));
        assert_eq!(runs.load(Ordering::SeqCst), 2, "only the id-less runs executed");
        assert_eq!(host.0.ledger().counts(), (0, 0, 0));
    }

    #[tokio::test]
    async fn an_idempotent_command_is_validated_but_never_ledgered() {
        let host = host();
        let runs = Arc::new(AtomicUsize::new(0));
        let payload = json!({"agentId": "a"});

        for _ in 0..2 {
            let ok = run(&host, "acp_logout", Some("cmd-1"), payload.clone(), &runs, Ok(())).await;
            assert_eq!(ok, Ok(()));
        }

        assert_eq!(runs.load(Ordering::SeqCst), 2);
        assert_eq!(host.0.ledger().counts(), (0, 0, 0));
    }

    #[tokio::test]
    async fn a_receipt_only_command_replays_as_accepted_when_its_result_is_not_retained() {
        let host = host();
        let runs = Arc::new(AtomicUsize::new(0));
        let payload = json!({"agentId": "a"});

        // A status-returning body: nothing stored, so nothing to rebuild it from.
        let first = run(&host, "acp_auth_deliver_redirect", Some("cmd-1"), payload.clone(), &runs, Ok(200u16)).await;
        let replay = run(&host, "acp_auth_deliver_redirect", Some("cmd-1"), payload.clone(), &runs, Ok(200u16)).await;
        assert_eq!(first, Ok(200));
        assert!(replay.unwrap_err().starts_with("command_accepted"));

        // A unit-returning body replays as the plain success it was.
        let unit_payload = json!({"agentId": "a", "methodId": "oauth"});
        let first = run(&host, "acp_authenticate", Some("cmd-2"), unit_payload.clone(), &runs, Ok(())).await;
        let replay = run(&host, "acp_authenticate", Some("cmd-2"), unit_payload, &runs, Ok(())).await;
        assert_eq!((first, replay), (Ok(()), Ok(())));
        assert_eq!(runs.load(Ordering::SeqCst), 2, "each command ran once");
    }

    #[tokio::test]
    async fn a_struct_reply_over_the_storage_cap_replays_as_accepted() {
        let host = host();
        let runs = Arc::new(AtomicUsize::new(0));
        let payload = json!({"agentId": "a"});
        let big = || {
            Ok(crate::commands::IpcResult::success(crate::acp::install::InstallOutcome {
                command: "bin".to_string(),
                args: vec!["x".repeat(40 * 1024)],
            }))
        };

        let first = run(&host, "acp_install_agent", Some("cmd-1"), payload.clone(), &runs, big()).await;
        let replay = run(&host, "acp_install_agent", Some("cmd-1"), payload, &runs, big()).await;

        assert!(first.unwrap().success);
        assert!(replay.unwrap_err().starts_with("command_accepted"));
        assert_eq!(runs.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_create_returning_a_struct_replays_equal_through_the_serde_round_trip() {
        let host = host();
        let runs = Arc::new(AtomicUsize::new(0));

        let session = || -> crate::acp::manager::NewSessionOutcome {
            serde_json::from_value(json!({
                "sessionId": "mock-1",
                "models": {"currentModelId": "m1", "availableModels": [{"modelId": "m1", "name": "M1"}]},
            }))
            .unwrap()
        };
        let payload = json!({"agentId": "a", "cwd": "/work"});
        let first = run(&host, "acp_new_session", Some("cmd-new"), payload.clone(), &runs, Ok(session())).await.unwrap();
        let replay = run(&host, "acp_new_session", Some("cmd-new"), payload, &runs, Ok(session())).await.unwrap();
        assert_eq!(serde_json::to_value(&first).unwrap(), serde_json::to_value(&replay).unwrap());

        let spawn = || -> crate::acp::manager::SpawnOutcome {
            serde_json::from_value(json!({
                "agentId": "agent-1",
                "capabilities": {"loadSession": true},
                "authMethods": [{"id": "oauth", "name": "OAuth", "type": "agent"}],
                "hostAuthReady": true,
                "stableNamespace": "config:mock",
            }))
            .unwrap()
        };
        let payload = json!({"config": {"name": "n", "command": "c", "configId": "mock"}});
        let first = run(&host, "acp_spawn_agent", Some("cmd-spawn"), payload.clone(), &runs, Ok(spawn())).await.unwrap();
        let replay = run(&host, "acp_spawn_agent", Some("cmd-spawn"), payload, &runs, Ok(spawn())).await.unwrap();
        assert_eq!(serde_json::to_value(&first).unwrap(), serde_json::to_value(&replay).unwrap());
        assert_eq!(replay.auth_methods.len(), 1);
        assert!(replay.host_auth_ready);
        assert_eq!(runs.load(Ordering::SeqCst), 2, "each create ran once");
    }

    /// `value` -> typed -> JSON -> typed -> JSON is stable: nothing the
    /// ledger stores is lost or reshaped by the round trip.
    fn assert_round_trips<T: serde::Serialize + serde::de::DeserializeOwned>(value: serde_json::Value) {
        let once: T = serde_json::from_value(value).unwrap();
        let json = serde_json::to_value(&once).unwrap();
        let twice: T = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(serde_json::to_value(&twice).unwrap(), json);
    }

    #[test]
    fn the_replayed_reply_types_survive_a_serde_round_trip() {
        let models = json!({"currentModelId": "m1", "availableModels": [{"modelId": "m1", "name": "M1", "description": "d"}]});
        let modes = json!({"currentModeId": "ask", "availableModes": [{"id": "ask", "name": "Ask"}]});
        assert_round_trips::<crate::acp::manager::SpawnOutcome>(json!({
            "agentId": "agent-1",
            "capabilities": {"loadSession": true},
            "authMethods": [
                {"id": "a", "name": "A", "type": "terminal", "args": ["login"], "env": {"K": "v"}},
                {"id": "b", "name": "B", "description": "d", "type": "agent"},
            ],
            "hostAuthReady": false,
        }));
        assert_round_trips::<crate::acp::manager::NewSessionOutcome>(json!({
            "sessionId": "s1", "modes": modes, "models": models,
        }));
        assert_round_trips::<crate::acp::manager::SessionReopenOutcome>(json!({
            "modes": modes, "models": models,
        }));
        assert_round_trips::<crate::commands::IpcResult<crate::acp::install::InstallOutcome>>(json!({
            "success": true, "data": {"command": "/bin/x", "args": ["--a"]},
        }));
        assert_round_trips::<crate::commands::IpcResult<crate::acp::install::InstallOutcome>>(json!({
            "success": false, "error": "boom", "code": "INSTALL_FAILED",
        }));
    }
}
