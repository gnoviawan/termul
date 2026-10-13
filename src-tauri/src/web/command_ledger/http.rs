//! The domain-command carriers of the ledger: HTTP routes (`X-Command-Id`
//! header, `IpcBody` replies) and Tauri commands (`commandId` argument,
//! `Result<T, String>` replies) admit through the same [`run_command_released`]
//! as `/ws`, with one class table for the domain kinds below.
//!
//! * Ledgered (`Command`/`Create`): fs write/rename/copy, git commit,
//!   discard, stash save/apply/pop/drop, stage/unstage hunk, create-branch,
//!   worktree create/rename-branch, plus the `install_acp_agent` row of the
//!   `/ws` table. Kinds whose request
//!   carries content (fs write, discard, commit, stash save, hunk patches) are
//!   receipt-only: a recorded rejection keeps its code but not its text, which
//!   could echo that content.
//! * Naturally idempotent (no ledger; a repeat answers like the first):
//!   fs mkdir/delete (deleting an absent path is ok), git
//!   init/stage/unstage/push/checkout/branch-switch, worktree
//!   remove/copy-include-files, projects, MCP servers, catalog opt-in,
//!   factory-key (a secret body, never stored), search cancel, canvas
//!   open/close/save, oauth disconnect.
//! * Never admitted: log frontend-error, oauth start (secret), probes, reads.
//!
//! A ledgered request without a `commandId` is refused with
//! `INVALID_COMMAND_ID` (Tauri: the `invalid_command_id:` prefix) before it
//! runs; the idempotent kinds above run with or without one. The write guard of
//! the route runs BEFORE this module, so a refused request leaves no entry.
//! Entries hold the outcome class and the reply payload only: never a request
//! body, content, token or secret (fingerprints hash entity names).

use std::future::{ready, Future, Ready};
use std::sync::Arc;

use axum::http::HeaderMap;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::web::fs_api::IpcBody;

use super::{
    class_of, is_valid_command_id, run_command_released, ClassKind, Command, CommandClass, CommandLedger,
    CommandResult, Fingerprint, Ran, Replay, Settled, MAX_COMMAND_ID_LEN,
};

/// The request header that carries the `commandId` of an HTTP route.
pub const COMMAND_ID_HEADER: &str = "x-command-id";

/// `IpcBody::code` of a malformed `commandId`.
pub const INVALID_COMMAND_ID_CODE: &str = "INVALID_COMMAND_ID";
/// `IpcBody::code` of a `commandId` reused for a different request.
pub const COMMAND_CONFLICT_CODE: &str = "COMMAND_CONFLICT";
/// `IpcBody::code` of a resend whose outcome is no longer known.
pub const OUTCOME_UNKNOWN_CODE: &str = "OUTCOME_UNKNOWN";
/// `IpcBody::code` of a stale `expected` precondition (fs write `expected`,
/// git commit `expectedHead`).
pub const PRECONDITION_FAILED_CODE: &str = "PRECONDITION_FAILED";
/// `IpcBody::receipt` of a resend while the first run is still going.
pub const IN_PROGRESS_RECEIPT: &str = "in_progress";

/// Error-text prefix (Tauri) of a stale precondition.
pub const PRECONDITION_FAILED_PREFIX: &str = "precondition_failed";

// Error-text prefixes (Tauri) of the verdicts that are not an outcome: a
// `Result<T, String>` command cannot carry a code, so the text starts with one.

/// Error-text prefix for a malformed `commandId`.
const INVALID_COMMAND_ID: &str = "invalid_command_id";
/// Error-text prefix for a `commandId` reused for a different request.
const COMMAND_CONFLICT: &str = "command_conflict";
/// Error-text prefix for a resend whose outcome is no longer known.
const OUTCOME_UNKNOWN: &str = "outcome_unknown";
/// Error-text prefix for a resend while the first run is still going.
const COMMAND_IN_PROGRESS: &str = "command_in_progress";
/// Error-text prefix for a resend of a command that succeeded but whose reply
/// is not retained (receipt-only kinds, or a reply over the storage cap). The
/// command ran; only its result is gone.
const COMMAND_ACCEPTED: &str = "command_accepted";

/// A create whose reply and rejection text are never stored (its request
/// carries content).
const fn create_receipt_only() -> CommandClass {
    CommandClass {
        kind: ClassKind::Create,
        replay: Some(Replay::ReceiptOnly),
    }
}

/// The domain kinds the ledger admits, and their class. `install_acp_agent`
/// lives in the `/ws` table and is found through [`class_of`].
const DOMAIN_COMMAND_CLASSES: &[(&str, CommandClass)] = &[
    ("fs_write", CommandClass::command(Replay::ReceiptOnly)),
    ("fs_rename", CommandClass::command(Replay::Payload)),
    ("fs_copy", CommandClass::command(Replay::Payload)),
    ("git_commit", create_receipt_only()),
    ("git_discard", CommandClass::command(Replay::ReceiptOnly)),
    ("git_stash_save", CommandClass::command(Replay::ReceiptOnly)),
    ("git_stash_apply", CommandClass::command(Replay::Payload)),
    ("git_stash_pop", CommandClass::command(Replay::Payload)),
    ("git_stash_drop", CommandClass::command(Replay::Payload)),
    ("git_stage_hunk", CommandClass::command(Replay::ReceiptOnly)),
    ("git_unstage_hunk", CommandClass::command(Replay::ReceiptOnly)),
    // A branch or worktree cannot carry a command stamp, so these are plain
    // commands: an evicted resend is `OUTCOME_UNKNOWN`, never "found by
    // existence" (which could turn an original rejection into success).
    ("git_create_branch", CommandClass::command(Replay::Payload)),
    ("worktree_create", CommandClass::command(Replay::Payload)),
    (
        "worktree_rename_branch",
        CommandClass::command(Replay::Payload),
    ),
];

/// The class of a domain command kind (`None`: not ledgered by this table or
/// the `/ws` one).
#[must_use]
pub fn domain_class(kind: &str) -> Option<(&'static str, CommandClass)> {
    DOMAIN_COMMAND_CLASSES
        .iter()
        .find(|(name, _)| *name == kind)
        .map(|(name, class)| (*name, *class))
        .or_else(|| class_of(kind))
}

/// The fingerprint of a `kind` request from its identifying `fields` (entity
/// names, never content). Built as its own statement/argument so the borrowed
/// request values are free to move into the effect.
#[must_use]
pub fn fingerprint_of(kind: &str, fields: &[(&str, &str)]) -> Fingerprint {
    Fingerprint::of_fields(kind, fields.iter().copied())
}

/// An entity lookup that never finds one (commands that create nothing).
pub fn no_entity() -> impl Fn() -> Ready<Option<Settled>> {
    || ready(None)
}

/// A successful, payload-free outcome (a found entity whose reply carries no
/// data).
#[must_use]
pub fn found_entity() -> Settled {
    Settled::Accepted {
        payload: Some(Value::Null),
        visible_at: None,
    }
}

/// The `commandId` of a request, `Ok(None)` when the header is absent and
/// `Err` (`INVALID_COMMAND_ID`) when it is not 1..=128 bytes of
/// `[A-Za-z0-9_-]`.
pub fn command_id_from_headers<T>(headers: &HeaderMap) -> Result<Option<String>, IpcBody<T>> {
    let Some(value) = headers.get(COMMAND_ID_HEADER) else {
        return Ok(None);
    };
    match value.to_str() {
        Ok(id) if is_valid_command_id(id) => Ok(Some(id.to_string())),
        _ => Err(IpcBody::err(
            format!(
                "X-Command-Id must be 1-{MAX_COMMAND_ID_LEN} characters of A-Z, a-z, 0-9, `_` or `-`"
            ),
            INVALID_COMMAND_ID_CODE,
        )),
    }
}

/// The outcome class of a reply body.
fn settled_of<T: Serialize>(body: &IpcBody<T>) -> Settled {
    if body.success {
        Settled::Accepted {
            payload: body
                .data
                .as_ref()
                .and_then(|data| serde_json::to_value(data).ok()),
            visible_at: None,
        }
    } else {
        Settled::Rejected {
            code: body.code.clone().unwrap_or_else(|| "ERROR".to_string()),
            message: body.error.clone().unwrap_or_default(),
        }
    }
}

/// The reply body for a ledger verdict.
fn body_of<T: DeserializeOwned>(kind: &str, result: CommandResult) -> IpcBody<T> {
    match result {
        CommandResult::Done(Settled::Accepted { payload, .. }) => {
            match serde_json::from_value::<T>(payload.unwrap_or(Value::Null)) {
                Ok(data) => IpcBody::ok(data),
                // The command ran; only a reply too large to keep (or one of
                // a receipt-only kind) is gone.
                Err(_) => IpcBody {
                    success: true,
                    data: None,
                    error: None,
                    code: None,
                    receipt: None,
                },
            }
        }
        CommandResult::Done(Settled::Rejected { code, message }) => IpcBody::err(message, code),
        CommandResult::InProgress => IpcBody {
            success: true,
            data: None,
            error: None,
            code: None,
            receipt: Some(IN_PROGRESS_RECEIPT.to_string()),
        },
        CommandResult::Unknown => IpcBody::err(
            format!(
                "the outcome of this `{kind}` is no longer known; it was not run again. Check the entity's state before retrying"
            ),
            OUTCOME_UNKNOWN_CODE,
        ),
        CommandResult::Conflict => IpcBody::err(
            format!("this commandId was already used for a different `{kind}` request"),
            COMMAND_CONFLICT_CODE,
        ),
    }
}

/// How an HTTP effect ended, for [`run_http_released`].
pub enum HttpRan<T> {
    /// Record the reply and replay it to resends.
    Settled(IpcBody<T>),
    /// Refused before any effect (a destructive-op guard): the caller gets the
    /// refusal, nothing is recorded, and the id is free for a retry to run.
    Released(IpcBody<T>),
}

/// How a Tauri effect ended, for [`run_domain_released`].
pub enum DomainRan<T> {
    /// Record the result and replay it to resends.
    Settled(Result<T, String>),
    /// Refused before any effect: the error text goes to the caller, nothing
    /// is recorded, and the id is free for a retry to run.
    Released(String),
}

/// Run `execute` for the HTTP route `kind` under the ledger.
///
/// Call it INSIDE the handler, after the route's write guard and request
/// validation, so a refused request records nothing. `fingerprint` is
/// [`fingerprint_of`] the identifying request fields. `lookup` finds
/// the entity a create stamped (see [`no_entity`]).
pub fn run_http<'a, T, L, LF, F>(
    ledger: &'a Arc<CommandLedger>,
    headers: &HeaderMap,
    kind: &'static str,
    fingerprint: Fingerprint,
    lookup: L,
    execute: F,
) -> impl Future<Output = IpcBody<T>> + 'a
where
    T: Serialize + DeserializeOwned + Send + 'static,
    L: Fn() -> LF + 'a,
    LF: Future<Output = Option<Settled>>,
    F: Future<Output = IpcBody<T>> + Send + 'static,
{
    run_http_released(ledger, headers, kind, fingerprint, lookup, async move {
        HttpRan::Settled(execute.await)
    })
}

/// [`run_http`] whose effect may [`HttpRan::Released`] the id: put a guard
/// that can refuse (`destructive_op_blocked`) INSIDE `execute`, so a settled
/// outcome replays before the guard runs and a refusal is never recorded.
pub fn run_http_released<'a, T, L, LF, F>(
    ledger: &'a Arc<CommandLedger>,
    headers: &HeaderMap,
    kind: &'static str,
    fingerprint: Fingerprint,
    lookup: L,
    execute: F,
) -> impl Future<Output = IpcBody<T>> + 'a
where
    T: Serialize + DeserializeOwned + Send + 'static,
    L: Fn() -> LF + 'a,
    LF: Future<Output = Option<Settled>>,
    F: Future<Output = HttpRan<T>> + Send + 'static,
{
    // Everything borrowed from the request is read here, so the returned
    // future owns its inputs and the caller can move its fields into `execute`.
    let ledgered_class = domain_class(kind).filter(|(_, class)| class.ledgered());
    let admission = match command_id_from_headers::<T>(headers) {
        // A ledgered route without an id has no replay protection: refused
        // before it runs, nothing is recorded.
        Ok(None) if ledgered_class.is_some() => Err(Some(IpcBody::err(
            format!("`{kind}` requires an X-Command-Id header"),
            INVALID_COMMAND_ID_CODE,
        ))),
        Ok(None) => Err(None),
        Err(refusal) => Err(Some(refusal)),
        Ok(Some(id)) => match ledgered_class {
            None => Err(None),
            Some((kind, class)) => Ok((id, kind, class, fingerprint)),
        },
    };
    async move {
        let (command_id, kind, class, fingerprint) = match admission {
            Ok(admitted) => admitted,
            Err(None) => {
                return match execute.await {
                    HttpRan::Settled(body) | HttpRan::Released(body) => body,
                }
            }
            Err(Some(refusal)) => return refusal,
        };
        let command = Command {
            id: &command_id,
            kind,
            class,
            fingerprint,
        };
        let result = run_command_released(ledger, command, lookup, async move {
            match execute.await {
                HttpRan::Settled(body) => Ran::Settled(settled_of(&body)),
                HttpRan::Released(body) => Ran::Released(settled_of(&body)),
            }
        })
        .await;
        body_of(kind, result)
    }
}

/// The code recorded for a rejected Tauri command (the error text is the
/// outcome; Tauri errors carry no separate code).
const REJECTED: &str = "rejected";

/// Run `execute` for the Tauri command `kind` under the ledger: the same
/// admission as [`run_http`], shaped for `Result<T, String>`. A verdict that
/// is not an outcome is an error whose text starts with a stable code (the
/// `acp_*` prefixes plus [`PRECONDITION_FAILED_PREFIX`] from the effect).
pub fn run_domain<'a, T, L, LF, F>(
    ledger: &'a Arc<CommandLedger>,
    kind: &'static str,
    command_id: Option<String>,
    fingerprint: Fingerprint,
    lookup: L,
    execute: F,
) -> impl Future<Output = Result<T, String>> + 'a
where
    T: Serialize + DeserializeOwned + Send + 'static,
    L: Fn() -> LF + 'a,
    LF: Future<Output = Option<Settled>>,
    F: Future<Output = Result<T, String>> + Send + 'static,
{
    run_domain_released(ledger, kind, command_id, fingerprint, lookup, async move {
        DomainRan::Settled(execute.await)
    })
}

/// [`run_domain`] whose effect may [`DomainRan::Released`] the id (see
/// [`run_http_released`]).
pub fn run_domain_released<'a, T, L, LF, F>(
    ledger: &'a Arc<CommandLedger>,
    kind: &'static str,
    command_id: Option<String>,
    fingerprint: Fingerprint,
    lookup: L,
    execute: F,
) -> impl Future<Output = Result<T, String>> + 'a
where
    T: Serialize + DeserializeOwned + Send + 'static,
    L: Fn() -> LF + 'a,
    LF: Future<Output = Option<Settled>>,
    F: Future<Output = DomainRan<T>> + Send + 'static,
{
    let ledgered_class = domain_class(kind).filter(|(_, class)| class.ledgered());
    let admission = match command_id {
        None if ledgered_class.is_some() => Err(Some(format!(
            "{INVALID_COMMAND_ID}: `{kind}` requires a commandId"
        ))),
        None => Err(None),
        Some(id) if !is_valid_command_id(&id) => Err(Some(format!(
            "{INVALID_COMMAND_ID}: commandId must be 1-{MAX_COMMAND_ID_LEN} characters of A-Z, a-z, 0-9, `_` or `-`"
        ))),
        Some(id) => match ledgered_class {
            None => Err(None),
            Some((kind, class)) => Ok((id, kind, class, fingerprint)),
        },
    };
    async move {
        let (command_id, kind, class, fingerprint) = match admission {
            Ok(admitted) => admitted,
            Err(None) => {
                return match execute.await {
                    DomainRan::Settled(result) => result,
                    DomainRan::Released(message) => Err(message),
                }
            }
            Err(Some(refusal)) => return Err(refusal),
        };
        let command = Command {
            id: &command_id,
            kind,
            class,
            fingerprint,
        };
        let result = run_command_released(ledger, command, lookup, async move {
            match execute.await {
                DomainRan::Released(message) => Ran::Released(Settled::Rejected {
                    code: REJECTED.to_string(),
                    message,
                }),
                DomainRan::Settled(Ok(value)) => Ran::Settled(match serde_json::to_value(&value) {
                    Ok(payload) => Settled::Accepted {
                        payload: Some(payload),
                        visible_at: None,
                    },
                    Err(error) => Settled::Rejected {
                        code: REJECTED.to_string(),
                        message: format!("reply could not be serialized: {error}"),
                    },
                }),
                DomainRan::Settled(Err(message)) => Ran::Settled(Settled::Rejected {
                    // A stable code prefix survives a receipt-only kind's
                    // dropped error text.
                    code: if message.starts_with(PRECONDITION_FAILED_PREFIX) {
                        PRECONDITION_FAILED_PREFIX.to_string()
                    } else {
                        REJECTED.to_string()
                    },
                    message,
                }),
            }
        })
        .await;
        match result {
            CommandResult::Done(Settled::Accepted { payload, .. }) => {
                serde_json::from_value(payload.unwrap_or(Value::Null)).map_err(|_| {
                    format!("{COMMAND_ACCEPTED}: the command ran; its result is not retained")
                })
            }
            CommandResult::Done(Settled::Rejected { code, message }) => {
                Err(if code == REJECTED || message.starts_with(&code) {
                    message
                } else {
                    format!("{code}: {message}")
                })
            }
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
}
