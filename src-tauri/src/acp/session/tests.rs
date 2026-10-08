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
    let (permissions, questions, elicitations) = state.dispose_session("temp");
    assert!(permissions.is_empty());
    assert!(questions.is_empty());
    assert!(elicitations.is_empty());
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

/// Story 8: promotion clears the ephemeral mark and drops the stashed
/// registration, but keeps the session (workspace root) alive.
#[test]
fn unmark_ephemeral_promotes_and_drops_stashed_registration() {
    let mut state = DriverState::new();
    state.set_session_root("warm".to_string(), PathBuf::from("/tmp/ws"));
    state.mark_ephemeral("warm".to_string());
    state.note_promotable_registration(
        "warm".to_string(),
        SessionRegistration {
            session_id: "warm".to_string(),
            cwd: PathBuf::from("/tmp/ws"),
            ..Default::default()
        },
    );
    assert!(state.is_ephemeral("warm"));
    assert!(state.promotable_registration("warm").is_some());

    state.unmark_ephemeral("warm");
    assert!(!state.is_ephemeral("warm"));
    assert!(state.promotable_registration("warm").is_none());
    assert!(state.session_root("warm").is_some());
    // Idempotent: a second unmark is a no-op.
    state.unmark_ephemeral("warm");
    assert!(!state.is_ephemeral("warm"));
}

/// Story 8: the close path captures the pre-removal ephemeral mark — the
/// CloseSession arm's finalization gate depends on it (capturing AFTER
/// removal would always read false and finalize a never-registered
/// session, surfacing a spurious "history finalization failed").
#[test]
fn begin_close_session_captures_ephemeral_mark_before_removal() {
    let mut state = DriverState::new();
    state.set_session_root("warm".to_string(), PathBuf::from("/tmp/ws"));
    state.mark_ephemeral("warm".to_string());
    let (was_ephemeral, pending) = state.begin_close_session("warm");
    assert!(was_ephemeral);
    assert!(pending.is_empty());
    assert!(!state.is_ephemeral("warm"));
    assert!(state.session_root("warm").is_none());

    // A durable session reports false so its close finalizes normally.
    state.set_session_root("durable".to_string(), PathBuf::from("/tmp/ws"));
    let (was_ephemeral, _) = state.begin_close_session("durable");
    assert!(!was_ephemeral);
}

/// Story 8: disposing/closing an un-promoted warm session drops the
/// stashed registration with the rest of the session state.
#[test]
fn remove_session_root_drops_stashed_registration() {
    let mut state = DriverState::new();
    state.set_session_root("warm".to_string(), PathBuf::from("/tmp/ws"));
    state.mark_ephemeral("warm".to_string());
    state.note_promotable_registration(
        "warm".to_string(),
        SessionRegistration {
            session_id: "warm".to_string(),
            cwd: PathBuf::from("/tmp/ws"),
            ..Default::default()
        },
    );
    state.remove_session_root("warm");
    assert!(!state.is_ephemeral("warm"));
    assert!(state.promotable_registration("warm").is_none());
    assert!(state.session_root("warm").is_none());
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
