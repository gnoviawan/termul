//! The browser policy service: caller scope rules, operation dispatch over
//! the file store, change events and the clear-profile hook. Every
//! transport (Tauri command, web route) calls this and nothing else.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;

use crate::web::{fan_out, EventSink};

use super::model::{validate_project_id, AppPolicy, AppPolicyOp, ProjectPolicy, ProjectPolicyOp};
use super::origin::OwnedPorts;
use super::profile::{AgentProfileControl, ProfileClearError};
use super::refusal::PolicyRefusal;
use super::store::PolicyFiles;
use super::wire::{
    parse_app_op, parse_project_op, AppOperation, AppPolicyView, PolicyChanged, ProjectPolicyView,
};

/// Event type fanned to every sink when a policy scope changes. The relay
/// strips the `acp:` prefix on the wire.
pub const EVENT_BROWSER_POLICY_CHANGED: &str = "acp:browser_policy_changed";

/// What a caller may touch. The desktop `main` webview and a remote client
/// holding the host token have app scope; a client bound to one project
/// holds only that project.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallerScope {
    App,
    Project(String),
}

impl CallerScope {
    fn require_app(&self) -> Result<(), PolicyRefusal> {
        match self {
            Self::App => Ok(()),
            Self::Project(_) => Err(PolicyRefusal::AppScopeRequired),
        }
    }

    fn require_project(&self, project_id: &str) -> Result<(), PolicyRefusal> {
        match self {
            Self::App => Ok(()),
            Self::Project(bound) if bound == project_id => Ok(()),
            Self::Project(_) => Err(PolicyRefusal::ProjectScopeMismatch),
        }
    }
}

/// Boundary log for a refused request: the operation and the reason slug,
/// never the origins or values the client sent.
fn audited<T>(operation: &str, result: Result<T, PolicyRefusal>) -> Result<T, PolicyRefusal> {
    if let Err(refusal) = &result {
        match refusal {
            PolicyRefusal::RevisionConflict { .. } => {
                log::debug!("[browser-policy] {operation} lost a revision race")
            }
            _ => log::warn!(
                "[browser-policy] {operation} refused: code={} reason={}",
                refusal.code().as_str(),
                refusal.reason()
            ),
        }
    }
    result
}

pub struct BrowserPolicyService {
    files: PolicyFiles,
    owned_ports: OwnedPorts,
    sinks: Vec<Arc<dyn EventSink>>,
    profile: Arc<dyn AgentProfileControl>,
}

impl BrowserPolicyService {
    pub fn new(
        root: PathBuf,
        owned_ports: OwnedPorts,
        sinks: Vec<Arc<dyn EventSink>>,
        profile: Arc<dyn AgentProfileControl>,
    ) -> Self {
        Self {
            files: PolicyFiles::new(root),
            owned_ports,
            sinks,
            profile,
        }
    }

    pub async fn project_view(
        &self,
        caller: &CallerScope,
        project_id: &str,
    ) -> Result<ProjectPolicyView, PolicyRefusal> {
        let result = async {
            validate_project_id(project_id)?;
            caller.require_project(project_id)?;
            let policy = self.files.read_project(project_id).await?;
            Ok(self.project_view_of(project_id, &policy).await)
        }
        .await;
        audited("read project policy", result)
    }

    pub async fn app_view(&self, caller: &CallerScope) -> Result<AppPolicyView, PolicyRefusal> {
        let result = async {
            caller.require_app()?;
            let policy = self.files.read_app().await?;
            Ok(self.app_view_of(&policy))
        }
        .await;
        audited("read app policy", result)
    }

    pub async fn apply_project(
        &self,
        caller: &CallerScope,
        project_id: &str,
        expected_revision: u64,
        op: &Value,
    ) -> Result<ProjectPolicyView, PolicyRefusal> {
        let result = async {
            validate_project_id(project_id)?;
            caller.require_project(project_id)?;
            let op = parse_project_op(op, &(self.owned_ports)())?;
            let policy = self
                .apply_project_op(project_id, expected_revision, op)
                .await?;
            Ok(self.project_view_of(project_id, &policy).await)
        }
        .await;
        audited("edit project policy", result)
    }

    pub async fn apply_app(
        &self,
        caller: &CallerScope,
        expected_revision: u64,
        op: &Value,
    ) -> Result<AppPolicyView, PolicyRefusal> {
        let result = async {
            caller.require_app()?;
            let operation = parse_app_op(op, &(self.owned_ports)())?;
            let policy = match operation {
                AppOperation::Edit(op) => self.apply_app_op(expected_revision, op).await?,
                AppOperation::ClearGlobalProfile => self.clear_global_profile().await?,
            };
            Ok(self.app_view_of(&policy))
        }
        .await;
        audited("edit app policy", result)
    }

    async fn project_view_of(&self, project_id: &str, policy: &ProjectPolicy) -> ProjectPolicyView {
        // An unreadable app policy leaves agents ephemeral, as the engine does.
        let global_enabled = self
            .app_policy()
            .await
            .is_ok_and(|app| app.global_profile_enabled);
        let effective = policy
            .profile_mode
            .effective(global_enabled, self.profile.global_profile_supported());
        ProjectPolicyView::new(project_id, policy, effective)
    }

    fn app_view_of(&self, policy: &AppPolicy) -> AppPolicyView {
        AppPolicyView::new(
            policy,
            self.profile.clear_impact(),
            self.profile.global_profile_supported(),
        )
    }

    /// Current project policy, for the engine's authorization checks. It
    /// leaves out entries for origins that are reserved at this moment.
    pub async fn project_policy(&self, project_id: &str) -> Result<ProjectPolicy, PolicyRefusal> {
        let policy = self.files.read_project(project_id).await?;
        Ok(policy.without_reserved(&(self.owned_ports)()))
    }

    /// Current app policy, for the engine's authorization checks. It
    /// leaves out entries for origins that are reserved at this moment.
    pub async fn app_policy(&self) -> Result<AppPolicy, PolicyRefusal> {
        let policy = self.files.read_app().await?;
        Ok(policy.without_reserved(&(self.owned_ports)()))
    }

    pub async fn apply_project_op(
        &self,
        project_id: &str,
        expected_revision: u64,
        op: ProjectPolicyOp,
    ) -> Result<ProjectPolicy, PolicyRefusal> {
        let (policy, changed) = self
            .files
            .edit_project(project_id, expected_revision, |p| p.apply(op))
            .await?;
        if changed {
            log::info!(
                "[browser-policy] project policy changed (revision {})",
                policy.revision
            );
            self.announce(PolicyChanged {
                scope: "project",
                project_id: Some(project_id.to_string()),
                revision: policy.revision,
            });
        }
        Ok(policy)
    }

    pub async fn apply_app_op(
        &self,
        expected_revision: u64,
        op: AppPolicyOp,
    ) -> Result<AppPolicy, PolicyRefusal> {
        let (policy, changed) = self
            .files
            .edit_app(expected_revision, |p| p.apply(op))
            .await?;
        if changed {
            log::info!(
                "[browser-policy] app policy changed (revision {})",
                policy.revision
            );
            self.announce(PolicyChanged {
                scope: "app",
                project_id: None,
                revision: policy.revision,
            });
        }
        Ok(policy)
    }

    /// Forward a clear request to the engine hook. The policy file is not
    /// edited, so no revision is involved.
    async fn clear_global_profile(&self) -> Result<AppPolicy, PolicyRefusal> {
        let policy = self.app_policy().await?;
        match self.profile.clear_global_profile().await {
            Ok(()) => {
                log::info!("[browser-policy] global agent profile cleared");
                self.announce(PolicyChanged {
                    scope: "app",
                    project_id: None,
                    revision: policy.revision,
                });
                Ok(policy)
            }
            Err(ProfileClearError::Unavailable) => {
                log::warn!("[browser-policy] clear refused: no engine can clear the profile");
                Err(PolicyRefusal::ProfileEngineUnavailable)
            }
            Err(ProfileClearError::Failed) => {
                log::error!("[browser-policy] clearing the global agent profile failed");
                Err(PolicyRefusal::ProfileClearFailed)
            }
        }
    }

    fn announce(&self, change: PolicyChanged) {
        fan_out(&self.sinks, None, EVENT_BROWSER_POLICY_CHANGED, &change);
        self.profile.policy_changed();
    }
}

#[cfg(test)]
#[path = "service_tests.rs"]
mod tests;
