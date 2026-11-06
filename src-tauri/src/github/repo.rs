//! A project's GitHub repository, read from its git remote (CAP-2, CAP-9).
//!
//! Requests never carry a host: it comes from the remote, and it reaches `gh`
//! only when it is `github.com` or a host in gh's own auth inventory, so a
//! crafted remote cannot make `gh` send the user's token to another host.

use serde::Deserialize;

use super::runner::DEFAULT_HOST;
use super::types::GithubRepoRef;
use crate::git_remote::ParsedRemote;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum RemoteRoute {
    /// No remote, a local path, or a remote that is not `owner/name` shaped.
    NoGithubRemote,
    /// A forge that is never GitHub.
    OtherForge,
    /// A GitHub-shaped remote; whether gh may talk to its host is decided
    /// against the auth inventory.
    Candidate(GithubRepoRef),
}

const OTHER_FORGE_HOSTS: &[&str] = &[
    "gitlab.com",
    "bitbucket.org",
    "codeberg.org",
    "dev.azure.com",
    "ssh.dev.azure.com",
    "git.sr.ht",
];

fn is_other_forge(host: &str) -> bool {
    OTHER_FORGE_HOSTS.contains(&host) || host.contains("gitlab")
}

pub(super) fn route_remote(remote: Option<ParsedRemote>) -> RemoteRoute {
    let Some(remote) = remote else {
        return RemoteRoute::NoGithubRemote;
    };
    if is_other_forge(&remote.host) {
        return RemoteRoute::OtherForge;
    }
    match (remote.owner, remote.name) {
        (Some(owner), Some(name)) => RemoteRoute::Candidate(GithubRepoRef {
            host: remote.host,
            owner,
            name,
        }),
        _ => RemoteRoute::NoGithubRemote,
    }
}

/// Whether `gh` may be pointed at `host`: always for `github.com`, otherwise
/// only when gh already holds a login for it.
pub(super) fn host_allowed(host: &str, known_to_gh: bool) -> bool {
    host == DEFAULT_HOST || known_to_gh
}

#[derive(Deserialize)]
struct RepoViewParent {
    parent: Option<ParentRepo>,
}

#[derive(Deserialize)]
struct ParentRepo {
    name: String,
    owner: ParentOwner,
}

#[derive(Deserialize)]
struct ParentOwner {
    login: String,
}

/// Parse `gh repo view --json parent`; the parent lives on the fork's host.
pub(super) fn parse_parent(stdout: &[u8], fork: &GithubRepoRef) -> Option<Option<GithubRepoRef>> {
    let view: RepoViewParent = serde_json::from_slice(stdout).ok()?;
    Some(view.parent.map(|parent| GithubRepoRef {
        host: fork.host.clone(),
        owner: parent.owner.login,
        name: parent.name,
    }))
}
