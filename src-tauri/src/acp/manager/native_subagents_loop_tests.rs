//! Native subagent traffic through the production connection: a scripted mock
//! Claude adapter (python3, stdio JSON-RPC) is spawned through
//! `AcpManager::spawn`, so the capability advertisement and the raw handler
//! that runs before the typed `session/update` handler are both exercised.
//! `TERMUL_SKIP_REAL_LOOP_TESTS=1` skips, as in `real_loop_tests.rs`.

use std::time::Duration;

use serde_json::Value;

use super::*;
use crate::web::prompt_turn::{
    accept_prompt_turn, complete_prompt_turn, PromptAdmission, PromptTurnRequest,
};
use crate::web::WsRelaySink;

const MOCK_CLAUDE: &str = r#"
import json, sys

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def update(session_id, body):
    send({"jsonrpc": "2.0", "method": "session/update",
          "params": {"sessionId": session_id, "update": body}})

def text(session_id, value):
    update(session_id, {"sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": value}})

native = False
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    method, rid = msg.get("method"), msg.get("id")
    if method == "initialize":
        native = "subagents" in msg["params"].get("clientCapabilities", {})
        send({"jsonrpc": "2.0", "id": rid, "result": {
            "protocolVersion": 1, "agentCapabilities": {}, "authMethods": []}})
    elif method == "session/new":
        send({"jsonrpc": "2.0", "id": rid, "result": {"sessionId": "mock-1"}})
    elif method == "session/prompt":
        if native:
            update("mock-1", {"sessionUpdate": "subagent_spawned",
                              "subagentSessionId": "child-1", "name": "Explore",
                              "task": "Read the repo", "capabilities": {}})
            update("child-1", {"sessionUpdate": "tool_call", "toolCallId": "toolu_read",
                               "title": "Read src/main.rs", "status": "completed"})
            text("child-1", "child text")
            update("child-1", {"sessionUpdate": "usage_update", "used": 5, "size": 10})
            text("mock-1", "parent text")
            update("mock-1", {"sessionUpdate": "subagent_state_update",
                              "subagentSessionId": "child-1", "state": "completed"})
        else:
            text("mock-1", "legacy")
        send({"jsonrpc": "2.0", "id": rid, "result": {"stopReason": "end_turn"}})
"#;

#[derive(Default)]
struct EventLog(Mutex<Vec<(String, Option<String>, Value)>>);

impl EventSink for EventLog {
    fn emit(&self, event: &crate::web::sink::AcpEvent) {
        self.0.lock().push((
            event.type_.to_string(),
            event.sid.clone(),
            event.payload.clone(),
        ));
    }
}

fn find_python() -> Option<&'static str> {
    ["python3", "python"].into_iter().find(|candidate| {
        std::process::Command::new(candidate)
            .arg("--version")
            .output()
            .is_ok_and(|output| output.status.success())
    })
}

/// Runs one prompt against the mock installed as Claude adapter `version`
/// and returns every session event. `None` when the host opted out.
async fn run_mock_claude(version: &str) -> Option<(String, Vec<(String, Option<String>, Value)>)> {
    let Some(python) = find_python() else {
        if std::env::var("TERMUL_SKIP_REAL_LOOP_TESTS").as_deref() == Ok("1") {
            return None;
        }
        panic!("native subagent loop tests need python3 on PATH");
    };
    let _serial = super::real_loop_tests::TIMEOUT_TEST_LOCK.lock().await;
    let root = tempfile::tempdir().expect("tempdir");
    let package = root
        .path()
        .join("node_modules/@agentclientprotocol/claude-agent-acp");
    std::fs::create_dir_all(package.join("dist")).expect("package dir");
    std::fs::write(
        package.join("package.json"),
        serde_json::json!({ "name": "@agentclientprotocol/claude-agent-acp", "version": version })
            .to_string(),
    )
    .expect("manifest");
    let script = package.join("dist/index.py");
    std::fs::write(&script, MOCK_CLAUDE).expect("script");

    let log = Arc::new(EventLog::default());
    let relay = Arc::new(WsRelaySink::new());
    let acp = Arc::new(AcpManager::new(vec![relay.clone(), log.clone()]));
    let spawned = acp
        .spawn(AgentConfig {
            config_id: None,
            name: "mock-claude".to_string(),
            command: python.to_string(),
            args: vec!["-u".to_string(), script.to_string_lossy().into_owned()],
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
        .filter(|(kind, _, _)| {
            matches!(
                kind.as_str(),
                "acp:tool_call" | "acp:tool_call_update" | "acp:message_chunk" | "acp:usage_update"
            )
        })
        .cloned()
        .collect();
    Some((session.session_id.0, events))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_air_adapter_reports_each_subagent_on_its_chat() {
    let Some((chat, events)) = run_mock_claude("0.78.0").await else {
        return;
    };
    let kinds: Vec<_> = events.iter().map(|(kind, _, _)| kind.as_str()).collect();
    assert_eq!(
        kinds,
        [
            "acp:tool_call",
            "acp:tool_call",
            "acp:message_chunk",
            "acp:message_chunk",
            "acp:tool_call_update",
        ],
        "child usage is dropped; everything else lands in order"
    );
    assert!(events
        .iter()
        .all(|(_, sid, _)| sid.as_deref() == Some(chat.as_str())));

    let dispatch = &events[0].2["toolCall"];
    assert_eq!(dispatch["toolCallId"], "termul-subagent:child-1");
    assert_eq!(dispatch["status"], "in_progress");
    assert_eq!(dispatch["_meta"]["termul/subagent"]["state"], "running");

    let child_call = &events[1].2["toolCall"];
    assert_eq!(child_call["toolCallId"], "toolu_read");
    assert_eq!(
        child_call["_meta"]["claudeCode"]["parentToolUseId"],
        "termul-subagent:child-1"
    );
    assert_eq!(events[2].2["parentToolCallId"], "termul-subagent:child-1");
    assert!(
        events[3].2.get("parentToolCallId").is_none(),
        "the chat's own text passes through unchanged"
    );

    let end = &events[4].2["update"];
    assert_eq!(end["toolCallId"], "termul-subagent:child-1");
    assert_eq!(end["status"], "completed");
    assert_eq!(end["_meta"]["termul/subagent"]["state"], "completed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_rfd_adapter_is_not_offered_native_subagents() {
    let Some((_, events)) = run_mock_claude("0.94.0").await else {
        return;
    };
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].0, "acp:message_chunk");
    assert_eq!(events[0].2["content"]["text"], "legacy");
}
