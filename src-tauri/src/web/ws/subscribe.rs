//! `subscribe` wiring + permission/question rendezvous WS handlers
//! (`respond_permission`, `answer_question`).

use super::*;

/// CamelCase subscribe payload (Story 1.6) — envelope snake_case, payload camelCase.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SubscribePayload {
    session_id: String,
    /// Cursor: `None` / omitted → live-only (no replay). `Some(n)` → replay from `n + 1`.
    /// Note: `Some(0)` is still a cursor and can be [`ReplayResult::Stale`] after ring eviction.
    #[serde(default)]
    last_seq: Option<u64>,
    /// The log epoch `last_seq` was issued under (from an earlier subscribe,
    /// snapshot or cursor reply). A different epoch — or a cursor ahead of the
    /// log's head — is answered `stale` without registering.
    #[serde(default)]
    log_epoch: Option<String>,
}

/// Forward a subscription's stream into the connection's outbound queue until
/// the subscription or the connection ends. Reliable: an item waits for room
/// (the connection closes if the peer stays full), it is never dropped.
pub(super) fn spawn_event_forwarder(mut stream: EventStream, out_tx: OutboundSender) {
    tokio::spawn(async move {
        while let Some(item) = stream.recv().await {
            let frame = match item {
                StreamItem::Event(event) => Outbound::Event(event),
                StreamItem::Gap(sid) => Outbound::Gap(sid),
            };
            if out_tx.enqueue(frame).await != EnqueueOutcome::Enqueued {
                break;
            }
        }
    });
}

/// Wire `subscribe` → [`WsRelaySink::subscribe`] + forward replay/live to this connection.
pub(super) async fn handle_subscribe(
    id: String,
    payload: &Value,
    relay: &Arc<WsRelaySink>,
    out_tx: &OutboundSender,
    subscribed_clients: &Subscriptions,
) -> WsReply {
    let parsed: SubscribePayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed subscribe payload (want sessionId, lastSeq?, logEpoch?): {e}"),
            );
        }
    };
    if parsed.session_id.is_empty() {
        return WsReply::err(id, WsErrorCode::Unsupported, "sessionId is required");
    }

    // Story 7: subscribe is a READ path. The session must already be known —
    // live in the relay map (events emitted, incl. ephemeral never-persisted
    // sessions) or present in the persistence catalog (finalized sessions
    // replay from disk). Unknown ids get `not_found` (parity with
    // `get_session_payload`) instead of a silent `{replayed: 0}` success.
    // `WsRelaySink::subscribe` performs the existence validation and the
    // subscription registration under the SAME `sessions` lock
    // `forget_session` removes under, so a concurrently removed session
    // cannot slip a subscription through the check→register gap (TOCTOU) —
    // both the live-only and cursor paths surface `ReplayResult::NotFound`.
    // The durable writer is deliberately NOT reinstalled here or in the sink:
    // `reopen_writer` flips the persisted status Closed→Active, bumps
    // `last_activity_at`, and rewrites the on-disk index — that mutation
    // belongs to the manager's `session/load` / `session/resume` paths (flip
    // on resume/prompt only, never on reads).

    // Do not drop the currently-live subscription until the replacement is
    // successfully registered. This preserves pending-permission ownership on
    // stale/failure and lets grace cancellation happen only after resubscribe.
    let prior_clients = subscribed_clients.clients_for(&parsed.session_id);

    let (client_id, stream, replay, head) = relay
        .subscribe(
            &parsed.session_id,
            parsed.last_seq,
            parsed.log_epoch.as_deref(),
            out_tx.closing(),
        )
        .await;
    match replay {
        ReplayResult::NotFound => {
            // Durable failure record for the desktop log sink (ws.rs runs on
            // both transports; only `log` lands in the desktop file sink).
            // Structured, no credentials, no ACP error text; the session id
            // is redacted per `logging::redact_session_id`.
            log::warn!(
                "[ws] subscribe failed failure=not_found session_id={}",
                crate::logging::redact_session_id(&parsed.session_id)
            );
            WsReply::err(id, WsErrorCode::NotFound, "session not found")
        }
        ReplayResult::Stale => {
            relay.unregister_client(client_id);
            WsReply::err(
                id,
                WsErrorCode::Stale,
                "cursor does not belong to the event log; request an atomic session snapshot",
            )
        }
        ReplayResult::Ok(replayed) => {
            for prior in subscribed_clients.replace(&parsed.session_id, &prior_clients, client_id) {
                relay.unsubscribe(&parsed.session_id, prior);
            }
            spawn_event_forwarder(stream, out_tx.clone());
            let mut reply = json!({
                "sessionId": parsed.session_id,
                "replayed": replayed,
            });
            // Registration returns the head on every `Ok`.
            if let Some(head) = head {
                reply["logEpoch"] = json!(head.log_epoch);
                reply["headSeq"] = json!(head.head_seq);
            }
            WsReply::ok(id, Some(reply))
        }
    }
}

/// CamelCase `respond_permission` payload (Story 1.7) — mirrors the client
/// `acp-transport.ts: respondPermission(agentId, requestId, optionId?)`.
/// The ticket (`requestId`) alone identifies the permission; `agentId` is
/// optional and, when present, must match the ticket's agent.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RespondPermissionPayload {
    #[serde(default)]
    agent_id: Option<crate::acp::AgentId>,
    request_id: String,
    /// `None` / omitted → cancel/deny (`RequestPermissionOutcome::Cancelled`).
    #[serde(default)]
    option_id: Option<String>,
}

/// Wire `respond_permission` → [`crate::web::permissions::PermissionRendezvous`]
/// (first-response-wins, TOCTOU re-validation, at-most-one) →
/// `AcpManager::respond_permission` (resolves the agent `Responder` on the
/// driver thread). Maps the rendezvous outcome/error to a stable `err.code`.
///
/// Answers are keyed by the ticket (`requestId`) alone: the calling
/// connection need not be subscribed to the permission's session (a fresh
/// socket after a reconnect can answer a pending approval), and `agentId` is
/// optional. First-wins is attributed to the CONNECTION (`client_id`), and a
/// later answer to a resolved ticket gets `already_resolved`. The write
/// capability is enforced before dispatch (`forbidden_reply`).
///
/// Requires a server-side rendezvous attached to the relay (`relay.rendezvous()`).
/// Without a rendezvous the request is refused (`not_implemented`).
pub(super) async fn handle_respond_permission(
    id: String,
    payload: &Value,
    relay: &Arc<WsRelaySink>,
    client_id: ClientId,
) -> WsReply {
    let Some(rdz) = relay.rendezvous() else {
        return WsReply::err(
            id,
            WsErrorCode::NotImplemented,
            "permission rendezvous is not attached",
        );
    };

    let parsed: RespondPermissionPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed respond_permission payload (want requestId, optionId?, agentId?): {e}"),
            );
        }
    };
    if parsed.request_id.is_empty() {
        return WsReply::err(id, WsErrorCode::Unsupported, "requestId is required");
    }

    // Defense in depth: a payload `agentId`, when sent, must match the
    // ticket's agent (a client cannot resolve another agent's permission).
    if let (Some(claimed), Some(ticket_agent)) = (
        parsed.agent_id.as_ref(),
        rdz.agent_for_request(&parsed.request_id),
    ) {
        if *claimed != ticket_agent {
            return WsReply::err(
                id,
                WsErrorCode::PermissionDenied,
                "agentId does not match the permission's agent",
            );
        }
    }

    let option_id = parsed.option_id.as_deref();
    match rdz
        .try_respond(client_id, &parsed.request_id, option_id)
        .await
    {
        Ok(crate::web::permissions::RespondOutcome::Resolved) => {
            info!(
                target: "termul::web::ws",
                request_id = %id,
                "permission resolved by ticket"
            );
            WsReply::ok(id, Some(json!({})))
        }
        Err(err) => {
            // Map each rendezvous rejection to its stable `err.code` (mirrors
            // `RespondError::wire_code`, but goes through `WsErrorCode` so the
            // enum + TS const stay the single source of truth).
            let (code, msg) = match err {
                crate::web::permissions::RespondError::NotFound => (
                    WsErrorCode::Stale,
                    "no outstanding permission for this requestId",
                ),
                crate::web::permissions::RespondError::AlreadyResolved => (
                    WsErrorCode::AlreadyResolved,
                    "this permission was already resolved (first-response-wins)",
                ),
                crate::web::permissions::RespondError::Duplicate => (
                    WsErrorCode::Duplicate,
                    "this connection already responded to this permission",
                ),
                crate::web::permissions::RespondError::InvalidOption => (
                    WsErrorCode::PermissionDenied,
                    "optionId is not among the original permission options (TOCTOU defense)",
                ),
            };
            WsReply::err(id, code, msg)
        }
    }
}

/// CamelCase `answer_question` payload (issue #411) — mirrors the client
/// `acp-transport.ts: answerQuestion(agentId, questionId, values?)`.
/// `agentId` is optional and, when present, must match the ticket's agent.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AnswerQuestionPayload {
    #[serde(default)]
    agent_id: Option<crate::acp::AgentId>,
    question_id: String,
    /// `None` / omitted → cancel; `Some(values)` → selected option values.
    #[serde(default)]
    values: Option<Vec<String>>,
}

/// Wire `answer_question` → [`crate::web::permissions::QuestionRendezvous`]
/// (first-response-wins, TOCTOU re-validation) → `AcpManager::answer_question`
/// (resolves the agent `Responder` on the driver thread). Maps the rendezvous
/// outcome/error to a stable `err.code` (mirrors `handle_respond_permission`:
/// ticket-only, no subscription requirement, per-connection first-wins,
/// `already_resolved` for a later answer).
///
/// Requires a server-side question rendezvous attached to the relay
/// (`relay.question_rendezvous()`). Without a rendezvous the request is refused
/// (`not_implemented`).
pub(super) async fn handle_answer_question(
    id: String,
    payload: &Value,
    relay: &Arc<WsRelaySink>,
    client_id: ClientId,
) -> WsReply {
    let Some(rdz) = relay.question_rendezvous() else {
        return WsReply::err(
            id,
            WsErrorCode::NotImplemented,
            "question rendezvous is not attached",
        );
    };

    let parsed: AnswerQuestionPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!(
                    "malformed answer_question payload (want questionId, values?, agentId?): {e}"
                ),
            );
        }
    };
    if parsed.question_id.is_empty() {
        return WsReply::err(id, WsErrorCode::Unsupported, "questionId is required");
    }

    // Defense in depth: a payload `agentId`, when sent, must match the
    // ticket's agent.
    if let (Some(claimed), Some(ticket_agent)) = (
        parsed.agent_id.as_ref(),
        rdz.agent_for_question(&parsed.question_id),
    ) {
        if *claimed != ticket_agent {
            return WsReply::err(
                id,
                WsErrorCode::PermissionDenied,
                "agentId does not match the question's agent",
            );
        }
    }

    let values = parsed.values.as_deref();
    match rdz
        .try_respond(client_id, &parsed.question_id, values)
        .await
    {
        Ok(crate::web::permissions::QuestionRespondOutcome::Resolved) => {
            info!(
                target: "termul::web::ws",
                request_id = %id,
                "question resolved by ticket"
            );
            WsReply::ok(id, Some(json!({})))
        }
        Err(err) => {
            let (code, msg) = match err {
                crate::web::permissions::QuestionRespondError::NotFound => (
                    WsErrorCode::Stale,
                    "no outstanding question for this questionId",
                ),
                crate::web::permissions::QuestionRespondError::AlreadyResolved => (
                    WsErrorCode::AlreadyResolved,
                    "this question was already answered (first-response-wins)",
                ),
                crate::web::permissions::QuestionRespondError::Duplicate => (
                    WsErrorCode::Duplicate,
                    "this connection already answered this question",
                ),
                crate::web::permissions::QuestionRespondError::InvalidOption => (
                    WsErrorCode::PermissionDenied,
                    "a value is not among the original question options (TOCTOU defense)",
                ),
            };
            WsReply::err(id, code, msg)
        }
    }
}
