//! `/terminal/ws` command-ledger behavior against a real `PtyManager`: lost
//! reply + resend, eviction, concurrent same-id race, spawn failure then
//! retry, kill/rotate/revoke/write replay, conflicts, refusals, and the
//! no-credential-in-the-ledger rule.

use std::time::Duration;

use super::tests::{attach_terminal, gate_test_ctx, gate_test_state};
use super::*;
use crate::web::command_ledger::terminal::{self as ledgered};
use crate::web::command_ledger::test_clock::ManualClock;
use crate::web::command_ledger::{Begin, CommandLedger};
use crate::web::sink::WsRelaySink;

const RETENTION: Duration = Duration::from_secs(600);

type Reply = Result<Value, (&'static str, String)>;

fn state_with_clock() -> (AppState, Arc<ManualClock>) {
    let mut state = gate_test_state(None);
    let clock = Arc::new(ManualClock::default());
    state.relay = Arc::new(
        WsRelaySink::new().with_ledger(CommandLedger::with_clock(RETENTION, clock.clone())),
    );
    (state, clock)
}

fn request(type_: &str, payload: Value, command_id: Option<&str>) -> Request {
    Request {
        id: "req".to_string(),
        type_: type_.to_string(),
        payload,
        command_id: command_id.map(str::to_string),
    }
}

async fn call(state: &AppState, ctx: &mut ConnectionContext, request: Request) -> Reply {
    let (tx, _rx) = mpsc::channel(8);
    handle(request, state, &tx, ctx).await
}

async fn spawn(
    state: &AppState,
    ctx: &mut ConnectionContext,
    command_id: &str,
    project: &str,
) -> Reply {
    call(
        state,
        ctx,
        request("spawn", json!({ "projectId": project }), Some(command_id)),
    )
    .await
}

fn code(reply: Reply) -> &'static str {
    reply.expect_err("expected a refusal").0
}

fn str_of(value: &Value, key: &str) -> String {
    value[key].as_str().expect(key).to_string()
}

fn entries(state: &AppState) -> (usize, usize, usize) {
    state.relay.ledger().counts()
}

#[tokio::test]
async fn a_lost_reply_spawn_resend_returns_the_same_terminal_with_a_fresh_claim() {
    let (state, _) = state_with_clock();
    let mut first_conn = gate_test_ctx(true);
    let first = spawn(&state, &mut first_conn, "spawn-1", "p").await.unwrap();
    let id = str_of(&first, "id");
    let claim = str_of(&first, "claim");
    // The first connection is a live viewer, so the resend gets a SHARED claim.
    let (tx, _rx) = mpsc::channel(8);
    attach_terminal(&state, &tx, &mut first_conn, &id, &claim).await;

    let mut second_conn = gate_test_ctx(true);
    let resent = spawn(&state, &mut second_conn, "spawn-1", "p").await.unwrap();

    assert_eq!(str_of(&resent, "id"), id, "the resend never spawns a second PTY");
    let fresh = str_of(&resent, "claim");
    assert_ne!(fresh, claim, "the resender gets a fresh claim");
    assert!(state.pty.verify_claim(&id, &claim).is_ok(), "the viewer's claim survives");
    assert!(state.pty.verify_claim(&id, &fresh).is_ok());
    assert_eq!(state.pty.get_all().len(), 1);
    assert!(
        !second_conn.is_authorized(&id),
        "a resend alone authorizes nothing; attaching with the fresh claim does"
    );
    attach_terminal(&state, &tx, &mut second_conn, &id, &fresh).await;
    assert!(second_conn.is_authorized(&id));

    state.pty.force_kill(&id).await.unwrap();
}

#[tokio::test]
async fn a_spawn_resend_after_ledger_eviction_finds_the_live_pty_by_its_stamped_command_id() {
    let (state, clock) = state_with_clock();
    let mut conn = gate_test_ctx(true);
    let first = spawn(&state, &mut conn, "spawn-1", "p").await.unwrap();
    let id = str_of(&first, "id");

    // The outcome aged into a bare id, then the id was forgotten altogether.
    for advance in [RETENTION + Duration::from_secs(1), RETENTION * 8] {
        clock.advance(advance);
        let resent = spawn(&state, &mut conn, "spawn-1", "p").await.unwrap();
        assert_eq!(str_of(&resent, "id"), id);
        assert!(!str_of(&resent, "claim").is_empty());
    }
    assert_eq!(state.pty.get_all().len(), 1);

    state.pty.force_kill(&id).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_same_id_spawns_create_one_pty() {
    let (state, _) = state_with_clock();
    let mut a = gate_test_ctx(true);
    let mut b = gate_test_ctx(true);

    let (first, second) = tokio::join!(
        spawn(&state, &mut a, "spawn-race", "p"),
        spawn(&state, &mut b, "spawn-race", "p")
    );
    let (first, second) = (first.unwrap(), second.unwrap());

    assert_eq!(str_of(&first, "id"), str_of(&second, "id"));
    assert_eq!(state.pty.get_all().len(), 1, "one PTY for one command");
    let id = str_of(&first, "id");
    assert_eq!(
        [a.is_authorized(&id), b.is_authorized(&id)]
            .iter()
            .filter(|authorized| **authorized)
            .count(),
        1,
        "exactly one run executed the spawn"
    );

    state.pty.force_kill(&id).await.unwrap();
}

#[tokio::test]
async fn a_failed_spawn_releases_its_id_so_a_retry_executes() {
    let (state, _) = state_with_clock();
    let mut conn = gate_test_ctx(true);
    let dir = std::env::temp_dir().join(format!("termul-spawn-retry-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let payload = json!({ "projectId": "p", "cwd": dir.to_string_lossy() });

    let failed = call(&state, &mut conn, request("spawn", payload.clone(), Some("spawn-1"))).await;
    assert_eq!(code(failed), "SPAWN_FAILED");
    assert_eq!(entries(&state), (0, 0, 0), "a failed spawn leaves no ledger entry");

    std::fs::create_dir_all(&dir).unwrap();
    let retried = call(&state, &mut conn, request("spawn", payload, Some("spawn-1"))).await;
    let id = str_of(&retried.expect("the identical retry executes"), "id");
    assert_eq!(state.pty.get_all().len(), 1);

    state.pty.force_kill(&id).await.unwrap();
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_spawn_resend_after_the_pty_is_gone_is_outcome_unknown_and_never_respawns() {
    let (state, _) = state_with_clock();
    let mut conn = gate_test_ctx(true);
    let first = spawn(&state, &mut conn, "spawn-1", "p").await.unwrap();
    state.pty.force_kill(&str_of(&first, "id")).await.unwrap();

    assert_eq!(code(spawn(&state, &mut conn, "spawn-1", "p").await), "OUTCOME_UNKNOWN");
    assert!(state.pty.get_all().is_empty());
}

#[tokio::test]
async fn a_repeat_kill_with_the_same_command_id_answers_ok_and_other_callers_are_refused() {
    let (state, _) = state_with_clock();
    let mut owner = gate_test_ctx(true);
    let id = str_of(&spawn(&state, &mut owner, "spawn-1", "p").await.unwrap(), "id");

    // An unauthorized caller leaves no entry and never kills; the id stays free.
    let mut attacker = gate_test_ctx(true);
    let refused = call(
        &state,
        &mut attacker,
        request("kill", json!({ "terminalId": id }), Some("kill-1")),
    )
    .await;
    assert_eq!(code(refused), "UNAUTHORIZED");
    assert!(state.pty.get(&id).is_some());

    let kill = || request("kill", json!({ "terminalId": id }), Some("kill-1"));
    assert_eq!(call(&state, &mut owner, kill()).await, Ok(Value::Null));
    assert!(state.pty.get(&id).is_none());
    // The first kill detached the terminal; the resend is answered by the ledger.
    assert_eq!(call(&state, &mut owner, kill()).await, Ok(Value::Null));
    // Without that id the repeat is the unchanged generic refusal.
    let other = request("kill", json!({ "terminalId": id }), Some("kill-2"));
    assert_eq!(code(call(&state, &mut owner, other).await), "UNAUTHORIZED");
}

#[tokio::test]
async fn a_rotate_resend_is_outcome_unknown_and_no_claim_is_in_the_ledger() {
    let (state, _) = state_with_clock();
    let mut conn = gate_test_ctx(true);
    let spawned = spawn(&state, &mut conn, "spawn-1", "p").await.unwrap();
    let id = str_of(&spawned, "id");
    let claim = str_of(&spawned, "claim");
    let rotate = |claim: &str| {
        request(
            "rotate_claim",
            json!({ "terminalId": id, "claim": claim }),
            Some("rot-1"),
        )
    };

    let rotated = str_of(&call(&state, &mut conn, rotate(&claim)).await.unwrap(), "claim");
    assert_ne!(rotated, claim);
    assert_eq!(code(call(&state, &mut conn, rotate(&claim)).await), "OUTCOME_UNKNOWN");
    assert!(state.pty.verify_claim(&id, &rotated).is_ok(), "the replay rotated nothing");

    // Neither the spawn nor the rotation entry holds any claim.
    let options = SpawnOptions {
        project_id: Some("p".to_string()),
        ..SpawnOptions::default()
    };
    let ledger = state.relay.ledger();
    for (entry, print) in [
        ("spawn-1", ledgered::spawn_fingerprint(&options)),
        (
            "rot-1",
            ledgered::fingerprint(ledgered::ROTATE_CLAIM, &[("terminalId", Some(&id))]),
        ),
    ] {
        let Begin::Settled(settled) = ledger.begin(entry, print) else {
            panic!("{entry} must be settled");
        };
        let dump = format!("{settled:?}");
        for secret in [&claim, &rotated] {
            assert!(!dump.contains(secret.as_str()), "{entry} stores a claim");
        }
    }

    state.pty.force_kill(&id).await.unwrap();
}

#[tokio::test]
async fn a_revoke_resend_answers_ok_without_revoking_again() {
    let (state, _) = state_with_clock();
    let mut conn = gate_test_ctx(true);
    let spawned = spawn(&state, &mut conn, "spawn-1", "p").await.unwrap();
    let id = str_of(&spawned, "id");
    let revoke = || {
        request(
            "revoke_claim",
            json!({ "terminalId": id, "claim": str_of(&spawned, "claim") }),
            Some("rev-1"),
        )
    };

    assert_eq!(call(&state, &mut conn, revoke()).await, Ok(Value::Null));
    // Re-running would be UNAUTHORIZED (the claim is revoked); the ledger answers ok.
    assert_eq!(call(&state, &mut conn, revoke()).await, Ok(Value::Null));

    state.pty.force_kill(&id).await.unwrap();
}

#[tokio::test]
async fn a_write_chunk_resend_is_not_typed_twice_and_a_changed_chunk_conflicts() {
    let (state, _) = state_with_clock();
    let mut conn = gate_test_ctx(true);
    let id = str_of(&spawn(&state, &mut conn, "spawn-1", "p").await.unwrap(), "id");
    let write = |command_id: &str, data: &str| {
        request(
            "write",
            json!({ "terminalId": id, "data": data }),
            Some(command_id),
        )
    };

    assert_eq!(call(&state, &mut conn, write("w1", "ls\n")).await, Ok(Value::Null));
    // The PTY vanishes: a re-run would fail with WRITE_FAILED, the replay does not.
    state.pty.force_kill(&id).await.unwrap();
    assert_eq!(call(&state, &mut conn, write("w1", "ls\n")).await, Ok(Value::Null));
    assert_eq!(code(call(&state, &mut conn, write("w1", "pwd\n")).await), "COMMAND_CONFLICT");
    // A new chunk id really executes.
    assert_eq!(code(call(&state, &mut conn, write("w2", "ls\n")).await), "WRITE_FAILED");
}

#[tokio::test]
async fn the_same_command_id_for_another_request_is_a_conflict() {
    let (state, _) = state_with_clock();
    let mut conn = gate_test_ctx(true);
    let id = str_of(&spawn(&state, &mut conn, "c1", "p").await.unwrap(), "id");

    assert_eq!(code(spawn(&state, &mut conn, "c1", "other-project").await), "COMMAND_CONFLICT");
    let kill = request("kill", json!({ "terminalId": id }), Some("c1"));
    assert_eq!(code(call(&state, &mut conn, kill).await), "COMMAND_CONFLICT");
    assert_eq!(state.pty.get_all().len(), 1);
    assert!(state.pty.get(&id).is_some(), "a conflicting kill must not run");

    state.pty.force_kill(&id).await.unwrap();
}

#[tokio::test]
async fn a_view_only_connection_is_refused_before_the_ledger_records_anything() {
    let (state, _) = state_with_clock();
    let mut conn = gate_test_ctx(true);
    conn.capabilities.write = false;

    let refused = spawn(&state, &mut conn, "spawn-1", "p").await;
    assert_eq!(code(refused), "FORBIDDEN");
    assert_eq!(entries(&state), (0, 0, 0));
    assert!(state.pty.get_all().is_empty());
}

#[tokio::test]
async fn a_malformed_or_disagreeing_command_id_is_refused_without_an_entry() {
    let (state, _) = state_with_clock();
    let mut conn = gate_test_ctx(true);

    assert_eq!(code(spawn(&state, &mut conn, "has space", "p").await), "INVALID_COMMAND_ID");
    let disagree = request(
        "spawn",
        json!({ "projectId": "p", "commandId": "from-payload" }),
        Some("from-envelope"),
    );
    assert_eq!(code(call(&state, &mut conn, disagree).await), "INVALID_COMMAND_ID");
    assert_eq!(entries(&state), (0, 0, 0));
    assert!(state.pty.get_all().is_empty());
}

#[tokio::test]
async fn a_spawn_carries_its_command_id_in_the_payload_like_the_desktop_options() {
    let (state, _) = state_with_clock();
    let mut conn = gate_test_ctx(true);
    let by_payload = request("spawn", json!({ "projectId": "p", "commandId": "spawn-p" }), None);

    let first = str_of(&call(&state, &mut conn, by_payload).await.unwrap(), "id");
    let resent = spawn(&state, &mut conn, "spawn-p", "p").await.unwrap();
    assert_eq!(str_of(&resent, "id"), first);
    assert_eq!(state.pty.get_all().len(), 1);

    state.pty.force_kill(&first).await.unwrap();
}

#[tokio::test]
async fn a_resend_while_the_first_spawn_is_going_answers_in_progress() {
    let (mut state, _) = state_with_clock();
    state.relay = Arc::new(WsRelaySink::new().with_ledger(
        CommandLedger::new(RETENTION).with_in_flight_wait(Duration::from_millis(30)),
    ));
    let options = SpawnOptions {
        project_id: Some("p".to_string()),
        ..SpawnOptions::default()
    };
    let Begin::Fresh(running) = state
        .relay
        .ledger()
        .begin("spawn-1", ledgered::spawn_fingerprint(&options))
    else {
        panic!("first sight");
    };
    let mut conn = gate_test_ctx(true);

    let reply = spawn(&state, &mut conn, "spawn-1", "p").await.unwrap();
    assert_eq!(reply, json!({ "receipt": "in_progress" }));
    assert!(state.pty.get_all().is_empty());
    drop(running);
}

#[tokio::test]
async fn list_preserved_is_never_replayed_even_with_a_command_id() {
    let (state, _) = state_with_clock();
    let mut conn = gate_test_ctx(true);
    let id = str_of(&spawn(&state, &mut conn, "spawn-1", "p").await.unwrap(), "id");
    let list = || request("list_preserved", json!({ "projectId": "p" }), Some("lp-1"));

    let first = call(&state, &mut conn, list()).await.unwrap();
    let second = call(&state, &mut conn, list()).await.unwrap();
    assert_ne!(
        first["terminals"][0]["claim"], second["terminals"][0]["claim"],
        "each listing re-issues claims"
    );
    assert_eq!(entries(&state), (0, 1, 0), "only the spawn is recorded");

    state.pty.force_kill(&id).await.unwrap();
}
