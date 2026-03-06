use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

use super::cwd_tracker::CwdTracker;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Build a backend helper command.
/// On Windows this suppresses stray console windows from helper binaries like git.exe.
#[cfg(target_os = "windows")]
fn backend_command(program: &str) -> Command {
    let mut command = Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(not(target_os = "windows"))]
fn backend_command(program: &str) -> Command {
    Command::new(program)
}

#[cfg(target_os = "windows")]
fn resolve_command_candidates_from_path(command: &str) -> Vec<String> {
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};

    let mut results = Vec::new();

    if command.contains('\\') || command.contains('/') {
        let candidate = Path::new(command);
        if candidate.exists() {
            results.push(command.to_string());
        }
        return results;
    }

    let Some(path_var) = std::env::var_os("PATH") else {
        return results;
    };

    let pathext_var =
        std::env::var_os("PATHEXT").unwrap_or_else(|| OsString::from(".COM;.EXE;.BAT;.CMD"));

    let command_path = Path::new(command);
    let has_extension = command_path.extension().is_some();

    let mut extensions: Vec<OsString> = Vec::new();
    if has_extension {
        extensions.push(OsString::new());
    } else {
        extensions.push(OsString::new());
        for ext in pathext_var
            .to_string_lossy()
            .split(';')
            .filter(|s| !s.trim().is_empty())
        {
            extensions.push(OsString::from(ext.trim()));
        }
    }

    for dir in std::env::split_paths(&path_var) {
        for ext in &extensions {
            let candidate: PathBuf = if ext.is_empty() {
                dir.join(command)
            } else {
                dir.join(format!("{}{}", command, ext.to_string_lossy()))
            };

            if candidate.exists() {
                let candidate_str = candidate.to_string_lossy().to_string();
                if !results
                    .iter()
                    .any(|r| r.eq_ignore_ascii_case(&candidate_str))
                {
                    results.push(candidate_str);
                }
            }
        }
    }

    results
}

/// Cache for the resolved git binary path (avoiding Laragon PATH pollution)
static GIT_BINARY: OnceLock<String> = OnceLock::new();

/// Resolve the git binary path, filtering out Laragon's git installation.
///
/// On Windows, resolves candidates directly from PATH/PATHEXT without spawning `where`.
/// On Unix, runs `which -a git`.
/// Skips any path that contains "laragon" (case-insensitive).
/// Falls back to plain `"git"` if no suitable path is found.
fn resolve_git_binary() -> &'static str {
    GIT_BINARY.get_or_init(|| {
        #[cfg(target_os = "windows")]
        {
            let candidates = resolve_command_candidates_from_path("git");
            for path in candidates {
                if path.to_lowercase().contains("laragon") {
                    log::debug!("[GitTracker] Skipping Laragon git: {}", path);
                    continue;
                }
                log::debug!("[GitTracker] Using git binary: {}", path);
                return path;
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            let which_cmd = backend_command("which").args(["-a", "git"]).output();

            if let Ok(output) = which_cmd {
                if output.status.success() {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    for line in stdout.lines() {
                        let path = line.trim();
                        if path.is_empty() {
                            continue;
                        }
                        if path.to_lowercase().contains("laragon") {
                            log::debug!("[GitTracker] Skipping Laragon git: {}", path);
                            continue;
                        }
                        log::debug!("[GitTracker] Using git binary: {}", path);
                        return path.to_string();
                    }
                }
            }
        }

        // Fallback to plain "git" if nothing better found
        log::warn!("[GitTracker] Could not resolve non-Laragon git binary, using plain 'git'");
        "git".to_string()
    })
}

const POLL_INTERVAL_MS: u64 = 6000;

/// Windows-specific polling multiplier for longer intervals between checks
#[cfg(target_os = "windows")]
const WINDOWS_POLL_MULTIPLIER: u32 = 2;

/// Cooldown duration when status hasn't changed (Windows only)
#[cfg(target_os = "windows")]
const STATUS_UNCHANGED_COOLDOWN_MS: u64 = POLL_INTERVAL_MS * 3;

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

/// Windows-only state for tracking when a CWD was last polled
#[derive(Debug, Clone)]
struct CwdPollState {
    last_checked: Instant,
    last_status: Option<GitStatus>,
}

impl CwdPollState {
    fn new() -> Self {
        Self {
            last_checked: Instant::now() - Duration::from_secs(60), // Initially allow immediate poll
            last_status: None,
        }
    }
}

impl Default for CwdPollState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone)]
struct WindowsPollTarget {
    cwd: String,
    terminal_ids: Vec<String>,
}

/// Guard that resets is_polling flag when dropped (RAII pattern)
struct PollingGuard {
    is_polling: Arc<AtomicBool>,
}

impl PollingGuard {
    fn new(is_polling: Arc<AtomicBool>) -> Option<Self> {
        // Try to acquire the lock - return None if already polling
        if !is_polling.swap(true, Ordering::SeqCst) {
            Some(Self { is_polling })
        } else {
            None
        }
    }
}

impl Drop for PollingGuard {
    fn drop(&mut self) {
        self.is_polling.store(false, Ordering::SeqCst);
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

impl GitState {
    fn update_terminal_cwd(&mut self, new_cwd: String) -> bool {
        if self.last_known_cwd == new_cwd {
            return false;
        }

        self.last_known_cwd = new_cwd;
        true
    }
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
/// On Windows, uses CWD deduplication and throttling to reduce git.exe spawns.
pub struct GitTracker {
    terminal_states: Arc<RwLock<HashMap<String, GitState>>>,
    app_handle: AppHandle,
    poll_handle: Arc<RwLock<Option<tokio::task::JoinHandle<()>>>>,
    is_polling_started: Arc<AtomicBool>,
    is_visible: Arc<AtomicBool>,
    #[cfg(target_os = "windows")]
    cwd_poll_states: Arc<RwLock<HashMap<String, CwdPollState>>>,
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
            #[cfg(target_os = "windows")]
            cwd_poll_states: Arc::new(RwLock::new(HashMap::new())),
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

        self.terminal_states
            .write()
            .insert(terminal_id.to_string(), state);

        // Emit initial events
        self.emit_branch_changed(terminal_id, &branch);
        self.emit_status_changed(terminal_id, &status);

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
        Self::sync_terminal_cwds_from_tracker(&self.app_handle, &self.terminal_states);

        #[cfg(target_os = "windows")]
        Self::prune_unused_cwd_poll_states(&self.terminal_states, &self.cwd_poll_states);

        #[cfg(target_os = "windows")]
        {
            let cwd_states: HashMap<String, Vec<String>> = {
                let states_read = self.terminal_states.read();
                let mut map = HashMap::new();
                for (id, state) in states_read.iter() {
                    map.entry(state.last_known_cwd.clone())
                        .or_insert_with(Vec::new)
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
                    let poll_state = cwd_poll_states.entry(cwd).or_insert_with(CwdPollState::new);
                    poll_state.last_checked = now;
                    poll_state.last_status = new_status.clone();
                }

                let (branch_emits, status_emits) = Self::apply_git_results(
                    &self.terminal_states,
                    &terminal_ids,
                    new_branch,
                    new_status,
                );

                for (terminal_id, branch) in branch_emits {
                    Self::emit_branch_changed_static(&self.app_handle, &terminal_id, &branch);
                }

                for (terminal_id, status) in status_emits {
                    Self::emit_status_changed_static(&self.app_handle, &terminal_id, &status);
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
                let (branch_emits, status_emits) =
                    Self::apply_git_results(&self.terminal_states, &terminal_ids, new_branch, new_status);

                for (_, branch) in branch_emits {
                    Self::emit_branch_changed_static(&self.app_handle, &terminal_id, &branch);
                }

                for (_, status) in status_emits {
                    Self::emit_status_changed_static(&self.app_handle, &terminal_id, &status);
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
            .filter_map(|terminal_id| cwd_tracker.get_cwd(&terminal_id).map(|cwd| (terminal_id, cwd)))
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
    ) -> (
        Vec<(String, Option<String>)>,
        Vec<(String, Option<GitStatus>)>,
    ) {
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
        tokio::task::spawn_blocking(move || {
            (
                Self::check_status_internal(&cwd),
                Self::check_branch_internal(&cwd),
            )
        })
        .await
        .unwrap_or((None, None))
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
        #[cfg(target_os = "windows")]
        self.cwd_poll_states.write().clear();
    }

    /// Start the polling task
    ///
    /// Windows optimizations:
    /// - Uses CWD deduplication: polls once per unique CWD, fans out results
    /// - Implements cooldown when status hasn't changed
    /// - Uses RAII guard to ensure is_polling flag is always reset
    fn start_polling(&self) {
        let states = self.terminal_states.clone();
        let is_visible = self.is_visible.clone();
        #[cfg(target_os = "windows")]
        let cwd_poll_states = self.cwd_poll_states.clone();
        let app_handle = self.app_handle.clone();
        let poll_handle = self.poll_handle.clone();

        let handle = tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(POLL_INTERVAL_MS));

            // Create is_polling flag for guard mechanism
            let is_polling = Arc::new(AtomicBool::new(false));

            #[cfg(target_os = "windows")]
            let mut tick_count = 0u32;

            loop {
                interval.tick().await;

                #[cfg(target_os = "windows")]
                {
                    tick_count += 1;
                    log::trace!(
                        "[GitTracker] Tick: {}, visible: {}",
                        tick_count,
                        is_visible.load(Ordering::SeqCst)
                    );
                }

                // Skip when not visible
                if !is_visible.load(Ordering::SeqCst) {
                    log::debug!("[GitTracker] Skipping poll - window not visible");
                    continue;
                }

                #[cfg(target_os = "windows")]
                {
                    // On Windows, only poll every Nth tick (throttling)
                    if tick_count % WINDOWS_POLL_MULTIPLIER != 0 {
                        log::trace!(
                            "[GitTracker] Skipping poll - throttling (tick {})",
                            tick_count
                        );
                        continue;
                    }
                    log::debug!("[GitTracker] Polling tick: {}", tick_count);
                }

                // Use RAII guard - automatically resets is_polling when dropped
                let guard_opt = PollingGuard::new(is_polling.clone());
                let _guard = match guard_opt {
                    Some(g) => g,
                    None => continue, // Already polling
                };

                Self::sync_terminal_cwds_from_tracker(&app_handle, &states);
                #[cfg(target_os = "windows")]
                Self::prune_unused_cwd_poll_states(&states, &cwd_poll_states);

                #[cfg(target_os = "windows")]
                {
                    // Windows: CWD deduplication strategy
                    // Group terminals by CWD, poll once per unique CWD, then fan out results
                    let cwd_states: HashMap<String, Vec<String>> = {
                        let states_read = states.read();
                        let mut map = HashMap::new();
                        for (id, state) in states_read.iter() {
                            map.entry(state.last_known_cwd.clone())
                                .or_insert_with(Vec::new)
                                .push(id.clone());
                        }
                        map
                    };

                    let now = Instant::now();
                    let poll_targets: Vec<WindowsPollTarget> = {
                        let mut cwd_poll_states_write = cwd_poll_states.write();
                        let mut targets = Vec::new();

                        for (cwd, terminal_ids) in cwd_states {
                            let poll_state = cwd_poll_states_write
                                .entry(cwd.clone())
                                .or_insert_with(CwdPollState::new);

                            let cooldown_ms = if poll_state.last_status.is_some() {
                                STATUS_UNCHANGED_COOLDOWN_MS
                            } else {
                                POLL_INTERVAL_MS
                            };

                            let elapsed = now.duration_since(poll_state.last_checked);
                            if elapsed < Duration::from_millis(cooldown_ms) {
                                log::trace!(
                                    "[GitTracker] CWD '{}' on cooldown: {:?} remaining",
                                    cwd,
                                    Duration::from_millis(cooldown_ms) - elapsed
                                );
                                continue;
                            }

                            log::debug!(
                                "[GitTracker] Polling CWD: {} ({} terminals)",
                                cwd,
                                terminal_ids.len()
                            );
                            poll_state.last_checked = now;
                            targets.push(WindowsPollTarget { cwd, terminal_ids });
                        }

                        targets
                    };

                    for target in poll_targets {
                        let (new_status, new_branch) =
                            Self::poll_git_snapshot(target.cwd.clone()).await;

                        {
                            let mut cwd_poll_states_write = cwd_poll_states.write();
                            if let Some(poll_state) = cwd_poll_states_write.get_mut(&target.cwd) {
                                poll_state.last_status = new_status.clone();
                            }
                        }

                        let (branch_emits, status_emits) = Self::apply_git_results(
                            &states,
                            &target.terminal_ids,
                            new_branch,
                            new_status,
                        );

                        for (terminal_id, branch) in branch_emits {
                            Self::emit_branch_changed_static(&app_handle, &terminal_id, &branch);
                        }

                        for (terminal_id, status) in status_emits {
                            Self::emit_status_changed_static(&app_handle, &terminal_id, &status);
                        }
                    }
                }

                #[cfg(not(target_os = "windows"))]
                {
                    let terminals: Vec<(String, String)> = states
                        .read()
                        .iter()
                        .map(|(id, state)| (id.clone(), state.last_known_cwd.clone()))
                        .collect();

                    for (terminal_id, cwd) in terminals {
                        let (new_status, new_branch) = Self::poll_git_snapshot(cwd).await;
                        let terminal_ids = vec![terminal_id.clone()];
                        let (branch_emits, status_emits) =
                            Self::apply_git_results(&states, &terminal_ids, new_branch, new_status);

                        for (_, branch) in branch_emits {
                            Self::emit_branch_changed_static(&app_handle, &terminal_id, &branch);
                        }

                        for (_, status) in status_emits {
                            Self::emit_status_changed_static(&app_handle, &terminal_id, &status);
                        }
                    }
                }
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
        let output = backend_command(resolve_git_binary())
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
        log::debug!("[GitTracker] Polling git status for cwd: {}", cwd);
        let output = backend_command(resolve_git_binary())
            .args(["status", "--porcelain"])
            .current_dir(cwd)
            .output()
            .ok()?;

        if !output.status.success() {
            return None;
        }

        Some(Self::parse_git_status(&String::from_utf8_lossy(
            &output.stdout,
        )))
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

    /// Static version of emit_branch_changed for use in async context
    fn emit_branch_changed_static(
        app_handle: &AppHandle,
        terminal_id: &str,
        branch: &Option<String>,
    ) {
        let event = GitBranchChangedEvent {
            terminal_id: terminal_id.to_string(),
            branch: branch.clone(),
        };
        let _ = app_handle.emit("terminal-git-branch-changed", event);
    }

    /// Static version of emit_status_changed for use in async context
    fn emit_status_changed_static(
        app_handle: &AppHandle,
        terminal_id: &str,
        status: &Option<GitStatus>,
    ) {
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
        let status =
            GitTracker::parse_git_status("M  staged.txt\nA  added.txt\nD  deleted-staged.txt\n");
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
        assert_eq!(status.staged, 1); // Index has M
        assert!(status.has_changes);
    }

    #[test]
    fn test_parse_git_status_mixed() {
        let output = "?? untracked.txt\n M modified.txt\nM  staged.txt\nMM both.txt\n";
        let status = GitTracker::parse_git_status(output);
        assert_eq!(status.untracked, 1);
        assert_eq!(status.modified, 2); // modified.txt + both.txt (work tree)
        assert_eq!(status.staged, 2); // staged.txt + both.txt (index)
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
    fn test_git_state_update_terminal_cwd_changes_value() {
        let mut state = GitState {
            _terminal_id: "term-1".to_string(),
            last_known_branch: Some("main".to_string()),
            last_known_cwd: "/tmp".to_string(),
            last_known_status: Some(GitStatus::new()),
        };

        assert!(state.update_terminal_cwd("/tmp/repo".to_string()));
        assert_eq!(state.last_known_cwd, "/tmp/repo");
    }

    #[test]
    fn test_git_state_update_terminal_cwd_no_change() {
        let mut state = GitState {
            _terminal_id: "term-1".to_string(),
            last_known_branch: Some("main".to_string()),
            last_known_cwd: "/tmp".to_string(),
            last_known_status: Some(GitStatus::new()),
        };

        assert!(!state.update_terminal_cwd("/tmp".to_string()));
        assert_eq!(state.last_known_cwd, "/tmp");
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
    fn test_parse_git_status_rename_with_similarity() {
        let status = GitTracker::parse_git_status("R100 old.txt -> new.txt\n");
        assert_eq!(status.untracked, 0);
        assert_eq!(status.modified, 0);
        assert_eq!(status.staged, 1);
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

    // ========== Windows-specific tests for CWD dedupe and throttling ==========

    #[cfg(target_os = "windows")]
    #[test]
    fn test_cwd_poll_state_new() {
        let state = CwdPollState::new();
        assert!(state.last_status.is_none());
        // New state should allow immediate poll (checked in past)
        let now = Instant::now();
        assert!(now.duration_since(state.last_checked) < Duration::from_secs(61));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_cwd_poll_state_default() {
        let state = CwdPollState::default();
        assert!(state.last_status.is_none());
    }

    #[test]
    fn test_polling_guard_acquires_when_free() {
        let flag = Arc::new(AtomicBool::new(false));
        let guard = PollingGuard::new(flag.clone());
        assert!(guard.is_some());
        assert!(flag.load(Ordering::SeqCst)); // Flag should be set
    }

    #[test]
    fn test_polling_guard_fails_when_locked() {
        let flag = Arc::new(AtomicBool::new(true));
        let guard = PollingGuard::new(flag.clone());
        assert!(guard.is_none());
        assert!(flag.load(Ordering::SeqCst)); // Flag should still be set
    }

    #[test]
    fn test_polling_guard_resets_on_drop() {
        let flag = Arc::new(AtomicBool::new(false));
        {
            let _guard = PollingGuard::new(flag.clone()).unwrap();
            assert!(flag.load(Ordering::SeqCst));
        }
        // After drop, flag should be reset
        assert!(!flag.load(Ordering::SeqCst));
    }

    #[test]
    fn test_polling_guard_reset_after_early_return() {
        let flag = Arc::new(AtomicBool::new(false));
        let _result = (|| -> Option<()> {
            let _guard = PollingGuard::new(flag.clone())?;
            // Simulate early return
            None::<()>.or(Some(()))
        })();
        // Even with early return pattern, guard should clean up
        assert!(!flag.load(Ordering::SeqCst));
    }

    // Test deduplication helper: grouping terminals by CWD
    #[test]
    fn test_cwd_grouping_logic() {
        use std::collections::HashMap;
        let mut terminals: HashMap<String, String> = HashMap::new();
        terminals.insert("term-1".to_string(), "/home/user/repo".to_string());
        terminals.insert("term-2".to_string(), "/home/user/repo".to_string());
        terminals.insert("term-3".to_string(), "/home/user/other".to_string());

        let mut cwd_groups: HashMap<String, Vec<String>> = HashMap::new();
        for (id, cwd) in terminals.iter() {
            cwd_groups.entry(cwd.clone()).or_default().push(id.clone());
        }

        assert_eq!(cwd_groups.len(), 2);
        assert_eq!(cwd_groups.get("/home/user/repo").unwrap().len(), 2);
        assert_eq!(cwd_groups.get("/home/user/other").unwrap().len(), 1);
    }

    // Test throttling decision logic
    #[cfg(target_os = "windows")]
    #[test]
    fn test_throttling_cooldown_with_status() {
        let mut state = CwdPollState::new();
        state.last_status = Some(GitStatus::new());
        state.last_checked = Instant::now();

        // Should be in cooldown immediately after poll with status
        assert!(
            Instant::now().duration_since(state.last_checked)
                < Duration::from_millis(STATUS_UNCHANGED_COOLDOWN_MS)
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_throttling_cooldown_without_status() {
        let mut state = CwdPollState::new();
        state.last_status = None; // No git repo or initial state
        state.last_checked = Instant::now();

        // Shorter cooldown when no status
        assert!(
            Instant::now().duration_since(state.last_checked)
                < Duration::from_millis(POLL_INTERVAL_MS)
        );
    }
}
