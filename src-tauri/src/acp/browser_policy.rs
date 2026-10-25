//! Host-owned browser policy (per project and app-wide).
//!
//! Per project: an allow-list of origins, pre-approvals keyed by
//! `(action class, origin)`, and an opt-out to ephemeral browsing. App-wide:
//! the global agent profile switch, app-scoped pre-approvals and the request
//! to clear the global agent profile.
//!
//! Edits are operations with a revision compare-and-swap, so concurrent edits
//! from the desktop and a remote client never lose updates: a stale revision
//! is refused with its current value and the client retries on fresh state.
//! Both the Tauri commands and the web routes call [`BrowserPolicyService`].

#![allow(
    dead_code,
    unused_imports,
    reason = "the browser engine's authorization is the consumer of the policy lookups and typed re-exports"
)]

mod model;
mod origin;
mod port;
mod profile;
mod refusal;
mod service;
mod store;
#[cfg(test)]
pub(crate) mod test_support;
mod wire;

use std::sync::{Arc, OnceLock};

pub use model::{
    ActionClass, AppPolicy, AppPolicyOp, AppPreapproval, Preapproval, ProfileMode, ProjectPolicy,
    ProjectPolicyOp, ProjectPreapproval,
};
pub use origin::{CanonicalOrigin, OriginError, OriginPattern, OwnedPorts, ReservedKind};
pub use profile::{
    AgentProfileControl, ClearImpact, LateProfileControl, ProfileClearError, ProfileFuture,
    UnwiredProfileControl,
};
pub use refusal::{PolicyRefusal, WireCode};
pub use service::{BrowserPolicyService, CallerScope, EVENT_BROWSER_POLICY_CHANGED};
pub use wire::{AppPolicyView, PolicyChanged, PreapprovalView, ProjectPolicyView};

static INSTALLED: OnceLock<Arc<BrowserPolicyService>> = OnceLock::new();

/// Make the host's policy service reachable by the web router, which is
/// built after startup and has no other way to receive it. The first call
/// wins; a host that never installs one answers policy routes with
/// `capability_unavailable`.
pub fn install(service: Arc<BrowserPolicyService>) {
    if INSTALLED.set(service).is_err() {
        log::warn!("[browser-policy] a policy service was already installed");
    }
}

pub fn installed() -> Option<Arc<BrowserPolicyService>> {
    INSTALLED.get().cloned()
}
