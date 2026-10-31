//! Pointing a chat worktree at a PR's head (CAP-7, CAP-8): which worktrees
//! qualify, the fork push rule, and the push command the agent is given.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::error::GithubError;
use super::graphql::{Login, RATE_LIMIT_FIELDS};
use super::types::GithubRepoRef;
use crate::git_remote::parse_remote_url;
use crate::trackers::GitTracker;

const GIT_TIMEOUT_MS: u64 = 10_000;
const CHAT_BRANCH_PREFIX: &str = "chat/";

/// A clean Termul chat worktree: a linked worktree under its repository's
/// `.termul/worktrees/`, on a `chat/` branch.
pub(super) struct ChatWorktree {
    pub root: String,
    pub branch: String,
}

fn git(cwd: &str, args: &[&str]) -> Option<String> {
    let output = GitTracker::run_git_command_with_timeout(cwd, args, GIT_TIMEOUT_MS)?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub(super) fn chat_worktree(cwd: &str) -> Result<ChatWorktree, GithubError> {
    let not_ours = || GithubError::NotTermulWorktree(cwd.to_string());
    let dirs = git(
        cwd,
        &[
            "rev-parse",
            "--show-toplevel",
            "--git-dir",
            "--git-common-dir",
        ],
    )
    .ok_or_else(not_ours)?;
    // `--git-dir` and `--git-common-dir` may print paths relative to `cwd`.
    let dirs: Vec<PathBuf> = dirs
        .lines()
        .map(|line| Path::new(cwd).join(line).canonicalize())
        .collect::<Result<_, _>>()
        .map_err(|_| not_ours())?;
    let [root, git_dir, common_dir] = dirs.as_slice() else {
        return Err(not_ours());
    };
    let managed = common_dir
        .parent()
        .map(|main| main.join(".termul").join("worktrees"));
    let linked = git_dir != common_dir;
    if !linked || !managed.is_some_and(|dir| root.starts_with(&dir) && *root != dir) {
        return Err(not_ours());
    }
    let root = crate::path_validation::strip_verbatim_prefix(&root.to_string_lossy()).into_owned();
    let branch = git(&root, &["symbolic-ref", "--short", "-q", "HEAD"]).unwrap_or_default();
    if !branch.starts_with(CHAT_BRANCH_PREFIX) {
        return Err(GithubError::Refused(format!(
            "The worktree is not on a chat branch ({}), so Termul will not reset it",
            if branch.is_empty() {
                "detached HEAD"
            } else {
                &branch
            }
        )));
    }
    let status = git(&root, &["status", "--porcelain"])
        .ok_or_else(|| GithubError::Failed("git status failed in the worktree".to_string()))?;
    if !status.is_empty() {
        return Err(GithubError::Refused(
            "The worktree has uncommitted changes; commit or discard them before checking out a pull request"
                .to_string(),
        ));
    }
    Ok(ChatWorktree { root, branch })
}

pub(super) fn head_graphql() -> String {
    format!(
        "query($owner: String!, $name: String!, $number: Int!) {{ {RATE_LIMIT_FIELDS} \
         repository(owner: $owner, name: $name) {{ viewerPermission pullRequest(number: $number) {{ \
         headRefName headRefOid isCrossRepository maintainerCanModify \
         headRepository {{ name owner {{ login }} viewerPermission }} }} }} }}"
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PrHead {
    pub head_ref_name: String,
    pub head_ref_oid: String,
    pub is_cross_repository: bool,
    pub maintainer_can_modify: bool,
    head_repository: Option<HeadRepo>,
    /// The viewer's permission on the base repository.
    #[serde(skip)]
    base_permission: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeadRepo {
    name: String,
    owner: Login,
    viewer_permission: Option<String>,
}

pub(super) fn parse_head(data: &serde_json::Value, number: u64) -> Result<PrHead, GithubError> {
    let pr = data
        .pointer("/repository/pullRequest")
        .filter(|pr| !pr.is_null())
        .ok_or_else(|| GithubError::NotFound(format!("pull request #{number}")))?;
    let mut head: PrHead = serde_json::from_value(pr.clone())
        .map_err(|e| GithubError::Failed(format!("unreadable pull request #{number}: {e}")))?;
    head.base_permission = data
        .pointer("/repository/viewerPermission")
        .and_then(|p| p.as_str())
        .map(str::to_string);
    Ok(head)
}

fn can_write(permission: Option<&str>) -> bool {
    matches!(permission, Some("ADMIN" | "MAINTAIN" | "WRITE"))
}

/// The repository commits must be pushed to for the PR's head branch, or
/// why they cannot be. The branch is pushable when the user can write to the
/// head repository, or when the PR allows maintainer edits and the user can
/// write to the base repository.
pub(super) fn push_repo(
    base: &GithubRepoRef,
    number: u64,
    head: &PrHead,
) -> Result<GithubRepoRef, GithubError> {
    let Some(repo) = &head.head_repository else {
        return Err(GithubError::ForkPushBlocked(format!(
            "The repository pull request #{number} comes from was deleted, so there is no branch to push to"
        )));
    };
    let head_repo = GithubRepoRef {
        host: base.host.clone(),
        owner: repo.owner.login.clone(),
        name: repo.name.clone(),
    };
    if can_write(repo.viewer_permission.as_deref()) {
        return Ok(head_repo);
    }
    if !head.is_cross_repository {
        return Err(GithubError::ForkPushBlocked(format!(
            "You cannot push to {}/{}, so an agent's commits could not be pushed to the branch of pull request #{number}.",
            base.owner, base.name
        )));
    }
    if !head.maintainer_can_modify {
        return Err(GithubError::ForkPushBlocked(format!(
            "Pull request #{number} comes from the fork {}/{}, which does not allow edits by maintainers, \
             so an agent's commits could not be pushed to its branch. Ask the author to enable \
             \"Allow edits by maintainers\".",
            head_repo.owner, head_repo.name
        )));
    }
    if !can_write(head.base_permission.as_deref()) {
        return Err(GithubError::ForkPushBlocked(format!(
            "Pull request #{number} comes from the fork {}/{}, which allows edits only by maintainers of {}/{}, \
             and you cannot push to {}/{}, so an agent's commits could not be pushed to its branch.",
            head_repo.owner, head_repo.name, base.owner, base.name, base.owner, base.name
        )));
    }
    Ok(head_repo)
}

/// Point `branch` at the detached HEAD and check it out; the working tree is
/// left as it is.
pub(super) fn attach_branch(root: &str, branch: &str) -> Result<(), GithubError> {
    git(root, &["switch", "-q", "-C", branch])
        .map(|_| ())
        .ok_or_else(|| {
            GithubError::Failed(format!("git switch -C {branch} failed in the worktree"))
        })
}

pub(super) fn head_sha(root: &str) -> Result<String, GithubError> {
    git(root, &["rev-parse", "HEAD"])
        .ok_or_else(|| GithubError::Failed("git rev-parse HEAD failed in the worktree".to_string()))
}

fn names_repo(url: &str, repo: &GithubRepoRef) -> bool {
    parse_remote_url(url).is_some_and(|remote| {
        remote.host.eq_ignore_ascii_case(&repo.host)
            && remote
                .owner
                .is_some_and(|owner| owner.eq_ignore_ascii_case(&repo.owner))
            && remote
                .name
                .is_some_and(|name| name.eq_ignore_ascii_case(&repo.name))
    })
}

/// The remote (a name, or a URL) that `git push` should use to reach
/// `head_repo`: the branch's push remote as `gh pr checkout` configured it,
/// else any remote for that repository, else its URL in `origin`'s protocol.
pub(super) fn push_remote(root: &str, branch: &str, head_repo: &GithubRepoRef) -> String {
    let remotes: Vec<String> = git(root, &["remote"])
        .unwrap_or_default()
        .lines()
        .map(str::to_string)
        .collect();
    let configured = ["pushRemote", "remote"]
        .iter()
        .filter_map(|key| git(root, &["config", &format!("branch.{branch}.{key}")]));
    for candidate in configured.chain(remotes.iter().cloned()) {
        let url = if remotes.contains(&candidate) {
            git(root, &["remote", "get-url", "--push", &candidate]).unwrap_or_default()
        } else {
            candidate.clone()
        };
        if names_repo(&url, head_repo) {
            return candidate;
        }
    }
    let origin_is_https = git(root, &["remote", "get-url", "origin"])
        .is_some_and(|url| url.starts_with("https://") || url.starts_with("http://"));
    if origin_is_https {
        format!(
            "https://{}/{}/{}.git",
            head_repo.host, head_repo.owner, head_repo.name
        )
    } else {
        format!(
            "git@{}:{}/{}.git",
            head_repo.host, head_repo.owner, head_repo.name
        )
    }
}

/// `git push <remote> HEAD:<branch>`, each argument quoted for a POSIX shell
/// when it needs it: a fork's branch name may contain `;`, `$` or quotes.
pub(super) fn push_command(remote: &str, head_ref_name: &str) -> String {
    format!(
        "git push {} {}",
        shell_word(remote),
        shell_word(&format!("HEAD:{head_ref_name}"))
    )
}

fn shell_word(word: &str) -> String {
    let plain = !word.is_empty()
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./:@+=,%".contains(c));
    if plain {
        word.to_string()
    } else {
        format!("'{}'", word.replace('\'', r"'\''"))
    }
}
