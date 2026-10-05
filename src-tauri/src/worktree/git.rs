use std::io::Read;
#[cfg(target_os = "windows")]
use std::path::Path;
use std::process::Stdio;

use super::*;

/// Build the `git worktree add` argument vector (subcommand args only — the
/// `git -c color.ui=false` prefix is added by `run_git`/`run_git_streaming`).
/// `-b <branch> <target> [start_ref]` selects new-branch mode; existing-branch
/// mode is `<target> <branch>`. `start_ref` is ignored unless `is_new_branch`.
pub(super) fn worktree_add_args<'a>(
    branch: &'a str,
    is_new_branch: bool,
    target: &'a str,
    start_ref: Option<&'a str>,
) -> Vec<&'a str> {
    let mut args = vec!["worktree", "add"];
    if is_new_branch {
        args.push("-b");
        args.push(branch);
        args.push(target);
        if let Some(ref_val) = start_ref {
            args.push(ref_val);
        }
    } else {
        args.push(target);
        args.push(branch);
    }
    args
}

/// Run a git command and return (stdout, stderr, success).
pub(super) fn run_git(args: &[&str], cwd: Option<&str>) -> Result<(String, String), WorktreeError> {
    let git = which_git()?;

    let mut cmd = quiet_command(&git);
    // `-c` must precede the subcommand. Pinning `color.ui=false` keeps a user
    // `color.ui=always` config from ANSI-wrapping the `fatal:`/`error:` line
    // prefixes that `parse_git_stderr` classifies on.
    cmd.arg("-c").arg("color.ui=false");
    cmd.args(args);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    let output = cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            WorktreeError::GitNotFound
        } else {
            WorktreeError::IoError(e.to_string())
        }
    })?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(parse_git_stderr(&stderr));
    }

    Ok((stdout, stderr))
}

/// Drain complete lines from `buf`. Git worktree progress uses `\r`-delimited
/// in-place updates (`Updating files: N%`) as well as regular `\n` lines, so a
/// line boundary is `\r`, `\n`, or `\r\n`. A partial trailing line stays in
/// `buf` for the next chunk.
pub(super) fn extract_lines(buf: &mut Vec<u8>) -> Vec<String> {
    let mut lines = Vec::new();
    let mut pos = 0usize;
    let mut i = 0usize;
    while i < buf.len() {
        if buf[i] == b'\r' || buf[i] == b'\n' {
            if i > pos {
                lines.push(String::from_utf8_lossy(&buf[pos..i]).to_string());
            }
            // Treat a "\r\n" pair as one delimiter.
            if buf[i] == b'\r' && i + 1 < buf.len() && buf[i + 1] == b'\n' {
                i += 1;
            }
            pos = i + 1;
        }
        i += 1;
    }
    buf.drain(..pos);
    lines
}

/// Run a git command, invoking `on_line` for each stderr line as it arrives.
/// Stdout is drained on a helper thread so a chatty child cannot deadlock on a
/// full pipe. Returns (stdout, full stderr) on success; on failure the stderr
/// is passed through `parse_git_stderr` like `run_git`.
pub(super) fn run_git_streaming(
    args: &[&str],
    cwd: Option<&str>,
    on_line: &mut dyn FnMut(&str),
) -> Result<(String, String), WorktreeError> {
    let git = which_git()?;

    let mut cmd = quiet_command(&git);
    // See `run_git` — `-c` must precede the subcommand.
    cmd.arg("-c").arg("color.ui=false");
    cmd.args(args);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            WorktreeError::GitNotFound
        } else {
            WorktreeError::IoError(e.to_string())
        }
    })?;

    let mut stdout = child.stdout.take().expect("stdout is piped");
    let stdout_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });

    let mut stderr_all = String::new();
    {
        let mut stderr = child.stderr.take().expect("stderr is piped");
        let mut buf: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            match stderr.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);
                    for line in extract_lines(&mut buf) {
                        let line = line.trim();
                        if !line.is_empty() {
                            stderr_all.push_str(line);
                            stderr_all.push('\n');
                            on_line(line);
                        }
                    }
                }
            }
        }
        let tail = String::from_utf8_lossy(&buf).trim().to_string();
        if !tail.is_empty() {
            stderr_all.push_str(&tail);
            stderr_all.push('\n');
            on_line(&tail);
        }
    }

    let status = child
        .wait()
        .map_err(|e| WorktreeError::IoError(e.to_string()))?;
    let stdout_bytes = stdout_handle.join().unwrap_or_default();
    let stdout = String::from_utf8_lossy(&stdout_bytes).to_string();

    if !status.success() {
        return Err(parse_git_stderr(&stderr_all));
    }

    Ok((stdout, stderr_all))
}

/// Find the `git` binary on PATH.
pub(super) fn which_git() -> Result<String, WorktreeError> {
    // On Windows, check common locations first
    #[cfg(target_os = "windows")]
    {
        let candidates = [
            "git.exe",
            "C:\\Program Files\\Git\\cmd\\git.exe",
            "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
        ];
        for candidate in &candidates {
            if Path::new(candidate).exists() {
                return Ok(candidate.to_string());
            }
        }
    }

    // Check PATH via `where git` (Windows) or `which git` (Unix)
    let cmd = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };

    let output = quiet_command(cmd)
        .arg("git")
        .output()
        .map_err(|_| WorktreeError::GitNotFound)?;

    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()
            .unwrap_or("git")
            .trim()
            .to_string();
        if !path.is_empty() {
            return Ok(path);
        }
    }

    Err(WorktreeError::GitNotFound)
}
