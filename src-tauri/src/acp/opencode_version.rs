//! OpenCode 2 detection for the ACP catalog.
//!
//! OpenCode 2 still speaks ACP protocol version 1 through `opencode acp`.
//! A machine that already has that binary on `PATH` or under `~/.opencode/bin`
//! can spawn it without downloading the pinned npm tarball. Version 1.x is
//! left for the catalog install path.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use crate::acp::config::resolve_runtime_executable;
use crate::acp::config::runtime_resolution_path;

/// Major version this probe accepts. OpenCode 3 would need its own check.
const OPENCODE_V2_MAJOR: u64 = 2;
const VERSION_TIMEOUT: Duration = Duration::from_secs(2);
const VERSION_MAX_BYTES: usize = 4_096;

/// Major version from `opencode --version` text.
///
/// Accepts `2.0.25`, `v2.0.25`, and a prefixed line whose last token is the
/// version (`opencode 2.0.25`). Returns `None` for empty or unparseable text.
#[must_use]
pub(crate) fn parse_opencode_major(output: &str) -> Option<u64> {
    let token = output.lines().find(|line| !line.trim().is_empty())?;
    let token = token.split_whitespace().next_back()?.trim();
    let token = token.strip_prefix('v').unwrap_or(token);
    let major = token.split(['.', '-', '+']).next()?;
    if major.is_empty() {
        return None;
    }
    major.parse().ok()
}

/// `true` when `output` reports OpenCode major version 2.
#[must_use]
pub(crate) fn is_opencode_v2(output: &str) -> bool {
    parse_opencode_major(output) == Some(OPENCODE_V2_MAJOR)
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(unix)]
    let home = std::env::var_os("HOME").map(PathBuf::from);
    #[cfg(windows)]
    let home = std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from));
    #[cfg(not(any(unix, windows)))]
    let home = std::env::var_os("HOME").map(PathBuf::from);
    home
}

fn is_runnable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .ok()
            .is_some_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn push_unique(out: &mut Vec<PathBuf>, candidate: PathBuf) {
    if out.iter().any(|existing| existing == &candidate) {
        return;
    }
    out.push(candidate);
}

/// PATH hit first, then `~/.opencode/bin`. Duplicates are dropped.
fn opencode_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(path) = resolve_runtime_executable("opencode", &runtime_resolution_path()) {
        push_unique(&mut out, path);
    }
    if let Some(home) = home_dir() {
        let bin = home.join(".opencode").join("bin");
        #[cfg(windows)]
        let names = ["opencode.exe", "opencode"];
        #[cfg(not(windows))]
        let names = ["opencode"];
        for name in names {
            let candidate = bin.join(name);
            if is_runnable(&candidate) {
                push_unique(&mut out, candidate);
            }
        }
    }
    out
}

fn read_version(path: &Path) -> Result<String, &'static str> {
    let mut child = Command::new(path)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "spawn")?;
    let mut stdout = child.stdout.take().ok_or("no-stdout")?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut chunk = [0_u8; 512];
        while buf.len() < VERSION_MAX_BYTES {
            match stdout.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    let room = VERSION_MAX_BYTES - buf.len();
                    buf.extend_from_slice(&chunk[..n.min(room)]);
                }
                Err(_) => break,
            }
        }
        let _ = tx.send(buf);
    });
    let bytes = match rx.recv_timeout(VERSION_TIMEOUT) {
        Ok(bytes) => bytes,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("timeout");
        }
    };
    match child.wait() {
        Ok(status) if status.success() => Ok(String::from_utf8_lossy(&bytes).into_owned()),
        Ok(_) => Err("exit"),
        Err(_) => Err("wait"),
    }
}

fn probe_log_info(message: &str) {
    log::info!("{message}");
    tracing::info!("{message}");
}

fn probe_log_warn(message: &str) {
    log::warn!("{message}");
    tracing::warn!("{message}");
}

/// First runnable OpenCode binary whose `--version` reports major 2.
///
/// Failures and 1.x binaries are skipped. The path itself is not logged.
#[must_use]
pub(crate) fn probe_external_opencode_v2() -> Option<PathBuf> {
    let candidates = opencode_candidates();
    if candidates.is_empty() {
        probe_log_info("[acp-catalog] opencode v2 probe miss reason=absent");
        return None;
    }
    for candidate in candidates {
        match read_version(&candidate) {
            Ok(output) if is_opencode_v2(&output) => {
                probe_log_info("[acp-catalog] opencode v2 probe hit");
                return Some(candidate);
            }
            Ok(_) => {
                probe_log_info("[acp-catalog] opencode probe skipped reason=not-v2");
            }
            Err(reason) => {
                probe_log_warn(&format!(
                    "[acp-catalog] opencode probe failed reason={reason}"
                ));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests;
