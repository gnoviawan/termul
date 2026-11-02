//! Pending elicitations, the third prompt kind beside permissions and
//! questions.
//!
//! An elicitation is answered straight through the agent
//! (`respond_elicitation`), so the relay enforces nothing about the answer.
//! It keeps a ticket per pending request only so a client that reconnects
//! mid-turn can render the request again: nothing in the event log says an
//! elicitation was answered, so only this table can tell a pending request
//! from an answered one. A ticket ends when it is answered, or when its turn
//! ends, its session closes or its agent dies.

use std::collections::HashMap;

use parking_lot::Mutex;
use serde_json::Value;
use tracing::warn;

use crate::acp::AgentId;

struct ElicitationTicket {
    agent_id: AgentId,
    session_id: String,
    /// The original `elicitation_request` payload.
    request: Value,
    /// Registration order, so pending elicitations list oldest first.
    order: u64,
}

#[derive(Default)]
struct State {
    /// `request_id → ticket` (pending tickets only).
    tickets: HashMap<String, ElicitationTicket>,
    next_order: u64,
}

/// The relay's table of pending elicitations, keyed by `requestId` (a uuid,
/// unique across agents).
#[derive(Default)]
pub struct ElicitationTickets {
    state: Mutex<State>,
}

impl ElicitationTickets {
    /// Keep a published `elicitation_request` payload until it is settled or
    /// released.
    pub fn register_event(&self, payload: &Value) {
        let field = |name: &str| payload.get(name).and_then(Value::as_str);
        let request_id = field("requestId").unwrap_or_default();
        if request_id.is_empty() {
            warn!(
                "[elicitations] dropping elicitation_request with no requestId (dispatcher bug?)"
            );
            return;
        }
        let mut state = self.state.lock();
        let order = state.next_order;
        state.next_order += 1;
        state.tickets.insert(
            request_id.to_string(),
            ElicitationTicket {
                agent_id: AgentId(field("agentId").unwrap_or("unknown").to_string()),
                session_id: field("sessionId").unwrap_or_default().to_string(),
                request: payload.clone(),
                order,
            },
        );
    }

    /// Drop an answered elicitation when `agent_id` owns it, so an answer
    /// naming another agent cannot clear the owner's ticket. Idempotent.
    pub fn settle(&self, request_id: &str, agent_id: &AgentId) {
        let mut state = self.state.lock();
        if state
            .tickets
            .get(request_id)
            .is_some_and(|ticket| ticket.agent_id == *agent_id)
        {
            state.tickets.remove(request_id);
        }
    }

    /// The `elicitation_request` payloads of `session_id` still waiting for
    /// an answer, oldest first.
    #[must_use]
    pub fn pending_requests(&self, session_id: &str) -> Vec<Value> {
        let state = self.state.lock();
        let mut pending: Vec<&ElicitationTicket> = state
            .tickets
            .values()
            .filter(|ticket| ticket.session_id == session_id)
            .collect();
        pending.sort_by_key(|ticket| ticket.order);
        pending
            .into_iter()
            .map(|ticket| ticket.request.clone())
            .collect()
    }

    /// Drop every ticket of a session whose turn ended or that closed: the
    /// driver already cancelled the parked responders. Returns how many.
    pub fn release_session(&self, session_id: &str) -> usize {
        self.release_where(|ticket| ticket.session_id == session_id)
    }

    /// Drop every ticket of an agent that disconnected or crashed. Returns
    /// how many.
    pub fn release_agent(&self, agent_id: &AgentId) -> usize {
        self.release_where(|ticket| ticket.agent_id == *agent_id)
    }

    fn release_where(&self, matches: impl Fn(&ElicitationTicket) -> bool) -> usize {
        let mut state = self.state.lock();
        let before = state.tickets.len();
        state.tickets.retain(|_, ticket| !matches(ticket));
        before - state.tickets.len()
    }
}
