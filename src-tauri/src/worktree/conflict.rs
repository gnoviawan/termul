use std::path::Path;

#[cfg(target_os = "windows")]
use super::quiet_command;

/// Helper struct to hold conflict block sections.
pub(super) struct ConflictBlock {
    pub(super) ours: String,
    pub(super) theirs: String,
    /// Diff3 common-ancestor section when present; reserved for future suggestions.
    #[allow(dead_code)]
    pub(super) base: String,
}

/// Convert a `.worktree-include` glob into a `Regex` for matching file paths
/// relative to the project root (forward slashes). Supports:
/// - `**` matches anything including `/`
/// - `*` matches anything except `/`
/// - `?` matches a single char (except `/`)
/// - everything else is escaped literally.
pub(super) fn glob_to_regex(glob: &str) -> Result<regex::Regex, regex::Error> {
    // Normalize: strip one leading slash so root-anchored patterns (e.g.
    // `/foo`) match the relative walk paths (which have no leading slash).
    // A trailing slash marks a recursive directory pattern (`foo/` matches
    // `foo/bar`, `foo/baz/qux`, ...) — append `.*` so it matches descendants.
    let trailing_dir = glob.ends_with('/');
    let trimmed = glob.strip_prefix('/').unwrap_or(glob).trim_end_matches('/');
    let mut out = String::with_capacity(trimmed.len() + 8);
    out.push('^');
    let mut chars = trimmed.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '*' => {
                if chars.peek() == Some(&'*') {
                    chars.next();
                    // `**/` -> match any path prefix (including empty)
                    if chars.peek() == Some(&'/') {
                        chars.next();
                        out.push_str("(?:.*/)?");
                    } else {
                        out.push_str(".*");
                    }
                } else {
                    out.push_str("[^/]*");
                }
            }
            '?' => out.push_str("[^/]"),
            '.' | '+' | '(' | ')' | '|' | '[' | ']' | '{' | '}' | '^' | '$' | '\\' => {
                out.push('\\');
                out.push(c);
            }
            '/' => out.push('/'),
            other => out.push(other),
        }
    }
    if trailing_dir {
        out.push_str(".*");
    }
    out.push('$');
    regex::Regex::new(&out)
}

/// Get an ISO 8601 timestamp string for the current time.
pub(super) fn chrono_timestamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    // Use chrono-compatible ISO 8601 format: YYYY-MM-DDTHHMMSSZ
    // Approximate Gregorian calendar from Unix timestamp
    let mut days = secs / 86400;
    let time_secs = secs % 86400;
    let hours = time_secs / 3600;
    let minutes = (time_secs % 3600) / 60;
    let seconds = time_secs % 60;

    // Civil date from days since epoch (proleptic Gregorian)
    let mut y = 1970i64;
    loop {
        let year_days = if is_leap(y) { 366 } else { 365 };
        if days < year_days {
            break;
        }
        days -= year_days;
        y += 1;
    }
    let month_days = if is_leap(y) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    let mut m = 0;
    for &md in &month_days {
        if days < md {
            break;
        }
        days -= md;
        m += 1;
    }
    format!(
        "{:04}-{:02}-{:02}T{:02}{:02}{:02}Z",
        y,
        m + 1,
        days as u32 + 1,
        hours,
        minutes,
        seconds
    )
}

/// Check if a year is a leap year.
fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

/// Get a timestamp 30 days from now as ISO string.
pub(super) fn thirty_days_from_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() + 30 * 86400;
    let mut days = secs / 86400;
    let time_secs = secs % 86400;
    let hours = time_secs / 3600;
    let minutes = (time_secs % 3600) / 60;
    let seconds = time_secs % 60;

    let mut y = 1970i64;
    loop {
        let year_days = if is_leap(y) { 366 } else { 365 };
        if days < year_days {
            break;
        }
        days -= year_days;
        y += 1;
    }
    let month_days = if is_leap(y) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    let mut m = 0;
    for &md in &month_days {
        if days < md {
            break;
        }
        days -= md;
        m += 1;
    }
    format!(
        "{:04}-{:02}-{:02}T{:02}{:02}{:02}Z",
        y,
        m + 1,
        days as u32 + 1,
        hours,
        minutes,
        seconds
    )
}

/// Create a directory symlink from `target` pointing to `source`.
///
/// On Windows, tries `symlink_dir()` first, falls back to creating a junction.
/// On Unix, uses `symlink()`.
pub(super) fn create_dir_symlink(source: &Path, target: &Path) -> Result<(), String> {
    // Ensure the parent directory of the target exists
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directory: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        // On Windows, try symlink_dir first (requires developer mode or admin)
        use std::os::windows::fs::symlink_dir;
        if symlink_dir(source, target).is_ok() {
            return Ok(());
        }

        // Fallback: create a directory junction using `mklink /J`
        let source_str = source.to_string_lossy().to_string();
        let target_str = target.to_string_lossy().to_string();
        let output = quiet_command("cmd")
            .args(["/C", "mklink", "/J", &target_str, &source_str])
            .output()
            .map_err(|e| format!("Failed to run mklink: {}", e))?;

        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!(
                "Failed to create symlink or junction for {}: {}",
                target.to_string_lossy(),
                stderr.trim()
            ))
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::os::unix::fs::symlink(source, target)
            .map_err(|e| format!("Failed to create symlink: {}", e))
    }
}
