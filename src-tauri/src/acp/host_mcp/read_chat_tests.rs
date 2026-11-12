use serde_json::{json, Value};

use super::read_chat::{chat_from_records, render_page, switch_link, Names, TEXT_BUDGET};
use crate::acp::session_persistence::{
    PersistedEventRecord, PersistedSessionStatus, SessionMetadata, SESSION_SCHEMA_VERSION,
};

/// 2025-11-08T10:00:00Z.
const BASE: u64 = 1_762_596_000_000;

fn metadata() -> SessionMetadata {
    SessionMetadata {
        schema_version: SESSION_SCHEMA_VERSION,
        storage_key: "0a0b0c0d-0e0f-4a0b-8c0d-0e0f10111213".to_string(),
        session_id: "chat-b".to_string(),
        stable_agent_namespace: Some("config:claude".to_string()),
        runtime_agent_id: Some("runtime-1".to_string()),
        project_id: Some("project-b".to_string()),
        cwd: "/work/b".to_string(),
        title: Some("Test the\nrelease skill".to_string()),
        title_source: None,
        created_at: BASE,
        last_activity_at: BASE + 3_600_000,
        status: PersistedSessionStatus::Closed,
        message_count: 0,
        tool_count: 0,
        last_seq: 0,
        fold_open_role: None,
        fold_counted: false,
        discovered: false,
        worktree_path: None,
        worktree_branch: None,
        model_id: None,
        model_name: None,
        worktree_branch_source: None,
        worktree_launch_branch: None,
        command_id: None,
        log_epoch: None,
        head_ahead_of_durable: false,
        sweep_checkpoint: None,
        continued_from: None,
    }
}

fn record(seq: u64, type_: &str, payload: Value) -> PersistedEventRecord {
    PersistedEventRecord {
        schema_version: SESSION_SCHEMA_VERSION,
        session_id: "chat-b".to_string(),
        seq,
        type_: type_.to_string(),
        recorded_at: BASE + seq * 1000,
        payload,
    }
}

fn prompt(seq: u64, content: Value) -> PersistedEventRecord {
    record(seq, "user_prompt", json!({ "content": content }))
}

fn chunk(seq: u64, role: &str, text: &str) -> PersistedEventRecord {
    record(
        seq,
        "message_chunk",
        json!({ "role": role, "content": { "type": "text", "text": text } }),
    )
}

fn tool(seq: u64, type_: &str, tool: Value) -> PersistedEventRecord {
    let key = if type_ == "tool_call" {
        "toolCall"
    } else {
        "update"
    };
    record(seq, type_, json!({ key: tool }))
}

fn names() -> Names {
    Names {
        project: Some("Skills playground".to_string()),
        agent: Some("Claude Code".to_string()),
    }
}

/// A user prompt with an attachment, a thought, an agent reply with tool
/// calls (one of them a subagent's own), a handoff boundary row, and a
/// block type nobody reads.
fn fixture() -> Vec<PersistedEventRecord> {
    vec![
        prompt(
            1,
            json!([
                { "type": "text", "text": "Run the release skill" },
                { "type": "resource_link", "name": "SKILL.md", "uri": "file:///skills/release/SKILL.md" },
            ]),
        ),
        chunk(2, "thought", "Let me think about the skill."),
        chunk(3, "agent", "Reading the skill."),
        tool(
            4,
            "tool_call",
            json!({ "toolCallId": "t1", "kind": "read", "status": "pending" }),
        ),
        tool(
            5,
            "tool_call_update",
            json!({ "toolCallId": "t1", "status": "completed" }),
        ),
        tool(
            6,
            "tool_call",
            json!({ "toolCallId": "t2", "kind": "edit", "status": "in_progress",
                    "locations": [{ "path": "/work/b/notes.md" }] }),
        ),
        tool(
            7,
            "tool_call",
            json!({ "toolCallId": "t3", "kind": "read",
                    "_meta": { "claudeCode": { "parentToolUseId": "t9" } } }),
        ),
        tool(
            8,
            "tool_call_update",
            json!({ "toolCallId": "t2", "status": "completed" }),
        ),
        chunk(9, "agent", "Done. The skill skipped step 2."),
        prompt(
            10,
            json!([{ "type": "text", "text": "# Conversation handoff\n\nsummary" }]),
        ),
        prompt(11, json!([{ "type": "audio", "data": "AAAA" }])),
    ]
}

#[test]
fn a_chat_renders_header_messages_and_tool_lines() {
    let chat = chat_from_records(&metadata(), &fixture(), names());
    let page = render_page(&chat, None, None);
    assert_eq!(
        page.text,
        "Chat: Test the release skill
Chat ID: chat-b
Project: Skills playground (ID project-b)
Folder: /work/b
Agent: Claude Code
Status: closed · created 2025-11-08T10:00:00Z · last activity 2025-11-08T11:00:00Z
Messages 1-3 of 3.

[1] user · 2025-11-08T10:00:01Z
Run the release skill
  attachment: SKILL.md

[2] assistant · 2025-11-08T10:00:03Z
Reading the skill.
  tool: read (completed)
  tool: edit /work/b/notes.md (completed)

[3] assistant · 2025-11-08T10:00:09Z
Done. The skill skipped step 2."
    );
    assert_eq!(page.returned, 3);
}

#[test]
fn unknown_names_fall_back_to_ids_and_unassigned_projects_are_left_out() {
    let chat = chat_from_records(&metadata(), &[], Names::default());
    assert_eq!(
        render_page(&chat, None, None).text,
        "Chat: Test the release skill
Chat ID: chat-b
Project: ID project-b
Folder: /work/b
Agent: claude
Status: closed · created 2025-11-08T10:00:00Z · last activity 2025-11-08T11:00:00Z
This chat has no messages."
    );

    let unassigned = SessionMetadata {
        project_id: Some("__unassigned__".to_string()),
        stable_agent_namespace: None,
        title: None,
        ..metadata()
    };
    let chat = chat_from_records(&unassigned, &[], Names::default());
    assert_eq!(
        render_page(&chat, None, None).text,
        "Chat: Untitled Chat
Chat ID: chat-b
Folder: /work/b
Status: closed · created 2025-11-08T10:00:00Z · last activity 2025-11-08T11:00:00Z
This chat has no messages."
    );
}

fn numbered(count: u64) -> Vec<PersistedEventRecord> {
    (1..=count)
        .map(|n| {
            prompt(
                n,
                json!([{ "type": "text", "text": format!("message {n}") }]),
            )
        })
        .collect()
}

fn body(text: &str) -> &str {
    text.split_once("Status: ")
        .and_then(|(_, rest)| rest.split_once('\n'))
        .map(|(_, body)| body)
        .unwrap()
}

#[test]
fn pages_point_at_the_next_offset_until_the_last_one() {
    let chat = chat_from_records(&metadata(), &numbered(5), names());

    let first = render_page(&chat, None, Some(2));
    assert_eq!(
        body(&first.text),
        "Messages 1-2 of 5. More: call read_chat with offset=2.

[1] user · 2025-11-08T10:00:01Z
message 1

[2] user · 2025-11-08T10:00:02Z
message 2"
    );

    let last = render_page(&chat, Some(4), Some(2));
    assert_eq!(
        body(&last.text),
        "Messages 5-5 of 5.

[5] user · 2025-11-08T10:00:05Z
message 5"
    );

    let past = render_page(&chat, Some(9), None);
    assert_eq!(body(&past.text), "No messages at offset 5; the chat has 5.");
    assert_eq!(past.returned, 0);
}

#[test]
fn limit_is_clamped_to_one_through_two_hundred() {
    let chat = chat_from_records(&metadata(), &numbered(250), names());
    assert_eq!(render_page(&chat, None, Some(0)).returned, 1);
    let widest = render_page(&chat, None, Some(1000));
    assert_eq!(widest.returned, 200);
    assert!(
        widest
            .text
            .contains("Messages 1-200 of 250. More: call read_chat with offset=200."),
        "{}",
        &widest.text[..400]
    );
}

#[test]
fn a_page_stops_before_the_message_that_would_pass_the_budget() {
    let long = "x".repeat(TEXT_BUDGET / 2);
    let records: Vec<_> = (1..=3)
        .map(|n| prompt(n, json!([{ "type": "text", "text": long }])))
        .collect();
    let chat = chat_from_records(&metadata(), &records, names());

    let page = render_page(&chat, None, None);
    assert_eq!(page.returned, 1);
    assert!(
        body(&page.text)
            .starts_with("Messages 1-1 of 3. More: call read_chat with offset=1.\n\n[1] user"),
        "{}",
        &page.text[..400]
    );

    let next = render_page(&chat, Some(1), None);
    assert_eq!(next.returned, 1);
    assert!(body(&next.text).starts_with("Messages 2-2 of 3. More: call read_chat with offset=2."));
}

#[test]
fn a_message_over_the_budget_is_cut_so_the_page_still_moves_on() {
    let huge = "y".repeat(TEXT_BUDGET * 2);
    let records = vec![
        prompt(1, json!([{ "type": "text", "text": huge }])),
        chunk(2, "agent", "after"),
    ];
    let chat = chat_from_records(&metadata(), &records, names());
    let page = render_page(&chat, None, None);
    assert_eq!(page.returned, 1);
    let body = body(&page.text);
    let header = "Messages 1-1 of 2. More: call read_chat with offset=1.\n\n";
    assert!(body.starts_with(header), "{}", &body[..200]);
    assert_eq!(
        &body[header.len()..],
        format!(
            "[1] user · 2025-11-08T10:00:01Z\n{}\n[truncated 60072 chars]",
            "y".repeat(59_928)
        )
    );
}

#[test]
fn a_type_less_text_block_still_renders() {
    // Imported prompts can carry a text block with no `type`; the fold reads
    // it as text.
    let records = vec![prompt(1, json!([{ "text": "pasted text" }]))];
    let chat = chat_from_records(&metadata(), &records, names());
    assert!(render_page(&chat, None, None).text.contains("pasted text"));
}

#[test]
fn a_handoff_turn_with_only_tools_keeps_them_as_a_tool_only_entry() {
    // A summary-only handoff prompt folds to a boundary row; its turn's tool
    // calls must not vanish with it.
    let records = vec![
        prompt(
            1,
            json!([{ "type": "text", "text": "# Conversation handoff\n\nsummary" }]),
        ),
        tool(
            2,
            "tool_call",
            json!({ "toolCallId": "t1", "kind": "read", "status": "in_progress" }),
        ),
        tool(
            3,
            "tool_call_update",
            json!({ "toolCallId": "t1", "status": "completed" }),
        ),
    ];
    let chat = chat_from_records(&metadata(), &records, names());
    assert_eq!(
        body(&render_page(&chat, None, None).text),
        "Messages 1-1 of 1.\n\n[1] user · 2025-11-08T10:00:01Z\n\n  tool: read (completed)"
    );
}

#[test]
fn tool_calls_before_any_message_become_a_tool_only_entry() {
    let records = vec![tool(
        1,
        "tool_call",
        json!({ "toolCallId": "t1", "kind": "execute", "status": "completed" }),
    )];
    let chat = chat_from_records(&metadata(), &records, names());
    assert_eq!(
        body(&render_page(&chat, None, None).text),
        "Messages 1-1 of 1.\n\n[1] assistant · 2025-11-08T10:00:01Z\n\n  tool: execute (completed)"
    );
}

#[test]
fn switch_link_names_the_last_linked_session_and_when() {
    assert_eq!(switch_link(&[]), None);
    let records = vec![
        record(
            3,
            "agent_switch",
            json!({ "newSessionId": "chat-c", "fromConfigId": "a", "toConfigId": "b" }),
        ),
        record(
            4,
            "agent_switch",
            json!({ "newSessionId": "chat-d", "fromConfigId": "b", "toConfigId": "c" }),
        ),
        record(
            5,
            "agent_switch",
            json!({ "newSessionId": "", "fromConfigId": "c", "toConfigId": "d" }),
        ),
    ];
    assert_eq!(
        switch_link(&records),
        Some(("chat-d".to_string(), BASE + 4_000))
    );
}

#[test]
fn a_subagent_dispatch_is_one_subagent_line_and_its_own_calls_are_left_out() {
    let records = vec![
        chunk(1, "agent", "Delegating."),
        tool(
            2,
            "tool_call",
            json!({ "toolCallId": "s1", "kind": "task", "status": "in_progress",
                    "_meta": { "termul/subagent": { "name": "explore" } } }),
        ),
        tool(
            3,
            "tool_call",
            json!({ "toolCallId": "s2", "kind": "read",
                    "_meta": { "claudeCode": { "parentToolUseId": "s1" } } }),
        ),
        tool(
            4,
            "tool_call_update",
            json!({ "toolCallId": "s1", "status": "completed" }),
        ),
    ];
    let chat = chat_from_records(&metadata(), &records, names());
    let page = render_page(&chat, None, None);
    let tools: Vec<&str> = body(&page.text)
        .lines()
        .filter(|line| line.starts_with("  tool:"))
        .collect();
    assert_eq!(tools, ["  tool: subagent (completed)"]);
}
