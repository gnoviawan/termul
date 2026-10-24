//! The engine-to-core half of the port: one ordered event stream per tab,
//! and the navigation policy the core hands each tab at construction.
//!
//! Adapters publish [`TabEvent`]s into a [`TabEvents`] channel and never
//! call the core directly. Navigation hooks are synchronous on every
//! engine termul uses through tauri, so the per-hop verdict comes from the
//! [`NavPolicy`] the core provisions when the tab is built. It is the only
//! decision a tab's navigation gets, and it is reported with the
//! `NavStarting` event it applied to.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tauri::Url;
use tokio::sync::mpsc::UnboundedSender;

use super::observe::{ConsoleEntry, NetworkEntry};

/// How a main-frame commit changed the page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommitKind {
    /// A new document replaced the old one.
    NewDocument,
    /// The URL changed inside the same document (`pushState`, fragment,
    /// same-document history step).
    #[cfg_attr(
        all(target_os = "macos", not(test)),
        allow(dead_code, reason = "WKWebView reports no same-document changes yet")
    )]
    SameDocument,
}

/// Which policy a tab's hooks serve. Only agent tabs get their script
/// dialogs and popups intercepted; user tabs keep the engine's defaults.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TabRole {
    User,
    Agent,
}

/// The kind of a page script dialog.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DialogKind {
    Alert,
    Confirm,
    Prompt,
    BeforeUnload,
}

impl DialogKind {
    pub fn as_str(self) -> &'static str {
        match self {
            DialogKind::Alert => "alert",
            DialogKind::Confirm => "confirm",
            DialogKind::Prompt => "prompt",
            DialogKind::BeforeUnload => "beforeunload",
        }
    }
}

/// How the core answers a held dialog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DialogAnswer {
    /// OK, with the text a prompt returns.
    Accept { text: Option<String> },
    /// Cancel: `confirm` returns false, `prompt` null, a navigation stays.
    Dismiss,
}

/// A per-hop navigation verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavVerdict {
    Allow,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TabEvent {
    /// A main-frame navigation hop is about to start (first hop or
    /// redirect). `verdict` is what the hook applied.
    NavStarting {
        nav_id: u64,
        url: String,
        verdict: NavVerdict,
    },
    /// The main frame committed. A same-document commit carries no
    /// `nav_id`: engines raise no start hop for it.
    NavCommitted {
        nav_id: Option<u64>,
        kind: CommitKind,
        url: String,
    },
    /// The document finished loading.
    LoadFinished,
    /// The page opened a script dialog; the adapter holds it until the
    /// core answers `id` (`BrowserEngine::answer_dialog`). `message` and
    /// `default_text` are page text.
    DialogOpened {
        id: u64,
        kind: DialogKind,
        message: String,
        default_text: Option<String>,
    },
    /// The page asked for a new window. The engine refused it; the core
    /// decides whether `url` opens as an owned popup tab.
    NewWindowRequested {
        url: String,
    },
    /// The engine refused to hand a URL to another application.
    ExternalProtocolBlocked,
    TitleChanged {
        title: String,
    },
    /// The page logged a console message (page-derived).
    Console(ConsoleEntry),
    /// A request the page made completed or failed (page-derived).
    Network(NetworkEntry),
    /// The engine destroyed the webview.
    Closed,
}

/// The core's per-hop navigation and download decisions, consulted
/// synchronously on the UI thread. Implementations must not block.
pub trait NavPolicy: Send + Sync {
    fn decide(&self, tab: &str, url: &Url) -> NavVerdict;
    /// Whether the tab's downloads go through [`NavPolicy::download_starting`].
    /// Tabs that answer false keep the engine's own download handling.
    fn holds_downloads(&self, _tab: &str) -> bool {
        false
    }
    /// Where a download the tab starts may be written, or `None` to cancel
    /// it. `suggested` is the engine's own choice of path.
    fn download_starting(&self, _tab: &str, _url: &Url, _suggested: &Path) -> Option<PathBuf> {
        None
    }
    /// A download the tab holds has, or announced it will have, `bytes`.
    /// False cancels it: engines that report progress call this while the
    /// bytes stream, and once with the announced length before any land.
    fn download_progress(&self, _tab: &str, _url: &Url, _bytes: u64) -> bool {
        true
    }
    fn download_finished(&self, _tab: &str, _url: &Url, _success: bool) {}
}

/// What the core gives an adapter for one tab: its label, the event
/// channel, and the policy its navigation hook applies.
#[derive(Clone)]
pub struct TabEvents {
    label: Arc<str>,
    tx: UnboundedSender<(String, TabEvent)>,
    policy: Arc<dyn NavPolicy>,
    /// Hook-assigned navigation ids. Engines reached through tauri hooks
    /// expose none, so ids are minted in hook order: a commit belongs to
    /// the latest hop that started before it.
    last_nav: Arc<AtomicU64>,
    last_dialog: Arc<AtomicU64>,
    role: TabRole,
}

impl TabEvents {
    pub fn new(
        label: &str,
        tx: UnboundedSender<(String, TabEvent)>,
        policy: Arc<dyn NavPolicy>,
    ) -> Self {
        Self {
            label: Arc::from(label),
            tx,
            policy,
            last_nav: Arc::new(AtomicU64::new(0)),
            last_dialog: Arc::new(AtomicU64::new(0)),
            role: TabRole::User,
        }
    }

    #[must_use]
    pub fn with_role(mut self, role: TabRole) -> Self {
        self.role = role;
        self
    }

    pub fn role(&self) -> TabRole {
        self.role
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    /// Publish a dialog the adapter now holds, under a fresh id.
    pub fn dialog_opened(&self, kind: DialogKind, message: String, default_text: Option<String>) -> u64 {
        let id = self.last_dialog.fetch_add(1, Ordering::AcqRel) + 1;
        self.publish(TabEvent::DialogOpened {
            id,
            kind,
            message,
            default_text,
        });
        id
    }

    /// Run the policy for a starting hop and publish it. Returns whether
    /// the hop may proceed.
    pub fn nav_starting(&self, url: &Url) -> bool {
        let verdict = self.policy.decide(&self.label, url);
        let nav_id = self.last_nav.fetch_add(1, Ordering::AcqRel) + 1;
        self.publish(TabEvent::NavStarting {
            nav_id,
            url: url.to_string(),
            verdict,
        });
        verdict == NavVerdict::Allow
    }

    /// A new-document commit, attributed to the latest started hop.
    pub fn committed(&self, url: &str) {
        let latest = self.last_nav.load(Ordering::Acquire);
        self.publish(TabEvent::NavCommitted {
            nav_id: (latest > 0).then_some(latest),
            kind: CommitKind::NewDocument,
            url: url.to_string(),
        });
    }

    #[cfg_attr(
        all(target_os = "macos", not(test)),
        allow(dead_code, reason = "WKWebView reports no same-document changes yet")
    )]
    pub fn same_document(&self, url: &str) {
        self.publish(TabEvent::NavCommitted {
            nav_id: None,
            kind: CommitKind::SameDocument,
            url: url.to_string(),
        });
    }

    pub fn holds_downloads(&self) -> bool {
        self.policy.holds_downloads(&self.label)
    }

    pub fn download_starting(&self, url: &Url, suggested: &Path) -> Option<PathBuf> {
        self.policy.download_starting(&self.label, url, suggested)
    }

    #[cfg_attr(target_os = "macos", allow(dead_code, reason = "tauri's WKWebView hook reports no download progress"))]
    pub fn download_progress(&self, url: &Url, bytes: u64) -> bool {
        self.policy.download_progress(&self.label, url, bytes)
    }

    pub fn download_finished(&self, url: &Url, success: bool) {
        self.policy.download_finished(&self.label, url, success);
    }

    pub fn publish(&self, event: TabEvent) {
        // The receiver is gone only when the host is shutting down.
        let _ = self.tx.send((self.label.to_string(), event));
    }
}

#[cfg(test)]
#[path = "events_tests.rs"]
mod tests;
