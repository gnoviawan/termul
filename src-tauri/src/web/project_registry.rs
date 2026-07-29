//! In-memory project registry for web/remote project listing and switching.
//!
//! The standalone server seeds it from the file-backed VFS-root registry; the
//! desktop shared-live server receives renderer snapshots. The browser reads it
//! through `GET /projects` and resolves `switch_project` ids to private cwd/MCP
//! context here. Public summaries remain redact-by-omission.
//!
//! The registry itself is not durable. VPS mode persists the active id through
//! the separately retained `FileProjectRegistry`; desktop mode remains file-free.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use agent_client_protocol::schema::McpServer;

use crate::acp::{FileProjectRegistry, VfsRoot};

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

#[derive(Debug, Clone)]
pub struct ProjectSwitchContext {
    pub project_id: String,
    pub cwd: String,
    pub mcp_servers: Vec<McpServer>,
    pub is_active: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct RegistryData {
    projects: Vec<ProjectSummary>,
    active_project_id: Option<String>,
}

/// In-memory project registry shared by VPS and desktop-hosted web modes.
///
/// `Arc<ProjectRegistry>` is shared between the router (read path + switch
/// resolution), the `remote_sync_projects` command (write path), and
/// `remote_server_stop` (clear). All mutation is behind a single
/// `parking_lot::Mutex` so a renderer sync and a `/projects` read never race.
#[derive(Default)]
pub struct ProjectRegistry {
    inner: Mutex<RegistryData>,
    mcp_servers: Mutex<std::collections::HashMap<String, Vec<McpServer>>>,
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
    pub fn set(&self, mut projects: Vec<ProjectSummary>, active_id: Option<String>) {
        for project in &mut projects {
            project.is_active = active_id.as_deref() == Some(project.id.as_str());
        }
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

    /// Resolve a complete switchable project context. Archived, unknown, and
    /// pathless projects are rejected. MCP configuration is kept private and
    /// never enters `ProjectSummary`/`GET /projects`.
    #[must_use]
    pub fn switch_context(&self, project_id: &str) -> Option<ProjectSwitchContext> {
        let g = self.inner.lock();
        let project = g
            .projects
            .iter()
            .find(|p| p.id == project_id && !p.is_archived)?;
        let cwd = project.path.clone()?.trim().to_string();
        if cwd.is_empty() {
            return None;
        }
        let mcp_servers = self
            .mcp_servers
            .lock()
            .get(project_id)
            .cloned()
            .unwrap_or_default();
        Some(ProjectSwitchContext {
            project_id: project.id.clone(),
            cwd,
            mcp_servers,
            is_active: g.active_project_id.as_deref() == Some(project_id),
        })
    }

    /// Atomically update the active id and every summary flag.
    pub fn set_active_project(&self, project_id: &str) -> bool {
        let mut g = self.inner.lock();
        if !g.projects.iter().any(|p| {
            p.id == project_id
                && !p.is_archived
                && p.path
                    .as_deref()
                    .is_some_and(|path| !path.trim().is_empty())
        }) {
            return false;
        }
        g.active_project_id = Some(project_id.to_string());
        for project in &mut g.projects {
            project.is_active = project.id == project_id;
        }
        true
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
        self.mcp_servers.lock().clear();
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

/// Map a file-backed VFS root to the wire [`ProjectSummary`] (VPS-mode seed).
///
/// The `web -> acp` direction is already established (`web` depends on
/// `acp::AcpManager`), so this mapping lives here — NOT in `acp` (which must
/// not import `web`, the no-cycle invariant). `is_active` is left `false`
/// per-entry; the caller ([`seed_from_file`]) derives the active flag from
/// `active_project_id` after the full list is built.
impl From<VfsRoot> for ProjectSummary {
    fn from(root: VfsRoot) -> Self {
        Self {
            id: root.id,
            name: root.name,
            color: root.color,
            // ProjectSummary.path is Option<String>; surface the root's
            // canonical path only when non-empty (a canonicalized root is
            // always non-empty, but the guard mirrors find_path's skip).
            path: (!root.path.as_os_str().is_empty())
                .then(|| root.path.to_string_lossy().into_owned()),
            is_archived: root.is_archived,
            is_active: false,
        }
    }
}

/// Seed an in-memory [`ProjectRegistry`] from a file-backed
/// [`FileProjectRegistry`] (the VPS-mode load path). Maps each VFS root to a
/// [`ProjectSummary`], marks the active one, and calls [`ProjectRegistry::set`].
/// The standalone `termul-server` binary calls this after `load`; the
/// desktop-hosted path seeds via `remote_sync_projects` instead (it never
/// constructs a `FileProjectRegistry`).
pub fn seed_from_file(registry: &ProjectRegistry, file_reg: &FileProjectRegistry) {
    let active_id = file_reg.active_project_id().map(str::to_string);
    let mcp_by_project = file_reg
        .roots()
        .iter()
        .map(|root| (root.id.clone(), root.mcp_servers.clone()))
        .collect();
    let mut summaries: Vec<ProjectSummary> = file_reg
        .roots()
        .iter()
        .map(|r| ProjectSummary::from(r.clone()))
        .collect();
    if let Some(ref id) = active_id {
        for s in &mut summaries {
            if s.id == *id {
                s.is_active = true;
            }
        }
    }
    registry.set(summaries, active_id);
    *registry.mcp_servers.lock() = mcp_by_project;
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
        reg.set(
            vec![sample("p-1", Some("/a"), false)],
            Some("p-1".to_string()),
        );
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
        let p = ProjectsChangedPayload {
            active_project_id: None,
        };
        let v = serde_json::to_value(&p).unwrap();
        assert!(v.get("activeProjectId").is_none());
        let p2 = ProjectsChangedPayload {
            active_project_id: Some("p-3".to_string()),
        };
        let v2 = serde_json::to_value(&p2).unwrap();
        assert_eq!(v2["activeProjectId"], "p-3");
    }

    // T5.8 — VfsRoot -> ProjectSummary mapping round-trips identity/display
    // fields and redacts-by-omission (no env-var field on ProjectSummary).
    #[test]
    fn vfs_root_maps_to_project_summary_redacting_env() {
        use crate::acp::VfsRoot;
        use std::path::PathBuf;

        let root = VfsRoot {
            id: "p-1".to_string(),
            name: "Project p-1".to_string(),
            path: PathBuf::from("/some/cwd"),
            color: "blue".to_string(),
            is_archived: false,
            mcp_servers: Vec::new(),
        };
        let summary: ProjectSummary = root.into();
        assert_eq!(summary.id, "p-1");
        assert_eq!(summary.name, "Project p-1");
        assert_eq!(summary.color, "blue");
        assert_eq!(summary.path.as_deref(), Some("/some/cwd"));
        assert!(!summary.is_archived);
        // is_active is left false per-entry; seed_from_file derives it.
        assert!(!summary.is_active);

        // Redact-by-omission: the wire shape carries NO env-var field.
        let v = serde_json::to_value(&summary).unwrap();
        assert!(
            v.get("envVars").is_none(),
            "ProjectSummary must not carry env-var values"
        );

        // An empty-path VfsRoot surfaces path: None (mirrors find_path's skip).
        let empty_root = VfsRoot {
            id: "p-empty".to_string(),
            name: "Empty".to_string(),
            path: PathBuf::new(),
            color: "blue".to_string(),
            is_archived: false,
            mcp_servers: Vec::new(),
        };
        let s: ProjectSummary = empty_root.into();
        assert!(
            s.path.is_none(),
            "empty VfsRoot path => ProjectSummary.path None"
        );
    }

    #[test]
    fn active_update_keeps_snapshot_flags_consistent() {
        let reg = ProjectRegistry::new();
        reg.set(
            vec![
                sample("p-1", Some("/a"), false),
                sample("p-2", Some("/b"), false),
            ],
            Some("p-1".to_string()),
        );
        assert!(reg.set_active_project("p-2"));
        let snap = reg.snapshot();
        assert_eq!(snap.active_project_id.as_deref(), Some("p-2"));
        assert!(!snap.projects[0].is_active);
        assert!(snap.projects[1].is_active);
    }

    #[test]
    fn switch_context_rejects_archived_and_carries_private_mcp() {
        use agent_client_protocol::schema::{McpServer, McpServerStdio};

        let reg = ProjectRegistry::new();
        reg.set(
            vec![
                sample("live", Some("/a"), false),
                sample("old", Some("/b"), true),
            ],
            Some("live".to_string()),
        );
        reg.mcp_servers.lock().insert(
            "live".to_string(),
            vec![McpServer::Stdio(McpServerStdio::new(
                "project-mcp",
                std::path::PathBuf::from("mcp-bin"),
            ))],
        );
        assert!(reg.switch_context("old").is_none());
        let context = reg.switch_context("live").expect("live context");
        assert_eq!(context.cwd, "/a");
        assert!(context.is_active);
        assert_eq!(context.mcp_servers.len(), 1);
        let public = serde_json::to_value(reg.snapshot()).expect("public snapshot");
        assert!(public["projects"][0].get("mcpServers").is_none());
    }
}
