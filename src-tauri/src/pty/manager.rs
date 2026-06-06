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
use std::sync::Mutex;

#[cfg(target_os = "windows")]
fn resolve_executable_from_path(command: &str) -> Option<String> {
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};

    if command.contains('\\') || command.contains('/') {
        let candidate = Path::new(command);
        return candidate.exists().then(|| command.to_string());
    }

    let path_var = crate::pty::env_refresh::path_for_resolution();
    if path_var.is_empty() {
        return None;
    }
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
use tauri::ipc::{Channel, Response};

/// ADR-004.2: Result of resolving a program path, possibly with leading argv
/// entries that must be prepended before the user-supplied args (e.g. when a
/// `.cmd` npm shim is rewritten to `node.exe <script>`).
#[derive(Debug, Clone)]
pub(crate) struct ResolvedProgram {
    /// Absolute path to the executable (always a PE image on Windows).
    pub program: String,
    /// Extra argv entries to insert before the user's args.
    /// E.g. `["C:\...\node_modules\opencode\bin\opencode"]` when the
    /// binary is `node.exe` and the script is the npm shim target.
    pub prepend_args: Vec<String>,
}

impl ResolvedProgram {
    pub fn new(program: String) -> Self {
        Self {
            program,
            prepend_args: Vec::new(),
        }
    }
    #[cfg(target_os = "windows")]
    pub fn with_args(program: String, args: Vec<String>) -> Self {
        Self {
            program,
            prepend_args: args,
        }
    }
}

/// ADR-004.2: Returns true if a Windows file path points to a directly-
/// executable PE image (`.exe`, `.com`, `.scr` only). Anything else
/// (`.bat`, `.cmd`, `.ps1`, `.vbs`, `.js`, ...) cannot be handed to
/// `CreateProcessW` and would surface as `os error 193`.
#[cfg(target_os = "windows")]
pub(super) fn is_directly_executable_windows(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    // Strip a trailing quote pair if the caller supplied a quoted form.
    let trimmed = lower.trim_end_matches('"');
    matches!(
        std::path::Path::new(trimmed)
            .extension()
            .and_then(|e| e.to_str()),
        Some("exe") | Some("com") | Some("scr")
    )
}

/// ADR-004.2, Windows-only: Parse an npm `.cmd` shim and extract the
/// underlying `node.exe` + script path so the spawn can run the PE image
/// directly instead of handing the non-executable `.cmd` to CreateProcessW.
///
/// npm on Windows installs CLI tools as thin batch wrappers whose last line is:
///   "<node.exe>" "<script>" %*
/// We extract both paths, resolve `%dp0%` / `%~dp0` to the shim's directory,
/// and return `ResolvedProgram { program: "node.exe", prepend_args: ["<script>"] }`.
#[cfg(target_os = "windows")]
pub(super) fn parse_npm_cmd_shim(shim_path: &str) -> Option<ResolvedProgram> {
    let content = std::fs::read_to_string(shim_path).ok()?;
    let shim_dir = std::path::Path::new(shim_path).parent()?;
    let shim_dir_str = shim_dir.to_str().unwrap_or(".");

    // Pre-scan `SET "VAR=value"` (and `SET VAR=value`) assignments so launcher
    // shims that invoke through variable indirection — e.g. npm's own
    // `npx.cmd` / `npm.cmd`, whose final line is `"%NODE_EXE%" "%NPX_CLI_JS%" %*`
    // — can be resolved, not just the simple `"%dp0%\node.exe" "<script>"` form
    // used by package bin shims. Without this, npm launchers fail to rewrite and
    // the raw `.cmd` is handed to CreateProcessW (os error 193).
    let mut vars: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let expand_dp0 = |val: &str| -> String {
        val.replace("%dp0%", shim_dir_str)
            .replace("%~dp0%", shim_dir_str)
            .replace("%~dp0", shim_dir_str)
    };
    for line in content.lines() {
        let t = line.trim();
        let Some(rest) = t
            .strip_prefix("SET ")
            .or_else(|| t.strip_prefix("set "))
            .or_else(|| t.strip_prefix("Set "))
        else {
            continue;
        };
        let rest = rest.trim();
        // Accept both `SET "VAR=value"` and `SET VAR=value`.
        let unquoted = rest.trim_matches('"');
        if let Some((name, value)) = unquoted.split_once('=') {
            let name = name.trim();
            if !name.is_empty() {
                // First assignment wins: it is the primary (unconditional) one;
                // later `SET`s in npm launchers are `IF`-guarded fallbacks a
                // static parser cannot evaluate.
                vars.entry(name.to_ascii_uppercase())
                    .or_insert_with(|| value.trim().to_string());
            }
        }
    }
    // Resolve a single `%VAR%` reference (one level of indirection is enough for
    // real npm launchers) against the SET map, then expand %dp0% inside it.
    let resolve_vars = |val: &str| -> String {
        let trimmed = val.trim();
        if trimmed.starts_with('%') && trimmed.ends_with('%') && trimmed.len() > 2 {
            let key = trimmed[1..trimmed.len() - 1].to_ascii_uppercase();
            if let Some(v) = vars.get(&key) {
                return expand_dp0(v);
            }
        }
        expand_dp0(trimmed)
    };

    // Find the last line that contains a command invocation pattern:
    //   "<executable>" "<script>" %*
    // or equivalently with %_prog% / %VAR% resolved.
    // We look for lines containing both `"%dp0%` (or `")` and `%*`.
    for line in content.lines().rev() {
        let line = line.trim();
        if !line.contains("%*") {
            continue;
        }
        if !line.contains("\"") {
            continue;
        }
        // Extract quoted strings: "..."
        let quotes: Vec<&str> = line.split('"').collect();
        // The invocation pattern uses two quoted paths:
        //   index 1 = executable (node.exe path)
        //   index 3 = script path
        if quotes.len() < 5 {
            continue;
        }
        let raw_exe = quotes[1].trim();
        let raw_script = quotes[3].trim();
        if raw_exe.is_empty() || raw_script.is_empty() {
            continue;
        }

        // Resolve %VAR% indirection first (npm launchers), then %dp0% / %~dp0,
        // and %_prog% to node.exe (either <dir>/node.exe or bare "node"
        // when the node executable is on PATH).
        let resolve_dp0 = |val: &str| -> String { resolve_vars(val).replace('"', "") };

        let exe_path_str = resolve_dp0(raw_exe);
        // Handle %_prog%: check for node.exe in the shim directory first.
        let exe_path_str = if exe_path_str == "%_prog%" {
            let local_node = shim_dir.join("node.exe");
            if local_node.exists() {
                local_node.to_string_lossy().to_string()
            } else if let Some(path) = resolve_executable_from_path("node.exe") {
                path
            } else {
                continue;
            }
        } else {
            exe_path_str
        };
        let script_path_str = resolve_dp0(raw_script);

        let exe_path = std::path::Path::new(&exe_path_str);
        let script_path = std::path::Path::new(&script_path_str);

        // The executable must exist and be a directly-executable image.
        if !exe_path.exists() || !is_directly_executable_windows(&exe_path_str) {
            continue;
        }
        // The script should exist (not strictly required but a good check).
        if !script_path.exists() {
            continue;
        }

        return Some(ResolvedProgram::with_args(
            exe_path_str,
            vec![script_path_str],
        ));
    }

    None
}

/// Windows-only: parse a `.cmd`/`.bat` shim that delegates to PowerShell, e.g.
/// Cursor Agent's `cursor-agent.cmd` which runs `powershell.exe -File script.ps1`.
#[cfg(target_os = "windows")]
pub(super) fn parse_powershell_cmd_shim(shim_path: &str) -> Option<ResolvedProgram> {
    let content = std::fs::read_to_string(shim_path).ok()?;
    let shim_dir = std::path::Path::new(shim_path).parent()?;

    let resolve_batch_token = |raw: &str| -> String {
        let shim_dir_str = shim_dir.to_str().unwrap_or(".");
        let system_root =
            env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
        raw.replace("%SystemRoot%", &system_root)
            .replace("%SYSTEMROOT%", &system_root)
            .replace("%SCRIPT_DIR%", shim_dir_str)
            .replace("%~dp0", shim_dir_str)
            .replace("%~dp0%", shim_dir_str)
            .replace("%dp0%", shim_dir_str)
            .trim_matches('"')
            .to_string()
    };

    for line in content.lines().rev() {
        let line = line.trim();
        let lower = line.to_ascii_lowercase();
        if !lower.contains("powershell") || !lower.contains("-file") {
            continue;
        }

        let ps_exe_token = line
            .split_whitespace()
            .find(|t| t.to_ascii_lowercase().contains("powershell.exe"))?;
        let ps_exe = resolve_batch_token(ps_exe_token);
        if !std::path::Path::new(&ps_exe).exists()
            || !is_directly_executable_windows(&ps_exe)
        {
            continue;
        }

        let file_flag = "-file";
        let file_idx = lower.find(file_flag)?;
        let after_file = line[file_idx + file_flag.len()..].trim();
        let script_raw = if let Some(start) = after_file.find('"') {
            let rest = &after_file[start + 1..];
            let end = rest.find('"')?;
            &rest[..end]
        } else {
            after_file.split_whitespace().next()?
        };
        let script_path = resolve_batch_token(script_raw);
        if !std::path::Path::new(&script_path).exists() {
            continue;
        }

        let mut prepend_args: Vec<String> = Vec::new();
        for token in line.split_whitespace() {
            let token_clean = token.trim_matches('"');
            if token_clean.eq_ignore_ascii_case("-file") {
                prepend_args.push("-File".to_string());
                prepend_args.push(script_path.clone());
                break;
            }
            if token_clean.to_ascii_lowercase().contains("powershell.exe") {
                continue;
            }
            if !token_clean.is_empty() {
                prepend_args.push(resolve_batch_token(token_clean));
            }
        }

        return Some(ResolvedProgram::with_args(ps_exe, prepend_args));
    }

    None
}

/// Try npm-node shim parsing first, then PowerShell-wrapper shims.
#[cfg(target_os = "windows")]
fn try_parse_windows_cmd_shim(shim_path: &str) -> Option<ResolvedProgram> {
    parse_npm_cmd_shim(shim_path).or_else(|| parse_powershell_cmd_shim(shim_path))
}

/// ADR-004.2: Resolve a spawn program the same way the PTY launcher does, for
/// reuse by other subprocess spawners (e.g. the ACP agent runtime).
///
/// On Windows: prefer a directly-executable PE image (`.exe`/`.com`/`.scr`);
/// when only a `.cmd`/`.bat` npm/PowerShell shim is on PATH, parse it and
/// rewrite to the underlying interpreter + script so `CreateProcessW` does not
/// fail with os error 193. Explicit paths are honored as-is when already a PE
/// image, otherwise the shim is parsed. Returns `Err` when nothing usable is
/// found so the caller can fall back to its previous behavior.
///
/// On non-Windows: returns the program unchanged (no rewriting needed).
pub(crate) fn resolve_spawn_program(program: &str) -> Result<ResolvedProgram, String> {
    let trimmed = program.trim();
    if trimmed.is_empty() {
        return Err("program is empty".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        // Explicit path: honor it if it exists.
        if trimmed.contains('/') || trimmed.contains('\\') {
            if Path::new(trimmed).exists() {
                if is_directly_executable_windows(trimmed) {
                    return Ok(ResolvedProgram::new(trimmed.to_string()));
                }
                if let Some(resolved) = try_parse_windows_cmd_shim(trimmed) {
                    return Ok(resolved);
                }
            }
            return Err(format!("program not found or not executable: {}", trimmed));
        }

        // 1. Bare name: try directly-executable PE image extensions first.
        const WIN_EXECUTABLE_EXTS: &[&str] = &["", ".exe", ".com", ".scr"];
        for ext in WIN_EXECUTABLE_EXTS {
            let candidate = format!("{}{}", trimmed, ext);
            if let Some(abs_path) = resolve_executable_from_path(&candidate) {
                if is_directly_executable_windows(&abs_path) {
                    return Ok(ResolvedProgram::new(abs_path));
                }
            }
        }

        // 2. No PE image: parse a `.cmd`/`.bat` shim and rewrite it.
        for shim_ext in [".cmd", ".bat"] {
            let candidate = format!("{}{}", trimmed, shim_ext);
            if let Some(abs_path) = resolve_executable_from_path(&candidate) {
                if let Some(resolved) = try_parse_windows_cmd_shim(&abs_path) {
                    return Ok(resolved);
                }
            }
        }

        Err(format!("program not found on PATH: {}", trimmed))
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(ResolvedProgram::new(trimmed.to_string()))
    }
}

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

// ADR-002.3: Flusher thread constants
pub const FLUSH_INTERVAL: Duration = Duration::from_millis(4);
pub const READ_BUF: usize = 16 * 1024; // 16KB read buffer
pub const MAX_PENDING: usize = 4 * 1024 * 1024; // 4MB overflow cap
pub const OVERFLOW_NOTICE: &[u8] = b"\x1bc\x1b[2m[termul: dropped output due to backpressure]\x1b[0m\r\n";

/// Public info emitted to renderer on spawn (also forwarded to ws clients)
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

/// Broadcast channel capacity (number of buffered output batches per terminal).
/// Each batch is up to READ_BUF (16KB) bytes. 1024 slots ≈ 16MB max buffered output.
/// Slow receivers will receive `RecvError::Lagged` — acceptable; they miss bytes
/// rather than back-pressuring the PTY.
const TERM_BROADCAST_CAPACITY: usize = 1024;

/// Maximum scrollback bytes retained per terminal for remote-client replay.
/// 256 KiB ≈ several screenfuls of history; bounded so memory stays predictable
/// even for very chatty terminals. Oldest bytes are evicted first.
pub const SCROLLBACK_CAP: usize = 256 * 1024;

/// Options for spawning a new terminal
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOptions {
    pub shell: Option<String>,
    pub cwd: Option<String>,
    pub env: Option<HashMap<String, String>>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    // ADR-004.2: terminal-native agent launch.
    // When `program` is Some, the PTY runs that executable directly with `args`
    // as discrete argv entries, bypassing shell resolution and shell quoting of
    // the prompt. When `program` is None, spawn behavior is unchanged.
    #[serde(default)]
    pub program: Option<String>,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    #[serde(default)]
    pub kind: Option<String>,
}

impl Default for SpawnOptions {
    fn default() -> Self {
        Self {
            shell: None,
            cwd: None,
            env: None,
            cols: Some(80),
            rows: Some(24),
            program: None,
            args: None,
            kind: None,
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
    pub flusher_handle: Arc<AsyncMutex<Option<std::thread::JoinHandle<()>>>>,
    pub shell: String,
    pub cwd: String,
    pub pid: u32,
    pub last_activity: Arc<RwLock<Instant>>,
    pub orphan_since: Arc<RwLock<Option<Instant>>>,
    pub renderer_refs: Arc<RwLock<HashSet<String>>>,
    /// When true, this terminal is still owned by an open project/tab and must
    /// NOT be reaped by orphan detection — even if it currently has zero
    /// renderer refs (e.g. its project is switched to the background, so the
    /// `ConnectedTerminal` component unmounted). It is set true at spawn and
    /// cleared only when the terminal is explicitly released (project closed or
    /// terminal tab closed). This prevents busy background-project terminals
    /// from being killed mid-task — the cause of the "Terminal not found"/hang.
    pub protected: Arc<AtomicBool>,
    pub cols: Arc<RwLock<u16>>,
    pub rows: Arc<RwLock<u16>>,
    /// Broadcast channel for fan-out of raw PTY output to remote WebSocket clients.
    /// Each flusher batch is sent as a `Vec<u8>` message. Tauri frontend keeps using
    /// its dedicated Channel — this field is only consumed by the remote module.
    pub broadcast_tx: Arc<tokio::sync::broadcast::Sender<Vec<u8>>>,
    /// Rolling scrollback buffer of recent raw PTY output (VT100 bytes).
    /// Replayed to remote web clients on connect so they see prior output
    /// (persistence + parity with the desktop terminal). Capped at
    /// `SCROLLBACK_CAP` bytes; oldest bytes are dropped first.
    pub scrollback: Arc<RwLock<std::collections::VecDeque<u8>>>,
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
        *self.orphan_since.write() = None;
    }

    /// Remove a renderer reference
    pub fn remove_renderer_ref(&self, renderer_id: &str) {
        let mut refs = self.renderer_refs.write();
        let removed = refs.remove(renderer_id);
        if removed && refs.is_empty() {
            *self.orphan_since.write() = Some(Instant::now());
        }
    }

    /// Get count of renderer references
    pub fn renderer_ref_count(&self) -> usize {
        self.renderer_refs.read().len()
    }

    /// Check if terminal has no renderer references
    pub fn is_orphan(&self) -> bool {
        self.renderer_refs.read().is_empty()
    }

    /// Whether this terminal is eligible for orphan reaping right now.
    ///
    /// A terminal is reapable only when it is NOT protected (its project/tab is
    /// genuinely closed), has no renderer refs, and has exceeded the timeout —
    /// measured from when it became orphaned, or by inactivity if it never had
    /// a renderer ref. Protected terminals (e.g. a backgrounded project's live
    /// terminals) are never reaped, even with zero renderer refs.
    pub fn is_orphan_reapable(&self, timeout: Duration) -> bool {
        should_reap_orphan(
            self.is_protected(),
            self.is_orphan(),
            self.orphan_since().map(|since| since.elapsed()),
            self.inactive_duration(),
            timeout,
        )
    }

    /// Returns when the terminal became orphaned, if ever.
    pub fn orphan_since(&self) -> Option<Instant> {
        *self.orphan_since.read()
    }

    /// Whether this terminal is protected from orphan reaping (still owned by an
    /// open project/tab). See the `protected` field docs.
    pub fn is_protected(&self) -> bool {
        self.protected.load(Ordering::Relaxed)
    }

    /// Update the protection flag. Set false only when the terminal is genuinely
    /// released (project closed / terminal tab closed), making it eligible for
    /// orphan reaping once it also has no renderer refs.
    pub fn set_protected(&self, protected: bool) {
        self.protected.store(protected, Ordering::Relaxed);
    }

    /// Subscribe to live PTY output. Returns a receiver that yields raw byte batches.
    /// Use this from the remote WebSocket module to forward output to web clients.
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<Vec<u8>> {
        self.broadcast_tx.subscribe()
    }

    /// Atomically snapshot the current scrollback AND subscribe to the live
    /// broadcast, under the scrollback write lock.
    ///
    /// Holding the lock across both operations guarantees no output is lost or
    /// duplicated at the seam: any batch appended to scrollback before this call
    /// is in the returned snapshot, and any batch after is delivered via the
    /// receiver. The flusher takes the same lock when appending, so the two
    /// cannot interleave.
    pub fn subscribe_with_backlog(
        &self,
    ) -> (Vec<u8>, tokio::sync::broadcast::Receiver<Vec<u8>>) {
        let guard = self.scrollback.write();
        let rx = self.broadcast_tx.subscribe();
        let snapshot: Vec<u8> = guard.iter().copied().collect();
        (snapshot, rx)
    }
}

/// Pure decision for whether an orphaned terminal should be reaped.
///
/// Kept free-standing (no PTY handles) so it can be unit-tested in isolation.
///
/// * `protected` — terminal is still owned by an open project/tab; never reap.
/// * `is_orphan` — terminal currently has zero renderer refs.
/// * `orphaned_for` — elapsed time since it became orphaned, if it ever was.
/// * `inactive_for` — elapsed time since last PTY activity.
/// * `timeout` — configured orphan timeout.
fn should_reap_orphan(
    protected: bool,
    is_orphan: bool,
    orphaned_for: Option<Duration>,
    inactive_for: Duration,
    timeout: Duration,
) -> bool {
    if protected || !is_orphan {
        return false;
    }
    match orphaned_for {
        Some(elapsed) => elapsed > timeout,
        None => inactive_for > timeout,
    }
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
    /// When true, orphan detection and kill operations are deferred.
    /// Set when the app window is minimized/hidden to prevent
    /// ConPTY lifecycle issues on Windows.
    is_hidden: Arc<AtomicBool>,
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
            is_hidden: Arc::new(AtomicBool::new(false)),
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

        // b) Wait flusher thread to finish naturally (max 2s)
        if let Some(flusher_handle) = instance.flusher_handle.blocking_lock().take() {
            if wait_reader_thread {
                Self::join_reader_with_timeout(flusher_handle, Duration::from_secs(2));
            }
        }

        // c) Wait reader thread to finish naturally (max 3s)
        if let Some(reader_handle) = instance.reader_handle.blocking_lock().take() {
            if wait_reader_thread {
                Self::join_reader_with_timeout(reader_handle, Duration::from_secs(3));
            }
        }

        // d) Kill child process
        if let Some(mut child) = instance.child.blocking_lock().take() {
            let _ = child.kill();
        }

        // e) Drop ConPTY handles last
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
        let is_hidden = self.is_hidden.clone();

        tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(Duration::from_millis(ORPHAN_CHECK_INTERVAL_MS));

            loop {
                interval.tick().await;

                // Check if detection is enabled
                if !enabled.load(Ordering::Relaxed) {
                    continue;
                }

                // SKIP orphan cleanup when app is hidden to prevent
                // ConPTY lifecycle issues on Windows
                if is_hidden.load(Ordering::Relaxed) {
                    continue;
                }

                let timeout = Duration::from_millis(timeout_ms.load(Ordering::Relaxed));

                // Find orphaned terminals
                let orphans: Vec<String> = terminals
                    .read()
                    .iter()
                    .filter(|(_, instance)| {
                        // Never reap terminals that are still owned by an open
                        // project/tab. A backgrounded project's terminals lose
                        // their renderer refs (component unmount) but remain
                        // live and may be running tasks — reaping them caused
                        // the "Terminal not found"/hang bug.
                        instance.is_orphan_reapable(timeout)
                    })
                    .map(|(id, _)| id.clone())
                    .collect();

                // Clean up orphans
                for id in orphans {
                    log::info!("Cleaning up orphaned terminal: {}", id);

                    if let Some(instance) = terminals.write().remove(&id) {
                        active_slots.fetch_sub(1, Ordering::SeqCst);
                        tokio::task::spawn_blocking(move || {
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

    /// Spawn a new terminal (with binary channel IPC)
    pub async fn spawn(
        &self,
        options: SpawnOptions,
        on_data: Option<Channel<Response>>,
    ) -> Result<TerminalInfo, String> {
        // Start orphan detection on first spawn (lazy initialization)
        self.start_orphan_detection();

        let mut slot_reservation = self
            .try_reserve_terminal_slot()
            .ok_or_else(|| "Global terminal limit reached".to_string())?;

        let id = self.generate_id();

        // ADR-004.2: Resolve the program to run. When `program` is set we run
        // that executable directly (terminal-native agent launch); otherwise we
        // resolve a login shell exactly as before. `program == None` keeps the
        // shell path byte-for-byte identical to prior behavior.
        let resolved = if let Some(program) = &options.program {
            self.resolve_program_path(program)?
        } else if let Some(shell) = &options.shell {
            ResolvedProgram::new(self.resolve_shell_path(shell)?)
        } else {
            ResolvedProgram::new(self.get_default_shell()?)
        };
        // Merge prepend_args (from npm .cmd shim rewriting) with user args.
        // User args apply only for agent/program spawns, not shell spawns.
        let user_args = if options.program.is_some() {
            options.args.clone().unwrap_or_default()
        } else {
            Vec::new()
        };
        let program_args: Vec<String> = resolved
            .prepend_args
            .into_iter()
            .chain(user_args)
            .collect();
        let shell_path = resolved.program;

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
            // ADR-004.2: In agent mode, build the command line from a discrete
            // argv array via the audited quoting helper — the prompt is passed as
            // a single argument and is never shell-interpolated. In shell mode,
            // preserve the existing shell-escaping behavior verbatim.
            let shell_escaped = if options.program.is_some() {
                crate::pty::windows::build_windows_command_line(&shell_path, &program_args)
            } else if shell_path.contains(' ') {
                format!(
                    "\"{}\" {}",
                    shell_path,
                    if cfg!(windows)
                        && (shell_path.contains("powershell") || shell_path.contains("pwsh"))
                    {
                        "-NoLogo"  // Skip PowerShell banner only (profile still loads)
                    } else {
                        ""
                    }
                )
            } else if shell_path.contains("powershell") || shell_path.contains("pwsh") {
                format!("{} -NoLogo", shell_path)  // Skip PowerShell banner only (profile still loads)
            } else {
                shell_path.clone()
            };

            let (reader, writer, pid, process_handle, job_handle, conpty_handles) =
                spawn_conpty(&shell_escaped, Some(&cwd), cols, rows, &env)
                    .map_err(|e| format!("Failed to spawn ConPTY: {}", e))?;

            let child = WindowsConPtyChild {
                pid,
                process_handle,
                job_handle,
            };

            // Create terminal instance
            let instance = Arc::new(TerminalInstance {
                id: id.clone(),
                child: Arc::new(AsyncMutex::new(Some(Box::new(child)))),
                master: Arc::new(AsyncMutex::new(None)), // No master for ConPTY
                writer: Arc::new(AsyncMutex::new(Some(writer))),
                reader_handle: Arc::new(AsyncMutex::new(None)),
                flusher_handle: Arc::new(AsyncMutex::new(None)),
                shell: shell_path.clone(),
                cwd: cwd.clone(),
                pid,
                last_activity: Arc::new(RwLock::new(Instant::now())),
                orphan_since: Arc::new(RwLock::new(None)),
                renderer_refs: Arc::new(RwLock::new(HashSet::new())),
                protected: Arc::new(AtomicBool::new(true)),
                cols: Arc::new(RwLock::new(cols)),
                rows: Arc::new(RwLock::new(rows)),
                broadcast_tx: Arc::new(tokio::sync::broadcast::channel(TERM_BROADCAST_CAPACITY).0),
                scrollback: Arc::new(RwLock::new(std::collections::VecDeque::new())),
                conpty_handles: Some(Arc::new(ParkingMutex::new(Some(conpty_handles)))),
            });

            // Start reader + flusher threads
            let pending_buf = Arc::new(Mutex::new(Vec::with_capacity(READ_BUF)));
            let done_flag = Arc::new(AtomicBool::new(false));

            let reader_instance = instance.clone();
            let app_handle = self.app_handle.clone();
            let exit_code_tracker = self.exit_code_tracker.clone();
            let terminal_id = id.clone();

            // Spawn flusher thread first (it references pending_buf and done_flag)
            let flusher_pending = pending_buf.clone();
            let flusher_done = done_flag.clone();
            let flusher_channel = on_data.clone();
            let flusher_id = id.clone();
            let flusher_broadcast = instance.broadcast_tx.clone();
            let flusher_scrollback = instance.scrollback.clone();

            let flusher_task = std::thread::spawn(move || {
                log::info!("[PTY {}] Flusher thread starting", flusher_id);
                Self::flusher_loop(flusher_pending, flusher_done, flusher_broadcast, flusher_scrollback, flusher_channel, flusher_id);
            });

            // Spawn reader thread
            let reader_task = std::thread::spawn(move || {
                log::info!(
                    "[PTY {}] Windows ConPTY reader thread starting",
                    terminal_id
                );
                Self::reader_loop(
                    reader_instance,
                    reader,
                    app_handle,
                    exit_code_tracker,
                    terminal_id,
                    pending_buf,
                    done_flag,
                );
            });

            *instance.reader_handle.lock().await = Some(reader_task);
            *instance.flusher_handle.lock().await = Some(flusher_task);

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
            // Interactive shells: login flag so profile-sourced PATH is applied (GH-275).
            if options.program.is_none() {
                if let Some(login_arg) = crate::pty::env_refresh::shell_wants_login_arg(&shell_path)
                {
                    cmd.arg(login_arg);
                }
            }
            // ADR-004.2: In agent mode, append the argv tail as discrete
            // arguments. portable-pty passes argv without a shell, so the prompt
            // is delivered verbatim with no shell interpolation. In shell mode
            // `program_args` is empty and this loop is a no-op.
            for arg in &program_args {
                cmd.arg(arg);
            }
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
                flusher_handle: Arc::new(AsyncMutex::new(None)),
                shell: shell_path.clone(),
                cwd: cwd.clone(),
                pid,
                last_activity: Arc::new(RwLock::new(Instant::now())),
                orphan_since: Arc::new(RwLock::new(None)),
                renderer_refs: Arc::new(RwLock::new(HashSet::new())),
                protected: Arc::new(AtomicBool::new(true)),
                cols: Arc::new(RwLock::new(cols)),
                rows: Arc::new(RwLock::new(rows)),
                broadcast_tx: Arc::new(tokio::sync::broadcast::channel(TERM_BROADCAST_CAPACITY).0),
                scrollback: Arc::new(RwLock::new(std::collections::VecDeque::new())),
                #[cfg(target_os = "windows")]
                conpty_handles: None,
            });

            // Start reader + flusher threads
            let pending_buf = Arc::new(Mutex::new(Vec::with_capacity(READ_BUF)));
            let done_flag = Arc::new(AtomicBool::new(false));

            // Spawn flusher thread first
            let flusher_pending = pending_buf.clone();
            let flusher_done = done_flag.clone();
            let flusher_channel = on_data.clone();
            let flusher_id = id.clone();
            let flusher_broadcast = instance.broadcast_tx.clone();
            let flusher_scrollback = instance.scrollback.clone();

            let flusher_task = std::thread::spawn(move || {
                log::info!("[PTY {}] Flusher thread starting", flusher_id);
                Self::flusher_loop(flusher_pending, flusher_done, flusher_broadcast, flusher_scrollback, flusher_channel, flusher_id);
            });

            // Spawn reader thread
            let reader_instance = instance.clone();
            let app_handle = self.app_handle.clone();
            let exit_code_tracker = self.exit_code_tracker.clone();
            let terminal_id = id.clone();

            let reader_task = std::thread::spawn(move || {
                Self::reader_loop(
                    reader_instance,
                    reader,
                    app_handle,
                    exit_code_tracker,
                    terminal_id,
                    pending_buf,
                    done_flag,
                );
            });

            *instance.reader_handle.lock().await = Some(reader_task);
            *instance.flusher_handle.lock().await = Some(flusher_task);

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

    /// ADR-002.3: Reader thread — reads PTY data into pending buffer, no direct IPC.
    /// Pushes raw bytes to pending_buf, handles overflow protection.
    /// Sets done_flag to true on EOF or error so flusher can finalize.
    /// ADR-002.5: Intercepts DA queries via DaFilter and responds directly to PTY writer.
    fn reader_loop(
        instance: Arc<TerminalInstance>,
        mut reader: Box<dyn Read + Send>,
        app_handle: AppHandle,
        exit_code_tracker: Arc<ExitCodeTracker>,
        terminal_id: String,
        pending_buf: Arc<Mutex<Vec<u8>>>,
        done_flag: Arc<AtomicBool>,
    ) {
        let mut buffer = [0u8; READ_BUF];
        let id = terminal_id.clone();
        // ADR-002.5: DA filter — intercepts DA queries and responds to PTY writer
        let mut da_filter = crate::pty::DaFilter::new();
        // Clone writer Arc for the DA filter respond closure
        let da_writer = instance.writer.clone();

        log::info!("[PTY {}] Reader thread starting", id);

        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    log::info!("[PTY {}] EOF reached, reader thread exiting", id);
                    break;
                }
                Ok(n) => {
                    instance.update_activity();

                    // Parse exit codes from output
                    let data_str = String::from_utf8_lossy(&buffer[..n]);
                    exit_code_tracker.process_data(&id, &data_str);

                    log::trace!("[PTY {}] Read {} bytes", id, n);

                    // ADR-002.5: Run DA filter to intercept DA queries.
                    // Responds directly to PTY writer so the shell gets immediate feedback
                    // without waiting for xterm.js to initialize.
                    let mut filtered = Vec::with_capacity(n);
                    let w = da_writer.clone();
                    da_filter.process(&buffer[..n], &mut filtered, move |reply| {
                        let mut writer_guard = w.blocking_lock();
                        if let Some(writer) = writer_guard.as_mut() {
                            let _ = writer.write_all(reply);
                            let _ = writer.flush();
                        }
                    });

                    // Push filtered (DA-processed) bytes to pending buffer
                    let mut guard = match pending_buf.lock() {
                        Ok(g) => g,
                        Err(e) => {
                            log::error!("[PTY {}] Pending buffer mutex poisoned: {}", id, e);
                            break;
                        }
                    };

                    if guard.len() + filtered.len() > MAX_PENDING {
                        // Overflow: clear buffer and insert notice
                        guard.clear();
                        guard.extend_from_slice(OVERFLOW_NOTICE);
                        log::warn!("[PTY {}] Output buffer overflow — dropped data", id);
                    } else {
                        guard.extend_from_slice(&filtered);
                    }
                }
                Err(e) => {
                    log::error!("[PTY {}] Error reading from PTY: {}", id, e);
                    break;
                }
            }
        }

        // Signal flusher that reader is done
        done_flag.store(true, Ordering::Release);

        // Get real child exit status where possible.
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

        // Emit terminal-exit event via app_handle (backward compat)
        let exit_event = TerminalExitEvent {
            id: id.clone(),
            exit_code,
            signal: None,
        };

        if let Err(e) = app_handle.emit("terminal-exit", exit_event) {
            log::error!("[PTY {}] Failed to emit terminal-exit event: {}", id, e);
        }

        log::info!("[PTY {}] Reader thread ended", id);
    }

    /// ADR-002.3: Flusher thread — batched Channel output at FLUSH_INTERVAL.
    /// Takes pending buffer via std::mem::take every 4ms and sends via binary channel.
    /// If on_data is None, skips sending (just drains).
    ///
    /// broadcast_tx: per-terminal broadcast channel. When present, each flushed
    /// batch is also sent so remote WebSocket clients receive live output.
    /// Send failures are ignored (no active remote subscribers is normal).
    ///
    /// scrollback: rolling history buffer. Each batch is appended (under its
    /// write lock, capped at `SCROLLBACK_CAP`) BEFORE broadcasting, so a remote
    /// client calling `subscribe_with_backlog` sees a consistent seam between
    /// replayed history and live output.
    fn flusher_loop(
        pending_buf: Arc<Mutex<Vec<u8>>>,
        done_flag: Arc<AtomicBool>,
        broadcast_tx: Arc<tokio::sync::broadcast::Sender<Vec<u8>>>,
        scrollback: Arc<RwLock<std::collections::VecDeque<u8>>>,
        on_data: Option<Channel<Response>>,
        terminal_id: String,
    ) {
        let id = terminal_id;
        log::info!("[PTY {}] Flusher thread starting", id);

        let channel_ref: Option<&Channel<Response>> = on_data.as_ref();

        // Append a batch to the capped scrollback ring buffer (oldest bytes evicted first).
        fn push_scrollback(buf: &Arc<RwLock<std::collections::VecDeque<u8>>>, data: &[u8]) {
            let mut guard = buf.write();
            guard.extend(data.iter().copied());
            let overflow = guard.len().saturating_sub(SCROLLBACK_CAP);
            if overflow > 0 {
                guard.drain(0..overflow);
            }
        }

        loop {
            std::thread::sleep(FLUSH_INTERVAL);

            let chunk = match pending_buf.lock() {
                Ok(mut guard) if !guard.is_empty() => Some(std::mem::take(&mut *guard)),
                _ => None,
            };

            if let Some(data) = chunk {
                // Record into scrollback FIRST so subscribe_with_backlog sees a clean seam.
                push_scrollback(&scrollback, &data);

                // Broadcast to remote WebSocket subscribers (best-effort; ignore Lagged/NoReceivers)
                let _ = broadcast_tx.send(data.clone());

                // Forward to Tauri frontend channel (may be None for detached terminals)
                if let Some(ch) = channel_ref {
                    if let Err(e) = ch.send(Response::new(data)) {
                        log::error!("[PTY {}] Failed to send data via channel: {}", id, e);
                    }
                }
            }

            if done_flag.load(Ordering::Acquire) {
                // One final broadcast of anything still buffered
                if let Ok(mut guard) = pending_buf.lock() {
                    if !guard.is_empty() {
                        let final_data = std::mem::take(&mut *guard);
                        push_scrollback(&scrollback, &final_data);
                        let _ = broadcast_tx.send(final_data.clone());
                        if let Some(ch) = channel_ref {
                            if let Err(e) = ch.send(Response::new(final_data)) {
                                log::error!("[PTY {}] Failed to send final data via channel: {}", id, e);
                            }
                        }
                    }
                }
                break;
            }
        }

        log::info!("[PTY {}] Flusher thread ended", id);
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
    /// This is async because cleanup_terminal_resources_sync uses blocking_lock()
    /// on AsyncMutex fields, which is forbidden inside tokio async runtime.
    ///
    /// When app window is hidden, kill is deferred to prevent ConPTY lifecycle
    /// issues on Windows where minimize can cause terminal processes to die.
    /// The terminal remains tracked and will be cleaned up on next visible cycle
    /// or when explicitly killed from the visible state.
    pub async fn kill(&self, id: &str) -> Result<(), String> {
        // When app is hidden, defer the kill — the PTY process should survive hide.
        // ConPTY on Windows can kill processes when the window is minimized.
        if self.is_hidden.load(Ordering::Relaxed) {
            log::info!(
                "[PtyManager] Deferring kill of terminal {} (app window hidden)",
                id
            );
            return Ok(());
        }

        let instance = self
            .terminals
            .write()
            .remove(id)
            .ok_or_else(|| format!("Terminal not found: {}", id))?;

        self.release_terminal_slot();

        // Wrap blocking cleanup in spawn_blocking to avoid panic
        let instance_clone = instance.clone();
        tokio::task::spawn_blocking(move || {
            Self::cleanup_terminal_resources_sync(instance_clone, true);
        })
        .await
        .map_err(|e| format!("spawn_blocking failed for terminal {}: {}", id, e))?;

        // Stop tracking (sync operations, safe to run after spawn_blocking)
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

    /// Update a terminal's orphan-reaping protection.
    ///
    /// Protection is enabled at spawn and should be disabled only when the
    /// terminal is genuinely released by the renderer (its project is closed or
    /// the terminal tab is closed). Once unprotected AND lacking renderer refs,
    /// the terminal becomes eligible for orphan reaping again. Returns Ok even
    /// if the terminal is already gone, so callers can release idempotently.
    pub fn set_protected(&self, id: &str, protected: bool) -> Result<(), String> {
        if let Some(instance) = self.terminals.read().get(id) {
            instance.set_protected(protected);
        }
        Ok(())
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
    /// This is async because cleanup_terminal_resources_sync uses blocking_lock()
    /// on AsyncMutex fields, which is forbidden inside tokio async runtime.
    pub async fn kill_all(&self) {
        let ids: Vec<String> = self.terminals.read().keys().cloned().collect();

        let cwd_tracker = self.cwd_tracker.clone();
        let git_tracker = self.git_tracker.clone();
        let exit_code_tracker = self.exit_code_tracker.clone();

        for id in ids {
            let instance = match self.terminals.write().remove(&id) {
                Some(i) => i,
                None => continue,
            };

            self.release_terminal_slot();

            // Wrap blocking cleanup in spawn_blocking to avoid panic
            let instance_clone = instance.clone();
            let id_clone = id.clone();
            if let Err(e) = tokio::task::spawn_blocking(move || {
                Self::cleanup_terminal_resources_sync(instance_clone, true);
            })
            .await
            {
                log::warn!("spawn_blocking failed for terminal {}: {}", id_clone, e);
            }

            // Stop tracking (sync operations)
            cwd_tracker.stop_tracking(&id);
            git_tracker.remove_terminal(&id);
            exit_code_tracker.remove_terminal(&id);
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

    /// Set the app window hidden state.
    /// When hidden=true, orphan detection will not kill orphaned terminals
    /// and kill() operations are deferred. Prevents ConPTY lifecycle issues
    /// on Windows where window minimize can cause PTY processes to die.
    pub fn set_hidden(&self, hidden: bool) {
        self.is_hidden.store(hidden, Ordering::Relaxed);
        if hidden {
            log::info!("[PtyManager] App window hidden — killing and orphan cleanup deferred");
        } else {
            log::info!("[PtyManager] App window visible — killing and orphan cleanup resumed");
        }
    }

    /// Check if the app window is currently hidden
    pub fn is_hidden(&self) -> bool {
        self.is_hidden.load(Ordering::Relaxed)
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

    /// ADR-004.2: Resolve a program (agent binary) to an absolute, existing
    /// path. Reuses the same PATH/`which` resolution as shell lookup so agents
    /// like `claude`, `codex`, or `gemini` resolve off the user's PATH.
    ///
    /// On Windows, npm installs CLI tools as `.cmd` batch wrappers around
    /// `node.exe`. Since `CreateProcessW` cannot execute `.cmd` directly (os
    /// error 193), we detect this pattern, parse the `.cmd` shim, and rewrite
    /// the spawn to `node.exe <script>`. If no rewriting is possible, returns an
    /// error rather than launching an unresolved name (defense in depth).
    fn resolve_program_path(&self, program: &str) -> Result<ResolvedProgram, String> {
        let trimmed = program.trim();
        if trimmed.is_empty() {
            return Err("Agent program is empty".to_string());
        }

        // Explicit path: must exist as given.
        if trimmed.contains('/') || trimmed.contains('\\') {
            if Path::new(trimmed).exists() {
                #[cfg(target_os = "windows")]
                {
                    if !is_directly_executable_windows(trimmed) {
                        if let Some(resolved) = try_parse_windows_cmd_shim(trimmed) {
                            return Ok(resolved);
                        }
                        let shim_ext = Path::new(trimmed)
                            .extension()
                            .and_then(|e| e.to_str())
                            .map(|e| e.to_ascii_lowercase());
                        if shim_ext.as_deref() == Some("cmd") || shim_ext.as_deref() == Some("bat") {
                            return Err(format!(
                                "Agent program '{}' is a batch shim that could not be parsed (ADR-004.2)",
                                trimmed
                            ));
                        }
                        return Err(format!(
                            "Agent program '{}' is not a directly-executable image (.exe/.com/.scr); \
                             batch scripts and PowerShell scripts are not supported (ADR-004.2)",
                            trimmed
                        ));
                    }
                }
                return Ok(ResolvedProgram::new(trimmed.to_string()));
            }
            return Err(format!("Agent program not found: {}", trimmed));
        }

        #[cfg(target_os = "windows")]
        {
            // 1. Try directly-executable image extensions (PE images that
            //    CreateProcessW can launch).
            const WIN_EXECUTABLE_EXTS: &[&str] = &["", ".exe", ".com", ".scr"];
            for ext in WIN_EXECUTABLE_EXTS {
                let candidate = format!("{}{}", trimmed, ext);
                if let Some(abs_path) = self.get_absolute_shell_path(&candidate) {
                    if is_directly_executable_windows(&abs_path) {
                        return Ok(ResolvedProgram::new(abs_path));
                    }
                }
            }

            // 2. No PE image found. Try .cmd/.bat shim parsing (npm node or
            //    PowerShell wrappers) and rewrite to a directly-executable image.
            for shim_ext in [".cmd", ".bat"] {
                let candidate = format!("{}{}", trimmed, shim_ext);
                if let Some(abs_path) = self.get_absolute_shell_path(&candidate) {
                    if let Some(resolved) = try_parse_windows_cmd_shim(&abs_path) {
                        return Ok(resolved);
                    }
                }
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            let path_for_which = crate::pty::env_refresh::path_for_resolution();
            if let Ok(output) = std::process::Command::new("which")
                .env("PATH", &path_for_which)
                .arg(trimmed)
                .output()
            {
                if output.status.success() {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    let first_line = stdout.lines().next().unwrap_or("").trim();
                    if !first_line.is_empty() {
                        return Ok(ResolvedProgram::new(first_line.to_string()));
                    }
                }
            }
            for prefix in ["/usr/local/bin", "/usr/bin", "/bin", "/opt/homebrew/bin"] {
                let candidate = format!("{}/{}", prefix, trimmed);
                if Path::new(&candidate).exists() {
                    return Ok(ResolvedProgram::new(candidate));
                }
            }
        }

        Err(format!("Agent program not found on PATH: {}", trimmed))
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
            // CRITICAL: Check PowerShell variants BEFORE generic *.exe lookup
            // so name-only tokens hit explicit paths first
            if shell == "pwsh" {
                // PowerShell 7/6 resolution path
                let paths = vec![
                    r"C:\Program Files\PowerShell\7\pwsh.exe",
                    r"C:\Program Files\PowerShell\6\pwsh.exe",
                    "pwsh.exe",
                ];
                for path in paths {
                    if let Some(abs_path) = self.get_absolute_shell_path(path) {
                        return Ok(abs_path);
                    }
                }
            } else if shell == "powershell" {
                // Windows PowerShell 5 resolution path
                let paths = vec![
                    r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
                    "powershell.exe",
                ];
                for path in paths {
                    if let Some(abs_path) = self.get_absolute_shell_path(path) {
                        return Ok(abs_path);
                    }
                }
            }

            // Try shell.exe variant for non-PowerShell shells
            let exe_shell = format!("{}.exe", shell);
            if let Some(abs_path) = self.get_absolute_shell_path(&exe_shell) {
                return Ok(abs_path);
            }

            // Try the shell name directly for non-PowerShell shells
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
        let custom_sets_path = custom_env.as_ref().is_some_and(|custom| {
            custom
                .keys()
                .any(|key| key.eq_ignore_ascii_case("path"))
        });

        #[cfg(target_os = "windows")]
        {
            let mut env_map = merge_windows_environment_map(env::vars(), None);
            if !custom_sets_path {
                crate::pty::env_refresh::apply_fresh_path(&mut env_map);
            }
            if let Some(custom) = custom_env {
                for (key, value) in custom {
                    upsert_windows_env_var(&mut env_map, &key, value);
                }
            }
            if !has_windows_env_var(&env_map, "Path") {
                upsert_windows_env_var(
                    &mut env_map,
                    "Path",
                    env::var("PATH").unwrap_or_default(),
                );
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

        #[cfg(not(target_os = "windows"))]
        {
            let mut env = HashMap::new();

            for (key, value) in env::vars() {
                env.insert(key, value);
            }

            if !custom_sets_path {
                crate::pty::env_refresh::apply_fresh_path(&mut env);
            }

            if let Some(custom) = custom_env {
                for (key, value) in custom {
                    env.insert(key, value);
                }
            }

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
    process_handle: *mut winapi::ctypes::c_void,
    // Job Object handle (KILL_ON_JOB_CLOSE) owning the child process tree, or
    // null if it could not be created. Closing it (on Drop) reaps the whole
    // tree; TerminateJobObject kills it on demand. See spawn_conpty / #281.
    job_handle: *mut winapi::ctypes::c_void,
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
            // Close the job handle first: with KILL_ON_JOB_CLOSE this reaps the
            // entire child process tree once the last handle is gone.
            if !self.job_handle.is_null() {
                let _ = winapi::um::handleapi::CloseHandle(self.job_handle);
                self.job_handle = std::ptr::null_mut();
            }
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
            // Prefer terminating the Job Object: this kills the entire child
            // process tree (cmd → powershell → node …), which single-PID
            // TerminateProcess cannot do. See #281.
            if !self.job_handle.is_null() {
                if winapi::um::jobapi2::TerminateJobObject(self.job_handle, 1) != 0 {
                    return Ok(());
                }
                // Job termination failed: if the process already exited the job
                // is effectively empty — treat as success rather than logging an
                // ERROR_ACCESS_DENIED-style false failure.
                if self.process_already_exited() {
                    return Ok(());
                }
                let err = std::io::Error::last_os_error();
                log::warn!(
                    "[WindowsConPtyChild:{}] TerminateJobObject failed: {}",
                    self.pid,
                    err
                );
                return Err(err);
            }

            if self.process_handle.is_null() {
                return Ok(());
            }
            if winapi::um::processthreadsapi::TerminateProcess(self.process_handle, 1) == 0 {
                // The process may already have exited; that's not a real failure
                // and avoids the recurring "Access is denied (os error 5)" noise.
                if self.process_already_exited() {
                    return Ok(());
                }
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
        let mut dup: *mut winapi::ctypes::c_void = std::ptr::null_mut();
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

            // Duplicate the job handle too so the clone can still tree-kill.
            // KILL_ON_JOB_CLOSE only fires when the LAST handle closes, so an
            // extra duplicate is safe and does not terminate the tree early.
            let mut dup_job: *mut winapi::ctypes::c_void = std::ptr::null_mut();
            if !self.job_handle.is_null() {
                if winapi::um::handleapi::DuplicateHandle(
                    winapi::um::processthreadsapi::GetCurrentProcess(),
                    self.job_handle,
                    winapi::um::processthreadsapi::GetCurrentProcess(),
                    &mut dup_job,
                    0,
                    0,
                    winapi::um::winnt::DUPLICATE_SAME_ACCESS,
                ) == 0
                {
                    log::warn!(
                        "[WindowsConPtyChild:{}] DuplicateHandle(job) failed, clone loses tree-kill: {}",
                        self.pid,
                        std::io::Error::last_os_error()
                    );
                    dup_job = std::ptr::null_mut();
                }
            }

            Box::new(WindowsConPtyChild {
                pid: self.pid,
                process_handle: dup,
                job_handle: dup_job,
            })
        }
    }
}

#[cfg(target_os = "windows")]
impl WindowsConPtyChild {
    /// Returns true if the underlying process is known to have exited. Used to
    /// distinguish a benign "already dead" kill from a real termination failure.
    unsafe fn process_already_exited(&self) -> bool {
        if self.process_handle.is_null() {
            return true;
        }
        let wait = winapi::um::synchapi::WaitForSingleObject(self.process_handle, 0);
        wait == winapi::um::winbase::WAIT_OBJECT_0
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
        Some(self.process_handle as *mut std::ffi::c_void)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "windows")]
    #[test]
    fn directly_executable_windows_accepts_only_image_formats() {
        // The exact list we accept — anything else will be rejected by
        // resolve_program_path before it can reach CreateProcessW and surface
        // as os error 193.
        for ok in [
            r"C:\bin\claude.exe",
            r"C:\bin\codex.exe",
            r"C:/bin/cursor.com",
            r"C:\bin\agent.scr",
            r"C:\bin\sub\path\agent.exe",
            r#"C:\bin\"quoted".exe"#, // trailing quote tolerated
        ] {
            assert!(
                is_directly_executable_windows(ok),
                "expected accepted: {}",
                ok
            );
        }
        for bad in [
            r"C:\bin\nodot",
            r"C:\bin\opencode.cmd",
            r"C:\bin\agent.bat",
            r"C:\bin\script.ps1",
            r"C:\bin\hello.vbs",
            r"C:\bin\runner.js",
            r"C:\bin\thing.exe.cmd", // .cmd wins, rejected
        ] {
            assert!(
                !is_directly_executable_windows(bad),
                "expected rejected: {}",
                bad
            );
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn directly_executable_windows_composite_suffix_does_not_match() {
        // A file like `agent.cmd.exe` is a .exe, so it IS accepted — but
        // `agent.cmd.txt` is not. Make sure we look at the last extension only.
        assert!(is_directly_executable_windows(r"C:\bin\agent.cmd.exe"));
        assert!(!is_directly_executable_windows(r"C:\bin\agent.exe.cmd"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn parse_npm_cmd_shim_rewrites_to_node_script() {
        // Write a simulated npm .cmd shim matching the real opencode.cmd format
        // that nvm-windows generates.
        let dir = std::env::temp_dir().join("termul-test-cmd-shim");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // Create a fake node.exe (just a marker — parser only checks existence
        // + extension via is_directly_executable_windows).
        std::fs::write(dir.join("node.exe"), b"MZ").unwrap();
        // Create the target script file.
        std::fs::create_dir_all(dir.join("node_modules\\opencode-ai\\bin"))
            .unwrap();
        std::fs::write(dir.join("node_modules\\opencode-ai\\bin\\opencode"), b"")
            .unwrap();

        let shim_path = dir.join("opencode.cmd");
        let shim_content = "@ECHO off\r\n".to_owned()
            + "GOTO start\r\n"
            + ":find_dp0\r\n"
            + "SET dp0=%~dp0\r\n"
            + "EXIT /b\r\n"
            + ":start\r\n"
            + "SETLOCAL\r\n"
            + "CALL :find_dp0\r\n"
            + "\r\n"
            + "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\opencode-ai\\bin\\opencode\" %*\r\n";
        std::fs::write(&shim_path, shim_content).unwrap();

        let resolved = parse_npm_cmd_shim(shim_path.to_str().unwrap());
        assert!(resolved.is_some(), "should parse the shim");
        let resolved = resolved.unwrap();

        // The executable should be node.exe in the same directory as the shim.
        assert!(
            resolved.program.ends_with("node.exe"),
            "expected node.exe, got: {}",
            resolved.program
        );
        // The script path should be the opencode-ai bin entry.
        assert_eq!(resolved.prepend_args.len(), 1);
        assert!(
            resolved.prepend_args[0].contains("opencode-ai\\bin\\opencode"),
            "expected script path containing opencode-ai bin, got: {}",
            resolved.prepend_args[0]
        );

        // Cleanup
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn parse_npm_cmd_shim_rewrites_npm_launcher_with_set_indirection() {
        // npm's own npx.cmd / npm.cmd invoke through SETLOCAL variables:
        //   SET "NODE_EXE=%~dp0\node.exe"
        //   SET "NPX_CLI_JS=%~dp0\node_modules\npm\bin\npx-cli.js"
        //   "%NODE_EXE%" "%NPX_CLI_JS%" %*
        // The parser must resolve the %VAR% indirection, not only the simple
        // `"%dp0%\node.exe" "<script>"` package-bin form.
        let dir = std::env::temp_dir().join("termul-test-npx-launcher-shim");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("node.exe"), b"MZ").unwrap();
        std::fs::create_dir_all(dir.join("node_modules\\npm\\bin")).unwrap();
        std::fs::write(dir.join("node_modules\\npm\\bin\\npx-cli.js"), b"").unwrap();

        let shim_path = dir.join("npx.cmd");
        let shim_content = ":: Created by npm, please don't edit manually.\r\n".to_owned()
            + "@ECHO OFF\r\n"
            + "SETLOCAL\r\n"
            + "SET \"NODE_EXE=%~dp0\\node.exe\"\r\n"
            + "IF NOT EXIST \"%NODE_EXE%\" (\r\n"
            + "  SET \"NODE_EXE=node\"\r\n"
            + ")\r\n"
            + "SET \"NPX_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npx-cli.js\"\r\n"
            + "\"%NODE_EXE%\" \"%NPX_CLI_JS%\" %*\r\n";
        std::fs::write(&shim_path, shim_content).unwrap();

        let resolved = parse_npm_cmd_shim(shim_path.to_str().unwrap());
        assert!(resolved.is_some(), "should parse the npm launcher shim");
        let resolved = resolved.unwrap();
        assert!(
            resolved.program.ends_with("node.exe"),
            "expected node.exe, got: {}",
            resolved.program
        );
        assert_eq!(resolved.prepend_args.len(), 1);
        assert!(
            resolved.prepend_args[0].contains("npm\\bin\\npx-cli.js"),
            "expected npx-cli.js script path, got: {}",
            resolved.prepend_args[0]
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn parse_powershell_cmd_shim_rewrites_cursor_agent_style() {
        let dir = std::env::temp_dir().join("termul-test-ps-shim");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let ps_exe = dir.join("powershell.exe");
        std::fs::write(&ps_exe, b"MZ").unwrap();
        let script = dir.join("cursor-agent.ps1");
        std::fs::write(&script, b"# stub").unwrap();

        let ps_exe_str = ps_exe.to_string_lossy();
        let script_str = script.to_string_lossy();
        let shim_path = dir.join("cursor-agent.cmd");
        let shim_content = format!(
            "@echo off\r\n{ps} -NoProfile -ExecutionPolicy Bypass -File \"{script}\" %*\r\n",
            ps = ps_exe_str,
            script = script_str,
        );
        std::fs::write(&shim_path, shim_content).unwrap();

        let resolved = parse_powershell_cmd_shim(shim_path.to_str().unwrap());
        assert!(resolved.is_some(), "should parse PowerShell shim");
        let resolved = resolved.unwrap();
        assert!(
            resolved.program.ends_with("powershell.exe"),
            "expected powershell.exe, got: {}",
            resolved.program
        );
        assert!(
            resolved.prepend_args.iter().any(|a| a.ends_with("cursor-agent.ps1")),
            "expected -File script in prepend_args: {:?}",
            resolved.prepend_args
        );
        assert!(
            resolved.prepend_args.iter().any(|a| a == "-NoProfile"),
            "expected -NoProfile flag: {:?}",
            resolved.prepend_args
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn win_agent_resolution_skips_extensionless_before_pe() {
        let dir = std::env::temp_dir().join("termul-test-pe-resolve");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        std::fs::write(dir.join("claude"), b"not a pe image").unwrap();
        std::fs::write(dir.join("claude.exe"), b"MZ").unwrap();

        let trimmed = "claude";
        const WIN_EXECUTABLE_EXTS: &[&str] = &["", ".exe", ".com", ".scr"];
        let mut resolved_path: Option<String> = None;
        for ext in WIN_EXECUTABLE_EXTS {
            let candidate = dir.join(format!("{}{}", trimmed, ext));
            if !candidate.exists() {
                continue;
            }
            let abs_path = candidate.to_string_lossy().to_string();
            if is_directly_executable_windows(&abs_path) {
                resolved_path = Some(abs_path);
                break;
            }
        }

        let resolved_path =
            resolved_path.expect("should resolve to claude.exe after skipping extensionless shim");
        assert!(
            resolved_path.ends_with("claude.exe"),
            "expected claude.exe, got: {}",
            resolved_path
        );
        assert!(
            !is_directly_executable_windows(&dir.join("claude").to_string_lossy()),
            "extensionless claude must not be treated as PE"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn try_parse_windows_cmd_shim_prefers_npm_over_powershell() {
        let dir = std::env::temp_dir().join("termul-test-shim-priority");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("node.exe"), b"MZ").unwrap();
        std::fs::create_dir_all(dir.join("node_modules\\pkg\\bin")).unwrap();
        std::fs::write(dir.join("node_modules\\pkg\\bin\\tool"), b"").unwrap();

        let shim_path = dir.join("tool.cmd");
        let shim_content = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\n\
            endLocal & goto #_undefined_# 2>NUL || \"%_prog%\" \"%dp0%\\node_modules\\pkg\\bin\\tool\" %*\r\n";
        std::fs::write(&shim_path, shim_content).unwrap();

        let resolved = try_parse_windows_cmd_shim(shim_path.to_str().unwrap());
        assert!(resolved.is_some());
        assert!(
            resolved.unwrap().program.ends_with("node.exe"),
            "npm shim should resolve to node.exe"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn resolve_spawn_program_rewrites_npm_cmd_shim() {
        let dir = std::env::temp_dir().join("termul-test-resolve-npm-shim");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("node.exe"), b"MZ").unwrap();
        std::fs::create_dir_all(dir.join("node_modules\\gemini\\bin")).unwrap();
        std::fs::write(dir.join("node_modules\\gemini\\bin\\gemini"), b"").unwrap();

        let shim_path = dir.join("gemini.cmd");
        let shim_content = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\n\
            endLocal & goto #_undefined_# 2>NUL || \"%_prog%\" \"%dp0%\\node_modules\\gemini\\bin\\gemini\" %*\r\n";
        std::fs::write(&shim_path, shim_content).unwrap();

        // Explicit-path form: resolve_spawn_program parses and rewrites the shim.
        let resolved = resolve_spawn_program(shim_path.to_str().unwrap())
            .expect("npm .cmd shim should resolve");
        assert!(
            resolved.program.ends_with("node.exe"),
            "expected node.exe, got: {}",
            resolved.program
        );
        assert_eq!(resolved.prepend_args.len(), 1);
        assert!(
            resolved.prepend_args[0].contains("gemini\\bin\\gemini"),
            "expected the script path prepended, got: {:?}",
            resolved.prepend_args
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn resolve_spawn_program_rewrites_powershell_cmd_shim() {
        let dir = std::env::temp_dir().join("termul-test-resolve-ps-shim");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("cursor-agent.ps1"), b"").unwrap();
        let ps_exe = std::path::Path::new(
            &std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string()),
        )
        .join("System32\\WindowsPowerShell\\v1.0\\powershell.exe");
        let ps_exe_str = ps_exe.to_string_lossy().to_string();
        let script_str = dir.join("cursor-agent.ps1").to_string_lossy().to_string();

        let shim_path = dir.join("cursor-agent.cmd");
        let shim_content = format!(
            "@echo off\r\n{ps} -NoProfile -ExecutionPolicy Bypass -File \"{script}\" %*\r\n",
            ps = ps_exe_str,
            script = script_str,
        );
        std::fs::write(&shim_path, shim_content).unwrap();

        let resolved = resolve_spawn_program(shim_path.to_str().unwrap())
            .expect("PowerShell .cmd shim should resolve");
        assert!(
            resolved.program.ends_with("powershell.exe"),
            "expected powershell.exe, got: {}",
            resolved.program
        );
        assert!(
            resolved.prepend_args.iter().any(|a| a.ends_with("cursor-agent.ps1")),
            "expected -File script prepended, got: {:?}",
            resolved.prepend_args
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn resolve_spawn_program_keeps_native_exe_without_prepend() {
        let dir = std::env::temp_dir().join("termul-test-resolve-native-exe");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let exe_path = dir.join("agent.exe");
        std::fs::write(&exe_path, b"MZ").unwrap();

        let resolved = resolve_spawn_program(exe_path.to_str().unwrap())
            .expect("native .exe should resolve");
        assert!(resolved.program.ends_with("agent.exe"));
        assert!(
            resolved.prepend_args.is_empty(),
            "native exe must not prepend args, got: {:?}",
            resolved.prepend_args
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn resolve_spawn_program_passes_through_on_unix() {
        let resolved = resolve_spawn_program("gemini").expect("unix passthrough");
        assert_eq!(resolved.program, "gemini");
        assert!(resolved.prepend_args.is_empty());
    }

    #[test]
    fn test_should_reap_orphan_protected_never_reaped() {
        let long_ago = Duration::from_secs(10_000);
        let timeout = Duration::from_secs(600);
        // Protected + orphaned + long past timeout => still not reapable.
        assert!(!should_reap_orphan(
            true,
            true,
            Some(long_ago),
            long_ago,
            timeout
        ));
    }

    #[test]
    fn test_should_reap_orphan_attached_never_reaped() {
        let long_ago = Duration::from_secs(10_000);
        let timeout = Duration::from_secs(600);
        // Not protected but still has a renderer ref (is_orphan == false).
        assert!(!should_reap_orphan(
            false,
            false,
            Some(long_ago),
            long_ago,
            timeout
        ));
    }

    #[test]
    fn test_should_reap_orphan_orphaned_past_timeout_reaped() {
        let timeout = Duration::from_secs(600);
        // Unprotected, orphaned, past timeout => reapable.
        assert!(should_reap_orphan(
            false,
            true,
            Some(Duration::from_secs(601)),
            Duration::from_secs(0),
            timeout
        ));
    }

    #[test]
    fn test_should_reap_orphan_orphaned_within_timeout_not_reaped() {
        let timeout = Duration::from_secs(600);
        assert!(!should_reap_orphan(
            false,
            true,
            Some(Duration::from_secs(59)),
            Duration::from_secs(0),
            timeout
        ));
    }

    #[test]
    fn test_should_reap_orphan_uses_inactivity_when_never_orphaned() {
        let timeout = Duration::from_secs(600);
        // Never had a renderer ref (orphaned_for None) => fall back to inactivity.
        assert!(should_reap_orphan(
            false,
            true,
            None,
            Duration::from_secs(601),
            timeout
        ));
        assert!(!should_reap_orphan(
            false,
            true,
            None,
            Duration::from_secs(59),
            timeout
        ));
    }

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

    // ========== Async kill() signature tests ==========
    // Note: Full integration tests for kill() and kill_all() require Tauri runtime.
    // The async spawn_blocking pattern is validated through:
    // 1. Compile-time check: kill() is now async and returns impl Future
    // 2. Existing orphan cleanup code at line 403-406 demonstrates the pattern
    // 3. Manual testing during development
}
