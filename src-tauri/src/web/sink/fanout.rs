//! Per-client subscription registry and delivery of the relay: who is
//! subscribed to what, the lossy ring, the non-blocking per-client enqueue
//! used inside the publish critical section, and the [`EventSink`] entry
//! point the ACP dispatcher emits through.

use std::collections::{HashMap, HashSet, VecDeque};

use serde_json::Value;
use tokio::sync::mpsc;
use tracing::warn;
use uuid::Uuid;

use crate::web::ws::{tier_of, ReliabilityTier, SequencedEvent};

#[cfg(test)]
use super::session_log::SessionState;
use super::{AcpEvent, EventSink, WsRelaySink};

/// Per-client subscription state.
pub(super) struct ClientSub {
    /// Outbound channel (reliable + idempotent events). Lossy events are
    /// buffered in `lossy_ring` and flushed here by the write loop.
    tx: mpsc::UnboundedSender<SequencedEvent>,
    /// Sessions this client is subscribed to.
    sessions: HashSet<String>,
    /// Bounded buffer for lossy events (drop-oldest when full).
    lossy_ring: VecDeque<SequencedEvent>,
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
    /// Push a lossy event into a client's bounded ring, evicting the oldest
    /// when over capacity (drop-oldest, AC5).
    pub(super) fn push_lossy(&self, sub: &mut ClientSub, se: SequencedEvent) {
        sub.lossy_ring.push_back(se);
        while sub.lossy_ring.len() > self.lossy_capacity {
            sub.lossy_ring.pop_front(); // drop-oldest
        }
    }

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
                if let Some(sids) = self.enqueue_in(&mut clients, client_id, event.clone(), tier) {
                    dead.push((client_id, sids));
                }
            }
        }
        for (client_id, sids) in dead {
            self.remove_client_from_session_subs(client_id, &sids);
        }
    }

    /// Enqueue an event to one client according to its tier (AC5 + AC6).
    ///
    /// Lossy events are pushed into the bounded ring (drop-oldest) then flushed
    /// to the outbound channel so a pure-lossy stream still reaches subscribers.
    /// Reliable/idempotent events flush any buffered lossy events first so
    /// emission order is preserved across tiers. A failed send (peer gone)
    /// unregisters the client from fan-out.
    pub(super) fn enqueue(&self, client_id: ClientId, se: SequencedEvent, tier: ReliabilityTier) {
        let dead_sids = {
            let mut clients = self.clients.lock();
            self.enqueue_in(&mut clients, client_id, se, tier)
        };
        if let Some(sids) = dead_sids {
            self.remove_client_from_session_subs(client_id, &sids);
        }
    }

    /// [`Self::enqueue`] against an already-locked client map. Returns the
    /// dead client's sessions when the peer is gone and was removed (the
    /// caller then clears the reverse index, after releasing `clients`).
    fn enqueue_in(
        &self,
        clients: &mut HashMap<ClientId, ClientSub>,
        client_id: ClientId,
        se: SequencedEvent,
        tier: ReliabilityTier,
    ) -> Option<Vec<String>> {
        let sub = clients.get_mut(&client_id)?;
        let send_ok = match tier {
            ReliabilityTier::Lossy => {
                self.push_lossy(sub, se);
                self.flush_lossy_sub(sub)
            }
            ReliabilityTier::Reliable | ReliabilityTier::Idempotent => {
                let flushed_ok = self.flush_lossy_sub(sub);
                flushed_ok && sub.tx.send(se).is_ok()
            }
        };
        if send_ok {
            None
        } else {
            clients
                .remove(&client_id)
                .map(|sub| sub.sessions.into_iter().collect::<Vec<_>>())
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
    /// Register a client + its sender under a session and the reverse index.
    /// Lock order: `clients` then `session_subs` (see module lock-order note).
    pub(super) fn register(&self, client_id: ClientId, sid: &str, tx: mpsc::UnboundedSender<SequencedEvent>) {
        {
            let mut clients = self.clients.lock();
            clients.insert(
                client_id,
                ClientSub {
                    tx,
                    sessions: HashSet::from([sid.to_string()]),
                    lossy_ring: VecDeque::new(),
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

    /// Flush a client's buffered lossy events into its outbound channel (AC5).
    ///
    /// Called by the WS write loop (and by tests). Under a slow peer the write
    /// loop can stall before flush; the ring fills and drop-oldest triggers in
    /// [`Self::push_lossy`]. Returns the number of events flushed.
    pub fn flush_lossy(&self, client_id: ClientId) -> usize {
        let (n, dead_sids) = {
            let mut clients = self.clients.lock();
            let Some(sub) = clients.get_mut(&client_id) else {
                return 0;
            };
            let pending = sub.lossy_ring.len();
            let ok = self.flush_lossy_sub(sub);
            if ok {
                (pending, None)
            } else {
                (
                    pending,
                    clients
                        .remove(&client_id)
                        .map(|s| s.sessions.into_iter().collect::<Vec<_>>()),
                )
            }
        };
        if let Some(sids) = dead_sids {
            self.remove_client_from_session_subs(client_id, &sids);
        }
        n
    }

    /// Flush the lossy ring for a borrowed client sub.
    /// Returns `true` if every event was sent (or the ring was empty).
    pub(super) fn flush_lossy_sub(&self, sub: &mut ClientSub) -> bool {
        while let Some(evt) = sub.lossy_ring.pop_front() {
            if sub.tx.send(evt).is_err() {
                sub.lossy_ring.clear();
                return false;
            }
        }
        true
    }

    /// Test helper: mark a session as known (empty log, next emit gets seq 1)
    /// without emitting — `subscribe` rejects unknown sessions with
    /// [`ReplayResult::NotFound`], so fan-out tests that subscribe before the
    /// first event seed the session first.
    #[cfg(test)]
    pub(crate) fn seed_session_for_test(&self, sid: &str) {
        SessionState::entry(&mut self.sessions.lock(), sid, 0);
    }

    /// Test helper: fill the lossy ring without flushing (exercises drop-oldest).
    #[cfg(test)]
    pub(super) fn push_lossy_no_flush_for_test(&self, client_id: ClientId, se: SequencedEvent) {
        let mut clients = self.clients.lock();
        if let Some(sub) = clients.get_mut(&client_id) {
            self.push_lossy(sub, se);
        }
    }

    /// Test helper: current lossy-ring length for a client.
    #[cfg(test)]
    pub(super) fn lossy_ring_len_for_test(&self, client_id: ClientId) -> usize {
        self.clients
            .lock()
            .get(&client_id)
            .map(|s| s.lossy_ring.len())
            .unwrap_or(0)
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
