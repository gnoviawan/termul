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
pub fn resolve_git_binary() -> &'static str {
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
const GIT_COMMAND_TIMEOUT_MS: u64 = 2000;

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
    pub ahead: u32,
    pub behind: u32,
    pub has_changes: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusDetail {
    pub path: String,
    pub status: String,
    pub staged: bool,
}

impl GitStatus {
    /// Create a new GitStatus with all zeros
    pub fn new() -> Self {
        Self {
            modified: 0,
            staged: 0,
            untracked: 0,
            ahead: 0,
            behind: 0,
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
        let state = GitState {
            _terminal_id: terminal_id.to_string(),
            last_known_branch: None,
            last_known_cwd: cwd.to_string(),
            last_known_status: None,
        };

        self.terminal_states
            .write()
            .insert(terminal_id.to_string(), state);

        let app_handle = self.app_handle.clone();
        let states = self.terminal_states.clone();
        let terminal_id_owned = terminal_id.to_string();
        let cwd_owned = cwd.to_string();

        tokio::spawn(async move {
            let (status, branch) = Self::poll_git_snapshot(cwd_owned.clone()).await;
            let terminal_ids = vec![terminal_id_owned.clone()];
            let (branch_emits, status_emits) =
                Self::apply_git_results(&states, &terminal_ids, branch, status);

            for (_, branch) in branch_emits {
                Self::emit_branch_changed_static(&app_handle, &terminal_id_owned, &branch);
            }

            for (_, status) in status_emits {
                Self::emit_status_changed_static(&app_handle, &terminal_id_owned, &status);
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
                let (branch_emits, status_emits) = Self::apply_git_results(
                    &self.terminal_states,
                    &terminal_ids,
                    new_branch,
                    new_status,
                );

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

pub fn git_get_status_detail(cwd: &str) -> Result<Vec<GitStatusDetail>, String> {
    let output = GitTracker::run_git_command(cwd, &["status", "--porcelain"])
        .ok_or_else(|| "Failed to run git status".to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(git_get_status_detail_from_output(&stdout))
}

fn git_get_status_detail_from_output(output: &str) -> Vec<GitStatusDetail> {
    let mut details = Vec::new();

    for line in output.lines() {
        if line.len() < 4 {
            continue;
        }

        let index_status = line.chars().next().unwrap_or(' ');
        let work_tree_status = line.chars().nth(1).unwrap_or(' ');
        let raw_path = &line[3..];
        let path = if index_status == 'R' || work_tree_status == 'R' {
            raw_path
                .rsplit_once(" -> ")
                .map(|(_, new_path)| new_path)
                .unwrap_or(raw_path)
                .to_string()
        } else {
            raw_path.to_string()
        };

        if index_status != ' ' && index_status != '?' {
            details.push(GitStatusDetail {
                path: path.clone(),
                status: match index_status {
                    'A' => "added",
                    'M' => "modified",
                    'D' => "deleted",
                    'R' => "renamed",
                    _ => "modified",
                }
                .to_string(),
                staged: true,
            });
        }

        if work_tree_status != ' ' {
            details.push(GitStatusDetail {
                path: path.clone(),
                status: match work_tree_status {
                    'M' => "modified",
                    'D' => "deleted",
                    '?' => "untracked",
                    _ => "modified",
                }
                .to_string(),
                staged: false,
            });
        }
    }

    details
}

/// Git treats `/dev/null` as a magic empty-file token on all platforms,
/// including Git for Windows, so it is safe to use for `diff --no-index`.
const NULL_DEVICE: &str = "/dev/null";

/// Select the `git diff` argument vector for a single path.
///
/// - Untracked files have nothing in the index, so they are shown in full as
///   additions via `--no-index`.
/// - Staged rows compare the index against HEAD (`--cached`).
/// - Unstaged rows compare the working tree against the index.
fn build_diff_args(path: &str, is_untracked: bool, staged: bool) -> Vec<&str> {
    if is_untracked {
        vec!["diff", "--no-index", "--", NULL_DEVICE, path]
    } else if staged {
        vec!["diff", "--cached", "--", path]
    } else {
        vec!["diff", "--", path]
    }
}

pub fn git_get_diff(cwd: &str, path: &str, staged: bool) -> Result<String, String> {
    if is_git_ignored(cwd, path)? {
        return Ok(String::new());
    }

    // First check if file is untracked (but not ignored)
    let status_output = GitTracker::run_git_command(cwd, &["status", "--porcelain", "--", path])
        .ok_or_else(|| "Failed to run git status".to_string())?;

    let status_str = String::from_utf8_lossy(&status_output.stdout);
    let is_untracked = status_str.starts_with("??");

    let args = build_diff_args(path, is_untracked, staged);

    let output = GitTracker::run_git_command(cwd, &args)
        .ok_or_else(|| "Failed to run git diff".to_string())?;

    // git diff returns 1 if there are differences, which is "success" for us
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();

    if stdout.is_empty() && is_untracked {
        // Fallback for untracked files if diff --no-index fails or returns empty
        return std::fs::read_to_string(std::path::Path::new(cwd).join(path))
            .map_err(|e| e.to_string());
    }

    Ok(stdout)
}

/// What discarding a path should do, derived from its `git status --porcelain` line.
#[derive(Debug, PartialEq, Eq)]
enum DiscardAction {
    /// Untracked entry: delete it from disk.
    DeleteUntracked,
    /// Tracked change: revert the working tree to the index (`git checkout -- <path>`).
    /// This never touches the index, so staged content is preserved.
    RevertWorktree,
    /// Nothing to discard (clean or unknown path).
    Noop,
}

/// Classify the discard action from a `git status --porcelain` line.
/// The first column is the index (staged) status; `??` marks untracked entries.
fn classify_discard_action(status_line: &str) -> DiscardAction {
    if status_line.trim().is_empty() {
        return DiscardAction::Noop;
    }
    if status_line.starts_with('?') {
        return DiscardAction::DeleteUntracked;
    }
    DiscardAction::RevertWorktree
}

/// Whether `path` is a safe repo-relative path (no absolute root, drive prefix,
/// or `..` traversal). Used to gate raw filesystem deletes against escaping `cwd`.
fn is_safe_relative_path(path: &str) -> bool {
    use std::path::Component;
    let p = std::path::Path::new(path);
    if p.is_absolute() {
        return false;
    }
    !p.components().any(|c| {
        matches!(
            c,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    })
}

fn git_command_result(
    cwd: &str,
    args: &[&str],
    failure_context: &str,
) -> Result<(), String> {
    let output = GitTracker::run_git_command(cwd, args)
        .ok_or_else(|| format!("Failed to run {failure_context}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Whether the repository has a resolvable HEAD (i.e. at least one commit).
fn repo_has_head(cwd: &str) -> bool {
    GitTracker::run_git_command(cwd, &["rev-parse", "--verify", "--quiet", "HEAD"])
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Stage a single file (`git add -- <path>`). Works for modified and untracked files.
pub fn git_stage_file(cwd: &str, path: &str) -> Result<(), String> {
    git_command_result(cwd, &["add", "--", path], "git add")
}

/// Unstage a single file.
///
/// When the repo has a HEAD, `git reset -q HEAD -- <path>` restores the index
/// entry to its committed version. `git reset` only touches the index (never
/// the working tree) and works on all Git versions, unlike `git restore`
/// (Git >= 2.23). With no commits yet there is no HEAD to reset to, so the
/// entry is removed from the index while the working-tree file is kept intact.
pub fn git_unstage_file(cwd: &str, path: &str) -> Result<(), String> {
    if repo_has_head(cwd) {
        git_command_result(cwd, &["reset", "-q", "HEAD", "--", path], "git reset")
    } else {
        git_command_result(cwd, &["rm", "--cached", "--", path], "git rm --cached")
    }
}

/// Delete an untracked file or directory from disk. Treats an already-missing
/// path as success (a concurrent delete still satisfies the intent).
fn delete_untracked_path(cwd: &str, path: &str) -> Result<(), String> {
    if !is_safe_relative_path(path) {
        return Err(format!("Refusing to delete unsafe path: {path}"));
    }
    let target = std::path::Path::new(cwd).join(path);
    let result = if target.is_dir() {
        std::fs::remove_dir_all(&target)
    } else {
        std::fs::remove_file(&target)
    };
    match result {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Discard changes to a single file. Untracked entries are deleted from disk;
/// tracked changes revert the working tree to the index (`git checkout -- <path>`),
/// which preserves any staged content. A clean/unknown path is a no-op.
pub fn git_discard_file(cwd: &str, path: &str) -> Result<(), String> {
    let status_output = GitTracker::run_git_command(cwd, &["status", "--porcelain", "--", path])
        .ok_or_else(|| "Failed to run git status".to_string())?;
    let status_str = String::from_utf8_lossy(&status_output.stdout);
    let status_line = status_str.lines().next().unwrap_or("");

    match classify_discard_action(status_line) {
        DiscardAction::DeleteUntracked => delete_untracked_path(cwd, path),
        DiscardAction::RevertWorktree => {
            git_command_result(cwd, &["checkout", "--", path], "git checkout")
        }
        DiscardAction::Noop => Ok(()),
    }
}

/// Network-bound git operations (push/fetch) get a generous timeout instead of
/// the 2s status-poll default. 120s comfortably covers most pushes.
const GIT_NETWORK_TIMEOUT_MS: u64 = 120_000;

/// Context the commit footer needs to render: current branch, whether an
/// upstream is configured, ahead/behind counts, how many entries are staged,
/// and the last commit's subject/body (used to prefill an amend).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitContext {
    /// Current branch name, or `None` in a detached HEAD / no-branch state.
    pub branch: Option<String>,
    /// Whether the current branch has a configured upstream.
    pub has_upstream: bool,
    /// Commits the local branch is ahead of its upstream.
    pub ahead: u32,
    /// Commits the local branch is behind its upstream.
    pub behind: u32,
    /// Number of staged index entries (`git diff --cached --name-only`).
    pub staged_count: u32,
    /// Whether the repo has at least one commit (HEAD resolves).
    pub has_head: bool,
    /// Last commit subject (first line), empty when no HEAD.
    pub last_subject: String,
    /// Last commit body (everything after the subject + blank line), empty when none.
    pub last_body: String,
}

/// Build the commit message body from a summary and optional description.
/// Format: `summary`, a blank line, then the trimmed description. The blank
/// line and body are omitted when the description is empty.
fn build_commit_message(summary: &str, description: &str) -> String {
    let summary = summary.trim();
    let description = description.trim();
    if description.is_empty() {
        summary.to_string()
    } else {
        format!("{summary}\n\n{description}")
    }
}

/// Number of staged entries via `git diff --cached --name-only`.
/// Returns `None` when the git invocation itself fails, so callers can
/// distinguish "genuinely nothing staged" (`Some(0)`) from "could not tell".
fn staged_entry_count(cwd: &str) -> Option<u32> {
    GitTracker::run_git_command(cwd, &["diff", "--cached", "--name-only"])
        .filter(|o| o.status.success())
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter(|l| !l.trim().is_empty())
                .count() as u32
        })
}

/// Create a commit from the currently-staged index.
///
/// The message is written to a temp file and passed via `git commit -F <file>`
/// so arbitrary user text is never interpolated into a shell or `-m` argument;
/// this also preserves multi-line bodies. The temp file is created with an
/// exclusive, uniquely-named handle (no symlink-following clobber, no collision
/// between near-simultaneous commits) and deleted after the commit attempt.
///
/// `amend` rewrites HEAD instead of creating a new commit. A plain commit with
/// nothing staged is rejected; an amend requires an existing HEAD. Uses the
/// network-length timeout so pre-commit hooks / GPG passphrase prompts are not
/// killed mid-run (which could leave a stale `.git/index.lock`).
pub fn git_commit_file(
    cwd: &str,
    summary: &str,
    description: &str,
    amend: bool,
) -> Result<(), String> {
    if summary.trim().is_empty() {
        return Err("Commit summary cannot be empty".to_string());
    }
    if amend {
        if !repo_has_head(cwd) {
            return Err("No commit to amend".to_string());
        }
    } else {
        match staged_entry_count(cwd) {
            Some(0) => return Err("Nothing staged to commit".to_string()),
            None => return Err("Failed to read the staged index".to_string()),
            Some(_) => {}
        }
    }

    let message = build_commit_message(summary, description);
    let msg_path = create_commit_message_file(message.as_bytes())?;

    // Pass the real OS path (not a lossy String) so a non-UTF-8 temp dir still
    // resolves to the file we actually wrote.
    use std::ffi::OsStr;
    let mut args: Vec<&OsStr> =
        vec![OsStr::new("commit"), OsStr::new("-F"), msg_path.as_os_str()];
    if amend {
        args.push(OsStr::new("--amend"));
    }

    let result = match GitTracker::run_git_command_with_timeout(cwd, &args, GIT_NETWORK_TIMEOUT_MS) {
        Some(output) if output.status.success() => Ok(()),
        Some(output) => Err(String::from_utf8_lossy(&output.stderr).trim().to_string()),
        None => Err("git commit timed out or failed to start".to_string()),
    };
    // Always clean up the temp message file, regardless of commit outcome.
    let _ = std::fs::remove_file(&msg_path);
    result
}

/// Write `bytes` to a freshly-created, uniquely-named temp file using an
/// exclusive create (`create_new`), which fails rather than following a symlink
/// or truncating an existing file (CWE-59/CWE-377). Returns the path on success.
fn create_commit_message_file(bytes: &[u8]) -> Result<std::path::PathBuf, String> {
    use std::io::Write;
    let pid = std::process::id();
    for attempt in 0..8u32 {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir()
            .join(format!("termul-commitmsg-{pid}-{nanos}-{attempt}.txt"));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true) // O_EXCL: fail if the path already exists
            .open(&path)
        {
            Ok(mut f) => {
                f.write_all(bytes).and_then(|_| f.flush()).map_err(|e| {
                    let _ = std::fs::remove_file(&path);
                    format!("Failed to write commit message: {e}")
                })?;
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Failed to create commit message file: {e}")),
        }
    }
    Err("Failed to create a unique commit message file".to_string())
}

/// Push the current branch to `origin`. When the branch has no upstream, it is
/// published with `--set-upstream origin <branch>`. Uses the network timeout.
/// Rejects in a detached-HEAD / no-branch state.
pub fn git_push_current(cwd: &str) -> Result<(), String> {
    let branch = GitTracker::check_branch_internal(cwd)
        .ok_or_else(|| "Not on a branch (detached HEAD); cannot push".to_string())?;

    let has_upstream = GitTracker::run_git_command(cwd, &["rev-parse", "--verify", "--quiet", "@{u}"])
        .map(|o| o.status.success())
        .unwrap_or(false);

    let args: Vec<&str> = if has_upstream {
        vec!["push"]
    } else {
        vec!["push", "--set-upstream", "origin", &branch]
    };

    let output = GitTracker::run_git_push(cwd, &args, GIT_NETWORK_TIMEOUT_MS)
        .ok_or_else(|| {
            "git push did not complete (it timed out, could not start, or the \
             remote required interactive credentials)"
                .to_string()
        })?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Gather the commit-footer context for a repo. Tolerant of no-HEAD and
/// no-upstream repos: missing values come back as zeros / empty / false.
pub fn git_get_commit_context(cwd: &str) -> Result<GitCommitContext, String> {
    let branch = GitTracker::check_branch_internal(cwd);
    let has_head = repo_has_head(cwd);

    let has_upstream = GitTracker::run_git_command(cwd, &["rev-parse", "--verify", "--quiet", "@{u}"])
        .map(|o| o.status.success())
        .unwrap_or(false);

    let (mut ahead, mut behind) = (0u32, 0u32);
    if has_upstream {
        if let Some(o) =
            GitTracker::run_git_command(cwd, &["rev-list", "--left-right", "--count", "HEAD...@{u}"])
        {
            if o.status.success() {
                let counts = String::from_utf8_lossy(&o.stdout);
                let parts: Vec<&str> = counts.split_whitespace().collect();
                if parts.len() == 2 {
                    ahead = parts[0].parse().unwrap_or(0);
                    behind = parts[1].parse().unwrap_or(0);
                }
            }
        }
    }

    let (last_subject, last_body) = if has_head {
        let subject = GitTracker::run_git_command(cwd, &["log", "-1", "--pretty=%s"])
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim_end().to_string())
            .unwrap_or_default();
        let body = GitTracker::run_git_command(cwd, &["log", "-1", "--pretty=%b"])
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim_end().to_string())
            .unwrap_or_default();
        (subject, body)
    } else {
        (String::new(), String::new())
    };

    Ok(GitCommitContext {
        branch,
        has_upstream,
        ahead,
        behind,
        staged_count: staged_entry_count(cwd).unwrap_or(0),
        has_head,
        last_subject,
        last_body,
    })
}


fn is_git_ignored(cwd: &str, path: &str) -> Result<bool, String> {
    let output = GitTracker::run_git_command(cwd, &["check-ignore", "--quiet", "--", path])
        .ok_or_else(|| "Failed to run git check-ignore".to_string())?;

    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(String::from_utf8_lossy(&output.stderr).trim().to_string()),
    }
}

impl GitTracker {

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
                        let mut map: HashMap<String, Vec<String>> = HashMap::new();
                        for (id, state) in states_read.iter() {
                            map.entry(state.last_known_cwd.clone())
                                .or_default()
                                .push(id.clone());
                        }
                        map
                    };

                    let now = Instant::now();
                    let poll_targets: Vec<WindowsPollTarget> = {
                        let mut cwd_poll_states_write = cwd_poll_states.write();
                        let mut targets = Vec::new();

                        for (cwd, terminal_ids) in cwd_states {
                            let poll_state = cwd_poll_states_write.entry(cwd.clone()).or_default();

                            let cooldown_ms = if poll_state.last_snapshot_unchanged {
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
                                poll_state.last_snapshot_unchanged =
                                    poll_state.last_status.as_ref() == new_status.as_ref()
                                        && poll_state.last_branch.as_ref() == new_branch.as_ref();
                                poll_state.last_branch = new_branch.clone();
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
        let output = Self::run_git_command(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])?;

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
    /// Runs `git status --porcelain` and `git rev-list --left-right --count HEAD...@{u}`
    /// and returns parsed status.
    /// Returns None if not in a git repository.
    fn check_status_internal(cwd: &str) -> Option<GitStatus> {
        log::debug!("[GitTracker] Polling git status for cwd: {}", cwd);
        let output = Self::run_git_command(cwd, &["status", "--porcelain"])?;

        if !output.status.success() {
            return None;
        }

        let mut status = Self::parse_git_status(&String::from_utf8_lossy(&output.stdout));

        log::debug!("[GitTracker] Fetching ahead/behind for cwd: {}", cwd);
        // Get ahead/behind count
        if let Some(rev_output) =
            Self::run_git_command(cwd, &["rev-list", "--left-right", "--count", "HEAD...@{u}"])
        {
            if rev_output.status.success() {
                let counts = String::from_utf8_lossy(&rev_output.stdout);
                let parts: Vec<&str> = counts.split_whitespace().collect();
                if parts.len() == 2 {
                    status.ahead = parts[0].parse().unwrap_or(0);
                    status.behind = parts[1].parse().unwrap_or(0);
                    log::debug!(
                        "[GitTracker] CWD: {}, ahead: {}, behind: {}",
                        cwd,
                        status.ahead,
                        status.behind
                    );
                }
            } else {
                log::debug!(
                    "[GitTracker] rev-list failed (possibly no upstream): {}",
                    String::from_utf8_lossy(&rev_output.stderr)
                );
            }
        }

        Some(status)
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
    fn test_build_diff_args_untracked_uses_no_index() {
        // Untracked files have no index entry; staged flag is irrelevant.
        assert_eq!(
            build_diff_args("new.txt", true, false),
            vec!["diff", "--no-index", "--", NULL_DEVICE, "new.txt"]
        );
        assert_eq!(
            build_diff_args("new.txt", true, true),
            vec!["diff", "--no-index", "--", NULL_DEVICE, "new.txt"]
        );
    }

    #[test]
    fn test_build_diff_args_staged_uses_cached() {
        assert_eq!(
            build_diff_args("a.txt", false, true),
            vec!["diff", "--cached", "--", "a.txt"]
        );
    }

    #[test]
    fn test_build_diff_args_unstaged_uses_worktree() {
        // Unstaged tracked diff compares worktree against the index (no HEAD,
        // no --cached), so the staged and unstaged rows of one file differ.
        assert_eq!(
            build_diff_args("a.txt", false, false),
            vec!["diff", "--", "a.txt"]
        );
    }

    #[test]
    fn test_classify_discard_action_untracked() {
        assert_eq!(
            classify_discard_action("?? new.txt"),
            DiscardAction::DeleteUntracked
        );
    }

    #[test]
    fn test_classify_discard_action_added_reverts_worktree() {
        // A staged-added file with no worktree change reverts the worktree only;
        // git checkout -- <path> is a safe no-op that never deletes staged content.
        assert_eq!(
            classify_discard_action("A  added.txt"),
            DiscardAction::RevertWorktree
        );
    }

    #[test]
    fn test_classify_discard_action_modified_variants_revert_worktree() {
        // Worktree-modified, staged-modified, MM, and deleted all revert the
        // working tree to the index without touching staged content.
        assert_eq!(
            classify_discard_action(" M mod.txt"),
            DiscardAction::RevertWorktree
        );
        assert_eq!(
            classify_discard_action("M  staged.txt"),
            DiscardAction::RevertWorktree
        );
        assert_eq!(
            classify_discard_action("MM both.txt"),
            DiscardAction::RevertWorktree
        );
        assert_eq!(
            classify_discard_action(" D del.txt"),
            DiscardAction::RevertWorktree
        );
    }

    #[test]
    fn test_classify_discard_action_empty_is_noop() {
        assert_eq!(classify_discard_action(""), DiscardAction::Noop);
        assert_eq!(classify_discard_action("   "), DiscardAction::Noop);
    }

    #[test]
    fn test_is_safe_relative_path() {
        assert!(is_safe_relative_path("src/main.rs"));
        assert!(is_safe_relative_path("a.txt"));
        assert!(is_safe_relative_path("dir/sub/file"));
        // Traversal and absolute / drive-rooted paths are rejected.
        assert!(!is_safe_relative_path("../escape.txt"));
        assert!(!is_safe_relative_path("a/../../b"));
        assert!(!is_safe_relative_path("/etc/passwd"));
        #[cfg(target_os = "windows")]
        {
            assert!(!is_safe_relative_path("C:\\Windows\\x"));
            assert!(!is_safe_relative_path("\\\\server\\share"));
        }
    }

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

    #[test]
    fn test_git_get_status_detail_skips_short_lines() {
        let details = git_get_status_detail_from_output("M\n\n?? file.txt\n");
        assert_eq!(details.len(), 1);
        assert_eq!(details[0].path, "file.txt");
        assert_eq!(details[0].status, "untracked");
        assert!(!details[0].staged);
    }

    #[test]
    fn test_git_get_status_detail_parses_staged_and_unstaged_entries() {
        let details = git_get_status_detail_from_output("MM both.txt\nA  added.txt\n D deleted.txt\n");
        assert_eq!(details.len(), 4);

        assert_eq!(details[0].path, "both.txt");
        assert_eq!(details[0].status, "modified");
        assert!(details[0].staged);

        assert_eq!(details[1].path, "both.txt");
        assert_eq!(details[1].status, "modified");
        assert!(!details[1].staged);

        assert_eq!(details[2].path, "added.txt");
        assert_eq!(details[2].status, "added");
        assert!(details[2].staged);

        assert_eq!(details[3].path, "deleted.txt");
        assert_eq!(details[3].status, "deleted");
        assert!(!details[3].staged);
    }

    #[test]
    fn test_git_get_status_detail_uses_rename_destination_path() {
        let details = git_get_status_detail_from_output("RM old.txt -> new.txt\n");
        assert_eq!(details.len(), 2);
        assert_eq!(details[0].path, "new.txt");
        assert_eq!(details[0].status, "renamed");
        assert!(details[0].staged);
        assert_eq!(details[1].path, "new.txt");
        assert_eq!(details[1].status, "modified");
        assert!(!details[1].staged);
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

    // ---- Integration tests for stage / unstage / discard against real repos ----

    fn unique_temp_dir(tag: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let pid = std::process::id();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("termul-git-it-{tag}-{pid}-{n}-{nanos}"));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn git(cwd: &std::path::Path, args: &[&str]) -> std::process::Output {
        let out = GitTracker::run_git_command(cwd.to_str().unwrap(), args)
            .expect("git command should run");
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
        out
    }

    /// Init a repo with deterministic identity. Returns the repo path.
    fn init_repo(tag: &str) -> std::path::PathBuf {
        let dir = unique_temp_dir(tag);
        git(&dir, &["init", "-q"]);
        git(&dir, &["config", "user.email", "t@example.com"]);
        git(&dir, &["config", "user.name", "Test"]);
        git(&dir, &["config", "commit.gpgsign", "false"]);
        // Keep line endings byte-exact so content assertions are deterministic
        // across platforms (Windows git defaults can rewrite LF -> CRLF).
        git(&dir, &["config", "core.autocrlf", "false"]);
        dir
    }

    fn porcelain(cwd: &std::path::Path, path: &str) -> String {
        let out = git(cwd, &["status", "--porcelain", "--", path]);
        String::from_utf8_lossy(&out.stdout).to_string()
    }

    /// Skip the test body (returning true) when git is unavailable in the env.
    fn git_missing() -> bool {
        GitTracker::run_git_command(std::env::temp_dir().to_str().unwrap(), &["--version"]).is_none()
    }

    #[test]
    fn it_stage_then_unstage_modified_file_roundtrips() {
        if git_missing() {
            return;
        }
        let repo = init_repo("stage-unstage");
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-qm", "init"]);
        std::fs::write(repo.join("a.txt"), "one\ntwo\n").unwrap();

        let cwd = repo.to_str().unwrap();
        git_stage_file(cwd, "a.txt").unwrap();
        assert!(porcelain(&repo, "a.txt").starts_with("M "), "should be staged");

        git_unstage_file(cwd, "a.txt").unwrap();
        assert!(
            porcelain(&repo, "a.txt").starts_with(" M"),
            "should be unstaged but still modified"
        );
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn it_unstage_preserves_worktree_on_staged_modified_file() {
        if git_missing() {
            return;
        }
        let repo = init_repo("unstage-preserve");
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-qm", "init"]);
        std::fs::write(repo.join("a.txt"), "changed\n").unwrap();
        git(&repo, &["add", "--", "a.txt"]);

        // Unstage must NOT delete or revert the working-tree content.
        git_unstage_file(repo.to_str().unwrap(), "a.txt").unwrap();
        assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "changed\n");
        assert!(porcelain(&repo, "a.txt").starts_with(" M"));
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn it_unstage_no_head_repo_removes_from_index_keeps_file() {
        if git_missing() {
            return;
        }
        let repo = init_repo("unstage-nohead");
        std::fs::write(repo.join("a.txt"), "x\n").unwrap();
        git(&repo, &["add", "--", "a.txt"]); // staged-added, no commit -> no HEAD
        assert!(!repo_has_head(repo.to_str().unwrap()));

        git_unstage_file(repo.to_str().unwrap(), "a.txt").unwrap();
        // File stays on disk, now untracked.
        assert!(repo.join("a.txt").exists());
        assert!(porcelain(&repo, "a.txt").starts_with("??"));
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn it_discard_reverts_tracked_modification_to_index() {
        if git_missing() {
            return;
        }
        let repo = init_repo("discard-modified");
        std::fs::write(repo.join("a.txt"), "orig\n").unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-qm", "init"]);
        std::fs::write(repo.join("a.txt"), "dirty\n").unwrap();

        git_discard_file(repo.to_str().unwrap(), "a.txt").unwrap();
        assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "orig\n");
        assert!(porcelain(&repo, "a.txt").is_empty(), "clean after discard");
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn it_discard_staged_row_of_mm_file_preserves_staged_content() {
        if git_missing() {
            return;
        }
        // MM: staged edit + further worktree edit. Discard reverts the worktree
        // to the index and must keep the staged edit intact.
        let repo = init_repo("discard-mm");
        std::fs::write(repo.join("a.txt"), "orig\n").unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-qm", "init"]);
        std::fs::write(repo.join("a.txt"), "staged\n").unwrap();
        git(&repo, &["add", "--", "a.txt"]);
        std::fs::write(repo.join("a.txt"), "staged-plus-worktree\n").unwrap();
        assert!(porcelain(&repo, "a.txt").starts_with("MM"));

        git_discard_file(repo.to_str().unwrap(), "a.txt").unwrap();
        // Worktree reverts to the staged (index) version, not HEAD.
        assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "staged\n");
        assert!(porcelain(&repo, "a.txt").starts_with("M "));
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn it_discard_untracked_file_deletes_it() {
        if git_missing() {
            return;
        }
        let repo = init_repo("discard-untracked");
        std::fs::write(repo.join("n.txt"), "new\n").unwrap();
        assert!(porcelain(&repo, "n.txt").starts_with("??"));

        git_discard_file(repo.to_str().unwrap(), "n.txt").unwrap();
        assert!(!repo.join("n.txt").exists());
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn it_discard_untracked_directory_deletes_it() {
        if git_missing() {
            return;
        }
        let repo = init_repo("discard-untracked-dir");
        std::fs::create_dir_all(repo.join("sub")).unwrap();
        std::fs::write(repo.join("sub/inner.txt"), "x\n").unwrap();
        // Porcelain collapses the untracked dir to "?? sub/".
        assert!(porcelain(&repo, "sub").starts_with("??"));

        git_discard_file(repo.to_str().unwrap(), "sub").unwrap();
        assert!(!repo.join("sub").exists());
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn it_discard_already_missing_untracked_is_ok() {
        if git_missing() {
            return;
        }
        let repo = init_repo("discard-missing");
        // No such file; classified clean -> Noop, must not error.
        git_discard_file(repo.to_str().unwrap(), "ghost.txt").unwrap();
        std::fs::remove_dir_all(&repo).ok();
    }

    // ---- commit / amend / push / context ----

    fn last_subject(repo: &std::path::Path) -> String {
        let out = git(repo, &["log", "-1", "--pretty=%s"]);
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn last_body(repo: &std::path::Path) -> String {
        let out = git(repo, &["log", "-1", "--pretty=%b"]);
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn count_commits(repo: &std::path::Path) -> usize {
        let out = git(repo, &["rev-list", "--count", "HEAD"]);
        String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0)
    }

    #[test]
    fn it_build_commit_message_formats_body() {
        assert_eq!(build_commit_message("hello", ""), "hello");
        assert_eq!(build_commit_message("  hello  ", "  "), "hello");
        assert_eq!(
            build_commit_message("summary", "more detail"),
            "summary\n\nmore detail"
        );
    }

    #[test]
    fn it_commit_creates_commit_and_clears_index() {
        if git_missing() {
            return;
        }
        let repo = init_repo("commit-basic");
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-qm", "init"]);
        std::fs::write(repo.join("a.txt"), "two\n").unwrap();
        git(&repo, &["add", "--", "a.txt"]);

        let cwd = repo.to_str().unwrap();
        git_commit_file(cwd, "second commit", "", false).unwrap();

        assert_eq!(count_commits(&repo), 2);
        assert_eq!(last_subject(&repo), "second commit");
        assert_eq!(staged_entry_count(cwd), Some(0), "index cleared after commit");
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn it_commit_writes_multiline_body() {
        if git_missing() {
            return;
        }
        let repo = init_repo("commit-body");
        std::fs::write(repo.join("a.txt"), "x\n").unwrap();
        git(&repo, &["add", "--", "a.txt"]);

        git_commit_file(repo.to_str().unwrap(), "sum", "line one\nline two", false).unwrap();
        assert_eq!(last_subject(&repo), "sum");
        assert_eq!(last_body(&repo), "line one\nline two");
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn it_commit_rejects_empty_summary() {
        if git_missing() {
            return;
        }
        let repo = init_repo("commit-emptysum");
        std::fs::write(repo.join("a.txt"), "x\n").unwrap();
        git(&repo, &["add", "--", "a.txt"]);
        let err = git_commit_file(repo.to_str().unwrap(), "   ", "", false).unwrap_err();
        assert!(err.to_lowercase().contains("summary"));
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn it_commit_rejects_nothing_staged() {
        if git_missing() {
            return;
        }
        let repo = init_repo("commit-nostage");
        std::fs::write(repo.join("a.txt"), "x\n").unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-qm", "init"]);
        // Clean index now.
        let err = git_commit_file(repo.to_str().unwrap(), "noop", "", false).unwrap_err();
        assert!(err.to_lowercase().contains("nothing staged"));
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn it_amend_rewords_subject_without_new_commit() {
        if git_missing() {
            return;
        }
        let repo = init_repo("amend-reword");
        std::fs::write(repo.join("a.txt"), "x\n").unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-qm", "original"]);
        assert_eq!(count_commits(&repo), 1);

        git_commit_file(repo.to_str().unwrap(), "reworded", "", true).unwrap();
        assert_eq!(count_commits(&repo), 1, "amend must not add a commit");
        assert_eq!(last_subject(&repo), "reworded");
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn it_amend_folds_staged_changes() {
        if git_missing() {
            return;
        }
        let repo = init_repo("amend-fold");
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-qm", "init"]);
        std::fs::write(repo.join("b.txt"), "new\n").unwrap();
        git(&repo, &["add", "--", "b.txt"]);

        let cwd = repo.to_str().unwrap();
        git_commit_file(cwd, "init+b", "", true).unwrap();
        assert_eq!(count_commits(&repo), 1);
        // b.txt is now part of HEAD; nothing left staged.
        assert_eq!(staged_entry_count(cwd), Some(0));
        let tree = git(&repo, &["ls-tree", "--name-only", "HEAD"]);
        let names = String::from_utf8_lossy(&tree.stdout);
        assert!(names.contains("b.txt"));
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn it_amend_rejects_no_head() {
        if git_missing() {
            return;
        }
        let repo = init_repo("amend-nohead");
        std::fs::write(repo.join("a.txt"), "x\n").unwrap();
        git(&repo, &["add", "--", "a.txt"]); // staged, but no commit yet
        let err = git_commit_file(repo.to_str().unwrap(), "x", "", true).unwrap_err();
        assert!(err.to_lowercase().contains("no commit to amend"));
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn it_push_sets_upstream_and_resets_ahead() {
        if git_missing() {
            return;
        }
        let repo = init_repo("push-upstream");
        std::fs::write(repo.join("a.txt"), "x\n").unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-qm", "init"]);

        // Local bare remote -> no network.
        let bare = unique_temp_dir("push-bare");
        git(&bare, &["init", "--bare", "-q"]);
        let bare_str = bare.to_str().unwrap();
        git(&repo, &["remote", "add", "origin", bare_str]);

        let cwd = repo.to_str().unwrap();
        // No upstream yet -> push must set it.
        git_push_current(cwd).unwrap();

        let ctx = git_get_commit_context(cwd).unwrap();
        assert!(ctx.has_upstream, "upstream should be set after publish");
        assert_eq!(ctx.ahead, 0, "ahead resets after push");

        // A further commit is ahead; push again brings it back to 0.
        std::fs::write(repo.join("a.txt"), "y\n").unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-qm", "second"]);
        assert_eq!(git_get_commit_context(cwd).unwrap().ahead, 1);
        git_push_current(cwd).unwrap();
        assert_eq!(git_get_commit_context(cwd).unwrap().ahead, 0);

        std::fs::remove_dir_all(&repo).ok();
        std::fs::remove_dir_all(&bare).ok();
    }

    #[test]
    fn it_push_rejects_detached_head() {
        if git_missing() {
            return;
        }
        let repo = init_repo("push-detached");
        std::fs::write(repo.join("a.txt"), "x\n").unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-qm", "init"]);
        let head = git(&repo, &["rev-parse", "HEAD"]);
        let sha = String::from_utf8_lossy(&head.stdout).trim().to_string();
        git(&repo, &["checkout", "-q", &sha]); // detach

        let err = git_push_current(repo.to_str().unwrap()).unwrap_err();
        assert!(err.to_lowercase().contains("branch"));
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn it_commit_context_reports_fields() {
        if git_missing() {
            return;
        }
        let repo = init_repo("ctx-basic");
        let cwd = repo.to_str().unwrap();

        // No HEAD yet.
        let empty = git_get_commit_context(cwd).unwrap();
        assert!(!empty.has_head);
        assert_eq!(empty.staged_count, 0);
        assert!(empty.last_subject.is_empty());

        std::fs::write(repo.join("a.txt"), "x\n").unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-qm", "first\n\nbody text"]);
        std::fs::write(repo.join("b.txt"), "y\n").unwrap();
        git(&repo, &["add", "--", "b.txt"]);

        let ctx = git_get_commit_context(cwd).unwrap();
        assert!(ctx.has_head);
        assert!(ctx.branch.is_some());
        assert!(!ctx.has_upstream);
        assert_eq!(ctx.staged_count, 1);
        assert_eq!(ctx.last_subject, "first");
        assert_eq!(ctx.last_body, "body text");
        std::fs::remove_dir_all(&repo).ok();
    }
}
