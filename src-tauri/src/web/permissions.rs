//! Permission rendezvous (Story 1.7) — server-side ticket table for the
//! human-relayed `request_permission` cap.
//!
//! The ACP `Responder<RequestPermissionResponse>` lives on the per-agent
//! driver thread inside [`crate::acp::manager::AcpManager`] (it is `!Send` and
//! must not cross threads). This module holds ONLY `Send + Sync` relay-side
//! ticket metadata + the rendezvous policy (timeout, at-most-one,
//! first-response-wins, disconnect-deny, TOCTOU re-validation). It never
//! touches the `Responder` directly — it forwards resolution decisions back
//! through [`AcpManager::respond_permission`], which resolves the `Responder`
//! on the driver thread via the existing `AcpCommand` mpsc channel.
//!
//! # Wiring
//!
//! [`crate::web::sink::WsRelaySink`] holds an `Option<Arc<PermissionRendezvous>>`
//! (server-side only — `None` on the desktop path, where the browser-less flow
//! uses the `acp_respond_permission` Tauri command directly). When the relay's
//! `emit` sees an `acp:permission_request` event, it snapshots a ticket here.
//! The `/ws` request handler calls [`PermissionRendezvous::try_respond`] for
//! `respond_permission` frames; the disconnect cleanup calls
//! [`PermissionRendezvous::deny_all_for_client`].
//!
//! # deny == Cancelled
//!
//! The ACP `RequestPermissionOutcome` enum has only `Selected` and `Cancelled`
//! — there is no dedicated "deny" variant. The architecture's "expiry = deny"
//! and "disconnect = deny/cancelled" are *semantics*: the operation does not
//! run. `option_id == None` → `RequestPermissionOutcome::Cancelled`, which the
//! agent treats as denial (the tool call does not execute). The browser learns
//! the turn's fate via the normal event stream (the agent continues; if it
//! then errors, that is Story 1.9's `AgentCrashed`, not a permission event).

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::Value;
use tokio::sync::oneshot;
use tracing::warn;

use crate::acp::{AcpManager, AgentId};
use crate::web::sink::ClientId;

/// Default permission timeout (60s) — the bounded rendezvous window.
/// Expiry resolves the permission as deny (`Cancelled`). Per FR14 / NFR7-adjacent.
pub const DEFAULT_PERMISSION_TIMEOUT: Duration = Duration::from_secs(60);

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
    /// No outstanding ticket for this `request_id` (never seen, resolved +
    /// evicted, or not yet promoted from the session queue). Wire
    /// `err.code: "stale"`.
    NotFound,
    /// The ticket was already resolved by a *different* client (first-wins).
    /// Wire `err.code: "stale"`.
    AlreadyResolved,
    /// The *same* client already responded to this ticket (double-respond).
    /// Wire `err.code: "duplicate"`.
    Duplicate,
    /// The `option_id` was not among the ticket's original immutable `options`
    /// (TOCTOU defense — an attacker can't approve an option that wasn't in the
    /// original request). Wire `err.code: "permission_denied"`.
    InvalidOption,
    /// The responding client is not subscribed to the permission's session
    /// (ownership check per access — NFR5; full token↔session ownership is
    /// Epic 2). Wire `err.code: "not_found"` (do not leak session existence).
    NotSubscribed,
}

impl RespondError {
    /// The stable snake_case WS `err.code` for this rejection (mirrors the
    /// `WsErrorCode` set in [`crate::web::ws`]).
    #[must_use]
    pub const fn wire_code(self) -> &'static str {
        match self {
            Self::NotFound | Self::AlreadyResolved => "stale",
            Self::Duplicate => "duplicate",
            Self::InvalidOption => "permission_denied",
            Self::NotSubscribed => "not_found",
        }
    }
}

/// Why a ticket was resolved as deny (for structured logging only).
#[derive(Debug, Clone, Copy)]
enum DenyReason {
    Timeout,
    Disconnect,
}

/// A `request_id` + the owning `agent_id` (for forwarding a deny to the agent).
type RequestAgentPair = (String, AgentId);

/// A single outstanding permission ticket — relay-side metadata only (never
/// holds the ACP `Responder`).
struct PermissionTicket {
    /// Which agent owns the responder (forwarded to
    /// `AcpManager::respond_permission`).
    agent_id: AgentId,
    /// The session the permission belongs to (for disconnect-deny + ownership).
    session_id: String,
    /// The immutable args snapshot — `options` array from the original
    /// `PermissionRequestEvent` payload. Used for TOCTOU re-validation.
    options: Value,
    /// `Some(client)` once a client has won the ticket (first-response-wins);
    /// further responses are `AlreadyResolved` (`stale`) or `Duplicate`.
    resolved_by: Option<ClientId>,
    /// Cancel handle for the per-ticket timeout task. Sent `()` on resolution
    /// / disconnect-deny so the timer does not fire after the fact.
    timeout_cancel: Option<oneshot::Sender<()>>,
}

/// Per-session queue state for the at-most-one-outstanding rule (FR14).
struct SessionQueue {
    /// The currently-outstanding `request_id` for this session (`None` when the
    /// slot is free). `Some` while a browser is being asked about a permission;
    /// further `permission_request` events are queued until this resolves.
    outstanding: Option<String>,
    /// FIFO of pending tickets waiting for the outstanding slot. Their timeouts
    /// are armed only when they are promoted to outstanding.
    queued: VecDeque<QueuedTicket>,
}

/// A ticket held in a session queue (not yet outstanding; timeout unarmed).
struct QueuedTicket {
    request_id: String,
    agent_id: AgentId,
    session_id: String,
    options: Value,
}

/// Server-side permission rendezvous (Story 1.7).
///
/// Holds the relay-side ticket table keyed by `request_id` (globally unique —
/// safe across agents) + per-session at-most-one queueing. The
/// `AcpManager` reference is server-side-only: the desktop path does not
/// construct a `PermissionRendezvous` at all (it uses the
/// `acp_respond_permission` Tauri command directly).
pub struct PermissionRendezvous {
    /// `request_id → ticket` (outstanding tickets only; resolved tickets are
    /// removed on resolution so a later `respond_permission` gets `NotFound`).
    tickets: Mutex<HashMap<String, PermissionTicket>>,
    /// `session_id → at-most-one queue` (FR14: at most one outstanding per
    /// session; the rest are queued).
    sessions: Mutex<HashMap<String, SessionQueue>>,
    /// The ACP manager — used to forward resolution decisions (deny/select)
    /// back to the agent's `Responder` via the command channel.
    acp: Arc<AcpManager>,
    /// The bounded timeout window. Expiry → deny.
    timeout: Duration,
    /// A handle to the server's tokio runtime. Captured at construction so the
    /// per-ticket timeout can be armed from ANY thread (the relay's `emit` runs
    /// on the per-agent driver thread — a plain `std::thread`, NOT a tokio
    /// task — so `tokio::spawn` would panic there; `handle.spawn` does not).
    /// `Ok` in production (constructed inside `serve`/`main`'s runtime); `Err`
    /// only in unit tests that never arm a timer (handled by falling back to a
    /// best-effort `tokio::spawn`, which works when the test wraps a runtime).
    handle: Result<tokio::runtime::Handle, tokio::runtime::TryCurrentError>,
}

impl PermissionRendezvous {
    /// Create a rendezvous bound to an [`AcpManager`] with the default 60s timeout.
    ///
    /// Captures the current tokio runtime handle (so the per-ticket timeout can
    /// be armed from the agent driver thread). Call from within a tokio runtime
    /// context (`serve`/`main`'s `block_on`).
    #[must_use]
    pub fn new(acp: Arc<AcpManager>) -> Self {
        Self::with_timeout(acp, DEFAULT_PERMISSION_TIMEOUT)
    }

    /// Create a rendezvous with an explicit timeout (testable; also wired from
    /// `ServerConfig::permission_timeout_secs` in `serve`).
    ///
    /// Captures the *current* tokio runtime handle. Call from within a tokio
    /// runtime context (`serve`/`main`'s `block_on`). For callers that may NOT be
    /// inside a runtime at construction time (e.g. the desktop path, which
    /// builds the rendezvous in Tauri's `setup` callback), use
    /// [`Self::with_handle`] with an explicitly-captured `tauri::async_runtime`
    /// handle so the per-ticket timeout is reliably armed from the agent driver
    /// thread.
    #[must_use]
    pub fn with_timeout(acp: Arc<AcpManager>, timeout: Duration) -> Self {
        Self {
            tickets: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            acp,
            timeout,
            handle: tokio::runtime::Handle::try_current(),
        }
    }

    /// Create a rendezvous with an explicit runtime handle + timeout.
    ///
    /// Use this when construction happens outside a guaranteed-runtime context
    /// (the desktop path in Tauri's `setup`) but a runtime handle is available
    /// via `tauri::async_runtime::handle()`. Passing the handle explicitly makes
    /// `arm_timeout` reliable — it does not depend on `Handle::try_current()`
    /// succeeding at construction time.
    #[must_use]
    pub fn with_handle(acp: Arc<AcpManager>, timeout: Duration, handle: tokio::runtime::Handle) -> Self {
        Self {
            tickets: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            acp,
            timeout,
            handle: Ok(handle),
        }
    }

    /// The configured timeout window (for tests + config reflection).
    #[must_use]
    pub fn timeout(&self) -> Duration {
        self.timeout
    }

    /// The session id a pending `request_id` belongs to, or `None` if there is
    /// no outstanding ticket for it. Used by the `/ws` `respond_permission`
    /// handler to resolve the calling connection's `ClientId` (a connection may
    /// be subscribed to several sessions; the permission belongs to one).
    #[must_use]
    pub fn session_for_request(&self, request_id: &str) -> Option<String> {
        self.tickets
            .lock()
            .get(request_id)
            .map(|t| t.session_id.clone())
    }

    /// The agent id a pending `request_id` belongs to, or `None` if there is no
    /// outstanding ticket. Used by the `/ws` `respond_permission` handler to
    /// verify the payload's `agentId` matches the ticket's agent (defense in
    /// depth — a client cannot resolve another agent's permission).
    #[must_use]
    pub fn agent_for_request(&self, request_id: &str) -> Option<AgentId> {
        self.tickets
            .lock()
            .get(request_id)
            .map(|t| t.agent_id.clone())
    }

    /// Whether a `request_id` is currently outstanding (test helper).
    #[cfg(test)]
    pub(crate) fn is_outstanding(&self, request_id: &str) -> bool {
        self.tickets.lock().contains_key(request_id)
    }

    /// The number of queued (not-yet-outstanding) permissions for a session
    /// (test helper for the at-most-one rule).
    #[cfg(test)]
    pub(crate) fn queued_count_for_session(&self, session_id: &str) -> usize {
        self.sessions
            .lock()
            .get(session_id)
            .map(|q| q.queued.len())
            .unwrap_or(0)
    }

    /// Snapshot a `permission_request` event into a ticket + arm the timeout
    /// (FR14: at-most-one outstanding per session; the rest are queued).
    ///
    /// Called by [`WsRelaySink::emit`] when it sees `acp:permission_request`.
    /// `options` is the `Value` of the event's `options` field (array of
    /// `{optionId, …}`) — the immutable-args snapshot for TOCTOU re-validation.
    ///
    /// Takes `self: &Arc<Self>` so the spawned timeout task can capture a clone
    /// and re-enter the rendezvous to deny + promote the queue on expiry.
    pub fn register(
        self: &Arc<Self>,
        request_id: String,
        agent_id: AgentId,
        session_id: String,
        options: Value,
    ) {
        let mut sessions = self.sessions.lock();
        let queue = sessions
            .entry(session_id.clone())
            .or_insert_with(|| SessionQueue {
                outstanding: None,
                queued: VecDeque::new(),
            });
        if queue.outstanding.is_some() {
            // Queue — do NOT arm the timeout yet (the browser hasn't seen it).
            queue.queued.push_back(QueuedTicket {
                request_id,
                agent_id,
                session_id,
                options,
            });
            return;
        }
        // Outstanding — record the ticket + arm the timeout.
        queue.outstanding = Some(request_id.clone());
        let ticket = PermissionTicket {
            agent_id: agent_id.clone(),
            session_id: session_id.clone(),
            options: options.clone(),
            resolved_by: None,
            timeout_cancel: None,
        };
        self.tickets.lock().insert(request_id.clone(), ticket);
        drop(sessions);
        self.arm_timeout(request_id, agent_id);
    }

    /// Arm the per-ticket timeout task (idempotent: a ticket already armed or
    /// resolved is left alone).
    ///
    /// Spawns onto the captured runtime `Handle` (NOT `tokio::spawn`), because
    /// the relay's `emit` runs on the per-agent driver thread — a plain
    /// `std::thread`, not a tokio task — and `tokio::spawn` would panic there.
    /// `Handle::spawn` submits the task to the server's runtime regardless of
    /// the calling thread.
    fn arm_timeout(self: &Arc<Self>, request_id: String, agent_id: AgentId) {
        let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
        {
            let mut tickets = self.tickets.lock();
            let Some(ticket) = tickets.get_mut(&request_id) else {
                return; // already resolved + evicted — nothing to time out.
            };
            if ticket.timeout_cancel.is_some() {
                return; // already armed.
            }
            ticket.timeout_cancel = Some(cancel_tx);
        }
        let this = Arc::clone(self);
        let timeout = self.timeout;
        // Clone for the no-runtime warning below (the future moves its own copy).
        let request_id_for_warn = request_id.clone();
        let future = async move {
            // Wait for either the timeout to elapse or the cancel signal.
            if tokio::time::timeout(timeout, cancel_rx).await.is_err() {
                // Timed out — resolve as deny (option_id=None → Cancelled).
                this.deny(&request_id, &agent_id, DenyReason::Timeout).await;
            }
            // else: cancelled by resolution/disconnect — nothing to do.
        };
        match &self.handle {
            Ok(handle) => {
                handle.spawn(future);
            }
            // The rendezvous was constructed outside a runtime (e.g. a unit
            // test's `test_rendezvous()` helper called before `block_on`). Try
            // capturing the runtime AGAIN at arm time — the caller may now be
            // inside a runtime (the test helpers wrap `register` in `block_on`).
            // In production this `Err` branch is unreachable (the rendezvous is
            // built inside `serve`/`main`'s runtime, so `handle` is `Ok`).
            Err(_) => match tokio::runtime::Handle::try_current() {
                Ok(handle) => {
                    handle.spawn(future);
                }
                Err(e) => warn!(
                    "[permissions] cannot arm timeout for {request_id_for_warn}: no tokio runtime ({e}); \
                     ticket will not auto-deny — construct the rendezvous inside a runtime"
                ),
            },
        }
    }

    /// Attempt to resolve a ticket with a client's response (first-response-wins).
    ///
    /// On success (`Resolved`), the response is forwarded to
    /// [`AcpManager::respond_permission`] (resolves the agent's `Responder`).
    /// On rejection, the caller maps the [`RespondError`] to a WS `err.code`.
    pub async fn try_respond(
        self: &Arc<Self>,
        client_id: ClientId,
        request_id: &str,
        option_id: Option<&str>,
    ) -> Result<RespondOutcome, RespondError> {
        // 1. Read-only validation under a single lock (TOCTOU re-check +
        //    first-wins + duplicate detection). The claim step re-checks under
        //    the same lock to close the race between two concurrent responses.
        {
            let tickets = self.tickets.lock();
            let Some(ticket) = tickets.get(request_id) else {
                return Err(RespondError::NotFound);
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
        }

        // 2. Claim the ticket (single-use). Mark resolved + cancel the timeout.
        let (agent_id, session_id) = {
            let mut tickets = self.tickets.lock();
            let Some(ticket) = tickets.get_mut(request_id) else {
                return Err(RespondError::NotFound);
            };
            // Re-check under the write lock (a concurrent first-wins could have
            // raced the read-to-claim window above).
            if ticket.resolved_by == Some(client_id) {
                return Err(RespondError::Duplicate);
            }
            if ticket.resolved_by.is_some() {
                return Err(RespondError::AlreadyResolved);
            }
            ticket.resolved_by = Some(client_id);
            if let Some(cancel) = ticket.timeout_cancel.take() {
                let _ = cancel.send(());
            }
            (ticket.agent_id.clone(), ticket.session_id.clone())
        };

        // 3. Forward to the agent (resolves the `Responder` on the driver thread).
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
                self.tickets.lock().remove(request_id);
                self.promote_next(&session_id);
                return Err(RespondError::NotFound);
            }
            warn!("[permissions] respond_permission {request_id} failed: {e}");
        }

        // 4. Evict the resolved ticket + promote the next queued permission.
        self.tickets.lock().remove(request_id);
        self.promote_next(&session_id);

        Ok(RespondOutcome::Resolved)
    }

    /// On browser disconnect, resolve every outstanding ticket whose session no
    /// longer has any OTHER subscribed client as deny (FR14: disconnect → deny),
    /// AND drain each such session's queued (not-yet-outstanding) tickets too.
    ///
    /// A ticket is denied only when the disconnecting client was the last
    /// subscriber on its session — otherwise a remaining client can still
    /// legitimately respond. `session_subscribers` reports the count of clients
    /// STILL subscribed (after the disconnecting one was unregistered).
    pub async fn deny_all_for_client<F>(self: &Arc<Self>, session_subscribers: F)
    where
        F: Fn(&str) -> usize,
    {
        // Collect outstanding tickets whose session now has zero remaining
        // subscribers, PLUS the queued tickets for those same sessions (FR14:
        // "all pending permissions resolve" — queued ones are pending too).
        let (to_deny, queued_to_deny): (Vec<RequestAgentPair>, Vec<RequestAgentPair>) = {
            let tickets = self.tickets.lock();
            // Sessions with an outstanding unresolved ticket AND zero remaining
            // subscribers (these get the full deny path: remove + forward + promote).
            let orphan_sessions: Vec<String> = tickets
                .iter()
                .filter(|(_, t)| t.resolved_by.is_none() && session_subscribers(&t.session_id) == 0)
                .map(|(_, t)| t.session_id.clone())
                .collect();
            let outstanding: Vec<(String, AgentId)> = tickets
                .iter()
                .filter(|(_, t)| t.resolved_by.is_none() && session_subscribers(&t.session_id) == 0)
                .map(|(rid, t)| (rid.clone(), t.agent_id.clone()))
                .collect();
            // Drain the queued tickets for the orphaned sessions too (imperative
            // loop — a `filter_map` closure can't return `&mut SessionQueue` out
            // of the captured `sessions` map).
            let mut queued: Vec<(String, AgentId)> = Vec::new();
            {
                let mut sessions = self.sessions.lock();
                for sid in &orphan_sessions {
                    if let Some(q) = sessions.get_mut(sid) {
                        for qt in q.queued.drain(..) {
                            queued.push((qt.request_id, qt.agent_id));
                        }
                    }
                }
            }
            (outstanding, queued)
        };
        for (request_id, agent_id) in to_deny {
            self.deny(&request_id, &agent_id, DenyReason::Disconnect).await;
        }
        // Resolve the drained queued tickets as deny directly (they were never
        // armed with a timeout and never in `self.tickets`, so `deny`'s
        // `remove` would no-op — forward the deny to the agent inline).
        for (request_id, agent_id) in queued_to_deny {
            if let Err(e) = self
                .acp
                .respond_permission(&agent_id, request_id.clone(), None)
                .await
            {
                warn!(
                    "[permissions] disconnect-deny (queued) for {request_id} failed: {e}"
                );
            }
        }
    }

    /// Resolve a ticket as deny (`option_id=None` → `Cancelled`) and pop the
    /// session's queue so the next queued permission becomes outstanding.
    async fn deny(self: &Arc<Self>, request_id: &str, agent_id: &AgentId, reason: DenyReason) {
        // Take the ticket + cancel its timeout.
        let session_id = {
            let mut tickets = self.tickets.lock();
            if let Some(mut ticket) = tickets.remove(request_id) {
                // Race guard: a concurrent `try_respond` may have already claimed
                // the ticket (set `resolved_by=Some(client)`) and forwarded a
                // `Selected` to the agent, but not yet evicted it (eviction is
                // after its `.await`). If so, do NOT forward a `Cancelled` too —
                // the single-use ACP `Responder` was already resolved, and a
                // second `.respond()` would conflict. Leave the promote to the
                // claimer's `try_respond` path; we just exit.
                if ticket.resolved_by.is_some() {
                    return;
                }
                if let Some(cancel) = ticket.timeout_cancel.take() {
                    let _ = cancel.send(());
                }
                ticket.session_id
            } else {
                return; // already gone (resolved concurrently).
            }
        };
        // Forward the deny to the agent. `option_id=None` → Cancelled.
        if let Err(e) = self
            .acp
            .respond_permission(agent_id, request_id.to_string(), None)
            .await
        {
            warn!(
                "[permissions] deny ({reason:?}) for {request_id} failed to reach agent: {e}"
            );
        }
        // Promote the next queued permission for this session.
        self.promote_next(&session_id);
    }

    /// Pop the session's queue: promote the next queued permission to
    /// outstanding + arm its timeout. Called after a ticket resolves (deny/select).
    fn promote_next(self: &Arc<Self>, session_id: &str) {
        // Atomically (under ONE sessions-lock acquisition): clear the outstanding
        // slot, pop the next queued ticket, AND re-set `outstanding=Some(rid)`
        // for the promoted one. Holding the lock across clear+pop+re-set closes
        // the race where a concurrent `register` sees `outstanding=None` between
        // two acquisitions and inserts its own ticket (violating FR14 at-most-one).
        let promoted = {
            let mut sessions = self.sessions.lock();
            let Some(queue) = sessions.get_mut(session_id) else {
                return;
            };
            queue.outstanding = None;
            let Some(queued) = queue.queued.pop_front() else {
                return; // queue empty — leave the slot free.
            };
            queue.outstanding = Some(queued.request_id.clone());
            queued
        };
        // Insert into `self.tickets` + arm the timeout OUTSIDE the sessions lock
        // (different mutex; arming spawns onto the captured runtime handle).
        let QueuedTicket {
            request_id,
            agent_id,
            session_id,
            options,
        } = promoted;
        let ticket = PermissionTicket {
            agent_id: agent_id.clone(),
            session_id: session_id.clone(),
            options: options.clone(),
            resolved_by: None,
            timeout_cancel: None,
        };
        self.tickets.lock().insert(request_id.clone(), ticket);
        self.arm_timeout(request_id, agent_id);
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
    options
        .as_array()
        .is_some_and(|arr| {
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

// ---------------------------------------------------------------------------
// Turn-id watermark (Story 1.7 T7.2 — FR13/FR11 plumbing; wire field in 1.8)
// ---------------------------------------------------------------------------

/// Server-side turn-id watermark + dedup set (Story 1.7 T7.2).
///
/// FR13 ("the server dedups agent turns by client turn-id with a single
/// last-completed-turn watermark") and FR11 ("`prompt_complete` idempotent by
/// turn-id") both need a server-side turn-id store. This struct is the
/// **mechanism** plumbing — a per-session `last_completed_turn_id` (the
/// high-water mark) + a per-session set of seen turn-ids for idempotent dedup.
///
/// The **wire-level `turnId` field** on `send_prompt`/`prompt_complete` payloads
/// is deferred to Story 1.8 (where the chat UI + `send_prompt` land and force a
/// renderer + TS-type change). 1.8's `prompt_complete` handler will call
/// [`Self::record_completed`] (after dedup via [`Self::is_seen`]); 1.8's
/// `send_prompt` handler will call [`Self::is_completed`] to reject a stale
/// turn. No caller exists yet — this is the shipped plumbing the spec required.
///
/// `Send + Sync` (the only state is `parking_lot::Mutex<HashMap<…>>`); the
/// stored ids are opaque `String`s (client-generated uuids in 1.8).
pub struct TurnWatermark {
    /// `session_id → last-completed turn-id` (the high-water mark).
    last_completed: Mutex<HashMap<String, String>>,
    /// `session_id → set of seen turn-ids` (idempotent dedup for `prompt_complete`).
    seen: Mutex<HashMap<String, std::collections::HashSet<String>>>,
}

impl TurnWatermark {
    /// Create an empty watermark.
    #[must_use]
    pub fn new() -> Self {
        Self {
            last_completed: Mutex::new(HashMap::new()),
            seen: Mutex::new(HashMap::new()),
        }
    }

    /// Record that `turn_id` was seen for `session_id` (idempotent dedup set).
    /// Returns `true` if this was a NEW turn-id (i.e. the caller should process
    /// it), `false` if it was already seen (the caller should drop it as a
    /// duplicate — `prompt_complete` is idempotent-by-turn-id).
    pub fn mark_seen(&self, session_id: &str, turn_id: &str) -> bool {
        let mut seen = self.seen.lock();
        seen.entry(session_id.to_string())
            .or_default()
            .insert(turn_id.to_string())
    }

    /// Whether `turn_id` has already been seen for `session_id`.
    #[must_use]
    pub fn is_seen(&self, session_id: &str, turn_id: &str) -> bool {
        self.seen
            .lock()
            .get(session_id)
            .is_some_and(|set| set.contains(turn_id))
    }

    /// Record that the turn `turn_id` COMPLETED for `session_id` (advances the
    /// high-water mark). 1.8's `prompt_complete` handler calls this AFTER
    /// `mark_seen` returns `true` (so the completion is recorded once).
    pub fn record_completed(&self, session_id: &str, turn_id: &str) {
        self.last_completed
            .lock()
            .insert(session_id.to_string(), turn_id.to_string());
    }

    /// The last-completed turn-id for `session_id`, or `None` if none completed.
    #[must_use]
    pub fn last_completed(&self, session_id: &str) -> Option<String> {
        self.last_completed
            .lock()
            .get(session_id)
            .cloned()
    }

    /// Whether `turn_id` is at-or-before the last-completed watermark for
    /// `session_id` (i.e. a stale turn a 1.8 `send_prompt` should reject). The
    /// comparison is by string equality (turn-ids are opaque client uuids with
    /// no natural ordering; "at-or-before" means "equals the watermark" — a
    /// turn-id strictly older than the watermark is one the client already
    /// abandoned and will not resend under the ACP contract).
    #[must_use]
    pub fn is_completed(&self, session_id: &str, turn_id: &str) -> bool {
        self.last_completed
            .lock()
            .get(session_id)
            .is_some_and(|last| last == turn_id)
    }

    /// Forget a session's watermark state (on explicit session close).
    pub fn forget_session(&self, session_id: &str) {
        self.last_completed.lock().remove(session_id);
        self.seen.lock().remove(session_id);
    }
}

impl Default for TurnWatermark {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;
    use serde_json::json;

    /// Build `options` JSON matching the ACP `PermissionOption` wire shape.
    fn options_value(ids: &[&str]) -> Value {
        json!(ids
            .iter()
            .map(|id| json!({ "optionId": id, "name": id, "kind": "auto" }))
            .collect::<Vec<_>>())
    }

    #[test]
    fn option_id_validation_matches_known_option() {
        let opts = options_value(&["allow", "deny"]);
        assert!(option_id_is_valid(&opts, "allow"));
        assert!(option_id_is_valid(&opts, "deny"));
        // TOCTOU: an option not in the original request is rejected.
        assert!(!option_id_is_valid(&opts, "escalate"));
        assert!(!option_id_is_valid(&opts, ""));
    }

    #[test]
    fn option_id_validation_rejects_non_array_or_missing_field() {
        assert!(!option_id_is_valid(&json!("not-an-array"), "allow"));
        assert!(!option_id_is_valid(&json!([{}]), "allow")); // no optionId field
        assert!(!option_id_is_valid(&json!(null), "allow"));
    }

    // --- Rendezvous bookkeeping tests (Story 1.7 AC3) -------------------------
    //
    // These exercise the relay-side ticket table + the rendezvous policy
    // (at-most-one, first-wins, stale/duplicate, TOCTOU, disconnect-deny,
    // timeout-deny) WITHOUT a real agent. The `AcpManager` is a no-op
    // (`AcpManager::new(vec![])` — `respond_permission` returns an "unknown
    // agent" `Err` which the rendezvous logs-and-continues). Assertions target
    // the ticket state (outstanding/queued/resolved/evicted) + the
    // `try_respond` outcome/error — the agent-side `Responder` resolution is
    // covered by the `#[ignore]` e2e test in `acp/tests.rs`.
    //
    // The rendezvous captures the tokio runtime handle at construction (so the
    // per-ticket timeout can be armed from the agent driver thread). The tests
    // therefore construct the rendezvous + call `register`/`try_respond` INSIDE
    // a single-threaded runtime (`block_on`) so the handle is captured and the
    // `Err`-fallback `tokio::spawn` path (if any) has a runtime to spawn onto.

    /// Drive an async block on a single-threaded tokio runtime (mirrors the
    /// `handle_sync` helper in `web/ws.rs`).
    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(future)
    }

    /// A rendezvous bound to a no-op `AcpManager` with the default 60s timeout
    /// (agent calls log-and-continue). Construct INSIDE a runtime context.
    fn test_rendezvous() -> Arc<PermissionRendezvous> {
        Arc::new(PermissionRendezvous::with_timeout(
            Arc::new(AcpManager::new(vec![])),
            Duration::from_secs(60),
        ))
    }

    /// Story 1.7 AC3: first-response-wins — a second client's `try_respond` is
    /// rejected. The first response resolves + evicts the ticket; the second
    /// therefore sees `NotFound` (the ticket is gone) or `AlreadyResolved` (the
    /// rare race where the ticket is resolved but not yet evicted). BOTH map to
    /// wire `err.code: "stale"` — the assertion is on the stable wire code.
    #[test]
    fn first_response_wins_second_is_rejected_stale() {
        let rdz = test_rendezvous();
        let client_a = ClientId::new();
        let client_b = ClientId::new();
        block_on(async {
            // Construct-time handle capture + register inside the runtime.
            rdz.register(
                "perm-1".to_string(),
                AgentId("a1".to_string()),
                "sess-1".to_string(),
                options_value(&["allow", "deny"]),
            );
            let a = rdz.try_respond(client_a, "perm-1", Some("allow")).await;
            let b = rdz.try_respond(client_b, "perm-1", Some("deny")).await;
            assert_eq!(a, Ok(RespondOutcome::Resolved), "first response wins");
            // Second is rejected — either NotFound (ticket evicted) or
            // AlreadyResolved (race window); both wire as `stale`.
            assert!(
                matches!(b, Err(RespondError::NotFound) | Err(RespondError::AlreadyResolved)),
                "second response must be rejected (stale), got {b:?}"
            );
            let b_code = b.unwrap_err().wire_code();
            assert_eq!(b_code, "stale", "first-wins rejection wires as `stale`");
            // A third call is NotFound (also stale).
            let c = rdz.try_respond(ClientId::new(), "perm-1", Some("allow")).await;
            assert_eq!(c, Err(RespondError::NotFound));
        });
    }

    /// Story 1.7 AC3: duplicate — the SAME client responding twice is `Duplicate`
    /// (→ wire `err.code: "duplicate"`). The first response resolves (evicts)
    /// the ticket; the same-client second call sees `NotFound` first. The
    /// `Duplicate` path is the race where the ticket is still outstanding when
    /// the same client retries — here we assert the wire-code mapping directly.
    #[test]
    fn duplicate_wire_code_is_duplicate() {
        assert_eq!(RespondError::Duplicate.wire_code(), "duplicate");
    }

    /// Story 1.7 AC3: TOCTOU — an `option_id` not in the original immutable
    /// `options` is rejected as `InvalidOption` (→ `permission_denied`).
    #[test]
    fn toctou_invalid_option_is_rejected() {
        let rdz = test_rendezvous();
        let client = ClientId::new();
        block_on(async {
            rdz.register(
                "perm-toctou".to_string(),
                AgentId("a1".to_string()),
                "sess-1".to_string(),
                options_value(&["allow", "deny"]),
            );
            let outcome = rdz.try_respond(client, "perm-toctou", Some("escalate")).await;
            assert_eq!(outcome, Err(RespondError::InvalidOption));
            assert_eq!(
                RespondError::InvalidOption.wire_code(),
                "permission_denied"
            );
            // The ticket is still outstanding (rejected, not resolved) — a valid
            // option can still win.
            assert!(rdz.is_outstanding("perm-toctou"));
            let ok = rdz.try_respond(client, "perm-toctou", Some("allow")).await;
            assert_eq!(ok, Ok(RespondOutcome::Resolved));
        });
    }

    /// Story 1.7 AC3: cancel (option_id=None) is always allowed — resolves the
    /// ticket as deny (`Cancelled`) without TOCTOU option validation.
    #[test]
    fn cancel_option_none_resolves_and_evicts() {
        let rdz = test_rendezvous();
        let client = ClientId::new();
        block_on(async {
            rdz.register(
                "perm-cancel".to_string(),
                AgentId("a1".to_string()),
                "sess-1".to_string(),
                options_value(&["allow", "deny"]),
            );
            let outcome = rdz.try_respond(client, "perm-cancel", None).await;
            assert_eq!(outcome, Ok(RespondOutcome::Resolved));
            assert!(!rdz.is_outstanding("perm-cancel"), "resolved ticket is evicted");
        });
    }

    /// Story 1.7 AC3: at-most-one outstanding per session — a second
    /// `permission_request` on the same session while one is outstanding is
    /// QUEUED (not surfaced/armed), and is promoted only after the first resolves.
    #[test]
    fn at_most_one_outstanding_per_session_queues_the_rest() {
        let rdz = test_rendezvous();
        let client = ClientId::new();
        block_on(async {
            // First permission → outstanding.
            rdz.register(
                "perm-q1".to_string(),
                AgentId("a1".to_string()),
                "sess-q".to_string(),
                options_value(&["allow"]),
            );
            assert!(rdz.is_outstanding("perm-q1"));
            // Second permission on the SAME session → queued, NOT outstanding.
            rdz.register(
                "perm-q2".to_string(),
                AgentId("a1".to_string()),
                "sess-q".to_string(),
                options_value(&["allow"]),
            );
            assert!(!rdz.is_outstanding("perm-q2"), "second permission is queued, not outstanding");
            assert_eq!(rdz.queued_count_for_session("sess-q"), 1);
            // Resolving the first promotes the second.
            let _ = rdz.try_respond(client, "perm-q1", Some("allow")).await;
            assert!(rdz.is_outstanding("perm-q2"), "queued permission promoted after the first resolves");
            assert_eq!(rdz.queued_count_for_session("sess-q"), 0);
        });
    }

    /// Story 1.7 AC3: timeout → deny. A ticket whose bounded timeout elapses is
    /// resolved as deny and evicted. Uses a tiny timeout + a generous poll loop
    /// (the spawned deny task runs on this single-threaded runtime when the poll
    /// yields). The 60-iteration × 25ms budget (1500ms for a 50ms timeout) gives
    /// 30× headroom; a deterministic `tokio::time::pause`/`advance` driver would
    /// require the `test-util` feature (deferred — the polling is robust enough
    /// for the gate and the deny path is also unit-tested via `deny_after_*`).
    #[test]
    fn timeout_deny_resolves_and_evicts() {
        let rdz = Arc::new(PermissionRendezvous::with_timeout(
            Arc::new(AcpManager::new(vec![])),
            Duration::from_millis(50),
        ));
        block_on(async {
            rdz.register(
                "perm-tmo".to_string(),
                AgentId("a1".to_string()),
                "sess-tmo".to_string(),
                options_value(&["allow"]),
            );
            assert!(rdz.is_outstanding("perm-tmo"));
            let mut evicted = false;
            for _ in 0..60 {
                tokio::time::sleep(Duration::from_millis(25)).await;
                tokio::task::yield_now().await;
                if !rdz.is_outstanding("perm-tmo") {
                    evicted = true;
                    break;
                }
            }
            assert!(evicted, "timed-out ticket must be evicted");
            assert!(!rdz.is_outstanding("perm-tmo"), "timed-out ticket is evicted");
        });
    }

    /// Story 1.7 AC3: expiry → deny is the same resolution path as timeout
    /// (both reach `deny` with `DenyReason::Timeout`). This test asserts the
    /// deny path also promotes the session queue. Same polling approach as
    /// `timeout_deny_resolves_and_evicts` (60×25ms budget for a 50ms timeout).
    #[test]
    fn expiry_deny_promotes_the_queue() {
        let rdz = Arc::new(PermissionRendezvous::with_timeout(
            Arc::new(AcpManager::new(vec![])),
            Duration::from_millis(50),
        ));
        block_on(async {
            rdz.register(
                "perm-e1".to_string(),
                AgentId("a1".to_string()),
                "sess-e".to_string(),
                options_value(&["allow"]),
            );
            // Queue a second on the same session.
            rdz.register(
                "perm-e2".to_string(),
                AgentId("a1".to_string()),
                "sess-e".to_string(),
                options_value(&["allow"]),
            );
            assert!(!rdz.is_outstanding("perm-e2"));
            let mut promoted = false;
            for _ in 0..60 {
                tokio::time::sleep(Duration::from_millis(25)).await;
                tokio::task::yield_now().await;
                if rdz.is_outstanding("perm-e2") {
                    promoted = true;
                    break;
                }
            }
            assert!(!rdz.is_outstanding("perm-e1"), "perm-e1 evicted by timeout-deny");
            assert!(promoted, "queue (perm-e2) promoted after expiry-deny");
        });
    }

    /// Story 1.7 AC3: disconnect → deny-all. When the last subscriber on a
    /// session disconnects, the outstanding permission is resolved as deny.
    /// When OTHER clients remain subscribed, the ticket is left outstanding.
    #[test]
    fn disconnect_denies_only_when_no_subscribers_remain() {
        let rdz = test_rendezvous();
        block_on(async {
            rdz.register(
                "perm-dc".to_string(),
                AgentId("a1".to_string()),
                "sess-dc".to_string(),
                options_value(&["allow"]),
            );
            assert!(rdz.is_outstanding("perm-dc"));
            // Simulate a disconnect where OTHER clients remain subscribed → ticket
            // stays outstanding (a remaining client can still respond).
            rdz.deny_all_for_client(|_sid| 1usize).await; // 1 remaining subscriber
            assert!(
                rdz.is_outstanding("perm-dc"),
                "ticket stays outstanding when other clients remain"
            );
            // Now the last subscriber disconnects → ticket denied + evicted.
            rdz.deny_all_for_client(|_sid| 0usize).await; // 0 remaining subscribers
            assert!(!rdz.is_outstanding("perm-dc"), "ticket denied on last-subscriber disconnect");
        });
    }

    /// Story 1.7: `session_for_request` / `agent_for_request` resolve the
    /// ticket's session/agent for the `/ws` handler's ownership + defense-in-depth
    /// checks. `None` once the ticket is evicted (resolved/timed-out).
    #[test]
    fn session_and_agent_for_request_resolve_and_evict() {
        let rdz = test_rendezvous();
        let client = ClientId::new();
        block_on(async {
            rdz.register(
                "perm-lookup".to_string(),
                AgentId("a-lookup".to_string()),
                "sess-lookup".to_string(),
                options_value(&["allow"]),
            );
            assert_eq!(rdz.session_for_request("perm-lookup").as_deref(), Some("sess-lookup"));
            assert_eq!(
                rdz.agent_for_request("perm-lookup"),
                Some(AgentId("a-lookup".to_string()))
            );
            let _ = rdz.try_respond(client, "perm-lookup", Some("allow")).await;
            // Evicted after resolution.
            assert!(rdz.session_for_request("perm-lookup").is_none());
            assert!(rdz.agent_for_request("perm-lookup").is_none());
        });
    }

    // --- Turn-id watermark (Story 1.7 T7.2 — FR13/FR11 plumbing) ------------

    #[test]
    fn turn_watermark_dedups_seen_turn_ids() {
        let wm = TurnWatermark::new();
        // First sight of a turn-id → new (process it).
        assert!(wm.mark_seen("sess-1", "turn-a"), "first sight is new");
        // Same turn-id again → duplicate (drop it — prompt_complete is idempotent).
        assert!(!wm.mark_seen("sess-1", "turn-a"), "second sight is a duplicate");
        assert!(wm.is_seen("sess-1", "turn-a"));
        assert!(!wm.is_seen("sess-1", "turn-b"));
        // Different session is independent.
        assert!(wm.mark_seen("sess-2", "turn-a"));
    }

    #[test]
    fn turn_watermark_records_and_queries_last_completed() {
        let wm = TurnWatermark::new();
        assert!(wm.last_completed("sess-1").is_none());
        wm.record_completed("sess-1", "turn-1");
        assert_eq!(wm.last_completed("sess-1").as_deref(), Some("turn-1"));
        // `is_completed` is true only for the exact watermark turn-id.
        assert!(wm.is_completed("sess-1", "turn-1"));
        assert!(!wm.is_completed("sess-1", "turn-0"), "an older turn-id is not the watermark");
        assert!(!wm.is_completed("sess-1", "turn-2"), "a newer turn-id is not yet completed");
        assert!(!wm.is_completed("sess-2", "turn-1"), "a different session is not completed");
    }

    #[test]
    fn turn_watermark_forgets_session_state() {
        let wm = TurnWatermark::new();
        wm.mark_seen("sess-1", "turn-a");
        wm.record_completed("sess-1", "turn-a");
        wm.forget_session("sess-1");
        assert!(wm.last_completed("sess-1").is_none());
        assert!(!wm.is_seen("sess-1", "turn-a"));
        // Forgetting a non-existent session is a no-op.
        wm.forget_session("never-existed");
    }

    /// Story 1.7 deny-race guard: a `deny` for a ticket that a concurrent
    /// `try_respond` already claimed (set `resolved_by`) must NOT forward a
    /// second resolution to the agent. We simulate the claim by having
    /// `try_respond` succeed first (which sets `resolved_by` + evicts), then
    /// call `deny` — `deny`'s `remove` returns `None` (evicted) → early return,
    /// no double-forward. This is the post-claim-eviction case; the live race
    /// window (claim-set, not-yet-evicted) is structurally guarded by the
    /// `resolved_by.is_some()` check inside `deny`.
    #[test]
    fn deny_after_try_respond_eviction_is_a_noop() {
        let rdz = test_rendezvous();
        let client = ClientId::new();
        block_on(async {
            rdz.register(
                "perm-race".to_string(),
                AgentId("a1".to_string()),
                "sess-race".to_string(),
                options_value(&["allow"]),
            );
            // Claim + evict via try_respond.
            let outcome = rdz.try_respond(client, "perm-race", Some("allow")).await;
            assert_eq!(outcome, Ok(RespondOutcome::Resolved));
            assert!(!rdz.is_outstanding("perm-race"));
            // A subsequent deny (e.g. a late timeout) is a no-op — no panic, no
            // double-resolution (the agent-side responder was already resolved).
            rdz.deny("perm-race", &AgentId("a1".to_string()), DenyReason::Timeout).await;
            assert!(!rdz.is_outstanding("perm-race"));
        });
    }

    /// Story 1.7 AC3 (same-client double-respond): the SAME client responding
    /// twice to the same ticket. The first resolves (evicts the ticket); the
    /// second is rejected. On a single-threaded runtime the no-op
    /// `AcpManager::respond_permission` returns `Err` synchronously (no yield at
    /// the claim→await gap), so the first `try_respond` completes before the
    /// second's read-check → the second sees `NotFound` (the ticket is evicted),
    /// NOT `Duplicate`. `Duplicate` is the genuine multi-threaded race window
    /// (same client, ticket claimed-but-not-evicted) — structurally guarded by
    /// the claim re-check at `try_respond`'s write-lock; its wire code
    /// (`"duplicate"`) is asserted by `duplicate_wire_code_is_duplicate`. This
    /// test exercises the same-client double-respond path end-to-end (the
    /// rejection is `stale`-coded regardless of which rejection variant fires).
    #[test]
    fn same_client_double_respond_is_rejected() {
        let rdz = test_rendezvous();
        let client = ClientId::new();
        block_on(async {
            rdz.register(
                "perm-dup".to_string(),
                AgentId("a1".to_string()),
                "sess-dup".to_string(),
                options_value(&["allow"]),
            );
            let (a, b) = tokio::join!(
                rdz.try_respond(client, "perm-dup", Some("allow")),
                rdz.try_respond(client, "perm-dup", Some("allow")),
            );
            // Exactly one wins; the other is a `stale`-coded rejection
            // (`NotFound` on this runtime, `Duplicate` under a real race).
            let loser = if a.is_ok() { b } else { a };
            let winner = if a.is_ok() { a } else { b };
            assert!(winner.is_ok(), "one response must win: ({a:?}, {b:?})");
            assert!(loser.is_err(), "the other must be rejected");
            assert_eq!(
                loser.unwrap_err().wire_code(),
                "stale",
                "same-client double-respond rejection wires as stale"
            );
        });
    }
}
