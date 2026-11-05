use std::collections::HashMap;

use super::*;
use crate::acp::config::AgentConfig;
use crate::acp::manager::real_loop_tests::{find_python, SKIP_ENV, TIMEOUT_TEST_LOCK};
use crate::web::WsRelaySink;

/// An agent that holds past sessions, like the Claude adapter does for the
/// chats of the Claude Code CLI. `cc-ok` replays a two-turn chat with a tool
/// call, `cc-empty` replays nothing and `cc-fail` fails the load.
const MOCK_AGENT: &str = r#"
import json, sys

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def update(sid, body):
    send({"jsonrpc": "2.0", "method": "session/update",
          "params": {"sessionId": sid, "update": body}})

def chunk(sid, kind, text):
    update(sid, {"sessionUpdate": kind, "content": {"type": "text", "text": text}})

reopened = []
for line in sys.stdin:
    msg = json.loads(line)
    method, rid = msg.get("method"), msg.get("id")
    params = msg.get("params", {})
    sid = params.get("sessionId")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": rid, "result": {
            "protocolVersion": 1,
            "agentCapabilities": {"loadSession": True,
                                  "sessionCapabilities": {"close": {}, "resume": {}, "list": {}}},
            "authMethods": []}})
    elif method == "session/load":
        if sid == "cc-fail":
            send({"jsonrpc": "2.0", "id": rid,
                  "error": {"code": -32603, "message": "cannot read the transcript"}})
            continue
        if sid == "cc-ok":
            chunk(sid, "user_message_chunk", "fix the build")
            chunk(sid, "agent_thought_chunk", "thinking")
            chunk(sid, "agent_message_chunk", "looking at it")
            update(sid, {"sessionUpdate": "tool_call", "toolCallId": "t1",
                         "title": "Edit build.rs", "kind": "edit", "status": "pending",
                         "locations": [{"path": "/tmp/build.rs"}]})
            update(sid, {"sessionUpdate": "tool_call_update", "toolCallId": "t1",
                         "status": "completed"})
            chunk(sid, "agent_message_chunk", "fixed")
            chunk(sid, "user_message_chunk", "thanks")
            chunk(sid, "agent_message_chunk", "welcome")
        reopened.append(sid)
        send({"jsonrpc": "2.0", "id": rid, "result": {}})
    elif method == "session/resume":
        send({"jsonrpc": "2.0", "id": rid, "result": {}})
    elif method == "session/close":
        send({"jsonrpc": "2.0", "id": rid, "result": {}})
"#;

struct Harness {
    acp: Arc<AcpManager>,
    persistence: Arc<SessionPersistence>,
    agent_id: AgentId,
    dir: PathBuf,
    _serial: tokio::sync::MutexGuard<'static, ()>,
}

impl Harness {
    async fn start() -> Option<Self> {
        let Some(python) = find_python() else {
            if std::env::var(SKIP_ENV).as_deref() == Ok("1") {
                eprintln!("SKIP agent_session_import_tests: no python interpreter ({SKIP_ENV}=1)");
                return None;
            }
            panic!("agent_session_import_tests need `python3`; set {SKIP_ENV}=1 to skip them");
        };
        let serial = TIMEOUT_TEST_LOCK.lock().await;
        let dir = std::env::temp_dir().join(format!("termul-import-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("mock_agent.py");
        std::fs::write(&script, MOCK_AGENT).unwrap();
        let persistence = SessionPersistence::open(dir.join("sessions"))
            .await
            .expect("open session persistence");
        let relay = Arc::new(WsRelaySink::with_persistence(64, persistence.clone()));
        let acp = Arc::new(AcpManager::with_persistence(
            vec![relay.clone()],
            persistence.clone(),
        ));
        let spawned = acp
            .spawn(AgentConfig {
                config_id: Some("mock".to_string()),
                name: "mock-agent".to_string(),
                command: python.to_string(),
                args: vec!["-u".to_string(), script.to_string_lossy().to_string()],
                env: HashMap::new(),
                allow_terminal: false,
            })
            .await
            .expect("mock agent initializes");
        Some(Self {
            acp,
            persistence,
            agent_id: spawned.agent_id,
            dir,
            _serial: serial,
        })
    }

    fn request(&self, session_id: &str) -> ImportAgentSessionRequest {
        ImportAgentSessionRequest {
            agent_id: self.agent_id.clone(),
            session_id: session_id.to_string(),
            cwd: self.dir.to_string_lossy().to_string(),
            title: Some("Build fix".to_string()),
            updated_at: Some(1_700_000_000_000),
            project_id: Some("project-1".to_string()),
        }
    }

    async fn import(&self, session_id: &str) -> Result<SessionMetadata, ImportAgentSessionError> {
        import_agent_session(&self.acp, &self.persistence, self.request(session_id)).await
    }

    async fn finish(self) {
        let _ = self.acp.kill(&self.agent_id).await;
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_imported_session_keeps_the_history_the_agent_replays() {
    let Some(h) = Harness::start().await else {
        return;
    };
    let metadata = h.import("cc-ok").await.expect("import");

    assert_eq!(metadata.status, PersistedSessionStatus::Closed);
    assert!(
        !metadata.discovered,
        "an imported session is the chat's own"
    );
    assert_eq!(metadata.title.as_deref(), Some("Build fix"));
    assert_eq!(metadata.project_id.as_deref(), Some("project-1"));
    assert_eq!(
        metadata.stable_agent_namespace.as_deref(),
        Some("config:mock")
    );

    let payload = h.persistence.session_payload_async("cc-ok").await.unwrap();
    let payload = serde_json::to_value(&payload).unwrap();
    let messages = payload["messages"].as_array().unwrap();
    let roles: Vec<(&str, String)> = messages
        .iter()
        .map(|message| {
            let text = message["blocks"][0]["text"]
                .as_str()
                .unwrap_or("")
                .to_string();
            (message["role"].as_str().unwrap(), text)
        })
        .collect();
    assert_eq!(
        roles,
        vec![
            ("user", "fix the build".to_string()),
            ("thought", "thinking".to_string()),
            ("agent", "looking at it".to_string()),
            ("agent", "fixed".to_string()),
            ("user", "thanks".to_string()),
            ("agent", "welcome".to_string()),
        ],
        "{payload}"
    );
    let tool_calls = payload["toolCalls"].as_array().expect("tool calls");
    assert_eq!(tool_calls.len(), 1, "{payload}");
    assert_eq!(tool_calls[0]["kind"], "edit");
    assert_eq!(tool_calls[0]["status"], "completed");
    assert_eq!(
        metadata.last_activity_at, 1_700_000_000_000,
        "the chat keeps the time the original ran"
    );
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_chat_lists_an_imported_session_and_resumes_it_on_the_agent() {
    let Some(h) = Harness::start().await else {
        return;
    };
    h.import("cc-ok").await.expect("import");

    let listed = h.persistence.list_sessions();
    assert_eq!(listed.len(), 1);
    assert!(!listed[0].discovered);

    h.acp
        .resume_session(
            &h.agent_id,
            SessionId("cc-ok".to_string()),
            h.dir.to_string_lossy().to_string(),
            Vec::new(),
            Some(Vec::new()),
        )
        .await
        .expect("an imported session resumes on the agent that loaded it");
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn importing_a_session_twice_is_refused_and_keeps_the_first_copy() {
    let Some(h) = Harness::start().await else {
        return;
    };
    h.import("cc-ok").await.expect("first import");
    let again = h.import("cc-ok").await;

    assert!(
        matches!(again, Err(ImportAgentSessionError::AlreadyKnown)),
        "{again:?}"
    );
    assert_eq!(h.persistence.metadata("cc-ok").unwrap().message_count, 6);
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_agent_that_replays_nothing_leaves_no_session_behind() {
    let Some(h) = Harness::start().await else {
        return;
    };
    let result = h.import("cc-empty").await;

    assert!(
        matches!(result, Err(ImportAgentSessionError::Empty)),
        "{result:?}"
    );
    assert!(h.persistence.metadata("cc-empty").is_err());
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_load_leaves_no_session_behind() {
    let Some(h) = Harness::start().await else {
        return;
    };
    let result = h.import("cc-fail").await;

    match result {
        Err(ImportAgentSessionError::Agent(message)) => {
            assert!(message.contains("cannot read the transcript"), "{message}");
        }
        other => panic!("expected an agent error, got {other:?}"),
    }
    assert!(h.persistence.metadata("cc-fail").is_err());
    assert!(h.persistence.list_sessions().is_empty());
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_request_without_a_session_id_or_cwd_is_invalid() {
    let Some(h) = Harness::start().await else {
        return;
    };
    let mut request = h.request("cc-ok");
    request.session_id = "  ".to_string();
    let result = import_agent_session(&h.acp, &h.persistence, request).await;

    assert!(
        matches!(result, Err(ImportAgentSessionError::Invalid(_))),
        "{result:?}"
    );
    h.finish().await;
}
