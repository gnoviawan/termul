//! System Claude CLI probes and the shared `claude` command builder.

use std::path::Path;

use super::{
    node_major_is_supported, probe_node_major_async, resolve_runtime_executable,
    ClaudeRuntimeProbe, ANTHROPIC_API_KEY_ENV, CLAUDE_CONFIG_DIR_ENV,
};

pub(super) struct SystemClaudeRuntimeProbe;

#[async_trait::async_trait]
impl ClaudeRuntimeProbe for SystemClaudeRuntimeProbe {
    async fn ensure_supported(&self) -> Result<(), String> {
        let path = crate::acp::config::runtime_resolution_path();
        if resolve_runtime_executable("claude", &path).is_none() {
            return Err(
                "Claude Code CLI is not installed. Install it from Anthropic, then restart Termul."
                    .to_string(),
            );
        }
        if resolve_runtime_executable("node", &path).is_none() {
            return Err(
                "Claude Agent ACP requires Node.js 22 or newer. Install or upgrade Node.js, then restart Termul."
                    .to_string(),
            );
        }
        if !node_major_is_supported(probe_node_major_async().await) {
            return Err(
                "Claude Agent ACP requires Node.js 22 or newer. Install or upgrade Node.js, then restart Termul."
                    .to_string(),
            );
        }
        Ok(())
    }

    async fn cli_authentication_status(
        &self,
        config_dir: Option<&Path>,
    ) -> Result<Option<bool>, String> {
        let Some(mut command) = claude_cli_command(&["auth", "status"], config_dir)? else {
            return Ok(None);
        };
        command
            .kill_on_drop(true)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let mut child = command
            .spawn()
            .map_err(|_| "could not check Claude CLI authentication".to_string())?;
        let result = tokio::time::timeout(std::time::Duration::from_secs(10), child.wait()).await;
        Ok(match result {
            Ok(Ok(exit)) if exit.success() => Some(true),
            Ok(Ok(exit)) if exit.code() == Some(1) => Some(false),
            _ => None,
        })
    }
}

/// A `claude <args>` command on the login-shell `PATH`, scoped to one Claude
/// config directory (`None` = the host's own). `Ok(None)` when the CLI is not
/// installed.
pub(super) fn claude_cli_command(
    args: &[&str],
    config_dir: Option<&Path>,
) -> Result<Option<tokio::process::Command>, String> {
    let path = crate::acp::config::runtime_resolution_path();
    let Some(cli_path) = resolve_runtime_executable("claude", &path) else {
        return Ok(None);
    };
    let cli = crate::pty::manager::resolve_spawn_program(
        cli_path
            .to_str()
            .ok_or_else(|| "Claude CLI path is not valid Unicode".to_string())?,
    )?;
    let mut command = tokio::process::Command::new(cli.program);
    crate::process_util::hide_console(&mut command);
    command
        .args(cli.prepend_args)
        .args(args)
        .env("PATH", path)
        .env_remove(ANTHROPIC_API_KEY_ENV);
    if let Some(dir) = config_dir {
        command.env(CLAUDE_CONFIG_DIR_ENV, dir);
    }
    Ok(Some(command))
}
