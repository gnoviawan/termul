//! AD-5 / AD-16 command-ledger cases through the production relay loop: lost
//! replies and resends, resends while in flight, ledger eviction (create vs
//! non-create), resend after a host restart, id reuse, interrupted handlers
//! and rejection replay. Create cases run the REAL command loop against a
//! scripted mock agent (python3, as `real_loop_tests`) so the entity stamp is
//! written and read by production code.

use std::path::{Path, PathBuf};

use axum::extract::ws::Message;

use super::*;
use crate::acp::manager::FakeAuth;
use crate::acp::session_persistence::SessionPersistence;
use crate::web::command_ledger::test_clock::ManualClock;
use crate::web::command_ledger::{CommandLedger, BARE_HORIZON_FACTOR};

const RETENTION: Duration = Duration::from_secs(600);
const SKIP_ENV: &str = "TERMUL_SKIP_REAL_LOOP_TESTS";

/// Numbers sessions `mock-1`, `mock-2`, ... Every `session/new` writes the
/// `MOCK_READY` marker, then waits while the `MOCK_GATE` file exists.
const MOCK_AGENT: &str = r#"
import json, os, sys, time

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

gate = os.environ.get("MOCK_GATE")
ready = os.environ.get("MOCK_READY")
count = 0
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
        # Tell the test the request reached the agent, then hold while gated.
        if ready:
            open(ready, "w").write("1")
        while gate and os.path.exists(gate):
            time.sleep(0.02)
        count += 1
        send({"jsonrpc": "2.0", "id": rid, "result": {"sessionId": "mock-%d" % count}})
"#;

fn text_contains(message: &Message, needle: &str) -> bool {
    matches!(message, Message::Text(text) if text.contains(needle))
}

fn python() -> Option<&'static str> {
    for candidate in ["python3", "python"] {
        if std::process::Command::new(candidate)
            .arg("--version")
            .output()
            .is_ok_and(|out| out.status.success())
        {
            return Some(candidate);
        }
    }
    assert_eq!(
        std::env::var(SKIP_ENV).as_deref(),
        Ok("1"),
        "command-ledger create tests need `python3` on PATH (or set {SKIP_ENV}=1)"
    );
    None
}

/// A durable host over the real command loop and a mock agent, rooted at `root`
/// (a second `RealHost` on the same root is a host restart).
struct RealHost {
    host: Host,
    acp: Arc<AcpManager>,
    persistence: Arc<SessionPersistence>,
    clock: Arc<ManualClock>,
    root: PathBuf,
    python: &'static str,
}

impl RealHost {
    async fn start(root: &Path, in_flight_wait: Duration) -> Option<Self> {
        let python = python()?;
        std::fs::create_dir_all(root.join("cwd")).unwrap();
        std::fs::write(root.join("mock_agent.py"), MOCK_AGENT).unwrap();
        let persistence = SessionPersistence::open(root.join("sessions"))
            .await
            .expect("open session persistence");
        let clock = Arc::new(ManualClock::default());
        let ledger = CommandLedger::with_clock(RETENTION, clock.clone())
            .with_in_flight_wait(in_flight_wait);
        let relay = Arc::new(
            WsRelaySink::with_persistence(64, persistence.clone()).with_ledger(ledger),
        );
        let acp = Arc::new(AcpManager::with_persistence(
            vec![relay.clone()],
            persistence.clone(),
        ));
        let host = Host::from_parts(relay, Arc::clone(&acp), HistoryMode::Server);
        Some(Self {
            host,
            acp,
            persistence,
            clock,
            root: root.to_path_buf(),
            python,
        })
    }

    fn cwd(&self) -> String {
        self.root.join("cwd").to_string_lossy().to_string()
    }

    fn gate(&self) -> PathBuf {
        self.root.join("gate")
    }

    fn ready(&self) -> PathBuf {
        self.root.join("ready")
    }

    /// Hold the next `session/new` and wait until it reached the agent.
    fn hold_session_new(&self) {
        let _ = std::fs::remove_file(self.ready());
        std::fs::write(self.gate(), "held").unwrap();
    }

    /// Wait (bounded) for the held `session/new` to arrive at the agent.
    async fn session_new_reached_the_agent(&self) {
        for _ in 0..500 {
            if self.ready().exists() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("session/new never reached the mock agent");
    }

    fn spawn_payload(&self) -> Value {
        json!({"config": {
            "configId": "mock",
            "name": "mock-agent",
            "command": self.python,
            "args": ["-u", self.root.join("mock_agent.py").to_string_lossy()],
            "env": {
                "MOCK_GATE": self.gate().to_string_lossy(),
                "MOCK_READY": self.ready().to_string_lossy(),
            },
        }})
    }

    fn create_payload(&self, agent: &str) -> Value {
        json!({"agentId": agent, "cwd": self.cwd()})
    }

    /// Spawn the mock agent through `/ws`; returns its agent id.
    async fn spawn(&self, conn: &mut Conn, command_id: &str) -> String {
        let reply = command(conn, "spawn", "spawn_agent", self.spawn_payload(), command_id).await;
        assert_eq!(reply["ok"], true, "{reply}");
        reply["payload"]["agentId"].as_str().unwrap().to_string()
    }

    async fn session_count(&self, agent: &str) -> usize {
        self.acp
            .agent_session_ids(&AgentId(agent.to_string()))
            .await
            .unwrap()
            .len()
    }

    fn records(&self, session: &str, type_: &str) -> usize {
        self.persistence
            .replay_after(session, 0)
            .unwrap()
            .iter()
            .filter(|record| record.type_ == type_)
            .count()
    }
}

impl Drop for RealHost {
    /// Stop the mock agents and remove the host's temp dir (session files and
    /// the mock script).
    fn drop(&mut self) {
        let _ = std::fs::remove_file(self.gate());
        let acp = Arc::clone(&self.acp);
        tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(acp.kill_all()));
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn temp_root(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("termul-ws-commands-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    root
}

fn send_command(conn: &Conn, id: &str, type_: &str, payload: Value, command_id: &str) {
    conn.peer.send_json(
        &json!({"id": id, "type": type_, "payload": payload, "command_id": command_id}),
    );
}

async fn command(
    conn: &mut Conn,
    id: &str,
    type_: &str,
    payload: Value,
    command_id: &str,
) -> Value {
    send_command(conn, id, type_, payload, command_id);
    conn.peer.wait_reply(id).await
}

/// Read until `n` frames were dropped by the fault filter.
async fn wait_dropped(conn: &mut Conn, n: usize) {
    for _ in 0..500 {
        if conn.peer.dropped_frames() >= n {
            return;
        }
        conn.peer.read_for(Duration::from_millis(10)).await;
    }
    panic!("the reply was never produced (dropped frames: {})", conn.peer.dropped_frames());
}

fn session_id(reply: &Value) -> String {
    assert_eq!(reply["ok"], true, "{reply}");
    reply["payload"]["sessionId"].as_str().unwrap().to_string()
}

/// The reply to the first `create_session` is lost; the resend with the same
/// `commandId` answers with the original session and nothing is created twice.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lost_reply_then_resend_of_create_session_runs_once() {
    let Some(env) = RealHost::start(&temp_root("create"), Duration::from_secs(5)).await else {
        return;
    };
    let mut conn = env.host.connect();
    conn.authenticate().await;
    let agent = env.spawn(&mut conn, "cmd-spawn").await;

    conn.peer.drop_outbound_where(|m| text_contains(m, "\"id\":\"c1\""));
    send_command(&conn, "c1", "create_session", env.create_payload(&agent), "cmd-create");
    wait_dropped(&mut conn, 1).await;
    conn.peer.clear_drop_filter();

    let resend = command(&mut conn, "c1b", "create_session", env.create_payload(&agent), "cmd-create").await;
    assert_eq!(session_id(&resend), "mock-1");
    assert_eq!(env.session_count(&agent).await, 1, "the session was created once");
}

/// Same for `spawn_agent`: one agent process, the resend answers with its id.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lost_reply_then_resend_of_spawn_agent_runs_once() {
    let Some(env) = RealHost::start(&temp_root("spawn"), Duration::from_secs(5)).await else {
        return;
    };
    let mut conn = env.host.connect();
    conn.authenticate().await;

    conn.peer.drop_outbound_where(|m| text_contains(m, "\"id\":\"s1\""));
    send_command(&conn, "s1", "spawn_agent", env.spawn_payload(), "cmd-spawn");
    wait_dropped(&mut conn, 1).await;
    conn.peer.clear_drop_filter();

    let resend = command(&mut conn, "s1b", "spawn_agent", env.spawn_payload(), "cmd-spawn").await;
    assert_eq!(resend["ok"], true, "{resend}");
    let agents = env.acp.list_agents();
    assert_eq!(agents.len(), 1, "one agent process");
    assert_eq!(resend["payload"]["agentId"], agents[0].0);
}

/// A resend on a NEW connection while the first create is still running waits
/// for it and answers with the same session; with a short wait window it
/// answers `{receipt:"in_progress"}` instead, and the next resend gets the
/// outcome. Either way one session exists.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resend_while_the_first_create_is_in_flight_waits_then_answers_in_progress() {
    // Long window: the resend waits out the first run.
    let Some(env) = RealHost::start(&temp_root("flight-long"), Duration::from_secs(10)).await else {
        return;
    };
    let mut first = env.host.connect();
    first.authenticate().await;
    let agent = env.spawn(&mut first, "cmd-spawn").await;
    env.hold_session_new();
    send_command(&first, "a", "create_session", env.create_payload(&agent), "cmd-create");
    env.session_new_reached_the_agent().await;

    let mut second = env.host.connect();
    second.authenticate().await;
    send_command(&second, "b", "create_session", env.create_payload(&agent), "cmd-create");
    // Bounded settle: lets the resend reach the in-flight entry before the
    // first run is released (the wait itself has no externally visible signal).
    tokio::time::sleep(Duration::from_millis(200)).await;
    std::fs::remove_file(env.gate()).unwrap();
    let (a, b) = (first.peer.wait_reply("a").await, second.peer.wait_reply("b").await);
    assert_eq!(session_id(&a), session_id(&b));
    assert_eq!(env.session_count(&agent).await, 1);

    // Short window: `in_progress`, then the stored outcome.
    let Some(env) = RealHost::start(&temp_root("flight-short"), Duration::from_millis(150)).await else {
        return;
    };
    let mut first = env.host.connect();
    first.authenticate().await;
    let agent = env.spawn(&mut first, "cmd-spawn").await;
    env.hold_session_new();
    send_command(&first, "a", "create_session", env.create_payload(&agent), "cmd-create");
    env.session_new_reached_the_agent().await;

    let mut second = env.host.connect();
    second.authenticate().await;
    let pending = command(&mut second, "b", "create_session", env.create_payload(&agent), "cmd-create").await;
    assert_eq!(pending["ok"], true, "{pending}");
    assert_eq!(pending["payload"]["receipt"], "in_progress", "{pending}");
    std::fs::remove_file(env.gate()).unwrap();
    let done = first.peer.wait_reply("a").await;
    let again = command(&mut second, "b2", "create_session", env.create_payload(&agent), "cmd-create").await;
    assert_eq!(session_id(&again), session_id(&done));
    assert_eq!(env.session_count(&agent).await, 1);
}

/// After the ledger evicted a create's outcome (and again after it forgot the
/// bare id) the resend finds the session through its stamped `commandId`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resend_of_an_evicted_create_finds_the_stamped_session() {
    let Some(env) = RealHost::start(&temp_root("evict-create"), Duration::from_secs(5)).await else {
        return;
    };
    let mut conn = env.host.connect();
    conn.authenticate().await;
    let agent = env.spawn(&mut conn, "cmd-spawn").await;
    let created = command(&mut conn, "c1", "create_session", env.create_payload(&agent), "cmd-create").await;
    let session = session_id(&created);

    env.clock.advance(RETENTION + Duration::from_secs(1));
    let after_outcome = command(&mut conn, "c2", "create_session", env.create_payload(&agent), "cmd-create").await;
    assert_eq!(session_id(&after_outcome), session);
    let visible = |reply: &Value| reply["visible_at"].as_u64().unwrap_or(0);
    assert!(visible(&after_outcome) > 0, "the entity answer carries visible_at: {after_outcome}");
    assert!(visible(&after_outcome) >= visible(&created), "{created} vs {after_outcome}");

    env.clock.advance(RETENTION * BARE_HORIZON_FACTOR);
    let after_bare = command(&mut conn, "c3", "create_session", env.create_payload(&agent), "cmd-create").await;
    assert_eq!(session_id(&after_bare), session);
    assert_eq!(env.session_count(&agent).await, 1, "never created twice");
}

/// After the ledger evicted a `spawn_agent` outcome (and again after it forgot
/// the bare id) the resend finds the live agent through its stamp and answers
/// with the original spawn facts; no second agent process exists.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resend_of_an_evicted_spawn_agent_finds_the_stamped_agent() {
    let Some(env) = RealHost::start(&temp_root("evict-spawn"), Duration::from_secs(5)).await else {
        return;
    };
    let mut conn = env.host.connect();
    conn.authenticate().await;
    let first = command(&mut conn, "s1", "spawn_agent", env.spawn_payload(), "cmd-spawn").await;
    assert_eq!(first["ok"], true, "{first}");

    for (tag, advance) in [
        ("s2", RETENTION + Duration::from_secs(1)),
        ("s3", RETENTION * BARE_HORIZON_FACTOR),
    ] {
        env.clock.advance(advance);
        let resend = command(&mut conn, tag, "spawn_agent", env.spawn_payload(), "cmd-spawn").await;
        assert_eq!(resend["ok"], true, "{resend}");
        for field in ["agentId", "authMethods", "hostAuthReady", "stableNamespace"] {
            assert_eq!(resend["payload"][field], first["payload"][field], "{tag} {field}");
        }
    }
    assert_eq!(env.acp.list_agents().len(), 1, "never spawned twice");
}

/// After the ledger evicted a NON-create's outcome the resend is
/// `outcome_unknown` and is not executed; before eviction it replays the
/// stored outcome (with its `visible_at`) without executing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resend_of_an_evicted_non_create_is_outcome_unknown_and_never_runs() {
    let Some(env) = RealHost::start(&temp_root("evict-command"), Duration::from_secs(5)).await else {
        return;
    };
    let mut conn = env.host.connect();
    conn.authenticate().await;
    let agent = env.spawn(&mut conn, "cmd-spawn").await;
    let session = session_id(
        &command(&mut conn, "c1", "create_session", env.create_payload(&agent), "cmd-create").await,
    );
    let switch = json!({
        "sessionId": session, "fromConfigId": "mock", "toConfigId": "other",
        "newSessionId": "next", "summaryText": "handoff",
    });

    let first = command(&mut conn, "m1", "record_agent_switch", switch.clone(), "cmd-switch").await;
    assert_eq!(first["ok"], true, "{first}");
    assert!(first["visible_at"].as_u64().is_some_and(|seq| seq > 0), "{first}");
    assert_eq!(env.records(&session, "agent_switch"), 1);

    let replay = command(&mut conn, "m2", "record_agent_switch", switch.clone(), "cmd-switch").await;
    assert_eq!(replay["ok"], true, "{replay}");
    assert_eq!(replay["visible_at"], first["visible_at"]);
    assert_eq!(env.records(&session, "agent_switch"), 1, "a replay does not execute");

    env.clock.advance(RETENTION + Duration::from_secs(1));
    let evicted = command(&mut conn, "m3", "record_agent_switch", switch, "cmd-switch").await;
    assert_eq!(evicted["ok"], false, "{evicted}");
    assert_eq!(evicted["err"]["code"], "outcome_unknown", "{evicted}");
    assert_eq!(env.records(&session, "agent_switch"), 1, "never re-executed");
}

/// A host restart empties the ledger; a create resend still finds the
/// persisted session by its stamp and creates nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resend_of_a_create_after_a_host_restart_returns_the_persisted_session() {
    let root = temp_root("restart");
    let Some(before) = RealHost::start(&root, Duration::from_secs(5)).await else {
        return;
    };
    let mut conn = before.host.connect();
    conn.authenticate().await;
    let agent = before.spawn(&mut conn, "cmd-spawn").await;
    let session = session_id(
        &command(&mut conn, "c1", "create_session", before.create_payload(&agent), "cmd-create").await,
    );
    before.persistence.flush_session(&session).await.unwrap();

    let after = RealHost::start(&root, Duration::from_secs(5)).await.unwrap();
    let mut conn = after.host.connect();
    conn.authenticate().await;
    let new_agent = after.spawn(&mut conn, "cmd-spawn-2").await;
    let resend = command(&mut conn, "c2", "create_session", after.create_payload(&new_agent), "cmd-create").await;

    assert_eq!(session_id(&resend), session, "the persisted session is returned");
    assert_eq!(after.session_count(&new_agent).await, 0, "nothing was created");
}

/// The same `commandId` for a different request is `command_conflict`: not
/// replayed and not executed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_same_command_id_for_another_request_is_a_conflict() {
    let Some(env) = RealHost::start(&temp_root("conflict"), Duration::from_secs(5)).await else {
        return;
    };
    let mut conn = env.host.connect();
    conn.authenticate().await;
    let agent = env.spawn(&mut conn, "cmd-spawn").await;
    session_id(
        &command(&mut conn, "c1", "create_session", env.create_payload(&agent), "cmd-create").await,
    );

    let other_cwd = json!({"agentId": agent, "cwd": env.root.to_string_lossy()});
    let conflict = command(&mut conn, "c2", "create_session", other_cwd, "cmd-create").await;
    assert_eq!(conflict["ok"], false, "{conflict}");
    assert_eq!(conflict["err"]["code"], "command_conflict", "{conflict}");
    assert_eq!(env.session_count(&agent).await, 1);
}

fn fake_host() -> Host {
    Host::new(|acp, sessions| {
        acp.install_test_agent_with_scripts(
            AgentId(AGENT.to_string()),
            sessions,
            vec![],
            false,
            vec![FakeAuth::ok_after(Duration::ZERO)],
        );
    })
}

/// A handler that dies mid-flight (panic: the connection closes) leaves the
/// command `Unknown`: the resend on a new connection is `outcome_unknown`,
/// never executed again.
#[tokio::test(start_paused = true)]
async fn a_handler_that_dies_mid_flight_is_never_re_executed() {
    let host = fake_host();
    let mut conn = host.connect();
    conn.authenticate().await;
    send_command(&conn, "boom", "panic_for_test", json!({}), "cmd-boom");
    conn.peer.read_for(Duration::from_secs(1)).await;
    assert!(conn.relay_finished().await, "the connection survived a handler panic");

    let mut next = host.connect();
    next.authenticate().await;
    let resend = command(&mut next, "boom2", "panic_for_test", json!({}), "cmd-boom").await;
    assert_eq!(resend["ok"], false, "{resend}");
    assert_eq!(resend["err"]["code"], "outcome_unknown", "{resend}");
}

/// A rejection replays with its ORIGINAL code even if the cause has since
/// gone away (the agent appears after the first, refused, attempt); a fresh
/// `commandId` for the same request now succeeds.
#[tokio::test(start_paused = true)]
async fn a_rejection_replays_with_its_original_code() {
    let host = fake_host();
    let mut conn = host.connect();
    conn.authenticate().await;
    let payload = json!({"agentId": "ghost", "sessionId": "s1"});

    let refused = command(&mut conn, "p1", "promote_session", payload.clone(), "cmd-promote").await;
    assert_eq!(refused["err"]["code"], "not_found", "{refused}");

    host.state.acp.install_test_agent_with_sessions(
        AgentId("ghost".to_string()),
        HashSet::from(["s1".to_string()]),
    );
    let replay = command(&mut conn, "p2", "promote_session", payload.clone(), "cmd-promote").await;
    assert_eq!(replay["err"]["code"], "not_found", "replayed, not re-executed: {replay}");

    let fresh = command(&mut conn, "p3", "promote_session", payload, "cmd-promote-2").await;
    assert_eq!(fresh["ok"], true, "{fresh}");
}

/// A credential-bearing kind is receipt-only: the first reply carries its
/// payload, the replay carries none (just the `accepted` receipt).
#[tokio::test(start_paused = true)]
async fn credential_bearing_kinds_replay_without_a_payload() {
    let host = fake_host();
    let mut conn = host.connect();
    conn.authenticate().await;
    let payload = json!({"agentId": AGENT, "methodId": "oauth"});

    let first = command(&mut conn, "a1", "authenticate_agent", payload.clone(), "cmd-auth").await;
    assert_eq!(first["ok"], true, "{first}");
    assert_eq!(first["payload"], json!({}));

    let replay = command(&mut conn, "a2", "authenticate_agent", payload, "cmd-auth").await;
    assert_eq!(replay["ok"], true, "{replay}");
    assert_eq!(replay["payload"], json!({"receipt": "accepted"}));
}

/// A malformed `commandId` is refused with `invalid_command_id` before
/// anything runs or is recorded; a read ignores the field.
#[tokio::test(start_paused = true)]
async fn a_malformed_command_id_is_refused_and_leaves_no_entry() {
    let host = fake_host();
    let mut conn = host.connect();
    conn.authenticate().await;
    let payload = json!({"agentId": AGENT, "sessionId": SESSION});
    let too_long = "a".repeat(129);

    for bad in ["has space", "semi;colon", too_long.as_str()] {
        for type_ in ["promote_session", "set_mode"] {
            let reply = command(&mut conn, "x", type_, payload.clone(), bad).await;
            assert_eq!(reply["err"]["code"], "invalid_command_id", "{type_} {bad}: {reply}");
        }
    }
    let read = command(&mut conn, "r", "list_agents", json!({}), "has space").await;
    assert_eq!(read["ok"], true, "{read}");
    assert_eq!(host.relay.ledger().counts(), (0, 0, 0), "nothing was recorded");
}

/// `send_prompt`'s `turnId` IS its `commandId`: a `commandId` alone names the
/// turn (a resend is the accepted receipt), and a conflicting pair is refused
/// before any claim.
#[tokio::test(start_paused = true)]
async fn send_prompt_resolves_its_turn_id_and_command_id_consistently() {
    let host = fake_host();
    let mut conn = host.connect();
    conn.authenticate().await;
    let prompt = json!({"agentId": AGENT, "sessionId": SESSION, "text": "hello"});

    let first = command(&mut conn, "p1", "send_prompt", prompt.clone(), "turn-1").await;
    assert_eq!(first["ok"], true, "{first}");
    let resend = command(&mut conn, "p2", "send_prompt", prompt.clone(), "turn-1").await;
    assert_eq!(resend["payload"]["receipt"], "accepted", "{resend}");

    let mut mismatched = prompt.clone();
    mismatched["turnId"] = json!("turn-other");
    let refused = command(&mut conn, "p3", "send_prompt", mismatched, "turn-2").await;
    assert_eq!(refused["err"]["code"], "invalid_command_id", "{refused}");

    // A malformed commandId is refused before it can become a turn id.
    let before = host.relay.session_watermark(SESSION);
    let malformed = command(&mut conn, "p4", "send_prompt", prompt, "not valid!").await;
    assert_eq!(malformed["err"]["code"], "invalid_command_id", "{malformed}");
    assert_eq!(host.relay.session_watermark(SESSION), before, "no turn was started");
    assert_eq!(host.relay.ledger().counts(), (0, 0, 0), "TurnWatermark owns prompts");
}

/// A one-shot ticket answer is a command: with a `commandId` a lost reply +
/// resend replays the original ok (not `already_resolved`), while another
/// connection answering the same ticket later still gets `already_resolved`.
#[tokio::test(start_paused = true)]
async fn a_resent_ticket_answer_replays_ok_but_another_answerer_is_already_resolved() {
    use crate::web::sink::{AcpEvent, EventSink};

    let host = Host::new(|_, _| {});
    host.relay
        .set_rendezvous(Arc::new(crate::web::permissions::PermissionRendezvous::default()));
    let mut conn = host.connect();
    conn.authenticate().await;
    conn.subscribe("sub").await;
    host.relay.emit(&AcpEvent {
        sid: Some(SESSION.to_string()),
        type_: "acp:permission_request",
        payload: json!({
            "agentId": "a1", "sessionId": SESSION, "requestId": "perm-1",
            "toolCall": {"toolCallId": "tc-1"}, "options": [{"optionId": "allow"}],
        }),
    });
    let answer = json!({"agentId": "a1", "requestId": "perm-1", "optionId": "allow"});

    conn.peer.drop_outbound_where(|m| text_contains(m, "\"id\":\"r1\""));
    send_command(&conn, "r1", "respond_permission", answer.clone(), "cmd-answer");
    for _ in 0..50 {
        if conn.peer.dropped_frames() >= 1 {
            break;
        }
        conn.peer.read_for(Duration::from_millis(10)).await;
    }
    assert_eq!(conn.peer.dropped_frames(), 1, "the first reply was lost");
    conn.peer.clear_drop_filter();

    let resend = command(&mut conn, "r1b", "respond_permission", answer.clone(), "cmd-answer").await;
    assert_eq!(resend["ok"], true, "the resend replays the original ok: {resend}");

    let mut other = host.connect();
    other.authenticate().await;
    let later = other.request("r2", "respond_permission", answer).await;
    assert_eq!(later["err"]["code"], "already_resolved", "{later}");
}
