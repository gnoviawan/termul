//! The engine-facing policy port, served straight from the policy service.

use crate::browser_automation::core::ports::{PolicyStore, PortFuture};

use super::model::{AppPolicy, AppPolicyOp, ProjectPolicy, ProjectPolicyOp};
use super::refusal::PolicyRefusal;
use super::service::BrowserPolicyService;

impl PolicyStore for BrowserPolicyService {
    fn project<'a>(
        &'a self,
        project_id: &'a str,
    ) -> PortFuture<'a, Result<ProjectPolicy, PolicyRefusal>> {
        Box::pin(self.project_policy(project_id))
    }

    fn app(&self) -> PortFuture<'_, Result<AppPolicy, PolicyRefusal>> {
        Box::pin(self.app_policy())
    }

    fn apply_project<'a>(
        &'a self,
        project_id: &'a str,
        expected_revision: u64,
        op: ProjectPolicyOp,
    ) -> PortFuture<'a, Result<ProjectPolicy, PolicyRefusal>> {
        Box::pin(self.apply_project_op(project_id, expected_revision, op))
    }

    fn apply_app(
        &self,
        expected_revision: u64,
        op: AppPolicyOp,
    ) -> PortFuture<'_, Result<AppPolicy, PolicyRefusal>> {
        Box::pin(self.apply_app_op(expected_revision, op))
    }
}
