use std::collections::HashMap;
use std::process::Command;
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Duration;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use std::sync::atomic::{AtomicBool, Ordering};

/// Cache for the resolved git binary path (avoiding Laragon PATH pollution)
static GIT_BINARY: OnceLock<String> = OnceLock::new();

/// Resolve the git binary path, filtering out Laragon's git installation.
///
/// On Windows, runs `where git` to get all git paths in PATH order.
/// On Unix, runs `which -a git`.
/// Skips any path that contains "laragon" (case-insensitive).
/// Falls back to plain `"git"` if no suitable path is found.
fn resolve_git_binary() -> &'static str {
    GIT_BINARY.get_or_init(|| {
        #[cfg(target_os = "windows")]
        let where_cmd = Command::new("where").arg("git").output();
        #[cfg(not(target_os = "windows"))]
        let where_cmd = Command::new("which").args(["-a", "git"]).output();

        if let Ok(output) = where_cmd {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let path = line.trim();
                    if path.is_empty() {
                        continue;
                    }
                    // Skip Laragon's git (case-insensitive match)
                    if path.to_lowercase().contains("laragon") {
                        log::debug!("[GitTracker] Skipping Laragon git: {}", path);
                        continue;
                    }
                    log::debug!("[GitTracker] Using git binary: {}", path);
                    return path.to_string();
                }
            }
        }

        // Fallback to plain "git" if nothing better found
        log::warn!("[GitTracker] Could not resolve non-Laragon git binary, using plain 'git'");
        "git".to_string()
    })
}

const POLL_INTERVAL_MS: u64 = 6000;

/// Git status information
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub modified: u32,
    pub staged: u32,
    pub untracked: u32,
    pub has_changes: bool,
}

impl GitStatus {
    /// Create a new GitStatus with all zeros
    pub fn new() -> Self {
        Self {
            modified: 0,
            staged: 0,
            untracked: 0,
            has_changes: false,
        }
    }
}

impl Default for GitStatus {
    fn default() -> Self {
        Self::new()
    }
}

/// Internal state for tracking a terminal's git information
#[derive(Debug, Clone)]
struct GitState {
    _terminal_id: String,
    last_known_branch: Option<String>,
    last_known_cwd: String,
    last_known_status: Option<GitStatus>,
}

/// Event emitted when git branch changes
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitBranchChangedEvent {
    terminal_id: String,
    branch: Option<String>,
}

/// Event emitted when git status changes
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitStatusChangedEvent {
    terminal_id: String,
    status: Option<GitStatus>,
}

/// Tracks git repository status for terminals
///
/// Polls git status periodically and emits events when branch or status changes.
/// Skips polling when the window is not visible to save resources.
pub struct GitTracker {
    terminal_states: Arc<RwLock<HashMap<String, GitState>>>,
    app_handle: AppHandle,
    poll_handle: Arc<RwLock<Option<tokio::task::JoinHandle<()>>>>,
    is_polling_started: Arc<AtomicBool>,
    is_visible: Arc<AtomicBool>,
    is_polling: Arc<AtomicBool>,
}

impl GitTracker {
    /// Create a new GitTracker with the given app handle
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            terminal_states: Arc::new(RwLock::new(HashMap::new())),
            app_handle,
            poll_handle: Arc::new(RwLock::new(None)),
            is_polling_started: Arc::new(AtomicBool::new(false)),
            is_visible: Arc::new(AtomicBool::new(true)),
            is_polling: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Initialize tracking for a terminal with the given working directory
    pub fn initialize_terminal(&self, terminal_id: &str, cwd: &str) {
        // Get initial branch and status
        let branch = Self::check_branch_internal(cwd);
        let status = Self::check_status_internal(cwd);

        let state = GitState {
            _terminal_id: terminal_id.to_string(),
            last_known_branch: branch.clone(),
            last_known_cwd: cwd.to_string(),
            last_known_status: status.clone(),
        };

        self.terminal_states.write().insert(terminal_id.to_string(), state);

        // Emit initial events
        self.emit_branch_changed(terminal_id, &branch);
        self.emit_status_changed(terminal_id, &status);

        // Start polling if not already running
        if self.is_polling_started.compare_exchange(
            false,
            true,
            Ordering::SeqCst,
            Ordering::Relaxed
        ).is_ok() {
            self.start_polling();
        }
    }

    /// Remove a terminal from tracking
    pub fn remove_terminal(&self, terminal_id: &str) {
        self.terminal_states.write().remove(terminal_id);

        // If no terminals left, we could stop polling but keep it running
        // for simplicity - it will just skip when empty
    }

    /// Get the current branch for a terminal
    pub fn get_branch(&self, terminal_id: &str) -> Option<String> {
        self.terminal_states
            .read()
            .get(terminal_id)
            .and_then(|s| s.last_known_branch.clone())
    }

    /// Get the current git status for a terminal
    pub fn get_status(&self, terminal_id: &str) -> Option<GitStatus> {
        self.terminal_states
            .read()
            .get(terminal_id)
            .and_then(|s| s.last_known_status.clone())
    }

    /// Update the visibility state for polling
    ///
    /// When false, polling will skip git commands to save CPU.
    pub fn set_visibility(&self, visible: bool) {
        self.is_visible.store(visible, Ordering::SeqCst);
    }

    /// Shutdown the tracker and stop polling
    pub fn shutdown(&self) {
        // Abort the polling task if running
        let mut poll_handle_guard = self.poll_handle.write();
        if let Some(handle) = poll_handle_guard.take() {
            handle.abort();
        }
        // Reset the flag so polling can be restarted
        self.is_polling_started.store(false, Ordering::SeqCst);
        self.terminal_states.write().clear();
    }

    /// Start the polling task
    fn start_polling(&self) {
        let states = self.terminal_states.clone();
        let is_visible = self.is_visible.clone();
        let is_polling = self.is_polling.clone();
        let app_handle = self.app_handle.clone();
        let poll_handle = self.poll_handle.clone();

        let handle = tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(POLL_INTERVAL_MS));

            loop {
                interval.tick().await;

                // Skip when not visible
                if !is_visible.load(Ordering::SeqCst) {
                    continue;
                }

                // Guard against concurrent polls
                if is_polling.swap(true, Ordering::SeqCst) {
                    continue; // Already polling
                }

                // Clone the data we need
                let terminals: Vec<(String, String)> = states
                    .read()
                    .iter()
                    .map(|(id, s)| (id.clone(), s.last_known_cwd.clone()))
                    .collect();

                for (terminal_id, cwd) in terminals {
                    // Check status
                    if let Some(new_status) = Self::check_status_internal(&cwd) {
                        let needs_emit = {
                            let mut states_guard = states.write();
                            if let Some(state) = states_guard.get_mut(&terminal_id) {
                                let should_emit = Some(&new_status) != state.last_known_status.as_ref();
                                state.last_known_status = Some(new_status.clone());
                                should_emit
                            } else {
                                false
                            }
                        };

                        if needs_emit {
                            Self::emit_status_changed_static(&app_handle, &terminal_id, &Some(new_status));
                        }
                    }
                }

                is_polling.store(false, Ordering::SeqCst);
            }
        });

        // Store the handle using RwLock write lock
        let mut poll_handle_guard = poll_handle.write();
        *poll_handle_guard = Some(handle);
    }

    /// Check the git branch for a directory
    ///
    /// Runs `git rev-parse --abbrev-ref HEAD` and returns the branch name.
    /// Returns None if not in a git repository or in detached HEAD state.
    fn check_branch_internal(cwd: &str) -> Option<String> {
        let output = Command::new(resolve_git_binary())
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(cwd)
            .output()
            .ok()?;

        if !output.status.success() {
            return None;
        }

        let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();

        // HEAD indicates detached HEAD state - treat as no branch
        if branch == "HEAD" {
            None
        } else {
            Some(branch)
        }
    }

    /// Check the git status for a directory
    ///
    /// Runs `git status --porcelain` and returns parsed status.
    /// Returns None if not in a git repository.
    fn check_status_internal(cwd: &str) -> Option<GitStatus> {
        let output = Command::new(resolve_git_binary())
            .args(["status", "--porcelain"])
            .current_dir(cwd)
            .output()
            .ok()?;

        if !output.status.success() {
            return None;
        }

        Some(Self::parse_git_status(&String::from_utf8_lossy(&output.stdout)))
    }

    /// Parse git status --porcelain output
    ///
    /// Format: XY filename
    /// - X = index status
    /// - Y = work tree status
    ///
    /// ?? = untracked
    /// M/D in workTreeStatus = modified
    /// indexStatus not space/? = staged
    fn parse_git_status(output: &str) -> GitStatus {
        let mut status = GitStatus::new();

        for line in output.lines() {
            if line.len() < 2 {
                continue;
            }

            let chars: Vec<char> = line.chars().collect();
            let index_status = chars[0];
            let work_tree_status = chars[1];

            if line.starts_with("??") {
                // Untracked files
                status.untracked += 1;
            } else {
                // Working tree modifications (M = modified, D = deleted)
                if work_tree_status == 'M' || work_tree_status == 'D' {
                    status.modified += 1;
                }

                // Staged changes (anything in index that's not space or ?)
                if index_status != ' ' && index_status != '?' {
                    status.staged += 1;
                }
            }
        }

        status.has_changes = status.modified + status.staged + status.untracked > 0;

        status
    }

    /// Emit a branch changed event
    fn emit_branch_changed(&self, terminal_id: &str, branch: &Option<String>) {
        let event = GitBranchChangedEvent {
            terminal_id: terminal_id.to_string(),
            branch: branch.clone(),
        };
        let _ = self.app_handle.emit("terminal-git-branch-changed", event);
    }

    /// Emit a status changed event
    fn emit_status_changed(&self, terminal_id: &str, status: &Option<GitStatus>) {
        let event = GitStatusChangedEvent {
            terminal_id: terminal_id.to_string(),
            status: status.clone(),
        };
        let _ = self.app_handle.emit("terminal-git-status-changed", event);
    }

    /// Static version of emit_status_changed for use in async context
    fn emit_status_changed_static(app_handle: &AppHandle, terminal_id: &str, status: &Option<GitStatus>) {
        let event = GitStatusChangedEvent {
            terminal_id: terminal_id.to_string(),
            status: status.clone(),
        };
        let _ = app_handle.emit("terminal-git-status-changed", event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_git_status_empty() {
        let status = GitTracker::parse_git_status("");
        assert_eq!(status.modified, 0);
        assert_eq!(status.staged, 0);
        assert_eq!(status.untracked, 0);
        assert!(!status.has_changes);
    }

    #[test]
    fn test_parse_git_status_untracked() {
        let status = GitTracker::parse_git_status("?? new-file.txt\n?? another.txt\n");
        assert_eq!(status.untracked, 2);
        assert_eq!(status.modified, 0);
        assert_eq!(status.staged, 0);
        assert!(status.has_changes);
    }

    #[test]
    fn test_parse_git_status_modified() {
        let status = GitTracker::parse_git_status(" M modified.txt\n D deleted.txt\n");
        assert_eq!(status.untracked, 0);
        assert_eq!(status.modified, 2);
        assert_eq!(status.staged, 0);
        assert!(status.has_changes);
    }

    #[test]
    fn test_parse_git_status_staged() {
        let status = GitTracker::parse_git_status("M  staged.txt\nA  added.txt\nD  deleted-staged.txt\n");
        assert_eq!(status.untracked, 0);
        assert_eq!(status.modified, 0);
        assert_eq!(status.staged, 3);
        assert!(status.has_changes);
    }

    #[test]
    fn test_parse_git_status_staged_and_modified() {
        let status = GitTracker::parse_git_status("MM both-changed.txt\n");
        assert_eq!(status.untracked, 0);
        assert_eq!(status.modified, 1); // Work tree has M
        assert_eq!(status.staged, 1);   // Index has M
        assert!(status.has_changes);
    }

    #[test]
    fn test_parse_git_status_mixed() {
        let output = "?? untracked.txt\n M modified.txt\nM  staged.txt\nMM both.txt\n";
        let status = GitTracker::parse_git_status(output);
        assert_eq!(status.untracked, 1);
        assert_eq!(status.modified, 2); // modified.txt + both.txt (work tree)
        assert_eq!(status.staged, 2);   // staged.txt + both.txt (index)
        assert!(status.has_changes);
    }

    #[test]
    fn test_git_status_new() {
        let status = GitStatus::new();
        assert_eq!(status.modified, 0);
        assert_eq!(status.staged, 0);
        assert_eq!(status.untracked, 0);
        assert!(!status.has_changes);
    }

    #[test]
    fn test_git_status_default() {
        let status = GitStatus::default();
        assert_eq!(status.modified, 0);
        assert_eq!(status.staged, 0);
        assert_eq!(status.untracked, 0);
        assert!(!status.has_changes);
    }

    #[test]
    fn test_parse_git_status_renamed() {
        // Renamed files show as R
        let status = GitTracker::parse_git_status("R  renamed.txt\n");
        assert_eq!(status.untracked, 0);
        assert_eq!(status.modified, 0);
        assert_eq!(status.staged, 1); // R in index counts as staged
        assert!(status.has_changes);
    }

    #[test]
    fn test_parse_git_status_ignored_lines() {
        // Short lines should be skipped
        let status = GitTracker::parse_git_status("M\n\n?? file.txt\n");
        assert_eq!(status.untracked, 1);
        assert_eq!(status.modified, 0);
        assert!(status.has_changes);
    }
}
