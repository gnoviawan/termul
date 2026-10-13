//! The registry's durable commit path and every mutation built on it.
//!
//! One commit is `validate → persist a candidate → swap memory`: the closure
//! of each mutation edits a clone of the current state, the clone is
//! normalized and written to the registry file (temp + fsync + rename), and
//! only then does it replace the in-memory state. A failed write returns an
//! error and the registry is exactly as it was — rollback is "never swapped".

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

use serde::Serialize;

use crate::acp::session_persistence::UNASSIGNED_PROJECT_ID;
use crate::acp::{FileProjectRegistry, ProjectRegistryError, RootCheck, VfsRoot};

use super::commands::ProjectCommandError;
use super::{is_usable, ProjectRegistry, ProjectSummary, RegistryData, SEEDED_PROJECT_ID};

/// The result of a commit: the mutation's value and whether it changed the
/// registry (an unchanged commit writes nothing and notifies nobody).
#[derive(Debug)]
pub(super) struct Committed<R> {
    pub(super) value: R,
    pub(super) changed: bool,
}

/// Reply of the one-shot import: `imported` is `true` only for the call that
/// ran it. A repeat is an ok no-op reporting `false`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub imported: bool,
}

impl ProjectRegistry {
    /// Open the durable registry at `path`.
    ///
    /// A missing file is an empty registry (created on the first write); a
    /// corrupt file is copied to `<path>.corrupt-<ts>.bak` and reported as an
    /// error; a newer schema is refused; an older one upgrades in memory and
    /// keeps its original in a `.pre-v<N>-<ts>.bak` on the first write
    /// (AD-18). `check` decides whether a root that no longer resolves fails
    /// the open ([`RootCheck::Strict`]) or stays in the list
    /// ([`RootCheck::Lenient`]).
    ///
    /// # Errors
    /// The file cannot be read, parsed, is a newer schema, or (strict only)
    /// names an unusable root.
    pub fn open_durable(path: &Path, check: RootCheck) -> Result<Self, ProjectRegistryError> {
        let file = FileProjectRegistry::load_with(path, check)?;
        let mut data = RegistryData {
            default_project_id: file.default_project_id().map(str::to_string),
            imported: file.imported(),
            ..RegistryData::default()
        };
        for root in file.roots() {
            data.mcp_servers
                .insert(root.id.clone(), root.mcp_servers.clone());
            data.projects.push(ProjectSummary::from(root.clone()));
        }
        data.normalize();
        let registry = Self {
            inner: parking_lot::Mutex::new(data),
            file: Some(path.to_path_buf()),
            ..Self::default()
        };
        registry.rebuild_roots();
        Ok(registry)
    }

    /// An empty registry that still writes to `path`: the desktop's fallback
    /// after [`open_durable`](Self::open_durable) failed (the corrupt file was
    /// already copied aside; a newer-schema file is never overwritten, every
    /// commit against it fails instead).
    #[must_use]
    pub fn empty_durable(path: &Path) -> Self {
        Self {
            file: Some(path.to_path_buf()),
            ..Self::default()
        }
    }

    /// The registry file, or `None` for an in-memory registry.
    #[must_use]
    pub fn file_path(&self) -> Option<&Path> {
        self.file.as_deref()
    }

    /// One registered project (archived or not) with its derived `is_default`.
    #[must_use]
    pub fn get(&self, project_id: &str) -> Option<ProjectSummary> {
        self.inner.lock().project(project_id).cloned()
    }

    /// Run one commit: `mutate` edits a candidate clone; the normalized
    /// candidate is persisted (when this registry has a file) and only then
    /// swapped in. A mutation that changes nothing writes nothing.
    pub(super) fn commit<R>(
        &self,
        mutate: impl FnOnce(&mut RegistryData) -> Result<R, ProjectCommandError>,
    ) -> Result<Committed<R>, ProjectCommandError> {
        let _serial = self.commit.lock();
        let current = self.inner.lock().clone();
        let mut candidate = current.clone();
        let value = mutate(&mut candidate)?;
        candidate.normalize();
        if candidate == current {
            return Ok(Committed {
                value,
                changed: false,
            });
        }
        if let Some(path) = &self.file {
            persist(path, &candidate)?;
        }
        self.swap(candidate);
        Ok(Committed {
            value,
            changed: true,
        })
    }

    /// Replace the in-memory state and refresh the boundary cache.
    fn swap(&self, candidate: RegistryData) {
        {
            let mut g = self.inner.lock();
            *g = candidate;
            self.epoch.fetch_add(1, Ordering::AcqRel);
        }
        self.rebuild_roots();
    }

    /// Insert or replace a project by id. A same-id project with a different
    /// path is refused (`Duplicate`): an add never silently repoints a
    /// registered project. `project.path` is the canonical root.
    pub(super) fn commit_add(
        &self,
        project: ProjectSummary,
    ) -> Result<Committed<ProjectSummary>, ProjectCommandError> {
        if project.id == UNASSIGNED_PROJECT_ID {
            return Err(ProjectCommandError::Reserved);
        }
        self.commit(|data| {
            if let Some(existing) = data.project(&project.id) {
                if !same_root(existing.path.as_deref(), project.path.as_deref()) {
                    return Err(ProjectCommandError::Duplicate {
                        project_id: project.id.clone(),
                    });
                }
            }
            let id = project.id.clone();
            insert_project(data, project.clone());
            data.normalize();
            Ok(data.project(&id).cloned().unwrap_or(project))
        })
    }

    /// Patch a project's display fields, archived flag and root. `path` is the
    /// canonical root (the caller validated it). `NotFound` when the id is not
    /// registered.
    pub(super) fn commit_update(
        &self,
        project_id: &str,
        name: Option<String>,
        color: Option<String>,
        is_archived: Option<bool>,
        path: Option<String>,
    ) -> Result<Committed<()>, ProjectCommandError> {
        self.commit(|data| {
            let Some(project) = data.projects.iter_mut().find(|p| p.id == project_id) else {
                return Err(ProjectCommandError::not_found(format!(
                    "project '{project_id}' not found"
                )));
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
            if let Some(path) = path {
                project.path = Some(path);
            }
            Ok(())
        })
    }

    /// `true` when `project_id` is registered with a root and `canonical` is a
    /// different directory. A pathless project has no root to leave.
    pub(super) fn moves_root(&self, project_id: &str, canonical: &Path) -> bool {
        self.get(project_id)
            .and_then(|project| project.path)
            .is_some_and(|existing| {
                let existing = existing.trim();
                !existing.is_empty()
                    && Path::new(existing) != canonical
                    && !std::fs::canonicalize(existing).is_ok_and(|resolved| resolved == canonical)
            })
    }

    /// Remove a project. An absent id is `Ok(false)` (idempotent).
    pub(super) fn commit_remove(
        &self,
        project_id: &str,
    ) -> Result<Committed<bool>, ProjectCommandError> {
        self.commit(|data| {
            let before = data.projects.len();
            data.projects.retain(|p| p.id != project_id);
            Ok(data.projects.len() != before)
        })
    }

    /// Make `project_id` the host default. It must be switchable (registered,
    /// not archived, with a working directory) — `NotFound` otherwise.
    pub(super) fn commit_set_default(
        &self,
        project_id: &str,
    ) -> Result<Committed<()>, ProjectCommandError> {
        self.commit(|data| {
            if !data.project(project_id).is_some_and(is_usable) {
                return Err(ProjectCommandError::not_found(format!(
                    "project '{project_id}' not found or not switchable"
                )));
            }
            data.default_project_id = Some(project_id.to_string());
            Ok(())
        })
    }

    /// Replace the whole list (the desktop renderer's transitional push).
    /// The new default is chosen by `derive(projects, current default)` under
    /// the commit lock, so a concurrent explicit default change is never
    /// overwritten by a stale read. The reserved unassigned id never
    /// registers. Returns the stored default.
    pub(super) fn commit_replace_all(
        &self,
        mut projects: Vec<ProjectSummary>,
        derive: impl FnOnce(&[ProjectSummary], Option<&str>) -> Option<String>,
    ) -> Result<Committed<Option<String>>, ProjectCommandError> {
        let before = projects.len();
        projects.retain(|p| p.id != UNASSIGNED_PROJECT_ID);
        if projects.len() != before {
            tracing::warn!(
                target: "termul::web::project_registry",
                "replace: dropped a project carrying the reserved unassigned id"
            );
        }
        let committed = self.commit(|data| {
            data.default_project_id = derive(&projects, data.default_project_id.as_deref());
            data.projects = projects;
            data.seeded = false;
            Ok(())
        })?;
        let stored = self.inner.lock().default_project_id.clone();
        Ok(Committed {
            value: stored,
            changed: committed.changed,
        })
    }

    /// The desktop's one-shot import: only while `imported` is false. Merges
    /// (ids not present are added, existing ids are kept, never overwritten),
    /// applies `default_project_id` only when no default is set (the synthetic
    /// seed does not count as one), and marks the registry imported — durably, even for an empty list.
    pub(super) fn commit_import(
        &self,
        projects: Vec<ProjectSummary>,
        default_project_id: Option<String>,
    ) -> Result<Committed<bool>, ProjectCommandError> {
        self.commit(|data| {
            if data.imported {
                return Ok(false);
            }
            // The synthetic seed counts as no default. Read this before the
            // merge: the first real project retires the seed and takes over
            // its default, which would hide the renderer's own choice.
            let default_unset = data.default_project_id.is_none() || data.seeded;
            for project in projects {
                if project.id == UNASSIGNED_PROJECT_ID || data.project(&project.id).is_some() {
                    continue;
                }
                insert_project(data, project);
            }
            if default_unset {
                if let Some(id) = default_project_id {
                    if data.project(&id).is_some_and(|p| !p.is_archived) {
                        data.default_project_id = Some(id);
                    }
                }
            }
            data.imported = true;
            Ok(true)
        })
    }

    /// Seed one registered project at `root` (also the default) when no
    /// usable project is registered (none non-archived with a path), so the
    /// registry-only boundary does not reject every request on a standalone
    /// `--project-root` server or a freshly started desktop host with an empty
    /// list. Returns `true` when a project was seeded. A registry that already
    /// has a usable project is left alone, as is one where a real project
    /// already owns the seed's id, and the seed is retired once a real
    /// usable project is added. The seed lives in memory only — it is never
    /// written to the registry file.
    ///
    /// The check and the insert happen under the commit lock, so a concurrent
    /// commit either lands first and the seed is skipped, or lands after and
    /// supersedes the seed — it is never overwritten by it.
    pub fn seed_root_if_no_usable_project(&self, root: &Path) -> bool {
        let name = root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| "Project".to_string());
        {
            let _serial = self.commit.lock();
            let mut candidate = self.inner.lock().clone();
            if candidate.projects.iter().any(is_usable) {
                return false;
            }
            // A real project (archived or without a path) that already owns
            // the seed's id must not be replaced by the synthetic seed: the
            // seed is never written, so the real project would be lost.
            if !candidate.seeded && candidate.projects.iter().any(|p| p.id == SEEDED_PROJECT_ID) {
                return false;
            }
            candidate.projects.retain(|p| p.id != SEEDED_PROJECT_ID);
            candidate.projects.push(ProjectSummary {
                id: SEEDED_PROJECT_ID.to_string(),
                name,
                color: "blue".to_string(),
                path: Some(root.to_string_lossy().into_owned()),
                is_archived: false,
                is_default: true,
            });
            candidate.default_project_id = Some(SEEDED_PROJECT_ID.to_string());
            candidate.seeded = true;
            candidate.normalize();
            self.swap(candidate);
        }
        tracing::info!(root = %root.display(), "seeded one registered project from the configured project root");
        true
    }
}

/// Insert or replace `project` by id (order preserved on replace). A real
/// usable project retires the synthetic seed and takes over as default when
/// the seed was it.
pub(super) fn insert_project(data: &mut RegistryData, project: ProjectSummary) {
    let adds_real_project = project.id != SEEDED_PROJECT_ID && is_usable(&project);
    let new_id = project.id.clone();
    if project.id == SEEDED_PROJECT_ID {
        // A real project that happens to carry the seed's id is no longer
        // synthetic.
        data.seeded = false;
    }
    if let Some(existing) = data.projects.iter_mut().find(|p| p.id == project.id) {
        *existing = project;
    } else {
        data.projects.push(project);
    }
    if adds_real_project && data.seeded {
        data.projects.retain(|p| p.id != SEEDED_PROJECT_ID);
        data.seeded = false;
        if data.default_project_id.as_deref() == Some(SEEDED_PROJECT_ID) {
            data.default_project_id = Some(new_id);
        }
    }
}

/// Whether a registered project's `existing` path and the requested
/// (canonical) `requested` path name the same directory. A pathless existing
/// project accepts any path.
fn same_root(existing: Option<&str>, requested: Option<&str>) -> bool {
    let Some(existing) = existing.map(str::trim).filter(|p| !p.is_empty()) else {
        return true;
    };
    let Some(requested) = requested.map(str::trim).filter(|p| !p.is_empty()) else {
        return false;
    };
    existing == requested
        || std::fs::canonicalize(existing).is_ok_and(|canonical| canonical == Path::new(requested))
}

/// Write the candidate to `path`. The synthetic seed is never persisted.
fn persist(path: &Path, data: &RegistryData) -> Result<(), ProjectCommandError> {
    let synthetic = |id: &str| data.seeded && id == SEEDED_PROJECT_ID;
    let roots = data
        .projects
        .iter()
        .filter(|p| !synthetic(&p.id))
        .map(|p| VfsRoot {
            id: p.id.clone(),
            name: p.name.clone(),
            path: PathBuf::from(p.path.clone().unwrap_or_default()),
            color: p.color.clone(),
            is_archived: p.is_archived,
            mcp_servers: data.mcp_servers.get(&p.id).cloned().unwrap_or_default(),
        })
        .collect();
    let default_project_id = data
        .default_project_id
        .clone()
        .filter(|id| !synthetic(id));
    FileProjectRegistry::from_parts(roots, default_project_id, data.imported)
        .save_atomic(path)
        .map_err(|error| {
            tracing::error!(
                target: "termul::web::project_registry",
                path = %path.display(),
                %error,
                "failed to persist the project registry; the registry is unchanged"
            );
            ProjectCommandError::Persist(error.to_string())
        })
}
