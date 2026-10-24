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
pub mod service;
pub mod session;
pub mod sftp;
pub mod shell;

use profile_manager::ProfileManager;
pub use session::Emit;
use session::SshSessionManager;
use std::path::Path;
use std::sync::Arc;

/// Top-level SSH manager that coordinates all SSH subsystems
pub struct SSHManager {
    pub profiles: Arc<ProfileManager>,
    pub sessions: Arc<SshSessionManager>,
    /// The event sink of this host's transport: Tauri events on the
    /// desktop, the `ssh` watch on the standalone server. It carries session
    /// progress, host-key questions, session ends, transfer progress and
    /// port-forward status.
    pub emit: Emit,
}

impl SSHManager {
    /// Profiles live in `data_dir`; events go to `emit`.
    pub fn new(data_dir: &Path, emit: Emit) -> Self {
        let profiles = Arc::new(ProfileManager::new(data_dir));
        let sessions = SshSessionManager::new(emit.clone());
        Self {
            profiles,
            sessions,
            emit,
        }
    }

    /// App exit: abort pending connects and stop port forwards. Live shells
    /// (and with them their connections) end via `PtyManager::kill_all`.
    pub async fn shutdown(&self) {
        self.sessions.shutdown();
    }
}
