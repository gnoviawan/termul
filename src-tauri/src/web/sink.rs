//! Transport-neutral event sink for the ACP dispatcher.
//!
//! The dispatcher (see `crate::acp::manager` + `crate::acp::client`) emits every
//! agent/session event through a fan-out of [`EventSink`] trait objects instead
//! of calling `AppHandle::emit` directly. That decouples the live session stream
//! from Tauri so the same dispatcher can feed:
//!
//! - the desktop's Tauri events ([`TauriEventSink`] — byte-for-byte preserves the
//!   existing `acp:*` event names + payloads the renderer depends on), and
//! - the future web's WebSocket relay ([`WsRelaySink`] — stubbed here as an
//!   in-memory recorder; wired live in Story 1.4).
//!
//! # Design rules baked in (do not deviate)
//!
//! - **Serialize ONCE, fan out N.** [`fan_out`] serializes the payload to a
//!   `serde_json::Value` once; every sink emits the same `Value`, so
//!   `TauriEventSink` and `WsRelaySink` emit byte-identical payloads.
//! - **`type_` keeps the `acp:` prefix.** [`TauriEventSink`] emits it verbatim
//!   (today's behavior); `WsRelaySink` will strip the prefix when the WS relay
//!   lands in Story 1.4. For this story the stub records the full string.
//! - **`sid` is `Option<String>`.** `None` for agent-level events
//!   (`agent_spawned`, `agent_disconnected`, `agent_error` without a session);
//!   `Some(session_id)` for session-scoped events. Matches the WS envelope
//!   `{sid, seq, type, payload}` shape (Story 1.4).
//!
//! `AcpManager` holds `Vec<Arc<dyn EventSink>>` and threads clones into every
//! driver spawn site, so `AppHandle` no longer reaches the driver thread. The
//! ONLY remaining `AppHandle` reference in the ACP stack lives inside
//! [`TauriEventSink`] (the desktop's sink — intentionally Tauri-aware).

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tracing::warn;
use uuid::Uuid;

use crate::acp::session_persistence::{
    now_millis, PersistedEventRecord, SessionPersistence, SESSION_SCHEMA_VERSION,
};
use crate::web::project_registry::ProjectsChangedPayload;
use crate::web::ws::{tier_of, ReliabilityTier, SequencedEvent};

// Global lock order for WsRelaySink (never invert — avoids deadlock):
// 1. `sessions`  2. `clients`  3. `session_subs`
// Prefer releasing a lock before acquiring the next when both are not required
// for the critical section.

/// A single ACP event ready for fan-out.
///
/// `sid` is the session id (`None` for agent-level events like `agent_spawned`
/// / `agent_disconnected`). `type_` is the existing `acp:*` event name with the
/// `acp:` prefix (e.g. `"acp:message_chunk"`) — [`TauriEventSink`] emits it
/// verbatim; `WsRelaySink` will strip the prefix when the WS relay lands in
/// Story 1.4. `payload` is the serialized JSON value so every sink emits
/// byte-identical bytes (serialize ONCE, fan out N times).
#[derive(Clone, Debug)]
pub struct AcpEvent {
    pub sid: Option<String>,
    pub type_: &'static str,
    pub payload: Value,
}

/// Transport-neutral sink for ACP events.
///
/// Object-safe (`dyn EventSink` usable via `Arc<dyn EventSink>`) and `Send +
/// Sync` so clones can cross from the Tauri command thread into each agent's
/// dedicated driver thread (see `AcpManager`'s threading model).
pub trait EventSink: Send + Sync {
    /// Deliver a single event. Errors must be logged, never propagated — a
    /// missing renderer (or a wedged WS peer) must never tear down the agent
    /// driver thread.
    fn emit(&self, event: &AcpEvent);
}

/// Desktop sink: forwards events to the Tauri renderer as `acp:*` events.
///
/// Byte-for-byte preserves the existing `events::emit(app, event, payload)`
/// behavior — same event names, same payloads (the `Value` was produced by the
/// same `serde_json::to_value` the old free function used implicitly via
/// `app.emit`), same error-logging-not-propagating semantics.
pub struct TauriEventSink {
    app: AppHandle,
}

impl TauriEventSink {
    /// Wrap a Tauri app handle. The sink is cheap to construct and `Clone`-free
    /// (it shares the handle via `AppHandle`'s internal `Arc`).
    #[must_use]
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl EventSink for TauriEventSink {
    fn emit(&self, event: &AcpEvent) {
        if let Err(e) = self.app.emit(event.type_, event.payload.clone()) {
            log::error!("[acp] failed to emit event {}: {e}", event.type_);
        }
    }
}

/// Live WS relay sink (Story 1.4 — replaces the Story 1.1 in-memory recorder).
///
/// Owns the per-session append-only bounded event logs (the canonical replay
/// source, D5), per-session monotonic `seq` counters, and the per-client
/// subscriber set. `emit` is called from the per-agent driver thread (via
/// [`fan_out`]) and is NON-blocking: it assigns `seq`, appends to the log, and
/// fans out to each subscribed client's `tokio::sync::mpsc::UnboundedSender`.
///
/// # Tier handling (AC5)
///
/// - **Lossy** events (`message_chunk`, `tool_call_update`, `commands_update`,
///   `plan_update`) are buffered in a per-client bounded ring; when the ring
///   is full the OLDEST lossy event is dropped. The write loop drains the ring
///   via [`Self::flush_lossy`]. Under a slow WS peer the write loop stalls, the
///   ring fills, and drop-oldest triggers — the lossy backpressure path.
/// - **Reliable** events are sent on the unbounded per-client channel and are
///   never dropped (full ack/backpressure + timeout=deny lands in Story 1.7).
/// - **Idempotent** (`prompt_complete`) is deduped by turn-id when the payload
///   carries one; the current `PromptCompleteEvent` has no turn-id field, so
///   the relay sends it through (like reliable) and the client dedups by
///   `seq` (Dev Notes #6).
///
/// Constructible WITHOUT a Tauri `AppHandle` (Story 1.1 invariant — the
/// standalone `termul-server` binary has no Tauri app). `Send + Sync` so clones
/// of `Arc<WsRelaySink>` can cross from the Tauri command thread into each
/// agent's dedicated driver thread.
pub struct WsRelaySink {
    /// Per-session seq counter + append-only bounded ring (canonical replay
    /// source, D5). Combined under one mutex so seq assignment and log append
    /// are atomic w.r.t. concurrent emits (AC4).
    sessions: Mutex<HashMap<String, SessionState>>,
    /// Per-client subscription: client_id → client state (sender + sessions).
    clients: Mutex<HashMap<ClientId, ClientSub>>,
    /// Reverse index: session_id → set of subscribed client_ids.
    session_subs: Mutex<HashMap<String, HashSet<ClientId>>>,
    /// Bounded per-session ring capacity (default 4096, AC4).
    event_log_capacity: usize,
    /// Per-client lossy ring capacity (drop-oldest threshold, AC5).
    lossy_capacity: usize,
    /// Server-side permission rendezvous (Story 1.7). `None` on the desktop
    /// path (the browser-less flow uses the `acp_respond_permission` Tauri
    /// command directly). When set, `emit` snapshots `acp:permission_request`
    /// events into a relay-side ticket table that enforces the rendezvous
    /// policy (timeout, at-most-one, first-wins, disconnect-deny, TOCTOU).
    rendezvous: Mutex<Option<Arc<crate::web::permissions::PermissionRendezvous>>>,
    /// Server-side question rendezvous (issue #411). `None` on the desktop
    /// path (the browser-less flow uses the `acp_answer_question` Tauri
    /// command directly). When set, `emit` snapshots `acp:question_request`
    /// events into a relay-side ticket table (first-wins, TOCTOU, timeout).
    question_rendezvous: Mutex<Option<Arc<crate::web::permissions::QuestionRendezvous>>>,
    /// Server-side turn-id watermark (Story 1.7 T7.2 — FR13/FR11 plumbing).
    /// Always present (cheap to construct; no external handle). 1.8's
    /// `prompt_complete` / `send_prompt` handlers read this via
    /// [`Self::turn_watermark`] to dedup agent turns by client turn-id.
    turn_watermark: crate::web::permissions::TurnWatermark,
    /// Standalone durable history. Desktop/shared-live leave this disabled.
    persistence: Option<Arc<SessionPersistence>>,
    /// Serializes each session's durable replay/catch-up/register handoff.
    /// Emits remain non-blocking and use the synchronous session state lock.
    replay_gates: tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

/// Per-session seq + append-only bounded ring (held under [`WsRelaySink::sessions`]).
struct SessionState {
    /// Last assigned seq (0 = none yet; next emit assigns `last_seq + 1`).
    last_seq: u64,
    /// Bounded ring; oldest evicted when `len > capacity`.
    events: VecDeque<SequencedEvent>,
    /// Complete in-memory session event snapshot for atomic stale recovery on
    /// desktop shared-live, where no file-backed event persistence exists.
    snapshot_events: Vec<SequencedEvent>,
    /// `seq` of the oldest event currently in the ring (for cursor-gap detect).
    base_seq: u64,
}

/// Per-client subscription state.
struct ClientSub {
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

/// Cursor-replay result for [`WsRelaySink::subscribe`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplayResult {
    /// Replay succeeded; carries the number of events replayed from the log tail.
    Ok(u64),
    /// `last_seq` is older than the log's oldest (evicted) event — the client
    /// must re-sync (AC4).
    Stale,
}

/// Default per-session event-log capacity (AC4).
pub const DEFAULT_EVENT_LOG_CAPACITY: usize = 4096;
/// Default per-client lossy ring capacity (drop-oldest threshold).
const DEFAULT_LOSSY_CAPACITY: usize = 256;

impl WsRelaySink {
    /// Create a live relay sink with default capacities
    /// (`event_log_capacity = 4096`, `lossy_capacity = 256`).
    #[must_use]
    pub fn new() -> Self {
        Self::with_capacity(DEFAULT_EVENT_LOG_CAPACITY, DEFAULT_LOSSY_CAPACITY)
    }

    /// Create a live relay sink with explicit capacities (AC4 + AC5).
    #[must_use]
    pub fn with_capacity(event_log_capacity: usize, lossy_capacity: usize) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            clients: Mutex::new(HashMap::new()),
            session_subs: Mutex::new(HashMap::new()),
            event_log_capacity: event_log_capacity.max(1),
            lossy_capacity: lossy_capacity.max(1),
            rendezvous: Mutex::new(None),
            question_rendezvous: Mutex::new(None),
            turn_watermark: crate::web::permissions::TurnWatermark::new(),
            persistence: None,
            replay_gates: tokio::sync::Mutex::new(HashMap::new()),
        }
    }

    /// Create a live relay sink with a custom per-session event-log capacity and
    /// the default per-client lossy ring capacity (AC4 + AC5). Used by
    /// `termul-server` to thread `ServerConfig::event_log_capacity`.
    #[must_use]
    pub fn with_log_capacity(event_log_capacity: usize) -> Self {
        Self::with_capacity(event_log_capacity, DEFAULT_LOSSY_CAPACITY)
    }

    #[must_use]
    pub fn with_persistence(
        event_log_capacity: usize,
        persistence: Arc<SessionPersistence>,
    ) -> Self {
        let mut sink = Self::with_capacity(event_log_capacity, DEFAULT_LOSSY_CAPACITY);
        for entry in persistence.list_sessions() {
            if let Ok(turn_ids) = persistence.completed_turn_ids(&entry.session_id) {
                sink.turn_watermark
                    .restore_completed(&entry.session_id, turn_ids);
            }
        }
        sink.persistence = Some(persistence);
        sink
    }

    #[must_use]
    pub fn persistence(&self) -> Option<Arc<SessionPersistence>> {
        self.persistence.clone()
    }

    /// The configured per-session event-log capacity (AC4).
    #[must_use]
    pub fn event_log_capacity(&self) -> usize {
        self.event_log_capacity
    }

    /// Attach the server-side permission rendezvous (Story 1.7). Server-only;
    /// the desktop path leaves this unset (the browser-less flow uses the
    /// `acp_respond_permission` Tauri command directly). Once attached, `emit`
    /// snapshots `acp:permission_request` events into the rendezvous so the
    /// `/ws` `respond_permission` handler + disconnect cleanup can enforce the
    /// rendezvous policy.
    pub fn set_rendezvous(&self, rendezvous: Arc<crate::web::permissions::PermissionRendezvous>) {
        *self.rendezvous.lock() = Some(rendezvous);
    }

    /// The attached rendezvous, if any (server path). Used by the `/ws`
    /// `respond_permission` handler + disconnect deny-all cleanup.
    #[must_use]
    pub fn rendezvous(&self) -> Option<Arc<crate::web::permissions::PermissionRendezvous>> {
        self.rendezvous.lock().clone()
    }

    /// Attach the server-side question rendezvous (issue #411). Server-only;
    /// when set, `emit` snapshots `acp:question_request` events into the
    /// rendezvous so the `/ws` `answer_question` handler can enforce the
    /// rendezvous policy (first-wins, TOCTOU, timeout).
    pub fn set_question_rendezvous(
        &self,
        rendezvous: Arc<crate::web::permissions::QuestionRendezvous>,
    ) {
        *self.question_rendezvous.lock() = Some(rendezvous);
    }

    /// The attached question rendezvous, if any (server path). Used by the `/ws`
    /// `answer_question` handler + disconnect deny-all cleanup.
    #[must_use]
    pub fn question_rendezvous(&self) -> Option<Arc<crate::web::permissions::QuestionRendezvous>> {
        self.question_rendezvous.lock().clone()
    }

    /// Number of clients currently subscribed to `session_id` (Story 1.7
    /// disconnect-deny: a pending permission is denied only when the
    /// disconnecting client was the LAST subscriber on its session — otherwise a
    /// remaining client can still legitimately respond).
    #[must_use]
    pub fn session_subscriber_count(&self, session_id: &str) -> usize {
        self.session_subs
            .lock()
            .get(session_id)
            .map_or(0, HashSet::len)
    }

    /// The server-side turn-id watermark (Story 1.7 T7.2 — FR13/FR11 plumbing).
    /// 1.8's `prompt_complete` / `send_prompt` handlers call this to dedup agent
    /// turns by client turn-id (the wire-level `turnId` field lands in 1.8).
    #[must_use]
    pub fn turn_watermark(&self) -> &crate::web::permissions::TurnWatermark {
        &self.turn_watermark
    }

    /// Current session sequence frontier. Used as the snapshot watermark.
    #[must_use]
    pub fn session_watermark(&self, session_id: &str) -> u64 {
        self.sessions.lock().get(session_id).map_or_else(
            || {
                self.persistence
                    .as_ref()
                    .and_then(|persistence| persistence.last_seq(session_id).ok())
                    .unwrap_or(0)
            },
            |state| state.last_seq,
        )
    }

    /// Assign seq + append under the sessions lock (atomic w.r.t. concurrent emits).
    fn assign_and_append(&self, sid: &str, type_: &str, payload: Value) -> SequencedEvent {
        let mut sessions = self.sessions.lock();
        let durable_last = self
            .persistence
            .as_ref()
            .and_then(|persistence| persistence.last_seq(sid).ok())
            .unwrap_or(0);
        let state = sessions
            .entry(sid.to_string())
            .or_insert_with(|| SessionState {
                last_seq: durable_last,
                events: VecDeque::new(),
                snapshot_events: Vec::new(),
                base_seq: 1,
            });
        state.last_seq = state.last_seq.saturating_add(1);
        let seq = state.last_seq;
        let se = SequencedEvent::new(Some(sid.to_string()), seq, type_, payload);
        if state.events.is_empty() {
            state.base_seq = seq;
        }
        state.events.push_back(se.clone());
        // Desktop shared-live only: maintain a bounded in-memory snapshot for
        // atomic stale recovery. When persistence is available, do NOT maintain
        // `snapshot_events` at all — `subscribe_snapshot` rebuilds the snapshot
        // from durable history instead (avoids unbounded growth).
        if self.persistence.is_none() {
            state.snapshot_events.push(se.clone());
            while state.snapshot_events.len() > self.event_log_capacity {
                state.snapshot_events.remove(0);
            }
        }
        while state.events.len() > self.event_log_capacity {
            state.events.pop_front();
            state.base_seq = state
                .events
                .front()
                .map(|e| e.seq)
                .unwrap_or(state.base_seq.saturating_add(1));
        }
        if let Some(persistence) = &self.persistence {
            let record = PersistedEventRecord {
                schema_version: SESSION_SCHEMA_VERSION,
                session_id: sid.to_string(),
                seq,
                type_: type_.to_string(),
                recorded_at: now_millis(),
                payload: se.payload.clone(),
            };
            if let Err(error) = persistence.enqueue_event(record) {
                warn!("[sessions] persistence queue rejected event for session {sid}: {error}");
            }
        }
        se
    }

    /// Push a lossy event into a client's bounded ring, evicting the oldest
    /// when over capacity (drop-oldest, AC5).
    fn push_lossy(&self, sub: &mut ClientSub, se: SequencedEvent) {
        sub.lossy_ring.push_back(se);
        while sub.lossy_ring.len() > self.lossy_capacity {
            sub.lossy_ring.pop_front(); // drop-oldest
        }
    }

    /// Enqueue an event to a client according to its tier (AC5 + AC6).
    ///
    /// Lossy events are pushed into the bounded ring (drop-oldest) then flushed
    /// to the outbound channel so a pure-lossy stream still reaches subscribers.
    /// Reliable/idempotent events flush any buffered lossy events first so
    /// emission order is preserved across tiers. A failed send (peer gone)
    /// unregisters the client from fan-out.
    fn enqueue(&self, client_id: ClientId, se: SequencedEvent, tier: ReliabilityTier) {
        let dead_sids = {
            let mut clients = self.clients.lock();
            let Some(sub) = clients.get_mut(&client_id) else {
                return;
            };
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
        };
        if let Some(sids) = dead_sids {
            self.remove_client_from_session_subs(client_id, &sids);
        }
    }

    /// Remove `client_id` from the reverse index for each session (no `clients` lock).
    fn remove_client_from_session_subs(&self, client_id: ClientId, sids: &[String]) {
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

    /// Subscribe a new client to a session with an optional cursor (AC4).
    ///
    /// `last_seq = None` → live-only (no replay). `last_seq = Some(n)` → replay
    /// the log tail from `n + 1` then live-stream. If `n` is older than the
    /// log's oldest (evicted) event, returns [`ReplayResult::Stale`] (the
    /// client must re-sync) and DOES NOT register the subscription.
    ///
    /// Holds the sessions lock across stale-check + register + replay so an
    /// emit cannot slip into the gap between unlock and register (TOCTOU).
    ///
    /// Returns the new client id + the receiver the write loop drains.
    pub async fn subscribe(
        &self,
        sid: &str,
        last_seq: Option<u64>,
    ) -> (
        ClientId,
        mpsc::UnboundedReceiver<SequencedEvent>,
        ReplayResult,
    ) {
        let client_id = ClientId::new();
        let (tx, rx) = mpsc::unbounded_channel::<SequencedEvent>();
        let Some(cursor) = last_seq else {
            self.register(client_id, sid, tx);
            return (client_id, rx, ReplayResult::Ok(0));
        };

        let gate = {
            let mut gates = self.replay_gates.lock().await;
            gates
                .entry(sid.to_string())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                .clone()
        };
        let _replay_guard = gate.lock().await;
        let mut by_seq = std::collections::BTreeMap::new();
        loop {
            if let Some(persistence) = &self.persistence {
                // Flush is a queue barrier for everything assigned before it.
                // The JSONL scan itself runs on spawn_blocking.
                if persistence.flush_session(sid).await.is_err() {
                    return (client_id, rx, ReplayResult::Stale);
                }
                let durable = match persistence
                    .replay_after_async(sid.to_string(), cursor)
                    .await
                {
                    Ok(records) => records,
                    Err(_) => return (client_id, rx, ReplayResult::Stale),
                };
                for record in durable {
                    by_seq.insert(
                        record.seq,
                        SequencedEvent::new(
                            Some(record.session_id),
                            record.seq,
                            record.type_,
                            record.payload,
                        ),
                    );
                }
            }

            let sessions = self.sessions.lock();
            if self.persistence.is_none()
                && sessions.get(sid).is_some_and(|state| {
                    cursor
                        .checked_add(1)
                        .is_some_and(|next| next < state.base_seq)
                })
            {
                return (client_id, rx, ReplayResult::Stale);
            }
            let (ring, last_seq, base_seq) = sessions.get(sid).map_or_else(
                || (Vec::new(), cursor, cursor.saturating_add(1)),
                |state| {
                    (
                        state
                            .events
                            .iter()
                            .filter(|event| event.seq > cursor)
                            .cloned()
                            .collect::<Vec<_>>(),
                        state.last_seq,
                        state.base_seq,
                    )
                },
            );
            for event in ring {
                by_seq.insert(event.seq, event);
            }
            // A high max sequence is not proof of coverage: validate every
            // sequence from cursor+1 through the observed frontier. If any hole
            // was evicted while disk replay was in flight, drop the state lock,
            // flush/re-read durable history, and retry before registering.
            let frontier = last_seq;
            let first_missing = cursor
                .checked_add(1)
                .and_then(|start| (start..=frontier).find(|seq| !by_seq.contains_key(seq)));
            if first_missing.is_some() {
                if self.persistence.is_none() || base_seq <= cursor.saturating_add(1) {
                    return (client_id, rx, ReplayResult::Stale);
                }
                drop(sessions);
                continue;
            }

            self.register(client_id, sid, tx.clone());
            let count = by_seq.len() as u64;
            for event in by_seq.into_values() {
                if tx.send(event).is_err() {
                    drop(sessions);
                    self.unregister_client(client_id);
                    return (client_id, rx, ReplayResult::Stale);
                }
            }
            return (client_id, rx, ReplayResult::Ok(count));
        }
    }

    /// Atomically register a client and capture the complete session event
    /// snapshot plus its sequence watermark. The sessions lock is held across
    /// capture + registration, so subsequent emits are strictly post-watermark.
    ///
    /// When persistence is available, the snapshot is rebuilt from durable
    /// history (the in-memory `snapshot_events` is NOT maintained on that path
    /// — see `assign_and_append`). If the session is truly unknown to
    /// persistence, an `Err` is propagated so the caller returns `not_found`
    /// instead of an empty snapshot that would wipe transcripts.
    pub async fn subscribe_snapshot(
        &self,
        sid: &str,
    ) -> Result<
        (
            ClientId,
            mpsc::UnboundedReceiver<SequencedEvent>,
            Vec<SequencedEvent>,
            u64,
        ),
        String,
    > {
        let client_id = ClientId::new();
        let (tx, rx) = mpsc::unbounded_channel::<SequencedEvent>();
        let gate = {
            let mut gates = self.replay_gates.lock().await;
            gates
                .entry(sid.to_string())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                .clone()
        };
        let _replay_guard = gate.lock().await;
        if let Some(persistence) = &self.persistence {
            // Persistence is available: rebuild the snapshot from durable
            // history (do NOT maintain `snapshot_events` on this path).
            let _ = persistence.flush_session(sid).await;
            let watermark = persistence
                .last_seq(sid)
                .map_err(|error| error.to_string())?;
            let records = persistence
                .replay_after_async(sid.to_string(), 0)
                .await
                .map_err(|error| error.to_string())?;
            let snapshot: Vec<SequencedEvent> = records
                .into_iter()
                .map(|record| {
                    SequencedEvent::new(
                        Some(record.session_id),
                        record.seq,
                        record.type_,
                        record.payload,
                    )
                })
                .collect();
            self.register(client_id, sid, tx);
            return Ok((client_id, rx, snapshot, watermark));
        }
        // Desktop shared-live: use the bounded in-memory `snapshot_events`.
        let sessions = self.sessions.lock();
        let (snapshot, watermark) = sessions.get(sid).map_or_else(
            || (Vec::new(), 0),
            |state| (state.snapshot_events.clone(), state.last_seq),
        );
        self.register(client_id, sid, tx);
        drop(sessions);
        Ok((client_id, rx, snapshot, watermark))
    }

    /// Authoritative server-authored user prompt: assign the relay sequence,
    /// persist it, and synchronously wait for the durability boundary before
    /// ACP dispatch.
    pub async fn persist_user_prompt(
        &self,
        sid: &str,
        payload: Value,
    ) -> Result<SequencedEvent, String> {
        let event = self.assign_and_append(sid, "user_prompt", payload);
        if let Some(persistence) = &self.persistence {
            persistence
                .flush_session(sid)
                .await
                .map_err(|error| error.to_string())?;
        }
        let targets: Vec<ClientId> = self
            .session_subs
            .lock()
            .get(sid)
            .map(|set| set.iter().copied().collect())
            .unwrap_or_default();
        for client_id in targets {
            self.enqueue(client_id, event.clone(), ReliabilityTier::Reliable);
        }
        Ok(event)
    }

    /// Register a client + its sender under a session and the reverse index.
    /// Lock order: `clients` then `session_subs` (see module lock-order note).
    fn register(&self, client_id: ClientId, sid: &str, tx: mpsc::UnboundedSender<SequencedEvent>) {
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
    fn flush_lossy_sub(&self, sub: &mut ClientSub) -> bool {
        while let Some(evt) = sub.lossy_ring.pop_front() {
            if sub.tx.send(evt).is_err() {
                sub.lossy_ring.clear();
                return false;
            }
        }
        true
    }

    /// Test helper: fill the lossy ring without flushing (exercises drop-oldest).
    #[cfg(test)]
    fn push_lossy_no_flush_for_test(&self, client_id: ClientId, se: SequencedEvent) {
        let mut clients = self.clients.lock();
        if let Some(sub) = clients.get_mut(&client_id) {
            self.push_lossy(sub, se);
        }
    }

    /// Test helper: current lossy-ring length for a client.
    #[cfg(test)]
    fn lossy_ring_len_for_test(&self, client_id: ClientId) -> usize {
        self.clients
            .lock()
            .get(&client_id)
            .map(|s| s.lossy_ring.len())
            .unwrap_or(0)
    }
}

impl Default for WsRelaySink {
    fn default() -> Self {
        Self::new()
    }
}

impl EventSink for WsRelaySink {
    fn emit(&self, event: &AcpEvent) {
        // Strip the `acp:` prefix to get the WS `type` (AC2).
        let type_ = event.type_.strip_prefix("acp:").unwrap_or(event.type_);
        let tier = tier_of(type_);

        match &event.sid {
            Some(sid) => {
                // Session-scoped: assign seq + append atomically, then fan out.
                let se = self.assign_and_append(sid, type_, event.payload.clone());
                let targets: Vec<ClientId> = self
                    .session_subs
                    .lock()
                    .get(sid)
                    .map(|set| set.iter().copied().collect())
                    .unwrap_or_default();
                for client_id in targets {
                    self.enqueue(client_id, se.clone(), tier);
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
    }
}

/// Fan an event out to every sink, serializing the payload ONCE so each sink
/// emits byte-identical JSON.
///
/// `sid` is `None` for agent-level events, `Some(session_id)` for
/// session-scoped events. `type_` is the `acp:*` event name (with prefix).
/// `payload` is serialized to a `serde_json::Value` here, then handed to each
/// sink by reference — `TauriEventSink` re-serializes via `app.emit` (which
/// accepts a `Value` directly) and `WsRelaySink` records the `Value` as-is.
///
/// Returns early without emitting when `sinks` is empty (avoids a wasted
/// serialization + allocation on the `vec![]` path blessed for unit tests) or
/// when the payload fails to serialize. A serialization failure is logged and
/// the event is dropped — preserving the old `events::emit` drop-and-log
/// semantics (a non-JSON-serializable payload must NOT be emitted as a `null`
/// payload on the wire).
pub fn fan_out<P: Serialize>(
    sinks: &[Arc<dyn EventSink>],
    sid: Option<&str>,
    type_: &'static str,
    payload: &P,
) {
    if sinks.is_empty() {
        return;
    }
    let payload = match serde_json::to_value(payload) {
        Ok(v) => v,
        Err(e) => {
            log::error!("[acp] skipping {type_} event: payload failed to serialize: {e}");
            return;
        }
    };
    let event = AcpEvent {
        sid: sid.map(str::to_string),
        type_,
        payload,
    };
    for sink in sinks {
        sink.emit(&event);
    }
}

/// Broadcast a `projects_changed` agent-level event to every connected client.
///
/// Called by the `remote_sync_projects` command after it updates the
/// [`crate::web::project_registry::ProjectRegistry`]. The event is
/// agent-level (`sid: None`, `seq: 0`) so [`WsRelaySink::emit`] fans it out to
/// ALL connected clients (the wire `type` is `projects_changed` — the `acp:`
/// prefix is stripped by `emit`). The payload carries only the new
/// `activeProjectId`; the web client refetches `GET /projects` for the full
/// list (the desktop is the source of truth).
///
/// `active_project_id` is `None` when the desktop has no active project.
pub fn broadcast_projects_changed(relay: &Arc<WsRelaySink>, active_project_id: Option<&str>) {
    // Use the typed `ProjectsChangedPayload` (single source of truth for the
    // wire shape) rather than hand-rolled `json!` — its `skip_serializing_if`
    // omits `activeProjectId` when `None` (the web client ignores the payload
    // + refetches `GET /projects`, so omit-vs-null is cosmetic, but the
    // struct stays the canonical shape if fields are added later).
    let payload = ProjectsChangedPayload {
        active_project_id: active_project_id.map(str::to_string),
    };
    // Clone into a concrete `Arc<WsRelaySink>` first so `Arc::clone` infers
    // `T = WsRelaySink` (not `dyn EventSink`); the unsized coercion to
    // `Arc<dyn EventSink>` then happens at the vec push.
    let relay_arc: Arc<WsRelaySink> = Arc::clone(relay);
    let sinks: Vec<Arc<dyn EventSink>> = vec![relay_arc];
    fan_out(&sinks, None, "acp:projects_changed", &payload);
}

/// Broadcast a `chat_history_changed` agent-level event to every connected
/// client.
///
/// Called after desktop history mutations or compatibility sync requests. The event is
/// agent-level (`sid: None`, `seq: 0`) so [`WsRelaySink::emit`] fans it out to
/// ALL connected clients (the wire `type` is `chat_history_changed` — the
/// `acp:` prefix is stripped by `emit`). The payload is empty `{}`; the web
/// client refetches the session index (`list_persisted_sessions`) for the full
/// list (the desktop is the source of truth).
pub fn broadcast_chat_history_changed(relay: &Arc<WsRelaySink>) {
    let payload = serde_json::json!({});
    let relay_arc: Arc<WsRelaySink> = Arc::clone(relay);
    let sinks: Vec<Arc<dyn EventSink>> = vec![relay_arc];
    fan_out(&sinks, None, "acp:chat_history_changed", &payload);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::session_persistence::SessionRegistration;
    use serde::Serialize;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// Drain a receiver into a Vec in arrival order (test helper for the live
    /// relay API — replaces the old `WsRelaySink::drain` recorder).
    fn drain_rx(
        rx: &mut tokio::sync::mpsc::UnboundedReceiver<SequencedEvent>,
    ) -> Vec<SequencedEvent> {
        let mut out = Vec::new();
        while let Ok(evt) = rx.try_recv() {
            out.push(evt);
        }
        out
    }

    /// A minimal serializable payload for sink tests — exercises the same
    /// `serde_json::to_value` path the real event structs use.
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct TestPayload {
        agent_id: String,
        session_id: String,
        message: String,
    }

    impl TestPayload {
        fn new(agent: &str, session: &str, msg: &str) -> Self {
            Self {
                agent_id: agent.to_string(),
                session_id: session.to_string(),
                message: msg.to_string(),
            }
        }
    }

    #[tokio::test]
    async fn forget_session_removes_relay_subscription_and_replay_state() {
        let ws = Arc::new(WsRelaySink::new());
        let (client, _rx, _) = ws.subscribe("temp", Some(0)).await;
        let sinks: Vec<Arc<dyn EventSink>> = vec![ws.clone()];
        fan_out(
            &sinks,
            Some("temp"),
            "acp:message_chunk",
            &TestPayload::new("a1", "temp", "secret"),
        );
        ws.turn_watermark().mark_seen("temp", "turn-1");
        assert_eq!(ws.session_watermark("temp"), 1);
        assert_eq!(ws.session_subscriber_count("temp"), 1);
        assert!(ws.turn_watermark().is_seen("temp", "turn-1"));
        assert!(ws.replay_gates.lock().await.contains_key("temp"));

        ws.forget_session("temp").await;

        assert_eq!(ws.session_watermark("temp"), 0);
        assert_eq!(ws.session_subscriber_count("temp"), 0);
        assert!(!ws.clients.lock().contains_key(&client));
        assert!(!ws.turn_watermark().is_seen("temp", "turn-1"));
        assert!(!ws.replay_gates.lock().await.contains_key("temp"));
    }

    /// AC: `WsRelaySink` delivers session + agent-level events in emission
    /// order to a subscribed client (Story 1.4 live API; was Task 8.1).
    #[tokio::test]
    async fn ws_relay_sink_delivers_events_in_order() {
        let ws = Arc::new(WsRelaySink::new());
        // Subscribe BEFORE emitting so the client receives events live.
        let (client, mut rx, replay) = ws.subscribe("sess-1", None).await;
        assert_eq!(replay, ReplayResult::Ok(0), "fresh session has no replay");
        let sinks: Vec<Arc<dyn EventSink>> = vec![ws.clone()];
        fan_out(
            &sinks,
            Some("sess-1"),
            "acp:message_chunk",
            &TestPayload::new("a1", "sess-1", "first"),
        );
        fan_out(
            &sinks,
            Some("sess-1"),
            "acp:message_chunk",
            &TestPayload::new("a1", "sess-1", "second"),
        );
        fan_out(
            &sinks,
            None,
            "acp:agent_disconnected",
            &TestPayload::new("a1", "sess-1", "third"),
        );

        // Lossy events are pushed + flushed to the channel on enqueue (AC5/AC6),
        // so an explicit flush is a no-op here; reliable agent_disconnected is last.
        assert_eq!(
            ws.flush_lossy(client),
            0,
            "lossy ring already drained on enqueue"
        );

        let drained = drain_rx(&mut rx);
        assert_eq!(drained.len(), 3, "exactly three events were delivered");
        // Session-scoped events get monotonic seq; agent-level gets seq=0.
        assert_eq!(drained[0].type_, "message_chunk");
        assert_eq!(drained[0].sid.as_deref(), Some("sess-1"));
        assert_eq!(drained[0].seq, 1);
        assert_eq!(drained[0].payload["message"], "first");
        assert_eq!(drained[1].seq, 2);
        assert_eq!(drained[1].payload["message"], "second");
        assert_eq!(drained[2].type_, "agent_disconnected");
        assert_eq!(drained[2].seq, 0);
        assert!(
            drained[2].sid.is_none(),
            "agent-level event must carry no sid"
        );
        // camelCase wire shape is preserved end-to-end (AC3).
        assert_eq!(drained[0].payload["agentId"], "a1");
        assert_eq!(drained[0].payload["sessionId"], "sess-1");
    }

    /// AC: `WsRelaySink` + `TauriEventSink` in the same fan-out both receive
    /// the SAME payload (Story 1.1 byte-identity invariant). We can't
    /// construct a real `AppHandle` in a unit test, so a custom sink records
    /// the `AcpEvent` the way `TauriEventSink` would emit it; we then assert
    /// the WS relay delivered an identical `Value` to a subscribed client.
    /// The relay strips the `acp:` prefix from `type_` (AC2) but passes the
    /// `payload` `Value` through verbatim (AC3 — byte-identity invariant).
    #[tokio::test]
    async fn fan_out_delivers_identical_payload_to_every_sink() {
        /// A second recorder used as a stand-in for `TauriEventSink`'s view of
        /// the event (we can't build a real `AppHandle` here). It captures the
        /// exact `AcpEvent` handed to `emit`.
        struct CapturingSink {
            seen: Mutex<Vec<AcpEvent>>,
        }
        impl EventSink for CapturingSink {
            fn emit(&self, event: &AcpEvent) {
                self.seen.lock().push(event.clone());
            }
        }

        let ws = Arc::new(WsRelaySink::new());
        let tauri_stand_in = Arc::new(CapturingSink {
            seen: Mutex::new(Vec::new()),
        });
        let sinks: Vec<Arc<dyn EventSink>> = vec![tauri_stand_in.clone(), ws.clone()];

        // Subscribe BEFORE emitting so the WS client receives the event live.
        let (_client, mut rx, _replay) = ws.subscribe("sess-7", None).await;

        fan_out(
            &sinks,
            Some("sess-7"),
            "acp:tool_call",
            &TestPayload::new("a2", "sess-7", "hello"),
        );

        let tauri_view = tauri_stand_in.seen.lock().drain(..).collect::<Vec<_>>();
        let ws_view = drain_rx(&mut rx);

        assert_eq!(tauri_view.len(), 1);
        assert_eq!(ws_view.len(), 1);
        // The relay strips the `acp:` prefix from the WS event type (AC2).
        assert_eq!(tauri_view[0].type_, "acp:tool_call");
        assert_eq!(ws_view[0].type_, "tool_call");
        assert_eq!(ws_view[0].sid.as_deref(), tauri_view[0].sid.as_deref());
        assert_eq!(
            ws_view[0].payload, tauri_view[0].payload,
            "both sinks must see the SAME serialized Value (serialize-once-fan-out-N)"
        );
        assert_eq!(ws_view[0].payload["message"], "hello");
    }

    /// `fan_out` with an empty sink list is a no-op (the dispatcher must not
    /// panic when constructed with `vec![]`, e.g. in unit tests of the manager).
    #[test]
    fn fan_out_with_no_sinks_is_a_no_op() {
        let sinks: Vec<Arc<dyn EventSink>> = vec![];
        fan_out(
            &sinks,
            Some("sess-x"),
            "acp:message_chunk",
            &TestPayload::new("a", "sess-x", "m"),
        );
        // No panic, no assertion needed beyond reaching this point.
    }

    /// `WsRelaySink` live receiver drains only currently-queued events;
    /// subsequent emits produce new events on the next drain (AC6).
    #[tokio::test]
    async fn ws_relay_sink_live_drain_is_incremental() {
        let ws = Arc::new(WsRelaySink::new());
        let (client, mut rx, _replay) = ws.subscribe("sess-d", None).await;
        let sinks: Vec<Arc<dyn EventSink>> = vec![ws.clone()];
        fan_out(
            &sinks,
            Some("sess-d"),
            "acp:message_chunk",
            &TestPayload::new("a", "sess-d", "m1"),
        );
        // Lossy events are flushed to the channel on enqueue.
        assert_eq!(ws.lossy_ring_len_for_test(client), 0);
        let first = drain_rx(&mut rx);
        assert_eq!(first.len(), 1);
        // A second drain without a new emit yields nothing.
        let between = drain_rx(&mut rx);
        assert!(
            between.is_empty(),
            "drain must not re-deliver already-drained events"
        );
        fan_out(
            &sinks,
            Some("sess-d"),
            "acp:message_chunk",
            &TestPayload::new("a", "sess-d", "m2"),
        );
        let second = drain_rx(&mut rx);
        assert_eq!(second.len(), 1, "a new emit must produce a new event");
        assert_eq!(second[0].seq, 2);
    }

    /// A payload whose `Serialize` impl always errors — deterministically
    /// exercises `fan_out`'s serialization-failure branch. The real-world
    /// trigger is an `f64::NaN`/`Infinity` in a field like
    /// `UsageCostEvent.amount`, but a custom failing serializer avoids
    /// depending on `serde_json`'s float policy.
    struct AlwaysFailsPayload;
    impl Serialize for AlwaysFailsPayload {
        fn serialize<S>(&self, _serializer: S) -> Result<S::Ok, S::Error>
        where
            S: serde::Serializer,
        {
            Err(<S::Error as serde::ser::Error>::custom(
                "intentional serialization failure for test",
            ))
        }
    }

    /// P1: a serialization failure must NOT emit a `null` payload on the wire
    /// — the event is dropped (preserving the old `events::emit` semantics).
    #[tokio::test]
    async fn fan_out_skips_emission_when_payload_fails_to_serialize() {
        let ws = Arc::new(WsRelaySink::new());
        let (_client, mut rx, _replay) = ws.subscribe("sess-nan", None).await;
        let sinks: Vec<Arc<dyn EventSink>> = vec![ws.clone()];
        fan_out(
            &sinks,
            Some("sess-nan"),
            "acp:usage_update",
            &AlwaysFailsPayload,
        );
        assert!(
            drain_rx(&mut rx).is_empty(),
            "serialization failure must not emit a null payload"
        );
    }

    /// Mirrors the real event structs' `#[serde(skip_serializing_if = ...)]`
    /// pattern (e.g. `SessionCreatedEvent`/`AgentErrorEvent`/`UsageUpdateEvent`)
    /// without coupling this test to `crate::acp::events` internals.
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct SkipIfPayload {
        agent_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        optional_field: Option<String>,
    }

    /// P2: the `Value` produced by `fan_out` must match a direct
    /// `serde_json::to_value` of the same struct, including `skip_serializing_if`
    /// fields (a `None` optional field must be ABSENT, not emitted as `null`).
    /// This guards against any future `Value`-intermediate regression that would
    /// silently break byte-identity for real event structs.
    #[tokio::test]
    async fn fan_out_preserves_skip_serializing_if_byte_identity() {
        let ws = Arc::new(WsRelaySink::new());
        let (_client, mut rx, _replay) = ws.subscribe("sess-skip", None).await;
        let sinks: Vec<Arc<dyn EventSink>> = vec![ws.clone()];
        let payload = SkipIfPayload {
            agent_id: "a1".to_string(),
            optional_field: None,
        };
        let direct = serde_json::to_value(&payload).unwrap();
        fan_out(&sinks, Some("sess-skip"), "acp:session_created", &payload);
        let recorded = drain_rx(&mut rx);
        assert_eq!(recorded.len(), 1);
        assert_eq!(
            recorded[0].payload, direct,
            "fan_out's Value must match direct to_value, including skip_serializing_if"
        );
        assert!(
            recorded[0].payload.get("optionalField").is_none(),
            "skipped Option::None field must be absent from the wire payload, not null"
        );
        assert_eq!(recorded[0].payload["agentId"], "a1");
    }

    /// P2: compile-time proof that `EventSink` and its implementations are
    /// `Send + Sync` (the trait requires it, so `Arc<dyn EventSink>` can cross
    /// from the Tauri command thread into each agent's dedicated driver
    /// thread). A future field change that breaks this would fail to compile.
    #[test]
    fn event_sink_trait_and_impls_are_send_sync() {
        fn assert_send_sync<T: Send + Sync + ?Sized>() {}
        assert_send_sync::<AcpEvent>();
        assert_send_sync::<WsRelaySink>();
        assert_send_sync::<dyn EventSink>();
        assert_send_sync::<Arc<dyn EventSink>>();
        assert_send_sync::<Vec<Arc<dyn EventSink>>>();
    }

    /// AC11: bounded per-session ring evicts oldest events and bumps `base_seq`.
    #[tokio::test]
    async fn event_log_evicts_oldest_when_over_capacity() {
        let ws = Arc::new(WsRelaySink::with_capacity(2, 256));
        let sinks: Vec<Arc<dyn EventSink>> = vec![ws.clone()];
        for msg in ["a", "b", "c"] {
            fan_out(
                &sinks,
                Some("sess-evict"),
                "acp:tool_call",
                &TestPayload::new("a1", "sess-evict", msg),
            );
        }
        // Cursor pointing at evicted seq 0 must be stale (base_seq is now 2;
        // next wanted seq 1 was evicted).
        let (_c, mut rx, replay) = ws.subscribe("sess-evict", Some(0)).await;
        assert_eq!(replay, ReplayResult::Stale);
        assert!(drain_rx(&mut rx).is_empty());

        // Cursor at seq 1 → next wanted is 2, still in the ring → replay 2+3.
        let (_c2, mut rx2, replay2) = ws.subscribe("sess-evict", Some(1)).await;
        assert_eq!(replay2, ReplayResult::Ok(2));
        let drained2 = drain_rx(&mut rx2);
        assert_eq!(drained2.len(), 2);
        assert_eq!(drained2[0].seq, 2);
        assert_eq!(drained2[1].seq, 3);

        // Cursor at seq 2 → replay only seq 3.
        let (_c3, mut rx3, replay3) = ws.subscribe("sess-evict", Some(2)).await;
        assert_eq!(replay3, ReplayResult::Ok(1));
        let drained = drain_rx(&mut rx3);
        assert_eq!(drained.len(), 1);
        assert_eq!(drained[0].seq, 3);
        assert_eq!(drained[0].payload["message"], "c");
    }

    fn temp_dir(label: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("termul-sink-{label}-{stamp}"));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn durable_replay_catches_more_than_ring_capacity_then_streams_live() {
        let root = temp_dir("replay-catchup");
        let cwd = root.join("cwd");
        std::fs::create_dir_all(&cwd).unwrap();
        let persistence = SessionPersistence::open(root.join("sessions"))
            .await
            .unwrap();
        persistence
            .register_session(SessionRegistration {
                session_id: "sess-durable".to_string(),
                stable_agent_namespace: None,
                runtime_agent_id: None,
                project_id: None,
                cwd,
            })
            .await
            .unwrap();
        let relay = Arc::new(WsRelaySink::with_persistence(2, persistence.clone()));
        let sinks: Vec<Arc<dyn EventSink>> = vec![relay.clone()];
        for index in 1..=2 {
            fan_out(
                &sinks,
                Some("sess-durable"),
                "acp:tool_call",
                &TestPayload::new("a", "sess-durable", &index.to_string()),
            );
        }
        persistence.flush_session("sess-durable").await.unwrap();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let hook = crate::acp::session_persistence::ReplayTestHook::new(entered_tx);
        persistence.set_replay_test_hook(hook.clone());
        let subscribe_relay = relay.clone();
        let subscribe =
            tokio::spawn(async move { subscribe_relay.subscribe("sess-durable", Some(0)).await });
        tokio::task::spawn_blocking(move || entered_rx.recv().unwrap())
            .await
            .unwrap();
        // The first disk snapshot is now blocked. Inject more than ring capacity,
        // forcing the handoff to detect missing 3..8 and retry durable replay.
        for index in 3..=8 {
            fan_out(
                &sinks,
                Some("sess-durable"),
                "acp:tool_call",
                &TestPayload::new("a", "sess-durable", &index.to_string()),
            );
        }
        hook.release();
        let (_client, mut rx, replay) = subscribe.await.unwrap();
        assert_eq!(replay, ReplayResult::Ok(8));
        let replayed = drain_rx(&mut rx);
        assert_eq!(
            replayed.iter().map(|event| event.seq).collect::<Vec<_>>(),
            (1..=8).collect::<Vec<_>>()
        );
        fan_out(
            &sinks,
            Some("sess-durable"),
            "acp:tool_call",
            &TestPayload::new("a", "sess-durable", "live"),
        );
        assert_eq!(rx.recv().await.unwrap().seq, 9);
        persistence.shutdown().await.unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    /// AC11: reconnect with `last_seq` replays the log tail then streams live.
    #[tokio::test]
    async fn cursor_replay_then_live() {
        let ws = Arc::new(WsRelaySink::new());
        let sinks: Vec<Arc<dyn EventSink>> = vec![ws.clone()];
        fan_out(
            &sinks,
            Some("sess-rp"),
            "acp:tool_call",
            &TestPayload::new("a1", "sess-rp", "one"),
        );
        fan_out(
            &sinks,
            Some("sess-rp"),
            "acp:tool_call",
            &TestPayload::new("a1", "sess-rp", "two"),
        );

        let (_c, mut rx, replay) = ws.subscribe("sess-rp", Some(1)).await;
        assert_eq!(replay, ReplayResult::Ok(1));
        let replayed = drain_rx(&mut rx);
        assert_eq!(replayed.len(), 1);
        assert_eq!(replayed[0].seq, 2);
        assert_eq!(replayed[0].payload["message"], "two");

        fan_out(
            &sinks,
            Some("sess-rp"),
            "acp:tool_call",
            &TestPayload::new("a1", "sess-rp", "three"),
        );
        let live = drain_rx(&mut rx);
        assert_eq!(live.len(), 1);
        assert_eq!(live[0].seq, 3);
    }

    /// AC11: lossy ring drop-oldest under pressure (ring filled without flush).
    #[tokio::test]
    async fn lossy_ring_drop_oldest_under_pressure() {
        let ws = Arc::new(WsRelaySink::with_capacity(4096, 2));
        let (client, mut rx, _) = ws.subscribe("sess-lossy", None).await;
        for i in 1..=5 {
            let se = SequencedEvent::new(
                Some("sess-lossy".to_string()),
                i,
                "message_chunk",
                serde_json::json!({"message": format!("m{i}")}),
            );
            ws.push_lossy_no_flush_for_test(client, se);
        }
        assert_eq!(
            ws.lossy_ring_len_for_test(client),
            2,
            "capacity 2 keeps only newest"
        );
        assert_eq!(ws.flush_lossy(client), 2);
        let drained = drain_rx(&mut rx);
        assert_eq!(drained.len(), 2);
        assert_eq!(drained[0].seq, 4);
        assert_eq!(drained[1].seq, 5);
    }

    /// AC11: reliable events are never dropped even when lossy ring is full.
    #[tokio::test]
    async fn reliable_events_never_dropped() {
        let ws = Arc::new(WsRelaySink::with_capacity(4096, 1));
        let (client, mut rx, _) = ws.subscribe("sess-rel", None).await;
        let sinks: Vec<Arc<dyn EventSink>> = vec![ws.clone()];
        // Fill lossy ring without flush, then emit a reliable event.
        ws.push_lossy_no_flush_for_test(
            client,
            SequencedEvent::new(
                Some("sess-rel".to_string()),
                99,
                "message_chunk",
                serde_json::json!({"message": "buffered"}),
            ),
        );
        fan_out(
            &sinks,
            Some("sess-rel"),
            "acp:permission_request",
            &TestPayload::new("a1", "sess-rel", "must-arrive"),
        );
        let drained = drain_rx(&mut rx);
        assert!(
            drained.iter().any(|e| e.type_ == "permission_request"),
            "reliable event must be delivered"
        );
        assert!(
            drained.iter().any(|e| e.type_ == "message_chunk"),
            "buffered lossy is flushed before the reliable event"
        );
    }

    /// AC11: client on session A does not receive session B events.
    #[tokio::test]
    async fn cross_session_isolation() {
        let ws = Arc::new(WsRelaySink::new());
        let (_ca, mut rx_a, _) = ws.subscribe("sess-a", None).await;
        let (_cb, mut rx_b, _) = ws.subscribe("sess-b", None).await;
        let sinks: Vec<Arc<dyn EventSink>> = vec![ws.clone()];
        fan_out(
            &sinks,
            Some("sess-a"),
            "acp:tool_call",
            &TestPayload::new("a1", "sess-a", "only-a"),
        );
        fan_out(
            &sinks,
            Some("sess-b"),
            "acp:tool_call",
            &TestPayload::new("a1", "sess-b", "only-b"),
        );
        let a = drain_rx(&mut rx_a);
        let b = drain_rx(&mut rx_b);
        assert_eq!(a.len(), 1);
        assert_eq!(b.len(), 1);
        assert_eq!(a[0].payload["message"], "only-a");
        assert_eq!(b[0].payload["message"], "only-b");
        assert_eq!(a[0].sid.as_deref(), Some("sess-a"));
        assert_eq!(b[0].sid.as_deref(), Some("sess-b"));
    }

    /// Epic-4 bridge: `broadcast_projects_changed` fans an agent-level
    /// `projects_changed` event (sid=null, seq=0) to every connected client.
    /// A client subscribed to ANY session receives it (the web client then
    /// refetches `GET /projects`).
    #[tokio::test]
    async fn broadcast_projects_changed_reaches_subscribed_client() {
        let relay = Arc::new(WsRelaySink::new());
        // Subscribe a client to a session so it is in the relay's client set.
        let (_client, mut rx, _replay) = relay.subscribe("sess-1", None).await;

        broadcast_projects_changed(&relay, Some("p-3"));

        let drained = drain_rx(&mut rx);
        assert_eq!(drained.len(), 1, "exactly one projects_changed event");
        let evt = &drained[0];
        assert_eq!(evt.type_, "projects_changed");
        assert!(evt.sid.is_none(), "agent-level event: sid must be null");
        assert_eq!(evt.seq, 0, "agent-level event: seq must be 0");
        assert_eq!(evt.payload["activeProjectId"], "p-3");
    }

    /// `broadcast_projects_changed` with no active project still fans out;
    /// the `ProjectsChangedPayload` struct's `skip_serializing_if` OMITS the
    /// `activeProjectId` key entirely (not `null`).
    #[tokio::test]
    async fn broadcast_projects_changed_null_active_id() {
        let relay = Arc::new(WsRelaySink::new());
        let (_client, mut rx, _replay) = relay.subscribe("sess-1", None).await;

        broadcast_projects_changed(&relay, None);

        let drained = drain_rx(&mut rx);
        assert_eq!(drained.len(), 1);
        assert_eq!(drained[0].type_, "projects_changed");
        // `skip_serializing_if = "Option::is_none"` → the key is omitted, not null.
        assert!(
            drained[0].payload.get("activeProjectId").is_none(),
            "activeProjectId must be omitted (not null) when None"
        );
    }

    /// `broadcast_chat_history_changed` fans an agent-level event (`sid: None`,
    /// `seq: 0`) to every connected client so the web sidebar refetches the
    /// session index. Mirrors `broadcast_projects_changed`.
    #[tokio::test]
    async fn broadcast_chat_history_changed_reaches_subscribed_client() {
        let relay = Arc::new(WsRelaySink::new());
        let (_client, mut rx, _replay) = relay.subscribe("sess-1", None).await;

        broadcast_chat_history_changed(&relay);

        let drained = drain_rx(&mut rx);
        assert_eq!(drained.len(), 1);
        assert_eq!(drained[0].type_, "chat_history_changed");
        assert_eq!(drained[0].seq, 0, "agent-level event: seq must be 0");
        // The payload is empty `{}` — the web client refetches the index.
        assert!(drained[0].payload.as_object().unwrap().is_empty());
    }
}
