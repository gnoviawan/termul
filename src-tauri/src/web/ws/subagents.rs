//! Subagent WS handlers: `stop_subagent`.

use super::*;
use crate::acp::subagents::StopSubagentError;

/// `stop_subagent` → `AcpManager::stop_subagent(agent_id, root, subagent)`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StopSubagentPayload {
    agent_id: crate::acp::AgentId,
    root_session_id: String,
    subagent_id: String,
}

/// Replies `{ "outcome": "sent" | "already_ended" }`. An unknown agent or
/// subagent is `not_found`; a subagent the agent offers no stop for is
/// `unsupported`.
pub(super) async fn handle_stop_subagent(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
) -> WsReply {
    let parsed: StopSubagentPayload = match serde_json::from_value(payload.clone()) {
        Ok(parsed) => parsed,
        Err(error) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!(
                    "malformed stop_subagent payload (want agentId, rootSessionId, subagentId): {error}"
                ),
            )
        }
    };
    let result = acp
        .stop_subagent(&parsed.agent_id, parsed.root_session_id, parsed.subagent_id)
        .await;
    match result {
        Ok(outcome) => WsReply::ok(id, Some(json!({ "outcome": outcome }))),
        Err(error @ (StopSubagentError::UnknownAgent | StopSubagentError::UnknownSubagent)) => {
            WsReply::err(id, WsErrorCode::NotFound, error.to_string())
        }
        Err(error @ StopSubagentError::NotStoppable) => {
            WsReply::err(id, WsErrorCode::Unsupported, error.to_string())
        }
        Err(StopSubagentError::Failed(error)) => acp_err_to_reply(id, error),
    }
}

#[cfg(test)]
#[path = "subagents_tests.rs"]
mod subagents_tests;
