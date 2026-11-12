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

/// `resume_session` → `AcpManager::resume_session(agent_id, session_id, cwd, additional_directories)`.
/// Reply payload = the camelCase reopen option snapshot + the explicit
/// `"replaySnapshot": null` marker (CAP-11; see [`resume_ok_payload`]).
pub(super) async fn handle_resume_session(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
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
    match acp
        .resume_session(
            &parsed.agent_id,
            parsed.session_id,
            parsed.cwd,
            parsed.additional_directories,
            parsed.mcp_servers,
        )
        .await
    {
        Ok(outcome) => resume_ok_payload(id, &outcome),
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
    subscribed_clients: &Subscriptions,
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
    let result = acp
        .dispose_ephemeral_session(&parsed.agent_id, parsed.session_id)
        .await;
    match result {
        Ok(()) => {
            for client_id in subscribed_clients.remove_session(&disposed_session_id.0) {
                relay.unsubscribe(&disposed_session_id.0, client_id);
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
    let result = acp.close_session(&parsed.agent_id, parsed.session_id).await;
    match result {
        Ok(()) => WsReply::ok(id, Some(json!({}))),
        Err(e) => acp_err_to_reply(id, e),
    }
}

/// Folder `list_sessions` asks the agent to list.
///
/// Desktop IPC (`Carrier::Ipc`) keeps the client cwd. A remote `/ws` client
/// (including a view-only peer; `list_sessions` is a read) cannot pick an
/// arbitrary folder. A supplied cwd is canonicalized (it must exist and be a directory; `..`
/// and symlinks cannot walk out) and is then checked with a component-wise
/// `Path::starts_with` against a similarly canonicalized project root.
/// Verbatim `\\?\` prefixes are stripped on both sides first so a Windows
/// prefix mismatch cannot pass or fail the check by itself. With `projectId`,
/// the cwd must sit inside that project. Without `projectId`, a cwd inside
/// any registered project is accepted. If cwd is omitted, the host uses the
/// named project or the host default.
pub(super) fn resolve_list_sessions_cwd(
    carrier: crate::web::capabilities::Carrier,
    registry: &crate::web::project_registry::ProjectRegistry,
    project_id: Option<&str>,
    client_cwd: Option<&str>,
) -> Result<Option<String>, String> {
    if carrier == crate::web::capabilities::Carrier::Ipc {
        return Ok(client_cwd.map(str::to_string));
    }

    let cwd = client_cwd.map(str::trim).filter(|value| !value.is_empty());
    let explicit_id = project_id.map(str::trim).filter(|value| !value.is_empty());

    if let Some(id) = explicit_id {
        let ctx = registry
            .switch_context(id)
            .ok_or_else(|| format!("project '{id}' not found"))?;
        return listing_cwd_for_project(registry, &ctx.project_id, &ctx.cwd, cwd);
    }

    if let Some(cwd) = cwd {
        let resolved = canonicalize_list_cwd(cwd)?;
        if !cwd_is_inside_any_registered_root(registry, &resolved) {
            return Err("list_sessions cwd must be a registered project folder".to_string());
        }
        return Ok(Some(listing_path_string(&resolved)));
    }

    let default_id = registry
        .snapshot()
        .default_project_id
        .ok_or_else(|| "list_sessions needs an active project folder".to_string())?;
    let ctx = registry
        .switch_context(&default_id)
        .ok_or_else(|| "list_sessions needs an active project folder".to_string())?;
    Ok(Some(ctx.cwd))
}

fn listing_cwd_for_project(
    registry: &crate::web::project_registry::ProjectRegistry,
    project_id: &str,
    project_cwd: &str,
    client_cwd: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(cwd) = client_cwd else {
        return Ok(Some(project_cwd.to_string()));
    };
    let resolved = canonicalize_list_cwd(cwd)?;
    let root = registry
        .canonical_root(project_id)
        .ok_or_else(|| "list_sessions cwd must be the active project folder".to_string())?;
    if !cwd_is_inside_root(&resolved, &root) {
        return Err("list_sessions cwd must be the active project folder".to_string());
    }
    Ok(Some(listing_path_string(&resolved)))
}

fn cwd_is_inside_any_registered_root(
    registry: &crate::web::project_registry::ProjectRegistry,
    resolved: &std::path::Path,
) -> bool {
    registry.snapshot().projects.iter().any(|project| {
        registry
            .canonical_root(&project.id)
            .is_some_and(|root| cwd_is_inside_root(resolved, &root))
    })
}

/// Component-wise containment after both sides are canonicalized and any
/// Windows verbatim prefix is stripped. Do not compare raw strings: a
/// prefix check on `"<root>\\..\\.."` would incorrectly succeed.
fn cwd_is_inside_root(resolved: &std::path::Path, root: &std::path::Path) -> bool {
    listing_path_buf(resolved).starts_with(listing_path_buf(root))
}

fn canonicalize_list_cwd(cwd: &str) -> Result<std::path::PathBuf, String> {
    let refused =
        || "list_sessions cwd must be an existing folder inside a registered project".to_string();
    let resolved = std::fs::canonicalize(cwd).map_err(|_| refused())?;
    let metadata = std::fs::metadata(&resolved).map_err(|_| refused())?;
    if !metadata.is_dir() {
        return Err(refused());
    }
    Ok(resolved)
}

fn listing_path_buf(path: &std::path::Path) -> std::path::PathBuf {
    std::path::PathBuf::from(listing_path_string(path))
}

fn listing_path_string(path: &std::path::Path) -> String {
    crate::path_validation::strip_verbatim_prefix(&path.to_string_lossy()).into_owned()
}

/// `list_sessions` → `AcpManager::list_sessions` with a host-resolved cwd
/// on the `/ws` carrier (see [`resolve_list_sessions_cwd`]).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ListSessionsPayload {
    agent_id: crate::acp::AgentId,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    project_id: Option<String>,
}

pub(super) async fn handle_list_sessions(id: String, payload: &Value, env: &HandlerEnv) -> WsReply {
    let parsed: ListSessionsPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!(
                    "malformed list_sessions payload (want agentId, projectId?, cwd?, cursor?): {e}"
                ),
            )
        }
    };
    let cwd = match resolve_list_sessions_cwd(
        env.carrier,
        &env.registry,
        parsed.project_id.as_deref(),
        parsed.cwd.as_deref(),
    ) {
        Ok(cwd) => cwd,
        Err(message) => {
            let code = if message.contains("not found") {
                WsErrorCode::NotFound
            } else {
                WsErrorCode::Unsupported
            };
            return WsReply::err(id, code, message);
        }
    };
    match env
        .acp
        .list_sessions(&parsed.agent_id, cwd, parsed.cursor)
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
