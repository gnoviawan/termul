//! The one project command service shared by `/ws`, HTTP and the desktop.
//!
//! add / update (including archive and restore through `isArchived`) / remove
//! / set default / import all land here, so there is a single set of rules —
//! path validation, the reserved unassigned id, seed retirement, `project_busy`
//! with its cascade — and a single commit path ([`ProjectRegistry::commit`]).
//! Add, update and remove are naturally idempotent by `projectId` (a repeat is
//! ok; removing an absent id is ok), so they carry no ledger `commandId`.

use std::path::Path;
use std::sync::Arc;

use serde_json::Value;

use crate::acp::project_registry::validate_root_path;
use crate::acp::session_persistence::UNASSIGNED_PROJECT_ID;
use crate::acp::AcpManager;
use crate::pty::PtyManager;
use crate::web::sink::WsRelaySink;
use crate::web::ws::WsErrorCode;

use super::busy::{self, BoundEntities};
use super::store::ImportOutcome;
use super::{ProjectRegistry, ProjectSummary};

/// Why a project command was refused. Every transport maps it through
/// [`ws_code`](Self::ws_code) / [`http_code`](Self::http_code) so `/ws`, HTTP
/// and Tauri reply the same refusals.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectCommandError {
    /// The id is the reserved unassigned sentinel.
    Reserved,
    /// The path is not an accessible directory.
    InvalidPath(String),
    /// Unknown (or, for set-default, unswitchable) project; carries the message.
    NotFound(String),
    /// A same-id project is registered with a different path.
    Duplicate { project_id: String },
    /// Live sessions or terminals are bound to the project (`project_busy`).
    /// `bound` is empty when another removal of the same project is running.
    Busy {
        project_id: String,
        bound: BoundEntities,
    },
    /// The registry file could not be written; the registry is unchanged.
    Persist(String),
}

impl ProjectCommandError {
    pub(super) fn not_found(message: impl Into<String>) -> Self {
        Self::NotFound(message.into())
    }

    /// Human-readable reply message.
    #[must_use]
    pub fn message(&self) -> String {
        match self {
            Self::Reserved => format!("project id '{UNASSIGNED_PROJECT_ID}' is reserved"),
            Self::InvalidPath(reason) => format!("invalid root path: {reason}"),
            Self::NotFound(message) => message.clone(),
            Self::Duplicate { project_id } => format!(
                "project '{project_id}' is already registered with a different path"
            ),
            Self::Busy { project_id, bound } if bound.is_empty() => {
                format!("removal of project '{project_id}' is already in progress")
            }
            Self::Busy { project_id, .. } => format!(
                "project '{project_id}' has live sessions or terminals; resend with cascade to stop them"
            ),
            Self::Persist(error) => format!("failed to persist the project registry: {error}"),
        }
    }

    /// The `/ws` `err.code`. Reserved ids, bad paths and persistence failures
    /// keep the `unsupported` code these handlers always used.
    #[must_use]
    pub const fn ws_code(&self) -> WsErrorCode {
        match self {
            Self::Reserved | Self::InvalidPath(_) | Self::Persist(_) => WsErrorCode::Unsupported,
            Self::NotFound(_) => WsErrorCode::NotFound,
            Self::Duplicate { .. } => WsErrorCode::Duplicate,
            Self::Busy { .. } => WsErrorCode::ProjectBusy,
        }
    }

    /// The HTTP / Tauri `IpcBody.code` string.
    #[must_use]
    pub const fn http_code(&self) -> &'static str {
        match self {
            Self::Reserved | Self::InvalidPath(_) => "VALIDATION_ERROR",
            Self::NotFound(_) => "NOT_FOUND",
            Self::Duplicate { .. } => "DUPLICATE",
            Self::Busy { .. } => "PROJECT_BUSY",
            Self::Persist(_) => "PERSIST_FAILED",
        }
    }

    /// The reply `details` (`{"sessions":[…],"terminals":[…]}`) of a busy refusal.
    #[must_use]
    pub fn details(&self) -> Option<Value> {
        match self {
            Self::Busy { bound, .. } => Some(bound.details()),
            _ => None,
        }
    }
}

impl std::fmt::Display for ProjectCommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

impl std::error::Error for ProjectCommandError {}

/// The `add_project` request.
#[derive(Debug, Clone)]
pub struct AddProject {
    /// Client-minted id (an operator-chosen id is kept verbatim).
    pub id: String,
    pub name: String,
    /// Working directory; canonicalized and required to be a directory.
    pub path: String,
    pub color: String,
    pub is_archived: bool,
}

/// The `update_project` request. `cascade` only matters when it archives a
/// project with live sessions or terminals, or moves its root while some are
/// bound to it.
#[derive(Debug, Clone)]
pub struct UpdateProject {
    pub project_id: String,
    pub name: Option<String>,
    pub color: Option<String>,
    pub is_archived: Option<bool>,
    /// A new working directory; validated and canonicalized like `add`.
    pub path: Option<String>,
    pub cascade: bool,
}

/// The host pieces a command needs: the registry, and the managers whose live
/// sessions and terminals keep a project busy.
#[derive(Clone, Copy)]
pub struct ProjectHost<'a> {
    pub registry: &'a Arc<ProjectRegistry>,
    pub acp: &'a Arc<AcpManager>,
    pub pty: &'a Arc<PtyManager>,
    pub relay: &'a Arc<WsRelaySink>,
}

impl ProjectHost<'_> {
    /// Add a project (or repeat an add: same id and path is ok and replaces the
    /// display fields). A same-id project with a different path is `Duplicate`.
    ///
    /// # Errors
    /// Reserved id, unusable path, `Duplicate`, or a failed registry write.
    pub async fn add(&self, req: AddProject) -> Result<ProjectSummary, ProjectCommandError> {
        if req.id == UNASSIGNED_PROJECT_ID {
            tracing::warn!(target: "termul::web::project_registry", "add_project: reserved project id refused");
            return Err(ProjectCommandError::Reserved);
        }
        let canonical = validate_root_path(Path::new(&req.path)).map_err(|reason| {
            tracing::warn!(
                target: "termul::web::project_registry",
                project_id = %req.id,
                "add_project: invalid root path"
            );
            ProjectCommandError::InvalidPath(reason)
        })?;
        let committed = self.registry.commit_add(ProjectSummary {
            id: req.id.clone(),
            name: req.name,
            color: req.color,
            path: Some(canonical.to_string_lossy().into_owned()),
            is_archived: req.is_archived,
            is_default: false,
        })?;
        if committed.changed {
            notify_changed(self.relay, self.registry);
        }
        tracing::info!(
            target: "termul::web::project_registry",
            project_id = %req.id,
            changed = committed.changed,
            "add_project: project registered"
        );
        Ok(committed.value)
    }

    /// Patch a project's display fields; `isArchived` archives or restores it
    /// and `path` moves its root. Archiving a project with live sessions or
    /// terminals, or moving the root of one (their working directories would
    /// leave it), is refused `project_busy` unless `cascade` stops them first.
    /// A `path` that is already the root is not a move.
    ///
    /// # Errors
    /// Reserved id or unusable path (a `path` is checked like `add`'s),
    /// `NotFound`, `Busy`, or a failed registry write.
    pub async fn update(&self, req: UpdateProject) -> Result<(), ProjectCommandError> {
        let canonical = match req.path.as_deref() {
            Some(path) => {
                if req.project_id == UNASSIGNED_PROJECT_ID {
                    tracing::warn!(target: "termul::web::project_registry", "update_project: reserved project id refused");
                    return Err(ProjectCommandError::Reserved);
                }
                Some(validate_root_path(Path::new(path)).map_err(|reason| {
                    tracing::warn!(
                        target: "termul::web::project_registry",
                        project_id = %req.project_id,
                        "update_project: invalid root path"
                    );
                    ProjectCommandError::InvalidPath(reason)
                })?)
            }
            None => None,
        };
        let archiving = req.is_archived == Some(true)
            && self
                .registry
                .get(&req.project_id)
                .is_some_and(|project| !project.is_archived);
        let moving = canonical
            .as_deref()
            .is_some_and(|root| self.registry.moves_root(&req.project_id, root));
        let path = canonical.map(|root| root.to_string_lossy().into_owned());
        let guarded = archiving || moving;
        let committed = if guarded {
            self.release(&req.project_id, req.cascade, || {
                self.registry.commit_update(
                    &req.project_id,
                    req.name.clone(),
                    req.color.clone(),
                    req.is_archived,
                    path.clone(),
                )
            })
            .await?
        } else {
            self.registry.commit_update(
                &req.project_id,
                req.name,
                req.color,
                req.is_archived,
                path,
            )?
        };
        if committed.changed {
            if guarded {
                // An archived project stops being watched, and a moved one's
                // watcher still observes the old root.
                self.relay.fs_watches().unwatch_project(&req.project_id);
            }
            notify_changed(self.relay, self.registry);
        }
        tracing::info!(
            target: "termul::web::project_registry",
            project_id = %req.project_id,
            archived = archiving,
            moved = moving,
            "update_project: project updated"
        );
        Ok(())
    }

    /// Remove a project; an absent id is ok. A project with live sessions or
    /// terminals is refused `project_busy` unless `cascade` stops them first.
    ///
    /// # Errors
    /// `Busy`, or a failed registry write.
    pub async fn remove(&self, project_id: &str, cascade: bool) -> Result<(), ProjectCommandError> {
        if !self.registry.contains(project_id) {
            return Ok(());
        }
        let committed = self
            .release(project_id, cascade, || self.registry.commit_remove(project_id))
            .await?;
        if committed.changed {
            self.relay.fs_watches().unwatch_project(project_id);
            notify_changed(self.relay, self.registry);
        }
        tracing::info!(
            target: "termul::web::project_registry",
            project_id,
            removed = committed.value,
            "remove_project: project removed"
        );
        Ok(())
    }

    /// Run `commit` (a remove or archive of `project_id`) once nothing is
    /// bound to the project. The project is marked `removing` first, so no new
    /// session or terminal can attach between the check and the commit. Bound
    /// entities without `cascade` refuse `project_busy` listing them and
    /// change nothing; with `cascade` the host stops them first, and anything
    /// that cannot be stopped keeps the project in place (`project_busy` with
    /// the leftovers).
    async fn release<T>(
        &self,
        project_id: &str,
        cascade: bool,
        commit: impl FnOnce() -> Result<T, ProjectCommandError>,
    ) -> Result<T, ProjectCommandError> {
        let Some(_removal) = self.registry.begin_removal(project_id) else {
            return Err(ProjectCommandError::Busy {
                project_id: project_id.to_string(),
                bound: BoundEntities::default(),
            });
        };
        let bound = busy::collect(self.acp, self.pty, project_id).await;
        if !bound.is_empty() {
            if !cascade {
                tracing::warn!(
                    target: "termul::web::project_registry",
                    project_id,
                    sessions = bound.sessions.len(),
                    terminals = bound.terminals.len(),
                    "project is busy; remove/archive refused"
                );
                return Err(ProjectCommandError::Busy {
                    project_id: project_id.to_string(),
                    bound,
                });
            }
            tracing::info!(
                target: "termul::web::project_registry",
                project_id,
                sessions = bound.sessions.len(),
                terminals = bound.terminals.len(),
                "cascade: stopping the project's sessions and terminals"
            );
            let leftovers = busy::stop_all(self.acp, self.pty, project_id, &bound).await;
            if !leftovers.is_empty() {
                tracing::warn!(
                    target: "termul::web::project_registry",
                    project_id,
                    sessions = leftovers.sessions.len(),
                    terminals = leftovers.terminals.len(),
                    "cascade: some entities could not be stopped; the project is kept"
                );
                return Err(ProjectCommandError::Busy {
                    project_id: project_id.to_string(),
                    bound: leftovers,
                });
            }
        }
        commit()
    }
}

/// Make `project_id` the host default (explicit only). It must be switchable.
///
/// # Errors
/// `NotFound` (unknown, archived or pathless) or a failed registry write.
pub fn set_default_project(
    registry: &Arc<ProjectRegistry>,
    relay: &Arc<WsRelaySink>,
    project_id: &str,
) -> Result<(), ProjectCommandError> {
    let committed = registry.commit_set_default(project_id)?;
    if committed.changed {
        notify_changed(relay, registry);
    }
    tracing::info!(
        target: "termul::web::project_registry",
        project_id,
        "set_default_project: host default updated"
    );
    Ok(())
}

/// Replace the whole list with the desktop renderer's push (transitional until
/// the renderer reads the registry through the projects watch). The default is
/// `derive(projects, current default)`; returns the stored default.
///
/// # Errors
/// A failed registry write (the registry is unchanged).
pub fn replace_projects(
    registry: &Arc<ProjectRegistry>,
    relay: &Arc<WsRelaySink>,
    projects: Vec<ProjectSummary>,
    derive: impl FnOnce(&[ProjectSummary], Option<&str>) -> Option<String>,
) -> Result<Option<String>, ProjectCommandError> {
    let committed = registry.commit_replace_all(projects, derive)?;
    // The renderer's push is announced even when nothing changed: it is the
    // signal that a freshly started host's clients should refetch.
    notify_changed(relay, registry);
    Ok(committed.value)
}

/// The desktop's one-shot import of the renderer's old project list: allowed
/// once, merges without overwriting, durable even for an empty list.
///
/// # Errors
/// A failed registry write (nothing is imported and the call can be retried).
pub fn import_projects(
    registry: &Arc<ProjectRegistry>,
    relay: &Arc<WsRelaySink>,
    projects: Vec<ProjectSummary>,
    default_project_id: Option<String>,
) -> Result<ImportOutcome, ProjectCommandError> {
    let committed = registry.commit_import(projects, default_project_id)?;
    if committed.value {
        notify_changed(relay, registry);
        tracing::info!(
            target: "termul::web::project_registry",
            projects = registry.len(),
            "project registry import completed"
        );
    }
    Ok(ImportOutcome {
        imported: committed.value,
    })
}

/// Announce that the registry changed: publish the new state to every
/// `projects` watcher. THE single notification point — every command above
/// ends here.
pub fn notify_changed(relay: &Arc<WsRelaySink>, registry: &ProjectRegistry) {
    crate::web::watch::publish_projects(relay, registry);
}
