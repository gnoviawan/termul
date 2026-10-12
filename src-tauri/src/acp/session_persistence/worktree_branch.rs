//! Worktree branch provenance + rewrite (story 16, CAP-5).
//!
//! `SessionPersistence` is the only writer of `worktree_branch`,
//! `worktree_branch_source` and `worktree_launch_branch` (AD-10): the renderer
//! never writes them. The provenance fields are set at registration when the
//! session created its worktree; this module answers the auto-rename guard and
//! rewrites every session that lives on a worktree after a rename.

use super::*;
use crate::worktree::worktree_path_key;

/// Why the auto rename is not allowed for a session. The caller logs ONE
/// warning with this stable code (never branch names).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AutoRenameRefusal {
    /// Unknown session or the session has no worktree.
    NoWorktree,
    /// The session did not create its worktree (existing worktree, model
    /// switch, later chat): it carries no branch source.
    NotCreator,
    /// A rename by hand already claimed the branch.
    SourceUser,
    /// The launch branch was not recorded.
    NoLaunchBranch,
}

impl AutoRenameRefusal {
    #[must_use]
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::NoWorktree => "no_worktree",
            Self::NotCreator => "not_creator",
            Self::SourceUser => "source_user",
            Self::NoLaunchBranch => "no_launch_branch",
        }
    }
}

/// What the auto rename may rename: the session's worktree and the branch it
/// was launched on (the `old` side of `git branch -m`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AutoRenameTarget {
    pub worktree_path: String,
    pub launch_branch: String,
}

impl SessionPersistence {
    /// The provenance half of the auto-rename guard: this session created the
    /// worktree and the branch source is still `auto`. The third condition
    /// (the worktree's current git branch equals the launch branch) is checked
    /// by `WorktreeManager::rename_branch`, which refuses with
    /// `BRANCH_CHANGED` otherwise.
    pub(crate) fn worktree_branch_guard(
        &self,
        session_id: &str,
    ) -> std::result::Result<AutoRenameTarget, AutoRenameRefusal> {
        let metadata = self
            .metadata(session_id)
            .map_err(|_| AutoRenameRefusal::NoWorktree)?;
        let worktree_path = metadata
            .worktree_path
            .filter(|path| !path.trim().is_empty())
            .ok_or(AutoRenameRefusal::NoWorktree)?;
        match metadata.worktree_branch_source {
            None => return Err(AutoRenameRefusal::NotCreator),
            Some(WorktreeBranchSource::User) => return Err(AutoRenameRefusal::SourceUser),
            Some(WorktreeBranchSource::Auto) => {}
        }
        let launch_branch = metadata
            .worktree_launch_branch
            .filter(|branch| !branch.is_empty())
            .ok_or(AutoRenameRefusal::NoLaunchBranch)?;
        Ok(AutoRenameTarget {
            worktree_path,
            launch_branch,
        })
    }

    /// Record a worktree branch rename: set `worktree_branch = new_branch` on
    /// EVERY session (active, closed, discovered) whose worktree path matches
    /// `worktree_path` by canonical path key, persist each `metadata.json`,
    /// then the index. A rename by hand (`user_initiated`) also flips
    /// `worktree_branch_source` to `user` on matching sessions that carry a
    /// source; an auto rename leaves it `auto` (the launch-branch guard blocks
    /// any second auto rename). Returns the number of sessions rewritten.
    pub(crate) async fn rename_worktree_branch(
        &self,
        worktree_path: &str,
        new_branch: &str,
        user_initiated: bool,
    ) -> Result<usize> {
        let key = worktree_path_key(worktree_path);
        let matching: Vec<Arc<Mutex<SessionMetadata>>> = self
            .inner
            .catalog
            .lock()
            .values()
            .filter(|entry| {
                entry
                    .lock()
                    .worktree_path
                    .as_deref()
                    .is_some_and(|path| worktree_path_key(path) == key)
            })
            .cloned()
            .collect();

        let mut first_error: Option<SessionPersistenceError> = None;
        for entry in &matching {
            // The entry lock stays held through the write: a concurrent
            // metadata change (the head-ahead mark) cannot land between the
            // snapshot and the file and then be overwritten by it.
            let mut metadata = entry.lock();
            metadata.worktree_branch = Some(new_branch.to_string());
            if user_initiated && metadata.worktree_branch_source.is_some() {
                metadata.worktree_branch_source = Some(WorktreeBranchSource::User);
            }
            if let Err(error) = persist_metadata_at_root(&self.inner.root, &metadata) {
                log::warn!(
                    "[acp-history] worktree branch metadata persist failed session={}: {error}",
                    crate::logging::redact_session_id(&metadata.session_id)
                );
                first_error.get_or_insert(error);
            }
            drop(metadata);
        }
        self.persist_index().await?;
        match first_error {
            Some(error) => Err(error),
            None => Ok(matching.len()),
        }
    }
}
