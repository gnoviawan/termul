//! Fixtures follow each agent's wire form as its shipped code builds it:
//! Cursor agent CLI 2026.10.22 (`dist-package/189.index.js`), OpenCode 2.2.5
//! (`$C`, `HP`, `JP` and `TaskTool.execute` in the binary), Gemini CLI 0.62
//! (`toAcpToolKind`, `DelegateInvocation.getDescription`).

use serde_json::{json, Map, Value};

use super::super::tools::map_tool_event;
use super::super::{AgentFamily, SUBAGENT_META_KEY};
use super::*;

const ROOT: &str = "chat-1";

fn map(records: &mut SubagentRecords, kind: &str, fields: Value, now_ms: u64) -> MappedToolEvent {
    let mut update: Map<String, Value> = fields.as_object().expect("an object").clone();
    update.insert("sessionUpdate".to_string(), json!(kind));
    map_tool_event(records, ROOT, kind, &update, now_ms)
}

fn record(mapped: &MappedToolEvent) -> Value {
    let (key, value) = mapped.stamp.as_ref().expect("the event carries a record");
    assert_eq!(*key, SUBAGENT_META_KEY);
    value.clone()
}

fn cursor_start(records: &mut SubagentRecords, call: &str, subagent_type: &str) -> Value {
    record(&map(
        records,
        "tool_call",
        json!({
            "toolCallId": call,
            "title": "Task: Explore auth flow",
            "kind": "other",
            "rawInput": {
                "_toolName": "task",
                "prompt": "Find where the login token is refreshed",
                "description": "Explore auth flow",
                "subagentType": subagent_type,
            },
            "locations": [],
        }),
        100,
    ))
}

fn cursor_done(records: &mut SubagentRecords, call: &str, raw_output: Value) -> Value {
    record(&map(
        records,
        "tool_call_update",
        json!({
            "toolCallId": call,
            "status": "completed",
            "content": [{ "type": "content", "content": { "type": "text", "text": "Found it." } }],
            "rawOutput": raw_output,
        }),
        200,
    ))
}

#[test]
fn a_cursor_task_completes_then_cursor_task_adds_its_model() {
    let mut records = SubagentRecords::default();
    let start = cursor_start(&mut records, "tool_1", "explore");
    assert_eq!(
        start,
        json!({
            "id": "tool_1",
            "rootSessionId": ROOT,
            "dispatchToolCallId": "tool_1",
            "source": "cursor-task",
            "title": "Explore auth flow",
            "role": "explore",
            "prompt": "Find where the login token is refreshed",
            "background": false,
            "activity": "running",
            "startedAt": 100,
            "caps": { "stop": null, "transcript": "final", "liveProgress": false, "usage": true },
        })
    );

    let done = cursor_done(
        &mut records,
        "tool_1",
        json!({ "durationMs": 42000, "isBackground": false }),
    );
    assert_eq!(done["activity"], "idle");
    assert_eq!(done["end"], json!({ "reason": "completed" }));
    assert_eq!(done["usage"], json!({ "durationMs": 42000 }));
    assert_eq!(done.get("model"), None);

    let task = json!({
        "toolCallId": "tool_1",
        "description": "Explore auth flow",
        "prompt": "Find where the login token is refreshed",
        "subagentType": "explore",
        "model": "gpt-5.1-codex",
        "agentId": "agent-7f3c",
        "durationMs": 42000,
    });
    let filled = apply_cursor_task(&mut records, &task, 300).expect("the model changed the record");
    let filled = filled.meta_value();
    assert_eq!(filled["model"], "gpt-5.1-codex");
    assert_eq!(filled["usage"], json!({ "durationMs": 42000 }));
    assert_eq!(filled["endedAt"], 200, "the end time stays the call's");
    assert_eq!(
        apply_cursor_task(&mut records, &task, 400),
        None,
        "a repeat changes nothing"
    );
}

#[test]
fn a_cursor_task_error_fails_the_record_although_its_status_is_completed() {
    let mut records = SubagentRecords::default();
    cursor_start(&mut records, "tool_2", "explore");
    let done = cursor_done(
        &mut records,
        "tool_2",
        json!({ "error": "Subagent hit its turn limit" }),
    );
    assert_eq!(done["activity"], "idle");
    assert_eq!(
        done["end"],
        json!({ "reason": "failed", "error": "Subagent hit its turn limit" })
    );
}

#[test]
fn a_later_raw_output_without_an_error_clears_the_failure() {
    let mut records = SubagentRecords::default();
    cursor_start(&mut records, "tool_4", "explore");
    cursor_done(&mut records, "tool_4", json!({ "error": "transient" }));
    let done = cursor_done(&mut records, "tool_4", json!({ "durationMs": 900 }));
    assert_eq!(done["end"], json!({ "reason": "completed" }));
}

#[test]
fn a_cursor_background_task_keeps_running_after_its_call_completes() {
    let mut records = SubagentRecords::default();
    cursor_start(&mut records, "tool_3", "shell");
    let done = cursor_done(
        &mut records,
        "tool_3",
        json!({ "durationMs": 900, "isBackground": true }),
    );
    assert_eq!(done["background"], true);
    assert_eq!(done["activity"], "running");
}

#[test]
fn a_cursor_unspecified_type_is_no_role_and_a_custom_type_names_one() {
    let mut records = SubagentRecords::default();
    let start = cursor_start(&mut records, "tool_4", "unspecified");
    assert_eq!(start.get("role"), None);
    let task = json!({
        "toolCallId": "tool_4",
        "description": "Explore auth flow",
        "prompt": "p",
        "subagentType": { "custom": "security-reviewer" },
    });
    let filled = apply_cursor_task(&mut records, &task, 300).expect("the role changed");
    assert_eq!(filled.role.as_deref(), Some("security-reviewer"));
}

#[test]
fn cursor_task_for_another_call_changes_nothing() {
    let mut records = SubagentRecords::default();
    let untracked = json!({ "toolCallId": "tool_9", "model": "m" });
    assert_eq!(apply_cursor_task(&mut records, &untracked, 1), None);
    assert_eq!(
        apply_cursor_task(&mut records, &json!({ "model": "m" }), 1),
        None
    );

    map(
        &mut records,
        "tool_call",
        json!({
            "toolCallId": "toolu_1",
            "title": "Agent",
            "rawInput": { "description": "d", "prompt": "p" },
            "_meta": { "claudeCode": { "toolName": "Agent" } },
        }),
        1,
    );
    let claude = json!({ "toolCallId": "toolu_1", "model": "m" });
    assert_eq!(apply_cursor_task(&mut records, &claude, 2), None);
    assert_eq!(
        records
            .record(ROOT, "toolu_1")
            .and_then(|r| r.model.clone()),
        None
    );
}

#[test]
fn cursor_tools_other_than_task_are_not_subagents() {
    let mut records = SubagentRecords::default();
    let todos = map(
        &mut records,
        "tool_call",
        json!({
            "toolCallId": "tool_5",
            "title": "Update TODOs",
            "kind": "other",
            "rawInput": { "_toolName": "updateTodos", "todos": [] },
        }),
        1,
    );
    assert!(todos.is_empty());
}

fn opencode_input() -> Value {
    json!({
        "description": "Explore auth flow",
        "prompt": "Find where the login token is refreshed",
        "subagent_type": "explore",
    })
}

fn opencode_start(records: &mut SubagentRecords, call: &str) -> Value {
    let pending = map(
        records,
        "tool_call",
        json!({
            "toolCallId": call, "title": "task", "kind": "think", "status": "pending",
            "locations": [], "rawInput": {},
        }),
        100,
    );
    assert!(pending.is_empty(), "a streaming call has no input yet");
    record(&map(
        records,
        "tool_call_update",
        json!({
            "toolCallId": call, "status": "in_progress", "kind": "think",
            "title": "Explore auth flow", "locations": [], "rawInput": opencode_input(),
        }),
        110,
    ))
}

fn opencode_metadata() -> Value {
    json!({
        "parentSessionId": "ses_parent",
        "sessionId": "ses_child",
        "model": { "providerID": "anthropic", "modelID": "claude-sonnet-4-5" },
    })
}

#[test]
fn an_opencode_task_completes_with_its_model() {
    let mut records = SubagentRecords::default();
    let start = opencode_start(&mut records, "prt_1");
    assert_eq!(start["source"], "opencode-task");
    assert_eq!(start["title"], "Explore auth flow");
    assert_eq!(start["role"], "explore");
    assert_eq!(start["activity"], "running");
    assert_eq!(
        start["caps"],
        json!({ "stop": null, "transcript": "final", "liveProgress": false, "usage": false })
    );

    let done = record(&map(
        &mut records,
        "tool_call_update",
        json!({
            "toolCallId": "prt_1",
            "status": "completed",
            "title": "Explore auth flow",
            "content": [{ "type": "content", "content": { "type": "text", "text": "Found it." } }],
            "rawOutput": { "output": "task_id: ses_child\n\nFound it.", "metadata": opencode_metadata() },
        }),
        200,
    ));
    assert_eq!(done["activity"], "idle");
    assert_eq!(done["end"], json!({ "reason": "completed" }));
    assert_eq!(done["model"], "claude-sonnet-4-5");
    assert_eq!(done["background"], false);
}

#[test]
fn an_opencode_background_task_keeps_running_after_its_launch() {
    let mut records = SubagentRecords::default();
    opencode_start(&mut records, "prt_2");
    let mut metadata = opencode_metadata();
    metadata["background"] = json!(true);
    metadata["jobId"] = json!("ses_child");
    let done = record(&map(
        &mut records,
        "tool_call_update",
        json!({
            "toolCallId": "prt_2",
            "status": "completed",
            "rawOutput": { "output": "Background task started", "metadata": metadata },
        }),
        200,
    ));
    assert_eq!(done["background"], true);
    assert_eq!(done["activity"], "running");
}

#[test]
fn a_failed_opencode_task_keeps_its_error() {
    let mut records = SubagentRecords::default();
    opencode_start(&mut records, "prt_3");
    let error = "Subagent failed (task_id: ses_child): provider overloaded";
    let failed = record(&map(
        &mut records,
        "tool_call_update",
        json!({
            "toolCallId": "prt_3",
            "status": "failed",
            "kind": "think",
            "title": "Explore auth flow",
            "rawInput": opencode_input(),
            "content": [{ "type": "content", "content": { "type": "text", "text": error } }],
            "rawOutput": { "error": error, "metadata": opencode_metadata() },
        }),
        200,
    ));
    assert_eq!(failed["end"], json!({ "reason": "failed", "error": error }));
}

fn gemini_call(status: &str, title: &str) -> Value {
    json!({
        "toolCallId": "invoke_agent-1762160000000-3",
        "status": status,
        "title": title,
        "content": [],
        "locations": [],
        "kind": "think",
    })
}

#[test]
fn a_gemini_cli_subagent_runs_until_its_report_arrives() {
    let mut records = SubagentRecords::default();
    records.set_agent(AgentFamily::GeminiCli);
    let title = "Delegating to agent 'codebase_investigator'";
    let start = record(&map(
        &mut records,
        "tool_call",
        gemini_call("in_progress", title),
        100,
    ));
    assert_eq!(
        start,
        json!({
            "id": "invoke_agent-1762160000000-3",
            "rootSessionId": ROOT,
            "dispatchToolCallId": "invoke_agent-1762160000000-3",
            "source": "gemini-agent",
            "title": "codebase_investigator",
            "role": "codebase_investigator",
            "background": false,
            "activity": "running",
            "startedAt": 100,
            "caps": { "stop": null, "transcript": "final", "liveProgress": false, "usage": false },
        })
    );
    let mut done = gemini_call("completed", title);
    done["content"] =
        json!([{ "type": "content", "content": { "type": "text", "text": "Report" } }]);
    let done = record(&map(&mut records, "tool_call_update", done, 200));
    assert_eq!(done["end"], json!({ "reason": "completed" }));
}

#[test]
fn a_gemini_title_on_another_agent_is_not_a_subagent() {
    let mut records = SubagentRecords::default();
    let title = "Delegating to agent 'generalist'";
    let mapped = map(
        &mut records,
        "tool_call",
        gemini_call("in_progress", title),
        1,
    );
    assert!(mapped.is_empty());
    assert_eq!(records.len(), 0);
}

#[test]
fn other_gemini_think_calls_are_not_subagents() {
    let mut records = SubagentRecords::default();
    records.set_agent(AgentFamily::GeminiCli);
    for title in [
        "Thinking",
        "Delegating to agent ''",
        "Delegating to agent 'a' and 'b'",
        "Delegating to agent 'generalist' now",
    ] {
        let mapped = map(
            &mut records,
            "tool_call",
            gemini_call("in_progress", title),
            1,
        );
        assert!(mapped.is_empty(), "{title}");
    }
    let mut shell = gemini_call("in_progress", "Delegating to agent 'generalist'");
    shell["kind"] = json!("execute");
    assert!(map(&mut records, "tool_call", shell, 1).is_empty());
    assert_eq!(records.len(), 0);
}
