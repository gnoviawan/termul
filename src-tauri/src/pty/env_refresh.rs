//! Refresh `Path` / `PATH` from OS sources before PTY spawn.
//!
//! Termul's GUI process keeps a snapshot of the environment from launch time.
//! Global installs and registry updates are invisible until we re-read PATH here.

use std::collections::HashMap;
use std::path::Path;

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
    if let Some(existing_key) = env
        .keys()
        .find(|k| k.eq_ignore_ascii_case("path"))
        .cloned()
    {
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
pub fn fresh_path() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        return read_windows_registry_path();
    }

    #[cfg(not(target_os = "windows"))]
    {
        probe_unix_login_path()
    }
}

#[cfg(not(target_os = "windows"))]
fn probe_unix_login_path() -> Option<String> {
    use std::process::Command;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let shell_name = Path::new(&shell)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("sh");

    let output = match shell_name {
        "bash" | "zsh" => Command::new(&shell)
            .args(["-lc", "printf %s \"$PATH\""])
            .output()
            .ok()?,
        "fish" => Command::new(&shell)
            .args(["-lc", "string join : $PATH"])
            .output()
            .ok()?,
        _ => return None,
    };

    if !output.status.success() {
        return None;
    }

    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

/// Apply a refreshed PATH to `env`, preserving custom overrides already present.
pub fn apply_fresh_path(env: &mut HashMap<String, String>) {
    let delimiter = if cfg!(target_os = "windows") { ';' } else { ':' };

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
        let merged = merge_path_segments(
            r"C:\Tools;C:\App",
            r"C:\tools;C:\Extra",
            ';',
        );
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
        assert_eq!(
            shell_wants_login_arg("/usr/bin/bash"),
            Some("-l")
        );
    }

    #[test]
    fn shell_login_arg_for_cmd_none() {
        assert_eq!(shell_wants_login_arg("cmd.exe"), None);
    }
}
