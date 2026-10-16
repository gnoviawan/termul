//! Lifecycle release of approval and question tickets.
//!
//! Tickets have no timeout, so the relay must tell the rendezvous when a ticket
//! can no longer be answered: the turn ended, the session closed, or the agent
//! died. The agent driver has already cancelled the parked responders on those
//! paths; this releases the relay side and the session's queue slot.

use super::WsRelaySink;
use crate::acp::AgentId;

impl WsRelaySink {
    /// Release every pending permission and question of `session_id`.
    pub fn release_session_tickets(&self, session_id: &str) {
        let permissions = self
            .rendezvous()
            .map_or(0, |rendezvous| rendezvous.release_session(session_id));
        let questions = self
            .question_rendezvous()
            .map_or(0, |rendezvous| rendezvous.release_session(session_id));
        if permissions + questions > 0 {
            tracing::info!(
                session_id,
                permissions,
                questions,
                "released pending approvals after the session ended"
            );
        }
    }

    /// Release every pending permission and question of `agent_id`.
    pub fn release_agent_tickets(&self, agent_id: &AgentId) {
        let permissions = self
            .rendezvous()
            .map_or(0, |rendezvous| rendezvous.release_agent(agent_id));
        let questions = self
            .question_rendezvous()
            .map_or(0, |rendezvous| rendezvous.release_agent(agent_id));
        if permissions + questions > 0 {
            tracing::info!(
                agent_id = %agent_id,
                permissions,
                questions,
                "released pending approvals after the agent ended"
            );
        }
    }
}
