//! One-shot sessions against a scripted mock ACP agent (python3, stdio
//! JSON-RPC) spawned through the real manager, driver and command loop.
//! Same interpreter rule as `manager/real_loop_tests.rs`: a missing python
//! fails loudly unless `TERMUL_SKIP_REAL_LOOP_TESTS=1`.

use super::*;
use crate::acp::manager::real_loop_tests::{find_python, SKIP_ENV, TIMEOUT_TEST_LOCK};
use std::path::PathBuf;

const MOCK_AGENT: &str = r#"
import json, os, sys

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def update(update):
    send({"jsonrpc": "2.0", "method": "session/update",
          "params": {"sessionId": "s1", "update": update}})

def chunk(text, message_id=None, meta=None):
    body = {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}
    if message_id:
        body["messageId"] = message_id
    if meta:
        body["_meta"] = meta
    update(body)

def model_option():
    return {"id": "model", "name": "Model", "category": "model", "type": "select",
            "currentValue": model,
            "options": [{"value": "fast", "name": "Fast"}, {"value": "smart", "name": "Smart"}]}

with open(os.environ["MOCK_PID_FILE"], "w") as f:
    f.write(str(os.getpid()))

model, prompts, cancels, hung = "fast", 0, 0, None
for line in sys.stdin:
    msg = json.loads(line)
    method, rid = msg.get("method"), msg.get("id")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": rid, "result": {
            "protocolVersion": 1, "agentCapabilities": {}, "authMethods": []}})
    elif method == "session/new":
        if os.environ.get("MOCK_MCP_FILE"):
            with open(os.environ["MOCK_MCP_FILE"], "w") as f:
                f.write(json.dumps([s.get("name") for s in msg["params"].get("mcpServers", [])]))
        if os.environ.get("MOCK_NEW_SESSION") == "auth":
            send({"jsonrpc": "2.0", "id": rid,
                  "error": {"code": -32000, "message": "Authentication required"}})
        else:
            send({"jsonrpc": "2.0", "id": rid,
                  "result": {"sessionId": "s1", "configOptions": [model_option()]}})
    elif method == "session/set_config_option":
        model = msg["params"]["value"]
        send({"jsonrpc": "2.0", "id": rid, "result": {"configOptions": [model_option()]}})
    elif method == "session/prompt":
        prompts += 1
        text = msg["params"]["prompt"][0]["text"]
        done = {"jsonrpc": "2.0", "id": rid, "result": {"stopReason": "end_turn"}}
        if text == "tool":
            chunk("Let me check the file.")
            update({"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "read"})
            chunk('{"ok":')
            chunk(' true}')
            send(done)
        elif text == "messages":
            chunk("draft", "m1")
            chunk("final ", "m2")
            chunk("answer", "m2")
            send(done)
        elif text == "subagent":
            chunk("main")
            chunk("inner", meta={"claudeCode": {"parentToolUseId": "t9"}})
            send(done)
        elif text == "state":
            chunk(f"model={model} prompts={prompts} cancels={cancels}")
            send(done)
        elif text == "hang":
            hung = rid
        elif text == "selfcancel":
            send({"jsonrpc": "2.0", "id": rid, "result": {"stopReason": "cancelled"}})
        elif text == "needauth":
            send({"jsonrpc": "2.0", "id": rid,
                  "error": {"code": -32000, "message": "Authentication required"}})
        elif text == "fail":
            send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32603, "message": "boom"}})
        elif text == "flood":
            for _ in range(17):
                chunk("x" * 65536)
            send(done)
    elif method == "session/cancel":
        cancels += 1
        if hung is not None:
            send({"jsonrpc": "2.0", "id": hung, "result": {"stopReason": "cancelled"}})
            hung = None
"#;

const TURN: Duration = Duration::from_secs(30);

struct Mock {
    manager: Arc<AcpManager>,
    dir: PathBuf,
    python: &'static str,
    // Real-loop tests set a process-wide 1 s idle timeout; never overlap them.
    _serial: tokio::sync::MutexGuard<'static, ()>,
}

impl Mock {
    async fn new() -> Option<Self> {
        let Some(python) = find_python() else {
            if std::env::var(SKIP_ENV).as_deref() == Ok("1") {
                eprintln!("SKIP oneshot tests: no python interpreter ({SKIP_ENV}=1)");
                return None;
            }
            panic!("oneshot tests need `python3` on PATH, or {SKIP_ENV}=1 to skip");
        };
        let serial = TIMEOUT_TEST_LOCK.lock().await;
        let dir = std::env::temp_dir().join(format!("termul-oneshot-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("mock_agent.py"), MOCK_AGENT).unwrap();
        Some(Self {
            manager: Arc::new(AcpManager::new(vec![])),
            dir,
            python,
            _serial: serial,
        })
    }

    fn request(&self, model: Option<&str>, env: &[(&str, &str)]) -> OneShotRequest {
        let mut vars: std::collections::HashMap<String, String> = env
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        vars.insert(
            "MOCK_PID_FILE".to_string(),
            self.pid_file().to_string_lossy().into_owned(),
        );
        OneShotRequest {
            config: AgentConfig {
                config_id: None,
                name: "mock-agent".to_string(),
                command: self.python.to_string(),
                args: vec![
                    "-u".to_string(),
                    self.dir
                        .join("mock_agent.py")
                        .to_string_lossy()
                        .into_owned(),
                ],
                env: vars,
                allow_terminal: false,
            },
            cwd: self.dir.to_string_lossy().into_owned(),
            model: model.map(str::to_string),
            project_id: None,
        }
    }

    async fn start(&self, model: Option<&str>) -> OneShotSession {
        OneShotSession::start(&self.manager, self.request(model, &[]))
            .await
            .expect("one-shot session starts")
    }

    fn pid_file(&self) -> PathBuf {
        self.dir.join("pid")
    }

    fn agent_pid(&self) -> u32 {
        std::fs::read_to_string(self.pid_file())
            .expect("mock agent wrote its pid")
            .parse()
            .unwrap()
    }
}

impl Drop for Mock {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn reply(session: &mut OneShotSession, text: &str) -> String {
    session
        .prompt(text, TURN)
        .await
        .expect("turn completes")
        .text
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn returns_the_last_agent_message_and_reprompts_the_same_session() {
    let Some(mock) = Mock::new().await else {
        return;
    };
    let mut session = mock.start(None).await;

    let first = session.prompt("tool", TURN).await.unwrap();
    assert_eq!(
        first,
        OneShotReply {
            text: r#"{"ok": true}"#.to_string(),
            stop_reason: StopReason::EndTurn,
        }
    );
    assert_eq!(reply(&mut session, "messages").await, "final answer");
    assert_eq!(reply(&mut session, "subagent").await, "main");
    assert_eq!(
        reply(&mut session, "state").await,
        "model=fast prompts=4 cancels=0"
    );
    session.dispose().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn selects_the_requested_model_through_the_config_option() {
    let Some(mock) = Mock::new().await else {
        return;
    };
    let mut session = mock.start(Some("smart")).await;
    assert_eq!(
        reply(&mut session, "state").await,
        "model=smart prompts=1 cancels=0"
    );
    session.dispose().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unoffered_model_fails_the_start_and_stops_the_agent() {
    let Some(mock) = Mock::new().await else {
        return;
    };
    let error = OneShotSession::start(&mock.manager, mock.request(Some("huge"), &[]))
        .await
        .err()
        .expect("start fails");
    assert_eq!(
        error,
        OneShotError::ModelUnavailable("the agent does not offer `huge`".to_string())
    );
    assert!(process_exits(mock.agent_pid()));
    assert_eq!(mock.manager.list_agents(), vec![]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_timed_out_turn_is_cancelled_and_the_session_stays_usable() {
    let Some(mock) = Mock::new().await else {
        return;
    };
    let mut session = mock.start(None).await;
    let budget = Duration::from_millis(300);

    let error = session.prompt("hang", budget).await.unwrap_err();

    assert_eq!(error, OneShotError::Timeout(budget));
    assert_eq!(
        reply(&mut session, "state").await,
        "model=fast prompts=2 cancels=1"
    );
    session.dispose().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn turn_failures_are_typed() {
    let Some(mock) = Mock::new().await else {
        return;
    };
    let mut session = mock.start(None).await;

    assert_eq!(
        session.prompt("selfcancel", TURN).await,
        Err(OneShotError::Cancelled)
    );
    assert!(matches!(
        session.prompt("needauth", TURN).await,
        Err(OneShotError::AuthRequired(_))
    ));
    assert_eq!(
        session.prompt("fail", TURN).await,
        Err(OneShotError::Agent("boom".to_string()))
    );
    assert_eq!(
        reply(&mut session, "state").await,
        "model=fast prompts=4 cancels=0"
    );
    session.dispose().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_new_auth_failure_is_auth_required_and_stops_the_agent() {
    let Some(mock) = Mock::new().await else {
        return;
    };
    let error = OneShotSession::start(
        &mock.manager,
        mock.request(None, &[("MOCK_NEW_SESSION", "auth")]),
    )
    .await
    .err()
    .expect("start fails");
    assert!(
        matches!(&error, OneShotError::AuthRequired(detail) if detail.starts_with("ACP_AUTH_REQUIRED: ")),
        "{error:?}"
    );
    assert!(process_exits(mock.agent_pid()));
}

/// C10: an automation run's session gets no host MCP server, so its agent
/// cannot author automations. A chat session on the same agent does.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_one_shot_session_gets_no_termul_mcp_server_but_a_chat_session_does() {
    let Some(mock) = Mock::new().await else {
        return;
    };
    let mcp_file = mock.dir.join("mcp-servers");
    let env = [("MOCK_MCP_FILE", mcp_file.to_str().unwrap())];
    let one_shot = OneShotSession::start(&mock.manager, mock.request(None, &env))
        .await
        .expect("one-shot session starts");
    assert_eq!(std::fs::read_to_string(&mcp_file).unwrap(), "[]");
    one_shot.dispose().await;

    let OneShotRequest { config, cwd, .. } = mock.request(None, &env);
    let spawned = mock
        .manager
        .spawn_private(config, None, vec![])
        .await
        .expect("agent spawns");
    mock.manager
        .new_session_with_context(
            &spawned.agent_id,
            cwd,
            vec![],
            SessionCreationContext::default(),
        )
        .await
        .expect("chat session starts");
    assert_eq!(std::fs::read_to_string(&mcp_file).unwrap(), r#"["termul"]"#);
    mock.manager.kill_detached(&spawned.agent_id);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_missing_agent_binary_is_a_spawn_failure() {
    let Some(mock) = Mock::new().await else {
        return;
    };
    let mut request = mock.request(None, &[]);
    request.config.command = mock
        .dir
        .join("no-such-agent")
        .to_string_lossy()
        .into_owned();
    let error = OneShotSession::start(&mock.manager, request)
        .await
        .err()
        .expect("start fails");
    assert!(
        matches!(&error, OneShotError::Spawn(detail) if detail.starts_with("ACP_AGENT_UNAVAILABLE: ")),
        "{error:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dispose_kills_the_agent_process() {
    let Some(mock) = Mock::new().await else {
        return;
    };
    let session = mock.start(None).await;
    let pid = mock.agent_pid();
    assert!(is_running(pid));

    session.dispose().await;

    assert!(process_exits(pid));
    assert_eq!(mock.manager.list_agents(), vec![]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_a_session_mid_turn_kills_the_agent_process() {
    let Some(mock) = Mock::new().await else {
        return;
    };
    let mut session = mock.start(None).await;
    let pid = mock.agent_pid();
    let agent_id = session.agent_id().clone();
    let abandoned = tokio::time::timeout(Duration::from_millis(200), session.prompt("hang", TURN));
    assert!(abandoned.await.is_err(), "the hung turn is still running");

    drop(session);

    assert!(process_exits(pid));
    assert!(!mock.manager.list_agents().contains(&agent_id));
}

fn process_exits(pid: u32) -> bool {
    let deadline = Instant::now() + Duration::from_secs(10);
    while is_running(pid) {
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    true
}

/// A reaped-later zombie counts as exited.
#[cfg(unix)]
fn is_running(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the pid exists.
    let exists = unsafe { libc::kill(pid as libc::pid_t, 0) } == 0;
    exists && !process_state(pid).starts_with('Z')
}

#[cfg(unix)]
fn process_state(pid: u32) -> String {
    std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .unwrap_or_default()
}

#[cfg(windows)]
fn is_running(pid: u32) -> bool {
    crate::process_util::test_support::is_alive(pid)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reply_over_the_cap_fails_and_the_session_stays_usable() {
    let Some(mock) = Mock::new().await else {
        return;
    };
    let mut session = mock.start(None).await;

    assert_eq!(
        session.prompt("flood", TURN).await,
        Err(OneShotError::Agent("reply exceeded 1048576 bytes".to_string()))
    );
    assert_eq!(
        reply(&mut session, "state").await,
        "model=fast prompts=2 cancels=0"
    );
    session.dispose().await;
}
