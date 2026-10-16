use super::IpcResult;
use crate::pty::claims::RotatedClaim;
use crate::pty::manager::{PreservedTerminal, SpawnedTerminal, TerminalAttachResult, TerminalInstance};
use crate::pty::{PtyManager, SpawnOptions};
use crate::trackers::{CwdTracker, ExitCodeTracker, GitStatus, GitTracker};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::ipc::{Channel, Response};
use tauri::State;

use crate::web::command_ledger::terminal::{self as ledgered, Done, Effect, Outcome};
use crate::web::WsRelaySink;

/// Terminal visibility state
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetVisibilityRequest {
    pub is_visible: bool,
}

// ==================== Terminal Commands ====================

/// Spawn a new terminal with binary data channel
///
/// The `on_data` channel uses Tauri 2's Channel API for
/// zero-overhead binary IPC. PTY output is sent as raw `Vec<u8>` via
/// `Response::new(bytes)`, arriving in JS as `ArrayBuffer` with no JSON
/// serialization overhead.
///
/// CAP-3: the response carries the terminal info PLUS the issued `claim`
/// credential (flattened camelCase, same shape as the web `spawn` reply).
/// This is the only issuance path.
///
/// `options.commandId` makes a resend after a lost reply safe: it answers with
/// the existing terminal plus a FRESH claim (never a second PTY). The reply
/// has the same shape as a first spawn, but the resend's new `on_data` channel
/// is dropped — the first spawn's channel stays bound to the PTY — so the
/// client MUST follow a replay with `terminal_attach` using the fresh claim.
/// A spawn that fails frees the id for a retry; a resend after the terminal is
/// gone answers `OUTCOME_UNKNOWN` instead of spawning again.
#[tauri::command]
pub async fn terminal_spawn(
    options: SpawnOptions,
    on_data: Channel<Response>,
    pty_manager: State<'_, Arc<PtyManager>>,
    relay: State<'_, Arc<WsRelaySink>>,
) -> Result<IpcResult<SpawnedTerminal>, String> {
    let outcome = ledgered::spawn(relay.ledger(), pty_manager.inner(), options, Some(on_data)).await;
    Ok(terminal_value_reply(outcome, ledgered::SPAWN))
}

/// The IPC reply of a unit-returning ledgered command: a replay of a command
/// that succeeded is a plain success.
pub(crate) fn terminal_unit_reply(outcome: Outcome<()>, kind: &str) -> IpcResult<()> {
    match outcome.into_result(kind) {
        Ok(Done::InProgress) => in_progress_error(kind),
        Ok(_) => IpcResult::success(()),
        Err((code, message)) => IpcResult::error(message, code),
    }
}

/// The IPC reply of a value-returning ledgered command. A replay that holds no
/// value (a rotation: the credential was never kept) is `OUTCOME_UNKNOWN`.
pub(crate) fn terminal_value_reply<T: Send + 'static>(outcome: Outcome<T>, kind: &str) -> IpcResult<T> {
    match outcome.into_result(kind) {
        Ok(Done::Executed(value) | Done::Found(value)) => IpcResult::success(value),
        Ok(Done::InProgress) => in_progress_error(kind),
        Ok(Done::Receipt) => IpcResult::error(
            format!(
                "this `{kind}` already ran but its reply is not retained; list preserved terminals to recover a fresh credential"
            ),
            ledgered::OUTCOME_UNKNOWN_CODE,
        ),
        Err((code, message)) => IpcResult::error(message, code),
    }
}

fn in_progress_error<T>(kind: &str) -> IpcResult<T> {
    IpcResult::error(
        format!("the first run of this `{kind}` is still going; resend later"),
        ledgered::COMMAND_IN_PROGRESS_CODE,
    )
}

/// Milliseconds between claim-generation checks in a desktop attach forwarder.
/// Bounds how long a forwarder survives a rotate/revoke while its terminal is
/// idle (no output events to piggyback the check on).
pub(crate) const ATTACH_FORWARDER_GENERATION_CHECK_MS: u64 = 250;

/// Tracked desktop attach forwarders: terminal_id → (token, abort handle).
/// Exactly one live forwarder per terminal — a re-attach aborts the
/// predecessor; rotate/revoke terminate it via the claim generation bump.
static ATTACH_FORWARDERS: OnceLock<Mutex<HashMap<String, (u64, tokio::task::AbortHandle)>>> =
    OnceLock::new();
static ATTACH_FORWARDER_TOKENS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn attach_forwarders() -> &'static Mutex<HashMap<String, (u64, tokio::task::AbortHandle)>> {
    ATTACH_FORWARDERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Recover the forwarder map guard even if a holder panicked while holding the
/// lock — silently skipping on poison would skip predecessor aborts and leak
/// entries.
fn lock_forwarders(
) -> std::sync::MutexGuard<'static, HashMap<String, (u64, tokio::task::AbortHandle)>> {
    attach_forwarders()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Teardown condition for an attach forwarder, pure for testability. Shared
/// by the desktop forwarder and the web attachment task (CAP-3 amendment R1:
/// invalidation severs EVERY access derived from the credential, on all
/// connections).
///
/// A forwarder must terminate when the captured claim generation no longer
/// matches the registry: a bump means rotate/revoke invalidated the credential
/// this stream was derived from, and a missing record (`None`) means the
/// terminal was killed/reaped.
pub(crate) fn forwarder_should_terminate(
    captured_generation: Option<u64>,
    current_generation: Option<u64>,
) -> bool {
    captured_generation != current_generation
}

/// Attach to a terminal's output stream with a claim credential (CAP-3).
///
/// Verification is the gate: `terminalId` + valid `claim` + `lastSeq`. Any
/// verification failure (unknown terminal, missing/wrong/revoked credential,
/// binding mismatch) returns ONE generic UNAUTHORIZED error — no response
/// shape distinguishes the cases (existence leak stays fixed). On success the
/// ring-bounded replay (chunks with `seq > lastSeq`) is delivered through the
/// raw-bytes channel, then a tracked forwarder streams live output.
///
/// Forwarder lifecycle: exactly one per terminal — this command aborts any
/// predecessor before installing the new one; rotate/revoke bump the claim
/// generation, which the forwarder observes and terminates on. The PTY is
/// never touched by attach failures or forwarder teardown.
#[tauri::command]
pub async fn terminal_attach(
    terminal_id: String,
    claim: String,
    last_seq: u64,
    log_epoch: Option<String>,
    on_data: Channel<Response>,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Result<IpcResult<TerminalAttachResult>, String> {
    Ok(attach_terminal(
        pty_manager.inner(),
        terminal_id,
        &claim,
        last_seq,
        log_epoch.as_deref(),
        on_data,
    ))
}

struct ForwarderAttachment(Arc<TerminalInstance>);

impl ForwarderAttachment {
    fn take(instance: Arc<TerminalInstance>) -> Self {
        instance.add_live_attachment();
        Self(instance)
    }
}

impl Drop for ForwarderAttachment {
    fn drop(&mut self) {
        self.0.remove_live_attachment();
    }
}

/// Takes the successor's count so the live-attachment count never touches
/// zero mid-swap: a zero lets a web `list_preserved` replace the claim and
/// end the successor's stream.
fn abort_predecessor(terminal_id: &str, _successor: &ForwarderAttachment) {
    let mut forwarders = lock_forwarders();
    if let Some((_, previous)) = forwarders.remove(terminal_id) {
        previous.abort();
        log::info!(
            "[terminal-attach] aborted previous forwarder terminal_id={}",
            terminal_id
        );
    }
}

pub(crate) fn attach_terminal(
    pty_manager: &Arc<PtyManager>,
    terminal_id: String,
    claim: &str,
    last_seq: u64,
    log_epoch: Option<&str>,
    on_data: Channel<Response>,
) -> IpcResult<TerminalAttachResult> {
    // Capture the generation BEFORE verifying (TOCTOU-safe ordering): if a
    // rotate/revoke lands between capture and verify, verify fails (the
    // credential was invalidated) and we reject; if it lands after verify, the
    // captured generation is stale and the forwarder terminates on its next
    // check. Capturing after verify would invert the race and let an
    // invalidated credential stream forever.
    let generation = pty_manager.claim_generation(&terminal_id);
    if pty_manager.verify_claim(&terminal_id, claim).is_err() {
        // Registry already logged the failure (terminal id, never the
        // credential). Keep the response generic.
        return IpcResult::error("Unauthorized", "UNAUTHORIZED");
    }
    let Some(instance) = pty_manager.get(&terminal_id) else {
        // Verified a heartbeat ago but gone now — same generic error.
        return IpcResult::error("Unauthorized", "UNAUTHORIZED");
    };

    // Bounded replay + live subscription snapshot atomically (existing seq
    // infra, unchanged).
    let replay = instance.subscribe_from(last_seq, log_epoch);
    let result = pty_manager.build_attach_result(&instance, &replay);

    let attachment = ForwarderAttachment::take(Arc::clone(&instance));

    // Single-forwarder invariant: abort the predecessor BEFORE delivering the
    // replay so it cannot interleave a duplicate stream.
    let token = ATTACH_FORWARDER_TOKENS.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    abort_predecessor(&terminal_id, &attachment);

    for chunk in &replay.chunks {
        if on_data.send(Response::new(chunk.data.clone())).is_err() {
            log::warn!(
                "[terminal-attach] replay channel closed terminal_id={}",
                terminal_id
            );
            return IpcResult::success(result);
        }
    }

    let pty = Arc::clone(pty_manager);
    let forwarder_id = terminal_id.clone();
    let handle = tokio::spawn(async move {
        let _attachment = attachment;
        let mut tick = tokio::time::interval(std::time::Duration::from_millis(
            ATTACH_FORWARDER_GENERATION_CHECK_MS,
        ));
        let mut receiver = replay.receiver;
        loop {
            // Teardown on rotate/revoke (generation bump) or kill/reap
            // (record gone). Checked every tick AND after every chunk.
            if forwarder_should_terminate(generation, pty.claim_generation(&forwarder_id)) {
                log::info!(
                    "[terminal-attach] forwarder terminating (claim invalidated) terminal_id={}",
                    forwarder_id
                );
                break;
            }
            tokio::select! {
                received = receiver.recv() => {
                    match received {
                        Ok(chunk) => {
                            if on_data.send(Response::new(chunk.data)).is_err() {
                                break; // renderer channel gone
                            }
                        }
                        // Desktop's raw-bytes channel has no gap framing
                        // (deferred parity decision) — keep streaming.
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                            log::warn!(
                                "[terminal-attach] output receiver lagged by {skipped} for {forwarder_id}"
                            );
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
                _ = tick.tick() => {}
            }
        }
        // Self-deregister only if this forwarder is still the tracked one (a
        // later re-attach may have replaced the entry already).
        let mut forwarders = lock_forwarders();
        if let Some((tracked_token, _)) = forwarders.get(&forwarder_id) {
            if *tracked_token == token {
                forwarders.remove(&forwarder_id);
            }
        }
    });

    if !handle.is_finished() {
        let mut forwarders = lock_forwarders();
        // A concurrent attach may have raced — keep this (latest) forwarder
        // and abort any rival: exactly one survives, last attach wins. A
        // forwarder that already terminated (e.g. a generation bump raced the
        // spawn) is never registered, so no dead entry lingers in the map.
        if let Some((prev_token, prev_abort)) =
            forwarders.insert(terminal_id.clone(), (token, handle.abort_handle()))
        {
            if prev_token != token {
                prev_abort.abort();
            }
        }
    }

    log::info!(
        "[terminal-attach] attached terminal_id={} latest_seq={} gap={}",
        terminal_id,
        result.latest_seq,
        result.gap
    );
    IpcResult::success(result)
}

/// List the terminals the host still runs for a project, each with a freshly
/// issued claim, so a reloaded renderer reattaches to them instead of
/// spawning new shells.
///
/// Re-issue replaces the claim record of a terminal no one streams, which
/// invalidates the credential the dead page held. A terminal with a live
/// stream (a web client, or a desktop forwarder) gets a shared claim instead.
/// Never ledgered: every call re-issues, so a resend just lists again.
#[tauri::command]
pub async fn terminal_list_preserved(
    project_id: String,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Result<IpcResult<Vec<PreservedTerminal>>, String> {
    Ok(list_preserved_reply(pty_manager.inner(), &project_id))
}

pub(crate) fn list_preserved_reply(
    pty_manager: &PtyManager,
    project_id: &str,
) -> IpcResult<Vec<PreservedTerminal>> {
    if project_id.is_empty() {
        return IpcResult::error("missing projectId", "VALIDATION_ERROR");
    }
    let preserved = pty_manager.list_preserved(project_id);
    log::info!(
        "[terminal-list-preserved] project_id={} count={} live_attachments={}",
        project_id,
        preserved.len(),
        preserved.iter().filter(|entry| entry.live_attachment).count()
    );
    IpcResult::success(preserved)
}

/// Rotate a terminal's claim credential (CAP-3).
///
/// Possession-based: presenting the current credential yields a fresh one and
/// atomically invalidates the old. Any verification failure returns the same
/// generic UNAUTHORIZED error as attach. The generation bump terminates the
/// tracked desktop attach forwarder (teardown of the invalidated holder's
/// access) while the PTY itself keeps running.
///
/// With a `commandId` a resend of a rotation that already applied answers
/// `OUTCOME_UNKNOWN` (the new credential was never retained); the client
/// recovers a fresh one through `list_preserved`.
#[tauri::command]
pub async fn terminal_rotate_claim(
    terminal_id: String,
    claim: String,
    command_id: Option<String>,
    pty_manager: State<'_, Arc<PtyManager>>,
    relay: State<'_, Arc<WsRelaySink>>,
) -> Result<IpcResult<RotatedClaim>, String> {
    let command_id = match ledgered::required_command_id(ledgered::ROTATE_CLAIM, command_id.as_deref()) {
        Ok(id) => id.to_string(),
        Err((code, message)) => return Ok(IpcResult::error(message, code)),
    };
    let pty = Arc::clone(pty_manager.inner());
    let target = terminal_id.clone();
    let outcome = ledgered::command(
        relay.ledger(),
        ledgered::ROTATE_CLAIM,
        &command_id,
        &[("terminalId", Some(&terminal_id))],
        async move {
            match pty.rotate_claim(&target, &claim) {
                Ok(new_claim) => Effect::Done(RotatedClaim { claim: new_claim }),
                Err(_) => Effect::Released {
                    code: "UNAUTHORIZED",
                    message: "Unauthorized".to_string(),
                },
            }
        },
    )
    .await;
    Ok(terminal_value_reply(outcome, ledgered::ROTATE_CLAIM))
}

/// Revoke a terminal's claim credential (CAP-3).
///
/// The PTY survives (never-clause) and stays attachable by a client holding a
/// newly rotated credential; only the presented credential is invalidated. The
/// generation bump terminates the tracked desktop attach forwarder. Any
/// verification failure returns the same generic UNAUTHORIZED error. With a
/// `commandId` a resend of a revocation that already applied answers ok.
#[tauri::command]
pub async fn terminal_revoke_claim(
    terminal_id: String,
    claim: String,
    command_id: Option<String>,
    pty_manager: State<'_, Arc<PtyManager>>,
    relay: State<'_, Arc<WsRelaySink>>,
) -> Result<IpcResult<()>, String> {
    let command_id = match ledgered::required_command_id(ledgered::REVOKE_CLAIM, command_id.as_deref()) {
        Ok(id) => id.to_string(),
        Err((code, message)) => return Ok(IpcResult::error(message, code)),
    };
    let pty = Arc::clone(pty_manager.inner());
    let target = terminal_id.clone();
    let outcome = ledgered::command(
        relay.ledger(),
        ledgered::REVOKE_CLAIM,
        &command_id,
        &[("terminalId", Some(&terminal_id))],
        async move {
            match pty.revoke_claim(&target, &claim) {
                Ok(()) => Effect::Done(()),
                Err(_) => Effect::Released {
                    code: "UNAUTHORIZED",
                    message: "Unauthorized".to_string(),
                },
            }
        },
    )
    .await;
    Ok(terminal_unit_reply(outcome, ledgered::REVOKE_CLAIM))
}

/// Write data to a terminal
///
/// The `commandId` is optional on the desktop (see the body); with one a resend
/// of a chunk that already reached the PTY answers ok instead of typing it twice.
#[tauri::command]
pub async fn terminal_write(
    terminal_id: String,
    data: String,
    command_id: Option<String>,
    pty_manager: State<'_, Arc<PtyManager>>,
    relay: State<'_, Arc<WsRelaySink>>,
) -> Result<IpcResult<()>, String> {
    // The desktop IPC has no lost-reply window and a keystroke per ledger entry
    // would flood the shared ledger: an id is optional here and a write without
    // one is plain. (`/terminal/ws` write requires one per chunk.)
    let Some(command_id) = command_id else {
        return Ok(match pty_manager.write(&terminal_id, &data).await {
            Ok(()) => IpcResult::success(()),
            Err(e) => IpcResult::error(e, "WRITE_FAILED"),
        });
    };
    let pty = Arc::clone(pty_manager.inner());
    let target = terminal_id.clone();
    // The chunk is identified by its terminal and length, never its text.
    let length = data.len().to_string();
    let outcome = ledgered::command(
        relay.ledger(),
        ledgered::WRITE,
        &command_id,
        &[("terminalId", Some(&terminal_id)), ("length", Some(&length))],
        async move {
            match pty.write(&target, &data).await {
                Ok(()) => Effect::Done(()),
                Err(message) => Effect::Failed {
                    code: "WRITE_FAILED",
                    message,
                },
            }
        },
    )
    .await;
    Ok(terminal_unit_reply(outcome, ledgered::WRITE))
}

/// Resize a terminal
#[tauri::command]
pub async fn terminal_resize(
    terminal_id: String,
    cols: u16,
    rows: u16,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Result<IpcResult<()>, String> {
    match pty_manager.resize(&terminal_id, cols, rows).await {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "RESIZE_FAILED")),
    }
}

/// Kill a terminal
///
/// With a `commandId` a repeat after a successful kill answers ok instead of
/// failing with "Terminal not found".
#[tauri::command]
pub async fn terminal_kill(
    terminal_id: String,
    command_id: Option<String>,
    pty_manager: State<'_, Arc<PtyManager>>,
    relay: State<'_, Arc<WsRelaySink>>,
) -> Result<IpcResult<()>, String> {
    let command_id = match ledgered::required_command_id(ledgered::KILL, command_id.as_deref()) {
        Ok(id) => id.to_string(),
        Err((code, message)) => return Ok(IpcResult::error(message, code)),
    };
    let pty = Arc::clone(pty_manager.inner());
    let target = terminal_id.clone();
    let outcome = ledgered::command(
        relay.ledger(),
        ledgered::KILL,
        &command_id,
        &[("terminalId", Some(&terminal_id))],
        async move {
            match pty.kill(&target).await {
                Ok(()) => Effect::Done(()),
                Err(message) => Effect::Failed {
                    code: "KILL_FAILED",
                    message,
                },
            }
        },
    )
    .await;
    Ok(terminal_unit_reply(outcome, ledgered::KILL))
}

/// Get the current working directory for a terminal
#[tauri::command]
pub async fn terminal_get_cwd(
    terminal_id: String,
    cwd_tracker: State<'_, Arc<CwdTracker>>,
) -> Result<IpcResult<Option<String>>, String> {
    let cwd = cwd_tracker.get_cwd(&terminal_id);
    Ok(IpcResult::success(cwd))
}

/// Get the git branch for a terminal
#[tauri::command]
pub async fn terminal_get_git_branch(
    terminal_id: String,
    git_tracker: State<'_, Arc<GitTracker>>,
) -> Result<IpcResult<Option<String>>, String> {
    let branch = git_tracker.get_branch(&terminal_id);
    Ok(IpcResult::success(branch))
}

/// Get the git status for a terminal
#[tauri::command]
pub async fn terminal_get_git_status(
    terminal_id: String,
    git_tracker: State<'_, Arc<GitTracker>>,
) -> Result<IpcResult<Option<GitStatus>>, String> {
    let status = git_tracker.get_status(&terminal_id);
    Ok(IpcResult::success(status))
}

/// Get the exit code for a terminal
#[tauri::command]
pub async fn terminal_get_exit_code(
    terminal_id: String,
    exit_code_tracker: State<'_, Arc<ExitCodeTracker>>,
) -> Result<IpcResult<Option<i32>>, String> {
    let exit_code = exit_code_tracker.get_exit_code(&terminal_id);
    Ok(IpcResult::success(exit_code))
}

/// Set visibility state (affects polling behavior and PTY kill deferral)
#[tauri::command]
pub async fn terminal_set_visibility(
    request: SetVisibilityRequest,
    pty_manager: State<'_, Arc<PtyManager>>,
    cwd_tracker: State<'_, Arc<CwdTracker>>,
    git_tracker: State<'_, Arc<GitTracker>>,
) -> Result<IpcResult<()>, String> {
    pty_manager.set_hidden(!request.is_visible);
    cwd_tracker.set_visibility(request.is_visible);
    git_tracker.set_visibility(request.is_visible);
    Ok(IpcResult::success(()))
}
