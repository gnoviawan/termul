use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use super::{TerminalEvent, TerminalEventHub};

const POLL_INTERVAL_MS: u64 = 500;

/// State for tracking a single terminal's CWD
#[derive(Clone, Debug)]
struct CwdState {
    terminal_id: String,
    pid: u32,
    last_known_cwd: String,
}

/// Tracks the current working directory (CWD) of terminal processes.
///
/// This tracker polls the `/proc/{pid}/cwd` symlink on Unix systems to detect
/// directory changes. On Windows, CWD tracking is not supported and returns None.
///
/// Polling is visibility-aware: when the terminal is hidden, polling is paused
/// to conserve CPU resources.
pub struct CwdTracker {
    /// Map of terminal_id to their CWD state
    tracked_terminals: Arc<RwLock<HashMap<String, CwdState>>>,

    /// Transport-neutral event fan-out (Tauri renderer + web subscribers).
    events: TerminalEventHub,
    git_tracker: Arc<RwLock<Option<std::sync::Weak<super::git_tracker::GitTracker>>>>,

    /// Handle to the polling task (wrapped in Arc<RwLock> for interior mutability)
    poll_handle: Arc<RwLock<Option<tokio::task::JoinHandle<()>>>>,

    /// Whether polling has been started (to prevent duplicate starts)
    is_polling_started: Arc<AtomicBool>,

    /// Whether the terminal is visible (polling only occurs when true)
    is_visible: Arc<AtomicBool>,

    /// Poll counter for testing/debugging (increments each time we poll)
    poll_count: Arc<AtomicBool>,
}

impl CwdTracker {
    /// Creates a new CWD tracker.
    ///
    /// # Arguments
    /// * `events` - transport-neutral terminal event hub
    pub fn new(events: TerminalEventHub) -> Self {
        Self {
            tracked_terminals: Arc::new(RwLock::new(HashMap::new())),
            events,
            git_tracker: Arc::new(RwLock::new(None)),
            poll_handle: Arc::new(RwLock::new(None)),
            is_polling_started: Arc::new(AtomicBool::new(false)),
            is_visible: Arc::new(AtomicBool::new(true)),
            poll_count: Arc::new(AtomicBool::new(false)),
        }
    }

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

    /// Starts tracking a terminal's CWD.
    ///
    /// If this is the first terminal being tracked, starts the polling loop.
    ///
    /// # Arguments
    /// * `terminal_id` - Unique identifier for the terminal
    /// * `pid` - Process ID of the terminal shell
    /// * `initial_cwd` - Initial working directory
    pub fn start_tracking(&self, terminal_id: &str, pid: u32, initial_cwd: &str) {
        let state = CwdState {
            terminal_id: terminal_id.to_string(),
            pid,
            last_known_cwd: initial_cwd.to_string(),
        };

        {
            let mut terminals = self.tracked_terminals.write();
            terminals.insert(terminal_id.to_string(), state);
        }

        // Start polling if not already running
        self.ensure_polling_started();
    }

    /// Stops tracking a terminal's CWD.
    ///
    /// # Arguments
    /// * `terminal_id` - Terminal identifier to stop tracking
    pub fn stop_tracking(&self, terminal_id: &str) {
        let mut terminals = self.tracked_terminals.write();
        terminals.remove(terminal_id);
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
        let terminals = self.tracked_terminals.read();
        terminals
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

    /// Shuts down the tracker and stops all polling.
    ///
    /// This aborts the polling task and clears all tracked terminals.
    pub fn shutdown(&self) {
        // Abort the polling task if running
        let mut poll_handle_guard = self.poll_handle.write();
        if let Some(handle) = poll_handle_guard.take() {
            handle.abort();
        }

        // Reset the polling started flag
        self.is_polling_started.store(false, Ordering::SeqCst);

        // Clear all tracked terminals
        let mut terminals = self.tracked_terminals.write();
        terminals.clear();
    }

    /// Ensures the polling loop is running.
    ///
    /// This is called internally when adding terminals to tracking.
    /// Uses atomic flag to prevent starting multiple polling loops.
    fn ensure_polling_started(&self) {
        // Use compare_exchange to atomically start polling only once
        if self
            .is_polling_started
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::Relaxed)
            .is_err()
        {
            // Already started, return early
            return;
        }

        // Start the polling loop
        self.start_polling();
    }

    /// Starts the polling loop.
    ///
    /// This spawns a tokio task that periodically checks CWD for all tracked terminals.
    /// Uses interior mutability through Arc<RwLock> for poll_handle.
    fn start_polling(&self) {
        let tracked = self.tracked_terminals.clone();
        let is_visible = self.is_visible.clone();
        let events = self.events.clone();
        let git_tracker = self.git_tracker.clone();
        let poll_handle = self.poll_handle.clone();
        let poll_count = self.poll_count.clone();

        let handle = tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(tokio::time::Duration::from_millis(POLL_INTERVAL_MS));

            loop {
                interval.tick().await;

                // Skip polling when not visible
                if !is_visible.load(Ordering::Relaxed) {
                    continue;
                }

                // Increment poll counter for testing/debugging
                poll_count.fetch_xor(true, Ordering::Relaxed);

                // Collect terminal IDs and PIDs to avoid holding the write lock during detection
                let snapshots: Vec<(String, u32)> = {
                    let terminals = tracked.read();
                    terminals
                        .values()
                        .map(|state| (state.terminal_id.clone(), state.pid))
                        .collect()
                };

                // Check each terminal's CWD
                for (terminal_id, pid) in snapshots {
                    if let Some(new_cwd) = Self::detect_cwd(pid) {
                        let mut terminals = tracked.write();

                        if let Some(state) = terminals.get_mut(&terminal_id) {
                            // Only emit event if CWD actually changed
                            if state.last_known_cwd != new_cwd {
                                state.last_known_cwd = new_cwd.clone();
                                if let Some(git) =
                                    git_tracker.read().as_ref().and_then(|g| g.upgrade())
                                {
                                    git.update_terminal_cwd(&terminal_id, new_cwd.clone());
                                }

                                events.emit(TerminalEvent::CwdChanged {
                                    terminal_id: terminal_id.clone(),
                                    cwd: new_cwd,
                                });
                            }
                        }
                    }
                }
            }
        });

        // Store the handle using RwLock write lock
        let mut poll_handle_guard = poll_handle.write();
        *poll_handle_guard = Some(handle);
    }

    /// Stops the polling loop.
    pub fn stop_polling(&self) {
        let mut poll_handle_guard = self.poll_handle.write();
        if let Some(handle) = poll_handle_guard.take() {
            handle.abort();
        }
        // Reset the flag so polling can be restarted
        self.is_polling_started.store(false, Ordering::SeqCst);
    }

    /// Returns a reference to the tracked terminals map (for testing)
    #[cfg(test)]
    pub fn tracked_count(&self) -> usize {
        self.tracked_terminals.read().len()
    }

    /// Returns the current visibility state (for testing)
    #[cfg(test)]
    pub fn is_tracking_visible(&self) -> bool {
        self.is_visible.load(Ordering::Relaxed)
    }

    /// Returns whether polling has been started (for testing)
    #[cfg(test)]
    pub fn is_polling_active(&self) -> bool {
        self.is_polling_started.load(Ordering::Relaxed)
    }

    /// Returns and resets the poll count (for testing)
    /// This increments each time the polling loop runs.
    /// Useful for verifying that polling is actually occurring.
    #[cfg(test)]
    pub fn take_poll_count(&self) -> bool {
        self.poll_count.fetch_and(false, Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests;
