use serde::{Deserialize, Serialize};

pub const SESSION_REGISTRY_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LastShutdown {
    Clean,
    KeepRunning,
    CrashedOrUnknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartupRecoveryState {
    Clean,
    KeepRunning,
    CrashedOrUnknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveredSessionKind {
    Terminal,
    Acp,
    Ssh,
    Browser,
    Editor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveredSessionStatus {
    Running,
    Exited,
    Detached,
    Lost,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveredSession {
    pub session_id: String,
    pub kind: RecoveredSessionKind,
    pub status: RecoveredSessionStatus,
    pub pid: Option<u32>,
    pub process_group_id: Option<u32>,
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    pub shell: Option<String>,
    pub cwd: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub scrollback_journal_path: Option<String>,
    pub exit_code: Option<i32>,
    pub recovery_reason: Option<String>,
}

impl RecoveredSession {
    #[cfg(test)]
    fn terminal(session_id: &str, pid: u32) -> Self {
        Self {
            session_id: session_id.to_string(),
            kind: RecoveredSessionKind::Terminal,
            status: RecoveredSessionStatus::Running,
            pid: Some(pid),
            process_group_id: Some(pid),
            command: None,
            args: Vec::new(),
            shell: None,
            cwd: None,
            cols: None,
            rows: None,
            scrollback_journal_path: None,
            exit_code: None,
            recovery_reason: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRegistry {
    pub schema_version: u32,
    pub supervisor_pid: u32,
    pub last_shutdown: LastShutdown,
    pub last_heartbeat_at_ms: u64,
    pub sessions: Vec<RecoveredSession>,
}

impl SessionRegistry {
    pub fn new(supervisor_pid: u32) -> Self {
        Self {
            schema_version: SESSION_REGISTRY_SCHEMA_VERSION,
            supervisor_pid,
            last_shutdown: LastShutdown::Clean,
            last_heartbeat_at_ms: 0,
            sessions: Vec::new(),
        }
    }

    pub fn classify_startup(
        &self,
        _current_supervisor_pid: u32,
        _now_ms: u64,
    ) -> StartupRecoveryState {
        match self.last_shutdown {
            LastShutdown::Clean => StartupRecoveryState::Clean,
            LastShutdown::KeepRunning => StartupRecoveryState::KeepRunning,
            LastShutdown::CrashedOrUnknown => StartupRecoveryState::CrashedOrUnknown,
        }
    }

    pub fn mark_lost_sessions(&mut self, is_pid_alive: &impl Fn(u32) -> bool) {
        for session in &mut self.sessions {
            if session.status == RecoveredSessionStatus::Running
                && session.pid.is_some_and(|pid| !is_pid_alive(pid))
            {
                session.status = RecoveredSessionStatus::Lost;
                session.recovery_reason = Some("process_not_found".to_string());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_shutdown_stays_clean() {
        let registry = SessionRegistry::new(123);
        assert_eq!(
            registry.classify_startup(123, 1_000),
            StartupRecoveryState::Clean
        );
    }

    #[test]
    fn keep_running_restores_attachable_sessions() {
        let mut registry = SessionRegistry::new(123);
        registry.last_shutdown = LastShutdown::KeepRunning;
        assert_eq!(
            registry.classify_startup(123, 1_000),
            StartupRecoveryState::KeepRunning
        );
    }

    #[test]
    fn stale_heartbeat_after_unknown_shutdown_is_crashed_or_unknown() {
        let mut registry = SessionRegistry::new(123);
        registry.last_shutdown = LastShutdown::CrashedOrUnknown;
        registry.last_heartbeat_at_ms = 1_000;
        assert_eq!(
            registry.classify_startup(123, 10_000),
            StartupRecoveryState::CrashedOrUnknown
        );
    }

    #[test]
    fn dead_supervisor_marks_running_terminal_lost() {
        let mut registry = SessionRegistry::new(123);
        registry.sessions.push(RecoveredSession::terminal("s1", 456));
        registry.mark_lost_sessions(&|pid| pid != 456);
        assert_eq!(registry.sessions[0].status, RecoveredSessionStatus::Lost);
    }
}
