//! `ask_user` (issue #784): park the agent's tool call until the user
//! answers, the turn ends, or the agent hangs up.

use std::future::Future;
use std::sync::Arc;

use uuid::Uuid;

use super::HostPlanServer;
use crate::acp::config::{AgentId, SessionId};
use crate::acp::events::{self, AskUserQuestionEvent, QuestionCancelledEvent, QuestionOption};
use crate::acp::host_mcp::{FrameReply, TermulAskUserInput};

/// How a parked `ask_user` call ended (issue #784).
#[derive(Debug)]
pub(crate) enum AskOutcome {
    /// The user picked option labels and/or typed free text.
    Answered(Vec<String>),
    /// The user dismissed the panel, or the turn or session ended first.
    Cancelled,
}

/// Resets the idle deadline of a session's turn: the owning agent's driver
/// `signal_idle`. Registered per agent by the command loop.
pub type IdleSignal = Arc<dyn Fn(&str) + Send + Sync>;

/// An `ask_user` call waiting for the user's answer.
pub(super) struct PendingAsk {
    session_id: String,
    responder: tokio::sync::oneshot::Sender<AskOutcome>,
}

impl HostPlanServer {
    /// Park an `ask_user` call: show the question panel and wait for the
    /// answer, a cancel, or the child hanging up (`hung_up` resolves). The
    /// agent's tool call stays open for as long as the user takes, so there is
    /// no timeout here.
    pub(super) async fn ask_user(
        &self,
        agent_id: &str,
        session_id: &str,
        input: TermulAskUserInput,
        hung_up: impl Future<Output = ()>,
    ) -> FrameReply {
        if input.question.trim().is_empty() {
            return FrameReply::err("question must not be empty");
        }
        if input.options.is_empty() && !input.allow_free_text {
            return FrameReply::err("ask_user needs options or free text");
        }
        let question_id = format!("q-{}", Uuid::new_v4());
        let (responder, waiting) = tokio::sync::oneshot::channel();
        self.pending_asks.lock().insert(
            question_id.clone(),
            PendingAsk {
                session_id: session_id.to_string(),
                responder,
            },
        );

        let cardinality = if input.multi_select {
            "multi"
        } else {
            "single"
        };
        let option_labels: Vec<String> = input.options.iter().map(|o| o.label.clone()).collect();
        let question = match input.header.as_deref().map(str::trim) {
            Some(header) if !header.is_empty() => format!("{header}\n\n{}", input.question),
            _ => input.question,
        };
        let event = AskUserQuestionEvent {
            agent_id: AgentId(agent_id.to_string()),
            session_id: SessionId(session_id.to_string()),
            question_id: question_id.clone(),
            question,
            options: input
                .options
                .into_iter()
                .map(|option| QuestionOption {
                    value: option.label.clone(),
                    label: option.label,
                    description: option.description,
                    cardinality: Some(cardinality.to_string()),
                })
                .collect(),
            allow_free_text: Some(input.allow_free_text),
            multi_select: Some(input.multi_select),
        };
        events::fan_out(
            &self.sinks,
            Some(session_id),
            events::EVENT_QUESTION_REQUEST,
            &event,
        );
        log::info!(
            "[host-mcp] ask_user waiting for the user in session {}",
            crate::logging::redact_session_id(session_id)
        );

        // The user can take a long time. A configured idle timeout would
        // otherwise cancel the turn (and with it this call) while they answer,
        // so keep the session's idle deadline alive for as long as the call is
        // pending. The hard turn timeout is untouched.
        let idle_signal = self.idle_signals.lock().get(agent_id).cloned();
        let heartbeat = self
            .ask_heartbeat_override
            .lock()
            .unwrap_or_else(|| ask_idle_heartbeat(crate::acp::manager::turn_idle_timeout()));
        if let Some(signal) = &idle_signal {
            signal(session_id);
        }
        let mut waiting = waiting;
        tokio::pin!(hung_up);
        let outcome = loop {
            tokio::select! {
                answered = &mut waiting => {
                    break match answered {
                        Ok(outcome) => outcome,
                        // The sender is gone only when the server itself is dropped.
                        Err(_) => AskOutcome::Cancelled,
                    };
                }
                () = &mut hung_up => {
                    self.withdraw_ask(agent_id, session_id, &question_id);
                    break AskOutcome::Cancelled;
                }
                () = tokio::time::sleep(heartbeat) => {
                    if let Some(signal) = &idle_signal {
                        signal(session_id);
                    }
                }
            }
        };
        self.pending_asks.lock().remove(&question_id);
        match outcome {
            AskOutcome::Answered(values) => {
                FrameReply::ok_with(ask_answer_result(&option_labels, values))
            }
            AskOutcome::Cancelled => FrameReply::ok_with(serde_json::json!({
                "answers": [],
                "free_text": null,
                "cancelled": true,
            })),
        }
    }

    /// The agent's MCP client gave up on a parked `ask_user` call, so nobody
    /// reads its answer: drop it and take its question off every client.
    fn withdraw_ask(&self, agent_id: &str, session_id: &str, question_id: &str) {
        if self.pending_asks.lock().remove(question_id).is_none() {
            return;
        }
        log::info!(
            "[host-mcp] ask_user caller hung up in session {}; question withdrawn",
            crate::logging::redact_session_id(session_id)
        );
        events::fan_out(
            &self.sinks,
            Some(session_id),
            events::EVENT_QUESTION_CANCELLED,
            &QuestionCancelledEvent {
                agent_id: AgentId(agent_id.to_string()),
                session_id: SessionId(session_id.to_string()),
                question_id: question_id.to_string(),
            },
        );
    }

    /// Route the user's answer to a parked `ask_user` call. Returns `false`
    /// when no such call is waiting (it was already answered or cancelled, or
    /// the id belongs to a `_session/question` request).
    pub fn answer_ask(&self, question_id: &str, values: Option<Vec<String>>) -> bool {
        let Some(pending) = self.pending_asks.lock().remove(question_id) else {
            return false;
        };
        let outcome = match values {
            Some(values) => AskOutcome::Answered(values),
            None => AskOutcome::Cancelled,
        };
        let _ = pending.responder.send(outcome);
        true
    }

    /// Cancel every `ask_user` call still waiting in a session. Called when the
    /// turn ends, the session closes or the agent goes away, so no tool call is
    /// left hanging.
    pub fn cancel_asks_for_session(&self, real_session_id: &str) {
        let cancelled: Vec<PendingAsk> = {
            let mut pending = self.pending_asks.lock();
            let ids: Vec<String> = pending
                .iter()
                .filter(|(_, ask)| ask.session_id == real_session_id)
                .map(|(id, _)| id.clone())
                .collect();
            ids.iter().filter_map(|id| pending.remove(id)).collect()
        };
        for ask in cancelled {
            let _ = ask.responder.send(AskOutcome::Cancelled);
        }
    }

    /// Register how to reset the idle deadline of `agent_id`'s sessions.
    pub fn set_idle_signal(&self, agent_id: &str, signal: IdleSignal) {
        self.idle_signals
            .lock()
            .insert(agent_id.to_string(), signal);
    }

    /// Forget the idle signal of an agent that went away.
    pub fn clear_idle_signal(&self, agent_id: &str) {
        self.idle_signals.lock().remove(agent_id);
    }

    /// Replace the computed `ask_user` heartbeat interval (tests only).
    #[cfg(test)]
    pub(crate) fn set_ask_heartbeat_for_tests(&self, interval: std::time::Duration) {
        *self.ask_heartbeat_override.lock() = Some(interval);
    }

    /// Question ids of the `ask_user` calls currently waiting (tests only).
    #[cfg(test)]
    pub(crate) fn open_ask_ids(&self) -> Vec<String> {
        self.pending_asks.lock().keys().cloned().collect()
    }
}

/// Split the user's answer into picked option labels and free text. A value
/// that matches an option label counts as a pick; anything else is free text.
fn ask_answer_result(option_labels: &[String], values: Vec<String>) -> serde_json::Value {
    let (answers, free): (Vec<String>, Vec<String>) = values
        .into_iter()
        .partition(|value| option_labels.contains(value));
    let free_text = if free.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::Value::String(free.join("\n"))
    };
    serde_json::json!({
        "answers": answers,
        "free_text": free_text,
        "cancelled": false,
    })
}

/// How often a pending `ask_user` resets the idle deadline: a third of the
/// configured idle timeout, so one missed beat still lands inside the window,
/// within 250 ms and 30 s. Unlimited idle timeout (the default) needs no
/// beat, so it ticks slowly.
pub(super) fn ask_idle_heartbeat(idle_timeout: Option<std::time::Duration>) -> std::time::Duration {
    const MIN: std::time::Duration = std::time::Duration::from_millis(250);
    const MAX: std::time::Duration = std::time::Duration::from_secs(30);
    idle_timeout.map_or(MAX, |timeout| (timeout / 3).clamp(MIN, MAX))
}
