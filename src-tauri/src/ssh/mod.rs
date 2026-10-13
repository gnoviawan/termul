//! SSH & Remote Connection Manager module
//!
//! Interactive sessions (native russh shell channels adopted as terminals),
//! host profiles, host key trust, and SFTP / port forwarding over each
//! session's connection. See `docs/ssh-native.md`.

pub mod config_parser;
pub mod connect;
pub mod connection;
pub mod credential_store;
pub mod keys;
pub mod known_hosts;
pub mod port_forward;
pub mod profile_manager;
pub mod session;
pub mod sftp;
pub mod shell;

use profile_manager::ProfileManager;
use session::SshSessionManager;
use std::sync::Arc;
use tauri::Emitter;

/// Top-level SSH manager that coordinates all SSH subsystems
pub struct SSHManager {
    pub profiles: Arc<ProfileManager>,
    pub sessions: Arc<SshSessionManager>,
}

impl SSHManager {
    pub fn new(app_handle: tauri::AppHandle) -> Self {
        let profiles = Arc::new(ProfileManager::new(app_handle.clone()));
        let emitter = app_handle;
        let sessions = SshSessionManager::new(Arc::new(move |event, payload| {
            if let Err(e) = emitter.emit(event, payload) {
                log::error!("[SSH] Failed to emit {}: {}", event, e);
            }
        }));
        Self { profiles, sessions }
    }

    /// App exit: abort pending connects and stop port forwards. Live shells
    /// (and with them their connections) end via `PtyManager::kill_all`.
    pub async fn shutdown(&self) {
        self.sessions.shutdown();
    }
}
