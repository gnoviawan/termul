use super::*;

use crate::acp::legacy_models::{resolve_models, WithLegacyModels};

/// Option snapshot returned by a successful `session/load` or `session/resume`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionReopenOutcome {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modes: Option<agent_client_protocol::schema::v1::SessionModeState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<SessionModelState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_options: Option<Vec<SessionConfigOption>>,
    /// The driver answered without the agent because the agent already holds
    /// the session live (`answer_reopen_of_held_session`). Host-only.
    #[serde(skip)]
    pub answered_by_host: bool,
}

/// Whether a reopen outcome means the agent took the reopen's MCP list. A
/// reopen the host answered left the agent on its earlier plan token.
pub(super) fn reached_agent(outcome: &Result<SessionReopenOutcome, String>) -> bool {
    matches!(outcome, Ok(outcome) if !outcome.answered_by_host)
}

/// Convert a reopen response into the outcome plus whether its model list is
/// legacy-only (read-only for `set_model`, issue #822).
pub(super) trait IntoSessionReopenOutcome {
    fn into_session_reopen_outcome(self) -> (SessionReopenOutcome, bool);
}

fn reopen_outcome(
    modes: Option<agent_client_protocol::schema::v1::SessionModeState>,
    config_options: Option<Vec<SessionConfigOption>>,
    legacy: Option<SessionModelState>,
) -> (SessionReopenOutcome, bool) {
    let resolved = resolve_models(config_options.as_deref(), legacy);
    (
        SessionReopenOutcome {
            modes,
            models: resolved.models,
            config_options,
            answered_by_host: false,
        },
        resolved.legacy_only,
    )
}

impl IntoSessionReopenOutcome for LoadSessionResponse {
    fn into_session_reopen_outcome(self) -> (SessionReopenOutcome, bool) {
        reopen_outcome(self.modes, self.config_options, None)
    }
}

impl IntoSessionReopenOutcome for ResumeSessionResponse {
    fn into_session_reopen_outcome(self) -> (SessionReopenOutcome, bool) {
        reopen_outcome(self.modes, self.config_options, None)
    }
}

impl IntoSessionReopenOutcome for WithLegacyModels<LoadSessionResponse> {
    fn into_session_reopen_outcome(self) -> (SessionReopenOutcome, bool) {
        reopen_outcome(
            self.response.modes,
            self.response.config_options,
            self.legacy,
        )
    }
}

impl IntoSessionReopenOutcome for WithLegacyModels<ResumeSessionResponse> {
    fn into_session_reopen_outcome(self) -> (SessionReopenOutcome, bool) {
        reopen_outcome(
            self.response.modes,
            self.response.config_options,
            self.legacy,
        )
    }
}

/// Stable prefix tagging an agent-side `ErrorCode::AuthRequired` (-32000)
/// failure at the manager's `Err(String)` boundary (the
/// `ACP_TURN_IN_PROGRESS` convention). `agent_client_protocol::Error`'s
/// `Display` drops the JSON-RPC code, so without the tag the WS taxonomy and
/// the desktop renderer cannot distinguish "authenticate first" from a
/// generic failure. The renderer prefix-matches this string (stories 5/6).
pub const ACP_AUTH_REQUIRED_PREFIX: &str = "ACP_AUTH_REQUIRED";

/// Stable prefix tagging an agent-side `ErrorCode::ResourceNotFound` (-32002)
/// failure, the agent's answer to a reopen of a session it does not have
/// (issue #1303: a Claude account that never saw the transcript).
pub const ACP_RESOURCE_NOT_FOUND_PREFIX: &str = "ACP_RESOURCE_NOT_FOUND";

/// Wire-string for an agent error crossing the manager's `Err(String)`
/// boundary: `ErrorCode::AuthRequired` gets the [`ACP_AUTH_REQUIRED_PREFIX`]
/// tag, `ErrorCode::ResourceNotFound` the [`ACP_RESOURCE_NOT_FOUND_PREFIX`]
/// tag, a recognized provider failure gets its `ACP_PROVIDER_*` tag
/// ([`tag_provider_error`](crate::acp::provider_errors::tag_provider_error));
/// every other error carries its client-safe message. The message never
/// includes the error's raw `data`.
pub(super) fn acp_err_wire_string(error: agent_client_protocol::Error) -> String {
    let detail = events::AcpErrorDetail::from(&error);
    match error.code {
        agent_client_protocol::ErrorCode::AuthRequired => {
            format!("{ACP_AUTH_REQUIRED_PREFIX}: {}", detail.client_message())
        }
        agent_client_protocol::ErrorCode::ResourceNotFound => {
            format!(
                "{ACP_RESOURCE_NOT_FOUND_PREFIX}: {}",
                detail.client_message()
            )
        }
        _ => crate::acp::provider_errors::tag_provider_error(&detail),
    }
}

/// Answer a `session/load` or `session/resume` of a session this driver
/// already holds live, without sending it to the agent. Returns whether it
/// answered.
///
/// The agent's session is already set up, and the client reads history from
/// the persisted log. claude-acp rebuilds a live session when any reopen input
/// differs from the one it was created with (MCP servers, extra directories),
/// and the rebuild kills the background shells and subagents the session
/// started. Reopening the PWA on an idle-looking chat did this. The caller has
/// already refused the reopen when a prompt turn is running.
pub(super) fn answer_reopen_of_held_session(
    req_state: &Mutex<DriverState>,
    session_id: &str,
    op: &str,
    slot: &ReplySlot<SessionReopenOutcome>,
) -> bool {
    if req_state.lock().session_root(session_id).is_none() {
        return false;
    }
    log::info!(
        "[acp] session {} {op} answered by the host: the agent already holds it live",
        crate::logging::redact_session_id(session_id)
    );
    send_reply(
        slot,
        Ok(SessionReopenOutcome {
            modes: None,
            models: None,
            config_options: None,
            answered_by_host: true,
        }),
    );
    true
}

/// Timed `session/load` / `session/resume`: preserve the option snapshot,
/// record the session root, and track whether the model list is legacy-only
/// (issue #822) on success.
pub(super) async fn run_session_reopen<Fut, T>(
    op: &str,
    session_id: &str,
    cwd: &str,
    req_state: &Mutex<DriverState>,
    request: Fut,
) -> Result<SessionReopenOutcome, String>
where
    Fut: Future<Output = Result<T, agent_client_protocol::Error>>,
    T: IntoSessionReopenOutcome,
{
    let timeout = session_reopen_timeout();
    let outcome = tokio::time::timeout(timeout, request).await;
    let result = match outcome {
        Ok(result) => result
            .map(IntoSessionReopenOutcome::into_session_reopen_outcome)
            .map_err(acp_err_wire_string),
        Err(_) => {
            log::warn!(
                "[acp] session {} {op} timed out after {timeout:?}; \
                 check agent stderr in RUST_LOG=debug",
                crate::logging::redact_session_id(session_id)
            );
            Err(format!("{op} timed out after {timeout:?}"))
        }
    };
    match result {
        Ok((outcome, legacy_only)) => {
            let mut state = req_state.lock();
            state.set_session_root(session_id.to_string(), PathBuf::from(cwd));
            if legacy_only {
                state.mark_legacy_models(session_id.to_string());
            } else {
                state.clear_legacy_models(session_id);
            }
            Ok(outcome)
        }
        Err(error) => Err(error),
    }
}
