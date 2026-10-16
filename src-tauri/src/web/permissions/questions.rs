//! Question rendezvous (issue #411) — the structured-question sibling of
//! [`super::PermissionRendezvous`].
//!
//! A pending question is durable host state: it waits for a human as long as
//! its session exists. There is no timeout and no disconnect deny. It ends
//! only by an answer, or when the lifecycle hooks ([`QuestionRendezvous::release_session`],
//! [`QuestionRendezvous::release_agent`]) tell the rendezvous that the turn
//! ended, the session closed or the agent died.

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::Value;
use tracing::warn;

use super::tombstones::Tombstones;
use crate::acp::{AcpManager, AgentId};
use crate::web::sink::ClientId;

/// Outcome of a successful [`QuestionRendezvous::try_respond`] call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuestionRespondOutcome {
    /// The ticket was unresolved; this answer won and was forwarded to the
    /// agent. The browser should show success.
    Resolved,
}

/// Why a [`QuestionRendezvous::try_respond`] call was rejected. Each variant
/// maps to a stable WS `err.code` (see [`QuestionRespondError::wire_code`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuestionRespondError {
    /// No outstanding ticket for this `question_id` (never seen, or resolved
    /// and aged out of the tombstones). Wire `err.code: "stale"`.
    NotFound,
    /// The ticket was already resolved — by another client (first-wins) or by
    /// a lifecycle release — and is still in the bounded tombstone memory.
    /// Wire `err.code: "already_resolved"`.
    AlreadyResolved,
    /// The *same* client already responded to this ticket (double-respond).
    /// Wire `err.code: "duplicate"`.
    Duplicate,
    /// A submitted `value` was not among the ticket's original immutable
    /// option values (TOCTOU defense — an attacker can't answer with an option
    /// that wasn't in the original question). Wire `err.code: "permission_denied"`.
    InvalidOption,
}

impl QuestionRespondError {
    /// The stable snake_case wire code for this rejection.
    #[must_use]
    pub const fn wire_code(self) -> &'static str {
        match self {
            Self::NotFound => "stale",
            Self::AlreadyResolved => "already_resolved",
            Self::Duplicate => "duplicate",
            Self::InvalidOption => "permission_denied",
        }
    }
}

/// A single outstanding question ticket — relay-side metadata only (never
/// holds the ACP `Responder`).
struct QuestionTicket {
    /// Which agent owns the responder (forwarded to `AcpManager::answer_question`).
    agent_id: AgentId,
    /// The session the question belongs to (for lifecycle release + ownership).
    session_id: String,
    /// The immutable args snapshot — `options` array from the original
    /// `AskUserQuestionEvent` payload. Used for TOCTOU re-validation.
    options: Value,
    /// `true` when any option declares `cardinality: "multi"` — multi-select
    /// allows several values; single-select enforces at most one.
    multi: bool,
    /// `Some(client)` once a client has won the ticket (first-response-wins).
    resolved_by: Option<ClientId>,
}

/// Server-side question rendezvous (issue #411).
///
/// Holds the relay-side ticket table keyed by `question_id` (globally unique —
/// safe across agents). The desktop renderer answers through the
/// `acp_answer_question` Tauri command, which tells the rendezvous through
/// [`Self::settle`]; first-response-wins across both paths.
pub struct QuestionRendezvous {
    /// `question_id → ticket` (outstanding tickets only).
    tickets: Mutex<HashMap<String, QuestionTicket>>,
    /// The ACP manager — used to forward answers back to the agent's
    /// `Responder` via the command channel.
    acp: Arc<AcpManager>,
    /// Bounded memory of resolved question ids (`already_resolved` replies).
    resolved: Mutex<Tombstones>,
}

impl QuestionRendezvous {
    /// Create a rendezvous bound to an [`AcpManager`].
    #[must_use]
    pub fn new(acp: Arc<AcpManager>) -> Self {
        Self {
            tickets: Mutex::new(HashMap::new()),
            acp,
            resolved: Mutex::new(Tombstones::new()),
        }
    }

    /// The session id a pending `question_id` belongs to, or `None`.
    #[must_use]
    pub fn session_for_question(&self, question_id: &str) -> Option<String> {
        self.tickets
            .lock()
            .get(question_id)
            .map(|t| t.session_id.clone())
    }

    /// The agent id a pending `question_id` belongs to, or `None`.
    #[must_use]
    pub fn agent_for_question(&self, question_id: &str) -> Option<AgentId> {
        self.tickets
            .lock()
            .get(question_id)
            .map(|t| t.agent_id.clone())
    }

    /// Whether a `question_id` is currently outstanding (test helper).
    #[cfg(test)]
    pub(crate) fn is_outstanding(&self, question_id: &str) -> bool {
        self.tickets.lock().contains_key(question_id)
    }

    /// Snapshot a `question_request` event into a ticket.
    ///
    /// Called by [`WsRelaySink::emit`] when it sees `acp:question_request`.
    /// `options` is the `Value` of the event's `options` field (array of
    /// `{value, label, description?, cardinality?}`) — the immutable-args
    /// snapshot for TOCTOU re-validation.
    pub fn register(
        &self,
        question_id: String,
        agent_id: AgentId,
        session_id: String,
        options: Value,
    ) {
        let multi = options.as_array().is_some_and(|arr| {
            arr.iter().any(|opt| {
                opt.get("cardinality")
                    .and_then(Value::as_str)
                    .is_some_and(|c| c == "multi")
            })
        });
        let ticket = QuestionTicket {
            agent_id,
            session_id,
            options,
            multi,
            resolved_by: None,
        };
        self.tickets.lock().insert(question_id, ticket);
    }

    /// The rejection for a `question_id` with no outstanding ticket: a recently
    /// resolved one is `AlreadyResolved`, anything else `NotFound`.
    fn missing_ticket_error(&self, question_id: &str) -> QuestionRespondError {
        if self.resolved.lock().contains(question_id) {
            QuestionRespondError::AlreadyResolved
        } else {
            QuestionRespondError::NotFound
        }
    }

    /// Attempt to resolve a ticket with a client's answer (first-response-wins).
    ///
    /// On success, the answer is forwarded to [`AcpManager::answer_question`].
    /// `values == None` resolves as cancelled; `Some(values)` forwards the
    /// selected option values (TOCTOU-validated against the registered options).
    pub async fn try_respond(
        &self,
        client_id: ClientId,
        question_id: &str,
        values: Option<&[String]>,
    ) -> Result<QuestionRespondOutcome, QuestionRespondError> {
        let agent_id = {
            let mut tickets = self.tickets.lock();
            let Some(ticket) = tickets.get_mut(question_id) else {
                drop(tickets);
                return Err(self.missing_ticket_error(question_id));
            };
            if ticket.resolved_by == Some(client_id) {
                return Err(QuestionRespondError::Duplicate);
            }
            if ticket.resolved_by.is_some() {
                return Err(QuestionRespondError::AlreadyResolved);
            }
            // TOCTOU: every submitted value MUST be among the original options.
            // Cancel (None) is always allowed (the user may dismiss).
            if let Some(values) = values {
                // An empty array is neither a selection nor a cancel — clients
                // must send `None` to cancel.
                if values.is_empty() {
                    return Err(QuestionRespondError::InvalidOption);
                }
                for v in values {
                    if !question_value_is_valid(&ticket.options, v) {
                        return Err(QuestionRespondError::InvalidOption);
                    }
                }
                if !ticket.multi && values.len() > 1 {
                    return Err(QuestionRespondError::InvalidOption);
                }
            }
            // Claim the ticket (single-use) under the same lock as the checks.
            ticket.resolved_by = Some(client_id);
            ticket.agent_id.clone()
        };

        let values = values.map(|v| v.to_vec());
        if let Err(e) = self
            .acp
            .answer_question(&agent_id, question_id.to_string(), values)
            .await
        {
            if e.contains("unknown question request") {
                warn!(
                    "[questions] answer_question {question_id} — agent has no outstanding request: {e}"
                );
                self.settle(question_id);
                return Err(QuestionRespondError::NotFound);
            }
            warn!("[questions] answer_question {question_id} failed: {e}");
        }

        self.settle(question_id);
        Ok(QuestionRespondOutcome::Resolved)
    }

    /// Mark a question as resolved elsewhere: drop its ticket and remember its
    /// id so a later answer reads `already_resolved`. Idempotent; an id the
    /// rendezvous never saw is ignored. Called after an answer, and by the
    /// desktop `acp_answer_question` command, which answers the agent directly.
    pub fn settle(&self, question_id: &str) {
        let mut tickets = self.tickets.lock();
        if tickets.remove(question_id).is_some() {
            self.resolved.lock().record(question_id);
        }
    }

    /// Drop every ticket of a session whose turn ended or that closed. The
    /// driver already resolved the parked responders; later answers read
    /// `already_resolved`. Returns how many tickets were released.
    pub fn release_session(&self, session_id: &str) -> usize {
        self.release_where(|ticket| ticket.session_id == session_id)
    }

    /// Drop every ticket of an agent that disconnected or crashed. Returns
    /// how many tickets were released.
    pub fn release_agent(&self, agent_id: &AgentId) -> usize {
        self.release_where(|ticket| ticket.agent_id == *agent_id)
    }

    fn release_where(&self, matches: impl Fn(&QuestionTicket) -> bool) -> usize {
        let mut tickets = self.tickets.lock();
        let released: Vec<String> = tickets
            .iter()
            .filter(|(_, ticket)| matches(ticket))
            .map(|(id, _)| id.clone())
            .collect();
        let mut resolved = self.resolved.lock();
        for id in &released {
            tickets.remove(id);
            resolved.record(id);
        }
        released.len()
    }
}

impl Default for QuestionRendezvous {
    fn default() -> Self {
        Self::new(Arc::new(AcpManager::new(vec![])))
    }
}

/// Whether `value` appears in the immutable `options` snapshot's `value`
/// fields (TOCTOU re-validation).
fn question_value_is_valid(options: &Value, value: &str) -> bool {
    options.as_array().is_some_and(|arr| {
        arr.iter().any(|opt| {
            opt.get("value")
                .and_then(Value::as_str)
                .is_some_and(|v| v == value)
        })
    })
}
