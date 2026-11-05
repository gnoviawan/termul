//! The update sequences below are the ones claude-agent-acp 0.100.0 and
//! codex-acp 2.5.0 sent to a raw ACP client with Termul's capabilities
//! (2026-11-05), output deltas elided.

use super::*;
use serde_json::json;

fn update(value: Value) -> SessionUpdate {
    serde_json::from_value(value).expect("a session update")
}

fn feed(commands: &mut BackgroundCommands, session_id: &str, updates: &[Value], now_ms: u64) {
    for value in updates {
        commands.note(session_id, &update(value.clone()), now_ms);
    }
}

fn running(id: &str, title: &str, command: &str, started_at_ms: u64) -> BackgroundCommand {
    BackgroundCommand {
        tool_call_id: id.to_string(),
        title: title.to_string(),
        command: Some(command.to_string()),
        started_at_ms,
        state: CommandState::Running,
    }
}

fn claude_background_call() -> Vec<Value> {
    let id = "toolu_01KQuaEEh6oct9vhst8549LZ";
    vec![
        json!({"_meta":{"claudeCode":{"toolName":"Bash"},"terminal_info":{"terminal_id":id}},"toolCallId":id,"sessionUpdate":"tool_call","rawInput":{},"status":"pending","title":"Terminal","kind":"execute","content":[{"type":"terminal","terminalId":id}]}),
        json!({"_meta":{"claudeCode":{"toolName":"Bash"}},"toolCallId":id,"sessionUpdate":"tool_call_update","rawInput":{"command":"sleep 25; echo probe-done"},"title":"sleep 25; echo probe-done"}),
        json!({"_meta":{"claudeCode":{"toolName":"Bash"}},"toolCallId":id,"sessionUpdate":"tool_call_update","rawInput":{"command":"sleep 25; echo probe-done","description":"Sleep then print probe-done"}}),
        json!({"_meta":{"claudeCode":{"toolName":"Bash"}},"toolCallId":id,"sessionUpdate":"tool_call_update","rawInput":{"command":"sleep 25; echo probe-done","description":"Sleep then print probe-done","run_in_background":true}}),
        json!({"_meta":{"claudeCode":{"toolResponse":{"stdout":"","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":false,"backgroundTaskId":"bqyzmlm5k"},"toolName":"Bash"}},"toolCallId":id,"sessionUpdate":"tool_call_update"}),
        json!({"_meta":{"terminal_output_delta":""},"toolCallId":id,"sessionUpdate":"tool_call_update"}),
        json!({"_meta":{"claudeCode":{"toolName":"Bash"}},"toolCallId":id,"sessionUpdate":"tool_call_update","status":"completed"}),
    ]
}

fn claude_background_exit() -> Value {
    let id = "toolu_01KQuaEEh6oct9vhst8549LZ";
    json!({"_meta":{"terminal_exit":{"terminal_id":id,"exit_code":null,"signal":null}},"toolCallId":id,"sessionUpdate":"tool_call_update"})
}

fn codex_command_call(id: &str, command: &str) -> Value {
    json!({"sessionUpdate":"tool_call","toolCallId":id,"name":"exec_command","kind":"execute","title":command,"status":"in_progress","content":[{"type":"terminal","terminalId":id}],"rawInput":{"command":command,"cwd":"/tmp/bgw-probe/work"},"_meta":{"terminal_info":{"cwd":"/tmp/bgw-probe/work","terminal_id":id}}})
}

fn codex_command_exit(id: &str) -> Vec<Value> {
    vec![
        json!({"sessionUpdate":"tool_call_update","toolCallId":id,"_meta":{"terminal_output_delta":""}}),
        json!({"sessionUpdate":"tool_call_update","toolCallId":id,"name":"exec_command","status":"completed","_meta":{"terminal_exit":{"exit_code":0,"signal":null,"terminal_id":id}}}),
    ]
}

#[test]
fn claude_run_in_background_runs_from_its_completed_status_until_its_late_terminal_exit() {
    let mut commands = BackgroundCommands::default();
    let calls = claude_background_call();
    let (last, opening) = calls.split_last().unwrap();
    feed(&mut commands, "s1", opening, 1_000);
    assert!(commands.list("s1").is_empty());

    assert!(commands.note("s1", &update(last.clone()), 2_000));
    let started = running(
        "toolu_01KQuaEEh6oct9vhst8549LZ",
        "Sleep then print probe-done",
        "sleep 25; echo probe-done",
        1_000,
    );
    assert_eq!(commands.list("s1"), vec![started.clone()]);
    assert!(!commands.end_turn("s1", |_| false));
    assert_eq!(commands.running_count(), 1);

    assert!(commands.note("s1", &update(claude_background_exit()), 27_000));
    assert_eq!(
        commands.list("s1"),
        vec![BackgroundCommand {
            state: CommandState::Ended {
                ended_at_ms: 27_000
            },
            ..started
        }]
    );
    assert_eq!(commands.running_count(), 0);
    assert!(!commands.note("s1", &update(claude_background_exit()), 28_000));
}

#[test]
fn a_claude_foreground_command_reports_its_exit_with_its_status_and_is_not_listed() {
    let id = "toolu_01FSB4iHTvFgrCCMs6Hu2Zu4";
    let mut commands = BackgroundCommands::default();
    feed(
        &mut commands,
        "s1",
        &[
            json!({"_meta":{"claudeCode":{"toolName":"Bash"},"terminal_info":{"terminal_id":id}},"toolCallId":id,"sessionUpdate":"tool_call","rawInput":{},"status":"pending","title":"Terminal","kind":"execute","content":[{"type":"terminal","terminalId":id}]}),
            json!({"_meta":{"claudeCode":{"toolName":"Bash"}},"toolCallId":id,"sessionUpdate":"tool_call_update","rawInput":{"command":"echo fg-ok"},"title":"echo fg-ok"}),
            json!({"_meta":{"terminal_output_delta":""},"toolCallId":id,"sessionUpdate":"tool_call_update"}),
            json!({"_meta":{"claudeCode":{"toolName":"Bash"},"terminal_exit":{"terminal_id":id,"exit_code":0,"signal":null}},"toolCallId":id,"sessionUpdate":"tool_call_update","status":"completed"}),
        ],
        1_000,
    );
    assert!(!commands.end_turn("s1", |_| false));
    assert!(commands.list("s1").is_empty());
}

#[test]
fn a_claude_command_cancelled_mid_turn_fails_with_its_exit_and_is_not_listed() {
    let id = "toolu_01KmTNmmPHDzo5tVif4LmJDJ";
    let mut commands = BackgroundCommands::default();
    feed(
        &mut commands,
        "s1",
        &[
            json!({"_meta":{"claudeCode":{"toolName":"Bash"},"terminal_info":{"terminal_id":id}},"toolCallId":id,"sessionUpdate":"tool_call","rawInput":{},"status":"pending","title":"Terminal","kind":"execute"}),
            json!({"_meta":{"claudeCode":{"toolName":"Bash"},"terminal_exit":{"terminal_id":id,"exit_code":null,"signal":null}},"toolCallId":id,"sessionUpdate":"tool_call_update","status":"failed"}),
        ],
        1_000,
    );
    assert!(!commands.end_turn("s1", |_| false));
    assert!(commands.list("s1").is_empty());
}

#[test]
fn a_codex_command_left_in_progress_at_turn_end_runs_until_its_completed_status() {
    let id = "exec-7300d7fa-0bbe-4f72-adb9-b5f8a870ad85";
    let mut commands = BackgroundCommands::default();
    assert!(!commands.note(
        "s1",
        &update(codex_command_call(id, "sleep 25; echo probe-done")),
        5_000
    ));

    assert!(commands.end_turn("s1", |_| false));
    let started = running(
        id,
        "sleep 25; echo probe-done",
        "sleep 25; echo probe-done",
        5_000,
    );
    assert_eq!(commands.list("s1"), vec![started.clone()]);

    let exit = codex_command_exit(id);
    assert!(!commands.note("s1", &update(exit[0].clone()), 29_000));
    assert!(commands.note("s1", &update(exit[1].clone()), 30_000));
    assert_eq!(
        commands.list("s1"),
        vec![BackgroundCommand {
            state: CommandState::Ended {
                ended_at_ms: 30_000
            },
            ..started
        }]
    );
}

#[test]
fn a_codex_command_still_running_after_a_cancelled_turn_is_listed_until_it_exits() {
    let id = "exec-20f41eda-4982-4cf1-aa30-98d874e6b5b6";
    let mut commands = BackgroundCommands::default();
    commands.note(
        "s1",
        &update(codex_command_call(id, "sleep 30; echo fg-ok")),
        4_000,
    );
    assert!(commands.end_turn("s1", |_| false));
    assert_eq!(commands.running_count(), 1);

    feed(&mut commands, "s1", &codex_command_exit(id), 34_000);
    assert_eq!(commands.running_count(), 0);
    assert_eq!(
        commands.list("s1")[0].state,
        CommandState::Ended {
            ended_at_ms: 34_000
        }
    );
}

#[test]
fn a_codex_foreground_command_finished_inside_its_turn_is_not_listed() {
    let id = "exec-f0af4dd1-8b1f-4350-a01b-067d02f36087";
    let mut commands = BackgroundCommands::default();
    commands.note("s1", &update(codex_command_call(id, "echo fg-ok")), 1_000);
    commands.note(
        "s1",
        &update(json!({"sessionUpdate":"tool_call_update","toolCallId":id,"status":"completed","_meta":{"terminal_exit":{"exit_code":0,"signal":null,"terminal_id":id}}})),
        1_000,
    );
    assert!(!commands.end_turn("s1", |_| false));
    assert!(commands.list("s1").is_empty());
}

#[test]
fn subagent_child_traffic_is_never_listed() {
    let id = "toolu_012gQDdX4dWchQLzmKK6LRsW";
    let parent = "toolu_01RN1hhaJ9mJibrLfeDa4xFQ";
    let mut commands = BackgroundCommands::default();
    feed(
        &mut commands,
        "s1",
        &[
            json!({"_meta":{"claudeCode":{"toolName":"Bash","parentToolUseId":parent},"terminal_info":{"terminal_id":id}},"toolCallId":id,"sessionUpdate":"tool_call","status":"pending","title":"Terminal","kind":"execute"}),
            json!({"_meta":{"claudeCode":{"toolName":"Bash","parentToolUseId":parent}},"toolCallId":id,"sessionUpdate":"tool_call_update","status":"completed"}),
            json!({"_meta":{"claudeCode":{"toolName":"Bash","parentToolUseId":parent}},"toolCallId":"toolu_child_open","sessionUpdate":"tool_call","status":"in_progress","title":"Terminal"}),
        ],
        1_000,
    );
    assert!(!commands.end_turn("s1", |_| false));
    assert!(commands.list("s1").is_empty());
}

#[test]
fn a_qwen_background_task_completed_chunk_ends_the_command_it_names() {
    let mut commands = BackgroundCommands::default();
    commands.note(
        "s1",
        &update(json!({"sessionUpdate":"tool_call","toolCallId":"call_monitor_1","status":"in_progress","title":"Monitor CI","kind":"execute","rawInput":{"command":"gh pr checks 1723 --watch","description":"Watch PR checks"}})),
        1_000,
    );
    commands.end_turn("s1", |_| false);

    let completed = |tool_use_id: &str| {
        update(
            json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Monitor finished."},"_meta":{"source":"background_task_completed","qwenDiscreteMessage":true,"backgroundTask":{"taskId":"mon_1","status":"completed","kind":"monitor","toolUseId":tool_use_id}}}),
        )
    };
    assert!(!commands.note("s1", &completed("call_other"), 9_000));
    assert!(commands.note("s1", &completed("call_monitor_1"), 9_000));
    assert_eq!(
        commands.list("s1"),
        vec![BackgroundCommand {
            tool_call_id: "call_monitor_1".to_string(),
            title: "Watch PR checks".to_string(),
            command: Some("gh pr checks 1723 --watch".to_string()),
            started_at_ms: 1_000,
            state: CommandState::Ended { ended_at_ms: 9_000 },
        }]
    );
}

#[test]
fn the_next_prompt_turn_drops_ended_commands_and_keeps_running_ones() {
    let mut commands = BackgroundCommands::default();
    feed(&mut commands, "s1", &claude_background_call(), 1_000);
    commands.note(
        "s1",
        &update(codex_command_call("exec-2", "npm run watch")),
        2_000,
    );
    commands.end_turn("s1", |_| false);
    commands.note("s1", &update(claude_background_exit()), 3_000);
    assert_eq!(commands.list("s1").len(), 2);

    assert!(commands.begin_turn("s1"));
    assert_eq!(
        commands.list("s1"),
        vec![running("exec-2", "npm run watch", "npm run watch", 2_000)]
    );
    assert!(!commands.begin_turn("s1"));
}

#[test]
fn closing_a_session_forgets_its_commands() {
    let mut commands = BackgroundCommands::default();
    feed(&mut commands, "s1", &claude_background_call(), 1_000);
    feed(&mut commands, "s2", &claude_background_call(), 1_000);

    assert!(commands.forget("s1"));
    assert!(commands.list("s1").is_empty());
    assert!(!commands.forget("s1"));
    assert_eq!(commands.by_session().keys().collect::<Vec<_>>(), vec!["s2"]);
    assert_eq!(commands.running_count(), 1);
}

#[test]
fn a_command_serializes_with_a_state_tag() {
    let started = running("t1", "Watch", "gh pr checks --watch", 1_000);
    assert_eq!(
        serde_json::to_value(&started).unwrap(),
        json!({"toolCallId":"t1","title":"Watch","command":"gh pr checks --watch","startedAtMs":1000,"state":"running"})
    );
    let ended = BackgroundCommand {
        command: None,
        state: CommandState::Ended { ended_at_ms: 5_000 },
        ..started
    };
    assert_eq!(
        serde_json::to_value(&ended).unwrap(),
        json!({"toolCallId":"t1","title":"Watch","command":null,"startedAtMs":1000,"state":"ended","endedAtMs":5000})
    );
}
