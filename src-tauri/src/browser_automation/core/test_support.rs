//! In-memory fakes of the host ports for core tests.

use std::collections::{HashMap, VecDeque};
use std::time::Duration;

use parking_lot::Mutex;

use super::ports::{
    AppPolicy, AppPolicyOp, PermissionRequest, PolicyRefusal, PolicyStore, PortFuture,
    ProjectPolicy, ProjectPolicyOp, TicketOutcome, TicketRequest,
};

/// Answers tickets from a script, recording every request. An empty
/// script answers `Unattended`, the safe default.
#[derive(Default)]
pub struct ScriptedPermissions {
    outcomes: Mutex<VecDeque<TicketOutcome>>,
    pub requests: Mutex<Vec<(TicketRequest, Duration)>>,
    pub cancelled_sessions: Mutex<Vec<String>>,
}

impl ScriptedPermissions {
    pub fn answering(outcomes: impl IntoIterator<Item = TicketOutcome>) -> Self {
        Self {
            outcomes: Mutex::new(outcomes.into_iter().collect()),
            ..Self::default()
        }
    }
}

impl PermissionRequest for ScriptedPermissions {
    fn request(&self, ticket: TicketRequest, wait: Duration) -> PortFuture<'_, TicketOutcome> {
        self.requests.lock().push((ticket, wait));
        let outcome = self
            .outcomes
            .lock()
            .pop_front()
            .unwrap_or(TicketOutcome::Unattended);
        Box::pin(async move { outcome })
    }

    fn cancel_session(&self, session_id: &str) {
        self.cancelled_sessions.lock().push(session_id.to_string());
    }
}

/// Policy store with the real revision compare-and-swap, held in memory.
#[derive(Default)]
pub struct InMemoryPolicyStore {
    projects: Mutex<HashMap<String, ProjectPolicy>>,
    app: Mutex<AppPolicy>,
}

fn stale(current: u64, expected: u64) -> Result<(), PolicyRefusal> {
    if current == expected {
        Ok(())
    } else {
        Err(PolicyRefusal::RevisionConflict { current })
    }
}

impl PolicyStore for InMemoryPolicyStore {
    fn project<'a>(&'a self, project_id: &'a str) -> PortFuture<'a, Result<ProjectPolicy, PolicyRefusal>> {
        let policy = self.projects.lock().get(project_id).cloned().unwrap_or_default();
        Box::pin(async move { Ok(policy) })
    }

    fn app(&self) -> PortFuture<'_, Result<AppPolicy, PolicyRefusal>> {
        let policy = self.app.lock().clone();
        Box::pin(async move { Ok(policy) })
    }

    fn apply_project<'a>(
        &'a self,
        project_id: &'a str,
        expected_revision: u64,
        op: ProjectPolicyOp,
    ) -> PortFuture<'a, Result<ProjectPolicy, PolicyRefusal>> {
        let mut projects = self.projects.lock();
        let mut policy = projects.get(project_id).cloned().unwrap_or_default();
        let result = stale(policy.revision, expected_revision)
            .and_then(|()| policy.apply(op))
            .map(|changed| {
                if changed {
                    policy.revision += 1;
                    projects.insert(project_id.to_string(), policy.clone());
                }
                policy
            });
        Box::pin(async move { result })
    }

    fn apply_app(
        &self,
        expected_revision: u64,
        op: AppPolicyOp,
    ) -> PortFuture<'_, Result<AppPolicy, PolicyRefusal>> {
        let mut app = self.app.lock();
        let mut policy = app.clone();
        let result = stale(policy.revision, expected_revision)
            .and_then(|()| policy.apply(op))
            .map(|changed| {
                if changed {
                    policy.revision += 1;
                    *app = policy.clone();
                }
                policy
            });
        Box::pin(async move { result })
    }
}
