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
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
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
    /// rejected). Both signals are created atomically so the notification
    /// callback can nudge the idle deadline from the moment the turn starts.
    pub(crate) fn try_begin_turn(&mut self, session_id: &str) -> Option<TurnHandles> {
        if self.active_turns.contains_key(session_id) {
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
}
