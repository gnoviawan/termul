use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::process::Command;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

use super::cwd_tracker::CwdTracker;
use super::{TerminalEvent, TerminalEventHub};

mod commands;
mod polling;
mod resolve;
mod types;

// Internal items shared across the `git_tracker` submodule tree — bound here so
// `use super::*` in each child (including `tests`) resolves them exactly as
// they resolved against the single-file module.
#[cfg(test)]
use commands::{
    build_commit_message, build_diff_args, classify_discard_action,
    git_get_status_detail_from_output, is_benign_log_failure, is_safe_relative_path, parse_git_log,
    repo_has_head, staged_entry_count, validate_hunk_patch_paths, DiscardAction, NULL_DEVICE,
};
#[cfg(test)]
use polling::PollingGuard;
use resolve::backend_command;

// `crate::trackers::git_tracker` public surface preserved via re-export.
pub use commands::{
    git_checkout_branch, git_commit_file, git_create_branch, git_discard_file,
    git_get_commit_context, git_get_diff, git_get_log, git_get_status_detail, git_push_current,
    git_stage_file, git_stage_hunk, git_unstage_file, git_unstage_hunk,
};
pub use resolve::{resolve_executable, resolve_git_binary};
pub use types::{GitCommit, GitCommitContext, GitStatus, GitStatusDetail};

const POLL_INTERVAL_MS: u64 = 6000;
const GIT_COMMAND_TIMEOUT_MS: u64 = 2000;

/// Windows-specific polling multiplier for longer intervals between checks
#[cfg(target_os = "windows")]
const WINDOWS_POLL_MULTIPLIER: u32 = 2;

/// Cooldown duration when status hasn't changed (Windows only)
#[cfg(target_os = "windows")]
const STATUS_UNCHANGED_COOLDOWN_MS: u64 = POLL_INTERVAL_MS * 3;

/// Windows-only state for tracking when a CWD was last polled
#[cfg(target_os = "windows")]
#[derive(Debug, Clone)]
struct CwdPollState {
    last_checked: Instant,
    last_branch: Option<String>,
    last_status: Option<GitStatus>,
    last_snapshot_unchanged: bool,
}

#[cfg(target_os = "windows")]
impl CwdPollState {
    fn new() -> Self {
        Self {
            last_checked: Instant::now() - Duration::from_secs(60), // Initially allow immediate poll
            last_branch: None,
            last_status: None,
            last_snapshot_unchanged: false,
        }
    }
}

#[cfg(target_os = "windows")]
impl Default for CwdPollState {
    fn default() -> Self {
        Self::new()
    }
}

type BranchEmit = (String, Option<String>);
type StatusEmit = (String, Option<GitStatus>);
type GitResultEmits = (Vec<BranchEmit>, Vec<StatusEmit>);

/// Internal state for tracking a terminal's git information
#[derive(Debug, Clone)]
struct GitState {
    _terminal_id: String,
    last_known_branch: Option<String>,
    last_known_cwd: String,
    last_known_status: Option<GitStatus>,
}

impl GitState {
    fn update_terminal_cwd(&mut self, new_cwd: String) -> bool {
        if self.last_known_cwd == new_cwd {
            return false;
        }

        self.last_known_cwd = new_cwd;
        true
    }
}

/// Tracks git repository status for terminals
///
/// Polls git status periodically and emits events when branch or status changes.
/// Skips polling when the window is not visible to save resources.
/// On Windows, uses CWD deduplication and throttling to reduce git.exe spawns.
pub struct GitTracker {
    terminal_states: Arc<RwLock<HashMap<String, GitState>>>,
    app_handle: Option<AppHandle>,
    cwd_tracker: Option<Arc<CwdTracker>>,
    events: TerminalEventHub,
    poll_handle: Arc<RwLock<Option<tokio::task::JoinHandle<()>>>>,
    is_polling_started: Arc<AtomicBool>,
    is_visible: Arc<AtomicBool>,
    #[cfg(target_os = "windows")]
    cwd_poll_states: Arc<RwLock<HashMap<String, CwdPollState>>>,
}

impl GitTracker {
    /// Create a new GitTracker with the given app handle
    pub fn new(app_handle: Option<AppHandle>, events: TerminalEventHub) -> Self {
        Self {
            terminal_states: Arc::new(RwLock::new(HashMap::new())),
            app_handle,
            cwd_tracker: None,
            events,
            poll_handle: Arc::new(RwLock::new(None)),
            is_polling_started: Arc::new(AtomicBool::new(false)),
            is_visible: Arc::new(AtomicBool::new(true)),
            #[cfg(target_os = "windows")]
            cwd_poll_states: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Create a GitTracker with a direct CwdTracker reference (standalone mode).
    /// This avoids the Tauri AppHandle dependency for CWD synchronization.
    pub fn with_cwd_tracker(cwd_tracker: Arc<CwdTracker>, events: TerminalEventHub) -> Self {
        let mut tracker = Self::new(None, events);
        tracker.cwd_tracker = Some(cwd_tracker);
        tracker
    }

    /// Initialize tracking for a terminal with the given working directory
    pub fn initialize_terminal(&self, terminal_id: &str, cwd: &str) {
        let state = GitState {
            _terminal_id: terminal_id.to_string(),
            last_known_branch: None,
            last_known_cwd: cwd.to_string(),
            last_known_status: None,
        };

        self.terminal_states
            .write()
            .insert(terminal_id.to_string(), state);

        let events = self.events.clone();
        let states = self.terminal_states.clone();
        let terminal_id_owned = terminal_id.to_string();
        let cwd_owned = cwd.to_string();

        tokio::spawn(async move {
            let (status, branch) = Self::poll_git_snapshot(cwd_owned.clone()).await;
            let terminal_ids = vec![terminal_id_owned.clone()];
            let (branch_emits, status_emits) =
                Self::apply_git_results(&states, &terminal_ids, branch, status);

            for (_, branch) in branch_emits {
                Self::emit_branch_changed_static(&events, &terminal_id_owned, &branch);
            }

            for (_, status) in status_emits {
                Self::emit_status_changed_static(&events, &terminal_id_owned, &status);
            }
        });

        // Start polling if not already running
        if self
            .is_polling_started
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::Relaxed)
            .is_ok()
        {
            self.start_polling();
        }
    }

    /// Remove a terminal from tracking
    pub fn remove_terminal(&self, terminal_id: &str) {
        // On Windows, clean up CWD poll state if no other terminals use this CWD
        #[cfg(target_os = "windows")]
        {
            let cwd_to_remove = self
                .terminal_states
                .read()
                .get(terminal_id)
                .map(|s| s.last_known_cwd.clone());

            if let Some(cwd) = cwd_to_remove {
                self.terminal_states.write().remove(terminal_id);

                // Check if any other terminal uses this CWD
                let cwd_still_in_use = self
                    .terminal_states
                    .read()
                    .values()
                    .any(|s| s.last_known_cwd == cwd);

                if !cwd_still_in_use {
                    self.cwd_poll_states.write().remove(&cwd);
                }
            } else {
                self.terminal_states.write().remove(terminal_id);
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            self.terminal_states.write().remove(terminal_id);
        }

        // If no terminals left, we could stop polling but keep it running
        // for simplicity - it will just skip when empty
    }

    /// Update a terminal's tracked CWD from the transport-neutral CWD tracker.
    pub fn update_terminal_cwd(&self, terminal_id: &str, cwd: String) {
        if let Some(state) = self.terminal_states.write().get_mut(terminal_id) {
            state.update_terminal_cwd(cwd);
        }
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
        let was_visible = self.is_visible.swap(visible, Ordering::SeqCst);
        if !was_visible && visible {
            self.refresh_tracked_terminals();
        }
    }

    fn refresh_tracked_terminals(&self) {
        // Transport-neutral: use the direct CwdTracker reference if available,
        // otherwise fall back to the Tauri AppHandle state lookup.
        if let Some(cwd_tracker) = &self.cwd_tracker {
            Self::sync_terminal_cwds_from_tracker_direct(cwd_tracker, &self.terminal_states);
        } else if let Some(app_handle) = &self.app_handle {
            Self::sync_terminal_cwds_from_tracker(app_handle, &self.terminal_states);
        }

        #[cfg(target_os = "windows")]
        Self::prune_unused_cwd_poll_states(&self.terminal_states, &self.cwd_poll_states);

        #[cfg(target_os = "windows")]
        {
            let cwd_states: HashMap<String, Vec<String>> = {
                let states_read = self.terminal_states.read();
                let mut map: HashMap<String, Vec<String>> = HashMap::new();
                for (id, state) in states_read.iter() {
                    map.entry(state.last_known_cwd.clone())
                        .or_default()
                        .push(id.clone());
                }
                map
            };

            let now = Instant::now();
            for (cwd, terminal_ids) in cwd_states {
                let new_status = Self::check_status_internal(&cwd);
                let new_branch = Self::check_branch_internal(&cwd);

                {
                    let mut cwd_poll_states = self.cwd_poll_states.write();
                    let poll_state = cwd_poll_states.entry(cwd).or_default();
                    poll_state.last_checked = now;
                    poll_state.last_branch = new_branch.clone();
                    poll_state.last_status = new_status.clone();
                    poll_state.last_snapshot_unchanged = false;
                }

                let (branch_emits, status_emits) = Self::apply_git_results(
                    &self.terminal_states,
                    &terminal_ids,
                    new_branch,
                    new_status,
                );

                for (terminal_id, branch) in branch_emits {
                    Self::emit_branch_changed_static(&self.events, &terminal_id, &branch);
                }

                for (terminal_id, status) in status_emits {
                    Self::emit_status_changed_static(&self.events, &terminal_id, &status);
                }
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            let terminals: Vec<(String, String)> = self
                .terminal_states
                .read()
                .iter()
                .map(|(id, state)| (id.clone(), state.last_known_cwd.clone()))
                .collect();

            for (terminal_id, cwd) in terminals {
                let new_status = Self::check_status_internal(&cwd);
                let new_branch = Self::check_branch_internal(&cwd);
                let terminal_ids = vec![terminal_id.clone()];
                let (branch_emits, status_emits) = Self::apply_git_results(
                    &self.terminal_states,
                    &terminal_ids,
                    new_branch,
                    new_status,
                );

                for (_, branch) in branch_emits {
                    Self::emit_branch_changed_static(&self.events, &terminal_id, &branch);
                }

                for (_, status) in status_emits {
                    Self::emit_status_changed_static(&self.events, &terminal_id, &status);
                }
            }
        }
    }

    fn sync_terminal_cwds_from_tracker(
        app_handle: &AppHandle,
        states: &Arc<RwLock<HashMap<String, GitState>>>,
    ) {
        let Some(cwd_tracker) = app_handle.try_state::<Arc<CwdTracker>>() else {
            return;
        };

        let terminal_ids: Vec<String> = states.read().keys().cloned().collect();
        let updates: Vec<(String, String)> = terminal_ids
            .into_iter()
            .filter_map(|terminal_id| {
                cwd_tracker
                    .get_cwd(&terminal_id)
                    .map(|cwd| (terminal_id, cwd))
            })
            .collect();

        if updates.is_empty() {
            return;
        }

        let mut states_guard = states.write();
        for (terminal_id, new_cwd) in updates {
            if let Some(state) = states_guard.get_mut(&terminal_id) {
                state.update_terminal_cwd(new_cwd);
            }
        }
    }

    /// Transport-neutral CWD sync: uses a direct Arc<CwdTracker> reference
    /// instead of the Tauri AppHandle state lookup. Used in standalone mode.
    fn sync_terminal_cwds_from_tracker_direct(
        cwd_tracker: &Arc<CwdTracker>,
        states: &Arc<RwLock<HashMap<String, GitState>>>,
    ) {
        let terminal_ids: Vec<String> = states.read().keys().cloned().collect();
        let updates: Vec<(String, String)> = terminal_ids
            .into_iter()
            .filter_map(|terminal_id| {
                cwd_tracker
                    .get_cwd(&terminal_id)
                    .map(|cwd| (terminal_id, cwd))
            })
            .collect();

        if updates.is_empty() {
            return;
        }

        let mut states_guard = states.write();
        for (terminal_id, new_cwd) in updates {
            if let Some(state) = states_guard.get_mut(&terminal_id) {
                state.update_terminal_cwd(new_cwd);
            }
        }
    }

    #[cfg(target_os = "windows")]
    fn prune_unused_cwd_poll_states(
        states: &Arc<RwLock<HashMap<String, GitState>>>,
        cwd_poll_states: &Arc<RwLock<HashMap<String, CwdPollState>>>,
    ) {
        let active_cwds: std::collections::HashSet<String> = states
            .read()
            .values()
            .map(|state| state.last_known_cwd.clone())
            .collect();

        cwd_poll_states
            .write()
            .retain(|cwd, _| active_cwds.contains(cwd));
    }

    fn apply_git_results(
        states: &Arc<RwLock<HashMap<String, GitState>>>,
        terminal_ids: &[String],
        branch: Option<String>,
        status: Option<GitStatus>,
    ) -> GitResultEmits {
        let mut branch_emits = Vec::new();
        let mut status_emits = Vec::new();
        let mut states_guard = states.write();

        for terminal_id in terminal_ids {
            if let Some(state) = states_guard.get_mut(terminal_id) {
                if state.last_known_branch.as_ref() != branch.as_ref() {
                    state.last_known_branch = branch.clone();
                    branch_emits.push((terminal_id.clone(), branch.clone()));
                }

                if state.last_known_status.as_ref() != status.as_ref() {
                    state.last_known_status = status.clone();
                    status_emits.push((terminal_id.clone(), status.clone()));
                }
            }
        }

        (branch_emits, status_emits)
    }

    async fn poll_git_snapshot(cwd: String) -> (Option<GitStatus>, Option<String>) {
        tokio::time::timeout(
            Duration::from_millis(GIT_COMMAND_TIMEOUT_MS),
            tokio::task::spawn_blocking(move || {
                (
                    Self::check_status_internal(&cwd),
                    Self::check_branch_internal(&cwd),
                )
            }),
        )
        .await
        .ok()
        .and_then(|result| result.ok())
        .unwrap_or((None, None))
    }

    pub fn run_git_command(cwd: &str, args: &[&str]) -> Option<std::process::Output> {
        Self::run_git_command_with_timeout(cwd, args, GIT_COMMAND_TIMEOUT_MS)
    }

    /// Run a git command with an explicit timeout (ms). Network-bound commands
    /// such as `git push` must use a generous timeout instead of the short
    /// status-poll default, which would otherwise kill the process mid-transfer.
    /// Generic over `AsRef<OsStr>` so callers can pass non-UTF-8 paths (e.g. a
    /// commit message file path) without a lossy conversion.
    pub fn run_git_command_with_timeout<S: AsRef<std::ffi::OsStr>>(
        cwd: &str,
        args: &[S],
        timeout_ms: u64,
    ) -> Option<std::process::Output> {
        let mut command = backend_command(resolve_git_binary());
        command
            .args(args.iter().map(|a| a.as_ref()))
            .current_dir(cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        Self::spawn_and_wait(command, args, cwd, timeout_ms)
    }

    /// Run `git push <args>` with the network timeout and `GIT_TERMINAL_PROMPT=0`
    /// so a remote that requires credentials fails fast ("could not read
    /// Username") instead of blocking on a terminal prompt until the timeout.
    pub fn run_git_push(cwd: &str, args: &[&str], timeout_ms: u64) -> Option<std::process::Output> {
        let mut command = backend_command(resolve_git_binary());
        command
            .args(args)
            .current_dir(cwd)
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        Self::spawn_and_wait(command, args, cwd, timeout_ms)
    }

    /// Spawn a prepared git `Command` and wait up to `timeout_ms`, killing the
    /// child on timeout. `args`/`cwd` are used only for the timeout log line.
    fn spawn_and_wait<S: AsRef<std::ffi::OsStr>>(
        mut command: Command,
        args: &[S],
        cwd: &str,
        timeout_ms: u64,
    ) -> Option<std::process::Output> {
        let mut child = command.spawn().ok()?;

        let deadline = Instant::now() + Duration::from_millis(timeout_ms);

        loop {
            match child.try_wait() {
                Ok(Some(_)) => return child.wait_with_output().ok(),
                Ok(None) => {
                    if Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        let rendered: Vec<String> = args
                            .iter()
                            .map(|a| a.as_ref().to_string_lossy().into_owned())
                            .collect();
                        log::warn!(
                            "[GitTracker] Timed out running git {} in {}",
                            rendered.join(" "),
                            cwd
                        );
                        return None;
                    }

                    std::thread::sleep(Duration::from_millis(25));
                }
                Err(_) => return None,
            }
        }
    }

    pub fn shutdown(&self) {
        // Abort the polling task if running
        let mut poll_handle_guard = self.poll_handle.write();
        if let Some(handle) = poll_handle_guard.take() {
            handle.abort();
        }
        // Reset the flag so polling can be restarted
        self.is_polling_started.store(false, Ordering::SeqCst);
        self.terminal_states.write().clear();
        #[cfg(target_os = "windows")]
        self.cwd_poll_states.write().clear();
    }
}

#[cfg(test)]
mod tests;
