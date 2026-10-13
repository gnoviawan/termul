//! The Tauri `terminal_*` replies of ledgered commands: what a resend,
//! conflict or in-flight verdict looks like to the desktop renderer.

use std::time::Duration;

use super::terminal::{terminal_unit_reply, terminal_value_reply};
use crate::pty::claims::RotatedClaim;
use crate::pty::SpawnOptions;
use crate::web::command_ledger::terminal::{self as ledgered, Effect};
use crate::web::command_ledger::{Begin, CommandLedger};

fn spawn_options(command_id: &str) -> SpawnOptions {
    SpawnOptions {
        project_id: Some("p".to_string()),
        command_id: Some(command_id.to_string()),
        ..SpawnOptions::default()
    }
}

#[tokio::test]
async fn a_spawn_resend_replies_with_the_existing_terminal_and_a_fresh_claim() {
    let pty = crate::web::test_pty_manager();
    let ledger = std::sync::Arc::new(CommandLedger::new(Duration::from_secs(600)));

    let first = terminal_value_reply(
        ledgered::spawn(&ledger, &pty, spawn_options("spawn-1"), None).await,
        ledgered::SPAWN,
    );
    let resent = terminal_value_reply(
        ledgered::spawn(&ledger, &pty, spawn_options("spawn-1"), None).await,
        ledgered::SPAWN,
    );

    let (first, resent) = (first.data.expect("first spawn"), resent.data.expect("replayed spawn"));
    assert_eq!(resent.info.id, first.info.id);
    assert_ne!(resent.claim, first.claim);
    assert_eq!(pty.get_all().len(), 1);

    pty.force_kill(&first.info.id).await.unwrap();
}

#[tokio::test]
async fn a_spawn_over_the_terminal_cap_replies_terminal_limit_with_the_numbers() {
    let pty = crate::web::test_pty_manager();
    pty.set_max_terminals_per_project(1);
    let ledger = std::sync::Arc::new(CommandLedger::new(Duration::from_secs(600)));
    let held = terminal_value_reply(
        ledgered::spawn(&ledger, &pty, spawn_options("spawn-1"), None).await,
        ledgered::SPAWN,
    );

    let refused = terminal_value_reply(
        ledgered::spawn(&ledger, &pty, spawn_options("spawn-2"), None).await,
        ledgered::SPAWN,
    );
    assert!(!refused.success);
    assert_eq!(refused.code.as_deref(), Some("TERMINAL_LIMIT"));
    let message = refused.error.expect("message");
    assert!(message.contains("1 per project") && message.contains("30 total"), "{message}");
    assert_eq!(pty.get_all().len(), 1, "a refused spawn creates nothing");

    pty.force_kill(&held.data.expect("held").info.id).await.unwrap();
}

#[tokio::test]
async fn a_rotate_resend_replies_outcome_unknown_and_a_revoke_resend_replies_ok() {
    let ledger = std::sync::Arc::new(CommandLedger::new(Duration::from_secs(600)));
    let fields = [("terminalId", Some("t1"))];
    let rotate = || async {
        ledgered::command(&ledger, ledgered::ROTATE_CLAIM, "rot-1", &fields, async {
            Effect::Done(RotatedClaim {
                claim: "fresh".to_string(),
            })
        })
        .await
    };
    let revoke = || async {
        ledgered::command(&ledger, ledgered::REVOKE_CLAIM, "rev-1", &fields, async {
            Effect::Done(())
        })
        .await
    };

    let first = terminal_value_reply(rotate().await, ledgered::ROTATE_CLAIM);
    assert!(first.success);
    let replay = terminal_value_reply(rotate().await, ledgered::ROTATE_CLAIM);
    assert!(!replay.success);
    assert_eq!(replay.code.as_deref(), Some("OUTCOME_UNKNOWN"));

    assert!(terminal_unit_reply(revoke().await, ledgered::REVOKE_CLAIM).success);
    assert!(terminal_unit_reply(revoke().await, ledgered::REVOKE_CLAIM).success);
}

#[tokio::test]
async fn conflict_invalid_id_and_in_flight_verdicts_carry_their_codes() {
    let ledger = std::sync::Arc::new(
        CommandLedger::new(Duration::from_secs(600)).with_in_flight_wait(Duration::from_millis(20)),
    );
    let run = |id: &'static str, terminal: &'static str| {
        let ledger = ledger.clone();
        async move {
            terminal_unit_reply(
                ledgered::command(
                    &ledger,
                    ledgered::KILL,
                    id,
                    &[("terminalId", Some(terminal))],
                    async { Effect::Done(()) },
                )
                .await,
                ledgered::KILL,
            )
        }
    };

    assert!(run("k1", "t1").await.success);
    assert_eq!(run("k1", "t2").await.code.as_deref(), Some("COMMAND_CONFLICT"));
    assert_eq!(run("bad id", "t1").await.code.as_deref(), Some("INVALID_COMMAND_ID"));

    let Begin::Fresh(running) = ledger.begin(
        "k2",
        ledgered::fingerprint(ledgered::KILL, &[("terminalId", Some("t1"))]),
    ) else {
        panic!("first sight");
    };
    assert_eq!(run("k2", "t1").await.code.as_deref(), Some("COMMAND_IN_PROGRESS"));
    drop(running);
}
