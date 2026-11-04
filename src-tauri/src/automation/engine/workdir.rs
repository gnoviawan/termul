//! A run's working directory: the project root, or a throwaway git worktree
//! per run that is removed with its branch when the run ends. A parked run
//! keeps its worktree, and the resume finds it again.

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

fn branch_of(name: &str) -> String {
    format!("automation/{name}")
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
    /// `worktree` is the run's [`worktree_name`]: `None` runs in the root.
    pub(super) async fn prepare(
        roots: &ProjectRoots,
        project_id: &str,
        worktree: Option<&str>,
    ) -> Result<Self, String> {
        let root = roots(project_id).ok_or_else(|| "project_unavailable".to_string())?;
        let Some(name) = worktree.map(str::to_string) else {
            return Ok(Self::Shared(root));
        };
        if let Some(existing) = Self::existing(root.clone(), &name).await? {
            log::info!("[Automation] run worktree {name} reused");
            return Ok(existing);
        }
        let branch = branch_of(&name);
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

    /// The run worktree `name` under `root`, if it is still checked out on
    /// the run's own branch. A listing that fails is an error, not absence.
    pub(super) async fn existing(root: PathBuf, name: &str) -> Result<Option<Self>, String> {
        let root_text = root.to_string_lossy().into_owned();
        let listed = match tokio::task::spawn_blocking(move || WorktreeManager::list(&root_text)).await {
            Ok(Ok(listed)) => listed,
            Ok(Err(error)) => return Err(format!("worktree_failed: {}", error.error_code())),
            Err(error) => return Err(format!("worktree_failed: {error}")),
        };
        let branch = branch_of(name);
        let Some(entry) = listed
            .into_iter()
            .find(|e| e.name == name && e.branch == branch)
        else {
            return Ok(None);
        };
        Ok(Some(Self::Worktree {
            root,
            path: PathBuf::from(entry.path),
            branch,
        }))
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
