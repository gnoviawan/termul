//! Cursor and Gemini CLI subagents through the production connection: a
//! scripted mock agent (python3, stdio JSON-RPC) is spawned through
//! `AcpManager::spawn`, so the `initialize` `agentInfo` read and the
//! `cursor/task` request handler are both exercised.
//! `TERMUL_SKIP_REAL_LOOP_TESTS=1` skips, as in `real_loop_tests.rs`.

use std::time::Duration;

use serde_json::Value;

use super::*;
use crate::web::prompt_turn::{
    accept_prompt_turn, complete_prompt_turn, PromptAdmission, PromptTurnRequest,
};
use crate::web::WsRelaySink;

const MOCK_AGENT: &str = r#"
import json, sys

mode = sys.argv[1]

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def update(body):
    send({"jsonrpc": "2.0", "method": "session/update",
          "params": {"sessionId": "mock-1", "update": body}})

prompt_id = None
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    method, rid = msg.get("method"), msg.get("id")
    if method == "initialize":
        result = {"protocolVersion": 1, "agentCapabilities": {}, "authMethods": []}
        if mode == "gemini":
            result["agentInfo"] = {"name": "gemini-cli", "title": "Gemini CLI", "version": "0.62.0"}
        send({"jsonrpc": "2.0", "id": rid, "result": result})
    elif method == "session/new":
        send({"jsonrpc": "2.0", "id": rid, "result": {"sessionId": "mock-1"}})
    elif method == "session/prompt" and mode == "cursor":
        prompt_id = rid
        update({"sessionUpdate": "tool_call", "toolCallId": "tool_1",
                "title": "Task: Explore auth flow", "kind": "other",
                "rawInput": {"_toolName": "task", "prompt": "Find the refresh",
                             "description": "Explore auth flow", "subagentType": "explore"}})
        update({"sessionUpdate": "tool_call_update", "toolCallId": "tool_1",
                "status": "completed", "rawOutput": {"durationMs": 4200, "isBackground": False}})
        send({"jsonrpc": "2.0", "id": "cursor-task-1", "method": "cursor/task",
              "params": {"toolCallId": "tool_1", "description": "Explore auth flow",
                         "prompt": "Find the refresh", "subagentType": "explore",
                         "model": "gpt-5.1-codex", "agentId": "agent-1", "durationMs": 4200}})
    elif method == "session/prompt":
        title = "Delegating to agent 'codebase_investigator'"
        update({"sessionUpdate": "tool_call", "toolCallId": "invoke_agent-1-1",
                "status": "in_progress", "title": title, "content": [], "kind": "think"})
        update({"sessionUpdate": "tool_call_update", "toolCallId": "invoke_agent-1-1",
                "status": "completed", "title": title, "kind": "think",
                "content": [{"type": "content", "content": {"type": "text", "text": "Report"}}]})
        send({"jsonrpc": "2.0", "id": rid, "result": {"stopReason": "end_turn"}})
    elif method is None and rid == "cursor-task-1":
        reply = "acked" if msg.get("result") == {} else "rejected"
        update({"sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": reply}})
        send({"jsonrpc": "2.0", "id": prompt_id, "result": {"stopReason": "end_turn"}})
"#;

#[derive(Default)]
struct EventLog(Mutex<Vec<(String, Value)>>);

impl EventSink for EventLog {
    fn emit(&self, event: &crate::web::sink::AcpEvent) {
        self.0
            .lock()
            .push((event.type_.to_string(), event.payload.clone()));
    }
}

/// Runs one prompt against the mock in `mode` and returns the chat's tool
/// call and message events. `None` when the host opted out.
async fn run_mock(mode: &str) -> Option<Vec<(String, Value)>> {
    let python = ["python3", "python"].into_iter().find(|candidate| {
        std::process::Command::new(candidate)
            .arg("--version")
            .output()
            .is_ok_and(|output| output.status.success())
    });
    let Some(python) = python else {
        if std::env::var("TERMUL_SKIP_REAL_LOOP_TESTS").as_deref() == Ok("1") {
            return None;
        }
        panic!("agent tool loop tests need python3 on PATH");
    };
    let _serial = super::real_loop_tests::TIMEOUT_TEST_LOCK.lock().await;
    let root = tempfile::tempdir().expect("tempdir");
    let script = root.path().join("mock_agent.py");
    std::fs::write(&script, MOCK_AGENT).expect("script");

    let log = Arc::new(EventLog::default());
    let relay = Arc::new(WsRelaySink::new());
    let acp = Arc::new(AcpManager::new(vec![relay.clone(), log.clone()]));
    let spawned = acp
        .spawn(AgentConfig {
            config_id: None,
            name: format!("mock-{mode}"),
            command: python.to_string(),
            args: vec![
                "-u".to_string(),
                script.to_string_lossy().into_owned(),
                mode.to_string(),
            ],
            env: HashMap::new(),
            allow_terminal: false,
        })
        .await
        .expect("mock agent initializes");
    let session = acp
        .new_session(
            &spawned.agent_id,
            root.path().to_string_lossy().into_owned(),
            vec![],
        )
        .await
        .expect("mock session");
    relay.seed_session_for_test(&session.session_id.0);
    let blocks = vec![ContentBlock::Text(
        agent_client_protocol::schema::v1::TextContent::new("go"),
    )];
    let request = PromptTurnRequest {
        agent_id: spawned.agent_id.clone(),
        session_id: session.session_id.clone(),
        content: blocks.clone(),
        record_content: blocks,
        turn_id: Some("t1".to_string()),
    };
    let turn = async {
        match accept_prompt_turn(&acp, &relay, request).await {
            Ok(PromptAdmission::Running(running)) => complete_prompt_turn(&acp, running).await,
            Ok(PromptAdmission::Receipt(_)) => Err("unexpected receipt".to_string()),
            Err(error) => Err(error.into_message()),
        }
    };
    let stop = tokio::time::timeout(Duration::from_secs(60), turn)
        .await
        .expect("turn finishes")
        .expect("turn succeeds");
    assert_eq!(stop, StopReason::EndTurn);
    let _ = acp.kill(&spawned.agent_id).await;
    let events = log
        .0
        .lock()
        .iter()
        .filter(|(kind, _)| {
            matches!(
                kind.as_str(),
                "acp:tool_call" | "acp:tool_call_update" | "acp:message_chunk"
            )
        })
        .cloned()
        .collect();
    Some(events)
}

fn subagent(event: &(String, Value)) -> &Value {
    let (kind, payload) = event;
    let call = if kind == "acp:tool_call" {
        &payload["toolCall"]
    } else {
        &payload["update"]
    };
    &call["_meta"]["termul/subagent"]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cursor_task_gets_its_model_from_cursor_task_and_the_request_is_answered() {
    let Some(events) = run_mock("cursor").await else {
        return;
    };
    let kinds: Vec<_> = events.iter().map(|(kind, _)| kind.as_str()).collect();
    assert_eq!(
        kinds,
        [
            "acp:tool_call",
            "acp:tool_call_update",
            "acp:tool_call_update",
            "acp:message_chunk",
        ]
    );
    assert_eq!(subagent(&events[0])["source"], "cursor-task");
    assert_eq!(subagent(&events[1])["activity"], "idle");
    assert_eq!(subagent(&events[1]).get("model"), None);
    let filled = subagent(&events[2]);
    assert_eq!(events[2].1["update"]["toolCallId"], "tool_1");
    assert_eq!(filled["model"], "gpt-5.1-codex");
    assert_eq!(filled["usage"]["durationMs"], 4200);
    assert_eq!(
        events[3].1["content"]["text"], "acked",
        "cursor/task is answered with {{}}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_gemini_cli_agent_call_is_a_subagent_on_a_gemini_connection() {
    let Some(events) = run_mock("gemini").await else {
        return;
    };
    let kinds: Vec<_> = events.iter().map(|(kind, _)| kind.as_str()).collect();
    assert_eq!(kinds, ["acp:tool_call", "acp:tool_call_update"]);
    let start = subagent(&events[0]);
    assert_eq!(start["source"], "gemini-agent");
    assert_eq!(start["title"], "codebase_investigator");
    let end = subagent(&events[1]);
    assert_eq!(end["end"]["reason"], "completed");
}
