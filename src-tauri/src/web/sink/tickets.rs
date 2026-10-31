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

    /// Release every pending permission and question of `session_id` whose
    /// turn `turn_id` ended. The permission side also remembers the turn, so a
    /// request of it whose registration lands after this release is dropped.
    pub fn release_turn_tickets(&self, session_id: &str, turn_id: &str) {
        let permissions = self
            .rendezvous()
            .map_or(0, |rendezvous| rendezvous.release_turn(session_id, turn_id));
        let questions = self
            .question_rendezvous()
            .map_or(0, |rendezvous| rendezvous.release_session(session_id));
        if permissions + questions > 0 {
            tracing::info!(
                session_id,
                permissions,
                questions,
                "released pending approvals after the turn ended"
            );
        }
    }

    /// Release one question its agent withdrew while the turn goes on (an
    /// `ask_user` call whose caller hung up). A later answer reads
    /// `already_resolved`.
    pub fn release_question_ticket(&self, question_id: &str) {
        if let Some(rendezvous) = self.question_rendezvous() {
            rendezvous.settle(question_id);
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
