//! In-crate fake agent driver for prompt-flow and relay-fault tests. It
//! reproduces the real command loop's behaviour instead of answering "always
//! OK": the real [`DriverState`] single-flight (`ACP_TURN_IN_PROGRESS`
//! rejection, which leaves the accept hook unrun), the accept hook before
//! anything of the turn is emitted, the real terminator helpers from
//! `turn.rs`, and an `Authenticate` handler that runs off the command loop
//! (like the real `spawn_request`) and can be slow, fail or crash.

use super::*;
use std::collections::VecDeque;

/// Scripted outcome of one accepted prompt.
pub(crate) enum FakeTurn {
    /// The agent ends the turn with this ACP stop reason.
    Stop(StopReason),
    /// The agent RPC fails: `agent_error` + an `error` terminator.
    Fail(String),
    /// The idle/hard deadline elapses: `agent_error` + a `timeout` terminator.
    Timeout,
    /// The connection closes mid-turn: the teardown appends `crashed`, and
    /// the turn reply is dropped (the waiter sees "agent thread dropped…").
    Crash,
    /// The driver accepts and runs the accept hook, but starting the turn task
    /// fails (connection shutting down): the `error` terminator closes the
    /// published `user_prompt` and the caller gets a spawn error.
    SpawnFail,
    /// The turn runs until `release` fires (`end_turn`) or the prompt is
    /// cancelled (`cancelled`); `entered` fires when the turn is accepted.
    Hold {
        release: oneshot::Receiver<()>,
        entered: oneshot::Sender<()>,
    },
}

/// What an `authenticate` request resolves to once its delay elapsed.
pub(crate) enum FakeAuthOutcome {
    /// The agent accepts the method.
    Ok,
    /// The agent RPC fails; the message is the real loop's `e.to_string()`.
    Fail(String),
    /// The agent connection dies mid-handler: the reply sender is dropped and
    /// the caller sees the transport's "agent thread dropped" error.
    Crash,
}

/// Scripted `authenticate` request: a (virtual-time friendly) delay, then an
/// outcome. A slow `Ok` is the long-handler fixture for the relay's
/// slow-handler-vs-pong-deadline invariant.
pub(crate) struct FakeAuth {
    pub(crate) delay: std::time::Duration,
    pub(crate) outcome: FakeAuthOutcome,
}

impl FakeAuth {
    pub(crate) fn ok_after(delay: std::time::Duration) -> Self {
        Self {
            delay,
            outcome: FakeAuthOutcome::Ok,
        }
    }

    pub(crate) fn fail_after(delay: std::time::Duration, message: &str) -> Self {
        Self {
            delay,
            outcome: FakeAuthOutcome::Fail(message.to_string()),
        }
    }

    pub(crate) fn crash_after(delay: std::time::Duration) -> Self {
        Self {
            delay,
            outcome: FakeAuthOutcome::Crash,
        }
    }
}

pub(crate) struct FakeDriver {
    sinks: Vec<Arc<dyn EventSink>>,
    agent_id: AgentId,
    state: Arc<Mutex<DriverState>>,
    turns: Mutex<VecDeque<FakeTurn>>,
    emit_chunk: bool,
    accept_gate: Mutex<Option<oneshot::Receiver<()>>>,
    auths: Mutex<VecDeque<FakeAuth>>,
}

impl FakeDriver {
    pub(crate) fn new(
        sinks: Vec<Arc<dyn EventSink>>,
        agent_id: AgentId,
        turns: Vec<FakeTurn>,
        emit_chunk: bool,
    ) -> Self {
        Self {
            sinks,
            agent_id,
            state: Arc::new(Mutex::new(DriverState::new())),
            turns: Mutex::new(turns.into()),
            emit_chunk,
            accept_gate: Mutex::new(None),
            auths: Mutex::new(VecDeque::new()),
        }
    }

    /// Script the outcomes of successive `authenticate` requests (default
    /// once exhausted: an immediate `Ok`).
    pub(crate) fn with_auths(self, auths: Vec<FakeAuth>) -> Self {
        *self.auths.lock() = auths.into();
        self
    }

    /// Withhold the accept ack of the next prompt until `gate` fires (or its
    /// sender drops).
    pub(crate) fn with_accept_gate(self, gate: oneshot::Receiver<()>) -> Self {
        *self.accept_gate.lock() = Some(gate);
        self
    }

    /// Mirror of the command loop's `Authenticate` arm: the request runs on
    /// its own task so the loop keeps serving other commands while it is
    /// pending.
    pub(crate) fn authenticate(&self, reply: oneshot::Sender<Result<(), String>>) {
        let script = self
            .auths
            .lock()
            .pop_front()
            .unwrap_or_else(|| FakeAuth::ok_after(std::time::Duration::ZERO));
        tokio::spawn(async move {
            if !script.delay.is_zero() {
                tokio::time::sleep(script.delay).await;
            }
            match script.outcome {
                FakeAuthOutcome::Ok => {
                    let _ = reply.send(Ok(()));
                }
                FakeAuthOutcome::Fail(message) => {
                    let _ = reply.send(Err(message));
                }
                FakeAuthOutcome::Crash => drop(reply),
            }
        });
    }

    pub(crate) fn is_turn_active(&self, session_id: &str) -> bool {
        self.state.lock().is_turn_active(session_id)
    }

    pub(crate) fn cancel(&self, session_id: &str) {
        self.state.lock().signal_cancel(session_id);
    }

    /// Mirror of the command loop's `SendPrompt` arm.
    pub(crate) fn send_prompt(
        &self,
        session_id: SessionId,
        turn_id: Option<String>,
        on_accept: Option<PromptAcceptHook>,
        accepted: oneshot::Sender<Result<(), String>>,
        reply: oneshot::Sender<Result<StopReason, String>>,
    ) {
        let handles = self.state.lock().try_begin_turn(&session_id.0);
        let Some(handles) = handles else {
            let error = format!("ACP_TURN_IN_PROGRESS: session {}", session_id.0);
            let _ = accepted.send(Err(error.clone()));
            let _ = reply.send(Err(error));
            return;
        };
        self.state
            .lock()
            .set_active_turn_id(&session_id.0, turn_id.clone());
        let hook_ran = on_accept.is_some();
        if let Some(hook) = on_accept {
            hook();
        }
        // Mirror of the command loop's `cx.spawn` failure: markers cleared and
        // the caller sees the spawn error. The `error` terminator closes the
        // already published `user_prompt` ONLY when the accept hook ran (the
        // production `hook_ran` guard) — with no hook there is no durable
        // turn to close, so no terminator is emitted.
        let spawn_fails = matches!(self.turns.lock().front(), Some(FakeTurn::SpawnFail));
        if spawn_fails {
            self.turns.lock().pop_front();
            self.state.lock().finish_turn(&session_id.0);
            let error = "failed to start prompt turn: connection closed".to_string();
            if hook_ran {
                emit_turn_terminator(
                    &self.sinks,
                    &self.agent_id,
                    &session_id,
                    turn_id,
                    events::TurnFailureStop::Error.into(),
                    None,
                );
            }
            let _ = accepted.send(Err(error.clone()));
            let _ = reply.send(Err(error));
            return;
        }
        // Gated accept: the driver HAS accepted (single-flight marker set, hook
        // run, turn spawned below) but the `accepted` ack to `start_prompt`
        // is withheld until the gate opens — the window in which a carrier can
        // drop its caller future while the driver already runs the turn.
        let gate = self.accept_gate.lock().take();
        match gate {
            Some(gate) => {
                tokio::spawn(async move {
                    let _ = gate.await;
                    let _ = accepted.send(Ok(()));
                });
            }
            None => {
                let _ = accepted.send(Ok(()));
            }
        }
        if self.emit_chunk {
            let event = events::MessageChunkEvent {
                agent_id: self.agent_id.clone(),
                session_id: session_id.clone(),
                role: events::ChunkRole::Agent,
                content: ContentBlock::Text(agent_client_protocol::schema::v1::TextContent::new(
                    "chunk",
                )),
                message_id: None,
                parent_tool_call_id: None,
            };
            events::fan_out(
                &self.sinks,
                Some(session_id.0.as_str()),
                events::EVENT_MESSAGE_CHUNK,
                &event,
            );
        }
        let turn = self
            .turns
            .lock()
            .pop_front()
            .unwrap_or(FakeTurn::Stop(StopReason::EndTurn));
        let state = Arc::clone(&self.state);
        let sinks = self.sinks.clone();
        let agent_id = self.agent_id.clone();
        tokio::spawn(async move {
            let outcome: Result<StopReason, events::AcpErrorDetail> = match turn {
                FakeTurn::Stop(stop_reason) => Ok(stop_reason),
                FakeTurn::Fail(message) => Err(message.into()),
                FakeTurn::Timeout => Err(timeouts::TurnTimeout {
                    message: "turn idle timeout: no agent activity".to_string(),
                }
                .into()),
                FakeTurn::SpawnFail => unreachable!("handled before the turn task starts"),
                FakeTurn::Crash => {
                    emit_crash_terminators(&state, &sinks, &agent_id);
                    return;
                }
                FakeTurn::Hold { release, entered } => {
                    let _ = entered.send(());
                    tokio::select! {
                        _ = release => Ok(StopReason::EndTurn),
                        _ = handles.cancel_rx => Ok(StopReason::Cancelled),
                    }
                }
            };
            state.lock().finish_turn(&session_id.0);
            emit_turn_outcome(&sinks, &agent_id, &session_id, turn_id, &outcome);
            let _ = reply.send(outcome.map_err(|detail| detail.message));
        });
    }
}
