//! Link hops between local file pages. A file page's own main-frame hop to
//! a file the session holds no grant for is cancelled by the synchronous
//! engine hook, which can do no I/O. The host then checks the target off
//! the UI thread with the same rules as an agent's `file://` target: a
//! project file that passes is granted exactly and loaded by its real path;
//! any other target stays cancelled, and the tab's next reply tells the
//! agent to navigate there itself (which asks the user for a file outside
//! the project). Frames keep exact grants: a hop that an iframe, `<frame>`,
//! `<object>` or `<embed>` of the page points at is never followed.
//!
//! A link is followed only while the session still holds the grant of the
//! page it was clicked on, checked when the hop is cancelled and again just
//! before the grant: after Stop, a profile revoke or session end, page
//! script cannot grant itself project files with no agent call. A tab runs
//! one follow at a time, and keeps at most [`MAX_NOTES`] notes.

use serde::Serialize;
use serde_json::Value;
use tauri::Url;

use super::authz::file_key;
use super::events::label_prefix;
use super::local_files::check_local_file;
use super::stop::StopToken;
use super::DesktopBrowserHost;
use crate::browser_automation::budgets;
use crate::browser_automation::engine::assets;

/// What the agent is told to do about a link it was not taken through.
const NAVIGATE_YOURSELF: &str =
    "the page linked to this local file and the host did not follow the link; call navigate with this url to open it (a file outside the project asks the user)";

/// Notes a tab keeps until its next reply; older ones are dropped.
pub const MAX_NOTES: usize = 16;
/// The longest link target a note carries, in bytes.
pub const MAX_NOTE_URL_BYTES: usize = 2048;

/// A link to a local file the host did not follow, reported in the tab's
/// next reply as `page.fileLinks` (page-chosen, so untrusted).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileLinkNote {
    /// The link's target as the engine reported it, cut to
    /// [`MAX_NOTE_URL_BYTES`].
    pub url: String,
    pub reason: &'static str,
    pub message: &'static str,
}

impl FileLinkNote {
    fn new(url: &Url, reason: &'static str) -> Self {
        let mut url = url.to_string();
        if url.len() > MAX_NOTE_URL_BYTES {
            let mut cut = MAX_NOTE_URL_BYTES;
            while !url.is_char_boundary(cut) {
                cut -= 1;
            }
            url.truncate(cut);
        }
        Self {
            url,
            reason,
            message: NAVIGATE_YOURSELF,
        }
    }
}

/// What the page says about the hop.
enum Framing {
    /// A frame, object or embed of the page points at the target.
    Framed,
    NotFramed,
    /// The page could not be read in time.
    Unreadable,
}

impl DesktopBrowserHost {
    /// The hook cancelled a main-frame hop of agent tab `tab_id` to the
    /// ungranted file `url`. If the tab shows a file page the session still
    /// holds, check the target off the UI thread and follow it when it is a
    /// project file. Runs on the UI thread: no I/O here.
    pub(super) fn file_link_cancelled(&self, tab_id: &str, session_id: &str, url: &Url) {
        let tab = label_prefix(tab_id);
        let from = {
            let mut registry = self.registry.lock();
            let Some(record) = registry.get_mut(tab_id) else {
                return;
            };
            let Ok(from) = record.url.parse::<Url>() else {
                return;
            };
            if from.scheme() != "file" {
                return;
            }
            if record.file_link_busy {
                log::info!("[browser-agent] file link dropped tab={tab} reason=follow_in_progress");
                return;
            }
            if self.gate.file_read_access(session_id, &from).is_none() {
                log::info!("[browser-agent] file link dropped tab={tab} reason=source_not_granted");
                return;
            }
            record.file_link_busy = true;
            from
        };
        let started = self
            .me
            .upgrade()
            .zip(self.gate.begin(session_id).ok());
        let Some((me, token)) = started else {
            self.end_file_link(tab_id);
            return;
        };
        let (label, session_id, url) = (tab_id.to_string(), session_id.to_string(), url.clone());
        super::spawn(async move {
            me.follow_file_link(&label, &session_id, &from, &url, &token).await;
            me.end_file_link(&label);
        });
    }

    fn end_file_link(&self, label: &str) {
        if let Some(record) = self.registry.lock().get_mut(label) {
            record.file_link_busy = false;
        }
    }

    async fn follow_file_link(
        &self,
        label: &str,
        session_id: &str,
        from: &Url,
        url: &Url,
        token: &StopToken,
    ) {
        let tab = label_prefix(label);
        let root = (self.root_of)(session_id);
        let target = url.to_string();
        let checked = tokio::time::timeout(
            budgets::EVAL_STEP,
            tokio::task::spawn_blocking(move || check_local_file(root.as_deref(), &target)),
        )
        .await;
        let file = match checked {
            Ok(Ok(Ok(file))) if file.inside => file,
            Ok(Ok(Ok(_))) => return self.note_file_link(label, url, "outside_project"),
            Ok(Ok(Err(refusal))) => return self.note_file_link(label, url, refusal.reason()),
            Ok(Err(_)) => return self.note_file_link(label, url, "file_check_failed"),
            Err(_) => return self.note_file_link(label, url, "file_check_timeout"),
        };
        match self.framing(label, url).await {
            Framing::NotFramed => {}
            Framing::Framed => {
                log::info!("[browser-agent] frame blocked tab={tab} reason=file_not_granted");
                return;
            }
            Framing::Unreadable => return self.note_file_link(label, url, "page_unreadable"),
        }
        let still_there = self
            .registry
            .lock()
            .get(label)
            .is_some_and(|record| record.url == from.as_str());
        if !still_there {
            log::info!("[browser-agent] file link dropped tab={tab} reason=page_changed");
            return;
        }
        // A revoke since the hop (Stop, profile change) took the source
        // page's grant with it.
        if self.gate.file_read_access(session_id, from).is_none() {
            log::info!("[browser-agent] file link dropped tab={tab} reason=source_not_granted");
            return;
        }
        if self.gate.keep_file_grant(token, session_id, &file).is_err() {
            log::info!("[browser-agent] file link dropped tab={tab} reason=stopped_by_user");
            return;
        }
        match self.load_page(label, file.url.to_string()) {
            Ok(()) => log::info!("[browser-agent] project file link followed tab={tab}"),
            Err(_) => log::warn!("[browser-agent] project file link could not load tab={tab}"),
        }
    }

    /// Whether a frame, object or embed of the tab's page points at `url`:
    /// the hop is that frame's, which keeps exact grants.
    async fn framing(&self, label: &str, url: &Url) -> Framing {
        let Some(key) = file_key(url) else {
            return Framing::Framed;
        };
        let read = tokio::time::timeout(
            budgets::EVAL_STEP,
            self.engine.evaluate(label, assets::frame_sources()),
        )
        .await;
        match read {
            Ok(Ok(Value::Array(sources))) => {
                let framed = sources
                    .iter()
                    .filter_map(Value::as_str)
                    .filter_map(|source| source.parse::<Url>().ok())
                    .any(|source| file_key(&source).as_deref() == Some(key.as_str()));
                if framed {
                    Framing::Framed
                } else {
                    Framing::NotFramed
                }
            }
            _ => Framing::Unreadable,
        }
    }

    /// Keep the target cancelled, log why, and tell the agent in the tab's
    /// next reply.
    fn note_file_link(&self, label: &str, url: &Url, reason: &'static str) {
        log::info!(
            "[browser-agent] file link not followed tab={} reason={reason}",
            label_prefix(label)
        );
        if let Some(record) = self.registry.lock().get_mut(label) {
            if record.file_links.len() >= MAX_NOTES {
                record.file_links.remove(0);
            }
            record.file_links.push(FileLinkNote::new(url, reason));
        }
    }
}

#[cfg(test)]
#[path = "link_hops_tests.rs"]
mod tests;
