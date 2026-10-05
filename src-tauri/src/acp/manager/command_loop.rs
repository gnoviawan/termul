use super::*;

/// The agent driver's main loop: complete `initialize`, then service commands
/// until shutdown. Runs concurrently with the connection's dispatch actors.
#[allow(clippy::too_many_arguments)]
pub(super) async fn run_command_loop(
    cx: ConnectionTo<Agent>,
    mut command_rx: mpsc::UnboundedReceiver<AcpCommand>,
    init_tx: oneshot::Sender<Result<InitOutcome, String>>,
    sinks: Vec<Arc<dyn EventSink>>,
    host_plan_server: Arc<crate::acp::host_mcp::parent::HostPlanServer>,
    agent_id: AgentId,
    driver_state: Arc<Mutex<DriverState>>,
    spawned: Arc<AtomicBool>,
    allow_terminal: bool,
    persistence: Option<Arc<SessionPersistence>>,
    profile: AgentRuntimeProfile,
) -> Result<(), agent_client_protocol::Error> {
    // Step 1: handshake, bounded by INIT_TIMEOUT so a silent agent can never
    // wedge `acp_spawn_agent` forever (H1). On timeout we report the failure
    // and return; returning ends `main_fn`, which tears the connection down and
    // kills the child via the SDK's `ChildGuard`.
    let init_request = InitializeRequest::new(ProtocolVersion::V1)
        .client_capabilities(client::client_capabilities(allow_terminal));
    let init_outcome =
        tokio::time::timeout(INIT_TIMEOUT, cx.send_request(init_request).block_task()).await;
    let supports_session_close = match init_outcome {
        Ok(Ok(response)) => {
            // Propagate the FULL advertised auth methods (opaque
            // id/name/optional description) so the renderer can offer a Sign-in
            // action and call `authenticate(methodId)` before `session/new`.
            // Every advertised method is forwarded; no agent-type filtering.
            let auth_methods = to_auth_method_infos(&response.auth_methods);
            let auth_method_ids: Vec<&str> = auth_methods.iter().map(|m| m.id.as_str()).collect();
            let session_caps = &response.agent_capabilities.session_capabilities;
            let supports_session_close = session_caps.close.is_some();
            log::info!(
                "[acp] agent {agent_id} initialized: protocol={:?} auth_methods={:?} \
                 loadSession={} sessionCapabilities.list={} resume={} close={}",
                response.protocol_version,
                auth_method_ids,
                response.agent_capabilities.load_session,
                session_caps.list.is_some(),
                session_caps.resume.is_some(),
                supports_session_close,
            );

            spawned.store(true, Ordering::Release);
            let _ = init_tx.send(Ok(InitOutcome {
                capabilities: response.agent_capabilities,
                auth_methods,
            }));
            supports_session_close
        }
        Ok(Err(e)) => {
            let _ = init_tx.send(Err(e.to_string()));
            return Err(e);
        }
        Err(_) => {
            let message = format!("initialize timed out after {INIT_TIMEOUT:?}");
            let _ = init_tx.send(Err(message.clone()));
            return Err(agent_client_protocol::Error::internal_error().data(message));
        }
    };

    // Step 2: command loop.
    //
    // Every agent→client *request* is dispatched via `cx.spawn` (not awaited
    // inline), so the loop returns to `command_rx.recv()` immediately. This is
    // the C1 fix: while any request is in flight, `RespondPermission` is still
    // serviced, so an agent that gates its reply on a permission decision can
    // never deadlock the loop. `recv()` is also always responsive to
    // `Shutdown` and to channel close, so `kill`/`kill_all` always make
    // progress (H1). Spawned tasks must return `Ok(())` and route protocol
    // errors through their reply channel — a spawned task that returns `Err`
    // would tear down the whole connection.
    while let Some(command) = command_rx.recv().await {
        match command {
            AcpCommand::Shutdown => break,

            AcpCommand::NewSession {
                cwd,
                mcp_servers,
                stable_agent_namespace,
                runtime_agent_id,
                project_id,
                ephemeral,
                worktree_path,
                worktree_branch,
                reply,
            } => {
                let slot = reply_slot(reply);
                let task_slot = slot.clone();
                let req_cx = cx.clone();
                let close_cx = cx.clone();
                let req_sinks = sinks.clone();
                let req_agent_id = agent_id.clone();
                let req_state = driver_state.clone();
                let req_persistence = persistence.clone();
                spawn_request(&cx, slot, async move {
                    let mut request = NewSessionRequest::new(cwd.clone()).mcp_servers(mcp_servers);
                    if profile.summarize_thinking {
                        request = request.meta(summarized_thinking_meta());
                    }
                    let timeout = session_new_timeout();
                    log::debug!(
                        "[acp] {req_agent_id} session/new sent, awaiting reply (timeout {timeout:?})"
                    );
                    match tokio::time::timeout(timeout, req_cx.send_request(request).block_task())
                        .await
                    {
                        Ok(Ok(response)) => {
                            let session_id = SessionId::from(response.session_id);
                            // Story 8: the registration metadata is built once —
                            // durable sessions register immediately; ephemeral
                            // sessions stash it on the driver state so a later
                            // `promote_session` registers it without trusting
                            // client-supplied fields.
                            let registration = SessionRegistration {
                                session_id: session_id.0.clone(),
                                stable_agent_namespace,
                                runtime_agent_id: Some(runtime_agent_id),
                                project_id,
                                cwd: PathBuf::from(&cwd),
                                worktree_path,
                                worktree_branch,
                            };
                            if !ephemeral {
                                if let Some(persistence) = req_persistence {
                                    if let Err(error) =
                                        persistence.register_session(registration.clone()).await
                                    {
                                        let _ = close_cx
                                            .send_request(CloseSessionRequest::new(&session_id))
                                            .block_task()
                                            .await;
                                        send_reply(
                                            &task_slot,
                                            Err(format!("failed to persist new session: {error}")),
                                        );
                                        return;
                                    }
                                }
                            }
                            // Record the session's workspace root so agent fs
                            // requests for this session can be sandboxed (H2).
                            {
                                let mut state = req_state.lock();
                                state.set_session_root(session_id.0.clone(), PathBuf::from(&cwd));
                                if ephemeral {
                                    state.mark_ephemeral(session_id.0.clone());
                                    state.note_promotable_registration(
                                        session_id.0.clone(),
                                        registration,
                                    );
                                }
                            }

                            // Cache the agent-advertised Model-selector configId so
                            // `set_model` targets it instead of hardcoding "model".
                            if let Some(id) = events::model_config_id_from_options(
                                response.config_options.as_deref(),
                            ) {
                                req_state
                                    .lock()
                                    .set_model_config_id(session_id.0.clone(), id);
                            }

                            let event = SessionCreatedEvent {
                                agent_id: req_agent_id,
                                session_id: session_id.clone(),
                                modes: response.modes.clone(),
                                models: events::models_from_config_options(
                                    response.config_options.as_deref(),
                                ),
                                config_options: response.config_options.clone(),
                            };
                            events::fan_out(
                                &req_sinks,
                                Some(event.session_id.0.as_str()),
                                events::EVENT_SESSION_CREATED,
                                &event,
                            );
                            send_reply(
                                &task_slot,
                                Ok(NewSessionOutcome {
                                    session_id,
                                    modes: response.modes,
                                    models: events::models_from_config_options(
                                        response.config_options.as_deref(),
                                    ),
                                    config_options: response.config_options,
                                }),
                            );
                        }
                        Ok(Err(e)) => send_reply(&task_slot, Err(acp_err_wire_string(e))),
                        Err(_) => {
                            log::warn!(
                                "[acp] {req_agent_id} session/new timed out after {timeout:?}; \
                                 check agent stderr in RUST_LOG=debug"
                            );
                            send_reply(
                                &task_slot,
                                Err(format!("session/new timed out after {timeout:?}")),
                            )
                        }
                    }
                });
            }

            AcpCommand::LoadSession {
                session_id,
                cwd,
                reply,
            } => {
                let slot = reply_slot(reply);
                let task_slot = slot.clone();
                let req_cx = cx.clone();
                let req_state = driver_state.clone();
                let req_persistence = persistence.clone();
                // Story 3 replay contract: admit the reopen by reserving the
                // session HERE — synchronously in the command loop, before the
                // request task is spawned — so admission follows
                // command-arrival order. Acquiring the reservation inside the
                // spawned task would leave a race: the task's first poll can
                // be deferred until after the loop services a later
                // SendPrompt, whose synchronous `try_begin_turn` would then
                // win admission over the earlier reopen. Admission is refused
                // while a prompt turn is active for the session: replayed
                // history must never overlap a live turn (the turn's updates
                // would be misclassified as replayed and dropped), so the
                // reopen fails instead — the caller may retry once the turn
                // completes.
                let Some(reopen_reservation) =
                    ReopenReservation::try_new(driver_state.clone(), session_id.0.to_string())
                else {
                    log::warn!(
                        "[acp] session {} load rejected: prompt turn active (ACP_REOPEN_TURN_ACTIVE)",
                        crate::logging::redact_session_id(&session_id.0)
                    );
                    send_reply(
                        &slot,
                        Err(format!("ACP_REOPEN_TURN_ACTIVE: session {}", session_id.0)),
                    );
                    continue;
                };
                spawn_request(&cx, slot, async move {
                    // The reservation acquired by the command loop is held for
                    // the whole reopen; the RAII guard releases it on every
                    // outcome (success, agent error, timeout, early return).
                    let _reopen_reservation = reopen_reservation;
                    // Reinstall the durable writer BEFORE sending session/load
                    // so POST-window live events (the follow-up prompt's
                    // chunks, status updates, last_seq-derived title-gen) are
                    // persisted instead of dropped with "persisted session not
                    // found". Replayed history arriving during the load is
                    // deliberately NOT persisted: the replay window below drops
                    // it before fan-out (story 3 — the persisted log is the
                    // sole history source). After an app restart the in-memory
                    // writer is gone; calling reopen_writer here restores it
                    // from the on-disk catalog before the agent starts
                    // streaming. Idempotent (no-op if already installed) and
                    // non-fatal (unknown/ephemeral id surfaces SessionNotFound,
                    // logged + skipped).
                    if let Some(persistence) = &req_persistence {
                        if let Err(error) = persistence.reopen_writer(&session_id.0).await {
                            log::warn!(
                                "[acp] session {} reopen_writer failed: {error} (continuing load)",
                                crate::logging::redact_session_id(&session_id.0)
                            );
                        }
                    }
                    // Open the replay window IMMEDIATELY BEFORE the request is
                    // sent — not at admission time — so suppression covers
                    // exactly the agent's history replay and live updates
                    // arriving during the preparatory writer reinstall are
                    // never dropped. The RAII guard closes the window on every
                    // outcome (success, agent error, timeout). The reservation
                    // above guarantees no turn is active, so this admission
                    // cannot fail; keep the check total anyway.
                    let Some(_replay_guard) =
                        ReplayWindowGuard::try_new(req_state.clone(), session_id.0.to_string())
                    else {
                        log::warn!(
                            "[acp] session {} load rejected: prompt turn active (ACP_REOPEN_TURN_ACTIVE)",
                            crate::logging::redact_session_id(&session_id.0)
                        );
                        send_reply(
                            &task_slot,
                            Err(format!("ACP_REOPEN_TURN_ACTIVE: session {}", session_id.0)),
                        );
                        return;
                    };
                    // Bounded like session/new: a wedged agent must not park the
                    // renderer's reconnect forever (the reply sender would be
                    // held indefinitely).
                    let mut request = LoadSessionRequest::new(&session_id, cwd.clone());
                    if profile.summarize_thinking {
                        request = request.meta(summarized_thinking_meta());
                    }
                    let result = run_session_reopen(
                        "session/load",
                        &session_id.0,
                        &cwd,
                        &req_state,
                        req_cx.send_request(request).block_task(),
                    )
                    .await;
                    send_reply(&task_slot, result);
                });
            }

            AcpCommand::ResumeSession {
                session_id,
                cwd,
                reply,
            } => {
                let slot = reply_slot(reply);
                let task_slot = slot.clone();
                let req_cx = cx.clone();
                let req_state = driver_state.clone();
                let req_persistence = persistence.clone();
                // Story 3 replay contract: same admission split as
                // session/load above — reserve the session synchronously in
                // the command loop, BEFORE the request task is spawned, so a
                // later SendPrompt's synchronous `try_begin_turn` can never
                // win admission over this earlier reopen while the task's
                // first poll is still deferred. Refuse to overlap a live
                // prompt turn (its updates would be misclassified as replayed
                // history and dropped).
                let Some(reopen_reservation) =
                    ReopenReservation::try_new(driver_state.clone(), session_id.0.to_string())
                else {
                    log::warn!(
                        "[acp] session {} resume rejected: prompt turn active (ACP_REOPEN_TURN_ACTIVE)",
                        crate::logging::redact_session_id(&session_id.0)
                    );
                    send_reply(
                        &slot,
                        Err(format!("ACP_REOPEN_TURN_ACTIVE: session {}", session_id.0)),
                    );
                    continue;
                };
                spawn_request(&cx, slot, async move {
                    // The reservation acquired by the command loop is held for
                    // the whole reopen and released on every outcome.
                    let _reopen_reservation = reopen_reservation;
                    // Same durable-writer reopen as LoadSession above — it
                    // serves POST-window live events; replayed history arriving
                    // during resume is dropped before fan-out by the replay
                    // window below (story 3), never persisted.
                    if let Some(persistence) = &req_persistence {
                        if let Err(error) = persistence.reopen_writer(&session_id.0).await {
                            log::warn!(
                                "[acp] session {} reopen_writer failed: {error} (continuing resume)",
                                crate::logging::redact_session_id(&session_id.0)
                            );
                        }
                    }
                    // Same deferred replay window as LoadSession above: opened
                    // immediately before the request so suppression covers
                    // exactly the agent's history replay; unreachable admission
                    // re-check kept total (the reservation blocks turns).
                    let Some(_replay_guard) =
                        ReplayWindowGuard::try_new(req_state.clone(), session_id.0.to_string())
                    else {
                        log::warn!(
                            "[acp] session {} resume rejected: prompt turn active (ACP_REOPEN_TURN_ACTIVE)",
                            crate::logging::redact_session_id(&session_id.0)
                        );
                        send_reply(
                            &task_slot,
                            Err(format!("ACP_REOPEN_TURN_ACTIVE: session {}", session_id.0)),
                        );
                        return;
                    };
                    let mut request = ResumeSessionRequest::new(&session_id, cwd.clone());
                    if profile.summarize_thinking {
                        request = request.meta(summarized_thinking_meta());
                    }
                    let result = run_session_reopen(
                        "session/resume",
                        &session_id.0,
                        &cwd,
                        &req_state,
                        req_cx.send_request(request).block_task(),
                    )
                    .await;
                    send_reply(&task_slot, result);
                });
            }

            AcpCommand::CloseSession { session_id, reply } => {
                let slot = reply_slot(reply);
                let task_slot = slot.clone();
                let req_cx = cx.clone();
                let req_state = driver_state.clone();
                let req_persistence = persistence.clone();
                let req_plan_server = host_plan_server.clone();
                spawn_request(&cx, slot, async move {
                    let request = CloseSessionRequest::new(&session_id);
                    let result = req_cx.send_request(request).block_task().await;
                    // Story 8: `begin_close_session` captures the ephemeral mark BEFORE
                    // clearing the session's roots/marks — backend-ephemeral
                    // sessions skip history finalization below (there is no
                    // durable record to finalize, so closing one must not
                    // surface a spurious "history finalization failed").
                    let mut was_ephemeral = false;
                    if result.is_ok() {
                        // Forget the workspace root and resolve any pending
                        // permissions for the now-closed session.
                        let pending = {
                            let mut state = req_state.lock();
                            let (ephemeral, pending) = state.begin_close_session(&session_id.0);
                            was_ephemeral = ephemeral;
                            pending
                        };
                        for permission in pending {
                            let _ = permission.responder.respond(RequestPermissionResponse::new(
                                RequestPermissionOutcome::Cancelled,
                            ));
                        }
                        // Issue #411: resolve outstanding questions for the
                        // closed session as cancelled too.
                        let pending_questions =
                            req_state.lock().finish_turn_questions(&session_id.0);
                        for question in pending_questions {
                            let _ = question.responder.respond(serde_json::json!({
                                "questionId": question.question_id,
                                "cancelled": true,
                            }));
                        }
                        // Evict host-plan auth, cache, and any active route only
                        // after the agent confirms the session is closed.
                        req_plan_server.unregister_session(&session_id.0);
                    }
                    let mut result = result.map(|_| ()).map_err(|e| e.to_string());
                    if result.is_ok() {
                        result = finalize_closed_session_if_durable(
                            req_persistence.as_ref(),
                            &session_id.0,
                            was_ephemeral,
                        )
                        .await;
                    }
                    send_reply(&task_slot, result);
                });
            }

            AcpCommand::ListSessions { cwd, cursor, reply } => {
                let slot = reply_slot(reply);
                let task_slot = slot.clone();
                let req_cx = cx.clone();
                spawn_request(&cx, slot, async move {
                    let mut request = agent_client_protocol::schema::v1::ListSessionsRequest::new();
                    if let Some(cwd) = cwd {
                        request = request.cwd(std::path::PathBuf::from(cwd));
                    }
                    if let Some(cursor) = cursor {
                        request = request.cursor(cursor);
                    }
                    let result = req_cx.send_request(request).block_task().await;
                    send_reply(&task_slot, result.map_err(|e| e.to_string()));
                });
            }

            AcpCommand::SendPrompt {
                session_id,
                content,
                turn_id,
                accepted,
                reply,
            } => {
                // Single-flight per session: reject a second prompt while a turn
                // is in flight (M4). Story 3 replay contract: also reject while
                // a replay window is open (a live turn must never overlap
                // agent-replayed history — the window drops every update for
                // the session before fan-out). `try_begin_turn` returns a
                // cancel signal receiver when the turn may proceed.
                let handles = driver_state.lock().try_begin_turn(&session_id.0);
                let Some(handles) = handles else {
                    // Stable code matched by renderer `ACP_TURN_IN_PROGRESS_CODE`.
                    // A rejection due to an open replay window or a held reopen
                    // reservation intentionally surfaces through the same code:
                    // the window is bounded by the reopen timeout, and the
                    // renderer recovers the prompt to its queue so it flushes
                    // once replay finishes.
                    log::debug!(
                        "[acp] session {} prompt rejected: turn active or reopen in flight (ACP_TURN_IN_PROGRESS)",
                        crate::logging::redact_session_id(&session_id.0)
                    );
                    let error = format!("ACP_TURN_IN_PROGRESS: session {}", session_id.0);
                    let _ = accepted.send(Err(error.clone()));
                    let _ = reply.send(Err(error));
                    continue;
                };
                let cancel_rx = handles.cancel_rx;
                let mut idle_rx = handles.idle_rx;

                let slot = reply_slot(reply);
                let task_slot = slot.clone();
                let turn_cx = cx.clone();
                let turn_sinks = sinks.clone();
                let turn_agent_id = agent_id.clone();
                let turn_plan_server = host_plan_server.clone();
                let turn_state = driver_state.clone();
                let turn_persistence = persistence.clone();
                let turn_session = session_id.clone();
                let log_session = session_id.clone();
                // Register before spawning so an immediate `plan` call is
                // routed to this accepted prompt's session, even when the agent
                // reuses an MCP child created for an older session.
                host_plan_server.begin_turn(&agent_id.0, &session_id.0);
                // Story 1.8 T3.2: capture the client turn-id to echo on prompt_complete.
                let turn_turn_id = turn_id.clone();
                let spawn_result = cx.spawn(async move {
                    // Race the turn against completion, a cancel signal, an
                    // optional idle deadline (reset by agent `session/update`
                    // activity via `DriverState::signal_idle`), and an optional
                    // hard wall-clock cap. Both default to `None` (unlimited):
                    // a turn is bounded only if the operator/user configured a
                    // value. On idle/hard timeout → signal cancel +
                    // `CANCEL_GRACE` + a typed error (`acp-store` sets
                    // `status: 'error'`). See [`race_turn`].
                    let idle = turn_idle_timeout();
                    let hard = resolved_turn_timeout();
                    let cancel_state = turn_state.clone();
                    let cancel_session = session_id.clone();
                    let cancel_cx = turn_cx.clone();
                    let outcome: Result<StopReason, String> = race_turn(
                        async {
                            turn_cx
                                .send_request(PromptRequest::new(&session_id, content))
                                .block_task()
                                .await
                                .map(|r| r.stop_reason)
                                .map_err(|e| e.to_string())
                        },
                        cancel_rx,
                        &mut idle_rx,
                        move || {
                            // Mirror AcpCommand::CancelPrompt: signal the
                            // active-turn cancel (winds down the race) AND
                            // notify the agent to abandon its in-flight
                            // session/prompt. send_notification is non-blocking
                            // (it queues onto the connection), so race_turn
                            // stays sync.
                            cancel_state.lock().signal_cancel(&cancel_session.0);
                            if let Err(error) = cancel_cx
                                .send_notification(CancelNotification::new(&cancel_session))
                            {
                                log::warn!(
                                    "[acp] failed to cancel agent prompt on turn timeout: {error}"
                                );
                            }
                        },
                        idle,
                        hard,
                    )
                    .await;

                    match &outcome {
                        Ok(stop_reason) => log::info!(
                            "[acp] session {} turn complete: stop_reason={stop_reason:?}",
                            crate::logging::redact_session_id(&log_session.0)
                        ),
                        Err(message) => {
                            log::warn!(
                                "[acp] session {} turn failed: {message}",
                                crate::logging::redact_session_id(&log_session.0)
                            )
                        }
                    }

                    // Turn is over: clear the host-plan routing marker and the
                    // driver active-turn marker. A successful prompt leaves
                    // unanswered permissions parked so a late Allow still
                    // reaches the agent. Cancel, failure, and disposal drain
                    // them as cancelled.
                    turn_plan_server.end_turn(&turn_agent_id.0, &session_id.0);
                    let pending = if matches!(outcome, Ok(StopReason::Cancelled) | Err(_)) {
                        turn_state.lock().finish_turn(&session_id.0)
                    } else {
                        turn_state.lock().release_turn(&session_id.0);
                        Vec::new()
                    };
                    for permission in pending {
                        let _ = permission.responder.respond(RequestPermissionResponse::new(
                            RequestPermissionOutcome::Cancelled,
                        ));
                    }
                    // Issue #411: model-abandoned questions are first-class
                    // outcomes — a turn that ends without the user answering
                    // resolves the parked question responders as cancelled.
                    let pending_questions = turn_state.lock().finish_turn_questions(&session_id.0);
                    for question in pending_questions {
                        let _ = question.responder.respond(serde_json::json!({
                            "questionId": question.question_id,
                            "cancelled": true,
                        }));
                    }

                    let is_ephemeral = turn_state.lock().is_ephemeral(&session_id.0);
                    match outcome {
                        Ok(stop_reason) => {
                            let event = PromptCompleteEvent {
                                agent_id: turn_agent_id,
                                session_id,
                                stop_reason,
                                turn_id: turn_turn_id.clone(),
                            };
                            events::fan_out(
                                &turn_sinks,
                                Some(event.session_id.0.as_str()),
                                events::EVENT_PROMPT_COMPLETE,
                                &event,
                            );
                            if !is_ephemeral {
                                if let Some(persistence) = &turn_persistence {
                                    if let Err(error) =
                                        persistence.flush_session(&event.session_id.0).await
                                    {
                                        send_reply(
                                            &task_slot,
                                            Err(format!(
                                                "failed to flush session history: {error}"
                                            )),
                                        );
                                        return Ok(());
                                    }
                                }
                            }
                            send_reply(&task_slot, Ok(stop_reason));
                        }
                        Err(message) => {
                            let event = AgentErrorEvent {
                                agent_id: turn_agent_id,
                                session_id: Some(session_id),
                                message: message.clone(),
                            };
                            // Turn-scoped error → sid is the session id.
                            events::fan_out(
                                &turn_sinks,
                                event.session_id.as_ref().map(|s| s.0.as_str()),
                                events::EVENT_AGENT_ERROR,
                                &event,
                            );
                            if !is_ephemeral {
                                if let Some(persistence) = &turn_persistence {
                                    if let Some(session_id) = event.session_id.as_ref() {
                                        if let Err(error) =
                                            persistence.flush_session(&session_id.0).await
                                        {
                                            send_reply(
                                                &task_slot,
                                                Err(format!(
                                                    "{message}; history flush failed: {error}"
                                                )),
                                            );
                                            return Ok(());
                                        }
                                    }
                                }
                            }
                            send_reply(&task_slot, Err(message));
                        }
                    }
                    Ok(())
                });
                if let Err(e) = spawn_result {
                    // The connection is shutting down; clear the markers we just
                    // set and surface the real error to the caller (L5).
                    host_plan_server.end_turn(&agent_id.0, &turn_session.0);
                    driver_state.lock().finish_turn(&turn_session.0);
                    let error = format!("failed to start prompt turn: {e}");
                    let _ = accepted.send(Err(error.clone()));
                    send_reply(&slot, Err(error));
                } else {
                    let _ = accepted.send(Ok(()));
                }
            }

            AcpCommand::OwnsSession { session_id, reply } => {
                let _ = reply.send(Ok(driver_state
                    .lock()
                    .session_root(&session_id.0)
                    .is_some()));
            }

            AcpCommand::IsEphemeralSession { session_id, reply } => {
                let _ = reply.send(Ok(driver_state.lock().is_ephemeral(&session_id.0)));
            }

            AcpCommand::PromoteSession { session_id, reply } => {
                let slot = reply_slot(reply);
                let task_slot = slot.clone();
                let req_state = driver_state.clone();
                let req_persistence = persistence.clone();
                let req_agent_id = agent_id.clone();
                let req_sinks = sinks.clone();
                spawn_request(&cx, slot, async move {
                    let result = promote_session_in_driver(
                        &req_state,
                        req_persistence.as_ref(),
                        &req_agent_id,
                        &session_id,
                    )
                    .await;
                    // A real ephemeral→durable transition created the catalog
                    // row just now — the create-time session_created was
                    // ephemeral and persisted nothing, so notify here (every
                    // client refetches the history index). Idempotent no-op
                    // promotes notify nothing.
                    if let Ok(outcome) = &result {
                        if outcome.promoted {
                            let parked = req_state
                                .lock()
                                .take_parked_permission_events(&session_id.0);
                            for event in parked {
                                events::fan_out(
                                    &req_sinks,
                                    Some(session_id.0.as_str()),
                                    events::EVENT_PERMISSION_REQUEST,
                                    &event,
                                );
                            }
                            events::fan_out(
                                &req_sinks,
                                Some(session_id.0.as_str()),
                                events::EVENT_SESSION_INFO_UPDATE,
                                &events::SessionInfoUpdateEvent {
                                    agent_id: req_agent_id.clone(),
                                    session_id: session_id.clone(),
                                    title: outcome.title.clone(),
                                },
                            );
                        }
                    } else {
                        let parked = req_state
                            .lock()
                            .take_parked_permission_events(&session_id.0);
                        if !parked.is_empty() {
                            log::warn!(
                                "[acp] session {} promotion failed; cancelling {} parked permission request(s)",
                                crate::logging::redact_session_id(&session_id.0),
                                parked.len()
                            );
                        }
                        for event in parked {
                            if let Some(permission) =
                                req_state.lock().take_permission(&event.request_id)
                            {
                                let _ =
                                    permission.responder.respond(RequestPermissionResponse::new(
                                        RequestPermissionOutcome::Cancelled,
                                    ));
                            }
                        }
                    }
                    send_reply(&task_slot, result.map(|_| ()));
                });
            }

            AcpCommand::IsTurnActive { session_id, reply } => {
                let _ = reply.send(Ok(driver_state.lock().is_turn_active(&session_id.0)));
            }

            AcpCommand::WaitTurnIdle { session_id, reply } => {
                let waiter = driver_state.lock().wait_turn_idle(&session_id.0);
                match waiter {
                    None => {
                        let _ = reply.send(Ok(()));
                    }
                    Some(waiter) => {
                        let slot = reply_slot(reply);
                        let task_slot = slot.clone();
                        spawn_request(&cx, slot, async move {
                            let result = waiter
                                .await
                                .map_err(|_| "turn idle waiter was dropped".to_string());
                            send_reply(&task_slot, result);
                        });
                    }
                }
            }

            AcpCommand::DisposeEphemeralSession { session_id, reply } => {
                let waiter = {
                    let mut state = driver_state.lock();
                    if !state.is_ephemeral(&session_id.0) {
                        let _ = reply.send(Err("session is not ephemeral".to_string()));
                        continue;
                    }
                    state.signal_cancel(&session_id.0);
                    state.wait_turn_idle(&session_id.0)
                };
                let slot = reply_slot(reply);
                let task_slot = slot.clone();
                let dispose_state = driver_state.clone();
                let dispose_plan_server = host_plan_server.clone();
                let close_cx = cx.clone();
                spawn_request(&cx, slot, async move {
                    if let Some(waiter) = waiter {
                        let timeout = CANCEL_GRACE + Duration::from_millis(250);
                        match tokio::time::timeout(timeout, waiter).await {
                            Ok(Ok(())) => {}
                            Ok(Err(_)) => {
                                send_reply(
                                    &task_slot,
                                    Err("turn idle waiter was dropped".to_string()),
                                );
                                return;
                            }
                            Err(_) => {
                                send_reply(
                                    &task_slot,
                                    Err(format!(
                                        "ephemeral session disposal timed out after {timeout:?}"
                                    )),
                                );
                                return;
                            }
                        }
                    }
                    {
                        let state = dispose_state.lock();
                        if state.is_turn_active(&session_id.0) {
                            send_reply(
                                &task_slot,
                                Err("ephemeral session turn is still active".to_string()),
                            );
                            return;
                        }
                        if !state.is_ephemeral(&session_id.0) {
                            send_reply(&task_slot, Err("session is not ephemeral".to_string()));
                            return;
                        }
                    }

                    // The temporary session is now idle and still protected by
                    // the authoritative ephemeral marker. Ask capable agents to
                    // release their session-side resources, but never let a
                    // stale or wedged `session/close` prevent local cleanup. The
                    // short bound keeps disposal responsive.
                    if supports_session_close {
                        let close_timeout = CANCEL_GRACE;
                        match tokio::time::timeout(
                            close_timeout,
                            close_cx
                                .send_request(CloseSessionRequest::new(&session_id))
                                .block_task(),
                        )
                        .await
                        {
                            Ok(Ok(_)) => {}
                            Ok(Err(error)) => log::debug!(
                                "[acp] ephemeral session {} close failed: {error}",
                                crate::logging::redact_session_id(&session_id.0)
                            ),
                            Err(_) => log::warn!(
                                "[acp] ephemeral session {} close timed out after {close_timeout:?}",
                                crate::logging::redact_session_id(&session_id.0)
                            ),
                        }
                    }

                    let (permissions, questions) = {
                        let mut state = dispose_state.lock();
                        if state.is_turn_active(&session_id.0) {
                            send_reply(
                                &task_slot,
                                Err("ephemeral session turn became active during disposal"
                                    .to_string()),
                            );
                            return;
                        }
                        if !state.is_ephemeral(&session_id.0) {
                            send_reply(&task_slot, Err("session is not ephemeral".to_string()));
                            return;
                        }
                        state.dispose_session(&session_id.0)
                    };
                    for permission in permissions {
                        let _ = permission.responder.respond(RequestPermissionResponse::new(
                            RequestPermissionOutcome::Cancelled,
                        ));
                    }
                    for question in questions {
                        let _ = question.responder.respond(serde_json::json!({
                            "questionId": question.question_id,
                            "cancelled": true,
                        }));
                    }
                    // A promotable warm-pool session carries the injected plan
                    // server — drop its registration on dispose (no-op for
                    // non-promotable one-shots).
                    dispose_plan_server.unregister_session(&session_id.0);
                    send_reply(&task_slot, Ok(()));
                });
            }

            AcpCommand::CancelPrompt { session_id, reply } => {
                // Signal the active turn to wind down (bounding its wait) and
                // resolve any pending permissions for this session as cancelled.
                let pending = {
                    let mut state = driver_state.lock();
                    state.signal_cancel(&session_id.0);
                    // The responder is answered below. Drop the parked UI
                    // payload so a later promotion cannot show a request
                    // whose Allow no longer has a responder.
                    let _parked = state.take_parked_permission_events(&session_id.0);
                    state.drain_session(&session_id.0)
                };
                for permission in pending {
                    let _ = permission.responder.respond(RequestPermissionResponse::new(
                        RequestPermissionOutcome::Cancelled,
                    ));
                }
                // Issue #411: cancel also resolves any outstanding questions for
                // the session (the agent abandons them; first-class outcome).
                let pending_questions = driver_state.lock().drain_session_questions(&session_id.0);
                for question in pending_questions {
                    let _ = question.responder.respond(serde_json::json!({
                        "questionId": question.question_id,
                        "cancelled": true,
                    }));
                }
                let result = cx.send_notification(CancelNotification::new(&session_id));
                let _ = reply.send(result.map_err(|e| e.to_string()));
            }

            AcpCommand::SetMode {
                session_id,
                mode_id,
                reply,
            } => {
                let slot = reply_slot(reply);
                let task_slot = slot.clone();
                let req_cx = cx.clone();
                spawn_request(&cx, slot, async move {
                    let request = SetSessionModeRequest::new(&session_id, mode_id);
                    let result = req_cx.send_request(request).block_task().await;
                    send_reply(&task_slot, result.map(|_| ()).map_err(|e| e.to_string()));
                });
            }

            AcpCommand::SetModel {
                session_id,
                model_id,
                reply,
            } => {
                let slot = reply_slot(reply);
                let task_slot = slot.clone();
                let req_cx = cx.clone();
                let req_sinks = sinks.clone();
                let req_agent_id = agent_id.clone();
                let req_state = driver_state.clone();
                spawn_request(&cx, slot, async move {
                    // ACP 0.14 removed `session/set_model`; the model is now a
                    // `select`-kind config option (category = Model). Its configId
                    // is the agent-provided option id (cached at session/new from
                    // the agent's `config_options`), falling back to the `"model"`
                    // convention when the agent didn't advertise one. `model_id` is
                    // the option value id the renderer picked.
                    let config_id = req_state
                        .lock()
                        .model_config_id(&session_id.0)
                        .unwrap_or_else(|| "model".to_string());
                    let request = SetSessionConfigOptionRequest::new(
                        &session_id,
                        config_id,
                        model_id.as_str(),
                    );
                    match req_cx.send_request(request).block_task().await {
                        Ok(response) => {
                            let event = ConfigOptionsUpdateEvent {
                                agent_id: req_agent_id,
                                session_id,
                                config_options: response.config_options.clone(),
                            };
                            events::fan_out(
                                &req_sinks,
                                Some(event.session_id.0.as_str()),
                                events::EVENT_CONFIG_OPTIONS_UPDATE,
                                &event,
                            );
                            send_reply(&task_slot, Ok(()));
                        }
                        Err(e) => send_reply(&task_slot, Err(e.to_string())),
                    }
                });
            }

            AcpCommand::SetConfigOption {
                session_id,
                config_id,
                value_id,
                reply,
            } => {
                let slot = reply_slot(reply);
                let task_slot = slot.clone();
                let req_cx = cx.clone();
                let req_sinks = sinks.clone();
                let req_agent_id = agent_id.clone();
                let req_state = driver_state.clone();
                spawn_request(&cx, slot, async move {
                    let request = SetSessionConfigOptionRequest::new(
                        &session_id,
                        config_id,
                        value_id.as_str(),
                    );
                    let result = if profile.lenient_config_option_ack {
                        match UntypedMessage::new("session/set_config_option", &request) {
                            Ok(message) => req_cx
                                .send_request(message)
                                .block_task()
                                .await
                                .map_err(|e| e.to_string())
                                .and_then(factory_config_option_result),
                            Err(e) => Err(e.to_string()),
                        }
                    } else {
                        req_cx
                            .send_request(request)
                            .block_task()
                            .await
                            .map(|response| Some(response.config_options))
                            .map_err(|e| e.to_string())
                    };
                    match result {
                        Ok(Some(config_options)) => {
                            // Keep the cached Model-selector configId fresh in case
                            // the agent reorganized its config options.
                            if let Some(id) = events::model_config_id_from_options(Some(
                                config_options.as_slice(),
                            )) {
                                req_state
                                    .lock()
                                    .set_model_config_id(session_id.0.clone(), id);
                            }
                            let event = ConfigOptionsUpdateEvent {
                                agent_id: req_agent_id,
                                session_id,
                                config_options: config_options.clone(),
                            };
                            events::fan_out(
                                &req_sinks,
                                Some(event.session_id.0.as_str()),
                                events::EVENT_CONFIG_OPTIONS_UPDATE,
                                &event,
                            );
                            send_reply(&task_slot, Ok(Some(config_options)));
                        }
                        Ok(None) => {
                            log::info!(
                                "[acp] Factory Droid accepted a config option without a snapshot"
                            );
                            send_reply(&task_slot, Ok(None));
                        }
                        Err(e) => send_reply(&task_slot, Err(e)),
                    }
                });
            }

            AcpCommand::RespondPermission {
                request_id,
                outcome,
                reply,
            } => {
                let pending = driver_state.lock().take_permission(&request_id);
                match pending {
                    Some(permission) => {
                        let result = permission
                            .responder
                            .respond(RequestPermissionResponse::new(outcome));
                        let _ = reply.send(result.map_err(|e| e.to_string()));
                    }
                    None => {
                        let _ =
                            reply.send(Err(format!("unknown permission request: {request_id}")));
                    }
                }
            }

            AcpCommand::AnswerQuestion {
                question_id,
                values,
                reply,
            } => {
                // Issue #411: resolve the parked `_session/question` responder
                // exactly once. `Some(values)` → the selected option values;
                // `None` → cancelled. Unknown id (already resolved / drained)
                // mirrors the permission race-loser path.
                let pending = driver_state.lock().take_question(&question_id);
                match pending {
                    Some(question) => {
                        let payload = match &values {
                            Some(values) => serde_json::json!({
                                "questionId": question_id,
                                "values": values,
                            }),
                            None => serde_json::json!({
                                "questionId": question_id,
                                "cancelled": true,
                            }),
                        };
                        let result = question.responder.respond(payload);
                        let _ = reply.send(result.map_err(|e| e.to_string()));
                    }
                    None => {
                        let _ = reply.send(Err(format!("unknown question request: {question_id}")));
                    }
                }
            }

            AcpCommand::Authenticate { method_id, reply } => {
                let slot = reply_slot(reply);
                let task_slot = slot.clone();
                let req_cx = cx.clone();
                let log_agent_id = agent_id.clone();
                spawn_request(&cx, slot, async move {
                    log::info!("[acp] agent {log_agent_id} authenticating via '{method_id}'");
                    let result = req_cx
                        .send_request(AuthenticateRequest::new(method_id))
                        .block_task()
                        .await
                        .map(|_| ())
                        .map_err(|e| e.to_string());
                    send_reply(&task_slot, result);
                });
            }
        }
    }

    Ok(())
}

/// Spawn an agent→client request task on the connection, keeping the command
/// loop free to service other commands (notably `RespondPermission`) while it
/// runs (the C1 fix).
///
/// The request's `reply` sender lives in a shared [`ReplySlot`]: the spawned
/// task sends the real result through it, but if spawning fails (the connection
/// is winding down) this helper sends an explicit error instead of dropping the
/// sender — otherwise the caller would see the generic "agent thread dropped
/// the reply" rather than the real cause (L5).
///
/// The spawned task itself must always resolve to `Ok(())`; a spawned task that
/// returns `Err` would tear down the whole connection.
pub(super) fn spawn_request<T, Fut>(cx: &ConnectionTo<Agent>, slot: ReplySlot<T>, task: Fut)
where
    T: Send + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    if let Err(e) = cx.spawn(async move {
        task.await;
        Ok(())
    }) {
        send_reply(&slot, Err(format!("failed to dispatch request: {e}")));
    }
}

/// A reply sender shared between a spawned request task and the command loop so
/// the loop can still surface a real error if the task fails to spawn (L5).
/// Whichever side resolves first takes the sender; the other becomes a no-op.
pub(super) type ReplySlot<T> = Arc<Mutex<Option<oneshot::Sender<Result<T, String>>>>>;

/// Wrap a reply sender in a shared, take-once slot.
pub(super) fn reply_slot<T>(reply: oneshot::Sender<Result<T, String>>) -> ReplySlot<T> {
    Arc::new(Mutex::new(Some(reply)))
}

/// Send through a [`ReplySlot`] exactly once; subsequent sends are ignored.
pub(super) fn send_reply<T>(slot: &ReplySlot<T>, value: Result<T, String>) {
    if let Some(tx) = slot.lock().take() {
        let _ = tx.send(value);
    }
}
