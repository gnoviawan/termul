//! Host-service ports the core consumes: host-originated consent tickets
//! and the browser policy store. Implementations live in `acp/` and
//! `web/`; the core only sees these traits.

pub use crate::acp::browser_policy::{
    ActionClass, AppPolicy, AppPolicyOp, CanonicalOrigin, PolicyRefusal, ProjectPolicy,
    ProjectPolicyOp,
};

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use serde::Serialize;
use uuid::Uuid;

pub type PortFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The agent identity a tab was actually built with (after engine
/// fallbacks). Ordered narrowest first: a session already running
/// ephemeral never widens to global.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TabProfile {
    Ephemeral,
    Global,
}

/// Host ticket id, `host:<uuid>`. Never reaches the ACP manager.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct TicketId(String);

impl TicketId {
    pub const PREFIX: &'static str = "host:";

    pub fn mint() -> Self {
        Self(format!("{}{}", Self::PREFIX, Uuid::new_v4()))
    }

    pub fn parse(input: &str) -> Option<Self> {
        let uuid = input.strip_prefix(Self::PREFIX)?;
        Uuid::parse_str(uuid).ok()?;
        Some(Self(input.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The fixed consent options and their ACP permission-kind mapping.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConsentOption {
    AllowSession,
    AllowProject,
    Deny,
}

impl ConsentOption {
    pub const ALL: [ConsentOption; 3] = [
        ConsentOption::AllowSession,
        ConsentOption::AllowProject,
        ConsentOption::Deny,
    ];

    /// What a sensitive action is offered when no project pre-approval
    /// could cover it: this once, or not at all.
    pub const ONCE_OR_DENY: [ConsentOption; 2] = [ConsentOption::AllowSession, ConsentOption::Deny];

    pub fn acp_kind(self) -> &'static str {
        match self {
            ConsentOption::AllowSession => "allow_once",
            ConsentOption::AllowProject => "allow_always",
            ConsentOption::Deny => "reject_once",
        }
    }

    /// `_meta.termul.scope`; clients label options from this, never from
    /// the ACP kind alone.
    pub fn scope(self) -> Option<&'static str> {
        match self {
            ConsentOption::AllowSession => Some("session"),
            ConsentOption::AllowProject => Some("project"),
            ConsentOption::Deny => None,
        }
    }
}

/// The file an upload ticket asks about: its base name and size, never
/// its path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TicketFile {
    pub name: String,
    pub bytes: u64,
}

/// What a ticket shows the approver. Closed: never page title or text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TicketRequest {
    pub id: TicketId,
    pub session_id: String,
    pub project_id: String,
    pub origin: CanonicalOrigin,
    pub target_url: String,
    pub action: ActionClass,
    /// Agent-supplied intent, displayed as such and never classified.
    pub element: Option<String>,
    /// For an upload, the host-checked file it sends.
    pub file: Option<TicketFile>,
    pub profile: TabProfile,
    /// The options offered, in display order.
    pub options: &'static [ConsentOption],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TicketOutcome {
    Answered(ConsentOption),
    /// No qualified approver is attached (or the session is flagged
    /// unattended): resolved immediately, never waited on.
    Unattended,
    TimedOut,
    /// Withdrawn by Stop or session teardown.
    Cancelled,
}

/// Host-originated consent tickets on the ACP permission contract.
pub trait PermissionRequest: Send + Sync {
    /// Raise a ticket and wait up to `wait` for the first qualified answer.
    fn request(&self, ticket: TicketRequest, wait: Duration) -> PortFuture<'_, TicketOutcome>;
    /// Resolve every pending ticket of the session as `Cancelled`.
    fn cancel_session(&self, session_id: &str);
}

/// Host-owned browser policy: operations only, serialized per scope by a
/// revision compare-and-swap.
pub trait PolicyStore: Send + Sync {
    fn project<'a>(&'a self, project_id: &'a str) -> PortFuture<'a, Result<ProjectPolicy, PolicyRefusal>>;
    fn app(&self) -> PortFuture<'_, Result<AppPolicy, PolicyRefusal>>;
    fn apply_project<'a>(
        &'a self,
        project_id: &'a str,
        expected_revision: u64,
        op: ProjectPolicyOp,
    ) -> PortFuture<'a, Result<ProjectPolicy, PolicyRefusal>>;
    #[cfg_attr(
        not(feature = "conformance"),
        allow(dead_code, reason = "only the conformance runner edits app policy through the port")
    )]
    fn apply_app(
        &self,
        expected_revision: u64,
        op: AppPolicyOp,
    ) -> PortFuture<'_, Result<AppPolicy, PolicyRefusal>>;
}

#[cfg(test)]
#[path = "ports_tests.rs"]
mod tests;
