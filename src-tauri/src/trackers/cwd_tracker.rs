use parking_lot::{Mutex, RwLock};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::broadcast;

use super::{TerminalEvent, TerminalEventHub};

const POLL_INTERVAL_MS: u64 = 500;
const MAX_PENDING: usize = 64;

/// State for tracking a single terminal's CWD
#[derive(Clone, Debug)]
pub(crate) struct CwdState {
    pub(crate) terminal_id: String,
    pub(crate) pid: u32,
    pub(crate) last_known_cwd: String,
    pub(crate) prompt_reported: bool,
}

#[derive(Default)]
pub(crate) struct TrackerMaps {
    pub(crate) tracked: HashMap<String, CwdState>,
    pub(crate) pending: HashMap<String, String>,
}

/// Tracks the current working directory (CWD) of terminal processes.
///
/// This tracker learns CWD from authenticated shell PromptReady events,
/// falling back to polling `/proc/{pid}/cwd` on Linux for terminals without
/// shell integration.
///
/// Polling is visibility-aware: when the terminal is hidden, polling is paused
/// to conserve CPU resources.
pub struct CwdTracker {
    /// Serializes cwd state transitions, event emissions, and terminal cleanup.
    ///
    /// Every path that mutates `last_known_cwd` and emits `CwdChanged`, as well as
    /// cleanup paths such as `stop_tracking` and `shutdown`, must acquire `publish_lock`
    /// FIRST and hold it until state mutation/cleanup (and any event emission) completes.
    /// Inside `publish_lock`, the `maps` lock is acquired and released BEFORE calling
    /// git or emit (the maps lock is never held across git or emit).
    /// Lock order is always `publish_lock` then `maps`. Readers such as `get_cwd` and
    /// test accessors take only `maps` and never acquire `publish_lock`, ensuring no
    /// deadlock is possible when `GitTracker` or event listeners call `get_cwd`.
    publish_lock: Arc<Mutex<()>>,

    /// Map of terminal_id to their CWD state, and pending buffered CWDs.
    maps: Arc<RwLock<TrackerMaps>>,

    /// Transport-neutral event fan-out (Tauri renderer + web subscribers).
    events: TerminalEventHub,

    /// Weak reference to git tracker for updating terminal repository state.
    git_tracker: Arc<RwLock<Option<std::sync::Weak<super::git_tracker::GitTracker>>>>,

    /// Initial broadcast receiver subscribed at construction before polling starts.
    initial_rx: Arc<Mutex<Option<broadcast::Receiver<TerminalEvent>>>>,

    /// Handle to the background task (wrapped in Arc<RwLock> for interior mutability).
    poll_handle: Arc<RwLock<Option<tokio::task::JoinHandle<()>>>>,

    /// Whether polling has been started (to prevent duplicate starts).
    is_polling_started: Arc<AtomicBool>,

    /// Whether the terminal is visible (procfs polling only occurs when true).
    is_visible: Arc<AtomicBool>,

    /// Poll counter for testing/debugging (increments each time we poll).
    poll_count: Arc<AtomicBool>,
}

impl CwdTracker {
    /// Creates a new CWD tracker and subscribes to events immediately.
    ///
    /// # Arguments
    /// * `events` - transport-neutral terminal event hub
    pub fn new(events: TerminalEventHub) -> Self {
        let rx = events.subscribe();
        Self {
            publish_lock: Arc::new(Mutex::new(())),
            maps: Arc::new(RwLock::new(TrackerMaps::default())),
            events,
            git_tracker: Arc::new(RwLock::new(None)),
            initial_rx: Arc::new(Mutex::new(Some(rx))),
            poll_handle: Arc::new(RwLock::new(None)),
            is_polling_started: Arc::new(AtomicBool::new(false)),
            is_visible: Arc::new(AtomicBool::new(true)),
            poll_count: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Sets the git tracker instance to notify when terminal CWD changes.
    ///
    /// Stores a weak reference to avoid cyclic Arc references.
    pub fn set_git_tracker(&self, git_tracker: &Arc<super::git_tracker::GitTracker>) {
        *self.git_tracker.write() = Some(Arc::downgrade(git_tracker));
    }

    /// Detects the current working directory for a given process ID.
    ///
    /// # Platform Support
    /// - **Unix/Linux**: Reads `/proc/{pid}/cwd` symlink
    /// - **Windows**: Returns None (not supported)
    ///
    /// # Arguments
    /// * `pid` - Process ID to query
    ///
    /// # Returns
    /// * `Some(String)` - Absolute path to current working directory
    /// * `None` - Process not found or platform not supported
    fn detect_cwd(_pid: u32) -> Option<String> {
        #[cfg(unix)]
        {
            use std::fs;
            use std::path::Path;

            let cwd_path = Path::new("/proc").join(_pid.to_string()).join("cwd");

            // Read the symlink which points to the actual directory
            fs::read_link(&cwd_path)
                .ok()
                .and_then(|path| path.into_os_string().into_string().ok())
        }

        #[cfg(not(unix))]
        {
            // Windows does not have /proc filesystem
            // CWD tracking on Windows would require different mechanisms
            // (e.g., NtQueryInformationProcess), which is not implemented here
            None
        }
    }

    /// Starts tracking a terminal's CWD. Consumes any buffered pending cwd.
    ///
    /// If this is the first terminal being tracked, starts the polling loop.
    ///
    /// # Arguments
    /// * `terminal_id` - Unique identifier for the terminal
    /// * `pid` - Process ID of the terminal shell
    /// * `initial_cwd` - Initial working directory
    pub fn start_tracking(&self, terminal_id: &str, pid: u32, initial_cwd: &str) {
        let _guard = self.publish_lock.lock();
        let (last_known_cwd, should_emit) = {
            let mut maps = self.maps.write();
            let (last_known_cwd, prompt_reported, should_emit) =
                match maps.pending.remove(terminal_id) {
                    Some(pending_cwd) => {
                        let diff = pending_cwd != initial_cwd;
                        (pending_cwd, true, diff)
                    }
                    None => (initial_cwd.to_string(), false, false),
                };

            maps.tracked.insert(
                terminal_id.to_string(),
                CwdState {
                    terminal_id: terminal_id.to_string(),
                    pid,
                    last_known_cwd: last_known_cwd.clone(),
                    prompt_reported,
                },
            );

            (last_known_cwd, should_emit)
        };

        if should_emit {
            Self::emit_cwd_changed(
                &self.git_tracker,
                &self.events,
                terminal_id,
                &last_known_cwd,
            );
        }
        drop(_guard);

        self.ensure_polling_started();
    }

    /// Stops tracking a terminal's CWD and clears any pending entry.
    ///
    /// # Arguments
    /// * `terminal_id` - Terminal identifier to stop tracking
    pub fn stop_tracking(&self, terminal_id: &str) {
        let _guard = self.publish_lock.lock();
        let mut maps = self.maps.write();
        maps.tracked.remove(terminal_id);
        maps.pending.remove(terminal_id);
    }

    /// Gets the last known CWD for a terminal.
    ///
    /// # Arguments
    /// * `terminal_id` - Terminal identifier
    ///
    /// # Returns
    /// * `Some(String)` - Last known working directory
    /// * `None` - Terminal not being tracked
    pub fn get_cwd(&self, terminal_id: &str) -> Option<String> {
        let maps = self.maps.read();
        maps.tracked
            .get(terminal_id)
            .map(|state| state.last_known_cwd.clone())
    }

    /// Sets the visibility flag for polling.
    ///
    /// When `false`, the polling loop will skip CWD detection to save CPU.
    ///
    /// # Arguments
    /// * `visible` - Whether polling should be active
    pub fn set_visibility(&self, visible: bool) {
        self.is_visible.store(visible, Ordering::Relaxed);
    }

    /// Shuts down the tracker, aborts the background task, and clears all tracked state.
    ///
    /// Returns the join handle of the aborted background task if running.
    pub fn shutdown(&self) -> Option<tokio::task::JoinHandle<()>> {
        let handle = self.stop_polling();
        let _guard = self.publish_lock.lock();
        let mut maps = self.maps.write();
        maps.tracked.clear();
        maps.pending.clear();
        handle
    }

    /// Ensures the polling and event processing loop is running.
    ///
    /// This is called internally when adding terminals to tracking.
    /// Uses atomic flag to prevent starting multiple polling loops.
    fn ensure_polling_started(&self) {
        if self
            .is_polling_started
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::Relaxed)
            .is_err()
        {
            return;
        }

        self.start_polling();
    }

    /// Starts the background task for event processing and procfs polling.
    ///
    /// This spawns a tokio task that consumes shell PromptReady events and periodically
    /// checks CWD via `/proc/{pid}/cwd` for tracked terminals that have not reported prompt CWD.
    fn start_polling(&self) {
        let publish_lock = self.publish_lock.clone();
        let tracked_maps = self.maps.clone();
        let is_visible = self.is_visible.clone();
        let events = self.events.clone();
        let git_tracker = self.git_tracker.clone();
        let poll_handle = self.poll_handle.clone();
        let poll_count = self.poll_count.clone();

        let initial_rx = self
            .initial_rx
            .lock()
            .take()
            .unwrap_or_else(|| events.subscribe());

        let handle = tokio::spawn(async move {
            Self::run_poll_loop(
                publish_lock,
                tracked_maps,
                is_visible,
                events,
                git_tracker,
                poll_count,
                initial_rx,
            )
            .await;
        });

        *poll_handle.write() = Some(handle);
    }

    /// Main loop combining periodic procfs polling and terminal event handling.
    async fn run_poll_loop(
        publish_lock: Arc<Mutex<()>>,
        tracked_maps: Arc<RwLock<TrackerMaps>>,
        is_visible: Arc<AtomicBool>,
        events: TerminalEventHub,
        git_tracker: Arc<RwLock<Option<std::sync::Weak<super::git_tracker::GitTracker>>>>,
        poll_count: Arc<AtomicBool>,
        initial_rx: broadcast::Receiver<TerminalEvent>,
    ) {
        let mut event_rx: Option<broadcast::Receiver<TerminalEvent>> = Some(initial_rx);
        let mut interval =
            tokio::time::interval(tokio::time::Duration::from_millis(POLL_INTERVAL_MS));

        loop {
            tokio::select! {
                _ = interval.tick() => {
                    if !is_visible.load(Ordering::Relaxed) {
                        continue;
                    }
                    poll_count.fetch_xor(true, Ordering::Relaxed);
                    Self::poll_tracked_terminals(&publish_lock, &tracked_maps, &git_tracker, &events);
                }
                res = async {
                    match event_rx.as_mut() {
                        Some(rx) => rx.recv().await,
                        None => std::future::pending().await,
                    }
                } => {
                    Self::handle_event_recv(&publish_lock, &tracked_maps, &git_tracker, &events, &mut event_rx, res);
                }
            }
        }
    }

    /// Handles received terminal events, applying PromptReady cwd updates.
    fn handle_event_recv(
        publish_lock: &Arc<Mutex<()>>,
        maps: &Arc<RwLock<TrackerMaps>>,
        git_tracker: &Arc<RwLock<Option<std::sync::Weak<super::git_tracker::GitTracker>>>>,
        events: &TerminalEventHub,
        event_rx: &mut Option<broadcast::Receiver<TerminalEvent>>,
        res: Result<TerminalEvent, broadcast::error::RecvError>,
    ) {
        match res {
            Ok(TerminalEvent::SessionLifecycle {
                kind,
                cwd: Some(cwd),
                terminal_id,
                ..
            }) if kind == "PromptReady" => {
                Self::apply_prompt_cwd(publish_lock, maps, git_tracker, events, &terminal_id, &cwd);
            }
            Ok(_) => {}
            Err(broadcast::error::RecvError::Lagged(n)) => {
                log::warn!("[cwd-tracker] event receiver lagged: {} events dropped", n);
            }
            Err(broadcast::error::RecvError::Closed) => {
                log::warn!("[cwd-tracker] event receiver closed");
                *event_rx = None;
            }
        }
    }

    /// Stops the polling and event processing loop.
    ///
    /// Returns the join handle of the aborted background task if running.
    pub fn stop_polling(&self) -> Option<tokio::task::JoinHandle<()>> {
        let mut poll_handle_guard = self.poll_handle.write();
        let handle = poll_handle_guard.take();
        if let Some(ref h) = handle {
            h.abort();
        }
        self.is_polling_started.store(false, Ordering::SeqCst);
        handle
    }

    /// Directly reports a CWD for a terminal, such as from shell integration or IPC.
    ///
    /// If the terminal is already tracked, marks it as prompt-reported (disabling
    /// procfs polling fallback) and emits a CwdChanged event if changed. If not tracked,
    /// buffers the cwd in the pending map.
    pub fn report_cwd(&self, terminal_id: &str, cwd: &str) {
        Self::apply_prompt_cwd(
            &self.publish_lock,
            &self.maps,
            &self.git_tracker,
            &self.events,
            terminal_id,
            cwd,
        );
    }

    /// Buffers a CWD in the pending map for an untracked terminal, evicting an
    /// arbitrary entry if capacity exceeds MAX_PENDING.
    fn buffer_pending(maps: &mut TrackerMaps, terminal_id: &str, cwd: &str) {
        if !maps.pending.contains_key(terminal_id) && maps.pending.len() >= MAX_PENDING {
            if let Some(evicted) = maps.pending.keys().next().cloned() {
                maps.pending.remove(&evicted);
                log::warn!(
                    "[cwd-tracker] pending cwd map full, evicting terminal_id={}",
                    evicted
                );
            }
        }
        log::debug!(
            "[cwd-tracker] buffering cwd to pending for terminal_id={}",
            terminal_id
        );
        maps.pending
            .insert(terminal_id.to_string(), cwd.to_string());
    }

    /// Emits a CwdChanged event to the event hub and updates the GitTracker.
    fn emit_cwd_changed(
        git_tracker: &Arc<RwLock<Option<std::sync::Weak<super::git_tracker::GitTracker>>>>,
        events: &TerminalEventHub,
        terminal_id: &str,
        cwd: &str,
    ) {
        if let Some(git) = git_tracker.read().as_ref().and_then(|g| g.upgrade()) {
            git.update_terminal_cwd(terminal_id, cwd.to_string());
        }
        events.emit(TerminalEvent::CwdChanged {
            terminal_id: terminal_id.to_string(),
            cwd: cwd.to_string(),
        });
    }

    /// Applies a prompt-reported CWD to a tracked terminal or buffers it in pending.
    ///
    /// Acquires `publish_lock` first to serialize state mutation and event emission.
    fn apply_prompt_cwd(
        publish_lock: &Arc<Mutex<()>>,
        maps: &Arc<RwLock<TrackerMaps>>,
        git_tracker: &Arc<RwLock<Option<std::sync::Weak<super::git_tracker::GitTracker>>>>,
        events: &TerminalEventHub,
        terminal_id: &str,
        cwd: &str,
    ) {
        let _guard = publish_lock.lock();
        let update = {
            let mut maps = maps.write();
            if let Some(state) = maps.tracked.get_mut(terminal_id) {
                state.prompt_reported = true;
                if state.last_known_cwd != cwd {
                    state.last_known_cwd = cwd.to_string();
                    Some((terminal_id.to_string(), cwd.to_string()))
                } else {
                    None
                }
            } else {
                Self::buffer_pending(&mut maps, terminal_id, cwd);
                None
            }
        };

        if let Some((term_id, new_cwd)) = update {
            Self::emit_cwd_changed(git_tracker, events, &term_id, &new_cwd);
        }
    }

    /// Performs a single poll step for a terminal with detected procfs CWD (for testing).
    #[cfg(test)]
    pub(crate) fn poll_step_terminal(&self, terminal_id: &str, detected_cwd: &str) -> bool {
        Self::apply_poll_step(
            &self.publish_lock,
            &self.maps,
            &self.git_tracker,
            &self.events,
            terminal_id,
            detected_cwd,
        )
    }

    /// Applies a detected procfs CWD to a terminal if it has not yet reported prompt CWD.
    ///
    /// Acquires `publish_lock` first to serialize state mutation and event emission.
    fn apply_poll_step(
        publish_lock: &Arc<Mutex<()>>,
        maps: &Arc<RwLock<TrackerMaps>>,
        git_tracker: &Arc<RwLock<Option<std::sync::Weak<super::git_tracker::GitTracker>>>>,
        events: &TerminalEventHub,
        terminal_id: &str,
        detected_cwd: &str,
    ) -> bool {
        let _guard = publish_lock.lock();
        let update = {
            let mut maps = maps.write();
            if let Some(state) = maps.tracked.get_mut(terminal_id) {
                if state.prompt_reported {
                    None
                } else if state.last_known_cwd != detected_cwd {
                    state.last_known_cwd = detected_cwd.to_string();
                    Some((terminal_id.to_string(), detected_cwd.to_string()))
                } else {
                    None
                }
            } else {
                None
            }
        };

        if let Some((term_id, new_cwd)) = update {
            Self::emit_cwd_changed(git_tracker, events, &term_id, &new_cwd);
            true
        } else {
            false
        }
    }

    /// Iterates over tracked terminals without prompt reporting and polls their procfs CWD.
    fn poll_tracked_terminals(
        publish_lock: &Arc<Mutex<()>>,
        maps: &Arc<RwLock<TrackerMaps>>,
        git_tracker: &Arc<RwLock<Option<std::sync::Weak<super::git_tracker::GitTracker>>>>,
        events: &TerminalEventHub,
    ) {
        let snapshots: Vec<(String, u32)> = {
            let maps = maps.read();
            maps.tracked
                .values()
                .filter(|state| !state.prompt_reported)
                .map(|state| (state.terminal_id.clone(), state.pid))
                .collect()
        };

        for (terminal_id, pid) in snapshots {
            if let Some(new_cwd) = Self::detect_cwd(pid) {
                Self::apply_poll_step(
                    publish_lock,
                    maps,
                    git_tracker,
                    events,
                    &terminal_id,
                    &new_cwd,
                );
            }
        }
    }

    /// Returns a reference to the tracked terminals map (for testing).
    #[cfg(test)]
    pub fn tracked_count(&self) -> usize {
        self.maps.read().tracked.len()
    }

    /// Returns the current visibility state (for testing).
    #[cfg(test)]
    pub fn is_tracking_visible(&self) -> bool {
        self.is_visible.load(Ordering::Relaxed)
    }

    /// Returns whether polling has been started (for testing).
    #[cfg(test)]
    pub fn is_polling_active(&self) -> bool {
        self.is_polling_started.load(Ordering::Relaxed)
    }

    /// Returns and resets the poll count (for testing).
    /// This increments each time the polling loop runs.
    /// Useful for verifying that polling is actually occurring.
    #[cfg(test)]
    pub fn take_poll_count(&self) -> bool {
        self.poll_count.fetch_and(false, Ordering::Relaxed)
    }

    /// Checks whether a terminal ID is buffered in pending (for testing).
    #[cfg(test)]
    pub fn has_pending(&self, terminal_id: &str) -> bool {
        self.maps.read().pending.contains_key(terminal_id)
    }

    /// Returns the number of buffered pending entries (for testing).
    #[cfg(test)]
    pub fn pending_count(&self) -> usize {
        self.maps.read().pending.len()
    }

    /// Checks whether a terminal has received a prompt CWD report (for testing).
    #[cfg(test)]
    pub fn is_prompt_reported(&self, terminal_id: &str) -> bool {
        self.maps
            .read()
            .tracked
            .get(terminal_id)
            .is_some_and(|s| s.prompt_reported)
    }

    /// Exposes the publish lock for testing synchronization invariants (for testing).
    #[cfg(test)]
    pub(crate) fn publish_lock(&self) -> Arc<Mutex<()>> {
        self.publish_lock.clone()
    }
}

#[cfg(test)]
mod tests;
