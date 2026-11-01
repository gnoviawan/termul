//! The agent-level sign-in prompt.
//!
//! An agent can ask the user to visit a URL outside any chat: Codex answers
//! `authenticate {methodId: "chat-gpt-device-code"}` with a request-scoped URL
//! elicitation whose message carries the device code. No turn owns it, so
//! the driver holds it here, one per agent, until the user answers it, the
//! agent completes it (`elicitation/complete`), or `authenticate` ends.

use agent_client_protocol::schema::v1::CreateElicitationResponse;
use agent_client_protocol::Responder;

/// A held sign-in prompt.
pub(crate) struct SignInPrompt {
    /// Host correlation id the clients answer with.
    pub request_id: String,
    /// The agent's id for the elicitation; `elicitation/complete` names it.
    elicitation_id: String,
    /// `None` once the user accepted. The prompt stays up after that, since
    /// the user still needs its code, until the agent completes the sign-in.
    pub responder: Option<Responder<CreateElicitationResponse>>,
}

/// What a user answer took from the slot.
pub(crate) struct SignInAnswer {
    /// Still unanswered on the agent side; respond with the user's action.
    pub responder: Option<Responder<CreateElicitationResponse>>,
    /// The prompt is gone, so clients must be told to drop it.
    pub settled: bool,
}

/// Where a request-scoped elicitation goes.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RequestElicitationRoute {
    /// Hold it as the agent's sign-in prompt.
    SignIn,
    /// Show it in the chat whose turn is the only one running.
    Session(String),
    /// Nothing can show it.
    Cancel,
}

#[derive(Default)]
pub(crate) struct SignInSlot {
    /// `authenticate` requests in flight.
    authenticating: usize,
    prompt: Option<SignInPrompt>,
}

impl SignInSlot {
    /// Route a request-scoped elicitation. A URL one raised during
    /// `authenticate`, or while no single turn could own it, is a sign-in
    /// prompt; anything else keeps the turn routing.
    pub(crate) fn route(
        &self,
        url_mode: bool,
        sole_turn: Option<String>,
    ) -> RequestElicitationRoute {
        match (url_mode, self.authenticating > 0, sole_turn) {
            (true, true, _) | (true, false, None) => RequestElicitationRoute::SignIn,
            (_, _, Some(session_id)) => RequestElicitationRoute::Session(session_id),
            (false, _, None) => RequestElicitationRoute::Cancel,
        }
    }

    pub(crate) fn begin_authenticate(&mut self) {
        self.authenticating += 1;
    }

    /// An `authenticate` settled: whatever prompt it raised is over.
    pub(crate) fn end_authenticate(&mut self) -> Option<SignInPrompt> {
        self.authenticating = self.authenticating.saturating_sub(1);
        self.prompt.take()
    }

    /// Hold a new prompt and return its request id plus the prompt it
    /// replaced, which the caller cancels.
    pub(crate) fn hold(
        &mut self,
        elicitation_id: String,
        responder: Responder<CreateElicitationResponse>,
    ) -> (String, Option<SignInPrompt>) {
        let request_id = format!("signin-{}", uuid::Uuid::new_v4());
        let replaced = self.prompt.replace(SignInPrompt {
            request_id: request_id.clone(),
            elicitation_id,
            responder: Some(responder),
        });
        (request_id, replaced)
    }

    /// The user answered prompt `request_id`. Accept keeps the prompt up and
    /// takes its responder once; any other action ends the prompt. `None`
    /// when no prompt has that id.
    pub(crate) fn answer(&mut self, request_id: &str, accept: bool) -> Option<SignInAnswer> {
        let prompt = self
            .prompt
            .as_mut()
            .filter(|prompt| prompt.request_id == request_id)?;
        if accept {
            return Some(SignInAnswer {
                responder: prompt.responder.take(),
                settled: false,
            });
        }
        let prompt = self.prompt.take()?;
        Some(SignInAnswer {
            responder: prompt.responder,
            settled: true,
        })
    }

    /// The agent reported elicitation `elicitation_id` complete.
    pub(crate) fn complete(&mut self, elicitation_id: &str) -> Option<SignInPrompt> {
        if self.prompt.as_ref()?.elicitation_id != elicitation_id {
            return None;
        }
        self.prompt.take()
    }

    #[must_use]
    pub(crate) fn is_pending(&self) -> bool {
        self.prompt.is_some()
    }
}
