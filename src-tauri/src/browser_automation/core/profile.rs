//! Which agent profile a session's tabs run in, and the operations that
//! change it.
//!
//! A session binds its profile at its first agent tab and keeps it for
//! every tab it opens while one is open. The requested profile is global
//! when the app switch is on, the project has not opted out and the engine
//! can keep a global profile; otherwise ephemeral. Narrowing edits take
//! effect at once: the global tabs of every session that no longer
//! qualifies close and lose their origin grants, and its next tab binds
//! ephemeral. Clearing the global profile closes every global tab, waits
//! until the engine released them all, then has the engine wipe the profile.

use std::collections::BTreeSet;
use std::sync::{Arc, Weak};
use std::time::Duration;

use super::dispatch::Verb;
use super::ports::TabProfile;
use super::teardown::session_dir;
use super::DesktopBrowserHost;
use crate::acp::browser_policy::{
    AgentProfileControl, ClearImpact, ProfileClearError, ProfileFuture, ProfileMode,
};
use crate::browser_automation::engine::profile::DataStore;
use crate::browser_automation::engine::Support;
use crate::browser_automation::BrowserCall;

/// The ephemeral profile's directory inside the session's directory, which
/// teardown deletes after the session's webviews closed.
pub(super) const EPHEMERAL_PROFILE_DIR: &str = "profile";

/// How long clearing waits for the engine to release every global tab.
const CLEAR_DRAIN: Duration = Duration::from_secs(20);
const CLEAR_POLL: Duration = Duration::from_millis(50);

/// The profile a session's next tab gets: what is requested now, but never
/// wider than the tabs the session already runs.
pub(super) fn bind(existing: Option<TabProfile>, requested: TabProfile) -> TabProfile {
    existing.map_or(requested, |existing| existing.min(requested))
}

impl DesktopBrowserHost {
    /// The profile the session's project asks for and the engine can give.
    /// An unreadable policy asks for the narrower profile.
    pub(super) async fn requested_profile(&self, session_id: &str) -> TabProfile {
        let project_id = (self.project_of)(session_id);
        let app = self.policy.app().await;
        let project = self.policy.project(&project_id).await;
        match (app, project) {
            (Ok(app), Ok(project)) => {
                let keeps_global = self.surface.persistent_profile() == Support::Trusted;
                match project
                    .profile_mode
                    .effective(app.global_profile_enabled, keeps_global)
                {
                    ProfileMode::Global => TabProfile::Global,
                    ProfileMode::Ephemeral => TabProfile::Ephemeral,
                }
            }
            (Err(error), _) | (_, Err(error)) => {
                log::warn!(
                    "[browser-agent] policy read failed reason={}; agent tabs run ephemeral",
                    error.reason()
                );
                TabProfile::Ephemeral
            }
        }
    }

    /// The profile a call runs under: its tab's, or the one its new tab
    /// would bind.
    pub(super) async fn call_profile(
        &self,
        session_id: &str,
        verb: Verb,
        call: &BrowserCall,
    ) -> TabProfile {
        if verb != Verb::NewTab {
            if let Ok(label) = self.resolve_tab(session_id, &call.args) {
                if let Some(profile) = self.registry.lock().get(&label).and_then(|r| r.profile()) {
                    return profile;
                }
            }
        }
        let requested = self.requested_profile(session_id).await;
        bind(self.registry.lock().session_profile(session_id), requested)
    }

    /// Where `label`'s webview keeps its data.
    pub(super) fn data_store(&self, label: &str) -> Result<DataStore, String> {
        let owner = self
            .registry
            .lock()
            .get(label)
            .and_then(|r| Some((r.session_id()?.to_string(), r.profile()?)));
        match owner {
            None => Ok(DataStore::App),
            Some((_, TabProfile::Global)) => Ok(DataStore::Global),
            Some((session_id, TabProfile::Ephemeral)) => {
                let root = self.surface.session_data_root()?;
                Ok(DataStore::Ephemeral {
                    dir: session_dir(&root, &session_id).join(EPHEMERAL_PROFILE_DIR),
                })
            }
        }
    }

    /// Close every global tab of the sessions whose project no longer
    /// qualifies for the global profile, and revoke those sessions' origin
    /// grants and pending consent tickets.
    pub(super) async fn reconcile_profiles(&self) {
        let sessions: BTreeSet<String> = self
            .registry
            .lock()
            .global_tabs()
            .into_iter()
            .map(|(_, session)| session)
            .collect();
        for session_id in sessions {
            if self.requested_profile(&session_id).await == TabProfile::Ephemeral {
                log::info!(
                    "[browser-agent] session {} leaves the global profile",
                    crate::logging::redact_session_id(&session_id)
                );
                self.close_global_tabs(|session| session == session_id)
                    .await;
                self.gate.revoke_access(&session_id);
            }
        }
    }

    async fn close_global_tabs(&self, of_session: impl Fn(&str) -> bool) {
        let tabs = self.registry.lock().global_tabs();
        for (label, session_id) in tabs.iter().filter(|(_, s)| of_session(s)) {
            self.close_agent_tab(label, session_id).await;
        }
    }

    pub(super) async fn clear_global_profile(&self) -> Result<(), ProfileClearError> {
        self.registry.lock().set_global_clearing(true);
        let result = self.drain_and_wipe().await;
        self.registry.lock().set_global_clearing(false);
        result
    }

    async fn drain_and_wipe(&self) -> Result<(), ProfileClearError> {
        self.close_global_tabs(|_| true).await;
        let drained = tokio::time::timeout(CLEAR_DRAIN, async {
            while self.registry.lock().global_lease() > 0 {
                tokio::time::sleep(CLEAR_POLL).await;
            }
        })
        .await;
        if drained.is_err() {
            log::error!("[browser-agent] clear refused: global agent tabs did not close");
            return Err(ProfileClearError::Failed);
        }
        self.surface.wipe_global_profile().await.map_err(|error| {
            log::error!("[browser-agent] global agent profile wipe failed: {error}");
            ProfileClearError::Failed
        })
    }

    fn clear_impact(&self) -> ClearImpact {
        let sessions: BTreeSet<String> = self
            .registry
            .lock()
            .global_tabs()
            .into_iter()
            .map(|(_, session)| session)
            .collect();
        let projects: BTreeSet<String> = sessions.iter().map(|s| (self.project_of)(s)).collect();
        ClearImpact {
            sessions: sessions.len() as u32,
            projects: projects.len() as u32,
        }
    }

    /// The hook the policy service drives the global profile through.
    pub fn profile_control(self: &Arc<Self>) -> Arc<dyn AgentProfileControl> {
        Arc::new(HostProfileControl(Arc::downgrade(self)))
    }
}

struct HostProfileControl(Weak<DesktopBrowserHost>);

impl AgentProfileControl for HostProfileControl {
    fn clear_impact(&self) -> ClearImpact {
        self.0
            .upgrade()
            .map(|host| host.clear_impact())
            .unwrap_or_default()
    }

    fn clear_global_profile(&self) -> ProfileFuture<'_, Result<(), ProfileClearError>> {
        let host = self.0.upgrade();
        Box::pin(async move {
            match host {
                Some(host) => host.clear_global_profile().await,
                None => Err(ProfileClearError::Unavailable),
            }
        })
    }

    fn global_profile_supported(&self) -> bool {
        self.0
            .upgrade()
            .is_some_and(|host| host.surface.persistent_profile() == Support::Trusted)
    }

    fn policy_changed(&self) {
        if let Some(host) = self.0.upgrade() {
            super::spawn(async move { host.reconcile_profiles().await });
        }
    }
}

#[cfg(test)]
#[path = "profile_tests.rs"]
mod tests;
