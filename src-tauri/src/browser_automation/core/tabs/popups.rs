//! Owned popup tabs: what a page's `window.open` or `target=_blank`
//! becomes on an agent tab. The engine never opens the window it asked
//! for; the host may open the URL instead as a new agent tab of the same
//! session and profile, with no opener, that never becomes the session's
//! default tab on its own. A session holds at most [`MAX_OPEN_POPUPS`].

use serde::Serialize;
use tokio::sync::oneshot;

use super::{Lifecycle, OpenResult, Owner, PendingAgentTab, TabRegistry};
use crate::browser_automation::core::ports::TabProfile;

pub const MAX_OPEN_POPUPS: usize = 3;

/// A popup outcome the opener tab's next reply reports in `data.popups`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PopupNote {
    /// The popup is opening as this agent tab.
    Opened(String),
    /// The popup was refused, with the reason.
    Blocked(&'static str),
}

/// Why a popup gets no tab.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PopupRefusal {
    /// The session already holds [`MAX_OPEN_POPUPS`].
    Cap,
    /// The opener is gone, or is not an agent tab.
    NoOpener,
    SessionEnding,
    GlobalClearing,
}

impl PopupRefusal {
    pub fn reason(self) -> &'static str {
        match self {
            PopupRefusal::Cap => "popup_cap",
            PopupRefusal::NoOpener => "popup_opener_gone",
            PopupRefusal::SessionEnding => "session_ended",
            PopupRefusal::GlobalClearing => "agent_profile_clearing",
        }
    }
}

impl TabRegistry {
    /// Popups the session holds or is opening.
    pub fn open_popups(&self, session_id: &str) -> usize {
        let open = self
            .tabs
            .values()
            .filter(|r| r.popup_of.is_some() && r.life != Lifecycle::Closing)
            .filter(|r| r.session_id() == Some(session_id))
            .count();
        let opening = self
            .pending
            .values()
            .filter(|p| p.popup_of.is_some() && p.session_id == session_id)
            .count();
        open + opening
    }

    /// Register the popup `opener` asked for as agent tab `label`, on the
    /// opener's session and profile, for the renderer to mount.
    pub fn expect_popup_tab(
        &mut self,
        label: &str,
        opener: &str,
        url: &str,
    ) -> Result<oneshot::Receiver<OpenResult>, PopupRefusal> {
        let (session_id, profile) = match self.tabs.get(opener) {
            Some(record) if record.is_live() => match &record.owner {
                Owner::Agent {
                    session_id,
                    profile,
                } => (session_id.clone(), *profile),
                Owner::User => return Err(PopupRefusal::NoOpener),
            },
            _ => return Err(PopupRefusal::NoOpener),
        };
        if self.closing.contains(&session_id) {
            return Err(PopupRefusal::SessionEnding);
        }
        if profile == TabProfile::Global && self.global_clearing > 0 {
            return Err(PopupRefusal::GlobalClearing);
        }
        if self.open_popups(&session_id) >= MAX_OPEN_POPUPS {
            return Err(PopupRefusal::Cap);
        }
        let (tx, rx) = oneshot::channel();
        self.pending.insert(
            label.to_string(),
            PendingAgentTab {
                session_id,
                url: url.to_string(),
                profile,
                popup_of: Some(opener.to_string()),
                opened: tx,
            },
        );
        Ok(rx)
    }

    /// Every popup tab the session owns, for Stop to close.
    pub fn session_popups(&self, session_id: &str) -> Vec<String> {
        self.tabs
            .iter()
            .filter(|(_, r)| r.popup_of.is_some() && r.session_id() == Some(session_id))
            .map(|(label, _)| label.clone())
            .collect()
    }

    pub fn note_popup(&mut self, opener: &str, note: PopupNote) {
        if let Some(record) = self.tabs.get_mut(opener) {
            record.popups.push(note);
        }
    }
}

#[cfg(test)]
#[path = "popups_tests.rs"]
mod tests;
