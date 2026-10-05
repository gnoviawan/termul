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
}

/// Wire `subscribe` → [`WsRelaySink::subscribe`] + forward replay/live to this connection.
pub(super) async fn handle_subscribe(
    id: String,
    payload: &Value,
    relay: &Arc<WsRelaySink>,
    out_tx: &mpsc::UnboundedSender<Outbound>,
    subscribed_clients: &mut Vec<(String, ClientId)>,
) -> WsReply {
    let parsed: SubscribePayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed subscribe payload (want sessionId, lastSeq): {e}"),
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
    let prior_clients: Vec<ClientId> = subscribed_clients
        .iter()
        .filter(|(sid, _)| sid == &parsed.session_id)
        .map(|(_, client_id)| *client_id)
        .collect();

    let (client_id, mut rx, replay) = relay.subscribe(&parsed.session_id, parsed.last_seq).await;
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
                "cursor is older than the event log; request an atomic session snapshot",
            )
        }
        ReplayResult::Ok(replayed) => {
            subscribed_clients.retain(|(sid, cid)| {
                if sid == &parsed.session_id && prior_clients.contains(cid) {
                    relay.unsubscribe(sid, *cid);
                    false
                } else {
                    true
                }
            });
            subscribed_clients.push((parsed.session_id.clone(), client_id));
            if let Some(rendezvous) = relay.rendezvous() {
                rendezvous.cancel_disconnect_grace(&parsed.session_id);
            }
            if let Some(question_rendezvous) = relay.question_rendezvous() {
                question_rendezvous.cancel_disconnect_grace(&parsed.session_id);
            }
            let forward_tx = out_tx.clone();
            tokio::spawn(async move {
                while let Some(evt) = rx.recv().await {
                    if forward_tx.send(Outbound::Event(evt)).is_err() {
                        break;
                    }
                }
            });
            WsReply::ok(
                id,
                Some(json!({
                    "sessionId": parsed.session_id,
                    "replayed": replayed,
                })),
            )
        }
    }
}

/// CamelCase `respond_permission` payload (Story 1.7) — mirrors the client
/// `acp-transport.ts: respondPermission(agentId, requestId, optionId?)`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RespondPermissionPayload {
    agent_id: crate::acp::AgentId,
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
/// Requires a server-side rendezvous attached to the relay (`relay.rendezvous()`).
/// On the desktop path (no rendezvous) the browser never reaches this handler
/// — the desktop uses the `acp_respond_permission` Tauri command directly.
pub(super) async fn handle_respond_permission(
    id: String,
    payload: &Value,
    relay: &Arc<WsRelaySink>,
    subscribed_clients: &[(String, ClientId)],
) -> WsReply {
    let Some(rdz) = relay.rendezvous() else {
        return WsReply::err(
            id,
            WsErrorCode::NotImplemented,
            "permission rendezvous is not attached (desktop path uses the Tauri command)",
        );
    };

    let parsed: RespondPermissionPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed respond_permission payload (want agentId, requestId, optionId?): {e}"),
            );
        }
    };
    if parsed.request_id.is_empty() {
        return WsReply::err(id, WsErrorCode::Unsupported, "requestId is required");
    }

    // Defense in depth: the payload's `agentId` must match the ticket's agent
    // (a client cannot resolve another agent's permission).
    let Some(ticket_agent) = rdz.agent_for_request(&parsed.request_id) else {
        return WsReply::err(
            id,
            WsErrorCode::Stale,
            "no outstanding permission for this requestId",
        );
    };
    if ticket_agent != parsed.agent_id {
        return WsReply::err(
            id,
            WsErrorCode::PermissionDenied,
            "agentId does not match the permission's agent",
        );
    }

    // Resolve the calling connection's `ClientId` for this permission's session
    // (a connection may be subscribed to several sessions; the permission belongs
    // to one). Ownership check: the connection MUST be subscribed to the
    // permission's session (NFR5 — no cross-session permission resolution).
    let Some(session_id) = rdz.session_for_request(&parsed.request_id) else {
        return WsReply::err(
            id,
            WsErrorCode::Stale,
            "no outstanding permission for this requestId",
        );
    };
    let Some((_, client_id)) = subscribed_clients
        .iter()
        .find(|(sid, _)| *sid == session_id)
    else {
        return WsReply::err(
            id,
            WsErrorCode::NotFound,
            "this connection is not subscribed to the permission's session",
        );
    };
    let client_id = *client_id;

    let option_id = parsed.option_id.as_deref();
    match rdz
        .try_respond(client_id, &parsed.request_id, option_id)
        .await
    {
        Ok(crate::web::permissions::RespondOutcome::Resolved) => WsReply::ok(id, Some(json!({}))),
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
                    WsErrorCode::Stale,
                    "this permission was already resolved by another client (first-response-wins)",
                ),
                crate::web::permissions::RespondError::Duplicate => (
                    WsErrorCode::Duplicate,
                    "this client already responded to this permission",
                ),
                crate::web::permissions::RespondError::InvalidOption => (
                    WsErrorCode::PermissionDenied,
                    "optionId is not among the original permission options (TOCTOU defense)",
                ),
                crate::web::permissions::RespondError::NotSubscribed => (
                    WsErrorCode::NotFound,
                    "not subscribed to the permission's session",
                ),
            };
            WsReply::err(id, code, msg)
        }
        // `RespondOutcome` has only `Resolved` after the enum consolidation; the
        // other arms are unreachable. Keep a fallthrough for future variants.
        #[allow(unreachable_patterns)]
        _ => WsReply::err(
            id,
            WsErrorCode::NotImplemented,
            "unexpected permission rendezvous outcome",
        ),
    }
}

/// CamelCase `answer_question` payload (issue #411) — mirrors the client
/// `acp-transport.ts: answerQuestion(agentId, questionId, values?)`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AnswerQuestionPayload {
    agent_id: crate::acp::AgentId,
    question_id: String,
    /// `None` / omitted → cancel; `Some(values)` → selected option values.
    #[serde(default)]
    values: Option<Vec<String>>,
}

/// Wire `answer_question` → [`crate::web::permissions::QuestionRendezvous`]
/// (first-response-wins, TOCTOU re-validation) → `AcpManager::answer_question`
/// (resolves the agent `Responder` on the driver thread). Maps the rendezvous
/// outcome/error to a stable `err.code` (mirrors `handle_respond_permission`).
///
/// Requires a server-side question rendezvous attached to the relay
/// (`relay.question_rendezvous()`). On the desktop path (no rendezvous) the
/// browser never reaches this handler — the desktop uses the `acp_answer_question`
/// Tauri command directly.
pub(super) async fn handle_answer_question(
    id: String,
    payload: &Value,
    relay: &Arc<WsRelaySink>,
    subscribed_clients: &[(String, ClientId)],
) -> WsReply {
    let Some(rdz) = relay.question_rendezvous() else {
        return WsReply::err(
            id,
            WsErrorCode::NotImplemented,
            "question rendezvous is not attached (desktop path uses the Tauri command)",
        );
    };

    let parsed: AnswerQuestionPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!(
                    "malformed answer_question payload (want agentId, questionId, values?): {e}"
                ),
            );
        }
    };
    if parsed.question_id.is_empty() {
        return WsReply::err(id, WsErrorCode::Unsupported, "questionId is required");
    }

    // Defense in depth: the payload's `agentId` must match the ticket's agent.
    let Some(ticket_agent) = rdz.agent_for_question(&parsed.question_id) else {
        return WsReply::err(
            id,
            WsErrorCode::Stale,
            "no outstanding question for this questionId",
        );
    };
    if ticket_agent != parsed.agent_id {
        return WsReply::err(
            id,
            WsErrorCode::PermissionDenied,
            "agentId does not match the question's agent",
        );
    }

    // Ownership check: the connection MUST be subscribed to the question's
    // session (NFR5 — no cross-session question resolution).
    let Some(session_id) = rdz.session_for_question(&parsed.question_id) else {
        return WsReply::err(
            id,
            WsErrorCode::Stale,
            "no outstanding question for this questionId",
        );
    };
    let Some((_, client_id)) = subscribed_clients
        .iter()
        .find(|(sid, _)| *sid == session_id)
    else {
        return WsReply::err(
            id,
            WsErrorCode::NotFound,
            "this connection is not subscribed to the question's session",
        );
    };
    let client_id = *client_id;

    let values = parsed.values.as_deref();
    match rdz
        .try_respond(client_id, &parsed.question_id, values)
        .await
    {
        Ok(crate::web::permissions::QuestionRespondOutcome::Resolved) => {
            WsReply::ok(id, Some(json!({})))
        }
        Err(err) => {
            let (code, msg) = match err {
                crate::web::permissions::QuestionRespondError::NotFound => (
                    WsErrorCode::Stale,
                    "no outstanding question for this questionId",
                ),
                crate::web::permissions::QuestionRespondError::AlreadyResolved => (
                    WsErrorCode::Stale,
                    "this question was already answered by another client (first-response-wins)",
                ),
                crate::web::permissions::QuestionRespondError::Duplicate => (
                    WsErrorCode::Duplicate,
                    "this client already answered this question",
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
