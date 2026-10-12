//! The domain-command carriers of the ledger: HTTP routes (`X-Command-Id`
//! header, `IpcBody` replies) and Tauri commands (`commandId` argument,
//! `Result<T, String>` replies) admit through the same [`run_command_with`]
//! as `/ws`, with one class table for the domain kinds below.
//!
//! * Ledgered (`Command`/`Create`): fs write/rename/copy, git commit,
//!   discard, stash save/apply/pop/drop, stage/unstage hunk, create-branch,
//!   worktree create/rename-branch, workspace write (a resend after the first
//!   run answers its `updated` outcome, not a `conflict` against itself), plus
//!   the `install_acp_agent` row of the `/ws` table. Kinds whose request
//!   carries content (fs write, discard, commit, stash save, hunk patches) are
//!   receipt-only: a recorded rejection keeps its code but not its text, which
//!   could echo that content.
//! * Naturally idempotent (no ledger; a repeat answers like the first):
//!   fs mkdir/delete (deleting an absent path is ok), git
//!   init/stage/unstage/push/checkout/branch-switch, worktree
//!   remove/copy-include-files, projects, MCP servers, catalog opt-in,
//!   factory-key (a secret body, never stored), workspace delete, search
//!   cancel, canvas open/close/save, oauth disconnect.
//! * Never admitted: log frontend-error, oauth start (secret), probes, reads.
//!
//! A request without a `commandId` runs exactly as before. The write guard of
//! the route runs BEFORE this module, so a refused request leaves no entry.
//! Entries hold the outcome class and the reply payload only: never a request
//! body, content, token or secret (fingerprints hash entity names).

use std::future::{ready, Future, Ready};
use std::sync::Arc;

use axum::http::HeaderMap;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::acp::commands::{
    COMMAND_ACCEPTED, COMMAND_CONFLICT, COMMAND_IN_PROGRESS, INVALID_COMMAND_ID, OUTCOME_UNKNOWN,
};
use crate::web::fs_api::IpcBody;

use super::{
    class_of, is_valid_command_id, run_command_with, ClassKind, Command, CommandClass, CommandLedger,
    CommandResult, Fingerprint, Replay, Settled, MAX_COMMAND_ID_LEN,
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
    ("git_create_branch", CommandClass::create()),
    ("worktree_create", CommandClass::create()),
    ("workspace_write", CommandClass::command(Replay::Payload)),
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

/// Whether a first-sight id also consults the entity lookup: only for a lookup
/// of the entity THIS command stamped (the commit trailer). Branch and
/// worktree lookups are by existence, so they run only for an id the ledger
/// already knows (see [`run_command_with`]).
fn lookup_on_fresh(kind: &str) -> bool {
    kind == "git_commit"
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

/// Run `execute` for the HTTP route `kind` under the ledger.
///
/// Call it INSIDE the handler, after the route's write guard and request
/// validation, so a refused request records nothing. `fingerprint` is
/// [`fingerprint_of`] the identifying request fields. `lookup` finds
/// the entity a create made (see [`no_entity`]).
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
    // Everything borrowed from the request is read here, so the returned
    // future owns its inputs and the caller can move its fields into `execute`.
    let admission = match command_id_from_headers::<T>(headers) {
        Ok(None) => Err(None),
        Err(refusal) => Err(Some(refusal)),
        Ok(Some(id)) => match domain_class(kind).filter(|(_, class)| class.ledgered()) {
            None => Err(None),
            Some((kind, class)) => Ok((id, kind, class, fingerprint)),
        },
    };
    async move {
        let (command_id, kind, class, fingerprint) = match admission {
            Ok(admitted) => admitted,
            Err(None) => return execute.await,
            Err(Some(refusal)) => return refusal,
        };
        let command = Command {
            id: &command_id,
            kind,
            class,
            fingerprint,
        };
        let result = run_command_with(ledger, command, lookup_on_fresh(kind), lookup, async move {
            settled_of(&execute.await)
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
    let admission = match command_id {
        None => Err(None),
        Some(id) if !is_valid_command_id(&id) => Err(Some(format!(
            "{INVALID_COMMAND_ID}: commandId must be 1-{MAX_COMMAND_ID_LEN} characters of A-Z, a-z, 0-9, `_` or `-`"
        ))),
        Some(id) => match domain_class(kind).filter(|(_, class)| class.ledgered()) {
            None => Err(None),
            Some((kind, class)) => Ok((id, kind, class, fingerprint)),
        },
    };
    async move {
        let (command_id, kind, class, fingerprint) = match admission {
            Ok(admitted) => admitted,
            Err(None) => return execute.await,
            Err(Some(refusal)) => return Err(refusal),
        };
        let command = Command {
            id: &command_id,
            kind,
            class,
            fingerprint,
        };
        let result = run_command_with(ledger, command, lookup_on_fresh(kind), lookup, async move {
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
                    // A stable code prefix survives a receipt-only kind's
                    // dropped error text.
                    code: if message.starts_with(PRECONDITION_FAILED_PREFIX) {
                        PRECONDITION_FAILED_PREFIX.to_string()
                    } else {
                        REJECTED.to_string()
                    },
                    message,
                },
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
