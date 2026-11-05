use serde_json::{json, Map, Value};

use super::super::{map_tool_event, SUBAGENT_META_KEY};
use super::*;

const ROOT: &str = "chat-1";

fn map(records: &mut SubagentRecords, kind: &str, fields: Value, now_ms: u64) -> MappedToolEvent {
    let mut update: Map<String, Value> = fields.as_object().expect("object").clone();
    update.insert("sessionUpdate".to_string(), json!(kind));
    map_tool_event(records, ROOT, kind, &update, now_ms)
}

fn record(mapped: &MappedToolEvent) -> Value {
    let (key, value) = mapped.stamp.as_ref().expect("a stamp");
    assert_eq!(*key, SUBAGENT_META_KEY);
    value.clone()
}

fn control(mapped: &MappedToolEvent) -> Value {
    let (key, value) = mapped.stamp.as_ref().expect("a stamp");
    assert_eq!(*key, SUBAGENT_CONTROL_META_KEY);
    value["subagentIds"].clone()
}

fn spawn(id: &str, threads: &[&str]) -> Value {
    json!({
        "toolCallId": id,
        "title": "spawnAgent",
        "kind": "other",
        "status": "in_progress",
        "rawInput": { "senderThreadId": "main", "receiverThreadIds": threads, "prompt": "Audit the store" },
    })
}

fn wait(id: &str, states: Value) -> Value {
    json!({
        "toolCallId": id,
        "title": "wait",
        "status": "in_progress",
        "rawInput": { "senderThreadId": "main", "agentsStates": states },
    })
}

fn card(id: &str, thread: &str, kind: &str) -> Value {
    json!({
        "toolCallId": id,
        "title": format!("Subagent {kind}"),
        "status": "completed",
        "rawInput": { "agentThreadId": thread, "activityKind": kind, "name": "Auditor" },
    })
}

#[test]
fn a_spawn_follows_its_thread_states_reported_on_other_calls() {
    let mut records = SubagentRecords::default();
    let spawned = record(&map(&mut records, "tool_call", spawn("spawn-1", &["t1"]), 10));
    assert_eq!(spawned["source"], "codex-collab");
    assert_eq!(spawned["id"], "spawn-1");
    assert_eq!(spawned["background"], true);
    assert_eq!(spawned["prompt"], "Audit the store");
    assert_eq!(spawned["activity"], "running");
    assert_eq!(
        spawned["caps"],
        json!({ "stop": null, "transcript": "none", "liveProgress": false, "usage": false })
    );

    let waiting = map(
        &mut records,
        "tool_call",
        wait("wait-1", json!({ "t1": { "status": "running" } })),
        11,
    );
    assert_eq!(control(&waiting), json!(["spawn-1"]));
    assert_eq!(waiting.changed.len(), 1);
    assert_eq!(waiting.changed[0].dispatch_tool_call_id, "spawn-1");
    assert!(waiting.changed[0].caps.live_progress);

    let finished = map(
        &mut records,
        "tool_call_update",
        json!({ "toolCallId": "wait-1", "status": "completed",
                "rawInput": { "senderThreadId": "main", "agentsStates": { "t1": { "status": "completed" } } } }),
        12,
    );
    assert_eq!(control(&finished), json!(["spawn-1"]));
    let ended = &finished.changed[0];
    assert_eq!(ended.state, SubagentState::idle(SubagentEndReason::Completed));
    assert_eq!(ended.ended_at, Some(12));

    let closed = map(
        &mut records,
        "tool_call",
        json!({ "toolCallId": "close-1", "title": "closeAgent",
                "rawInput": { "senderThreadId": "main", "receiverThreadIds": ["t1"],
                              "agentsStates": { "t1": { "status": "shutdown" } } } }),
        13,
    );
    assert_eq!(control(&closed), json!(["spawn-1"]));
    assert!(closed.changed.is_empty(), "a completed agent that is shut down stays completed");

    let status_only = map(
        &mut records,
        "tool_call_update",
        json!({ "toolCallId": "close-1", "status": "completed" }),
        14,
    );
    assert_eq!(control(&status_only), json!(["spawn-1"]), "the marker rides every event");
}

#[test]
fn until_a_thread_state_is_known_the_spawn_mirrors_its_call() {
    let mut records = SubagentRecords::default();
    map(&mut records, "tool_call", spawn("spawn-1", &[]), 1);
    let done = record(&map(
        &mut records,
        "tool_call_update",
        json!({ "toolCallId": "spawn-1", "status": "completed" }),
        2,
    ));
    assert_eq!(done["activity"], "idle");
    assert_eq!(done["end"], json!({ "reason": "completed" }));
    assert_eq!(done["caps"]["liveProgress"], false);
}

#[test]
fn a_spawn_aggregates_every_thread_it_names() {
    let mut records = SubagentRecords::default();
    map(&mut records, "tool_call", spawn("spawn-1", &["t1", "t2"]), 1);
    let mixed = map(
        &mut records,
        "tool_call",
        wait("wait-1", json!({ "t1": { "status": "completed" }, "t2": { "status": "errored" } })),
        2,
    );
    assert_eq!(
        mixed.changed[0].state,
        SubagentState::idle(SubagentEndReason::Failed)
    );
    let rerun = map(
        &mut records,
        "tool_call",
        wait("wait-2", json!({ "t2": { "status": "pendingInit" } })),
        3,
    );
    assert_eq!(rerun.changed[0].state, SubagentState::Running);
    assert_eq!(rerun.changed[0].ended_at, None);
    let stopped = map(
        &mut records,
        "tool_call",
        wait("wait-3", json!({ "t2": { "status": "interrupted" } })),
        4,
    );
    assert_eq!(
        stopped.changed[0].state,
        SubagentState::idle(SubagentEndReason::Cancelled)
    );
}

#[test]
fn a_started_card_without_a_spawn_is_a_subagent_of_its_own() {
    let mut records = SubagentRecords::default();
    let started = record(&map(&mut records, "tool_call", card("card-1", "t9", "started"), 1));
    assert_eq!(started["id"], "card-1");
    assert_eq!(started["title"], "Auditor");
    assert_eq!(started["activity"], "running");
    assert_eq!(started["caps"]["liveProgress"], true);

    let completed = map(&mut records, "tool_call", card("card-2", "t9", "completed"), 2);
    assert_eq!(control(&completed), json!(["card-1"]));
    assert_eq!(
        completed.changed[0].state,
        SubagentState::idle(SubagentEndReason::Completed)
    );
}

#[test]
fn a_started_card_for_a_spawned_thread_steers_the_spawn() {
    let mut records = SubagentRecords::default();
    map(&mut records, "tool_call", spawn("spawn-1", &["t1"]), 1);
    let started = map(&mut records, "tool_call", card("card-1", "t1", "started"), 2);
    assert_eq!(control(&started), json!(["spawn-1"]));
    assert_eq!(started.changed[0].state, SubagentState::Running);
    assert!(started.changed[0].caps.live_progress);
    let interrupted = map(&mut records, "tool_call", card("card-2", "t1", "interrupted"), 3);
    assert_eq!(
        interrupted.changed[0].state,
        SubagentState::idle(SubagentEndReason::Cancelled)
    );
}

#[test]
fn a_collab_call_that_names_no_known_subagent_has_an_empty_marker() {
    let mut records = SubagentRecords::default();
    let send = map(
        &mut records,
        "tool_call",
        json!({ "toolCallId": "send-1", "title": "sendInput",
                "rawInput": { "senderThreadId": "main", "receiverThreadIds": ["ghost"] } }),
        1,
    );
    assert_eq!(control(&send), json!([]));
    assert!(send.changed.is_empty());
}

#[test]
fn spawn_titles_match_loosely() {
    for title in ["spawnAgent", "spawn_agent", "Spawn Agent", "spawn-agent"] {
        assert!(is_spawn_title(Some(title)), "{title}");
    }
    assert!(!is_spawn_title(Some("wait")));
    assert!(!is_spawn_title(None));
}
