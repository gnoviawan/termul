//! The Tauri `acp_*` side of the command ledger: the same admission the
//! `/ws` dispatch uses ([`run_command`]), shaped for `Result<T, String>`
//! commands.
//!
//! A command without a `commandId` runs exactly as before. A ledgered kind
//! with one is recorded before it runs and a resend gets the original
//! outcome. Verdicts that are not an outcome surface as errors whose text
//! starts with a stable code: `invalid_command_id`, `command_conflict`,
//! `outcome_unknown`, `command_in_progress` (the `/ws` reply is the
//! `{receipt:"in_progress"}` payload; a typed command cannot carry one) or
//! `command_accepted` (the command ran; its result is not retained).

use std::future::Future;
use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::acp::AcpManager;
use crate::web::command_ledger::{
    class_of, is_valid_command_id, run_command, tauri_request_type, Command, CommandResult,
    Fingerprint, Settled, MAX_COMMAND_ID_LEN,
};
use crate::web::WsRelaySink;

/// Error-text prefix for a malformed `commandId`.
pub const INVALID_COMMAND_ID: &str = "invalid_command_id";
/// Error-text prefix for a `commandId` reused for a different request.
pub const COMMAND_CONFLICT: &str = "command_conflict";
/// Error-text prefix for a resend whose outcome is no longer known.
pub const OUTCOME_UNKNOWN: &str = "outcome_unknown";
/// Error-text prefix for a resend while the first run is still going.
pub const COMMAND_IN_PROGRESS: &str = "command_in_progress";
/// Error-text prefix for a resend of a command that succeeded but whose reply
/// is not retained (receipt-only kinds, or a reply over the storage cap). The
/// command ran; only its result is gone.
pub const COMMAND_ACCEPTED: &str = "command_accepted";

/// The code recorded for a rejected Tauri command (the error text is the
/// outcome; Tauri errors carry no separate code).
const REJECTED: &str = "rejected";

/// Run `execute` for the Tauri command `command` under the ledger.
///
/// `payload` describes the request (it is fingerprinted, never stored; secret
/// bearing fields are skipped). Commands whose class is not ledgered
/// (idempotent ones) only have their `commandId` validated.
pub async fn run_ledgered<T, F>(
    relay: &Arc<WsRelaySink>,
    manager: &Arc<AcpManager>,
    command: &'static str,
    command_id: Option<String>,
    payload: Value,
    execute: F,
) -> Result<T, String>
where
    T: Serialize + DeserializeOwned + Send + 'static,
    F: Future<Output = Result<T, String>> + Send + 'static,
{
    let Some(command_id) = command_id else {
        return execute.await;
    };
    if !is_valid_command_id(&command_id) {
        return Err(format!(
            "{INVALID_COMMAND_ID}: commandId must be 1-{MAX_COMMAND_ID_LEN} characters of A-Z, a-z, 0-9, `_` or `-`"
        ));
    }
    let class = tauri_request_type(command).and_then(class_of);
    let Some((kind, class)) = class.filter(|(_, class)| class.ledgered()) else {
        return execute.await;
    };

    let admitted = Command {
        id: &command_id,
        kind,
        class,
        fingerprint: Fingerprint::of(kind, &payload),
    };
    let result = run_command(relay, manager, admitted, async move {
        match execute.await {
            Ok(value) => match serde_json::to_value(&value) {
                Ok(payload) => Settled::Accepted {
                    payload: Some(payload),
                    visible_at: None,
                },
                Err(error) => Settled::Rejected {
                    code: REJECTED.to_string(),
                    message: format!("reply could not be serialized: {error}"),
                },
            },
            Err(message) => Settled::Rejected {
                code: REJECTED.to_string(),
                message,
            },
        }
    })
    .await;
    outcome_of(kind, result)
}

/// Rebuild the command's `Result` from a verdict.
fn outcome_of<T: DeserializeOwned>(kind: &str, result: CommandResult) -> Result<T, String> {
    match result {
        CommandResult::Done(Settled::Accepted { payload, .. }) => {
            // No stored payload still decodes for unit-returning commands.
            serde_json::from_value(payload.unwrap_or(Value::Null)).map_err(|_| {
                format!("{COMMAND_ACCEPTED}: the command ran; its result is not retained")
            })
        }
        CommandResult::Done(Settled::Rejected { message, .. }) => Err(message),
        CommandResult::InProgress => Err(format!(
            "{COMMAND_IN_PROGRESS}: the first run of this `{kind}` is still going; resend later"
        )),
        CommandResult::Unknown => Err(format!(
            "{OUTCOME_UNKNOWN}: the outcome of this `{kind}` is no longer known; it was not run again. Check the entity's state before retrying"
        )),
        CommandResult::Conflict => Err(format!(
            "{COMMAND_CONFLICT}: this commandId was already used for a different `{kind}` request"
        )),
    }
}
