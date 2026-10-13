//! Live sessions bound to a project, and stopping them.
//!
//! The project registry refuses to remove or archive a project while live
//! sessions are bound to it, and a cascading remove stops them through the
//! manager's own close path. A session's project is stamped by the host at
//! creation and is immutable, so the binding is read from the persisted
//! session metadata (`SessionMetadata.project_id`); the live set comes from
//! each agent driver's own session list.

use std::time::Duration;

use crate::acp::config::{AgentId, SessionId};
use crate::acp::events::{self, AgentDisconnectedEvent, SessionClosedEvent};

use super::AcpManager;

/// How long a cascading stop waits for a cancelled turn to write its
/// terminator before closing the session anyway.
const TURN_TERMINATOR_WAIT: Duration = Duration::from_secs(5);

impl AcpManager {
    /// `(agent, session id)` for every live session whose host-stamped
    /// project is `project_id`. A session without persisted metadata (an
    /// ephemeral warm-pool session) has no project binding and is not listed;
    /// an agent whose driver cannot answer is skipped.
    pub async fn sessions_bound_to_project(&self, project_id: &str) -> Vec<(AgentId, String)> {
        let Some(persistence) = self.persistence() else {
            return Vec::new();
        };
        let mut bound = Vec::new();
        for agent_id in self.list_agents() {
            let session_ids = match self.agent_session_ids(&agent_id).await {
                Ok(ids) => ids,
                Err(error) => {
                    log::warn!(
                        "[acp] session query failed for agent {agent_id} while listing project sessions: {error}"
                    );
                    continue;
                }
            };
            for session_id in session_ids {
                let in_project = persistence
                    .metadata(&session_id)
                    .ok()
                    .is_some_and(|metadata| metadata.project_id.as_deref() == Some(project_id));
                if in_project {
                    bound.push((agent_id.clone(), session_id));
                }
            }
        }
        bound
    }

    /// Stop `session_ids` on one agent: cancel an active turn and wait for its
    /// terminator, close the session, and fan out `session_closed`. Afterwards
    /// the agent is killed (and `agent_disconnected` fanned out) when no
    /// session outside `session_ids` still uses it — an agent serving other
    /// sessions is left running. A session that cannot be stopped (an agent
    /// without `session/close`) is left to that agent-kill rule or reported by
    /// the caller's next listing.
    pub async fn stop_project_sessions(&self, agent_id: &AgentId, session_ids: &[String]) {
        for session_id in session_ids {
            if let Err(error) = self.stop_session(agent_id, session_id).await {
                log::warn!(
                    "[acp] could not stop session {} of agent {agent_id}: {error}",
                    crate::logging::redact_session_id(session_id)
                );
            }
        }
        let remaining = match self.agent_session_ids(agent_id).await {
            Ok(remaining) => remaining,
            Err(error) => {
                log::warn!("[acp] session query failed for agent {agent_id} after a project stop: {error}");
                return;
            }
        };
        if remaining.iter().any(|id| !session_ids.contains(id)) {
            return;
        }
        // Every session still on this agent belongs to the stopped project (or
        // none is left): the agent has no other user.
        if let Err(error) = self.kill(agent_id).await {
            log::warn!("[acp] could not kill agent {agent_id} after a project stop: {error}");
            return;
        }
        for session_id in remaining {
            events::fan_out(
                &self.sinks,
                Some(session_id.as_str()),
                events::EVENT_SESSION_CLOSED,
                &SessionClosedEvent {
                    agent_id: agent_id.clone(),
                    session_id: SessionId::new(session_id.clone()),
                },
            );
        }
        events::fan_out(
            &self.sinks,
            None,
            events::EVENT_AGENT_DISCONNECTED,
            &AgentDisconnectedEvent {
                agent_id: agent_id.clone(),
            },
        );
    }

    /// Cancel a session's active turn (waiting for its terminator), close it,
    /// and fan out `session_closed`.
    async fn stop_session(&self, agent_id: &AgentId, session_id: &str) -> Result<(), String> {
        let session = SessionId::new(session_id);
        if self
            .is_turn_active(agent_id, session.clone())
            .await
            .unwrap_or(false)
        {
            self.cancel_prompt(agent_id, session.clone()).await?;
            if tokio::time::timeout(
                TURN_TERMINATOR_WAIT,
                self.wait_turn_idle(agent_id, session.clone()),
            )
            .await
            .is_err()
            {
                log::warn!(
                    "[acp] session {} did not finish its cancelled turn in time; closing it anyway",
                    crate::logging::redact_session_id(session_id)
                );
            }
        }
        self.close_session(agent_id, session.clone()).await?;
        events::fan_out(
            &self.sinks,
            Some(session_id),
            events::EVENT_SESSION_CLOSED,
            &SessionClosedEvent {
                agent_id: agent_id.clone(),
                session_id: session,
            },
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
impl AcpManager {
    /// Fixture: an agent that can close sessions (advertises `session/close`),
    /// owns `sessions`, and drops a session from its set when closed. Returns
    /// the shared live set so a test can observe what a cascade did.
    pub(crate) fn install_test_agent_with_closable_sessions(
        &self,
        agent_id: AgentId,
        sessions: Vec<String>,
        close_works: bool,
    ) -> std::sync::Arc<parking_lot::Mutex<Vec<String>>> {
        use std::sync::atomic::AtomicBool;
        use std::sync::Arc;

        use super::{AcpCommand, AgentEntry, SpawnStamp};

        let live = Arc::new(parking_lot::Mutex::new(sessions));
        let live_for_driver = Arc::clone(&live);
        let (command_tx, mut command_rx) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Some(command) = command_rx.recv().await {
                match command {
                    AcpCommand::SessionIds { reply } => {
                        let _ = reply.send(Ok(live_for_driver.lock().clone()));
                    }
                    AcpCommand::IsTurnActive { reply, .. } => {
                        let _ = reply.send(Ok(false));
                    }
                    AcpCommand::CloseSession { session_id, reply } => {
                        if close_works {
                            live_for_driver.lock().retain(|id| *id != session_id.0);
                            let _ = reply.send(Ok(()));
                        } else {
                            let _ = reply.send(Err("agent refused to close".to_string()));
                        }
                    }
                    AcpCommand::Shutdown => break,
                    _ => {}
                }
            }
        });
        let mut capabilities = agent_client_protocol::schema::v1::AgentCapabilities::default();
        capabilities.session_capabilities.close = Some(Default::default());
        self.agents.lock().insert(
            agent_id,
            AgentEntry {
                command_tx,
                capabilities,
                stable_namespace: None,
                name: "test-agent".to_string(),
                config_id: None,
                join_handle: None,
                killed: Arc::new(AtomicBool::new(false)),
                stamp: SpawnStamp::default(),
            },
        );
        live
    }
}
