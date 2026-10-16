//! The Tauri `terminal_*` replies of ledgered commands: what a resend,
//! conflict or in-flight verdict looks like to the desktop renderer.

use std::time::Duration;

use super::terminal::{list_preserved_reply, terminal_unit_reply, terminal_value_reply};
#[cfg(unix)]
use super::terminal::{attach_terminal, ATTACH_FORWARDER_GENERATION_CHECK_MS};
use crate::pty::claims::RotatedClaim;
#[cfg(unix)]
use crate::pty::manager::SpawnedTerminal;
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

#[cfg(unix)]
fn collecting_channel() -> (
    tauri::ipc::Channel<tauri::ipc::Response>,
    std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
) {
    let received = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = std::sync::Arc::clone(&received);
    let channel = tauri::ipc::Channel::new(move |body| {
        if let tauri::ipc::InvokeResponseBody::Raw(bytes) = body {
            sink.lock().unwrap().extend(bytes);
        }
        Ok(())
    });
    (channel, received)
}

#[cfg(unix)]
async fn wait_for_text(received: &std::sync::Mutex<Vec<u8>>, text: &str) -> bool {
    for _ in 0..100 {
        if String::from_utf8_lossy(&received.lock().unwrap()).contains(text) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    false
}

#[cfg(unix)]
fn echo_shell(command_id: &str) -> SpawnOptions {
    SpawnOptions {
        program: Some("sh".to_string()),
        args: Some(vec![
            "-c".to_string(),
            "echo ready-marker; read line; echo got-$line; sleep 300".to_string(),
        ]),
        ..spawn_options(command_id)
    }
}

#[cfg(unix)]
async fn spawn_live_terminal(pty: &std::sync::Arc<crate::pty::PtyManager>) -> SpawnedTerminal {
    let ledger = std::sync::Arc::new(CommandLedger::new(Duration::from_secs(600)));
    let spawned = terminal_value_reply(
        ledgered::spawn(&ledger, pty, echo_shell("spawn-live"), None).await,
        ledgered::SPAWN,
    )
    .data
    .expect("spawn");
    let instance = pty.get(&spawned.info.id).expect("tracked");
    for _ in 0..100 {
        let printed: Vec<u8> = instance
            .subscribe_from(0, None)
            .chunks
            .into_iter()
            .flat_map(|chunk| chunk.data)
            .collect();
        if String::from_utf8_lossy(&printed).contains("ready-marker") {
            return spawned;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("the shell never printed");
}

#[cfg(unix)]
#[tokio::test]
async fn a_reloaded_renderer_reattaches_the_live_pty_and_replays_its_output() {
    let pty = crate::web::test_pty_manager();
    let dead_page = spawn_live_terminal(&pty).await;
    let terminal_id = dead_page.info.id.clone();

    let listed = list_preserved_reply(&pty, "p");
    assert!(listed.success);
    let listed = listed.data.expect("preserved terminals");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].info.id, terminal_id);
    assert!(!listed[0].live_attachment);
    let wire = serde_json::to_value(&listed[0]).unwrap();
    let mut keys: Vec<&str> = wire.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        ["claim", "cols", "cwd", "hasLiveAttachment", "id", "pid", "rows", "shell"]
    );

    let (channel, received) = collecting_channel();
    let claim = listed[0].claim.as_deref().expect("fresh claim");
    let attached = attach_terminal(&pty, terminal_id.clone(), claim, 0, None, channel);

    assert!(attached.success, "reattach: {:?}", attached.error);
    assert_eq!(attached.data.expect("attach result").id, terminal_id);
    assert!(wait_for_text(&received, "ready-marker").await, "scrollback replayed");
    assert_eq!(pty.get_all().len(), 1, "a reattach spawns nothing");
    pty.write(&terminal_id, "typed\n").await.unwrap();
    assert!(wait_for_text(&received, "got-typed").await, "the same shell answers");

    let (stale_channel, _) = collecting_channel();
    let stale = attach_terminal(&pty, terminal_id.clone(), &dead_page.claim, 0, None, stale_channel);
    assert_eq!(stale.code.as_deref(), Some("UNAUTHORIZED"));

    pty.force_kill(&terminal_id).await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn another_clients_listing_does_not_sever_a_desktop_attach_stream() {
    let pty = crate::web::test_pty_manager();
    let terminal_id = spawn_live_terminal(&pty).await.info.id;
    let desktop_claim = list_preserved_reply(&pty, "p").data.expect("list")[0]
        .claim
        .clone()
        .expect("fresh claim");
    let (channel, received) = collecting_channel();
    assert!(attach_terminal(&pty, terminal_id.clone(), &desktop_claim, 0, None, channel).success);

    let phone = list_preserved_reply(&pty, "p").data.expect("list");
    assert!(phone[0].live_attachment);
    tokio::time::sleep(Duration::from_millis(3 * ATTACH_FORWARDER_GENERATION_CHECK_MS)).await;
    pty.write(&terminal_id, "after\n").await.unwrap();

    assert!(wait_for_text(&received, "got-after").await, "the desktop stream still flows");
    assert!(pty.verify_claim(&terminal_id, &desktop_claim).is_ok());

    pty.force_kill(&terminal_id).await.unwrap();
}

#[tokio::test]
async fn listing_without_a_project_is_a_validation_error() {
    let pty = crate::web::test_pty_manager();
    let reply = list_preserved_reply(&pty, "");
    assert!(!reply.success);
    assert_eq!(reply.code.as_deref(), Some("VALIDATION_ERROR"));
}
