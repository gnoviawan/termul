//! The JSON a client sees: operation parsing and the policy views. Command
//! and route both build their reply from these, so a given operation
//! sequence produces identical bodies on either transport.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::model::{
    preapproval_origin, ActionClass, AppPolicy, AppPolicyOp, AppPreapproval, Preapproval,
    ProfileMode, ProjectPolicy, ProjectPolicyOp, ProjectPreapproval,
};
use super::origin::{CanonicalOrigin, OriginPattern};
use super::profile::ClearImpact;
use super::refusal::PolicyRefusal;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum ProjectOpWire {
    AddOrigin { origin: String },
    RemoveOrigin { origin: String },
    AddPreapproval { action: ActionClass, origin: String },
    RemovePreapproval { action: ActionClass, origin: String },
    SetEphemeral { ephemeral: bool },
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum AppOpWire {
    SetGlobalProfile { enabled: bool },
    SetAskBeforePasswordSubmit { enabled: bool },
    AddPreapproval { action: ActionClass, origin: String },
    RemovePreapproval { action: ActionClass, origin: String },
    ClearGlobalProfile,
}

/// An app-level operation: a policy edit, or the profile wipe request that
/// does not touch the policy file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppOperation {
    Edit(AppPolicyOp),
    ClearGlobalProfile,
}

fn malformed<E>(_: E) -> PolicyRefusal {
    PolicyRefusal::MalformedOperation
}

/// Parse a project operation. Operations that add an origin are checked
/// against `owned_ports`; removals only need valid syntax.
pub fn parse_project_op(
    value: &Value,
    owned_ports: &[u16],
) -> Result<ProjectPolicyOp, PolicyRefusal> {
    Ok(
        match serde_json::from_value::<ProjectOpWire>(value.clone()).map_err(malformed)? {
            ProjectOpWire::AddOrigin { origin } => {
                ProjectPolicyOp::AddOrigin(OriginPattern::parse_allowed(&origin, owned_ports)?)
            }
            ProjectOpWire::RemoveOrigin { origin } => {
                ProjectPolicyOp::RemoveOrigin(OriginPattern::parse(&origin)?)
            }
            ProjectOpWire::AddPreapproval { action, origin } => ProjectPolicyOp::AddPreapproval(
                ProjectPreapproval::new(action, preapproval_origin(&origin, owned_ports)?)?,
            ),
            ProjectOpWire::RemovePreapproval { action, origin } => {
                ProjectPolicyOp::RemovePreapproval(Preapproval {
                    action,
                    origin: CanonicalOrigin::parse(&origin)?,
                })
            }
            ProjectOpWire::SetEphemeral { ephemeral } => ProjectPolicyOp::SetEphemeral(ephemeral),
        },
    )
}

pub fn parse_app_op(value: &Value, owned_ports: &[u16]) -> Result<AppOperation, PolicyRefusal> {
    Ok(
        match serde_json::from_value::<AppOpWire>(value.clone()).map_err(malformed)? {
            AppOpWire::SetGlobalProfile { enabled } => {
                AppOperation::Edit(AppPolicyOp::SetGlobalProfile(enabled))
            }
            AppOpWire::SetAskBeforePasswordSubmit { enabled } => {
                AppOperation::Edit(AppPolicyOp::SetAskBeforePasswordSubmit(enabled))
            }
            AppOpWire::AddPreapproval { action, origin } => {
                AppOperation::Edit(AppPolicyOp::AddPreapproval(AppPreapproval::new(
                    action,
                    preapproval_origin(&origin, owned_ports)?,
                )?))
            }
            AppOpWire::RemovePreapproval { action, origin } => {
                AppOperation::Edit(AppPolicyOp::RemovePreapproval(Preapproval {
                    action,
                    origin: CanonicalOrigin::parse(&origin)?,
                }))
            }
            AppOpWire::ClearGlobalProfile => AppOperation::ClearGlobalProfile,
        },
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreapprovalView {
    pub action: ActionClass,
    pub origin: String,
}

fn preapproval_views(items: &[Preapproval]) -> Vec<PreapprovalView> {
    items
        .iter()
        .map(|p| PreapprovalView {
            action: p.action,
            origin: p.origin.as_str().to_string(),
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPolicyView {
    pub project_id: String,
    pub revision: u64,
    pub read_only: bool,
    pub allow_list: Vec<String>,
    pub preapprovals: Vec<PreapprovalView>,
    pub profile_mode: ProfileMode,
    /// What the project's sessions get after the app switch and the engine.
    pub effective_profile_mode: ProfileMode,
}

impl ProjectPolicyView {
    pub fn new(project_id: &str, policy: &ProjectPolicy, effective_profile_mode: ProfileMode) -> Self {
        Self {
            project_id: project_id.to_string(),
            revision: policy.revision,
            read_only: policy.read_only,
            allow_list: policy
                .allow_list
                .iter()
                .map(OriginPattern::to_canonical_string)
                .collect(),
            preapprovals: preapproval_views(&policy.preapprovals),
            profile_mode: policy.profile_mode,
            effective_profile_mode,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPolicyView {
    pub revision: u64,
    pub read_only: bool,
    pub global_profile_enabled: bool,
    /// Whether agents get the global profile: the switch is on and the
    /// engine can keep one (macOS needs 14).
    pub effective_global_profile: bool,
    pub ask_before_password_submit: bool,
    pub preapprovals: Vec<PreapprovalView>,
    /// What clearing the global profile would close right now.
    pub clear_impact: ClearImpact,
}

impl AppPolicyView {
    pub fn new(policy: &AppPolicy, clear_impact: ClearImpact, engine_keeps_global: bool) -> Self {
        Self {
            revision: policy.revision,
            read_only: policy.read_only,
            global_profile_enabled: policy.global_profile_enabled,
            effective_global_profile: policy.global_profile_enabled && engine_keeps_global,
            ask_before_password_submit: policy.ask_before_password_submit,
            preapprovals: preapproval_views(&policy.preapprovals),
            clear_impact,
        }
    }
}

/// Payload of `browser_policy_changed`. Carries no policy content: clients
/// re-read the scope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyChanged {
    pub scope: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub revision: u64,
}
