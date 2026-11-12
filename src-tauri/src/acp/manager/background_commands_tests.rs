//! The driver's side of `session::background_commands`: which updates reach
//! the tracker, the `background_commands` events, and the reaper evidence.
//! Update payloads are the ones claude-agent-acp 0.100.0 and codex-acp 2.5.0
//! sent on 2026-11-05.

use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{json, Value};

use super::driver::handle_session_notification;
use crate::acp::session::DriverState;
use crate::acp::AgentId;
use crate::web::EventSink;

#[derive(Default)]
struct CapturingSink {
    seen: Mutex<Vec<crate::web::sink::AcpEvent>>,
}

impl EventSink for CapturingSink {
    fn emit(&self, event: &crate::web::sink::AcpEvent) {
        self.seen.lock().push(event.clone());
    }
}

/// Each `background_commands` event as `(tool call id, state)` pairs.
fn command_events(sink: &CapturingSink) -> Vec<Vec<(String, String)>> {
    sink.seen
        .lock()
        .iter()
        .filter(|event| event.type_ == crate::acp::events::EVENT_BACKGROUND_COMMANDS)
        .map(|event| {
            event.payload["commands"]
                .as_array()
                .expect("command list")
                .iter()
                .map(|command| {
                    (
                        command["toolCallId"].as_str().unwrap().to_string(),
                        command["state"].as_str().unwrap().to_string(),
                    )
                })
                .collect()
        })
        .collect()
}

fn pair(id: &str, state: &str) -> (String, String) {
    (id.to_string(), state.to_string())
}

struct Driver {
    state: Arc<Mutex<DriverState>>,
    sink: Arc<CapturingSink>,
    sinks: Vec<Arc<dyn EventSink>>,
    agent: AgentId,
}

impl Driver {
    fn new() -> Self {
        let state = Arc::new(Mutex::new(DriverState::new()));
        state
            .lock()
            .set_session_root("sess-1".to_string(), std::path::PathBuf::from("/tmp"));
        let sink = Arc::new(CapturingSink::default());
        Self {
            state,
            sinks: vec![sink.clone()],
            sink,
            agent: AgentId::new(),
        }
    }

    async fn update(&self, update: Value) {
        let notification = serde_json::from_value(json!({"sessionId": "sess-1", "update": update}))
            .expect("a session notification");
        handle_session_notification(&self.state, None, &self.sinks, &self.agent, notification)
            .await
            .expect("update");
    }

    /// What the command loop does when a prompt turn ends with `end_turn`.
    fn end_turn(&self) -> Option<crate::acp::session::BackgroundCommandList> {
        let mut state = self.state.lock();
        state.finish_turn("sess-1");
        state.end_turn_background_commands("sess-1", crate::acp::session::TurnEnd::Stopped)
    }

    fn running(&self) -> usize {
        self.state.lock().activity(0).running_background_commands
    }
}

#[tokio::test]
async fn claude_run_in_background_is_listed_and_keeps_the_agent_until_its_exit() {
    let driver = Driver::new();
    let id = "toolu_01KQuaEEh6oct9vhst8549LZ";
    assert!(driver.state.lock().try_begin_turn("sess-1").is_some());
    driver
        .update(json!({"_meta":{"claudeCode":{"toolName":"Bash"},"terminal_info":{"terminal_id":id}},"toolCallId":id,"sessionUpdate":"tool_call","rawInput":{},"status":"pending","title":"Terminal","kind":"execute"}))
        .await;
    driver
        .update(json!({"_meta":{"claudeCode":{"toolName":"Bash"}},"toolCallId":id,"sessionUpdate":"tool_call_update","rawInput":{"command":"sleep 25; echo probe-done","description":"Sleep then print probe-done","run_in_background":true}}))
        .await;
    driver
        .update(json!({"_meta":{"claudeCode":{"toolName":"Bash"}},"toolCallId":id,"sessionUpdate":"tool_call_update","status":"completed"}))
        .await;
    assert_eq!(
        command_events(&driver.sink),
        vec![vec![pair(id, "running")]]
    );
    assert_eq!(driver.end_turn(), None);
    assert_eq!(driver.running(), 1);
    assert!(
        driver.state.lock().activity(0).has_evidence(),
        "the idle reaper keeps the agent"
    );

    driver
        .update(json!({"_meta":{"terminal_exit":{"terminal_id":id,"exit_code":null,"signal":null}},"toolCallId":id,"sessionUpdate":"tool_call_update"}))
        .await;
    assert_eq!(
        command_events(&driver.sink),
        vec![vec![pair(id, "running")], vec![pair(id, "ended")]]
    );
    assert_eq!(driver.running(), 0);
    assert!(!driver.state.lock().activity(0).has_evidence());
}

#[tokio::test]
async fn a_codex_command_open_at_turn_end_is_listed_by_the_turn_end() {
    let driver = Driver::new();
    let id = "exec-7300d7fa-0bbe-4f72-adb9-b5f8a870ad85";
    assert!(driver.state.lock().try_begin_turn("sess-1").is_some());
    driver
        .update(json!({"sessionUpdate":"tool_call","toolCallId":id,"kind":"execute","title":"sleep 25; echo probe-done","status":"in_progress","rawInput":{"command":"sleep 25; echo probe-done","cwd":"/tmp"},"_meta":{"terminal_info":{"cwd":"/tmp","terminal_id":id}}}))
        .await;
    assert!(command_events(&driver.sink).is_empty());

    let listed = driver
        .end_turn()
        .expect("the turn end lists the command")
        .commands;
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].tool_call_id, id);
    assert_eq!(
        listed[0].command.as_deref(),
        Some("sleep 25; echo probe-done")
    );
    assert_eq!(driver.running(), 1);

    driver
        .update(json!({"sessionUpdate":"tool_call_update","toolCallId":id,"status":"completed","_meta":{"terminal_exit":{"exit_code":0,"signal":null,"terminal_id":id}}}))
        .await;
    assert_eq!(command_events(&driver.sink), vec![vec![pair(id, "ended")]]);
    assert_eq!(driver.running(), 0);
}

#[tokio::test]
async fn a_subagent_dispatch_open_at_turn_end_is_not_a_command() {
    let driver = Driver::new();
    let dispatch = json!({"_meta":{"claudeCode":{"toolName":"Agent"}},"toolCallId":"toolu_01RN1hhaJ9mJibrLfeDa4xFQ","sessionUpdate":"tool_call","rawInput":{"description":"Run echo","prompt":"echo sub-ok","subagent_type":"general-purpose","run_in_background":true},"status":"pending","title":"Agent","kind":"think"});
    assert!(driver.state.lock().try_begin_turn("sess-1").is_some());
    // The registry may learn of a dispatch after its first update reached
    // the tracker.
    driver.update(dispatch.clone()).await;
    let mapped = crate::acp::subagents::map_tool_event(
        driver.state.lock().subagent_records(),
        "sess-1",
        "tool_call",
        dispatch.as_object().unwrap(),
        1_000,
    );
    assert!(!mapped.is_empty(), "the registry records the dispatch");

    assert_eq!(driver.end_turn(), None);
    assert!(command_events(&driver.sink).is_empty());
    assert_eq!(driver.running(), 0);
}

#[tokio::test]
async fn deleting_or_closing_a_session_forgets_its_commands() {
    let driver = Driver::new();
    assert!(driver.state.lock().try_begin_turn("sess-1").is_some());
    driver
        .update(json!({"sessionUpdate":"tool_call","toolCallId":"exec-1","kind":"execute","title":"npm run watch","status":"in_progress","_meta":{"terminal_info":{"terminal_id":"exec-1"}}}))
        .await;
    assert!(driver.end_turn().is_some());
    assert_eq!(driver.running(), 1);

    driver.state.lock().begin_close_session("sess-1");
    assert_eq!(driver.running(), 0);
    assert!(driver
        .state
        .lock()
        .background_commands()
        .snapshot()
        .sessions
        .is_empty());
}

#[tokio::test]
async fn disposing_an_ephemeral_session_returns_its_emptied_list() {
    let driver = Driver::new();
    driver.state.lock().mark_ephemeral("sess-1".to_string());
    assert!(driver.state.lock().try_begin_turn("sess-1").is_some());
    driver
        .update(json!({"sessionUpdate":"tool_call","toolCallId":"exec-1","kind":"execute","title":"npm run watch","status":"in_progress","_meta":{"terminal_info":{"terminal_id":"exec-1"}}}))
        .await;
    let listed = driver.end_turn().expect("the turn end lists the command");

    let cleared = driver
        .state
        .lock()
        .dispose_session("sess-1")
        .cleared_commands
        .expect("the dispose clears the list");
    assert!(cleared.commands.is_empty());
    assert!(cleared.revision > listed.revision);
    assert_eq!(driver.running(), 0);
}
