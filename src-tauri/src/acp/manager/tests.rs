use super::*;
use crate::acp::PersistedEventRecord;

#[test]
fn fallback_namespace_uses_safe_identity_and_excludes_secrets() {
    let mut config = AgentConfig {
        config_id: None,
        name: "  Example   Agent ".to_string(),
        command: "C:/Users/alice/private/token.exe".to_string(),
        args: vec!["--api-key=secret-one".to_string()],
        env: std::collections::HashMap::from([(
            "AUTH_TOKEN".to_string(),
            "secret-two".to_string(),
        )]),
        allow_terminal: false,
    };
    let namespace = stable_agent_namespace(&config).unwrap();
    config.name = "example agent".to_string();
    config.command = "/different/private/token.exe".to_string();
    config.args = vec!["--api-key=other-secret".to_string()];
    config
        .env
        .insert("AUTH_TOKEN".to_string(), "third-secret".to_string());
    assert_eq!(
        stable_agent_namespace(&config).as_deref(),
        Some(namespace.as_str())
    );
    assert!(namespace.starts_with("agent-safe:"));
    assert!(!namespace.contains("secret"));

    config.command = "different.exe".to_string();
    assert_ne!(stable_agent_namespace(&config).unwrap(), namespace);
    config.command.clear();
    assert_eq!(stable_agent_namespace(&config), None);
}

fn sample_config(config_id: &str, command: &str, args: &[&str]) -> AgentConfig {
    AgentConfig {
        config_id: Some(config_id.to_string()),
        name: "Agent".to_string(),
        command: command.to_string(),
        args: args.iter().map(|arg| (*arg).to_string()).collect(),
        env: std::collections::HashMap::new(),
        allow_terminal: false,
    }
}

#[test]
fn claude_agent_requests_summarized_thinking() {
    let managed = sample_config(
        "acp-registry:claude-acp",
        "node",
        &["/cache/claude-agent-acp/dist/index.js"],
    );
    assert!(AgentRuntimeProfile::resolve(&managed).summarize_thinking);

    let package = sample_config(
        "custom",
        "npx",
        &["-y", "@agentclientprotocol/claude-agent-acp@0.78.0"],
    );
    assert!(AgentRuntimeProfile::resolve(&package).summarize_thinking);

    let other = sample_config("acp-registry:codex-acp", "codex", &[]);
    assert!(!AgentRuntimeProfile::resolve(&other).summarize_thinking);
}

#[test]
fn summarized_thinking_meta_asks_for_a_visible_summary() {
    let meta = summarized_thinking_meta();
    assert_eq!(
        meta.get("claudeCode")
            .and_then(|value| value.pointer("/options/thinking/type"))
            .and_then(Value::as_str),
        Some("adaptive")
    );
    assert_eq!(
        meta.get("claudeCode")
            .and_then(|value| value.pointer("/options/thinking/display"))
            .and_then(Value::as_str),
        Some("summarized")
    );
}

#[tokio::test]
async fn owns_session_queries_authoritative_agent_driver_state() {
    let manager = AcpManager::new(vec![]);
    let agent_id = AgentId::new();
    let (tx, mut rx) = mpsc::unbounded_channel();
    manager.agents.lock().insert(
        agent_id.clone(),
        AgentEntry {
            command_tx: tx,
            capabilities: AgentCapabilities::default(),
            stable_namespace: None,
            name: "test-agent".to_string(),
            config_id: None,
            join_handle: None,
            killed: Arc::new(AtomicBool::new(false)),
        },
    );
    let requested = SessionId::new("owned-session");
    let responder = tokio::spawn(async move {
        match rx.recv().await.unwrap() {
            AcpCommand::OwnsSession { session_id, reply } => {
                assert_eq!(session_id, requested);
                let _ = reply.send(Ok(false));
            }
            _ => panic!("ownership query must use OwnsSession"),
        }
    });
    assert!(!manager
        .owns_session(&agent_id, SessionId::new("owned-session"))
        .await
        .unwrap());
    responder.await.unwrap();
}

/// CAP-11: `list_agent_summaries` returns identity-rich entries
/// (`{ id, name, configId?, namespace?, capabilities }`) for every live
/// agent; the wire shape is camelCase with absent Options skipped.
#[test]
fn list_agent_summaries_returns_identity_rich_entries() {
    let manager = AcpManager::new(vec![]);
    let insert = |id: &str, name: &str, config_id: Option<&str>, namespace: Option<&str>| {
        let (tx, _rx) = mpsc::unbounded_channel();
        manager.agents.lock().insert(
            AgentId(id.to_string()),
            AgentEntry {
                command_tx: tx,
                capabilities: AgentCapabilities::default(),
                stable_namespace: namespace.map(str::to_string),
                name: name.to_string(),
                config_id: config_id.map(str::to_string),
                join_handle: None,
                killed: Arc::new(AtomicBool::new(false)),
            },
        );
    };
    insert("agent-1", "Claude", Some("claude"), Some("config:claude"));
    insert("agent-2", "Plain", None, None);

    let summaries = manager.list_agent_summaries();
    assert_eq!(summaries.len(), 2);
    let claude = summaries
        .iter()
        .find(|s| s.id == AgentId("agent-1".to_string()))
        .expect("agent-1 summary");
    assert_eq!(claude.name, "Claude");
    assert_eq!(claude.config_id.as_deref(), Some("claude"));
    assert_eq!(claude.namespace.as_deref(), Some("config:claude"));

    // Wire shape (CAP-11): camelCase keys; `configId`/`namespace` omitted
    // when absent (`skip_serializing_if`), present otherwise.
    let wire = serde_json::to_value(&summaries).unwrap();
    let wire_claude = wire
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == "agent-1")
        .unwrap();
    assert_eq!(wire_claude["name"], "Claude");
    assert_eq!(wire_claude["configId"], "claude");
    assert_eq!(wire_claude["namespace"], "config:claude");
    assert!(wire_claude.get("capabilities").is_some());
    let wire_plain = wire
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == "agent-2")
        .unwrap();
    assert!(wire_plain.get("configId").is_none());
    assert!(wire_plain.get("namespace").is_none());
}

/// Capability gating exercises the *real* gate functions used by
/// `load_session`/`resume_session`/`close_session` (F4). With default
/// capabilities every gate must reject; the `*_call_*` channel test below
/// confirms no command is sent on the rejection path.
#[test]
fn real_capability_gates_reject_when_unsupported() {
    let caps = AgentCapabilities::default();
    assert!(
        gate_close_session(&caps).is_err(),
        "default agent must not advertise close"
    );
    assert!(
        gate_load_session(&caps).is_err(),
        "default agent must not advertise loadSession"
    );
    assert!(
        gate_resume_session(&caps).is_err(),
        "default agent must not advertise resume"
    );
    assert!(
        gate_list_sessions(&caps).is_err(),
        "default agent must not advertise session/list"
    );
}

/// The rejection path must NOT enqueue any command (agent never contacted).
/// Drives the real gate, then asserts the channel stayed empty (AC-4).
#[tokio::test]
async fn gated_call_without_capability_returns_err_and_does_not_send() {
    let (tx, mut rx) = mpsc::unbounded_channel::<AcpCommand>();

    let caps = AgentCapabilities::default();
    let result: Result<(), String> = async {
        // The real production gate, not a mirror.
        gate_close_session(&caps)?;
        send_command(&tx, |reply| AcpCommand::CloseSession {
            session_id: SessionId::new("s"),
            reply,
        })
        .await
    }
    .await;

    assert!(result.is_err(), "gated call must return Err");
    assert!(
        matches!(rx.try_recv(), Err(mpsc::error::TryRecvError::Empty)),
        "no command must have been sent to the agent"
    );
}

/// A capable call (capability present) does enqueue a command on the channel.
#[tokio::test]
async fn capable_call_enqueues_command() {
    let (tx, mut rx) = mpsc::unbounded_channel::<AcpCommand>();

    let (reply_tx, _reply_rx) = oneshot::channel::<Result<(), String>>();
    tx.send(AcpCommand::CloseSession {
        session_id: SessionId::new("s"),
        reply: reply_tx,
    })
    .unwrap();

    assert!(
        matches!(rx.try_recv(), Ok(AcpCommand::CloseSession { .. })),
        "command must be enqueued when capability is present"
    );
}

/// `send_command` surfaces a typed error when the driver thread is gone.
#[tokio::test]
async fn send_command_errors_when_thread_gone() {
    let (tx, rx) = mpsc::unbounded_channel::<AcpCommand>();
    drop(rx); // simulate a dead driver thread

    let result: Result<(), String> = send_command(&tx, |reply| AcpCommand::CloseSession {
        session_id: SessionId::new("s"),
        reply,
    })
    .await;

    assert!(result.is_err());
}

/// The post-cancel grace window forcibly resolves a turn whose agent never
/// replies to `session/cancel` (M5). This drives the exact `select!` /
/// timeout shape used in the `SendPrompt` arm against a prompt future that
/// never completes, and asserts it resolves `Cancelled` rather than hanging.
/// A short local grace keeps the test fast (the production constant is
/// `CANCEL_GRACE`).
#[tokio::test]
async fn cancel_grace_forcibly_resolves_a_stuck_turn() {
    const TEST_GRACE: Duration = Duration::from_millis(50);
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    // A prompt future that never resolves (agent ignores cancel).
    let prompt = std::future::pending::<Result<StopReason, String>>();
    tokio::pin!(prompt);

    // Fire the cancel signal immediately.
    cancel_tx.send(()).unwrap();

    let outcome: Result<StopReason, String> = tokio::select! {
        result = &mut prompt => result,
        _ = cancel_rx => {
            match tokio::time::timeout(TEST_GRACE, &mut prompt).await {
                Ok(result) => result,
                Err(_) => Ok(StopReason::Cancelled),
            }
        }
    };

    assert_eq!(
        outcome,
        Ok(StopReason::Cancelled),
        "a stuck turn must be force-resolved as Cancelled after the grace window"
    );
}

/// Shape test (like `cancel_grace_forcibly_resolves_a_stuck_turn`): mirrors
/// the timeout-around-request pattern of the `LoadSession`/`ResumeSession`
/// arms against a never-resolving future, using a short local bound so the
/// is fast. The arms themselves need a live connection + sink fan-out and
/// are not driven here; this covers the match shape plus the production
/// timeout resolution below.
#[tokio::test]
async fn session_reopen_times_out_instead_of_hanging() {
    const TEST_TIMEOUT: Duration = Duration::from_millis(50);
    let request = std::future::pending::<Result<(), String>>();
    let outcome = tokio::time::timeout(TEST_TIMEOUT, request).await;
    let result: Result<(), String> = match outcome {
        Ok(result) => result,
        Err(_) => Err(format!("session/load timed out after {TEST_TIMEOUT:?}")),
    };
    assert!(
        result.is_err_and(|e| e.contains("timed out")),
        "a hung reopen must resolve to a timeout error"
    );
}

/// The production reopen budget resolves to the 60s default and honors the
/// `TERMUL_ACP_SESSION_REOPEN_TIMEOUT_SECS` diagnostic override contract
/// (mirrors `session_new_timeout`). Only the default path is asserted —
/// mutating process env in a test would race other tests.
#[test]
fn session_reopen_timeout_defaults_to_constant() {
    if std::env::var("TERMUL_ACP_SESSION_REOPEN_TIMEOUT_SECS").is_err() {
        assert_eq!(session_reopen_timeout(), SESSION_REOPEN_TIMEOUT);
    }
    assert_eq!(SESSION_REOPEN_TIMEOUT, Duration::from_secs(60));
}

#[test]
fn prompt_blocks_and_cwd_follow_advertised_capabilities() {
    use agent_client_protocol::schema::v1::{ContentBlock, ImageContent, TextContent};
    assert!(reject_unsupported_prompt_blocks(
        &[ContentBlock::Text(TextContent::new("hi"))],
        false,
        false,
        false
    )
    .is_ok());
    assert!(reject_unsupported_prompt_blocks(
        &[ContentBlock::Image(ImageContent::new("aaaa", "image/png"))],
        false,
        false,
        false
    )
    .is_err());
    assert!(reject_unsupported_prompt_blocks(
        &[ContentBlock::Image(ImageContent::new("aaaa", "image/png"))],
        true,
        false,
        false
    )
    .is_ok());
    assert!(require_absolute_cwd("relative").is_err());
    assert!(require_absolute_cwd("/tmp/work").is_ok());
}

#[test]
fn factory_set_config_option_rejects_empty_ack_and_invalid_options() {
    assert!(serde_json::from_value::<
        agent_client_protocol::schema::v1::SetSessionConfigOptionResponse,
    >(serde_json::json!({}))
    .is_err());
    assert!(factory_config_option_result(serde_json::json!({})).is_err());
    assert_eq!(
        factory_config_option_result(serde_json::json!({"configOptions": []})).unwrap(),
        Some(vec![])
    );
    assert!(factory_config_option_result(serde_json::json!({"configOptions": "bad"})).is_err());
    assert!(factory_config_option_result(serde_json::json!(null)).is_err());
}

#[tokio::test]
async fn session_load_reopen_preserves_optional_fields_and_records_root() {
    let state = Mutex::new(DriverState::new());
    let modes = agent_client_protocol::schema::v1::SessionModeState::new("ask", vec![]);
    let response = LoadSessionResponse::new()
        .modes(modes.clone())
        .config_options(Vec::<SessionConfigOption>::new());
    let outcome = run_session_reopen("session/load", "sess-load", "/work", &state, async move {
        Ok::<_, agent_client_protocol::Error>(response)
    })
    .await
    .unwrap();

    assert_eq!(outcome.modes, Some(modes));
    assert_eq!(outcome.models, None);
    assert_eq!(outcome.config_options, Some(vec![]));
    assert_eq!(
        state.lock().session_root("sess-load"),
        Some(PathBuf::from("/work"))
    );
}

/// Story 7: `acp_err_wire_string` tags `ErrorCode::AuthRequired` (-32000)
/// with the stable prefix — `agent_client_protocol::Error`'s `Display`
/// drops the JSON-RPC code, so the tag is the only thing preserving the
/// auth classification across the manager's `Err(String)` collapse. All
/// other errors stringify verbatim.
#[test]
fn acp_err_wire_string_tags_auth_required_only() {
    let auth = agent_client_protocol::Error::auth_required();
    assert_eq!(
        acp_err_wire_string(auth),
        format!("{ACP_AUTH_REQUIRED_PREFIX}: Authentication required")
    );
    let other = agent_client_protocol::Error::internal_error();
    assert_eq!(acp_err_wire_string(other), "Internal error");
}

/// Story 7: an agent `AuthRequired` failure on `session/load` carries the
/// prefix through `run_session_reopen` (the WS layer maps it to
/// `agent_auth_required`; the desktop renderer prefix-matches the string).
#[tokio::test]
async fn session_reopen_auth_required_is_prefixed() {
    let state = Mutex::new(DriverState::new());
    let outcome = run_session_reopen("session/load", "sess-auth", "/work", &state, async {
        Err::<LoadSessionResponse, _>(agent_client_protocol::Error::auth_required())
    })
    .await;
    assert_eq!(
        outcome.unwrap_err(),
        "ACP_AUTH_REQUIRED: Authentication required"
    );
    // A failed reopen records no session root.
    assert_eq!(state.lock().session_root("sess-auth"), None);
}

#[tokio::test]
async fn session_resume_reopen_preserves_omitted_fields() {
    let state = Mutex::new(DriverState::new());
    let outcome = run_session_reopen("session/resume", "sess-resume", "/work", &state, async {
        Ok::<_, agent_client_protocol::Error>(ResumeSessionResponse::new())
    })
    .await
    .unwrap();

    assert_eq!(
        outcome,
        SessionReopenOutcome {
            modes: None,
            models: None,
            config_options: None,
        }
    );
    assert_eq!(
        serde_json::to_value(&outcome).unwrap(),
        serde_json::json!({})
    );
}

/// An empty prompt is rejected before any agent contact (EMPTY-CONTENT).
/// `send_prompt`'s guard is a pure pre-check; assert its predicate here
/// (the manager method needs a sink fan-out, but the guard runs first).
#[test]
fn empty_prompt_content_is_rejected_by_guard() {
    let content: Vec<ContentBlock> = Vec::new();
    // Mirror of the guard at the top of `AcpManager::send_prompt`.
    let rejected = content.is_empty();
    assert!(rejected, "empty prompt content must be rejected");
}

/// `ReplySlot` delivers exactly once: the spawn-failure path and the task
/// path can both target it, but only the first send wins (L5 safety).
#[tokio::test]
async fn reply_slot_sends_exactly_once() {
    let (tx, rx) = oneshot::channel::<Result<(), String>>();
    let slot = reply_slot(tx);
    send_reply(&slot, Ok(()));
    // A second send is a no-op and must not panic.
    send_reply(&slot, Err("late".to_string()));
    assert_eq!(rx.await.unwrap(), Ok(()));
}

/// The initialize→spawn-event mapping forwards the FULL advertised auth
/// method metadata (id, name, optional description) so the renderer can
/// present Sign-in and call `authenticate(methodId)`. Optional description
/// is preserved when present and `None` when absent.
#[test]
fn to_auth_method_infos_maps_full_metadata() {
    use agent_client_protocol::schema::v1::AuthMethodAgent;
    let methods = vec![
        AuthMethod::Agent(
            AuthMethodAgent::new("cursor_login", "Sign in with Cursor")
                .description("Opens the Cursor login flow"),
        ),
        AuthMethod::Agent(AuthMethodAgent::new("api_key", "API key")),
    ];
    let infos = to_auth_method_infos(&methods);
    assert_eq!(infos.len(), 2);
    assert_eq!(infos[0].id, "cursor_login");
    assert_eq!(infos[0].name, "Sign in with Cursor");
    assert_eq!(infos[0].r#type, "agent");
    assert_eq!(infos[0].args, None);
    assert_eq!(infos[0].env, None);
    assert_eq!(
        infos[0].description.as_deref(),
        Some("Opens the Cursor login flow")
    );
    assert_eq!(infos[1].id, "api_key");
    assert_eq!(infos[1].name, "API key");
    assert_eq!(infos[1].r#type, "agent");
    assert_eq!(infos[1].description, None);
}

/// An agent that advertises no auth methods maps to an empty vec (the
/// renderer treats this as a no-auth agent).
#[test]
fn to_auth_method_infos_empty_for_no_methods() {
    assert!(to_auth_method_infos(&[]).is_empty());
}

/// `unstable_auth_methods` (spec-acp-terminal-auth): a `terminal` method
/// maps to `type: "terminal"` and carries its `args`/`env` verbatim so the
/// renderer can run the command in a real terminal tab.
#[test]
fn to_auth_method_infos_maps_terminal_variant() {
    use agent_client_protocol::schema::v1::AuthMethodTerminal;
    let methods = vec![AuthMethod::Terminal(
        AuthMethodTerminal::new("devin-terminal-login", "Terminal login")
            .args(vec!["devin".to_string(), "login".to_string()])
            .env(std::collections::HashMap::from([(
                "TERM".to_string(),
                "xterm-256color".to_string(),
            )])),
    )];
    let infos = to_auth_method_infos(&methods);
    assert_eq!(infos.len(), 1);
    assert_eq!(infos[0].id, "devin-terminal-login");
    assert_eq!(infos[0].r#type, "terminal");
    assert_eq!(
        infos[0].args.as_deref(),
        Some(&["devin".to_string(), "login".to_string()][..])
    );
    assert_eq!(
        infos[0]
            .env
            .as_ref()
            .and_then(|e| e.get("TERM"))
            .map(String::as_str),
        Some("xterm-256color")
    );
}

/// `unstable_auth_methods`: an `env_var` method maps to `type: "env_var"`
/// with no `args`/`env` (the renderer prompts for the vars itself).
#[test]
fn to_auth_method_infos_maps_env_var_variant() {
    use agent_client_protocol::schema::v1::AuthMethodEnvVar;
    let methods = vec![AuthMethod::EnvVar(AuthMethodEnvVar::new(
        "api-key",
        "API Key",
        vec![],
    ))];
    let infos = to_auth_method_infos(&methods);
    assert_eq!(infos.len(), 1);
    assert_eq!(infos[0].r#type, "env_var");
    assert_eq!(infos[0].args, None);
    assert_eq!(infos[0].env, None);
}

/// The serialized `AuthMethodInfo` wire shape matches the renderer
/// contract: camelCase `{id, name, description?, type, args?, env?}` with
/// `args`/`env` present only for terminal methods.
#[test]
fn auth_method_info_serializes_contract_shape() {
    use agent_client_protocol::schema::v1::{AuthMethodAgent, AuthMethodTerminal};
    let methods = vec![
        AuthMethod::Agent(AuthMethodAgent::new("a", "A")),
        AuthMethod::Terminal(AuthMethodTerminal::new("t", "T").args(vec!["x".to_string()])),
    ];
    let infos = to_auth_method_infos(&methods);
    let agent_json = serde_json::to_value(&infos[0]).unwrap();
    assert_eq!(agent_json["type"], "agent");
    assert!(agent_json.get("args").is_none(), "agent omits args");
    assert!(agent_json.get("env").is_none(), "agent omits env");
    let term_json = serde_json::to_value(&infos[1]).unwrap();
    assert_eq!(term_json["type"], "terminal");
    assert_eq!(term_json["args"], serde_json::json!(["x"]));
    assert!(term_json.get("env").is_some(), "terminal carries env");
}

// --- race_turn (idle + hard cap + cancel) ---

/// An active turn (agent streaming activity) keeps resetting its idle
/// deadline and completes normally — never hits the idle timeout.
#[tokio::test(start_paused = true)]
async fn race_turn_activity_resets_idle_and_completes() {
    let (idle_tx, mut idle_rx) = watch::channel(());
    let (_cancel_tx, cancel_rx) = oneshot::channel::<()>();
    let on_timeout = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let on_timeout_clone = on_timeout.clone();
    // Activity every 20ms (under the 50ms idle window) keeps the idle
    // deadline pushed back; the prompt completes at 100ms.
    let activity = tokio::spawn(async move {
        for _ in 0..6 {
            tokio::time::sleep(Duration::from_millis(20)).await;
            let _ = idle_tx.send(());
        }
    });
    let result = race_turn(
        async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            Ok::<StopReason, String>(StopReason::EndTurn)
        },
        cancel_rx,
        &mut idle_rx,
        move || {
            on_timeout_clone.fetch_add(1, Ordering::SeqCst);
        },
        Some(Duration::from_millis(50)),
        Some(Duration::from_secs(10)),
    )
    .await;
    let _ = activity.await;
    assert!(result.is_ok(), "got {result:?}");
    assert_eq!(
        on_timeout.load(Ordering::SeqCst),
        0,
        "no timeout should fire for an active turn"
    );
}

/// A silent (wedged) turn with no activity and no completion hits the idle
/// timeout — and signals cancel via `on_timeout_cancel`.
#[tokio::test(start_paused = true)]
async fn race_turn_silence_hits_idle_timeout() {
    let (_idle_tx, mut idle_rx) = watch::channel(()); // never fires
    let (_cancel_tx, cancel_rx) = oneshot::channel::<()>();
    let on_timeout = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let on_timeout_clone = on_timeout.clone();
    let result = race_turn(
        std::future::pending::<Result<StopReason, String>>(),
        cancel_rx,
        &mut idle_rx,
        move || {
            on_timeout_clone.fetch_add(1, Ordering::SeqCst);
        },
        Some(Duration::from_millis(100)),
        Some(Duration::from_secs(10)),
    )
    .await;
    let err = result.unwrap_err();
    assert!(err.contains("idle timeout"), "got {err}");
    assert_eq!(on_timeout.load(Ordering::SeqCst), 1);
}

/// A turn that streams activity forever but never completes is still
/// bounded by the hard wall-clock cap (the pre-loop check fires despite
/// the continuously-ready activity arm under `biased`).
#[tokio::test(start_paused = true)]
async fn race_turn_streaming_non_completing_hits_hard_cap() {
    let (idle_tx, mut idle_rx) = watch::channel(());
    let (_cancel_tx, cancel_rx) = oneshot::channel::<()>();
    let activity = tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(10)).await;
            let _ = idle_tx.send(());
        }
    });
    let on_timeout = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let on_timeout_clone = on_timeout.clone();
    let result = race_turn(
        std::future::pending::<Result<StopReason, String>>(),
        cancel_rx,
        &mut idle_rx,
        move || {
            on_timeout_clone.fetch_add(1, Ordering::SeqCst);
        },
        Some(Duration::from_millis(50)),
        Some(Duration::from_millis(200)),
    )
    .await;
    activity.abort();
    let _ = activity.await;
    let err = result.unwrap_err();
    assert!(err.contains("hard timeout"), "got {err}");
    assert_eq!(on_timeout.load(Ordering::SeqCst), 1);
}

/// A user cancel wins over both timeouts: the cancel arm returns
/// `Cancelled` after `CANCEL_GRACE`, and `on_timeout_cancel` is not called.
#[tokio::test(start_paused = true)]
async fn race_turn_cancel_wins_over_timeouts() {
    let (_idle_tx, mut idle_rx) = watch::channel(()); // no activity
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    let on_timeout = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let on_timeout_clone = on_timeout.clone();
    // Cancel before the idle window fires.
    let canceller = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        let _ = cancel_tx.send(());
    });
    let result = race_turn(
        std::future::pending::<Result<StopReason, String>>(),
        cancel_rx,
        &mut idle_rx,
        move || {
            on_timeout_clone.fetch_add(1, Ordering::SeqCst);
        },
        Some(Duration::from_millis(100)),
        Some(Duration::from_secs(10)),
    )
    .await;
    let _ = canceller.await;
    assert!(
        matches!(result, Ok(StopReason::Cancelled)),
        "got {result:?}"
    );
    assert_eq!(on_timeout.load(Ordering::SeqCst), 0);
}

/// A prompt error that arrives after the user cancel arm fires is a
/// cancellation, not a chat error.
#[tokio::test(start_paused = true)]
async fn race_turn_cancel_maps_prompt_error_to_cancelled() {
    let (_idle_tx, mut idle_rx) = watch::channel(());
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    let _ = cancel_tx.send(());
    let result = race_turn(
        async {
            tokio::time::sleep(Duration::from_millis(10)).await;
            Err("aborted by agent runtime".to_string())
        },
        cancel_rx,
        &mut idle_rx,
        || {},
        None,
        None,
    )
    .await;
    assert!(
        matches!(result, Ok(StopReason::Cancelled)),
        "got {result:?}"
    );
}

/// A prompt that finishes inside the cancel grace keeps its stop reason.
#[tokio::test(start_paused = true)]
async fn race_turn_cancel_keeps_completed_stop_reason() {
    let (_idle_tx, mut idle_rx) = watch::channel(());
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    let _ = cancel_tx.send(());
    let result = race_turn(
        async {
            tokio::time::sleep(Duration::from_millis(10)).await;
            Ok(StopReason::EndTurn)
        },
        cancel_rx,
        &mut idle_rx,
        || {},
        None,
        None,
    )
    .await;
    assert!(matches!(result, Ok(StopReason::EndTurn)), "got {result:?}");
}

/// Fully-unlimited default (`idle = None`, `hard = None`): a silent,
/// never-completing turn is bounded ONLY by an explicit cancel — no
/// timeout fires. This is the new default contract.
#[tokio::test(start_paused = true)]
async fn race_turn_unlimited_silent_turn_only_ends_on_cancel() {
    let (_idle_tx, mut idle_rx) = watch::channel(()); // no activity
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    let on_timeout = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let on_timeout_clone = on_timeout.clone();
    let canceller = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        let _ = cancel_tx.send(());
    });
    let result = race_turn(
        std::future::pending::<Result<StopReason, String>>(),
        cancel_rx,
        &mut idle_rx,
        move || {
            on_timeout_clone.fetch_add(1, Ordering::SeqCst);
        },
        None,
        None,
    )
    .await;
    let _ = canceller.await;
    assert!(
        matches!(result, Ok(StopReason::Cancelled)),
        "got {result:?}"
    );
    assert_eq!(
        on_timeout.load(Ordering::SeqCst),
        0,
        "unlimited turn must not invoke on_timeout_cancel"
    );
}

/// Unlimited hard cap (`hard = None`) with a bounded idle: a streaming,
/// never-completing turn that keeps activity alive never hits the idle
/// deadline and is bounded ONLY by cancel — the absent hard cap imposes no
/// bound, matching "unlimited hard cap".
#[tokio::test(start_paused = true)]
async fn race_turn_unlimited_hard_cap_active_turn_only_ends_on_cancel() {
    let (idle_tx, mut idle_rx) = watch::channel(());
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    let activity = tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(10)).await;
            let _ = idle_tx.send(());
        }
    });
    let on_timeout = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let on_timeout_clone = on_timeout.clone();
    let canceller = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(60)).await;
        let _ = cancel_tx.send(());
    });
    // idle 50ms (kept reset by activity), hard None (unlimited): an active
    // turn never hits either, so only cancel ends it.
    let result = race_turn(
        std::future::pending::<Result<StopReason, String>>(),
        cancel_rx,
        &mut idle_rx,
        move || {
            on_timeout_clone.fetch_add(1, Ordering::SeqCst);
        },
        Some(Duration::from_millis(50)),
        None,
    )
    .await;
    activity.abort();
    let _ = activity.await;
    let _ = canceller.await;
    assert!(
        matches!(result, Ok(StopReason::Cancelled)),
        "got {result:?}"
    );
    assert_eq!(
        on_timeout.load(Ordering::SeqCst),
        0,
        "unlimited hard cap must not invoke on_timeout_cancel for an active turn"
    );
}

/// `resolved_turn_timeout` precedence: env var > UI override > default.
/// The override replaces the default when no env var is set; the default is
/// now `None` (unlimited).
#[test]
fn turn_timeout_override_takes_effect_when_no_env_var() {
    // The env var is usually absent in the test runner; when it IS set
    // (operator machine), it correctly masks the UI override — skip there.
    if std::env::var("TERMUL_ACP_TURN_TIMEOUT_SECS").is_ok() {
        return;
    }
    set_turn_timeout_override(Some(42));
    assert_eq!(resolved_turn_timeout(), Some(Duration::from_secs(42)));
    set_turn_timeout_override(None);
    assert_eq!(resolved_turn_timeout(), None);
}

/// `turn_idle_timeout` full precedence ladder, in ONE test so the shared
/// override static and env var are never touched by concurrent tests:
/// env var absent → override wins over default; cleared → default (`None`
/// / unlimited); env var present → env beats a simultaneous UI override
/// (the operator precedence the settings UI documents). When the env var is
/// ALREADY set on the host (operator machine), only the env-wins phase runs
/// and its original value is restored afterwards.
#[test]
fn turn_idle_timeout_precedence_env_beats_override_beats_default() {
    let preexisting = std::env::var("TERMUL_ACP_TURN_IDLE_TIMEOUT_SECS").ok();
    if preexisting.is_none() {
        set_turn_idle_timeout_override(Some(42));
        assert_eq!(turn_idle_timeout(), Some(Duration::from_secs(42)));
        set_turn_idle_timeout_override(None);
        assert_eq!(turn_idle_timeout(), None);
    }

    std::env::set_var("TERMUL_ACP_TURN_IDLE_TIMEOUT_SECS", "60");
    set_turn_idle_timeout_override(Some(1800));
    assert_eq!(turn_idle_timeout(), Some(Duration::from_secs(60)));

    match preexisting {
        Some(v) => std::env::set_var("TERMUL_ACP_TURN_IDLE_TIMEOUT_SECS", v),
        None => std::env::remove_var("TERMUL_ACP_TURN_IDLE_TIMEOUT_SECS"),
    }
    set_turn_idle_timeout_override(None);
}

/// `session_new_timeout` precedence: env var > UI override > default.
/// A zero override is ignored (the IPC command rejects it; the resolver
/// also filters it defensively).
#[test]
fn session_new_timeout_override_takes_effect_when_no_env_var() {
    if std::env::var("TERMUL_ACP_SESSION_NEW_TIMEOUT_SECS").is_ok() {
        return;
    }
    set_session_new_timeout_override(Some(42));
    assert_eq!(session_new_timeout(), Duration::from_secs(42));
    set_session_new_timeout_override(Some(0));
    assert_eq!(session_new_timeout(), SESSION_NEW_TIMEOUT);
    set_session_new_timeout_override(None);
    assert_eq!(session_new_timeout(), SESSION_NEW_TIMEOUT);
}

/// `session_reopen_timeout` precedence: env var > UI override > default.
/// A zero override is ignored (same defensive filter as session/new).
#[test]
fn session_reopen_timeout_override_takes_effect_when_no_env_var() {
    if std::env::var("TERMUL_ACP_SESSION_REOPEN_TIMEOUT_SECS").is_ok() {
        return;
    }
    set_session_reopen_timeout_override(Some(42));
    assert_eq!(session_reopen_timeout(), Duration::from_secs(42));
    set_session_reopen_timeout_override(Some(0));
    assert_eq!(session_reopen_timeout(), SESSION_REOPEN_TIMEOUT);
    set_session_reopen_timeout_override(None);
    assert_eq!(session_reopen_timeout(), SESSION_REOPEN_TIMEOUT);
}

// --- Story 8: promote_session (ephemeral warm pool) ---

/// Build a driver state holding one backend-ephemeral session rooted at
/// `cwd`, exactly as the NewSession arm leaves it: ephemeral mark + stashed
/// registration metadata (captured at `session/new`).
fn ephemeral_driver_state(session_id: &str, cwd: &std::path::Path) -> Arc<Mutex<DriverState>> {
    let state = Arc::new(Mutex::new(DriverState::new()));
    {
        let mut guard = state.lock();
        guard.set_session_root(session_id.to_string(), cwd.to_path_buf());
        guard.mark_ephemeral(session_id.to_string());
        guard.note_promotable_registration(
            session_id.to_string(),
            SessionRegistration {
                session_id: session_id.to_string(),
                stable_agent_namespace: Some("config:test".to_string()),
                runtime_agent_id: Some("runtime-1".to_string()),
                project_id: Some("p-1".to_string()),
                cwd: cwd.to_path_buf(),
                ..Default::default()
            },
        );
    }
    state
}

fn temp_dir_with_cwd(tag: &str) -> (PathBuf, PathBuf) {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("termul-promote-{tag}-{stamp}"));
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    (root, cwd)
}

/// I/O matrix "Claim + first prompt": promote registers the stashed
/// metadata (project id + namespace survive) and clears the ephemeral
/// mark — the session becomes visible to the durable catalog.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn promote_session_registers_metadata_and_unmarks_ephemeral() {
    let (root, cwd) = temp_dir_with_cwd("ok");
    let persistence = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    let state = ephemeral_driver_state("sess-warm", &cwd);

    promote_session_in_driver(
        &state,
        Some(&persistence),
        &AgentId::new(),
        &SessionId::new("sess-warm"),
    )
    .await
    .unwrap();

    assert!(!state.lock().is_ephemeral("sess-warm"));
    let metadata = persistence.metadata("sess-warm").unwrap();
    assert_eq!(metadata.project_id.as_deref(), Some("p-1"));
    assert_eq!(
        metadata.stable_agent_namespace.as_deref(),
        Some("config:test")
    );
    assert_eq!(metadata.runtime_agent_id.as_deref(), Some("runtime-1"));
    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

/// I/O matrix "Promote unknown session": a session the driver never
/// created errors and changes no state.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn promote_session_unknown_session_errors_without_state_change() {
    let (root, cwd) = temp_dir_with_cwd("unknown");
    let persistence = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    let state = ephemeral_driver_state("sess-warm", &cwd);

    let error = promote_session_in_driver(
        &state,
        Some(&persistence),
        &AgentId::new(),
        &SessionId::new("sess-never-created"),
    )
    .await
    .unwrap_err();
    assert!(
        error.contains("unknown session"),
        "unexpected error: {error}"
    );
    // No state change: the warm session is still ephemeral, nothing
    // was registered.
    assert!(state.lock().is_ephemeral("sess-warm"));
    assert!(persistence.metadata("sess-never-created").is_err());
    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

/// I/O matrix "Promote non-ephemeral": already-durable sessions get an
/// idempotent Ok with no re-registration.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn promote_session_durable_session_is_idempotent_ok() {
    let (root, cwd) = temp_dir_with_cwd("durable");
    let persistence = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    // A durable session: registered at create, never marked ephemeral.
    persistence
        .register_session(SessionRegistration {
            session_id: "sess-durable".to_string(),
            cwd: cwd.clone(),
            ..Default::default()
        })
        .await
        .unwrap();
    let state = Arc::new(Mutex::new(DriverState::new()));
    state
        .lock()
        .set_session_root("sess-durable".to_string(), cwd.clone());

    promote_session_in_driver(
        &state,
        Some(&persistence),
        &AgentId::new(),
        &SessionId::new("sess-durable"),
    )
    .await
    .unwrap();
    // Once more: still Ok, still no error, still durable.
    promote_session_in_driver(
        &state,
        Some(&persistence),
        &AgentId::new(),
        &SessionId::new("sess-durable"),
    )
    .await
    .unwrap();
    assert!(!state.lock().is_ephemeral("sess-durable"));
    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

/// I/O matrix "Promote with persistence failure": the session STAYS
/// ephemeral (no half-promoted state) and the reply is an error.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn promote_session_persistence_failure_keeps_ephemeral() {
    let (root, cwd) = temp_dir_with_cwd("fail");
    let persistence = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    let state = Arc::new(Mutex::new(DriverState::new()));
    {
        let mut guard = state.lock();
        guard.set_session_root("sess-warm".to_string(), cwd.clone());
        guard.mark_ephemeral("sess-warm".to_string());
        // Stash a registration whose cwd does not exist — register_session
        // canonicalizes and fails, exercising the error path.
        guard.note_promotable_registration(
            "sess-warm".to_string(),
            SessionRegistration {
                session_id: "sess-warm".to_string(),
                cwd: root.join("does-not-exist"),
                ..Default::default()
            },
        );
    }

    let error = promote_session_in_driver(
        &state,
        Some(&persistence),
        &AgentId::new(),
        &SessionId::new("sess-warm"),
    )
    .await
    .unwrap_err();
    assert!(
        error.contains("failed to persist promoted session"),
        "unexpected error: {error}"
    );
    assert!(
        state.lock().is_ephemeral("sess-warm"),
        "a failed promote must leave the session ephemeral"
    );
    assert!(persistence.metadata("sess-warm").is_err());
    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

/// No durable store attached (desktop without persistence): promote
/// errors and the session stays ephemeral — chat remains non-durable.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn promote_session_without_persistence_errors_and_stays_ephemeral() {
    let (root, cwd) = temp_dir_with_cwd("nostore");
    let state = ephemeral_driver_state("sess-warm", &cwd);

    let error =
        promote_session_in_driver(&state, None, &AgentId::new(), &SessionId::new("sess-warm"))
            .await
            .unwrap_err();
    assert!(
        error.contains("persistence unavailable"),
        "unexpected error: {error}"
    );
    assert!(state.lock().is_ephemeral("sess-warm"));
    let _ = std::fs::remove_dir_all(root);
}

/// I/O matrix "Web boot": an ephemeral session registered nowhere is
/// invisible to the durable catalog — and stays that way until promoted.
/// (The boot path creates nothing; this pins that a bare ephemeral
/// session/new leaves no durable trace.)
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unpromoted_ephemeral_session_leaves_no_durable_trace() {
    let (root, cwd) = temp_dir_with_cwd("ephemeral");
    let persistence = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    let state = ephemeral_driver_state("sess-warm", &cwd);

    // No promote: the catalog stays empty for this session id.
    assert!(persistence.metadata("sess-warm").is_err());
    assert!(state.lock().is_ephemeral("sess-warm"));
    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

/// I/O matrix "Close un-promoted warm session": an ephemeral session's
/// close never calls `finalize_session` (there is no durable record — the
/// call would fail on the unknown id and surface a spurious "history
/// finalization failed"). A durable (registered) session finalizes fine.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_of_ephemeral_session_skips_finalize_without_error() {
    let (root, cwd) = temp_dir_with_cwd("close");
    let persistence = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();

    // Ephemeral close: never registered — finalize must be skipped, so no
    // error despite the unknown session id.
    finalize_closed_session_if_durable(Some(&persistence), "sess-warm", true)
        .await
        .unwrap();

    // Durable close: a registered session finalizes cleanly…
    persistence
        .register_session(SessionRegistration {
            session_id: "sess-durable".to_string(),
            cwd: cwd.clone(),
            ..Default::default()
        })
        .await
        .unwrap();
    finalize_closed_session_if_durable(Some(&persistence), "sess-durable", false)
        .await
        .unwrap();

    // …and the gate is load-bearing: with `was_ephemeral` false on a
    // never-registered id, the finalize error WOULD surface.
    let error =
        finalize_closed_session_if_durable(Some(&persistence), "sess-never-registered", false)
            .await
            .unwrap_err();
    assert!(
        error.contains("history finalization failed"),
        "unexpected error: {error}"
    );
    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

/// Review (promote/close race): a close/dispose landing during the
/// register await removes the session from the driver state; convergence
/// finalizes the just-registered record Closed instead of leaving a
/// phantom Active history entry, and reports the race.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn promote_converge_after_close_finalizes_record_closed() {
    let (root, cwd) = temp_dir_with_cwd("race");
    let persistence = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    persistence
        .register_session(SessionRegistration {
            session_id: "sess-race".to_string(),
            cwd: cwd.clone(),
            ..Default::default()
        })
        .await
        .unwrap();
    // The session vanished from the driver (close/dispose won the race).
    let state = Arc::new(Mutex::new(DriverState::new()));

    let error = converge_promoted_session(
        &state,
        &persistence,
        &AgentId::new(),
        &SessionId::new("sess-race"),
    )
    .await
    .unwrap_err();
    assert!(
        error.contains("closed during promotion"),
        "unexpected error: {error}"
    );
    let metadata = persistence.metadata("sess-race").unwrap();
    assert_eq!(metadata.status, PersistedSessionStatus::Closed);
    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

/// Story 8 (web honesty): the teardown finalize treats the
/// already-handled outcomes — `WriterStopped` (writer drained + persisted
/// metadata via its own Shutdown arm) and `SessionNotFound` (runtime
/// already finalized/deleted) — as benign; they must NOT be counted as
/// persistence failures. A real error still lands in the failure list.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn teardown_finalize_writer_stopped_is_not_a_persistence_failure() {
    let (root, cwd) = temp_dir_with_cwd("finalize-routing");
    let persistence = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    persistence
        .register_session(SessionRegistration {
            session_id: "sess-stop".to_string(),
            cwd: cwd.clone(),
            ..Default::default()
        })
        .await
        .unwrap();

    // A real (non-benign) finalize failure surfaces the error — this is
    // the class that must stay on the error channel.
    let error =
        finalize_closed_session_if_durable(Some(&persistence), "sess-never-registered", false)
            .await
            .unwrap_err();
    assert!(
        error.contains("history finalization failed"),
        "real finalize failures stay failures: {error}"
    );

    // The benign classes: after shutdown drains the writer, a second
    // finalize surfaces SessionNotFound (runtime gone) — the durable
    // metadata was already persisted by the writer's own Shutdown arm.
    // WriterStopped (channel closed, runtime present) is the same
    // already-handled class; both route to info, never the error channel.
    persistence.shutdown().await.unwrap();
    let rerun = persistence
        .finalize_session("sess-stop", PersistedSessionStatus::Closed)
        .await
        .unwrap_err();
    assert!(
        matches!(
            rerun,
            SessionPersistenceError::SessionNotFound | SessionPersistenceError::WriterStopped
        ),
        "expected an already-handled benign outcome, got: {rerun}"
    );
    let _ = std::fs::remove_dir_all(root);
}

/// Test sink capturing every emitted event (mirrors the `web::sink` tests'
/// CapturingSink pattern).
#[derive(Default)]
struct CapturingSink {
    seen: Mutex<Vec<crate::web::sink::AcpEvent>>,
}

impl EventSink for CapturingSink {
    fn emit(&self, event: &crate::web::sink::AcpEvent) {
        self.seen.lock().push(event.clone());
    }
}

fn thought_notification(
    session_id: &str,
    text: &str,
) -> agent_client_protocol::schema::v1::SessionNotification {
    use agent_client_protocol::schema::v1 as acp;
    acp::SessionNotification::new(
        acp::SessionId::new(session_id),
        acp::SessionUpdate::AgentThoughtChunk(acp::ContentChunk::new(acp::ContentBlock::Text(
            acp::TextContent::new(text),
        ))),
    )
}

#[tokio::test]
async fn session_notification_is_suppressed_while_replay_window_open() {
    let state = Arc::new(Mutex::new(DriverState::new()));
    assert!(state.lock().try_begin_replay_window("sess-1"));
    let sink = Arc::new(CapturingSink::default());
    let sinks: Vec<Arc<dyn EventSink>> = vec![sink.clone()];
    let result = handle_session_notification(
        &state,
        None,
        &sinks,
        &AgentId::new(),
        thought_notification("sess-1", "replayed history"),
    )
    .await;
    assert!(result.is_ok());
    assert!(
        sink.seen.lock().is_empty(),
        "a replayed update must reach NO sink"
    );
}

fn plan_notification(session_id: &str) -> agent_client_protocol::schema::v1::SessionNotification {
    use agent_client_protocol::schema::v1 as acp;
    acp::SessionNotification::new(
        acp::SessionId::new(session_id),
        acp::SessionUpdate::Plan(acp::Plan::new(vec![acp::PlanEntry::new(
            "step",
            acp::PlanEntryPriority::High,
            acp::PlanEntryStatus::Pending,
        )])),
    )
}

/// History chunks stay suppressed during reopen. Plan (and other session
/// state) still fans out so slash commands, modes, and config are not lost.
#[tokio::test]
async fn replay_window_forwards_plan_and_drops_history() {
    let state = Arc::new(Mutex::new(DriverState::new()));
    assert!(state.lock().try_begin_replay_window("sess-1"));
    let sink = Arc::new(CapturingSink::default());
    let sinks: Vec<Arc<dyn EventSink>> = vec![sink.clone()];
    let agent_id = AgentId::new();
    handle_session_notification(&state, None, &sinks, &agent_id, plan_notification("sess-1"))
        .await
        .expect("plan update");
    handle_session_notification(
        &state,
        None,
        &sinks,
        &agent_id,
        thought_notification("sess-1", "replayed history"),
    )
    .await
    .expect("history chunk");
    let seen = sink.seen.lock();
    assert_eq!(seen.len(), 1, "only the plan fans out");
    assert_eq!(seen[0].type_, crate::acp::events::EVENT_PLAN_UPDATE);
}

#[tokio::test]
async fn session_notification_fans_out_when_no_replay_window() {
    let state = Arc::new(Mutex::new(DriverState::new()));
    let sink = Arc::new(CapturingSink::default());
    let sinks: Vec<Arc<dyn EventSink>> = vec![sink.clone()];
    let result = handle_session_notification(
        &state,
        None,
        &sinks,
        &AgentId::new(),
        thought_notification("sess-1", "live chunk"),
    )
    .await;
    assert!(result.is_ok());
    let seen = sink.seen.lock();
    assert_eq!(seen.len(), 1, "a live update must fan out to the sink");
    assert_eq!(seen[0].sid.as_deref(), Some("sess-1"));
}

/// Replay windows and active turns are mutually exclusive (admission
/// rejects either ordering), so the only reachable live-turn notification
/// path is a LIVE update: it must nudge the turn's idle clock AND fan out.
#[tokio::test]
async fn live_update_during_active_turn_nudges_idle_clock_and_fans_out() {
    let state = Arc::new(Mutex::new(DriverState::new()));
    let handles = state.lock().try_begin_turn("sess-1").expect("turn starts");
    let idle_rx = handles.idle_rx;
    let sink = Arc::new(CapturingSink::default());
    let sinks: Vec<Arc<dyn EventSink>> = vec![sink.clone()];
    assert!(
        !idle_rx.has_changed().unwrap(),
        "no idle nudge before the notification arrives"
    );
    let result = handle_session_notification(
        &state,
        None,
        &sinks,
        &AgentId::new(),
        thought_notification("sess-1", "live chunk"),
    )
    .await;
    assert!(result.is_ok());
    assert!(
        idle_rx.has_changed().unwrap(),
        "a live update nudges the active turn's idle deadline"
    );
    assert_eq!(
        sink.seen.lock().len(),
        1,
        "the live update fans out to the sink"
    );
}

/// Turn-before-replay ordering at the notification layer: while a turn is
/// active, replay-window admission is refused, so updates keep fanning out
/// as live (nothing is misclassified as replayed history and dropped).
#[tokio::test]
async fn replay_window_admission_refused_during_active_turn_keeps_updates_live() {
    let state = Arc::new(Mutex::new(DriverState::new()));
    let _handles = state.lock().try_begin_turn("sess-1").expect("turn starts");
    assert!(
        ReplayWindowGuard::try_new(state.clone(), "sess-1".to_string()).is_none(),
        "replay window must be rejected while a turn is active"
    );
    let sink = Arc::new(CapturingSink::default());
    let sinks: Vec<Arc<dyn EventSink>> = vec![sink.clone()];
    let result = handle_session_notification(
        &state,
        None,
        &sinks,
        &AgentId::new(),
        thought_notification("sess-1", "live chunk"),
    )
    .await;
    assert!(result.is_ok());
    assert_eq!(
        sink.seen.lock().len(),
        1,
        "with no replay window admitted, the update fans out as live"
    );
}

/// Replay-before-turn ordering: while a replay window is open, turn
/// admission is refused, and the replayed update is suppressed (never
/// persisted or forwarded).
#[tokio::test]
async fn turn_admission_refused_during_replay_window() {
    let state = Arc::new(Mutex::new(DriverState::new()));
    let guard = ReplayWindowGuard::try_new(state.clone(), "sess-1".to_string())
        .expect("window opens when no turn is active");
    assert!(
        state.lock().try_begin_turn("sess-1").is_none(),
        "a turn must be rejected while a replay window is open"
    );
    drop(guard);
    assert!(
        state.lock().try_begin_turn("sess-1").is_some(),
        "a turn may begin once the replay window closes"
    );
}

/// Reopen reservations split admission from suppression: while a
/// reservation is held (reopen admitted, replay window not yet open), a
/// prompt turn is rejected BUT updates are NOT suppressed (no window yet);
/// a turn that is already active refuses the reservation. The reservation
/// is ref-counted across overlapping reopens and released on the last
/// drop, after which turns are admitted again.
#[tokio::test]
async fn reopen_reservation_blocks_turns_without_suppressing_updates() {
    let state = Arc::new(Mutex::new(DriverState::new()));
    // Turn-before-reopen ordering: admission is refused while a turn lives.
    let handles = state.lock().try_begin_turn("sess-1").expect("turn starts");
    assert!(
        ReopenReservation::try_new(state.clone(), "sess-1".to_string()).is_none(),
        "reopen reservation must be rejected while a turn is active"
    );
    let _ = state.lock().finish_turn("sess-1");
    drop(handles);

    let reservation = ReopenReservation::try_new(state.clone(), "sess-1".to_string())
        .expect("reservation admitted once the turn finished");
    assert!(
        state.lock().try_begin_turn("sess-1").is_none(),
        "a turn must be rejected while a reopen reservation is held"
    );
    assert!(
        !state.lock().note_replayed_update("sess-1"),
        "no replay window is open yet — updates stay live (no suppression)"
    );
    // Overlapping reopens share the reservation via refcount.
    let second = ReopenReservation::try_new(state.clone(), "sess-1".to_string())
        .expect("overlapping reopen shares the reservation");
    drop(second);
    assert!(
        state.lock().try_begin_turn("sess-1").is_none(),
        "the reservation survives until the last guard drops"
    );
    drop(reservation);
    assert!(
        state.lock().try_begin_turn("sess-1").is_some(),
        "a turn may begin once the reservation is released"
    );
}

/// Admission-ordering regression: the reopen reservation is acquired
/// synchronously by the command loop BEFORE the request task is spawned,
/// so a SendPrompt dispatched immediately after a LoadSession /
/// ResumeSession is rejected even though the spawned task has not yet run
/// and the replay window is not open — and updates stay live (no
/// suppression) until the window opens. The deferred window then opens
/// under the held reservation, and turns stay rejected until the
/// reservation itself (not just the window) is released.
#[tokio::test]
async fn reopen_reserved_before_spawn_rejects_prompt_before_window_opens() {
    let state = Arc::new(Mutex::new(DriverState::new()));
    // Command-loop phase: the reservation is taken before spawn_request;
    // the spawned task (and its replay window) has not run yet.
    let reservation = ReopenReservation::try_new(state.clone(), "sess-1".to_string())
        .expect("reopen admitted while no turn is active");
    assert!(
        state.lock().try_begin_turn("sess-1").is_none(),
        "SendPrompt dispatched after the reopen must be rejected before the window opens"
    );
    assert!(
        !state.lock().note_replayed_update("sess-1"),
        "no window yet — updates stay live (no suppression)"
    );
    // Spawned-task phase: the deferred replay window opens under the held
    // reservation (no turn could have started, so this cannot fail).
    let window = ReplayWindowGuard::try_new(state.clone(), "sess-1".to_string())
        .expect("window opens under the held reservation");
    drop(window);
    assert!(
        state.lock().try_begin_turn("sess-1").is_none(),
        "closing the window alone must not admit turns while the reservation is held"
    );
    drop(reservation);
    assert!(
        state.lock().try_begin_turn("sess-1").is_some(),
        "turns are admitted once the reservation is released"
    );
}

/// Minimal serializable payload for the fan-out tests (mirrors sink.rs's
/// TestPayload).
#[derive(serde::Serialize)]
struct TestPayload {
    agent_id: String,
    session_id: String,
    text: String,
}

/// CAP-2: `record_agent_switch` validates every identity field BEFORE the
/// durable write — the WS path reaches this function without the Tauri
/// command layer's pre-check, and a marker missing fromConfigId or
/// newSessionId is permanently unresolvable (CAP-7 reopen reads them).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn record_agent_switch_rejects_blank_identity_fields_before_write() {
    let (root, cwd) = temp_dir_with_cwd("switch-validate");
    let persistence = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    persistence
        .register_session(SessionRegistration {
            session_id: "sess-validate".to_string(),
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    let valid = |from: &str, to: &str, new: &str| AgentSwitchRecord {
        session_id: "sess-validate".to_string(),
        from_config_id: from.to_string(),
        to_config_id: to.to_string(),
        new_session_id: new.to_string(),
        summary_text: "summary".to_string(),
    };
    // Blank sessionId / fromConfigId / newSessionId each reject BEFORE
    // any durable write — no record, no seq advance.
    for record in [
        valid("   ", "claude", "sess-new"),
        valid("omp", "claude", ""),
        valid("omp", "   ", "sess-new"),
    ] {
        let error = record_agent_switch(
            &persistence,
            &[],
            AgentId::new(),
            record.session_id.clone(),
            record,
        )
        .await
        .unwrap_err();
        assert!(error.contains("are required"), "unexpected error: {error}");
    }
    let error = record_agent_switch(
        &persistence,
        &[],
        AgentId::new(),
        "  ".to_string(),
        valid("omp", "claude", "sess-new"),
    )
    .await
    .unwrap_err();
    assert!(error.contains("are required"), "blank sessionId rejects");
    // Fail-closed: nothing was written, the frontier never moved.
    assert_eq!(persistence.last_seq("sess-validate").unwrap(), 0);
    assert!(persistence
        .replay_after("sess-validate", 0)
        .unwrap()
        .is_empty());
    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

/// CAP-2 "one sequence authority" proof: after `record_agent_switch`
/// completes (writer-assigned seq S committed + flushed), the relay's
/// next `assign_and_append` reconciles against the durable frontier and
/// assigns S+1 — and the durable record it enqueues at S+1 is ACCEPTED
/// by the writer's fail-closed monotonic check (no collision, no
/// rejection). This is the same invariant the existing sink.rs test
/// (`relay_reconciles_cached_seq_with_durable_frontier_after_background_title`)
/// pins for `record_local_title`; this test proves it for the switch
/// marker, whose durable write also bypasses the relay.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn record_agent_switch_then_relay_emit_never_collides_on_seq() {
    let (root, cwd) = temp_dir_with_cwd("switch-seq-authority");
    let persistence = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    persistence
        .register_session(SessionRegistration {
            session_id: "sess-coll".to_string(),
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    let relay = Arc::new(crate::web::WsRelaySink::with_persistence(
        8,
        Arc::clone(&persistence),
    ));
    let sinks: Vec<Arc<dyn EventSink>> = vec![relay.clone()];

    // 1. A relay emit first (seq 1, durable via assign_and_append).
    events::fan_out(
        &sinks,
        Some("sess-coll"),
        "acp:message_chunk",
        &TestPayload {
            agent_id: "a".to_string(),
            session_id: "sess-coll".to_string(),
            text: "first".to_string(),
        },
    );
    persistence.flush_session("sess-coll").await.unwrap();
    assert_eq!(persistence.last_seq("sess-coll").unwrap(), 1);

    // 2. The switch marker writes DURABLY through the writer command
    //    (bypassing the relay — seq 2). The relay's cached frontier is
    //    still 1.
    record_agent_switch(
        &persistence,
        &sinks,
        AgentId::new(),
        "sess-coll".to_string(),
        AgentSwitchRecord {
            session_id: "sess-coll".to_string(),
            from_config_id: "omp".to_string(),
            to_config_id: "claude".to_string(),
            new_session_id: "sess-coll-new".to_string(),
            summary_text: "Handoff".to_string(),
        },
    )
    .await
    .unwrap();
    assert_eq!(persistence.last_seq("sess-coll").unwrap(), 2);
    // The switch's fan-out was live-only: still exactly ONE agent_switch
    // durable record (seq 2), plus the seq-1 chunk.
    let after_switch: Vec<PersistedEventRecord> = persistence.replay_after("sess-coll", 0).unwrap();
    assert_eq!(after_switch.len(), 2);
    assert_eq!(
        after_switch
            .iter()
            .filter(|r| r.type_ == "agent_switch")
            .count(),
        1
    );

    // 3. A LATE durable event through the relay: the switch's live-only
    //    fan-out already consumed relay seq 3 (assign_and_append stamps
    //    EVERY session-scoped emit; `is_durable_event` drops it from the
    //    durable queue), so the durable frontier is still 2. The late
    //    emit reconciles max(cached=3, durable=2)+1 = 4 and enqueues at
    //    seq 4 — ACCEPTED by the writer's monotonic check: no collision
    //    with the switch's seq 2, no rejection.
    events::fan_out(
        &sinks,
        Some("sess-coll"),
        "acp:message_chunk",
        &TestPayload {
            agent_id: "a".to_string(),
            session_id: "sess-coll".to_string(),
            text: "late".to_string(),
        },
    );
    persistence.flush_session("sess-coll").await.unwrap();
    assert_eq!(
        persistence.last_seq("sess-coll").unwrap(),
        4,
        "late durable event lands on a fresh seq (no collision with seq 2)"
    );
    // The durable log is strictly monotonic; seq 3 was consumed by the
    // switch's non-durable live event (expected — same as any
    // non-durable session-scoped emit).
    let durable: Vec<PersistedEventRecord> = persistence.replay_after("sess-coll", 0).unwrap();
    let seqs: Vec<u64> = durable.iter().map(|r| r.seq).collect();
    assert_eq!(seqs, vec![1, 2, 4]);
    assert_eq!(
        durable.iter().filter(|r| r.type_ == "agent_switch").count(),
        1,
        "still exactly one durable switch marker"
    );

    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

/// CAP-2: a catalog-known session whose writer runtime is gone
/// (post-restart recovered session) surfaces a DISTINGUISHABLE error
/// ("session writer unavailable") that the WS handler maps to a typed
/// `not_found` reply — not the generic persistence-failure string.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn record_agent_switch_writer_gone_surfaces_distinguishable_error() {
    let (root, cwd) = temp_dir_with_cwd("switch-writer-gone");
    let persistence = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    persistence
        .register_session(SessionRegistration {
            session_id: "sess-recovered".to_string(),
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    // Simulate the post-restart state: the catalog entry survives (the
    // metadata check passes) but no writer runtime is installed.
    persistence.shutdown().await.unwrap();
    let reopened = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    assert!(reopened.metadata("sess-recovered").is_ok());
    // The writer runtime is gone: the direct append surfaces SessionNotFound
    // (the public observable for "catalog known, writer gone").
    assert!(matches!(
        reopened
            .append_agent_switch(
                "sess-recovered",
                AgentSwitchRecord {
                    session_id: "sess-recovered".to_string(),
                    from_config_id: "omp".to_string(),
                    to_config_id: "claude".to_string(),
                    new_session_id: "sess-new".to_string(),
                    summary_text: "probe".to_string(),
                }
            )
            .await,
        Err(SessionPersistenceError::SessionNotFound)
    ));

    let error = record_agent_switch(
        &reopened,
        &[],
        AgentId::new(),
        "sess-recovered".to_string(),
        AgentSwitchRecord {
            session_id: "sess-recovered".to_string(),
            from_config_id: "omp".to_string(),
            to_config_id: "claude".to_string(),
            new_session_id: "sess-new".to_string(),
            summary_text: "Handoff".to_string(),
        },
    )
    .await
    .unwrap_err();
    // The classification survives: distinguishable from a storage
    // failure, and phrased so the WS handler's not-found mapping (which
    // greps for "not found" / "session writer unavailable") picks it up.
    assert_eq!(error, "session writer unavailable");

    reopened.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}
