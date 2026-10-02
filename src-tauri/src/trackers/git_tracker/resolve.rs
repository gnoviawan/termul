use super::*;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Build a backend helper command.
/// On Windows this suppresses stray console windows from helper binaries like git.exe.
#[cfg(target_os = "windows")]
pub(super) fn backend_command(program: &str) -> Command {
    let mut command = Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(not(target_os = "windows"))]
pub(super) fn backend_command(program: &str) -> Command {
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

/// Resolve an arbitrary executable name to a concrete path.
///
/// On Windows, GUI-spawned processes do not get a shell's command resolution,
/// so a bare name like `gemini` (installed as `gemini.cmd`) fails to spawn.
/// This resolves the name against PATH/PATHEXT (reusing the same logic as the
/// git resolver) and returns the first match. An absolute/relative path, or a
/// name that cannot be resolved, is returned unchanged so the caller still gets
/// a meaningful spawn error. On Unix, the name is returned as-is because the OS
/// resolves bare names on PATH natively.
pub fn resolve_executable(command: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        if let Some(path) = resolve_command_candidates_from_path(command)
            .into_iter()
            .next()
        {
            return path;
        }
        command.to_string()
    }

    #[cfg(not(target_os = "windows"))]
    {
        command.to_string()
    }
}
