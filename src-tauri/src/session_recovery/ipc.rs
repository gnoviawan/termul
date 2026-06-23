use serde::{Deserialize, Serialize};

pub const SUPERVISOR_PROTOCOL_VERSION: u32 = 1;

/// Spawn parameters for a supervisor-owned PTY session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SpawnSpec {
    pub shell: Option<String>,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
    /// Optional program to run instead of a login shell (agent mode).
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Vec<(String, String)>,
}

/// Client -> supervisor request frame (newline-delimited JSON on the wire).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SupervisorRequest {
    Hello {
        protocol_version: u32,
        app_instance_id: String,
    },
    Spawn {
        spec: SpawnSpec,
    },
    Write {
        session_id: String,
        /// Raw bytes to write to the PTY.
        data: Vec<u8>,
    },
    Resize {
        session_id: String,
        cols: u16,
        rows: u16,
    },
    Kill {
        session_id: String,
    },
    ListSessions,
    /// Subscribe to live output frames for a session and request a scrollback
    /// replay.
    Attach {
        session_id: String,
    },
    Detach {
        session_id: String,
    },
    Shutdown {
        kill_all: bool,
    },
}

/// Supervisor -> client response/event frame.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SupervisorResponse {
    HelloAck {
        supervisor_pid: u32,
        protocol_version: u32,
    },
    Spawned {
        session_id: String,
        pid: u32,
    },
    Ok,
    Sessions {
        sessions: Vec<crate::session_recovery::registry::RecoveredSession>,
    },
    /// Replayed scrollback for an attach, sent before live output frames.
    Scrollback {
        session_id: String,
        data: Vec<u8>,
    },
    /// Live PTY output frame (server push).
    Output {
        session_id: String,
        data: Vec<u8>,
    },
    /// Session process exited.
    Exited {
        session_id: String,
        exit_code: i32,
    },
    Error {
        code: String,
        message: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_round_trips() {
        let msg = SupervisorRequest::Hello {
            protocol_version: 1,
            app_instance_id: "app-1".to_string(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        let decoded: SupervisorRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, msg);
    }

    #[test]
    fn spawn_and_write_round_trip() {
        let spawn = SupervisorRequest::Spawn {
            spec: SpawnSpec {
                shell: Some("/bin/bash".to_string()),
                cwd: Some("/tmp".to_string()),
                cols: 80,
                rows: 24,
                command: None,
                args: vec![],
                env: vec![("TERM".to_string(), "xterm-256color".to_string())],
            },
        };
        let json = serde_json::to_string(&spawn).unwrap();
        assert_eq!(
            serde_json::from_str::<SupervisorRequest>(&json).unwrap(),
            spawn
        );

        let write = SupervisorRequest::Write {
            session_id: "s1".to_string(),
            data: b"echo hi\n".to_vec(),
        };
        let json = serde_json::to_string(&write).unwrap();
        assert_eq!(
            serde_json::from_str::<SupervisorRequest>(&json).unwrap(),
            write
        );
    }

    #[test]
    fn output_event_round_trips() {
        let event = SupervisorResponse::Output {
            session_id: "s1".to_string(),
            data: vec![0x1b, b'[', b'0', b'm'],
        };
        let json = serde_json::to_string(&event).unwrap();
        let decoded: SupervisorResponse = serde_json::from_str(&json).unwrap();
        let rejson = serde_json::to_string(&decoded).unwrap();
        assert_eq!(json, rejson);
    }
}
