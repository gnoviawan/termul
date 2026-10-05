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
    /// appended. When the new project is the only one and no default is set,
    /// the caller may set it via `set_default_project`.
    ///
    /// F-020: `is_default` is recomputed from `default_project_id` on every
    /// upsert — a caller-supplied flag is advisory only, so upserting the
    /// current default can never clear its flag while `default_project_id`
    /// still points at it. P4 (no dangling default): when the upsert archives
    /// the current default, `default_project_id` is cleared — same posture as
    /// `update`/`remove`/`load`. When the upserted project remains the
    /// default (e.g. its path changed), `project_root` is rebound so the
    /// containment boundary follows the active project.
    pub fn upsert(&self, project: ProjectSummary) {
        let rebind = {
            let mut g = self.inner.lock();
            if let Some(existing) = g.projects.iter_mut().find(|p| p.id == project.id) {
                *existing = project;
            } else {
                g.projects.push(project);
            }
            let mut default_id = g.default_project_id.clone();
            if default_id
                .as_deref()
                .is_some_and(|id| g.projects.iter().any(|p| p.id == id && p.is_archived))
            {
                default_id = None;
            }
            for p in &mut g.projects {
                p.is_default = default_id.as_deref() == Some(p.id.as_str());
            }
            g.default_project_id = default_id.clone();
            default_id.is_some()
        };
        if rebind {
            self.rebind_project_root();
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
                && ancestor.as_ref().is_none_or(|(len, _)| path.len() > *len)
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
        let handle = self.project_root_handle.lock().clone();
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
                *g = canonical.clone();
                tracing::info!(
                    project_root = %canonical.display(),
                    "project_root rebound to default project path"
                );
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
mod tests;
