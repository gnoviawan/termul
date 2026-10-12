//! AD-16 prompt-turn cases for the shared prompt-turn service, driven through
//! the in-crate fake agent (`FakeDriver`: real `DriverState` single-flight,
//! accept hook, and the same terminator helpers as the real command loop).

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use agent_client_protocol::schema::v1::{ContentBlock, StopReason, TextContent};
use tokio::sync::oneshot;

use super::prompt_turn::*;
use crate::acp::manager::FakeTurn;
use crate::acp::session_persistence::{
    PersistedEventRecord, SessionPersistence, SessionRegistration, WriterGate,
};
use crate::acp::{AcpManager, AgentId, SessionId};
use crate::web::permissions::TurnClaim;
use crate::web::sink::ReplayResult;
use crate::web::WsRelaySink;

const AGENT: &str = "agent-turns";
const SESSION: &str = "sess-turns";

struct Env {
    acp: Arc<AcpManager>,
    relay: Arc<WsRelaySink>,
    persistence: Arc<SessionPersistence>,
}

async fn env(turns: Vec<FakeTurn>, emit_chunk: bool) -> Env {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("termul-prompt-turn-{stamp}"));
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    persistence
        .register_session(SessionRegistration {
            session_id: SESSION.to_string(),
            stable_agent_namespace: None,
            runtime_agent_id: None,
            project_id: None,
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    let relay = Arc::new(WsRelaySink::with_persistence(64, persistence.clone()));
    // The relay is a sink of the manager, exactly as on the server/desktop:
    // driver events (chunks, terminators) reach it through `fan_out`.
    let acp = Arc::new(AcpManager::new(vec![relay.clone()]));
    let mut sessions = HashSet::new();
    sessions.insert(SESSION.to_string());
    acp.install_test_agent_with_turns(AgentId(AGENT.to_string()), sessions, turns, emit_chunk);
    Env {
        acp,
        relay,
        persistence,
    }
}

fn request(turn_id: Option<&str>) -> PromptTurnRequest {
    let blocks = vec![ContentBlock::Text(TextContent::new("hello"))];
    PromptTurnRequest {
        agent_id: AgentId(AGENT.to_string()),
        session_id: SessionId(SESSION.to_string()),
        content: blocks.clone(),
        record_content: blocks,
        turn_id: turn_id.map(str::to_string),
    }
}

fn hold() -> (FakeTurn, oneshot::Sender<()>, oneshot::Receiver<()>) {
    let (release_tx, release_rx) = oneshot::channel();
    let (entered_tx, entered_rx) = oneshot::channel();
    (
        FakeTurn::Hold {
            release: release_rx,
            entered: entered_tx,
        },
        release_tx,
        entered_rx,
    )
}

async fn records(env: &Env) -> Vec<PersistedEventRecord> {
    env.persistence.flush_session(SESSION).await.unwrap();
    env.persistence
        .replay_after_async(SESSION.to_string(), 0)
        .await
        .unwrap()
}

fn count(records: &[PersistedEventRecord], type_: &str) -> usize {
    records.iter().filter(|r| r.type_ == type_).count()
}

fn stop_reasons(records: &[PersistedEventRecord]) -> Vec<String> {
    records
        .iter()
        .filter(|r| r.type_ == "prompt_complete")
        .map(|r| r.payload["stopReason"].as_str().unwrap().to_string())
        .collect()
}

fn receipt(reply: &PromptReply) -> serde_json::Value {
    serde_json::to_value(reply).unwrap()
}

/// The reply to a dropped connection: the accepted turn keeps running (the
/// carrier's spawned task holds the claim) and the client resends the same
/// `turnId`. Both before and after the turn finishes the resend is a receipt,
/// the prompt is not re-run, and exactly one `user_prompt` exists.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resend_after_dropped_reply_is_a_receipt_and_never_reruns() {
    let (turn, release, entered) = hold();
    let env = env(vec![turn], false).await;

    let PromptAdmission::Running(running) = accept_prompt_turn(&env.acp, &env.relay, request(Some("t1")))
        .await
        .unwrap_or_else(|_| panic!("first send accepted"))
    else {
        panic!("first send must run");
    };
    // The WS connection drops here: nobody awaits the reply, the spawned
    // completion task (as in `dispatch_connection_text`) keeps the claim.
    let acp = env.acp.clone();
    let completion = tokio::spawn(async move { complete_prompt_turn(&acp, running).await });
    entered.await.unwrap();

    let PromptAdmission::Receipt(in_flight) = accept_prompt_turn(&env.acp, &env.relay, request(Some("t1")))
        .await
        .unwrap_or_else(|_| panic!("resend must not error"))
    else {
        panic!("resend while running must be a receipt");
    };
    assert_eq!(receipt(&in_flight), serde_json::json!({"receipt": "in_progress"}));

    release.send(()).unwrap();
    assert_eq!(completion.await.unwrap().unwrap(), StopReason::EndTurn);

    let PromptAdmission::Receipt(done) = accept_prompt_turn(&env.acp, &env.relay, request(Some("t1")))
        .await
        .unwrap_or_else(|_| panic!("resend must not error"))
    else {
        panic!("resend after completion must be a receipt");
    };
    assert_eq!(receipt(&done), serde_json::json!({"receipt": "accepted"}));

    let log = records(&env).await;
    assert_eq!(count(&log, "user_prompt"), 1, "resends add no user_prompt");
    assert_eq!(stop_reasons(&log), vec!["end_turn"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn different_turn_id_while_running_is_busy_not_a_receipt() {
    let (turn, release, entered) = hold();
    let env = env(vec![turn], false).await;
    let PromptAdmission::Running(running) = accept_prompt_turn(&env.acp, &env.relay, request(Some("t1")))
        .await
        .unwrap_or_else(|_| panic!("accepted"))
    else {
        panic!("must run");
    };
    entered.await.unwrap();

    let busy = accept_prompt_turn(&env.acp, &env.relay, request(Some("t2"))).await;
    assert!(matches!(busy, Err(PromptTurnError::Busy { .. })));
    // The busy reply on the desktop boundary keeps the stable renderer code.
    assert!(PromptTurnError::Busy {
        session_id: SESSION.to_string()
    }
    .into_message()
    .starts_with("ACP_TURN_IN_PROGRESS"));

    release.send(()).unwrap();
    complete_prompt_turn(&env.acp, running).await.unwrap();
    let log = records(&env).await;
    assert_eq!(count(&log, "user_prompt"), 1, "busy prompt leaves no record");
}

/// The driver rejects a prompt while a turn is active (here: a second carrier
/// with its own claim table, so the claim passes and the driver is the one
/// refusing): explicit error, NO `user_prompt` record, claim released.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn driver_rejected_prompt_leaves_no_user_prompt_and_releases_claim() {
    let (turn, release, entered) = hold();
    let env = env(vec![turn], false).await;
    let PromptAdmission::Running(running) = accept_prompt_turn(&env.acp, &env.relay, request(Some("t1")))
        .await
        .unwrap_or_else(|_| panic!("accepted"))
    else {
        panic!("must run");
    };
    entered.await.unwrap();

    let other_relay = Arc::new(WsRelaySink::with_persistence(64, env.persistence.clone()));
    let before = other_relay.session_watermark(SESSION);
    let rejected = accept_prompt_turn(&env.acp, &other_relay, request(Some("t2"))).await;
    match rejected {
        Err(PromptTurnError::Failed(message)) => {
            assert!(message.starts_with("ACP_TURN_IN_PROGRESS"), "{message}");
        }
        _ => panic!("driver rejection must surface as an error"),
    }
    assert_eq!(
        other_relay.session_watermark(SESSION),
        before,
        "a rejected prompt must not be sequenced"
    );
    assert_eq!(
        other_relay
            .turn_watermark()
            .claim_turn(SESSION, Some("t2")),
        TurnClaim::Claimed,
        "a rejected prompt releases its claim"
    );

    release.send(()).unwrap();
    complete_prompt_turn(&env.acp, running).await.unwrap();
    let log = records(&env).await;
    assert_eq!(count(&log, "user_prompt"), 1);
}

/// Error, timeout, crash and cancel turns each leave exactly one
/// `prompt_complete` with the right stop reason, a resend of the finished
/// turn is `accepted`, and the next `send_prompt` is accepted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn error_timeout_crash_and_cancel_turns_end_with_exactly_one_terminator() {
    let cases: Vec<(FakeTurn, &str, bool)> = vec![
        (FakeTurn::Fail("rpc failed".to_string()), "error", false),
        (FakeTurn::Timeout, "timeout", false),
        (FakeTurn::Crash, "crashed", false),
        (FakeTurn::Stop(StopReason::Cancelled), "cancelled", true),
    ];
    for (turn, expected, ok) in cases {
        let env = env(vec![turn], false).await;
        let result = run_prompt_turn(&env.acp, &env.relay, request(Some("t1"))).await;
        assert_eq!(result.is_ok(), ok, "{expected}: {result:?}");

        let log = records(&env).await;
        assert_eq!(count(&log, "user_prompt"), 1, "{expected}");
        assert_eq!(stop_reasons(&log), vec![expected], "{expected}");
        let terminator = log
            .iter()
            .find(|r| r.type_ == "prompt_complete")
            .expect("terminator");
        assert_eq!(terminator.payload["turnId"], "t1", "{expected}");

        // Resend of the finished (even failed) turn: accepted, not re-run.
        let resend = run_prompt_turn(&env.acp, &env.relay, request(Some("t1")))
            .await
            .expect("resend is a receipt");
        assert_eq!(receipt(&resend), serde_json::json!({"receipt": "accepted"}));

        // The claim was released: the next prompt runs.
        let next = run_prompt_turn(&env.acp, &env.relay, request(Some("t2")))
            .await
            .expect("next prompt accepted");
        assert_eq!(receipt(&next), serde_json::json!("end_turn"), "{expected}");
        let log = records(&env).await;
        assert_eq!(
            stop_reasons(&log),
            vec![expected, "end_turn"],
            "{expected}: one terminator per turn"
        );
    }
}

/// SINK-F3: the `user_prompt` is sequenced and fanned out when the driver
/// accepts the prompt, so it can never be delivered after a chunk of its own
/// turn — even when the driver emits a chunk right after accepting.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn user_prompt_is_never_delivered_after_a_chunk_of_its_turn() {
    let env = env(Vec::new(), true).await;
    let (_client, mut rx, replay) = env.relay.subscribe(SESSION, Some(0)).await;
    assert!(matches!(replay, ReplayResult::Ok(_)));

    run_prompt_turn(&env.acp, &env.relay, request(Some("t1")))
        .await
        .expect("turn runs");

    let mut order = Vec::new();
    while let Ok(event) = tokio::time::timeout(std::time::Duration::from_millis(500), rx.recv()).await {
        let Some(event) = event else { break };
        order.push((event.seq, event.type_.clone()));
        if event.type_ == "prompt_complete" {
            break;
        }
    }
    let types: Vec<&str> = order.iter().map(|(_, t)| t.as_str()).collect();
    assert_eq!(types, vec!["user_prompt", "message_chunk", "prompt_complete"]);
    assert!(order.windows(2).all(|w| w[0].0 < w[1].0), "{order:?}");
}

/// The accepted `user_prompt` is durable before the call returns (the flush is
/// awaited after acceptance).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn accepted_user_prompt_is_durable_when_accept_returns() {
    let (turn, release, entered) = hold();
    let env = env(vec![turn], false).await;
    let PromptAdmission::Running(running) = accept_prompt_turn(&env.acp, &env.relay, request(Some("t1")))
        .await
        .unwrap_or_else(|_| panic!("accepted"))
    else {
        panic!("must run");
    };
    entered.await.unwrap();
    // Read straight from the durable log without any extra flush.
    let log = env
        .persistence
        .replay_after_async(SESSION.to_string(), 0)
        .await
        .unwrap();
    assert_eq!(count(&log, "user_prompt"), 1);
    assert_eq!(log[0].payload["turnId"], "t1");
    release.send(()).unwrap();
    complete_prompt_turn(&env.acp, running).await.unwrap();
}

/// The carrier may drop the accept future while the post-accept flush is still
/// pending (peer gone → read task aborted). The turn is already running, so
/// the claim must stay held: a same-`turnId` resend is `in_progress` (never
/// `Claimed`, which would hit the driver and be rate-limited), and once the
/// detached task finishes the turn a resend is `accepted`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropped_accept_during_post_accept_flush_keeps_the_turn_claimed() {
    let (turn, release, entered) = hold();
    let env = env(vec![turn], false).await;
    let (gate_tx, gate_rx) = oneshot::channel();
    let gate = WriterGate::new(gate_tx);
    env.persistence.set_writer_gate(Arc::clone(&gate));

    let (acp, relay) = (env.acp.clone(), env.relay.clone());
    let accept = tokio::spawn(async move {
        accept_prompt_turn(&acp, &relay, request(Some("t1")))
            .await
            .map(|_| ())
    });
    // The writer is parked on the accepted `user_prompt` append, so the flush
    // queued behind it cannot finish: the accept future is mid-flush.
    gate_rx.await.expect("writer blocked on the accepted append");
    entered.await.unwrap();
    accept.abort();
    assert!(accept.await.unwrap_err().is_cancelled());

    let PromptAdmission::Receipt(in_flight) =
        accept_prompt_turn(&env.acp, &env.relay, request(Some("t1")))
            .await
            .unwrap_or_else(|_| panic!("resend must not error"))
    else {
        panic!("resend of the running turn must be a receipt");
    };
    assert_eq!(receipt(&in_flight), serde_json::json!({"receipt": "in_progress"}));

    gate.release();
    release.send(()).unwrap();
    let mut accepted = None;
    for _ in 0..200 {
        let PromptAdmission::Receipt(reply) =
            accept_prompt_turn(&env.acp, &env.relay, request(Some("t1")))
                .await
                .unwrap_or_else(|_| panic!("resend must not error"))
        else {
            panic!("resend of the same turn never runs it again");
        };
        if receipt(&reply) == serde_json::json!({"receipt": "accepted"}) {
            accepted = Some(reply);
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    assert!(accepted.is_some(), "the detached task completes the turn");

    let log = records(&env).await;
    assert_eq!(count(&log, "user_prompt"), 1);
    assert_eq!(stop_reasons(&log), vec!["end_turn"]);
}
