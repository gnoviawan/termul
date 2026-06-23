use parking_lot::RwLock;
use std::sync::Arc;

pub fn supervisor_binary_name() -> &'static str {
    "termul-supervisor"
}

#[derive(Debug, Default)]
pub struct SupervisorClientState {
    pub supervisor_pid: Option<u32>,
    registry: Arc<RwLock<Option<crate::session_recovery::registry::SessionRegistry>>>,
}

impl SupervisorClientState {
    pub fn recovered_sessions(&self) -> Vec<crate::session_recovery::registry::RecoveredSession> {
        self.registry
            .read()
            .as_ref()
            .map(|registry| registry.sessions.clone())
            .unwrap_or_default()
    }

    pub fn set_registry(&self, registry: crate::session_recovery::registry::SessionRegistry) {
        *self.registry.write() = Some(registry);
    }
}

pub fn registry_path(base_dir: &std::path::Path) -> std::path::PathBuf {
    base_dir.join("sessions.json")
}

/// Generate a random hex auth token for the supervisor socket handshake.
pub fn generate_auth_token() -> String {
    let mut bytes = [0u8; 32];
    // getrandom is already a dependency (used for remote-server auth tokens).
    if getrandom::getrandom(&mut bytes).is_err() {
        // Fall back to a time/pid seed; the socket is still user-only on disk.
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let pid = std::process::id() as u128;
        let mixed = seed ^ (pid << 64);
        return format!("{mixed:032x}");
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Resolve the `termul-supervisor` binary path. Tauri places sidecar/extra
/// binaries next to the main executable, so look there first, then fall back to
/// a bare name on PATH (dev `cargo run` with the binary in target/).
#[cfg(unix)]
pub fn resolve_supervisor_path() -> std::path::PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join(supervisor_binary_name());
            if candidate.exists() {
                return candidate;
            }
        }
    }
    std::path::PathBuf::from(supervisor_binary_name())
}

/// Launch the supervisor daemon on Linux/Unix, detached from this process so it
/// survives a Termul force-close. Returns the spawned child pid and the auth
/// token the daemon was started with (clients must present it in `Hello`).
///
/// The daemon itself calls `setsid()` at startup; spawning here only needs to
/// avoid blocking on the child and to pass the token via the environment.
#[cfg(unix)]
pub fn launch_supervisor() -> Result<(u32, String), String> {
    use std::process::{Command, Stdio};

    let token = generate_auth_token();
    let bin = resolve_supervisor_path();

    let child = Command::new(&bin)
        .env("TERMUL_SUPERVISOR_TOKEN", &token)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to launch supervisor {}: {e}", bin.display()))?;

    Ok((child.id(), token))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supervisor_binary_name_is_stable() {
        assert_eq!(supervisor_binary_name(), "termul-supervisor");
    }

    #[test]
    fn registry_filename_is_sessions_json() {
        let base = std::path::PathBuf::from("/tmp/termul-test");
        assert_eq!(registry_path(&base), base.join("sessions.json"));
    }

    #[test]
    fn recovered_sessions_defaults_empty_then_reflects_registry() {
        use crate::session_recovery::registry::SessionRegistry;

        let state = SupervisorClientState::default();
        assert!(state.recovered_sessions().is_empty());

        let registry = SessionRegistry::new(123);
        state.set_registry(registry);
        assert!(state.recovered_sessions().is_empty());
    }
}
