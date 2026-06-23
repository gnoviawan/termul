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

    pub fn load(path: &std::path::Path) -> Result<Self, String> {
        let contents = std::fs::read_to_string(path).map_err(|e| {
            format!(
                "failed to read session registry {}: {}",
                path.display(),
                e
            )
        })?;
        serde_json::from_str(&contents).map_err(|e| {
            format!(
                "failed to parse session registry {}: {}",
                path.display(),
                e
            )
        })
    }

    pub fn load_or_new(path: &std::path::Path, supervisor_pid: u32) -> Result<Self, String> {
        if path.exists() {
            Self::load(path)
        } else {
            Ok(Self::new(supervisor_pid))
        }
    }

    pub fn save_atomic(&self, path: &std::path::Path) -> Result<(), String> {
        if let Some(parent) = non_empty_parent(path) {
            std::fs::create_dir_all(parent).map_err(|e| {
                format!(
                    "failed to create session registry directory {}: {}",
                    parent.display(),
                    e
                )
            })?;
        }

        let tmp_path = path.with_file_name(format!(
            ".{}.{}.tmp",
            path.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("sessions.json"),
            uuid::Uuid::new_v4()
        ));
        let bytes = serde_json::to_vec_pretty(self)
            .map_err(|e| format!("failed to serialize session registry: {}", e))?;
        {
            use std::io::Write;

            let mut tmp_file = std::fs::File::create(&tmp_path).map_err(|e| {
                format!(
                    "failed to create session registry temp {}: {}",
                    tmp_path.display(),
                    e
                )
            })?;
            tmp_file.write_all(&bytes).map_err(|e| {
                format!(
                    "failed to write session registry temp {}: {}",
                    tmp_path.display(),
                    e
                )
            })?;
            tmp_file.sync_all().map_err(|e| {
                format!(
                    "failed to sync session registry temp {}: {}",
                    tmp_path.display(),
                    e
                )
            })?;
        }

        replace_file(&tmp_path, path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp_path);
            format!(
                "failed to replace session registry {}: {}",
                path.display(),
                e
            )
        })?;

        if let Some(parent) = non_empty_parent(path) {
            sync_directory(parent);
        }

        Ok(())
    }
}

fn non_empty_parent(path: &std::path::Path) -> Option<&std::path::Path> {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
}

#[cfg(not(target_os = "windows"))]
fn replace_file(tmp_path: &std::path::Path, path: &std::path::Path) -> std::io::Result<()> {
    std::fs::rename(tmp_path, path)
}

#[cfg(target_os = "windows")]
fn replace_file(tmp_path: &std::path::Path, path: &std::path::Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let mut tmp_wide: Vec<u16> = tmp_path.as_os_str().encode_wide().collect();
    tmp_wide.push(0);
    let mut path_wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    path_wide.push(0);

    let result = unsafe {
        MoveFileExW(
            tmp_wide.as_ptr(),
            path_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };

    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
fn sync_directory(path: &std::path::Path) {
    if let Ok(dir) = std::fs::File::open(path) {
        let _ = dir.sync_all();
    }
}

#[cfg(target_os = "windows")]
fn sync_directory(_path: &std::path::Path) {}

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

    #[test]
    fn registry_round_trips_json() {
        let dir = std::env::temp_dir().join(format!(
            "termul-registry-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sessions.json");

        let mut registry = SessionRegistry::new(42);
        registry.last_shutdown = LastShutdown::KeepRunning;
        registry.sessions.push(RecoveredSession::terminal("term-1", 9001));

        registry.save_atomic(&path).unwrap();
        let loaded = SessionRegistry::load(&path).unwrap();

        assert_eq!(loaded.schema_version, SESSION_REGISTRY_SCHEMA_VERSION);
        assert_eq!(loaded.last_shutdown, LastShutdown::KeepRunning);
        assert_eq!(loaded.sessions[0].session_id, "term-1");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn registry_overwrites_existing_json() {
        let dir = std::env::temp_dir().join(format!(
            "termul-registry-overwrite-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sessions.json");

        let mut registry = SessionRegistry::new(42);
        registry.save_atomic(&path).unwrap();
        registry.last_shutdown = LastShutdown::KeepRunning;
        registry.save_atomic(&path).unwrap();

        let loaded = SessionRegistry::load(&path).unwrap();
        assert_eq!(loaded.last_shutdown, LastShutdown::KeepRunning);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn registry_saves_to_relative_path_without_parent() {
        let current_dir = std::env::current_dir().unwrap();
        let dir = std::env::temp_dir().join(format!(
            "termul-registry-relative-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        std::env::set_current_dir(&dir).unwrap();
        let result = SessionRegistry::new(42).save_atomic(std::path::Path::new("sessions.json"));
        std::env::set_current_dir(current_dir).unwrap();

        result.unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn missing_registry_loads_empty_clean_registry() {
        let path = std::env::temp_dir().join(format!("missing-{}.json", uuid::Uuid::new_v4()));
        let loaded = SessionRegistry::load_or_new(&path, 77).unwrap();
        assert_eq!(loaded.supervisor_pid, 77);
        assert_eq!(loaded.last_shutdown, LastShutdown::Clean);
    }
}
