//! Per-agent driver-thread state.
//!
//! `DriverState` lives on a single agent's dedicated driver thread and is shared
//! (via `Arc<Mutex<..>>`) between that thread's connection event loop and its
//! inbound message handlers. It tracks:
//!   * pending permission requests, so `acp_respond_permission` /
//!     `acp_cancel_prompt` (and prompt completion / disconnect) can resolve them;
//!   * per-session workspace roots (canonicalized `cwd`), so agent-driven `fs`
//!     reads/writes can be scoped to the workspace; and
//!   * per-session active turns, so concurrent prompts on one session are
//!     rejected and an in-flight turn can be signalled to stop after a cancel.
//!
//! It is wrapped in a `Mutex` purely to satisfy the `Send` bound the ACP
//! handler closures require; in practice all access happens on the one driver
//! thread, so the lock is uncontended.

use agent_client_protocol::schema::v1::RequestPermissionResponse;
use agent_client_protocol::Responder;
use parking_lot::Mutex;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{oneshot, watch};

/// A permission request awaiting the user's decision.
///
/// The `responder` completes the agent's in-flight `session/request_permission`
/// request once the user responds (or the turn is cancelled / drained).
pub(crate) struct PendingPermission {
    pub session_id: String,
    pub responder: Responder<RequestPermissionResponse>,
}

/// A structured question (issue #411) awaiting the user's answer.
///
/// The `responder` completes the agent's in-flight `_session/question` extension
/// request once the user answers (or the turn is cancelled / drained). The
/// response is an untyped JSON value (the ACP extension surface has no typed
/// question response), so the `serde_json::Value` is `Send` and can cross the
/// driver thread boundary inside `DriverState`'s `Arc<Mutex<..>>`.
pub(crate) struct PendingQuestion {
    pub session_id: String,
    pub question_id: String,
    pub responder: Responder<Value>,
}

/// Mutable state shared across a single agent's driver thread.
#[derive(Default)]
pub(crate) struct DriverState {
    /// Permission requests keyed by a globally-unique correlation id.
    pending_permissions: HashMap<String, PendingPermission>,
    /// Structured questions (issue #411) keyed by a globally-unique question id.
    pending_questions: HashMap<String, PendingQuestion>,
    /// Canonicalized workspace root per active session, used to sandbox `fs`
    /// reads/writes to the session's `cwd`.
    session_roots: HashMap<String, PathBuf>,
    /// Authoritative set of non-durable sessions created by the manager.
    ephemeral_sessions: HashSet<String>,
    /// Sessions with an in-flight prompt turn. The value holds the cancel
    /// signal sender; it is taken (set to `None`) once a cancel has been
    /// signalled, but the key remains until the turn task finishes so a
    /// concurrent turn cannot slip in during the post-cancel grace window.
    active_turns: HashMap<String, Option<oneshot::Sender<()>>>,
    /// In-flight idle-reset signal senders per active turn. The
    /// `session/update`/`tool_call` notification callback fires these
    /// (non-blocking) so the turn task's idle deadline resets on agent
    /// activity — a wedged (silent) turn hits the idle timeout fast, an active
    /// (streaming) turn never does. Mirrors `active_turns`' lifecycle: created
    /// in `try_begin_turn`, dropped in `finish_turn`.
    idle_resets: HashMap<String, watch::Sender<()>>,
    /// One-shot waiters registered by turn-scoped operations. `finish_turn`
    /// removes and resolves the full waiter list exactly once.
    turn_idle_waiters: HashMap<String, Vec<oneshot::Sender<()>>>,
    /// Sessions associated with each tool call id for this connection. ACP tool
    /// call ids are session-scoped, so a set preserves collisions as ambiguous.
    /// Bindings remain for the connection lifetime so delayed updates cannot be
    /// reassigned to a different active turn after their original turn ends.
    tool_call_sessions: HashMap<String, HashSet<String>>,
    /// Per-session configId of the agent-advertised Model selector. ACP 0.14
    /// replaced `session/set_model` with `session/set_config_option`, whose
    /// `configId` is the agent-provided option id (conventionally `"model"` but
    /// not guaranteed). Caching it per session lets `set_model` target the
    /// agent's actual model selector id instead of hardcoding `"model"`.
    model_config_ids: HashMap<String, String>,
    /// Per-session replay windows for in-flight `session/load` /
    /// `session/resume` requests (story 3: replay contract). While a window is
    /// open, agent-replayed history arrives as `session/update` notifications
    /// that must be dropped before fan-out — never persisted, never forwarded
    /// to subscribers — so the persisted JSONL log stays the sole history
    /// source. The value is a refcount (overlapping reopens of one session
    /// keep the window open until ALL complete) plus a count of suppressed
    /// updates for the close-out summary log.
    /// Replay windows and prompt turns are mutually exclusive per session:
    /// admission goes through one atomic transition each
    /// (`try_begin_replay_window` rejects while a turn is active,
    /// `try_begin_turn` rejects while a window is open), so a live turn's
    /// updates can never be misclassified as replayed history and dropped.
    replay_windows: HashMap<String, ReplayWindow>,
    /// Per-session reopen reservations for admitted `session/load` /
    /// `session/resume` requests (story 3: replay contract). A reservation is
    /// taken at admission time — BEFORE the durable-writer reinstall await —
    /// so a prompt turn cannot slip in while the reopen prepares; the replay
    /// window (which actually suppresses updates) is opened separately,
    /// immediately before the ACP request is sent, so live updates are never
    /// dropped during the preparatory phase. Ref-counted like
    /// `replay_windows` so overlapping reopens of one session hold the
    /// reservation until ALL complete. Released on every outcome via
    /// [`ReopenReservation`]'s `Drop`.
    reopen_reservations: HashMap<String, usize>,
}

/// State of one session's replay window: how many reopens are in flight and
/// how many replayed updates have been suppressed since the window opened.
#[derive(Default)]
struct ReplayWindow {
    open_count: usize,
    suppressed: u64,
}

/// RAII guard keeping a session's replay window open.
///
/// Created by the manager's `session/load` / `session/resume` handlers BEFORE
/// the request future is evaluated and dropped after the response resolves
/// (on success, agent error, or timeout alike), so the window covers exactly
/// the agent's history replay. Ref-counted: overlapping guards for one
/// session keep the window open until the last guard drops.
/// Admission is refused while a prompt turn is active for the session
/// (`try_new` returns `None`): replayed history and a live turn must never
/// overlap, or live updates would be misclassified as replayed history and
/// dropped. The manager holds a [`ReopenReservation`] from reopen admission
/// until the reopen resolves, so in practice this refusal is unreachable on
/// the deferred creation path — it stays as the total admission invariant.
///
/// NEVER drop this guard while holding the `DriverState` lock on the same
/// thread: `Drop` locks the (non-reentrant) `parking_lot` mutex, which would
/// deadlock.
pub(crate) struct ReplayWindowGuard {
    state: Arc<Mutex<DriverState>>,
    session_id: String,
}

impl ReplayWindowGuard {
    /// Open (or add a reference to) the replay window for `session_id`.
    /// Returns `None` — opening no window — when a prompt turn is active for
    /// the session; the caller must fail the reopen instead of replaying
    /// history into a live turn.
    pub(crate) fn try_new(state: Arc<Mutex<DriverState>>, session_id: String) -> Option<Self> {
        if !state.lock().try_begin_replay_window(&session_id) {
            return None;
        }
        Some(Self { state, session_id })
    }
}

impl Drop for ReplayWindowGuard {
    fn drop(&mut self) {
        let suppressed = self.state.lock().finish_replay_window(&self.session_id);
        // Summary log only when the window actually suppressed updates — an
        // empty window is normal (e.g. opencode's `session/resume` replays
        // nothing) and must stay silent.
        if suppressed > 0 {
            log::debug!(
                "[acp] session {} replay window closed: {suppressed} replayed update(s) suppressed",
                crate::logging::redact_session_id(&self.session_id)
            );
        }
    }
}

/// RAII guard holding a session's reopen reservation (see
/// [`DriverState::reopen_reservations`]).
///
/// Created by the manager's `session/load` / `session/resume` handlers at
/// admission time — BEFORE the durable-writer reinstall await — so a prompt
/// turn cannot start while the reopen prepares; the replay window (which
/// suppresses replayed updates before fan-out) is opened separately via
/// [`ReplayWindowGuard`] immediately before the ACP request is sent. Dropped
/// when the reopen task finishes (success, agent error, timeout, or early
/// return alike), so the reservation covers exactly the reopen's in-flight
/// lifetime. Ref-counted: overlapping reopens of one session keep the
/// reservation until the last guard drops.
/// Admission is refused while a prompt turn is active for the session
/// (`try_new` returns `None`): the caller must fail the reopen instead of
/// racing history replay against a live turn.
///
/// NEVER drop this guard while holding the `DriverState` lock on the same
/// thread: `Drop` locks the (non-reentrant) `parking_lot` mutex, which would
/// deadlock.
pub(crate) struct ReopenReservation {
    state: Arc<Mutex<DriverState>>,
    session_id: String,
}

impl ReopenReservation {
    /// Reserve `session_id` for an in-flight reopen (or add a reference to an
    /// existing reservation). Returns `None` — no reservation — when a prompt
    /// turn is active for the session.
    pub(crate) fn try_new(state: Arc<Mutex<DriverState>>, session_id: String) -> Option<Self> {
        if !state.lock().try_begin_reopen_reservation(&session_id) {
            return None;
        }
        Some(Self { state, session_id })
    }
}

impl Drop for ReopenReservation {
    fn drop(&mut self) {
        self.state
            .lock()
            .finish_reopen_reservation(&self.session_id);
    }
}

/// Signals handed to the turn task when a turn begins: the cancel receiver
/// (user/system cancel) and the idle-reset receiver (fired on agent activity
/// to push back the idle deadline).
pub(crate) struct TurnHandles {
    pub cancel_rx: oneshot::Receiver<()>,
    pub idle_rx: watch::Receiver<()>,
}

impl DriverState {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Register a pending permission request and return its globally-unique
    /// correlation id.
    ///
    /// The id embeds a UUID so it never collides across agents (each agent has
    /// its own `DriverState`, but renderers and logs may key solely on the id).
    pub(crate) fn register_permission(
        &mut self,
        session_id: String,
        responder: Responder<RequestPermissionResponse>,
    ) -> String {
        let request_id = format!("perm-{}", uuid::Uuid::new_v4());
        self.pending_permissions.insert(
            request_id.clone(),
            PendingPermission {
                session_id,
                responder,
            },
        );
        request_id
    }

    /// Remove and return a pending permission by its correlation id.
    pub(crate) fn take_permission(&mut self, request_id: &str) -> Option<PendingPermission> {
        self.pending_permissions.remove(request_id)
    }

    /// Register a pending structured question (issue #411) and return its
    /// globally-unique correlation id.
    ///
    /// The id embeds a UUID (mirroring `register_permission`'s `perm-{uuid}`
    /// style, but with a `q-` prefix) so it never collides across agents.
    pub(crate) fn register_question(
        &mut self,
        session_id: String,
        responder: Responder<Value>,
    ) -> String {
        let question_id = format!("q-{}", uuid::Uuid::new_v4());
        self.pending_questions.insert(
            question_id.clone(),
            PendingQuestion {
                session_id,
                question_id: question_id.clone(),
                responder,
            },
        );
        question_id
    }

    /// Remove and return a pending question by its correlation id.
    pub(crate) fn take_question(&mut self, question_id: &str) -> Option<PendingQuestion> {
        self.pending_questions.remove(question_id)
    }

    /// Remove and return all pending questions belonging to a session.
    ///
    /// Used on cancellation and on prompt completion to resolve every
    /// outstanding question for the session (cancelled).
    pub(crate) fn drain_session_questions(&mut self, session_id: &str) -> Vec<PendingQuestion> {
        let ids: Vec<String> = self
            .pending_questions
            .iter()
            .filter(|(_, q)| q.session_id == session_id)
            .map(|(id, _)| id.clone())
            .collect();
        ids.into_iter()
            .filter_map(|id| self.pending_questions.remove(&id))
            .collect()
    }

    /// Remove and return every pending question, regardless of session.
    pub(crate) fn drain_all_questions(&mut self) -> Vec<PendingQuestion> {
        self.pending_questions.drain().map(|(_, q)| q).collect()
    }

    /// Remove and return all pending permissions belonging to a session.
    ///
    /// Used on cancellation and on prompt completion to resolve every
    /// outstanding request for the session (cancelled).
    pub(crate) fn drain_session(&mut self, session_id: &str) -> Vec<PendingPermission> {
        let ids: Vec<String> = self
            .pending_permissions
            .iter()
            .filter(|(_, p)| p.session_id == session_id)
            .map(|(id, _)| id.clone())
            .collect();
        ids.into_iter()
            .filter_map(|id| self.pending_permissions.remove(&id))
            .collect()
    }

    /// Remove and return every pending permission, regardless of session.
    ///
    /// Used on shutdown / disconnect so no responder (and no agent-side
    /// `session/request_permission`) is left dangling.
    pub(crate) fn drain_all(&mut self) -> Vec<PendingPermission> {
        self.pending_permissions.drain().map(|(_, p)| p).collect()
    }

    /// Record the canonicalized workspace root for a session. Agent `fs`
    /// reads/writes for this session must stay within this root.
    pub(crate) fn set_session_root(&mut self, session_id: String, root: PathBuf) {
        self.session_roots.insert(session_id, root);
    }

    pub(crate) fn mark_ephemeral(&mut self, session_id: String) {
        self.ephemeral_sessions.insert(session_id);
    }

    #[must_use]
    pub(crate) fn is_ephemeral(&self, session_id: &str) -> bool {
        self.ephemeral_sessions.contains(session_id)
    }

    /// Look up the canonicalized workspace root for a session, if known.
    pub(crate) fn session_root(&self, session_id: &str) -> Option<PathBuf> {
        self.session_roots.get(session_id).cloned()
    }

    /// Forget a session's workspace root (on explicit close).
    pub(crate) fn remove_session_root(&mut self, session_id: &str) {
        self.session_roots.remove(session_id);
        self.ephemeral_sessions.remove(session_id);
        self.model_config_ids.remove(session_id);
    }

    /// Record the agent-advertised configId of the Model selector for a session
    /// (derived from the session's `config_options`). Updated whenever options
    /// are loaded, resumed, or refreshed via `session/set_config_option`.
    pub(crate) fn set_model_config_id(&mut self, session_id: String, config_id: String) {
        self.model_config_ids.insert(session_id, config_id);
    }

    /// The cached Model-selector configId for a session, if one was advertised.
    /// Callers fall back to the `"model"` convention when `None`.
    pub(crate) fn model_config_id(&self, session_id: &str) -> Option<String> {
        self.model_config_ids.get(session_id).cloned()
    }

    /// Open a replay window for a session (or add a reference to an already
    /// open one). While open, inbound `session/update` notifications for the
    /// session are agent-replayed history and must be dropped before fan-out.
    /// Returns `false` — without opening the window — when a prompt turn is
    /// active for the session: replay-window and turn admission are mutually
    /// exclusive so live turn updates can never be swallowed as replayed
    /// history. Prefer [`ReplayWindowGuard`] so the window closes on every
    /// outcome.
    pub(crate) fn try_begin_replay_window(&mut self, session_id: &str) -> bool {
        if self.active_turns.contains_key(session_id) {
            return false;
        }
        self.replay_windows
            .entry(session_id.to_string())
            .or_default()
            .open_count += 1;
        true
    }

    /// Reserve a session for an admitted `session/load`/`session/resume`
    /// reopen (or add a reference to an existing reservation). While
    /// reserved, `try_begin_turn` rejects new prompt turns for the session,
    /// so the replay window — opened later, immediately before the ACP
    /// request is sent — can never collide with a live turn. Returns `false`
    /// — without reserving — when a prompt turn is already active: reopen and
    /// turn admission are mutually exclusive so a live turn's updates can
    /// never be misclassified as replayed history and dropped. Prefer
    /// [`ReopenReservation`] so the reservation is released on every outcome.
    pub(crate) fn try_begin_reopen_reservation(&mut self, session_id: &str) -> bool {
        if self.active_turns.contains_key(session_id) {
            return false;
        }
        *self
            .reopen_reservations
            .entry(session_id.to_string())
            .or_default() += 1;
        true
    }

    /// Release one reference to a session's reopen reservation; the last
    /// release removes it so prompt turns are admitted again. Unknown
    /// sessions are ignored.
    pub(crate) fn finish_reopen_reservation(&mut self, session_id: &str) {
        let Some(count) = self.reopen_reservations.get_mut(session_id) else {
            return;
        };
        *count = count.saturating_sub(1);
        if *count == 0 {
            self.reopen_reservations.remove(session_id);
        }
    }

    /// Release one reference to a session's replay window and return the
    /// number of replayed updates the window suppressed. The count is handed
    /// out exactly once, at final close; returns 0 for unknown sessions and
    /// while references remain.
    pub(crate) fn finish_replay_window(&mut self, session_id: &str) -> u64 {
        let Some(window) = self.replay_windows.get_mut(session_id) else {
            return 0;
        };
        window.open_count = window.open_count.saturating_sub(1);
        if window.open_count > 0 {
            return 0;
        }
        let suppressed = window.suppressed;
        self.replay_windows.remove(session_id);
        suppressed
    }

    /// Record an inbound `session/update` for the session. Returns `true`
    /// (and counts the update) when a replay window is open, meaning the
    /// notification is agent-replayed history and the caller MUST drop it
    /// before fan-out; `false` for live events that proceed normally.
    pub(crate) fn note_replayed_update(&mut self, session_id: &str) -> bool {
        match self.replay_windows.get_mut(session_id) {
            Some(window) => {
                window.suppressed += 1;
                true
            }
            None => false,
        }
    }

    /// Whether a replay window is currently open for the session. Only the
    /// unit tests (here and in the manager) observe the window directly, so
    /// this is test-only.
    #[cfg(test)]
    #[must_use]
    pub(crate) fn is_replay_window_open(&self, session_id: &str) -> bool {
        self.replay_windows.contains_key(session_id)
    }

    /// Return all sessions that still have a registered workspace root. Used on
    /// disconnect to emit `acp:session_closed` for sessions that were active.
    pub(crate) fn active_session_ids(&self) -> Vec<String> {
        self.session_roots.keys().cloned().collect()
    }

    /// Associate a tool call with its authoritative enclosing session.
    pub(crate) fn bind_tool_call(&mut self, tool_call_id: String, session_id: String) {
        self.tool_call_sessions
            .entry(tool_call_id)
            .or_default()
            .insert(session_id);
    }

    /// Attempt to begin a turn for a session. Returns `Some(TurnHandles)`
    /// (cancel + idle-reset receivers) when the turn may proceed, or `None` if
    /// a turn is already active for this session (concurrent turns are
    /// rejected), a replay window is open (a `session/load`/`session/resume`
    /// history replay is in flight — its updates are dropped before fan-out,
    /// so a live turn must never overlap it), or a reopen reservation is held
    /// (an admitted reopen is preparing — e.g. reinstalling the durable
    /// writer — and will open its replay window immediately before the ACP
    /// request; a turn must not slip in during that preparatory phase). Both
    /// signals are created atomically so the notification callback can nudge
    /// the idle deadline from the moment the turn starts.
    pub(crate) fn try_begin_turn(&mut self, session_id: &str) -> Option<TurnHandles> {
        if self.active_turns.contains_key(session_id)
            || self.replay_windows.contains_key(session_id)
            || self.reopen_reservations.contains_key(session_id)
        {
            return None;
        }
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let (idle_tx, idle_rx) = watch::channel(());
        self.active_turns.insert(session_id.to_string(), Some(cancel_tx));
        self.idle_resets.insert(session_id.to_string(), idle_tx);
        Some(TurnHandles { cancel_rx, idle_rx })
    }

    /// Whether the session currently has an active turn, including cancel grace.
    #[must_use]
    pub(crate) fn is_turn_active(&self, session_id: &str) -> bool {
        self.active_turns.contains_key(session_id)
    }

    /// Register a one-shot notification for the session becoming idle.
    /// Returns `None` when already idle so callers never wait for a completion
    /// that already happened.
    pub(crate) fn wait_turn_idle(&mut self, session_id: &str) -> Option<oneshot::Receiver<()>> {
        if !self.is_turn_active(session_id) {
            return None;
        }
        let (tx, rx) = oneshot::channel();
        self.turn_idle_waiters
            .entry(session_id.to_string())
            .or_default()
            .push(tx);
        Some(rx)
    }

    /// Signal the active turn for a session to wind down (a cancel was
    /// requested). Keeps the session marked active (so no concurrent turn can
    /// start during the grace window). No-op if there is no active turn.
    pub(crate) fn signal_cancel(&mut self, session_id: &str) {
        if let Some(slot) = self.active_turns.get_mut(session_id) {
            if let Some(tx) = slot.take() {
                let _ = tx.send(());
            }
        }
    }

    /// Nudge the active turn's idle deadline — the agent produced activity (a
    /// `session/update`/`tool_call` notification arrived), so push the idle
    /// deadline back. Non-blocking and a no-op when no turn is active for the
    /// session. `watch` coalesces: a burst of notifications resets once, which
    /// is all the idle clock needs ("activity happened since the last reset").
    pub(crate) fn signal_idle(&mut self, session_id: &str) {
        if let Some(tx) = self.idle_resets.get(session_id) {
            let _ = tx.send(());
        }
    }

    /// Mark a session's turn finished and return any still-pending permissions
    /// for that session (to be resolved cancelled). Idempotent.
    pub(crate) fn finish_turn(&mut self, session_id: &str) -> Vec<PendingPermission> {
        self.active_turns.remove(session_id);
        self.idle_resets.remove(session_id);
        if let Some(waiters) = self.turn_idle_waiters.remove(session_id) {
            for waiter in waiters {
                let _ = waiter.send(());
            }
        }
        self.drain_session(session_id)
    }

    /// Mark a session's turn finished and return any still-pending questions
    /// for that session (to be resolved cancelled). Idempotent.
    pub(crate) fn finish_turn_questions(&mut self, session_id: &str) -> Vec<PendingQuestion> {
        self.drain_session_questions(session_id)
    }

    pub(crate) fn dispose_session(
        &mut self,
        session_id: &str,
    ) -> (Vec<PendingPermission>, Vec<PendingQuestion>) {
        self.remove_session_root(session_id);
        let permissions = self.finish_turn(session_id);
        let questions = self.finish_turn_questions(session_id);
        (permissions, questions)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn request_ids_are_globally_unique() {
        // Two independent driver states (i.e. two agents) must never collide on
        // a request id — the ids embed a UUID rather than a per-agent counter.
        // We can't build a real Responder headless, so we assert uniqueness at
        // the id-generation level via a tiny shim around the same format.
        let a = format!("perm-{}", uuid::Uuid::new_v4());
        let b = format!("perm-{}", uuid::Uuid::new_v4());
        assert_ne!(a, b);
        assert!(a.starts_with("perm-"));
    }

    #[test]
    fn question_ids_are_globally_unique_and_prefixed() {
        // Issue #411: question ids use the same UUID scheme as permission ids
        // but with a `q-` prefix so the two correlation spaces never collide.
        let a = format!("q-{}", uuid::Uuid::new_v4());
        let b = format!("q-{}", uuid::Uuid::new_v4());
        assert_ne!(a, b);
        assert!(a.starts_with("q-"));
    }

    #[test]
    fn concurrent_turn_on_same_session_is_rejected() {
        let mut state = DriverState::new();
        // First turn begins: we get a cancel receiver.
        let first = state.try_begin_turn("sess-1");
        assert!(first.is_some(), "first turn must be allowed to start");
        // Second turn on the same session is rejected while the first is active.
        assert!(
            state.try_begin_turn("sess-1").is_none(),
            "a concurrent turn on the same session must be rejected"
        );
        // A different session is independent.
        assert!(
            state.try_begin_turn("sess-2").is_some(),
            "a turn on a different session must be allowed"
        );
        // Once the first turn finishes, a new turn may begin again.
        let _ = state.finish_turn("sess-1");
        assert!(
            state.try_begin_turn("sess-1").is_some(),
            "a new turn must be allowed once the previous one finished"
        );
    }

    #[test]
    fn signal_idle_nudges_the_active_turn_and_is_a_noop_otherwise() {
        let mut state = DriverState::new();
        let handles = state.try_begin_turn("sess-1").expect("turn starts");
        let mut idle_rx = handles.idle_rx;
        // No activity yet — the idle receiver has observed no change.
        assert!(!idle_rx.has_changed().unwrap());
        // An inbound session/update fires signal_idle — the receiver sees it.
        state.signal_idle("sess-1");
        assert!(idle_rx.has_changed().unwrap());
        // mark_changed so has_changed can report a subsequent send again.
        idle_rx.mark_changed();
        state.signal_idle("sess-1");
        assert!(idle_rx.has_changed().unwrap());
        // No active turn for another session → no-op (no panic).
        state.signal_idle("no-such-session");
        // finish_turn drops the idle sender; signal_idle becomes a no-op after.
        let _ = state.finish_turn("sess-1");
        state.signal_idle("sess-1");
    }

    #[test]
    fn turn_state_query_and_waiter_follow_authoritative_turn() {
        let mut state = DriverState::new();
        assert!(!state.is_turn_active("sess-1"));
        assert!(state.wait_turn_idle("sess-1").is_none());
        let _cancel = state.try_begin_turn("sess-1").expect("turn starts");
        assert!(state.is_turn_active("sess-1"));
        let mut waiter = state.wait_turn_idle("sess-1").expect("waiter registered");
        assert!(waiter.try_recv().is_err());
        let _ = state.finish_turn("sess-1");
        assert!(!state.is_turn_active("sess-1"));
        assert_eq!(waiter.try_recv(), Ok(()));
        // Idempotent finish cannot resolve the consumed one-shot again.
        let _ = state.finish_turn("sess-1");
        assert!(state.wait_turn_idle("sess-1").is_none());
    }

    #[test]
    fn cancel_keeps_session_active_until_finish() {
        let mut state = DriverState::new();
        let _rx = state.try_begin_turn("sess-1").expect("turn starts");
        // Signalling cancel must NOT free the slot — a concurrent turn must
        // still be rejected during the post-cancel grace window.
        state.signal_cancel("sess-1");
        assert!(
            state.try_begin_turn("sess-1").is_none(),
            "session must stay single-flight during the cancel grace window"
        );
        // Only finishing the turn frees the slot.
        let _ = state.finish_turn("sess-1");
        assert!(state.try_begin_turn("sess-1").is_some());
    }

    #[test]
    fn ephemeral_sessions_are_authoritative_and_disposed_with_roots() {
        let mut state = DriverState::new();
        state.set_session_root("temp".to_string(), PathBuf::from("/tmp/ws"));
        state.mark_ephemeral("temp".to_string());
        assert!(state.is_ephemeral("temp"));
        assert!(state.try_begin_turn("temp").is_some());
        state.signal_cancel("temp");
        assert!(state.is_ephemeral("temp"));
        assert!(state.session_root("temp").is_some());
        assert!(state.is_turn_active("temp"));
        state.finish_turn("temp");
        let (permissions, questions) = state.dispose_session("temp");
        assert!(permissions.is_empty());
        assert!(questions.is_empty());
        assert!(!state.is_ephemeral("temp"));
        assert!(state.session_root("temp").is_none());
    }

    #[test]
    fn session_roots_track_and_clear() {
        let mut state = DriverState::new();
        assert!(state.session_root("sess-1").is_none());
        state.set_session_root("sess-1".to_string(), PathBuf::from("/tmp/ws"));
        assert_eq!(state.session_root("sess-1"), Some(PathBuf::from("/tmp/ws")));
        assert_eq!(state.active_session_ids(), vec!["sess-1".to_string()]);
        state.remove_session_root("sess-1");
        assert!(state.session_root("sess-1").is_none());
        assert!(state.active_session_ids().is_empty());
    }

    #[test]
    fn tool_call_binding_accepts_multiple_sessions_per_id() {
        let mut state = DriverState::new();
        state.bind_tool_call("call-1".to_string(), "sess-a".to_string());
        state.bind_tool_call("call-1".to_string(), "sess-b".to_string());
        // Collision is preserved as ambiguous — no routing helper consumes it.
        let _ = state.try_begin_turn("sess-a");
    }

    #[test]
    fn replay_window_suppresses_and_counts_until_finished() {
        let mut state = DriverState::new();
        // No window: updates are live (not suppressed).
        assert!(!state.is_replay_window_open("sess-1"));
        assert!(!state.note_replayed_update("sess-1"));

        assert!(
            state.try_begin_replay_window("sess-1"),
            "window opens when no turn is active"
        );
        assert!(state.is_replay_window_open("sess-1"));
        assert!(state.note_replayed_update("sess-1"));
        assert!(state.note_replayed_update("sess-1"));

        // Final close hands out the suppressed count exactly once.
        assert_eq!(state.finish_replay_window("sess-1"), 2);
        assert!(!state.is_replay_window_open("sess-1"));
        // After close the window is gone: updates are live again and a stray
        // finish is a no-op returning 0.
        assert!(!state.note_replayed_update("sess-1"));
        assert_eq!(state.finish_replay_window("sess-1"), 0);
        assert!(!state.is_replay_window_open("sess-1"));
    }

    #[test]
    fn replay_window_refcount_keeps_overlapping_reopen_open() {
        let mut state = DriverState::new();
        assert!(state.try_begin_replay_window("sess-1"));
        // Overlapping reopen of the same session adds a reference.
        assert!(state.try_begin_replay_window("sess-1"));
        assert!(state.note_replayed_update("sess-1"));
        // First finish only releases one reference — suppression continues and
        // the count is not handed out yet.
        assert_eq!(state.finish_replay_window("sess-1"), 0);
        assert!(state.is_replay_window_open("sess-1"));
        assert!(state.note_replayed_update("sess-1"));
        // Second finish closes the window for good and returns the full count.
        assert_eq!(state.finish_replay_window("sess-1"), 2);
        assert!(!state.is_replay_window_open("sess-1"));
        assert!(!state.note_replayed_update("sess-1"));
    }

    #[test]
    fn replay_windows_are_isolated_per_session() {
        let mut state = DriverState::new();
        assert!(state.try_begin_replay_window("sess-a"));
        // Session B has no window: its updates fan out normally.
        assert!(!state.note_replayed_update("sess-b"));
        assert!(state.note_replayed_update("sess-a"));
        assert_eq!(state.finish_replay_window("sess-a"), 1);
        assert!(!state.note_replayed_update("sess-a"));
    }

    #[test]
    fn replay_window_guard_opens_on_construction_and_closes_on_drop() {
        let state = Arc::new(Mutex::new(DriverState::new()));
        {
            let _guard = ReplayWindowGuard::try_new(state.clone(), "sess-1".to_string())
                .expect("window opens when no turn is active");
            assert!(state.lock().is_replay_window_open("sess-1"));
            assert!(state.lock().note_replayed_update("sess-1"));
            // Overlapping guard: dropping the first must not close the window.
            let guard2 = ReplayWindowGuard::try_new(state.clone(), "sess-1".to_string())
                .expect("overlapping guard adds a reference");
            drop(guard2);
            assert!(state.lock().is_replay_window_open("sess-1"));
        }
        // Last guard dropped: window closed, updates live again.
        assert!(!state.lock().is_replay_window_open("sess-1"));
        assert!(!state.lock().note_replayed_update("sess-1"));
    }

    #[test]
    fn replay_window_counts_suppressed_updates_for_summary() {
        let mut state = DriverState::new();
        assert!(state.try_begin_replay_window("sess-9"));
        for _ in 0..5 {
            assert!(state.note_replayed_update("sess-9"));
        }
        // 5 suppressed -> 5, handed out exactly once; a second finish -> 0 and
        // the entry is gone (no state leak).
        assert_eq!(state.finish_replay_window("sess-9"), 5);
        assert_eq!(state.finish_replay_window("sess-9"), 0);
        assert!(!state.is_replay_window_open("sess-9"));
    }

    #[test]
    fn replay_window_rejected_while_turn_active_and_admitted_after_turn_finishes() {
        let mut state = DriverState::new();
        let _handles = state.try_begin_turn("sess-1").expect("turn starts");
        // Turn-before-replay ordering: the window must NOT open over a live
        // turn (its updates would be misclassified as replayed history).
        assert!(
            !state.try_begin_replay_window("sess-1"),
            "replay window must be rejected while a turn is active"
        );
        assert!(!state.is_replay_window_open("sess-1"));
        // Rejection must not consume/disturb the turn: cancel-grace rules and
        // a later reopen after finish both behave normally.
        assert!(state.is_turn_active("sess-1"));
        let _ = state.finish_turn("sess-1");
        assert!(
            state.try_begin_replay_window("sess-1"),
            "window opens once the turn has finished"
        );
        assert!(state.note_replayed_update("sess-1"));
        assert_eq!(state.finish_replay_window("sess-1"), 1);
    }

    #[test]
    fn turn_rejected_while_replay_window_open_and_admitted_after_window_closes() {
        let mut state = DriverState::new();
        assert!(state.try_begin_replay_window("sess-1"));
        // Replay-before-turn ordering: no turn may start while replayed
        // history is in flight (a second reference keeps the window open and
        // keeps rejecting turns).
        assert!(
            state.try_begin_turn("sess-1").is_none(),
            "turn must be rejected while a replay window is open"
        );
        assert!(state.try_begin_replay_window("sess-1"));
        assert!(
            state.try_begin_turn("sess-1").is_none(),
            "overlapping windows keep rejecting turns"
        );
        // Rejection must not have created a turn.
        assert!(!state.is_turn_active("sess-1"));
        // First close only releases one reference: turns still rejected.
        assert_eq!(state.finish_replay_window("sess-1"), 0);
        assert!(state.try_begin_turn("sess-1").is_none());
        // Final close frees the session for a turn again.
        assert_eq!(state.finish_replay_window("sess-1"), 0);
        assert!(
            state.try_begin_turn("sess-1").is_some(),
            "a turn may begin once the last window reference closes"
        );
    }

    #[test]
    fn replay_window_guard_rejected_while_turn_active() {
        let state = Arc::new(Mutex::new(DriverState::new()));
        let _handles = state.lock().try_begin_turn("sess-1").expect("turn starts");
        assert!(
            ReplayWindowGuard::try_new(state.clone(), "sess-1".to_string()).is_none(),
            "guard admission must fail while a turn is active"
        );
        assert!(
            !state.lock().is_replay_window_open("sess-1"),
            "a rejected guard must leave no window behind"
        );
        let _ = state.lock().finish_turn("sess-1");
        let guard = ReplayWindowGuard::try_new(state.clone(), "sess-1".to_string())
            .expect("guard admitted once the turn finished");
        assert!(state.lock().is_replay_window_open("sess-1"));
        drop(guard);
        assert!(!state.lock().is_replay_window_open("sess-1"));
    }
}
