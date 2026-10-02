use super::*;

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
        let system_root = env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
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
        if !std::path::Path::new(&ps_exe).exists() || !is_directly_executable_windows(&ps_exe) {
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
pub(super) fn try_parse_windows_cmd_shim(shim_path: &str) -> Option<ResolvedProgram> {
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
pub(super) fn merge_windows_environment_map<I>(
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

impl PtyManager {
    /// Get the default shell path. Resolution order (F-001):
    /// 1. `$SHELL` (interactive sessions);
    /// 2. the user's login shell from the OS account database — under systemd (and
    ///    other service managers) `SHELL` is typically unset, and falling
    ///    straight to `/bin/sh` gives root services dash instead of the
    ///    operator's shell (`env_refresh::probe_unix_login_path` documents
    ///    this exact failure for PATH probing; the PTY spawn path must not
    ///    repeat it);
    /// 3. `/bin/sh` only when neither resolves.
    ///
    /// Both `$SHELL` and the passwd shell must exist as files before use —
    /// a stale/nonexistent `$SHELL` (e.g. a removed shell left in the
    /// service environment) must fall through to the passwd login shell
    /// rather than win the `or_else` and lose to the final filter, which
    /// would silently land on `/bin/sh` anyway.
    pub(super) fn get_default_shell(&self) -> Result<String, String> {
        #[cfg(target_os = "windows")]
        {
            let comspec = env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
            Ok(comspec)
        }

        #[cfg(not(target_os = "windows"))]
        {
            Ok(env::var("SHELL")
                .ok()
                .filter(|s| !s.is_empty())
                .filter(|s| std::path::Path::new(s).is_file())
                .or_else(|| {
                    crate::pty::env_refresh::login_shell_from_system()
                        .filter(|s| std::path::Path::new(s).is_file())
                })
                .unwrap_or_else(|| "/bin/sh".to_string()))
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
    pub(super) fn resolve_program_path(&self, program: &str) -> Result<ResolvedProgram, String> {
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
                        if shim_ext.as_deref() == Some("cmd") || shim_ext.as_deref() == Some("bat")
                        {
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
    pub(super) fn resolve_shell_path(&self, shell: &str) -> Result<String, String> {
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
    pub(super) fn is_builtin_windows_shell(shell_path: &str) -> bool {
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
    pub(super) fn get_home_directory(&self) -> String {
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
    pub(super) fn merge_environment(
        &self,
        custom_env: Option<HashMap<String, String>>,
    ) -> HashMap<String, String> {
        let custom_sets_path = custom_env
            .as_ref()
            .is_some_and(|custom| custom.keys().any(|key| key.eq_ignore_ascii_case("path")));

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
