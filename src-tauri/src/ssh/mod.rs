//! SSH & Remote Connection Manager module
//!
//! Provides SSH connection management, SFTP operations, and port forwarding
//! for the Termul terminal manager.

pub mod config_parser;
pub mod connection;
pub mod credential_store;
pub mod port_forward;
pub mod profile_manager;
pub mod sftp;

use connection::SSHConnectionManager;
use profile_manager::ProfileManager;
use std::sync::Arc;

/// Top-level SSH manager that coordinates all SSH subsystems
pub struct SSHManager {
    pub connections: Arc<SSHConnectionManager>,
    pub profiles: Arc<ProfileManager>,
    pub port_forwards: Arc<port_forward::PortForwardManager>,
}

impl SSHManager {
    pub fn new(app_handle: tauri::AppHandle) -> Self {
        let profiles = Arc::new(ProfileManager::new(app_handle.clone()));
        let connections = Arc::new(SSHConnectionManager::new(app_handle.clone()));
        let port_forwards = Arc::new(port_forward::PortForwardManager::new(app_handle));

        Self {
            connections,
            profiles,
            port_forwards,
        }
    }

    pub async fn disconnect(&self, connection_id: &str) -> Result<(), String> {
        self.port_forwards.stop_all_for_connection(connection_id);
        self.connections.disconnect(connection_id).await
    }

    pub async fn shutdown(&self) {
        self.port_forwards.stop_all();
        let connection_ids = self.connections.connection_ids();
        for connection_id in connection_ids {
            if let Err(error) = self.connections.disconnect(&connection_id).await {
                log::warn!(
                    "[SSH] Failed to disconnect {} during shutdown: {}",
                    connection_id,
                    error
                );
            }
        }
    }
}
