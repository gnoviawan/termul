//! Destructive-operation guard: a branch switch or worktree removal must not
//! pull the working tree out from under a session that is mid-turn.
//!
//! [`ensure_no_active_turn_under`] is the one check every entry point runs —
//! the HTTP routes (`/git/checkout-branch`, `/git/branch-switch`,
//! `/worktree/remove`) and the Tauri commands (`git_checkout_branch`,
//! `git_branch_switch`, `worktree_remove`, `worktree_remove_all_managed`) —
//! so both carriers refuse with the identical
//! [`DESTRUCTIVE_OP_BLOCKED`] code and message.

use std::path::{Path, PathBuf};

use super::{AcpManager, AgentId, SessionId};

/// The stable code shared with `WsErrorCode::DestructiveOpBlocked`.
pub const DESTRUCTIVE_OP_BLOCKED: &str = "destructive_op_blocked";

/// A session with an active turn has its working directory inside the target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DestructiveOpBlocked {
    /// The canonical path the operation would have rewritten.
    pub target: PathBuf,
}

impl std::fmt::Display for DestructiveOpBlocked {
    /// Identical on every carrier: the stable code, then the reason. Carries
    /// no session id or prompt content.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{DESTRUCTIVE_OP_BLOCKED}: a session with an active turn is working inside {}; \
             wait for it to finish or cancel the turn first",
            self.target.display()
        )
    }
}

impl std::error::Error for DestructiveOpBlocked {}

/// Canonical form for containment checks; a path that cannot be canonicalized
/// (already removed, not yet created) is compared as given.
fn canonical_or_self(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Whether `git checkout -b <branch> <start_ref>` rewrites the work tree:
/// branching from HEAD (omitted, blank or an explicit `HEAD`) leaves it
/// alone; any other start ref is checked out.
#[must_use]
pub fn start_ref_rewrites_tree(start_ref: Option<&str>) -> bool {
    start_ref
        .map(str::trim)
        .is_some_and(|r| !r.is_empty() && r != "HEAD")
}

/// The git work-tree root containing `dir`, or `None` outside a repository
/// (or when git cannot run). Blocking: call from `spawn_blocking`.
fn try_git_toplevel(dir: &Path) -> Option<PathBuf> {
    let output = crate::trackers::git_tracker::GitTracker::run_git_command(
        dir.to_str()?,
        &["rev-parse", "--show-toplevel"],
    )?;
    if !output.status.success() {
        return None;
    }
    let top = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!top.is_empty()).then(|| PathBuf::from(top))
}

/// The git work-tree root containing `dir` (`dir` itself when it is not in a
/// repository or git is unavailable). A checkout rewrites the whole work tree
/// no matter which subdirectory the caller names, so the guard must test the
/// root, not the supplied `cwd`.
pub async fn git_toplevel(dir: &Path) -> PathBuf {
    let dir = dir.to_path_buf();
    let fallback = dir.clone();
    tokio::task::spawn_blocking(move || try_git_toplevel(&dir))
        .await
        .ok()
        .flatten()
        .unwrap_or(fallback)
}

/// [`ensure_no_active_turn_under`] for a checkout run from `cwd`: the target
/// is the enclosing git work-tree root.
///
/// # Errors
/// [`DestructiveOpBlocked`] naming the work-tree root.
pub async fn ensure_no_active_turn_in_checkout(
    acp: &AcpManager,
    cwd: &Path,
) -> Result<(), DestructiveOpBlocked> {
    ensure_no_active_turn_under(acp, &git_toplevel(cwd).await).await
}

/// Whether the session directory `dir` lies inside `target` AND is rewritten
/// by an operation on it. Containment is component-wise (`/a/b-other` is NOT
/// inside `/a/b`). A directory that belongs to a different, nested git work
/// tree (a linked worktree under `<repo>/.termul/worktrees/…`) has its own
/// index and HEAD, so an operation on the enclosing tree does not touch it.
/// Blocking: canonicalizes and may run git.
fn is_rewritten_by(dir: &Path, target: &Path) -> bool {
    let dir = canonical_or_self(dir);
    if !dir.starts_with(target) {
        return false;
    }
    match try_git_toplevel(&dir).map(|top| canonical_or_self(&top)) {
        Some(top) => !(top != target && top.starts_with(target)),
        None => true,
    }
}

/// Refuse when any session whose working directory lies inside `target` has
/// an active turn. A session's directory is read from its driver-held
/// workspace root and from its persisted metadata. Idle sessions never block;
/// an agent whose driver cannot answer is skipped (a dead driver has no turn).
/// A session in a linked worktree nested inside `target` is not counted (see
/// [`is_rewritten_by`]).
///
/// This is a point-in-time check: it refuses an operation requested while a
/// turn is already running. It does not reserve the target against a prompt
/// the user starts afterwards (that needs prompt admission to share a lock
/// with the mutation).
///
/// # Errors
/// [`DestructiveOpBlocked`] naming the canonical `target`.
pub async fn ensure_no_active_turn_under(
    acp: &AcpManager,
    target: &Path,
) -> Result<(), DestructiveOpBlocked> {
    let target_path = target.to_path_buf();
    let target = tokio::task::spawn_blocking(move || canonical_or_self(&target_path))
        .await
        .unwrap_or_else(|_| target.to_path_buf());
    let persistence = acp.persistence();
    for agent_id in acp.list_agents() {
        let sessions = session_dirs(acp, &agent_id).await;
        // Filesystem and git work (canonicalize, metadata, rev-parse) stays
        // off the async runtime.
        let candidates = {
            let target = target.clone();
            let persistence = persistence.clone();
            tokio::task::spawn_blocking(move || {
                sessions
                    .into_iter()
                    .filter(|(session_id, driver_root)| {
                        let persisted_cwd = persistence
                            .as_ref()
                            .and_then(|store| store.metadata(session_id).ok())
                            .map(|metadata| PathBuf::from(metadata.cwd));
                        driver_root
                            .iter()
                            .chain(persisted_cwd.iter())
                            .any(|dir| is_rewritten_by(dir, &target))
                    })
                    .map(|(session_id, _)| session_id)
                    .collect::<Vec<_>>()
            })
            .await
            .unwrap_or_default()
        };
        for session_id in candidates {
            match acp.is_turn_active(&agent_id, SessionId(session_id)).await {
                Ok(true) => {
                    log::warn!(
                        "[destructive-guard] blocked: agent {agent_id} has an active turn inside {}",
                        target.display()
                    );
                    return Err(DestructiveOpBlocked { target });
                }
                Ok(false) => {}
                Err(error) => log::warn!(
                    "[destructive-guard] turn-state query failed for agent {agent_id}: {error}"
                ),
            }
        }
    }
    Ok(())
}

/// `(session id, driver-held root)` for one agent. When the roots query fails
/// the ids alone are still checked against persisted metadata.
async fn session_dirs(acp: &AcpManager, agent_id: &AgentId) -> Vec<(String, Option<PathBuf>)> {
    match acp.agent_session_roots(agent_id).await {
        Ok(roots) => roots
            .into_iter()
            .map(|(session_id, root)| (session_id, Some(root)))
            .collect(),
        Err(error) => {
            log::warn!("[destructive-guard] session-root query failed for agent {agent_id}: {error}");
            match acp.agent_session_ids(agent_id).await {
                Ok(ids) => ids.into_iter().map(|id| (id, None)).collect(),
                Err(_) => Vec::new(),
            }
        }
    }
}

#[cfg(test)]
mod tests;
