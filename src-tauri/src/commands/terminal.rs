use super::IpcResult;
use crate::pty::claims::RotatedClaim;
use crate::pty::manager::{SpawnedTerminal, TerminalAttachResult};
use crate::pty::{PtyManager, SpawnOptions};
use crate::trackers::{CwdTracker, ExitCodeTracker, GitStatus, GitTracker};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::ipc::{Channel, Response};
use tauri::State;

/// Terminal visibility state
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetVisibilityRequest {
    pub is_visible: bool,
}

/// Orphan detection settings
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanDetectionSettings {
    pub enabled: bool,
    pub timeout_minutes: Option<u64>,
}

/// Renderer ref request
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererRefRequest {
    pub terminal_id: String,
    pub renderer_id: String,
}

/// Request to update a terminal's orphan-reaping protection.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetTerminalProtectedRequest {
    pub terminal_id: String,
    pub protected: bool,
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
#[tauri::command]
pub async fn terminal_spawn(
    options: SpawnOptions,
    on_data: Channel<Response>,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Result<IpcResult<SpawnedTerminal>, String> {
    match pty_manager.spawn(options, Some(on_data)).await {
        Ok(spawned) => Ok(IpcResult::success(spawned)),
        Err(e) => Ok(IpcResult::error(e, "SPAWN_FAILED")),
    }
}

/// Milliseconds between claim-generation checks in a desktop attach forwarder.
/// Bounds how long a forwarder survives a rotate/revoke while its terminal is
/// idle (no output events to piggyback the check on).
const ATTACH_FORWARDER_GENERATION_CHECK_MS: u64 = 250;

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
    on_data: Channel<Response>,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Result<IpcResult<TerminalAttachResult>, String> {
    // Capture the generation BEFORE verifying (TOCTOU-safe ordering): if a
    // rotate/revoke lands between capture and verify, verify fails (the
    // credential was invalidated) and we reject; if it lands after verify, the
    // captured generation is stale and the forwarder terminates on its next
    // check. Capturing after verify would invert the race and let an
    // invalidated credential stream forever.
    let generation = pty_manager.claim_generation(&terminal_id);
    if pty_manager.verify_claim(&terminal_id, &claim).is_err() {
        // Registry already logged the failure (terminal id, never the
        // credential). Keep the response generic.
        return Ok(IpcResult::error("Unauthorized", "UNAUTHORIZED"));
    }
    let Some(instance) = pty_manager.get(&terminal_id) else {
        // Verified a heartbeat ago but gone now — same generic error.
        return Ok(IpcResult::error("Unauthorized", "UNAUTHORIZED"));
    };

    // Bounded replay + live subscription snapshot atomically (existing seq
    // infra, unchanged).
    let replay = instance.subscribe_from(last_seq);
    let result = pty_manager.build_attach_result(&instance, &replay);

    // Single-forwarder invariant: abort the predecessor BEFORE delivering the
    // replay so it cannot interleave a duplicate stream.
    let token = ATTACH_FORWARDER_TOKENS.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    {
        let mut forwarders = lock_forwarders();
        if let Some((_, previous)) = forwarders.remove(&terminal_id) {
            previous.abort();
            log::info!(
                "[terminal-attach] aborted previous forwarder terminal_id={}",
                terminal_id
            );
        }
    }

    for chunk in &replay.chunks {
        if on_data.send(Response::new(chunk.data.clone())).is_err() {
            log::warn!(
                "[terminal-attach] replay channel closed terminal_id={}",
                terminal_id
            );
            return Ok(IpcResult::success(result));
        }
    }

    let pty = pty_manager.inner().clone();
    let forwarder_id = terminal_id.clone();
    let handle = tokio::spawn(async move {
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
    Ok(IpcResult::success(result))
}

/// Rotate a terminal's claim credential (CAP-3).
///
/// Possession-based: presenting the current credential yields a fresh one and
/// atomically invalidates the old. Any verification failure returns the same
/// generic UNAUTHORIZED error as attach. The generation bump terminates the
/// tracked desktop attach forwarder (teardown of the invalidated holder's
/// access) while the PTY itself keeps running.
#[tauri::command]
pub async fn terminal_rotate_claim(
    terminal_id: String,
    claim: String,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Result<IpcResult<RotatedClaim>, String> {
    match pty_manager.rotate_claim(&terminal_id, &claim) {
        Ok(new_claim) => Ok(IpcResult::success(RotatedClaim { claim: new_claim })),
        Err(_) => Ok(IpcResult::error("Unauthorized", "UNAUTHORIZED")),
    }
}

/// Revoke a terminal's claim credential (CAP-3).
///
/// The PTY survives (never-clause) and stays attachable by a client holding a
/// newly rotated credential; only the presented credential is invalidated. The
/// generation bump terminates the tracked desktop attach forwarder. Any
/// verification failure returns the same generic UNAUTHORIZED error.
#[tauri::command]
pub async fn terminal_revoke_claim(
    terminal_id: String,
    claim: String,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Result<IpcResult<()>, String> {
    match pty_manager.revoke_claim(&terminal_id, &claim) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(_) => Ok(IpcResult::error("Unauthorized", "UNAUTHORIZED")),
    }
}

/// Write data to a terminal
#[tauri::command]
pub async fn terminal_write(
    terminal_id: String,
    data: String,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Result<IpcResult<()>, String> {
    match pty_manager.write(&terminal_id, &data).await {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "WRITE_FAILED")),
    }
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
#[tauri::command]
pub async fn terminal_kill(
    terminal_id: String,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Result<IpcResult<()>, String> {
    match pty_manager.kill(&terminal_id).await {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "KILL_FAILED")),
    }
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

/// Update orphan detection settings
#[tauri::command]
pub async fn terminal_update_orphan_detection(
    settings: OrphanDetectionSettings,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Result<IpcResult<()>, String> {
    pty_manager
        .update_orphan_detection_settings(settings.enabled, settings.timeout_minutes)
        .await;
    Ok(IpcResult::success(()))
}

/// Add a renderer reference to a terminal
#[tauri::command]
pub async fn terminal_add_renderer_ref(
    request: RendererRefRequest,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Result<IpcResult<()>, String> {
    match pty_manager.add_renderer_ref(&request.terminal_id, &request.renderer_id) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "TERMINAL_NOT_FOUND")),
    }
}

/// Remove a renderer reference from a terminal
#[tauri::command]
pub async fn terminal_remove_renderer_ref(
    request: RendererRefRequest,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Result<IpcResult<()>, String> {
    match pty_manager.remove_renderer_ref(&request.terminal_id, &request.renderer_id) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "TERMINAL_NOT_FOUND")),
    }
}

/// Update a terminal's orphan-reaping protection.
///
/// Protection is enabled automatically at spawn. The renderer calls this with
/// `protected = false` only when a terminal is genuinely released (its project
/// is closed or its tab is closed), so orphan detection may reclaim it. This
/// keeps live background-project terminals from being killed mid-task.
#[tauri::command]
pub async fn terminal_set_protected(
    request: SetTerminalProtectedRequest,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Result<IpcResult<()>, String> {
    // `set_protected` is intentionally idempotent and infallible (it is a no-op
    // when the terminal is already gone), so there is no error case to map.
    pty_manager.set_protected(&request.terminal_id, request.protected);
    Ok(IpcResult::success(()))
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
