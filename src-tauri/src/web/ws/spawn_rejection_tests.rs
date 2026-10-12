#![allow(clippy::unwrap_used, clippy::expect_used)]
//! AD-5 deterministic spawn rejections over `/ws`: a missing agent binary and
//! an unusable agent config answer with a stable code, never `not_implemented`.

use super::tests::{handle_sync_with_access, test_access};
use super::*;

fn spawn_agent(config: Value) -> WsReply {
    let frame = json!({"id": "s1", "type": "spawn_agent", "payload": {"config": config}});
    let mut authed = true;
    handle_sync_with_access(
        &frame.to_string(),
        &mut authed,
        &mut None,
        &mut test_access(),
        None,
    )
}

#[test]
fn missing_agent_binary_is_agent_unavailable_without_transport_prefix() {
    let reply = spawn_agent(json!({
        "configId": "custom-missing",
        "name": "ghost",
        "command": "termul-no-such-agent-binary-4b",
    }));
    assert!(!reply.ok);
    let err = reply.err.expect("spawn failure carries an error");
    assert_eq!(err.code, "agent_unavailable");
    assert!(
        !err.message.contains("ACP_AGENT_UNAVAILABLE"),
        "the code carries the verdict, not the message: {}",
        err.message
    );
}

#[test]
fn unusable_config_is_invalid_agent_config() {
    for config in [
        json!({"configId": "c", "name": "x", "command": "   "}),
        json!({"configId": "c", "name": " ", "command": "node"}),
        json!({"configId": " ", "name": "x", "command": "node"}),
        json!({"name": "x", "command": "node"}),
    ] {
        let reply = spawn_agent(config.clone());
        assert!(!reply.ok, "{config} must be rejected");
        let err = reply.err.expect("rejection carries an error");
        assert_eq!(err.code, "invalid_agent_config", "{config}");
        assert!(!err.message.contains("ACP_INVALID_AGENT_CONFIG"));
    }
}

/// A start failure with no concrete launch-refusal cause is not a definite
/// rejection: it keeps the generic code so clients may retry it.
#[test]
fn untagged_start_failure_is_not_agent_unavailable() {
    let reply = acp_err_to_reply(
        "s1".to_string(),
        "agent failed to start (process did not initialize)".to_string(),
    );
    let err = reply.err.expect("error reply");
    assert_eq!(err.code, "not_implemented");
}
