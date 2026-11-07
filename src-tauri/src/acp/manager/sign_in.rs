//! Agent-level sign-in prompts on the driver thread: hold a request-scoped URL
//! elicitation (Codex device-code sign-in) for the user, and announce when the
//! host stops holding it. The slot itself is [`crate::acp::session::SignInSlot`].

use agent_client_protocol::schema::v1::{
    CompleteElicitationNotification, CreateElicitationResponse, ElicitationAction,
    ElicitationUrlMode,
};
use agent_client_protocol::Responder;

use super::*;
use crate::acp::events::{AgentSignInRequestEvent, AgentSignInResolvedEvent};
use crate::acp::safe_url::{check_safe_url, Opener};
use crate::acp::session::SignInPrompt;

/// Hold `url_mode` as the agent's sign-in prompt and announce it to every
/// client. A URL that is not safe to open on a remote device is cancelled.
pub(super) fn hold_sign_in(
    state: &Mutex<DriverState>,
    sinks: &[Arc<dyn EventSink>],
    agent_id: &AgentId,
    url_mode: &ElicitationUrlMode,
    message: String,
    responder: Responder<CreateElicitationResponse>,
) {
    if let Err(refused) = check_safe_url(&url_mode.url, Opener::Remote) {
        log::warn!("[acp] agent {agent_id} sign-in elicitation cancelled: {refused}");
        let _ = responder.respond(CreateElicitationResponse::new(ElicitationAction::Cancel));
        return;
    }
    let (request_id, replaced) = state
        .lock()
        .sign_in()
        .hold(url_mode.elicitation_id.to_string(), responder);
    if let Some(replaced) = replaced {
        settle_sign_in(sinks, agent_id, replaced, "replaced");
    }
    log::info!("[acp] agent {agent_id} sign-in prompt {request_id} held (request-scoped url)");
    let event = AgentSignInRequestEvent {
        agent_id: agent_id.clone(),
        request_id,
        url: url_mode.url.clone(),
        message,
    };
    events::fan_out(sinks, None, events::EVENT_AGENT_SIGN_IN_REQUEST, &event);
}

/// `elicitation/complete`: the agent finished the sign-in the prompt asked for.
pub(super) fn complete_sign_in(
    state: &Mutex<DriverState>,
    sinks: &[Arc<dyn EventSink>],
    agent_id: &AgentId,
    notification: &CompleteElicitationNotification,
) {
    let completed = state
        .lock()
        .sign_in()
        .complete(&notification.elicitation_id.to_string());
    match completed {
        Some(prompt) => settle_sign_in(sinks, agent_id, prompt, "completed"),
        None => {
            log::debug!("[acp] agent {agent_id} completed an elicitation the host does not hold")
        }
    }
}

/// The host stopped holding `prompt` without the user's answer. An agent still
/// waiting on it gets cancel (it moved on already), and clients drop it.
pub(super) fn settle_sign_in(
    sinks: &[Arc<dyn EventSink>],
    agent_id: &AgentId,
    prompt: SignInPrompt,
    why: &str,
) {
    if let Some(responder) = prompt.responder {
        let _ = responder.respond(CreateElicitationResponse::new(ElicitationAction::Cancel));
    }
    log::info!(
        "[acp] agent {agent_id} sign-in prompt {} settled: {why}",
        prompt.request_id
    );
    announce_sign_in_resolved(sinks, agent_id, prompt.request_id);
}

pub(super) fn announce_sign_in_resolved(
    sinks: &[Arc<dyn EventSink>],
    agent_id: &AgentId,
    request_id: String,
) {
    let event = AgentSignInResolvedEvent {
        agent_id: agent_id.clone(),
        request_id,
    };
    events::fan_out(sinks, None, events::EVENT_AGENT_SIGN_IN_RESOLVED, &event);
}
