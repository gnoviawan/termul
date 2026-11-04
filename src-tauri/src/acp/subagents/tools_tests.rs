use serde_json::{json, Map, Value};

use super::*;

const ROOT: &str = "chat-1";

fn event(kind: &str, fields: Value) -> Map<String, Value> {
    let mut update = fields.as_object().expect("fields are an object").clone();
    update.insert("sessionUpdate".to_string(), json!(kind));
    update
}

fn map(records: &mut SubagentRecords, kind: &str, fields: Value, now_ms: u64) -> MappedToolEvent {
    map_tool_event(records, ROOT, kind, &event(kind, fields), now_ms)
}

fn record(mapped: &MappedToolEvent) -> Value {
    let (key, value) = mapped.stamp.as_ref().expect("the event carries a record");
    assert_eq!(*key, SUBAGENT_META_KEY);
    value.clone()
}

#[test]
fn a_claude_foreground_agent_completes_with_its_usage() {
    let mut records = SubagentRecords::default();
    let start = map(
        &mut records,
        "tool_call",
        json!({
            "toolCallId": "toolu_1",
            "title": "Agent",
            "kind": "think",
            "status": "pending",
            "rawInput": { "description": "Review the store", "prompt": "Find bugs", "subagent_type": "reviewer" },
            "_meta": { "claudeCode": { "toolName": "Agent" } },
        }),
        100,
    );
    assert_eq!(
        record(&start),
        json!({
            "id": "toolu_1",
            "rootSessionId": ROOT,
            "dispatchToolCallId": "toolu_1",
            "source": "claude-meta",
            "title": "Review the store",
            "role": "reviewer",
            "prompt": "Find bugs",
            "background": false,
            "activity": "running",
            "startedAt": 100,
            "caps": { "stop": null, "transcript": "live", "liveProgress": false, "usage": true },
        })
    );
    assert!(start.changed.is_empty());

    let done = json!({
        "toolCallId": "toolu_1",
        "status": "completed",
        "_meta": { "claudeCode": { "toolName": "Agent", "toolResponse": {
            "status": "completed", "totalTokens": 1500, "totalDurationMs": 9000, "totalToolUseCount": 7,
        } } },
    });
    let end = record(&map(&mut records, "tool_call_update", done.clone(), 200));
    assert_eq!(end["activity"], "idle");
    assert_eq!(end["end"], json!({ "reason": "completed" }));
    assert_eq!(end["endedAt"], 200);
    assert_eq!(end["startedAt"], 100);
    assert_eq!(
        end["usage"],
        json!({ "totalTokens": 1500, "toolUses": 7, "durationMs": 9000 })
    );
    assert!(
        map(&mut records, "tool_call_update", done, 300).is_empty(),
        "an unchanged record is not re-sent"
    );
}

#[test]
fn a_claude_background_launch_keeps_running_with_its_output_file() {
    let mut records = SubagentRecords::default();
    map(
        &mut records,
        "tool_call",
        json!({
            "toolCallId": "toolu_bg",
            "title": "Agent",
            "rawInput": { "description": "Watch CI", "prompt": "Wait for CI", "run_in_background": true },
            "_meta": { "claudeCode": { "toolName": "Agent" } },
        }),
        1,
    );
    let launched = record(&map(
        &mut records,
        "tool_call_update",
        json!({
            "toolCallId": "toolu_bg",
            "status": "completed",
            "_meta": { "claudeCode": { "toolName": "Agent", "toolResponse": {
                "status": "async_launched", "isAsync": true, "agentId": "a1", "outputFile": "/tmp/a1.output",
            } } },
        }),
        2,
    ));
    assert_eq!(launched["activity"], "running");
    assert_eq!(launched["background"], true);
    assert_eq!(launched["outputFile"], "/tmp/a1.output");
    assert!(launched.get("endedAt").is_none());
}

#[test]
fn a_launch_receipt_alone_marks_the_launch_background() {
    let mut records = SubagentRecords::default();
    map(
        &mut records,
        "tool_call",
        json!({
            "toolCallId": "toolu_r",
            "title": "Task",
            "status": "in_progress",
            "rawInput": { "description": "Scan", "prompt": "Scan it" },
            "_meta": { "claudeCode": { "toolName": "Task" } },
        }),
        1,
    );
    let ended = record(&map(
        &mut records,
        "tool_call_update",
        json!({ "toolCallId": "toolu_r", "status": "completed" }),
        2,
    ));
    assert_eq!(ended["activity"], "idle");
    let receipt = record(&map(
        &mut records,
        "tool_call_update",
        json!({
            "toolCallId": "toolu_r",
            "_meta": { "claudeCode": { "toolResponse": { "status": "remote_launched" } } },
        }),
        3,
    ));
    assert_eq!(receipt["background"], true);
    assert_eq!(receipt["activity"], "running", "a background launch runs on");
    assert!(receipt.get("endedAt").is_none());
}

#[test]
fn claude_rawinput_that_arrives_on_an_update_refreshes_the_record() {
    let mut records = SubagentRecords::default();
    let first = record(&map(
        &mut records,
        "tool_call",
        json!({
            "toolCallId": "toolu_late",
            "title": "Task",
            "rawInput": {},
            "_meta": { "claudeCode": { "toolName": "Task" } },
        }),
        1,
    ));
    assert_eq!(first["title"], "Task");
    assert!(first.get("prompt").is_none());
    let refreshed = record(&map(
        &mut records,
        "tool_call_update",
        json!({
            "toolCallId": "toolu_late",
            "rawInput": { "description": "Map the host", "prompt": "Read src-tauri", "subagent_type": "Explore" },
            "_meta": { "claudeCode": { "toolName": "Task" } },
        }),
        2,
    ));
    assert_eq!(refreshed["title"], "Map the host");
    assert_eq!(refreshed["role"], "Explore");
    assert_eq!(refreshed["prompt"], "Read src-tauri");
    assert_eq!(refreshed["startedAt"], 1);
}

#[test]
fn an_unknown_update_with_dispatch_input_is_classified() {
    let mut records = SubagentRecords::default();
    let mapped = map(
        &mut records,
        "tool_call_update",
        json!({
            "toolCallId": "toolu_u",
            "rawInput": { "description": "Late", "prompt": "Late work" },
            "_meta": { "claudeCode": { "toolName": "Agent" } },
        }),
        1,
    );
    assert_eq!(record(&mapped)["source"], "claude-meta");
}

#[test]
fn claude_child_calls_and_reasoning_are_not_subagents() {
    let mut records = SubagentRecords::default();
    let child = map(
        &mut records,
        "tool_call",
        json!({
            "toolCallId": "toolu_read",
            "title": "Read src/a.ts",
            "rawInput": { "file_path": "src/a.ts" },
            "_meta": { "claudeCode": { "toolName": "Read", "parentToolUseId": "toolu_1" } },
        }),
        1,
    );
    assert!(child.is_empty());
    let think = map(
        &mut records,
        "tool_call",
        json!({ "toolCallId": "think-1", "title": "Thinking", "kind": "think" }),
        1,
    );
    assert!(think.is_empty());
    let status_only = map(
        &mut records,
        "tool_call_update",
        json!({ "toolCallId": "toolu_read", "status": "completed" }),
        2,
    );
    assert!(status_only.is_empty());
    assert_eq!(records.len(), 0);
}

#[test]
fn an_invalid_usage_value_is_ignored() {
    let mut records = SubagentRecords::default();
    let mapped = record(&map(
        &mut records,
        "tool_call",
        json!({
            "toolCallId": "toolu_bad",
            "title": "Agent",
            "status": "completed",
            "rawInput": { "description": "x", "prompt": "y" },
            "_meta": { "claudeCode": { "toolName": "Agent", "toolResponse": {
                "totalTokens": "lots", "totalDurationMs": -5, "totalToolUseCount": 3,
            } } },
        }),
        1,
    ));
    assert_eq!(mapped["usage"], json!({ "toolUses": 3 }));
}

#[test]
fn an_unknown_agents_dispatch_is_mapped_by_the_heuristic() {
    let mut records = SubagentRecords::default();
    let start = record(&map(
        &mut records,
        "tool_call",
        json!({
            "toolCallId": "call-1",
            "title": "Delegate",
            "kind": "other",
            "status": "in_progress",
            "rawInput": { "description": "Explore auth", "prompt": "Find the login flow" },
        }),
        5,
    ));
    assert_eq!(start["source"], "tool-heuristic");
    assert_eq!(start["title"], "Explore auth");
    assert_eq!(
        start["caps"],
        json!({ "stop": null, "transcript": "final", "liveProgress": false, "usage": false })
    );
    let failed = record(&map(
        &mut records,
        "tool_call_update",
        json!({ "toolCallId": "call-1", "status": "failed" }),
        6,
    ));
    assert_eq!(failed["end"], json!({ "reason": "failed" }));
}

#[test]
fn the_title_falls_back_to_the_tool_title_then_subagent() {
    let mut records = SubagentRecords::default();
    let named = record(&map(
        &mut records,
        "tool_call",
        json!({ "toolCallId": "h-1", "title": "Spawn helper", "rawInput": { "subagentType": "helper" } }),
        1,
    ));
    assert_eq!(named["title"], "Spawn helper");
    let bare = record(&map(
        &mut records,
        "tool_call",
        json!({ "toolCallId": "h-2", "rawInput": { "subagent_type": "helper" } }),
        1,
    ));
    assert_eq!(bare["title"], "Subagent");
    let tasked = record(&map(
        &mut records,
        "tool_call",
        json!({ "toolCallId": "h-3", "title": "t", "rawInput": { "subagent_type": "x", "task": "Do the thing" } }),
        1,
    ));
    assert_eq!(tasked["title"], "Do the thing");
}
