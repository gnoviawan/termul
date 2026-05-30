//! ACP configuration types: agent/session identifiers and agent launch config.
//!
//! These are the renderer-facing wire types for the ACP backend. All structs
//! use `#[serde(rename_all = "camelCase")]` to match the renderer contract.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Opaque identifier for a spawned ACP agent (one OS subprocess + driver thread).
///
/// Generated as a UUID v4 by the manager when an agent is spawned. This is the
/// Termul-side handle for an agent and is distinct from any protocol session id.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AgentId(pub String);

impl AgentId {
    /// Generate a fresh random agent id.
    #[must_use]
    pub fn new() -> Self {
        Self(uuid::Uuid::new_v4().to_string())
    }
}

impl Default for AgentId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for AgentId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Newtype wrapper for an ACP protocol session id, as a plain string for the
/// renderer contract.
///
/// The protocol-internal session id is `agent_client_protocol::schema::SessionId`
/// (an `Arc<str>`); this wrapper is the camelCase-friendly form passed across IPC.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SessionId(pub String);

impl SessionId {
    /// Wrap a raw session id string.
    #[must_use]
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }
}

impl std::fmt::Display for SessionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<agent_client_protocol::schema::SessionId> for SessionId {
    fn from(value: agent_client_protocol::schema::SessionId) -> Self {
        Self(value.0.to_string())
    }
}

impl From<&SessionId> for agent_client_protocol::schema::SessionId {
    fn from(value: &SessionId) -> Self {
        agent_client_protocol::schema::SessionId::new(value.0.as_str())
    }
}

/// Configuration describing how to launch an ACP agent subprocess.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    /// Human-readable name for this agent (also used as the MCP server name in the
    /// underlying stdio transport config).
    pub name: String,
    /// The executable to launch (resolved against PATH by the OS).
    pub command: String,
    /// Command-line arguments passed to the agent.
    #[serde(default)]
    pub args: Vec<String>,
    /// Extra environment variables to set for the agent process.
    #[serde(default)]
    pub env: HashMap<String, String>,
}

impl AgentConfig {
    /// Convert this config into the protocol stdio server config used to spawn
    /// the subprocess via `agent_client_protocol::AcpAgent`.
    pub(crate) fn to_mcp_server(&self) -> agent_client_protocol::schema::McpServer {
        let env: Vec<agent_client_protocol::schema::EnvVariable> = self
            .env
            .iter()
            .map(|(name, value)| agent_client_protocol::schema::EnvVariable::new(name, value))
            .collect();

        agent_client_protocol::schema::McpServer::Stdio(
            agent_client_protocol::schema::McpServerStdio::new(
                self.name.clone(),
                std::path::PathBuf::from(&self.command),
            )
            .args(self.args.clone())
            .env(env),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_id_is_unique() {
        let a = AgentId::new();
        let b = AgentId::new();
        assert_ne!(a, b);
    }

    #[test]
    fn session_id_roundtrips_through_protocol_type() {
        let original = SessionId::new("sess-123");
        let proto: agent_client_protocol::schema::SessionId = (&original).into();
        let back: SessionId = proto.into();
        assert_eq!(original, back);
    }

    #[test]
    fn agent_config_builds_stdio_server() {
        let mut env = HashMap::new();
        env.insert("API_KEY".to_string(), "secret".to_string());
        let config = AgentConfig {
            name: "test-agent".to_string(),
            command: "/usr/bin/agent".to_string(),
            args: vec!["--acp".to_string()],
            env,
        };

        match config.to_mcp_server() {
            agent_client_protocol::schema::McpServer::Stdio(stdio) => {
                assert_eq!(stdio.name, "test-agent");
                assert_eq!(stdio.command, std::path::PathBuf::from("/usr/bin/agent"));
                assert_eq!(stdio.args, vec!["--acp".to_string()]);
                assert_eq!(stdio.env.len(), 1);
                assert_eq!(stdio.env[0].name, "API_KEY");
                assert_eq!(stdio.env[0].value, "secret");
            }
            _ => panic!("expected stdio server"),
        }
    }
}
