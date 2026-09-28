//! Refresh `Path` / `PATH` from OS sources before PTY spawn.
//!
//! Termul's GUI process keeps a snapshot of the environment from launch time.
//! Global installs and registry updates are invisible until we re-read PATH here.

use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;

const PATH_PROBE_MARKER: &str = "__TERMUL_LOGIN_PATH__=";

/// Process-lifetime cache for the OS-probed PATH, so `fresh_path()` does not
/// spawn a login shell (Unix) or read the registry (Windows) on every agent
/// launch. Matches the `RG_PATH_CACHE` pattern in `commands.rs`.
static FRESH_PATH_CACHE: OnceLock<Option<String>> = OnceLock::new();

#[cfg(target_os = "windows")]
fn has_path_key(env: &HashMap<String, String>) -> bool {
    env.keys().any(|k| k.eq_ignore_ascii_case("path"))
}

#[cfg(target_os = "windows")]
fn get_path_from_map(env: &HashMap<String, String>) -> String {
    env.iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("path"))
        .map(|(_, v)| v.clone())
        .unwrap_or_default()
}

#[cfg(target_os = "windows")]
fn set_path_in_map(env: &mut HashMap<String, String>, value: String) {
    if let Some(existing_key) = env.keys().find(|k| k.eq_ignore_ascii_case("path")).cloned() {
        env.remove(&existing_key);
    }
    env.insert("Path".to_string(), value);
}

/// Merge `registry` and `inherited` PATH segments (platform delimiter), keeping
/// registry order first then appending inherited segments not already present.
pub fn merge_path_segments(registry: &str, inherited: &str, delimiter: char) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<String> = Vec::new();

    // Semicolon-separated paths follow Windows rules (case-insensitive dedupe).
    let case_insensitive = delimiter == ';';

    let mut push_segment = |seg: &str| {
        let trimmed = seg.trim();
        if trimmed.is_empty() {
            return;
        }
        let key = if case_insensitive {
            trimmed.to_ascii_lowercase()
        } else {
            trimmed.to_string()
        };
        if seen.insert(key) {
            out.push(trimmed.to_string());
        }
    };

    for seg in registry.split(delimiter) {
        push_segment(seg);
    }
    for seg in inherited.split(delimiter) {
        push_segment(seg);
    }

    out.join(&delimiter.to_string())
}

#[cfg(target_os = "windows")]
fn expand_windows_env_value(value: &str) -> String {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use winapi::um::processenv::ExpandEnvironmentStringsW;

    if value.is_empty() {
        return String::new();
    }

    let wide: Vec<u16> = OsStr::new(value).encode_wide().chain(Some(0)).collect();
    let mut buf = vec![0u16; 32_768];
    unsafe {
        let needed = ExpandEnvironmentStringsW(wide.as_ptr(), buf.as_mut_ptr(), buf.len() as u32);
        if needed == 0 || needed as usize > buf.len() {
            return value.to_string();
        }
        let len = needed.saturating_sub(1) as usize;
        String::from_utf16_lossy(&buf[..len])
    }
}

#[cfg(target_os = "windows")]
fn read_windows_registry_path() -> Option<String> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    let machine = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment")
        .ok()
        .and_then(|k| k.get_value::<String, _>("Path").ok())
        .map(|s| expand_windows_env_value(&s))
        .filter(|s| !s.is_empty());

    let user = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Environment")
        .ok()
        .and_then(|k| k.get_value::<String, _>("Path").ok())
        .map(|s| expand_windows_env_value(&s))
        .filter(|s| !s.is_empty());

    match (machine, user) {
        (Some(m), Some(u)) => Some(merge_path_segments(&m, &u, ';')),
        (Some(m), None) => Some(m),
        (None, Some(u)) => Some(u),
        (None, None) => None,
    }
}

/// PATH string for executable resolution (registry/login probe, else process env).
pub fn path_for_resolution() -> std::ffi::OsString {
    fresh_path()
        .map(std::ffi::OsString::from)
        .or_else(|| std::env::var_os("PATH"))
        .unwrap_or_default()
}

/// Returns the refreshed PATH string for the current platform, if obtainable.
/// Cached for the process lifetime via `FRESH_PATH_CACHE` so the probe runs at
/// most once; subsequent calls return the cached result without spawning a
/// login shell or reading the registry.
pub fn fresh_path() -> Option<String> {
    FRESH_PATH_CACHE
        .get_or_init(|| {
            #[cfg(target_os = "windows")]
            {
                read_windows_registry_path()
            }

            #[cfg(not(target_os = "windows"))]
            {
                probe_unix_login_path()
            }
        })
        .clone()
}

#[cfg(not(target_os = "windows"))]
fn probe_unix_login_path() -> Option<String> {
    use std::process::Command;

    // Under desktop launchers and service managers, SHELL is often unset.
    // Resolve the account's configured login shell before falling back to
    // /bin/sh. On macOS, users commonly come from Open Directory and are not
    // listed in /etc/passwd, so use the system account database.
    let shell = select_login_shell(std::env::var("SHELL").ok(), login_shell_from_system());

    if !is_trusted_shell_path(&shell) {
        let shell_basename = Path::new(&shell)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("?");
        tracing::warn!(
            target: "termul::env_refresh",
            shell_basename,
            "login PATH probe skipped: shell path is not a trusted absolute executable"
        );
        return None;
    }

    let shell_name = Path::new(&shell)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("sh");

    let output = match shell_name {
        // Interactive startup files (for example ~/.zshrc) often add agent
        // tools to PATH. A desktop-launched app must probe the same PATH as a
        // user's interactive terminal, not only login-profile configuration.
        "bash" | "zsh" => run_shell_path_probe(
            &shell,
            "-ilc",
            "printf '\\n__TERMUL_LOGIN_PATH__=%s\\n' \"$PATH\"",
        )?,
        "fish" => run_shell_path_probe(
            &shell,
            "-ilc",
            "printf '\\n__TERMUL_LOGIN_PATH__=%s\\n' (string join : $PATH)",
        )?,
        // POSIX sh/dash/ash/ksh/busybox: source startup files with stdout
        // redirected so profile banners are not captured as PATH segments.
        // HOME is passed via Command::env from passwd identity, never
        // interpolated into the script.
        "sh" | "dash" | "ash" | "ksh" | "busybox" => {
            const POSIX_SCRIPT: &str = ". /etc/profile >/dev/null 2>/dev/null; \
                . \"$HOME/.profile\" >/dev/null 2>/dev/null; \
                printf '\\n__TERMUL_LOGIN_PATH__=%s\\n' \"$PATH\"";
            let mut cmd = Command::new(&shell);
            // BusyBox selects applets by argv[1]; `busybox -l -c` is invalid.
            if shell_name == "busybox" {
                cmd.args(["sh", "-l", "-c", POSIX_SCRIPT]);
            } else {
                cmd.args(["-l", "-c", POSIX_SCRIPT]);
            }
            if let Some(home) = service_identity_from_passwd()
                .map(|id| id.home)
                .or_else(|| std::env::var("HOME").ok().filter(|s| !s.is_empty()))
            {
                cmd.env("HOME", home);
            }
            match cmd.output() {
                Ok(o) => o,
                Err(e) => {
                    tracing::warn!(
                        target: "termul::env_refresh",
                        shell_basename = shell_name,
                        error = %e,
                        "login PATH probe failed: could not spawn shell"
                    );
                    return None;
                }
            }
        }
        other => {
            tracing::warn!(
                target: "termul::env_refresh",
                shell_basename = other,
                "login PATH probe skipped: unsupported shell for PATH probing"
            );
            return None;
        }
    };

    if !output.status.success() {
        tracing::warn!(
            target: "termul::env_refresh",
            shell_basename = shell_name,
            exit_code = ?output.status.code(),
            "login PATH probe failed: shell exited non-zero"
        );
        return None;
    }

    let Some(path) = parse_login_path_output(&output.stdout) else {
        tracing::warn!(
            target: "termul::env_refresh",
            shell_basename = shell_name,
            "login PATH probe failed: shell returned no PATH marker"
        );
        return None;
    };
    Some(path)
}

fn parse_login_path_output(output: &[u8]) -> Option<String> {
    let output = String::from_utf8_lossy(output);
    let (_, path) = output.rsplit_once(PATH_PROBE_MARKER)?;
    let path = path.lines().next()?.trim();
    (!path.is_empty()).then(|| path.to_string())
}

/// Service identity (`HOME`, `SHELL`) for the current user from `/etc/passwd`.
#[cfg(not(target_os = "windows"))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ServiceIdentity {
    pub home: String,
    pub shell: String,
}

/// Resolve the current user's `HOME` and login `SHELL` from `/etc/passwd`.
/// Used by onboard env-file generation (never trust caller env). Unix-only.
#[cfg(not(target_os = "windows"))]
pub(crate) fn service_identity_from_passwd() -> Option<ServiceIdentity> {
    let user = current_passwd_user()?;
    let passwd = std::fs::read_to_string("/etc/passwd").ok()?;
    passwd.lines().find_map(|line| {
        let mut fields = line.splitn(7, ':');
        let name = fields.next()?;
        let _ = fields.next()?; // passwd
        let _ = fields.next()?; // uid
        let _ = fields.next()?; // gid
        let _ = fields.next()?; // gecos
        let home = fields.next()?;
        let shell = fields.next()?;
        if name == user
            && !home.is_empty()
            && home.starts_with('/')
            && !shell.is_empty()
            && shell.starts_with('/')
        {
            Some(ServiceIdentity {
                home: home.to_string(),
                shell: shell.to_string(),
            })
        } else {
            None
        }
    })
}

/// Resolve the current user's login shell from the operating system account
/// database. macOS users may come from Open Directory and not be present in
/// `/etc/passwd`.
#[cfg(not(target_os = "windows"))]
pub(crate) fn login_shell_from_system() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        login_shell_from_macos_account()
            .or_else(|| service_identity_from_passwd().map(|id| id.shell))
    }

    #[cfg(not(target_os = "macos"))]
    {
        service_identity_from_passwd().map(|id| id.shell)
    }
}

#[cfg(not(target_os = "windows"))]
fn select_login_shell(shell_env: Option<String>, system_shell: Option<String>) -> String {
    shell_env
        .filter(|shell| !shell.is_empty())
        .filter(|shell| is_trusted_shell_path(shell))
        .or(system_shell.filter(|shell| is_trusted_shell_path(shell)))
        .unwrap_or_else(|| "/bin/sh".to_string())
}

/// Resolve the login shell through macOS's account database (including Open
/// Directory) without relying on the process-wide, non-thread-safe getpwuid.
#[cfg(target_os = "macos")]
fn login_shell_from_macos_account() -> Option<String> {
    use std::ffi::CStr;

    let mut buffer = vec![0_u8; 16 * 1024];
    loop {
        let mut account: libc::passwd = unsafe { std::mem::zeroed() };
        let mut result = std::ptr::null_mut();
        // SAFETY: `account`, `buffer`, and `result` remain valid for the call.
        // getpwuid_r writes any returned strings into `buffer`.
        let status = unsafe {
            libc::getpwuid_r(
                libc::getuid(),
                &mut account,
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                &mut result,
            )
        };

        if status == libc::ERANGE && buffer.len() < 1024 * 1024 {
            buffer.resize(buffer.len() * 2, 0);
            continue;
        }
        if status != 0 || result.is_null() || account.pw_shell.is_null() {
            return None;
        }

        // SAFETY: getpwuid_r populated pw_shell in `buffer` on success.
        return unsafe { CStr::from_ptr(account.pw_shell) }
            .to_str()
            .ok()
            .filter(|shell| !shell.is_empty())
            .map(str::to_owned);
    }
}

#[cfg(not(target_os = "windows"))]
fn current_passwd_user() -> Option<String> {
    std::env::var("USER")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("LOGNAME").ok().filter(|s| !s.is_empty()))
}

/// Run a login-shell probe and log spawn failures.
#[cfg(not(target_os = "windows"))]
fn run_shell_path_probe(shell: &str, flag: &str, script: &str) -> Option<std::process::Output> {
    run_shell_path_probe_with_env(shell, flag, script, &[])
}

#[cfg(not(target_os = "windows"))]
fn run_shell_path_probe_with_env(
    shell: &str,
    flag: &str,
    script: &str,
    extra_env: &[(&str, &str)],
) -> Option<std::process::Output> {
    let shell_name = Path::new(shell)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("?");
    let mut command = std::process::Command::new(shell);
    command.args([flag, script]).envs(extra_env.iter().copied());
    match command.output() {
        Ok(o) => Some(o),
        Err(e) => {
            tracing::warn!(
                target: "termul::env_refresh",
                shell_basename = shell_name,
                error = %e,
                "login PATH probe failed: could not spawn shell"
            );
            None
        }
    }
}

/// True when `shell` is an absolute path to a known login-shell executable.
#[cfg(not(target_os = "windows"))]
fn is_trusted_shell_path(shell: &str) -> bool {
    let p = Path::new(shell);
    if !p.is_absolute() || !p.exists() {
        return false;
    }
    let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
    matches!(
        name,
        "bash" | "zsh" | "fish" | "sh" | "dash" | "ash" | "ksh" | "busybox"
    )
}

/// Apply a refreshed PATH to `env`, preserving custom overrides already present.
pub fn apply_fresh_path(env: &mut HashMap<String, String>) {
    let delimiter = if cfg!(target_os = "windows") {
        ';'
    } else {
        ':'
    };

    let inherited = {
        #[cfg(target_os = "windows")]
        {
            if has_path_key(env) {
                get_path_from_map(env)
            } else {
                std::env::var("PATH").unwrap_or_default()
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            env.get("PATH")
                .cloned()
                .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default())
        }
    };

    let Some(registry_or_probed) = fresh_path() else {
        return;
    };

    let merged = merge_path_segments(&registry_or_probed, &inherited, delimiter);

    #[cfg(target_os = "windows")]
    set_path_in_map(env, merged);

    #[cfg(not(target_os = "windows"))]
    env.insert("PATH".to_string(), merged);
}

/// Whether an interactive shell spawn should pass a login-shell flag.
// Only invoked from the non-Windows PTY spawn path; on Windows it is exercised
// solely by unit tests, so a non-test Windows build sees it as unused.
#[cfg_attr(windows, allow(dead_code))]
pub fn shell_wants_login_arg(shell_path: &str) -> Option<&'static str> {
    let name = Path::new(shell_path)
        .file_name()
        .and_then(|s| s.to_str())?
        .to_ascii_lowercase();

    match name.as_str() {
        "bash" | "zsh" => Some("-l"),
        "fish" => Some("-l"),
        #[cfg(not(target_os = "windows"))]
        "pwsh" | "powershell" => Some("-Login"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_dedupes_case_insensitively_on_windows_style() {
        let merged = merge_path_segments(r"C:\Tools;C:\App", r"C:\tools;C:\Extra", ';');
        assert_eq!(merged, r"C:\Tools;C:\App;C:\Extra");
    }

    #[test]
    fn merge_unix_colon_delimiter() {
        let merged = merge_path_segments("/usr/bin", "/bin:/usr/bin", ':');
        assert_eq!(merged, "/usr/bin:/bin");
    }

    #[test]
    fn merge_skips_empty_segments() {
        let merged = merge_path_segments(";;/a", "/b;;", ';');
        assert_eq!(merged, "/a;/b");
    }

    #[test]
    fn shell_login_arg_for_bash() {
        assert_eq!(shell_wants_login_arg("/usr/bin/bash"), Some("-l"));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn trusted_shell_path_rejects_relative() {
        assert!(!is_trusted_shell_path("bash"));
        assert!(!is_trusted_shell_path("./bin/bash"));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn trusted_shell_path_accepts_known_absolute_shells() {
        for candidate in ["/bin/bash", "/bin/sh", "/bin/dash"] {
            if Path::new(candidate).exists() {
                assert!(
                    is_trusted_shell_path(candidate),
                    "expected trusted: {candidate}"
                );
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn missing_shell_environment_uses_system_login_shell() {
        let expected = ["/bin/zsh", "/bin/bash", "/bin/sh"]
            .into_iter()
            .find(|shell| is_trusted_shell_path(shell))
            .expect("Unix should provide a trusted shell");
        assert_eq!(
            select_login_shell(None, Some(expected.to_string())),
            expected
        );
    }

    #[test]
    fn path_probe_ignores_interactive_shell_startup_output() {
        assert_eq!(
            parse_login_path_output(
                b"zsh startup notice\n__TERMUL_LOGIN_PATH__=/custom/bin:/usr/bin\n"
            ),
            Some("/custom/bin:/usr/bin".to_string())
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_account_database_resolves_the_login_shell() {
        let shell = login_shell_from_macos_account()
            .expect("macOS account database should provide the current user's login shell");
        assert!(
            is_trusted_shell_path(&shell),
            "account database returned an unsupported shell: {shell}"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn interactive_zsh_probe_includes_zshrc_path() {
        let zsh = Path::new("/bin/zsh");
        if !zsh.exists() {
            return;
        }

        let config_dir = tempfile::tempdir().expect("create temporary zsh config");
        std::fs::write(
            config_dir.path().join(".zshrc"),
            "export PATH=\"/termul-regression-bin:$PATH\"\n",
        )
        .expect("write temporary zshrc");
        let zdotdir = config_dir
            .path()
            .to_str()
            .expect("temporary config path is UTF-8");

        let output = run_shell_path_probe_with_env(
            zsh.to_str().expect("zsh path is UTF-8"),
            "-ilc",
            "printf '\\n__TERMUL_LOGIN_PATH__=%s\\n' \"$PATH\"",
            &[
                ("PATH", "/usr/bin:/bin:/usr/sbin:/sbin"),
                ("ZDOTDIR", zdotdir),
            ],
        )
        .expect("run interactive login zsh PATH probe");
        assert!(
            output.status.success(),
            "zsh PATH probe failed with {:?}",
            output.status.code()
        );
        let path = parse_login_path_output(&output.stdout).expect("PATH marker in zsh output");
        assert!(
            std::env::split_paths(&path).any(|entry| entry == Path::new("/termul-regression-bin")),
            "interactive .zshrc PATH entry was not detected"
        );
    }

    #[test]
    fn shell_login_arg_for_cmd_none() {
        assert_eq!(shell_wants_login_arg("cmd.exe"), None);
    }
}
