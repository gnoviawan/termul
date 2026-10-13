//! The host's single project registry.
//!
//! One durable [`ProjectRegistry`] exists per host: the standalone
//! `termul-server` opens it from `--projects-file`, the desktop builds it once
//! at setup from `<app_data_dir>/projects.json` and hands the same instance to
//! the shared-live host, so stopping shared-live never touches it. The browser
//! reads it through `GET /projects` and the `projects` watch;
//! `create_session` resolves project ids and cwds to registered projects here.
//! Public summaries remain redact-by-omission; private MCP context lives
//! alongside and is persisted with the project.
//!
//! # Layout
//!
//! - this module: the wire types, the read model and the boundary readers;
//! - [`store`]: the durable commit path (`validate → persist candidate →
//!   swap memory`) and every mutation built on it;
//! - [`commands`]: the one command service shared by HTTP, `/ws` and the
//!   desktop (add / update / remove / set default / import), plus the single
//!   change notification;
//! - [`busy`]: the live sessions and terminals bound to a project and the
//!   cascade that stops them.
//!
//! # Commit path
//!
//! Every mutation runs through one commit: a candidate is built from the
//! current state, validated, written to the registry file (temp + fsync +
//! rename) and only then swapped into memory. A failed write therefore leaves
//! memory exactly as it was — rollback is "never swapped". Registries built
//! with [`ProjectRegistry::new`] have no file and skip the write.
//!
//! # Host default vs per-client active (Epic 7 — cross-client continuity)
//!
//! The host owns a single `default_project_id` — the project NEW web clients
//! start with on their initial `GET /projects`. It is NOT "whoever switched
//! last": switching projects is client-only and never reaches the host. The
//! default changes only via an explicit set-default command; it is cleared
//! when its project is archived or removed.
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
//! retired as soon as a real usable project is added and is never written to
//! the registry file.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};

use agent_client_protocol::schema::v1::McpServer;

use crate::acp::VfsRoot;

mod busy;
mod commands;
#[cfg(test)]
mod fixtures;
mod store;
#[cfg(test)]
mod command_tests;
#[cfg(test)]
mod store_tests;
#[cfg(test)]
pub(crate) mod test_host;

pub use busy::{BoundEntities, BoundSession};
pub use commands::{
    import_projects, notify_changed, replace_projects, set_default_project, AddProject,
    ProjectCommandError, ProjectHost, UpdateProject,
};
pub use crate::acp::RootCheck;
pub use store::ImportOutcome;

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

#[derive(Debug, Clone)]
pub struct ProjectSwitchContext {
    pub project_id: String,
    pub cwd: String,
    pub mcp_servers: Vec<McpServer>,
}


/// The registry's state: the project list, the default, the one-shot import
/// marker and the private per-project MCP attachments. Cloned into a candidate
/// by every commit.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct RegistryData {
    projects: Vec<ProjectSummary>,
    default_project_id: Option<String>,
    /// The desktop's one-shot import of the renderer's old project list has run.
    imported: bool,
    /// Project-scoped MCP attachments (never part of a public summary).
    mcp_servers: HashMap<String, Vec<McpServer>>,
    /// `true` while the project with id [`SEEDED_PROJECT_ID`] is the synthetic
    /// seed (kept in memory only, never written to the registry file).
    seeded: bool,
}

impl RegistryData {
    fn project(&self, project_id: &str) -> Option<&ProjectSummary> {
        self.projects.iter().find(|p| p.id == project_id)
    }

    /// Restore the invariants every commit ends with: no dangling or archived
    /// default (P4), `is_default` flags derived from the default id, MCP
    /// attachments only for registered projects, and `seeded` only while the
    /// seed project exists.
    fn normalize(&mut self) {
        if self
            .default_project_id
            .as_deref()
            .is_some_and(|id| !self.project(id).is_some_and(|p| !p.is_archived))
        {
            self.default_project_id = None;
        }
        let default_id = self.default_project_id.as_deref();
        for project in &mut self.projects {
            project.is_default = default_id == Some(project.id.as_str());
        }
        let ids: HashSet<&str> = self.projects.iter().map(|p| p.id.as_str()).collect();
        self.mcp_servers.retain(|id, _| ids.contains(id.as_str()));
        if !ids.contains(SEEDED_PROJECT_ID) {
            self.seeded = false;
        }
    }
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

/// The host's project registry (see the module docs).
///
/// `Arc<ProjectRegistry>` is shared between the router (read path + switch
/// resolution), the command service and the desktop commands. Readers take the
/// `inner` mutex only for a short clone; writers go through `commit`, which
/// holds `commit` (not `inner`) across the registry-file write so reads never
/// wait on the disk.
///
/// `roots` caches the canonical root of every non-archived project with a
/// path. Every commit rebuilds it after the swap, serialized by
/// `roots_rebuild` so the last rebuild always reflects the latest registry
/// state. Boundary checks only read it.
#[derive(Default)]
pub struct ProjectRegistry {
    inner: Mutex<RegistryData>,
    /// The registry file, or `None` for an in-memory registry.
    file: Option<PathBuf>,
    /// Serializes commits: one candidate is validated, persisted and swapped
    /// at a time, so two writers never persist from the same base.
    commit: Mutex<()>,
    /// Project ids whose remove/archive is running: new sessions and terminals
    /// are refused for them (see [`ProjectRegistry::begin_removal`]).
    removing: Mutex<HashSet<String>>,
    roots: RwLock<RootsCache>,
    roots_rebuild: Mutex<()>,
    /// Bumped under `inner` by every mutation that can change the boundary;
    /// the cache is current only while its epoch equals this.
    epoch: AtomicU64,
}

impl ProjectRegistry {
    /// Create an empty in-memory registry (no file): tests and hosts without a
    /// resolvable state directory.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
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

    /// `true` once the one-shot import of the renderer's old project list ran.
    #[must_use]
    pub fn is_imported(&self) -> bool {
        self.inner.lock().imported
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
        let mcp_servers = g.mcp_servers.get(project_id).cloned().unwrap_or_default();
        Some(ProjectSwitchContext {
            project_id: project.id.clone(),
            cwd,
            mcp_servers,
        })
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

    /// Number of registered projects (test helper / diagnostics).
    #[must_use]
    pub fn len(&self) -> usize {
        self.inner.lock().projects.len()
    }

    /// `true` when the registry holds no projects.
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
    /// stale. Used by the per-project fs watch and the project-named MCP/OAuth
    /// operations.
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
                        project_id = project_id.as_str(),
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

/// Map a file-backed VFS root to the wire [`ProjectSummary`].
///
/// The `web -> acp` direction is already established (`web` depends on
/// `acp::AcpManager`), so this mapping lives here — NOT in `acp` (which must
/// not import `web`, the no-cycle invariant). `is_default` is left `false`
/// per-entry; [`RegistryData::normalize`] derives it from the default id.
impl From<VfsRoot> for ProjectSummary {
    fn from(root: VfsRoot) -> Self {
        Self {
            id: root.id,
            name: root.name,
            color: root.color,
            // ProjectSummary.path is Option<String>; surface the root's path
            // only when non-empty (a pathless project stores an empty path).
            path: (!root.path.as_os_str().is_empty())
                .then(|| root.path.to_string_lossy().into_owned()),
            is_archived: root.is_archived,
            is_default: false,
        }
    }
}

#[cfg(test)]
mod tests;
