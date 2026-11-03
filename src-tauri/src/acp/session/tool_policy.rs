//! Host answers to a headless session's permission requests.
//!
//! A headless session (an automation's agent node) has nobody to ask, so the
//! host answers each `session/request_permission` from the session's
//! [`ToolAllowlist`]: a listed tool kind gets the agent's allow-once option,
//! anything else its reject-once option. The host never picks an
//! allow-always option (it writes a lasting rule into the agent's settings)
//! and never allows a mode switch, so the session cannot leave the mode the
//! host checked at start.
//!
//! Claude's adapter sends the kind only on the `tool_call` update that
//! precedes the request, so the kinds seen per tool call are kept here.

use std::collections::HashMap;

use agent_client_protocol::schema::v1::{
    PermissionOption, PermissionOptionKind, RequestPermissionOutcome, SelectedPermissionOutcome,
    ToolCallUpdate, ToolKind,
};

/// The tool kinds a headless session may use without asking anyone.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ToolAllowlist {
    kinds: Vec<ToolKind>,
}

impl ToolAllowlist {
    /// `SwitchMode` is dropped: a session never changes its own mode.
    pub fn new(kinds: impl IntoIterator<Item = ToolKind>) -> Self {
        let mut allowed = Vec::new();
        for kind in kinds {
            if kind != ToolKind::SwitchMode && !allowed.contains(&kind) {
                allowed.push(kind);
            }
        }
        Self { kinds: allowed }
    }

    pub fn allows(&self, kind: ToolKind) -> bool {
        self.kinds.contains(&kind)
    }
}

/// The host's answer to one permission request.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ToolDecision {
    pub kind: ToolKind,
    pub allowed: bool,
    pub outcome: RequestPermissionOutcome,
}

#[derive(Default)]
pub(super) struct ToolPolicies {
    sessions: HashMap<String, SessionPolicy>,
}

struct SessionPolicy {
    allowlist: ToolAllowlist,
    kinds: HashMap<String, ToolKind>,
}

impl ToolPolicies {
    pub(super) fn set(&mut self, session_id: String, allowlist: ToolAllowlist) {
        self.sessions.insert(
            session_id,
            SessionPolicy {
                allowlist,
                kinds: HashMap::new(),
            },
        );
    }

    pub(super) fn forget(&mut self, session_id: &str) {
        self.sessions.remove(session_id);
    }

    pub(super) fn note_kind(&mut self, session_id: &str, tool_call_id: &str, kind: ToolKind) {
        if let Some(policy) = self.sessions.get_mut(session_id) {
            policy.kinds.insert(tool_call_id.to_string(), kind);
        }
    }

    /// `None` when the session has no allowlist.
    pub(super) fn answer(
        &self,
        session_id: &str,
        tool_call: &ToolCallUpdate,
        options: &[PermissionOption],
    ) -> Option<ToolDecision> {
        let policy = self.sessions.get(session_id)?;
        let kind = tool_call
            .fields
            .kind
            .or_else(|| {
                policy
                    .kinds
                    .get(tool_call.tool_call_id.0.as_ref())
                    .copied()
            })
            .unwrap_or_default();
        let allow = policy.allowlist.allows(kind).then(|| {
            options
                .iter()
                .find(|o| o.kind == PermissionOptionKind::AllowOnce)
        });
        let (allowed, option) = match allow.flatten() {
            Some(option) => (true, Some(option)),
            None => (
                false,
                options
                    .iter()
                    .find(|o| o.kind == PermissionOptionKind::RejectOnce),
            ),
        };
        let outcome = option.map_or(RequestPermissionOutcome::Cancelled, |o| {
            RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(o.option_id.clone()))
        });
        Some(ToolDecision {
            kind,
            allowed,
            outcome,
        })
    }
}

#[cfg(test)]
#[path = "tool_policy_tests.rs"]
mod tests;
