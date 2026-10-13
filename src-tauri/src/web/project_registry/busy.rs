//! What keeps a project busy: the live sessions and terminals bound to it, the
//! cascade that stops them, and the `removing` mark that refuses new ones
//! while a remove/archive runs.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::acp::{AcpManager, AgentId};
use crate::pty::PtyManager;

use super::ProjectRegistry;

/// One live session bound to a project.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundSession {
    pub agent_id: AgentId,
    pub session_id: String,
}

/// The live entities bound to one project: the `PROJECT_BUSY` payload.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BoundEntities {
    pub sessions: Vec<BoundSession>,
    pub terminals: Vec<String>,
}

impl BoundEntities {
    /// `true` when nothing is bound.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty() && self.terminals.is_empty()
    }

    /// The reply `details`: `{"sessions":[sessionId…],"terminals":[terminalId…]}`.
    #[must_use]
    pub fn details(&self) -> Value {
        json!({
            "sessions": self.sessions.iter().map(|s| s.session_id.as_str()).collect::<Vec<_>>(),
            "terminals": self.terminals,
        })
    }
}

/// The live sessions and terminals bound to `project_id`.
pub(super) async fn collect(
    acp: &AcpManager,
    pty: &PtyManager,
    project_id: &str,
) -> BoundEntities {
    BoundEntities {
        sessions: acp
            .sessions_bound_to_project(project_id)
            .await
            .into_iter()
            .map(|(agent_id, session_id)| BoundSession {
                agent_id,
                session_id,
            })
            .collect(),
        terminals: pty.terminal_ids_for_project(project_id),
    }
}

/// Stop everything in `bound` through the host's own paths — sessions via
/// [`AcpManager::stop_project_sessions`] (cancel, await the terminator, close;
/// the agent is killed only when no other session uses it), terminals via
/// `force_kill`, which ignores the desktop's hidden-window deferral — and
/// return what is still bound afterwards (empty on full success).
pub(super) async fn stop_all(
    acp: &AcpManager,
    pty: &PtyManager,
    project_id: &str,
    bound: &BoundEntities,
) -> BoundEntities {
    let mut by_agent: Vec<(AgentId, Vec<String>)> = Vec::new();
    for session in &bound.sessions {
        match by_agent.iter_mut().find(|(agent, _)| *agent == session.agent_id) {
            Some((_, ids)) => ids.push(session.session_id.clone()),
            None => by_agent.push((session.agent_id.clone(), vec![session.session_id.clone()])),
        }
    }
    for (agent_id, session_ids) in &by_agent {
        acp.stop_project_sessions(agent_id, session_ids).await;
    }
    for terminal_id in &bound.terminals {
        // "not found" means the terminal already exited: that is the goal.
        if let Err(error) = pty.force_kill(terminal_id).await {
            if !error.starts_with("Terminal not found") {
                tracing::warn!(
                    target: "termul::web::project_registry",
                    project_id,
                    terminal_id = %terminal_id,
                    %error,
                    "could not stop a project terminal"
                );
            }
        }
    }
    collect(acp, pty, project_id).await
}

/// Holds a project's `removing` mark; releases it on drop.
pub(super) struct RemovalGuard {
    registry: Arc<ProjectRegistry>,
    project_id: String,
}

impl Drop for RemovalGuard {
    fn drop(&mut self) {
        self.registry.removing.lock().remove(&self.project_id);
    }
}

impl ProjectRegistry {
    /// Mark `project_id` as being removed or archived: new sessions and
    /// terminals are refused for it until the guard drops. `None` when a
    /// removal of the same project is already running.
    pub(super) fn begin_removal(self: &Arc<Self>, project_id: &str) -> Option<RemovalGuard> {
        if !self.removing.lock().insert(project_id.to_string()) {
            return None;
        }
        Some(RemovalGuard {
            registry: Arc::clone(self),
            project_id: project_id.to_string(),
        })
    }

    /// `true` while a remove/archive of `project_id` runs. Session and
    /// terminal creation refuses such a project (`project_busy`).
    #[must_use]
    pub fn is_removing(&self, project_id: &str) -> bool {
        self.removing.lock().contains(project_id)
    }

    /// `true` while `project_id` is registered and not archived.
    #[must_use]
    pub fn is_active(&self, project_id: &str) -> bool {
        self.inner
            .lock()
            .project(project_id)
            .is_some_and(|p| !p.is_archived)
    }

    /// `true` when a session or terminal that has just been created in
    /// `project_id` missed the remove or archive: one still runs, or it has
    /// finished and took the project away. The caller then stops the new
    /// entity and answers `project_busy`. `was_active` is
    /// [`is_active`](Self::is_active) read before the entity was created, so
    /// a project that was never active (unassigned, archived) is not held to
    /// this check.
    ///
    /// The `removing` mark lives until the remove or archive has committed. An
    /// entity created before the mark is found by the bound-entity check. An
    /// entity that is created while the mark is held, or after the commit, is
    /// caught here.
    #[must_use]
    pub fn project_left_while_starting(&self, project_id: &str, was_active: bool) -> bool {
        self.is_removing(project_id) || (was_active && !self.is_active(project_id))
    }
}
