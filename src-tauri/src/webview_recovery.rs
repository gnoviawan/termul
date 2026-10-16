//! Main-window WebView2 crash recovery (Windows only).
//!
//! Under memory pressure the WebView2 processes behind the main window can die
//! (`0x8007139F`), leaving a blank window until a manual restart. A
//! `ProcessFailed` handler on the `main` webview reloads the page when a render
//! process exits or hangs (at most [`RELOAD_BUDGET`] times per
//! [`RELOAD_WINDOW`]; a hang is deduped within [`RELOAD_COOLDOWN`] of the last
//! reload, a crash never is). When the budget is spent, a reload fails, or the
//! WebView2 browser process itself exits, it requests one graceful app restart,
//! which runs the normal exit cleanup first. A persisted marker
//! ([`RESTART_MARKER_FILE`]) stops a restart within [`RESTART_GUARD`] of the
//! last one, so a launch-time failure cannot restart forever. Other process
//! kinds (iframe renderers, GPU, utility, sandbox) are only logged. Browser-tab
//! webviews are never touched.
//!
//! [`decide`], [`on_reload_failed`] and [`restart_allowed`] are pure and
//! platform-neutral so the whole dispatch is unit-tested on every platform;
//! only [`install`] (the COM wiring) is Windows-only.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Reloads allowed inside one [`RELOAD_WINDOW`].
pub(crate) const RELOAD_BUDGET: usize = 3;
/// Sliding window of the reload budget.
pub(crate) const RELOAD_WINDOW: Duration = Duration::from_secs(300);
/// A hang reported this soon after the last reload is the same failure (a hang
/// reports repeatedly) and is dropped instead of spending the budget. A crash
/// is never deduped: it fires once, so dropping it would leave the page dead.
pub(crate) const RELOAD_COOLDOWN: Duration = Duration::from_secs(15);
/// No recovery restart within this long of the last one (persisted marker).
pub(crate) const RESTART_GUARD: Duration = Duration::from_secs(600);
/// File in the app log dir holding the unix seconds of the last recovery restart.
pub(crate) const RESTART_MARKER_FILE: &str = "webview-recovery-restart.marker";

// Raw `COREWEBVIEW2_PROCESS_FAILED_KIND` values, pinned against webview2-com's
// constants by the compile-time assertions below (Windows builds).
pub(crate) const KIND_BROWSER_PROCESS_EXITED: i32 = 0;
pub(crate) const KIND_RENDER_PROCESS_EXITED: i32 = 1;
pub(crate) const KIND_RENDER_PROCESS_UNRESPONSIVE: i32 = 2;
pub(crate) const KIND_FRAME_RENDER_PROCESS_EXITED: i32 = 3;
pub(crate) const KIND_UTILITY_PROCESS_EXITED: i32 = 4;
pub(crate) const KIND_SANDBOX_HELPER_PROCESS_EXITED: i32 = 5;
pub(crate) const KIND_GPU_PROCESS_EXITED: i32 = 6;

/// What the handler does for one `ProcessFailed` event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Effect {
    /// Reload the main webview.
    Reload,
    /// Request a graceful app restart (exit cleanup, then relaunch).
    Restart,
    /// Log only.
    None,
}

/// Log name of a raw `COREWEBVIEW2_PROCESS_FAILED_KIND`.
pub(crate) fn kind_name(kind: i32) -> &'static str {
    match kind {
        KIND_BROWSER_PROCESS_EXITED => "BROWSER_PROCESS_EXITED",
        KIND_RENDER_PROCESS_EXITED => "RENDER_PROCESS_EXITED",
        KIND_RENDER_PROCESS_UNRESPONSIVE => "RENDER_PROCESS_UNRESPONSIVE",
        KIND_FRAME_RENDER_PROCESS_EXITED => "FRAME_RENDER_PROCESS_EXITED",
        KIND_UTILITY_PROCESS_EXITED => "UTILITY_PROCESS_EXITED",
        KIND_SANDBOX_HELPER_PROCESS_EXITED => "SANDBOX_HELPER_PROCESS_EXITED",
        KIND_GPU_PROCESS_EXITED => "GPU_PROCESS_EXITED",
        _ => "OTHER_PROCESS_EXITED",
    }
}

/// Sliding-window reload limit: at most `max` reloads in any `window`.
#[derive(Debug)]
pub(crate) struct ReloadBudget {
    max: usize,
    window: Duration,
    recent: VecDeque<Instant>,
}

impl ReloadBudget {
    pub(crate) fn new(max: usize, window: Duration) -> Self {
        Self {
            max,
            window,
            recent: VecDeque::with_capacity(max),
        }
    }

    /// Takes one reload at `now`; `false` when the window's budget is spent.
    pub(crate) fn try_take(&mut self, now: Instant) -> bool {
        while let Some(&oldest) = self.recent.front() {
            if now.saturating_duration_since(oldest) >= self.window {
                self.recent.pop_front();
            } else {
                break;
            }
        }
        if self.recent.len() >= self.max {
            return false;
        }
        self.recent.push_back(now);
        true
    }
}

/// Recovery state of the main webview for one process lifetime.
#[derive(Debug)]
pub(crate) struct RecoveryState {
    budget: ReloadBudget,
    last_reload: Option<Instant>,
    /// One graceful restart decision per process: a second would only loop.
    restart_requested: bool,
    /// Last over-budget reload taken because a decided restart was refused.
    last_fallback_reload: Option<Instant>,
}

impl RecoveryState {
    pub(crate) fn new() -> Self {
        Self {
            budget: ReloadBudget::new(RELOAD_BUDGET, RELOAD_WINDOW),
            last_reload: None,
            restart_requested: false,
            last_fallback_reload: None,
        }
    }

    pub(crate) fn restart_requested(&self) -> bool {
        self.restart_requested
    }

    /// A decided restart was not dispatched (guarded, marker unwritable, no
    /// log dir, or a quit already claimed the exit): clear the one-shot flag so
    /// later render crashes still reload within the budget.
    pub(crate) fn restart_not_dispatched(&mut self) {
        self.restart_requested = false;
    }
}

/// Decides the effect of one `ProcessFailed` event of raw `kind` at `now`.
/// `exiting` is true while the app's exit cleanup runs (quit or restart).
pub(crate) fn decide(kind: i32, state: &mut RecoveryState, now: Instant, exiting: bool) -> Effect {
    if exiting || state.restart_requested {
        return Effect::None;
    }
    match kind {
        KIND_RENDER_PROCESS_EXITED | KIND_RENDER_PROCESS_UNRESPONSIVE => {
            if kind == KIND_RENDER_PROCESS_UNRESPONSIVE
                && state
                    .last_reload
                    .is_some_and(|last| now.saturating_duration_since(last) < RELOAD_COOLDOWN)
            {
                return Effect::None;
            }
            if state.budget.try_take(now) {
                state.last_reload = Some(now);
                Effect::Reload
            } else {
                escalate(state)
            }
        }
        KIND_BROWSER_PROCESS_EXITED => escalate(state),
        _ => Effect::None,
    }
}

/// The effect after a [`decide`]d reload could not run (`Reload()` failed or
/// there was no sender webview): the same one-shot restart a spent budget gets.
pub(crate) fn on_reload_failed(state: &mut RecoveryState) -> Effect {
    if state.restart_requested {
        return Effect::None;
    }
    escalate(state)
}

/// Whether a render failure whose decided restart was refused (guard, marker,
/// no log dir) still gets one reload past the budget. A render crash fires only
/// once, so without it the window stays blank; at most one such reload per
/// [`RELOAD_WINDOW`] keeps a launch-time crash loop from reloading endlessly.
pub(crate) fn fallback_reload(
    kind: i32,
    state: &mut RecoveryState,
    now: Instant,
    exiting: bool,
) -> bool {
    if exiting
        || !matches!(
            kind,
            KIND_RENDER_PROCESS_EXITED | KIND_RENDER_PROCESS_UNRESPONSIVE
        )
    {
        return false;
    }
    if state
        .last_fallback_reload
        .is_some_and(|last| now.saturating_duration_since(last) < RELOAD_WINDOW)
    {
        return false;
    }
    state.last_fallback_reload = Some(now);
    state.last_reload = Some(now);
    true
}

fn escalate(state: &mut RecoveryState) -> Effect {
    state.restart_requested = true;
    Effect::Restart
}

/// Whether a recovery restart may run at `now_secs` (unix) given the marker of
/// the last one. No marker (missing, unreadable, garbled, or in the future)
/// means no guard.
pub(crate) fn restart_allowed(marker_secs: Option<u64>, now_secs: u64) -> bool {
    match marker_secs {
        Some(last) if last <= now_secs => now_secs - last >= RESTART_GUARD.as_secs(),
        _ => true,
    }
}

/// Parses the marker file's contents (unix seconds); `None` when garbled.
pub(crate) fn parse_marker(contents: &str) -> Option<u64> {
    contents.trim().parse().ok()
}

/// The restart marker inside the app log dir.
pub(crate) fn marker_path(log_dir: &Path) -> PathBuf {
    log_dir.join(RESTART_MARKER_FILE)
}

/// Reads the marker, applies [`restart_allowed`] and, when allowed, writes
/// `now_secs` to it. `Ok(true)`: marker written, the restart may proceed.
/// `Ok(false)`: a recovery restart ran within [`RESTART_GUARD`] (logged).
/// `Err`: the marker could not be written, so no restart (an unguarded one
/// could loop across launches).
pub(crate) fn claim_restart(marker: &Path, now_secs: u64) -> Result<bool, String> {
    let last = std::fs::read_to_string(marker)
        .ok()
        .and_then(|contents| parse_marker(&contents));
    if !restart_allowed(last, now_secs) {
        log::error!(
            "[webview-recovery] restart skipped: the last recovery restart was {}s ago (guard {}s)",
            now_secs.saturating_sub(last.unwrap_or(now_secs)),
            RESTART_GUARD.as_secs()
        );
        return Ok(false);
    }
    marker
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| std::fs::write(marker, now_secs.to_string()))
        .map(|()| true)
        .map_err(|e| format!("cannot write the restart marker {}: {e}", marker.display()))
}

/// Why [`decide`] returned `effect` for `kind`, for the log line.
/// `restart_was_requested` is the state's flag *before* the call.
pub(crate) fn outcome_note(
    kind: i32,
    effect: Effect,
    restart_was_requested: bool,
    exiting: bool,
) -> &'static str {
    let render = matches!(
        kind,
        KIND_RENDER_PROCESS_EXITED | KIND_RENDER_PROCESS_UNRESPONSIVE
    );
    match effect {
        Effect::Reload => "reloading",
        Effect::Restart if render => "reload budget spent; restarting the app after exit cleanup",
        Effect::Restart => "restarting the app after exit cleanup",
        Effect::None if exiting => "app is exiting; no action",
        Effect::None if restart_was_requested => "restart already decided; no action",
        Effect::None if kind == KIND_RENDER_PROCESS_UNRESPONSIVE => {
            "hang within the reload cooldown; deduped, no action"
        }
        Effect::None => "log only; no action",
    }
}

#[cfg(windows)]
const _: () = {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    assert!(
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED.0 == KIND_BROWSER_PROCESS_EXITED
    );
    assert!(COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED.0 == KIND_RENDER_PROCESS_EXITED);
    assert!(
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE.0
            == KIND_RENDER_PROCESS_UNRESPONSIVE
    );
    assert!(
        COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED.0
            == KIND_FRAME_RENDER_PROCESS_EXITED
    );
    assert!(
        COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED.0 == KIND_UTILITY_PROCESS_EXITED
    );
    assert!(
        COREWEBVIEW2_PROCESS_FAILED_KIND_SANDBOX_HELPER_PROCESS_EXITED.0
            == KIND_SANDBOX_HELPER_PROCESS_EXITED
    );
    assert!(COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED.0 == KIND_GPU_PROCESS_EXITED);
};

/// Registers the `ProcessFailed` handler on `window`'s WebView2. The attach
/// runs on the UI thread once the event loop dispatches it; an attach failure
/// is logged there. `Err` means the dispatch itself failed.
#[cfg(windows)]
pub(crate) fn install(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> Result<(), String> {
    let app = app.clone();
    let label = window.label().to_string();
    window
        .with_webview(move |platform| {
            // SAFETY: runs on the UI thread that owns the WebView2 objects.
            let attached = unsafe { platform.controller().CoreWebView2() }
                .map_err(|e| format!("CoreWebView2: {e}"))
                .and_then(|core| attach(&core, app));
            match attached {
                Ok(()) => log::info!("[webview-recovery] ProcessFailed hook attached to '{label}'"),
                Err(e) => log::warn!(
                    "[webview-recovery] failed to attach ProcessFailed hook to '{label}': {e}"
                ),
            }
        })
        .map_err(|e| format!("with_webview: {e}"))
}

#[cfg(windows)]
fn attach(
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2ProcessFailedEventArgs2, COREWEBVIEW2_PROCESS_FAILED_KIND,
    };
    use webview2_com::ProcessFailedEventHandler;
    use windows_core::Interface;

    let mut state = RecoveryState::new();
    let handler = ProcessFailedEventHandler::create(Box::new(move |sender, args| {
        let Some(args) = args else {
            log::warn!("[webview-recovery] ProcessFailed without event args; ignored");
            return Ok(());
        };
        let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
        // SAFETY: event args are valid for the duration of the callback.
        if let Err(e) = unsafe { args.ProcessFailedKind(&mut kind) } {
            log::warn!("[webview-recovery] ProcessFailed kind unreadable ({e}); ignored");
            return Ok(());
        }
        let exit_code = args
            .cast::<ICoreWebView2ProcessFailedEventArgs2>()
            .ok()
            .and_then(|args2| {
                let mut code = 0i32;
                // SAFETY: as above.
                unsafe { args2.ExitCode(&mut code) }.ok().map(|()| code)
            });
        let kind = kind.0;
        let name = kind_name(kind);
        let exit = exit_code
            .map(|code| format!("0x{code:08X}"))
            .unwrap_or_else(|| "unknown".to_string());

        let exiting = crate::exit_cleanup_in_progress();
        let restart_was_requested = state.restart_requested();
        let effect = decide(kind, &mut state, Instant::now(), exiting);
        let note = outcome_note(kind, effect, restart_was_requested, exiting);
        let line =
            format!("[webview-recovery] main webview {name} (kind {kind}, exit {exit}); {note}");
        match effect {
            Effect::Reload => {
                log::warn!("{line}");
                if !reload_main(&app, sender.as_ref(), name)
                    && on_reload_failed(&mut state) == Effect::Restart
                {
                    log::error!(
                        "[webview-recovery] main webview {name}: reload failed; restarting the app after exit cleanup"
                    );
                    restart_or_keep_reloading(&app, &mut state);
                }
            }
            Effect::Restart => {
                log::error!("{line}");
                if !restart_or_keep_reloading(&app, &mut state)
                    && fallback_reload(
                        kind,
                        &mut state,
                        Instant::now(),
                        crate::exit_cleanup_in_progress(),
                    )
                {
                    log::warn!(
                        "[webview-recovery] main webview {name}: restart refused; one reload past the budget"
                    );
                    reload_main(&app, sender.as_ref(), name);
                }
            }
            Effect::None => log::warn!("{line}"),
        }
        Ok(())
    }));
    let mut token = 0i64;
    // SAFETY: on the UI thread; WebView2 addrefs the handler for the
    // registration, which lives as long as the main webview.
    unsafe { core.add_ProcessFailed(&handler, &mut token) }
        .map_err(|e| format!("add_ProcessFailed: {e}"))
}

/// Drops the dead page's WS channel connections (only `Destroyed` closes them
/// otherwise), then reloads the main webview. `false` when the reload could not
/// run; the failure is logged.
#[cfg(windows)]
fn reload_main(
    app: &tauri::AppHandle,
    sender: Option<&webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2>,
    name: &str,
) -> bool {
    use tauri::Manager;

    let Some(core) = sender else {
        log::error!("[webview-recovery] reload after {name} failed: no sender webview");
        return false;
    };
    if let Some(host) = app.try_state::<crate::web::ws::channel::WsChannelHost>() {
        let closed = host.close_window("main");
        log::info!("[webview-recovery] closed {closed} ws channel connection(s) of the dead page");
    }
    // SAFETY: the sender is the main ICoreWebView2, on its UI thread.
    match unsafe { core.Reload() } {
        Ok(()) => true,
        Err(e) => {
            log::error!("[webview-recovery] reload after {name} failed: {e}");
            false
        }
    }
}

/// Runs a decided restart; when none is dispatched, recovery falls back to
/// reloads only instead of going quiet for the rest of the process. Returns
/// whether a restart was dispatched.
#[cfg(windows)]
fn restart_or_keep_reloading(app: &tauri::AppHandle, state: &mut RecoveryState) -> bool {
    let dispatched = restart_guarded(app);
    if !dispatched {
        state.restart_not_dispatched();
        log::warn!(
            "[webview-recovery] no restart dispatched; recovery continues with reloads only"
        );
    }
    dispatched
}

/// Requests the graceful restart unless [`claim_restart`] refuses it. Returns
/// whether a restart was actually dispatched.
#[cfg(windows)]
fn restart_guarded(app: &tauri::AppHandle) -> bool {
    use tauri::Manager;

    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let Ok(log_dir) = app.path().app_log_dir() else {
        log::error!("[webview-recovery] restart skipped: no app log dir for the restart marker");
        return false;
    };
    match claim_restart(&marker_path(&log_dir), now_secs) {
        Ok(true) => crate::request_restart_after_cleanup(app),
        Ok(false) => false,
        Err(e) => {
            log::error!("[webview-recovery] restart skipped: {e}");
            false
        }
    }
}

#[cfg(test)]
#[path = "webview_recovery_tests.rs"]
mod tests;
