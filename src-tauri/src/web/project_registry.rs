//! In-memory project registry for web/remote project listing and switching.
//!
//! The standalone server seeds it from the file-backed VFS-root registry; the
//! desktop shared-live server receives renderer snapshots. The browser reads it
//! through `GET /projects` and resolves `switch_project` ids to private cwd/MCP
//! context here. Public summaries remain redact-by-omission.
//!
//! The registry itself is not durable. VPS mode persists the default id through
//! the separately retained `FileProjectRegistry`; desktop mode remains file-free.
//!
//! # Host default vs per-client active (Epic 7 — cross-client continuity)
//!
//! The host owns a single `default_project_id` — the project NEW web clients
//! start with on their initial `GET /projects`. It is NOT "whoever switched
//! last": a per-client `switch_project` updates only the requesting
//! connection's `current_project` (no broadcast, no persistence). The default
//! changes only via `set_default_project` (explicit) or `remote_sync_projects`
//! (desktop-hosted push — the desktop user IS the host operator, so their
//! active selection IS the default for new clients).

use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};

use agent_client_protocol::schema::v1::McpServer;

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
    /// `true` when this is the host's default project (set by the host based on
    /// `default_project_id`). Distinct from a client's per-connection active
    /// project — the host cannot know which project a specific client is on.
    pub is_default: bool,
}

/// `GET /projects` response payload (wrapped in `IpcResult<T>` by the handler).
///
/// Mirrors `src/shared/types/web-projects.types.ts` `ProjectListPayload`.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectListPayload {
    /// Non-archived + archived summaries (the web list shows both, archived greyed).
    pub projects: Vec<ProjectSummary>,
    /// The host's default project id (seeds a new web client's initial
    /// `activeProjectId`), or `None` when none is set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_project_id: Option<String>,
}

/// `projects_changed` WS event payload (agent-level: `sid: None`, `seq: 0`).
///
/// Carries only the new `defaultProjectId` — the web client refetches
/// `GET /projects` for the full list rather than receiving it inline. On the
/// initial load the client seeds `activeProjectId` from `defaultProjectId`; on
/// subsequent `projects_changed` events the client refetches the list but
/// preserves its own `activeProjectId` (no silent retarget).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsChangedPayload {
    /// The host's new default project id, or `None` when none is set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_project_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ProjectSwitchContext {
    pub project_id: String,
    pub cwd: String,
    pub mcp_servers: Vec<McpServer>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct RegistryData {
    projects: Vec<ProjectSummary>,
    default_project_id: Option<String>,
}

/// In-memory project registry shared by VPS and desktop-hosted web modes.
///
/// `Arc<ProjectRegistry>` is shared between the router (read path + switch
/// resolution), the `remote_sync_projects` command (write path), and
/// `remote_server_stop` (clear). All mutation is behind a single
/// `parking_lot::Mutex` so a renderer sync and a `/projects` read never race.
///
/// **CAP-1 (live project_root rebind):** the registry also holds an optional
/// `Arc<RwLock<PathBuf>>` handle — the *same* `Arc` `AppState.project_root`
/// owns. `serve_router` / `router` registers it via `set_project_root_handle`
/// after constructing `AppState`. The `set` / `set_default_project` mutators
/// then call `rebind_project_root`, which reads the new default's path,
/// canonicalizes it via `resolve_and_validate_project_root`, and writes the
/// canonical form to the handle — so switching the active project updates the
/// containment boundary without a server restart. When no handle is registered
/// (tests, pre-`serve_router` seed) the rebind is a no-op.
#[derive(Default)]
pub struct ProjectRegistry {
    inner: Mutex<RegistryData>,
    mcp_servers: Mutex<std::collections::HashMap<String, Vec<McpServer>>>,
    /// CAP-1: the live `project_root` handle shared with `AppState`. `None`
    /// until `serve_router` / `router` registers it. The `set` /
    /// `set_default_project` mutators rebind through this handle.
    project_root_handle: Mutex<Option<Arc<RwLock<PathBuf>>>>,
}

impl ProjectRegistry {
    /// Create an empty registry.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Replace the whole mirror atomically. Called by `remote_sync_projects`
    /// (renderer push — desktop-hosted mode, the desktop's active IS the default)
    /// and `set_default_project` (explicit host-default change) with the
    /// desktop's current non-archived + archived summaries + default id. The
    /// renderer is the source of truth in desktop-hosted mode — a fresh `set`
    /// fully supersedes the prior snapshot.
    ///
    /// **CAP-1:** after the mutation lands, rebinds `AppState.project_root`
    /// (via the registered handle) to the new default's canonical path so the
    /// containment boundary follows the active project without a restart.
    pub fn set(&self, mut projects: Vec<ProjectSummary>, default_id: Option<String>) {
        for project in &mut projects {
            project.is_default = default_id.as_deref() == Some(project.id.as_str());
        }
        {
            let mut g = self.inner.lock();
            g.projects = projects;
            g.default_project_id = default_id;
        }
        self.rebind_project_root();
    }
    /// Insert or replace a single project summary by `id` in the in-memory
    /// mirror (Option B: web-client project create/update). A root with an
    /// existing `id` is replaced in place (preserving order); a new id is
    /// appended. Does NOT touch the default. When the new project is the only
    /// one and no default is set, the caller may set it via
    /// `set_default_project`. Triggers a `project_root` rebind so the
    /// containment boundary follows when this becomes the default.
    pub fn upsert(&self, project: ProjectSummary) {
        let mut g = self.inner.lock();
        if let Some(existing) = g.projects.iter_mut().find(|p| p.id == project.id) {
            *existing = project;
        } else {
            g.projects.push(project);
        }
    }

    /// Remove a project summary by `id` from the in-memory mirror. Clears the
    /// default when it referenced the removed project (P4: no dangling
    /// default). Returns `true` when a project was removed.
    pub fn remove(&self, project_id: &str) -> bool {
        let mut g = self.inner.lock();
        let before = g.projects.len();
        g.projects.retain(|p| p.id != project_id);
        if g.projects.len() == before {
            return false;
        }
        if g.default_project_id.as_deref() == Some(project_id) {
            g.default_project_id = None;
        }
        true
    }

    /// Patch a single project's display fields (name, color, archived) by
    /// `id`. Returns `false` when the id is absent. Clears the default when the
    /// project is archived (P4: an archived default is not switchable).
    pub fn update(
        &self,
        project_id: &str,
        name: Option<String>,
        color: Option<String>,
        is_archived: Option<bool>,
    ) -> bool {
        let mut g = self.inner.lock();
        let Some(project) = g.projects.iter_mut().find(|p| p.id == project_id) else {
            return false;
        };
        if let Some(name) = name {
            project.name = name;
        }
        if let Some(color) = color {
            project.color = color;
        }
        if let Some(is_archived) = is_archived {
            project.is_archived = is_archived;
        }
        if project.is_archived && g.default_project_id.as_deref() == Some(project_id) {
            g.default_project_id = None;
        }
        true
    }

    /// Snapshot the current mirror for `GET /projects`. Clones the vec under
    /// the lock (the read is short); the caller serializes outside the lock.
    #[must_use]
    pub fn snapshot(&self) -> ProjectListPayload {
        let g = self.inner.lock();
        ProjectListPayload {
            projects: g.projects.clone(),
            default_project_id: g.default_project_id.clone(),
        }
    }

    /// Resolve a complete switchable project context. Archived, unknown, and
    /// pathless projects are rejected. MCP configuration is kept private and
    /// never enters `ProjectSummary`/`GET /projects`. Per-connection activity
    /// is NOT computed here — the caller checks `current_project` itself.
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
        })
    }

    /// Atomically update the default id and every summary's `is_default` flag.
    /// Called by the explicit `set_default_project` operation (Tauri command +
    /// WS request + HTTP route). Returns `false` when the target is unknown,
    /// archived, or pathless (not switchable) — the caller replies `NOT_FOUND`.
    ///
    /// **CAP-1:** on success, rebinds `AppState.project_root` (via the
    /// registered handle) to the new default's canonical path so the
    /// containment boundary follows the active project without a restart.
    pub fn set_default_project(&self, project_id: &str) -> bool {
        let ok = {
            let mut g = self.inner.lock();
            let valid = g.projects.iter().any(|p| {
                p.id == project_id
                    && !p.is_archived
                    && p.path
                        .as_deref()
                        .is_some_and(|path| !path.trim().is_empty())
            });
            if !valid {
                false
            } else {
                g.default_project_id = Some(project_id.to_string());
                for project in &mut g.projects {
                    project.is_default = project.id == project_id;
                }
                true
            }
        };
        if ok {
            self.rebind_project_root();
        }
        ok
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

    /// Resolve a cwd (`path`) → its project id, or `None` when no registered
    /// project matches. Best-effort identity for host-owned sessions created
    /// with a cwd but no explicit project (CAP-2 attribution): an exact path
    /// match wins; otherwise a cwd INSIDE a project directory (worktree or
    /// subfolder) falls back to that project so the session stays
    /// project-scoped instead of vanishing from the sidebar.
    #[must_use]
    pub fn find_by_path(&self, cwd: &str) -> Option<String> {
        let target = cwd.trim();
        if target.is_empty() {
            return None;
        }
        let g = self.inner.lock();
        // Track the LONGEST matching ancestor dir, not the first one. When two
        // registered projects nest (e.g. `/dev` and `/dev/app`), a cwd of
        // `/dev/app/sub` must attribute to the child (`/dev/app`), not to
        // whichever parent happened to be iterated first. Path length is a
        // sufficient specificity proxy: a deeper ancestor is always more
        // specific (and `is_within_dir` already enforces a separator
        // boundary, so `/dev` cannot spuriously shadow `/devapp`).
        let mut ancestor: Option<(usize, String)> = None;
        for project in g.projects.iter().filter(|p| !p.is_archived) {
            let Some(path) = project.path.as_deref() else {
                continue;
            };
            let path = path.trim();
            if path == target {
                return Some(project.id.clone());
            }
            if is_within_dir(target, path)
                && ancestor
                    .as_ref()
                    .is_none_or(|(len, _)| path.len() > *len)
            {
                ancestor = Some((path.len(), project.id.clone()));
            }
        }
        ancestor.map(|(_, id)| id)
    }

    /// Clear the mirror (called on `remote_server_stop` so a stale list does
    /// not linger after the server is off). Idempotent. Does NOT trigger a
    /// `project_root` rebind — the server is stopping; the boundary is
    /// re-established on the next `serve_router` start.
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

    /// Check whether a canonical `path` is within ANY registered (non-archived)
    /// project root. Used by the operation containment check
    /// (`ensure_within_project_boundary`) so that a web client that switched to
    /// a non-default project (per-connection `switch_project`) can still run
    /// git/skills/search operations — the boundary follows any registered
    /// project, not just the host default.
    ///
    /// Collects display paths under a short lock, then canonicalizes each
    /// outside the lock (sync fs call). Paths that fail to canonicalize
    /// (deleted/moved) are silently skipped — they cannot match a live request.
    #[must_use]
    pub fn is_within_any_registered_root(&self, path: &std::path::Path) -> bool {
        let paths: Vec<String> = {
            let g = self.inner.lock();
            g.projects
                .iter()
                .filter(|p| !p.is_archived)
                .filter_map(|p| p.path.as_deref().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect()
        };
        for raw in paths {
            if let Ok(canonical) = std::fs::canonicalize(&raw) {
                if path.starts_with(&canonical) {
                    return true;
                }
            }
        }
        false
    }

    // ---- CAP-1: live project_root rebind ----

    /// Register the `Arc<RwLock<PathBuf>>` handle that `AppState.project_root`
    /// owns. Called once by `serve_router` / `router` after `AppState` is
    /// built (the initial canonical `project_root` is already correct — the
    /// host computed it from this registry's default, or the standalone from
    /// its CLI arg). Subsequent `set` / `set_default_project` mutations
    /// recompute the canonical path from the new default and write it here via
    /// `rebind_project_root`. Safe to call multiple times (a restart builds a
    /// new `AppState` + re-registers) — last handle wins.
    pub fn set_project_root_handle(&self, handle: Arc<RwLock<PathBuf>>) {
        *self.project_root_handle.lock() = Some(handle);
    }

    /// The default project's cwd `path` (display form, not canonicalized), or
    /// `None` when the registry has no default or the default has no path.
    /// Single-lock read of `default_project_id` + the matching summary's
    /// `path`. `rebind_project_root` canonicalizes this via
    /// `resolve_and_validate_project_root`. Also used by
    /// `RemoteServerState::start` to derive the initial `project_root` from
    /// the active project (CAP-1). `pub(crate)` — the returned path is a
    /// display form (not canonicalized); callers MUST run it through
    /// `resolve_and_validate_project_root` before using it as a boundary.
    #[must_use]
    pub(crate) fn default_project_path(&self) -> Option<String> {
        let g = self.inner.lock();
        let default_id = g.default_project_id.as_deref()?;
        g.projects
            .iter()
            .find(|p| p.id == default_id)
            .and_then(|p| p.path.clone())
            .filter(|p| !p.trim().is_empty())
    }

    /// CAP-1: recompute `AppState.project_root` from the current default
    /// project's path and write the canonical form to the registered handle.
    /// Called by `set` / `set_default_project` after the mutation lands.
    ///
    /// - No handle registered (tests, pre-`serve_router` seed) → no-op.
    /// - No default / empty path → `warn!` + keep the prior boundary (do NOT
    ///   widen to home mid-run; only the START path falls back to home).
    /// - Canonicalization fails (deleted/moved path) → `warn!` + keep the
    ///   prior boundary (transient failure does not widen the jail).
    /// - Success → write lock the handle + replace with the canonical path.
    ///
    /// The lock is held only across the `starts_with`-style replacement (no
    /// `.await` under the guard). `resolve_and_validate_project_root` is a
    /// sync fs canonicalize — called outside any registry lock.
    fn rebind_project_root(&self) {
        // Clone the Arc out of the handle lock, then drop the handle lock so
        // the fs canonicalize below never runs under a registry mutex.
        let handle = self
            .project_root_handle
            .lock()
            .clone();
        let Some(handle) = handle else {
            // No handle registered yet (test / pre-serve seed) — nothing to
            // rebind. This is the normal path for `seed_from_file` + unit
            // tests that construct AppState directly without calling
            // `set_project_root_handle`.
            return;
        };
        let Some(path) = self.default_project_path() else {
            tracing::warn!(
                "project_root rebind skipped: registry has no default project path; \
                 keeping the prior boundary"
            );
            return;
        };
        match crate::web::config::resolve_and_validate_project_root(PathBuf::from(&path).as_path())
        {
            Ok(canonical) => {
                let mut g = handle.write();
                *g = canonical;
            }
            Err(e) => {
                tracing::warn!(
                    "project_root rebind failed for '{}': {}; keeping the prior boundary",
                    path,
                    e
                );
            }
        }
    }
}

/// `true` when `candidate` is a path strictly inside `dir` (a worktree or
/// subfolder), honoring both `/` and `\` separators. Prefix matches that do
/// not land on a separator boundary are rejected so `/a/bc` is NOT inside
/// `/a/b`.
#[must_use]
fn is_within_dir(candidate: &str, dir: &str) -> bool {
    let dir = dir.trim_end_matches(['/', '\\']);
    if dir.is_empty() || candidate.len() <= dir.len() {
        return false;
    }
    candidate.starts_with(dir)
        && candidate[dir.len()..]
            .chars()
            .next()
            .is_some_and(|ch| ch == '/' || ch == '\\')
}

/// Map a file-backed VFS root to the wire [`ProjectSummary`] (VPS-mode seed).
///
/// The `web -> acp` direction is already established (`web` depends on
/// `acp::AcpManager`), so this mapping lives here — NOT in `acp` (which must
/// not import `web`, the no-cycle invariant). `is_default` is left `false`
/// per-entry; the caller ([`seed_from_file`]) derives the default flag from
/// `default_project_id` after the full list is built.
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
            is_default: false,
        }
    }
}

/// Seed an in-memory [`ProjectRegistry`] from a file-backed
/// [`FileProjectRegistry`] (the VPS-mode load path). Maps each VFS root to a
/// [`ProjectSummary`], marks the default one, and calls [`ProjectRegistry::set`].
/// The standalone `termul-server` binary calls this after `load`; the
/// desktop-hosted path seeds via `remote_sync_projects` instead (it never
/// constructs a `FileProjectRegistry`).
pub fn seed_from_file(registry: &ProjectRegistry, file_reg: &FileProjectRegistry) {
    let default_id = file_reg.default_project_id().map(str::to_string);
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
    if let Some(ref id) = default_id {
        for s in &mut summaries {
            if s.id == *id {
                s.is_default = true;
            }
        }
    }
    registry.set(summaries, default_id);
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
            is_default: false,
        }
    }

    #[test]
    fn snapshot_defaults_to_empty() {
        let reg = ProjectRegistry::new();
        assert!(reg.is_empty());
        let snap = reg.snapshot();
        assert!(snap.projects.is_empty());
        assert_eq!(snap.default_project_id, None);
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
        assert_eq!(snap.default_project_id.as_deref(), Some("p-1"));
        assert_eq!(snap.projects[0].id, "p-1");
        assert!(snap.projects[1].is_archived);

        // A second set fully supersedes the first.
        reg.set(vec![sample("p-3", Some("/c"), false)], None);
        assert_eq!(reg.len(), 1);
        let snap2 = reg.snapshot();
        assert_eq!(snap2.projects[0].id, "p-3");
        assert_eq!(snap2.default_project_id, None);
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
        assert_eq!(reg.snapshot().default_project_id, None);
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
        assert_eq!(v["isDefault"], false);

        let no_path = sample("p-2", None, true);
        let v2 = serde_json::to_value(&no_path).unwrap();
        // skip_serializing_if: path omitted (not null) when None.
        assert!(v2.get("path").is_none(), "path must be omitted, not null");
        assert_eq!(v2["isArchived"], true);
    }

    #[test]
    fn projects_changed_payload_omits_none_default() {
        let p = ProjectsChangedPayload {
            default_project_id: None,
        };
        let v = serde_json::to_value(&p).unwrap();
        assert!(v.get("defaultProjectId").is_none());
        let p2 = ProjectsChangedPayload {
            default_project_id: Some("p-3".to_string()),
        };
        let v2 = serde_json::to_value(&p2).unwrap();
        assert_eq!(v2["defaultProjectId"], "p-3");
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
        // is_default is left false per-entry; seed_from_file derives it.
        assert!(!summary.is_default);

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
    fn default_update_keeps_snapshot_flags_consistent() {
        let reg = ProjectRegistry::new();
        reg.set(
            vec![
                sample("p-1", Some("/a"), false),
                sample("p-2", Some("/b"), false),
            ],
            Some("p-1".to_string()),
        );
        assert!(reg.set_default_project("p-2"));
        let snap = reg.snapshot();
        assert_eq!(snap.default_project_id.as_deref(), Some("p-2"));
        assert!(!snap.projects[0].is_default);
        assert!(snap.projects[1].is_default);
    }

    #[test]
    fn set_default_project_rejects_archived_and_pathless() {
        let reg = ProjectRegistry::new();
        reg.set(
            vec![
                sample("p-1", Some("/a"), false),
                sample("p-archived", Some("/b"), true),
                sample("p-pathless", None, false),
            ],
            None,
        );
        // Unknown id rejected.
        assert!(!reg.set_default_project("missing"));
        // Archived rejected.
        assert!(!reg.set_default_project("p-archived"));
        // Pathless rejected.
        assert!(!reg.set_default_project("p-pathless"));
        // Valid switchable accepted.
        assert!(reg.set_default_project("p-1"));
        let snap = reg.snapshot();
        assert_eq!(snap.default_project_id.as_deref(), Some("p-1"));
        assert!(snap.projects[0].is_default);
        assert!(!snap.projects[1].is_default);
        assert!(!snap.projects[2].is_default);
    }

    #[test]
    fn switch_context_rejects_archived_and_carries_private_mcp() {
        use agent_client_protocol::schema::v1::{McpServer, McpServerStdio};

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
        assert_eq!(context.mcp_servers.len(), 1);
        let public = serde_json::to_value(reg.snapshot()).expect("public snapshot");
        assert!(public["projects"][0].get("mcpServers").is_none());
    }

    /// CAP-2 attribution: `find_by_path` resolves an exact project path, and
    /// falls back to the enclosing project for a nested cwd (worktree or
    /// subfolder). A prefix that does not land on a separator is NOT a match,
    /// archived projects are skipped, and empty input yields `None`.
    #[test]
    fn find_by_path_exact_ancestor_and_boundary() {
        let reg = ProjectRegistry::new();
        reg.set(
            vec![
                sample("p-app", Some("/dev/app"), false),
                sample("p-archived", Some("/dev/old"), true),
            ],
            None,
        );
        // Exact match wins.
        assert_eq!(reg.find_by_path("/dev/app").as_deref(), Some("p-app"));
        // Nested cwd falls back to the enclosing project.
        assert_eq!(
            reg.find_by_path("/dev/app/worktrees/feat").as_deref(),
            Some("p-app")
        );
        assert_eq!(reg.find_by_path("/dev/app/sub").as_deref(), Some("p-app"));
        // Separator-boundary guard: `/dev/application` is NOT inside `/dev/app`.
        assert_eq!(reg.find_by_path("/dev/application"), None);
        // Archived projects never match.
        assert_eq!(reg.find_by_path("/dev/old"), None);
        // Unrelated path / empty input.
        assert_eq!(reg.find_by_path("/elsewhere"), None);
        assert_eq!(reg.find_by_path("   "), None);
    }

    /// `find_by_path` resolves the MOST SPECIFIC ancestor, not the first
    /// match. With nested projects `/dev` and `/dev/app`, a cwd inside the
    /// child must attribute to the child regardless of iteration order.
    #[test]
    fn find_by_path_picks_longest_ancestor_for_nested_projects() {
        let reg = ProjectRegistry::new();
        // Parent registered FIRST, then the child — both non-archived.
        reg.set(
            vec![
                sample("p-dev", Some("/dev"), false),
                sample("p-app", Some("/dev/app"), false),
            ],
            None,
        );
        assert_eq!(
            reg.find_by_path("/dev/app/sub").as_deref(),
            Some("p-app"),
            "child `/dev/app` must win over parent `/dev`"
        );
        // The parent itself still resolves to the parent (exact match).
        assert_eq!(reg.find_by_path("/dev/other").as_deref(), Some("p-dev"));

        // Reverse the iteration order — the child must STILL win.
        reg.set(
            vec![
                sample("p-app", Some("/dev/app"), false),
                sample("p-dev", Some("/dev"), false),
            ],
            None,
        );
        assert_eq!(
            reg.find_by_path("/dev/app/sub").as_deref(),
            Some("p-app"),
            "child must win regardless of registration order"
        );
    }

    // ---- CAP-1: live project_root rebind edge cases ----

    fn tempdir_like(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let p = std::env::temp_dir().join(format!(
            "termul-reg-rebind-{label}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&p).expect("create tempdir_like");
        p
    }

    /// Row: "No default / empty path → warn! + keep the prior boundary" and
    /// "No handle registered → no-op". With no handle registered, `set` on a
    /// registry with no default must be a silent no-op (the start path falls
    /// back to home separately; the rebind never widens mid-run).
    #[test]
    fn rebind_is_noop_when_no_handle_registered() {
        let reg = ProjectRegistry::new();
        // No handle set — set() must not panic and must not rebind anything.
        reg.set(vec![sample("p-1", Some("/a"), false)], None);
        // No default → default_project_path is None.
        assert!(reg.default_project_path().is_none());
    }

    /// Row: empty registry / no default at start. The rebind, when a handle IS
    /// registered but the registry has no default, must keep the prior boundary
    /// (do not widen to home mid-run; only the START path falls back to home).
    #[test]
    fn rebind_keeps_prior_boundary_when_no_default() {
        let reg = ProjectRegistry::new();
        let prior = PathBuf::from("/prior/boundary");
        let handle: Arc<RwLock<PathBuf>> = Arc::new(RwLock::new(prior.clone()));
        reg.set_project_root_handle(Arc::clone(&handle));
        // set() with no default → rebind skips (warns, keeps prior).
        reg.set(vec![sample("p-1", Some("/a"), false)], None);
        assert_eq!(
            *handle.read(),
            prior,
            "rebind with no default must keep the prior boundary, not widen"
        );
    }

    /// Row: canonicalization failure (deleted/moved default path) keeps the
    /// prior boundary — a transient failure does not widen the jail.
    #[test]
    fn rebind_keeps_prior_boundary_when_default_path_unresolvable() {
        let reg = ProjectRegistry::new();
        let prior = PathBuf::from("/prior/boundary");
        let handle: Arc<RwLock<PathBuf>> = Arc::new(RwLock::new(prior.clone()));
        reg.set_project_root_handle(Arc::clone(&handle));
        // A default project whose path does NOT exist on disk — canonicalize
        // fails, so the rebind must keep the prior boundary.
        reg.set(
            vec![sample("p-ghost", Some("/this/path/does/not/exist"), false)],
            Some("p-ghost".to_string()),
        );
        assert_eq!(
            *handle.read(),
            prior,
            "rebind on an unresolvable default path must keep the prior boundary"
        );
    }

    /// Row: success path — rebind writes the canonical default path to the
    /// handle so the containment boundary follows the active project.
    #[test]
    fn rebind_writes_canonical_default_path_to_handle() {
        let dir = tempdir_like("ok");
        let reg = ProjectRegistry::new();
        let prior = PathBuf::from("/prior/boundary");
        let handle: Arc<RwLock<PathBuf>> = Arc::new(RwLock::new(prior));
        reg.set_project_root_handle(Arc::clone(&handle));
        reg.set(
            vec![sample("p-live", Some(dir.to_str().unwrap()), false)],
            Some("p-live".to_string()),
        );
        let bound = handle.read().clone();
        assert!(
            bound.is_absolute(),
            "rebind must write a canonical absolute path, got: {}",
            bound.display()
        );
        // The canonical form must resolve to the same real directory (a second
        // canonicalize is idempotent).
        let again = bound.canonicalize().expect("canonicalize again");
        assert_eq!(bound, again, "rebind must write the canonical form");
        assert_ne!(
            bound, PathBuf::from("/prior/boundary"),
            "rebind must replace the prior boundary with the active project's path"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `set_default_project` triggers a rebind too — switching the default
    /// updates the handle to the new default's canonical path.
    #[test]
    fn set_default_project_rebinds_to_new_default_path() {
        let dir_a = tempdir_like("a");
        let dir_b = tempdir_like("b");
        let reg = ProjectRegistry::new();
        let handle: Arc<RwLock<PathBuf>> = Arc::new(RwLock::new(PathBuf::from("/prior")));
        reg.set_project_root_handle(Arc::clone(&handle));
        reg.set(
            vec![
                sample("p-a", Some(dir_a.to_str().unwrap()), false),
                sample("p-b", Some(dir_b.to_str().unwrap()), false),
            ],
            Some("p-a".to_string()),
        );
        let first = handle.read().clone();
        assert_eq!(
            first.canonicalize().expect("canonicalize a"),
            first,
            "initial rebind binds to p-a's canonical path"
        );
        // Switch default to p-b → rebind updates the handle.
        assert!(reg.set_default_project("p-b"));
        let second = handle.read().clone();
        assert_ne!(second, first, "switching default must rebind the boundary");
        assert_eq!(
            second.canonicalize().expect("canonicalize b"),
            second,
            "rebind after switch writes p-b's canonical path"
        );
        let _ = std::fs::remove_dir_all(&dir_a);
        let _ = std::fs::remove_dir_all(&dir_b);
    }
}
