//! Import a session another client created into the durable session store.
//!
//! An agent can list the sessions it knows (`session/list`), among them the
//! chats a user had in the agent's own CLI. Those sessions have no durable log
//! in Termul, so the chat cannot show them. This service registers the session
//! as a Termul session, has the agent replay its history into the log, and
//! leaves it closed. The chat then opens it like any session of its own, and
//! `session/resume` continues it on the agent.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use parking_lot::Mutex;

use crate::acp::manager::AcpManager;
use crate::acp::session_persistence::{
    now_millis, PersistedSessionStatus, SessionMetadata, SessionPersistence, SessionRegistration,
};
use crate::acp::{AgentId, SessionId};

/// How long the agent has to answer `session/close` after the import.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(30);

/// How far past now an agent-supplied `updatedAt` may lie (clock skew).
const MAX_FUTURE_SKEW_MS: u64 = 300_000;

/// Sessions with an import in flight. A second import of one of them returns
/// `AlreadyKnown`: it must not load the session again, and its rollback must
/// never delete the transcript the first import is writing.
static IMPORTS_IN_FLIGHT: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

struct ImportSlot(String);

impl ImportSlot {
    fn claim(session_id: &str) -> Option<Self> {
        IMPORTS_IN_FLIGHT
            .lock()
            .insert(session_id.to_string())
            .then(|| Self(session_id.to_string()))
    }
}

impl Drop for ImportSlot {
    fn drop(&mut self) {
        IMPORTS_IN_FLIGHT.lock().remove(&self.0);
    }
}

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
    /// The agent is unknown or not running. Nothing was registered.
    UnknownAgent(String),
    /// The session store refused the registration. Nothing was registered.
    Registration(String),
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
            Self::Invalid(message)
            | Self::UnknownAgent(message)
            | Self::Registration(message)
            | Self::Agent(message)
            | Self::Persistence(message) => f.write_str(message),
            Self::AlreadyKnown => f.write_str("this session is already in the chat history"),
            Self::Empty => f.write_str("the agent returned no history for this session"),
        }
    }
}

impl std::error::Error for ImportAgentSessionError {}

impl ImportAgentSessionError {
    /// Whether the import had registered the session (and so may have left
    /// state behind in the relay) when it failed.
    pub fn registered_session(&self) -> bool {
        matches!(self, Self::Agent(_) | Self::Empty | Self::Persistence(_))
    }
}

/// Import one session. A failure leaves no trace in the store.
pub async fn import_agent_session(
    acp: &Arc<AcpManager>,
    persistence: &Arc<SessionPersistence>,
    request: ImportAgentSessionRequest,
) -> Result<SessionMetadata, ImportAgentSessionError> {
    let session_id = request.session_id.trim().to_string();
    // A directory name may end in whitespace on POSIX: only the emptiness check trims.
    let cwd = request.cwd.clone();
    if session_id.is_empty() || cwd.trim().is_empty() {
        return Err(ImportAgentSessionError::Invalid(
            "sessionId and cwd are required".to_string(),
        ));
    }
    let log_id = crate::logging::redact_session_id(&session_id);
    let Some(_slot) = ImportSlot::claim(&session_id) else {
        log::info!("[acp-import] skipped session_id={log_id}: import already running");
        return Err(ImportAgentSessionError::AlreadyKnown);
    };
    if persistence.metadata(&session_id).is_ok() {
        log::info!("[acp-import] skipped session_id={log_id}: already known");
        return Err(ImportAgentSessionError::AlreadyKnown);
    }
    log::info!("[acp-import] start session_id={log_id}");
    let namespace = acp
        .stable_agent_namespace(&request.agent_id)
        .map_err(ImportAgentSessionError::UnknownAgent)?;
    let updated_at = request
        .updated_at
        .filter(|at| *at > 0 && *at <= now_millis() + MAX_FUTURE_SKEW_MS);
    let created_at = updated_at.unwrap_or_else(now_millis);
    let registration = SessionRegistration {
        session_id: session_id.clone(),
        stable_agent_namespace: namespace,
        runtime_agent_id: Some(request.agent_id.0.to_string()),
        project_id: request
            .project_id
            .map(|id| id.trim().to_string())
            .filter(|id| !id.is_empty()),
        cwd: PathBuf::from(&cwd),
        ..Default::default()
    };
    persistence
        .register_imported_session(registration, created_at, request.title)
        .await
        .map_err(|error| ImportAgentSessionError::Registration(error.to_string()))?;

    match load_and_close(
        acp,
        persistence,
        &request.agent_id,
        &session_id,
        &cwd,
        updated_at,
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
    if let Err(message) = acp
        .import_session_history(
            agent_id,
            SessionId(session_id.to_string()),
            cwd.to_string(),
            Vec::new(),
        )
        .await
    {
        // The agent loaded the session but the log lost steps: hand it back. A
        // live session of another flow (`ACP_IMPORT_SESSION_LIVE`) is not ours to close.
        if message.starts_with("ACP_IMPORT_INCOMPLETE") {
            close_agent_session(acp, agent_id, session_id).await;
        }
        return Err(ImportAgentSessionError::Agent(message));
    }

    // The agent now holds the session: every way out from here hands it back,
    // or a retry would find it live.
    if let Err(error) = flush_checked(persistence, session_id).await {
        close_agent_session(acp, agent_id, session_id).await;
        return Err(error);
    }
    // Closing hands the session back: a later reopen attaches the project's MCP
    // servers, which this import did not. An agent that cannot close it keeps it
    // loaded; `session/resume` is then answered by the host.
    let closed = close_agent_session(acp, agent_id, session_id).await;
    if !closed {
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

async fn flush_checked(
    persistence: &Arc<SessionPersistence>,
    session_id: &str,
) -> Result<(), ImportAgentSessionError> {
    persistence
        .flush_session(session_id)
        .await
        .map_err(|error| ImportAgentSessionError::Persistence(error.to_string()))?;
    // A durable append can fail after the flush barrier passed: the flag the
    // writer sets then is the only sign of a record that never landed.
    persistence
        .ensure_writer_healthy(session_id)
        .map_err(|error| ImportAgentSessionError::Persistence(error.to_string()))
}

/// Close the agent's copy of the session within [`CLOSE_TIMEOUT`]. Returns
/// whether the agent closed it.
async fn close_agent_session(acp: &Arc<AcpManager>, agent_id: &AgentId, session_id: &str) -> bool {
    let close = acp.close_session(agent_id, SessionId(session_id.to_string()));
    let failure = match tokio::time::timeout(CLOSE_TIMEOUT, close).await {
        Ok(Ok(())) => return true,
        Ok(Err(error)) => error,
        Err(_) => format!("no answer within {CLOSE_TIMEOUT:?}"),
    };
    log::warn!(
        "[acp-import] close after import failed session_id={}: {failure}",
        crate::logging::redact_session_id(session_id)
    );
    false
}

#[cfg(test)]
mod tests;
