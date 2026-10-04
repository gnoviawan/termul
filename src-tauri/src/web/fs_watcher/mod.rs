//! Server-side filesystem watcher for web clients (#856).
//!
//! On the desktop the renderer uses `tauri-plugin-fs`'s `watchImmediate`
//! (notify) and receives `FileChangeEvent`s over Tauri event listeners; on
//! the web the browser cannot watch the host's filesystem, so the explorer
//! only refreshed after an agent turn or a manual reload. This module
//! closes that parity gap: a host-side `notify` watcher over the ACTIVE
//! PROJECT ROOT batches change events and broadcasts them to every
//! connected web client over the control WS as an agent-level
//! `fs_changed` event (`{root, paths[]}` — reliable tier, sid null, seq 0).
//! The renderer's existing `useFileWatcher` chain then refreshes the
//! explorer tree (debounced) exactly as it does on desktop.
//!
//! Scope: ONE watcher over the current project root (per the issue — a
//! watcher per project is heavier than needed). The root is
//! `AppState.project_root` (an `Arc<RwLock<PathBuf>>` that live-rebinds on
//! project switch); the watcher task re-arms whenever the root changes.
//!
//! Robustness: watcher errors are logged and retried after a backoff — a
//! transitory inotify exhaustion must not silently kill change events for
//! the rest of the session. The watcher task is a daemon: it runs until
//! the process exits; each broadcast is fire-and-forget (the sink drops
//! events when no client is connected, which is the desired idle posture).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use notify::{recommended_watcher, RecursiveMode, Result as NotifyResult, Watcher};
use parking_lot::RwLock as ParkingRwLock;
use tracing::{info, warn};

use crate::web::sink::{broadcast_fs_changed, WsRelaySink};

/// How long to batch raw notify events before broadcasting one
/// `fs_changed` frame. A save, a build, and a git checkout each fan dozens
/// of events within a few hundred milliseconds; one debounced frame keeps
/// the WS quiet while staying well under the explorer's own refresh
/// debounce (300 ms in `useFileWatcher`).
const BATCH_WINDOW: Duration = Duration::from_millis(200);

/// Backoff before re-arming a failed watcher (inotify limits, FS gone
/// away). Doubles up to the cap on consecutive failures.
const RETRY_BASE: Duration = Duration::from_secs(1);
const RETRY_MAX: Duration = Duration::from_secs(30);

/// Directory names commonly git-ignored; changes under them are noise for
/// an explorer tree (build churn, caches). Mirrors the renderer facade's
/// `ALWAYS_IGNORE` semantics so the web tree does not refresh itself to
/// death during `npm install` / `cargo build`.
const IGNORED_DIR_NAMES: &[&str] = &[
    "node_modules",
    ".git",
    ".next",
    ".cache",
    ".turbo",
    "dist",
    "build",
    ".output",
    ".nuxt",
    ".svelte-kit",
    "__pycache__",
    ".pytest_cache",
    "target",
];

/// Whether a changed path should be reported to clients: any path that
/// descends into an ignored directory is suppressed. Pure (no I/O).
#[must_use]
fn is_reportable(path: &std::path::Path) -> bool {
    // Only ANCESTOR components count — the final component is the changed
    // entry itself (a file literally named `dist` is a plain tree change,
    // not a build-churn artifact).
    let components: Vec<_> = path.components().collect();
    let ancestor_count = components.len().saturating_sub(1);
    components[..ancestor_count].iter().all(|component| {
        let Some(name) = component.as_os_str().to_str() else {
            return true;
        };
        !IGNORED_DIR_NAMES.contains(&name)
    })
}

/// Normalize a changed path for the wire: forward slashes, empty on
/// failure. Pure.
#[must_use]
fn normalize_path(path: &std::path::Path) -> Option<String> {
    let text = path.to_string_lossy();
    let normalized = text.replace('\\', "/");
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

/// Spawn the FS watcher daemon over the live project-root handle (call
/// once per server from `serve_router`; both the standalone binary and the
/// desktop shared-live host get it). Returns immediately — the watcher
/// runs until process exit.
pub fn spawn_fs_watcher(
    project_root: Arc<ParkingRwLock<PathBuf>>,
    relay: Arc<WsRelaySink>,
) {
    tokio::spawn(async move {
        let mut retry_delay = RETRY_BASE;
        loop {
            let root = project_root.read().clone();
            match watch_root(root, &project_root, &relay).await {
                WatchOutcome::RootChanged => {
                    // The active project switched — re-arm immediately at
                    // the new root (reset the backoff: a new root is a
                    // fresh chance, not a failure streak).
                    retry_delay = RETRY_BASE;
                    info!("[fs-watcher] project root changed — re-arming watcher");
                }
                WatchOutcome::Failed => {
                    warn!(
                        "[fs-watcher] watcher failed; retrying in {:?}",
                        retry_delay
                    );
                    tokio::time::sleep(retry_delay).await;
                    retry_delay = std::cmp::min(retry_delay * 2, RETRY_MAX);
                }
            }
        }
    });
}

/// Result of one watcher session.
enum WatchOutcome {
    /// The project root changed while watching — re-arm at the new root.
    RootChanged,
    /// The watcher errored or the root vanished — backoff and retry.
    Failed,
}

/// Watch `root` until the project root handle points elsewhere (or the
/// watcher errors). Events are debounced into `fs_changed` broadcasts.
async fn watch_root(
    root: PathBuf,
    project_root: &Arc<ParkingRwLock<PathBuf>>,
    relay: &Arc<WsRelaySink>,
) -> WatchOutcome {
    if !root.is_dir() {
        warn!("[fs-watcher] project root is not a directory: {}", root.display());
        return WatchOutcome::Failed;
    }

    let (event_tx, mut event_rx) = tokio::sync::mpsc::channel::<PathBuf>(256);
    let event_tx = Arc::new(event_tx);

    let mut watcher = match recommended_watcher(move |result: NotifyResult<notify::Event>| {
        let Ok(event) = result else {
            return;
        };
        for path in event.paths {
            // A full channel drops that path — the next event for the
            // same tree lands anyway once the drain catches up (watchers
            // coalesce; the client debounces too).
            let _ = event_tx.try_send(path);
        }
    }) {
        Ok(watcher) => watcher,
        Err(error) => {
            warn!("[fs-watcher] failed to create watcher: {error}");
            return WatchOutcome::Failed;
        }
    };

    if let Err(error) = watcher.watch(&root, RecursiveMode::Recursive) {
        warn!(
            "[fs-watcher] failed to watch {}: {error}",
            root.display()
        );
        return WatchOutcome::Failed;
    }
    info!("[fs-watcher] watching project root: {}", root.display());

    // Root-change detection tick: the root handle is re-read cheaply; when
    // it no longer matches the watched root, re-arm. Much cheaper than a
    // channel of root clones and safe for the switch latency (≤1s).
    let mut root_check = tokio::time::interval(Duration::from_secs(1));
    root_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    let root_display = root.display().to_string();
    loop {
        tokio::select! {
            maybe_path = event_rx.recv() => {
                let Some(path) = maybe_path else {
                    // Sender dropped — only possible on watcher thread exit.
                    return WatchOutcome::Failed;
                };
                // Debounce: drain the burst for BATCH_WINDOW, then send one
                // frame with every distinct reportable path.
                let mut pending: Vec<PathBuf> = vec![path];
                let deadline = tokio::time::Instant::now() + BATCH_WINDOW;
                loop {
                    let wait = deadline.saturating_duration_since(tokio::time::Instant::now());
                    if wait.is_zero() {
                        break;
                    }
                    match tokio::time::timeout(wait, event_rx.recv()).await {
                        Ok(Some(path)) => pending.push(path),
                        Ok(None) => return WatchOutcome::Failed,
                        Err(_) => break, // deadline
                    }
                }
                let mut paths: Vec<String> = pending
                    .iter()
                    .filter(|path| is_reportable(path))
                    .filter_map(|path| normalize_path(path))
                    .collect();
                paths.sort();
                paths.dedup();
                if !paths.is_empty() {
                    broadcast_fs_changed(relay, &root_display, &paths);
                }
            }
            _ = root_check.tick() => {
                if *project_root.read() != root {
                    return WatchOutcome::RootChanged;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
