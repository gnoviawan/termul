//! Real command-loop / driver-teardown coverage for prompt-turn terminators:
//! a scripted mock ACP agent (python3, stdio JSON-RPC) is spawned through
//! `AcpManager::spawn`, so the production `SendPrompt` arm, `race_turn`
//! deadline handling and the `run_agent` crash teardown all run. The prompt
//! goes through the shared prompt-turn service exactly as on `/ws` and desktop.
//! A missing interpreter fails loudly; `TERMUL_SKIP_REAL_LOOP_TESTS=1` skips.

use super::*;
use crate::web::prompt_turn::{
    accept_prompt_turn, complete_prompt_turn, PromptAdmission, PromptTurnRequest,
};
use crate::web::sink::ReplayResult;
use crate::web::{SequencedEvent, WsRelaySink};
use std::time::Duration;

const MOCK_AGENT: &str = r#"
import json, sys

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def chunk(text):
    send({"jsonrpc": "2.0", "method": "session/update", "params": {
        "sessionId": "mock-1",
        "update": {"sessionUpdate": "agent_message_chunk",
                   "content": {"type": "text", "text": text}}}})

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    method, rid = msg.get("method"), msg.get("id")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": rid, "result": {
            "protocolVersion": 1, "agentCapabilities": {}, "authMethods": []}})
    elif method == "session/new":
        send({"jsonrpc": "2.0", "id": rid, "result": {"sessionId": "mock-1"}})
    elif method == "session/prompt":
        text = msg["params"]["prompt"][0].get("text", "")
        if text == "ok":
            chunk("hello")
            send({"jsonrpc": "2.0", "id": rid, "result": {"stopReason": "end_turn"}})
        elif text == "rpcfail":
            send({"jsonrpc": "2.0", "id": rid,
                  "error": {"code": -32000, "message": "mock failure"}})
        elif text == "crash":
            chunk("partial")
            sys.exit(3)
        # "hang": never answer
"#;

/// Serializes every test that reads or writes process-global ACP timeout state:
/// the in-process idle-timeout override and the environment variables
/// `TERMUL_ACP_TURN_IDLE_TIMEOUT_SECS`, `TERMUL_ACP_TURN_TIMEOUT_SECS`,
/// `TERMUL_ACP_SESSION_NEW_TIMEOUT_SECS` and
/// `TERMUL_ACP_SESSION_REOPEN_TIMEOUT_SECS`. It covers all real-loop tests and
/// the override and precedence tests in `manager/tests.rs`. A real-loop test
/// therefore never inherits another test's timeout, and vice versa.
pub(super) static TIMEOUT_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Opt-out for hosts without a Python interpreter. Without it a missing
/// interpreter is a hard failure: these are the only tests that drive the
/// production `SendPrompt` arm, `race_turn` and the crash teardown.
const SKIP_ENV: &str = "TERMUL_SKIP_REAL_LOOP_TESTS";

/// First interpreter on PATH that runs (`python3`, then `python` for
/// Windows runners).
fn find_python() -> Option<&'static str> {
    ["python3", "python"].into_iter().find(|candidate| {
        std::process::Command::new(candidate)
            .arg("--version")
            .output()
            .is_ok_and(|output| output.status.success())
    })
}

/// Applies the 1 s idle window for the lifetime of the guard.
struct IdleTimeoutGuard;

impl IdleTimeoutGuard {
    fn set(secs: u64) -> Self {
        set_turn_idle_timeout_override(Some(secs));
        Self
    }
}

impl Drop for IdleTimeoutGuard {
    fn drop(&mut self) {
        set_turn_idle_timeout_override(None);
    }
}

/// Timeout env vars the harness exercises (`turn_idle_timeout()`,
/// `resolved_turn_timeout()`, `session_new_timeout()`, `session_reopen_timeout()`).
/// They take precedence over the in-process override the idle-timeout test
/// sets, so a developer/CI environment that configures one would change every
/// real-loop turn's deadlines.
const TURN_TIMEOUT_ENV_VARS: [&str; 4] = [
    "TERMUL_ACP_TURN_IDLE_TIMEOUT_SECS",
    "TERMUL_ACP_TURN_TIMEOUT_SECS",
    "TERMUL_ACP_SESSION_NEW_TIMEOUT_SECS",
    "TERMUL_ACP_SESSION_REOPEN_TIMEOUT_SECS",
];

/// Clears the ambient turn-timeout env vars for the harness lifetime (the
/// caller holds [`TIMEOUT_TEST_LOCK`]) and restores them on drop.
struct TurnTimeoutEnvGuard(Vec<(&'static str, Option<std::ffi::OsString>)>);

impl TurnTimeoutEnvGuard {
    fn clear() -> Self {
        let saved = TURN_TIMEOUT_ENV_VARS
            .into_iter()
            .map(|name| {
                let previous = std::env::var_os(name);
                std::env::remove_var(name);
                (name, previous)
            })
            .collect();
        Self(saved)
    }
}

impl Drop for TurnTimeoutEnvGuard {
    fn drop(&mut self) {
        for (name, previous) in self.0.drain(..) {
            match previous {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }
}

/// Upper bound for one turn; a wedged loop fails the test instead of hanging.
const RUN_TIMEOUT: Duration = Duration::from_secs(60);

struct Harness {
    acp: Arc<AcpManager>,
    relay: Arc<WsRelaySink>,
    agent_id: AgentId,
    session_id: SessionId,
    rx: mpsc::UnboundedReceiver<SequencedEvent>,
    dir: PathBuf,
    /// Durable store shared by relay and manager (`start_with_persistence`).
    persistence: Option<Arc<SessionPersistence>>,
    // Field order matters: the override is cleared and the env restored before
    // the serialization lock is released.
    _idle_timeout: Option<IdleTimeoutGuard>,
    _env: TurnTimeoutEnvGuard,
    _serial: tokio::sync::MutexGuard<'static, ()>,
}

impl Harness {
    /// `None` only when the host opted out via `TERMUL_SKIP_REAL_LOOP_TESTS=1`;
    /// a missing interpreter otherwise panics rather than passing vacuously.
    async fn start() -> Option<Self> {
        Self::start_inner(false, None).await
    }

    /// Like [`Self::start`], but relay and manager share a real
    /// `SessionPersistence` in a temp dir, exactly as on the standalone server.
    async fn start_with_persistence() -> Option<Self> {
        Self::start_inner(true, None).await
    }

    /// Durable harness whose session is created with an explicit project id,
    /// as `create_session` hands over a resolved `projectId`.
    async fn start_with_project(project_id: &str) -> Option<Self> {
        Self::start_inner(true, Some(project_id)).await
    }

    async fn start_inner(durable: bool, project_id: Option<&str>) -> Option<Self> {
        let Some(python) = find_python() else {
            if std::env::var(SKIP_ENV).as_deref() == Ok("1") {
                eprintln!("SKIP real_loop_tests: no python interpreter ({SKIP_ENV}=1)");
                return None;
            }
            panic!(
                "real_loop_tests need `python3` (or `python`) on PATH to run the mock ACP \
                 agent; install it or set {SKIP_ENV}=1 to skip these tests explicitly"
            );
        };
        let serial = TIMEOUT_TEST_LOCK.lock().await;
        let env = TurnTimeoutEnvGuard::clear();
        let dir = std::env::temp_dir().join(format!("termul-real-loop-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("mock_agent.py");
        std::fs::write(&script, MOCK_AGENT).unwrap();
        let (persistence, relay, acp) = if durable {
            let persistence = SessionPersistence::open(dir.join("sessions"))
                .await
                .expect("open session persistence");
            let relay = Arc::new(WsRelaySink::with_persistence(64, persistence.clone()));
            let acp = Arc::new(AcpManager::with_persistence(
                vec![relay.clone()],
                persistence.clone(),
            ));
            (Some(persistence), relay, acp)
        } else {
            let relay = Arc::new(WsRelaySink::new());
            let acp = Arc::new(AcpManager::new(vec![relay.clone()]));
            (None, relay, acp)
        };
        let spawned = acp
            .spawn(AgentConfig {
                config_id: None,
                name: "mock-agent".to_string(),
                command: python.to_string(),
                args: vec!["-u".to_string(), script.to_string_lossy().to_string()],
                env: std::collections::HashMap::new(),
                allow_terminal: false,
            })
            .await
            .expect("mock agent initializes");
        let session = acp
            .new_session_with_context(
                &spawned.agent_id,
                dir.to_string_lossy().to_string(),
                vec![],
                SessionCreationContext {
                    project_id: project_id.map(str::to_string),
                    ..SessionCreationContext::default()
                },
            )
            .await
            .expect("mock session");
        let session_id = session.session_id;
        relay.seed_session_for_test(&session_id.0);
        let (_client, rx, replay, _) = relay.subscribe(&session_id.0, None, None).await;
        assert!(matches!(replay, ReplayResult::Ok(_)));
        Some(Self {
            acp,
            relay,
            agent_id: spawned.agent_id,
            session_id,
            rx,
            dir,
            persistence,
            _idle_timeout: None,
            _env: env,
            _serial: serial,
        })
    }

    /// Bound the next turns' idle window (cleared when the harness drops).
    fn set_idle_timeout(&mut self, secs: u64) {
        self._idle_timeout = Some(IdleTimeoutGuard::set(secs));
    }

    fn request(&self, text: &str, turn_id: &str) -> PromptTurnRequest {
        let blocks = vec![ContentBlock::Text(
            agent_client_protocol::schema::v1::TextContent::new(text),
        )];
        PromptTurnRequest {
            agent_id: self.agent_id.clone(),
            session_id: self.session_id.clone(),
            content: blocks.clone(),
            record_content: blocks,
            turn_id: Some(turn_id.to_string()),
        }
    }

    /// Run one prompt through the shared service; the result is the turn's
    /// reply (stop reason or the manager error).
    async fn run(&self, text: &str, turn_id: &str) -> Result<StopReason, String> {
        let turn = async {
            match accept_prompt_turn(&self.acp, &self.relay, self.request(text, turn_id)).await {
                Ok(PromptAdmission::Running(running)) => {
                    complete_prompt_turn(&self.acp, running).await
                }
                Ok(PromptAdmission::Receipt(_)) => Err("unexpected receipt".to_string()),
                Err(error) => Err(error.into_message()),
            }
        };
        tokio::time::timeout(RUN_TIMEOUT, turn)
            .await
            .unwrap_or_else(|_| panic!("turn `{text}` did not finish within {RUN_TIMEOUT:?}"))
    }

    /// Session events up to and including the first `prompt_complete`, then
    /// whatever else arrives in a short settle window (a second terminator
    /// would show up there).
    async fn events_through_terminator(&mut self) -> Vec<(String, serde_json::Value)> {
        let mut seen = Vec::new();
        loop {
            let event = tokio::time::timeout(Duration::from_secs(30), self.rx.recv())
                .await
                .expect("terminator arrives")
                .expect("subscription open");
            let done = event.type_ == "prompt_complete";
            seen.push((event.type_.clone(), event.payload.clone()));
            if done {
                break;
            }
        }
        while let Ok(Some(event)) =
            tokio::time::timeout(Duration::from_millis(400), self.rx.recv()).await
        {
            seen.push((event.type_.clone(), event.payload.clone()));
        }
        seen
    }

    async fn finish(self) {
        let _ = self.acp.kill(&self.agent_id).await;
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn kinds(events: &[(String, serde_json::Value)]) -> Vec<&str> {
    events
        .iter()
        .filter(|(kind, _)| {
            matches!(
                kind.as_str(),
                "user_prompt" | "message_chunk" | "agent_error" | "prompt_complete"
            )
        })
        .map(|(kind, _)| kind.as_str())
        .collect()
}

fn terminators(events: &[(String, serde_json::Value)]) -> Vec<&serde_json::Value> {
    events
        .iter()
        .filter(|(kind, _)| kind == "prompt_complete")
        .map(|(_, payload)| payload)
        .collect()
}

/// Normal turn: the `user_prompt` (sequenced by the accept hook on the driver
/// thread) precedes the agent's chunk, which precedes the one terminator.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn normal_turn_orders_user_prompt_chunk_terminator() {
    let Some(mut h) = Harness::start().await else {
        return;
    };
    assert_eq!(h.run("ok", "t1").await.unwrap(), StopReason::EndTurn);
    let events = h.events_through_terminator().await;
    assert_eq!(
        kinds(&events),
        vec!["user_prompt", "message_chunk", "prompt_complete"]
    );
    let done = terminators(&events);
    assert_eq!(done[0]["stopReason"], "end_turn");
    assert_eq!(done[0]["turnId"], "t1");
    h.finish().await;
}

/// An agent RPC error: `agent_error` + exactly one `error` terminator; the
/// claim is released so the next prompt runs.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rpc_error_turn_emits_one_error_terminator_and_releases_the_claim() {
    let Some(mut h) = Harness::start().await else {
        return;
    };
    let error = h.run("rpcfail", "t1").await.unwrap_err();
    assert!(error.contains("mock failure"), "{error}");
    let events = h.events_through_terminator().await;
    assert_eq!(
        kinds(&events),
        vec!["user_prompt", "agent_error", "prompt_complete"]
    );
    assert_eq!(terminators(&events)[0]["stopReason"], "error");
    assert_eq!(terminators(&events)[0]["turnId"], "t1");

    assert_eq!(h.run("ok", "t2").await.unwrap(), StopReason::EndTurn);
    h.finish().await;
}

/// A wedged agent hits the idle deadline: typed timeout → `timeout`
/// terminator (not `error`), still exactly one, and the next prompt is
/// accepted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn idle_timeout_turn_emits_one_timeout_terminator() {
    let Some(mut h) = Harness::start().await else {
        return;
    };
    h.set_idle_timeout(1);
    let error = h.run("hang", "t1").await.unwrap_err();
    assert!(error.contains("idle timeout"), "{error}");
    let events = h.events_through_terminator().await;
    assert_eq!(
        kinds(&events),
        vec!["user_prompt", "agent_error", "prompt_complete"]
    );
    assert_eq!(terminators(&events)[0]["stopReason"], "timeout");
    assert_eq!(terminators(&events)[0]["turnId"], "t1");
    h.finish().await;
}

/// The agent process dies mid-turn: the connection-close teardown owns the
/// terminator — exactly one `crashed` `prompt_complete` naming the turn.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_crash_mid_turn_emits_one_crashed_terminator() {
    let Some(mut h) = Harness::start().await else {
        return;
    };
    let result = h.run("crash", "t1").await;
    assert!(
        result.is_err(),
        "the dropped turn reply surfaces as an error"
    );
    let events = h.events_through_terminator().await;
    let done = terminators(&events);
    assert_eq!(done.len(), 1, "exactly one terminator: {events:?}");
    assert_eq!(done[0]["stopReason"], "crashed", "{result:?} {events:?}");
    assert_eq!(done[0]["turnId"], "t1");
    // The resend of the crashed turn id is a completed-turn receipt.
    assert!(h.relay.turn_watermark().is_completed(&h.session_id.0, "t1"));
    h.finish().await;
}

/// Process shutdown with a REAL durable store while the agent is mid-turn: the
/// connection-close teardown must leave the turn to the `interrupted` marker
/// (no `crashed` terminator, via the `is_process_shutdown` arm in `driver.rs`),
/// the turn task's transport-closed error must write no terminator either, and
/// `SessionPersistence::shutdown` then appends exactly one `interrupted`
/// `prompt_complete` naming the turn.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn process_shutdown_mid_turn_leaves_the_turn_to_the_interrupted_marker() {
    let Some(h) = Harness::start_with_persistence().await else {
        return;
    };
    let persistence = h.persistence.clone().expect("durable harness");
    let admission = accept_prompt_turn(&h.acp, &h.relay, h.request("hang", "t1"))
        .await
        .unwrap_or_else(|_| panic!("accepted"));
    let PromptAdmission::Running(running) = admission else {
        panic!("first send must run");
    };
    // The turn is in flight and its `user_prompt` is durable (flushed by accept).
    let waiter = {
        let acp = h.acp.clone();
        tokio::spawn(async move { complete_prompt_turn(&acp, running).await })
    };

    tokio::time::timeout(RUN_TIMEOUT, h.acp.kill_all_checked())
        .await
        .expect("kill_all finishes")
        .expect("kill_all ok");
    let reply = tokio::time::timeout(RUN_TIMEOUT, waiter)
        .await
        .expect("turn waiter resolves")
        .expect("waiter joined");
    assert!(
        reply.is_err(),
        "the dropped turn surfaces as an error: {reply:?}"
    );

    // Before the persistence close: nothing terminated the turn.
    persistence.flush_all().await.unwrap();
    let before = persistence
        .replay_after_async(h.session_id.0.clone(), 0)
        .await
        .unwrap();
    let stops = |records: &[crate::acp::session_persistence::PersistedEventRecord]| -> Vec<String> {
        records
            .iter()
            .filter(|r| r.type_ == "prompt_complete")
            .map(|r| r.payload["stopReason"].as_str().unwrap().to_string())
            .collect()
    };
    assert!(
        stops(&before).is_empty(),
        "no terminator (crashed or otherwise) before the interrupted marker: {before:?}"
    );

    h.acp
        .shutdown_persistence()
        .await
        .expect("persistence shutdown");
    let after = persistence
        .replay_after_async(h.session_id.0.clone(), 0)
        .await
        .unwrap();
    assert_eq!(stops(&after), vec!["interrupted"], "{after:?}");
    let marker = after
        .iter()
        .find(|r| r.type_ == "prompt_complete")
        .expect("marker");
    assert_eq!(marker.payload["turnId"], "t1");
    assert_eq!(
        after.iter().filter(|r| r.type_ == "user_prompt").count(),
        1,
        "{after:?}"
    );
    let _ = std::fs::remove_dir_all(&h.dir);
}

/// A session created without a project is stamped with the unassigned
/// sentinel in the durable record, through the real `session/new` path that
/// `create_session` and `acp_new_session` share.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_created_without_a_project_is_stamped_unassigned() {
    let Some(h) = Harness::start_with_persistence().await else {
        return;
    };
    let persistence = h.persistence.clone().expect("durable harness");

    assert_eq!(
        persistence
            .metadata(&h.session_id.0)
            .unwrap()
            .project_id
            .as_deref(),
        Some(crate::acp::session_persistence::UNASSIGNED_PROJECT_ID)
    );
    h.finish().await;
}

/// An explicit project id handed to `session/new` reaches the durable record
/// (the second half of `create_session`'s "stamp once" contract).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_created_with_a_project_is_stamped_with_it() {
    let Some(h) = Harness::start_with_project("project-7").await else {
        return;
    };
    let persistence = h.persistence.clone().expect("durable harness");

    assert_eq!(
        persistence
            .metadata(&h.session_id.0)
            .unwrap()
            .project_id
            .as_deref(),
        Some("project-7")
    );
    h.finish().await;
}
