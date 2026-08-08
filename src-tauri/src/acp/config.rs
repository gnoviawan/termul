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
/// The protocol-internal session id is `agent_client_protocol::schema::v1::SessionId`
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

impl From<agent_client_protocol::schema::v1::SessionId> for SessionId {
    fn from(value: agent_client_protocol::schema::v1::SessionId) -> Self {
        Self(value.0.to_string())
    }
}

impl From<&SessionId> for agent_client_protocol::schema::v1::SessionId {
    fn from(value: &SessionId) -> Self {
        agent_client_protocol::schema::v1::SessionId::new(value.0.as_str())
    }
}

/// Configuration describing how to launch an ACP agent subprocess.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    /// Stable renderer/config identity used for durable session matching. It is
    /// never used as a filesystem component and may be absent for older clients.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_id: Option<String>,
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
    /// Whether this agent may use the `terminal` client capability (arbitrary
    /// command execution). Defaults to false (M6): terminal access is opt-in
    /// per trusted agent. Existing persisted configs without this field load as
    /// `false`.
    #[serde(default)]
    pub allow_terminal: bool,
}

/// Resolve a bare command name against a `:`-separated PATH, returning the first
/// existing, executable match as an absolute path. An input that already
/// contains a `/` is treated as an explicit path and returned as-is. Returns
/// `None` when nothing executable is found so the caller keeps the bare name and
/// the spawn still surfaces a meaningful "not found" error.
#[cfg(not(target_os = "windows"))]
fn resolve_executable_in_path(command: &str, path: &str) -> Option<String> {
    use std::os::unix::fs::PermissionsExt;

    if command.contains('/') {
        return Some(command.to_string());
    }
    for dir in path.split(':').filter(|segment| !segment.is_empty()) {
        let candidate = std::path::Path::new(dir).join(command);
        if let Ok(meta) = std::fs::metadata(&candidate) {
            if meta.is_file() && meta.permissions().mode() & 0o111 != 0 {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    None
}

pub(crate) fn is_registry_launcher_on_path(command: &str) -> bool {
    let mut env_map = HashMap::new();
    crate::pty::env_refresh::apply_fresh_path(&mut env_map);

    if crate::pty::manager::resolve_spawn_program(command).is_ok() {
        return true;
    }

    #[cfg(not(target_os = "windows"))]
    if let Some(path) = env_map.get("PATH") {
        if resolve_executable_in_path(command, path).is_some() {
            return true;
        }
    }

    false
}

/// Availability of package-manager launchers used by the ACP registry.
#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpRuntimeProbe {
    pub npx: bool,
    pub uvx: bool,
}

/// Probe whether `npx` and `uvx` are resolvable on the current machine.
pub fn probe_registry_runtime() -> AcpRuntimeProbe {
    AcpRuntimeProbe {
        npx: is_registry_launcher_on_path("npx"),
        uvx: is_registry_launcher_on_path("uvx"),
    }
}

impl AgentConfig {
    /// Convert this config into the protocol stdio server config used to spawn
    /// the subprocess via `agent_client_protocol::AcpAgent`.
    pub(crate) fn to_mcp_server(&self) -> agent_client_protocol::schema::v1::McpServer {
        // Merge the login-shell PATH into the agent env. A GUI-launched app
        // (Finder/Dock/Spotlight on macOS, desktop launchers on Linux) only
        // inherits a minimal PATH, so npx/uvx/node from nvm/Homebrew are not on
        // it. PTY terminals avoid this via `env_refresh::apply_fresh_path`; ACP
        // agents (e.g. the npx-launched `claude-acp`) need the same treatment or
        // they fail to spawn (ENOENT) and never reach the connected/"Ready"
        // state. Custom PATH overrides already in `self.env` are preserved.
        let mut env_map = self.env.clone();
        crate::pty::env_refresh::apply_fresh_path(&mut env_map);

        let env: Vec<agent_client_protocol::schema::v1::EnvVariable> = env_map
            .iter()
            .map(|(name, value)| agent_client_protocol::schema::v1::EnvVariable::new(name, value))
            .collect();

        // Resolve the command for direct spawning. On Windows, npm/PowerShell
        // CLIs install as `.cmd`/`.bat` batch shims, which `CreateProcessW`
        // cannot launch (os error 193). Reuse the PTY launcher's shim-aware
        // resolver (ADR-004.2): it rewrites e.g. `gemini.cmd` to
        // `node.exe <script>`, prepending the script ahead of the user args.
        // A resolution failure falls back to the legacy PATH/PATHEXT lookup so
        // any real spawn error stays observable.
        let (command, args): (String, Vec<String>) = match crate::pty::manager::resolve_spawn_program(
            &self.command,
        ) {
            Ok(resolved) => {
                let mut args = resolved.prepend_args;
                args.extend(self.args.iter().cloned());
                (resolved.program, args)
            }
            Err(_) => (
                crate::trackers::git_tracker::resolve_executable(&self.command),
                self.args.clone(),
            ),
        };

        // On non-Windows `resolve_spawn_program` returns a bare command name
        // unchanged, leaving PATH resolution to whoever spawns the process. The
        // ACP runtime spawns it for us, so we cannot rely on it searching the
        // refreshed PATH — resolve the bare name against the merged PATH here so
        // the absolute path is launched regardless of the spawner's environment.
        #[cfg(not(target_os = "windows"))]
        let command = env_map
            .get("PATH")
            .and_then(|path| resolve_executable_in_path(&command, path))
            .unwrap_or(command);

        agent_client_protocol::schema::v1::McpServer::Stdio(
            agent_client_protocol::schema::v1::McpServerStdio::new(
                self.name.clone(),
                std::path::PathBuf::from(command),
            )
            .args(args)
            .env(env),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_registry_runtime_reports_launcher_flags() {
        let probe = probe_registry_runtime();
        assert_eq!(probe.npx, is_registry_launcher_on_path("npx"));
        assert_eq!(probe.uvx, is_registry_launcher_on_path("uvx"));
    }

    #[test]
    fn agent_id_is_unique() {
        let a = AgentId::new();
        let b = AgentId::new();
        assert_ne!(a, b);
    }

    #[test]
    fn session_id_roundtrips_through_protocol_type() {
        let original = SessionId::new("sess-123");
        let proto: agent_client_protocol::schema::v1::SessionId = (&original).into();
        let back: SessionId = proto.into();
        assert_eq!(original, back);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn resolve_executable_in_path_finds_executable_in_later_segment() {
        use std::os::unix::fs::PermissionsExt;

        let base = std::env::temp_dir().join(format!("termul-acp-path-{}", uuid::Uuid::new_v4()));
        let empty_dir = base.join("empty");
        let bin_dir = base.join("bin");
        std::fs::create_dir_all(&empty_dir).unwrap();
        std::fs::create_dir_all(&bin_dir).unwrap();
        let exe = bin_dir.join("npx");
        std::fs::write(&exe, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();

        let path = format!("{}:{}", empty_dir.display(), bin_dir.display());
        assert_eq!(
            resolve_executable_in_path("npx", &path),
            Some(exe.to_string_lossy().into_owned())
        );

        // A non-executable file of the same name is skipped, yielding None.
        let plain = empty_dir.join("npx");
        std::fs::write(&plain, b"not exec").unwrap();
        assert_eq!(
            resolve_executable_in_path("npx", &empty_dir.display().to_string()),
            None
        );

        // An explicit path is returned unchanged.
        assert_eq!(
            resolve_executable_in_path("/usr/bin/npx", &path),
            Some("/usr/bin/npx".to_string())
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn agent_config_builds_stdio_server() {
        let mut env = HashMap::new();
        env.insert("API_KEY".to_string(), "secret".to_string());
        let config = AgentConfig {
            config_id: None,
            name: "test-agent".to_string(),
            command: "/usr/bin/agent".to_string(),
            args: vec!["--acp".to_string()],
            env,
            allow_terminal: false,
        };

        match config.to_mcp_server() {
            agent_client_protocol::schema::v1::McpServer::Stdio(stdio) => {
                assert_eq!(stdio.name, "test-agent");
                assert_eq!(stdio.command, std::path::PathBuf::from("/usr/bin/agent"));
                assert_eq!(stdio.args, vec!["--acp".to_string()]);
                // The configured env is preserved. A login-shell PATH may also be
                // merged in (env-dependent), so look the var up by name rather
                // than asserting an exact count/order.
                let api_key = stdio
                    .env
                    .iter()
                    .find(|var| var.name == "API_KEY")
                    .expect("API_KEY env var preserved");
                assert_eq!(api_key.value, "secret");
            }
            _ => panic!("expected stdio server"),
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn agent_config_rewrites_windows_cmd_shim_and_orders_args() {
        // Simulate an npm-installed agent that exists only as a `.cmd` shim.
        let dir = std::env::temp_dir().join("termul-test-acp-cmd-shim");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("node.exe"), b"MZ").unwrap();
        std::fs::create_dir_all(dir.join("node_modules\\gemini\\bin")).unwrap();
        std::fs::write(dir.join("node_modules\\gemini\\bin\\gemini"), b"").unwrap();

        let shim_path = dir.join("gemini.cmd");
        let shim_content = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\n\
            endLocal & goto #_undefined_# 2>NUL || \"%_prog%\" \"%dp0%\\node_modules\\gemini\\bin\\gemini\" %*\r\n";
        std::fs::write(&shim_path, shim_content).unwrap();

        let config = AgentConfig {
            config_id: None,
            name: "gemini".to_string(),
            command: shim_path.to_string_lossy().to_string(),
            args: vec!["--experimental-acp".to_string()],
            env: HashMap::new(),
            allow_terminal: false,
        };

        match config.to_mcp_server() {
            agent_client_protocol::schema::v1::McpServer::Stdio(stdio) => {
                // Command rewritten to the directly-executable interpreter.
                assert!(
                    stdio.command.to_string_lossy().ends_with("node.exe"),
                    "expected node.exe, got: {}",
                    stdio.command.display()
                );
                // Script path is prepended ahead of the user's configured args.
                assert_eq!(stdio.args.len(), 2);
                assert!(
                    stdio.args[0].contains("gemini\\bin\\gemini"),
                    "expected script path first, got: {:?}",
                    stdio.args
                );
                assert_eq!(stdio.args[1], "--experimental-acp");
            }
            _ => panic!("expected stdio server"),
        }

        let _ = std::fs::remove_dir_all(&dir);
    }
}
