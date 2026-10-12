//! The terminal carriers' side of the command ledger (AD-5): `/terminal/ws`
//! and the Tauri `terminal_*` commands admit `spawn`, `write`, `kill`,
//! `rotate_claim` and `revoke_claim` through [`admit`], so a resend after a lost
//! reply never spawns a second PTY, types a chunk twice or rotates a claim
//! twice.
//!
//! | kind                    | class                       | replay                          |
//! |-------------------------|-----------------------------|---------------------------------|
//! | `terminal_spawn`        | create, entity = the PTY    | the PTY + a FRESH claim         |
//! | `terminal_write`        | command                     | ok (the chunk is not re-typed)  |
//! | `terminal_kill`         | command                     | ok                              |
//! | `terminal_rotate_claim` | command, receipt-only       | `OUTCOME_UNKNOWN` (see below)   |
//! | `terminal_revoke_claim` | command, receipt-only       | ok                              |
//!
//! Every other terminal request (resize, detach, protection, renderer refs,
//! orphan detection, visibility, reads) is naturally idempotent and never
//! enters the ledger; `list_preserved` is a write in disguise (it re-issues
//! claims) and is deliberately never replayed.
//!
//! Nothing here stores a credential: the ledger records only that the command
//! succeeded or its rejection code, and a spawn replay builds its reply from
//! the live PTY and issues a fresh claim to the resender. A replayed
//! `rotate_claim` cannot hand out the new credential (it was never kept), so it
//! answers `OUTCOME_UNKNOWN` and the client recovers through `list_preserved`.
//!
//! A command without a `commandId` keeps today's behavior on every carrier.

use std::future::Future;
use std::sync::Arc;

use serde_json::Value;
use tauri::ipc::{Channel, Response};
use parking_lot::Mutex;
use tracing::warn;

use crate::pty::manager::SpawnedTerminal;
use crate::pty::{PtyManager, SpawnOptions};
use crate::web::command_ledger::{
    is_valid_command_id, run_command_released, ClassKind, Command, CommandClass, CommandLedger,
    CommandResult, Fingerprint, Ran, Replay, Settled, MAX_COMMAND_ID_LEN,
};

/// Wire code of a malformed `commandId`.
pub const INVALID_COMMAND_ID_CODE: &str = "INVALID_COMMAND_ID";
/// Wire code of a `commandId` reused for a different request.
pub const COMMAND_CONFLICT_CODE: &str = "COMMAND_CONFLICT";
/// Wire code of a resend whose outcome is gone (it was not run again).
pub const OUTCOME_UNKNOWN_CODE: &str = "OUTCOME_UNKNOWN";
/// Tauri-only wire code of a resend while the first run is still going (the
/// `/terminal/ws` reply is the `{receipt:"in_progress"}` payload).
pub const COMMAND_IN_PROGRESS_CODE: &str = "COMMAND_IN_PROGRESS";

/// Kinds of the terminal classes.
pub const SPAWN: &str = "terminal_spawn";
pub const WRITE: &str = "terminal_write";
pub const KILL: &str = "terminal_kill";
pub const ROTATE_CLAIM: &str = "terminal_rotate_claim";
pub const REVOKE_CLAIM: &str = "terminal_revoke_claim";

/// Rejection codes a terminal command records; replays map the stored string
/// back to one of these.
const REJECTION_CODES: &[&str] = &[
    "SPAWN_FAILED",
    "WRITE_FAILED",
    "KILL_FAILED",
    "UNAUTHORIZED",
    OUTCOME_UNKNOWN_CODE,
];

/// Every ledgered terminal kind and its class. The spawn is a create whose
/// reply carries a claim, so it is receipt-only: its payload is never stored
/// and the replay is rebuilt from the PTY.
pub const TERMINAL_COMMAND_CLASSES: &[(&str, CommandClass)] = &[
    (
        SPAWN,
        CommandClass {
            kind: ClassKind::Create,
            replay: Some(Replay::ReceiptOnly),
        },
    ),
    (
        WRITE,
        CommandClass {
            kind: ClassKind::Command,
            replay: Some(Replay::Payload),
        },
    ),
    (
        KILL,
        CommandClass {
            kind: ClassKind::Command,
            replay: Some(Replay::Payload),
        },
    ),
    (
        ROTATE_CLAIM,
        CommandClass {
            kind: ClassKind::Command,
            replay: Some(Replay::ReceiptOnly),
        },
    ),
    (
        REVOKE_CLAIM,
        CommandClass {
            kind: ClassKind::Command,
            replay: Some(Replay::ReceiptOnly),
        },
    ),
];

/// The ledgered kind of a `/terminal/ws` request type, `None` for the
/// requests that never enter the ledger.
#[must_use]
pub fn ws_kind(request_type: &str) -> Option<&'static str> {
    Some(match request_type {
        "spawn" => SPAWN,
        "write" => WRITE,
        "kill" => KILL,
        "rotate_claim" => ROTATE_CLAIM,
        "revoke_claim" => REVOKE_CLAIM,
        _ => return None,
    })
}

fn class_of_kind(kind: &str) -> Option<CommandClass> {
    TERMINAL_COMMAND_CLASSES
        .iter()
        .find(|(name, _)| *name == kind)
        .map(|(_, class)| *class)
}

/// A refusal text for a malformed `commandId`.
#[must_use]
pub fn invalid_command_id_message() -> String {
    format!(
        "commandId must be 1-{MAX_COMMAND_ID_LEN} characters of A-Z, a-z, 0-9, `_` or `-`"
    )
}

/// A digest of a terminal request's identity: the kind plus the entity-naming
/// fields (terminal id, project, cwd, program...). Never env, args, input
/// text, claims or any other content, so one id is consistent across the
/// `/terminal/ws` and Tauri carriers and the digest derives from nothing
/// secret.
#[must_use]
pub fn fingerprint(kind: &str, fields: &[(&str, Option<&str>)]) -> Fingerprint {
    let mut identity = String::from(kind);
    for (name, value) in fields {
        if let Some(value) = value {
            identity.push('\u{0}');
            identity.push_str(name);
            identity.push('=');
            identity.push_str(&value.len().to_string());
            identity.push(':');
            identity.push_str(value);
        }
    }
    Fingerprint::of(&identity, &Value::Null)
}

/// The conflict fingerprint of a spawn (project, cwd, shell, program, kind).
#[must_use]
pub fn spawn_fingerprint(options: &SpawnOptions) -> Fingerprint {
    fingerprint(
        SPAWN,
        &[
            ("projectId", options.project_id.as_deref()),
            ("cwd", options.cwd.as_deref()),
            ("shell", options.shell.as_deref()),
            ("program", options.program.as_deref()),
            ("kind", options.kind.as_deref()),
        ],
    )
}

/// What the run of a command settled on, produced by the carrier's closure.
pub enum Effect<T> {
    /// It ran and succeeded. Only the fact is recorded, never `T`.
    Done(T),
    /// It ran and failed; the rejection is recorded and replayed.
    Failed { code: &'static str, message: String },
    /// It failed without any effect (a spawn that failed before a PTY existed,
    /// an unauthorized caller): no outcome is recorded and the id is free for a
    /// retry to execute.
    Released { code: &'static str, message: String },
}

/// The verdict for one admitted command.
#[derive(Debug)]
pub enum Outcome<T> {
    /// Executed now.
    Executed(T),
    /// A resend answered from the entity the command stamped (the live PTY).
    Found(T),
    /// A resend of a command that succeeded; nothing is retained to replay.
    Receipt,
    /// The command was rejected (now, or originally).
    Rejected { code: &'static str, message: String },
    /// The first run is still going after the bounded wait.
    InProgress,
    /// The outcome is gone; the command was NOT run again.
    Unknown,
    /// The id belongs to a different request.
    Conflict,
    /// The `commandId` is malformed.
    InvalidId,
}

/// The success shapes of an [`Outcome`] once the refusals are split off.
#[derive(Debug)]
pub enum Done<T> {
    Executed(T),
    Found(T),
    Receipt,
    InProgress,
}

impl<T> Outcome<T> {
    /// Split the carrier-neutral refusals (`code`, `message`) from the
    /// successes. `kind` only words the messages.
    pub fn into_result(self, kind: &str) -> Result<Done<T>, (&'static str, String)> {
        match self {
            Self::Executed(value) => Ok(Done::Executed(value)),
            Self::Found(value) => Ok(Done::Found(value)),
            Self::Receipt => Ok(Done::Receipt),
            Self::InProgress => Ok(Done::InProgress),
            Self::Rejected { code, message } => Err((code, message)),
            Self::Unknown => Err((
                OUTCOME_UNKNOWN_CODE,
                format!(
                    "the outcome of this `{kind}` is no longer known; it was not run again. Check the terminal's state before retrying"
                ),
            )),
            Self::Conflict => Err((
                COMMAND_CONFLICT_CODE,
                format!("this commandId was already used for a different `{kind}` request"),
            )),
            Self::InvalidId => Err((INVALID_COMMAND_ID_CODE, invalid_command_id_message())),
        }
    }
}

fn static_code(code: &str) -> &'static str {
    REJECTION_CODES
        .iter()
        .find(|known| **known == code)
        .copied()
        .unwrap_or("REJECTED")
}

fn accepted() -> Settled {
    Settled::Accepted {
        payload: None,
        visible_at: None,
    }
}

/// Admit one terminal command: record it BEFORE it executes, run `execute`
/// unless an earlier run already decided it, and answer a resend with the
/// original outcome class.
///
/// `lookup` finds the entity a create stamped (the live PTY for a spawn); it
/// runs before the first execution and on every resend, so a resend whose
/// ledger entry was evicted still resolves. `execute` runs on its own task: a
/// carrier that goes away mid-command does not cancel the effect, so the
/// outcome is still recorded; a panic is re-raised here and leaves `Unknown`.
pub async fn admit<T, E, L>(
    ledger: &Arc<CommandLedger>,
    kind: &'static str,
    id: &str,
    fingerprint: Fingerprint,
    lookup: L,
    execute: E,
) -> Outcome<T>
where
    T: Send + 'static,
    E: Future<Output = Effect<T>> + Send + 'static,
    L: Fn() -> Option<T> + Send + Sync,
{
    /// The value a run or an entity lookup produced; the ledger stores only
    /// the fact (never the value), so it travels beside the verdict.
    enum Produced<T> {
        Executed(T),
        Found(T),
    }

    if !is_valid_command_id(id) {
        return Outcome::InvalidId;
    }
    let Some(class) = class_of_kind(kind) else {
        warn!(target: "termul::web::command_ledger", kind, "terminal kind has no class");
        return Outcome::Unknown;
    };
    let produced: Arc<Mutex<Option<Produced<T>>>> = Arc::new(Mutex::new(None));
    let found_slot = Arc::clone(&produced);
    let run_slot = Arc::clone(&produced);
    let verdict = run_command_released(
        ledger,
        Command {
            id,
            kind,
            class,
            fingerprint,
        },
        move || {
            let found = lookup().map(|value| {
                *found_slot.lock() = Some(Produced::Found(value));
                accepted()
            });
            std::future::ready(found)
        },
        async move {
            match execute.await {
                Effect::Done(value) => {
                    *run_slot.lock() = Some(Produced::Executed(value));
                    Ran::Settled(accepted())
                }
                Effect::Failed { code, message } => Ran::Settled(Settled::Rejected {
                    code: code.to_string(),
                    message,
                }),
                Effect::Released { code, message } => Ran::Released(Settled::Rejected {
                    code: code.to_string(),
                    message,
                }),
            }
        },
    )
    .await;
    match verdict {
        CommandResult::Done(Settled::Rejected { code, message }) => Outcome::Rejected {
            code: static_code(&code),
            message,
        },
        CommandResult::Done(Settled::Accepted { .. }) => match produced.lock().take() {
            Some(Produced::Executed(value)) => Outcome::Executed(value),
            Some(Produced::Found(value)) => Outcome::Found(value),
            // A create that succeeded whose PTY is gone is never respawned.
            None if class.creates_entity() => Outcome::Unknown,
            None => Outcome::Receipt,
        },
        CommandResult::InProgress => Outcome::InProgress,
        CommandResult::Unknown => Outcome::Unknown,
        CommandResult::Conflict => Outcome::Conflict,
    }
}

/// Run a non-spawn command (`write`, `kill`, `rotate_claim`, `revoke_claim`)
/// under the ledger. `fields` name the entity for the conflict fingerprint.
pub async fn command<T, E>(
    ledger: &Arc<CommandLedger>,
    kind: &'static str,
    id: &str,
    fields: &[(&str, Option<&str>)],
    execute: E,
) -> Outcome<T>
where
    T: Send + 'static,
    E: Future<Output = Effect<T>> + Send + 'static,
{
    admit(ledger, kind, id, fingerprint(kind, fields), || None, execute).await
}

/// Spawn a terminal. With `options.command_id` the spawn is recorded BEFORE a
/// terminal slot is reserved, a concurrent same-id spawn waits for the first,
/// a resend answers with the existing PTY plus a FRESH claim (never a second
/// PTY, never the first claim), and a spawn that fails releases the id so a
/// retry executes. Without a `commandId` this is a plain spawn.
///
/// On the desktop the replay's new `on_data` channel is dropped: the original
/// channel stays bound to the PTY, so the client attaches to receive output.
pub async fn spawn(
    ledger: &Arc<CommandLedger>,
    pty: &Arc<PtyManager>,
    options: SpawnOptions,
    on_data: Option<Channel<Response>>,
) -> Outcome<SpawnedTerminal> {
    let Some(id) = options.command_id.clone() else {
        return match pty.spawn(options, on_data).await {
            Ok(spawned) => Outcome::Executed(spawned),
            Err(message) => Outcome::Rejected {
                code: "SPAWN_FAILED",
                message,
            },
        };
    };
    let print = spawn_fingerprint(&options);
    let lookup_pty = Arc::clone(pty);
    let lookup_id = id.clone();
    let project_id = options.project_id.clone();
    let run_pty = Arc::clone(pty);
    let run_id = id.clone();
    admit(
        ledger,
        SPAWN,
        &id,
        print,
        move || lookup_pty.replay_spawn(&lookup_id, project_id.as_deref()),
        async move {
            // A PTY already carries this id but no claim could be issued for
            // it (revoked): never spawn a second one for the same command.
            if run_pty.find_by_command_id(&run_id).is_some() {
                return Effect::Released {
                    code: OUTCOME_UNKNOWN_CODE,
                    message: "the terminal of this spawn exists but its credential was revoked; list preserved terminals to recover one".to_string(),
                };
            }
            match run_pty.spawn(options, on_data).await {
                Ok(spawned) => Effect::Done(spawned),
                Err(message) => Effect::Released {
                    code: "SPAWN_FAILED",
                    message,
                },
            }
        },
    )
    .await
}
