//! Device presence: which `deviceId`s currently hold authenticated
//! connections, aggregated across `/ws` and `/terminal/ws` and across tabs
//! (`clientInstanceId`).
//!
//! A connection registers when its `authenticate` succeeds and unregisters
//! when its [`PresenceGuard`] drops (connection cleanup, including a read
//! task that is aborted or panics). The first connection of a device and the
//! last disconnect of a device are logged at info. Presence never feeds a reap
//! decision (agent reaping is activity-based only), so it only logs and
//! answers queries.

use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;

use crate::web::capabilities::Carrier;
use crate::web::ws::ClientIdentity;

/// One authenticated connection of a device.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ConnectionEntry {
    client_instance_id: String,
    carrier: Carrier,
}

/// Aggregated view of one device's live connections.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevicePresence {
    /// Open authenticated connections across all carriers.
    pub connections: usize,
    /// Distinct `clientInstanceId`s (browser tabs / app instances).
    pub client_instances: BTreeSet<String>,
    /// Distinct carriers in use (`ws`, `terminal_ws`).
    pub carriers: BTreeSet<&'static str>,
}

/// Registry of live connections keyed by `deviceId`.
#[derive(Default)]
pub struct PresenceRegistry {
    devices: Mutex<HashMap<String, HashMap<u64, ConnectionEntry>>>,
    next_connection: AtomicU64,
}

impl PresenceRegistry {
    /// An empty registry.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Register an authenticated connection. The returned guard removes it
    /// again on drop.
    #[must_use]
    pub fn register(
        self: &Arc<Self>,
        identity: &ClientIdentity,
        carrier: Carrier,
    ) -> PresenceGuard {
        let connection = self.next_connection.fetch_add(1, Ordering::Relaxed);
        let total = {
            let mut devices = self.devices.lock();
            let connections = devices.entry(identity.device_id.clone()).or_default();
            let first = connections.is_empty();
            connections.insert(
                connection,
                ConnectionEntry {
                    client_instance_id: identity.client_instance_id.clone(),
                    carrier,
                },
            );
            if first {
                tracing::info!(
                    target: "termul::web::presence",
                    device_id = %ClientIdentity::log_label(&identity.device_id),
                    carrier = carrier.as_str(),
                    "device connected (first connection)"
                );
            }
            connections.len()
        };
        tracing::debug!(
            target: "termul::web::presence",
            device_id = %ClientIdentity::log_label(&identity.device_id),
            carrier = carrier.as_str(),
            connections = total,
            "device connection registered"
        );
        PresenceGuard {
            registry: Arc::clone(self),
            device_id: identity.device_id.clone(),
            connection,
        }
    }

    fn unregister(&self, device_id: &str, connection: u64) {
        let mut devices = self.devices.lock();
        let Some(connections) = devices.get_mut(device_id) else {
            return;
        };
        if connections.remove(&connection).is_none() {
            return;
        }
        if connections.is_empty() {
            devices.remove(device_id);
            tracing::info!(
                target: "termul::web::presence",
                device_id = %ClientIdentity::log_label(device_id),
                "device disconnected (last connection closed)"
            );
        }
    }

    /// Aggregated presence for one device, `None` when it has no connection.
    #[must_use]
    pub fn device(&self, device_id: &str) -> Option<DevicePresence> {
        let devices = self.devices.lock();
        let connections = devices.get(device_id)?;
        Some(DevicePresence {
            connections: connections.len(),
            client_instances: connections
                .values()
                .map(|entry| entry.client_instance_id.clone())
                .collect(),
            carriers: connections
                .values()
                .map(|entry| entry.carrier.as_str())
                .collect(),
        })
    }

    /// Number of devices with at least one live connection.
    #[must_use]
    pub fn device_count(&self) -> usize {
        self.devices.lock().len()
    }
}

/// Removes its connection from the [`PresenceRegistry`] on drop.
pub struct PresenceGuard {
    registry: Arc<PresenceRegistry>,
    device_id: String,
    connection: u64,
}

impl Drop for PresenceGuard {
    fn drop(&mut self) {
        self.registry.unregister(&self.device_id, self.connection);
    }
}

#[cfg(test)]
mod tests;
