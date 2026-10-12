//! Per-session log of the relay: the one seq authority, the atomic
//! assign + persist + fan-out critical section, cursor replay and snapshot
//! registration.
//!
//! # One seq authority
//!
//! [`WsRelaySink`] hands out every per-session seq. Relay events
//! ([`WsRelaySink::publish`]) and host-authored records
//! ([`WsRelaySink::record_host_event`]: title, agent switch) take the same
//! counter, so the durable JSONL, the in-memory ring and the live stream agree
//! on what seq N is. The session writer never assigns one; the single record it
//! authors itself (the shutdown `interrupted` marker) asks
//! [`RelaySeqAuthority`].
//!
//! # Critical section
//!
//! Assign + ring append + durable enqueue + per-client enqueue run under one
//! lock chain, in this order (never invert):
//!
//! 1. the session's persistence send lock (`with_ordered_sender`, durable
//!    events only),
//! 2. `sessions`,
//! 3. `clients`,
//! 4. `session_subs` (read-only target copy, released before `clients`).
//!
//! Every enqueue inside it is non-blocking. Subscribe/snapshot registration
//! takes `sessions` too, so a client sees an event exactly once: in the
//! replay it was registered behind, or live after registration.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::convert::Infallible;
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};
use uuid::Uuid;

use crate::acp::session_persistence::{
    is_durable_event, now_millis, PersistedEventRecord, SeqAuthority, SessionPersistence,
    SessionPersistenceError, SESSION_SCHEMA_VERSION,
};
use crate::web::ws::{tier_of, ReliabilityTier, SequencedEvent};

use super::fanout::Gaps;
use super::{ClientId, EventStream, LogHead, ReplayResult, StreamItem, WsRelaySink};

/// Per-session seq counter + append-only bounded ring (held under
/// [`WsRelaySink::sessions`]).
pub(super) struct SessionState {
    /// Last assigned seq (0 = none yet; next publish assigns `last_seq + 1`).
    pub(super) last_seq: u64,
    /// Identity of this log incarnation. A cursor is only meaningful against
    /// the epoch it was issued under.
    pub(super) log_epoch: String,
    /// A live-only event took a seq the durable log will never hold, so the
    /// allocated frontier is ahead of the disk. Remembered here because the
    /// session may not be registered with persistence yet; applied when it is.
    pub(super) head_ahead_of_durable: bool,
    /// Bounded ring; oldest evicted when `len > capacity`.
    pub(super) events: VecDeque<SequencedEvent>,
    /// `seq` of the oldest event currently in the ring (for cursor-gap detect).
    pub(super) base_seq: u64,
}

impl SessionState {
    /// Fresh state whose next seq follows `last_seq` (the durable frontier of
    /// a session this process has not published to yet), under `log_epoch`.
    fn new(last_seq: u64, log_epoch: String) -> Self {
        Self {
            last_seq,
            log_epoch,
            head_ahead_of_durable: false,
            events: VecDeque::new(),
            base_seq: last_seq.saturating_add(1),
        }
    }

    /// Existing state for `sid`, or a fresh one seeded at `durable_last`. A
    /// durable session's epoch is the one persisted in its metadata (so
    /// cursors survive a host restart); a session with none (non-durable)
    /// mints one per process.
    pub(super) fn entry<'a>(
        sessions: &'a mut HashMap<String, SessionState>,
        sid: &str,
        durable_last: u64,
        persistence: Option<&SessionPersistence>,
    ) -> &'a mut SessionState {
        sessions.entry(sid.to_string()).or_insert_with(|| {
            let log_epoch = persistence
                .and_then(|persistence| persistence.log_epoch(sid))
                .unwrap_or_else(|| Uuid::new_v4().to_string());
            SessionState::new(durable_last, log_epoch)
        })
    }

    /// Adopt the durable session's persisted epoch. The agent's first events
    /// can beat `register_session` and create this state under a
    /// process-minted epoch; the persisted one is what a cursor must survive a
    /// restart under, so it wins as soon as the session is registered.
    fn adopt_persisted_epoch(&mut self, sid: &str, persistence: Option<&SessionPersistence>) {
        if let Some(epoch) = persistence.and_then(|persistence| persistence.log_epoch(sid)) {
            if epoch != self.log_epoch {
                self.log_epoch = epoch;
            }
        }
    }

    pub(super) fn head(&self) -> LogHead {
        LogHead {
            log_epoch: self.log_epoch.clone(),
            head_seq: self.last_seq,
        }
    }
}

/// What the publish critical section does about durability.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Persist {
    /// Live only: not a durable event, no persistence, or a host record the
    /// relay must never append a second time (`agent_switch`: only
    /// `record_host_event` writes it).
    Skip,
    /// Enqueue to the session's writer (the send lock is held by the caller).
    Enqueue,
    /// No writer is installed (no send lock held): buffer the record directly.
    Buffer,
}

/// Event types only [`WsRelaySink::record_host_event`] may append durably. A
/// relay `emit` of one is live-only, so a switch can never gain a second
/// durable record.
fn is_host_record_type(type_: &str) -> bool {
    type_ == "agent_switch"
}

/// The relay's [`SeqAuthority`]: hands the session writer a seq from the same
/// counter live events use.
pub(super) struct RelaySeqAuthority {
    pub(super) sessions: Arc<Mutex<HashMap<String, SessionState>>>,
    /// Weak: the persistence owns this authority.
    pub(super) persistence: std::sync::Weak<SessionPersistence>,
}

impl SeqAuthority for RelaySeqAuthority {
    fn allocate_after(&self, session_id: &str, floor: u64) -> u64 {
        let mut sessions = self.sessions.lock();
        let persistence = self.persistence.upgrade();
        let state = SessionState::entry(&mut sessions, session_id, floor, persistence.as_deref());
        state.last_seq = state.last_seq.max(floor).saturating_add(1);
        state.last_seq
    }
}

/// Issue #836 safety net: maximum durable re-read passes the cursor-replay
/// loop will make while waiting for a hole to fill. Every pass re-flushes and
/// re-scans the session JSONL, so an unbounded loop wedges the per-session
/// replay gate (and the WS read loop awaiting the handler inline) until the
/// keepalive watchdog drops the connection.
const REPLAY_MAX_PASSES: u32 = 4;

/// One contiguous run of sequence numbers missing from `cursor+1..=frontier`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct SeqRange {
    pub(super) start: u64,
    pub(super) end: u64,
}

/// Find every contiguous hole in `cursor+1..=frontier` that is absent from
/// `by_seq` (issue #836). Pure: the cursor-replay loop uses it to decide
/// between a bounded retry (a hole inside the live-evicted window may fill
/// once a concurrent durable flush lands) and a skip (a stable hole below the
/// durable frontier — e.g. events dropped before the session registered with
/// persistence — never fills).
pub(super) fn missing_seq_ranges(
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


impl WsRelaySink {
    /// Durable (written) frontier of `sid`, `0` when unknown or unreadable.
    fn durable_last_seq(&self, sid: &str) -> u64 {
        self.persistence
            .as_ref()
            .and_then(|persistence| persistence.last_seq(sid).ok())
            .unwrap_or(0)
    }

    /// The epoch of `sid`'s log: the durable session's persisted epoch when it
    /// has one, else this process's state.
    fn current_log_epoch(&self, sid: &str) -> Option<String> {
        self.persistence
            .as_ref()
            .and_then(|persistence| persistence.log_epoch(sid))
            .or_else(|| {
                self.sessions
                    .lock()
                    .get(sid)
                    .map(|state| state.log_epoch.clone())
            })
    }

    /// Where `sid`'s log stands right now, without creating any state: this
    /// process's log when it has one, else the durable session's persisted
    /// epoch and frontier. `None` for a session nothing knows.
    #[must_use]
    pub fn log_head(&self, sid: &str) -> Option<LogHead> {
        if let Some(state) = self.sessions.lock().get(sid) {
            let mut head = state.head();
            if let Some(epoch) = self.persistence.as_ref().and_then(|p| p.log_epoch(sid)) {
                head.log_epoch = epoch;
            }
            return Some(head);
        }
        let persistence = self.persistence.as_ref()?;
        Some(LogHead {
            log_epoch: persistence.log_epoch(sid)?,
            head_seq: persistence.last_seq(sid).ok()?,
        })
    }

    /// Head of `sid`'s log under the already-held `sessions` lock, creating
    /// the state (seeded at the durable frontier) when this process has not
    /// published to the session yet.
    pub(super) fn session_head_locked(
        &self,
        sessions: &mut HashMap<String, SessionState>,
        sid: &str,
    ) -> LogHead {
        let durable_last = self.durable_last_seq(sid);
        let state = SessionState::entry(sessions, sid, durable_last, self.persistence.as_deref());
        state.adopt_persisted_epoch(sid, self.persistence.as_deref());
        state.head()
    }

    /// Assign a seq to a relay event, persist it, append it to the ring and
    /// fan it out to every subscriber of `sid`, atomically (see the module
    /// critical-section note). A persistence failure never loses the live
    /// event: a not-yet-registered session buffers the record, anything else
    /// is logged.
    pub(super) fn publish(
        &self,
        sid: &str,
        type_: &str,
        payload: Value,
        tier: ReliabilityTier,
    ) -> SequencedEvent {
        let result = match &self.persistence {
            Some(persistence) if is_durable_event(type_) && !is_host_record_type(type_) => {
                // Durable events take the session send lock BEFORE `sessions`.
                // Inside it the pre-registration buffer drains first: those
                // records already carry lower seqs and MUST reach the writer
                // ahead of this one. A full writer queue diverts to the
                // session's overflow forwarder instead of parking this
                // thread, so holding the lock never wedges the agent driver
                // runtime.
                match persistence.with_ordered_sender(sid, payload, |payload| {
                    self.flush_pre_registration_locked(persistence, sid);
                    self.publish_locked(
                        sid,
                        type_,
                        payload,
                        tier,
                        Persist::Enqueue,
                        Self::absorb_persist_error,
                    )
                }) {
                    Ok(result) => result,
                    // No writer yet: buffer the record directly. Never call
                    // `enqueue_event` here: it takes the session send lock,
                    // and a writer installing in between would then take it
                    // AFTER `sessions` (lock inversion).
                    Err(payload) => self.publish_locked(
                        sid,
                        type_,
                        payload,
                        tier,
                        Persist::Buffer,
                        Self::absorb_persist_error,
                    ),
                }
            }
            _ => self.publish_locked(
                sid,
                type_,
                payload,
                tier,
                Persist::Skip,
                Self::absorb_persist_error,
            ),
        };
        let (event, head_ahead) = match result {
            Ok(published) => published,
            Err(never) => match never {},
        };
        self.mark_head_ahead(sid, head_ahead);
        event
    }

    /// Tell persistence that `sid`'s allocated frontier is ahead of its disk
    /// (a live-only event, or a durable record that could not be queued, took
    /// a seq the JSONL will never hold). Outside the `sessions` lock: the
    /// writer queue is taken before it.
    fn mark_head_ahead(&self, sid: &str, head_ahead: bool) {
        if !head_ahead {
            return;
        }
        if let Some(persistence) = &self.persistence {
            persistence.note_head_ahead_of_durable(sid);
        }
    }

    /// Allocate a seq for a host-authored record (session title, agent
    /// switch), persist it and fan it out live, atomically. This is the only
    /// way such a record gets a seq: the session writer never assigns one.
    ///
    /// Unlike relay events, a persistence failure is an error: nothing is
    /// allocated, persisted or fanned out, and the caller reports the
    /// failure. A session with no writer installed is
    /// [`SessionPersistenceError::SessionNotFound`].
    ///
    /// The record is durable and live under the same seq; the caller awaits
    /// [`Self::flush_prompt_record`] for the durability boundary.
    pub fn record_host_event(
        &self,
        sid: &str,
        type_: &str,
        payload: Value,
    ) -> Result<SequencedEvent, SessionPersistenceError> {
        let tier = tier_of(type_);
        fn reject(
            _: &WsRelaySink,
            _: &SessionPersistence,
            _: PersistedEventRecord,
            error: SessionPersistenceError,
        ) -> Result<(), SessionPersistenceError> {
            Err(error)
        }
        let event = match &self.persistence {
            Some(persistence) if is_durable_event(type_) => {
                persistence.with_ordered_sender(sid, payload, |payload| {
                    // Reject up front on an unhealthy writer: nothing may be
                    // allocated or delivered for a record that cannot persist.
                    persistence.ensure_writer_healthy(sid)?;
                    self.flush_pre_registration_locked(persistence, sid);
                    self.publish_locked(sid, type_, payload, tier, Persist::Enqueue, reject)
                })
                .map_err(|_| SessionPersistenceError::SessionNotFound)??
            }
            _ => self.publish_locked(sid, type_, payload, tier, Persist::Skip, reject)?,
        };
        let (event, head_ahead) = event;
        self.mark_head_ahead(sid, head_ahead);
        self.notify_history_for(type_);
        Ok(event)
    }

    /// The critical section: assign, persist, ring-append, fan out. The caller
    /// already holds the session send lock when the event is durable.
    /// [`Persist::Buffer`] (no writer, so no send lock is held) skips
    /// `enqueue_event` and takes the `SessionNotFound` path directly.
    ///
    /// `on_persist_error` decides what a failed durable enqueue means: relay
    /// events absorb it (the live event must not be lost), host records
    /// reject (nothing is allocated, so the seq stays free).
    fn publish_locked<E>(
        &self,
        sid: &str,
        type_: &str,
        payload: Value,
        tier: ReliabilityTier,
        persist: Persist,
        on_persist_error: fn(
            &Self,
            &SessionPersistence,
            PersistedEventRecord,
            SessionPersistenceError,
        ) -> Result<(), E>,
    ) -> Result<(SequencedEvent, bool), E> {
        let mut sessions = self.sessions.lock();
        let durable_last = self.durable_last_seq(sid);
        let state =
            SessionState::entry(&mut sessions, sid, durable_last, self.persistence.as_deref());
        state.adopt_persisted_epoch(sid, self.persistence.as_deref());
        if durable_last > state.last_seq {
            // Nothing but the relay allocates seqs, so the durable frontier
            // can never lead. Adopt it rather than collide with the log.
            warn!(
                "[sessions] seq frontier drift for session {sid}: durable {durable_last} is ahead \
                 of the relay's {}; adopting the durable frontier",
                state.last_seq
            );
            state.last_seq = durable_last;
        }
        let seq = state.last_seq + 1;
        let event = SequencedEvent::new(Some(sid.to_string()), seq, type_, payload);
        // Whether this seq ends up ahead of the disk: a live-only event never
        // reaches it, nor does a durable record the writer refused.
        let mut head_ahead = self.persistence.is_some() && persist == Persist::Skip;
        if let Some(persistence) = self.persistence.as_ref().filter(|_| persist != Persist::Skip) {
            let record = PersistedEventRecord {
                schema_version: SESSION_SCHEMA_VERSION,
                session_id: sid.to_string(),
                seq,
                type_: type_.to_string(),
                recorded_at: now_millis(),
                payload: event.payload.clone(),
            };
            let outcome = match persist {
                Persist::Enqueue => persistence.enqueue_event(record.clone()),
                _ => Err(SessionPersistenceError::SessionNotFound),
            };
            if let Err(error) = outcome {
                // `SessionNotFound` is a buffered pre-registration record (it
                // reaches the disk unless the buffer is full) or a deleted
                // session; any other error drops the record.
                let mut dropped = !matches!(error, SessionPersistenceError::SessionNotFound);
                if !dropped {
                    // The bounded pre-registration buffer evicts its oldest
                    // record when full: that record never reaches the disk.
                    dropped = self
                        .pre_registration_events
                        .lock()
                        .get(sid)
                        .is_some_and(|queue| queue.len() >= self.pre_registration_capacity);
                }
                on_persist_error(self, persistence, record, error)?;
                head_ahead |= dropped;
            }
        }
        state.last_seq = seq;
        if state.events.is_empty() {
            state.base_seq = seq;
        }
        state.events.push_back(event.clone());
        while state.events.len() > self.event_log_capacity {
            state.events.pop_front();
            state.base_seq = state
                .events
                .front()
                .map_or(state.base_seq.saturating_add(1), |e| e.seq);
        }
        if head_ahead {
            state.head_ahead_of_durable = true;
        }
        self.fan_out_locked(sid, &event, tier);
        Ok((event, head_ahead))
    }

    /// Relay-event policy for a failed durable enqueue: never lose the live
    /// event.
    ///
    /// `SessionNotFound` is the expected outcome for BOTH a deleted session
    /// (delete won the race against a still-streaming event: the durable
    /// record is intentionally absent) AND a session whose registration has
    /// not installed the durable writer yet (an agent's first events can beat
    /// `register_session`, issue #836). The not-yet-registered case is
    /// BUFFERED (flushed the moment registration lands) so the JSONL keeps a
    /// contiguous seq run; the deleted case stays dropped. Writer-stopped and
    /// I/O failures stay warn. A full queue does not reject: `enqueue_event`
    /// diverts to the writer's overflow forwarder.
    fn absorb_persist_error(
        &self,
        persistence: &SessionPersistence,
        record: PersistedEventRecord,
        error: SessionPersistenceError,
    ) -> Result<(), Infallible> {
        let sid = record.session_id.clone();
        if !matches!(error, SessionPersistenceError::SessionNotFound) {
            warn!("[sessions] persistence queue rejected event for session {sid}: {error}");
            return Ok(());
        }
        let seq = record.seq;
        let known_deleted = {
            let mut pending = self.pre_registration_events.lock();
            let queue = pending.entry(sid.clone()).or_default();
            queue.push_back(record);
            while queue.len() > self.pre_registration_capacity {
                queue.pop_front(); // drop-oldest
            }
            // A session that was known (registered) and then deleted has no
            // catalog entry: nothing to flush into, and buffering forever
            // would leak. Drop the buffer for ids the catalog no longer knows.
            !matches!(
                persistence.metadata(&sid),
                Err(SessionPersistenceError::SessionNotFound)
            )
        };
        if known_deleted {
            info!("[sessions] persistence queue skipped event for deleted session {sid}");
        } else {
            info!(
                "[sessions] persistence queue buffered pre-registration event \
                 for session {sid} (seq {seq})"
            );
        }
        Ok(())
    }

    /// Authoritative server-authored user prompt: assign the relay sequence,
    /// enqueue it to the durable writer and fan it out to the session's
    /// subscribers, all synchronously. Called on the agent driver thread at
    /// the moment the driver ACCEPTS the prompt (before the turn task exists),
    /// so the record is delivered before any event of its own turn (never an
    /// await in between: SINK-F3). The durability boundary is
    /// [`Self::flush_prompt_record`].
    pub fn record_user_prompt(&self, sid: &str, payload: Value) -> SequencedEvent {
        self.publish(sid, "user_prompt", payload, ReliabilityTier::Reliable)
    }

    /// Await the durable flush of everything queued for `sid` (including a
    /// just-recorded `user_prompt` or host record). A no-op without
    /// persistence.
    pub async fn flush_prompt_record(&self, sid: &str) -> Result<(), String> {
        match &self.persistence {
            Some(persistence) => persistence
                .flush_session(sid)
                .await
                .map_err(|error| error.to_string()),
            None => Ok(()),
        }
    }

}

impl WsRelaySink {
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
    /// Registration holds `sessions`, the lock every publish assigns and fans
    /// out under, so each event lands exactly once: in the replay (assigned
    /// before registration) or live (after it). On success the log head
    /// (`logEpoch`, `headSeq`) read under that same lock comes back too:
    /// events with `seq <= head_seq` are replay, anything above is live.
    ///
    /// `log_epoch` is the epoch the cursor was issued under. A cursor from a
    /// different epoch (the host restarted without durable history), or one
    /// ahead of the log's head, replays nothing meaningful: that is
    /// [`ReplayResult::Stale`] too, with no registration, and the client
    /// takes a snapshot instead. Without a cursor the epoch is ignored; a
    /// cursor sent without one is checked against the head only.
    ///
    /// Returns the new client id + the stream the connection's forwarder
    /// drains: the replay (every `seq <= headSeq`) first, then the live items
    /// over a bounded channel. `closing` ends the caller's connection if the
    /// subscriber cannot keep up with a reliable event.
    pub async fn subscribe(
        &self,
        sid: &str,
        last_seq: Option<u64>,
        log_epoch: Option<&str>,
        closing: &CancellationToken,
    ) -> (ClientId, EventStream, ReplayResult, Option<LogHead>) {
        let client_id = ClientId::new();
        let gaps = Gaps::default();
        // The stream of a subscription that registered nothing: already ended.
        let no_stream = || {
            let (_tx, rx) = mpsc::channel::<StreamItem>(1);
            EventStream::new(Vec::new(), rx, Gaps::default())
        };
        let Some(cursor) = last_seq else {
            // Live-only: validate existence and register under the SAME
            // `sessions` lock `forget_session` removes under — a concurrent
            // forget cannot slip a subscription through the check→register
            // gap, and an unknown/removed session gets `not_found` instead of
            // a silent empty subscription.
            let mut sessions = self.sessions.lock();
            if !self.session_known_locked(&sessions, sid) {
                return (client_id, no_stream(), ReplayResult::NotFound, None);
            }
            let head = self.session_head_locked(&mut sessions, sid);
            let (tx, rx) = mpsc::channel::<StreamItem>(self.client_queue_capacity);
            self.register(client_id, sid, tx, Arc::clone(&gaps), closing);
            return (
                client_id,
                EventStream::new(Vec::new(), rx, gaps),
                ReplayResult::Ok(0),
                Some(head),
            );
        };

        // Cursor path: cheap early-out so an unknown id routes to `not_found`
        // instead of falling into the durable-replay error path (which reports
        // `stale`). The authoritative check re-runs under the `sessions` lock
        // at registration below, closing the `forget_session` race.
        if !self.knows_session(sid) {
            return (client_id, no_stream(), ReplayResult::NotFound, None);
        }
        // A cursor from another epoch cannot be replayed: answer before any
        // disk read. Re-checked under the lock at registration.
        if let Some(epoch) = log_epoch {
            if self.current_log_epoch(sid).is_some_and(|current| current != epoch) {
                info!(
                    "[ws] subscribe cursor under a stale log epoch for session {}",
                    crate::logging::redact_session_id(sid)
                );
                return (client_id, no_stream(), ReplayResult::Stale, None);
            }
        }

        let gate = self.replay_gate(sid).await;
        let _replay_guard = gate.lock().await;
        let mut by_seq = BTreeMap::new();
        // Issue #836 safety net: bound the durable re-read retry loop. A hole
        // that never fills (dropped-before-registration events) must terminate
        // the subscribe handshake, not spin past the WS keepalive watchdog.
        let mut passes: u32 = 0;
        loop {
            if let Some(persistence) = &self.persistence {
                // Writer barrier: the flush completes only after everything
                // enqueued before it is on disk. The JSONL scan itself runs
                // on spawn_blocking.
                if persistence.flush_session(sid).await.is_err() {
                    return (client_id, no_stream(), ReplayResult::Stale, None);
                }
                let durable = match persistence
                    .replay_after_async(sid.to_string(), cursor)
                    .await
                {
                    Ok(records) => records,
                    Err(_) => return (client_id, no_stream(), ReplayResult::Stale, None),
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

            let mut sessions = self.sessions.lock();
            // `frontier` is what this process published for the session. An
            // empty ring means nothing was published since the state was
            // created, so the durable read is authoritative and there is no
            // live frontier to validate it against.
            let (ring, frontier, base_seq) = sessions.get(sid).map_or_else(
                || (Vec::new(), cursor, cursor.saturating_add(1)),
                |state| {
                    (
                        state
                            .events
                            .iter()
                            .filter(|event| event.seq > cursor)
                            .cloned()
                            .collect::<Vec<_>>(),
                        if state.events.is_empty() {
                            cursor
                        } else {
                            state.last_seq
                        },
                        state.base_seq,
                    )
                },
            );
            if self.persistence.is_none()
                && sessions.get(sid).is_some_and(|state| {
                    cursor
                        .checked_add(1)
                        .is_some_and(|next| next < state.base_seq)
                })
            {
                return (client_id, no_stream(), ReplayResult::Stale, None);
            }
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
            let missing = missing_seq_ranges(cursor, frontier, &by_seq);
            if !missing.is_empty() {
                if self.persistence.is_none() || base_seq <= cursor.saturating_add(1) {
                    return (client_id, no_stream(), ReplayResult::Stale, None);
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
                return (client_id, no_stream(), ReplayResult::NotFound, None);
            }
            let head = self.session_head_locked(&mut sessions, sid);
            if log_epoch.is_some_and(|epoch| epoch != head.log_epoch) || cursor > head.head_seq {
                info!(
                    "[ws] subscribe cursor {cursor} does not belong to the log of session {} \
                     (head {})",
                    crate::logging::redact_session_id(sid),
                    head.head_seq
                );
                return (client_id, no_stream(), ReplayResult::Stale, None);
            }
            // The replay drains through the connection queue at the peer's
            // pace while live events keep arriving: room for what a long replay
            // can overlap, so a healthy phone catching up is not closed and
            // then replayed again forever. Bounded by the log capacity.
            let (tx, rx) = mpsc::channel::<StreamItem>(
                self.client_queue_capacity + by_seq.len().min(self.event_log_capacity),
            );
            self.register(client_id, sid, tx, Arc::clone(&gaps), closing);
            let count = by_seq.len() as u64;
            let stream = EventStream::new(by_seq.into_values().collect(), rx, gaps);
            return (client_id, stream, ReplayResult::Ok(count), Some(head));
        }
    }

    /// Atomically register a client and capture the complete session event
    /// snapshot plus its log head. Registration happens under the `sessions`
    /// lock, so every event after the head is delivered live and none falls
    /// between the snapshot and the live stream.
    ///
    /// With persistence the snapshot is the durable history, made complete up
    /// to the head by a writer barrier: everything allocated before the
    /// barrier is flushed to disk, everything after it is still in the ring
    /// (retried if the ring was evicted past the barrier). Non-durable events
    /// are excluded, so the snapshot equals `get_session_payload` at the head.
    /// A session unknown to persistence is an `Err`, so the caller returns
    /// `not_found` instead of an empty snapshot that would wipe transcripts.
    /// Without persistence the bounded live ring is the snapshot.
    pub async fn subscribe_snapshot(
        &self,
        sid: &str,
        closing: &CancellationToken,
    ) -> Result<(ClientId, EventStream, Vec<SequencedEvent>, LogHead), String> {
        let client_id = ClientId::new();
        let (tx, rx) = mpsc::channel::<StreamItem>(self.client_queue_capacity);
        let gaps = Gaps::default();
        let gate = self.replay_gate(sid).await;
        let _replay_guard = gate.lock().await;
        let Some(persistence) = &self.persistence else {
            let mut sessions = self.sessions.lock();
            let snapshot: Vec<SequencedEvent> = sessions
                .get(sid)
                .map(|state| state.events.iter().cloned().collect())
                .unwrap_or_default();
            let head = self.session_head_locked(&mut sessions, sid);
            self.register(client_id, sid, tx, Arc::clone(&gaps), closing);
            return Ok((client_id, EventStream::new(Vec::new(), rx, gaps), snapshot, head));
        };
        let mut passes: u32 = 0;
        loop {
            let barrier = self.session_watermark(sid);
            let _ = persistence.flush_session(sid).await;
            persistence
                .last_seq(sid)
                .map_err(|error| error.to_string())?;
            let records = persistence
                .replay_after_async(sid.to_string(), 0)
                .await
                .map_err(|error| error.to_string())?;
            let mut sessions = self.sessions.lock();
            // The ring must reach back to the barrier: everything after it is
            // not guaranteed to be on disk yet.
            let ring_reaches_barrier = sessions.get(sid).is_none_or(|state| {
                state.events.is_empty() || state.base_seq <= barrier.saturating_add(1)
            });
            if !ring_reaches_barrier {
                drop(sessions);
                passes += 1;
                if passes >= REPLAY_MAX_PASSES {
                    warn!(
                        "[ws] snapshot for session {sid} could not establish a writer barrier \
                         after {passes} passes"
                    );
                    return Err("snapshot writer barrier not reached".to_string());
                }
                continue;
            }
            let mut by_seq: BTreeMap<u64, SequencedEvent> = records
                .into_iter()
                .map(|record| {
                    (
                        record.seq,
                        SequencedEvent::new(
                            Some(record.session_id),
                            record.seq,
                            record.type_,
                            record.payload,
                        ),
                    )
                })
                .collect();
            if let Some(state) = sessions.get(sid) {
                for event in state
                    .events
                    .iter()
                    .filter(|event| event.seq > barrier && is_durable_event(&event.type_))
                {
                    by_seq.entry(event.seq).or_insert_with(|| event.clone());
                }
            }
            let head = self.session_head_locked(&mut sessions, sid);
            self.register(client_id, sid, tx, Arc::clone(&gaps), closing);
            return Ok((
                client_id,
                EventStream::new(Vec::new(), rx, gaps),
                by_seq.into_values().collect(),
                head,
            ));
        }
    }

    /// The per-session gate serializing replay/snapshot/register handoffs.
    async fn replay_gate(&self, sid: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut gates = self.replay_gates.lock().await;
        gates
            .entry(sid.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    /// Issue #836: notify the relay that `sid` just registered with the
    /// durable store. Flushes any events buffered while the session's writer
    /// was not yet installed (they arrived between the agent's first emit and
    /// `register_session`), preserving a contiguous seq run in the JSONL.
    ///
    /// The whole flush runs under the session's persistence send lock
    /// (`with_ordered_sender`) so the buffered prefix is serialized with
    /// every post-registration emit: a concurrent emit for this session can
    /// never slip its enqueue between buffered records — the emit path
    /// itself drains this same buffer under the same lock, so the earlier
    /// seqs always reach the writer first. When no writer is installed yet
    /// (registration raced a delete) `with_ordered_sender` returns `None`
    /// and the buffer stays put for a later flush. Best-effort + idempotent:
    /// a failed enqueue (writer stopped) logs and drops — a full queue
    /// overflows to the writer's forwarder instead of rejecting, so
    /// pre-registration records are not dropped for capacity. The live
    /// fan-out already delivered those events, so only a stopped writer
    /// affects the durable replay tail.
    pub fn note_session_registered_inherent(&self, sid: &str) {
        let Some(persistence) = &self.persistence else {
            return;
        };
        let persistence = Arc::clone(persistence);
        // A live-only event that beat registration found no catalog entry to
        // mark: apply the remembered mark now (outside the `sessions` lock).
        let head_ahead = self
            .sessions
            .lock()
            .get(sid)
            .is_some_and(|state| state.head_ahead_of_durable);
        if head_ahead {
            persistence.note_head_ahead_of_durable(sid);
        }
        // No writer yet (registration raced a delete): the buffer stays put.
        let _ = persistence.with_ordered_sender(sid, (), |()| {
            self.flush_pre_registration_locked(&persistence, sid);
        });
    }

    /// Drain `sid`'s pre-registration buffer into the durable writer. MUST be
    /// called while holding the session's send lock (via
    /// `SessionPersistence::with_ordered_sender`) — the lock is what keeps
    /// these already-sequenced records ahead of any emit racing registration.
    fn flush_pre_registration_locked(&self, persistence: &SessionPersistence, sid: &str) {
        let drained: Vec<PersistedEventRecord> = {
            let mut pending = self.pre_registration_events.lock();
            pending
                .remove(sid)
                .map_or_else(Vec::new, |queue| queue.into_iter().collect::<Vec<_>>())
        };
        if drained.is_empty() {
            return;
        }
        let mut requeued: Vec<PersistedEventRecord> = Vec::new();
        let mut enqueued = 0usize;
        let mut rejected = false;
        for record in drained {
            // Split the record so the enqueue (which consumes it) and the
            // requeue path (which keeps it) never fight over ownership.
            let (enqueue_record, requeue_record) = (record.clone(), record);
            match persistence.enqueue_event(enqueue_record) {
                Ok(()) => enqueued += 1,
                Err(SessionPersistenceError::SessionNotFound) => {
                    // The writer vanished between the `with_ordered_sender`
                    // check and this enqueue (a concurrent delete won the
                    // race): keep the record buffered for a later flush
                    // rather than dropping it.
                    requeued.push(requeue_record);
                }
                Err(error) => {
                    warn!(
                        "[sessions] pre-registration buffer flush rejected an event for \
                         session {sid}: {error}"
                    );
                    rejected = true;
                }
            }
        }
        if rejected {
            // A rejected record never reaches the disk: the seq frontier is
            // ahead of it. (`sessions` is not held here: the writer queue is
            // taken before it.)
            if let Some(state) = self.sessions.lock().get_mut(sid) {
                state.head_ahead_of_durable = true;
            }
            persistence.note_head_ahead_of_durable(sid);
        }
        if !requeued.is_empty() {
            let mut pending = self.pre_registration_events.lock();
            let queue = pending.entry(sid.to_string()).or_default();
            for record in requeued {
                queue.push_back(record);
            }
        }
        if enqueued > 0 {
            info!("[sessions] flushed {enqueued} pre-registration event(s) for session {sid}");
        }
    }
}
