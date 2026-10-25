//! The hook through which the global agent profile reaches the browser
//! engine. The engine owns the live global tabs and the profile data, so
//! the policy layer only forwards requests and reports the impact; without
//! an engine attached the requests are refused honestly.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};

use serde::Serialize;

/// What clearing the global profile closes: global-bound agent tabs, counted
/// as the sessions and projects that lose them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct ClearImpact {
    pub sessions: u32,
    pub projects: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileClearError {
    /// No engine is attached that can clear the profile.
    Unavailable,
    Failed,
}

pub type ProfileFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Engine side of the global agent profile.
pub trait AgentProfileControl: Send + Sync {
    fn clear_impact(&self) -> ClearImpact;
    /// Refuse new global binds, tear down every global-bound agent tab, wait
    /// for the engine to confirm close, wipe the profile, release.
    fn clear_global_profile(&self) -> ProfileFuture<'_, Result<(), ProfileClearError>>;
    /// Whether the engine can keep a global profile at all (macOS needs 14).
    fn global_profile_supported(&self) -> bool;
    /// A policy scope changed: narrowings take effect on live tabs now.
    fn policy_changed(&self);
}

/// The control used until a browser engine is attached.
pub struct UnwiredProfileControl;

impl AgentProfileControl for UnwiredProfileControl {
    fn clear_impact(&self) -> ClearImpact {
        ClearImpact::default()
    }

    fn clear_global_profile(&self) -> ProfileFuture<'_, Result<(), ProfileClearError>> {
        Box::pin(async { Err(ProfileClearError::Unavailable) })
    }

    fn global_profile_supported(&self) -> bool {
        false
    }

    fn policy_changed(&self) {}
}

/// A control attached after the policy service is built: the browser host
/// that implements it needs the service first. Acts unwired until then.
#[derive(Default)]
pub struct LateProfileControl(OnceLock<Arc<dyn AgentProfileControl>>);

impl LateProfileControl {
    pub fn attach(&self, control: Arc<dyn AgentProfileControl>) {
        if self.0.set(control).is_err() {
            log::warn!("[browser-policy] a profile control was already attached");
        }
    }

    fn get(&self) -> &dyn AgentProfileControl {
        self.0.get().map_or(&UnwiredProfileControl, |control| control.as_ref())
    }
}

impl AgentProfileControl for LateProfileControl {
    fn clear_impact(&self) -> ClearImpact {
        self.get().clear_impact()
    }

    fn clear_global_profile(&self) -> ProfileFuture<'_, Result<(), ProfileClearError>> {
        self.get().clear_global_profile()
    }

    fn global_profile_supported(&self) -> bool {
        self.get().global_profile_supported()
    }

    fn policy_changed(&self) {
        self.get().policy_changed();
    }
}
