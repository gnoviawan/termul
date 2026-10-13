//! Project WS handlers: `create_session`/`load_session`, project CRUD and the
//! host default.

use super::*;
use crate::web::project_registry::{
    set_default_project, AddProject, ProjectCommandError, ProjectHost, UpdateProject,
};

/// `create_session` → `AcpManager::new_session(agent_id, cwd, mcp_servers)`.
/// Reply payload = the `NewSessionOutcome` (camelCase: sessionId/modes/models/configOptions).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CreateSessionPayload {
    agent_id: crate::acp::AgentId,
    cwd: String,
    #[serde(default)]
    mcp_servers: Vec<agent_client_protocol::schema::v1::McpServer>,
    #[serde(default)]
    ephemeral: bool,
    /// Story 8: an ephemeral session the client may later promote to durable
    /// (`promote_session`) — keeps the host plan-MCP injection it would
    /// otherwise skip. Ignored for non-ephemeral creates; unknown to older
    /// servers (additive).
    #[serde(default)]
    promotable: bool,
    #[serde(default)]
    additional_directories: Vec<String>,
    /// Owning project. Optional: omitted → the host matches `cwd` against the
    /// registry, else stamps the unassigned sentinel. Stamped once at creation.
    #[serde(default)]
    project_id: Option<String>,
}

/// The project id a new session is stamped with: the explicit registered id,
/// else the registry project owning `cwd`, else [`crate::acp::session_persistence::UNASSIGNED_PROJECT_ID`].
/// An explicit id the registry does not know is `Err(id)` (→ `not_found`).
pub(super) fn resolve_session_project(
    registry: &ProjectRegistry,
    explicit: Option<&str>,
    cwd: &str,
) -> Result<String, String> {
    match explicit.map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) if registry.contains(id) => Ok(id.to_string()),
        Some(id) => Err(id.to_string()),
        None => Ok(registry
            .find_by_path(cwd)
            .unwrap_or_else(|| crate::acp::session_persistence::UNASSIGNED_PROJECT_ID.to_string())),
    }
}

pub(super) async fn handle_create_session(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
    registry: &Arc<ProjectRegistry>,
    command_id: Option<String>,
) -> WsReply {
    let parsed: CreateSessionPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed create_session payload (want agentId, cwd, mcpServers?): {e}"),
            )
        }
    };
    // Story 1.8 review (EC4): reject an empty cwd (the desktop store path
    // trims + rejects `cwd.length === 0`; the WS path must not diverge — an
    // empty cwd would give the agent subprocess undefined cwd semantics).
    if parsed.cwd.trim().is_empty() {
        return WsReply::err(
            id,
            WsErrorCode::Unsupported,
            "create_session requires a non-empty `cwd`",
        );
    }
    // The host stamps the owning project once, here: explicit registered id,
    // else the registry project owning `cwd`, else the unassigned sentinel.
    let project_id =
        match resolve_session_project(registry, parsed.project_id.as_deref(), &parsed.cwd) {
            Ok(project_id) => project_id,
            Err(unknown) => {
                warn!(
                    target: "termul::web::ws",
                    project_id = %unknown,
                    "create_session: unknown projectId"
                );
                return WsReply::err(
                    id,
                    WsErrorCode::NotFound,
                    format!("project '{unknown}' not found"),
                );
            }
        };
    // A project being removed or archived takes no new sessions.
    if registry.is_removing(&project_id) {
        warn!(
            target: "termul::web::ws",
            project_id = %project_id,
            "create_session: project is being removed"
        );
        return WsReply::err(
            id,
            WsErrorCode::ProjectBusy,
            format!("project '{project_id}' is being removed or archived"),
        );
    }
    match acp
        .new_session_with_context(
            &parsed.agent_id,
            parsed.cwd,
            parsed.mcp_servers,
            SessionCreationContext {
                project_id: Some(project_id),
                ephemeral: parsed.ephemeral,
                promotable: parsed.promotable,
                additional_directories: parsed.additional_directories,
                command_id,
                ..Default::default()
            },
        )
        .await
    {
        Ok(outcome) => ok_with_payload(id, &outcome),
        Err(e) => acp_err_to_reply(id, e),
    }
}

/// `set_default_project` WS request payload. Changes the host's default
/// project.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SetDefaultProjectPayload {
    project_id: String,
}

/// `add_project` WS request payload (Option B). Mirrors the
/// `POST /projects` body + the desktop `addProject` renderer store action.
/// `id` is client-minted; a repeat with the same id and path is ok.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AddProjectPayload {
    id: String,
    name: String,
    path: String,
    color: String,
    #[serde(default)]
    is_archived: bool,
}

/// `update_project` WS request payload (Option B). All fields optional (partial
/// update). Mirrors `PUT /projects/{id}`. `cascade` lets an archive stop the
/// project's live sessions and terminals instead of being refused
/// `project_busy`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct UpdateProjectPayload {
    project_id: String,
    name: Option<String>,
    color: Option<String>,
    is_archived: Option<bool>,
    #[serde(default)]
    cascade: bool,
}

/// `remove_project` WS request payload (Option B). Mirrors
/// `DELETE /projects/{id}`. `cascade` stops the project's live sessions and
/// terminals instead of refusing `project_busy`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RemoveProjectPayload {
    project_id: String,
    #[serde(default)]
    cascade: bool,
}

/// The command service over this connection's host pieces.
fn project_host(env: &HandlerEnv) -> ProjectHost<'_> {
    ProjectHost {
        registry: &env.registry,
        acp: &env.acp,
        pty: &env.pty,
        relay: &env.relay,
    }
}

/// A refused project command as a failing reply (`project_busy` carries the
/// bound entity list in `err.details`).
fn project_error_reply(id: String, error: &ProjectCommandError) -> WsReply {
    match error.details() {
        Some(details) => {
            WsReply::err_with_details(id, error.ws_code(), error.message(), details)
        }
        None => WsReply::err(id, error.ws_code(), error.message()),
    }
}

/// `set_default_project` WS handler — the explicit host-default change.
/// Unknown/archived/pathless targets reply `not_found`.
pub(super) async fn handle_set_default_project(
    id: String,
    payload: &Value,
    env: &HandlerEnv,
) -> WsReply {
    let parsed: SetDefaultProjectPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            warn!(
                target: "termul::web::ws",
                error = e.to_string(),
                "set_default_project: malformed payload (want projectId)"
            );
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed set_default_project payload (want projectId): {e}"),
            );
        }
    };
    match set_default_project(&env.registry, &env.relay, &parsed.project_id) {
        Ok(()) => WsReply::ok(id, Some(json!({}))),
        Err(error) => project_error_reply(id, &error),
    }
}

/// `add_project` WS handler — register a project (idempotent by id).
pub(super) async fn handle_add_project(id: String, payload: &Value, env: &HandlerEnv) -> WsReply {
    let parsed: AddProjectPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            warn!(
                target: "termul::web::ws",
                error = e.to_string(),
                "add_project: malformed payload (want id + name + path + color)"
            );
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed add_project payload: {e}"),
            );
        }
    };
    let added = project_host(env)
        .add(AddProject {
            id: parsed.id,
            name: parsed.name,
            path: parsed.path,
            color: parsed.color,
            is_archived: parsed.is_archived,
        })
        .await;
    match added {
        Ok(project) => WsReply::ok(id, Some(json!({ "project": project }))),
        Err(error) => project_error_reply(id, &error),
    }
}

/// `update_project` WS handler — patch a project's display fields; archive and
/// restore go through `isArchived` (archiving a busy project honors `cascade`).
pub(super) async fn handle_update_project(
    id: String,
    payload: &Value,
    env: &HandlerEnv,
) -> WsReply {
    let parsed: UpdateProjectPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            warn!(
                target: "termul::web::ws",
                error = e.to_string(),
                "update_project: malformed payload (want projectId)"
            );
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed update_project payload: {e}"),
            );
        }
    };
    let updated = project_host(env)
        .update(UpdateProject {
            project_id: parsed.project_id,
            name: parsed.name,
            color: parsed.color,
            is_archived: parsed.is_archived,
            cascade: parsed.cascade,
        })
        .await;
    match updated {
        Ok(()) => WsReply::ok(id, Some(json!({}))),
        Err(error) => project_error_reply(id, &error),
    }
}

/// `remove_project` WS handler — remove a project (an absent id is ok; a busy
/// project is refused `project_busy` unless `cascade` stops its entities).
pub(super) async fn handle_remove_project(
    id: String,
    payload: &Value,
    env: &HandlerEnv,
) -> WsReply {
    let parsed: RemoveProjectPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            warn!(
                target: "termul::web::ws",
                error = e.to_string(),
                "remove_project: malformed payload (want projectId)"
            );
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed remove_project payload: {e}"),
            );
        }
    };
    match project_host(env)
        .remove(&parsed.project_id, parsed.cascade)
        .await
    {
        Ok(()) => WsReply::ok(id, Some(json!({}))),
        Err(error) => project_error_reply(id, &error),
    }
}

/// `load_session` → `AcpManager::load_session(agent_id, session_id, cwd)`.
/// Reply payload = the camelCase reopen option snapshot.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LoadResumeSessionPayload {
    pub(super) agent_id: crate::acp::AgentId,
    pub(super) session_id: crate::acp::SessionId,
    pub(super) cwd: String,
    #[serde(default)]
    pub(super) additional_directories: Vec<String>,
}

pub(super) async fn handle_load_session(
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
                format!("malformed load_session payload (want agentId, sessionId, cwd): {e}"),
            )
        }
    };
    match acp
        .load_session(
            &parsed.agent_id,
            parsed.session_id,
            parsed.cwd,
            parsed.additional_directories,
        )
        .await
    {
        Ok(outcome) => ok_with_payload(id, &outcome),
        Err(e) => acp_err_to_reply(id, e),
    }
}
