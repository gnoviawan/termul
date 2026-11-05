//! Folds the history an agent replays on `session/load` into the records of a
//! durable session, for importing a session that another client created.
//!
//! The agent replays a chat as a flat run of `session/update` notifications.
//! A durable log needs the turn structure instead: one `user_prompt` per user
//! message and one `prompt_complete` per answered turn. [`ReplayImport`] adds
//! that structure; the driver numbers and persists each step through the relay.

use agent_client_protocol::schema::v1::SessionUpdate;
use serde_json::Value;

use super::DriverState;

/// One durable step of an imported history.
#[derive(Debug, PartialEq)]
pub(crate) enum ImportStep {
    /// A user message: the prompt that opens a turn.
    UserPrompt {
        turn_id: String,
        content: Vec<Value>,
    },
    /// An agent, thought or tool update, recorded as a live one would be.
    Update(Box<SessionUpdate>),
    /// The turn the previous steps belong to got at least one reply.
    PromptComplete { turn_id: String },
}

#[derive(Debug)]
struct PendingUser {
    message_id: Option<String>,
    content: Vec<Value>,
}

#[derive(Debug)]
struct OpenTurn {
    turn_id: String,
    responded: bool,
}

/// Turn tracking for one replayed history.
#[derive(Debug, Default)]
pub(crate) struct ReplayImport {
    turns: u64,
    pending_user: Option<PendingUser>,
    open_turn: Option<OpenTurn>,
}

impl ReplayImport {
    /// Fold one replayed history update into the steps it completes.
    pub(crate) fn push(&mut self, update: SessionUpdate) -> Vec<ImportStep> {
        match update {
            SessionUpdate::UserMessageChunk(chunk) => {
                let message_id = chunk.message_id.as_ref().map(|id| id.0.to_string());
                let block = serde_json::to_value(&chunk.content).unwrap_or(Value::Null);
                let continues = self.pending_user.as_ref().is_some_and(|pending| {
                    message_id.is_none()
                        || pending.message_id.is_none()
                        || pending.message_id == message_id
                });
                let mut steps = Vec::new();
                if !continues {
                    steps = self.flush_user();
                }
                let pending = self.pending_user.get_or_insert(PendingUser {
                    message_id: message_id.clone(),
                    content: Vec::new(),
                });
                if pending.message_id.is_none() {
                    pending.message_id = message_id;
                }
                push_block(&mut pending.content, block);
                steps
            }
            other => {
                let mut steps = self.flush_user();
                if let Some(turn) = self.open_turn.as_mut() {
                    turn.responded = true;
                }
                steps.push(ImportStep::Update(Box::new(other)));
                steps
            }
        }
    }

    /// End of the history: flush the last user message and close the last turn.
    pub(crate) fn finish(&mut self) -> Vec<ImportStep> {
        let mut steps = self.flush_user();
        steps.extend(self.close_turn());
        steps
    }

    fn flush_user(&mut self) -> Vec<ImportStep> {
        let Some(pending) = self.pending_user.take() else {
            return Vec::new();
        };
        let mut steps: Vec<ImportStep> = self.close_turn().into_iter().collect();
        self.turns += 1;
        let turn_id = format!("import-turn-{}", self.turns);
        self.open_turn = Some(OpenTurn {
            turn_id: turn_id.clone(),
            responded: false,
        });
        steps.push(ImportStep::UserPrompt {
            turn_id,
            content: pending.content,
        });
        steps
    }

    fn close_turn(&mut self) -> Option<ImportStep> {
        let turn = self.open_turn.take()?;
        turn.responded.then_some(ImportStep::PromptComplete {
            turn_id: turn.turn_id,
        })
    }
}

/// Text blocks that follow each other join into one, as the chat shows them.
fn push_block(blocks: &mut Vec<Value>, block: Value) {
    let incoming = block.get("type").and_then(Value::as_str) == Some("text");
    if incoming {
        if let Some(last) = blocks.last_mut() {
            if last.get("type").and_then(Value::as_str) == Some("text") {
                let joined = format!(
                    "{}{}",
                    last.get("text").and_then(Value::as_str).unwrap_or_default(),
                    block
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                );
                if let Some(object) = last.as_object_mut() {
                    object.insert("text".to_string(), Value::String(joined));
                }
                return;
            }
        }
    }
    blocks.push(block);
}

/// Per-session import state of a replay window: the fold plus the records the
/// relay could not take.
#[derive(Debug, Default)]
pub(super) struct ImportWindow {
    fold: ReplayImport,
    failed: u64,
}

impl DriverState {
    /// Open the replay window of a session that is being imported. Its history
    /// becomes durable records instead of being dropped. Refused like
    /// [`DriverState::try_begin_replay_window`] while a turn is active.
    pub(crate) fn try_begin_import_replay_window(&mut self, session_id: &str) -> bool {
        if !self.try_begin_replay_window(session_id) {
            return false;
        }
        if let Some(window) = self.replay_windows.get_mut(session_id) {
            window.import.get_or_insert_with(ImportWindow::default);
        }
        true
    }

    /// Whether the open replay window of the session imports its history.
    pub(crate) fn is_import_window(&self, session_id: &str) -> bool {
        self.replay_windows
            .get(session_id)
            .is_some_and(|window| window.import.is_some())
    }

    /// Fold a replayed update of an import window. `None` when the session
    /// has no import window.
    pub(crate) fn import_push(
        &mut self,
        session_id: &str,
        update: SessionUpdate,
    ) -> Option<Vec<ImportStep>> {
        let window = self.replay_windows.get_mut(session_id)?;
        let import = window.import.as_mut()?;
        Some(import.fold.push(update))
    }

    /// Close the history of an import window and return its last steps.
    pub(crate) fn import_finish(&mut self, session_id: &str) -> Vec<ImportStep> {
        self.replay_windows
            .get_mut(session_id)
            .and_then(|window| window.import.as_mut())
            .map(|import| import.fold.finish())
            .unwrap_or_default()
    }

    /// Count steps the relay could not record.
    pub(crate) fn note_import_failures(&mut self, session_id: &str, failed: u64) {
        if let Some(import) = self
            .replay_windows
            .get_mut(session_id)
            .and_then(|window| window.import.as_mut())
        {
            import.failed += failed;
        }
    }

    /// Steps the relay could not record in the import window so far.
    pub(crate) fn import_failures(&self, session_id: &str) -> u64 {
        self.replay_windows
            .get(session_id)
            .and_then(|window| window.import.as_ref())
            .map_or(0, |import| import.failed)
    }
}
