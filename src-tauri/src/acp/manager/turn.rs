//! Prompt-turn terminators and the accept hook shared by the real command
//! loop, the driver teardown and the in-crate test agents.
//!
//! Every accepted turn ends with exactly one session-scoped
//! `acp:prompt_complete` (AD-5): an ACP stop reason from the agent, or a host
//! terminator (`error`, `timeout`, `crashed`). The driver-side active-turn
//! marker (`DriverState::active_turns`) is the exactly-once guard: whoever
//! removes the marker owns the terminator.

use super::*;

/// One-shot hook the command loop runs on the driver thread the moment it
/// ACCEPTS a prompt (`try_begin_turn` succeeded) and before the turn task is
/// spawned. Carrier code uses it to sequence + fan out the durable
/// `user_prompt` so it can never be delivered after a chunk of its own turn.
/// A prompt the driver rejects never runs its hook.
pub(crate) type PromptAcceptHook = Box<dyn FnOnce() + Send + 'static>;

/// Fan out the session-scoped `prompt_complete` terminator for a turn.
pub(super) fn emit_turn_terminator(
    sinks: &[Arc<dyn EventSink>],
    agent_id: &AgentId,
    session_id: &SessionId,
    turn_id: Option<String>,
    stop_reason: events::PromptStopReason,
) {
    let event = PromptCompleteEvent {
        agent_id: agent_id.clone(),
        session_id: session_id.clone(),
        stop_reason,
        turn_id,
    };
    events::fan_out(
        sinks,
        Some(event.session_id.0.as_str()),
        events::EVENT_PROMPT_COMPLETE,
        &event,
    );
}

/// Fan out the events that close a turn the agent ran to an outcome: for an
/// `Err` the `acp:agent_error` first (unchanged, so the renderer still
/// reports the failure), then the session-scoped terminator — the ACP stop
/// reason, or `timeout` (typed [`events::AcpErrorDetail::timed_out`] marker)
/// / `error`.
pub(super) fn emit_turn_outcome(
    sinks: &[Arc<dyn EventSink>],
    agent_id: &AgentId,
    session_id: &SessionId,
    turn_id: Option<String>,
    outcome: &Result<StopReason, events::AcpErrorDetail>,
) {
    let stop_reason = match outcome {
        Ok(stop_reason) => events::PromptStopReason::from(*stop_reason),
        Err(detail) => {
            let event = detail
                .clone()
                .into_agent_error(agent_id.clone(), Some(session_id.clone()));
            events::fan_out(
                sinks,
                Some(session_id.0.as_str()),
                events::EVENT_AGENT_ERROR,
                &event,
            );
            detail.turn_stop().into()
        }
    };
    emit_turn_terminator(sinks, agent_id, session_id, turn_id, stop_reason);
}

/// A turn whose reply failed because the agent transport closed while the
/// process is shutting down is owned by the `interrupted` marker
/// (`SessionPersistence::shutdown` scans for the unterminated turn), exactly
/// like the driver teardown: appending a `crashed` terminator here would
/// close the turn and hide that marker. Every other outcome keeps its
/// terminator.
pub(super) fn outcome_owned_by_process_shutdown(
    persistence: Option<&Arc<SessionPersistence>>,
    outcome: &Result<StopReason, events::AcpErrorDetail>,
) -> bool {
    matches!(outcome, Err(detail) if detail.connection_closed)
        && persistence.is_some_and(|persistence| persistence.is_process_shutdown())
}

/// Connection teardown: the SDK drops the command loop and every spawned turn
/// task when the connection closes, so a turn that was still active never
/// reached its own terminator. Drain the active-turn markers and append a
/// `crashed` terminator for each (before the writers are finalized). Returns
/// the number of terminators emitted.
pub(super) fn emit_crash_terminators(
    state: &Mutex<DriverState>,
    sinks: &[Arc<dyn EventSink>],
    agent_id: &AgentId,
) -> usize {
    let active = state.lock().drain_active_turns();
    for (session, turn_id) in &active {
        log::warn!(
            "[acp] session {} turn ended by agent connection close: terminator=crashed",
            crate::logging::redact_session_id(session)
        );
        emit_turn_terminator(
            sinks,
            agent_id,
            &SessionId::new(session.clone()),
            turn_id.clone(),
            events::TurnFailureStop::Crashed.into(),
        );
    }
    active.len()
}
