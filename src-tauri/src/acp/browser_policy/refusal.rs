//! Why a policy read or edit was refused, and how that maps onto the frozen
//! wire codes. Finer causes travel as a stable `reason` slug.

use super::origin::OriginError;

/// The wire codes a policy reply can carry. A subset of the frozen browser
/// error codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireCode {
    InvalidParams,
    CapabilityUnavailable,
    Internal,
}

impl WireCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidParams => "invalid_params",
            Self::CapabilityUnavailable => "capability_unavailable",
            Self::Internal => "internal",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyRefusal {
    Origin(OriginError),
    /// The action class cannot be pre-approved in this scope.
    PreapprovalNotAllowed,
    LimitExceeded,
    MalformedOperation,
    InvalidProjectId,
    /// An app-level operation from a client bound to a single project.
    AppScopeRequired,
    /// A project-bound client addressing another project.
    ProjectScopeMismatch,
    /// `expected_revision` is stale; `current` is the stored revision.
    RevisionConflict {
        current: u64,
    },
    /// The policy file was written by a newer build, or does not parse, and
    /// is never overwritten.
    ReadOnly,
    /// No policy store is installed on this host (for example `termul-server`).
    StoreUnavailable,
    /// The agent browser engine cannot clear the global profile yet.
    ProfileEngineUnavailable,
    ProfileClearFailed,
    Storage,
}

impl PolicyRefusal {
    pub const fn code(&self) -> WireCode {
        match self {
            Self::StoreUnavailable | Self::ProfileEngineUnavailable => {
                WireCode::CapabilityUnavailable
            }
            Self::Storage | Self::ProfileClearFailed => WireCode::Internal,
            _ => WireCode::InvalidParams,
        }
    }

    pub const fn reason(&self) -> &'static str {
        match self {
            Self::Origin(error) => error.reason(),
            Self::PreapprovalNotAllowed => "preapproval_not_allowed",
            Self::LimitExceeded => "limit_exceeded",
            Self::MalformedOperation => "malformed_operation",
            Self::InvalidProjectId => "invalid_project_id",
            Self::AppScopeRequired => "app_scope_required",
            Self::ProjectScopeMismatch => "project_scope_mismatch",
            Self::RevisionConflict { .. } => "revision_conflict",
            Self::ReadOnly => "policy_read_only",
            Self::StoreUnavailable => "policy_store_unavailable",
            Self::ProfileEngineUnavailable => "profile_engine_unavailable",
            Self::ProfileClearFailed => "profile_clear_failed",
            Self::Storage => "storage_failed",
        }
    }

    /// Host template text; never echoes client input.
    pub fn message(&self) -> String {
        match self {
            Self::Origin(error) => error.message().to_string(),
            Self::PreapprovalNotAllowed => {
                "this action cannot be pre-approved in this scope".to_string()
            }
            Self::LimitExceeded => "the policy list is full".to_string(),
            Self::MalformedOperation => "the operation is not recognized".to_string(),
            Self::InvalidProjectId => "the project id is not valid".to_string(),
            Self::AppScopeRequired => {
                "app-level browser policy needs a client with app scope".to_string()
            }
            Self::ProjectScopeMismatch => "this client is bound to a different project".to_string(),
            Self::RevisionConflict { current } => {
                format!("the policy changed (now at revision {current}); reload and retry")
            }
            Self::ReadOnly => {
                "this policy file was written by a newer version of termul or does not parse, so it is read-only".to_string()
            }
            Self::StoreUnavailable => "browser policy is not available on this host".to_string(),
            Self::ProfileEngineUnavailable => {
                "this build cannot clear the agent browser profile yet".to_string()
            }
            Self::ProfileClearFailed => {
                "the agent browser profile could not be cleared".to_string()
            }
            Self::Storage => "the policy could not be saved".to_string(),
        }
    }

    /// `error` text of the reply envelope: `<reason>: <message>`. Clients
    /// split on the first `: ` to recover the reason.
    pub fn envelope_error(&self) -> String {
        format!("{}: {}", self.reason(), self.message())
    }
}

impl From<OriginError> for PolicyRefusal {
    fn from(error: OriginError) -> Self {
        Self::Origin(error)
    }
}
