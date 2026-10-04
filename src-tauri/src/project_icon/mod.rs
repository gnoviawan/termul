//! Project icon resolver (spec-project-icon).
//!
//! Resolution order — a `None` at every step falls through to the next:
//! 1. Local well-known icon files: ordered candidate scan, bounded reads,
//!    magic-byte sniff, square-only raster check, ICO→PNG frame extraction
//!    (`local`).
//! 2. Remote icon derived from the parsed `git remote` output — GitHub-family
//!    `<owner>.png`, every other forge host `favicon.ico` — fetched
//!    server-side over https with bounded redirects/size and `image/*` MIME
//!    enforcement (`remote`).
//! 3. `None` → the renderer falls back to a colored monogram tile.
//!
//! Shared by the desktop `project_icon_resolve` command and the web
//! `POST /project/icon` route so both transports resolve identically.
//! Best-effort everywhere: failures return `None` (never block the UI) plus
//! a durable boundary log — never credentials or full remote URLs.

mod local;
mod remote;

use std::path::PathBuf;

use serde::Serialize;

/// Resolved project icon, serialized to the renderer as a `data:` URI so the
/// existing CSP (`img-src … data:`) applies unchanged on every surface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectIcon {
    /// `data:<mime>;base64,<payload>` — rendered directly in `<img src>`.
    pub data_uri: String,
    /// Effective MIME type (magic-byte sniffed where possible; a `favicon.ico`
    /// holding PNG bytes reports `image/png`, not `image/x-icon`).
    pub mime: String,
    /// Where the icon came from: a repo file or a remote fetch.
    pub source: ProjectIconSource,
}

/// Provenance of a resolved [`ProjectIcon`]; serializes as `"file"`/`"remote"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectIconSource {
    File,
    Remote,
}

/// Resolve the project icon for the repo at `cwd` (local scan → remote fetch).
/// `None` means "render the monogram" — every failure path is best-effort.
pub async fn resolve(cwd: PathBuf) -> Option<ProjectIcon> {
    // The local file scan and `git remote` read are blocking (filesystem +
    // child process) — run them off the async executor in one blocking hop
    // (mirrors the `spawn_blocking` pattern the git routes use), then the
    // https fetch runs async.
    let probe = tokio::task::spawn_blocking(move || {
        let icon = local::resolve_local(&cwd);
        let targets = if icon.is_none() {
            remote::fetch_targets(&cwd)
        } else {
            Vec::new()
        };
        (icon, targets)
    })
    .await;
    let (icon, targets) = match probe {
        Ok(pair) => pair,
        Err(e) => {
            boundary_warn(&format!("project icon resolution task failed: {e}"));
            return None;
        }
    };
    if icon.is_some() {
        return icon;
    }
    for target in &targets {
        if let Some(icon) = remote::fetch_remote_icon(target).await {
            return Some(icon);
        }
    }
    None
}

/// Durable boundary log emitted on BOTH logger facades the crate uses: the
/// desktop installs a `log` backend (tauri-plugin-log) while `termul-server`
/// installs a `tracing` subscriber — each call lands once on whichever
/// runtime is live and no-ops on the other. Callers must pass messages that
/// contain no secrets, credentials, or full remote URLs.
fn boundary_warn(message: &str) {
    log::warn!("[project_icon] {message}");
    tracing::warn!(target: "termul::project_icon", "{message}");
}

#[cfg(test)]
mod tests;
