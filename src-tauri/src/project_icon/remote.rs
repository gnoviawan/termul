//! Git-remote-derived remote icon resolution.
//!
//! The fetch URL is ALWAYS derived from parsed `git remote` output — never a
//! renderer-supplied URL. HTTPS only: `http://` remotes are refused, and
//! redirects are bounded to the remote host or `avatars.githubusercontent.com`
//! (GitHub's `<owner>.png` 302s there). Response guard: `image/*` content-type,
//! ≤256 KB stream-read, and the shared magic-byte/square pipeline. Remote-URL
//! parsing covers `https://`, `ssh://`, `git+ssh://`, `git://`, and scp-like
//! `git@host:owner/repo(.git)` forms, trailing `.git`, ports, and self-hosted
//! hosts (GHES/Gitea).
//!
//! SSRF hygiene: literal IPs in loopback/link-local/unspecified/multicast
//! ranges and obviously-local names are refused. RFC-1918 private IPs and
//! private DNS names stay allowed on purpose — self-hosted forges (GHES,
//! Gitea) routinely live on LAN addresses and the spec requires them; the
//! https-only + image-MIME + size-cap guards bound the residual risk.
//!
//! The raw remote string is never logged (it may embed credentials); logs
//! carry the parsed host + step only.

use std::net::IpAddr;
use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use reqwest::Url;

use crate::trackers::git_tracker::GitTracker;

use super::local::{decode_image, Decode};
use super::{boundary_warn, ProjectIcon, ProjectIconSource};

/// Remote response bound (~256 KB per spec).
const MAX_REMOTE_BYTES: usize = 256 * 1024;
/// Redirect hop bound — enough for `owner.png` → CDN; refuse beyond it.
const MAX_REDIRECTS: usize = 5;
/// Total request timeout — a hung endpoint must not stall resolution.
const FETCH_TIMEOUT_SECS: u64 = 10;
/// The only off-host redirect target allowed (GitHub avatar CDN per spec).
const GITHUB_AVATAR_CDN: &str = "avatars.githubusercontent.com";
const USER_AGENT: &str = "termul-project-icon";

/// One candidate fetch URL plus the host redirects may stay on.
pub(super) struct FetchTarget {
    pub url: String,
    /// Redirect targets must land on this host or [`GITHUB_AVATAR_CDN`].
    pub allowed_host: String,
}

/// Parsed remote — host normalized (`ssh.github.com` → `github.com`,
/// lowercased), port kept only for `https` remotes.
pub(super) struct ParsedRemote {
    /// Hostname only — safe to log (credentials never reach this field).
    pub host: String,
    /// Explicit non-default port of an `https://` remote (a Gitea on :8443
    /// serves its favicon on the same port). `ssh`/`git` ports are dropped —
    /// they describe the SSH endpoint, not the web service.
    pub port: Option<u16>,
    /// First path segment (the GitHub avatar owner). `None` for pathless or
    /// empty-path remotes — they still get the `favicon.ico` candidate.
    pub owner: Option<String>,
}

pub(super) enum RemoteParse {
    Remote(ParsedRemote),
    /// `http://` remote — refused (https only); caller emits the warn log.
    HttpScheme,
    /// Local path / unparseable string — silent miss.
    NotRemote,
}

/// Build the ordered fetch candidates for a repo: GitHub-family hosts get
/// `https://<host>/<owner>.png?size=64` before the `favicon.ico` fallback
/// every forge host gets. Empty when the repo has no usable remote.
pub(super) fn fetch_targets(cwd: &Path) -> Vec<FetchTarget> {
    let Some(cwd_str) = cwd.to_str() else {
        return Vec::new();
    };
    let Some(remote_url) = git_remote_url(cwd_str) else {
        return Vec::new();
    };
    let parsed = match parse_remote_url(&remote_url) {
        RemoteParse::Remote(parsed) => parsed,
        RemoteParse::HttpScheme => {
            boundary_warn(
                "remote icon fetch refused: http:// remotes are not fetched (https only)",
            );
            return Vec::new();
        }
        RemoteParse::NotRemote => return Vec::new(),
    };
    if is_refused_host(&parsed.host) {
        boundary_warn("remote icon fetch refused: remote host is a local/refused address");
        return Vec::new();
    }
    let authority = match parsed.port {
        Some(port) => format!("{}:{port}", parsed.host),
        None => parsed.host.clone(),
    };
    let mut targets = Vec::new();
    if is_github_family(&parsed.host) {
        if let Some(owner) = parsed.owner.as_deref() {
            targets.push(FetchTarget {
                url: format!("https://{authority}/{owner}.png?size=64"),
                allowed_host: parsed.host.clone(),
            });
        }
    }
    targets.push(FetchTarget {
        url: format!("https://{authority}/favicon.ico"),
        allowed_host: parsed.host.clone(),
    });
    targets
}

/// `git remote get-url origin` → stdout trimmed; on failure/empty, the first
/// URL field of `git remote -v` (`origin\t<url> (fetch)` → field 1).
/// The raw remote string is never logged — it may embed credentials.
fn git_remote_url(cwd: &str) -> Option<String> {
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

/// Parse a `git remote` URL into `(host, port?, owner)`. Covers https/ssh/
/// git+ssh/git schemes, scp-like `git@host:path`, trailing `.git`, ports, and
/// self-hosted hosts.
pub(super) fn parse_remote_url(raw: &str) -> RemoteParse {
    let raw = raw.trim();
    if raw.is_empty() {
        return RemoteParse::NotRemote;
    }
    if raw.contains("://") {
        // `git+ssh://` is not a registered scheme — normalize to `ssh://`.
        let normalized = raw.replacen("git+ssh://", "ssh://", 1);
        let Ok(url) = Url::parse(&normalized) else {
            return RemoteParse::NotRemote;
        };
        let scheme = url.scheme();
        let Some(host) = url.host_str().map(|h| h.to_ascii_lowercase()) else {
            return RemoteParse::NotRemote;
        };
        match scheme {
            "http" => return RemoteParse::HttpScheme,
            "https" | "ssh" | "git" => {}
            _ => return RemoteParse::NotRemote,
        }
        return RemoteParse::Remote(ParsedRemote {
            host: normalize_host(&host),
            port: if scheme == "https" { url.port() } else { None },
            owner: path_owner(url.path()),
        });
    }
    // scp-like `user@host:owner/repo(.git)` — the `@` is required so Windows
    // drive paths (`C:\…`) and bare `host:path` can't be mistaken for remotes.
    let Some((user_host, path)) = raw.split_once(':') else {
        return RemoteParse::NotRemote;
    };
    let Some((_, host)) = user_host.rsplit_once('@') else {
        return RemoteParse::NotRemote;
    };
    let host = host.trim().to_ascii_lowercase();
    if host.is_empty() || host.contains('/') || path.is_empty() {
        return RemoteParse::NotRemote;
    }
    RemoteParse::Remote(ParsedRemote {
        host: normalize_host(&host),
        port: None,
        owner: path_owner(path),
    })
}

/// First path segment after stripping trailing `.git` on the last segment.
fn path_owner(path: &str) -> Option<String> {
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
    segs.first()
        .filter(|seg| !seg.is_empty())
        .map(|seg| seg.to_string())
}

/// `ssh.github.com`/`www.github.com` collapse to `github.com` (SSH endpoint
/// and www redirect respectively — the icon service is the bare host).
fn normalize_host(host: &str) -> String {
    match host {
        "ssh.github.com" | "www.github.com" => "github.com".to_string(),
        _ => host.to_string(),
    }
}

/// GitHub-family: `github.com` itself plus `github.*` self-hosted GHES hosts.
/// A non-GHES `github.*` host simply 404s the avatar and falls back to
/// `favicon.ico`, so the guess stays cheap.
pub(super) fn is_github_family(host: &str) -> bool {
    host == "github.com" || host.starts_with("github.")
}

/// Refuse hosts that can never be a remote forge: `localhost`/`*.localhost`/
/// `*.local`/`*.home.arpa` names and literal IPs in loopback, link-local
/// (covers `169.254.169.254` cloud metadata), unspecified, multicast, and
/// broadcast ranges — IPv4-mapped IPv6 literals checked as IPv4.
/// RFC-1918/ULA/private DNS stays allowed (self-hosted forges live there).
pub(super) fn is_refused_host(host: &str) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    if h == "localhost"
        || h.ends_with(".localhost")
        || h.ends_with(".local")
        || h.ends_with(".home.arpa")
    {
        return true;
    }
    match h.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => refused_v4(ip),
        Ok(IpAddr::V6(ip)) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return refused_v4(v4);
            }
            ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || (ip.segments()[0] & 0xffc0) == 0xfe80
        }
        Err(_) => false,
    }
}

pub(super) fn refused_v4(ip: std::net::Ipv4Addr) -> bool {
    ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip.is_broadcast()
}

fn http_client() -> Option<&'static reqwest::Client> {
    static CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .user_agent(USER_AGENT)
                .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
                // Manual redirect handling: every hop is re-validated against
                // the remote host / avatar CDN before being followed.
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .ok()
        })
        .as_ref()
}

/// Fetch + decode one remote candidate. `None` on every failure — refused
/// redirect, non-2xx, non-image, oversized, transport error — each logged at
/// warn level with the host (never the full URL, which could carry secrets).
pub(super) async fn fetch_remote_icon(target: &FetchTarget) -> Option<ProjectIcon> {
    let (bytes, header_mime) = fetch_bounded(target).await?;
    let (mime, payload) = match decode_image(&bytes) {
        Decode::Icon(mime, frame) => (mime.to_string(), frame.to_vec()),
        // Recognized-but-rejected (non-square raster) refuses outright — a
        // remote favicon must not sneak through the header fallback.
        Decode::Rejected => {
            boundary_warn(&format!(
                "remote icon refused non-square raster payload from {}",
                target.allowed_host
            ));
            return None;
        }
        // Unrecognized bytes are kept under the asserted `image/*` type —
        // covers formats with no sniffer (avif, heic).
        Decode::Unknown => (header_mime, bytes),
    };
    Some(ProjectIcon {
        data_uri: format!("data:{mime};base64,{}", B64.encode(payload)),
        mime,
        source: ProjectIconSource::Remote,
    })
}

async fn fetch_bounded(target: &FetchTarget) -> Option<(Vec<u8>, String)> {
    let client = http_client()?;
    let mut current = Url::parse(&target.url).ok()?;
    for _hop in 0..=MAX_REDIRECTS {
        let response = match client
            .get(current.clone())
            .header(reqwest::header::ACCEPT, "image/*")
            .send()
            .await
        {
            Ok(response) => response,
            Err(e) => {
                boundary_warn(&format!(
                    "remote icon fetch failed for host {}: {e}",
                    target.allowed_host
                ));
                return None;
            }
        };
        let status = response.status();
        if status.is_redirection() {
            let Some(next) = redirect_target(&response, &current, target) else {
                boundary_warn(&format!(
                    "remote icon redirect refused leaving host {}",
                    target.allowed_host
                ));
                return None;
            };
            current = next;
            continue;
        }
        if !status.is_success() {
            boundary_warn(&format!(
                "remote icon fetch returned {status} for host {}",
                target.allowed_host
            ));
            return None;
        }
        let mime = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(|value| {
                value
                    .split(';')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_ascii_lowercase()
            })
            .unwrap_or_default();
        if !mime.starts_with("image/") {
            boundary_warn(&format!(
                "remote icon refused non-image content-type '{mime}' from {}",
                target.allowed_host
            ));
            return None;
        }
        if response
            .content_length()
            .is_some_and(|len| len as usize > MAX_REMOTE_BYTES)
        {
            boundary_warn(&format!(
                "remote icon refused oversized payload from {}",
                target.allowed_host
            ));
            return None;
        }
        // Bounded stream-read — a chunked response lying about its size is
        // still capped at MAX_REMOTE_BYTES.
        let mut buf = Vec::new();
        let mut response = response;
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    if buf.len() + chunk.len() > MAX_REMOTE_BYTES {
                        boundary_warn(&format!(
                            "remote icon refused oversized payload from {}",
                            target.allowed_host
                        ));
                        return None;
                    }
                    buf.extend_from_slice(&chunk);
                }
                Ok(None) => break,
                Err(e) => {
                    boundary_warn(&format!(
                        "remote icon read failed from {}: {e}",
                        target.allowed_host
                    ));
                    return None;
                }
            }
        }
        return Some((buf, mime));
    }
    boundary_warn(&format!(
        "remote icon redirect limit exceeded for host {}",
        target.allowed_host
    ));
    None
}

/// Follow a 3xx only when the target stays on https AND on the remote host
/// (or the GitHub avatar CDN). Relative `Location` values resolve against
/// the current URL, so same-origin relative redirects pass the host check.
fn redirect_target(
    response: &reqwest::Response,
    current: &Url,
    target: &FetchTarget,
) -> Option<Url> {
    let location = response
        .headers()
        .get(reqwest::header::LOCATION)?
        .to_str()
        .ok()?;
    let next = current.join(location).ok()?;
    if next.scheme() != "https" {
        return None;
    }
    let host = next.host_str()?.to_ascii_lowercase();
    (host == target.allowed_host || host == GITHUB_AVATAR_CDN).then_some(next)
}
