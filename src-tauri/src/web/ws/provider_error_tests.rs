#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Provider failures answer with a stable `provider_*` code and the human
//! message without the manager's transport prefix.

use super::*;

fn err_of(raw: &str) -> WsError {
    let reply = acp_err_to_reply("p1".to_string(), raw.to_string());
    assert!(!reply.ok);
    reply.err.expect("failure carries an error")
}

#[test]
fn provider_tags_map_to_their_codes_without_the_prefix() {
    for (raw, code, message) in [
        (
            "ACP_PROVIDER_QUOTA_EXCEEDED: Internal error: usage limit",
            "provider_quota_exceeded",
            "Internal error: usage limit",
        ),
        (
            "ACP_PROVIDER_SESSION_LIMIT: You've hit your session limit",
            "provider_session_limit",
            "You've hit your session limit",
        ),
        (
            "ACP_PROVIDER_REQUEST_REJECTED: status 400",
            "provider_request_rejected",
            "status 400",
        ),
    ] {
        let err = err_of(raw);
        assert_eq!(err.code, code, "{raw}");
        assert_eq!(err.message, message, "{raw}");
    }
}

#[test]
fn auth_and_untagged_errors_keep_their_codes() {
    assert_eq!(
        err_of("ACP_AUTH_REQUIRED: Authentication required").code,
        "agent_auth_required"
    );
    assert_eq!(err_of("Internal error").code, "not_implemented");
    // A tag without the separator is not a tag.
    assert_eq!(
        err_of("ACP_PROVIDER_QUOTA_EXCEEDED no colon").code,
        "not_implemented"
    );
}
