//! Per-project filesystem watch hub for web clients (#856, per-`projectId`).
//!
//! On the desktop the renderer uses `tauri-plugin-fs`'s `watchImmediate`
//! (notify) and receives `FileChangeEvent`s over Tauri event listeners; on
//! the web the browser cannot watch the host's filesystem. A connection asks
//! the host to watch a registered project with the `watch_project` WS request
//! and the host pushes an agent-level `fs_changed` event
//! (`{projectId, root, paths[]}`) to exactly the subscribed connections. The
//! renderer's existing `useFileWatcher` chain then refreshes the explorer
//! tree (debounced) exactly as it does on desktop.
//!
//! The hub is refcounted per `projectId`: the first subscriber arms one
//! `notify` watcher over the project's canonical root, later subscribers share
//! it, and the watcher is dropped on the last unsubscribe, on connection
//! close (`unsubscribe_all`), when a delivery finds every subscriber gone, or
//! when the project is archived/removed/unresolvable (checked on a 1 s tick
//! against the registry, so every registry mutation path is covered).
//!
//! Robustness: a watcher error is logged and retried after a backoff — a
//! transient inotify exhaustion must not silently kill change events for the
//! rest of the subscription. A moved project root re-arms at the new root.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use notify::{recommended_watcher, RecursiveMode, Result as NotifyResult, Watcher};
use parking_lot::Mutex;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;
use tracing::{info, warn};

use crate::web::project_registry::ProjectRegistry;
use crate::web::ws::{EnqueueOutcome, Outbound, OutboundSender, SequencedEvent};

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

/// How often a running or backing-off watch re-resolves its project in the
/// registry, so archive/remove/path changes take effect within a second.
const REGISTRY_CHECK_INTERVAL: Duration = Duration::from_secs(1);

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
///
/// `root` is the watched project root: the filter only inspects the path's
/// components BELOW the root — the root's own ancestors (e.g. a project at
/// `/home/u/build/myproj`) must not suppress everything (CodeRabbit).
#[must_use]
fn is_reportable_below_root(path: &std::path::Path, root: &std::path::Path) -> bool {
    // Strip the root prefix (both already normalized by the watcher to
    // forward-slash PathBufs on Windows via notify's canonical events; a
    // path outside the root keeps all its components).
    let below_root = path.strip_prefix(root).unwrap_or(path);
    // Only ANCESTOR components count — the final component is the changed
    // entry itself (a file literally named `dist` is a plain tree change,
    // not a build-churn artifact).
    let components: Vec<_> = below_root.components().collect();
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

/// Wire payload of the `fs_changed` agent-level event: the watched project,
/// its canonical root, and the changed paths (forward-slash normalized).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsChangedPayload {
    pub project_id: String,
    pub root: String,
    pub paths: Vec<String>,
}

/// Why a watch request was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchError {
    /// The project is unknown, archived, pathless, or its root cannot be
    /// resolved — there is nothing to watch.
    NotFound,
}

/// One watched project: its subscribed connections and the stop handle of the
/// watcher task. `generation` lets a finishing task remove only its own entry.
struct ProjectWatch {
    generation: u64,
    subscribers: Vec<OutboundSender>,
    cancel: CancellationToken,
    /// `true` while the notify watcher is armed on the project's root (read by
    /// `FsWatchHub::wait_armed`, which tests use to act only once it is live).
    #[cfg_attr(not(test), allow(dead_code))]
    armed: tokio::sync::watch::Receiver<bool>,
}

type WatchMap = Arc<Mutex<HashMap<String, ProjectWatch>>>;

/// Refcounted per-`projectId` watch manager. Owned by the relay sink so every
/// WS handler and the per-connection cleanup reach it through `relay`.
#[derive(Default)]
pub struct FsWatchHub {
    watches: WatchMap,
    next_generation: AtomicU64,
    /// Every project watcher task, so a host stop can await them.
    tasks: TaskTracker,
}

impl FsWatchHub {
    /// Subscribe a connection (identified by its outbound channel) to
    /// `project_id`. Arms the project's watcher when this is the first
    /// subscriber; an already-subscribed connection is a no-op. Must run
    /// inside a Tokio runtime (the watcher task is spawned here).
    pub(crate) fn subscribe(
        &self,
        registry: &Arc<ProjectRegistry>,
        project_id: &str,
        conn: &OutboundSender,
    ) -> Result<(), WatchError> {
        if registry.canonical_root(project_id).is_none() {
            warn!(
                project_id,
                "[fs-watch] watch refused: project not found or not watchable"
            );
            return Err(WatchError::NotFound);
        }
        let mut watches = self.watches.lock();
        if let Some(watch) = watches.get_mut(project_id) {
            if !watch.subscribers.iter().any(|s| s.same_channel(conn)) {
                watch.subscribers.push(conn.clone());
                info!(
                    project_id,
                    subscribers = watch.subscribers.len(),
                    "[fs-watch] subscriber added"
                );
            }
            return Ok(());
        }
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        let cancel = CancellationToken::new();
        let (armed_tx, armed_rx) = tokio::sync::watch::channel(false);
        watches.insert(
            project_id.to_string(),
            ProjectWatch {
                generation,
                subscribers: vec![conn.clone()],
                cancel: cancel.clone(),
                armed: armed_rx,
            },
        );
        drop(watches);
        info!(
            project_id,
            "[fs-watch] first subscriber; arming project watcher"
        );
        self.tasks.spawn(run_project_watch(
            project_id.to_string(),
            generation,
            Arc::clone(registry),
            Arc::clone(&self.watches),
            cancel,
            armed_tx,
        ));
        Ok(())
    }

    /// Remove one connection's subscription. Drops the watcher on the last
    /// unsubscribe. Returns `true` when the connection was subscribed.
    pub(crate) fn unsubscribe(&self, project_id: &str, conn: &OutboundSender) -> bool {
        let mut watches = self.watches.lock();
        let Some(watch) = watches.get_mut(project_id) else {
            return false;
        };
        let before = watch.subscribers.len();
        watch.subscribers.retain(|s| !s.same_channel(conn));
        let removed = watch.subscribers.len() != before;
        if watch.subscribers.is_empty() {
            if let Some(watch) = watches.remove(project_id) {
                watch.cancel.cancel();
                info!(
                    project_id,
                    "[fs-watch] last subscriber left; watcher dropped"
                );
            }
        }
        removed
    }

    /// Remove a closed connection from every project it watches (the
    /// per-connection cleanup hook). Projects left without subscribers drop
    /// their watcher.
    pub(crate) fn unsubscribe_all(&self, conn: &OutboundSender) {
        let mut watches = self.watches.lock();
        let mut emptied = Vec::new();
        for (project_id, watch) in watches.iter_mut() {
            watch.subscribers.retain(|s| !s.same_channel(conn));
            if watch.subscribers.is_empty() {
                emptied.push(project_id.clone());
            }
        }
        for project_id in emptied {
            if let Some(watch) = watches.remove(&project_id) {
                watch.cancel.cancel();
                info!(project_id = %project_id, "[fs-watch] connection closed; watcher dropped");
            }
        }
    }

    /// Host stop: cancel every watch still registered and wait up to `bound`
    /// for the watcher tasks to end (connections that closed already released
    /// theirs). The hub is shared across host restarts, so it accepts watches
    /// again afterwards.
    pub async fn shutdown(&self, bound: Duration) {
        for (_, watch) in self.watches.lock().drain() {
            watch.cancel.cancel();
        }
        self.tasks.close();
        if tokio::time::timeout(bound, self.tasks.wait()).await.is_err() {
            warn!(
                tasks = self.tasks.len(),
                "[fs-watch] watcher tasks still running after the drain bound"
            );
        }
        self.tasks.reopen();
    }

    /// Wait until `project_id`'s notify watcher is armed (events under the
    /// root are observed from then on). `false` on timeout or when the project
    /// has no watch. Lets tests act only once the watcher is live.
    #[cfg(test)]
    pub(crate) async fn wait_armed(&self, project_id: &str, wait: Duration) -> bool {
        let Some(mut armed) = self
            .watches
            .lock()
            .get(project_id)
            .map(|watch| watch.armed.clone())
        else {
            return false;
        };
        tokio::time::timeout(wait, armed.wait_for(|armed| *armed))
            .await
            .is_ok_and(|result| result.is_ok())
    }

    /// Number of subscribed connections for `project_id` (0 when unwatched).
    #[must_use]
    pub fn subscriber_count(&self, project_id: &str) -> usize {
        self.watches
            .lock()
            .get(project_id)
            .map_or(0, |watch| watch.subscribers.len())
    }

    /// Number of projects with an armed watcher.
    #[must_use]
    pub fn watched_project_count(&self) -> usize {
        self.watches.lock().len()
    }
}

/// Deliver one `fs_changed` batch to `project_id`'s subscribers. Subscribers
/// whose channel is closed are pruned; when none remain the watcher is dropped.
/// Returns `false` when this generation no longer owns the project's watch.
fn deliver(
    watches: &WatchMap,
    project_id: &str,
    generation: u64,
    payload: &FsChangedPayload,
) -> bool {
    let Ok(payload) = serde_json::to_value(payload) else {
        warn!(
            project_id,
            "[fs-watch] failed to serialize fs_changed payload"
        );
        return true;
    };
    let mut guard = watches.lock();
    let Some(watch) = guard
        .get_mut(project_id)
        .filter(|w| w.generation == generation)
    else {
        return false;
    };
    // Bounded delivery: a subscriber whose queue is full misses this batch
    // (the explorer refreshes on the next change) and counts toward its
    // overflow tolerance; one that is closing is pruned.
    watch.subscribers.retain(|subscriber| {
        let outcome = subscriber.try_enqueue(Outbound::Event(SequencedEvent::new(
            None,
            0,
            "fs_changed",
            payload.clone(),
        )));
        if outcome == EnqueueOutcome::Full {
            warn!(project_id, "[fs-watch] subscriber queue full; fs_changed batch dropped");
        }
        outcome != EnqueueOutcome::Closed
    });
    if watch.subscribers.is_empty() {
        if let Some(watch) = guard.remove(project_id) {
            watch.cancel.cancel();
            info!(
                project_id,
                "[fs-watch] all subscribers gone; watcher dropped"
            );
        }
        return false;
    }
    true
}

/// Result of one watcher session.
enum WatchOutcome {
    /// Unsubscribed / connections gone — stop for good.
    Stopped,
    /// The project's root moved — re-arm at the new root.
    RootChanged,
    /// The project was archived/removed/unresolvable — drop the watch.
    ProjectGone,
    /// The watcher errored — backoff and retry.
    Failed,
}

/// Own one project's watcher lifecycle: arm, re-arm on a moved root, retry
/// with backoff on failure, and end (removing this generation's entry) when
/// the project disappears.
async fn run_project_watch(
    project_id: String,
    generation: u64,
    registry: Arc<ProjectRegistry>,
    watches: WatchMap,
    cancel: CancellationToken,
    armed: tokio::sync::watch::Sender<bool>,
) {
    let mut retry_delay = RETRY_BASE;
    while let Some(root) = registry.canonical_root(&project_id) {
        let outcome = watch_root(
            &project_id,
            generation,
            root.clone(),
            &registry,
            &watches,
            &cancel,
            &armed,
        )
        .await;
        armed.send_replace(false);
        match outcome {
            WatchOutcome::Stopped => return,
            WatchOutcome::ProjectGone => break,
            WatchOutcome::RootChanged => {
                retry_delay = RETRY_BASE;
                info!(project_id = %project_id, "[fs-watch] project root changed; re-arming watcher");
            }
            WatchOutcome::Failed => {
                warn!(
                    project_id = %project_id,
                    "[fs-watch] watcher failed; retrying in {:?}", retry_delay
                );
                match backoff(&project_id, &root, retry_delay, &registry, &cancel).await {
                    BackoffOutcome::Stopped => return,
                    BackoffOutcome::ProjectGone => break,
                    BackoffOutcome::RootChanged => {
                        retry_delay = RETRY_BASE;
                        continue;
                    }
                    BackoffOutcome::Elapsed => {}
                }
                retry_delay = std::cmp::min(retry_delay * 2, RETRY_MAX);
            }
        }
    }
    let mut guard = watches.lock();
    if guard
        .get(&project_id)
        .is_some_and(|w| w.generation == generation)
    {
        if let Some(watch) = guard.remove(&project_id) {
            notify_watch_ended(&project_id, &watch.subscribers);
        }
        warn!(project_id = %project_id, "[fs-watch] project archived/removed; watcher and subscriptions dropped");
    }
}

/// Tell every subscriber that its watch of `project_id` ended because the
/// project is no longer watchable (archived, removed, root gone), so the client
/// can re-request the watch instead of waiting for events that never come.
fn notify_watch_ended(project_id: &str, subscribers: &[OutboundSender]) {
    let payload = serde_json::json!({
        "projectId": project_id,
        "reason": "project_unavailable",
    });
    for subscriber in subscribers {
        subscriber.try_enqueue(Outbound::Event(SequencedEvent::new(
            None,
            0,
            "fs_watch_ended",
            payload.clone(),
        )));
    }
}

/// Why a retry backoff ended.
enum BackoffOutcome {
    /// Unsubscribed / connections gone — stop for good.
    Stopped,
    /// The project was archived/removed/unresolvable during the wait.
    ProjectGone,
    /// The project's root moved during the wait — re-arm at once.
    RootChanged,
    /// The delay ran out — retry the same root.
    Elapsed,
}

/// Wait out `delay` before a retry, re-checking the registry every second so
/// an archived/removed project drops its subscriptions, and a moved root
/// re-arms, without waiting for the full (up to 30 s) backoff.
async fn backoff(
    project_id: &str,
    root: &std::path::Path,
    delay: Duration,
    registry: &Arc<ProjectRegistry>,
    cancel: &CancellationToken,
) -> BackoffOutcome {
    let deadline = tokio::time::Instant::now() + delay;
    loop {
        let step = deadline
            .saturating_duration_since(tokio::time::Instant::now())
            .min(REGISTRY_CHECK_INTERVAL);
        tokio::select! {
            () = cancel.cancelled() => return BackoffOutcome::Stopped,
            () = tokio::time::sleep(step) => {}
        }
        match registry.canonical_root(project_id) {
            None => return BackoffOutcome::ProjectGone,
            Some(current) if current != root => return BackoffOutcome::RootChanged,
            Some(_) => {}
        }
        if tokio::time::Instant::now() >= deadline {
            return BackoffOutcome::Elapsed;
        }
    }
}

/// Watch `root` until cancelled, the project goes away or moves, or the
/// watcher errors. Events are debounced into targeted `fs_changed` frames.
async fn watch_root(
    project_id: &str,
    generation: u64,
    root: PathBuf,
    registry: &Arc<ProjectRegistry>,
    watches: &WatchMap,
    cancel: &CancellationToken,
    armed: &tokio::sync::watch::Sender<bool>,
) -> WatchOutcome {
    if !root.is_dir() {
        warn!(
            project_id,
            "[fs-watch] project root is not a directory: {}",
            root.display()
        );
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
            warn!(project_id, "[fs-watch] failed to create watcher: {error}");
            return WatchOutcome::Failed;
        }
    };

    if let Err(error) = watcher.watch(&root, RecursiveMode::Recursive) {
        warn!(
            project_id,
            "[fs-watch] failed to watch {}: {error}",
            root.display()
        );
        return WatchOutcome::Failed;
    }
    info!(
        project_id,
        "[fs-watch] watching project root: {}",
        root.display()
    );
    armed.send_replace(true);

    // Validity tick: re-resolve the project's root against the registry so an
    // archive/remove/path change (from any mutation path) ends or re-arms the
    // watch within a second.
    let mut root_check = tokio::time::interval(REGISTRY_CHECK_INTERVAL);
    root_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    let root_display = root.display().to_string();
    loop {
        tokio::select! {
            () = cancel.cancelled() => return WatchOutcome::Stopped,
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
                    .filter(|path| is_reportable_below_root(path, &root))
                    .filter_map(|path| normalize_path(path))
                    .collect();
                paths.sort();
                paths.dedup();
                if !paths.is_empty() {
                    let payload = FsChangedPayload {
                        project_id: project_id.to_string(),
                        root: root_display.clone(),
                        paths,
                    };
                    if !deliver(watches, project_id, generation, &payload) {
                        return WatchOutcome::Stopped;
                    }
                }
            }
            _ = root_check.tick() => {
                match registry.canonical_root(project_id) {
                    Some(current) if current == root => {}
                    Some(_) => return WatchOutcome::RootChanged,
                    None => return WatchOutcome::ProjectGone,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
