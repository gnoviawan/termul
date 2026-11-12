//! Load a session another client created and keep its history.

use super::*;

impl AcpManager {
    /// `session/load` that records the history the agent replays as durable
    /// records of `session_id`, instead of dropping it. The session must have a
    /// durable writer (it is registered with the session store). The reopen
    /// carries no MCP servers: the caller closes the session afterwards, and a
    /// later reopen attaches the project's servers. Errors when
    /// the agent already holds the session live: it replays nothing then, so
    /// the import would be empty.
    pub async fn import_session_history(
        &self,
        agent_id: &AgentId,
        session_id: SessionId,
        cwd: String,
        additional_directories: Vec<String>,
    ) -> Result<SessionReopenOutcome, String> {
        let outcome = self
            .load_session_with(
                agent_id,
                session_id,
                cwd,
                additional_directories,
                None,
                true,
            )
            .await?;
        if outcome.answered_by_host {
            return Err(
                "ACP_IMPORT_SESSION_LIVE: the agent already holds this session".to_string(),
            );
        }
        Ok(outcome)
    }
}
