//! In-memory project registry for the web/remote project-list mirror.
//!
//! A deliberate bridge to Epic 4's file-backed project registry / VFS roots. The
//! desktop renderer is the source of truth: on project-store mutation (while the
//! shared-live server runs) it pushes its non-archived + archived project
//! summaries + active id into here via the `remote_sync_projects` Tauri command
//! (`commands.rs`). The browser reads the mirror via `GET /projects`
//! (`projects_api.rs`) and switches projects via the `switch_project` WS request
//! (`ws.rs`, which resolves a project id → cwd here).
//!
//! # Scope fence (Epic 4 territory — do NOT build here)
//!
//! - NOT file-backed. Lives only while the server runs; cleared on
//!   `remote_server_stop`. Survives nothing.
//! - NO project CREATE/EDIT/DELETE from the web client (read + switch only).
//! - NO env-var values (secret or plain) — `ProjectSummary` redacts-by-omission.
//! - Does NOT change the desktop's active project — a web `switch_project`
//!   starts a new session at the project's cwd; it does not mutate the desktop.
//!
//! Constructible WITHOUT a Tauri `AppHandle` (`Send + Sync` via `parking_lot`)
//! so the standalone `termul-server` binary can pass an empty one to
//! `serve_router` (its `/projects` then returns an empty list until a future
//! Epic wires a server-side source).

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

/// A single project's summary as exposed to the web/remote client.
///
/// Mirrors `src/shared/types/web-projects.types.ts` `ProjectSummary` one-to-one
/// (camelCase wire). Carries NO env-var values — redact-by-omission (frozen
/// constraint). Only the identity/display fields a project switcher needs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    /// Stable project id (matches the desktop `Project.id`).
    pub id: String,
    /// Display name.
    pub name: String,
    /// Color token (one of the desktop `ProjectColor` literals, as a string).
    pub color: String,
    /// Working-directory path, or `None` when the project has no cwd (cannot switch).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// `true` when the project is archived (rendered greyed, not clickable).
    pub is_archived: bool,
    /// `true` when this is the desktop's active project.
    pub is_active: bool,
}

/// `GET /projects` response payload (wrapped in `IpcResult<T>` by the handler).
///
/// Mirrors `src/shared/types/web-projects.types.ts` `ProjectListPayload`.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectListPayload {
    /// Non-archived + archived summaries (the web list shows both, archived greyed).
    pub projects: Vec<ProjectSummary>,
    /// The desktop's active project id, or `None` when none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_project_id: Option<String>,
}

/// `projects_changed` WS event payload (agent-level: `sid: None`, `seq: 0`).
///
/// Carries only the new `activeProjectId` — the web client refetches
/// `GET /projects` for the full list rather than receiving it inline.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsChangedPayload {
    /// The desktop's new active project id, or `None` when none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_project_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct RegistryData {
    projects: Vec<ProjectSummary>,
    active_project_id: Option<String>,
}

/// In-memory, renderer-fed project registry (bridge to Epic 4).
///
/// `Arc<ProjectRegistry>` is shared between the router (read path + switch
/// resolution), the `remote_sync_projects` command (write path), and
/// `remote_server_stop` (clear). All mutation is behind a single
/// `parking_lot::Mutex` so a renderer sync and a `/projects` read never race.
#[derive(Default)]
pub struct ProjectRegistry {
    inner: Mutex<RegistryData>,
}

impl ProjectRegistry {
    /// Create an empty registry.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Replace the whole mirror atomically. Called by `remote_sync_projects`
    /// (renderer push) with the desktop's current non-archived + archived
    /// summaries + active id. The renderer is the source of truth — a fresh
    /// `set` fully supersedes the prior snapshot.
    pub fn set(&self, projects: Vec<ProjectSummary>, active_id: Option<String>) {
        let mut g = self.inner.lock();
        g.projects = projects;
        g.active_project_id = active_id;
    }

    /// Snapshot the current mirror for `GET /projects`. Clones the vec under
    /// the lock (the read is short); the caller serializes outside the lock.
    #[must_use]
    pub fn snapshot(&self) -> ProjectListPayload {
        let g = self.inner.lock();
        ProjectListPayload {
            projects: g.projects.clone(),
            active_project_id: g.active_project_id.clone(),
        }
    }

    /// Resolve a project id → its cwd (`path`), or `None` when the project is
    /// not in the registry or has no cwd. Used by the `switch_project` WS
    /// handler to start a new session at the project's path.
    #[must_use]
    pub fn find_path(&self, project_id: &str) -> Option<String> {
        let g = self.inner.lock();
        g.projects
            .iter()
            .find(|p| p.id == project_id)
            .and_then(|p| p.path.clone())
            .filter(|p| !p.trim().is_empty())
    }

    /// Clear the mirror (called on `remote_server_stop` so a stale list does
    /// not linger after the server is off). Idempotent.
    pub fn clear(&self) {
        let mut g = self.inner.lock();
        *g = RegistryData::default();
    }

    /// Number of projects currently mirrored (test helper / diagnostics).
    #[must_use]
    pub fn len(&self) -> usize {
        self.inner.lock().projects.len()
    }

    /// `true` when the mirror holds no projects.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(id: &str, path: Option<&str>, archived: bool) -> ProjectSummary {
        ProjectSummary {
            id: id.to_string(),
            name: format!("Proj {id}"),
            color: "blue".to_string(),
            path: path.map(str::to_string),
            is_archived: archived,
            is_active: false,
        }
    }

    #[test]
    fn snapshot_defaults_to_empty() {
        let reg = ProjectRegistry::new();
        assert!(reg.is_empty());
        let snap = reg.snapshot();
        assert!(snap.projects.is_empty());
        assert_eq!(snap.active_project_id, None);
    }

    #[test]
    fn set_replaces_and_snapshot_round_trips() {
        let reg = ProjectRegistry::new();
        reg.set(
            vec![sample("p-1", Some("/a"), false), sample("p-2", None, true)],
            Some("p-1".to_string()),
        );
        assert_eq!(reg.len(), 2);
        let snap = reg.snapshot();
        assert_eq!(snap.active_project_id.as_deref(), Some("p-1"));
        assert_eq!(snap.projects[0].id, "p-1");
        assert!(snap.projects[1].is_archived);

        // A second set fully supersedes the first.
        reg.set(vec![sample("p-3", Some("/c"), false)], None);
        assert_eq!(reg.len(), 1);
        let snap2 = reg.snapshot();
        assert_eq!(snap2.projects[0].id, "p-3");
        assert_eq!(snap2.active_project_id, None);
    }

    #[test]
    fn find_path_resolves_known_with_cwd() {
        let reg = ProjectRegistry::new();
        reg.set(
            vec![sample("p-1", Some("/a"), false), sample("p-2", None, false)],
            Some("p-1".to_string()),
        );
        assert_eq!(reg.find_path("p-1").as_deref(), Some("/a"));
        // No cwd → None (cannot switch).
        assert_eq!(reg.find_path("p-2"), None);
        // Unknown id → None.
        assert_eq!(reg.find_path("missing"), None);
        // Whitespace-only path → None.
        reg.set(vec![sample("p-x", Some("   "), false)], None);
        assert_eq!(reg.find_path("p-x"), None);
    }

    #[test]
    fn clear_empties_the_mirror() {
        let reg = ProjectRegistry::new();
        reg.set(vec![sample("p-1", Some("/a"), false)], Some("p-1".to_string()));
        assert!(!reg.is_empty());
        reg.clear();
        assert!(reg.is_empty());
        assert_eq!(reg.snapshot().active_project_id, None);
        // Clear is idempotent.
        reg.clear();
        assert!(reg.is_empty());
    }

    #[test]
    fn project_summary_serializes_camel_case_with_optional_path() {
        let with_path = sample("p-1", Some("/a"), false);
        let v = serde_json::to_value(&with_path).unwrap();
        assert_eq!(v["id"], "p-1");
        assert_eq!(v["name"], "Proj p-1");
        assert_eq!(v["color"], "blue");
        assert_eq!(v["path"], "/a");
        assert_eq!(v["isArchived"], false);
        assert_eq!(v["isActive"], false);

        let no_path = sample("p-2", None, true);
        let v2 = serde_json::to_value(&no_path).unwrap();
        // skip_serializing_if: path omitted (not null) when None.
        assert!(v2.get("path").is_none(), "path must be omitted, not null");
        assert_eq!(v2["isArchived"], true);
    }

    #[test]
    fn projects_changed_payload_omits_none_active() {
        let p = ProjectsChangedPayload { active_project_id: None };
        let v = serde_json::to_value(&p).unwrap();
        assert!(v.get("activeProjectId").is_none());
        let p2 = ProjectsChangedPayload { active_project_id: Some("p-3".to_string()) };
        let v2 = serde_json::to_value(&p2).unwrap();
        assert_eq!(v2["activeProjectId"], "p-3");
    }
}
