//! Permission rendezvous (Story 1.7) — server-side ticket table for the
//! human-relayed `request_permission` cap.
//!
//! The ACP `Responder<RequestPermissionResponse>` lives on the per-agent
//! driver thread inside [`crate::acp::manager::AcpManager`] (it is `!Send` and
//! must not cross threads). This module holds ONLY `Send + Sync` relay-side
//! ticket metadata + the rendezvous policy (at-most-one, first-response-wins,
//! TOCTOU re-validation). It never touches the `Responder` directly — it
//! forwards resolution decisions back through [`AcpManager::respond_permission`],
//! which resolves the `Responder` on the driver thread via the existing
//! `AcpCommand` mpsc channel.
//!
//! # Durable tickets
//!
//! A pending permission is durable host state: the session is awaiting input.
//! There is no ticket timeout and no disconnect deny. A ticket ends only by
//!
//! - an answer ([`PermissionRendezvous::try_respond`], first answer wins),
//! - an answer given elsewhere ([`PermissionRendezvous::settle`], used by the
//!   desktop `acp_respond_permission` command), or
//! - a lifecycle release ([`PermissionRendezvous::release_session`] on turn
//!   end or session close, [`PermissionRendezvous::release_agent`] on agent
//!   death), called from [`crate::web::sink::WsRelaySink::emit`].
//!
//! Any client may answer by `request_id`, with or without a subscription, for
//! as long as the ticket exists. Answered and released ids are remembered in a
//! bounded tombstone memory, so a later answer reads `already_resolved`.
//!
//! A ticket keeps its original `permission_request` payload, so a client that
//! (re)subscribes gets every still-pending request of the session back
//! ([`PermissionRendezvous::pending_requests`]): the request event is not in
//! the durable log, so neither a snapshot nor a replay past its seq carries it.
//!
//! At most one ticket per session is outstanding; the rest wait in a FIFO
//! queue. Every answer promotes the next queued ticket. A lifecycle release
//! drops the whole session queue instead: the driver has already cancelled
//! every parked responder of the session, so there is nothing left to promote.
//!
//! # Wiring
//!
//! [`crate::web::sink::WsRelaySink`] holds an `Option<Arc<PermissionRendezvous>>`.
//! When the relay's `emit` sees an `acp:permission_request` event, it snapshots
//! a ticket here. The `/ws` request handler calls
//! [`PermissionRendezvous::try_respond`] for `respond_permission` frames.
//!
//! # Host tickets
//!
//! Ids namespaced `host:` are consent tickets the host itself raised
//! ([`crate::acp::host_ticket`]). They never enter this table and never
//! reach the agent: [`PermissionRendezvous::answer_host`] resolves them
//! against the host ticket resolver, under its approver rules.
//!
//! # deny == Cancelled
//!
//! The ACP `RequestPermissionOutcome` enum has only `Selected` and `Cancelled`
//! — there is no dedicated "deny" variant. `option_id == None` →
//! `RequestPermissionOutcome::Cancelled`, which the agent treats as denial (the
//! tool call does not execute).

mod questions;
mod tombstones;
mod turn_watermark;

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::Value;
use tracing::warn;

use crate::acp::host_ticket::{is_host_ticket_id, AnswerError, Approver, HostTickets};
use crate::acp::{AcpManager, AgentId};
use crate::browser_automation::core::ports::ConsentOption;
use crate::web::sink::ClientId;

pub use questions::{QuestionRendezvous, QuestionRespondError, QuestionRespondOutcome};
pub use tombstones::RESOLVED_TOMBSTONE_CAPACITY;
pub use turn_watermark::{TurnClaim, TurnWatermark};

use tombstones::Tombstones;

/// Outcome of a successful [`PermissionRendezvous::try_respond`] call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RespondOutcome {
    /// The ticket was unresolved; this response won and was forwarded to the
    /// agent. The browser should show success.
    Resolved,
}

/// Why a [`PermissionRendezvous::try_respond`] call was rejected. Each variant
/// maps to a stable WS `err.code` (see [`RespondError::wire_code`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RespondError {
    /// No outstanding ticket for this `request_id` (never seen, resolved and
    /// aged out of the tombstones, or not yet promoted from the session
    /// queue). Wire `err.code: "stale"`.
    NotFound,
    /// The ticket was already resolved — by another client (first-wins) or by
    /// a lifecycle release — and is still in the bounded tombstone memory.
    /// Wire `err.code: "already_resolved"`.
    AlreadyResolved,
    /// The *same* client already responded to this ticket (double-respond).
    /// Wire `err.code: "duplicate"`.
    Duplicate,
    /// The `option_id` was not among the ticket's original immutable `options`
    /// (TOCTOU defense — an attacker can't approve an option that wasn't in the
    /// original request). Wire `err.code: "permission_denied"`.
    InvalidOption,
}

impl RespondError {
    /// The stable snake_case WS `err.code` for this rejection (mirrors the
    /// `WsErrorCode` set in [`crate::web::ws`]).
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

/// A single outstanding permission ticket — relay-side metadata only (never
/// holds the ACP `Responder`).
struct PermissionTicket {
    /// Which agent owns the responder (forwarded to
    /// `AcpManager::respond_permission`).
    agent_id: AgentId,
    /// The session the permission belongs to (for lifecycle release + ownership).
    session_id: String,
    /// The immutable args snapshot — `options` array from the original
    /// `PermissionRequestEvent` payload. Used for TOCTOU re-validation.
    options: Value,
    /// The original `permission_request` payload, re-delivered to a client
    /// that subscribes while the ticket is pending.
    request: Value,
    /// `Some(client)` once a client has won the ticket (first-response-wins);
    /// further responses are `AlreadyResolved` or `Duplicate`.
    resolved_by: Option<ClientId>,
}

/// Per-session queue state for the at-most-one-outstanding rule (FR14).
struct SessionQueue {
    /// The currently-outstanding `request_id` for this session. Further
    /// `permission_request` events are queued until this resolves.
    outstanding: String,
    /// FIFO of pending tickets waiting for the outstanding slot.
    queued: VecDeque<QueuedTicket>,
}

/// A ticket held in a session queue (not yet outstanding).
struct QueuedTicket {
    request_id: String,
    agent_id: AgentId,
    options: Value,
    request: Value,
}

/// The ticket table and the per-session queues. One lock covers both, so the
/// outstanding slot and its ticket never disagree.
#[derive(Default)]
struct State {
    /// `request_id → ticket` for outstanding tickets (one per session).
    tickets: HashMap<String, PermissionTicket>,
    /// `session_id → at-most-one queue`. A session has an entry only while it
    /// has an outstanding ticket.
    sessions: HashMap<String, SessionQueue>,
}

impl State {
    /// Make `request_id` of `session_id` the outstanding ticket.
    fn open_ticket(&mut self, session_id: &str, ticket: QueuedTicket) {
        self.tickets.insert(
            ticket.request_id,
            PermissionTicket {
                agent_id: ticket.agent_id,
                session_id: session_id.to_string(),
                options: ticket.options,
                request: ticket.request,
                resolved_by: None,
            },
        );
    }

    /// Forget `request_id` everywhere. When it held its session's outstanding
    /// slot, the next queued ticket is promoted in the same step, so a
    /// concurrent `register` never sees a free slot. Returns whether the id
    /// was known (outstanding or queued).
    fn settle(&mut self, request_id: &str) -> bool {
        let owner = match self.tickets.remove(request_id) {
            Some(ticket) => Some(ticket.session_id),
            None => self
                .sessions
                .iter()
                .find(|(_, queue)| queue.queued.iter().any(|t| t.request_id == request_id))
                .map(|(session_id, _)| session_id.clone()),
        };
        let Some(session_id) = owner else {
            return false;
        };
        let Some(queue) = self.sessions.get_mut(&session_id) else {
            return true;
        };
        queue.queued.retain(|t| t.request_id != request_id);
        if queue.outstanding == request_id {
            match queue.queued.pop_front() {
                Some(next) => {
                    queue.outstanding.clone_from(&next.request_id);
                    self.open_ticket(&session_id, next);
                }
                None => {
                    self.sessions.remove(&session_id);
                }
            }
        }
        true
    }

    /// Drop a whole session queue (outstanding + queued). Returns the ids.
    fn release_session(&mut self, session_id: &str) -> Vec<String> {
        let Some(queue) = self.sessions.remove(session_id) else {
            return Vec::new();
        };
        let mut ids: Vec<String> = queue.queued.into_iter().map(|t| t.request_id).collect();
        ids.push(queue.outstanding);
        for id in &ids {
            self.tickets.remove(id);
        }
        ids
    }
}

/// Server-side permission rendezvous (Story 1.7).
///
/// Holds the relay-side ticket table keyed by `request_id` (globally unique —
/// safe across agents) + per-session at-most-one queueing. The same
/// rendezvous serves the desktop host, the shared-live host, `termul-server`
/// and the browser client.
pub struct PermissionRendezvous {
    state: Mutex<State>,
    /// The ACP manager — used to forward resolution decisions (select/cancel)
    /// back to the agent's `Responder` via the command channel.
    acp: Arc<AcpManager>,
    /// Bounded memory of resolved request ids (`already_resolved` replies).
    /// Lock order: `state` before `resolved`.
    resolved: Mutex<Tombstones>,
    /// Host-originated tickets (desktop only; `None` elsewhere).
    host: Mutex<Option<Arc<HostTickets>>>,
}

impl PermissionRendezvous {
    /// Create a rendezvous bound to an [`AcpManager`].
    #[must_use]
    pub fn new(acp: Arc<AcpManager>) -> Self {
        Self {
            state: Mutex::new(State::default()),
            acp,
            resolved: Mutex::new(Tombstones::new()),
            host: Mutex::new(None),
        }
    }

    /// Attach the host ticket resolver (the desktop's browser consent).
    pub fn set_host_tickets(&self, host: Arc<HostTickets>) {
        *self.host.lock() = Some(host);
    }

    /// Whether `request_id` names a host ticket rather than an agent's.
    #[must_use]
    pub fn is_host_ticket(request_id: &str) -> bool {
        is_host_ticket_id(request_id)
    }

    /// The session a pending host ticket belongs to.
    #[must_use]
    pub fn host_ticket_session(&self, request_id: &str) -> Option<String> {
        self.host.lock().as_ref()?.session_of(request_id)
    }

    /// Answer a host ticket. A process without a host resolver has no host
    /// tickets, so every id reads `NotFound`.
    pub fn answer_host(
        &self,
        approver: Approver,
        request_id: &str,
        option_id: Option<&str>,
    ) -> Result<ConsentOption, AnswerError> {
        let host = self.host.lock().clone();
        host.ok_or(AnswerError::NotFound)?
            .answer(approver, request_id, option_id)
    }

    /// The session id a pending `request_id` belongs to, or `None` if there is
    /// no outstanding ticket for it. Used by the `/ws` `respond_permission`
    /// handler to resolve the calling connection's `ClientId` (a connection may
    /// be subscribed to several sessions; the permission belongs to one).
    #[must_use]
    pub fn session_for_request(&self, request_id: &str) -> Option<String> {
        self.state
            .lock()
            .tickets
            .get(request_id)
            .map(|t| t.session_id.clone())
    }

    /// The agent id a pending `request_id` belongs to, or `None` if there is no
    /// outstanding ticket. Used by the `/ws` `respond_permission` handler to
    /// verify the payload's `agentId` matches the ticket's agent (defense in
    /// depth — a client cannot resolve another agent's permission).
    #[must_use]
    pub fn agent_for_request(&self, request_id: &str) -> Option<AgentId> {
        self.state
            .lock()
            .tickets
            .get(request_id)
            .map(|t| t.agent_id.clone())
    }

    /// Whether a `request_id` is currently outstanding (test helper).
    #[cfg(test)]
    pub(crate) fn is_outstanding(&self, request_id: &str) -> bool {
        self.state.lock().tickets.contains_key(request_id)
    }

    /// The number of queued (not-yet-outstanding) permissions for a session
    /// (test helper for the at-most-one rule).
    #[cfg(test)]
    pub(crate) fn queued_count_for_session(&self, session_id: &str) -> usize {
        self.state
            .lock()
            .sessions
            .get(session_id)
            .map_or(0, |q| q.queued.len())
    }

    /// Snapshot a `permission_request` event payload into a ticket.
    ///
    /// Called by [`WsRelaySink::emit`] when it sees `acp:permission_request`.
    /// The payload is `{agentId, sessionId, requestId, toolCall, options}`
    /// (events.rs → camelCase wire); it is kept whole so a resubscribing
    /// client can render the request again. A payload without a `requestId`
    /// would collide all such tickets on the empty key, so it is skipped
    /// (`DriverState::register_permission` always mints `perm-{uuid}`; this
    /// only triggers on a dispatcher bug).
    pub fn register_event(&self, payload: &Value) {
        let field = |name: &str| payload.get(name).and_then(Value::as_str);
        let request_id = field("requestId").unwrap_or_default();
        if request_id.is_empty() {
            warn!("[permissions] dropping permission_request with no requestId (dispatcher bug?)");
            return;
        }
        self.insert(
            field("sessionId").unwrap_or_default().to_string(),
            QueuedTicket {
                request_id: request_id.to_string(),
                agent_id: AgentId(field("agentId").unwrap_or("unknown").to_string()),
                options: payload.get("options").cloned().unwrap_or(Value::Array(vec![])),
                request: payload.clone(),
            },
        );
    }

    /// Register a ticket from its fields (FR14: at-most-one outstanding per
    /// session; the rest are queued). `options` is the `Value` of the event's
    /// `options` field (array of `{optionId, …}`) — the immutable-args snapshot
    /// for TOCTOU re-validation. The kept request payload is built from the
    /// same fields.
    pub fn register(
        &self,
        request_id: String,
        agent_id: AgentId,
        session_id: String,
        options: Value,
    ) {
        let request = serde_json::json!({
            "agentId": agent_id.0,
            "sessionId": session_id,
            "requestId": request_id,
            "options": options,
        });
        self.insert(
            session_id,
            QueuedTicket {
                request_id,
                agent_id,
                options,
                request,
            },
        );
    }

    fn insert(&self, session_id: String, ticket: QueuedTicket) {
        if is_host_ticket_id(&ticket.request_id) {
            return;
        }
        let mut state = self.state.lock();
        if let Some(queue) = state.sessions.get_mut(&session_id) {
            queue.queued.push_back(ticket);
            return;
        }
        state.sessions.insert(
            session_id.clone(),
            SessionQueue {
                outstanding: ticket.request_id.clone(),
                queued: VecDeque::new(),
            },
        );
        state.open_ticket(&session_id, ticket);
    }

    /// The `permission_request` payloads of a session that still wait for an
    /// answer: the outstanding one first, then the queued ones in FIFO order.
    /// An outstanding ticket whose answer is already being forwarded to the
    /// agent is not pending any more and is left out. A subscribing client
    /// installs this list as the session's pending approvals.
    #[must_use]
    pub fn pending_requests(&self, session_id: &str) -> Vec<Value> {
        let state = self.state.lock();
        let Some(queue) = state.sessions.get(session_id) else {
            return Vec::new();
        };
        let outstanding = state
            .tickets
            .get(&queue.outstanding)
            .filter(|ticket| ticket.resolved_by.is_none())
            .map(|ticket| ticket.request.clone());
        outstanding
            .into_iter()
            .chain(queue.queued.iter().map(|ticket| ticket.request.clone()))
            .collect()
    }

    /// The rejection for a `request_id` with no outstanding ticket: a recently
    /// resolved one is `AlreadyResolved`, anything else `NotFound`.
    fn missing_ticket_error(&self, request_id: &str) -> RespondError {
        if self.resolved.lock().contains(request_id) {
            RespondError::AlreadyResolved
        } else {
            RespondError::NotFound
        }
    }

    /// Attempt to resolve a ticket with a client's response (first-response-wins).
    ///
    /// On success (`Resolved`), the response is forwarded to
    /// [`AcpManager::respond_permission`] (resolves the agent's `Responder`).
    /// On rejection, the caller maps the [`RespondError`] to a WS `err.code`.
    pub async fn try_respond(
        &self,
        client_id: ClientId,
        request_id: &str,
        option_id: Option<&str>,
    ) -> Result<RespondOutcome, RespondError> {
        // 1. Validate and claim the ticket (single-use) under one lock: TOCTOU
        //    re-check, first-wins and duplicate detection.
        let agent_id = {
            let mut state = self.state.lock();
            let Some(ticket) = state.tickets.get_mut(request_id) else {
                drop(state);
                return Err(self.missing_ticket_error(request_id));
            };
            if ticket.resolved_by == Some(client_id) {
                return Err(RespondError::Duplicate);
            }
            if ticket.resolved_by.is_some() {
                return Err(RespondError::AlreadyResolved);
            }
            // TOCTOU: an option_id MUST be among the original immutable options.
            // Cancel (option_id=None) is always allowed (the user may dismiss).
            if let Some(id) = option_id {
                if !option_id_is_valid(&ticket.options, id) {
                    return Err(RespondError::InvalidOption);
                }
            }
            ticket.resolved_by = Some(client_id);
            ticket.agent_id.clone()
        };

        // 2. Forward to the agent (resolves the `Responder` on the driver thread).
        //    T1.3: the agent-side driver loop returns `Err("unknown permission
        //    request: {id}")` when `take_permission` finds no outstanding
        //    `Responder` for this `request_id` (resolved concurrently / drained
        //    on a turn-complete / agent-disconnect race). Map that to `stale` so
        //    the browser's optimistic-restore (`acp-store.ts`) re-shows the
        //    permission rather than falsely reporting success. Other errors
        //    (e.g. `"unknown agent: …"` — the agent is gone entirely and its
        //    `Responder`s were already resolved `Cancelled` by the disconnect
        //    teardown) are logged-and-continued: the agent-side state is
        //    already consistent, so reporting success to the browser is safe.
        let outcome = option_id.map(str::to_string);
        if let Err(e) = self
            .acp
            .respond_permission(&agent_id, request_id.to_string(), outcome)
            .await
        {
            if e.contains("unknown permission request") {
                warn!(
                    "[permissions] respond_permission {request_id} — agent has no outstanding request: {e}"
                );
                // The agent already resolved it elsewhere: this answer is
                // `stale`, and remembering the ticket makes any LATER answer
                // read `already_resolved`.
                self.settle(request_id);
                return Err(RespondError::NotFound);
            }
            warn!("[permissions] respond_permission {request_id} failed: {e}");
        }

        // 3. Evict the resolved ticket (remembering it, so a later answer reads
        //    `already_resolved`) + promote the next queued permission.
        self.settle(request_id);
        Ok(RespondOutcome::Resolved)
    }

    /// Mark a permission as resolved elsewhere: drop its ticket, remember its
    /// id so a later answer reads `already_resolved`, and promote the next
    /// queued permission of its session. Idempotent; an id the rendezvous
    /// never saw is ignored. Called after an answer, and by the desktop
    /// `acp_respond_permission` command, which answers the agent directly and
    /// would otherwise leave its ticket holding the session's slot.
    pub fn settle(&self, request_id: &str) {
        let mut state = self.state.lock();
        if state.settle(request_id) {
            self.resolved.lock().record(request_id);
        }
    }

    /// Drop every ticket of a session whose turn ended or that closed (the
    /// outstanding one and the queued ones). The driver already cancelled the
    /// parked responders; later answers read `already_resolved`. Returns how
    /// many tickets were released.
    pub fn release_session(&self, session_id: &str) -> usize {
        let mut state = self.state.lock();
        let released = state.release_session(session_id);
        let mut resolved = self.resolved.lock();
        for id in &released {
            resolved.record(id);
        }
        released.len()
    }

    /// Drop every ticket of an agent that disconnected, crashed or was killed.
    /// Returns how many tickets were released.
    pub fn release_agent(&self, agent_id: &AgentId) -> usize {
        let mut state = self.state.lock();
        let sessions: Vec<String> = state
            .tickets
            .values()
            .filter(|ticket| ticket.agent_id == *agent_id)
            .map(|ticket| ticket.session_id.clone())
            .collect();
        let mut resolved = self.resolved.lock();
        let mut count = 0;
        for session_id in sessions {
            let released = state.release_session(&session_id);
            for id in &released {
                resolved.record(id);
            }
            count += released.len();
        }
        count
    }
}

/// Whether `option_id` appears in the immutable `options` snapshot's
/// `optionId` fields (TOCTOU re-validation).
///
/// `options` is the JSON `Value` of the `PermissionRequestEvent.options` array
/// (each element is `{optionId, name, kind, …}` per the ACP schema). We check
/// membership by `optionId` string equality so the relay does not need to
/// deserialize the full ACP `PermissionOption` struct.
fn option_id_is_valid(options: &Value, option_id: &str) -> bool {
    options.as_array().is_some_and(|arr| {
        arr.iter().any(|opt| {
            opt.get("optionId")
                .and_then(Value::as_str)
                .is_some_and(|id| id == option_id)
        })
    })
}

impl Default for PermissionRendezvous {
    fn default() -> Self {
        // `Default` is used by tests that don't exercise the agent path; a
        // no-op `AcpManager` (empty sinks) suffices for relay-side unit tests.
        Self::new(Arc::new(AcpManager::new(vec![])))
    }
}

#[cfg(test)]
mod durable_tests;
#[cfg(test)]
mod pending_tests;
#[cfg(test)]
mod question_tests;
#[cfg(test)]
mod tests;
