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
}
