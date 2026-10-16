//! Helpers for `close_session`: a close during a running turn cancels the
//! turn, waits for its terminator, and only then closes the session, so a
//! closing session ends with exactly one `prompt_complete` followed by
//! `session_closed`.

use super::*;

/// How long a close waits for the cancelled turn to reach its terminator.
const TURN_TERMINATOR_WAIT: Duration = Duration::from_millis(5_250);

/// Await the turn terminator registered through `DriverState::wait_turn_idle`
/// (`None` means the session had no running turn). Errors on timeout or when
/// the waiter is dropped; the caller then forces local cleanup.
pub(super) async fn await_turn_terminator(
    waiter: Option<oneshot::Receiver<()>>,
) -> Result<(), String> {
    let Some(waiter) = waiter else {
        return Ok(());
    };
    match tokio::time::timeout(TURN_TERMINATOR_WAIT, waiter).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(_)) => Err("turn idle waiter was dropped".to_string()),
        Err(_) => Err(format!(
            "session close timed out waiting for the cancelled turn after {TURN_TERMINATOR_WAIT:?}"
        )),
    }
}

/// Forget a closing session locally: drop its workspace root and marks, finish
/// any turn bookkeeping, resolve its pending permissions, questions and
/// elicitations as cancelled, and evict its host-plan registration. Returns
/// whether the session was ephemeral (captured before the marks clear).
pub(super) fn close_session_locally(
    state: &Mutex<DriverState>,
    plan_server: &crate::acp::host_mcp::parent::HostPlanServer,
    session_id: &str,
) -> bool {
    let (was_ephemeral, pending) = state.lock().begin_close_session(session_id);
    for permission in pending {
        let _ = permission.responder.respond(RequestPermissionResponse::new(
            RequestPermissionOutcome::Cancelled,
        ));
    }
    let questions = state.lock().finish_turn_questions(session_id);
    for question in questions {
        let _ = question.responder.respond(serde_json::json!({
            "questionId": question.question_id,
            "cancelled": true,
        }));
    }
    let elicitations = state.lock().finish_turn_elicitations(session_id);
    for elicitation in elicitations {
        cancel_elicitation(elicitation);
    }
    plan_server.unregister_session(session_id);
    was_ephemeral
}

/// Tell every sink the session was closed on request.
pub(super) fn announce_session_closed(
    sinks: &[Arc<dyn EventSink>],
    agent_id: &AgentId,
    session_id: &SessionId,
) {
    let event = SessionClosedEvent {
        agent_id: agent_id.clone(),
        session_id: session_id.clone(),
        reason: AgentExitReason::Closed,
    };
    events::fan_out(
        sinks,
        Some(session_id.0.as_str()),
        events::EVENT_SESSION_CLOSED,
        &event,
    );
}
