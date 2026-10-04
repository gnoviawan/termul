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
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tracing::{info, warn};
use uuid::Uuid;

use crate::acp::session_persistence::{
    now_millis, PersistedEventRecord, SessionPersistence, SessionPersistenceError,
    SESSION_SCHEMA_VERSION,
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

    /// Issue #836: notification that a session just registered with the
    /// durable store. The WS relay uses it to flush events it buffered while
    /// the session's durable writer was not yet installed (the agent's first
    /// emits can beat `register_session`). Default no-op so the desktop
    /// Tauri sink (and test sinks) need no change.
    fn note_session_registered(&self, _session_id: &str) {}
}

/// Batched desktop event name: one `acp:events` emit carries `events:
/// [{type, payload}]`, and the renderer fans each inner event out to the
/// listeners of its `acp:*` name. Each inner event keeps the full `acp:`
/// prefix so the fan-out key is the name clients already subscribe to.
pub const TAURI_EVENTS_BATCH: &str = "acp:events";

/// Coalesce window for desktop batches: 8ms ≈ one frame at 120Hz — tight
/// enough to be invisible in the UI, long enough to fold a streaming burst
/// into a single IPC crossing.
const TAURI_BATCH_WINDOW_MS: u64 = 8;

/// Flush early once this many events are buffered — a hard cap on batch
/// latency (a saturated queue flushes immediately, never waits the window).
const TAURI_BATCH_MAX: usize = 32;

/// Buffered event awaiting its batch flush. Owned clone of the emit inputs
/// (the dispatcher's `&AcpEvent` borrows don't outlive the call).
struct PendingTauriEvent {
    type_: String,
    payload: Value,
}

/// Desktop sink: forwards events to the Tauri renderer, batching bursts into
/// `acp:events` frames.
///
/// The dispatcher calls `emit` synchronously from driver threads and one
/// `app.emit` was one webview IPC crossing — under an 8-agent stream that is
/// ~160 crossings/sec of `MessagePort` dispatch + JSON parse. Buffering into
/// a shared `pending` queue and emitting one frame per window collapses the
/// burst: N crossings → 1, identical payload order.
///
/// Ordering: `pending` is a single FIFO and a `scheduled` flag admits exactly
/// one flusher task per window, so batches leave in strict emit order — the
/// `acp:events` payload preserves it verbatim. Loss window: ~8ms at process
/// teardown (unavoidable for any buffered sink; persistence mirrors every
/// event so replayed history is unaffected).
pub struct TauriEventSink {
    app: AppHandle,
    pending: Arc<Mutex<Vec<PendingTauriEvent>>>,
    scheduled: Arc<std::sync::atomic::AtomicBool>,
}

impl TauriEventSink {
    /// Wrap a Tauri app handle. The sink is cheap to construct and `Clone`-free
    /// (it shares the handle via `AppHandle`'s internal `Arc`).
    #[must_use]
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            pending: Arc::new(Mutex::new(Vec::new())),
            scheduled: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    /// Emit everything currently buffered as one `acp:events` frame.
    ///
    /// The `pending` lock is HELD ACROSS `app.emit`: pushes block for the
    /// duration of the serialize+post (~µs), so concurrent flushers (the
    /// timer task and an inline saturated emit) can never interleave batch
    /// contents — frames leave in strict FIFO order.
    fn flush_pending(app: &AppHandle, pending: &Arc<Mutex<Vec<PendingTauriEvent>>>) {
        let mut q = pending.lock();
        if q.is_empty() {
            return;
        }
        let events = std::mem::take(&mut *q);
        let batch = json!({
            "events": events
                .iter()
                .map(|e| json!({ "type": e.type_, "payload": e.payload }))
                .collect::<Vec<_>>()
        });
        if let Err(e) = app.emit(TAURI_EVENTS_BATCH, batch) {
            log::error!(
                "[acp] failed to emit {} batch ({} events): {e}",
                TAURI_EVENTS_BATCH,
                events.len()
            );
        }
    }

    /// Queue a batch flush: the timer races the size cap; whichever fires
    /// first drains the queue. The `scheduled` flag keeps exactly one flusher
    /// in flight so emission order is strictly FIFO.
    fn schedule_flush(&self) {
        if self
            .scheduled
            .swap(true, std::sync::atomic::Ordering::AcqRel)
        {
            return; // a flusher is already armed
        }
        let app = self.app.clone();
        let pending = Arc::clone(&self.pending);
        let scheduled = Arc::clone(&self.scheduled);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(TAURI_BATCH_WINDOW_MS)).await;
            loop {
                Self::flush_pending(&app, &pending);
                // Release the flag only once the queue is empty, then recheck
                // BEFORE letting go: a push that ran between the empty check
                // and the store sees `scheduled == false` and arms its own
                // flusher; a push whose event is already in the queue is
                // caught by the recheck and flushed by this task. No event
                // can strand.
                let q = pending.lock();
                if q.is_empty() {
                    scheduled.store(false, std::sync::atomic::Ordering::Release);
                    if q.is_empty() {
                        break;
                    }
                }
            }
        });
    }
}

impl EventSink for TauriEventSink {
    fn emit(&self, event: &AcpEvent) {
        let saturated = {
            let mut q = self.pending.lock();
            q.push(PendingTauriEvent {
                type_: event.type_.to_string(),
                payload: event.payload.clone(),
            });
            q.len() >= TAURI_BATCH_MAX
        };
        if saturated {
            // Size cap hit: drain inline (serialized on `pending`, so order
            // is preserved against any in-flight timer flush), then let the
            // armed task sweep whatever queued after this batch.
            Self::flush_pending(&self.app, &self.pending);
        }
        self.schedule_flush();
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
    /// Issue #836: durable records that arrived BEFORE the session registered
    /// with persistence (the agent's first events can beat
    /// `register_session`). `enqueue_event` rejects those with
    /// `SessionNotFound`; instead of dropping them (leaving a permanent seq
    /// hole in the JSONL that cursor-replay must then skip), buffer them here
    /// and flush on registration. Bounded: a session that never registers
    /// (ephemeral, or registration failed) drops its buffer at the cap — the
    /// live fan-out is unaffected either way.
    pre_registration_events: Mutex<HashMap<String, VecDeque<PersistedEventRecord>>>,
    /// Issue #836: per-session bound on the pre-registration buffer.
    pre_registration_capacity: usize,
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
    /// The session is unknown to both the relay live-map and the persistence
    /// catalog — nothing was registered (Story 7: `not_found` parity with
    /// `get_session_payload`).
    NotFound,
    /// `last_seq` is older than the log's oldest (evicted) event — the client
    /// must re-sync (AC4).
    Stale,
}

/// Issue #836 safety net: maximum durable re-read passes the cursor-replay
/// loop will make while waiting for a hole to fill. Every pass re-flushes and
/// re-scans the session JSONL, so an unbounded loop wedges the per-session
/// replay gate (and the WS read loop awaiting the handler inline) until the
/// keepalive watchdog drops the connection.
const REPLAY_MAX_PASSES: u32 = 4;

/// One contiguous run of sequence numbers missing from `cursor+1..=frontier`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SeqRange {
    start: u64,
    end: u64,
}

/// Find every contiguous hole in `cursor+1..=frontier` that is absent from
/// `by_seq` (issue #836). Pure: the cursor-replay loop uses it to decide
/// between a bounded retry (a hole inside the live-evicted window may fill
/// once a concurrent durable flush lands) and a skip (a stable hole below the
/// durable frontier — e.g. events dropped before the session registered with
/// persistence — never fills).
fn missing_seq_ranges(
    cursor: u64,
    frontier: u64,
    by_seq: &std::collections::BTreeMap<u64, SequencedEvent>,
) -> Vec<SeqRange> {
    let mut missing = Vec::new();
    let mut current: Option<SeqRange> = None;
    let start = cursor.saturating_add(1);
    if start == 0 || frontier < start {
        return missing;
    }
    for seq in start..=frontier {
        if by_seq.contains_key(&seq) {
            if let Some(range) = current.take() {
                missing.push(range);
            }
        } else {
            match &mut current {
                Some(range) => range.end = seq,
                None => current = Some(SeqRange { start: seq, end: seq }),
            }
        }
    }
    if let Some(range) = current {
        missing.push(range);
    }
    missing
}

/// Issue #836: per-session bound on the pre-registration durable buffer. The
/// window between an agent's first events and `register_session` is small
/// (milliseconds); 256 covers a burst while bounding memory for sessions that
/// never register.
const DEFAULT_PRE_REGISTRATION_CAPACITY: usize = 256;

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
            pre_registration_events: Mutex::new(HashMap::new()),
            pre_registration_capacity: DEFAULT_PRE_REGISTRATION_CAPACITY,
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
        // Eagerly restoring completed turn IDs for every session on startup
        // requires a full JSONL scan of all sessions (completed_turn_ids →
        // replay_after → load_jsonl per session). With 1000+ sessions this
        // added ~50s to startup. The `completed` watermark is only consulted
        // when a live prompt_complete arrives for a session — and for active
        // sessions, live events populate it naturally. For reconnected
        // clients, `mark_seen` + `is_seen` handle dedup independently.
        sink.persistence = Some(persistence);
        sink
    }

    /// Issue #836: notify the relay that `sid` just registered with the
    /// durable store. Flushes any events buffered while the session's writer
    /// was not yet installed (they arrived between the agent's first emit and
    /// `register_session`), preserving a contiguous seq run in the JSONL.
    /// Best-effort + idempotent: a failed enqueue (queue full / writer gone)
    /// logs and drops — the live fan-out already delivered those events, so
    /// only the durable replay tail is affected.
    pub fn note_session_registered(&self, sid: &str) {
        let Some(persistence) = &self.persistence else {
            return;
        };
        let drained: Vec<PersistedEventRecord> = {
            let mut pending = self.pre_registration_events.lock();
            pending.remove(sid).map_or_else(Vec::new, |queue| {
                queue.into_iter().collect::<Vec<_>>()
            })
        };
        if drained.is_empty() {
            return;
        }
        let mut requeued: Vec<PersistedEventRecord> = Vec::new();
        let mut enqueued = 0usize;
        for record in drained {
            // Split the record so the enqueue (which consumes it) and the
            // requeue path (which keeps it) never fight over ownership.
            let (enqueue_record, requeue_record) = (
                record.clone(),
                record,
            );
            match persistence.enqueue_event(enqueue_record) {
                Ok(()) => enqueued += 1,
                Err(SessionPersistenceError::SessionNotFound) => {
                    // The writer is still not installed (registration raced a
                    // concurrent delete): keep the record buffered for a
                    // later flush rather than dropping it.
                    requeued.push(requeue_record);
                }
                Err(error) => {
                    warn!(
                        "[sessions] pre-registration buffer flush rejected an event for \
                         session {sid}: {error}"
                    );
                }
            }
        }
        if !requeued.is_empty() {
            let mut pending = self.pre_registration_events.lock();
            let queue = pending.entry(sid.to_string()).or_default();
            for record in requeued {
                queue.push_back(record);
            }
        }
        if enqueued > 0 {
            info!(
                "[sessions] flushed {enqueued} pre-registration event(s) for session {sid}"
            );
        }
    }

    #[must_use]
    pub fn persistence(&self) -> Option<Arc<SessionPersistence>> {
        self.persistence.clone()
    }

    /// Whether the relay can serve this session id: live in the relay map
    /// (events were emitted — covers ephemeral never-persisted sessions) or,
    /// when persistence is attached, present in the catalog (finalized
    /// sessions replay from disk). Read-only: never reopens writers or mutates
    /// persisted state. `subscribe` / `open_persisted_session` gate on this so
    /// an unknown id gets `not_found` (parity with `get_session_payload`)
    /// instead of a silent empty subscribe.
    #[must_use]
    pub fn knows_session(&self, sid: &str) -> bool {
        self.session_known_locked(&self.sessions.lock(), sid)
    }

    /// Existence check with the `sessions` lock already held: live in the
    /// relay map or present in the persistence catalog. `subscribe` runs this
    /// under the same `sessions` lock it registers under — the lock
    /// `forget_session` removes under — so validation and registration are
    /// atomic and a concurrent forget cannot slip a subscription through the
    /// check→register gap.
    fn session_known_locked(&self, sessions: &HashMap<String, SessionState>, sid: &str) -> bool {
        if sessions.contains_key(sid) {
            return true;
        }
        self.persistence.as_ref().is_some_and(|persistence| {
            !matches!(
                persistence.metadata(sid),
                Err(SessionPersistenceError::SessionNotFound)
            )
        })
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
        // Reconcile the cached frontier with the durable frontier before
        // incrementing. The `set_session_title` MCP tool
        // (`record_local_title`) writes a durable
        // `local_title_generated` event directly through
        // `SessionPersistence::enqueue_event` (advancing durable `last_seq`
        // past the relay's cached value) BEFORE the synthetic
        // `session_info_update` reaches the relay. Without this
        // reconciliation the relay would assign a seq that collides with the
        // durable record, tripping the fail-closed `record.seq <=
        // current.last_seq` check in `append_record` on the next durable
        // enqueue.
        state.last_seq = state.last_seq.max(durable_last).saturating_add(1);
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
            if let Err(error) = persistence.enqueue_event(record.clone()) {
                // Story 8 (web honesty) + issue #836: `SessionNotFound` is
                // the expected outcome for BOTH a deleted session (delete won
                // the race against a still-streaming event — the durable
                // record is intentionally absent) AND a session whose
                // registration has not installed the durable writer yet (an
                // agent's first events can beat `register_session`). The
                // not-yet-registered case is BUFFERED (flushed to the writer
                // the moment registration lands — `note_session_registered`)
                // so the JSONL keeps a contiguous seq run; the deleted case
                // stays dropped. Every real failure class (queue full, writer
                // stopped, I/O) stays warn — the live fan-out continues
                // regardless.
                if matches!(error, SessionPersistenceError::SessionNotFound) {
                    let known_deleted = {
                        let mut pending = self.pre_registration_events.lock();
                        let queue = pending.entry(sid.to_string()).or_default();
                        queue.push_back(record);
                        while queue.len() > self.pre_registration_capacity {
                            queue.pop_front(); // drop-oldest
                        }
                        // A session that was known (registered) and then
                        // deleted has no catalog entry — nothing to flush
                        // into, and buffering forever would leak. Drop the
                        // buffer for ids the catalog no longer knows.
                        !matches!(
                            persistence.metadata(sid),
                            Err(SessionPersistenceError::SessionNotFound)
                        )
                    };
                    if known_deleted {
                        info!(
                            "[sessions] persistence queue skipped event for deleted session {sid}"
                        );
                    } else {
                        info!(
                            "[sessions] persistence queue buffered pre-registration event \
                             for session {sid} (seq {seq})"
                        );
                    }
                } else {
                    warn!("[sessions] persistence queue rejected event for session {sid}: {error}");
                }
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
    /// A session unknown to both the relay live-map and the persistence
    /// catalog — or one removed by `forget_session` — returns
    /// [`ReplayResult::NotFound`] and DOES NOT register: existence is
    /// re-validated under the same `sessions` lock registration takes (the
    /// lock `forget_session` removes under), on both the live-only and the
    /// cursor path, so a forget cannot race the check→register gap.
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
            // Live-only: validate existence and register under the SAME
            // `sessions` lock `forget_session` removes under — a concurrent
            // forget cannot slip a subscription through the check→register
            // gap, and an unknown/removed session gets `not_found` instead of
            // a silent empty subscription.
            let sessions = self.sessions.lock();
            if !self.session_known_locked(&sessions, sid) {
                return (client_id, rx, ReplayResult::NotFound);
            }
            self.register(client_id, sid, tx);
            return (client_id, rx, ReplayResult::Ok(0));
        };

        // Cursor path: cheap early-out so an unknown id routes to `not_found`
        // instead of falling into the durable-replay error path (which reports
        // `stale`). The authoritative check re-runs under the `sessions` lock
        // at registration below, closing the `forget_session` race.
        if !self.knows_session(sid) {
            return (client_id, rx, ReplayResult::NotFound);
        }

        let gate = {
            let mut gates = self.replay_gates.lock().await;
            gates
                .entry(sid.to_string())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                .clone()
        };
        let _replay_guard = gate.lock().await;
        let mut by_seq = std::collections::BTreeMap::new();
        // Issue #836 safety net: bound the durable re-read retry loop. A hole
        // that never fills (dropped-before-registration events) must terminate
        // the subscribe handshake, not spin past the WS keepalive watchdog.
        let mut passes: u32 = 0;
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
                // Lazily restore the completed-turn watermark from the
                // replayed records so `claim_turn` rejects already-completed
                // turns. This replaces the eager full-scan restoration that
                // was removed from `with_persistence`; it reuses records
                // already loaded for replay instead of scanning JSONL again.
                let mut restored_turn_ids: Vec<String> = Vec::new();
                for record in &durable {
                    if record.type_ == "prompt_complete" {
                        if let Some(turn_id) = record
                            .payload
                            .get("turnId")
                            .and_then(serde_json::Value::as_str)
                            .filter(|t| !t.is_empty())
                        {
                            restored_turn_ids.push(turn_id.to_string());
                        }
                    }
                }
                if !restored_turn_ids.is_empty() {
                    self.turn_watermark
                        .restore_completed(sid, restored_turn_ids);
                }
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
            // sequence from cursor+1 through the observed frontier. A hole
            // BELOW the durable frontier is non-fatal (issue #836): the very
            // first events of a session can be absent from disk when they
            // arrive before `register_session` installs the durable writer
            // (the enqueue rejects with `SessionNotFound` and the event is
            // only in the live ring), and no amount of re-flushing conjures
            // them back — re-reading the same JSONL forever spins the
            // subscribe loop past the WS keepalive watchdog. Skip the hole
            // (warn once per missing range) and continue replay from the next
            // available seq instead. A hole at-or-above the ring's base (the
            // live-evicted window) still retries so a concurrent durable
            // flush in flight at read time can land, bounded by
            // REPLAY_MAX_PASSES so the loop always terminates.
            let frontier = last_seq;
            let missing = missing_seq_ranges(cursor, frontier, &by_seq);
            if !missing.is_empty() {
                if self.persistence.is_none() || base_seq <= cursor.saturating_add(1) {
                    return (client_id, rx, ReplayResult::Stale);
                }
                if passes >= REPLAY_MAX_PASSES {
                    warn!(
                        "[ws] replay hole in session {sid} below the durable frontier did \
                         not fill after {passes} passes (missing {missing:?}); skipping"
                    );
                } else if missing.iter().all(|range| range.end < base_seq) && passes > 0 {
                    // Stable hole below the durable read: the durable replay
                    // already ran at least once with the flush barrier before
                    // it, so the bytes genuinely do not exist on disk. Log +
                    // skip so replay still delivers every seq that DOES exist.
                    warn!(
                        "[ws] replay hole in session {sid} (seq {}..={} missing from \
                         disk + ring; skipping to keep replay finite)",
                        missing[0].start,
                        missing[0].end
                    );
                } else {
                    // First observation (or a hole inside the live-evicted
                    // window): drop the state lock, re-flush + re-read durable
                    // history, and retry before registering.
                    drop(sessions);
                    passes += 1;
                    continue;
                }
            }

            // Re-validate under the still-held `sessions` lock: the session may
            // have been forgotten while the durable replay was in flight.
            if !self.session_known_locked(&sessions, sid) {
                return (client_id, rx, ReplayResult::NotFound);
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

    /// Test helper: mark a session as known (empty log, next emit gets seq 1)
    /// without emitting — `subscribe` rejects unknown sessions with
    /// [`ReplayResult::NotFound`], so fan-out tests that subscribe before the
    /// first event seed the session first.
    #[cfg(test)]
    pub(crate) fn seed_session_for_test(&self, sid: &str) {
        self.sessions
            .lock()
            .entry(sid.to_string())
            .or_insert_with(|| SessionState {
                last_seq: 0,
                events: VecDeque::new(),
                snapshot_events: Vec::new(),
                base_seq: 1,
            });
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

        // CAP-2: history is now host-owned. When a session is created,
        // finalized, or its title metadata changes at the host (regardless of
        // which client drove it), notify every connected client so sidebars
        // refetch the host index instead of depending on a desktop renderer
        // save. `session_info_update` covers agent-supplied titles;
        // `local_title_generated` covers background title generation. Only
        // fires when durable persistence is attached (live-only mode has
        // nothing to refetch).
        if self.persistence().is_some()
            && matches!(
                type_,
                "session_created"
                    | "session_closed"
                    | "session_info_update"
                    | "local_title_generated"
                    // CAP-2 (spec-in-chat-agent-switch): a durable switch
                    // marker mutates last_seq/last_activity_at — the live
                    // fan-out (emitted after the record is durable) triggers
                    // the same index refetch as a title change.
                    | "agent_switch"
            )
        {
            self.notify_history_changed();
        }
    }
}

impl WsRelaySink {
    /// Agent-level `chat_history_changed` fan-out (mirrors
    /// `broadcast_chat_history_changed`, but callable from inside `emit` where
    /// no `Arc<Self>` is available). Empty payload; clients refetch the index.
    fn notify_history_changed(&self) {
        let type_ = "chat_history_changed";
        let se = SequencedEvent::new(None, 0, type_, json!({}));
        let tier = tier_of(type_);
        let targets: Vec<ClientId> = self.clients.lock().keys().copied().collect();
        for client_id in targets {
            self.enqueue(client_id, se.clone(), tier);
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
/// Called by the `remote_sync_projects` command (desktop-hosted push — the
/// desktop's active IS the default) and the explicit `set_default_project`
/// operation (Tauri command + WS request + HTTP route) after they update the
/// [`crate::web::project_registry::ProjectRegistry`]. The event is agent-level
/// (`sid: None`, `seq: 0`) so [`WsRelaySink::emit`] fans it out to ALL connected
/// clients (the wire `type` is `projects_changed` — the `acp:` prefix is
/// stripped by `emit`). The payload carries only the new `defaultProjectId`;
/// the web client refetches `GET /projects` for the full list. On the initial
/// load a client seeds `activeProjectId` from `defaultProjectId`; on subsequent
/// events it preserves its own `activeProjectId` (no silent retarget).
///
/// `default_project_id` is `None` when the host has no default project.
pub fn broadcast_projects_changed(relay: &Arc<WsRelaySink>, default_project_id: Option<&str>) {
    // Use the typed `ProjectsChangedPayload` (single source of truth for the
    // wire shape) rather than hand-rolled `json!` — its `skip_serializing_if`
    // omits `defaultProjectId` when `None` (the web client ignores the payload
    // + refetches `GET /projects`, so omit-vs-null is cosmetic, but the
    // struct stays the canonical shape if fields are added later).
    let payload = ProjectsChangedPayload {
        default_project_id: default_project_id.map(str::to_string),
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
mod tests;
