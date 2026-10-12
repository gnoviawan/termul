//! In-memory project registry for web/remote project listing and switching.
//!
//! The standalone server seeds it from the file-backed VFS-root registry; the
//! desktop shared-live server receives renderer snapshots. The browser reads it
//! through `GET /projects`; `create_session` resolves project ids and cwds to
//! registered projects here, and private cwd/MCP context lives alongside. Public summaries remain redact-by-omission.
//!
//! The registry itself is not durable. VPS mode persists the default id through
//! the separately retained `FileProjectRegistry`; desktop mode remains file-free.
//!
//! # Host default vs per-client active (Epic 7 — cross-client continuity)
//!
//! The host owns a single `default_project_id` — the project NEW web clients
//! start with on their initial `GET /projects`. It is NOT "whoever switched
//! last": switching projects is client-only and never reaches the host. The
//! default changes only via `set_default_project` (an explicit user action); `set`
//! stores whatever default its caller passes (the desktop project-list sync
//! passes the existing default, so navigation never moves it).
//!
//! # Boundary
//!
//! The web fs/git/worktree/search/skills/canvas boundary is "inside any
//! registered, non-archived project". The registry caches each project's
//! canonical root (rebuilt after every mutation, tracked by an epoch so a
//! read never uses a cache that is behind a mutation) so a request never
//! canonicalizes every project.
//!
//! A synthetic seed project (see [`ProjectRegistry::seed_root_if_no_usable_project`])
//! keeps the boundary usable while no real project is registered; it is
//! retired as soon as a real usable project is added.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};

use agent_client_protocol::schema::v1::McpServer;

use crate::acp::{FileProjectRegistry, VfsRoot};

/// Id of the project [`ProjectRegistry::seed_root_if_no_usable_project`] registers.
pub const SEEDED_PROJECT_ID: &str = "default";

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

/// The cached canonical roots and the registry epoch they were built at.
#[derive(Debug, Default)]
struct RootsCache {
    epoch: u64,
    roots: Vec<CachedRoot>,
}

/// `true` for a project the boundary can use: not archived, with a non-empty path.
fn is_usable(project: &ProjectSummary) -> bool {
    !project.is_archived
        && project
            .path
            .as_deref()
            .is_some_and(|p| !p.trim().is_empty())
}

/// A project's canonical root as cached for boundary checks. `canonical` is
/// `None` while the directory cannot be resolved (deleted/moved); such roots
/// are retried lazily on each check so a directory created later still counts.
#[derive(Debug, Clone)]
struct CachedRoot {
    project_id: String,
    raw: String,
    canonical: Option<PathBuf>,
}

/// In-memory project registry shared by VPS and desktop-hosted web modes.
///
/// `Arc<ProjectRegistry>` is shared between the router (read path + switch
/// resolution), the `remote_sync_projects` command (write path), and
/// `remote_server_stop` (clear). All mutation is behind a single
/// `parking_lot::Mutex` so a renderer sync and a `/projects` read never race.
///
/// `roots` caches the canonical root of every non-archived project with a
/// path. Every mutator (`set`/`upsert`/`update`/`remove`/`clear`) rebuilds it
/// after its change lands, serialized by `roots_rebuild` so the last rebuild
/// always reflects the latest registry state. Boundary checks only read it.
#[derive(Default)]
pub struct ProjectRegistry {
    inner: Mutex<RegistryData>,
    mcp_servers: Mutex<std::collections::HashMap<String, Vec<McpServer>>>,
    roots: RwLock<RootsCache>,
    roots_rebuild: Mutex<()>,
    /// Bumped under `inner` by every mutation that can change the boundary;
    /// the cache is current only while its epoch equals this.
    epoch: AtomicU64,
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
    pub fn set(&self, mut projects: Vec<ProjectSummary>, default_id: Option<String>) {
        // The unassigned sentinel names no project; a renderer-fed entry
        // carrying it would make its sessions indistinguishable from
        // unassigned ones, so it is never registered.
        let before = projects.len();
        projects.retain(|p| p.id != crate::acp::session_persistence::UNASSIGNED_PROJECT_ID);
        if projects.len() != before {
            tracing::warn!(
                target: "termul::web::project_registry",
                "set: dropped a project carrying the reserved unassigned id"
            );
        }
        // A default naming the sentinel would dangle (P4).
        let default_id =
            default_id.filter(|id| id != crate::acp::session_persistence::UNASSIGNED_PROJECT_ID);
        for project in &mut projects {
            project.is_default = default_id.as_deref() == Some(project.id.as_str());
        }
        {
            let mut g = self.inner.lock();
            g.projects = projects;
            g.default_project_id = default_id;
            self.epoch.fetch_add(1, Ordering::AcqRel);
        }
        self.rebuild_roots();
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
    /// `update`/`remove`/`load`.
    pub fn upsert(&self, project: ProjectSummary) {
        {
            let mut g = self.inner.lock();
            let adds_real_project = project.id != SEEDED_PROJECT_ID && is_usable(&project);
            let new_id = project.id.clone();
            if let Some(existing) = g.projects.iter_mut().find(|p| p.id == project.id) {
                *existing = project;
            } else {
                g.projects.push(project);
            }
            // A real usable project retires the synthetic seed (and takes
            // over as default when the seed was it).
            if adds_real_project && g.projects.iter().any(|p| p.id == SEEDED_PROJECT_ID) {
                g.projects.retain(|p| p.id != SEEDED_PROJECT_ID);
                if g.default_project_id.as_deref() == Some(SEEDED_PROJECT_ID) {
                    g.default_project_id = Some(new_id);
                }
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
            g.default_project_id = default_id;
            self.epoch.fetch_add(1, Ordering::AcqRel);
        }
        self.rebuild_roots();
    }

    /// Remove a project summary by `id` from the in-memory mirror. Clears the
    /// default when it referenced the removed project (P4: no dangling
    /// default). Returns `true` when a project was removed.
    pub fn remove(&self, project_id: &str) -> bool {
        {
            let mut g = self.inner.lock();
            let before = g.projects.len();
            g.projects.retain(|p| p.id != project_id);
            if g.projects.len() == before {
                return false;
            }
            if g.default_project_id.as_deref() == Some(project_id) {
                g.default_project_id = None;
            }
            self.epoch.fetch_add(1, Ordering::AcqRel);
        }
        self.rebuild_roots();
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
        {
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
            self.epoch.fetch_add(1, Ordering::AcqRel);
        }
        self.rebuild_roots();
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
        })
    }

    /// Atomically update the default id and every summary's `is_default` flag.
    /// Called by the explicit `set_default_project` operation (Tauri command +
    /// WS request + HTTP route). Returns `false` when the target is unknown,
    /// archived, or pathless (not switchable) — the caller replies `NOT_FOUND`.
    /// Only the default pointer moves — the boundary is the set of registered
    /// roots, which this does not change.
    pub fn set_default_project(&self, project_id: &str) -> bool {
        let mut g = self.inner.lock();
        let valid = g.projects.iter().any(|p| {
            p.id == project_id
                && !p.is_archived
                && p.path
                    .as_deref()
                    .is_some_and(|path| !path.trim().is_empty())
        });
        if !valid {
            return false;
        }
        g.default_project_id = Some(project_id.to_string());
        for project in &mut g.projects {
            project.is_default = project.id == project_id;
        }
        true
    }

    /// Whether `project_id` is a registered project (archived or not). Used by
    /// `create_session` to validate an explicit `projectId` before stamping it.
    #[must_use]
    pub fn contains(&self, project_id: &str) -> bool {
        self.inner
            .lock()
            .projects
            .iter()
            .any(|p| p.id == project_id)
    }

    /// Resolve a project id → its cwd (`path`), or `None` when the project is
    /// not in the registry or has no cwd.
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

    /// Seed one registered project at `root` (also the default) when no
    /// usable project is registered (none non-archived with a path), so the
    /// registry-only boundary does not reject every request on a standalone
    /// `--project-root` server or a freshly started desktop host that has not
    /// received its project list yet. Returns `true` when a project was
    /// seeded. A registry that already has a usable project is left alone, and
    /// the seed is retired once a real usable project is upserted.
    /// The check and the insert happen under one lock, so a concurrent `set`
    /// (renderer sync) either lands first and the seed is skipped, or lands
    /// after and supersedes the seed — it is never overwritten by it.
    pub fn seed_root_if_no_usable_project(&self, root: &Path) -> bool {
        let name = root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| "Project".to_string());
        {
            let mut g = self.inner.lock();
            if g.projects.iter().any(is_usable) {
                return false;
            }
            g.projects.retain(|p| p.id != SEEDED_PROJECT_ID);
            g.projects.push(ProjectSummary {
                id: SEEDED_PROJECT_ID.to_string(),
                name,
                color: "blue".to_string(),
                path: Some(root.to_string_lossy().into_owned()),
                is_archived: false,
                is_default: true,
            });
            g.default_project_id = Some(SEEDED_PROJECT_ID.to_string());
            self.epoch.fetch_add(1, Ordering::AcqRel);
        }
        self.rebuild_roots();
        tracing::info!(root = %root.display(), "seeded one registered project from the configured project root");
        true
    }

    /// Test fixture: a shared registry with `root` registered as the one
    /// (default) project, i.e. the boundary an `AppState` rooted at `root`
    /// used to have.
    #[cfg(test)]
    #[must_use]
    pub(crate) fn seeded_for_test(root: &Path) -> std::sync::Arc<Self> {
        let registry = std::sync::Arc::new(Self::new());
        registry.seed_root_if_no_usable_project(root);
        registry
    }

    /// Clear the mirror (called on `remote_server_stop` so a stale list does
    /// not linger after the server is off). Idempotent.
    pub fn clear(&self) {
        {
            let mut g = self.inner.lock();
            *g = RegistryData::default();
            self.mcp_servers.lock().clear();
            self.epoch.fetch_add(1, Ordering::AcqRel);
        }
        self.rebuild_roots();
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

    /// Check whether a canonical `path` is within ANY registered
    /// (non-archived) project root. This is the single containment boundary
    /// for the web fs/git/worktree/search/skills/canvas routes.
    ///
    /// The cached canonical roots pre-filter the candidates, so a request
    /// never canonicalizes the whole project list. A candidate is then
    /// re-verified with one `canonicalize` of its registered path, so a root
    /// that was deleted or moved after the last rebuild stops matching at
    /// once, and a root that could not be resolved at the last rebuild (and
    /// appeared later) is admitted without a registry mutation. All
    /// filesystem calls run after the `roots` guard is released.
    #[must_use]
    pub fn is_within_any_registered_root(&self, path: &Path) -> bool {
        self.ensure_roots_current();
        let candidates: Vec<CachedRoot> = self
            .roots
            .read()
            .roots
            .iter()
            .filter(|root| match &root.canonical {
                Some(canonical) => path.starts_with(canonical),
                None => true,
            })
            .cloned()
            .collect();
        candidates
            .iter()
            .any(|root| std::fs::canonicalize(&root.raw).is_ok_and(|fresh| path.starts_with(fresh)))
    }

    /// Canonical root of a registered, non-archived project, or `None` when
    /// the id is unknown/archived/pathless or its directory cannot be
    /// resolved right now. Resolved fresh from the registered path (outside
    /// the `roots` guard), so a deleted or moved root is never returned
    /// stale. Used by the per-project fs watch and the MCP bridge.
    #[must_use]
    pub fn canonical_root(&self, project_id: &str) -> Option<PathBuf> {
        self.ensure_roots_current();
        let raw = self
            .roots
            .read()
            .roots
            .iter()
            .find(|r| r.project_id == project_id)
            .map(|r| r.raw.clone())?;
        std::fs::canonicalize(raw).ok()
    }

    /// Rebuild the cache first when a mutation landed after it was built (the
    /// mutator bumps the epoch before it rebuilds), so a read never admits an
    /// archived/removed project or an old path in that window.
    fn ensure_roots_current(&self) {
        if self.roots.read().epoch != self.epoch.load(Ordering::Acquire) {
            self.rebuild_roots();
        }
    }

    /// Canonical root of the host default project, or `None` when there is no
    /// default (or its directory cannot be resolved). Interim bridge for the
    /// MCP server/OAuth files, which are still host-wide until per-project
    /// naming lands.
    #[must_use]
    pub fn default_canonical_root(&self) -> Option<PathBuf> {
        let default_id = self.inner.lock().default_project_id.clone()?;
        self.canonical_root(&default_id)
    }

    /// The default project's cwd `path` (display form, not canonicalized), or
    /// `None` when the registry has no default or the default has no path.
    /// Callers that need a boundary-grade path MUST canonicalize it through
    /// `resolve_and_validate_project_root`.
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

    /// Rebuild the cached canonical roots from the current registry state.
    /// Snapshots the paths under the registry lock, canonicalizes outside it,
    /// and serializes concurrent rebuilds so the last one reflects the latest
    /// state.
    fn rebuild_roots(&self) {
        let _serial = self.roots_rebuild.lock();
        let (epoch, entries): (u64, Vec<(String, String)>) = {
            let g = self.inner.lock();
            let epoch = self.epoch.load(Ordering::Acquire);
            let entries = g
                .projects
                .iter()
                .filter(|p| !p.is_archived)
                .filter_map(|p| {
                    let raw = p.path.as_deref()?.trim();
                    (!raw.is_empty()).then(|| (p.id.clone(), raw.to_string()))
                })
                .collect();
            (epoch, entries)
        };
        let roots = entries
            .into_iter()
            .map(|(project_id, raw)| {
                let canonical = std::fs::canonicalize(&raw).ok();
                if canonical.is_none() {
                    tracing::warn!(
                        project_id = %project_id,
                        "project root cannot be canonicalized; it is rechecked lazily"
                    );
                }
                CachedRoot {
                    project_id,
                    raw,
                    canonical,
                }
            })
            .collect();
        *self.roots.write() = RootsCache { epoch, roots };
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
