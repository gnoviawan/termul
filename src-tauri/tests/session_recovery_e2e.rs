//! End-to-end integration test for the session-recovery lifecycle.
//!
//! This exercises the durable layer that exists today across a real process
//! boundary and the filesystem:
//!
//!   spawn real background CLI (sample: `pi`)
//!     -> record session in registry
//!     -> persist registry to disk (atomic write)
//!     -> simulate UI crash (drop all in-memory state)
//!     -> reload registry from disk
//!     -> classify startup (crashed_or_unknown)
//!     -> mark_lost_sessions against REAL OS pid liveness
//!
//! Two scenarios are covered:
//!   1. child still alive  -> session stays `running` (recoverable / live_attachable)
//!   2. child killed        -> session is reclassified `lost`
//!
//! There is no supervisor socket transport or PTY ownership yet (deferred
//! follow-ups), so this is the highest-fidelity e2e the current code supports.

use std::process::{Child, Command, Stdio};

use termul_manager_lib::session_recovery::registry::{
    LastShutdown, RecoveredSession, RecoveredSessionKind, RecoveredSessionStatus, SessionRegistry,
    StartupRecoveryState,
};

/// A temp dir that cleans itself up, so the test never leaks files even on
/// panic/assert failure.
struct TempDir {
    path: std::path::PathBuf,
}

impl TempDir {
    fn new(tag: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "termul-recovery-e2e-{tag}-{}-{}",
            std::process::id(),
            nanos()
        ));
        std::fs::create_dir_all(&path).expect("create temp dir");
        Self { path }
    }

    fn registry_file(&self) -> std::path::PathBuf {
        self.path.join("sessions.json")
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// Real OS liveness check. `kill -0 <pid>` succeeds iff the process exists and
/// is signalable, which is exactly what the supervisor's `mark_lost_sessions`
/// callback needs from the host.
fn is_pid_alive(pid: u32) -> bool {
    Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Spawn the sample CLI (`pi`) as a real long-lived background process. stdin is
/// piped (not inherited) so the interactive CLI blocks waiting for input and
/// stays alive until we explicitly kill it, mirroring a backgrounded session.
/// Falls back to `sleep` if `pi` is not on PATH so the test is portable.
fn spawn_sample_cli() -> Child {
    if let Ok(child) = Command::new("pi")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        return child;
    }

    Command::new("sleep")
        .arg("300")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn fallback sample CLI (sleep)")
}

fn terminal_session(session_id: &str, pid: u32) -> RecoveredSession {
    RecoveredSession {
        session_id: session_id.to_string(),
        kind: RecoveredSessionKind::Terminal,
        status: RecoveredSessionStatus::Running,
        pid: Some(pid),
        process_group_id: Some(pid),
        command: Some("pi".to_string()),
        args: Vec::new(),
        shell: Some("bash".to_string()),
        cwd: Some("/tmp".to_string()),
        cols: Some(80),
        rows: Some(24),
        scrollback_journal_path: None,
        exit_code: None,
        recovery_reason: None,
    }
}

#[test]
fn live_background_cli_survives_simulated_crash_and_stays_recoverable() {
    let tmp = TempDir::new("alive");
    let registry_path = tmp.registry_file();

    // A real CLI process running in the background.
    let mut child = spawn_sample_cli();
    let pid = child.id();
    assert!(is_pid_alive(pid), "sample CLI should be alive after spawn");

    // Supervisor (pid 4242 here) records the live session and persists it as it
    // would right before the UI goes away uncleanly.
    let mut registry = SessionRegistry::new(4242);
    registry.last_shutdown = LastShutdown::CrashedOrUnknown;
    registry.last_heartbeat_at_ms = 1_000;
    registry.sessions.push(terminal_session("sess-alive", pid));
    registry
        .save_atomic(&registry_path)
        .expect("persist registry");

    // Simulate UI crash: every in-memory structure is gone. The only truth left
    // is the file on disk.
    drop(registry);

    // Relaunch path: reload registry, classify, then reconcile against the real
    // OS. The supervisor (same pid) is still up and the child is still alive.
    let mut reloaded = SessionRegistry::load(&registry_path).expect("reload registry");
    assert_eq!(
        reloaded.classify_startup(4242, 10_000),
        StartupRecoveryState::CrashedOrUnknown,
        "non-clean shutdown must surface the recovery banner state"
    );

    reloaded.mark_lost_sessions(&is_pid_alive);

    let session = &reloaded.sessions[0];
    assert_eq!(
        session.status,
        RecoveredSessionStatus::Running,
        "a still-running background CLI must remain recoverable, not lost"
    );
    assert!(session.recovery_reason.is_none());

    // Teardown the real process.
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn dead_background_cli_is_marked_lost_after_simulated_crash() {
    let tmp = TempDir::new("dead");
    let registry_path = tmp.registry_file();

    // Spawn the sample CLI, capture its pid, then kill it BEFORE the recovery
    // pass — modelling a child that did not survive (e.g. supervisor also died).
    let mut child = spawn_sample_cli();
    let pid = child.id();
    let _ = child.kill();
    let _ = child.wait();

    // Give the OS a moment to reap; assert it is genuinely gone.
    for _ in 0..50 {
        if !is_pid_alive(pid) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(!is_pid_alive(pid), "sample CLI should be dead after kill");

    let mut registry = SessionRegistry::new(4242);
    registry.last_shutdown = LastShutdown::CrashedOrUnknown;
    registry.sessions.push(terminal_session("sess-dead", pid));
    registry
        .save_atomic(&registry_path)
        .expect("persist registry");
    drop(registry);

    let mut reloaded = SessionRegistry::load(&registry_path).expect("reload registry");
    reloaded.mark_lost_sessions(&is_pid_alive);

    let session = &reloaded.sessions[0];
    assert_eq!(
        session.status,
        RecoveredSessionStatus::Lost,
        "a dead background CLI must be reclassified as lost"
    );
    assert_eq!(
        session.recovery_reason.as_deref(),
        Some("process_not_found"),
        "lost sessions must record why"
    );
}

#[test]
fn clean_shutdown_reload_shows_no_recovery() {
    let tmp = TempDir::new("clean");
    let registry_path = tmp.registry_file();

    // Clean close: no live sessions, marker is clean.
    let registry = SessionRegistry::new(4242);
    registry
        .save_atomic(&registry_path)
        .expect("persist registry");
    drop(registry);

    let reloaded = SessionRegistry::load(&registry_path).expect("reload registry");
    assert_eq!(
        reloaded.classify_startup(4242, 10_000),
        StartupRecoveryState::Clean,
        "a clean shutdown must not trigger recovery on next launch"
    );
    assert!(reloaded.sessions.is_empty());
}
