#![allow(clippy::unwrap_used, clippy::expect_used)]
//! `authenticate_agent` with a typed API key, through the real `/ws` handler,
//! the real command loop and a scripted agent process that advertises the
//! API-key methods of codex-acp and Gemini CLI and records what it receives.
//! Assertion messages never print a recorded request: it carries the key.

use super::*;
use crate::acp::manager::real_loop_tests::{find_python, SKIP_ENV};
use crate::web::log_capture::{capture_tracing, logged_lines};

const KEY: &str = "sk-termul-test-not-real";

const MOCK_AGENT: &str = r#"
import json, os, sys

record = os.environ["MOCK_AUTH_RECORD"]

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    method, rid = msg.get("method"), msg.get("id")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": rid, "result": {
            "protocolVersion": 1,
            "agentCapabilities": {},
            "authMethods": [
                {"id": "api-key", "name": "API Key",
                 "_meta": {"api-key": {"provider": "openai"}}},
                {"id": "gemini-api-key", "name": "Gemini API key",
                 "_meta": {"api-key": {"provider": "google"}}},
                {"id": "byok", "name": "Bring your own key",
                 "_meta": {"api-key": {"provider": "somebody-new"}}},
                {"id": "chat-gpt", "name": "ChatGPT"}]}})
    elif method == "authenticate":
        with open(record, "a") as out:
            out.write(json.dumps(msg["params"]) + "\n")
        send({"jsonrpc": "2.0", "id": rid, "result": {}})
"#;

struct MockAgent {
    acp: Arc<AcpManager>,
    agent_id: String,
    auth_methods: Value,
    record: std::path::PathBuf,
    dir: std::path::PathBuf,
}

impl Drop for MockAgent {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn spawn_mock() -> Option<MockAgent> {
    let Some(python) = find_python() else {
        if std::env::var(SKIP_ENV).as_deref() == Ok("1") {
            return None;
        }
        panic!("these tests need python3 on PATH, or {SKIP_ENV}=1 to skip them");
    };
    let dir = std::env::temp_dir().join(format!("termul-api-key-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("mock_agent.py");
    std::fs::write(&script, MOCK_AGENT).unwrap();
    let record = dir.join("authenticate.jsonl");
    let acp = Arc::new(AcpManager::new(Vec::new()));
    let spawned = acp
        .spawn(AgentConfig {
            config_id: None,
            name: "mock-agent".to_string(),
            command: python.to_string(),
            args: vec!["-u".to_string(), script.to_string_lossy().to_string()],
            env: std::collections::HashMap::from([(
                "MOCK_AUTH_RECORD".to_string(),
                record.to_string_lossy().to_string(),
            )]),
            allow_terminal: false,
        })
        .await
        .expect("mock agent initializes");
    Some(MockAgent {
        acp,
        agent_id: spawned.agent_id.0.clone(),
        auth_methods: serde_json::to_value(&spawned.auth_methods).unwrap(),
        record,
        dir,
    })
}

impl MockAgent {
    async fn authenticate(&self, payload: Value) -> Value {
        let mut payload = payload;
        payload["agentId"] = json!(self.agent_id);
        let reply = handle_authenticate_agent("a1".to_string(), &payload, &self.acp).await;
        serde_json::to_value(reply).unwrap()
    }

    fn recorded(&self) -> Vec<Value> {
        std::fs::read_to_string(&self.record)
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
}

/// The spawn result flags exactly the methods whose advertised
/// `_meta["api-key"]` names a provider whose key shape Termul knows.
#[tokio::test]
async fn spawn_flags_the_methods_that_take_an_api_key() {
    let Some(mock) = spawn_mock().await else {
        return;
    };
    let flags: Vec<(String, bool)> = mock
        .auth_methods
        .as_array()
        .unwrap()
        .iter()
        .map(|method| {
            (
                method["id"].as_str().unwrap().to_string(),
                method["takesApiKey"] == json!(true),
            )
        })
        .collect();
    assert_eq!(
        flags,
        [
            ("api-key".to_string(), true),
            ("gemini-api-key".to_string(), true),
            ("byok".to_string(), false),
            ("chat-gpt".to_string(), false),
        ]
    );
}

/// codex-acp reads `_meta["api-key"].apiKey`; Gemini CLI reads
/// `_meta["api-key"]` as a string. Neither the handler's nor the command
/// loop's log lines carry the key.
#[tokio::test]
async fn an_api_key_reaches_each_agent_in_the_shape_it_reads() {
    let Some(mock) = spawn_mock().await else {
        return;
    };
    logged_lines();
    let ((codex, gemini), traced) = capture_tracing(async {
        (
            mock.authenticate(json!({ "methodId": "api-key", "apiKey": KEY }))
                .await,
            mock.authenticate(json!({ "methodId": "gemini-api-key", "apiKey": KEY }))
                .await,
        )
    })
    .await;
    assert_eq!(codex["ok"], true, "{codex}");
    assert_eq!(gemini["ok"], true, "{gemini}");

    let expected = vec![
        json!({ "methodId": "api-key", "_meta": { "api-key": { "apiKey": KEY } } }),
        json!({ "methodId": "gemini-api-key", "_meta": { "api-key": KEY } }),
    ];
    assert!(
        mock.recorded() == expected,
        "the agent received authenticate params in the wrong shape"
    );
    assert!(
        !traced.contains(KEY),
        "a /ws handler log line carries the key"
    );
    let leaked: Vec<String> = logged_lines()
        .into_iter()
        .filter(|line| line.contains(KEY))
        .map(|line| line.split_whitespace().next().unwrap_or("").to_string())
        .collect();
    assert!(leaked.is_empty(), "log lines from {leaked:?} carry the key");
}

/// A key for a method that takes none, or beside a gateway, is refused before
/// anything reaches the agent, and the refusal does not repeat the key.
#[tokio::test]
async fn a_misplaced_api_key_is_refused_without_repeating_it() {
    let Some(mock) = spawn_mock().await else {
        return;
    };
    for payload in [
        json!({ "methodId": "chat-gpt", "apiKey": KEY }),
        json!({ "methodId": "byok", "apiKey": KEY }),
        json!({ "methodId": "api-key", "apiKey": KEY, "gateway": { "baseUrl": "https://gw" } }),
        json!({ "methodId": "api-key", "apiKey": "  " }),
    ] {
        let reply = mock.authenticate(payload).await;
        assert_eq!(reply["ok"], false);
        let text = reply.to_string();
        assert!(!text.contains(KEY), "the refusal repeats the key");
        assert!(
            reply["err"]["message"]
                .as_str()
                .is_some_and(|m| !m.is_empty()),
            "the refusal names why: {}",
            text.replace(KEY, "<key>")
        );
    }
    assert!(
        mock.recorded().is_empty(),
        "a refused key reached the agent"
    );
}
