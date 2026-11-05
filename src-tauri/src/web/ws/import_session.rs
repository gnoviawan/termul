//! `import_agent_session`: copy a session that another client created into the
//! durable history (see `crate::acp::agent_session_import`).

use super::*;
use crate::acp::agent_session_import::{
    import_agent_session, ImportAgentSessionError, ImportAgentSessionRequest,
};
use crate::acp::AgentId;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ImportAgentSessionPayload {
    agent_id: AgentId,
    session_id: String,
    cwd: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    updated_at: Option<u64>,
    #[serde(default)]
    project_id: Option<String>,
}

pub(super) async fn handle_import_agent_session(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
    relay: &Arc<WsRelaySink>,
) -> WsReply {
    let parsed: ImportAgentSessionPayload = match serde_json::from_value(payload.clone()) {
        Ok(parsed) => parsed,
        Err(error) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!(
                    "malformed import_agent_session payload (want agentId, sessionId, cwd): {error}"
                ),
            )
        }
    };
    let Some(persistence) = relay.persistence() else {
        return WsReply::err(
            id,
            WsErrorCode::Unsupported,
            "session persistence unavailable",
        );
    };
    let session_id = parsed.session_id.trim().to_string();
    let result = import_agent_session(
        acp,
        &persistence,
        ImportAgentSessionRequest {
            agent_id: parsed.agent_id,
            session_id: parsed.session_id,
            cwd: parsed.cwd,
            title: parsed.title,
            updated_at: parsed.updated_at,
            project_id: parsed.project_id,
        },
    )
    .await;
    match result {
        Ok(metadata) => {
            crate::web::watch::publish_chat_history(relay, &[session_id.as_str()]);
            info!(
                target: "termul::web::ws",
                messages = metadata.message_count,
                "import_agent_session: imported"
            );
            ok_with_payload(id, &crate::acp::SessionIndexEntry::from(&metadata))
        }
        Err(error) => {
            if error.registered_session() {
                relay.forget_session(&session_id).await;
            }
            warn!(
                target: "termul::web::ws",
                error = %error,
                "import_agent_session: failed"
            );
            match error {
                ImportAgentSessionError::AlreadyKnown => {
                    WsReply::err(id, WsErrorCode::Duplicate, error.to_string())
                }
                ImportAgentSessionError::UnknownAgent(message)
                | ImportAgentSessionError::Agent(message) => acp_err_to_reply(id, message),
                ImportAgentSessionError::Invalid(_) | ImportAgentSessionError::Empty => {
                    WsReply::err(id, WsErrorCode::Unsupported, error.to_string())
                }
                // The store's own message names paths: it stays in the host log.
                ImportAgentSessionError::Registration(_)
                | ImportAgentSessionError::Persistence(_) => WsReply::err(
                    id,
                    WsErrorCode::Unsupported,
                    "the session could not be saved to the chat history",
                ),
            }
        }
    }
}
