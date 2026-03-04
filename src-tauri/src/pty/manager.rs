//! PtyManager - Manages PTY (pseudo-terminal) instances for Tauri
//!
//! This module provides terminal spawning, I/O, and lifecycle management
//! ported from the Electron implementation.

use crate::trackers::{CwdTracker, ExitCodeTracker, GitTracker};
use parking_lot::RwLock;
use portable_pty::{native_pty_system, CommandBuilder, Child, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::env;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex as AsyncMutex;

// Constants matching Electron implementation
const GLOBAL_TERMINAL_LIMIT: usize = 30;
const ORPHAN_TIMEOUT_MS: u64 = 300_000; // 5 minutes
const ORPHAN_CHECK_INTERVAL_MS: u64 = 30_000; // 30 seconds

/// Public information about a spawned terminal
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: String,
    pub shell: String,
    pub cwd: String,
    pub pid: u32,
    pub cols: u16,
    pub rows: u16,
}

/// Options for spawning a new terminal
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOptions {
    pub shell: Option<String>,
    pub cwd: Option<String>,
    pub env: Option<HashMap<String, String>>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

impl Default for SpawnOptions {
    fn default() -> Self {
        Self {
            shell: None,
            cwd: None,
            env: None,
            cols: Some(80),
            rows: Some(24),
        }
    }
}

/// A running terminal instance
pub struct TerminalInstance {
    pub id: String,
    pub child: Arc<AsyncMutex<Option<Box<dyn Child + Send>>>>,
    pub master: Arc<AsyncMutex<Option<Box<dyn MasterPty + Send>>>>,
    pub reader_handle: Arc<AsyncMutex<Option<std::thread::JoinHandle<()>>>>,
    pub shell: String,
    pub cwd: String,
    pub pid: u32,
    pub last_activity: Arc<RwLock<Instant>>,
    pub renderer_refs: Arc<RwLock<HashSet<String>>>,
    pub cols: Arc<RwLock<u16>>,
    pub rows: Arc<RwLock<u16>>,
}

impl TerminalInstance {
    /// Update the last activity timestamp
    pub fn update_activity(&self) {
        *self.last_activity.write() = Instant::now();
    }

    /// Get elapsed time since last activity
    pub fn inactive_duration(&self) -> Duration {
        self.last_activity.read().elapsed()
    }

    /// Add a renderer reference
    pub fn add_renderer_ref(&self, renderer_id: String) {
        self.renderer_refs.write().insert(renderer_id);
    }

    /// Remove a renderer reference
    pub fn remove_renderer_ref(&self, renderer_id: &str) {
        self.renderer_refs.write().remove(renderer_id);
    }

    /// Get count of renderer references
    pub fn renderer_ref_count(&self) -> usize {
        self.renderer_refs.read().len()
    }

    /// Check if terminal has no renderer references
    pub fn is_orphan(&self) -> bool {
        self.renderer_refs.read().is_empty()
    }
}

/// Event emitted when terminal data is received
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalDataEvent {
    id: String,
    data: String,
}

/// Event emitted when a terminal exits
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExitEvent {
    id: String,
    exit_code: Option<i32>,
    signal: Option<i32>,
}

/// Manages all PTY instances
pub struct PtyManager {
    terminals: Arc<RwLock<HashMap<String, Arc<TerminalInstance>>>>,
    id_counter: Arc<AtomicU64>,
    app_handle: AppHandle,
    orphan_detection_enabled: Arc<AtomicBool>,
    orphan_timeout_ms: Arc<AtomicU64>,
    orphan_detection_started: Arc<AtomicBool>,
    cwd_tracker: Arc<CwdTracker>,
    git_tracker: Arc<GitTracker>,
    exit_code_tracker: Arc<ExitCodeTracker>,
}

impl PtyManager {
    /// Create a new PtyManager
    pub fn new(
        app_handle: AppHandle,
        cwd_tracker: Arc<CwdTracker>,
        git_tracker: Arc<GitTracker>,
        exit_code_tracker: Arc<ExitCodeTracker>,
    ) -> Self {
        Self {
            terminals: Arc::new(RwLock::new(HashMap::new())),
            id_counter: Arc::new(AtomicU64::new(0)),
            app_handle,
            orphan_detection_enabled: Arc::new(AtomicBool::new(true)),
            orphan_timeout_ms: Arc::new(AtomicU64::new(ORPHAN_TIMEOUT_MS)),
            orphan_detection_started: Arc::new(AtomicBool::new(false)),
            cwd_tracker,
            git_tracker,
            exit_code_tracker,
        }
    }

    /// Start the orphan detection background task
    /// This is called lazily when the first terminal is spawned
    fn start_orphan_detection(&self) {
        // Check if already started using compare_exchange
        if self.orphan_detection_started.compare_exchange(false, true, Ordering::SeqCst, Ordering::Relaxed).is_err() {
            return; // Already started
        }

        let terminals = self.terminals.clone();
        let _app_handle = self.app_handle.clone();
        let cwd_tracker = self.cwd_tracker.clone();
        let git_tracker = self.git_tracker.clone();
        let exit_code_tracker = self.exit_code_tracker.clone();
        let enabled = self.orphan_detection_enabled.clone();
        let timeout_ms = self.orphan_timeout_ms.clone();

        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(ORPHAN_CHECK_INTERVAL_MS));

            loop {
                interval.tick().await;

                // Check if detection is enabled
                if !enabled.load(Ordering::Relaxed) {
                    continue;
                }

                let timeout = Duration::from_millis(timeout_ms.load(Ordering::Relaxed));

                // Find orphaned terminals
                let orphans: Vec<String> = terminals
                    .read()
                    .iter()
                    .filter(|(_, instance)| instance.is_orphan() && instance.inactive_duration() > timeout)
                    .map(|(id, _)| id.clone())
                    .collect();

                // Clean up orphans
                for id in orphans {
                    log::info!("Cleaning up orphaned terminal: {}", id);

                    if let Some(instance) = terminals.write().remove(&id) {
                        // Kill child process first to unblock reader thread on PTY EOF
                        if let Ok(mut guard) = instance.child.try_lock() {
                            if let Some(child) = guard.as_mut() {
                                child.kill().ok();
                            }
                        }

                        // Join reader thread with short timeout by detaching.
                        // We cannot safely block this async task on thread join.
                        if let Ok(mut guard) = instance.reader_handle.try_lock() {
                            let _ = guard.take();
                        }

                        // Stop tracking
                        cwd_tracker.stop_tracking(&id);
                        git_tracker.remove_terminal(&id);
                        exit_code_tracker.remove_terminal(&id);
                    }
                }
            }
        });
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

    /// Spawn a new terminal
    pub async fn spawn(&self, options: SpawnOptions) -> Result<TerminalInfo, String> {
        // Start orphan detection on first spawn (lazy initialization)
        self.start_orphan_detection();

        // Check terminal limit
        if self.is_limit_reached() {
            return Err("Global terminal limit reached".to_string());
        }

        let id = self.generate_id();

        // Resolve shell path
        let shell_path = if let Some(shell) = &options.shell {
            self.resolve_shell_path(shell)?
        } else {
            self.get_default_shell()?
        };

        // Resolve working directory
        let cwd = if let Some(cwd) = &options.cwd {
            cwd.clone()
        } else {
            self.get_home_directory()
        };

        // Verify CWD exists
        if !Path::new(&cwd).exists() {
            return Err(format!("Directory does not exist: {}", cwd));
        }

        // Get terminal size
        let cols = options.cols.unwrap_or(80);
        let rows = options.rows.unwrap_or(24);

        // Create PTY
        let pty_system = native_pty_system();
        let pty_size = PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        };

        let pty_pair = pty_system
            .openpty(pty_size)
            .map_err(|e| format!("Failed to open PTY: {}", e))?;

        // Build command with environment
        let mut cmd = CommandBuilder::new(&shell_path);

        // Merge environment variables (case-insensitive on Windows)
        let env = self.merge_environment(options.env);
        for (key, value) in &env {
            cmd.env(key, value);
        }

        // Set standard terminal environment variables
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        // Set working directory
        cmd.cwd(&cwd);

        // Spawn the child process
        let child = pty_pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn shell: {}", e))?;

        let pid = child.process_id().unwrap_or(0);

        // Get the reader from the master PTY
        let reader = pty_pair.master.try_clone_reader()
            .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

        // Create terminal instance
        let instance = Arc::new(TerminalInstance {
            id: id.clone(),
            child: Arc::new(AsyncMutex::new(Some(child))),
            master: Arc::new(AsyncMutex::new(Some(pty_pair.master))),
            reader_handle: Arc::new(AsyncMutex::new(None)),
            shell: shell_path.clone(),
            cwd: cwd.clone(),
            pid,
            last_activity: Arc::new(RwLock::new(Instant::now())),
            renderer_refs: Arc::new(RwLock::new(HashSet::new())),
            cols: Arc::new(RwLock::new(cols)),
            rows: Arc::new(RwLock::new(rows)),
        });

        // Start reader task
        let reader_instance = instance.clone();
        let app_handle = self.app_handle.clone();
        let exit_code_tracker = self.exit_code_tracker.clone();
        let terminal_id = id.clone();

        let reader_task = std::thread::spawn(move || {
            Self::reader_loop_sync(reader_instance, reader, app_handle, exit_code_tracker, terminal_id);
        });

        *instance.reader_handle.lock().await = Some(reader_task);

        // Store the terminal
        self.terminals.write().insert(id.clone(), instance.clone());

        // Initialize tracking
        self.cwd_tracker.start_tracking(&id, pid, &cwd);
        self.git_tracker.initialize_terminal(&id, &cwd);
        self.exit_code_tracker.initialize_terminal(&id);

        Ok(TerminalInfo {
            id,
            shell: shell_path,
            cwd,
            pid,
            cols,
            rows,
        })
    }

    /// Reader loop that continuously reads from PTY and emits events
    fn reader_loop_sync(
        instance: Arc<TerminalInstance>,
        mut reader: Box<dyn Read + Send>,
        app_handle: AppHandle,
        exit_code_tracker: Arc<ExitCodeTracker>,
        terminal_id: String,
    ) {
        let mut buffer = [0u8; 8192];
        let id = terminal_id.clone();

        log::info!("[PTY {}] Reader loop started", id);

        let mut had_read_error = false;

        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    // EOF - process has exited
                    log::info!("[PTY {}] EOF reached, exiting reader loop", id);
                    break;
                }
                Ok(n) => {
                    instance.update_activity();

                    // Convert bytes to UTF-8 string, replacing invalid sequences
                    let data = String::from_utf8_lossy(&buffer[..n]).to_string();

                    log::trace!("[PTY {}] Read {} bytes", id, n);

                    // Parse exit codes from output
                    exit_code_tracker.process_data(&id, &data);

                    // Emit terminal-data event
                    let event = TerminalDataEvent {
                        id: id.clone(),
                        data,
                    };

                    if let Err(e) = app_handle.emit("terminal-data", event) {
                        log::error!("[PTY {}] Failed to emit terminal-data event: {}", id, e);
                    }
                }
                Err(e) => {
                    had_read_error = true;
                    log::error!("[PTY {}] Error reading from PTY: {}", id, e);
                    break;
                }
            }
        }

        // Get real child exit status where possible.
        // If we observed a PTY read error and cannot retrieve a child status, do not report success.
        let exit_code = match instance.child.try_lock() {
            Ok(mut guard) => match guard.as_mut() {
                Some(child) => match child.try_wait() {
                    Ok(Some(status)) => {
                        let code_u32 = status.exit_code();
                        i32::try_from(code_u32).ok()
                    }
                    Ok(None) => {
                        if had_read_error {
                            None
                        } else {
                            Some(0)
                        }
                    }
                    Err(e) => {
                        log::warn!("[PTY {}] Failed to query child exit status: {}", id, e);
                        if had_read_error {
                            None
                        } else {
                            Some(0)
                        }
                    }
                },
                None => {
                    if had_read_error {
                        None
                    } else {
                        Some(0)
                    }
                }
            },
            Err(_) => {
                if had_read_error {
                    None
                } else {
                    Some(0)
                }
            }
        };

        // Process has exited - emit terminal-exit event
        let exit_event = TerminalExitEvent {
            id: id.clone(),
            exit_code,
            signal: None,
        };

        if let Err(e) = app_handle.emit("terminal-exit", exit_event) {
            log::error!("[PTY {}] Failed to emit terminal-exit event: {}", id, e);
        }

        log::info!("[PTY {}] Reader loop ended", id);
    }

    /// Write data to a terminal
    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let instance = self.terminals
            .read()
            .get(id)
            .ok_or_else(|| format!("Terminal not found: {}", id))?
            .clone();

        instance.update_activity();

        // Try to get the master - using try_lock for sync context
        let master_guard = instance.master.try_lock()
            .map_err(|_| "Failed to acquire PTY lock".to_string())?;

        let master = master_guard.as_ref()
            .ok_or_else(|| "PTY master already consumed".to_string())?;

        let mut writer = master
            .take_writer()
            .map_err(|e| format!("Failed to get PTY writer: {}", e))?;

        use std::io::Write;
        writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("Failed to write to PTY: {}", e))?;
        writer
            .flush()
            .map_err(|e| format!("Failed to flush PTY: {}", e))?;

        Ok(())
    }

    /// Resize a terminal
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let instance = self.terminals
            .read()
            .get(id)
            .ok_or_else(|| format!("Terminal not found: {}", id))?
            .clone();

        let master_guard = instance.master.try_lock()
            .map_err(|_| "Failed to acquire PTY lock".to_string())?;

        let master = master_guard.as_ref()
            .ok_or_else(|| "PTY master already consumed".to_string())?;

        let size = PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        };

        master.resize(size)
            .map_err(|e| format!("Failed to resize terminal: {}", e))?;

        *instance.cols.write() = cols;
        *instance.rows.write() = rows;
        instance.update_activity();

        Ok(())
    }

    /// Kill a terminal
    pub fn kill(&self, id: &str) -> Result<(), String> {
        let instance = self.terminals.write().remove(id)
            .ok_or_else(|| format!("Terminal not found: {}", id))?;

        // Clone references needed for the task
        let child_clone = instance.child.clone();
        let reader_handle_clone = instance.reader_handle.clone();

        // Spawn task to do async cleanup
        tokio::spawn(async move {
            // Kill the child process first so reader thread can naturally exit on EOF
            if let Some(mut child) = child_clone.lock().await.take() {
                let _ = child.kill();
            }

            // Drop join handle to detach reader thread; it will end after PTY closes
            let _ = reader_handle_clone.lock().await.take();
        });

        // Stop tracking (sync operations)
        self.cwd_tracker.stop_tracking(id);
        self.git_tracker.remove_terminal(id);
        self.exit_code_tracker.remove_terminal(id);

        Ok(())
    }

    /// Add a renderer reference to a terminal
    pub fn add_renderer_ref(&self, id: &str, renderer_id: &str) -> Result<(), String> {
        self.terminals
            .read()
            .get(id)
            .ok_or_else(|| format!("Terminal not found: {}", id))
            .map(|instance| instance.add_renderer_ref(renderer_id.to_string()))
    }

    /// Remove a renderer reference from a terminal
    pub fn remove_renderer_ref(&self, id: &str, renderer_id: &str) -> Result<(), String> {
        self.terminals
            .read()
            .get(id)
            .ok_or_else(|| format!("Terminal not found: {}", id))
            .map(|instance| instance.remove_renderer_ref(renderer_id))
    }

    /// Get terminal by ID
    pub fn get(&self, id: &str) -> Option<Arc<TerminalInstance>> {
        self.terminals.read().get(id).cloned()
    }

    /// Get all terminals
    pub fn get_all(&self) -> Vec<Arc<TerminalInstance>> {
        self.terminals.read().values().cloned().collect()
    }

    /// Get terminal count
    pub fn get_count(&self) -> usize {
        self.terminals.read().len()
    }

    /// Check if terminal limit is reached
    pub fn is_limit_reached(&self) -> bool {
        self.get_count() >= GLOBAL_TERMINAL_LIMIT
    }

    /// Update orphan detection settings (timeout in milliseconds)
    pub fn update_orphan_detection(&self, enabled: bool, timeout_ms: Option<u64>) {
        self.orphan_detection_enabled.store(enabled, Ordering::Relaxed);
        if let Some(timeout) = timeout_ms {
            self.orphan_timeout_ms.store(timeout, Ordering::Relaxed);
        }
    }

    /// Update orphan detection settings (timeout in minutes, for async API compatibility)
    pub async fn update_orphan_detection_settings(&self, enabled: bool, timeout_minutes: Option<u64>) {
        self.orphan_detection_enabled.store(enabled, Ordering::Relaxed);
        if let Some(timeout) = timeout_minutes {
            self.orphan_timeout_ms.store(timeout * 60 * 1000, Ordering::Relaxed);
        }
    }

    /// Get the default shell path
    fn get_default_shell(&self) -> Result<String, String> {
        #[cfg(target_os = "windows")]
        {
            let comspec = env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
            Ok(comspec)
        }

        #[cfg(not(target_os = "windows"))]
        {
            env::var("SHELL")
                .or_else(|_| Ok("/bin/sh".to_string()))
                .map_err(|_| "Failed to determine default shell".to_string())
        }
    }

    /// Resolve a shell name to its full path
    fn resolve_shell_path(&self, shell: &str) -> Result<String, String> {
        // If it looks like a path, verify it exists
        if shell.contains('/') || shell.contains('\\') {
            if Path::new(shell).exists() {
                return Ok(shell.to_string());
            }
            return Err(format!("Shell not found: {}", shell));
        }

        #[cfg(target_os = "windows")]
        {
            // Try shell.exe variant
            let exe_shell = format!("{}.exe", shell);
            if let Some(abs_path) = self.get_absolute_shell_path(&exe_shell) {
                return Ok(abs_path);
            }

            // Try the shell name directly
            if let Some(abs_path) = self.get_absolute_shell_path(shell) {
                return Ok(abs_path);
            }

            // Try common paths for Git Bash
            if shell == "bash" || shell == "git-bash" {
                let paths = vec![
                    r"C:\Program Files\Git\bin\bash.exe",
                    r"C:\Program Files\Git\usr\bin\bash.exe",
                    r"C:\Program Files (x86)\Git\bin\bash.exe",
                    r"C:\Program Files (x86)\Git\usr\bin\bash.exe",
                    r"C:\tools\msys64\usr\bin\bash.exe",
                ];
                for path in paths {
                    if Path::new(path).exists() {
                        return Ok(path.to_string());
                    }
                }
            }

            // Try PowerShell variants
            if shell == "powershell" || shell == "pwsh" {
                let paths = vec!["pwsh.exe", "powershell.exe"];
                for path in paths {
                    if let Some(abs_path) = self.get_absolute_shell_path(path) {
                        return Ok(abs_path);
                    }
                }
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            let candidates = vec![
                format!("/bin/{}", shell),
                format!("/usr/bin/{}", shell),
                format!("/usr/local/bin/{}", shell),
            ];

            for candidate in candidates {
                if Path::new(&candidate).exists() {
                    return Ok(candidate);
                }
            }
        }

        Err(format!("Shell not found: {}", shell))
    }

    /// Get the absolute path for a shell if available
    fn get_absolute_shell_path(&self, shell_path: &str) -> Option<String> {
        // If it's already an absolute path that exists, return it
        if Path::new(shell_path).exists() {
            return Some(shell_path.to_string());
        }

        #[cfg(target_os = "windows")]
        {
            if !shell_path.contains('\\') && !shell_path.contains('/') {
                if let Ok(output) = std::process::Command::new("where")
                    .arg(shell_path)
                    .creation_flags(0x08000000) // CREATE_NO_WINDOW
                    .output()
                {
                    if output.status.success() {
                        let stdout = String::from_utf8_lossy(&output.stdout);
                        let first_line = stdout.lines().next().unwrap_or("").trim();
                        if !first_line.is_empty() {
                            return Some(first_line.to_string());
                        }
                    }
                }
            }
            if Path::new(shell_path).exists() {
                return Some(shell_path.to_string());
            }
            None
        }

        #[cfg(not(target_os = "windows"))]
        {
            if let Ok(output) = std::process::Command::new("which")
                .arg(shell_path)
                .output()
            {
                if output.status.success() {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    let first_line = stdout.lines().next().unwrap_or("").trim();
                    if !first_line.is_empty() {
                        return Some(first_line.to_string());
                    }
                }
            }
            if Path::new(shell_path).exists() {
                return Some(shell_path.to_string());
            }
            None
        }
    }

    /// Get the home directory
    fn get_home_directory(&self) -> String {
        #[cfg(target_os = "windows")]
        {
            env::var("USERPROFILE")
                .or_else(|_| env::var("HOME"))
                .unwrap_or_else(|_| "C:\\".to_string())
        }

        #[cfg(not(target_os = "windows"))]
        {
            env::var("HOME").unwrap_or_else(|_| "/tmp".to_string())
        }
    }

    /// Merge custom environment with base environment
    /// On Windows, environment variable keys are case-insensitive
    fn merge_environment(
        &self,
        custom_env: Option<HashMap<String, String>>,
    ) -> HashMap<String, String> {
        let mut env = HashMap::new();

        // Copy current process environment
        for (key, value) in env::vars() {
            env.insert(key, value);
        }

        // Apply custom environment (overriding existing)
        if let Some(custom) = custom_env {
            #[cfg(target_os = "windows")]
            {
                // On Windows, use case-insensitive merging
                for (custom_key, custom_value) in custom {
                    // Find and remove existing key with different case
                    let existing_key = env
                        .keys()
                        .find(|k| k.eq_ignore_ascii_case(&custom_key))
                        .cloned();

                    if let Some(key) = existing_key {
                        env.remove(&key);
                    }

                    env.insert(custom_key, custom_value);
                }
            }

            #[cfg(not(target_os = "windows"))]
            {
                // On Unix, case-sensitive
                for (key, value) in custom {
                    env.insert(key, value);
                }
            }
        }

        // Ensure PATH exists
        if !env.contains_key("PATH") {
            #[cfg(target_os = "windows")]
            {
                env.insert("PATH".to_string(), String::new());
            }
            #[cfg(not(target_os = "windows"))]
            {
                env.insert("PATH".to_string(), "/usr/bin:/bin".to_string());
            }
        }

        env
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_spawn_options_default() {
        let options = SpawnOptions::default();
        assert!(options.shell.is_none());
        assert!(options.cwd.is_none());
        assert!(options.env.is_none());
        assert_eq!(options.cols, Some(80));
        assert_eq!(options.rows, Some(24));
    }

    #[test]
    fn test_terminal_info_serialization() {
        let info = TerminalInfo {
            id: "test-123".to_string(),
            shell: "/bin/bash".to_string(),
            cwd: "/home/user".to_string(),
            pid: 12345,
            cols: 100,
            rows: 30,
        };

        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("\"id\":\"test-123\""));
        assert!(json.contains("\"shell\":\"/bin/bash\""));
        assert!(json.contains("\"cwd\":\"/home/user\""));
        assert!(json.contains("\"pid\":12345"));
        assert!(json.contains("\"cols\":100"));
        assert!(json.contains("\"rows\":30"));
    }

    #[test]
    fn test_spawn_options_deserialization() {
        let json = r#"{"shell":"cmd.exe","cwd":"C:\\","cols":120,"rows":40}"#;
        let options: SpawnOptions = serde_json::from_str(json).unwrap();
        assert_eq!(options.shell, Some("cmd.exe".to_string()));
        assert_eq!(options.cwd, Some("C:\\".to_string()));
        assert_eq!(options.cols, Some(120));
        assert_eq!(options.rows, Some(40));
    }
}
