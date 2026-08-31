//! Guided setup + background launch for the standalone `termul-server`.
//!
//! `termul-server onboard` interactively asks for each supported config,
//! validates answers by reusing the existing validators (`BindMode::parse`,
//! `resolve_and_validate_project_root`, `UpdateChannel::parse`, …), then
//! auto-detects the host's service manager and launches the server detached
//! so it survives SSH logout: systemd hosts install + enable + start a
//! `termul-server.service` unit; non-systemd Linux hosts detach via `setsid`
//! with stdio to a log file + a PID file.
//!
//! The wizard logic (validation, synthesis, detection predicate, unit-text
//! builder, access-info text, non-TTY path) is unit-testable without a TTY,
//! root, or a real systemd — only the thin `run()` I/O wrapper touches the
//! real stdin/stdout. The module is intentionally NOT feature-gated so its
//! tests run under the spec's default `cargo test` gate (mirrors
//! `server_update`); only `server_main.rs`'s `--onboard` branch is
//! `standalone-server`-gated.

use std::fs::OpenOptions;
use std::io::{BufRead, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};

use crate::server_update::UpdateChannel;
use crate::web::config::{
    default_project_root, default_sessions_dir, resolve_and_validate_project_root, BindMode,
    ServerConfig,
};

// ---------------------------------------------------------------------------
// OnboardAnswers — validated answers + synthesis trio.
// ---------------------------------------------------------------------------

/// The operator's validated onboard answers. Built by [`Self::collect`] (TTY)
/// or [`Self::defaults`] (non-TTY display path). All fields hold the resolved
/// values — raw stdin is never retained.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OnboardAnswers {
    pub host: String,
    pub port: u16,
    pub project_root: PathBuf,
    pub sessions_dir: PathBuf,
    pub allow_remote_writes: bool,
    pub update_channel: Option<UpdateChannel>,
    pub update_interval_secs: u64,
}

impl OnboardAnswers {
    /// Best-effort defaults from env/platform fallbacks. Used as the starting
    /// defaults for [`Self::collect`] (where the value is re-validated + can be
    /// overridden) and for the non-TTY display path. Project root is validated
    /// when possible; on failure the raw fallback is kept so the display path
    /// never panics. Falls back to the user's home dir only — never the parent
    /// `/home` (over-broad boundary for /git/*,/skills,/search).
    pub fn defaults() -> Self {
        let project_root = default_project_root()
            .and_then(|p| resolve_and_validate_project_root(&p).ok())
            .or_else(default_project_root)
            .unwrap_or_else(|| PathBuf::from("/"));
        let sessions_dir =
            default_sessions_dir().unwrap_or_else(|| PathBuf::from("/tmp/termul/sessions"));
        Self {
            host: "127.0.0.1".to_string(),
            port: 8080,
            project_root,
            sessions_dir,
            allow_remote_writes: false,
            update_channel: None,
            update_interval_secs: 21600,
        }
    }

    /// Interactive collection loop. Reuses the existing validators verbatim;
    /// each prompt shows the resolved default and accepts an empty line to
    /// keep it. Retries on validation error with the validator's message.
    /// Only called when stdin is a TTY — the non-TTY path uses [`Self::defaults`].
    pub fn collect<R: BufRead, W: Write>(stdin: &mut R, stdout: &mut W) -> Self {
        writeln!(stdout, "=== termul-server onboard ===").ok();
        writeln!(stdout, "Press Enter to accept the [default] for each prompt.\n").ok();

        let host = prompt_validated(
            stdin,
            stdout,
            "Bind host (127.0.0.1 = localhost only, 0.0.0.0 = expose)",
            "127.0.0.1",
            |s| {
                BindMode::parse(s)
                    .map(|m| m.display_host().to_string())
                    .ok_or_else(|| format!("invalid host '{s}': use 127.0.0.1 or 0.0.0.0"))
            },
        );

        let port = prompt_validated(stdin, stdout, "Bind port", "8080", |s| {
            let p: u16 = s
                .parse()
                .map_err(|_| format!("invalid port '{s}': expected 1-65535"))?;
            if p == 0 {
                return Err("invalid port '0': use 1-65535".into());
            }
            Ok(p)
        });

        let pr_default = default_project_root()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "(none — required)".to_string());
        let project_root = prompt_validated(
            stdin,
            stdout,
            "Project root (boundary for /git/*,/skills,/search)",
            &pr_default,
            |s| resolve_and_validate_project_root(Path::new(s)),
        );

        let sd_default = default_sessions_dir()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "(none — required)".to_string());
        let sessions_dir = prompt_validated(stdin, stdout, "Sessions directory", &sd_default, |s| {
            let t = s.trim();
            if t.is_empty() {
                return Err("sessions directory cannot be empty".into());
            }
            Ok(PathBuf::from(t))
        });

        let bind_all = BindMode::parse(&host) == Some(BindMode::All);
        let allow_remote_writes = if bind_all {
            prompt_yesno(
                stdin,
                stdout,
                "Allow non-loopback write peers (fs/git/workspace mutations)?",
                false,
            )
        } else {
            writeln!(
                stdout,
                "Note: --allow-remote-writes is a no-op when bound to 127.0.0.1 (skipped)."
            )
            .ok();
            false
        };

        let update_channel: Option<UpdateChannel> = prompt_validated(
            stdin,
            stdout,
            "Update channel (stable/insider/nightly/none)",
            "none",
            |s| {
                let t = s.trim().to_ascii_lowercase();
                if t == "none" || t.is_empty() {
                    return Ok(None);
                }
                UpdateChannel::parse(&t)
                    .map(Some)
                    .ok_or_else(|| format!("invalid channel '{s}': use stable/insider/nightly/none"))
            },
        );

        let update_interval_secs = if update_channel.is_some() {
            prompt_validated(stdin, stdout, "Update check interval (seconds)", "21600", |s| {
                let n: u64 = s
                    .parse()
                    .map_err(|_| format!("invalid interval '{s}': expected a positive integer"))?;
                if n == 0 {
                    return Err("interval must be > 0".into());
                }
                Ok(n)
            })
        } else {
            21600
        };

        Self {
            host,
            port,
            project_root,
            sessions_dir,
            allow_remote_writes,
            update_channel,
            update_interval_secs,
        }
    }

    /// Synthesize a [`ServerConfig`] from the answers. Non-onboarded fields use
    /// the parser's defaults (event-log capacity, permission timeouts). Remote
    /// writes is only enabled in the config when the bind is non-loopback — on
    /// loopback it stays `false` (documented no-op).
    pub fn to_server_config(&self) -> ServerConfig {
        let expose = BindMode::parse(&self.host) == Some(BindMode::All);
        ServerConfig {
            host: self.host.clone(),
            port: self.port,
            event_log_capacity: 4096,
            permission_timeout_secs: 60,
            permission_reconnect_grace_secs: 60,
            project_root: self.project_root.clone(),
            projects_file: None,
            sessions_dir: Some(self.sessions_dir.clone()),
            workspace_manifests_dir: None,
            acp_catalog_dir: None,
            store_file: None,
            allow_remote_writes: self.allow_remote_writes && expose,
        }
    }

    /// Synthesize the foreground CLI args for the server. Matches the golden
    /// unit ordering: `--host`, `--port`, `--project-root`, `--sessions-dir`,
    /// then `--allow-remote-writes` ONLY when bound to `0.0.0.0` and enabled.
    /// On loopback the flag is a documented no-op and is omitted.
    pub fn to_command_args(&self) -> Vec<String> {
        let mut args: Vec<String> = vec![
            "--host".into(),
            self.host.clone(),
            "--port".into(),
            self.port.to_string(),
            "--project-root".into(),
            self.project_root.display().to_string(),
            "--sessions-dir".into(),
            self.sessions_dir.display().to_string(),
        ];
        let expose = BindMode::parse(&self.host) == Some(BindMode::All);
        if expose && self.allow_remote_writes {
            args.push("--allow-remote-writes".into());
        }
        args
    }

    /// Synthesize `KEY=value` env-file lines. `SHELL` and `HOME` are ALWAYS
    /// emitted (even on loopback, even with no updates) so the service
    /// process has the vars `env_refresh::probe_unix_login_path` needs to
    /// resolve the user's login PATH. Without them, a systemd service runs
    /// with `SHELL` unset → falls back to /bin/sh (dash) → PATH probe fails
    /// → binaries in ~/.local/bin, ~/.cargo/bin, nvm, etc. are unreachable.
    /// Remote-writes env is emitted only when bound to `0.0.0.0` and enabled.
    /// Update env vars are emitted only when `update_channel` is `Some`.
    pub fn to_env_lines(&self) -> Vec<String> {
        let mut lines = Vec::new();

        // Always emit SHELL and HOME so the service can resolve the user's
        // login PATH (env_refresh probes the login shell for PATH additions).
        // Reject control characters and trailing backslashes that could break
        // systemd EnvironmentFile parsing (CWE-15).
        if let Some(shell) = std::env::var_os("SHELL") {
            if let Some(line) = safe_systemd_env_line("SHELL", &shell) {
                lines.push(line);
            }
        }
        if let Some(home) = std::env::var_os("HOME") {
            if let Some(line) = safe_systemd_env_line("HOME", &home) {
                lines.push(line);
            }
        }

        let expose = BindMode::parse(&self.host) == Some(BindMode::All);
        if expose && self.allow_remote_writes {
            lines.push("TERMUL_SERVER_ALLOW_REMOTE_WRITES=true".into());
        }
        if let Some(channel) = self.update_channel {
            lines.push("TERMUL_SERVER_UPDATE_ENABLED=true".into());
            lines.push(format!(
                "TERMUL_SERVER_UPDATE_CHANNEL={}",
                channel_name(channel)
            ));
            lines.push(format!(
                "TERMUL_SERVER_UPDATE_INTERVAL_SECS={}",
                self.update_interval_secs
            ));
        }
        lines
    }
}

fn channel_name(channel: UpdateChannel) -> &'static str {
    match channel {
        UpdateChannel::Stable => "stable",
        UpdateChannel::Insider => "insider",
        UpdateChannel::Nightly => "nightly",
    }
}

/// Build a `KEY=value` line safe for systemd `EnvironmentFile=`.
/// Rejects values containing control characters, newlines, or trailing
/// backslashes that could alter subsequent assignments.
fn safe_systemd_env_line(key: &str, value: &std::ffi::OsStr) -> Option<String> {
    let s = value.to_string_lossy();
    if s.is_empty()
        || s.bytes().any(|b| b < 0x20 || b == b'\\')
        || s.ends_with('\\')
    {
        return None;
    }
    Some(format!("{key}={s}"))
}

// ---------------------------------------------------------------------------
// ServiceManager — auto-detection + per-mechanism install/spawn.
// ---------------------------------------------------------------------------

/// systemd scope: system (root, `/etc/systemd/system`) or user (non-root,
/// `~/.config/systemd/user` + `loginctl enable-linger`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SystemdScope {
    System,
    User,
}

/// The auto-detected background-launch mechanism.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServiceManager {
    Systemd { scope: SystemdScope },
    Setsid,
}

impl ServiceManager {
    /// Auto-detect the mechanism. systemd = `/run/systemd/system` exists AND
    /// `systemctl --version` succeeds; scope by uid (root → system, else user).
    /// Fallback: `Setsid`.
    pub fn detect() -> Self {
        detect_from(systemd_is_present(), is_root())
    }

    /// A short management tip for the non-TTY display path.
    fn tip(&self) -> String {
        match self {
            Self::Systemd { scope } => {
                let u = if matches!(scope, SystemdScope::User) {
                    " --user"
                } else {
                    ""
                };
                format!(
                    "Mechanism: systemd. Manage: journalctl{u} -u termul-server -f; \
                     systemctl{u} stop termul-server."
                )
            }
            Self::Setsid => {
                "Mechanism: setsid (no systemd). Detached background process \
                 (survives logout, not reboot)."
                    .into()
            }
        }
    }

    /// Install + start the server in the background via the detected mechanism.
    /// `env_path` is `Some` only when the operator accepted the env-file write;
    /// `env_lines` carries the same vars (used by the setsid child env). When
    /// `env_path` is `None` (declined), `env_lines` should be empty so neither
    /// path passes env vars — the server runs with explicit CLI args only.
    fn install_and_start(
        &self,
        exe: &Path,
        args: &[String],
        env_path: Option<&Path>,
        env_lines: &[String],
        state_dir: &Path,
        user: &str,
    ) -> Result<(), String> {
        match self {
            Self::Systemd { scope } => {
                let unit_path = unit_path(scope);
                if let Some(parent) = unit_path.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| format!("create {}: {e}", parent.display()))?;
                }
                // Quote every ExecStart token so paths with spaces survive
                // systemd's whitespace-tokenizing ExecStart parser. The
                // operator's project-root / sessions-dir can legitimately
                // contain spaces (e.g. /home/me/My Projects); an unquoted
                // token would split into multiple args and the server would
                // start with a wrong/missing path. Escape embedded quotes +
                // backslashes per systemd's quoting rules.
                let quote = |s: &str| {
                    let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
                    format!("\"{escaped}\"")
                };
                let mut exec_start = quote(&exe.display().to_string());
                for arg in args {
                    exec_start.push(' ');
                    exec_start.push_str(&quote(arg));
                }
                let env_file_str = env_path.map(|p| p.display().to_string());
                let unit_text =
                    build_systemd_unit_text(&exec_start, env_file_str.as_deref(), *scope);
                std::fs::write(&unit_path, &unit_text)
                    .map_err(|e| format!("write {}: {e}", unit_path.display()))?;

                let user_flag = matches!(scope, SystemdScope::User);

                // Run systemctl; surface BOTH spawn failures (io::Error) AND
                // non-zero exits (invalid unit, polkit denial, SELinux). A
                // bare `.status().map_err(...)?` only catches the spawn error
                // and would let a failed enable --now report success.
                let mut reload = Command::new("systemctl");
                if user_flag {
                    reload.arg("--user");
                }
                reload.arg("daemon-reload");
                let st = reload
                    .status()
                    .map_err(|e| format!("systemctl daemon-reload failed: {e}"))?;
                if !st.success() {
                    return Err(format!(
                        "systemctl daemon-reload failed (exit {:?})",
                        st.code()
                    ));
                }

                let mut enable = Command::new("systemctl");
                if user_flag {
                    enable.arg("--user");
                }
                enable.args(["enable", "--now", "termul-server"]);
                let st = enable
                    .status()
                    .map_err(|e| format!("systemctl enable --now failed: {e}"))?;
                if !st.success() {
                    return Err(format!(
                        "systemctl enable --now failed (exit {:?}) — check the unit at {}",
                        st.code(),
                        unit_path.display()
                    ));
                }

                if user_flag {
                    // enable-linger so the user unit survives logout + boots.
                    // Best-effort: a failure here (e.g. polkit) leaves the
                    // unit running but not boot-persistent; warn, don't abort.
                    if let Ok(linger_st) = Command::new("loginctl")
                        .args(["enable-linger", user])
                        .status()
                    {
                        if !linger_st.success() {
                            eprintln!(
                                "warning: loginctl enable-linger failed (exit {:?}); the \
                                 unit runs now but may not survive reboot",
                                linger_st.code()
                            );
                        }
                    }
                }
                Ok(())
            }
            Self::Setsid => {
                // Probe setsid presence. `.status().is_err()` only catches a
                // spawn failure (NotFound); a setsid that exists but exits
                // non-zero (BusyBox rejects --version) would pass. Use
                // `.success()` so both "not found" and "broken setsid" halt
                // with the clear message the spec's matrix requires.
                let setsid_ok = Command::new("setsid")
                    .arg("--version")
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false);
                if !setsid_ok {
                    return Err(
                        "`setsid` not found or not functional on PATH. Install it \
                         (util-linux) or run the server manually in the foreground."
                            .into(),
                    );
                }
                std::fs::create_dir_all(state_dir)
                    .map_err(|e| format!("create state dir '{}': {e}", state_dir.display()))?;
                let log_path = state_dir.join("termul-server.log");
                let pid_path = state_dir.join("termul-server.pid");
                let log = OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&log_path)
                    .map_err(|e| format!("open log '{}': {e}", log_path.display()))?;
                let err = log
                    .try_clone()
                    .map_err(|e| format!("dup log fd: {e}"))?;

                let env_iter: Vec<(&str, &str)> = env_lines
                    .iter()
                    .filter_map(|l| l.split_once('='))
                    .collect();

                let mut cmd = Command::new("setsid");
                cmd.arg(exe)
                    .args(args)
                    .stdin(Stdio::null())
                    .stdout(Stdio::from(log))
                    .stderr(Stdio::from(err))
                    .envs(env_iter);
                let child = cmd
                    .spawn()
                    .map_err(|e| format!("spawn setsid: {e}"))?;
                let pid = child.id();
                std::fs::write(&pid_path, format!("{pid}\n"))
                    .map_err(|e| format!("write pid '{}': {e}", pid_path.display()))?;
                Ok(())
            }
        }
    }
}

/// Pure detection predicate: systemd present → `Systemd` (scope by root),
/// else `Setsid`. Factored out so [`ServiceManager::detect`] stays a thin
/// wrapper and the predicate is unit-testable without a real host.
fn detect_from(systemd_present: bool, is_root: bool) -> ServiceManager {
    if systemd_present {
        ServiceManager::Systemd {
            scope: if is_root {
                SystemdScope::System
            } else {
                SystemdScope::User
            },
        }
    } else {
        ServiceManager::Setsid
    }
}

fn systemd_is_present() -> bool {
    Path::new("/run/systemd/system").exists()
        && Command::new("systemctl")
            .arg("--version")
            .status()
            .is_ok()
}

#[cfg(unix)]
fn is_root() -> bool {
    // No `libc`/`nix` (forbidden); resolve uid via the external `id -u` util.
    Command::new("id")
        .arg("-u")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "0")
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_root() -> bool {
    false
}

fn unit_path(scope: &SystemdScope) -> PathBuf {
    match scope {
        SystemdScope::System => PathBuf::from("/etc/systemd/system/termul-server.service"),
        SystemdScope::User => {
            let home = std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."));
            home.join(".config/systemd/user/termul-server.service")
        }
    }
}

/// Build the systemd unit text. `env_file` is the optional `EnvironmentFile`
/// path (emitted only when the operator accepted the env-file write). The
/// golden unit (localhost, no env file) omits `EnvironmentFile`. `WantedBy`
/// branches on `scope`: `default.target` for user units (multi-user.target
/// does not exist in the user systemd instance), `multi-user.target` for
/// system units.
fn build_systemd_unit_text(
    exec_start: &str,
    env_file: Option<&str>,
    scope: SystemdScope,
) -> String {
    let mut s = String::new();
    s.push_str("[Unit]\n");
    s.push_str("Description=Termul standalone server (onboard-generated)\n");
    s.push_str("After=network.target\n\n");
    s.push_str("[Service]\n");
    s.push_str("Type=simple\n");
    s.push_str(&format!("ExecStart={exec_start}\n"));
    if let Some(path) = env_file {
        s.push_str(&format!("EnvironmentFile={path}\n"));
    }
    s.push_str("Restart=on-failure\n");
    s.push_str("RestartSec=2\n\n");
    s.push_str("[Install]\n");
    let wanted_by = match scope {
        SystemdScope::System => "multi-user.target",
        SystemdScope::User => "default.target",
    };
    s.push_str(&format!("WantedBy={wanted_by}\n"));
    s
}

/// Print the access info: URL, management tip per mechanism, future-run
/// foreground command, update channel line, and a security note when remote
/// writes is enabled.
#[allow(clippy::too_many_arguments)]
fn write_access_info<W: Write>(
    stdout: &mut W,
    mechanism: &ServiceManager,
    host: &str,
    port: u16,
    state_dir: &Path,
    allow_remote_writes: bool,
    update_channel: Option<UpdateChannel>,
    exe: &Path,
    args: &[String],
) {
    let bind_all = BindMode::parse(host) == Some(BindMode::All);
    writeln!(
        stdout,
        "Termul server is starting in the background on http://localhost:{port}"
    )
    .ok();
    if bind_all {
        writeln!(
            stdout,
            "(bound to 0.0.0.0 — use the server's LAN/public IP for remote devices)"
        )
        .ok();
    }
    writeln!(stdout, "Open that URL in a browser to use the web client.").ok();
    match mechanism {
        ServiceManager::Systemd { scope } => {
            // Scope-aware commands: user units must be addressed via
            // `--user` or the commands hit the (empty) system instance.
            let u = match scope {
                SystemdScope::User => " --user",
                SystemdScope::System => "",
            };
            writeln!(stdout, "Logs: journalctl{u} -u termul-server -f").ok();
            writeln!(stdout, "Stop:  systemctl{u} stop termul-server").ok();
            writeln!(
                stdout,
                "Note: survives logout + reboot (systemd manages auto-start)."
            )
            .ok();
        }
        ServiceManager::Setsid => {
            let log = state_dir.join("termul-server.log").display().to_string();
            let pid = state_dir.join("termul-server.pid").display().to_string();
            writeln!(stdout, "Logs: tail -f {log}").ok();
            writeln!(stdout, "Stop:  kill $(cat {pid})").ok();
            writeln!(
                stdout,
                "Note: this background process does NOT auto-restart on crash or reboot."
            )
            .ok();
        }
    }
    if let Some(channel) = update_channel {
        writeln!(
            stdout,
            "Updates: {} channel (TERMUL_SERVER_UPDATE_ENABLED + _CHANNEL + _INTERVAL_SECS)",
            channel_name(channel)
        )
        .ok();
    }
    let exe_name = exe
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("termul-server");
    writeln!(
        stdout,
        "For a foreground run: {exe_name} {}",
        args.join(" ")
    )
    .ok();
    if allow_remote_writes && bind_all {
        writeln!(
            stdout,
            "Security: remote writes are ENABLED — non-loopback peers can mutate the \
             server. Restrict network exposure until web auth lands (Epic 2)."
        )
        .ok();
    }
}

// ---------------------------------------------------------------------------
// Prompting helpers (synchronous std::io, no new crate).
// ---------------------------------------------------------------------------

/// Prompt with a default; validate via `parse`; retry on error with the
/// validator's message. Empty line keeps the default. On EOF, use the default
/// or exit 0 (never crash).
fn prompt_validated<R, W, T, F>(
    stdin: &mut R,
    stdout: &mut W,
    label: &str,
    default: &str,
    parse: F,
) -> T
where
    R: BufRead,
    W: Write,
    F: Fn(&str) -> Result<T, String>,
{
    loop {
        write!(stdout, "{label} [{default}]: ").ok();
        stdout.flush().ok();
        let mut line = String::new();
        let n = stdin.read_line(&mut line).unwrap_or(0);
        if n == 0 {
            return match parse(default) {
                Ok(v) => v,
                Err(_) => {
                    writeln!(stdout, "(EOF — exiting)").ok();
                    std::process::exit(0);
                }
            };
        }
        let trimmed = line.trim();
        let input = if trimmed.is_empty() { default } else { trimmed };
        match parse(input) {
            Ok(v) => return v,
            Err(e) => {
                let _ = writeln!(stdout, "{e}");
            }
        }
    }
}

/// A yes/no prompt. Empty line keeps `default_yes`. Retries on unrecognized
/// input (e.g. a typo like "ye"/"tru") with a hint, mirroring
/// [`prompt_validated`]'s retry-on-error UX instead of silently treating the
/// typo as a hard "no".
fn prompt_yesno<R: BufRead, W: Write>(
    stdin: &mut R,
    stdout: &mut W,
    label: &str,
    default_yes: bool,
) -> bool {
    let default_str = if default_yes { "Y/n" } else { "y/N" };
    loop {
        write!(stdout, "{label} [{default_str}]: ").ok();
        stdout.flush().ok();
        let mut line = String::new();
        let n = stdin.read_line(&mut line).unwrap_or(0);
        if n == 0 {
            // EOF — keep the default rather than crash.
            return default_yes;
        }
        let t = line.trim().to_ascii_lowercase();
        if t.is_empty() {
            return default_yes;
        }
        if t == "y" || t == "yes" {
            return true;
        }
        if t == "n" || t == "no" {
            return false;
        }
        writeln!(stdout, "Please answer 'y' or 'n' (or press Enter for the default).").ok();
    }
}

// ---------------------------------------------------------------------------
// run() — entry point wired by server_main.rs's --onboard branch.
// ---------------------------------------------------------------------------

/// Entry point. Detects TTY; the non-TTY path resolves defaults and exits 0
/// without installing/spawning. The TTY path collects answers, prints access
/// info, launches in the background, and emits a durable boundary log.
pub fn run() -> ExitCode {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    if !stdin.is_terminal() {
        return run_non_tty(&mut stdout.lock());
    }
    run_interactive(&mut stdin.lock(), &mut stdout.lock())
}

/// Non-TTY path: resolve defaults, print the default command, the mechanism
/// tip, and the non-TTY note, then exit 0 without installing/spawning/binding.
/// Verification-safe: the server itself is never launched. Detection still
/// runs benign probes (`systemctl --version`, `id -u`) to resolve the
/// mechanism tip — these do not start the server or mutate state.
fn run_non_tty<W: Write>(stdout: &mut W) -> ExitCode {
    let answers = OnboardAnswers::defaults();
    let args = answers.to_command_args();
    let mechanism = ServiceManager::detect();
    let exe = std::env::current_exe()
        .unwrap_or_else(|_| PathBuf::from("termul-server"));
    let exe_name = exe
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("termul-server");
    writeln!(
        stdout,
        "termul-server onboard: stdin is not a TTY; using defaults — re-run in a terminal to launch."
    )
    .ok();
    writeln!(stdout, "Default command: {exe_name} {}", args.join(" ")).ok();
    writeln!(stdout, "{}", mechanism.tip()).ok();
    ExitCode::SUCCESS
}

/// TTY path: collect → synthesize → access info → launch → boundary log.
fn run_interactive<R: BufRead, W: Write>(stdin: &mut R, stdout: &mut W) -> ExitCode {
    let answers = OnboardAnswers::collect(stdin, stdout);
    let args = answers.to_command_args();
    let env_lines = answers.to_env_lines();
    let cfg = answers.to_server_config();
    let state_dir = cfg.service_account_state_dir();
    let _ = std::fs::create_dir_all(&state_dir);
    let exe = std::env::current_exe()
        .unwrap_or_else(|_| PathBuf::from("termul-server"));

    // Optional env-file write. The env file is used ONLY by systemd's
    // `EnvironmentFile=` directive — the setsid child always receives the
    // env vars directly via its process env, regardless of the write choice.
    // So `child_env_lines` is `env_lines` whenever there are vars to pass;
    // only `env_path` depends on the operator's write decision. This keeps
    // the update config (and remote-writes env) effective even when the
    // operator declines the env file.
    let (env_path, child_env_lines): (Option<PathBuf>, Vec<String>) = if !env_lines.is_empty() {
        let env_file = state_dir.join("termul-server.env");
        let write = prompt_yesno(
            stdin,
            stdout,
            &format!("Write env file to {}?", env_file.display()),
            true,
        );
        if write {
            let content = format!("{}\n", env_lines.join("\n"));
            match std::fs::write(&env_file, content) {
                Ok(()) => (Some(env_file), env_lines.clone()),
                Err(e) => {
                    writeln!(stdout, "warning: failed to write env file: {e}").ok();
                    (None, env_lines.clone())
                }
            }
        } else {
            (None, env_lines.clone())
        }
    } else {
        (None, Vec::new())
    };

    let mechanism = ServiceManager::detect();
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("LOGNAME"))
        .unwrap_or_else(|_| "root".to_string());

    // Access info immediately before the launch.
    write_access_info(
        stdout,
        &mechanism,
        &answers.host,
        answers.port,
        &state_dir,
        answers.allow_remote_writes,
        answers.update_channel,
        &exe,
        &args,
    );

    match mechanism.install_and_start(
        &exe,
        &args,
        env_path.as_deref(),
        &child_env_lines,
        &state_dir,
        &user,
    ) {
        Ok(()) => {
            tracing::info!(
                target: "termul::onboard",
                host = %answers.host,
                port = answers.port,
                project_root = %answers.project_root.display(),
                sessions_dir = %answers.sessions_dir.display(),
                allow_remote_writes = answers.allow_remote_writes,
                update_channel = ?answers.update_channel,
                mechanism = ?mechanism,
                "onboard completed: server launched in background"
            );
            writeln!(stdout, "Onboarding complete. The server is running in the background.").ok();
            ExitCode::SUCCESS
        }
        Err(e) => {
            tracing::error!(
                target: "termul::onboard",
                mechanism = ?mechanism,
                error = %e,
                "onboard failed: background launch did not start"
            );
            writeln!(stdout, "error: {e}").ok();
            writeln!(
                stdout,
                "Foreground command: {} {}",
                exe.display(),
                args.join(" ")
            )
            .ok();
            ExitCode::from(1)
        }
    }
}

// ---------------------------------------------------------------------------
// Tests — synthesis, detection predicate, unit text, non-TTY path.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn answers_localhost() -> OnboardAnswers {
        OnboardAnswers {
            host: "127.0.0.1".into(),
            port: 8080,
            project_root: PathBuf::from("/home/opus"),
            sessions_dir: PathBuf::from("/home/opus/.local/state/termul/sessions"),
            allow_remote_writes: false,
            update_channel: None,
            update_interval_secs: 21600,
        }
    }

    fn answers_expose_remote() -> OnboardAnswers {
        OnboardAnswers {
            host: "0.0.0.0".into(),
            port: 8080,
            project_root: PathBuf::from("/home/opus"),
            sessions_dir: PathBuf::from("/home/opus/.local/state/termul/sessions"),
            allow_remote_writes: true,
            update_channel: None,
            update_interval_secs: 21600,
        }
    }

    fn answers_with_update() -> OnboardAnswers {
        OnboardAnswers {
            host: "127.0.0.1".into(),
            port: 8080,
            project_root: PathBuf::from("/home/opus"),
            sessions_dir: PathBuf::from("/home/opus/.local/state/termul/sessions"),
            allow_remote_writes: false,
            update_channel: Some(UpdateChannel::Stable),
            update_interval_secs: 21600,
        }
    }

    #[test]
    fn command_args_loopback_no_remote_writes() {
        let a = answers_localhost();
        let args = a.to_command_args();
        assert_eq!(
            args,
            vec![
                "--host".to_string(),
                "127.0.0.1".into(),
                "--port".into(),
                "8080".into(),
                "--project-root".into(),
                "/home/opus".into(),
                "--sessions-dir".into(),
                "/home/opus/.local/state/termul/sessions".into(),
            ]
        );
        assert!(!args.iter().any(|a| a == "--allow-remote-writes"));
    }

    #[test]
    fn command_args_expose_remote_writes_adds_flag() {
        let a = answers_expose_remote();
        let args = a.to_command_args();
        assert!(args.iter().any(|a| a == "--allow-remote-writes"));
    }

    #[test]
    fn env_lines_loopback_no_updates_has_shell_home_only() {
        // Loopback + no updates: the only env lines are SHELL and HOME
        // (always emitted so the service can resolve the login PATH).
        // The test env may or may not have these set, so assert the
        // invariant: no remote-writes or update vars are present.
        let a = answers_localhost();
        let lines = a.to_env_lines();
        assert!(
            !lines
                .iter()
                .any(|l| l.starts_with("TERMUL_SERVER_ALLOW_REMOTE_WRITES")),
            "loopback must not emit remote-writes"
        );
        assert!(
            !lines.iter().any(|l| l.starts_with("TERMUL_SERVER_UPDATE")),
            "no update channel must not emit update vars"
        );
        // SHELL and HOME are present (when the env var is set in the
        // test process — both are set under `cargo test`).
        if std::env::var_os("SHELL").is_some() {
            assert!(lines.iter().any(|l| l.starts_with("SHELL=")));
        }
        if std::env::var_os("HOME").is_some() {
            assert!(lines.iter().any(|l| l.starts_with("HOME=")));
        }
    }

    #[test]
    fn env_lines_expose_remote_writes() {
        let a = answers_expose_remote();
        let lines = a.to_env_lines();
        assert!(lines
            .iter()
            .any(|l| l == "TERMUL_SERVER_ALLOW_REMOTE_WRITES=true"));
    }

    #[test]
    fn env_lines_with_update_channel() {
        let a = answers_with_update();
        let lines = a.to_env_lines();
        assert!(lines.iter().any(|l| l == "TERMUL_SERVER_UPDATE_ENABLED=true"));
        assert!(lines
            .iter()
            .any(|l| l == "TERMUL_SERVER_UPDATE_CHANNEL=stable"));
        assert!(lines
            .iter()
            .any(|l| l == "TERMUL_SERVER_UPDATE_INTERVAL_SECS=21600"));
    }

    #[test]
    fn to_server_config_loopback_disables_remote_writes() {
        let a = answers_localhost();
        let cfg = a.to_server_config();
        assert!(!cfg.allow_remote_writes);
        assert_eq!(cfg.host, "127.0.0.1");
        assert_eq!(cfg.port, 8080);
        assert_eq!(cfg.project_root, PathBuf::from("/home/opus"));
        assert_eq!(
            cfg.sessions_dir.as_ref(),
            Some(&PathBuf::from("/home/opus/.local/state/termul/sessions"))
        );
    }

    #[test]
    fn to_server_config_expose_enables_remote_writes() {
        let a = answers_expose_remote();
        let cfg = a.to_server_config();
        assert!(cfg.allow_remote_writes);
    }

    #[test]
    fn detect_from_systemd_root_is_system_scope() {
        assert_eq!(
            detect_from(true, true),
            ServiceManager::Systemd {
                scope: SystemdScope::System
            }
        );
    }

    #[test]
    fn detect_from_systemd_nonroot_is_user_scope() {
        assert_eq!(
            detect_from(true, false),
            ServiceManager::Systemd {
                scope: SystemdScope::User
            }
        );
    }

    #[test]
    fn detect_from_no_systemd_is_setsid() {
        assert_eq!(detect_from(false, true), ServiceManager::Setsid);
        assert_eq!(detect_from(false, false), ServiceManager::Setsid);
    }

    #[test]
    fn systemd_unit_text_with_env_file_has_required_fields() {
        let unit = build_systemd_unit_text(
            "/usr/local/bin/termul-server --host 127.0.0.1",
            Some("/etc/termul/termul-server.env"),
            SystemdScope::System,
        );
        assert!(unit.contains("ExecStart="));
        assert!(unit.contains("EnvironmentFile="));
        assert!(unit.contains("Restart=on-failure"));
        assert!(unit.contains("WantedBy=multi-user.target"));
    }

    #[test]
    fn systemd_unit_text_without_env_file_omits_environment_file() {
        let unit = build_systemd_unit_text(
            "/usr/local/bin/termul-server --host 127.0.0.1",
            None,
            SystemdScope::System,
        );
        assert!(unit.contains("ExecStart="));
        assert!(!unit.contains("EnvironmentFile="));
        assert!(unit.contains("Restart=on-failure"));
    }

    #[test]
    fn systemd_unit_text_user_scope_uses_default_target() {
        // BH#2: user-scope units must use `default.target`, not
        // `multi-user.target` (which doesn't exist in the user systemd
        // instance and makes `systemctl --user enable` fail).
        let unit = build_systemd_unit_text(
            "/usr/local/bin/termul-server --host 127.0.0.1",
            None,
            SystemdScope::User,
        );
        assert!(
            unit.contains("WantedBy=default.target"),
            "user-scope unit must use default.target, got:\n{unit}"
        );
        assert!(
            !unit.contains("WantedBy=multi-user.target"),
            "user-scope unit must NOT use multi-user.target, got:\n{unit}"
        );
    }

    #[test]
    fn systemd_unit_text_system_scope_uses_multi_user_target() {
        let unit = build_systemd_unit_text(
            "/usr/local/bin/termul-server --host 127.0.0.1",
            None,
            SystemdScope::System,
        );
        assert!(unit.contains("WantedBy=multi-user.target"));
    }

    #[test]
    fn env_lines_expose_with_update_channel_orders_remote_then_update() {
        // BH#15: expose+update env-lines ordering + content.
        let mut a = answers_expose_remote();
        a.update_channel = Some(UpdateChannel::Nightly);
        a.update_interval_secs = 3600;
        let lines = a.to_env_lines();
        assert!(lines
            .iter()
            .any(|l| l == "TERMUL_SERVER_ALLOW_REMOTE_WRITES=true"));
        assert!(lines.iter().any(|l| l == "TERMUL_SERVER_UPDATE_ENABLED=true"));
        assert!(lines
            .iter()
            .any(|l| l == "TERMUL_SERVER_UPDATE_CHANNEL=nightly"));
        assert!(lines
            .iter()
            .any(|l| l == "TERMUL_SERVER_UPDATE_INTERVAL_SECS=3600"));
    }

    #[test]
    fn write_access_info_systemd_user_scope_includes_user_flag() {
        // BH#3: the TTY access-info path must print `--user` for user-scope
        // units (the non-TTY tip already did; this covers write_access_info).
        let mut out = Vec::new();
        write_access_info(
            &mut out,
            &ServiceManager::Systemd {
                scope: SystemdScope::User,
            },
            "127.0.0.1",
            8080,
            Path::new("/tmp"),
            false,
            None,
            Path::new("/usr/local/bin/termul-server"),
            &[],
        );
        let s = String::from_utf8(out).unwrap();
        assert!(s.contains("journalctl --user -u termul-server"), "got: {s}");
        assert!(s.contains("systemctl --user stop termul-server"), "got: {s}");
    }

    #[test]
    fn write_access_info_systemd_system_scope_omits_user_flag() {
        let mut out = Vec::new();
        write_access_info(
            &mut out,
            &ServiceManager::Systemd {
                scope: SystemdScope::System,
            },
            "127.0.0.1",
            8080,
            Path::new("/tmp"),
            false,
            None,
            Path::new("/usr/local/bin/termul-server"),
            &[],
        );
        let s = String::from_utf8(out).unwrap();
        assert!(s.contains("journalctl -u termul-server"), "got: {s}");
        assert!(!s.contains("journalctl --user"), "got: {s}");
    }

    #[test]
    fn write_access_info_surfaces_update_channel_when_some() {
        // ECH#6: the chosen update channel must appear in stdout access info,
        // not just the boundary log.
        let mut out = Vec::new();
        write_access_info(
            &mut out,
            &ServiceManager::Setsid,
            "127.0.0.1",
            8080,
            Path::new("/tmp"),
            false,
            Some(UpdateChannel::Insider),
            Path::new("/usr/local/bin/termul-server"),
            &[],
        );
        let s = String::from_utf8(out).unwrap();
        assert!(s.contains("insider channel"), "got: {s}");
    }

    #[test]
    fn run_non_tty_exits_zero_and_prints_defaults_without_spawning() {
        let mut out = Vec::new();
        let code = run_non_tty(&mut out);
        assert_eq!(code, ExitCode::SUCCESS);
        let s = String::from_utf8(out).unwrap();
        assert!(s.contains("stdin is not a TTY"), "got: {s}");
        assert!(s.contains("Default command:"), "got: {s}");
        assert!(
            s.contains("Mechanism:"),
            "non-TTY path must print the mechanism tip, got: {s}"
        );
    }

    #[test]
    fn prompt_validated_retries_on_error_then_accepts_valid() {
        // Matrix row "Invalid answer then valid": a bad value is re-prompted
        // with the validator's message, then a valid value (or empty = default)
        // is accepted. Feed "abc" (invalid port) then "" (keep default 8080).
        let input = "abc\n\n".as_bytes();
        let mut stdin = std::io::BufReader::new(input);
        let mut stdout = Vec::new();
        let port: u16 = prompt_validated(
            &mut stdin,
            &mut stdout,
            "Bind port",
            "8080",
            |s| {
                let p: u16 = s
                    .parse()
                    .map_err(|_| format!("invalid port '{s}': expected 1-65535"))?;
                if p == 0 {
                    return Err("invalid port '0': use 1-65535".into());
                }
                Ok(p)
            },
        );
        assert_eq!(port, 8080, "empty line must keep the default after a bad input");
        let out = String::from_utf8(stdout).unwrap();
        assert!(
            out.contains("invalid port 'abc'"),
            "retry must surface the validator error, got: {out}"
        );
    }

    #[test]
    fn safe_systemd_env_line_rejects_control_chars_and_backslash() {
        use std::ffi::OsStr;
        assert_eq!(
            safe_systemd_env_line("HOME", OsStr::new("/root")),
            Some("HOME=/root".into())
        );
        assert!(safe_systemd_env_line("HOME", OsStr::new("/root\n")).is_none());
        assert!(safe_systemd_env_line("HOME", OsStr::new("/root\\")).is_none());
        assert!(safe_systemd_env_line("HOME", OsStr::new("")).is_none());
    }

    #[test]
    fn prompt_yesno_retries_on_unrecognized_then_accepts_no() {
        // BH#10: a typo ("ye") re-prompts instead of silently counting as "no";
        // a subsequent "n" is then accepted.
        let input = "ye\nn\n".as_bytes();
        let mut stdin = std::io::BufReader::new(input);
        let mut stdout = Vec::new();
        let yes = prompt_yesno(&mut stdin, &mut stdout, "Allow?", false);
        assert!(!yes, "second answer 'n' must return false");
        let out = String::from_utf8(stdout).unwrap();
        assert!(
            out.contains("Please answer 'y' or 'n'"),
            "unrecognized input must re-prompt, got: {out}"
        );
    }
}
