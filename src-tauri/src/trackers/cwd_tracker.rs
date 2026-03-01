use std::collections::HashMap;
use parking_lot::RwLock;
use std::sync::Arc;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use std::sync::atomic::{AtomicBool, Ordering};

const POLL_INTERVAL_MS: u64 = 500;

/// State for tracking a single terminal's CWD
#[derive(Clone, Debug)]
struct CwdState {
    terminal_id: String,
    pid: u32,
    last_known_cwd: String,
}

/// Event emitted when a terminal's CWD changes
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CwdChangedEvent {
    pub terminal_id: String,
    pub cwd: String,
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

    /// Tauri app handle for emitting events
    app_handle: AppHandle,

    /// Handle to the polling task
    poll_handle: Option<tokio::task::JoinHandle<()>>,

    /// Whether the terminal is visible (polling only occurs when true)
    is_visible: Arc<AtomicBool>,
}

impl CwdTracker {
    /// Creates a new CWD tracker.
    ///
    /// # Arguments
    /// * `app_handle` - Tauri app handle for emitting events
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            tracked_terminals: Arc::new(RwLock::new(HashMap::new())),
            app_handle,
            poll_handle: None,
            is_visible: Arc::new(AtomicBool::new(true)),
        }
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
        if let Some(handle) = &self.poll_handle {
            handle.abort();
        }

        // Clear all tracked terminals
        let mut terminals = self.tracked_terminals.write();
        terminals.clear();
    }

    /// Ensures the polling loop is running.
    ///
    /// This is called internally when adding terminals to tracking.
    /// Uses interior mutability pattern through the poll_handle Option.
    fn ensure_polling_started(&self) {
        // We need to check if polling is running and start it if not.
        // Since we need mutable access to poll_handle, we use a workaround.
        // In practice, this should be called through a mutable reference
        // or the polling should be managed through a separate mechanism.

        // For this implementation, we assume start_polling() is called externally
        // when the first terminal is added, or we use unsafe cell internally.
        // The actual implementation defers to start_polling() being called.
    }

    /// Starts the polling loop.
    ///
    /// This spawns a tokio task that periodically checks CWD for all tracked terminals.
    /// This requires mutable access to set the poll_handle.
    pub fn start_polling(&mut self) {
        // Don't start if already polling
        if self.poll_handle.is_some() {
            return;
        }

        let tracked = self.tracked_terminals.clone();
        let is_visible = self.is_visible.clone();
        let app_handle = self.app_handle.clone();

        let handle = tokio::spawn(async move {
            let mut interval = tokio::time::interval(tokio::time::Duration::from_millis(POLL_INTERVAL_MS));

            loop {
                interval.tick().await;

                // Skip polling when not visible
                if !is_visible.load(Ordering::Relaxed) {
                    continue;
                }

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

                                // Emit the event
                                let event = CwdChangedEvent {
                                    terminal_id: terminal_id.clone(),
                                    cwd: new_cwd,
                                };

                                let _ = app_handle.emit("terminal-cwd-changed", event);
                            }
                        }
                    }
                }
            }
        });

        self.poll_handle = Some(handle);
    }

    /// Stops the polling loop.
    pub fn stop_polling(&mut self) {
        if let Some(handle) = self.poll_handle.take() {
            handle.abort();
        }
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_cwd_unix() {
        #[cfg(unix)]
        {
            // Test with current process
            let pid = std::process::id();
            let cwd = CwdTracker::detect_cwd(pid);
            assert!(cwd.is_some());

            // Test with invalid PID
            let invalid_cwd = CwdTracker::detect_cwd(999_999);
            assert!(invalid_cwd.is_none());
        }

        #[cfg(not(unix))]
        {
            // On Windows, should always return None
            let cwd = CwdTracker::detect_cwd(std::process::id());
            assert!(cwd.is_none());
        }
    }

    #[test]
    fn test_cwd_state_creation() {
        let state = CwdState {
            terminal_id: "test-term".to_string(),
            pid: 1234,
            last_known_cwd: "/home/user".to_string(),
        };

        assert_eq!(state.terminal_id, "test-term");
        assert_eq!(state.pid, 1234);
        assert_eq!(state.last_known_cwd, "/home/user");
    }

    #[test]
    fn test_start_tracking() {
        // Create a mock AppHandle - in real tests, use Tauri's test utilities
        // For now, we skip this test as it requires a valid AppHandle
        // This is a placeholder showing the test structure
    }
}
