//! Real command-loop / driver-teardown coverage for prompt-turn terminators:
//! a scripted mock ACP agent (python3, stdio JSON-RPC) is spawned through
//! `AcpManager::spawn`, so the production `SendPrompt` arm, `race_turn`
//! deadline handling and the `run_agent` crash teardown all run. The prompt
//! goes through the shared prompt-turn service exactly as on `/ws` and desktop.
//! A missing interpreter fails loudly; `TERMUL_SKIP_REAL_LOOP_TESTS=1` skips.

use super::*;
use crate::acp::provider_errors::{ACP_PROVIDER_REQUEST_REJECTED, ACP_PROVIDER_SESSION_LIMIT};
use crate::web::prompt_turn::{
    accept_prompt_turn, complete_prompt_turn, PromptAdmission, PromptTurnRequest,
};
use crate::web::sink::ReplayResult;
use crate::web::{EventStream, StreamItem, WsRelaySink};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

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

hung = None
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    method, rid = msg.get("method"), msg.get("id")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": rid, "result": {
            "protocolVersion": 1,
            "agentCapabilities": {"sessionCapabilities": {"close": {}}},
            "authMethods": []}})
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
        elif text == "providerlimit":
            send({"jsonrpc": "2.0", "id": rid,
                  "error": {"code": -32603,
                            "message": "You've hit your session limit",
                            "data": {"errorKind": "rate_limit"}}})
        elif text == "rejected":
            send({"jsonrpc": "2.0", "id": rid,
                  "error": {"code": -32603, "message": "Internal error",
                            "data": {"status": 400}}})
        elif text == "crash":
            chunk("partial")
            sys.exit(3)
        elif text == "hang":
            hung = rid  # answered only by session/cancel
        elif text == "ask":
            hung = rid  # a permission request first, then answered by cancel
            send({"jsonrpc": "2.0", "id": 900, "method": "session/request_permission",
                  "params": {"sessionId": "mock-1",
                             "toolCall": {"toolCallId": "tc-1", "title": "run a tool"},
                             "options": [{"optionId": "allow", "name": "Allow",
                                          "kind": "allow_once"}]}})
        # "stuck": never answered, and session/cancel is ignored
    elif method == "session/cancel":
        if hung is not None:
            send({"jsonrpc": "2.0", "id": hung, "result": {"stopReason": "cancelled"}})
            hung = None
    elif method == "session/close":
        send({"jsonrpc": "2.0", "id": rid, "result": {}})
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

/// Sink that records every event it is handed, in order.
#[derive(Default)]
struct EventLog(Mutex<Vec<(String, serde_json::Value)>>);

impl EventSink for EventLog {
    fn emit(&self, event: &crate::web::sink::AcpEvent) {
        self.0
            .lock()
            .push((event.type_.to_string(), event.payload.clone()));
    }
}

impl EventLog {
    /// `type` (without the `acp:` prefix) and `reason` of every lifecycle
    /// event seen, in order.
    fn lifecycle(&self) -> Vec<(String, Option<String>)> {
        self.0
            .lock()
            .iter()
            .filter_map(|(type_, payload)| {
                let name = type_.strip_prefix("acp:").unwrap_or(type_);
                matches!(
                    name,
                    "agent_crashed" | "agent_error" | "session_closed" | "agent_disconnected"
                )
                .then(|| {
                    (
                        name.to_string(),
                        payload["reason"].as_str().map(str::to_string),
                    )
                })
            })
            .collect()
    }

    /// Order of the `prompt_complete` terminators and `session_closed` events.
    fn terminators_and_closes(&self) -> Vec<(String, serde_json::Value)> {
        self.0
            .lock()
            .iter()
            .filter(|(type_, _)| {
                let name = type_.strip_prefix("acp:").unwrap_or(type_);
                name == "prompt_complete" || name == "session_closed"
            })
            .map(|(type_, payload)| {
                (
                    type_.strip_prefix("acp:").unwrap_or(type_).to_string(),
                    payload.clone(),
                )
            })
            .collect()
    }
}

struct Harness {
    /// Two extra sinks beside the relay: every sink must see every lifecycle
    /// event.
    logs: [Arc<EventLog>; 2],
    acp: Arc<AcpManager>,
    relay: Arc<WsRelaySink>,
    agent_id: AgentId,
    session_id: SessionId,
    rx: EventStream,
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
        let logs = [Arc::new(EventLog::default()), Arc::new(EventLog::default())];
        let extra = |relay: &Arc<WsRelaySink>| -> Vec<Arc<dyn EventSink>> {
            vec![relay.clone(), logs[0].clone(), logs[1].clone()]
        };
        let (persistence, relay, acp) = if durable {
            let persistence = SessionPersistence::open(dir.join("sessions"))
                .await
                .expect("open session persistence");
            let relay = Arc::new(WsRelaySink::with_persistence(64, persistence.clone()));
            let acp = Arc::new(AcpManager::with_persistence(
                extra(&relay),
                persistence.clone(),
            ));
            (Some(persistence), relay, acp)
        } else {
            let relay = Arc::new(WsRelaySink::new());
            let acp = Arc::new(AcpManager::new(extra(&relay)));
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
        let (_client, rx, replay, _) = relay
            .subscribe(&session_id.0, None, None, &CancellationToken::new())
            .await;
        assert!(matches!(replay, ReplayResult::Ok(_)));
        Some(Self {
            logs,
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
            let Some(StreamItem::Event(event)) =
                tokio::time::timeout(Duration::from_secs(30), self.rx.recv())
                    .await
                    .expect("terminator arrives")
            else {
                panic!("subscription ended or produced a gap before the terminator");
            };
            let done = event.type_ == "prompt_complete";
            seen.push((event.type_.clone(), event.payload.clone()));
            if done {
                break;
            }
        }
        loop {
            match tokio::time::timeout(Duration::from_millis(400), self.rx.recv()).await {
                Ok(Some(StreamItem::Event(event))) => {
                    seen.push((event.type_.clone(), event.payload.clone()));
                }
                Ok(Some(StreamItem::Gap(sid))) => panic!("unexpected gap frame for {sid}"),
                Ok(None) | Err(_) => break,
            }
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

/// A provider refusal keeps its stable code on both the `agent_error` event
/// and the turn reply; an unrecognized RPC failure carries neither.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn provider_failure_carries_a_stable_code_on_the_event_and_the_reply() {
    let Some(mut h) = Harness::start().await else {
        return;
    };
    let error = h.run("providerlimit", "t1").await.unwrap_err();
    assert!(
        error.starts_with(&format!(
            "{ACP_PROVIDER_SESSION_LIMIT}: You've hit your session limit"
        )),
        "{error}"
    );
    let events = h.events_through_terminator().await;
    let (_, payload) = events
        .iter()
        .find(|(kind, _)| kind == "agent_error")
        .expect("agent_error event");
    assert_eq!(payload["providerCode"], "provider_session_limit");

    let error = h.run("rejected", "t2").await.unwrap_err();
    assert!(error.starts_with(ACP_PROVIDER_REQUEST_REJECTED), "{error}");
    let events = h.events_through_terminator().await;
    let (_, payload) = events
        .iter()
        .find(|(kind, _)| kind == "agent_error")
        .expect("agent_error event");
    assert_eq!(payload["providerCode"], "provider_request_rejected");

    let error = h.run("rpcfail", "t3").await.unwrap_err();
    assert_eq!(error, "mock failure");
    let events = h.events_through_terminator().await;
    let (_, payload) = events
        .iter()
        .find(|(kind, _)| kind == "agent_error")
        .expect("agent_error event");
    assert!(payload.get("providerCode").is_none());
    h.finish().await;
}

/// A start failure reports the agent's last stderr lines, masked, in the
/// rejection detail; the failure stays untagged (not a launch refusal).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn start_failure_detail_embeds_the_masked_stderr_tail() {
    let Some(python) = find_python() else {
        return;
    };
    let _serial = TIMEOUT_TEST_LOCK.lock().await;
    let script = "import sys\n\
        sys.stderr.write('fatal: runtime is missing\\n')\n\
        sys.stderr.write('ANTHROPIC_API_KEY=sk-ant-0123456789abcdef0123\\n')\n\
        sys.stderr.flush()\n\
        sys.exit(1)\n";
    let acp = AcpManager::new(vec![]);
    let error = acp
        .spawn(AgentConfig {
            config_id: Some("custom-diag".to_string()),
            name: "diag".to_string(),
            command: python.to_string(),
            args: vec!["-c".to_string(), script.to_string()],
            env: std::collections::HashMap::new(),
            allow_terminal: false,
        })
        .await
        .expect_err("agent exits before initialize");
    assert!(error.contains("agent stderr:"), "{error}");
    assert!(error.contains("fatal: runtime is missing"), "{error}");
    assert!(!error.contains("sk-ant-0123456789"), "{error}");
    assert!(classify_spawn_error(&error).is_none(), "{error}");
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

fn reasons(log: &EventLog) -> Vec<(String, Option<String>)> {
    log.lifecycle()
}

/// Settle window for events that must NOT arrive.
async fn settle() {
    tokio::time::sleep(Duration::from_millis(300)).await;
}

/// An explicit kill of an agent with a live session announces, to EVERY sink,
/// `session_closed` for the session and then `agent_disconnected`, both with
/// reason `killed`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn kill_announces_session_closed_then_disconnected_to_every_sink() {
    let Some(h) = Harness::start().await else {
        return;
    };
    h.acp.kill(&h.agent_id).await.expect("kill");
    let expected = vec![
        ("session_closed".to_string(), Some("killed".to_string())),
        ("agent_disconnected".to_string(), Some("killed".to_string())),
    ];
    for log in &h.logs {
        assert_eq!(reasons(log), expected);
    }
    let _ = std::fs::remove_dir_all(&h.dir);
}

/// The reaper's stop is announced with reason `reaped`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reaper_kill_announces_reaped_to_every_sink() {
    let Some(h) = Harness::start().await else {
        return;
    };
    h.acp.reap_agent(&h.agent_id).await.expect("reap");
    let expected = vec![
        ("session_closed".to_string(), Some("reaped".to_string())),
        ("agent_disconnected".to_string(), Some("reaped".to_string())),
    ];
    for log in &h.logs {
        assert_eq!(reasons(log), expected);
    }
    let _ = std::fs::remove_dir_all(&h.dir);
}

/// Process shutdown (`kill_all`) stays silent: no `session_closed`, no
/// `agent_disconnected`, no crash events on any sink.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn kill_all_emits_no_lifecycle_events() {
    let Some(h) = Harness::start().await else {
        return;
    };
    tokio::time::timeout(RUN_TIMEOUT, h.acp.kill_all_checked())
        .await
        .expect("kill_all finishes")
        .expect("kill_all ok");
    settle().await;
    for log in &h.logs {
        assert_eq!(reasons(log), vec![], "shutdown must stay silent");
    }
    let _ = std::fs::remove_dir_all(&h.dir);
}

/// A crash is announced to every sink in order: crashed → error →
/// session_closed → disconnected, each carrying reason `crashed` where it has
/// one. The failed turn's own `agent_error` may come before the group.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn crash_announces_crashed_error_closed_disconnected_in_order() {
    let Some(h) = Harness::start().await else {
        return;
    };
    let _ = h.run("crash", "t1").await;
    // The teardown runs on the driver thread after the turn reply drops.
    for _ in 0..100 {
        let done = h.logs.iter().all(|log| {
            reasons(log)
                .iter()
                .any(|(name, _)| name == "agent_disconnected")
        });
        if done {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let expected = [
        ("agent_crashed".to_string(), None),
        ("agent_error".to_string(), None),
        ("session_closed".to_string(), Some("crashed".to_string())),
        (
            "agent_disconnected".to_string(),
            Some("crashed".to_string()),
        ),
    ];
    for log in &h.logs {
        let seen = reasons(log);
        let split = seen.len().saturating_sub(expected.len());
        assert_eq!(seen[split..], expected[..], "{seen:?}");
        assert!(
            seen[..split].iter().all(|(name, _)| name == "agent_error"),
            "only the failed turn's own error may precede the teardown group: {seen:?}"
        );
    }
    let _ = std::fs::remove_dir_all(&h.dir);
}

/// `close_session` during a turn cancels it and waits for its terminator:
/// exactly one `prompt_complete` (cancelled), then `session_closed` with reason
/// `closed`, on every sink.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_session_mid_turn_leaves_one_terminator_then_session_closed() {
    let Some(h) = Harness::start().await else {
        return;
    };
    let admission = accept_prompt_turn(&h.acp, &h.relay, h.request("hang", "t1"))
        .await
        .unwrap_or_else(|_| panic!("accepted"));
    let PromptAdmission::Running(running) = admission else {
        panic!("first send must run");
    };
    let waiter = {
        let acp = h.acp.clone();
        tokio::spawn(async move { complete_prompt_turn(&acp, running).await })
    };
    assert!(h
        .acp
        .is_turn_active(&h.agent_id, h.session_id.clone())
        .await
        .unwrap());

    tokio::time::timeout(
        RUN_TIMEOUT,
        h.acp.close_session(&h.agent_id, h.session_id.clone()),
    )
    .await
    .expect("close finishes")
    .expect("close ok");
    let _ = tokio::time::timeout(RUN_TIMEOUT, waiter).await;
    settle().await;

    for log in &h.logs {
        let seen = log.terminators_and_closes();
        let names: Vec<&str> = seen.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, vec!["prompt_complete", "session_closed"], "{seen:?}");
        assert_eq!(seen[0].1["stopReason"], "cancelled");
        assert_eq!(seen[1].1["reason"], "closed");
    }
    assert!(
        !h.acp
            .is_turn_active(&h.agent_id, h.session_id.clone())
            .await
            .unwrap(),
        "the turn is gone with the session"
    );
    h.finish().await;
}

/// A close with no turn running announces `session_closed{closed}` once.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_session_when_idle_announces_session_closed_once() {
    let Some(h) = Harness::start().await else {
        return;
    };
    h.acp
        .close_session(&h.agent_id, h.session_id.clone())
        .await
        .expect("close ok");
    for log in &h.logs {
        assert_eq!(
            reasons(log),
            vec![("session_closed".to_string(), Some("closed".to_string()))]
        );
    }
    h.finish().await;
}

/// The activity probe reports a running turn and a pending-free idle agent,
/// and a finished turn stamps `last_active_at`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn activity_probe_reports_turn_and_stamps_last_active() {
    let Some(h) = Harness::start().await else {
        return;
    };
    let idle = h.acp.agent_activity(&h.agent_id).await.expect("probe");
    assert!(!idle.has_evidence(), "{idle:?}");

    let admission = accept_prompt_turn(&h.acp, &h.relay, h.request("hang", "t1"))
        .await
        .unwrap_or_else(|_| panic!("accepted"));
    let PromptAdmission::Running(running) = admission else {
        panic!("first send must run");
    };
    let waiter = {
        let acp = h.acp.clone();
        tokio::spawn(async move { complete_prompt_turn(&acp, running).await })
    };
    let busy = h.acp.agent_activity(&h.agent_id).await.expect("probe");
    assert_eq!(busy.active_turns, 1);
    assert!(busy.has_evidence());
    assert!(busy.last_active_at >= idle.last_active_at);

    h.acp
        .cancel_prompt(&h.agent_id, h.session_id.clone())
        .await
        .expect("cancel");
    let _ = tokio::time::timeout(RUN_TIMEOUT, waiter).await;
    let after = h.acp.agent_activity(&h.agent_id).await.expect("probe");
    assert_eq!(after.active_turns, 0);
    assert!(after.last_active_at >= busy.last_active_at);
    h.finish().await;
}

const REAP_WINDOW: Duration = Duration::from_secs(30);

/// A sweep clock far past any stamp the test produced, so only live evidence
/// (not the quiet span) can keep an agent.
fn far_future() -> std::time::Instant {
    std::time::Instant::now() + Duration::from_secs(3600)
}

/// Start one turn through the shared prompt-turn service without waiting for
/// its terminator.
async fn spawn_turn(
    h: &Harness,
    text: &str,
    turn_id: &str,
) -> tokio::task::JoinHandle<Result<StopReason, String>> {
    let admission = accept_prompt_turn(&h.acp, &h.relay, h.request(text, turn_id))
        .await
        .unwrap_or_else(|_| panic!("accepted"));
    let PromptAdmission::Running(running) = admission else {
        panic!("first send must run");
    };
    let acp = h.acp.clone();
    tokio::spawn(async move { complete_prompt_turn(&acp, running).await })
}

/// Poll the agent's activity probe until `ready` holds.
async fn wait_for_activity(
    h: &Harness,
    ready: impl Fn(&crate::acp::AgentActivity) -> bool,
) -> crate::acp::AgentActivity {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let activity = h.acp.agent_activity(&h.agent_id).await.expect("probe");
        if ready(&activity) {
            return activity;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "activity never reached the expected state: {activity:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn reaped_lifecycle() -> Vec<(String, Option<String>)> {
    vec![
        ("session_closed".to_string(), Some("reaped".to_string())),
        ("agent_disconnected".to_string(), Some("reaped".to_string())),
    ]
}

/// A pending approval keeps an agent alive however long it has been quiet and
/// whatever the connections do; once the turn ends the same sweep reaps it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pending_approval_blocks_the_reap_until_the_turn_ends() {
    use crate::web::agent_reaper::reap_idle_agents;
    let Some(h) = Harness::start().await else {
        return;
    };
    let waiter = spawn_turn(&h, "ask", "t1").await;
    wait_for_activity(&h, |a| a.pending_permissions == 1).await;

    let reaped = reap_idle_agents(&h.acp, far_future(), REAP_WINDOW).await;
    assert!(reaped.is_empty(), "a pending approval must block the reap");
    assert_eq!(h.acp.list_agents(), vec![h.agent_id.clone()]);
    settle().await;
    for log in &h.logs {
        assert!(reasons(log).is_empty(), "nothing was announced");
    }

    h.acp
        .cancel_prompt(&h.agent_id, h.session_id.clone())
        .await
        .expect("cancel");
    let _ = tokio::time::timeout(RUN_TIMEOUT, waiter).await;
    wait_for_activity(&h, |a| !a.has_evidence()).await;

    let reaped = reap_idle_agents(&h.acp, far_future(), REAP_WINDOW).await;
    assert_eq!(reaped, vec![h.agent_id.clone()]);
    for log in &h.logs {
        assert_eq!(reasons(log), reaped_lifecycle());
    }
    let _ = std::fs::remove_dir_all(&h.dir);
}

/// A durable idle session is reaped once the window passes: every sink hears
/// `session_closed` then `agent_disconnected` with reason `reaped`, and the
/// session's history stays on disk.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_idle_durable_session_is_reaped_with_fan_out_and_its_history_stays() {
    use crate::web::agent_reaper::reap_idle_agents;
    let Some(h) = Harness::start_with_persistence().await else {
        return;
    };
    let persistence = h.persistence.clone().expect("durable harness");
    assert_eq!(h.run("ok", "t1").await.unwrap(), StopReason::EndTurn);

    let early = reap_idle_agents(&h.acp, std::time::Instant::now(), REAP_WINDOW).await;
    assert!(early.is_empty(), "inside the window the agent is kept");

    let reaped = reap_idle_agents(&h.acp, far_future(), REAP_WINDOW).await;
    assert_eq!(reaped, vec![h.agent_id.clone()]);
    assert!(h.acp.list_agents().is_empty());
    for log in &h.logs {
        assert_eq!(reasons(log), reaped_lifecycle());
    }
    persistence.flush_all().await.unwrap();
    assert!(
        persistence
            .list_sessions()
            .iter()
            .any(|entry| entry.session_id == h.session_id.0),
        "history of the reaped session stays indexed"
    );
    assert!(persistence.metadata(&h.session_id.0).is_ok());
    let _ = std::fs::remove_dir_all(&h.dir);
}

/// An agent that ignores the cancel does not wedge a close: the host's own
/// cancel grace ends the turn with a single terminator, then the session is
/// closed and announced once.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_session_waits_out_an_agent_that_ignores_the_cancel() {
    let Some(h) = Harness::start().await else {
        return;
    };
    let waiter = spawn_turn(&h, "stuck", "t1").await;
    wait_for_activity(&h, |a| a.active_turns == 1).await;

    let started = std::time::Instant::now();
    tokio::time::timeout(
        RUN_TIMEOUT,
        h.acp.close_session(&h.agent_id, h.session_id.clone()),
    )
    .await
    .expect("close finishes")
    .expect("close ok");
    assert!(
        started.elapsed() >= Duration::from_secs(4),
        "the close waited for the turn terminator first"
    );
    let _ = tokio::time::timeout(RUN_TIMEOUT, waiter).await;
    settle().await;
    for log in &h.logs {
        let seen = log.terminators_and_closes();
        let names: Vec<&str> = seen.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, vec!["prompt_complete", "session_closed"], "{seen:?}");
        assert_eq!(seen[1].1["reason"], "closed");
    }
    h.finish().await;
}
