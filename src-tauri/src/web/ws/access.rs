//! Per-connection access state for `/ws`: the capabilities resolved at
//! `authenticate` and the connection's own `ClientId` (first-wins identity for
//! ticket answers). Plain `Copy` data: request tasks take a copy; the presence
//! registration lives in `ConnState`.

use super::*;
use crate::web::capabilities::{ws_request_permitted, Capabilities, CapabilityPolicy};

#[derive(Debug, Clone, Copy)]
pub(super) struct ConnectionAccess {
    policy: CapabilityPolicy,
    capabilities: Capabilities,
    connection_id: ClientId,
}

impl ConnectionAccess {
    /// A pre-`authenticate` connection: no capabilities, not in presence.
    pub(super) fn new(policy: CapabilityPolicy) -> Self {
        Self {
            capabilities: Capabilities::none(policy.carrier),
            policy,
            connection_id: ClientId::new(),
        }
    }

    /// `authenticate` succeeded: resolve capabilities once.
    pub(super) fn grant(&mut self) {
        self.capabilities = self.policy.resolve();
    }

    pub(super) fn carrier(&self) -> Carrier {
        self.policy.carrier
    }

    pub(super) fn capabilities(&self) -> Capabilities {
        self.capabilities
    }

    /// The connection's own id: ticket answers (first-wins) are attributed to
    /// it regardless of which sessions the connection subscribed to.
    pub(super) fn connection_id(&self) -> ClientId {
        self.connection_id
    }

    /// An already-authenticated access (tests that skip the handshake).
    #[cfg(test)]
    pub(super) fn granted(policy: CapabilityPolicy) -> Self {
        let mut access = Self::new(policy);
        access.capabilities = policy.resolve();
        access
    }
}

/// The required-capability check run before the post-auth dispatch: `Some`
/// holds the `forbidden` reply when `request` needs a capability the
/// connection lacks.
pub(super) fn forbidden_reply(
    id: &str,
    request_type: &str,
    payload: &Value,
    access: &ConnectionAccess,
    identity: Option<&ClientIdentity>,
) -> Option<WsReply> {
    if ws_request_permitted(request_type, payload, access.capabilities(), identity) {
        return None;
    }
    // Boundary log: request type + carrier + device label only — never the
    // payload (it can carry prompt text or store values).
    warn!(
        target: "termul::web::ws",
        request_id = %id,
        request_type = %request_type,
        carrier = access.capabilities().carrier.as_str(),
        device_id = %identity.map_or_else(String::new, |i| ClientIdentity::log_label(&i.device_id)),
        "/ws request refused: view-only connection lacks write capability"
    );
    Some(WsReply::err(
        id,
        WsErrorCode::Forbidden,
        format!("`{request_type}` requires write capability; this connection is view-only"),
    ))
}
