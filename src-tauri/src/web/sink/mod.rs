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
use tracing::warn;

use crate::acp::session_persistence::{
    PersistedEventRecord, SessionPersistence, SessionPersistenceError,
};

mod fanout;
mod session_log;
mod watch_bridge;

pub use fanout::{ClientId, EventStream, StreamItem};
pub use watch_bridge::{broadcast_chat_history_changed, broadcast_projects_changed};

use fanout::ClientSub;
use session_log::{RelaySeqAuthority, SessionState};

// Global lock order for WsRelaySink (never invert — avoids deadlock):
// 0. the session's persistence send lock (`with_ordered_sender`, durable
//    publishes only)  1. `sessions`  2. `clients`  3. `session_subs`
// Prefer releasing a lock before acquiring the next when both are not required
// for the critical section. `pre_registration_events` is a leaf lock.

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

    /// The live relay behind this sink, if it is one. Host-authored records
    /// (session title, agent switch) take their seq from the relay's single
    /// allocator, so their callers need to reach it through `dyn EventSink`.
    fn as_ws_relay(&self) -> Option<&WsRelaySink> {
        None
    }
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
/// subscriber set. It is the ONE seq authority of every session log: relay
/// events and host-authored records alike are numbered here (see
/// `session_log`). `emit` is called from the per-agent driver thread (via
/// [`fan_out`]) and is NON-blocking: it assigns `seq`, persists, appends to
/// the log, and fans out to each subscribed client's bounded
/// `tokio::sync::mpsc::Sender` in one critical section.
///
/// # Tier handling (AC5)
///
/// Fan-out never waits: a subscription's channel holds
/// `DEFAULT_CLIENT_QUEUE_CAPACITY` items (plus room for the replay it started
/// with, capped at the event-log capacity) and a slow peer cannot grow it.
///
/// - **Lossy** events (`message_chunk`, `tool_call_update`, `commands_update`,
///   `plan_update`) that find the channel full are dropped, and one
///   [`StreamItem::Gap`] is queued ahead of the next event of that session
///   once the channel has room again. The client answers a gap with an atomic
///   snapshot (and notices a hole by seq even without one).
/// - **Reliable** events that find the channel full close the peer's
///   connection (through the token handed to `subscribe`) instead of being
///   dropped: the client reconnects and resumes by cursor.
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
    sessions: Arc<Mutex<HashMap<String, SessionState>>>,
    /// Per-client subscription: client_id → client state (sender + sessions).
    clients: Mutex<HashMap<ClientId, ClientSub>>,
    /// Reverse index: session_id → set of subscribed client_ids.
    session_subs: Mutex<HashMap<String, HashSet<ClientId>>>,
    /// Bounded per-session ring capacity (default 4096, AC4).
    event_log_capacity: usize,
    /// Capacity of each subscription's bounded channel into its connection.
    client_queue_capacity: usize,
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
    /// Single-flight gate per session for [`Self::ensure_turns_restored`].
    restore_gates: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Per-`projectId` filesystem watch subscriptions (`watch_project` /
    /// `unwatch_project`). `fs_changed` events go only to subscribed
    /// connections, not through the client registry above.
    fs_watches: crate::web::fs_watcher::FsWatchHub,
    /// The command receipt ledger, shared by `/ws` dispatch and the Tauri
    /// `acp_*` commands (one ledger per host).
    ledger: Arc<crate::web::command_ledger::CommandLedger>,
    /// Authenticated connections per `deviceId`, shared by `/ws` and
    /// `/terminal/ws` (both reach the relay through `AppState.relay`).
    presence: Arc<crate::web::presence::PresenceRegistry>,
}

/// Where a session's log stands at a point under the seq lock: the identity
/// of the log incarnation and its head. Events with `seq <= head_seq` are
/// replay, anything above is live.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogHead {
    pub log_epoch: String,
    pub head_seq: u64,
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

/// Issue #836: per-session bound on the pre-registration durable buffer. The
/// window between an agent's first events and `register_session` is small
/// (milliseconds); 256 covers a burst while bounding memory for sessions that
/// never register.
const DEFAULT_PRE_REGISTRATION_CAPACITY: usize = 256;

/// Default per-session event-log capacity (AC4).
pub const DEFAULT_EVENT_LOG_CAPACITY: usize = 4096;
/// Default capacity of each subscription's bounded channel into its
/// connection (the bound a slow peer can add to the host's memory).
const DEFAULT_CLIENT_QUEUE_CAPACITY: usize = 256;

impl WsRelaySink {
    /// Create a live relay sink with default capacities
    /// (`event_log_capacity = 4096`, `client_queue_capacity = 256`).
    #[must_use]
    pub fn new() -> Self {
        Self::with_capacity(DEFAULT_EVENT_LOG_CAPACITY, DEFAULT_CLIENT_QUEUE_CAPACITY)
    }

    /// Create a live relay sink with explicit capacities: the per-session
    /// event log and each subscription's bounded channel.
    #[must_use]
    pub fn with_capacity(event_log_capacity: usize, client_queue_capacity: usize) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            clients: Mutex::new(HashMap::new()),
            session_subs: Mutex::new(HashMap::new()),
            event_log_capacity: event_log_capacity.max(1),
            client_queue_capacity: client_queue_capacity.max(1),
            rendezvous: Mutex::new(None),
            question_rendezvous: Mutex::new(None),
            turn_watermark: crate::web::permissions::TurnWatermark::new(),
            pre_registration_events: Mutex::new(HashMap::new()),
            pre_registration_capacity: DEFAULT_PRE_REGISTRATION_CAPACITY,
            persistence: None,
            replay_gates: tokio::sync::Mutex::new(HashMap::new()),
            restore_gates: Mutex::new(HashMap::new()),
            fs_watches: crate::web::fs_watcher::FsWatchHub::default(),
            ledger: Arc::new(crate::web::command_ledger::CommandLedger::new(
                std::time::Duration::from_secs(
                    crate::web::config::DEFAULT_RECEIPT_RETENTION_SECS,
                ),
            )),
            presence: Arc::new(crate::web::presence::PresenceRegistry::new()),
        }
    }

    /// The command receipt ledger.
    #[must_use]
    pub fn ledger(&self) -> &Arc<crate::web::command_ledger::CommandLedger> {
        &self.ledger
    }

    /// Replace the ledger (outcome retention from `ServerConfig`, or a test
    /// ledger with an injected clock). Call before the sink is shared.
    #[must_use]
    pub fn with_ledger(mut self, ledger: crate::web::command_ledger::CommandLedger) -> Self {
        self.ledger = Arc::new(ledger);
        self
    }

    /// The per-project filesystem watch manager.
    #[must_use]
    pub fn fs_watches(&self) -> &crate::web::fs_watcher::FsWatchHub {
        &self.fs_watches
    }

    /// Device presence registry (connections per `deviceId`).
    #[must_use]
    pub fn presence(&self) -> &Arc<crate::web::presence::PresenceRegistry> {
        &self.presence
    }

    /// Create a live relay sink with a custom per-session event-log capacity and
    /// the default per-subscription channel capacity. Used by
    /// `termul-server` to thread `ServerConfig::event_log_capacity`.
    #[must_use]
    pub fn with_log_capacity(event_log_capacity: usize) -> Self {
        Self::with_capacity(event_log_capacity, DEFAULT_CLIENT_QUEUE_CAPACITY)
    }

    #[must_use]
    pub fn with_persistence(
        event_log_capacity: usize,
        persistence: Arc<SessionPersistence>,
    ) -> Self {
        let mut sink = Self::with_capacity(event_log_capacity, DEFAULT_CLIENT_QUEUE_CAPACITY);
        // Eagerly restoring completed turn IDs for every session on startup
        // requires a full JSONL scan of all sessions (completed_turn_ids →
        // replay_after → load_jsonl per session). With 1000+ sessions this
        // added ~50s to startup. The `completed` watermark is only consulted
        // when a live prompt_complete arrives for a session — and for active
        // sessions, live events populate it naturally. For reconnected
        // clients, `mark_seen` + `is_seen` handle dedup independently.
        persistence.set_seq_authority(Arc::new(RelaySeqAuthority {
            sessions: Arc::clone(&sink.sessions),
            persistence: Arc::downgrade(&persistence),
        }));
        sink.persistence = Some(persistence);
        sink
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

    /// Restore `session_id`'s completed-turn set from durable history once,
    /// before a prompt claims a turn. Completed turns are otherwise restored
    /// only lazily on subscribe, so a resend of a completed `turnId` after a
    /// host restart (before any subscribe) would find no record of the turn
    /// and run it again. Single-flight per session: concurrent claims wait for
    /// the first scan instead of repeating it.
    ///
    /// A session with no durable history (no persistence, or not in the
    /// catalog: ephemeral) has nothing to restore. Any other failure is
    /// returned: claiming without the completed set could re-run a finished
    /// turn, so the caller must refuse the prompt (the next claim retries).
    ///
    /// # Errors
    /// A generic message when the durable read failed; the cause is logged.
    pub async fn ensure_turns_restored(&self, session_id: &str) -> Result<(), String> {
        let Some(persistence) = &self.persistence else {
            return Ok(());
        };
        if self.turn_watermark.is_restored(session_id) {
            return Ok(());
        }
        let gate = Arc::clone(
            self.restore_gates
                .lock()
                .entry(session_id.to_string())
                .or_default(),
        );
        let _single_flight = gate.lock().await;
        if self.turn_watermark.is_restored(session_id) {
            return Ok(());
        }
        match persistence.completed_turn_ids_async(session_id.to_string()).await {
            Ok(turn_ids) => {
                self.turn_watermark.restore_completed(session_id, turn_ids);
                self.turn_watermark.mark_restored(session_id);
                Ok(())
            }
            Err(crate::acp::session_persistence::SessionPersistenceError::SessionNotFound) => {
                Ok(())
            }
            Err(error) => {
                warn!(
                    "[prompt] completed turns could not be restored for session {}: {error}",
                    crate::logging::redact_session_id(session_id)
                );
                Err("the session's turn history could not be read; retry the prompt".to_string())
            }
        }
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
}

impl Default for WsRelaySink {
    fn default() -> Self {
        Self::new()
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

/// Where [`record_host_event`] delivers a host-authored record besides the
/// relay that numbers it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostRecordFanout {
    /// Only the relay (a durable record whose desktop twin is a different
    /// event the caller fans out itself).
    RelayOnly,
    /// Every other sink too (the desktop renderer gets the same event).
    AllSinks,
}

/// Number, persist and fan out a host-authored record (session title, agent
/// switch) through the sink that owns the session log. The relay is the only
/// seq authority, so the record's seq is allocated there, in one critical
/// section with its durable append and live fan-out.
///
/// `type_` carries the `acp:` prefix like [`fan_out`]. Returns the allocated
/// seq. Any failure leaves nothing allocated, persisted or delivered.
///
/// # Errors
///
/// The relay's persistence error ([`SessionPersistenceError`]) or
/// [`HostRecordError::NoSeqAuthority`] when `sinks` holds no relay.
pub fn record_host_event<P: Serialize>(
    sinks: &[Arc<dyn EventSink>],
    sid: &str,
    type_: &'static str,
    payload: &P,
    fanout: HostRecordFanout,
) -> Result<u64, HostRecordError> {
    let payload = serde_json::to_value(payload).map_err(|error| {
        log::error!("[acp] skipping host record {type_}: payload failed to serialize: {error}");
        HostRecordError::Serialize
    })?;
    let relay = sinks
        .iter()
        .find_map(|sink| sink.as_ws_relay())
        .ok_or(HostRecordError::NoSeqAuthority)?;
    let wire_type = type_.strip_prefix("acp:").unwrap_or(type_);
    let seq = relay
        .record_host_event(sid, wire_type, payload.clone())
        .map_err(HostRecordError::Persistence)?
        .seq;
    if fanout == HostRecordFanout::AllSinks {
        let event = AcpEvent {
            sid: Some(sid.to_string()),
            type_,
            payload,
        };
        for sink in sinks.iter().filter(|sink| sink.as_ws_relay().is_none()) {
            sink.emit(&event);
        }
    }
    Ok(seq)
}

/// Why [`record_host_event`] produced no record.
#[derive(Debug)]
pub enum HostRecordError {
    /// The payload could not be serialized.
    Serialize,
    /// No relay among the sinks to number the record.
    NoSeqAuthority,
    /// The relay could not persist the record (writer missing, stopped,
    /// unhealthy). Nothing was allocated or fanned out.
    Persistence(SessionPersistenceError),
}

impl std::fmt::Display for HostRecordError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Serialize => write!(f, "host record payload failed to serialize"),
            Self::NoSeqAuthority => write!(f, "no relay available to number the host record"),
            Self::Persistence(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for HostRecordError {}

#[cfg(test)]
mod epoch_tests;
#[cfg(test)]
mod log_integrity_tests;
#[cfg(test)]
mod tests;
