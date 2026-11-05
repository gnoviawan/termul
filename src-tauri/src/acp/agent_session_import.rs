//! Import a session another client created into the durable session store.
//!
//! An agent can list the sessions it knows (`session/list`), among them the
//! chats a user had in the agent's own CLI. Those sessions have no durable log
//! in Termul, so the chat cannot show them. This service registers the session
//! as a Termul session, has the agent replay its history into the log, and
//! leaves it closed. The chat then opens it like any session of its own, and
//! `session/resume` continues it on the agent.

use std::path::PathBuf;
use std::sync::Arc;

use crate::acp::manager::AcpManager;
use crate::acp::session_persistence::{
    now_millis, PersistedSessionStatus, SessionMetadata, SessionPersistence, SessionRegistration,
};
use crate::acp::{AgentId, SessionId};

/// What the caller knows of the session from `session/list`.
#[derive(Debug, Clone)]
pub struct ImportAgentSessionRequest {
    pub agent_id: AgentId,
    pub session_id: String,
    pub cwd: String,
    pub title: Option<String>,
    /// Time of the last activity, in ms since the epoch.
    pub updated_at: Option<u64>,
    pub project_id: Option<String>,
}

#[derive(Debug)]
pub enum ImportAgentSessionError {
    /// The request lacks a session id or a cwd.
    Invalid(String),
    /// The store already holds a session with this id.
    AlreadyKnown,
    /// The agent could not load the session.
    Agent(String),
    /// The agent replayed no history.
    Empty,
    /// The session store failed.
    Persistence(String),
}

impl std::fmt::Display for ImportAgentSessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(message) | Self::Agent(message) | Self::Persistence(message) => {
                f.write_str(message)
            }
            Self::AlreadyKnown => f.write_str("this session is already in the chat history"),
            Self::Empty => f.write_str("the agent returned no history for this session"),
        }
    }
}

impl std::error::Error for ImportAgentSessionError {}

/// Import one session. A failure leaves no trace in the store.
pub async fn import_agent_session(
    acp: &Arc<AcpManager>,
    persistence: &Arc<SessionPersistence>,
    request: ImportAgentSessionRequest,
) -> Result<SessionMetadata, ImportAgentSessionError> {
    let session_id = request.session_id.trim().to_string();
    let cwd = request.cwd.trim().to_string();
    if session_id.is_empty() || cwd.is_empty() {
        return Err(ImportAgentSessionError::Invalid(
            "sessionId and cwd are required".to_string(),
        ));
    }
    let log_id = crate::logging::redact_session_id(&session_id);
    if persistence.metadata(&session_id).is_ok() {
        log::info!("[acp-import] skipped session_id={log_id}: already known");
        return Err(ImportAgentSessionError::AlreadyKnown);
    }
    log::info!("[acp-import] start session_id={log_id}");
    let namespace = acp
        .stable_agent_namespace(&request.agent_id)
        .map_err(ImportAgentSessionError::Agent)?;
    let created_at = request
        .updated_at
        .filter(|at| *at > 0)
        .unwrap_or_else(now_millis);
    let registration = SessionRegistration {
        session_id: session_id.clone(),
        stable_agent_namespace: namespace,
        runtime_agent_id: Some(request.agent_id.0.to_string()),
        project_id: request.project_id.filter(|id| !id.trim().is_empty()),
        cwd: PathBuf::from(&cwd),
        ..Default::default()
    };
    persistence
        .register_imported_session(registration, created_at, request.title)
        .await
        .map_err(|error| ImportAgentSessionError::Persistence(error.to_string()))?;

    match load_and_close(
        acp,
        persistence,
        &request.agent_id,
        &session_id,
        &cwd,
        request.updated_at.filter(|at| *at > 0),
    )
    .await
    {
        Ok(metadata) => {
            log::info!(
                "[acp-import] success session_id={log_id} messages={}",
                metadata.message_count
            );
            Ok(metadata)
        }
        Err(error) => {
            log::warn!("[acp-import] failure session_id={log_id} error={error}");
            if let Err(rollback) = persistence.delete_session(&session_id).await {
                log::warn!("[acp-import] rollback failed session_id={log_id} error={rollback}");
            }
            Err(error)
        }
    }
}

async fn load_and_close(
    acp: &Arc<AcpManager>,
    persistence: &Arc<SessionPersistence>,
    agent_id: &AgentId,
    session_id: &str,
    cwd: &str,
    updated_at: Option<u64>,
) -> Result<SessionMetadata, ImportAgentSessionError> {
    acp.import_session_history(
        agent_id,
        SessionId(session_id.to_string()),
        cwd.to_string(),
        Vec::new(),
    )
    .await
    .map_err(ImportAgentSessionError::Agent)?;
    persistence
        .flush_session(session_id)
        .await
        .map_err(|error| ImportAgentSessionError::Persistence(error.to_string()))?;

    // Closing hands the session back: a later reopen attaches the project's MCP
    // servers, which this import did not.
    if let Err(error) = acp
        .close_session(agent_id, SessionId(session_id.to_string()))
        .await
    {
        log::warn!(
            "[acp-import] close after import failed session_id={}: {error}",
            crate::logging::redact_session_id(session_id)
        );
        persistence
            .finalize_session(session_id, PersistedSessionStatus::Closed)
            .await
            .map_err(|error| ImportAgentSessionError::Persistence(error.to_string()))?;
    }

    if let Some(at) = updated_at {
        persistence
            .restore_last_activity(session_id, at)
            .await
            .map_err(|error| ImportAgentSessionError::Persistence(error.to_string()))?;
    }
    let metadata = persistence
        .metadata(session_id)
        .map_err(|error| ImportAgentSessionError::Persistence(error.to_string()))?;
    if metadata.message_count == 0 && metadata.tool_count == 0 {
        return Err(ImportAgentSessionError::Empty);
    }
    Ok(metadata)
}

#[cfg(test)]
mod tests;
