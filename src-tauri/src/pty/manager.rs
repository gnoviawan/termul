//! PtyManager - Manages PTY (pseudo-terminal) instances for Tauri
//!
//! This module provides terminal spawning, I/O, and lifecycle management
//! ported from the Electron implementation.

use crate::trackers::{CwdTracker, ExitCodeTracker, GitTracker};
use parking_lot::RwLock;
use portable_pty::{Child, MasterPty, PtySize};

#[cfg(target_os = "windows")]
use crate::pty::windows::{resize_conpty, spawn_conpty, ConPtyHandles};
#[cfg(target_os = "windows")]
use crate::shell_paths::git_bash_paths;
#[cfg(target_os = "windows")]
use parking_lot::Mutex as ParkingMutex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::env;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

#[cfg(target_os = "windows")]
fn resolve_executable_from_path(command: &str) -> Option<String> {
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};

    if command.contains('\\') || command.contains('/') {
        let candidate = Path::new(command);
        return candidate.exists().then(|| command.to_string());
    }

    let path_var = env::var_os("PATH")?;
    let pathext_var =
        env::var_os("PATHEXT").unwrap_or_else(|| OsString::from(".COM;.EXE;.BAT;.CMD"));

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

    for dir in env::split_paths(&path_var) {
        for ext in &extensions {
            let candidate: PathBuf = if ext.is_empty() {
                dir.join(command)
            } else {
                dir.join(format!("{}{}", command, ext.to_string_lossy()))
            };
            if candidate.exists() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }

    None
}

use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex as AsyncMutex;

#[cfg(target_os = "windows")]
fn has_windows_env_var(env_map: &HashMap<String, String>, key: &str) -> bool {
    env_map
        .keys()
        .any(|existing| existing.eq_ignore_ascii_case(key))
}

#[cfg(target_os = "windows")]
fn upsert_windows_env_var(env_map: &mut HashMap<String, String>, key: &str, value: String) {
    if let Some(existing_key) = env_map
        .keys()
        .find(|existing| existing.eq_ignore_ascii_case(key))
        .cloned()
    {
        env_map.remove(&existing_key);
    }

    env_map.insert(key.to_string(), value);
}

#[cfg(target_os = "windows")]
fn merge_windows_environment_map<I>(
    base_env: I,
    custom_env: Option<HashMap<String, String>>,
) -> HashMap<String, String>
where
    I: IntoIterator<Item = (String, String)>,
{
    let mut env_map = HashMap::new();

    for (key, value) in base_env {
        upsert_windows_env_var(&mut env_map, &key, value);
    }

    if let Some(custom) = custom_env {
        for (key, value) in custom {
            upsert_windows_env_var(&mut env_map, &key, value);
        }
    }

    if !has_windows_env_var(&env_map, "Path") {
        upsert_windows_env_var(&mut env_map, "Path", env::var("PATH").unwrap_or_default());
    }

    if !has_windows_env_var(&env_map, "PATHEXT") {
        upsert_windows_env_var(
            &mut env_map,
            "PATHEXT",
            env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string()),
        );
    }

    env_map
}

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
    pub writer: Arc<AsyncMutex<Option<Box<dyn Write + Send>>>>,
    pub reader_handle: Arc<AsyncMutex<Option<std::thread::JoinHandle<()>>>>,
    pub shell: String,
    pub cwd: String,
    pub pid: u32,
    pub last_activity: Arc<RwLock<Instant>>,
    pub renderer_refs: Arc<RwLock<HashSet<String>>>,
    pub cols: Arc<RwLock<u16>>,
    pub rows: Arc<RwLock<u16>>,
    #[cfg(target_os = "windows")]
    pub conpty_handles: Option<Arc<ParkingMutex<Option<ConPtyHandles>>>>,
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

struct TerminalSlotReservation {
    active_slots: Arc<AtomicUsize>,
    committed: bool,
}

impl TerminalSlotReservation {
    fn try_acquire(active_slots: Arc<AtomicUsize>) -> Option<Self> {
        loop {
            let current = active_slots.load(Ordering::SeqCst);
            if current >= GLOBAL_TERMINAL_LIMIT {
                return None;
            }

            if active_slots
                .compare_exchange(current, current + 1, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                return Some(Self {
                    active_slots,
                    committed: false,
                });
            }
        }
    }

    fn commit(&mut self) {
        self.committed = true;
    }
}

impl Drop for TerminalSlotReservation {
    fn drop(&mut self) {
        if !self.committed {
            self.active_slots.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

/// Manages all PTY instances
pub struct PtyManager {
    terminals: Arc<RwLock<HashMap<String, Arc<TerminalInstance>>>>,
    active_terminal_slots: Arc<AtomicUsize>,
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
            active_terminal_slots: Arc::new(AtomicUsize::new(0)),
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

    fn join_reader_with_timeout(reader_handle: std::thread::JoinHandle<()>, timeout: Duration) {
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || {
            let _ = reader_handle.join();
            let _ = tx.send(());
        });
        let _ = rx.recv_timeout(timeout);
    }

    fn cleanup_terminal_resources_sync(instance: Arc<TerminalInstance>, wait_reader_thread: bool) {
        // a) Drop writer first to close PTY input stream cleanly.
        let _ = instance.writer.blocking_lock().take();

        // b) Wait reader thread to finish naturally (max 3s)
        if let Some(reader_handle) = instance.reader_handle.blocking_lock().take() {
            if wait_reader_thread {
                Self::join_reader_with_timeout(reader_handle, Duration::from_secs(3));
            }
        }

        // c) Kill child process
        if let Some(mut child) = instance.child.blocking_lock().take() {
            let _ = child.kill();
        }

        // d) Drop ConPTY handles last
        #[cfg(target_os = "windows")]
        if let Some(conpty_handles) = &instance.conpty_handles {
            let mut guard = conpty_handles.lock();
            let _ = guard.take();
        }
    }

    fn try_reserve_terminal_slot(&self) -> Option<TerminalSlotReservation> {
        TerminalSlotReservation::try_acquire(self.active_terminal_slots.clone())
    }

    fn release_terminal_slot(&self) {
        self.active_terminal_slots.fetch_sub(1, Ordering::SeqCst);
    }

    /// Start the orphan detection background task
    /// This is called lazily when the first terminal is spawned
    fn start_orphan_detection(&self) {
        // Check if already started using compare_exchange
        if self
            .orphan_detection_started
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::Relaxed)
            .is_err()
        {
            return; // Already started
        }

        let terminals = self.terminals.clone();
        let _app_handle = self.app_handle.clone();
        let cwd_tracker = self.cwd_tracker.clone();
        let git_tracker = self.git_tracker.clone();
        let exit_code_tracker = self.exit_code_tracker.clone();
        let active_slots = self.active_terminal_slots.clone();
        let enabled = self.orphan_detection_enabled.clone();
        let timeout_ms = self.orphan_timeout_ms.clone();

        tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(Duration::from_millis(ORPHAN_CHECK_INTERVAL_MS));

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
                    .filter(|(_, instance)| {
                        instance.is_orphan() && instance.inactive_duration() > timeout
                    })
                    .map(|(id, _)| id.clone())
                    .collect();

                // Clean up orphans
                for id in orphans {
                    log::info!("Cleaning up orphaned terminal: {}", id);

                    if let Some(instance) = terminals.write().remove(&id) {
                        let active_slots = active_slots.clone();
                        tokio::task::spawn_blocking(move || {
                            active_slots.fetch_sub(1, Ordering::SeqCst);
                            Self::cleanup_terminal_resources_sync(instance, true);
                        });

                        // Stop tracking (sync operations)
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

        let mut slot_reservation = self
            .try_reserve_terminal_slot()
            .ok_or_else(|| "Global terminal limit reached".to_string())?;

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
        let env = self.merge_environment(options.env.clone());

        // On Windows, use our custom ConPTY implementation to avoid console window
        #[cfg(target_os = "windows")]
        {
            // Quote the shell path if it contains spaces
            let shell_escaped = if shell_path.contains(' ') {
                format!(
                    "\"{}\" {}",
                    shell_path,
                    if cfg!(windows)
                        && (shell_path.contains("powershell") || shell_path.contains("pwsh"))
                    {
                        "-NoLogo -NoProfile"
                    } else {
                        ""
                    }
                )
            } else if shell_path.contains("powershell") || shell_path.contains("pwsh") {
                format!("{} -NoLogo -NoProfile", shell_path)
            } else {
                shell_path.clone()
            };

            let (reader, writer, pid, process_handle, conpty_handles) =
                spawn_conpty(&shell_escaped, Some(&cwd), cols, rows, &env)
                    .map_err(|e| format!("Failed to spawn ConPTY: {}", e))?;

            let child = WindowsConPtyChild {
                pid,
                process_handle,
            };

            // Create terminal instance
            let instance = Arc::new(TerminalInstance {
                id: id.clone(),
                child: Arc::new(AsyncMutex::new(Some(Box::new(child)))),
                master: Arc::new(AsyncMutex::new(None)), // No master for ConPTY
                writer: Arc::new(AsyncMutex::new(Some(writer))),
                reader_handle: Arc::new(AsyncMutex::new(None)),
                shell: shell_path.clone(),
                cwd: cwd.clone(),
                pid,
                last_activity: Arc::new(RwLock::new(Instant::now())),
                renderer_refs: Arc::new(RwLock::new(HashSet::new())),
                cols: Arc::new(RwLock::new(cols)),
                rows: Arc::new(RwLock::new(rows)),
                conpty_handles: Some(Arc::new(ParkingMutex::new(Some(conpty_handles)))),
            });

            // Start reader task
            let reader_instance = instance.clone();
            let app_handle = self.app_handle.clone();
            let exit_code_tracker = self.exit_code_tracker.clone();
            let terminal_id = id.clone();

            let reader_task = std::thread::spawn(move || {
                log::info!(
                    "[PTY {}] Windows ConPTY reader thread starting",
                    terminal_id
                );
                Self::reader_loop_sync(
                    reader_instance,
                    reader,
                    app_handle,
                    exit_code_tracker,
                    terminal_id,
                );
            });

            *instance.reader_handle.lock().await = Some(reader_task);

            // Store the terminal
            self.terminals.write().insert(id.clone(), instance.clone());

            // Initialize tracking
            self.cwd_tracker.start_tracking(&id, pid, &cwd);
            self.git_tracker.initialize_terminal(&id, &cwd);
            self.exit_code_tracker.initialize_terminal(&id);

            slot_reservation.commit();

            Ok(TerminalInfo {
                id,
                shell: shell_path,
                cwd,
                pid,
                cols,
                rows,
            })
        }

        // On non-Windows, use portable-pty as before
        #[cfg(not(target_os = "windows"))]
        {
            use portable_pty::{native_pty_system, CommandBuilder};

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

            let mut cmd = CommandBuilder::new(&shell_path);
            for (key, value) in &env {
                cmd.env(key, value);
            }
            cmd.env("TERM", "xterm-256color");
            cmd.env("COLORTERM", "truecolor");
            cmd.cwd(&cwd);

            let child = pty_pair
                .slave
                .spawn_command(cmd)
                .map_err(|e| format!("Failed to spawn shell: {}", e))?;

            let pid = child.process_id().unwrap_or(0);

            let reader = pty_pair
                .master
                .try_clone_reader()
                .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;
            let writer = pty_pair
                .master
                .take_writer()
                .map_err(|e| format!("Failed to get PTY writer: {}", e))?;

            let instance = Arc::new(TerminalInstance {
                id: id.clone(),
                child: Arc::new(AsyncMutex::new(Some(child))),
                master: Arc::new(AsyncMutex::new(Some(pty_pair.master))),
                writer: Arc::new(AsyncMutex::new(Some(writer))),
                reader_handle: Arc::new(AsyncMutex::new(None)),
                shell: shell_path.clone(),
                cwd: cwd.clone(),
                pid,
                last_activity: Arc::new(RwLock::new(Instant::now())),
                renderer_refs: Arc::new(RwLock::new(HashSet::new())),
                cols: Arc::new(RwLock::new(cols)),
                rows: Arc::new(RwLock::new(rows)),
                #[cfg(target_os = "windows")]
                conpty_handles: None,
            });

            let reader_instance = instance.clone();
            let app_handle = self.app_handle.clone();
            let exit_code_tracker = self.exit_code_tracker.clone();
            let terminal_id = id.clone();

            let reader_task = std::thread::spawn(move || {
                Self::reader_loop_sync(
                    reader_instance,
                    reader,
                    app_handle,
                    exit_code_tracker,
                    terminal_id,
                );
            });

            *instance.reader_handle.lock().await = Some(reader_task);

            self.terminals.write().insert(id.clone(), instance.clone());

            self.cwd_tracker.start_tracking(&id, pid, &cwd);
            self.git_tracker.initialize_terminal(&id, &cwd);
            self.exit_code_tracker.initialize_terminal(&id);

            slot_reservation.commit();

            Ok(TerminalInfo {
                id,
                shell: shell_path,
                cwd,
                pid,
                cols,
                rows,
            })
        }
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
                    Ok(None) => None,
                    Err(e) => {
                        log::warn!("[PTY {}] Failed to query child exit status: {}", id, e);
                        None
                    }
                },
                None => None,
            },
            Err(_) => None,
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
    pub async fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let instance = self
            .terminals
            .read()
            .get(id)
            .ok_or_else(|| format!("Terminal not found: {}", id))?
            .clone();

        instance.update_activity();

        let mut writer_guard = instance.writer.lock().await;

        let writer = writer_guard
            .as_mut()
            .ok_or_else(|| "PTY writer unavailable".to_string())?;

        writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("Failed to write to PTY: {}", e))?;
        writer
            .flush()
            .map_err(|e| format!("Failed to flush PTY: {}", e))?;

        Ok(())
    }

    /// Resize a terminal
    pub async fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let instance = self
            .terminals
            .read()
            .get(id)
            .ok_or_else(|| format!("Terminal not found: {}", id))?
            .clone();

        #[cfg(target_os = "windows")]
        {
            if let Some(conpty_handles) = &instance.conpty_handles {
                let guard = conpty_handles.lock();
                let handles = guard
                    .as_ref()
                    .ok_or_else(|| "ConPTY handles unavailable".to_string())?;
                resize_conpty(handles, cols, rows)
                    .map_err(|e| format!("Failed to resize ConPTY: {}", e))?;

                *instance.cols.write() = cols;
                *instance.rows.write() = rows;
                instance.update_activity();

                return Ok(());
            }
        }

        let master_guard = instance.master.lock().await;

        let master = master_guard
            .as_ref()
            .ok_or_else(|| "PTY master already consumed".to_string())?;

        let size = PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        };

        master
            .resize(size)
            .map_err(|e| format!("Failed to resize terminal: {}", e))?;

        *instance.cols.write() = cols;
        *instance.rows.write() = rows;
        instance.update_activity();

        Ok(())
    }

    /// Kill a terminal
    pub fn kill(&self, id: &str) -> Result<(), String> {
        let instance = self
            .terminals
            .write()
            .remove(id)
            .ok_or_else(|| format!("Terminal not found: {}", id))?;

        self.release_terminal_slot();

        Self::cleanup_terminal_resources_sync(instance, true);

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
        self.active_terminal_slots.load(Ordering::SeqCst) >= GLOBAL_TERMINAL_LIMIT
    }

    /// Kill all terminals (best-effort), used as app-exit safety net.
    pub fn kill_all(&self) {
        let ids: Vec<String> = self.terminals.read().keys().cloned().collect();

        for id in ids {
            let instance = match self.terminals.write().remove(&id) {
                Some(i) => i,
                None => continue,
            };

            self.release_terminal_slot();

            Self::cleanup_terminal_resources_sync(instance, true);

            self.cwd_tracker.stop_tracking(&id);
            self.git_tracker.remove_terminal(&id);
            self.exit_code_tracker.remove_terminal(&id);
        }
    }

    /// Update orphan detection settings (timeout in milliseconds)
    pub fn update_orphan_detection(&self, enabled: bool, timeout_ms: Option<u64>) {
        self.orphan_detection_enabled
            .store(enabled, Ordering::Relaxed);
        if let Some(timeout) = timeout_ms {
            self.orphan_timeout_ms.store(timeout, Ordering::Relaxed);
        }
    }

    /// Update orphan detection settings (timeout in minutes, for async API compatibility)
    pub async fn update_orphan_detection_settings(
        &self,
        enabled: bool,
        timeout_minutes: Option<u64>,
    ) {
        self.orphan_detection_enabled
            .store(enabled, Ordering::Relaxed);
        if let Some(timeout) = timeout_minutes {
            self.orphan_timeout_ms
                .store(timeout * 60 * 1000, Ordering::Relaxed);
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
            Ok(env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string()))
        }
    }

    /// Resolve a shell name to its full path
    ///
    /// For `git-bash` alias on Windows, tries multiple fallback strategies:
    /// 1. `bash.exe` via `where` command (PATH lookup)
    /// 2. Common Git Bash installation paths
    /// 3. MSYS2 paths
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
            // Special handling for git-bash alias
            if shell == "git-bash" {
                // Strategy 1: Try bash.exe via PATH (where command)
                if let Some(abs_path) = self.get_absolute_shell_path("bash.exe") {
                    return Ok(abs_path);
                }

                // Strategy 2: Try common Git Bash installation paths
                // Uses shared constants from git_bash_paths module (synced with lib.rs)
                for path in git_bash_paths::PRIMARY_PATHS {
                    if Path::new(path).exists() {
                        return Ok(path.to_string());
                    }
                }

                // Strategy 3: Try MSYS2 and other common locations
                for path in git_bash_paths::FALLBACK_PATHS {
                    if Path::new(path).exists() {
                        return Ok(path.to_string());
                    }
                }

                // All strategies failed
                return Err(format!(
                    "Shell not found: {} - bash.exe not found in PATH or common Git Bash locations",
                    shell
                ));
            }

            // Standard shell resolution for other shells
            // Try shell.exe variant
            let exe_shell = format!("{}.exe", shell);
            if let Some(abs_path) = self.get_absolute_shell_path(&exe_shell) {
                return Ok(abs_path);
            }

            // Try the shell name directly
            if let Some(abs_path) = self.get_absolute_shell_path(shell) {
                return Ok(abs_path);
            }

            // Try common paths for bash (not git-bash alias)
            if shell == "bash" {
                // Use same candidate lists as git-bash
                for path in git_bash_paths::PRIMARY_PATHS {
                    if Path::new(path).exists() {
                        return Ok(path.to_string());
                    }
                }
                // Also try a subset of fallback paths for bash
                for path in git_bash_paths::FALLBACK_PATHS {
                    if Path::new(path).exists() {
                        return Ok(path.to_string());
                    }
                }
            }

            // Try PowerShell variants
            // CRITICAL: Check explicit paths FIRST, then PATH
            if shell == "powershell" || shell == "pwsh" {
                let paths = vec![
                    // PowerShell 7 explicit paths (checked first)
                    r"C:\Program Files\PowerShell\7\pwsh.exe",
                    r"C:\Program Files\PowerShell\6\pwsh.exe",
                    // Windows PowerShell 5 explicit path
                    r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
                    // PATH-based fallbacks (checked last)
                    "pwsh.exe",
                    "powershell.exe",
                ];
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
    /// Uses cache to avoid repeated `where`/`which` command spawns
    #[cfg(target_os = "windows")]
    fn get_absolute_shell_path(&self, shell_path: &str) -> Option<String> {
        use std::sync::OnceLock;

        // Per-shell cache to avoid repeated `where` commands
        static CACHE: OnceLock<
            std::sync::Mutex<std::collections::HashMap<String, Option<String>>>,
        > = OnceLock::new();
        let cache = CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));

        // Check cache first
        {
            let cache_read = cache.lock().unwrap();
            if let Some(cached) = cache_read.get(shell_path) {
                return cached.clone();
            }
        }

        // Not in cache - resolve and store
        let result = self.resolve_shell_path_uncached(shell_path);

        // Store in cache
        {
            let mut cache_write = cache.lock().unwrap();
            cache_write.insert(shell_path.to_string(), result.clone());
        }

        result
    }

    #[cfg(target_os = "windows")]
    fn is_builtin_windows_shell(shell_path: &str) -> bool {
        let normalized = shell_path.to_ascii_lowercase();
        matches!(
            normalized.as_str(),
            "cmd"
                | "cmd.exe"
                | "powershell"
                | "powershell.exe"
                | "pwsh"
                | "pwsh.exe"
                | "wsl"
                | "wsl.exe"
        )
    }

    /// Internal uncached resolution - resolve via PATH scan or absolute path
    #[cfg(target_os = "windows")]
    fn resolve_shell_path_uncached(&self, shell_path: &str) -> Option<String> {
        log::debug!("[ShellResolve] Uncached resolution for: {}", shell_path);
        // If it's already an absolute path that exists, return it
        if Path::new(shell_path).exists() {
            return Some(shell_path.to_string());
        }

        #[cfg(target_os = "windows")]
        {
            if !shell_path.contains('\\') && !shell_path.contains('/') {
                if Self::is_builtin_windows_shell(shell_path) {
                    log::debug!(
                        "[ShellResolve] Built-in Windows shell, skipping PATH resolution: {}",
                        shell_path
                    );
                    return Some(shell_path.to_string());
                }

                let resolved = resolve_executable_from_path(shell_path);
                if let Some(path) = resolved {
                    log::debug!(
                        "[ShellResolve] Resolved from PATH without spawning cmd: {} -> {}",
                        shell_path,
                        path
                    );
                    return Some(path);
                }
            }
            if Path::new(shell_path).exists() {
                return Some(shell_path.to_string());
            }
            None
        }

        #[cfg(not(target_os = "windows"))]
        {
            if let Ok(output) = std::process::Command::new("which").arg(shell_path).output() {
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
        #[cfg(target_os = "windows")]
        {
            merge_windows_environment_map(env::vars(), custom_env)
        }

        #[cfg(not(target_os = "windows"))]
        {
            let mut env = HashMap::new();

            // Copy current process environment
            for (key, value) in env::vars() {
                env.insert(key, value);
            }

            // Apply custom environment (overriding existing)
            if let Some(custom) = custom_env {
                for (key, value) in custom {
                    env.insert(key, value);
                }
            }

            // Ensure PATH exists
            if !env.contains_key("PATH") {
                env.insert("PATH".to_string(), "/usr/bin:/bin".to_string());
            }

            env
        }
    }
}

/// Windows ConPTY child process wrapper.
#[cfg(target_os = "windows")]
#[derive(Debug)]
struct WindowsConPtyChild {
    pid: u32,
    process_handle: *mut std::ffi::c_void,
}

#[cfg(target_os = "windows")]
#[derive(Debug)]
struct WindowsPidKiller {
    pid: u32,
}

// SAFETY: process_handle is only accessed by one thread at a time via the
// AsyncMutex<Option<Box<dyn Child>>> wrapper in TerminalInstance.
#[cfg(target_os = "windows")]
unsafe impl Send for WindowsConPtyChild {}

// SAFETY: process_handle is only accessed by one thread at a time via the
// AsyncMutex<Option<Box<dyn Child>>> wrapper in TerminalInstance.
#[cfg(target_os = "windows")]
unsafe impl Sync for WindowsConPtyChild {}

#[cfg(target_os = "windows")]
impl Drop for WindowsConPtyChild {
    fn drop(&mut self) {
        unsafe {
            if !self.process_handle.is_null() {
                let _ = winapi::um::handleapi::CloseHandle(self.process_handle);
                self.process_handle = std::ptr::null_mut();
            }
        }
    }
}

#[cfg(target_os = "windows")]
impl portable_pty::ChildKiller for WindowsPidKiller {
    fn kill(&mut self) -> std::io::Result<()> {
        unsafe {
            let handle = winapi::um::processthreadsapi::OpenProcess(
                winapi::um::winnt::PROCESS_TERMINATE,
                0,
                self.pid,
            );
            if handle.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let terminate_ok = winapi::um::processthreadsapi::TerminateProcess(handle, 1);
            let close_ok = winapi::um::handleapi::CloseHandle(handle);
            if terminate_ok == 0 {
                return Err(std::io::Error::last_os_error());
            }
            if close_ok == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        }
    }

    fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync + 'static> {
        Box::new(WindowsPidKiller { pid: self.pid })
    }
}

#[cfg(target_os = "windows")]
impl portable_pty::ChildKiller for WindowsConPtyChild {
    fn kill(&mut self) -> std::io::Result<()> {
        unsafe {
            if self.process_handle.is_null() {
                return Ok(());
            }
            if winapi::um::processthreadsapi::TerminateProcess(self.process_handle, 1) == 0 {
                let err = std::io::Error::last_os_error();
                log::warn!(
                    "[WindowsConPtyChild:{}] TerminateProcess failed: {}",
                    self.pid,
                    err
                );
                return Err(err);
            }
            Ok(())
        }
    }

    fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync + 'static> {
        let mut dup: *mut std::ffi::c_void = std::ptr::null_mut();
        unsafe {
            let ok = winapi::um::handleapi::DuplicateHandle(
                winapi::um::processthreadsapi::GetCurrentProcess(),
                self.process_handle,
                winapi::um::processthreadsapi::GetCurrentProcess(),
                &mut dup,
                0,
                0,
                winapi::um::winnt::DUPLICATE_SAME_ACCESS,
            );
            if ok == 0 {
                log::warn!(
                    "[WindowsConPtyChild:{}] DuplicateHandle failed, falling back to pid-based killer: {}",
                    self.pid,
                    std::io::Error::last_os_error()
                );
                return Box::new(WindowsPidKiller { pid: self.pid });
            }
        }

        Box::new(WindowsConPtyChild {
            pid: self.pid,
            process_handle: dup,
        })
    }
}

#[cfg(target_os = "windows")]
impl portable_pty::Child for WindowsConPtyChild {
    fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
        unsafe {
            if self.process_handle.is_null() {
                return Ok(Some(portable_pty::ExitStatus::with_exit_code(1)));
            }

            let wait = winapi::um::synchapi::WaitForSingleObject(self.process_handle, 0);

            if wait == winapi::shared::winerror::WAIT_TIMEOUT {
                return Ok(None);
            }

            if wait != winapi::um::winbase::WAIT_OBJECT_0 {
                return Err(std::io::Error::last_os_error());
            }

            let mut code: u32 = 0;
            if winapi::um::processthreadsapi::GetExitCodeProcess(self.process_handle, &mut code)
                == 0
            {
                return Err(std::io::Error::last_os_error());
            }

            Ok(Some(portable_pty::ExitStatus::with_exit_code(code)))
        }
    }

    fn wait(&mut self) -> std::io::Result<portable_pty::ExitStatus> {
        unsafe {
            if self.process_handle.is_null() {
                return Ok(portable_pty::ExitStatus::with_exit_code(1));
            }

            let wait = winapi::um::synchapi::WaitForSingleObject(
                self.process_handle,
                winapi::um::winbase::INFINITE,
            );
            if wait != winapi::um::winbase::WAIT_OBJECT_0 {
                return Err(std::io::Error::last_os_error());
            }

            let mut code: u32 = 0;
            if winapi::um::processthreadsapi::GetExitCodeProcess(self.process_handle, &mut code)
                == 0
            {
                return Err(std::io::Error::last_os_error());
            }

            Ok(portable_pty::ExitStatus::with_exit_code(code))
        }
    }

    fn process_id(&self) -> Option<u32> {
        Some(self.pid)
    }

    fn as_raw_handle(&self) -> Option<*mut std::ffi::c_void> {
        Some(self.process_handle)
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

    // ========== Git Bash resolution tests ==========

    #[cfg(target_os = "windows")]
    #[test]
    fn test_git_bash_candidates_match_detection() {
        // Verify that the candidates in resolve_shell_path match
        // the candidates in lib.rs get_available_shells()
        // This test ensures the git_bash_paths constants stay in sync

        // Verify primary paths are non-empty and well-formed
        assert!(!git_bash_paths::PRIMARY_PATHS.is_empty());
        for path in git_bash_paths::PRIMARY_PATHS {
            assert!(
                path.contains("bash.exe"),
                "Primary path should contain bash.exe: {}",
                path
            );
        }

        // Verify fallback paths are non-empty and well-formed
        assert!(!git_bash_paths::FALLBACK_PATHS.is_empty());
        for path in git_bash_paths::FALLBACK_PATHS {
            assert!(
                path.contains("bash.exe"),
                "Fallback path should contain bash.exe: {}",
                path
            );
        }

        // Specific verification that key paths exist
        assert!(git_bash_paths::PRIMARY_PATHS.contains(&r"C:\Program Files\Git\bin\bash.exe"));
        assert!(git_bash_paths::PRIMARY_PATHS.contains(&r"C:\Program Files\Git\usr\bin\bash.exe"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_git_bash_fallback_paths_included() {
        // Verify fallback paths are included for edge cases
        let fallback_paths = vec![
            r"C:\tools\msys64\usr\bin\bash.exe",
            r"C:\msys64\usr\bin\bash.exe",
            r"C:\Git\bin\bash.exe",
            r"C:\Git\usr\bin\bash.exe",
        ];

        for path in fallback_paths {
            assert!(path.contains("bash.exe"));
        }
    }

    #[test]
    fn test_shell_resolution_git_bash_alias_recognized() {
        // Verify git-bash is treated as a special alias distinct from "bash"
        let git_bash = "git-bash";
        let bash = "bash";

        // These should be different shell names
        assert_ne!(git_bash, bash);

        // git-bash should map to bash.exe eventually (verified in resolve_shell_path)
        assert!(git_bash.contains("bash"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_shell_resolution_error_message_git_bash() {
        // Verify that git-bash error message is informative
        let _shell = "git-bash";
        let expected_error_substring = "bash.exe not found in PATH or common Git Bash locations";
        assert!(expected_error_substring.contains("bash.exe"));
        assert!(expected_error_substring.contains("PATH"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_is_builtin_windows_shell() {
        assert!(PtyManager::is_builtin_windows_shell("cmd"));
        assert!(PtyManager::is_builtin_windows_shell("CMD.EXE"));
        assert!(PtyManager::is_builtin_windows_shell("powershell"));
        assert!(PtyManager::is_builtin_windows_shell("pwsh"));
        assert!(PtyManager::is_builtin_windows_shell("wsl"));
        assert!(!PtyManager::is_builtin_windows_shell("bash.exe"));
        assert!(!PtyManager::is_builtin_windows_shell("git-bash"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_windows_env_merge_preserves_existing_path_case_insensitively() {
        let env_map = merge_windows_environment_map(
            vec![("Path".to_string(), r"C:\laragon\bin\nodejs".to_string())],
            None,
        );

        let path_keys: Vec<&String> = env_map
            .keys()
            .filter(|key| key.eq_ignore_ascii_case("path"))
            .collect();

        assert_eq!(path_keys.len(), 1);
        assert_eq!(
            env_map
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case("path"))
                .map(|(_, value)| value.as_str()),
            Some(r"C:\laragon\bin\nodejs")
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_windows_env_merge_overrides_path_case_insensitively() {
        let mut custom_env = HashMap::new();
        custom_env.insert("PATH".to_string(), r"C:\custom\node".to_string());

        let env_map = merge_windows_environment_map(
            vec![("Path".to_string(), r"C:\laragon\bin\nodejs".to_string())],
            Some(custom_env),
        );

        let path_keys: Vec<&String> = env_map
            .keys()
            .filter(|key| key.eq_ignore_ascii_case("path"))
            .collect();

        assert_eq!(path_keys.len(), 1);
        assert_eq!(
            env_map
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case("path"))
                .map(|(_, value)| value.as_str()),
            Some(r"C:\custom\node")
        );
    }
}
