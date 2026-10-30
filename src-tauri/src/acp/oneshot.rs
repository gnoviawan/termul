//! Headless one-shot prompts: run a prompt on a fresh ephemeral ACP session
//! with no renderer attached and get the agent's final reply text back.
//!
//! Each [`OneShotSession`] owns a private agent process. The agent is spawned
//! with [`AcpManager::spawn_private`], so its events reach only this module's
//! [`ReplyCollector`] sink and never the WS relay: nothing is shown to,
//! persisted for, or replayed to a client, on desktop and `termul-server`
//! alike. The session is ephemeral, so the host injects no MCP server and the
//! driver auto-cancels permission requests, questions and elicitations.

use std::fmt;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use agent_client_protocol::schema::v1::{ContentBlock, StopReason, TextContent};
use parking_lot::Mutex;

use crate::acp::config::{AgentConfig, AgentId, SessionId};
use crate::acp::events::{self, SessionModelState};
use crate::acp::manager::{AcpManager, SessionCreationContext, ACP_AUTH_REQUIRED_PREFIX};
use crate::web::sink::{AcpEvent, EventSink};

/// How long a timed-out turn may take to settle after its cancel. The driver
/// force-resolves a cancelled turn after its own 5 s grace, so this bound is
/// only reached by a wedged driver.
const CANCEL_SETTLE: Duration = Duration::from_secs(10);

/// What to launch for a one-shot session.
#[derive(Debug, Clone)]
pub struct OneShotRequest {
    /// The agent's launch config. Configs are client-owned, so the caller
    /// resolves it before asking for a session.
    pub config: AgentConfig,
    pub cwd: String,
    /// Option value id of the agent's model selector; `None` keeps the
    /// agent's default.
    pub model: Option<String>,
    /// Selects the Claude account of a managed Claude agent.
    pub project_id: Option<String>,
}

/// A completed turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OneShotReply {
    /// The text of the agent's last message in the turn: tool calls, thought
    /// chunks and subagent text are not part of it.
    pub text: String,
    /// Never [`StopReason::Cancelled`]: that is [`OneShotError::Cancelled`].
    pub stop_reason: StopReason,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OneShotError {
    /// The agent could not be launched, initialized or open a session.
    Spawn(String),
    /// The agent, or the Claude account it runs as, needs a sign-in.
    AuthRequired(String),
    /// The agent does not offer the requested model, or refused to switch.
    ModelUnavailable(String),
    /// The turn outlived its wall-clock budget and was cancelled.
    Timeout(Duration),
    /// The agent ended the turn as cancelled.
    Cancelled,
    /// The agent failed the turn, or its process went away.
    Agent(String),
}

impl fmt::Display for OneShotError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Spawn(detail) => write!(f, "agent did not start: {detail}"),
            Self::AuthRequired(detail) => write!(f, "agent needs sign-in: {detail}"),
            Self::ModelUnavailable(detail) => write!(f, "model unavailable: {detail}"),
            Self::Timeout(budget) => write!(f, "agent turn timed out after {budget:?}"),
            Self::Cancelled => f.write_str("agent cancelled the turn"),
            Self::Agent(detail) => write!(f, "agent turn failed: {detail}"),
        }
    }
}

impl std::error::Error for OneShotError {}

/// A live ephemeral session on a private agent. Prompt it any number of
/// times, then [`dispose`](Self::dispose) it. Dropping it also stops the
/// agent, so an abandoned run never leaks the process.
pub struct OneShotSession {
    agent: AgentLease,
    session_id: SessionId,
    collector: Arc<ReplyCollector>,
}

impl OneShotSession {
    /// Spawn the agent, open an ephemeral session in `request.cwd` and select
    /// `request.model`. Any failure stops the agent before returning.
    pub async fn start(
        manager: &Arc<AcpManager>,
        request: OneShotRequest,
    ) -> Result<Self, OneShotError> {
        let OneShotRequest {
            config,
            cwd,
            model,
            project_id,
        } = request;
        let agent_name = config.name.clone();
        let collector = Arc::new(ReplyCollector::default());
        let spawned = manager
            .spawn_private(config, project_id.as_deref(), vec![collector.clone()])
            .await
            .map_err(|error| {
                log::warn!("[acp-oneshot] {agent_name} spawn failed: {error}");
                start_error(error)
            })?;
        let agent = AgentLease {
            manager: manager.clone(),
            agent_id: spawned.agent_id,
        };
        let created = manager
            .new_session_with_context(
                &agent.agent_id,
                cwd,
                vec![],
                SessionCreationContext {
                    project_id,
                    ephemeral: true,
                    ..SessionCreationContext::default()
                },
            )
            .await
            .map_err(|error| {
                log::warn!(
                    "[acp-oneshot] agent {} session/new failed: {error}",
                    agent.agent_id
                );
                start_error(error)
            })?;
        let session_id = created.session_id;
        let _ = collector.session_id.set(session_id.0.clone());
        if let Some(model) = &model {
            select_model(manager, &agent.agent_id, &session_id, created.models, model).await?;
        }
        log::info!(
            "[acp-oneshot] agent {} ({agent_name}) session {} ready (model={})",
            agent.agent_id,
            crate::logging::redact_session_id(&session_id.0),
            model.as_deref().unwrap_or("default")
        );
        Ok(Self {
            agent,
            session_id,
            collector,
        })
    }

    /// Run one turn and return the agent's final message. A turn still
    /// running after `timeout` is cancelled and fails with
    /// [`OneShotError::Timeout`]; the session stays usable afterwards.
    pub async fn prompt(
        &mut self,
        text: &str,
        timeout: Duration,
    ) -> Result<OneShotReply, OneShotError> {
        let AgentLease { manager, agent_id } = &self.agent;
        let session = crate::logging::redact_session_id(&self.session_id.0);
        let began = Instant::now();
        self.collector.begin_turn();
        let content = vec![ContentBlock::Text(TextContent::new(text))];
        let started = manager
            .start_prompt(agent_id, self.session_id.clone(), content, None, None)
            .await
            .map_err(|error| self.turn_error(error))?;
        let completion = manager.wait_prompt(started);
        tokio::pin!(completion);
        let outcome = match tokio::time::timeout(timeout, &mut completion).await {
            Ok(outcome) => outcome,
            Err(_) => {
                log::warn!(
                    "[acp-oneshot] agent {agent_id} session {session} turn timed out after {timeout:?}; cancelling"
                );
                if let Err(error) = manager
                    .cancel_prompt(agent_id, self.session_id.clone())
                    .await
                {
                    log::warn!("[acp-oneshot] agent {agent_id} cancel failed: {error}");
                }
                // The next prompt is refused while this turn is still active.
                let _ = tokio::time::timeout(CANCEL_SETTLE, &mut completion).await;
                return Err(OneShotError::Timeout(timeout));
            }
        };
        let elapsed_ms = began.elapsed().as_millis();
        match outcome {
            Ok(StopReason::Cancelled) => {
                log::warn!(
                    "[acp-oneshot] agent {agent_id} session {session} turn cancelled by the agent after {elapsed_ms} ms"
                );
                Err(OneShotError::Cancelled)
            }
            Ok(stop_reason) => {
                let Some(text) = self.collector.take_reply() else {
                    log::warn!(
                        "[acp-oneshot] agent {agent_id} session {session} reply exceeded {MAX_REPLY_BYTES} bytes"
                    );
                    return Err(OneShotError::Agent(format!(
                        "reply exceeded {MAX_REPLY_BYTES} bytes"
                    )));
                };
                log::info!(
                    "[acp-oneshot] agent {agent_id} session {session} turn complete: stop_reason={stop_reason:?}, {} chars in {elapsed_ms} ms",
                    text.chars().count()
                );
                Ok(OneShotReply { text, stop_reason })
            }
            Err(error) => {
                log::warn!(
                    "[acp-oneshot] agent {agent_id} session {session} turn failed after {elapsed_ms} ms: {error}"
                );
                Err(self.turn_error(error))
            }
        }
    }

    /// Stop the agent and wait (bounded) for its driver to exit.
    pub async fn dispose(self) {
        let AgentLease { manager, agent_id } = &self.agent;
        if let Err(error) = manager.kill(agent_id).await {
            log::warn!("[acp-oneshot] agent {agent_id} dispose failed: {error}");
        }
        log::info!("[acp-oneshot] agent {agent_id} disposed");
    }

    #[cfg(test)]
    pub(crate) fn agent_id(&self) -> &AgentId {
        &self.agent.agent_id
    }

    fn turn_error(&self, error: String) -> OneShotError {
        if self.collector.turn_auth_required() {
            OneShotError::AuthRequired(error)
        } else {
            OneShotError::Agent(error)
        }
    }
}

/// Stops the agent on drop. `kill` is idempotent, so the drop after an
/// awaited [`OneShotSession::dispose`] is a no-op.
struct AgentLease {
    manager: Arc<AcpManager>,
    agent_id: AgentId,
}

impl Drop for AgentLease {
    fn drop(&mut self) {
        self.manager.kill_detached(&self.agent_id);
    }
}

async fn select_model(
    manager: &Arc<AcpManager>,
    agent_id: &AgentId,
    session_id: &SessionId,
    offered: Option<SessionModelState>,
    model: &str,
) -> Result<(), OneShotError> {
    let Some(offered) = offered else {
        return Err(OneShotError::ModelUnavailable(format!(
            "the agent offers no model selector (requested `{model}`)"
        )));
    };
    if offered.current_model_id == model {
        return Ok(());
    }
    if !offered.available_models.iter().any(|m| m.model_id == model) {
        return Err(OneShotError::ModelUnavailable(format!(
            "the agent does not offer `{model}`"
        )));
    }
    manager
        .set_model(agent_id, session_id.clone(), model.to_string())
        .await
        .map_err(|error| {
            log::warn!("[acp-oneshot] agent {agent_id} model switch failed: {error}");
            OneShotError::ModelUnavailable(error)
        })
}

fn start_error(error: String) -> OneShotError {
    if is_auth_required(&error) {
        OneShotError::AuthRequired(error)
    } else {
        OneShotError::Spawn(error)
    }
}

/// The manager's tagged auth failures: an agent `AuthRequired` RPC error, or
/// a managed Claude account that is signed out.
fn is_auth_required(error: &str) -> bool {
    error
        .strip_prefix(ACP_AUTH_REQUIRED_PREFIX)
        .is_some_and(|rest| rest.starts_with(": "))
        || crate::acp::claude_accounts::strip_signed_out_tag(error).is_some()
}

/// The private agent's only sink: keeps the text of the current turn's last
/// agent message, and whether the turn failed with `AuthRequired` (the prompt
/// reply string drops the RPC code; the `agent_error` event keeps it).
#[derive(Default)]
struct ReplyCollector {
    session_id: OnceLock<String>,
    turn: Mutex<TurnCapture>,
}

/// Cap on one turn's collected reply, so a runaway agent cannot grow host
/// memory until the prompt timeout.
pub(crate) const MAX_REPLY_BYTES: usize = 1024 * 1024;

#[derive(Default)]
struct TurnCapture {
    text: String,
    /// The current message outgrew [`MAX_REPLY_BYTES`]; its text is dropped.
    overflowed: bool,
    message_id: Option<String>,
    /// A tool call ended the current message; the next chunk starts another.
    message_closed: bool,
    auth_required: bool,
}

impl ReplyCollector {
    fn begin_turn(&self) {
        *self.turn.lock() = TurnCapture::default();
    }

    /// The turn's final message, or `None` when it outgrew [`MAX_REPLY_BYTES`].
    fn take_reply(&self) -> Option<String> {
        let mut turn = self.turn.lock();
        (!turn.overflowed).then(|| std::mem::take(&mut turn.text))
    }

    fn turn_auth_required(&self) -> bool {
        self.turn.lock().auth_required
    }
}

impl EventSink for ReplyCollector {
    fn emit(&self, event: &AcpEvent) {
        let Some(session_id) = self.session_id.get() else {
            return;
        };
        if event.sid.as_deref() != Some(session_id.as_str()) {
            return;
        }
        let payload = &event.payload;
        let mut turn = self.turn.lock();
        match event.type_ {
            events::EVENT_MESSAGE_CHUNK => {
                let is_main_agent_text = payload["role"] == "agent"
                    && payload["content"]["type"] == "text"
                    && payload.get("parentToolCallId").is_none();
                let Some(text) = payload["content"]["text"]
                    .as_str()
                    .filter(|_| is_main_agent_text)
                else {
                    return;
                };
                let message_id = payload["messageId"].as_str().map(str::to_owned);
                if turn.message_closed || (message_id.is_some() && message_id != turn.message_id) {
                    turn.text.clear();
                    turn.overflowed = false;
                    turn.message_closed = false;
                }
                if message_id.is_some() {
                    turn.message_id = message_id;
                }
                if turn.overflowed || turn.text.len() + text.len() > MAX_REPLY_BYTES {
                    turn.overflowed = true;
                    turn.text.clear();
                } else {
                    turn.text.push_str(text);
                }
            }
            events::EVENT_TOOL_CALL => turn.message_closed = true,
            events::EVENT_AGENT_ERROR
                if payload["code"].as_i64()
                    == Some(i64::from(i32::from(
                        agent_client_protocol::ErrorCode::AuthRequired,
                    ))) =>
            {
                turn.auth_required = true;
            }
            _ => {}
        }
    }
}

#[cfg(test)]
#[path = "oneshot_tests.rs"]
mod tests;
