//! SSH & Remote Connection Manager module
//!
//! Provides SSH connection management, SFTP operations, and port forwarding
//! for the Termul terminal manager.

pub mod config_parser;
pub mod connection;
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
}

impl SSHManager {
    pub fn new(app_handle: tauri::AppHandle) -> Self {
        let profiles = Arc::new(ProfileManager::new(app_handle.clone()));
        let connections = Arc::new(SSHConnectionManager::new(app_handle));

        Self {
            connections,
            profiles,
        }
    }
}
