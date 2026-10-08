//! ACP configuration types: agent/session identifiers and agent launch config.
//!
//! These are the renderer-facing wire types for the ACP backend. All structs
//! use `#[serde(rename_all = "camelCase")]` to match the renderer contract.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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

/// OQ1: the spawn path requires a non-empty `configId` so it derives a stable
/// `config:{config_id}` session namespace (no fallback hash). Both the desktop
/// `acp_spawn_agent` command and the WS `spawn_agent` handler route through
/// this shared guard — the desktop path returns the `Err(String)` directly, the
/// WS handler maps it to a `WsReply::err` with `WsErrorCode::Unsupported`.
pub(crate) fn require_config_id(config: &AgentConfig) -> Result<(), String> {
    let config_id = config.config_id.as_deref().map(str::trim).unwrap_or("");
    if config_id.is_empty() {
        return Err(
            "spawn_agent requires a non-empty `config.configId` for durable session matching"
                .to_string(),
        );
    }
    Ok(())
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

/// The PATH string every runtime-availability probe resolves against: the
/// login-shell/registry refreshed PATH merged with the inherited process PATH
/// (via [`crate::pty::env_refresh::apply_fresh_path`]). Shared so the catalog's
/// registry probes and the Claude runtime probes use ONE PATH source.
pub(crate) fn runtime_resolution_path() -> String {
    let mut env_map = HashMap::new();
    crate::pty::env_refresh::apply_fresh_path(&mut env_map);
    env_map
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("path"))
        .map(|(_, value)| value.clone())
        .unwrap_or_else(|| {
            crate::pty::env_refresh::path_for_resolution()
                .to_string_lossy()
                .into_owned()
        })
}

/// Single source of truth for "is this runtime CLI available": resolve the
/// bare command name against `path` (a platform-delimiter-separated PATH
/// string), returning the first existing executable candidate as an absolute
/// path. Windows also accepts `.exe`/`.cmd`/`.bat` shims; Unix requires an
/// exec bit. `None` means the CLI is NOT available on this host — every
/// caller (catalog `claude_cli`/launcher probes, install preflight, managed
/// Claude runtime checks) shares this exact semantic.
pub(crate) fn resolve_runtime_executable(command: &str, path: &str) -> Option<PathBuf> {
    for directory in std::env::split_paths(&std::ffi::OsString::from(path)) {
        #[cfg(windows)]
        let candidates = [
            directory.join(format!("{command}.exe")),
            directory.join(format!("{command}.cmd")),
            directory.join(format!("{command}.bat")),
            directory.join(command),
        ];
        #[cfg(not(windows))]
        let candidates = [directory.join(command)];

        for candidate in candidates {
            if !candidate.is_file() {
                continue;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if std::fs::metadata(&candidate)
                    .ok()
                    .is_some_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
                {
                    return Some(candidate);
                }
            }
            #[cfg(not(unix))]
            return Some(candidate);
        }
    }
    None
}

/// Probe whether `command` is available on the refreshed runtime PATH.
/// Delegates to [`resolve_runtime_executable`] so all availability probes
/// share one semantic (a previous implementation accepted any non-empty name
/// on Unix via the lenient PTY resolver, letting the catalog report
/// `claude_cli: true` while the install preflight correctly reported it
/// missing).
pub(crate) fn is_registry_launcher_on_path(command: &str) -> bool {
    resolve_runtime_executable(command, &runtime_resolution_path()).is_some()
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
    ///
    /// `shim_dir` (POSIX only): when `Some`, the headless browser-open shim
    /// (see `acp::browser_shim`) is injected — the dir is prepended to PATH and
    /// `BROWSER` points at its `xdg-open` so the agent's browser-open lands in
    /// the shim's `urls` sink instead of a real browser. Pass `None` for the
    /// unshimmed path (tests, non-agent spawns).
    pub(crate) fn to_mcp_server(
        &self,
        shim_dir: Option<&std::path::Path>,
    ) -> agent_client_protocol::schema::v1::McpServer {
        // The shim injection below is POSIX-only; keep the parameter's
        // contract explicit on Windows (where it is intentionally unused).
        #[cfg(not(unix))]
        let _ = shim_dir;
        // Merge the login-shell PATH into the agent env. A GUI-launched app
        // (Finder/Dock/Spotlight on macOS, desktop launchers on Linux) only
        // inherits a minimal PATH, so npx/uvx/node from nvm/Homebrew are not on
        // it. PTY terminals avoid this via `env_refresh::apply_fresh_path`; ACP
        // agents (e.g. the npx-launched `claude-acp`) need the same treatment or
        // they fail to spawn (ENOENT) and never reach the connected/"Ready"
        // state. Custom PATH overrides already in `self.env` are preserved.
        let mut env_map = self.env.clone();
        crate::pty::env_refresh::apply_fresh_path(&mut env_map);
        // Headless browser-open shim (spec-acp-terminal-auth): prepend the
        // per-agent shim dir to PATH + point BROWSER at its xdg-open so the
        // agent's `xdg-open <auth-url>` is captured, not launched. Runs AFTER
        // `apply_fresh_path` so the shim dir is FIRST on PATH (shadowing any
        // real xdg-open/gio). POSIX only — Windows keeps the native open.
        #[cfg(unix)]
        if let Some(dir) = shim_dir {
            crate::acp::browser_shim::inject_shim_env(&mut env_map, dir);
        }
        // Windows headless server has no browser-open shim. Set NO_BROWSER
        // for every ACP agent so vendor CLIs skip a browser login. A user
        // override of any case wins.
        #[cfg(windows)]
        if std::env::var_os("TERMUL_SERVER").is_some()
            && !env_map
                .keys()
                .any(|key| key.eq_ignore_ascii_case("NO_BROWSER"))
        {
            env_map.insert("NO_BROWSER".to_string(), "1".to_string());
        }

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
        let (command, args): (String, Vec<String>) =
            match crate::pty::manager::resolve_spawn_program(&self.command) {
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
mod tests;
