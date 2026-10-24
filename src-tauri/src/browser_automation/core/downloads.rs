//! Agent-tab downloads. The engine's download hook asks the host where a
//! download may land: only into the session's downloads directory under app
//! data, never the project tree or the user's Downloads folder, under a
//! host-chosen `<uuid>.<ext>` name, within per-session count and size caps.
//! When the file is complete the host marks it as downloaded from the
//! internet (Mark-of-the-Web, quarantine) and asks for confirmation; a
//! download the user does not allow is deleted. Files are never opened.
//!
//! Engine hooks are synchronous, so the confirmation comes after the bytes
//! landed in the session directory and before anything else can use them.
//! The size cap holds while the bytes stream where the engine reports
//! progress (WebView2, WebKitGTK): a download announcing more is cancelled
//! before any byte lands, and one that grows past it is cancelled there.
//! Tauri's WKWebView hook reports no progress, so on macOS the cap is
//! checked when the download finishes.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use tauri::Url;
use uuid::Uuid;

use super::authz::HopVerdict;
use super::consent::SensitiveRequest;
use super::events::label_prefix;
use super::ports::{ActionClass, CanonicalOrigin, TabProfile};
use super::sensitivity::Sensitive;
use super::teardown::session_dir;
use super::DesktopBrowserHost;
use crate::browser_automation::budgets::{self, Deadline};
use crate::browser_automation::engine::files;

pub const MAX_DOWNLOADS_PER_SESSION: usize = 20;
pub const MAX_DOWNLOAD_BYTES: u64 = 200 * 1024 * 1024;

/// One download the engine is writing for an agent tab.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pending {
    pub tab: String,
    pub url: String,
    pub path: PathBuf,
    pub origin: CanonicalOrigin,
    pub profile: TabProfile,
}

#[derive(Default)]
struct SessionDownloads {
    started: usize,
    pending: Vec<Pending>,
}

/// Per-session download bookkeeping.
#[derive(Default)]
pub struct Downloads {
    sessions: Mutex<HashMap<String, SessionDownloads>>,
}

impl Downloads {
    /// Record a download about to start. False once the session started
    /// its quota of downloads.
    pub fn admit(&self, session_id: &str, pending: Pending) -> bool {
        let mut sessions = self.sessions.lock();
        let session = sessions.entry(session_id.to_string()).or_default();
        if session.started >= MAX_DOWNLOADS_PER_SESSION {
            return false;
        }
        session.started += 1;
        session.pending.push(pending);
        true
    }

    /// The oldest pending download of `tab` for `url`.
    pub fn take(&self, tab: &str, url: &str) -> Option<(String, Pending)> {
        let mut sessions = self.sessions.lock();
        sessions.iter_mut().find_map(|(session_id, s)| {
            let at = s
                .pending
                .iter()
                .position(|p| p.tab == tab && p.url == url)?;
            Some((session_id.clone(), s.pending.remove(at)))
        })
    }

    pub fn forget(&self, session_id: &str) {
        self.sessions.lock().remove(session_id);
    }
}

/// Whether a download of `tab` that has (or announced) `bytes` may go on.
pub fn within_cap(tab: &str, bytes: u64) -> bool {
    if bytes <= MAX_DOWNLOAD_BYTES {
        return true;
    }
    log::info!(
        "[browser-agent] download cancelled tab={} reason=too_large",
        label_prefix(tab)
    );
    false
}

/// The extension a download keeps: ASCII alphanumerics only, short, lower
/// case.
fn sanitized_ext(name: &str) -> Option<String> {
    let (_, ext) = name.rsplit_once('.')?;
    let ok = !ext.is_empty() && ext.len() <= 10 && ext.chars().all(|c| c.is_ascii_alphanumeric());
    ok.then(|| ext.to_ascii_lowercase())
}

/// `<uuid>.<ext>`, the extension taken from the engine's suggested name or
/// else the URL's last path segment.
pub fn host_file_name(suggested: &Path, url: &Url) -> String {
    let from_suggested = suggested
        .file_name()
        .and_then(|n| sanitized_ext(&n.to_string_lossy()));
    let from_url = || {
        url.path_segments()
            .and_then(|mut segments| segments.next_back().map(str::to_string))
            .and_then(|last| sanitized_ext(&last))
    };
    match from_suggested.or_else(from_url) {
        Some(ext) => format!("{}.{ext}", Uuid::new_v4()),
        None => Uuid::new_v4().to_string(),
    }
}

/// The origin a download comes from: the URL's own for http(s), the
/// creating document's for `blob:`, the tab's for `data:`.
pub fn download_origin(url: &Url, tab_url: &str) -> Option<CanonicalOrigin> {
    match url.scheme() {
        "http" | "https" => CanonicalOrigin::parse(url.as_str()).ok(),
        "blob" => CanonicalOrigin::parse(url.path()).ok(),
        "data" => CanonicalOrigin::parse(tab_url).ok(),
        _ => None,
    }
}

impl DesktopBrowserHost {
    /// Where a download `tab` starts may land, or `None` to cancel it.
    /// Runs on the UI thread inside the engine's download hook.
    pub(super) fn download_starting(
        &self,
        tab: &str,
        url: &Url,
        suggested: &Path,
    ) -> Option<PathBuf> {
        let refuse = |reason: &str| {
            log::info!(
                "[browser-agent] download cancelled tab={} reason={reason}",
                label_prefix(tab)
            );
            None
        };
        let (session_id, tab_url, profile) = {
            let registry = self.registry.lock();
            let Some(record) = registry.get(tab) else {
                return refuse("tab_unknown");
            };
            let (Some(session_id), Some(profile)) = (record.session_id(), record.profile()) else {
                return refuse("not_an_agent_tab");
            };
            (session_id.to_string(), record.url.clone(), profile)
        };
        if self.gate.is_stopped(&session_id) {
            return refuse("stopped_by_user");
        }
        let Some(origin) = download_origin(url, &tab_url) else {
            return refuse("unsupported_source");
        };
        let fetched = matches!(url.scheme(), "http" | "https");
        if fetched && self.gate.check_hop(&session_id, url) != HopVerdict::Allow {
            return refuse("ungranted_origin");
        }
        let Ok(root) = self.surface.session_data_root() else {
            return refuse("no_session_dir");
        };
        let dir = session_dir(&root, &session_id).join("downloads");
        if std::fs::create_dir_all(&dir).is_err() {
            return refuse("no_session_dir");
        }
        let path = dir.join(host_file_name(suggested, url));
        let pending = Pending {
            tab: tab.to_string(),
            url: url.to_string(),
            path: path.clone(),
            origin,
            profile,
        };
        if !self.downloads.admit(&session_id, pending) {
            return refuse("download_cap");
        }
        log::info!("[browser-agent] download started tab={}", label_prefix(tab));
        Some(path)
    }

    /// The engine finished (or failed) a download it started for `tab`.
    pub(super) fn download_finished(&self, tab: &str, url: &Url, success: bool) {
        let Some((session_id, pending)) = self.downloads.take(tab, url.as_str()) else {
            return;
        };
        let Some(me) = self.me.upgrade() else {
            return;
        };
        super::spawn(async move {
            let kept = me.vet_download(&session_id, &pending, success).await;
            if !kept {
                let path = pending.path.clone();
                let _ = tokio::task::spawn_blocking(move || std::fs::remove_file(path)).await;
            }
        });
    }

    /// Whether a finished download is kept: complete, within the size cap,
    /// marked, and confirmed.
    async fn vet_download(&self, session_id: &str, pending: &Pending, success: bool) -> bool {
        let tab = label_prefix(&pending.tab);
        let refuse = |reason: &str| {
            log::info!("[browser-agent] download discarded tab={tab} reason={reason}");
            false
        };
        if !success {
            return refuse("engine_failed");
        }
        let path = pending.path.clone();
        let origin = pending.origin.clone();
        let checked = tokio::task::spawn_blocking(move || {
            let bytes = std::fs::metadata(&path).map(|m| m.len()).ok()?;
            Some((
                bytes,
                files::mark_downloaded(&path, origin.as_str()).is_ok(),
            ))
        })
        .await
        .ok()
        .flatten();
        let Some((bytes, marked)) = checked else {
            return refuse("missing_file");
        };
        if bytes > MAX_DOWNLOAD_BYTES {
            return refuse("too_large");
        }
        if !marked {
            return refuse("mark_failed");
        }
        let Ok(token) = self.gate.begin(session_id) else {
            return refuse("stopped_by_user");
        };
        let project_id = (self.project_of)(session_id);
        let item = Sensitive {
            class: ActionClass::Download,
            origin: Some(pending.origin.clone()),
            target: pending.url.clone(),
            pinned: false,
        };
        let req = SensitiveRequest {
            session_id,
            project_id: &project_id,
            element: None,
            file: None,
            profile: pending.profile,
            deadline: Deadline::after(budgets::CONSENT_WAIT),
        };
        match self.gate.confirm_sensitive(&token, &req, &item).await {
            Ok(()) => {
                log::info!("[browser-agent] download kept tab={tab} bytes={bytes}");
                true
            }
            Err(e) => refuse(e.reason.unwrap_or("not_confirmed")),
        }
    }
}

#[cfg(test)]
#[path = "downloads_tests.rs"]
mod tests;
