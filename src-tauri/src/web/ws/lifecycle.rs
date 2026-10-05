//! Session lifecycle WS handlers: resume/promote/close/dispose-ephemeral,
//! `list_sessions`, and `register_discovered_session`.

use super::*;

/// Frozen replay contract 1 (story 3): history reconstruction belongs to
/// `get_session_payload` / `recover_session_snapshot`; `resume_session` NEVER
/// emits replay events or a replay snapshot. Inject the explicit
/// `"replaySnapshot": null` marker into the ok payload at the WS boundary so
/// clients get an unambiguous signal — the shared `SessionReopenOutcome`
/// struct itself stays untouched for story 3.
pub(super) fn resume_ok_payload(
    id: String,
    outcome: &crate::acp::manager::SessionReopenOutcome,
) -> WsReply {
    let mut value = serde_json::to_value(outcome).unwrap_or_else(|e| {
        warn!("[ws] failed to serialize resume_session outcome: {e}");
        json!({})
    });
    if let Some(obj) = value.as_object_mut() {
        obj.insert("replaySnapshot".to_string(), Value::Null);
    }
    WsReply::ok(id, Some(value))
}

/// `resume_session` → `AcpManager::resume_session(agent_id, session_id, cwd)`.
/// Reply payload = the camelCase reopen option snapshot + the explicit
/// `"replaySnapshot": null` marker (CAP-11; see [`resume_ok_payload`]).
pub(super) async fn handle_resume_session(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
    current_agent: &mut Option<crate::acp::AgentId>,
    current_session: &Arc<parking_lot::Mutex<Option<crate::acp::SessionId>>>,
    current_project: &Arc<parking_lot::Mutex<Option<String>>>,
) -> WsReply {
    let parsed: LoadResumeSessionPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed resume_session payload (want agentId, sessionId, cwd): {e}"),
            )
        }
    };
    // Clone the ids before the call moves `parsed.session_id` + `parsed.cwd`;
    // we still need the session id to track it for `switch_project`.
    let agent_id = parsed.agent_id.clone();
    let session_id = parsed.session_id.clone();
    match acp
        .resume_session(&agent_id, parsed.session_id, parsed.cwd, parsed.mcp_servers)
        .await
    {
        Ok(outcome) => {
            *current_agent = Some(agent_id);
            *current_session.lock() = Some(session_id);
            *current_project.lock() = None;
            resume_ok_payload(id, &outcome)
        }
        Err(e) => acp_err_to_reply(id, e),
    }
}

/// `close_session` → `AcpManager::close_session(agent_id, session_id)`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CloseSessionPayload {
    agent_id: crate::acp::AgentId,
    session_id: crate::acp::SessionId,
}

/// `promote_session` WS request payload (story 8). Mirrors
/// `close_session`'s `{agentId, sessionId}` shape.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PromoteSessionPayload {
    agent_id: crate::acp::AgentId,
    session_id: crate::acp::SessionId,
}

/// `promote_session` → `AcpManager::promote_session(agent_id, session_id)`.
/// Story 8 (ephemeral warm pool): promotes a backend-ephemeral warm-pool
/// session to durable — the driver registers the persistence metadata captured
/// at `session/new` and clears the ephemeral mark, so the first real prompt
/// persists. Idempotent for already-durable sessions; `not_found` for sessions
/// the driver never created.
pub(super) async fn handle_promote_session(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
) -> WsReply {
    let parsed: PromoteSessionPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(
                target: "termul::web::ws",
                error = %e,
                "promote_session: malformed payload"
            );
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed promote_session payload (want agentId, sessionId): {e}"),
            );
        }
    };
    let session_id = parsed.session_id.clone();
    match acp
        .promote_session(&parsed.agent_id, parsed.session_id)
        .await
    {
        Ok(()) => {
            tracing::info!(
                target: "termul::web::ws",
                agent_id = %parsed.agent_id,
                session_id = %session_id,
                "promote_session: warm-pool session promoted to durable"
            );
            WsReply::ok(id, Some(json!({})))
        }
        // An unknown session id is a lookup failure, not an unsupported call
        // (mirrors the `unknown agent` mapping in `acp_err_to_reply`).
        Err(e) if e.starts_with("unknown session") => {
            tracing::warn!(
                target: "termul::web::ws",
                agent_id = %parsed.agent_id,
                session_id = %session_id,
                error = %e,
                "promote_session: unknown session"
            );
            WsReply::err(id, WsErrorCode::NotFound, e)
        }
        Err(e) => {
            tracing::warn!(
                target: "termul::web::ws",
                agent_id = %parsed.agent_id,
                session_id = %session_id,
                error = %e,
                "promote_session: promotion failed"
            );
            acp_err_to_reply(id, e)
        }
    }
}

pub(super) async fn handle_dispose_ephemeral_session(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
    relay: &Arc<WsRelaySink>,
    subscribed_clients: &mut Vec<(String, ClientId)>,
    current_session: &Arc<parking_lot::Mutex<Option<SessionId>>>,
    current_project: &Arc<parking_lot::Mutex<Option<String>>>,
) -> WsReply {
    let parsed: CloseSessionPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!(
                    "malformed dispose_ephemeral_session payload (want agentId, sessionId): {e}"
                ),
            )
        }
    };
    let disposed_session_id = parsed.session_id.clone();
    match acp
        .dispose_ephemeral_session(&parsed.agent_id, parsed.session_id)
        .await
    {
        Ok(()) => {
            subscribed_clients.retain(|(session_id, client_id)| {
                if session_id == &disposed_session_id.0 {
                    relay.unsubscribe(session_id, *client_id);
                    false
                } else {
                    true
                }
            });
            if current_session.lock().as_ref() == Some(&disposed_session_id) {
                *current_session.lock() = None;
                *current_project.lock() = None;
            }
            relay.forget_session(&disposed_session_id.0).await;
            WsReply::ok(id, Some(json!({})))
        }
        Err(e) => acp_err_to_reply(id, e),
    }
}

pub(super) async fn handle_close_session(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
    current_session: &Arc<parking_lot::Mutex<Option<SessionId>>>,
    current_project: &Arc<parking_lot::Mutex<Option<String>>>,
) -> WsReply {
    let parsed: CloseSessionPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed close_session payload (want agentId, sessionId): {e}"),
            )
        }
    };
    let closing_session_id = parsed.session_id.clone();
    match acp.close_session(&parsed.agent_id, parsed.session_id).await {
        Ok(()) => {
            if current_session.lock().as_ref() == Some(&closing_session_id) {
                *current_session.lock() = None;
                *current_project.lock() = None;
            }
            WsReply::ok(id, Some(json!({})))
        }
        Err(e) => acp_err_to_reply(id, e),
    }
}

/// `list_sessions` → `AcpManager::list_sessions(agent_id, cwd?, cursor?)`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ListSessionsPayload {
    agent_id: crate::acp::AgentId,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    cursor: Option<String>,
}

pub(super) async fn handle_list_sessions(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
) -> WsReply {
    let parsed: ListSessionsPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed list_sessions payload (want agentId, cwd?, cursor?): {e}"),
            )
        }
    };
    match acp
        .list_sessions(&parsed.agent_id, parsed.cwd, parsed.cursor)
        .await
    {
        Ok(resp) => ok_with_payload(id, &resp),
        Err(e) => acp_err_to_reply(id, e),
    }
}

/// Persist metadata for an agent-owned session returned by `session/list`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RegisterDiscoveredSessionPayload {
    session_id: String,
    agent_id: crate::acp::AgentId,
    cwd: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    updated_at: Option<u64>,
    #[serde(default)]
    project_id: Option<String>,
}

pub(super) async fn handle_register_discovered_session(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
    relay: &Arc<WsRelaySink>,
) -> WsReply {
    let parsed: RegisterDiscoveredSessionPayload = match serde_json::from_value(payload.clone()) {
        Ok(parsed) => parsed,
        Err(error) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!(
                    "malformed register_discovered_session payload (want sessionId, agentId, cwd): {error}"
                ),
            )
        }
    };
    if parsed.session_id.trim().is_empty() || parsed.cwd.trim().is_empty() {
        return WsReply::err(
            id,
            WsErrorCode::Unsupported,
            "sessionId and cwd are required",
        );
    }
    let Some(persistence) = relay.persistence() else {
        return WsReply::err(
            id,
            WsErrorCode::Unsupported,
            "session persistence unavailable",
        );
    };
    let stable_agent_namespace = match acp.stable_agent_namespace(&parsed.agent_id) {
        Ok(namespace) => namespace,
        Err(error) => return acp_err_to_reply(id, error),
    };
    match persistence
        .register_discovered_session(
            crate::acp::SessionRegistration {
                session_id: parsed.session_id,
                stable_agent_namespace,
                runtime_agent_id: Some(parsed.agent_id.0),
                project_id: parsed.project_id,
                cwd: parsed.cwd.into(),
                ..Default::default()
            },
            parsed.title,
            parsed.updated_at,
        )
        .await
    {
        Ok(metadata) => {
            tracing::info!(
                target: "termul::web::ws",
                session_id = %metadata.session_id,
                "register_discovered_session: metadata promoted"
            );
            ok_with_payload(id, &crate::acp::SessionIndexEntry::from(&metadata))
        }
        Err(error) => {
            tracing::warn!(
                target: "termul::web::ws",
                error = %error,
                "register_discovered_session: persistence failed"
            );
            WsReply::err(
                id,
                WsErrorCode::Unsupported,
                "failed to persist discovered session metadata",
            )
        }
    }
}
