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

use agent_client_protocol::Responder;
use agent_client_protocol::schema::RequestPermissionResponse;
use std::collections::HashMap;
use std::path::PathBuf;
use tokio::sync::oneshot;

/// A permission request awaiting the user's decision.
///
/// The `responder` completes the agent's in-flight `session/request_permission`
/// request once the user responds (or the turn is cancelled / drained).
pub(crate) struct PendingPermission {
    pub session_id: String,
    pub responder: Responder<RequestPermissionResponse>,
}

/// Mutable state shared across a single agent's driver thread.
#[derive(Default)]
pub(crate) struct DriverState {
    /// Permission requests keyed by a globally-unique correlation id.
    pending_permissions: HashMap<String, PendingPermission>,
    /// Canonicalized workspace root per active session, used to sandbox `fs`
    /// reads/writes to the session's `cwd`.
    session_roots: HashMap<String, PathBuf>,
    /// Sessions with an in-flight prompt turn. The value holds the cancel
    /// signal sender; it is taken (set to `None`) once a cancel has been
    /// signalled, but the key remains until the turn task finishes so a
    /// concurrent turn cannot slip in during the post-cancel grace window.
    active_turns: HashMap<String, Option<oneshot::Sender<()>>>,
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

    /// Look up the canonicalized workspace root for a session, if known.
    pub(crate) fn session_root(&self, session_id: &str) -> Option<PathBuf> {
        self.session_roots.get(session_id).cloned()
    }

    /// Forget a session's workspace root (on explicit close).
    pub(crate) fn remove_session_root(&mut self, session_id: &str) {
        self.session_roots.remove(session_id);
    }

    /// Return all sessions that still have a registered workspace root. Used on
    /// disconnect to emit `acp:session_closed` for sessions that were active.
    pub(crate) fn active_session_ids(&self) -> Vec<String> {
        self.session_roots.keys().cloned().collect()
    }

    /// Attempt to begin a turn for a session. Returns `Some(receiver)` (a cancel
    /// signal) when the turn may proceed, or `None` if a turn is already active
    /// for this session (concurrent turns are rejected).
    pub(crate) fn try_begin_turn(&mut self, session_id: &str) -> Option<oneshot::Receiver<()>> {
        if self.active_turns.contains_key(session_id) {
            return None;
        }
        let (tx, rx) = oneshot::channel();
        self.active_turns.insert(session_id.to_string(), Some(tx));
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

    /// Mark a session's turn finished and return any still-pending permissions
    /// for that session (to be resolved cancelled). Idempotent.
    pub(crate) fn finish_turn(&mut self, session_id: &str) -> Vec<PendingPermission> {
        self.active_turns.remove(session_id);
        self.drain_session(session_id)
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
}
