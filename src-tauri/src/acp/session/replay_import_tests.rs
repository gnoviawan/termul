use super::replay_import::{ImportStep, ReplayImport};
use agent_client_protocol::schema::v1::{ContentBlock, ContentChunk, SessionUpdate, TextContent};
use serde_json::json;

fn text(text: &str) -> ContentBlock {
    ContentBlock::Text(TextContent::new(text))
}

fn user(content: &str) -> SessionUpdate {
    SessionUpdate::UserMessageChunk(ContentChunk::new(text(content)))
}

fn user_in(message_id: &str, content: &str) -> SessionUpdate {
    SessionUpdate::UserMessageChunk(ContentChunk::new(text(content)).message_id(message_id))
}

fn agent(content: &str) -> SessionUpdate {
    SessionUpdate::AgentMessageChunk(ContentChunk::new(text(content)))
}

fn prompt(turn: u64, content: &str) -> ImportStep {
    ImportStep::UserPrompt {
        turn_id: format!("import-turn-{turn}"),
        content: vec![json!({"type": "text", "text": content})],
    }
}

fn complete(turn: u64) -> ImportStep {
    ImportStep::PromptComplete {
        turn_id: format!("import-turn-{turn}"),
    }
}

fn fold(updates: Vec<SessionUpdate>) -> Vec<ImportStep> {
    let mut import = ReplayImport::default();
    let mut steps: Vec<ImportStep> = updates
        .into_iter()
        .flat_map(|update| import.push(update))
        .collect();
    steps.extend(import.finish());
    steps
}

#[test]
fn a_user_message_opens_a_turn_and_the_reply_closes_it() {
    let steps = fold(vec![user("hi"), agent("hello"), agent(" there")]);
    assert_eq!(
        steps,
        vec![
            prompt(1, "hi"),
            ImportStep::Update(Box::new(agent("hello"))),
            ImportStep::Update(Box::new(agent(" there"))),
            complete(1),
        ]
    );
}

#[test]
fn each_user_message_after_a_reply_starts_the_next_turn() {
    let steps = fold(vec![user("a"), agent("1"), user("b"), agent("2")]);
    assert_eq!(
        steps,
        vec![
            prompt(1, "a"),
            ImportStep::Update(Box::new(agent("1"))),
            complete(1),
            prompt(2, "b"),
            ImportStep::Update(Box::new(agent("2"))),
            complete(2),
        ]
    );
}

#[test]
fn chunks_of_one_user_message_join_into_one_prompt() {
    let steps = fold(vec![user("he"), user("llo"), agent("x")]);
    assert_eq!(
        steps,
        vec![
            prompt(1, "hello"),
            ImportStep::Update(Box::new(agent("x"))),
            complete(1),
        ]
    );
}

#[test]
fn a_new_message_id_starts_a_new_user_message() {
    let steps = fold(vec![user_in("m1", "a"), user_in("m2", "b"), agent("x")]);
    assert_eq!(
        steps,
        vec![
            prompt(1, "a"),
            prompt(2, "b"),
            ImportStep::Update(Box::new(agent("x"))),
            complete(2)
        ]
    );
}

#[test]
fn a_user_message_without_a_reply_has_no_completion() {
    assert_eq!(
        fold(vec![user("a"), agent("1"), user("b")]),
        vec![
            prompt(1, "a"),
            ImportStep::Update(Box::new(agent("1"))),
            complete(1),
            prompt(2, "b"),
        ]
    );
}

#[test]
fn a_reply_before_any_user_message_is_kept_without_a_turn() {
    assert_eq!(
        fold(vec![agent("greeting")]),
        vec![ImportStep::Update(Box::new(agent("greeting")))]
    );
}

#[test]
fn an_empty_history_has_no_steps() {
    assert!(fold(Vec::new()).is_empty());
}

#[test]
fn an_import_window_and_an_ordinary_window_exclude_each_other() {
    use crate::acp::session::DriverState;

    let mut state = DriverState::new();
    assert!(state.try_begin_import_replay_window("s"));
    assert!(!state.try_begin_replay_window("s"));
    assert!(!state.try_begin_import_replay_window("s"));
    state.finish_replay_window("s");

    assert!(state.try_begin_replay_window("s"));
    assert!(!state.try_begin_import_replay_window("s"));
    assert!(state.try_begin_replay_window("s"));
}
