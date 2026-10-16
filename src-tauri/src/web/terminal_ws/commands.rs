//! The `/terminal/ws` requests that enter the command ledger (AD-5): `spawn`,
//! `write`, `kill`, `rotate_claim` and `revoke_claim`.
//!
//! A request WITHOUT a `commandId` is refused with `INVALID_COMMAND_ID` before
//! it runs. With one it is admitted through `command_ledger::terminal` AFTER the
//! capability gate in [`handle`](super::handle) (a refused request leaves no
//! ledger entry) and after any per-terminal authorization that must not be
//! recorded.
//!
//! The `commandId` is the request envelope's `commandId`; a `spawn` may also
//! carry it as `payload.commandId` (the field rides `SpawnOptions`, like on the
//! desktop carrier), and both must agree when both are present.

use crate::web::command_ledger::terminal::{
    self as ledgered, Done, Effect, INVALID_COMMAND_ID_CODE, OUTCOME_UNKNOWN_CODE,
};

use super::*;

type Failure = (&'static str, String);

/// `{"receipt": "in_progress"}`: the first run of this command is still going;
/// the client stays pending and resends later.
fn in_progress_reply() -> Value {
    json!({ "receipt": "in_progress" })
}

/// The `commandId` of a ledgered request: required and well-formed.
fn required(kind: &str, command_id: Option<&str>) -> Result<String, Failure> {
    ledgered::required_command_id(kind, command_id).map(str::to_string)
}

/// The `spawn` request's `commandId`: the envelope's and the payload's must
/// agree when both are present; one of them is required.
fn spawn_command_id(
    envelope: Option<&str>,
    payload: Option<&str>,
) -> Result<String, Failure> {
    if let (Some(envelope), Some(payload)) = (envelope, payload) {
        if envelope != payload {
            return Err((
                INVALID_COMMAND_ID_CODE,
                "the request commandId and payload.commandId differ".to_string(),
            ));
        }
    }
    required(ledgered::SPAWN, envelope.or(payload))
}

pub(super) async fn spawn(
    request: &Request,
    state: &AppState,
    ctx: &mut ConnectionContext,
) -> Result<Value, Failure> {
    let mut options = SpawnOptions::deserialize(&request.payload)
        .map_err(|e| ("VALIDATION_ERROR", e.to_string()))?;
    options.command_id = Some(spawn_command_id(
        request.command_id.as_deref(),
        options.command_id.as_deref(),
    )?);
    // Require project_id so the terminal is scoped — do not default
    // to a literal that any client can target.
    if options
        .project_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .is_none()
    {
        return Err((
            "VALIDATION_ERROR",
            "spawn requires a non-empty projectId".to_string(),
        ));
    }
    // A project being removed or archived takes no new terminals.
    if let Some(project_id) = options.project_id.as_deref() {
        if state.registry.is_removing(project_id) {
            return Err((
                "PROJECT_BUSY",
                format!("project '{project_id}' is being removed or archived"),
            ));
        }
    }
    info!(
        "[terminal-ws] spawn requested project_id={}",
        options.project_id.as_deref().unwrap_or("?")
    );
    // CAP-3: spawn is the only issuance path. The reply carries the
    // flattened info + claim (same camelCase shape as desktop).
    let project_id = options.project_id.clone().unwrap_or_default();
    let was_active = state.registry.is_active(&project_id);
    let outcome = ledgered::spawn(state.relay.ledger(), &state.pty, options, None).await;
    let spawned = match outcome.into_result(ledgered::SPAWN)? {
        Done::Executed(spawned) => {
            // A remove or archive that began while the terminal started could
            // not see it. Stop the terminal here instead of leaving it bound
            // to a project that is going away or gone.
            if state
                .registry
                .project_left_while_starting(&project_id, was_active)
            {
                if let Err(error) = state.pty.force_kill(&spawned.info.id).await {
                    if !error.starts_with("Terminal not found") {
                        warn!(
                            "[terminal-ws] could not stop terminal {} of removed project {project_id}: {error}",
                            spawned.info.id
                        );
                    }
                }
                return Err((
                    "PROJECT_BUSY",
                    format!("project '{project_id}' is being removed or archived"),
                ));
            }
            ctx.authorize(&spawned.info.id);
            spawned
        }
        // A resend: the PTY already exists and the reply carries a FRESH claim.
        // The connection is authorized by attaching with it, never by the
        // resend alone.
        Done::Found(spawned) => spawned,
        Done::InProgress => return Ok(in_progress_reply()),
        Done::Receipt => return Err(unknown("spawn")),
    };
    info!(
        "[terminal-ws] spawn success terminal_id={}",
        spawned.info.id
    );
    serde_json::to_value(spawned).map_err(|e| ("SPAWN_FAILED", e.to_string()))
}

pub(super) async fn write(
    request: &Request,
    state: &AppState,
    ctx: &ConnectionContext,
) -> Result<Value, Failure> {
    let terminal_id = string_field(&request.payload, "terminalId")?;
    if !ctx.is_authorized(terminal_id) {
        return Err((
            "UNAUTHORIZED",
            format!("Not authorized for terminal {terminal_id}"),
        ));
    }
    let data = string_field(&request.payload, "data")?;
    let command_id = required(ledgered::WRITE, request.command_id.as_deref())?;
    let pty = state.pty.clone();
    let client_id = ctx.client_id.clone();
    let owned_terminal = terminal_id.to_string();
    let owned_data = data.to_string();
    // #851 "single size owner": the device that last typed is
    // the size owner — record it before the write.
    let write = async move {
        if let Some(instance) = pty.get(&owned_terminal) {
            instance.note_web_size_owner(&client_id);
        }
        pty.write(&owned_terminal, &owned_data).await
    };
    // The chunk is identified by its terminal and length, never its text.
    let length = data.len().to_string();
    let outcome = ledgered::command(
        state.relay.ledger(),
        ledgered::WRITE,
        &command_id,
        &[("terminalId", Some(terminal_id)), ("length", Some(&length))],
        async move {
            match write.await {
                Ok(()) => Effect::Done(()),
                Err(message) => Effect::Failed {
                    code: "WRITE_FAILED",
                    message,
                },
            }
        },
    )
    .await;
    match outcome.into_result(ledgered::WRITE)? {
        Done::InProgress => Ok(in_progress_reply()),
        _ => Ok(Value::Null),
    }
}

pub(super) async fn kill(
    request: &Request,
    state: &AppState,
    ctx: &mut ConnectionContext,
) -> Result<Value, Failure> {
    let terminal_id = string_field(&request.payload, "terminalId")?;
    let command_id = required(ledgered::KILL, request.command_id.as_deref())?;
    // CWE-862: authorization FIRST — a connection may only kill a
    // terminal it spawned or verifiably attached to. The check collapses to the
    // single generic UNAUTHORIZED, so a client holding only the shared
    // web token can neither terminate another connection's PTY nor
    // distinguish "terminal exists but not yours" from "unknown id".
    let authorized = ctx.is_authorized(terminal_id);

    // A repeat after a successful kill answers ok from the
    // ledger BEFORE the authorization check could refuse it (the first kill
    // detached the terminal). Authorization is still enforced for the one run
    // that executes: an unauthorized caller releases the id and leaves no entry.
    let pty = state.pty.clone();
    let owned_terminal = terminal_id.to_string();
    let outcome = ledgered::command(
        state.relay.ledger(),
        ledgered::KILL,
        &command_id,
        &[("terminalId", Some(terminal_id))],
        async move {
            if !authorized {
                let (code, message) = unauthorized_error(&owned_terminal);
                return Effect::Released { code, message };
            }
            if pty.get(&owned_terminal).is_none() {
                return Effect::Done(());
            }
            match pty.force_kill(&owned_terminal).await {
                Ok(()) => Effect::Done(()),
                Err(message) => Effect::Failed {
                    code: "KILL_FAILED",
                    message,
                },
            }
        },
    )
    .await;
    match outcome.into_result(ledgered::KILL)? {
        Done::InProgress => Ok(in_progress_reply()),
        _ => {
            ctx.detach(terminal_id, state);
            Ok(Value::Null)
        }
    }
}

pub(super) async fn rotate_claim(
    request: &Request,
    state: &AppState,
    ctx: &mut ConnectionContext,
) -> Result<Value, Failure> {
    // CAP-3: possession of the current credential yields a fresh one
    // and atomically invalidates the old. Any failure — including a
    // missing/empty claim — is the same generic UNAUTHORIZED as attach
    // (missing claims flow through verification, never a shape error).
    let terminal_id = string_field(&request.payload, "terminalId")?.to_string();
    let claim = request.payload["claim"].as_str().unwrap_or("").to_string();
    let command_id = required(ledgered::ROTATE_CLAIM, request.command_id.as_deref())?;
    let pty = state.pty.clone();
    let owned_terminal = terminal_id.clone();
    let outcome = ledgered::command(
        state.relay.ledger(),
        ledgered::ROTATE_CLAIM,
        &command_id,
        &[("terminalId", Some(&terminal_id))],
        async move {
            match pty.rotate_claim(&owned_terminal, &claim) {
                Ok(rotated) => Effect::Done(rotated),
                Err(_) => {
                    let (code, message) = unauthorized_error(&owned_terminal);
                    Effect::Released { code, message }
                }
            }
        },
    )
    .await;
    let rotated = match outcome.into_result(ledgered::ROTATE_CLAIM)? {
        Done::Executed(rotated) => rotated,
        Done::InProgress => return Ok(in_progress_reply()),
        // The rotation was applied but its credential was never kept.
        Done::Found(_) | Done::Receipt => return Err(unknown("rotate_claim")),
    };
    // Teardown (amendment R1): the invalidated holder loses the output
    // stream (attachment task detached) AND write/resize access
    // (removed from the authorized set). Holders on OTHER connections
    // are severed by the claim-generation check inside their
    // attachment tasks. The PTY keeps running.
    ctx.detach(&terminal_id, state);
    info!("[terminal-ws] claim rotated terminal_id={terminal_id}");
    serde_json::to_value(crate::pty::RotatedClaim { claim: rotated })
        .map_err(|e| ("NETWORK_ERROR", e.to_string()))
}

pub(super) async fn revoke_claim(
    request: &Request,
    state: &AppState,
    ctx: &mut ConnectionContext,
) -> Result<Value, Failure> {
    // CAP-3: revocation invalidates the credential; the PTY survives
    // until explicit kill/release/expiry/shutdown. Any failure —
    // including a missing/empty claim — is the same generic
    // UNAUTHORIZED as attach.
    let terminal_id = string_field(&request.payload, "terminalId")?.to_string();
    let claim = request.payload["claim"].as_str().unwrap_or("").to_string();
    let command_id = required(ledgered::REVOKE_CLAIM, request.command_id.as_deref())?;
    let pty = state.pty.clone();
    let owned_terminal = terminal_id.clone();
    let outcome = ledgered::command(
        state.relay.ledger(),
        ledgered::REVOKE_CLAIM,
        &command_id,
        &[("terminalId", Some(&terminal_id))],
        async move {
            match pty.revoke_claim(&owned_terminal, &claim) {
                Ok(()) => Effect::Done(()),
                Err(_) => {
                    let (code, message) = unauthorized_error(&owned_terminal);
                    Effect::Released { code, message }
                }
            }
        },
    )
    .await;
    match outcome.into_result(ledgered::REVOKE_CLAIM)? {
        Done::Executed(()) => {}
        Done::InProgress => return Ok(in_progress_reply()),
        // A replay: the revocation already happened. The connection
        // may have re-attached with a fresh claim since, so it must
        // not be detached again.
        Done::Found(()) | Done::Receipt => return Ok(Value::Null),
    }
    // Teardown (amendment R1): same severing as rotate — the revoked
    // holder is a credential-less client and receives no further
    // metadata or output; other connections are severed by the
    // generation check in their attachment tasks. The PTY keeps
    // running.
    ctx.detach(&terminal_id, state);
    info!("[terminal-ws] claim revoked terminal_id={terminal_id}");
    Ok(Value::Null)
}

fn unknown(kind: &str) -> Failure {
    (
        OUTCOME_UNKNOWN_CODE,
        format!(
            "this `{kind}` already ran but its reply is not retained; list preserved terminals to recover a fresh credential"
        ),
    )
}
