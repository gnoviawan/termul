//! Project registry — the renderer-published project → terminal tree.
//!
//! "Projects" are a renderer concept (Zustand stores). The Rust backend only
//! knows raw PTY terminal IDs. To render a project-grouped tree in the web
//! client, the desktop app pushes a snapshot of its current projects (and the
//! terminals belonging to each) into this registry via a Tauri command. The web
//! client reads it from `GET /api/projects`.
//!
//! The registry is a simple atomically-swapped snapshot: the renderer overwrites
//! the whole tree whenever its state changes. There is no merging — last write
//! wins — which keeps it trivially consistent.

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

/// One terminal entry within a project, as the web client sees it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTerminal {
    /// PTY id used for the WebSocket `terminal_id` query param.
    pub pty_id: String,
    /// Human-friendly tab name from the renderer.
    pub name: String,
    /// Optional current working directory (display only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

/// One project with its terminals.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProject {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub terminals: Vec<RemoteTerminal>,
}

/// The full tree the web client renders.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTree {
    pub projects: Vec<RemoteProject>,
}

/// Thread-safe holder for the latest project tree snapshot.
pub struct ProjectRegistry {
    tree: RwLock<ProjectTree>,
}

impl ProjectRegistry {
    pub fn new() -> Self {
        Self {
            tree: RwLock::new(ProjectTree::default()),
        }
    }

    /// Replace the entire tree with a renderer-published snapshot.
    pub fn replace(&self, tree: ProjectTree) {
        *self.tree.write() = tree;
    }

    /// Return a clone of the current tree (for JSON serialization).
    pub fn snapshot(&self) -> ProjectTree {
        self.tree.read().clone()
    }
}

impl Default for ProjectRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_starts_empty() {
        let r = ProjectRegistry::new();
        assert!(r.snapshot().projects.is_empty());
    }

    #[test]
    fn replace_overwrites_tree() {
        let r = ProjectRegistry::new();
        r.replace(ProjectTree {
            projects: vec![RemoteProject {
                id: "p1".into(),
                name: "Proj 1".into(),
                terminals: vec![RemoteTerminal {
                    pty_id: "terminal-1".into(),
                    name: "zsh".into(),
                    cwd: Some("/home/u".into()),
                }],
            }],
        });
        let snap = r.snapshot();
        assert_eq!(snap.projects.len(), 1);
        assert_eq!(snap.projects[0].terminals.len(), 1);
        assert_eq!(snap.projects[0].terminals[0].pty_id, "terminal-1");

        // Last write wins — replacing with empty clears it.
        r.replace(ProjectTree::default());
        assert!(r.snapshot().projects.is_empty());
    }
}
