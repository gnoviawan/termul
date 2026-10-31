//! A repository's git remote, read from `git remote` and parsed into host and
//! path. Shared by the project icon resolver and the GitHub service.
//!
//! The raw remote string is never logged: it may embed credentials
//! (`https://user:token@host/...`). Only the parsed fields are safe to log.

use crate::trackers::git_tracker::GitTracker;
use reqwest::Url;

/// A parsed remote. `host` is lowercased, with `ssh.github.com` and
/// `www.github.com` collapsed to `github.com`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParsedRemote {
    /// Hostname only; credentials never reach this field.
    pub host: String,
    /// Explicit port of an `https://`/`http://` remote. `ssh`/`git` ports
    /// describe the SSH endpoint, not the web service, so they are dropped.
    pub port: Option<u16>,
    /// First path segment. `None` for pathless remotes.
    pub owner: Option<String>,
    /// Second path segment, without `.git`, when the path is exactly
    /// `owner/name` (GitHub's shape; GitLab subgroups have more segments).
    pub name: Option<String>,
    /// The remote uses plain `http://`.
    pub insecure_http: bool,
}

/// `git remote get-url origin`, or the first URL of `git remote -v` when the
/// repository has no `origin`.
pub(crate) fn git_remote_url(cwd: &str) -> Option<String> {
    if let Some(out) = GitTracker::run_git_command(cwd, &["remote", "get-url", "origin"]) {
        if out.status.success() {
            let url = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !url.is_empty() {
                return Some(url);
            }
        }
    }
    let out = GitTracker::run_git_command(cwd, &["remote", "-v"])?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().next()?;
    let url = line.split_whitespace().nth(1)?.trim().to_string();
    (!url.is_empty()).then_some(url)
}

/// Parse a `git remote` URL. Covers https/http/ssh/git+ssh/git schemes,
/// scp-like `git@host:path`, trailing `.git`, ports, and self-hosted hosts.
/// `None` for local paths and unparseable strings.
pub(crate) fn parse_remote_url(raw: &str) -> Option<ParsedRemote> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if raw.contains("://") {
        // `git+ssh://` is not a registered scheme.
        let normalized = raw.replacen("git+ssh://", "ssh://", 1);
        let url = Url::parse(&normalized).ok()?;
        let scheme = url.scheme();
        let host = url.host_str()?.to_ascii_lowercase();
        let web = match scheme {
            "https" | "http" => true,
            "ssh" | "git" => false,
            _ => return None,
        };
        let (owner, name) = path_owner_name(url.path());
        return Some(ParsedRemote {
            host: normalize_host(&host),
            port: if web { url.port() } else { None },
            owner,
            name,
            insecure_http: scheme == "http",
        });
    }
    // scp-like `user@host:owner/repo(.git)`. The `@` is required so Windows
    // drive paths (`C:\…`) and bare `host:path` can't be mistaken for remotes.
    let (user_host, path) = raw.split_once(':')?;
    let (_, host) = user_host.rsplit_once('@')?;
    let host = host.trim().to_ascii_lowercase();
    if host.is_empty() || host.contains('/') || path.is_empty() {
        return None;
    }
    let (owner, name) = path_owner_name(path);
    Some(ParsedRemote {
        host: normalize_host(&host),
        port: None,
        owner,
        name,
        insecure_http: false,
    })
}

fn path_owner_name(path: &str) -> (Option<String>, Option<String>) {
    let mut segs: Vec<&str> = path
        .trim_matches('/')
        .split('/')
        .filter(|seg| !seg.is_empty())
        .collect();
    if let Some(last) = segs.last_mut() {
        if let Some(stripped) = last.strip_suffix(".git") {
            *last = stripped;
        }
    }
    let owner = segs
        .first()
        .filter(|seg| !seg.is_empty())
        .map(|seg| seg.to_string());
    let name = match segs.as_slice() {
        [_, name] if !name.is_empty() => Some(name.to_string()),
        _ => None,
    };
    (owner, name)
}

fn normalize_host(host: &str) -> String {
    match host {
        "ssh.github.com" | "www.github.com" => "github.com".to_string(),
        _ => host.to_string(),
    }
}

#[cfg(test)]
#[path = "git_remote_tests.rs"]
mod tests;
