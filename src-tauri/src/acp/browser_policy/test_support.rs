//! Shared fixtures for the policy tests: a service over a temp directory,
//! a recording event sink and a scriptable profile control.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;

use crate::web::sink::AcpEvent;
use crate::web::EventSink;

use super::profile::{
    AgentProfileControl, ClearImpact, ProfileClearError, ProfileFuture, UnwiredProfileControl,
};
use super::service::BrowserPolicyService;

#[derive(Default)]
pub(crate) struct RecordingSink {
    seen: Mutex<Vec<AcpEvent>>,
}

impl EventSink for RecordingSink {
    fn emit(&self, event: &AcpEvent) {
        self.seen.lock().push(event.clone());
    }
}

impl RecordingSink {
    pub(crate) fn payloads_of(&self, type_: &str) -> Vec<serde_json::Value> {
        self.seen
            .lock()
            .iter()
            .filter(|event| event.type_ == type_)
            .map(|event| event.payload.clone())
            .collect()
    }
}

pub(crate) struct ScriptedProfile {
    pub(crate) cleared: AtomicBool,
    pub(crate) outcome: Result<(), ProfileClearError>,
}

impl ScriptedProfile {
    pub(crate) fn succeeding() -> Arc<Self> {
        Arc::new(Self {
            cleared: AtomicBool::new(false),
            outcome: Ok(()),
        })
    }

    pub(crate) fn failing() -> Arc<Self> {
        Arc::new(Self {
            cleared: AtomicBool::new(false),
            outcome: Err(ProfileClearError::Failed),
        })
    }
}

impl AgentProfileControl for ScriptedProfile {
    fn clear_impact(&self) -> ClearImpact {
        ClearImpact {
            sessions: 2,
            projects: 1,
        }
    }

    fn clear_global_profile(&self) -> ProfileFuture<'_, Result<(), ProfileClearError>> {
        self.cleared.store(true, Ordering::SeqCst);
        let outcome = self.outcome;
        Box::pin(async move { outcome })
    }

    fn global_profile_supported(&self) -> bool {
        true
    }

    fn policy_changed(&self) {}
}

pub(crate) struct Fixture {
    pub(crate) service: Arc<BrowserPolicyService>,
    pub(crate) sink: Arc<RecordingSink>,
}

pub(crate) fn fixture(root: &Path, owned_ports: Vec<u16>) -> Fixture {
    fixture_with_profile(root, owned_ports, Arc::new(UnwiredProfileControl))
}

pub(crate) fn fixture_with_profile(
    root: &Path,
    owned_ports: Vec<u16>,
    profile: Arc<dyn AgentProfileControl>,
) -> Fixture {
    let sink = Arc::new(RecordingSink::default());
    let service = Arc::new(BrowserPolicyService::new(
        root.to_path_buf(),
        Arc::new(move || owned_ports.clone()),
        vec![sink.clone()],
        profile,
    ));
    Fixture { service, sink }
}
