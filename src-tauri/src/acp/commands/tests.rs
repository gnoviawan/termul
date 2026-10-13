use super::*;

/// Zero is meaningless for the three strictly-positive timeouts and must
/// be rejected at the IPC boundary (the resolvers also filter it
/// defensively). Rejection happens BEFORE the override is stored, so
/// these assertions never mutate the shared override statics.
#[test]
fn zero_overrides_are_rejected_for_strictly_positive_timeouts() {
    assert!(acp_set_turn_idle_timeout(Some(0)).is_err());
    assert!(acp_set_session_new_timeout(Some(0)).is_err());
    assert!(acp_set_session_reopen_timeout(Some(0)).is_err());
}
