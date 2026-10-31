//! Git-remote-derived remote icon resolution.
//!
//! The fetch URL is ALWAYS derived from parsed `git remote` output — never a
//! renderer-supplied URL. HTTPS only: `http://` remotes are refused, and
//! redirects are bounded to the remote host or `avatars.githubusercontent.com`
//! (GitHub's `<owner>.png` 302s there). Response guard: `image/*` content-type,
//! ≤256 KB stream-read, and the shared magic-byte/square pipeline. Remote-URL
//! parsing ([`crate::git_remote`]) covers `https://`, `ssh://`, `git+ssh://`, `git://`, and scp-like
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

use crate::git_remote::{git_remote_url, parse_remote_url};

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
    let Some(parsed) = parse_remote_url(&remote_url) else {
        return Vec::new();
    };
    if parsed.insecure_http {
        boundary_warn("remote icon fetch refused: http:// remotes are not fetched (https only)");
        return Vec::new();
    }
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
