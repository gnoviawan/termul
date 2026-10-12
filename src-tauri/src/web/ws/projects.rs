//! Project WS handlers: `create_session`/`load_session`, project CRUD and the
//! host default.

use super::*;

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

/// `set_default_project` WS handler — the explicit host-default change.
///
/// Validates the target (unknown/archived/pathless → `NOT_FOUND`), updates
/// `registry.set_default_project`, persists to `FileProjectRegistry` (VPS only,
/// with rollback on failure), and broadcasts `projects_changed` carrying the
/// new `defaultProjectId` to ALL connected clients. Desktop-hosted mode has
/// no `FileProjectRegistry` (`registry_persistence`/`projects_file` are
/// `None`) — it updates the in-memory registry + broadcasts only. The
/// `remote_sync_projects` desktop push is the other path that changes the
/// default (the desktop user IS the host operator).
///
/// # Error code mapping (P9)
///
/// The WS protocol's fixed `WsErrorCode` enum has no dedicated
/// "persistence failed" variant (the 11 stable codes are mirrored in TS).
/// Malformed payloads use `Unsupported` (matching the other project handlers); a
/// persistence failure also maps to `Unsupported` but with a distinct
/// message ("failed to persist default project: ..."). The HTTP route
/// (`POST /projects/default`) uses the free-form `IpcBody.code` string
/// `PERSIST_FAILED` for the same condition — the codes differ by transport
/// but the messages are unambiguous.
#[allow(clippy::too_many_arguments)]
pub(super) async fn handle_set_default_project(
    id: String,
    payload: &Value,
    relay: &Arc<WsRelaySink>,
    registry: &Arc<ProjectRegistry>,
    registry_persistence: Option<&Arc<parking_lot::Mutex<FileProjectRegistry>>>,
    projects_file: Option<&PathBuf>,
) -> WsReply {
    let parsed: SetDefaultProjectPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            warn!(
                target: "termul::web::ws",
                error = %e,
                "set_default_project: malformed payload (want projectId)"
            );
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed set_default_project payload (want projectId): {e}"),
            );
        }
    };
    // Validate via the in-memory registry (unknown/archived/pathless → NOT_FOUND).
    // `switch_context` re-checks the same conditions.
    if registry.switch_context(&parsed.project_id).is_none() {
        warn!(
            target: "termul::web::ws",
            project_id = %parsed.project_id,
            "set_default_project: project not found or not switchable"
        );
        return WsReply::err(
            id,
            WsErrorCode::NotFound,
            format!(
                "project '{}' not found or not switchable",
                parsed.project_id
            ),
        );
    }
    // VPS persistence (with rollback). Desktop-hosted mode skips this (no file
    // registry). The old default is captured so the in-memory-set failure path
    // below can roll the file back (P1: no split-brain — if
    // `registry.set_default_project` returns false after the file was already
    // persisted, the file is restored + re-saved before returning the error).
    let mut persisted_old_default: Option<Option<String>> = None;
    if let (Some(file_registry), Some(path)) = (registry_persistence, projects_file) {
        let persistence_result = {
            let mut file_registry = file_registry.lock();
            let old_default = file_registry.default_project_id().map(str::to_string);
            match file_registry.set_default_project(&parsed.project_id) {
                Ok(()) => match file_registry.save_atomic(path) {
                    Ok(()) => {
                        persisted_old_default = Some(old_default);
                        Ok(())
                    }
                    Err(error) => {
                        file_registry.restore_default_project(old_default);
                        Err(error)
                    }
                },
                Err(error) => Err(error),
            }
        };
        if let Err(error) = persistence_result {
            error!(
                target: "termul::web::ws",
                project_id = %parsed.project_id,
                error = %error,
                "set_default_project: persistence failed (rolled back)"
            );
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("failed to persist default project: {error}"),
            );
        }
    }
    // Update the in-memory registry default + broadcast to all clients.
    // If the in-memory set fails (target vanished between validation and
    // commit), roll back the file registry (P1: no split-brain).
    if !registry.set_default_project(&parsed.project_id) {
        if let (Some(file_registry), Some(path), Some(old_default)) =
            (registry_persistence, projects_file, persisted_old_default)
        {
            let mut file_registry = file_registry.lock();
            file_registry.restore_default_project(old_default);
            if let Err(error) = file_registry.save_atomic(path) {
                warn!(
                    target: "termul::web::ws",
                    error = %error,
                    "set_default_project: failed to persist in-memory-set rollback"
                );
            }
        }
        warn!(
            target: "termul::web::ws",
            project_id = %parsed.project_id,
            "set_default_project: target became unavailable before commit (file rolled back)"
        );
        return WsReply::err(
            id,
            WsErrorCode::NotFound,
            "target project became unavailable before commit",
        );
    }
    broadcast_projects_changed(relay, Some(&parsed.project_id));
    info!(
        target: "termul::web::ws",
        project_id = %parsed.project_id,
        "set_default_project: host default updated + broadcast"
    );
    WsReply::ok(id, Some(json!({})))
}

/// `add_project` WS request payload (Option B). Mirrors the
/// `POST /projects` body + the desktop `addProject` renderer store action.
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
/// update). Mirrors `PUT /projects/{id}`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct UpdateProjectPayload {
    project_id: String,
    name: Option<String>,
    color: Option<String>,
    is_archived: Option<bool>,
}

/// `remove_project` WS request payload (Option B). Mirrors
/// `DELETE /projects/{id}`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RemoveProjectPayload {
    project_id: String,
}

/// `add_project` WS handler — create / upsert a VFS root (Option B).
///
/// Validates + canonicalizes the path, upserts into `FileProjectRegistry`
/// (VPS, with rollback) + the in-memory `ProjectRegistry`, and broadcasts
/// `projects_changed`. Desktop-hosted mode has no file registry — it upserts
/// the in-memory mirror + broadcasts only.
#[allow(clippy::too_many_arguments)]
pub(super) async fn handle_add_project(
    id: String,
    payload: &Value,
    relay: &Arc<WsRelaySink>,
    registry: &Arc<ProjectRegistry>,
    registry_persistence: Option<&Arc<parking_lot::Mutex<FileProjectRegistry>>>,
    projects_file: Option<&PathBuf>,
) -> WsReply {
    let parsed: AddProjectPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            warn!(
                target: "termul::web::ws",
                error = %e,
                "add_project: malformed payload (want id + name + path + color)"
            );
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed add_project payload: {e}"),
            );
        }
    };
    if parsed.id == crate::acp::session_persistence::UNASSIGNED_PROJECT_ID {
        warn!(
            target: "termul::web::ws",
            "add_project: reserved project id refused"
        );
        return WsReply::err(
            id,
            WsErrorCode::Unsupported,
            format!(
                "project id '{}' is reserved",
                crate::acp::session_persistence::UNASSIGNED_PROJECT_ID
            ),
        );
    }
    let mut root = crate::acp::VfsRoot {
        id: parsed.id.clone(),
        name: parsed.name.clone(),
        path: std::path::PathBuf::from(parsed.path.clone()),
        color: parsed.color.clone(),
        is_archived: parsed.is_archived,
        mcp_servers: Vec::new(),
    };
    // VPS persistence (with rollback). Desktop-hosted mode skips this.
    if let (Some(file_registry), Some(path)) = (registry_persistence, projects_file) {
        let persistence_result = {
            let mut file_registry = file_registry.lock();
            let old_root = file_registry
                .roots()
                .iter()
                .find(|r| r.id == parsed.id)
                .cloned();
            // F-020: an upsert that re-registers a project must not wipe its
            // file-side MCP config — carry the existing root's mcp_servers.
            if let Some(old) = &old_root {
                root.mcp_servers = old.mcp_servers.clone();
            }
            match file_registry.upsert_root(root.clone()) {
                Ok(()) => match file_registry.save_atomic(path) {
                    Ok(()) => Ok(old_root),
                    Err(error) => {
                        if let Some(old) = old_root {
                            let _ = file_registry.upsert_root(old);
                        } else {
                            let _ = file_registry.remove_root(&parsed.id);
                        }
                        Err(error)
                    }
                },
                Err(error) => Err(error),
            }
        };
        if let Err(error) = persistence_result {
            error!(
                target: "termul::web::ws",
                project_id = %parsed.id,
                error = %error,
                "add_project: persistence failed (rolled back)"
            );
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("failed to persist project: {error}"),
            );
        }
    }
    // Mirror into the in-memory registry. F-020: `is_default` reflects the
    // CURRENT default (an upsert of the default keeps its flag; an archived
    // default is cleared by `upsert` itself — P4). `upsert` recomputes the
    // flag internally regardless of what is passed here.
    let summary = crate::web::project_registry::ProjectSummary {
        id: parsed.id.clone(),
        name: parsed.name,
        color: parsed.color,
        path: Some(parsed.path),
        is_archived: parsed.is_archived,
        is_default: !parsed.is_archived
            && registry.snapshot().default_project_id.as_deref() == Some(parsed.id.as_str()),
    };
    registry.upsert(summary.clone());
    broadcast_projects_changed(relay, None);
    info!(
        target: "termul::web::ws",
        project_id = %summary.id,
        "add_project: project upserted + broadcast"
    );
    WsReply::ok(id, Some(json!({ "project": summary })))
}

/// `update_project` WS handler — patch a project's display fields (Option B).
#[allow(clippy::too_many_arguments)]
pub(super) async fn handle_update_project(
    id: String,
    payload: &Value,
    relay: &Arc<WsRelaySink>,
    registry: &Arc<ProjectRegistry>,
    registry_persistence: Option<&Arc<parking_lot::Mutex<FileProjectRegistry>>>,
    projects_file: Option<&PathBuf>,
) -> WsReply {
    let parsed: UpdateProjectPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            warn!(
                target: "termul::web::ws",
                error = %e,
                "update_project: malformed payload (want projectId)"
            );
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed update_project payload: {e}"),
            );
        }
    };
    // VPS persistence (with rollback).
    if let (Some(file_registry), Some(path)) = (registry_persistence, projects_file) {
        let persistence_result = {
            let mut file_registry = file_registry.lock();
            let old_root = file_registry
                .roots()
                .iter()
                .find(|r| r.id == parsed.project_id)
                .cloned();
            if !file_registry.update_root(
                &parsed.project_id,
                parsed.name.clone(),
                parsed.color.clone(),
                parsed.is_archived,
            ) {
                None
            } else {
                match file_registry.save_atomic(path) {
                    Ok(()) => Some(Ok(old_root)),
                    Err(error) => {
                        if let Some(old) = old_root {
                            let _ = file_registry.upsert_root(old);
                        }
                        Some(Err(error))
                    }
                }
            }
        };
        match persistence_result {
            None => {
                warn!(
                    target: "termul::web::ws",
                    project_id = %parsed.project_id,
                    "update_project: project not found"
                );
                return WsReply::err(
                    id,
                    WsErrorCode::NotFound,
                    format!("project '{}' not found", parsed.project_id),
                );
            }
            Some(Err(error)) => {
                error!(
                    target: "termul::web::ws",
                    project_id = %parsed.project_id,
                    error = %error,
                    "update_project: persistence failed (rolled back)"
                );
                return WsReply::err(
                    id,
                    WsErrorCode::Unsupported,
                    format!("failed to persist project: {error}"),
                );
            }
            Some(_) => {}
        }
    }
    // Mirror into the in-memory registry.
    if !registry.update(
        &parsed.project_id,
        parsed.name,
        parsed.color,
        parsed.is_archived,
    ) {
        warn!(
            target: "termul::web::ws",
            project_id = %parsed.project_id,
            "update_project: project not found in in-memory registry"
        );
        return WsReply::err(
            id,
            WsErrorCode::NotFound,
            format!("project '{}' not found", parsed.project_id),
        );
    }
    broadcast_projects_changed(relay, None);
    info!(
        target: "termul::web::ws",
        project_id = %parsed.project_id,
        "update_project: project updated + broadcast"
    );
    WsReply::ok(id, Some(json!({})))
}

/// `remove_project` WS handler — remove a VFS root (Option B).
#[allow(clippy::too_many_arguments)]
pub(super) async fn handle_remove_project(
    id: String,
    payload: &Value,
    relay: &Arc<WsRelaySink>,
    registry: &Arc<ProjectRegistry>,
    registry_persistence: Option<&Arc<parking_lot::Mutex<FileProjectRegistry>>>,
    projects_file: Option<&PathBuf>,
) -> WsReply {
    let parsed: RemoveProjectPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            warn!(
                target: "termul::web::ws",
                error = %e,
                "remove_project: malformed payload (want projectId)"
            );
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed remove_project payload: {e}"),
            );
        }
    };
    // VPS persistence (with rollback).
    if let (Some(file_registry), Some(path)) = (registry_persistence, projects_file) {
        let persistence_result = {
            let mut file_registry = file_registry.lock();
            let old_root = file_registry
                .roots()
                .iter()
                .find(|r| r.id == parsed.project_id)
                .cloned();
            if !file_registry.remove_root(&parsed.project_id) {
                None
            } else {
                match file_registry.save_atomic(path) {
                    Ok(()) => Some(Ok(old_root)),
                    Err(error) => {
                        if let Some(old) = old_root {
                            let _ = file_registry.upsert_root(old);
                        }
                        Some(Err(error))
                    }
                }
            }
        };
        match persistence_result {
            None => {
                warn!(
                    target: "termul::web::ws",
                    project_id = %parsed.project_id,
                    "remove_project: project not found"
                );
                return WsReply::err(
                    id,
                    WsErrorCode::NotFound,
                    format!("project '{}' not found", parsed.project_id),
                );
            }
            Some(Err(error)) => {
                error!(
                    target: "termul::web::ws",
                    project_id = %parsed.project_id,
                    error = %error,
                    "remove_project: persistence failed (rolled back)"
                );
                return WsReply::err(
                    id,
                    WsErrorCode::Unsupported,
                    format!("failed to persist project removal: {error}"),
                );
            }
            Some(_) => {}
        }
    }
    // Mirror into the in-memory registry.
    registry.remove(&parsed.project_id);
    broadcast_projects_changed(relay, None);
    info!(
        target: "termul::web::ws",
        project_id = %parsed.project_id,
        "remove_project: project removed + broadcast"
    );
    WsReply::ok(id, Some(json!({})))
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
