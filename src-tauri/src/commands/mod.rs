use crate::path_validation;
use serde::Serialize;
use std::path::PathBuf;

/// Validate and canonicalize a project path to prevent path traversal attacks.
/// Returns the canonicalized path or an error if the path is invalid or inaccessible.
fn validate_project_path(path: &str) -> Result<PathBuf, String> {
    let path_buf = PathBuf::from(path);

    // Canonicalize to resolve symlinks and relative paths
    let canonical = path_buf.canonicalize().map_err(|e| {
        log::warn!("[Security] Path validation failed for '{}': {}", path, e);
        format!("Invalid or inaccessible path: {}", e)
    })?;

    // On Windows, `canonicalize()` returns a verbatim (`\\?\…`) path. That prefix
    // defeats external tools such as `git.exe` (e.g. `git worktree add` fails with
    // "could not create leading directories …: Invalid argument"). Strip it so the
    // validated path stays tool-friendly while keeping the canonicalization benefits.
    let canonical_str = canonical.to_string_lossy();
    let simplified = path_validation::strip_verbatim_prefix(&canonical_str).into_owned();

    log::debug!("[Security] Path validated: {} -> {}", path, simplified);
    Ok(PathBuf::from(simplified))
}

/// Macro to validate a path and convert it to a String, returning early with an IpcResult error if validation fails.
macro_rules! validate_and_stringify {
    ($path:expr) => {
        match validate_project_path($path) {
            Ok(validated) => match validated.to_str() {
                Some(s) => s.to_string(),
                None => {
                    return Ok(IpcResult::error(
                        "Path contains invalid UTF-8",
                        "INVALID_PATH_ENCODING",
                    ))
                }
            },
            Err(e) => return Ok(IpcResult::error(e, "PATH_VALIDATION_FAILED")),
        }
    };
}

/// IPC Result pattern
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IpcResult<T> {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

impl<T> IpcResult<T> {
    pub fn success(data: T) -> Self {
        Self {
            success: true,
            data: Some(data),
            error: None,
            code: None,
        }
    }

    pub fn error(error: impl Into<String>, code: impl Into<String>) -> Self {
        Self {
            success: false,
            data: None,
            error: Some(error.into()),
            code: Some(code.into()),
        }
    }
}

pub mod acp_history;
pub mod browser;
pub mod canvas;
pub mod git;
pub mod migrations;
pub mod misc;
pub mod project_icon;
pub mod remote;
pub mod search;
pub mod ssh;
pub mod terminal;
pub mod workspace;
pub mod worktree;

pub use acp_history::*;
pub use browser::*;
pub use canvas::*;
pub use git::*;
pub use migrations::*;
pub use misc::*;
pub use project_icon::*;
pub use remote::*;
pub use search::*;
pub use ssh::*;
pub use terminal::*;
pub use workspace::*;
pub use worktree::*;

/// Get available shells
#[cfg(test)]
mod tests;

#[cfg(test)]
mod remote_sync_mcp_registry_tests;

#[cfg(test)]
mod forwarder_teardown_tests;
