//! PtyManager - Manages PTY (pseudo-terminal) instances for Tauri
//!
//! This module provides terminal spawning, I/O, and lifecycle management
//! ported from the Electron implementation.

use crate::pty::claims::ClaimError;
use crate::trackers::{
    CwdTracker, ExitCodeTracker, GitTracker, TerminalEvent, TerminalEventHub, TerminalStateSnapshot,
};
use parking_lot::RwLock;
use portable_pty::{Child, MasterPty, PtySize};

#[cfg(target_os = "windows")]
use crate::pty::windows::{resize_conpty, spawn_conpty, ConPtyHandles};
#[cfg(target_os = "windows")]
use crate::shell_paths::git_bash_paths;
#[cfg(target_os = "windows")]
use parking_lot::Mutex as ParkingMutex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::env;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::sync::Mutex;

use std::time::{Duration, Instant};
use tauri::ipc::{Channel, Response};

use tokio::sync::Mutex as AsyncMutex;

mod instance;
mod lifecycle;
mod resolve;
mod spawn;
mod types;
#[cfg(target_os = "windows")]
mod windows;

// Internal items shared across the `manager` submodule tree — bound here so
// `use super::*` in each child (including `tests`) resolves them exactly as
// they resolved against the single-file module.
#[cfg(target_os = "windows")]
use self::windows::*;
#[cfg(test)]
use instance::should_reap_orphan;
#[cfg(test)]
use instance::should_reap_web_listed;
use instance::{ClaimRollbackGuard, TerminalSlotReservation};
#[cfg(all(test, target_os = "windows"))]
use resolve::{
    is_directly_executable_windows, merge_windows_environment_map, parse_npm_cmd_shim,
    parse_powershell_cmd_shim, try_parse_windows_cmd_shim,
};
use types::{
    GLOBAL_TERMINAL_LIMIT, ORPHAN_CHECK_INTERVAL_MS, ORPHAN_TIMEOUT_MS, TERM_BROADCAST_CAPACITY,
    WEB_LISTED_REAP_AFTER_MS,
};

// `crate::pty::manager` public/`pub(crate)` surface preserved via re-export.
pub use instance::TerminalInstance;
pub(crate) use resolve::{resolve_spawn_program, ResolvedProgram};
pub use types::{
    PreservedTerminal, SpawnOptions, SpawnedTerminal, TerminalAttachResult, TerminalInfo,
    TerminalOutputChunk, TerminalReplay, FLUSH_INTERVAL, MAX_PENDING, OVERFLOW_NOTICE, READ_BUF,
    SCROLLBACK_CAP,
};

/// Manages all PTY instances
pub struct PtyManager {
    terminals: Arc<RwLock<HashMap<String, Arc<TerminalInstance>>>>,
    active_terminal_slots: Arc<AtomicUsize>,
    id_counter: Arc<AtomicU64>,
    terminal_events: TerminalEventHub,
    orphan_detection_enabled: Arc<AtomicBool>,
    orphan_timeout_ms: Arc<AtomicU64>,
    orphan_detection_started: Arc<AtomicBool>,
    cwd_tracker: Arc<CwdTracker>,
    git_tracker: Arc<GitTracker>,
    exit_code_tracker: Arc<ExitCodeTracker>,
    /// Claim credential registry (CAP-3). Single ownership here keeps the
    /// claim lifecycle coupled to the terminal lifecycle: issued at spawn,
    /// removed at kill/reap.
    claims: Arc<crate::pty::claims::TerminalClaimRegistry>,
    /// When true, orphan detection and kill operations are deferred.
    /// Set when the app window is minimized/hidden to prevent
    /// ConPTY lifecycle issues on Windows.
    is_hidden: Arc<AtomicBool>,
    /// #851b: web-listed reap window in ms. A web-spawned terminal that no
    /// client has listed for this long (and that has no live web attachment
    /// or renderer ref) is swept by the orphan reaper. Shared `AtomicU64`
    /// so the reaper task reads the live value and tests can shrink it.
    web_listed_reap_after_ms: Arc<AtomicU64>,
}

impl PtyManager {
    /// Create a new PtyManager
    pub fn new(
        terminal_events: TerminalEventHub,
        cwd_tracker: Arc<CwdTracker>,
        git_tracker: Arc<GitTracker>,
        exit_code_tracker: Arc<ExitCodeTracker>,
    ) -> Self {
        Self {
            terminals: Arc::new(RwLock::new(HashMap::new())),
            active_terminal_slots: Arc::new(AtomicUsize::new(0)),
            id_counter: Arc::new(AtomicU64::new(0)),
            terminal_events,
            orphan_detection_enabled: Arc::new(AtomicBool::new(true)),
            orphan_timeout_ms: Arc::new(AtomicU64::new(ORPHAN_TIMEOUT_MS)),
            orphan_detection_started: Arc::new(AtomicBool::new(false)),
            web_listed_reap_after_ms: Arc::new(AtomicU64::new(WEB_LISTED_REAP_AFTER_MS)),
            is_hidden: Arc::new(AtomicBool::new(false)),
            cwd_tracker,
            git_tracker,
            exit_code_tracker,
            claims: Arc::new(crate::pty::claims::TerminalClaimRegistry::new()),
        }
    }

    fn join_reader_with_timeout(reader_handle: std::thread::JoinHandle<()>, timeout: Duration) {
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || {
            let _ = reader_handle.join();
            let _ = tx.send(());
        });
        let _ = rx.recv_timeout(timeout);
    }

    fn cleanup_terminal_resources_sync(instance: Arc<TerminalInstance>, wait_reader_thread: bool) {
        // a) Drop writer first to close PTY input stream cleanly.
        let _ = instance.writer.blocking_lock().take();

        // b) Kill the child FIRST and wait briefly for it to exit. Once the
        //    child exits, the OS closes the PTY slave end and the reader
        //    thread's blocking `reader.read()` returns Ok(0) (EOF), so it
        //    exits naturally and the joins below complete fast.
        //
        //    The previous order (join reader, THEN kill child) left the reader
        //    blocked because the child was still alive holding the PTY open.
        //    Every cleanup hit the 3s join timeout, leaking the detached
        //    watcher thread spawned by `join_reader_with_timeout` plus the
        //    stuck reader thread. With N terminals, those leaked threads kept
        //    the process alive in the task manager and spinning CPU after the
        //    window was closed (issue #390).
        if let Some(mut child) = instance.child.blocking_lock().take() {
            let _ = child.kill();
            // Best-effort wait: give the child up to ~2s to exit so the PTY
            // EOF propagates to the reader before we join. If it doesn't exit
            // (stubborn grandchild / ConPTY edge case), proceed anyway — the
            // join timeout below is the safety net.
            let deadline = Instant::now() + Duration::from_secs(2);
            while Instant::now() < deadline {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                    Err(_) => break,
                }
            }
        }

        // c) Wait flusher thread to finish naturally (max 2s). It observes the
        //    reader's done_flag, which is set once the reader exits on EOF.
        if let Some(flusher_handle) = instance.flusher_handle.blocking_lock().take() {
            if wait_reader_thread {
                Self::join_reader_with_timeout(flusher_handle, Duration::from_secs(2));
            }
        }

        // d) Wait reader thread to finish naturally (max 3s). With the child
        //    already killed above, the reader should have hit EOF and exited;
        //    this join is a safety net for slow/edge-case exits.
        if let Some(reader_handle) = instance.reader_handle.blocking_lock().take() {
            if wait_reader_thread {
                Self::join_reader_with_timeout(reader_handle, Duration::from_secs(3));
            }
        }

        // e) Drop ConPTY handles last
        #[cfg(target_os = "windows")]
        if let Some(conpty_handles) = &instance.conpty_handles {
            let mut guard = conpty_handles.lock();
            let _ = guard.take();
        }
    }

    fn try_reserve_terminal_slot(&self) -> Option<TerminalSlotReservation> {
        TerminalSlotReservation::try_acquire(self.active_terminal_slots.clone())
    }

    fn release_terminal_slot(&self) {
        self.active_terminal_slots.fetch_sub(1, Ordering::SeqCst);
    }

    /// Start the orphan detection background task
    /// This is called lazily when the first terminal is spawned
    fn start_orphan_detection(&self) {
        // Check if already started using compare_exchange
        if self
            .orphan_detection_started
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::Relaxed)
            .is_err()
        {
            return; // Already started
        }

        let terminals = self.terminals.clone();
        let _terminal_events = self.terminal_events.clone();
        let cwd_tracker = self.cwd_tracker.clone();
        let git_tracker = self.git_tracker.clone();
        let exit_code_tracker = self.exit_code_tracker.clone();
        let claims = self.claims.clone();
        let active_slots = self.active_terminal_slots.clone();
        let enabled = self.orphan_detection_enabled.clone();
        let timeout_ms = self.orphan_timeout_ms.clone();
        let is_hidden = self.is_hidden.clone();
        let web_listed_reap_after_ms = self.web_listed_reap_after_ms.clone();

        tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(Duration::from_millis(ORPHAN_CHECK_INTERVAL_MS));

            loop {
                interval.tick().await;

                // Check if detection is enabled
                if !enabled.load(Ordering::Relaxed) {
                    continue;
                }

                // SKIP orphan cleanup when app is hidden to prevent
                // ConPTY lifecycle issues on Windows
                if is_hidden.load(Ordering::Relaxed) {
                    continue;
                }

                let timeout = Duration::from_millis(timeout_ms.load(Ordering::Relaxed));

                // Find orphaned terminals.
                let web_listed_timeout =
                    Duration::from_millis(web_listed_reap_after_ms.load(Ordering::Relaxed));
                let orphans: Vec<String> = terminals
                    .read()
                    .iter()
                    .filter(|(_, instance)| {
                        // Never reap terminals that are still owned by an open
                        // project/tab. A backgrounded project's terminals lose
                        // their renderer refs (component unmount) but remain
                        // live and may be running tasks — reaping them caused
                        // the "Terminal not found"/hang bug.
                        instance.is_orphan_reapable(timeout)
                            // #851b: web-spawned terminals stay `protected`
                            // (they never collect renderer refs, so the rule
                            // above never fires and they leaked to the 30-
                            // terminal global cap). The web-listed window
                            // sweeps them once NO client has listed them for
                            // the window and no live web attachment /
                            // renderer ref keeps them observable. Desktop-
                            // only terminals (never listed by the web
                            // surface) are untouched by this rule.
                            || instance.is_web_listed_reapable(web_listed_timeout)
                    })
                    .map(|(id, _)| id.clone())
                    .collect();

                // Clean up orphans
                for id in orphans {
                    // #851b: the web-listed sweep is a NEW reap reason —
                    // log it distinctly (tracing) so operators can tell a
                    // web-PTY sweep (expected: no client listed it for the
                    // window) from an ordinary orphan cleanup.
                    let web_swept = terminals.read().get(&id).is_some_and(|instance| {
                        !instance.is_orphan_reapable(timeout)
                            && instance.is_web_listed_reapable(web_listed_timeout)
                    });
                    if web_swept {
                        tracing::info!(
                            "[pty] reaping web terminal not listed for {:?}: {}",
                            web_listed_timeout,
                            id
                        );
                    } else {
                        log::info!("Cleaning up orphaned terminal: {}", id);
                    }

                    if let Some(instance) = terminals.write().remove(&id) {
                        active_slots.fetch_sub(1, Ordering::SeqCst);
                        tokio::task::spawn_blocking(move || {
                            Self::cleanup_terminal_resources_sync(instance, true);
                        });

                        // Stop tracking (sync operations)
                        cwd_tracker.stop_tracking(&id);
                        git_tracker.remove_terminal(&id);
                        exit_code_tracker.remove_terminal(&id);
                        claims.remove(&id);
                    }
                }
            }
        });
    }

    /// Generate a unique terminal ID
    fn generate_id(&self) -> String {
        let counter = self.id_counter.fetch_add(1, Ordering::SeqCst);
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis();
        format!("terminal-{}-{}", timestamp, counter)
    }
}

#[cfg(test)]
mod tests;
