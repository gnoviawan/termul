//! Per-client subscription registry and delivery of the relay: who is
//! subscribed to what, the bounded per-subscription channel, the non-blocking
//! per-client push used inside the publish critical section, and the
//! [`EventSink`] entry point the ACP dispatcher emits through.
//!
//! Every subscription owns a BOUNDED channel into the connection's forwarder
//! (`ws/subscribe.rs`). Fan-out never waits for it: a full channel drops a
//! LOSSY event and queues one `gap` frame once there is room again (the client
//! then installs a snapshot), and closes the connection for any other tier (the
//! client resumes by cursor). No unbounded queue stands behind a slow peer.

use std::collections::{HashMap, HashSet, VecDeque};

use serde_json::Value;
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TrySendError;
use tokio_util::sync::CancellationToken;
use tracing::warn;
use uuid::Uuid;

use crate::web::ws::{tier_of, ReliabilityTier, SequencedEvent};

#[cfg(test)]
use super::session_log::SessionState;
use super::{AcpEvent, EventSink, WsRelaySink};

/// One item of a subscription's stream towards its connection.
#[derive(Debug, Clone)]
pub enum StreamItem {
    /// A sequenced session event.
    Event(SequencedEvent),
    /// LOSSY events for this session were dropped ahead of this point: the
    /// client must install a snapshot.
    Gap(String),
}

impl StreamItem {
    /// The session the item belongs to.
    fn into_sid(self) -> Option<String> {
        match self {
            Self::Event(event) => event.sid,
            Self::Gap(sid) => Some(sid),
        }
    }
}

/// What a subscription yields to its connection: the replay found at
/// registration (all `seq <= headSeq`), then the live items. The replay is
/// handed over as a batch because it can exceed the live channel's bound; the
/// forwarder waits on the connection queue for it, so a stalled peer is still
/// closed by the overflow tolerance.
pub struct EventStream {
    replay: VecDeque<SequencedEvent>,
    live: mpsc::Receiver<StreamItem>,
}

impl EventStream {
    pub(super) fn new(replay: Vec<SequencedEvent>, live: mpsc::Receiver<StreamItem>) -> Self {
        Self {
            replay: replay.into(),
            live,
        }
    }

    /// The next item, waiting for one. `None` once the subscription ended and
    /// everything it held was drained.
    pub async fn recv(&mut self) -> Option<StreamItem> {
        if let Some(event) = self.replay.pop_front() {
            return Some(StreamItem::Event(event));
        }
        self.live.recv().await
    }

    /// The next item if one is ready.
    ///
    /// # Errors
    ///
    /// [`mpsc::error::TryRecvError::Empty`] while nothing is ready,
    /// `Disconnected` once the subscription ended and was drained.
    pub fn try_recv(&mut self) -> Result<StreamItem, mpsc::error::TryRecvError> {
        if let Some(event) = self.replay.pop_front() {
            return Ok(StreamItem::Event(event));
        }
        self.live.try_recv()
    }
}

/// Per-client subscription state.
pub(super) struct ClientSub {
    /// Bounded channel into the connection's forwarder.
    tx: mpsc::Sender<StreamItem>,
    /// Closes the connection this subscription belongs to.
    closing: CancellationToken,
    /// Sessions this client is subscribed to.
    sessions: HashSet<String>,
    /// Sessions whose LOSSY events were dropped since the last `gap` frame
    /// reached the channel.
    gap_pending: HashSet<String>,
}

/// What one push into a client's channel did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Push {
    /// The event is queued.
    Delivered,
    /// The channel was full and the event was LOSSY: dropped, `gap` pending.
    Dropped,
    /// The channel was full and the event must not be lost: the peer is
    /// hopelessly behind.
    Overflow,
    /// The forwarder is gone (the connection ended).
    Gone,
}

impl ClientSub {
    /// Queue one event without waiting. A pending `gap` frame goes first so
    /// the client learns about the hole before it sees the next event.
    fn push(&mut self, se: SequencedEvent, tier: ReliabilityTier) -> Push {
        let pending_gap = se
            .sid
            .as_deref()
            .filter(|sid| self.gap_pending.contains(*sid))
            .map(str::to_string);
        if let Some(sid) = pending_gap {
            match self.tx.try_send(StreamItem::Gap(sid.clone())) {
                Ok(()) => {
                    self.gap_pending.remove(&sid);
                }
                Err(TrySendError::Full(_)) => return self.full(Some(sid), tier),
                Err(TrySendError::Closed(_)) => return Push::Gone,
            }
        }
        match self.tx.try_send(StreamItem::Event(se)) {
            Ok(()) => Push::Delivered,
            Err(TrySendError::Full(item)) => self.full(item.into_sid(), tier),
            Err(TrySendError::Closed(_)) => Push::Gone,
        }
    }

    /// The channel had no room for an item of session `sid`.
    fn full(&mut self, sid: Option<String>, tier: ReliabilityTier) -> Push {
        let label = sid.as_deref().map_or_else(
            || "-".to_string(),
            crate::logging::redact_session_id,
        );
        if tier != ReliabilityTier::Lossy {
            warn!(
                "[ws] subscriber for session {label} cannot keep up with a {tier:?} event; \
                 closing its connection so it resumes by cursor"
            );
            return Push::Overflow;
        }
        if let Some(sid) = sid {
            if self.gap_pending.insert(sid) {
                warn!(
                    "[ws] slow subscriber for session {label}: dropped a lossy event; \
                     a gap frame follows once it drains"
                );
            }
        }
        Push::Dropped
    }
}

/// Opaque per-connection client id (uuid v4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ClientId(Uuid);

impl ClientId {
    /// Generate a new random client id.
    #[must_use]
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for ClientId {
    fn default() -> Self {
        Self::new()
    }
}

impl WsRelaySink {
    /// Fan one just-assigned event out to every subscriber of `sid`. Runs
    /// inside the publish critical section (`sessions` held): lock order
    /// `sessions` → `clients`, with `session_subs` read first and released.
    /// Never blocks.
    pub(super) fn fan_out_locked(&self, sid: &str, event: &SequencedEvent, tier: ReliabilityTier) {
        let targets: Vec<ClientId> = self
            .session_subs
            .lock()
            .get(sid)
            .map(|set| set.iter().copied().collect())
            .unwrap_or_default();
        if targets.is_empty() {
            return;
        }
        let mut dead: Vec<(ClientId, Vec<String>)> = Vec::new();
        {
            let mut clients = self.clients.lock();
            for client_id in targets {
                if let Some(sids) = self.push_in(&mut clients, client_id, event.clone(), tier) {
                    dead.push((client_id, sids));
                }
            }
        }
        for (client_id, sids) in dead {
            self.remove_client_from_session_subs(client_id, &sids);
        }
    }

    /// Push an event to one client according to its tier. A full channel
    /// drops a LOSSY event (a `gap` frame follows) and closes the connection
    /// for any other tier; a gone peer unregisters the client from fan-out.
    pub(super) fn enqueue(&self, client_id: ClientId, se: SequencedEvent, tier: ReliabilityTier) {
        let dead_sids = {
            let mut clients = self.clients.lock();
            self.push_in(&mut clients, client_id, se, tier)
        };
        if let Some(sids) = dead_sids {
            self.remove_client_from_session_subs(client_id, &sids);
        }
    }

    /// [`Self::enqueue`] against an already-locked client map. Returns the
    /// removed client's sessions when the peer is gone or overflowed (the
    /// caller then clears the reverse index, after releasing `clients`).
    fn push_in(
        &self,
        clients: &mut HashMap<ClientId, ClientSub>,
        client_id: ClientId,
        se: SequencedEvent,
        tier: ReliabilityTier,
    ) -> Option<Vec<String>> {
        let sub = clients.get_mut(&client_id)?;
        match sub.push(se, tier) {
            Push::Delivered | Push::Dropped => None,
            Push::Overflow | Push::Gone => {
                if let Some(sub) = clients.remove(&client_id) {
                    // Idempotent for a connection that is already ending.
                    sub.closing.cancel();
                    return Some(sub.sessions.into_iter().collect());
                }
                None
            }
        }
    }

    /// Remove `client_id` from the reverse index for each session (no `clients` lock).
    pub(super) fn remove_client_from_session_subs(&self, client_id: ClientId, sids: &[String]) {
        let mut session_subs = self.session_subs.lock();
        for sid in sids {
            if let Some(set) = session_subs.get_mut(sid) {
                set.remove(&client_id);
                if set.is_empty() {
                    session_subs.remove(sid);
                }
            }
        }
    }

    /// Register a client + its bounded channel under a session and the
    /// reverse index. `closing` ends the connection the subscription belongs
    /// to. Lock order: `clients` then `session_subs` (see module lock-order
    /// note).
    pub(super) fn register(
        &self,
        client_id: ClientId,
        sid: &str,
        tx: mpsc::Sender<StreamItem>,
        closing: &CancellationToken,
    ) {
        {
            let mut clients = self.clients.lock();
            clients.insert(
                client_id,
                ClientSub {
                    tx,
                    closing: closing.clone(),
                    sessions: HashSet::from([sid.to_string()]),
                    gap_pending: HashSet::new(),
                },
            );
        }
        let mut session_subs = self.session_subs.lock();
        session_subs
            .entry(sid.to_string())
            .or_default()
            .insert(client_id);
    }

    /// Unsubscribe a client from a session (AC4). Removes the client entirely
    /// when it has no remaining sessions.
    pub fn unsubscribe(&self, sid: &str, client_id: ClientId) {
        {
            let mut clients = self.clients.lock();
            let Some(sub) = clients.get_mut(&client_id) else {
                return;
            };
            sub.sessions.remove(sid);
            sub.gap_pending.remove(sid);
            if sub.sessions.is_empty() {
                clients.remove(&client_id);
            }
        }
        // Release `clients` before `session_subs` (lock order / no dual-hold).
        let mut session_subs = self.session_subs.lock();
        if let Some(set) = session_subs.get_mut(sid) {
            set.remove(&client_id);
            if set.is_empty() {
                session_subs.remove(sid);
            }
        }
    }

    /// Forget all in-memory relay state for a successfully disposed ephemeral session.
    pub async fn forget_session(&self, sid: &str) {
        self.sessions.lock().remove(sid);
        let affected_clients = self.session_subs.lock().remove(sid).unwrap_or_default();
        if !affected_clients.is_empty() {
            let mut clients = self.clients.lock();
            for client_id in affected_clients {
                if let Some(client) = clients.get_mut(&client_id) {
                    client.sessions.remove(sid);
                    client.gap_pending.remove(sid);
                    if client.sessions.is_empty() {
                        clients.remove(&client_id);
                    }
                }
            }
        }
        self.turn_watermark.forget_session(sid);
        self.restore_gates.lock().remove(sid);
        self.replay_gates.lock().await.remove(sid);
    }

    /// Remove a client entirely (e.g. on WS close).
    pub fn unregister_client(&self, client_id: ClientId) {
        let sids: Vec<String> = {
            let mut clients = self.clients.lock();
            clients
                .remove(&client_id)
                .map(|sub| sub.sessions.into_iter().collect())
                .unwrap_or_default()
        };
        self.remove_client_from_session_subs(client_id, &sids);
    }

    /// Test helper: mark a session as known (empty log, next emit gets seq 1)
    /// without emitting — `subscribe` rejects unknown sessions with
    /// [`ReplayResult::NotFound`], so fan-out tests that subscribe before the
    /// first event seed the session first.
    #[cfg(test)]
    pub(crate) fn seed_session_for_test(&self, sid: &str) {
        SessionState::entry(&mut self.sessions.lock(), sid, 0, self.persistence.as_deref());
    }
}

impl EventSink for WsRelaySink {
    fn emit(&self, event: &AcpEvent) {
        // Strip the `acp:` prefix to get the WS `type` (AC2).
        let type_ = event.type_.strip_prefix("acp:").unwrap_or(event.type_);
        let tier = tier_of(type_);

        match &event.sid {
            Some(sid) => {
                // Turn terminator (AD-5): a second `prompt_complete` for the
                // same turn id is dropped (idempotent by turn id), and the
                // first one records the turn as completed + releases its
                // claim, so the next `send_prompt` is accepted and a resend of
                // this id gets an `accepted` receipt — regardless of which
                // path (turn task, crash teardown, spawn failure) produced it.
                let terminated_turn = (type_ == "prompt_complete")
                    .then(|| {
                        event
                            .payload
                            .get("turnId")
                            .and_then(Value::as_str)
                            .filter(|turn_id| !turn_id.is_empty())
                            .map(str::to_string)
                    })
                    .flatten();
                if let Some(turn_id) = &terminated_turn {
                    if !self.turn_watermark.mark_seen(sid, turn_id) {
                        warn!(
                            "[sessions] dropped duplicate prompt_complete for an already-terminated turn (session {sid})"
                        );
                        return;
                    }
                }
                // Session-scoped: assign seq, persist, append and fan out in
                // one critical section.
                self.publish(sid, type_, event.payload.clone(), tier);
                if let Some(turn_id) = &terminated_turn {
                    self.turn_watermark.record_completed(sid, turn_id);
                }
            }
            None => {
                // Agent-level: seq=0, sid=null, NOT in any per-session log (AC4).
                // Delivered to ALL connected clients with ≥1 session.
                let se = SequencedEvent::new(None, 0, type_, event.payload.clone());
                let targets: Vec<ClientId> = self.clients.lock().keys().copied().collect();
                for client_id in targets {
                    self.enqueue(client_id, se.clone(), tier);
                }
            }
        }

        // Story 1.7: snapshot `permission_request` events into the server-side
        // rendezvous (if attached). The ticket holds the immutable args (the
        // `options` array) for TOCTOU re-validation + arms the bounded timeout.
        // Runs only on the server path (desktop leaves the rendezvous unset).
        if type_ == "permission_request" {
            if let Some(rdz) = self.rendezvous() {
                // Extract the correlation fields from the camelCase payload.
                // The `PermissionRequestEvent` payload is `{agentId, sessionId,
                // requestId, toolCall, options}` (events.rs → camelCase wire).
                let payload = &event.payload;
                let request_id = payload
                    .get("requestId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                // Defensive: a malformed event (no `requestId`) would collide
                // all such tickets on the empty-string key — skip + warn instead
                // of registering a degenerate ticket. The `PermissionRequestEvent`
                // struct always carries a non-empty `request_id` (generated by
                // `DriverState::register_permission` as `perm-{uuid}`), so this
                // branch only triggers on a dispatcher bug.
                if request_id.is_empty() {
                    warn!(
                        "[permissions] dropping permission_request with no requestId (dispatcher bug?)"
                    );
                } else {
                    let agent_id = payload
                        .get("agentId")
                        .and_then(Value::as_str)
                        .map(|s| crate::acp::AgentId(s.to_string()))
                        .unwrap_or_else(|| crate::acp::AgentId("unknown".to_string()));
                    let session_id = payload
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let options = payload
                        .get("options")
                        .cloned()
                        .unwrap_or(Value::Array(vec![]));
                    rdz.register(request_id, agent_id, session_id, options);
                }
            }
        }
        // Issue #411: snapshot `question_request` events into the server-side
        // question rendezvous (if attached). The ticket holds the immutable
        // args (the `options` array) for TOCTOU re-validation + arms the
        // bounded timeout. Runs only on the server path.
        if type_ == "question_request" {
            if let Some(rdz) = self.question_rendezvous() {
                let payload = &event.payload;
                let question_id = payload
                    .get("questionId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if question_id.is_empty() {
                    warn!(
                        "[questions] dropping question_request with no questionId (dispatcher bug?)"
                    );
                } else {
                    let agent_id = payload
                        .get("agentId")
                        .and_then(Value::as_str)
                        .map(|s| crate::acp::AgentId(s.to_string()))
                        .unwrap_or_else(|| crate::acp::AgentId("unknown".to_string()));
                    let session_id = payload
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let options = payload
                        .get("options")
                        .cloned()
                        .unwrap_or(Value::Array(vec![]));
                    rdz.register(question_id, agent_id, session_id, options);
                }
            }
        }

        self.notify_history_for(type_);
    }

    /// Issue #836: dispatch `note_session_registered` through the trait so
    /// `Arc<dyn EventSink>` callers (the ACP command loop after
    /// `register_session` / promote) reach the real flush, not this trait's
    /// no-op default. Delegates to the inherent method.
    fn note_session_registered(&self, session_id: &str) {
        self.note_session_registered_inherent(session_id)
    }

    fn as_ws_relay(&self) -> Option<&WsRelaySink> {
        Some(self)
    }
}
