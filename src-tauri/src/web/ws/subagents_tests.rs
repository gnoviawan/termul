#![allow(clippy::unwrap_used, clippy::expect_used)]
//! `stop_subagent` maps each refusal to a stable code. The success path, a
//! cancel that reaches the child session, is covered end to end by
//! `acp::manager::native_subagents_loop_tests`.

use super::*;

async fn stop(payload: Value) -> WsReply {
    let acp = Arc::new(AcpManager::new(vec![]));
    handle_stop_subagent("s1".to_string(), &payload, &acp).await
}

#[tokio::test]
async fn an_unknown_agent_is_not_found() {
    let reply = stop(json!({
        "agentId": "agent-gone",
        "rootSessionId": "chat-1",
        "subagentId": "child-1",
    }))
    .await;
    let error = reply.err.expect("refused");
    assert_eq!(error.code, "not_found");
    assert_eq!(error.message, "The agent of this chat is not running");
}

#[tokio::test]
async fn a_payload_without_the_subagent_is_refused() {
    let reply = stop(json!({ "agentId": "agent-1", "rootSessionId": "chat-1" })).await;
    let error = reply.err.expect("refused");
    assert_eq!(error.code, "unsupported");
    assert!(error
        .message
        .contains("want agentId, rootSessionId, subagentId"));
}
