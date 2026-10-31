//! A run's working directory: the project root, or a throwaway git worktree
//! per run that is removed with its branch when the run ends.

use std::path::{Path, PathBuf};

use super::ProjectRoots;
use crate::automation::model::{Isolation, RunId};
use crate::worktree::WorktreeManager;

/// The worktree name a run gets under `worktree_per_run`, else `None`.
pub(super) fn worktree_name(run_id: &RunId, isolation: Isolation) -> Option<String> {
    match isolation {
        Isolation::SharedInRoot => None,
        Isolation::WorktreePerRun => {
            let short: String = run_id.as_str().chars().take(8).collect();
            Some(format!("automation-{short}"))
        }
    }
}

pub(super) enum Workdir {
    Shared(PathBuf),
    Worktree {
        root: PathBuf,
        path: PathBuf,
        branch: String,
    },
}

impl Workdir {
    pub(super) async fn prepare(
        roots: &ProjectRoots,
        project_id: &str,
        isolation: Isolation,
        worktree: Option<&str>,
    ) -> Result<Self, String> {
        let root = roots(project_id).ok_or_else(|| "project_unavailable".to_string())?;
        let name = match (isolation, worktree) {
            (Isolation::SharedInRoot, _) => return Ok(Self::Shared(root)),
            (Isolation::WorktreePerRun, Some(name)) => name.to_string(),
            (Isolation::WorktreePerRun, None) => return Err("worktree_unavailable".to_string()),
        };
        let branch = format!("automation/{name}");
        let root_text = root.to_string_lossy().into_owned();
        let created = {
            let (root_text, name, branch) = (root_text.clone(), name.clone(), branch.clone());
            tokio::task::spawn_blocking(move || {
                WorktreeManager::create(&root_text, &name, &branch, true, None, None, None)
            })
            .await
        };
        match created {
            Ok(Ok(entry)) => Ok(Self::Worktree {
                root,
                path: PathBuf::from(entry.path),
                branch,
            }),
            Ok(Err(error)) => {
                log::warn!("[Automation] run worktree {name} could not be created: {error:?}");
                Err(format!("worktree_failed: {}", error.error_code()))
            }
            Err(error) => Err(format!("worktree_failed: {error}")),
        }
    }

    pub(super) fn path(&self) -> &Path {
        match self {
            Self::Shared(root) => root,
            Self::Worktree { path, .. } => path,
        }
    }

    pub(super) async fn release(self) {
        let Self::Worktree { root, path, branch } = self else {
            return;
        };
        let removed = tokio::task::spawn_blocking(move || {
            let root = root.to_string_lossy();
            WorktreeManager::remove(&root, &path.to_string_lossy(), true)
                .and_then(|()| WorktreeManager::delete_branch(&root, &branch))
        })
        .await;
        if !matches!(removed, Ok(Ok(()))) {
            log::warn!("[Automation] run worktree cleanup failed: {removed:?}");
        }
    }
}
