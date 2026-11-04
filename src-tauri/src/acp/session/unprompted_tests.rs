use super::*;
use agent_client_protocol::schema::v1 as acp;

fn chunk() -> SessionUpdate {
    acp::SessionUpdate::AgentMessageChunk(acp::ContentChunk::new(acp::ContentBlock::Text(
        acp::TextContent::new("working"),
    )))
}

fn tool_call(id: &str, status: ToolCallStatus) -> SessionUpdate {
    acp::SessionUpdate::ToolCall(acp::ToolCall::new(id.to_string(), "Run a command").status(status))
}

fn tool_update(id: &str, status: Option<ToolCallStatus>) -> SessionUpdate {
    let mut fields = acp::ToolCallUpdateFields::new();
    if let Some(status) = status {
        fields = fields.status(status);
    }
    acp::SessionUpdate::ToolCallUpdate(acp::ToolCallUpdate::new(id.to_string(), fields))
}

fn commands() -> SessionUpdate {
    acp::SessionUpdate::AvailableCommandsUpdate(acp::AvailableCommandsUpdate::new(Vec::new()))
}

#[test]
fn streamed_text_starts_work_once_and_goes_quiet_after_the_quiet_period() {
    let mut work = UnpromptedWork::default();
    let start = Instant::now();

    assert!(work.note("s1", &chunk(), start));
    assert!(!work.note("s1", &chunk(), start));
    assert_eq!(work.next_deadline(), Some(start + UNPROMPTED_QUIET));
    assert!(work
        .take_quiet(start + UNPROMPTED_QUIET - Duration::from_secs(1))
        .is_empty());
    assert_eq!(
        work.take_quiet(start + UNPROMPTED_QUIET),
        vec!["s1".to_string()]
    );
    assert_eq!(work.count(), 0);
}

#[test]
fn a_running_tool_call_keeps_the_session_working_however_long_it_is_quiet() {
    let mut work = UnpromptedWork::default();
    let start = Instant::now();

    assert!(work.note("s1", &tool_call("t1", ToolCallStatus::InProgress), start));
    let much_later = start + UNPROMPTED_QUIET * 19;
    assert_eq!(work.next_deadline(), Some(start + UNPROMPTED_STALE));
    assert!(work.take_quiet(much_later).is_empty());

    work.note(
        "s1",
        &tool_update("t1", Some(ToolCallStatus::Completed)),
        much_later,
    );
    assert_eq!(work.next_deadline(), Some(much_later + UNPROMPTED_QUIET));
    assert_eq!(
        work.take_quiet(much_later + UNPROMPTED_QUIET),
        vec!["s1".to_string()]
    );
}

#[test]
fn state_updates_and_finished_tool_calls_do_not_start_work() {
    let mut work = UnpromptedWork::default();
    let now = Instant::now();

    assert!(!work.note("s1", &commands(), now));
    assert!(!work.note("s1", &tool_call("t1", ToolCallStatus::Completed), now));
    assert!(!work.note("s1", &tool_update("t1", Some(ToolCallStatus::Failed)), now));
    assert!(!work.note("s1", &tool_update("t1", None), now));
    assert_eq!(work.count(), 0);
}

#[test]
fn a_keep_alive_update_holds_only_an_open_call() {
    let mut work = UnpromptedWork::default();
    let start = Instant::now();
    work.note("s1", &tool_call("t1", ToolCallStatus::InProgress), start);
    let later = start + Duration::from_secs(5 * 60);

    assert!(!work.note("s1", &tool_update("t1", None), later));
    assert_eq!(work.next_deadline(), Some(later + UNPROMPTED_STALE));

    work.note(
        "s1",
        &tool_update("other", None),
        later + Duration::from_secs(60),
    );
    assert_eq!(work.next_deadline(), Some(later + UNPROMPTED_STALE));
}

#[test]
fn end_reports_whether_the_session_was_working() {
    let mut work = UnpromptedWork::default();
    work.note("s1", &chunk(), Instant::now());

    assert!(work.end("s1"));
    assert!(!work.end("s1"));
    assert!(work.session_ids().is_empty());
}

#[test]
fn an_open_tool_call_that_reports_nothing_goes_stale() {
    let mut work = UnpromptedWork::default();
    let start = Instant::now();
    work.note("s1", &tool_call("t1", ToolCallStatus::InProgress), start);

    assert!(work
        .take_quiet(start + UNPROMPTED_STALE - Duration::from_secs(1))
        .is_empty());
    assert_eq!(
        work.take_quiet(start + UNPROMPTED_STALE),
        vec!["s1".to_string()]
    );
}

#[test]
fn subagent_traffic_is_not_work_of_the_chat() {
    let mut work = UnpromptedWork::default();
    let now = Instant::now();
    let mut child = acp::ContentChunk::new(acp::ContentBlock::Text(acp::TextContent::new("child")));
    let mut meta = Meta::new();
    meta.insert(
        "claudeCode".to_string(),
        serde_json::json!({ "parentToolUseId": "toolu_1" }),
    );
    child.meta = Some(meta);
    let mut card =
        acp::ToolCall::new("toolu_1".to_string(), "Explore").status(ToolCallStatus::InProgress);
    let mut card_meta = Meta::new();
    card_meta.insert(SUBAGENT_META_KEY.to_string(), serde_json::json!({}));
    card.meta = Some(card_meta);

    assert!(!work.note("s1", &acp::SessionUpdate::AgentMessageChunk(child), now));
    assert!(!work.note("s1", &acp::SessionUpdate::ToolCall(card), now));
    assert_eq!(work.count(), 0);
}

#[test]
fn a_republished_finished_call_does_not_push_back_the_quiet_deadline() {
    let mut work = UnpromptedWork::default();
    let start = Instant::now();
    work.note("s1", &chunk(), start);

    work.note(
        "s1",
        &tool_update("old", Some(ToolCallStatus::Completed)),
        start + Duration::from_secs(20),
    );

    assert_eq!(work.next_deadline(), Some(start + UNPROMPTED_QUIET));
}
