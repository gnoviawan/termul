//! Records the steps of an imported history through the relay.
//!
//! The relay numbers and persists every record of a session log. These records
//! go to the relay only: the chat they belong to is not open on any client yet.

use std::sync::Arc;

use parking_lot::Mutex;

use agent_client_protocol::schema::v1::SessionNotification;
use serde_json::json;

use super::AgentId;
use crate::acp::events::EVENT_PROMPT_COMPLETE;
use crate::acp::session::replay_import::ImportStep;
use crate::acp::session::DriverState;
use crate::web::sink::{record_host_event, EventSink, HostRecordFanout};

const EVENT_USER_PROMPT: &str = "acp:user_prompt";

/// Record `steps` in `session_id`'s log. Returns how many steps the relay
/// could not take; a session with a lost step is not a faithful copy.
pub(super) fn record_import_steps(
    sinks: &[Arc<dyn EventSink>],
    agent_id: &AgentId,
    session_id: &str,
    steps: Vec<ImportStep>,
) -> u64 {
    let relay_sinks: Vec<Arc<dyn EventSink>> = sinks
        .iter()
        .filter(|sink| sink.as_ws_relay().is_some())
        .cloned()
        .collect();
    let mut failed = 0;
    for step in steps {
        let recorded = match step {
            ImportStep::UserPrompt { turn_id, content } => record_host_event(
                sinks,
                session_id,
                EVENT_USER_PROMPT,
                &json!({
                    "agentId": agent_id,
                    "sessionId": session_id,
                    "turnId": turn_id,
                    "content": content,
                }),
                HostRecordFanout::RelayOnly,
            )
            .is_ok(),
            ImportStep::PromptComplete { turn_id } => record_host_event(
                sinks,
                session_id,
                EVENT_PROMPT_COMPLETE,
                &json!({
                    "agentId": agent_id,
                    "sessionId": session_id,
                    "turnId": turn_id,
                }),
                HostRecordFanout::RelayOnly,
            )
            .is_ok(),
            ImportStep::Update(update) => {
                crate::acp::client::emit_session_update(
                    &relay_sinks,
                    agent_id,
                    SessionNotification::new(session_id.to_string(), *update),
                );
                !relay_sinks.is_empty()
            }
        };
        if !recorded {
            failed += 1;
        }
    }
    failed
}

/// Close the history of an import window and record its last steps. Errors
/// when the relay lost a step anywhere in the history.
pub(super) fn finish_history_import(
    state: &Mutex<DriverState>,
    sinks: &[Arc<dyn EventSink>],
    agent_id: &AgentId,
    session_id: &str,
) -> Result<(), String> {
    let steps = state.lock().import_finish(session_id);
    let failed = record_import_steps(sinks, agent_id, session_id, steps);
    let mut state = state.lock();
    state.note_import_failures(session_id, failed);
    match state.import_failures(session_id) {
        0 => Ok(()),
        failed => Err(format!(
            "ACP_IMPORT_INCOMPLETE: {failed} history step(s) could not be recorded"
        )),
    }
}
