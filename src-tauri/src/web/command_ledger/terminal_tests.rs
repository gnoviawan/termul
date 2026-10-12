//! Terminal admission behavior: replay, rejection replay, released failures,
//! eviction with entity lookup, in-flight resends, panics and the
//! no-credential-stored rule.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::oneshot;

use super::terminal::{self, Effect, Outcome};
use super::test_clock::ManualClock;
use super::*;

const RETENTION: Duration = Duration::from_secs(600);

fn ledger() -> (Arc<CommandLedger>, Arc<ManualClock>) {
    let clock = Arc::new(ManualClock::default());
    (
        Arc::new(CommandLedger::with_clock(RETENTION, clock.clone())),
        clock,
    )
}

fn terminal_fp(kind: &str, terminal: &str) -> Fingerprint {
    terminal::fingerprint(kind, &[("terminalId", Some(terminal))])
}

async fn run_kill(
    ledger: &Arc<CommandLedger>,
    id: &str,
    runs: &Arc<AtomicUsize>,
    terminal: &str,
) -> Outcome<()> {
    let runs = runs.clone();
    terminal::command(
        ledger,
        terminal::KILL,
        id,
        &[("terminalId", Some(terminal))],
        async move {
            runs.fetch_add(1, Ordering::SeqCst);
            Effect::Done(())
        },
    )
    .await
}

#[tokio::test]
async fn a_resent_command_answers_ok_and_never_runs_twice() {
    let (ledger, _) = ledger();
    let runs = Arc::new(AtomicUsize::new(0));

    assert!(matches!(
        run_kill(&ledger, "k1", &runs, "t1").await,
        Outcome::Executed(())
    ));
    assert!(matches!(
        run_kill(&ledger, "k1", &runs, "t1").await,
        Outcome::Receipt
    ));
    assert_eq!(runs.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn the_same_id_for_another_request_is_a_conflict_and_not_run() {
    let (ledger, _) = ledger();
    let runs = Arc::new(AtomicUsize::new(0));
    run_kill(&ledger, "k1", &runs, "t1").await;

    assert!(matches!(
        run_kill(&ledger, "k1", &runs, "t2").await,
        Outcome::Conflict
    ));
    assert_eq!(runs.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_malformed_id_is_refused_without_a_ledger_entry() {
    let (ledger, _) = ledger();
    let runs = Arc::new(AtomicUsize::new(0));

    assert!(matches!(
        run_kill(&ledger, "has space", &runs, "t1").await,
        Outcome::InvalidId
    ));
    assert_eq!(runs.load(Ordering::SeqCst), 0);
    assert_eq!(ledger.counts(), (0, 0, 0));
}

#[tokio::test]
async fn a_recorded_rejection_replays_with_its_original_code() {
    let (ledger, _) = ledger();
    let runs = Arc::new(AtomicUsize::new(0));
    let failing = |runs: Arc<AtomicUsize>| async move {
        runs.fetch_add(1, Ordering::SeqCst);
        Effect::<()>::Failed {
            code: "WRITE_FAILED",
            message: "Terminal not found".to_string(),
        }
    };
    let fields = [("terminalId", Some("t1"))];

    let first = terminal::command(&ledger, terminal::WRITE, "w1", &fields, failing(runs.clone())).await;
    let again = terminal::command(&ledger, terminal::WRITE, "w1", &fields, failing(runs.clone())).await;

    for outcome in [first, again] {
        match outcome {
            Outcome::Rejected { code, message } => {
                assert_eq!(code, "WRITE_FAILED");
                assert_eq!(message, "Terminal not found");
            }
            other => panic!("expected the original rejection, got {other:?}"),
        }
    }
    assert_eq!(runs.load(Ordering::SeqCst), 1, "the rejection is replayed, not retried");
}

#[tokio::test]
async fn a_failure_without_effect_releases_the_id_so_a_retry_executes() {
    let (ledger, _) = ledger();
    let runs = Arc::new(AtomicUsize::new(0));
    let fields = [("terminalId", Some("t1"))];
    let attempt = |runs: Arc<AtomicUsize>, fail: bool| async move {
        runs.fetch_add(1, Ordering::SeqCst);
        if fail {
            Effect::Released {
                code: "UNAUTHORIZED",
                message: "Unauthorized".to_string(),
            }
        } else {
            Effect::Done(())
        }
    };

    let first = terminal::command(&ledger, terminal::KILL, "k1", &fields, attempt(runs.clone(), true)).await;
    assert!(matches!(first, Outcome::Rejected { code: "UNAUTHORIZED", .. }));
    assert_eq!(ledger.counts(), (0, 0, 0), "a released id leaves no entry");

    let retry = terminal::command(&ledger, terminal::KILL, "k1", &fields, attempt(runs.clone(), false)).await;
    assert!(matches!(retry, Outcome::Executed(())));
    assert_eq!(runs.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_resend_while_the_first_run_is_going_waits_then_reports_in_progress() {
    let ledger = Arc::new(
        CommandLedger::with_clock(RETENTION, Arc::new(ManualClock::default()))
            .with_in_flight_wait(Duration::from_millis(40)),
    );
    let (release, gate) = oneshot::channel::<()>();
    let first_ledger = ledger.clone();
    let first = tokio::spawn(async move {
        terminal::command(
            &first_ledger,
            terminal::KILL,
            "k1",
            &[("terminalId", Some("t1"))],
            async move {
                let _ = gate.await;
                Effect::Done(())
            },
        )
        .await
    });
    // Let the first run record itself.
    while ledger.counts().0 == 0 {
        tokio::task::yield_now().await;
    }

    let runs = Arc::new(AtomicUsize::new(0));
    assert!(matches!(
        run_kill(&ledger, "k1", &runs, "t1").await,
        Outcome::InProgress
    ));
    release.send(()).unwrap();
    assert!(matches!(first.await.unwrap(), Outcome::Executed(())));
    assert!(matches!(
        run_kill(&ledger, "k1", &runs, "t1").await,
        Outcome::Receipt
    ));
    assert_eq!(runs.load(Ordering::SeqCst), 0, "no resend ever executed");
}

#[tokio::test]
async fn a_waiting_resend_becomes_the_next_run_when_the_first_is_released() {
    let (ledger, _) = ledger();
    let (release, gate) = oneshot::channel::<()>();
    let first_ledger = ledger.clone();
    let first = tokio::spawn(async move {
        terminal::command(
            &first_ledger,
            terminal::KILL,
            "k1",
            &[("terminalId", Some("t1"))],
            async move {
                let _ = gate.await;
                Effect::<()>::Released {
                    code: "SPAWN_FAILED",
                    message: "no shell".to_string(),
                }
            },
        )
        .await
    });
    while ledger.counts().0 == 0 {
        tokio::task::yield_now().await;
    }

    let runs = Arc::new(AtomicUsize::new(0));
    let waiter_ledger = ledger.clone();
    let waiter_runs = runs.clone();
    let waiter = tokio::spawn(async move { run_kill(&waiter_ledger, "k1", &waiter_runs, "t1").await });
    tokio::time::sleep(Duration::from_millis(20)).await;
    release.send(()).unwrap();

    assert!(matches!(first.await.unwrap(), Outcome::Rejected { .. }));
    assert!(matches!(waiter.await.unwrap(), Outcome::Executed(())));
    assert_eq!(runs.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_create_resend_after_eviction_finds_the_stamped_entity_and_a_gone_entity_is_unknown() {
    let (ledger, clock) = ledger();
    let fp = terminal_fp(terminal::SPAWN, "p");
    let spawns = Arc::new(AtomicUsize::new(0));
    let spawn = |ledger: Arc<CommandLedger>, spawns: Arc<AtomicUsize>, alive: bool| async move {
        terminal::admit(
            &ledger,
            terminal::SPAWN,
            "s1",
            fp,
            move || alive.then(|| "terminal-1".to_string()),
            async move {
                spawns.fetch_add(1, Ordering::SeqCst);
                Effect::Done("terminal-1".to_string())
            },
        )
        .await
    };

    // First sight with no stamped terminal yet: executes.
    assert!(matches!(
        spawn(ledger.clone(), spawns.clone(), false).await,
        Outcome::Executed(_)
    ));
    // Recorded and alive: the entity answers.
    assert!(matches!(
        spawn(ledger.clone(), spawns.clone(), true).await,
        Outcome::Found(id) if id == "terminal-1"
    ));
    // Recorded but the PTY was reaped: never respawned.
    assert!(matches!(
        spawn(ledger.clone(), spawns.clone(), false).await,
        Outcome::Unknown
    ));
    // The outcome aged into a bare id, then the id was forgotten entirely.
    clock.advance(RETENTION + Duration::from_secs(1));
    assert!(matches!(
        spawn(ledger.clone(), spawns.clone(), true).await,
        Outcome::Found(_)
    ));
    clock.advance(RETENTION * (BARE_HORIZON_FACTOR + 1));
    assert!(matches!(
        spawn(ledger.clone(), spawns.clone(), true).await,
        Outcome::Found(_)
    ));
    assert_eq!(spawns.load(Ordering::SeqCst), 1, "the stamped PTY answered every resend");
}

#[tokio::test]
async fn a_non_create_resend_after_eviction_is_unknown_and_not_run() {
    let (ledger, clock) = ledger();
    let runs = Arc::new(AtomicUsize::new(0));
    run_kill(&ledger, "k1", &runs, "t1").await;
    clock.advance(RETENTION + Duration::from_secs(1));

    assert!(matches!(
        run_kill(&ledger, "k1", &runs, "t1").await,
        Outcome::Unknown
    ));
    assert_eq!(runs.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_panicking_command_leaves_unknown_and_is_never_run_again() {
    let (ledger, _) = ledger();
    let panicking_ledger = ledger.clone();
    let crashed = tokio::spawn(async move {
        terminal::command::<(), _>(
            &panicking_ledger,
            terminal::KILL,
            "k1",
            &[("terminalId", Some("t1"))],
            async { panic!("handler died") },
        )
        .await
    })
    .await;
    assert!(crashed.is_err());

    let runs = Arc::new(AtomicUsize::new(0));
    assert!(matches!(
        run_kill(&ledger, "k1", &runs, "t1").await,
        Outcome::Unknown
    ));
    assert_eq!(runs.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_receipt_only_command_records_no_credential_or_error_text() {
    let (ledger, _) = ledger();
    let secret = "claim-0123456789abcdef";
    let fields = [("terminalId", Some("t1"))];

    let executed = terminal::command(
        &ledger,
        terminal::ROTATE_CLAIM,
        "r1",
        &fields,
        async move { Effect::Done(secret.to_string()) },
    )
    .await;
    assert!(matches!(&executed, Outcome::Executed(claim) if claim == secret));
    match ledger.begin("r1", terminal_fp(terminal::ROTATE_CLAIM, "t1")) {
        Begin::Settled(settled) => {
            assert!(!format!("{settled:?}").contains(secret));
        }
        _ => panic!("the rotation must be settled"),
    }

    let failed = terminal::command(
        &ledger,
        terminal::REVOKE_CLAIM,
        "r2",
        &fields,
        async move {
            Effect::<()>::Failed {
                code: "UNAUTHORIZED",
                message: format!("bad claim {secret}"),
            }
        },
    )
    .await;
    assert!(matches!(failed, Outcome::Rejected { .. }));
    match ledger.begin("r2", terminal_fp(terminal::REVOKE_CLAIM, "t1")) {
        Begin::Settled(settled) => assert!(!format!("{settled:?}").contains(secret)),
        _ => panic!("the revocation must be settled"),
    }
}

#[test]
fn only_the_terminal_mutations_are_ledgered() {
    for kind in [
        terminal::SPAWN,
        terminal::WRITE,
        terminal::KILL,
        terminal::ROTATE_CLAIM,
        terminal::REVOKE_CLAIM,
    ] {
        assert!(
            terminal::TERMINAL_COMMAND_CLASSES
                .iter()
                .any(|(name, class)| *name == kind && class.ledgered()),
            "{kind} must be ledgered"
        );
    }
    for request in [
        "resize",
        "detach",
        "set_protected",
        "add_renderer_ref",
        "remove_renderer_ref",
        "update_orphan_detection",
        "get_cwd",
        "list_preserved",
        "attach",
    ] {
        assert!(
            terminal::ws_kind(request).is_none(),
            "{request} never enters the ledger"
        );
    }
}
