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
    assert!(acp_set_agent_idle_window(Some(0)).is_err());
}

#[test]
fn unsafe_authorization_url_is_refused_with_its_code() {
    let refusal = host_auth_url("javascript:alert(1)").unwrap_err();
    assert!(!refusal.success);
    assert_eq!(refusal.code.as_deref(), Some("MCP_UNSAFE_URL"));
    assert_eq!(
        refusal.error.as_deref(),
        Some("refused an unsafe link: only https links are allowed")
    );
}

#[test]
fn host_opened_authorization_url_allows_https_and_loopback_http() {
    assert_eq!(
        host_auth_url("https://auth.example.com/authorize?state=abc")
            .map(String::from)
            .ok(),
        Some("https://auth.example.com/authorize?state=abc".to_string())
    );
    assert_eq!(
        host_auth_url("http://127.0.0.1:4100/authorize")
            .map(String::from)
            .ok(),
        Some("http://127.0.0.1:4100/authorize".to_string())
    );
}
