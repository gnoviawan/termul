//! Shared `send_prompt` turn service for BOTH carriers: the `/ws`
//! `send_prompt` handler and the desktop `acp_send_prompt` command.
//!
//! Flow: ownership check → turn claim (`TurnWatermark`, by client `turnId`) →
//! driver start with a one-shot on-accept hook that sequences + fans out the
//! durable `user_prompt` on the driver thread → durable flush → wait for the
//! stop reason. A resend of the same `turnId` never errors:
//!
//! | claim              | reply                            |
//! |--------------------|----------------------------------|
//! | already in flight  | `{"receipt":"in_progress"}`      |
//! | already completed  | `{"receipt":"accepted"}`         |
//! | other turn running | [`PromptTurnError::Busy`] (rate-limited) |
//!
//! "Completed" includes a turn that ended in error, timeout or crash: the
//! host recorded exactly one terminator for it, so a resend is `accepted`.
//! Turnless callers (desktop/older clients) skip the dedupe and keep the
//! pre-receipt behaviour. Logs carry session context only — never prompt
//! content.

use std::sync::Arc;

use agent_client_protocol::schema::v1::{ContentBlock, StopReason};
use serde::Serialize;
use serde_json::json;
use tokio::sync::oneshot;
use tracing::{debug, warn};

use crate::acp::manager::{PromptAcceptHook, StartedPrompt};
use crate::acp::{AcpManager, AgentId, SessionId};
use crate::web::permissions::TurnClaim;
use crate::web::WsRelaySink;

/// Receipt for a resend of an already-seen `turnId`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReceiptKind {
    /// The same turn is still running on the host.
    InProgress,
    /// The same turn already finished (any terminator).
    Accepted,
}

/// `{"receipt": "in_progress" | "accepted"}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct PromptReceipt {
    pub receipt: ReceiptKind,
}

/// Reply payload of `send_prompt`: the stop reason (turn ran on this call) or
/// a receipt (same `turnId` already seen). Untagged, so the stop-reason shape
/// is unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum PromptReply {
    Stop(StopReason),
    Receipt(PromptReceipt),
}

impl PromptReply {
    fn receipt(kind: ReceiptKind) -> Self {
        Self::Receipt(PromptReceipt { receipt: kind })
    }
}

/// Why a prompt was not accepted.
#[derive(Debug)]
pub enum PromptTurnError {
    /// The session does not belong to the supplied live agent.
    NotOwned,
    /// A different turn is running for this session.
    Busy { session_id: String },
    /// The driver/manager rejected or failed the prompt (carries the manager
    /// error string, e.g. `ACP_TURN_IN_PROGRESS: …` or an RPC failure).
    Failed(String),
}

impl PromptTurnError {
    /// Plain-string form for the Tauri command boundary. `Busy` uses the
    /// stable `ACP_TURN_IN_PROGRESS` code the renderer queues on.
    #[must_use]
    pub fn into_message(self) -> String {
        match self {
            Self::NotOwned => "session does not belong to the supplied live agent".to_string(),
            Self::Busy { session_id } => format!("ACP_TURN_IN_PROGRESS: session {session_id}"),
            Self::Failed(message) => message,
        }
    }
}

/// One `send_prompt` request, already parsed by the carrier.
pub struct PromptTurnRequest {
    pub agent_id: AgentId,
    pub session_id: SessionId,
    /// Blocks sent to the agent.
    pub content: Vec<ContentBlock>,
    /// Blocks persisted in the durable `user_prompt` (the display-side
    /// override, or `content` when there is none).
    pub record_content: Vec<ContentBlock>,
    /// Client turn id (`None` for callers that omit it: no dedupe).
    pub turn_id: Option<String>,
}

/// Holds the session turn claim while the prompt runs.
pub struct PromptClaim {
    relay: Arc<WsRelaySink>,
    session_id: String,
    turn_id: Option<String>,
    armed: bool,
}

impl PromptClaim {
    /// Terminal outcome after acceptance (ok, error, timeout, crash): record
    /// the turn as completed so a resend gets `accepted`, and release.
    fn complete(mut self) {
        if let Some(turn_id) = self.turn_id.as_deref() {
            self.relay
                .turn_watermark()
                .record_completed(&self.session_id, turn_id);
        } else {
            self.relay
                .turn_watermark()
                .release_claim(&self.session_id, None);
        }
        self.armed = false;
    }
}

impl Drop for PromptClaim {
    /// A prompt that never reached acceptance only releases the claim.
    fn drop(&mut self) {
        if self.armed {
            self.relay
                .turn_watermark()
                .release_claim(&self.session_id, self.turn_id.as_deref());
        }
    }
}

/// A prompt the driver accepted and is running.
pub struct RunningPrompt {
    started: StartedPrompt,
    claim: PromptClaim,
}

pub enum PromptAdmission {
    Running(RunningPrompt),
    Receipt(PromptReply),
}

/// Claim the turn and start the prompt on the driver. Returns once the driver
/// accepted it AND the accepted `user_prompt` is durable (a flush failure is
/// logged and does not unwind the accepted turn).
pub async fn accept_prompt_turn(
    acp: &Arc<AcpManager>,
    relay: &Arc<WsRelaySink>,
    request: PromptTurnRequest,
) -> Result<PromptAdmission, PromptTurnError> {
    let PromptTurnRequest {
        agent_id,
        session_id,
        content,
        record_content,
        turn_id,
    } = request;

    match acp.owns_session(&agent_id, session_id.clone()).await {
        Ok(true) => {}
        Ok(false) => return Err(PromptTurnError::NotOwned),
        Err(error) => return Err(PromptTurnError::Failed(error)),
    }

    match relay
        .turn_watermark()
        .claim_turn(session_id.0.as_str(), turn_id.as_deref())
    {
        TurnClaim::Claimed => {}
        // A same-turn resend is only meaningful when the client named the
        // turn; a turnless duplicate is just another prompt while busy.
        TurnClaim::DuplicateInFlight if turn_id.is_some() => {
            debug!(
                "[prompt] resend of in-flight turn acknowledged (session {})",
                crate::logging::redact_session_id(&session_id.0)
            );
            return Ok(PromptAdmission::Receipt(PromptReply::receipt(
                ReceiptKind::InProgress,
            )));
        }
        TurnClaim::Completed => {
            debug!(
                "[prompt] resend of completed turn acknowledged (session {})",
                crate::logging::redact_session_id(&session_id.0)
            );
            return Ok(PromptAdmission::Receipt(PromptReply::receipt(
                ReceiptKind::Accepted,
            )));
        }
        TurnClaim::DuplicateInFlight | TurnClaim::Busy => {
            return Err(PromptTurnError::Busy {
                session_id: session_id.0,
            });
        }
    }
    let claim = PromptClaim {
        relay: Arc::clone(relay),
        session_id: session_id.0.clone(),
        turn_id: turn_id.clone(),
        armed: true,
    };

    let ephemeral = acp
        .is_ephemeral_session(&agent_id, session_id.clone())
        .await
        .map_err(PromptTurnError::Failed)?;

    // Durable `user_prompt`: sequenced + fanned out on the driver thread the
    // moment the driver accepts (never before, never after a chunk of its
    // turn). Ephemeral sessions have no durable history, so no record.
    let on_accept: Option<PromptAcceptHook> = (!ephemeral).then(|| {
        let payload = json!({
            "agentId": agent_id.clone(),
            "sessionId": session_id.clone(),
            "turnId": turn_id.clone(),
            "content": record_content,
        });
        let relay = Arc::clone(relay);
        let sid = session_id.0.clone();
        Box::new(move || {
            relay.record_user_prompt(&sid, payload);
        }) as PromptAcceptHook
    });

    let started = acp
        .start_prompt(&agent_id, session_id.clone(), content, turn_id, on_accept)
        .await
        .map_err(PromptTurnError::Failed)?;

    let running = RunningPrompt { started, claim };
    if ephemeral {
        return Ok(PromptAdmission::Running(running));
    }

    // Everything after driver acceptance is non-cancellable: the driver
    // already runs the turn, so a carrier that drops this future (peer gone,
    // read task aborted) must not release the claim of a running turn. The
    // flush therefore runs in a detached task that owns the claim; when the
    // caller is gone the task itself drives the turn to its terminal outcome,
    // so the claim is recorded/released exactly once and a same-`turnId`
    // resend sees `in_progress` until then.
    let (accepted_tx, accepted_rx) = oneshot::channel();
    let acp = Arc::clone(acp);
    let relay = Arc::clone(relay);
    tokio::spawn(async move {
        if let Err(error) = relay.flush_prompt_record(&session_id.0).await {
            // The record was sequenced and enqueued, so the flush failure
            // must not unwind the accepted turn.
            warn!(
                "[prompt] failed to flush accepted user_prompt for session {}: {error}",
                crate::logging::redact_session_id(&session_id.0)
            );
        }
        if let Err(running) = accepted_tx.send(running) {
            let _ = complete_prompt_turn(&acp, running).await;
        }
    });
    match accepted_rx.await {
        Ok(running) => Ok(PromptAdmission::Running(running)),
        Err(_) => Err(PromptTurnError::Failed(
            "prompt acceptance task ended unexpectedly".to_string(),
        )),
    }
}

/// Wait for the accepted turn and release its claim on ANY terminal outcome
/// (stop reason, RPC error, timeout, crash).
pub async fn complete_prompt_turn(
    acp: &Arc<AcpManager>,
    running: RunningPrompt,
) -> Result<StopReason, String> {
    let RunningPrompt { started, claim } = running;
    let result = acp.wait_prompt(started).await;
    claim.complete();
    result
}

/// Accept + wait in one call (the desktop command shape).
pub async fn run_prompt_turn(
    acp: &Arc<AcpManager>,
    relay: &Arc<WsRelaySink>,
    request: PromptTurnRequest,
) -> Result<PromptReply, PromptTurnError> {
    match accept_prompt_turn(acp, relay, request).await? {
        PromptAdmission::Receipt(reply) => Ok(reply),
        PromptAdmission::Running(running) => complete_prompt_turn(acp, running)
            .await
            .map(PromptReply::Stop)
            .map_err(PromptTurnError::Failed),
    }
}
