use serde::{Deserialize, Serialize};

pub const SUPERVISOR_PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SupervisorRequest {
    Hello {
        protocol_version: u32,
        app_instance_id: String,
    },
    ListSessions,
    Attach { session_id: String },
    Detach { session_id: String },
    Shutdown { kill_all: bool },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SupervisorResponse {
    HelloAck {
        supervisor_pid: u32,
        protocol_version: u32,
    },
    Ok,
    Error { code: String, message: String },
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
}
