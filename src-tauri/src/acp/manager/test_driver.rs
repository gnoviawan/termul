//! In-crate fake agent driver for prompt-flow tests. It reproduces the real
//! command loop's `SendPrompt` behaviour instead of answering "always OK":
//! the real [`DriverState`] single-flight (`ACP_TURN_IN_PROGRESS` rejection,
//! which leaves the accept hook unrun), the accept hook before anything of the
//! turn is emitted, and the real terminator helpers from `turn.rs`.

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
    /// The turn runs until `release` fires (`end_turn`) or the prompt is
    /// cancelled (`cancelled`); `entered` fires when the turn is accepted.
    Hold {
        release: oneshot::Receiver<()>,
        entered: oneshot::Sender<()>,
    },
}

pub(crate) struct FakeDriver {
    sinks: Vec<Arc<dyn EventSink>>,
    agent_id: AgentId,
    state: Arc<Mutex<DriverState>>,
    turns: Mutex<VecDeque<FakeTurn>>,
    emit_chunk: bool,
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
        }
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
        if let Some(hook) = on_accept {
            hook();
        }
        let _ = accepted.send(Ok(()));
        if self.emit_chunk {
            let event = events::MessageChunkEvent {
                agent_id: self.agent_id.clone(),
                session_id: session_id.clone(),
                role: events::ChunkRole::Agent,
                content: ContentBlock::Text(agent_client_protocol::schema::v1::TextContent::new(
                    "chunk",
                )),
                message_id: None,
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
