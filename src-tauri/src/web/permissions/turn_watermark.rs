//! Server-side turn-id watermark + dedup set, split out of the rendezvous
//! module (the ticket tables in [`super`] and [`super::questions`] do not use it).

use std::collections::HashMap;

use parking_lot::Mutex;

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
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnClaim {
    Claimed,
    Completed,
    DuplicateInFlight,
    Busy,
}

pub struct TurnWatermark {
    /// `session_id → completed turn ids` reconstructed from durable history and
    /// updated on live completion.
    completed: Mutex<HashMap<String, std::collections::HashSet<String>>>,
    /// `session_id → currently claimed turn id` (empty string for clients that
    /// omit turnId). Claiming is atomic with duplicate/busy rejection.
    in_flight: Mutex<HashMap<String, String>>,
    /// `session_id → set of seen turn-ids` (idempotent event dedup).
    seen: Mutex<HashMap<String, std::collections::HashSet<String>>>,
    /// Sessions whose completed set was restored from durable history (once
    /// per session, before the first claim).
    restored: Mutex<std::collections::HashSet<String>>,
}

impl TurnWatermark {
    /// Create an empty watermark.
    #[must_use]
    pub fn new() -> Self {
        Self {
            completed: Mutex::new(HashMap::new()),
            in_flight: Mutex::new(HashMap::new()),
            seen: Mutex::new(HashMap::new()),
            restored: Mutex::new(std::collections::HashSet::new()),
        }
    }

    /// Whether `session_id`'s completed set was restored from history.
    #[must_use]
    pub fn is_restored(&self, session_id: &str) -> bool {
        self.restored.lock().contains(session_id)
    }

    /// Record that `session_id`'s completed set was restored from history.
    pub fn mark_restored(&self, session_id: &str) {
        self.restored.lock().insert(session_id.to_string());
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
        self.completed
            .lock()
            .entry(session_id.to_string())
            .or_default()
            .insert(turn_id.to_string());
        self.release_claim(session_id, Some(turn_id));
    }

    pub fn restore_completed<I>(&self, session_id: &str, turn_ids: I)
    where
        I: IntoIterator<Item = String>,
    {
        self.completed
            .lock()
            .entry(session_id.to_string())
            .or_default()
            .extend(turn_ids);
    }

    /// One completed id for legacy diagnostics/tests; ordering is unspecified.
    #[must_use]
    pub fn last_completed(&self, session_id: &str) -> Option<String> {
        self.completed
            .lock()
            .get(session_id)
            .and_then(|ids| ids.iter().next().cloned())
    }

    /// Atomically claim the session turn before persistence. Rejects an already
    /// completed id as stale, the same in-flight id as duplicate, and any other
    /// concurrent turn as busy.
    pub fn claim_turn(&self, session_id: &str, turn_id: Option<&str>) -> TurnClaim {
        let id = turn_id.unwrap_or_default();
        if !id.is_empty() && self.is_completed(session_id, id) {
            return TurnClaim::Completed;
        }
        let mut in_flight = self.in_flight.lock();
        if let Some(active) = in_flight.get(session_id) {
            return if active == id {
                TurnClaim::DuplicateInFlight
            } else {
                TurnClaim::Busy
            };
        }
        in_flight.insert(session_id.to_string(), id.to_string());
        TurnClaim::Claimed
    }

    pub fn release_claim(&self, session_id: &str, turn_id: Option<&str>) {
        let expected = turn_id.unwrap_or_default();
        let mut in_flight = self.in_flight.lock();
        if in_flight
            .get(session_id)
            .is_some_and(|active| active == expected)
        {
            in_flight.remove(session_id);
        }
    }

    /// Whether `turn_id` is at-or-before the last-completed watermark for
    /// `session_id` (i.e. a stale turn a 1.8 `send_prompt` should reject). The
    /// comparison is by string equality (turn-ids are opaque client uuids with
    /// no natural ordering; "at-or-before" means "equals the watermark" — a
    /// turn-id strictly older than the watermark is one the client already
    /// abandoned and will not resend under the ACP contract).
    #[must_use]
    pub fn is_completed(&self, session_id: &str, turn_id: &str) -> bool {
        self.completed
            .lock()
            .get(session_id)
            .is_some_and(|ids| ids.contains(turn_id))
    }

    /// Forget a session's watermark state (on explicit session close).
    pub fn forget_session(&self, session_id: &str) {
        self.completed.lock().remove(session_id);
        self.in_flight.lock().remove(session_id);
        self.seen.lock().remove(session_id);
        self.restored.lock().remove(session_id);
    }
}

impl Default for TurnWatermark {
    fn default() -> Self {
        Self::new()
    }
}
