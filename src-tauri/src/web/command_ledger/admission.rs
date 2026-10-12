//! The shared admission helper: `/ws` dispatch and the Tauri `acp_*` commands
//! both run a ledgered command through [`run_command`], so one place decides
//! record-before-execute, replay, wait-for-in-flight and `Unknown`.

use std::future::Future;
use std::sync::Arc;

use tracing::{info, warn};

use crate::acp::AcpManager;
use crate::web::command_ledger::{Begin, CommandClass, Fingerprint, Settled};
use crate::web::WsRelaySink;

use serde_json::json;

/// One ledgered command, already validated (`commandId` well-formed, class
/// ledgered) by the carrier.
pub struct Command<'a> {
    pub id: &'a str,
    /// The class-table name of the request (`create_session`, ...).
    pub kind: &'static str,
    pub class: CommandClass,
    pub fingerprint: Fingerprint,
}

/// What the carrier answers with.
#[derive(Debug, Clone, PartialEq)]
pub enum CommandResult {
    /// The outcome: executed now, or replayed from the ledger or the entity.
    Done(Settled),
    /// The first run is still going after the bounded wait.
    InProgress,
    /// The outcome is gone; the command was NOT re-executed.
    Unknown,
    /// The id belongs to a different request.
    Conflict,
}

/// Admit `command` (recorded in `relay`'s ledger) and run `execute` unless an earlier run already decided it.
///
/// `execute` runs on its own task: a carrier that goes away mid-command (a
/// closed socket aborts the request task) does not cancel the effect, so the
/// outcome is still recorded for the resend. A panicking `execute` is
/// re-raised here (the connection is then closed) and leaves `Unknown`.
pub async fn run_command<F>(
    relay: &Arc<WsRelaySink>,
    acp: &Arc<AcpManager>,
    command: Command<'_>,
    execute: F,
) -> CommandResult
where
    F: Future<Output = Settled> + Send + 'static,
{
    let Command {
        id,
        kind,
        class,
        fingerprint,
    } = command;
    let ledger = relay.ledger();
    let mut waited = false;
    loop {
        match ledger.begin(id, fingerprint) {
            Begin::Fresh(guard) => {
                if class.creates_entity() {
                    if let Some(found) = lookup_created(kind, id, acp, relay).await {
                        info!(
                            target: "termul::web::command_ledger",
                            kind,
                            "create resend answered from the stamped entity"
                        );
                        guard.complete(&found, class);
                        return CommandResult::Done(found);
                    }
                }
                let handle = tokio::spawn(async move {
                    let settled = execute.await;
                    guard.complete(&settled, class);
                    settled
                });
                return match handle.await {
                    Ok(settled) => CommandResult::Done(settled),
                    Err(error) if error.is_panic() => std::panic::resume_unwind(error.into_panic()),
                    Err(_) => CommandResult::Unknown,
                };
            }
            Begin::InFlight(mut waiter) => {
                if waited {
                    return CommandResult::InProgress;
                }
                waited = true;
                let _ = tokio::time::timeout(ledger.in_flight_wait(), async {
                    while waiter.changed().await.is_ok() {}
                })
                .await;
            }
            Begin::Settled(Settled::Accepted { payload: None, .. }) if class.creates_entity() => {
                // A payload too large to store: rebuild it from the entity.
                if let Some(found) = lookup_created(kind, id, acp, relay).await {
                    return CommandResult::Done(found);
                }
                return CommandResult::Done(Settled::Accepted {
                    payload: None,
                    visible_at: None,
                });
            }
            Begin::Settled(settled) => return CommandResult::Done(settled),
            Begin::Unknown => {
                if class.creates_entity() {
                    if let Some(found) = lookup_created(kind, id, acp, relay).await {
                        info!(
                            target: "termul::web::command_ledger",
                            kind,
                            "create resend after eviction answered from the stamped entity"
                        );
                        return CommandResult::Done(found);
                    }
                }
                warn!(
                    target: "termul::web::command_ledger",
                    kind,
                    "resend of a command with no stored outcome; not re-executed"
                );
                return CommandResult::Unknown;
            }
            Begin::Conflict => {
                warn!(
                    target: "termul::web::command_ledger",
                    kind,
                    "commandId reused for a different request"
                );
                return CommandResult::Conflict;
            }
        }
    }
}

// Entity lookup for create commands: a resend whose outcome the ledger no
// longer holds (evicted, or the host restarted) is answered from the entity
// that carries the `commandId`.
/// The reply for an already-created entity stamped with `command_id`, for the
/// create request type `kind`. `None` when no such entity exists (it was never
/// created, or is gone: ephemeral sessions are live-only).
pub async fn lookup_created(
    kind: &str,
    command_id: &str,
    acp: &AcpManager,
    relay: &WsRelaySink,
) -> Option<Settled> {
    let (payload, visible_at) = match kind {
        "create_session" => {
            let session_id = acp
                .persistence()?
                .find_session_by_command_id(command_id)?
                .session_id;
            // Any later seq is safe: the session already exists, so its
            // current frontier is at or past the point the create was visible.
            let seq = relay.session_watermark(&session_id);
            (json!({ "sessionId": session_id }), (seq > 0).then_some(seq))
        }
        "spawn_agent" => (
            serde_json::to_value(acp.spawn_outcome_by_command_id(command_id)?).ok()?,
            None,
        ),
        _ => return None,
    };
    Some(Settled::Accepted {
        payload: Some(payload),
        visible_at,
    })
}
