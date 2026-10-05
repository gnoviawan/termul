//! Project WS handlers: `create_session`/`load_session`, project CRUD, the
//! host default, and the per-connection `switch_project` queue.

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
}

pub(super) async fn handle_create_session(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
    registry: &Arc<ProjectRegistry>,
    current_agent: &mut Option<crate::acp::AgentId>,
    current_session: &Arc<parking_lot::Mutex<Option<crate::acp::SessionId>>>,
    current_project: &Arc<parking_lot::Mutex<Option<String>>>,
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
    // CAP-2 attribution: resolve the project id best-effort from the registry
    // by cwd, so browser-origin sessions persist under their owning project
    // (switch-back reopen + project-scoped listings). Unknown cwds stay
    // project-less.
    let project_id = registry.find_by_path(&parsed.cwd);
    match acp
        .new_session_with_context(
            &parsed.agent_id,
            parsed.cwd,
            parsed.mcp_servers,
            SessionCreationContext {
                project_id,
                ephemeral: parsed.ephemeral,
                promotable: parsed.promotable,
                ..Default::default()
            },
        )
        .await
    {
        Ok(outcome) => {
            if !parsed.ephemeral {
                // Track the agent + new session for `switch_project` cwd switching.
                *current_agent = Some(parsed.agent_id.clone());
                *current_session.lock() = Some(outcome.session_id.clone());
                // Generic session creation carries a cwd, not a registry-owned
                // project id. Leave it unknown so the next switch is always real.
                *current_project.lock() = None;
            }
            ok_with_payload(id, &outcome)
        }
        Err(e) => acp_err_to_reply(id, e),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SwitchProjectPayload {
    project_id: String,
}

/// `set_default_project` WS request payload. Changes the host's default
/// project (distinct from a per-connection `switch_project`).
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
/// Malformed payloads use `Unsupported` (matching `switch_project`); a
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
    // `switch_context` re-checks the same conditions; reuse it so the
    // validation path is identical to `switch_project`.
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

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(super) enum SwitchProjectOutcome {
    Completed {
        project_id: String,
        session_id: SessionId,
        cwd: String,
        mcp_server_count: usize,
    },
    Queued {
        project_id: String,
        current_session_id: SessionId,
    },
    /// Cold-tab (no live agent) deferred select: the shared active project
    /// changed but no session was created. The web client spawns the agent
    /// lazily when a chat starts (Ask-First resolution stands). `cwd` lets the
    /// client resolve the project root without a second registry round-trip.
    Selected { project_id: String, cwd: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProjectSwitchCompletedPayload {
    status: &'static str,
    request_id: String,
    project_id: String,
    previous_session_id: SessionId,
    session_id: SessionId,
    cwd: String,
    mcp_server_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProjectSwitchFailedPayload {
    request_id: String,
    project_id: String,
    previous_session_id: SessionId,
    message: String,
}

#[derive(Clone)]
pub(super) struct PendingProjectSwitch {
    pub(super) request_id: String,
    pub(super) target: ProjectSwitchContext,
    pub(super) previous_session_id: SessionId,
}

#[derive(Default)]
pub(super) struct ProjectSwitchQueue {
    pub(super) pending: Option<PendingProjectSwitch>,
    worker_running: bool,
}

impl ProjectSwitchQueue {
    /// Queue policy is latest-wins per connection. Returns the replaced request
    /// so the caller can emit one correlated failure event for it.
    pub(super) fn replace_pending(
        &mut self,
        pending: PendingProjectSwitch,
    ) -> Option<PendingProjectSwitch> {
        self.pending.replace(pending)
    }
}

#[must_use]
pub(super) fn connection_already_on_project(
    current_project_id: Option<&str>,
    target_project_id: &str,
) -> bool {
    current_project_id == Some(target_project_id)
}

pub(super) fn project_switch_failed_event(
    request_id: String,
    project_id: String,
    previous_session_id: SessionId,
    message: String,
) -> SequencedEvent {
    SequencedEvent::new(
        Some(previous_session_id.0.clone()),
        0,
        "project_switch_failed",
        serde_json::to_value(ProjectSwitchFailedPayload {
            request_id,
            project_id,
            previous_session_id,
            message,
        })
        .unwrap_or_else(|_| json!({})),
    )
}

/// Attempt to reopen the most-recent resumable session for a project switch
/// (switch-back restore). Looks up the host persistence store for the target
/// `(project_id, cwd)`, gates on the agent's `load`/`resume` capability, and
/// reopens via `resume_session` (preferred) or `load_session`. Returns
/// `Ok(Some(id))` on a successful reopen, `Ok(None)` when there is no
/// resumable session or the agent lacks both capabilities, and `Err` when the
/// reopen attempt fails (the caller falls back to `new_session_with_context`
/// in both the `None` and `Err` cases).
pub(super) async fn try_reopen_session_for_switch(
    acp: &Arc<AcpManager>,
    agent_id: &AgentId,
    persistence: &Arc<crate::acp::SessionPersistence>,
    target: &ProjectSwitchContext,
) -> Result<Option<SessionId>, String> {
    // Resolve the current agent's stable namespace (config id or safe
    // fallback) so the durable store filters candidates to sessions owned by the
    // SAME agent namespace — not just any resumable session for
    // (project_id, cwd). Falls back to the unfiltered lookup when the
    // namespace cannot be resolved (agent unknown / has no stable
    // namespace).
    let agent_namespace = acp.stable_agent_namespace(agent_id).ok().flatten();
    let Some(entry) = persistence.find_most_recent_for_project(
        &target.project_id,
        &target.cwd,
        agent_namespace.as_deref(),
    ) else {
        return Ok(None);
    };
    let session_id = SessionId(entry.session_id.clone());
    // Prefer resume; fall back to load. The store's `resumeEligible` flag
    // only guarantees the session has SOME stable agent namespace — it does
    // NOT guarantee that namespace matches the current agent. The
    // `agent_namespace` filter above (patch #4) narrows candidates to the
    // current agent's namespace, but the load/resume attempt below can still
    // fail (purged session, capability missing, agent error). Both
    // `AcpManager` methods are internally capability-gated — a missing
    // capability returns a fast error string ("agent does not support …")
    // WITHOUT contacting the agent, so the wasteful-attempt cost is one
    // cheap error. Any failure (capability, purged session, agent error) →
    // fall back to a new session.
    match acp
        .resume_session(agent_id, session_id.clone(), target.cwd.clone())
        .await
    {
        Ok(_) => Ok(Some(session_id)),
        Err(resume_err) => match acp
            .load_session(agent_id, session_id.clone(), target.cwd.clone())
            .await
        {
            Ok(_) => Ok(Some(session_id)),
            Err(load_err) => {
                warn!(
                    "[ws] switch-back reopen of session {} failed (resume: {}; load: {}); \
                     falling back to a new session",
                    session_id.0, resume_err, load_err
                );
                Err(load_err)
            }
        },
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn execute_project_switch(
    agent_id: &AgentId,
    target: ProjectSwitchContext,
    previous_session_id: SessionId,
    acp: &Arc<AcpManager>,
    relay: &Arc<WsRelaySink>,
    current_session: &Arc<parking_lot::Mutex<Option<SessionId>>>,
    current_project: &Arc<parking_lot::Mutex<Option<String>>>,
) -> Result<SwitchProjectOutcome, String> {
    if connection_already_on_project(current_project.lock().as_deref(), &target.project_id) {
        return Ok(SwitchProjectOutcome::Completed {
            project_id: target.project_id,
            session_id: previous_session_id,
            cwd: target.cwd,
            mcp_server_count: target.mcp_servers.len(),
        });
    }

    let mcp_server_count = target.mcp_servers.len();
    // Switch-back reopen (Epic-4 bridge): before minting a new session, look up
    // the most-recent resumable session for the target `(project_id, cwd)` in
    // the host-owned durable history store. If found AND the agent has the
    // `load`/`resume` capability, reopen it so the web client restores the
    // previous conversation instead of starting a blank chat (mirrors desktop's
    // "restore the last tab"). Falls back to `new_session_with_context` when
    // no resumable session exists, the agent lacks the capability, or the
    // reopen fails (e.g. the session was purged).
    let reopened = match relay.persistence() {
        Some(persistence) => {
            try_reopen_session_for_switch(acp, agent_id, &persistence, &target).await
        }
        None => Ok(None),
    }
    .unwrap_or(None);
    let new_session = match reopened {
        Some(session_id) => session_id,
        None => {
            let outcome = acp
                .new_session_with_context(
                    agent_id,
                    target.cwd.clone(),
                    target.mcp_servers,
                    SessionCreationContext {
                        project_id: Some(target.project_id.clone()),
                        ephemeral: false,
                        ..Default::default()
                    },
                )
                .await?;
            outcome.session_id
        }
    };

    // Per-connection switch (Epic 7): update only this connection's
    // `current_project`. No `registry.set_default_project`, no
    // `broadcast_projects_changed`, no `FileProjectRegistry` persistence —
    // a per-client switch is ephemeral; only `set_default_project` writes
    // the durable default. Other connected clients are unaffected.
    *current_session.lock() = Some(new_session.clone());
    *current_project.lock() = Some(target.project_id.clone());
    debug!(
        target: "termul::web::ws",
        project_id = %target.project_id,
        session_id = %new_session.0,
        "switch_project: per-connection switch committed (no broadcast)"
    );

    if previous_session_id != new_session {
        if let Err(error) = acp.close_session(agent_id, previous_session_id).await {
            warn!("[ws] project switch committed but old session close failed: {error}");
        }
    }

    Ok(SwitchProjectOutcome::Completed {
        project_id: target.project_id,
        session_id: new_session,
        cwd: target.cwd,
        mcp_server_count,
    })
}

/// Cold-tab (no live agent) `switch_project`: deferred select. Updates only
/// the requesting connection's `current_project`. No agent is spawned and no
/// session is created — the Ask-First resolution stands; the web client
/// spawns the agent lazily when a chat starts. Returns `Selected`. The shared
/// `default_project_id` is NOT touched (per-connection switch); only
/// `set_default_project` changes the host default.
pub(super) fn execute_cold_tab_select(
    target: ProjectSwitchContext,
    current_project: &Arc<parking_lot::Mutex<Option<String>>>,
) -> Result<SwitchProjectOutcome, String> {
    *current_project.lock() = Some(target.project_id.clone());
    debug!(
        target: "termul::web::ws",
        project_id = %target.project_id,
        "switch_project: cold-tab per-connection select (no broadcast, no persistence)"
    );
    Ok(SwitchProjectOutcome::Selected {
        project_id: target.project_id,
        cwd: target.cwd,
    })
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn run_switch_queue(
    agent_id: AgentId,
    acp: Arc<AcpManager>,
    relay: Arc<WsRelaySink>,
    out_tx: mpsc::UnboundedSender<Outbound>,
    current_session: Arc<parking_lot::Mutex<Option<SessionId>>>,
    current_project: Arc<parking_lot::Mutex<Option<String>>>,
    switch_queue: Arc<tokio::sync::Mutex<ProjectSwitchQueue>>,
) {
    loop {
        let pending = {
            let queue = switch_queue.lock().await;
            queue.pending.clone()
        };
        let Some(pending) = pending else {
            switch_queue.lock().await.worker_running = false;
            return;
        };

        if let Err(error) = acp
            .wait_turn_idle(&agent_id, pending.previous_session_id.clone())
            .await
        {
            let failed = {
                let mut queue = switch_queue.lock().await;
                queue.pending.take()
            };
            if let Some(failed) = failed {
                let _ = out_tx.send(Outbound::Event(project_switch_failed_event(
                    failed.request_id,
                    failed.target.project_id,
                    failed.previous_session_id,
                    error,
                )));
            }
            switch_queue.lock().await.worker_running = false;
            return;
        }

        let pending = {
            let mut queue = switch_queue.lock().await;
            queue.pending.take()
        };
        let Some(pending) = pending else {
            continue;
        };
        match execute_project_switch(
            &agent_id,
            pending.target.clone(),
            pending.previous_session_id.clone(),
            &acp,
            &relay,
            &current_session,
            &current_project,
        )
        .await
        {
            Ok(SwitchProjectOutcome::Completed {
                project_id,
                session_id,
                cwd,
                mcp_server_count,
            }) => {
                let event = SequencedEvent::new(
                    Some(pending.previous_session_id.0.clone()),
                    0,
                    "project_switch_completed",
                    serde_json::to_value(ProjectSwitchCompletedPayload {
                        status: "completed",
                        request_id: pending.request_id,
                        project_id,
                        previous_session_id: pending.previous_session_id,
                        session_id,
                        cwd,
                        mcp_server_count,
                    })
                    .unwrap_or_else(|_| json!({})),
                );
                let _ = out_tx.send(Outbound::Event(event));
            }
            Ok(SwitchProjectOutcome::Queued { .. }) => {}
            // `execute_project_switch` never returns `Selected` (only
            // `execute_cold_tab_select` does, on the cold-tab path); kept for
            // exhaustiveness now that the enum has a `Selected` variant.
            Ok(SwitchProjectOutcome::Selected { .. }) => {}
            Err(error) => {
                let _ = out_tx.send(Outbound::Event(project_switch_failed_event(
                    pending.request_id,
                    pending.target.project_id,
                    pending.previous_session_id,
                    error,
                )));
            }
        }
        let mut queue = switch_queue.lock().await;
        if queue.pending.is_some() {
            continue;
        }
        queue.worker_running = false;
        return;
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn handle_switch_project(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
    relay: &Arc<WsRelaySink>,
    registry: &Arc<ProjectRegistry>,
    out_tx: &mpsc::UnboundedSender<Outbound>,
    current_agent: &mut Option<AgentId>,
    current_session: &Arc<parking_lot::Mutex<Option<SessionId>>>,
    current_project: &Arc<parking_lot::Mutex<Option<String>>>,
    switch_queue: &Arc<tokio::sync::Mutex<ProjectSwitchQueue>>,
) -> WsReply {
    let parsed: SwitchProjectPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed switch_project payload (want projectId): {e}"),
            )
        }
    };
    // Resolve the target FIRST (pure registry lookup). Archived / unknown /
    // pathless ids are `NOT_FOUND` for both cold-tab and live-agent paths —
    // hoisted above the agent check so a cold tab can select without a live
    // agent. The live-agent behavior is unchanged: it also resolves `target`
    // before any session work.
    let target = match registry.switch_context(&parsed.project_id) {
        Some(target) => target,
        None => {
            return WsReply::err(
                id,
                WsErrorCode::NotFound,
                format!(
                    "project '{}' not found or not switchable",
                    parsed.project_id
                ),
            )
        }
    };
    let agent_id = match current_agent.clone() {
        Some(agent_id) => agent_id,
        // Cold tab (no live agent): deferred per-connection select — update
        // only this connection's `current_project`, return `Selected`. No
        // agent spawn / session (Ask-First stands; the web client spawns
        // lazily on chat start). No host-default change, no broadcast, no
        // persistence (per-connection switch is ephemeral).
        None => match execute_cold_tab_select(target, current_project) {
            Ok(outcome) => return ok_with_payload(id, &outcome),
            Err(error) => return acp_err_to_reply(id, error),
        },
    };
    // Issue #849: an agent is tracked but no session is (the chat was closed
    // — `close_session`/`dispose_ephemeral_session` clear both trackers, but
    // a mid-lifecycle state can leave an agent without a session). A session
    // switch is not possible without one, so this degrades to the cold-tab
    // deferred select instead of failing: update only this connection's
    // `current_project` and return `Selected`. The web client mirrors the
    // select locally and spawns/creates a session lazily when a chat starts.
    // Live PTY sessions are untouched (a switch never kills PTYs — AGENTS.md
    // known pitfall), and the host default + broadcasts are untouched.
    let previous_session_id = match current_session.lock().clone() {
        Some(session_id) => session_id,
        None => match execute_cold_tab_select(target, current_project) {
            Ok(outcome) => return ok_with_payload(id, &outcome),
            Err(error) => return acp_err_to_reply(id, error),
        },
    };

    match acp
        .is_turn_active(&agent_id, previous_session_id.clone())
        .await
    {
        Ok(false) => match execute_project_switch(
            &agent_id,
            target,
            previous_session_id,
            acp,
            relay,
            current_session,
            current_project,
        )
        .await
        {
            Ok(outcome) => ok_with_payload(id, &outcome),
            Err(error) => acp_err_to_reply(id, error),
        },
        Ok(true) => {
            let outcome = SwitchProjectOutcome::Queued {
                project_id: target.project_id.clone(),
                current_session_id: previous_session_id.clone(),
            };
            let mut queue = switch_queue.lock().await;
            let replaced = queue.replace_pending(PendingProjectSwitch {
                request_id: id.clone(),
                target,
                previous_session_id,
            });
            if let Some(replaced) = replaced {
                let _ = out_tx.send(Outbound::Event(project_switch_failed_event(
                    replaced.request_id,
                    replaced.target.project_id,
                    replaced.previous_session_id,
                    "queued project switch was replaced by a newer request".to_string(),
                )));
            }
            if !queue.worker_running {
                queue.worker_running = true;
                tokio::spawn(run_switch_queue(
                    agent_id,
                    Arc::clone(acp),
                    Arc::clone(relay),
                    out_tx.clone(),
                    Arc::clone(current_session),
                    Arc::clone(current_project),
                    Arc::clone(switch_queue),
                ));
            }
            ok_with_payload(id, &outcome)
        }
        Err(error) => acp_err_to_reply(id, error),
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
}

pub(super) async fn handle_load_session(
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
                format!("malformed load_session payload (want agentId, sessionId, cwd): {e}"),
            )
        }
    };
    // Clone the ids before the call moves `parsed.session_id` + `parsed.cwd`;
    // we still need the session id to track it for `switch_project`.
    let agent_id = parsed.agent_id.clone();
    let session_id = parsed.session_id.clone();
    match acp
        .load_session(&agent_id, parsed.session_id, parsed.cwd)
        .await
    {
        Ok(outcome) => {
            *current_agent = Some(agent_id);
            *current_session.lock() = Some(session_id);
            *current_project.lock() = None;
            ok_with_payload(id, &outcome)
        }
        Err(e) => acp_err_to_reply(id, e),
    }
}
