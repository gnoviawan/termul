//! Prompt WS handlers: `send_prompt` accept/complete with turn claims,
//! `cancel_prompt`, and session `set_mode`/`set_model`/`set_config_option`.

use super::*;

/// `send_prompt` → `AcpManager::send_prompt(agent_id, session_id, content)`.
/// Story 1.7 T7.1: the concurrent-turn rejection (`ACP_TURN_IN_PROGRESS`) maps
/// to `err.code: "rate_limited"` via `map_prompt_error_code`. Story 1.8 T3:
/// the client `turnId` is extracted + stashed for the `prompt_complete`
/// idempotent-by-turn-id dedup (see `TurnWatermark`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SendPromptPayload {
    agent_id: crate::acp::AgentId,
    session_id: crate::acp::SessionId,
    /// Text-mode prompt (mutually exclusive with `content`).
    #[serde(default)]
    text: Option<String>,
    /// Blocks-mode prompt (attachments + structured content).
    #[serde(default)]
    content: Option<Vec<agent_client_protocol::schema::v1::ContentBlock>>,
    /// Story 1.8 T3: client-generated turn id for `prompt_complete` dedup.
    /// Optional for forward-compat (older clients omit it; dedup is a no-op).
    #[serde(default)]
    turn_id: Option<String>,
    /// Display-side content persisted as the durable `user_prompt` record in
    /// place of `content`/`text` (spec-agent-switch-separator-redesign): the
    /// switch handoff wires `summary + --- + draft` to the agent but only the
    /// draft belongs in the replayed transcript. Absent → the wire content is
    /// persisted verbatim.
    #[serde(default)]
    display_content: Option<Vec<agent_client_protocol::schema::v1::ContentBlock>>,
}

pub(super) struct AcceptedSendPrompt {
    id: String,
    started: crate::acp::manager::StartedPrompt,
    claim: PromptClaim,
}

pub(super) struct PromptClaim {
    relay: Arc<WsRelaySink>,
    session_id: String,
    turn_id: Option<String>,
    armed: bool,
}

impl PromptClaim {
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
    fn drop(&mut self) {
        if self.armed {
            self.relay
                .turn_watermark()
                .release_claim(&self.session_id, self.turn_id.as_deref());
        }
    }
}

// clippy 1.98 (`result_large_err`): `WsReply` is ≥128 bytes — it carries the
// full reply envelope. It is the error currency of every WS handler here and
// is consumed immediately by the enclosing send path; boxing would add an
// allocation per WS reply and ripple through all call sites for no functional
// gain. Allowed pending a dedicated WsReply refactor.
#[allow(clippy::result_large_err)]
pub(super) async fn accept_send_prompt(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
    relay: &Arc<WsRelaySink>,
) -> Result<AcceptedSendPrompt, WsReply> {
    let parsed: SendPromptPayload = serde_json::from_value(payload.clone()).map_err(|error| {
        WsReply::err(
            id.clone(),
            WsErrorCode::Unsupported,
            format!("malformed send_prompt payload (want agentId, sessionId, text|content, turnId?): {error}"),
        )
    })?;
    let content = match (parsed.content, parsed.text) {
        (Some(blocks), _) if !blocks.is_empty() => blocks,
        (_, Some(text)) if !text.trim().is_empty() => {
            vec![agent_client_protocol::schema::v1::ContentBlock::Text(
                agent_client_protocol::schema::v1::TextContent::new(text),
            )]
        }
        _ => {
            return Err(WsReply::err(
                id,
                WsErrorCode::Unsupported,
                "send_prompt requires non-empty `text` or `content`",
            ))
        }
    };

    match acp
        .owns_session(&parsed.agent_id, parsed.session_id.clone())
        .await
    {
        Ok(true) => {}
        Ok(false) => {
            return Err(WsReply::err(
                id,
                WsErrorCode::NotFound,
                "session does not belong to the supplied live agent",
            ))
        }
        Err(error) => return Err(acp_err_to_reply(id, error)),
    }

    match relay
        .turn_watermark()
        .claim_turn(parsed.session_id.0.as_str(), parsed.turn_id.as_deref())
    {
        TurnClaim::Claimed => {}
        TurnClaim::Completed => {
            return Err(WsReply::err(
                id,
                WsErrorCode::Stale,
                "this turn already completed (stale turn-id)",
            ))
        }
        TurnClaim::DuplicateInFlight | TurnClaim::Busy => {
            return Err(WsReply::err(
                id,
                WsErrorCode::RateLimited,
                "a prompt turn is already in progress",
            ))
        }
    }
    let claim = PromptClaim {
        relay: Arc::clone(relay),
        session_id: parsed.session_id.0.clone(),
        turn_id: parsed.turn_id.clone(),
        armed: true,
    };

    let ephemeral = acp
        .is_ephemeral_session(&parsed.agent_id, parsed.session_id.clone())
        .await
        .map_err(|error| acp_err_to_reply(id.clone(), error))?;
    // Display-side override (spec-agent-switch-separator-redesign): the
    // durable `user_prompt` records the pending draft, not the wire framing
    // (handoff summary + `---`) when the caller supplies displayContent.
    // Empty display_content = no override (a zero-block record would replay
    // as a ghost row and hide the turn).
    let persisted_content = parsed
        .display_content
        .clone()
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| content.clone());
    let prompt_payload = json!({
        "agentId": parsed.agent_id.clone(),
        "sessionId": parsed.session_id.clone(),
        "turnId": parsed.turn_id.clone(),
        "content": persisted_content,
    });
    acp.ensure_prompt_blocks_supported(&parsed.agent_id, &content)
        .await
        .map_err(|error| acp_err_to_reply(id.clone(), error))?;
    if !ephemeral {
        relay
            .persist_user_prompt(parsed.session_id.0.as_str(), prompt_payload)
            .await
            .map_err(|error| {
                WsReply::err(
                    id.clone(),
                    WsErrorCode::NotImplemented,
                    format!("failed to persist accepted prompt: {error}"),
                )
            })?;
    }

    let started = acp
        .start_prompt(&parsed.agent_id, parsed.session_id, content, parsed.turn_id)
        .await
        .map_err(|error| acp_err_to_reply(id.clone(), error))?;
    Ok(AcceptedSendPrompt { id, started, claim })
}

pub(super) async fn complete_send_prompt(
    accepted: AcceptedSendPrompt,
    acp: &Arc<AcpManager>,
) -> WsReply {
    let AcceptedSendPrompt { id, started, claim } = accepted;
    match acp.wait_prompt(started).await {
        Ok(stop_reason) => {
            claim.complete();
            ok_with_payload(id, &stop_reason)
        }
        Err(error) => acp_err_to_reply(id, error),
    }
}

pub(super) async fn handle_send_prompt(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
    relay: &Arc<WsRelaySink>,
) -> WsReply {
    match accept_send_prompt(id, payload, acp, relay).await {
        Ok(accepted) => complete_send_prompt(accepted, acp).await,
        Err(reply) => reply,
    }
}

/// `cancel_prompt` → `AcpManager::cancel_prompt(agent_id, session_id)`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SessionOnlyPayload {
    agent_id: crate::acp::AgentId,
    session_id: crate::acp::SessionId,
}

pub(super) async fn handle_cancel_prompt(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
) -> WsReply {
    let parsed: SessionOnlyPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed cancel_prompt payload (want agentId, sessionId): {e}"),
            )
        }
    };
    match acp.cancel_prompt(&parsed.agent_id, parsed.session_id).await {
        Ok(()) => WsReply::ok(id, Some(json!({}))),
        Err(e) => acp_err_to_reply(id, e),
    }
}

/// `set_mode` → `AcpManager::set_mode(agent_id, session_id, mode_id)`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SetModePayload {
    agent_id: crate::acp::AgentId,
    session_id: crate::acp::SessionId,
    mode_id: String,
}

pub(super) async fn handle_set_mode(id: String, payload: &Value, acp: &Arc<AcpManager>) -> WsReply {
    let parsed: SetModePayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed set_mode payload (want agentId, sessionId, modeId): {e}"),
            )
        }
    };
    match acp
        .set_mode(&parsed.agent_id, parsed.session_id, parsed.mode_id)
        .await
    {
        Ok(()) => WsReply::ok(id, Some(json!({}))),
        Err(e) => acp_err_to_reply(id, e),
    }
}

/// `set_model` → `AcpManager::set_model(agent_id, session_id, model_id)`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SetModelPayload {
    agent_id: crate::acp::AgentId,
    session_id: crate::acp::SessionId,
    model_id: String,
}

pub(super) async fn handle_set_model(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
) -> WsReply {
    let parsed: SetModelPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed set_model payload (want agentId, sessionId, modelId): {e}"),
            )
        }
    };
    match acp
        .set_model(&parsed.agent_id, parsed.session_id, parsed.model_id)
        .await
    {
        Ok(()) => WsReply::ok(id, Some(json!({}))),
        Err(e) => acp_err_to_reply(id, e),
    }
}

/// `set_config_option` → `AcpManager::set_config_option(agent_id, session_id,
/// config_id, value_id)`. Reply payload = the updated `Vec<SessionConfigOption>`
/// (the desktop path also emits `acp:config_options_update` automatically).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SetConfigOptionPayload {
    agent_id: crate::acp::AgentId,
    session_id: crate::acp::SessionId,
    config_id: String,
    value_id: String,
}

pub(super) async fn handle_set_config_option(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
) -> WsReply {
    let parsed: SetConfigOptionPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => return WsReply::err(id, WsErrorCode::Unsupported, format!("malformed set_config_option payload (want agentId, sessionId, configId, valueId): {e}")),
    };
    match acp
        .set_config_option(
            &parsed.agent_id,
            parsed.session_id,
            parsed.config_id,
            parsed.value_id,
        )
        .await
    {
        Ok(options) => ok_with_payload(id, &options),
        Err(e) => acp_err_to_reply(id, e),
    }
}
