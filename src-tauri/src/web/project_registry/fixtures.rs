//! Test-only conveniences over the real commit path, so fixtures across the
//! crate can arrange a registry without going through a command service.

use std::path::Path;
use std::sync::Arc;

use crate::acp::session_persistence::UNASSIGNED_PROJECT_ID;

use super::store::insert_project;
use super::{ProjectRegistry, ProjectSummary};

impl ProjectRegistry {
    /// A shared registry with `root` registered as the one (default) project,
    /// i.e. the boundary an `AppState` rooted at `root` used to have.
    #[must_use]
    pub(crate) fn seeded_for_test(root: &Path) -> Arc<Self> {
        let registry = Arc::new(Self::new());
        registry.seed_root_if_no_usable_project(root);
        registry
    }

    /// Replace the whole list and default (panics when the commit fails).
    pub(crate) fn set(&self, projects: Vec<ProjectSummary>, default_id: Option<String>) {
        self.commit_replace_all(projects, |_, _| default_id)
            .expect("fixture replace commits");
    }

    /// Insert or replace one project by id without the command service's path
    /// checks; the reserved unassigned id is ignored (panics when the commit
    /// fails).
    pub(crate) fn upsert(&self, project: ProjectSummary) {
        if project.id == UNASSIGNED_PROJECT_ID {
            return;
        }
        self.commit(|data| {
            insert_project(data, project);
            Ok(())
        })
        .expect("fixture upsert commits");
    }

    /// Patch one project; `false` when the id is not registered.
    pub(crate) fn update(
        &self,
        project_id: &str,
        name: Option<String>,
        color: Option<String>,
        is_archived: Option<bool>,
    ) -> bool {
        self.commit_update(project_id, name, color, is_archived, None)
            .is_ok()
    }

    /// Remove one project; `false` when the id was not registered.
    pub(crate) fn remove(&self, project_id: &str) -> bool {
        self.commit_remove(project_id)
            .expect("fixture remove commits")
            .value
    }

    /// Make `project_id` the default; `false` when it is not switchable.
    pub(crate) fn set_default_project(&self, project_id: &str) -> bool {
        self.commit_set_default(project_id).is_ok()
    }

    /// Replace the list, deriving the default under the commit lock.
    pub(crate) fn set_with_default_from(
        &self,
        projects: Vec<ProjectSummary>,
        derive: impl FnOnce(&[ProjectSummary], Option<&str>) -> Option<String>,
    ) -> Option<String> {
        self.commit_replace_all(projects, derive)
            .expect("fixture replace commits")
            .value
    }
}
