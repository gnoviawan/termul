use parking_lot::RwLock;
use std::sync::Arc;

pub fn supervisor_binary_name() -> &'static str {
    "termul-supervisor"
}

#[derive(Debug, Default)]
pub struct SupervisorClientState {
    supervisor_pid: RwLock<Option<u32>>,
    auth_token: RwLock<Option<String>>,
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

    pub fn set_supervisor_pid(&self, pid: u32) {
        *self.supervisor_pid.write() = Some(pid);
    }

    pub fn supervisor_pid(&self) -> Option<u32> {
        *self.supervisor_pid.read()
    }
    /// Record the launched daemon's auth token (used by the renderer-facing
    /// client when connecting to the socket).
    pub fn set_auth_token(&self, token: String) {
        *self.auth_token.write() = Some(token);
    }

    pub fn auth_token(&self) -> Option<String> {
        self.auth_token.read().clone()
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

/// Entry point used when the main executable is re-spawned as the supervisor
/// daemon (env `TERMUL_RUN_AS_SUPERVISOR=1`). Returns `true` if it handled the
/// run (caller must exit), `false` for the normal app path.
///
/// This guarantees a working daemon in packaged builds where a separate
/// `[[bin]]` is not placed next to the app executable: the launcher re-execs
/// `current_exe` with this env flag instead of relying on a sidecar.
#[cfg(unix)]
pub fn run_as_supervisor_if_requested() -> bool {
    if std::env::var("TERMUL_RUN_AS_SUPERVISOR").as_deref() != Ok("1") {
        return false;
    }

    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    crate::session_recovery::daemon::daemonize_detach();
    let socket_path = crate::session_recovery::server::default_socket_path();
    let table = Arc::new(crate::session_recovery::daemon::SessionTable::new());
    let shutdown = Arc::new(AtomicBool::new(false));
    let token = std::env::var("TERMUL_SUPERVISOR_TOKEN")
        .ok()
        .filter(|t| !t.is_empty());

    if let Err(e) =
        crate::session_recovery::server::serve_with_auth(&socket_path, table, shutdown, token)
    {
        eprintln!("termul-supervisor (embedded) server error: {e}");
        std::process::exit(1);
    }
    true
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

    // Prefer the standalone supervisor binary (dev / when shipped as a sidecar).
    // Fall back to re-execing the current executable with TERMUL_RUN_AS_SUPERVISOR
    // so packaged builds without a separate sidecar still get a daemon.
    let (program, extra_env): (std::path::PathBuf, bool) = if bin.exists() {
        (bin, false)
    } else {
        let exe = std::env::current_exe()
            .map_err(|e| format!("cannot resolve current exe for supervisor: {e}"))?;
        (exe, true)
    };

    let mut cmd = Command::new(&program);
    cmd.env("TERMUL_SUPERVISOR_TOKEN", &token)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if extra_env {
        cmd.env("TERMUL_RUN_AS_SUPERVISOR", "1");
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("failed to launch supervisor {}: {e}", program.display()))?;

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
