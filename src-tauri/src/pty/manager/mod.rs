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
use std::collections::HashMap;
use std::env;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::sync::Mutex;

use std::time::{Duration, Instant};
use tauri::ipc::{Channel, Response};

use tokio::sync::Mutex as AsyncMutex;

mod external;
mod instance;
mod lifecycle;
mod limits;
mod resolve;
mod set_watch;
mod spawn;
mod types;
#[cfg(target_os = "windows")]
mod windows;

// Internal items shared across the `manager` submodule tree — bound here so
// `use super::*` in each child (including `tests`) resolves them exactly as
// they resolved against the single-file module.
#[cfg(target_os = "windows")]
use self::windows::*;
use instance::ClaimRollbackGuard;
use limits::PendingSpawns;
#[cfg(all(test, target_os = "windows"))]
use resolve::{
    is_directly_executable_windows, merge_windows_environment_map, parse_npm_cmd_shim,
    parse_powershell_cmd_shim, try_parse_windows_cmd_shim,
};
use types::{
    EXITED_SWEEP_INTERVAL_MS, EXITED_TERMINAL_TTL_MS, GLOBAL_TERMINAL_LIMIT,
    TERM_BROADCAST_CAPACITY,
};

// `crate::pty::manager` public/`pub(crate)` surface preserved via re-export.
pub use external::ExternalTerminal;
pub use instance::TerminalInstance;
pub use limits::{SpawnError, TERMINAL_LIMIT_CODE};
pub use set_watch::TerminalSetObserver;
pub(crate) use resolve::{resolve_spawn_program, ResolvedProgram};
pub use types::{
    ExternalResizer, PreservedTerminal, SpawnOptions, SpawnedTerminal, TerminalAttachResult,
    TerminalInfo, TerminalOutputChunk, TerminalReplay, FLUSH_INTERVAL, MAX_PENDING,
    OVERFLOW_NOTICE, READ_BUF, SCROLLBACK_CAP,
};

/// Manages all PTY instances
pub struct PtyManager {
    terminals: Arc<RwLock<HashMap<String, Arc<TerminalInstance>>>>,
    /// Spawns that hold a cap slot but have not registered their PTY yet.
    pending_spawns: PendingSpawns,
    /// Per-project terminal cap; the global cap is `GLOBAL_TERMINAL_LIMIT`.
    max_terminals_per_project: Arc<AtomicUsize>,
    id_counter: Arc<AtomicU64>,
    terminal_events: TerminalEventHub,
    /// How long an exited PTY stays tracked before the sweeper removes it.
    exited_ttl_ms: Arc<AtomicU64>,
    exit_sweeper_started: Arc<AtomicBool>,
    cwd_tracker: Arc<CwdTracker>,
    git_tracker: Arc<GitTracker>,
    exit_code_tracker: Arc<ExitCodeTracker>,
    /// Claim credential registry (CAP-3). Single ownership here keeps the
    /// claim lifecycle coupled to the terminal lifecycle: issued at spawn,
    /// removed at kill/reap.
    claims: Arc<crate::pty::claims::TerminalClaimRegistry>,
    /// When true, kill operations and the exited-PTY sweep are deferred.
    /// Set when the app window is minimized/hidden to prevent
    /// ConPTY lifecycle issues on Windows.
    is_hidden: Arc<AtomicBool>,
    /// Told when a project's terminal set changes (the `terminals` watch).
    set_observer: TerminalSetObserver,
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
            pending_spawns: Arc::new(parking_lot::Mutex::new(HashMap::new())),
            max_terminals_per_project: Arc::new(AtomicUsize::new(
                crate::web::config::DEFAULT_MAX_TERMINALS_PER_PROJECT,
            )),
            id_counter: Arc::new(AtomicU64::new(0)),
            terminal_events,
            exited_ttl_ms: Arc::new(AtomicU64::new(EXITED_TERMINAL_TTL_MS)),
            exit_sweeper_started: Arc::new(AtomicBool::new(false)),
            is_hidden: Arc::new(AtomicBool::new(false)),
            cwd_tracker,
            git_tracker,
            exit_code_tracker,
            claims: Arc::new(crate::pty::claims::TerminalClaimRegistry::new()),
            set_observer: TerminalSetObserver::default(),
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

    /// Start the exited-PTY sweeper. Called lazily when the first terminal is
    /// spawned. The sweeper removes only PTYs whose process has already
    /// exited and whose TTL ran out; it never touches a live PTY.
    fn start_exit_sweeper(&self) {
        if self
            .exit_sweeper_started
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::Relaxed)
            .is_err()
        {
            return; // Already started
        }

        let sweep = self.exit_sweep();
        let ttl_ms = self.exited_ttl_ms.clone();
        let is_hidden = self.is_hidden.clone();

        tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(Duration::from_millis(EXITED_SWEEP_INTERVAL_MS));

            loop {
                interval.tick().await;

                // Skip while the window is hidden: dropping ConPTY handles
                // then is the lifecycle problem `set_hidden` guards against.
                if is_hidden.load(Ordering::Relaxed) {
                    continue;
                }

                sweep
                    .remove_expired(Duration::from_millis(ttl_ms.load(Ordering::Relaxed)))
                    .await;
            }
        });
    }

    /// Handles the sweeper needs, detached from `&self` so the background
    /// task can own them.
    fn exit_sweep(&self) -> ExitSweep {
        ExitSweep {
            terminals: self.terminals.clone(),
            cwd_tracker: self.cwd_tracker.clone(),
            git_tracker: self.git_tracker.clone(),
            exit_code_tracker: self.exit_code_tracker.clone(),
            terminal_events: self.terminal_events.clone(),
            claims: self.claims.clone(),
            set_observer: self.set_observer.clone(),
        }
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

/// Removes exited PTYs past their TTL. Owned by the sweeper task; tests drive
/// it directly.
struct ExitSweep {
    terminals: Arc<RwLock<HashMap<String, Arc<TerminalInstance>>>>,
    cwd_tracker: Arc<CwdTracker>,
    git_tracker: Arc<GitTracker>,
    exit_code_tracker: Arc<ExitCodeTracker>,
    terminal_events: TerminalEventHub,
    claims: Arc<crate::pty::claims::TerminalClaimRegistry>,
    set_observer: TerminalSetObserver,
}

impl ExitSweep {
    /// Remove every tracked PTY that exited more than `ttl` ago, releasing
    /// its resources like a kill. A PTY whose process is still alive has no
    /// `exited_for` and is never matched. Returns the ids removed.
    async fn remove_expired(&self, ttl: Duration) -> Vec<String> {
        let expired: Vec<String> = self
            .terminals
            .read()
            .iter()
            .filter(|(_, instance)| instance.exited_for().is_some_and(|age| age > ttl))
            .map(|(id, _)| id.clone())
            .collect();

        let mut removed = Vec::with_capacity(expired.len());
        for id in expired {
            // Re-check under the write lock: the PTY may have been killed
            // (and its id reused is impossible, ids are unique) in between.
            let Some(instance) = self.terminals.write().remove(&id) else {
                continue;
            };
            log::info!("Removing exited terminal past its TTL: {}", id);
            let cleanup = instance.clone();
            if let Err(e) = tokio::task::spawn_blocking(move || {
                PtyManager::cleanup_terminal_resources_sync(cleanup, true);
            })
            .await
            {
                log::warn!("spawn_blocking failed for terminal {}: {}", id, e);
            }
            self.cwd_tracker.stop_tracking(&id);
            self.git_tracker.remove_terminal(&id);
            self.exit_code_tracker.remove_terminal(&id);
            self.terminal_events.remove(&id);
            self.claims.remove(&id);
            self.set_observer.notify(instance.project_id.as_deref());
            removed.push(id);
        }
        removed
    }
}

#[cfg(test)]
mod lifetime_tests;
#[cfg(test)]
mod limit_tests;
#[cfg(test)]
mod tests;
