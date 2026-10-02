use super::*;

/// Entry point for an agent's dedicated driver thread.
///
/// Builds a current-thread Tokio runtime and drives the ACP connection to
/// completion. All `!Send`-sensitive connection work is confined here.
///
/// On exit (for any reason — clean shutdown, agent crash, or initialize
/// failure) the thread reaps itself from the registry and, if it had actually
/// spawned (`spawned` is true), emits the appropriate disconnect/close events.
#[allow(clippy::too_many_arguments)]
pub(super) fn run_agent(
    config: AgentConfig,
    sinks: Vec<Arc<dyn EventSink>>,
    host_plan_server: Arc<crate::acp::host_mcp::parent::HostPlanServer>,
    agent_id: AgentId,
    command_rx: mpsc::UnboundedReceiver<AcpCommand>,
    init_tx: oneshot::Sender<Result<InitOutcome, String>>,
    agents: Arc<Mutex<HashMap<AgentId, AgentEntry>>>,
    reaped: Arc<AtomicBool>,
    killed: Arc<AtomicBool>,
    start_error: Arc<Mutex<Option<String>>>,
    persistence: Option<Arc<SessionPersistence>>,
) {
    warn_if_pidfd_reaper();
    // True once `initialize` succeeded and the agent was surfaced to the
    // renderer via `acp:agent_spawned`. We only emit disconnect/error events
    // for agents the renderer actually saw (L4/F5).
    let spawned = Arc::new(AtomicBool::new(false));
    // Shared with the connection handlers and the command loop. Created here so
    // that, even if the agent crashes and `main_fn` is dropped mid-await, this
    // teardown code can still drain leaked permissions and discover which
    // sessions were active for `acp:session_closed`.
    let driver_state = Arc::new(Mutex::new(DriverState::new()));

    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            let _ = init_tx.send(Err(format!("failed to build runtime: {e}")));
            *start_error.lock() = Some(format!("failed to build runtime: {e}"));
            return;
        }
    };

    let profile = AgentRuntimeProfile::resolve(&config);
    let result = runtime.block_on(drive_connection(
        config,
        sinks.clone(),
        host_plan_server.clone(),
        agent_id.clone(),
        command_rx,
        init_tx,
        spawned.clone(),
        driver_state.clone(),
        persistence.clone(),
        profile,
    ));

    let was_spawned = spawned.load(Ordering::Acquire);

    // Drain any permissions that leaked because the connection ended (crash /
    // disconnect) without the loop resolving them. The connection is gone, so
    // responding may fail silently — that is fine; the point is to not hold the
    // responders forever (H3).
    let (leaked, active_sessions) = {
        let mut state = driver_state.lock();
        (state.drain_all(), state.active_session_ids())
    };
    // A connection teardown can drop an in-flight prompt task before its normal
    // completion cleanup runs. Remove every surviving session's auth, cache,
    // and route so stale MCP children cannot target a later session.
    for session_id in &active_sessions {
        host_plan_server.unregister_session(session_id);
    }
    for permission in leaked {
        let _ = permission.responder.respond(RequestPermissionResponse::new(
            RequestPermissionOutcome::Cancelled,
        ));
    }
    // Issue #411: resolve leaked questions as cancelled too (the connection is
    // gone, so responding may fail silently — the point is to not hold the
    // responders forever).
    let leaked_questions = driver_state.lock().drain_all_questions();
    for question in leaked_questions {
        let _ = question.responder.respond(serde_json::json!({
            "questionId": question.question_id,
            "cancelled": true,
        }));
    }

    // Self-reap: remove our own registry entry so a crashed/EOFed agent does
    // not linger in `list_agents` with a dead command channel. We do NOT join
    // our own handle here (a thread cannot join itself); `kill`/`kill_all` may
    // still hold the handle, and joining a finished thread returns promptly.
    // The `reaped` flag (set under the same lock the registrar checks) closes
    // the race where init succeeded but the agent exited before registration.
    {
        let mut map = agents.lock();
        reaped.store(true, Ordering::Release);
        map.remove(&agent_id);
    }
    // Only surface lifecycle events for an agent the renderer actually saw, and
    // never for an intentional kill (L4): a kill we initiated is silent, so the
    // renderer doesn't see a "disconnected" it didn't cause.
    let intentional_kill = killed.load(Ordering::Acquire);

    // If the agent never finished initializing, the connection error IS the
    // start-failure reason (e.g. the subprocess could not be spawned). Record it
    // BEFORE the lifecycle gate below so the awaiting `spawn` caller can surface
    // the real error instead of the generic "did not initialize" message. This
    // must run regardless of `was_spawned`/`intentional_kill` (those gate only
    // the renderer-facing lifecycle events).
    if !was_spawned {
        if let Err(message) = &result {
            *start_error.lock() = Some(message.clone());
        }
    }

    let mut persistence_failures = Vec::new();
    if let Some(persistence) = &persistence {
        for session in &active_sessions {
            let status = if result.is_err() {
                PersistedSessionStatus::Error
            } else {
                PersistedSessionStatus::Closed
            };
            if let Err(error) = runtime.block_on(persistence.finalize_session(session, status)) {
                // Story 8 (web honesty): the teardown finalize's job is
                // already done when the writer is stopped (its own Shutdown
                // arm drained + persisted the metadata) or the session's
                // runtime is already gone (finalized/deleted concurrently).
                // Both are benign window-close outcomes, not persistence
                // failures — route them at info so a clean close does not
                // emit shutdown-time "failed to finalize" errors. Every
                // other error (I/O, corrupt, unhealthy queue) is a real
                // failure and stays on the error channel.
                if matches!(
                    error,
                    SessionPersistenceError::WriterStopped
                        | SessionPersistenceError::SessionNotFound
                ) {
                    log::info!(
                        "[acp] session {} writer already stopped or gone; durable record already persisted",
                        crate::logging::redact_session_id(session)
                    );
                } else {
                    persistence_failures.push(format!("session {session}: {error}"));
                }
            }
        }
    }
    if !persistence_failures.is_empty() {
        log::error!(
            "[acp] failed to finalize {} persisted session(s): {}",
            persistence_failures.len(),
            persistence_failures.join("; ")
        );
    }

    if was_spawned && !intentional_kill {
        for session in active_sessions {
            let event = SessionClosedEvent {
                agent_id: agent_id.clone(),
                session_id: SessionId::new(session),
            };
            events::fan_out(
                &sinks,
                Some(event.session_id.0.as_str()),
                events::EVENT_SESSION_CLOSED,
                &event,
            );
        }

        if let Err(message) = result {
            // Story 1.9 FR26: emit the typed `AgentCrashed` event BEFORE
            // `agent_error` (back-compat) + `agent_disconnected`. The renderer
            // distinguishes "crash" (→ `status: 'error'` + manual restart) from
            // a clean disconnect. Outstanding turn oneshots fail with this.
            if profile.mask_failure_details {
                // The renderer gets the generic message (agents may echo env
                // values); the host log keeps the specific detail.
                log::warn!("[acp] Factory Droid connection failed: {message}");
            }
            let message = if profile.mask_failure_details {
                "Factory Droid connection failed".to_string()
            } else {
                message
            };
            let crashed = AgentCrashedEvent {
                agent_id: agent_id.clone(),
                session_id: None,
                message: message.clone(),
            };
            events::fan_out(&sinks, None, events::EVENT_AGENT_CRASHED, &crashed);

            let event = AgentErrorEvent {
                agent_id: agent_id.clone(),
                session_id: None,
                message,
            };
            // Teardown error is agent-level (no session) → sid = None.
            events::fan_out(&sinks, None, events::EVENT_AGENT_ERROR, &event);
        }

        let event = AgentDisconnectedEvent { agent_id };
        // Agent-level lifecycle event → sid = None.
        events::fan_out(&sinks, None, events::EVENT_AGENT_DISCONNECTED, &event);
    }
}

/// Handle an inbound `session/update` notification from the agent: nudge the
/// active turn's idle deadline, apply the story-3 replay-window suppression,
/// bind tool calls, apply the AD-8 title gate, then fan out to the sinks.
///
/// Extracted from the connection-builder closure so the routing logic can be
/// unit-tested without a live connection (cf. `gate_load_session`).
pub(super) async fn handle_session_notification(
    state: &Mutex<DriverState>,
    persistence: Option<&Arc<SessionPersistence>>,
    sinks: &[Arc<dyn EventSink>],
    agent_id: &AgentId,
    notification: agent_client_protocol::schema::v1::SessionNotification,
) -> Result<(), agent_client_protocol::Error> {
    let session_id = notification.session_id.0.to_string();
    // Any inbound session/update is agent activity — nudge the active turn's
    // idle deadline so a streaming turn never hits the idle timeout.
    // Best-effort: a no-op when no turn is active for this session. Admission
    // (`try_begin_turn` / `try_begin_replay_window`) forbids an active turn
    // overlapping a replay window; the idle nudge stays unconditional as
    // defense-in-depth.
    state.lock().signal_idle(&session_id);
    // Story 3 replay contract: while a `session/load` / `session/resume`
    // replay window is open for this session, the agent is replaying persisted
    // history — drop the notification here, before fan-out, so it is neither
    // persisted again nor pushed to subscribers as a live event (the persisted
    // JSONL log stays the sole history source).
    if state.lock().note_replayed_update(&session_id) {
        return Ok(());
    }
    let tool_call_id = match &notification.update {
        agent_client_protocol::schema::v1::SessionUpdate::ToolCall(tool_call) => {
            Some(tool_call.tool_call_id.0.to_string())
        }
        agent_client_protocol::schema::v1::SessionUpdate::ToolCallUpdate(update) => {
            Some(update.tool_call_id.0.to_string())
        }
        _ => None,
    };
    if let Some(tool_call_id) = tool_call_id {
        state
            .lock()
            .bind_tool_call(tool_call_id, session_id.clone());
    }
    // AD-8: gate native `session_info_update` fan-out. When the host already
    // owns a higher-precedence title (`BackgroundGenerated` from a prior
    // background-gen flow, or a future `LocalAlias`), suppress the agent's
    // `session_info_update` so the background title survives in the renderer.
    // The durable defense in `append_record` is the second layer; this is the
    // fan-out defense.
    let is_protected_info_update = matches!(
        &notification.update,
        agent_client_protocol::schema::v1::SessionUpdate::SessionInfoUpdate(_)
    ) && is_protected_title_source(
        persistence
            .and_then(|p| p.metadata(&session_id).ok())
            .and_then(|m| m.title_source)
            .as_ref(),
    );
    if is_protected_info_update {
        log::debug!(
            "[acp] session {}: suppressed native session_info_update (title_source is BackgroundGenerated/LocalAlias)",
            crate::logging::redact_session_id(&session_id)
        );
        return Ok(());
    }
    client::emit_session_update(sinks, agent_id, notification);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn drive_connection(
    config: AgentConfig,
    sinks: Vec<Arc<dyn EventSink>>,
    host_plan_server: Arc<crate::acp::host_mcp::parent::HostPlanServer>,
    agent_id: AgentId,
    command_rx: mpsc::UnboundedReceiver<AcpCommand>,
    init_tx: oneshot::Sender<Result<InitOutcome, String>>,
    spawned: Arc<AtomicBool>,
    driver_state: Arc<Mutex<DriverState>>,
    persistence: Option<Arc<SessionPersistence>>,
    profile: AgentRuntimeProfile,
) -> Result<(), String> {
    // Forward the agent subprocess's stdio to the log at `debug` (opt-in via
    // `RUST_LOG`). stderr is where agents print auth/login prompts and runtime
    // errors, so it is logged verbatim. stdin/stdout carry the JSON-RPC protocol
    // trace which can include `authenticate` payloads (API keys, OAuth tokens),
    // so by default those are redacted to direction + byte length — enough to
    // confirm streaming/traffic without writing secrets to disk.
    //
    // Set `TERMUL_ACP_TRACE_RAW=1` to log the full stdin/stdout JSON-RPC bodies
    // (diagnostics only — may write secrets to the log; never enable in normal
    // use). Combine with a debug log level to see the trace.
    // Headless browser-open shim (spec-acp-terminal-auth): install a per-agent
    // shim dir of browser-open scripts (`xdg-open`, `gio`, `open`, …) that
    // append the URL to a `urls` sink instead of launching a browser. The dir
    // is injected into the agent's PATH/BROWSER by `to_mcp_server`, and a
    // watcher thread fans each captured URL out as `acp:browser_open_request`
    // so the renderer can show it + accept a paste-back redirect.
    //
    // Always injected on POSIX (spec-acp-terminal-auth): a uniform path — on
    // the desktop app the modal's "Open" button completes the localhost
    // callback natively, on headless termul-server the paste-back replays it.
    // When the gate is off (non-POSIX) or install fails, `shim_dir` is `None`
    // and the agent's browser-open behaves exactly as before.
    #[cfg(unix)]
    let shim_dir = crate::acp::browser_shim::install_shim(&agent_id);
    #[cfg(not(unix))]
    let shim_dir: Option<std::path::PathBuf> = None;

    // Watcher: poll the shim's `urls` sink and fan each captured URL out as an
    // agent-level `acp:browser_open_request`. Dropping the handle stops the
    // thread; it also self-terminates when the shim dir is removed at teardown.
    #[cfg(unix)]
    let _shim_watcher = shim_dir.as_ref().map(|dir| {
        crate::acp::browser_shim::ShimWatcher::spawn(agent_id.clone(), dir.clone(), sinks.clone())
    });

    let debug_agent_id = agent_id.clone();
    let redact_output = profile.redact_output;
    let trace_raw = !redact_output
        && std::env::var("TERMUL_ACP_TRACE_RAW")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
    let agent = agent_client_protocol::AcpAgent::new(config.to_mcp_server(shim_dir.as_deref()))
        .with_debug(
            move |line: &str, direction: LineDirection| match direction {
                LineDirection::Stderr => {
                    if redact_output {
                        log::debug!("[acp] {debug_agent_id} stderr ({} bytes)", line.len());
                    } else {
                        log::debug!("[acp] {debug_agent_id} stderr {line}");
                    }
                }
                LineDirection::Stdin => {
                    if trace_raw {
                        log::debug!("[acp] {debug_agent_id} -> {line}");
                    } else {
                        log::debug!("[acp] {debug_agent_id} -> ({} bytes)", line.len());
                    }
                }
                LineDirection::Stdout => {
                    if trace_raw {
                        log::debug!("[acp] {debug_agent_id} <- {line}");
                    } else {
                        log::debug!("[acp] {debug_agent_id} <- ({} bytes)", line.len());
                    }
                }
            },
        );

    // Per-handler clones (handlers must be `Send` and may be called repeatedly).
    // Each handler gets its own clone of the sink fan-out; `Arc` clones are
    // cheap and `Vec::clone` is N Arc clones (N is tiny: 1 sink in desktop mode
    // today, 2 once Story 1.10 adds the shared-live WS sink).
    let notif_sinks = sinks.clone();
    let notif_agent_id = agent_id.clone();
    let notif_state = driver_state.clone();
    // AD-8: capture persistence into the notification closure so the host can
    // gate `session_info_update` fan-out on `title_source`. When a background
    // title (`BackgroundGenerated`) or a future local alias (`LocalAlias`) owns
    // the title, a native agent `session_info_update` is suppressed here (the
    // durable defense in `append_record` is the second layer).
    let notif_persistence = persistence.clone();
    let perm_sinks = sinks.clone();
    let perm_agent_id = agent_id.clone();
    let perm_state = driver_state.clone();
    let question_sinks = sinks.clone();
    let question_agent_id = agent_id.clone();
    let question_state = driver_state.clone();
    let read_state = driver_state.clone();
    let write_state = driver_state.clone();

    // Terminal capability (P6b): a per-agent registry of ACP command-runner
    // terminals. Handlers are always registered, but they only do work when the
    // agent opted in (`allow_terminal`); the real gate is the capability
    // advertisement (default false), so a compliant agent never calls these
    // unless allowed. The registry is torn down with the driver thread.
    let allow_terminal = config.allow_terminal;
    let terminals = Arc::new(Mutex::new(crate::acp::terminal::TerminalRegistry::new()));
    let term_create = terminals.clone();
    let term_create_state = driver_state.clone();
    let term_output = terminals.clone();
    let term_output_state = driver_state.clone();
    let term_wait = terminals.clone();
    let term_wait_state = driver_state.clone();
    let term_kill = terminals.clone();
    let term_kill_state = driver_state.clone();
    let term_release = terminals.clone();
    let term_release_state = driver_state.clone();
    let loop_terminals = terminals.clone();

    // Clones moved into the command loop (`main_fn`).
    let loop_sinks = sinks.clone();
    let loop_host_plan_server = host_plan_server;
    let loop_agent_id = agent_id.clone();
    let loop_state = driver_state.clone();
    let loop_spawned = spawned.clone();

    let connection_result = Client
        .builder()
        .name(format!("termul-acp-{agent_id}"))
        .on_receive_notification(
            async move |notification: agent_client_protocol::schema::v1::SessionNotification,
                        _cx| {
                handle_session_notification(
                    &notif_state,
                    notif_persistence.as_ref(),
                    &notif_sinks,
                    &notif_agent_id,
                    notification,
                )
                .await
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: agent_client_protocol::schema::v1::RequestPermissionRequest,
                        responder,
                        _cx| {
                let agent_client_protocol::schema::v1::RequestPermissionRequest {
                    session_id,
                    tool_call,
                    options,
                    ..
                } = request;
                let session_string = session_id.0.to_string();
                if perm_state.lock().is_ephemeral(&session_string) {
                    let _ = responder.respond(RequestPermissionResponse::new(
                        RequestPermissionOutcome::Cancelled,
                    ));
                    return Ok(());
                }
                // A permission request is agent activity — the turn is waiting
                // on user input, not wedged. Nudge the idle deadline so a
                // user-input wait doesn't false-fire the idle timeout.
                perm_state.lock().signal_idle(&session_string);
                let request_id = {
                    let mut state = perm_state.lock();
                    state.bind_tool_call(
                        tool_call.tool_call_id.0.to_string(),
                        session_string.clone(),
                    );
                    state.register_permission(session_string.clone(), responder)
                };
                let event = events::PermissionRequestEvent {
                    agent_id: perm_agent_id.clone(),
                    session_id: SessionId::new(session_string),
                    request_id,
                    tool_call,
                    options,
                };
                events::fan_out(
                    &perm_sinks,
                    Some(event.session_id.0.as_str()),
                    events::EVENT_PERMISSION_REQUEST,
                    &event,
                );
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: AskUserQuestionRequest, responder, _cx| {
                // Issue #411: a structured question from the agent. Register the
                // parked `Responder<serde_json::Value>` (mirroring permissions),
                // fan out `acp:question_request`, and resolve the responder when
                // the user answers via `acp_answer_question` / `answer_question`.
                let session_string = request.session_id.clone();
                if question_state.lock().is_ephemeral(&session_string) {
                    let _ = responder.respond(serde_json::json!({
                        "cancelled": true,
                    }));
                    return Ok(());
                }
                // A structured question is agent activity — the turn is waiting
                // on user input, not wedged. Nudge the idle deadline so a
                // user-input wait doesn't false-fire the idle timeout.
                question_state.lock().signal_idle(&session_string);
                let question_id = {
                    let mut state = question_state.lock();
                    state.register_question(session_string.clone(), responder)
                };
                let event = events::AskUserQuestionEvent {
                    agent_id: question_agent_id.clone(),
                    session_id: SessionId::new(session_string),
                    question_id,
                    question: request.question,
                    options: request
                        .options
                        .into_iter()
                        .map(|o| events::QuestionOption {
                            value: o.value,
                            label: o.label,
                            description: o.description,
                            cardinality: o.cardinality,
                        })
                        .collect(),
                };
                events::fan_out(
                    &question_sinks,
                    Some(event.session_id.0.as_str()),
                    events::EVENT_QUESTION_REQUEST,
                    &event,
                );
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: agent_client_protocol::schema::v1::ReadTextFileRequest,
                        responder,
                        cx| {
                // Resolve the session's workspace root (the sandbox boundary)
                // and perform the (blocking) read off the dispatch loop so a
                // large file can't stall connection I/O (M1).
                let root = {
                    let state = read_state.lock();
                    if state.is_ephemeral(request.session_id.0.as_ref()) {
                        let denied = Err(agent_client_protocol::Error::method_not_found());
                        let _ = responder.respond_with_result(denied);
                        return Ok(());
                    }
                    state.session_root(request.session_id.0.as_ref())
                };
                cx.spawn(async move {
                    let result = client::handle_read_text_file(&request, root.as_deref()).await;
                    let _ = responder.respond_with_result(result);
                    Ok(())
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: agent_client_protocol::schema::v1::WriteTextFileRequest,
                        responder,
                        cx| {
                let root = {
                    let state = write_state.lock();
                    if state.is_ephemeral(request.session_id.0.as_ref()) {
                        let denied = Err(agent_client_protocol::Error::method_not_found());
                        let _ = responder.respond_with_result(denied);
                        return Ok(());
                    }
                    state.session_root(request.session_id.0.as_ref())
                };
                cx.spawn(async move {
                    let result = client::handle_write_text_file(&request, root.as_deref()).await;
                    let _ = responder.respond_with_result(result);
                    Ok(())
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: agent_client_protocol::schema::v1::CreateTerminalRequest,
                        responder,
                        _cx| {
                use agent_client_protocol::schema::v1::CreateTerminalResponse;
                if !allow_terminal
                    || term_create_state
                        .lock()
                        .is_ephemeral(request.session_id.0.as_ref())
                {
                    let denied: Result<CreateTerminalResponse, agent_client_protocol::Error> =
                        Err(agent_client_protocol::Error::method_not_found());
                    let _ = responder.respond_with_result(denied);
                    return Ok(());
                }
                // Default the cwd to the session's workspace root when the agent
                // doesn't specify one.
                let session_root = term_create_state
                    .lock()
                    .session_root(request.session_id.0.as_ref());
                let cwd = request.cwd.clone().or(session_root);
                let env: Vec<(String, String)> = request
                    .env
                    .iter()
                    .map(|e| (e.name.clone(), e.value.clone()))
                    .collect();
                let result = term_create
                    .lock()
                    .create(
                        &request.command,
                        &request.args,
                        &env,
                        cwd.as_deref(),
                        request.output_byte_limit,
                    )
                    .map(CreateTerminalResponse::new)
                    .map_err(|e| agent_client_protocol::Error::internal_error().data(e));
                let _ = responder.respond_with_result(result);
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: agent_client_protocol::schema::v1::TerminalOutputRequest,
                        responder,
                        _cx| {
                use agent_client_protocol::schema::v1::TerminalOutputResponse;
                if term_output_state
                    .lock()
                    .is_ephemeral(request.session_id.0.as_ref())
                {
                    let denied: Result<TerminalOutputResponse, agent_client_protocol::Error> =
                        Err(agent_client_protocol::Error::method_not_found());
                    let _ = responder.respond_with_result(denied);
                    return Ok(());
                }
                let result = term_output
                    .lock()
                    .output(&request.terminal_id)
                    .map(|(output, truncated, exit)| {
                        TerminalOutputResponse::new(output, truncated).exit_status(exit)
                    })
                    .map_err(|e| agent_client_protocol::Error::internal_error().data(e));
                let _ = responder.respond_with_result(result);
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: agent_client_protocol::schema::v1::WaitForTerminalExitRequest,
                        responder,
                        cx| {
                use agent_client_protocol::schema::v1::WaitForTerminalExitResponse;
                if term_wait_state
                    .lock()
                    .is_ephemeral(request.session_id.0.as_ref())
                {
                    let denied: Result<WaitForTerminalExitResponse, agent_client_protocol::Error> =
                        Err(agent_client_protocol::Error::method_not_found());
                    let _ = responder.respond_with_result(denied);
                    return Ok(());
                }
                let registry = term_wait.clone();
                // Await off the dispatch path so other terminal ops stay
                // responsive. The child handle is taken out from under the lock
                // first, so the registry mutex is NOT held across the await.
                cx.spawn(async move {
                    let taken = registry.lock().take_child_for_wait(&request.terminal_id);
                    let result = match taken {
                        Err(e) => Err(agent_client_protocol::Error::internal_error().data(e)),
                        Ok(None) => {
                            // Already exited: return the cached status.
                            match registry.lock().cached_exit(&request.terminal_id) {
                                Some(status) => Ok(WaitForTerminalExitResponse::new(status)),
                                None => Err(agent_client_protocol::Error::internal_error()
                                    .data("terminal has no exit status")),
                            }
                        }
                        Ok(Some(mut child)) => match child.wait().await {
                            Ok(status) => {
                                let exit = crate::acp::terminal::to_exit_status(status);
                                registry
                                    .lock()
                                    .record_exit(&request.terminal_id, exit.clone());
                                Ok(WaitForTerminalExitResponse::new(exit))
                            }
                            Err(e) => Err(agent_client_protocol::Error::internal_error()
                                .data(format!("failed to wait for terminal: {e}"))),
                        },
                    };
                    let _ = responder.respond_with_result(result);
                    Ok(())
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: agent_client_protocol::schema::v1::KillTerminalRequest,
                        responder,
                        _cx| {
                use agent_client_protocol::schema::v1::KillTerminalResponse;
                if term_kill_state
                    .lock()
                    .is_ephemeral(request.session_id.0.as_ref())
                {
                    let denied: Result<KillTerminalResponse, agent_client_protocol::Error> =
                        Err(agent_client_protocol::Error::method_not_found());
                    let _ = responder.respond_with_result(denied);
                    return Ok(());
                }
                let result = term_kill
                    .lock()
                    .kill(&request.terminal_id)
                    .map(|()| KillTerminalResponse::new())
                    .map_err(|e| agent_client_protocol::Error::internal_error().data(e));
                let _ = responder.respond_with_result(result);
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: agent_client_protocol::schema::v1::ReleaseTerminalRequest,
                        responder,
                        _cx| {
                use agent_client_protocol::schema::v1::ReleaseTerminalResponse;
                if term_release_state
                    .lock()
                    .is_ephemeral(request.session_id.0.as_ref())
                {
                    let denied: Result<ReleaseTerminalResponse, agent_client_protocol::Error> =
                        Err(agent_client_protocol::Error::method_not_found());
                    let _ = responder.respond_with_result(denied);
                    return Ok(());
                }
                let result = term_release
                    .lock()
                    .release(&request.terminal_id)
                    .map(|()| ReleaseTerminalResponse::new())
                    .map_err(|e| agent_client_protocol::Error::internal_error().data(e));
                let _ = responder.respond_with_result(result);
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(agent, async move |cx: ConnectionTo<Agent>| {
            let loop_result = run_command_loop(
                cx,
                command_rx,
                init_tx,
                loop_sinks,
                loop_host_plan_server,
                loop_agent_id,
                loop_state,
                loop_spawned,
                allow_terminal,
                persistence,
                profile,
            )
            .await;
            // Driver thread is winding down — kill any live terminal children so
            // they don't outlive the agent.
            loop_terminals.lock().release_all();
            loop_result
        })
        .await;

    // Teardown: stop the sink watcher (drop joins its thread) and remove the
    // shim dir so no stale scripts/URLs outlive the agent. POSIX only —
    // elsewhere `shim_dir` is `None`, no watcher ran, and there is nothing to
    // remove.
    #[cfg(unix)]
    {
        drop(_shim_watcher);
        crate::acp::browser_shim::remove_shim(&agent_id);
    }

    connection_result.map_err(|e| e.to_string())
}
