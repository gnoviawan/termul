//! Project-folder scoping for the web `/worktree/list` response.
//!
//! AD-9 / CAP-14: worktrees checked out outside the registered project folder
//! are LISTED (so the renderer can show a disabled row with the reason) but
//! flagged `outsideProjectRoot: true`. Host containment is unchanged: every
//! act route (`create`, `remove`, `check-dirty`, `branches`, ...) still runs
//! `resolve_project_path`, which refuses paths outside the server's registered
//! roots, so a flagged worktree cannot be acted on through the web server.

use serde::{Deserialize, Serialize};

use crate::worktree::GitWorktreeEntry;

/// One `/worktree/list` row on the web wire: the git entry plus the outside-root flag.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebWorktreeEntry {
    #[serde(flatten)]
    pub entry: GitWorktreeEntry,
    /// `true` when the worktree path is not inside the project folder. Omitted
    /// from the wire when `false`.
    #[serde(default, skip_serializing_if = "is_false")]
    pub outside_project_root: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// Canonical comparison key: no Windows verbatim prefix, forward slashes, no
/// trailing slash, ASCII case-folded for Windows drive/UNC paths.
pub(super) fn path_key(path: &str) -> String {
    let stripped = crate::path_validation::strip_verbatim_prefix(path);
    let mut key = stripped.replace('\\', "/");
    while key.len() > 1 && key.ends_with('/') {
        key.pop();
    }
    let bytes = key.as_bytes();
    let is_windows_path = key.starts_with("//") || (bytes.len() >= 2 && bytes[1] == b':');
    if is_windows_path {
        key.make_ascii_lowercase();
    }
    key
}

/// Segment-bounded containment (`root` itself counts as inside).
fn is_inside(path: &str, root: &str) -> bool {
    let key = path_key(path);
    let root_key = path_key(root);
    key == root_key || key.starts_with(&format!("{}/", root_key.trim_end_matches('/')))
}

/// Mark each listed worktree as inside or outside `project_root`. Nothing is dropped.
pub fn scope_entries(entries: Vec<GitWorktreeEntry>, project_root: &str) -> Vec<WebWorktreeEntry> {
    entries
        .into_iter()
        .map(|entry| {
            let outside_project_root = !is_inside(&entry.path, project_root);
            WebWorktreeEntry {
                entry,
                outside_project_root,
            }
        })
        .collect()
}

#[cfg(test)]
#[path = "scope_tests.rs"]
mod tests;
