//! One tab's script-dialog state: the dialog the page is blocked on, and
//! the last dialog the host closed on its own that no reply has reported.
//!
//! Policy: an agent tab's `alert` is accepted at once, and so is a
//! `beforeunload` raised by a navigation the agent asked for. Every other
//! dialog holds the tab until the agent answers it or the answer budget
//! runs out, which dismisses it. One dialog at a time: a page cannot open
//! a second while the first blocks it, so a second is dismissed.

use serde::Serialize;
use tokio::sync::watch;

use super::reply::cap_page_text;
use crate::browser_automation::engine::events::DialogKind;

/// Where a dialog stands, as the agent reads it in `page.dialog`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DialogState {
    Open,
    Accepted,
    Dismissed,
}

/// `page.dialog`: page text (`message`, `default_text`) plus host facts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DialogView {
    pub kind: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_text: Option<String>,
    pub state: DialogState,
}

/// What the host does with a dialog the engine holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Disposition {
    Accept,
    Dismiss,
    /// Block the tab until the agent answers.
    Hold,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenDialog {
    pub id: u64,
    pub kind: DialogKind,
    pub view: DialogView,
}

pub struct TabDialogs {
    open: Option<OpenDialog>,
    unreported: Option<DialogView>,
    /// Bumped whenever a dialog starts holding the tab.
    held: watch::Sender<u64>,
}

impl Default for TabDialogs {
    fn default() -> Self {
        Self {
            open: None,
            unreported: None,
            held: watch::Sender::new(0),
        }
    }
}

impl TabDialogs {
    /// Decide a dialog the engine just opened. `agent_navigating` is true
    /// while a navigation the agent asked for is in flight on the tab.
    pub fn opened(
        &mut self,
        id: u64,
        kind: DialogKind,
        message: &str,
        default_text: Option<&str>,
        agent_navigating: bool,
    ) -> Disposition {
        let view = |state| DialogView {
            kind: kind.as_str(),
            message: cap_page_text(message),
            default_text: default_text.map(cap_page_text),
            state,
        };
        let disposition = match kind {
            _ if self.open.is_some() => Disposition::Dismiss,
            DialogKind::Alert => Disposition::Accept,
            DialogKind::BeforeUnload if agent_navigating => Disposition::Accept,
            _ => Disposition::Hold,
        };
        match disposition {
            Disposition::Hold => {
                self.open = Some(OpenDialog {
                    id,
                    kind,
                    view: view(DialogState::Open),
                });
                self.held.send_modify(|n| *n += 1);
            }
            Disposition::Accept => self.unreported = Some(view(DialogState::Accepted)),
            Disposition::Dismiss => self.unreported = Some(view(DialogState::Dismissed)),
        }
        disposition
    }

    /// The dialog blocking the tab, if any.
    pub fn open(&self) -> Option<&OpenDialog> {
        self.open.as_ref()
    }

    /// The agent answered `id`: the tab is unblocked. Returns the closed
    /// dialog, or None when `id` no longer blocks the tab.
    pub fn answered(&mut self, id: u64, accepted: bool) -> Option<DialogView> {
        if self.open.as_ref().is_none_or(|d| d.id != id) {
            return None;
        }
        let mut view = self.open.take()?.view;
        view.state = if accepted {
            DialogState::Accepted
        } else {
            DialogState::Dismissed
        };
        Some(view)
    }

    /// The answer budget for `id` ran out: dismiss it, and report it on
    /// the tab's next reply. False when it was already answered.
    pub fn expired(&mut self, id: u64) -> bool {
        match self.answered(id, false) {
            Some(view) => {
                self.unreported = Some(view);
                true
            }
            None => false,
        }
    }

    /// What the next reply on this tab reports: the blocking dialog, else
    /// the last one the host closed on its own (once).
    pub fn report(&mut self) -> Option<DialogView> {
        match &self.open {
            Some(open) => Some(open.view.clone()),
            None => self.unreported.take(),
        }
    }

    pub fn watch(&self) -> watch::Receiver<u64> {
        self.held.subscribe()
    }
}

#[cfg(test)]
#[path = "dialogs_tests.rs"]
mod tests;
