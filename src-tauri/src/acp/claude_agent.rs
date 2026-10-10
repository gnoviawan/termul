//! Host-managed lifecycle for the Claude ACP adapter.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::atomic_file;
use super::config::resolve_runtime_executable;
use super::credentials;

const MIN_NODE_MAJOR: u64 = 22;
const CLAUDE_PACKAGE_PREFIX: &str = "@agentclientprotocol/claude-agent-acp@";
const API_KEY_ACCOUNT: &str = "acp.claude-agent.api-key";
/// Legacy keychain account for the auth-mode preference. Kept for one-time
/// migration reads; the mode file is authoritative once it exists.
const AUTH_MODE_ACCOUNT: &str = "acp.claude-agent.auth-mode";
/// Non-secret auth-mode preference file in the host state dir (sibling of
/// `acp-registry-binaries`). Not a secret — it must not live in the keychain,
/// or hosts without a working keychain cannot even launch `claude-code` mode.
const AUTH_MODE_FILE_NAME: &str = "claude-auth-mode";
const ANTHROPIC_API_KEY_ENV: &str = "ANTHROPIC_API_KEY";

/// Extract the major version from Node's canonical `vMAJOR.MINOR.PATCH` output.
pub fn parse_node_major(output: &str) -> Option<u64> {
    let version = output.trim().strip_prefix('v')?;
    let (major, rest) = version.split_once('.')?;
    if rest.is_empty() || major.is_empty() || !major.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    major.parse().ok()
}

/// Process-lifetime cache for the Node major-version probe (mirrors the
/// `FRESH_PATH_CACHE` pattern in `pty::env_refresh`): catalog resolution and
/// managed-config preflights probe repeatedly, and `node --version` spawns a
/// process each time. A host that installs or upgrades Node must restart
/// Termul to re-probe — the same tradeoff the cached PATH probe already makes.
static NODE_MAJOR_CACHE: std::sync::OnceLock<Option<u64>> = std::sync::OnceLock::new();

pub(crate) fn probe_node_major() -> Option<u64> {
    *NODE_MAJOR_CACHE.get_or_init(probe_node_major_uncached)
}

fn probe_node_major_uncached() -> Option<u64> {
    let path = super::config::runtime_resolution_path();
    let node = resolve_runtime_executable("node", &path)?;
    let mut child = std::process::Command::new(node)
        .arg("--version")
        .env("PATH", path)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let output_reader = std::thread::spawn(move || {
        use std::io::Read;
        let mut output = Vec::with_capacity(64);
        stdout.take(1024).read_to_end(&mut output).ok()?;
        Some(output)
    });
    let started = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < std::time::Duration::from_secs(5) => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Ok(None) | Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = output_reader.join();
                return None;
            }
        }
    };
    if !status.success() {
        let _ = output_reader.join();
        return None;
    }
    let output = output_reader.join().ok()??;
    parse_node_major(std::str::from_utf8(&output).ok()?)
}

/// Async wrapper around the (cached) blocking Node probe: runs on the tokio
/// blocking pool so a hung `node` process cannot stall an async caller beyond
/// the existing 5-second cap.
pub(crate) async fn probe_node_major_async() -> Option<u64> {
    tokio::task::spawn_blocking(probe_node_major)
        .await
        .ok()
        .flatten()
}

/// Claude Agent ACP requires Node.js 22 or newer.
pub fn node_major_is_supported(major: Option<u64>) -> bool {
    major.is_some_and(|major| major >= MIN_NODE_MAJOR)
}

/// Why the Claude ACP runtime is unavailable, evaluated in preflight order
/// (Node.js → npm → external Claude CLI).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ClaudeRuntimeBlock {
    NodeTooOld,
    NpmMissing,
    CliMissing,
}

/// The single Claude ACP runtime-availability policy: Node.js 22+ with npm,
/// plus the external Claude Code CLI. `compute_catalog_agent`,
/// `overlay_installed`, and the install preflight all route through here so
/// the three previously-drifting copies cannot disagree.
pub(crate) fn claude_runtime_block(
    node_major: Option<u64>,
    npm: bool,
    claude_cli: bool,
) -> Option<ClaudeRuntimeBlock> {
    if !node_major_is_supported(node_major) {
        Some(ClaudeRuntimeBlock::NodeTooOld)
    } else if !npm {
        Some(ClaudeRuntimeBlock::NpmMissing)
    } else if !claude_cli {
        Some(ClaudeRuntimeBlock::CliMissing)
    } else {
        None
    }
}

/// Human-readable reason for a blocked Claude ACP runtime, matching the copy
/// the renderer renders for the same conditions.
pub(crate) fn claude_unavailable_reason(block: ClaudeRuntimeBlock) -> &'static str {
    match block {
        ClaudeRuntimeBlock::NodeTooOld => {
            "Claude Agent ACP requires Node.js 22 or newer. Install or upgrade Node.js, then restart Termul."
        }
        ClaudeRuntimeBlock::NpmMissing => {
            "Claude Agent ACP requires npm. Install npm alongside Node.js 22 or newer, then restart Termul."
        }
        ClaudeRuntimeBlock::CliMissing => {
            "Install Claude Code CLI from Anthropic, then run `claude auth login` in a terminal."
        }
    }
}

/// The single policy source for the Claude ACP catalog status. Returns the
/// 5-state catalog status plus, when blocked, the human-readable
/// `unavailableReason`. `clear_status` distinguishes the catalog view
/// (not yet installed → `InstallRequired`) from the installed overlay
/// (host-installed → `Ready`).
pub fn claude_status(
    runtimes: &crate::acp::catalog::CatalogRuntimeAvailability,
    clear_status: crate::acp::catalog::SupportedAcpAgentStatus,
) -> (
    crate::acp::catalog::SupportedAcpAgentStatus,
    Option<&'static str>,
) {
    use crate::acp::catalog::SupportedAcpAgentStatus;
    match claude_runtime_block(
        runtimes.node_major,
        runtimes.npm,
        runtimes.claude_cli,
    ) {
        None => (clear_status, None),
        Some(
            block @ (ClaudeRuntimeBlock::NodeTooOld | ClaudeRuntimeBlock::NpmMissing),
        ) => (SupportedAcpAgentStatus::NeedsRuntime, Some(claude_unavailable_reason(block))),
        Some(block @ ClaudeRuntimeBlock::CliMissing) => (
            SupportedAcpAgentStatus::ManualInstall,
            Some(claude_unavailable_reason(block)),
        ),
    }
}

/// Return the exact semantic version from the supported Claude ACP package
/// spec. Tags and version ranges are rejected so managed installs are pinned.
pub fn parse_pinned_claude_package(package: &str) -> Option<String> {
    let version = package.strip_prefix(CLAUDE_PACKAGE_PREFIX)?;
    let mut parts = version.split('.');
    let major = parts.next()?;
    let minor = parts.next()?;
    let patch = parts.next()?;
    if parts.next().is_some()
        || [major, minor, patch]
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return None;
    }
    Some(version.to_string())
}

/// Validate the installed npm manifest and return its CLI entrypoint relative
/// to the package directory. Only the official executable and package version
/// selected by the trusted catalog are accepted.
pub fn parse_claude_package_entrypoint(manifest: &str, expected_version: &str) -> Option<PathBuf> {
    let value: serde_json::Value = serde_json::from_str(manifest).ok()?;
    if value.get("name")?.as_str()? != "@agentclientprotocol/claude-agent-acp"
        || value.get("version")?.as_str()? != expected_version
    {
        return None;
    }
    let entrypoint = value.get("bin")?.get("claude-agent-acp")?.as_str()?;
    if entrypoint.is_empty()
        || entrypoint.starts_with('/')
        || entrypoint.starts_with('\\')
        || entrypoint
            .chars()
            .any(|character| matches!(character, ':' | '\\'))
    {
        return None;
    }
    let path = PathBuf::from(entrypoint);
    if path
        .components()
        .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return None;
    }
    Some(path)
}

/// Host-wide authentication choice for Claude Agent ACP.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ClaudeAuthMode {
    #[default]
    ClaudeCode,
    ApiKey,
}

/// Parse the stored preference value (the same `claude-code`/`api-key`
/// strings used by the legacy keychain account). Anything else is a corrupt
/// preference and fails with the historical invalid-preference error.
fn parse_auth_mode(value: &str) -> Result<ClaudeAuthMode, String> {
    match value {
        "claude-code" => Ok(ClaudeAuthMode::ClaudeCode),
        "api-key" => Ok(ClaudeAuthMode::ApiKey),
        _ => Err("Claude auth preference is invalid".to_string()),
    }
}

/// Secret-store interface used by the Claude lifecycle module.
trait ClaudeCredentialStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, value: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

#[async_trait::async_trait]
trait ClaudeRuntimeProbe: Send + Sync {
    async fn ensure_supported(&self) -> Result<(), String>;
    async fn cli_authentication_status(&self) -> Result<Option<bool>, String>;
}

struct SystemClaudeRuntimeProbe;

#[async_trait::async_trait]
impl ClaudeRuntimeProbe for SystemClaudeRuntimeProbe {
    async fn ensure_supported(&self) -> Result<(), String> {
        let path = super::config::runtime_resolution_path();
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

    async fn cli_authentication_status(&self) -> Result<Option<bool>, String> {
        let path = super::config::runtime_resolution_path();
        let Some(cli_path) = resolve_runtime_executable("claude", &path) else {
            return Ok(None);
        };
        let cli = crate::pty::manager::resolve_spawn_program(
            cli_path
                .to_str()
                .ok_or_else(|| "Claude CLI path is not valid Unicode".to_string())?,
        )?;
        let mut command = tokio::process::Command::new(cli.program);
        command
            .args(cli.prepend_args)
            .args(["auth", "status"])
            .env("PATH", path)
            .env_remove(ANTHROPIC_API_KEY_ENV)
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

/// System keychain adapter over the shared ACP credentials plumbing. It
/// intentionally does not fall back to files or process memory when the OS
/// keychain is unavailable.
struct SystemClaudeCredentialStore;

impl ClaudeCredentialStore for SystemClaudeCredentialStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        credentials::read_secret(account, "OS keychain contains an empty Claude credential")
    }

    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        credentials::write_secret(
            account,
            value,
            "Could not save Claude credential in OS keychain",
            "Could not verify Claude credential in OS keychain",
        )
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        credentials::delete_secret(
            account,
            "Could not remove Claude credential from OS keychain",
        )
    }
}

/// Safe status shape for desktop settings and local server administration.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAuthStatus {
    pub auth_mode: ClaudeAuthMode,
    pub api_key_configured: bool,
    /// `false` when the OS keychain could not be probed at all — key-derived
    /// fields (`api_key_configured`) then report "unavailable" rather than
    /// erroring the whole status read.
    pub keychain_available: bool,
    pub cli_installed: bool,
    pub cli_authenticated: Option<bool>,
}

/// Shared host-wide Claude auth manager. Browser remotes receive no management
/// commands, but spawned managed Claude agents use the same host keychain.
pub struct ClaudeAgentService {
    credentials: Arc<dyn ClaudeCredentialStore>,
    install_root: Option<PathBuf>,
    runtime_probe: Arc<dyn ClaudeRuntimeProbe>,
}

impl ClaudeAgentService {
    #[must_use]
    pub fn system(install_root: PathBuf) -> Self {
        Self::new_with_runtime(
            Arc::new(SystemClaudeCredentialStore),
            Some(install_root),
            Arc::new(SystemClaudeRuntimeProbe),
        )
    }

    #[must_use]
    pub fn without_host_state() -> Self {
        Self::new_with_runtime(
            Arc::new(SystemClaudeCredentialStore),
            None,
            Arc::new(SystemClaudeRuntimeProbe),
        )
    }

    #[cfg(test)]
    #[must_use]
    fn with_adapters(
        credentials: Arc<dyn ClaudeCredentialStore>,
        install_root: Option<PathBuf>,
        runtime_probe: Arc<dyn ClaudeRuntimeProbe>,
    ) -> Self {
        Self::new_with_runtime(credentials, install_root, runtime_probe)
    }

    fn new_with_runtime(
        credentials: Arc<dyn ClaudeCredentialStore>,
        install_root: Option<PathBuf>,
        runtime_probe: Arc<dyn ClaudeRuntimeProbe>,
    ) -> Self {
        Self {
            credentials,
            install_root,
            runtime_probe,
        }
    }

    pub fn status(&self) -> Result<ClaudeAuthStatus, String> {
        let auth_mode = self.auth_mode()?;
        // A missing/unavailable keychain degrades the key-derived fields
        // instead of erroring, so headless operators can still inspect the
        // auth mode and CLI state.
        let (api_key_configured, keychain_available) =
            match self.credentials.get(API_KEY_ACCOUNT) {
                Ok(key) => (key.is_some_and(|key| !key.trim().is_empty()), true),
                Err(error) => {
                    log::warn!("[acp-claude] keychain probe failed; reporting unavailable: {error}");
                    (false, false)
                }
            };
        Ok(ClaudeAuthStatus {
            auth_mode,
            api_key_configured,
            keychain_available,
            cli_installed: false,
            cli_authenticated: None,
        })
    }

    /// Resolve Claude CLI installation and read its documented auth-status
    /// exit code. The CLI's JSON output is discarded and never logged.
    pub async fn setup_status(&self) -> Result<ClaudeAuthStatus, String> {
        let mut status = self.status()?;
        let path = super::config::runtime_resolution_path();
        status.cli_installed = resolve_runtime_executable("claude", &path).is_some();
        if status.cli_installed {
            status.cli_authenticated = self.runtime_probe.cli_authentication_status().await?;
        }
        Ok(status)
    }

    /// Run Anthropic's interactive `claude auth login` in the caller's
    /// terminal. Termul never installs or updates the external Claude CLI.
    pub fn run_cli_login(&self) -> Result<(), String> {
        let path = super::config::runtime_resolution_path();
        let cli_path = resolve_runtime_executable("claude", &path)
            .ok_or_else(|| "Claude Code CLI is not installed or is not on PATH".to_string())?;
        let cli = crate::pty::manager::resolve_spawn_program(
            cli_path
                .to_str()
                .ok_or_else(|| "Claude CLI path is not valid Unicode".to_string())?,
        )?;
        let status = std::process::Command::new(cli.program)
            .args(cli.prepend_args)
            .args(["auth", "login"])
            .env("PATH", path)
            .env_remove(ANTHROPIC_API_KEY_ENV)
            .stdin(std::process::Stdio::inherit())
            .stdout(std::process::Stdio::inherit())
            .stderr(std::process::Stdio::inherit())
            .status()
            .map_err(|error| {
                log::warn!("[acp-claude] CLI login could not start: {error}");
                "could not start Claude CLI login".to_string()
            })?;
        if status.success() {
            Ok(())
        } else {
            log::warn!("[acp-claude] CLI login exited with status {status}");
            Err(format!("Claude CLI login exited with status {status}"))
        }
    }

    /// The non-secret auth-mode preference file: `<state dir>/claude-auth-mode`,
    /// a sibling of the `acp-registry-binaries` install root. `None` for
    /// `without_host_state()` services, which always run the default mode.
    fn mode_file_path(&self) -> Option<PathBuf> {
        Some(
            self.install_root
                .as_ref()?
                .parent()?
                .join(AUTH_MODE_FILE_NAME),
        )
    }

    /// Resolve the auth mode from the host-state preference file. When the
    /// file is absent, fall back to the legacy keychain account once and
    /// migrate a valid value into the file; a keychain read failure there is
    /// treated as unset (default `claude-code`, not persisted) so a recovered
    /// keychain can still migrate the true preference.
    pub fn auth_mode(&self) -> Result<ClaudeAuthMode, String> {
        let Some(path) = self.mode_file_path() else {
            return Ok(ClaudeAuthMode::ClaudeCode);
        };
        match std::fs::read_to_string(&path) {
            Ok(contents) => match parse_auth_mode(contents.trim()) {
                Ok(mode) => Ok(mode),
                Err(error) => {
                    log::warn!(
                        "[acp-claude] invalid auth mode file content path={} error={error}",
                        path.display()
                    );
                    Err(error)
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.legacy_auth_mode(&path)
            }
            Err(error) => {
                log::warn!(
                    "[acp-claude] auth mode file read failed path={} error={error}",
                    path.display()
                );
                if error.kind() == std::io::ErrorKind::InvalidData {
                    Err("Claude auth preference is invalid".to_string())
                } else {
                    Err("Could not read Claude auth preference".to_string())
                }
            }
        }
    }

    /// One-time fallback for hosts whose preference predates the mode file:
    /// read the legacy keychain account, migrate a valid value into the file
    /// (the file is authoritative afterward), and treat a keychain failure as
    /// unset without persisting that default.
    fn legacy_auth_mode(&self, path: &Path) -> Result<ClaudeAuthMode, String> {
        match self.credentials.get(AUTH_MODE_ACCOUNT) {
            Ok(Some(value)) => {
                let value = value.trim();
                let mode = match parse_auth_mode(value) {
                    Ok(mode) => mode,
                    Err(error) => {
                        log::warn!(
                            "[acp-claude] legacy auth mode keychain account {AUTH_MODE_ACCOUNT} is invalid: {error}"
                        );
                        return Err(error);
                    }
                };
                // Migrate create-if-absent: a concurrent `set_auth_mode` may
                // have written the file since the caller observed it absent.
                // The file is authoritative once it exists, so the migration
                // write must fail rather than clobber it.
                match atomic_file::create_new(path, value.as_bytes()) {
                    Ok(()) => {
                        log::info!(
                            "[acp-claude] auth mode migrated from OS keychain to {}",
                            path.display()
                        );
                        // The file is now authoritative; drop the legacy
                        // keychain value so a stale entry cannot re-migrate.
                        if let Err(error) = self.credentials.delete(AUTH_MODE_ACCOUNT) {
                            log::warn!(
                                "[acp-claude] legacy auth mode keychain cleanup failed: {error}"
                            );
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                        // A concurrent writer won — resolve through the now-
                        // existing file (parse, or its invalid-content error).
                        return self.auth_mode();
                    }
                    Err(error) => log::warn!(
                        "[acp-claude] auth mode migration write failed path={} error={error}",
                        path.display()
                    ),
                }
                Ok(mode)
            }
            Ok(None) => Ok(ClaudeAuthMode::ClaudeCode),
            Err(error) => {
                log::warn!(
                    "[acp-claude] auth mode keychain probe failed; using default: {error}"
                );
                Ok(ClaudeAuthMode::ClaudeCode)
            }
        }
    }

    /// Persist the auth mode to the host-state file (atomic replace), then
    /// best-effort delete the legacy keychain account — the file is
    /// authoritative once it exists.
    pub fn set_auth_mode(&self, mode: ClaudeAuthMode) -> Result<(), String> {
        let value = match mode {
            ClaudeAuthMode::ClaudeCode => "claude-code",
            ClaudeAuthMode::ApiKey => "api-key",
        };
        let Some(path) = self.mode_file_path() else {
            return Err("Could not save Claude auth preference".to_string());
        };
        let result = atomic_file::replace(&path, value.as_bytes()).map_err(|error| {
            log::warn!(
                "[acp-claude] auth mode write failed path={} error={error}",
                path.display()
            );
            "Could not save Claude auth preference".to_string()
        });
        match &result {
            Ok(()) => {
                log::info!("[acp-claude] auth mode set to {value}");
                if let Err(error) = self.credentials.delete(AUTH_MODE_ACCOUNT) {
                    log::warn!(
                        "[acp-claude] legacy auth mode keychain cleanup failed: {error}"
                    );
                }
            }
            Err(error) => log::warn!("[acp-claude] auth mode set to {value} failed: {error}"),
        }
        result
    }

    pub fn save_api_key(&self, key: String) -> Result<(), String> {
        if key.trim().is_empty() || key.contains('\0') {
            return Err("A non-empty Claude API key is required".to_string());
        }
        let result = self.credentials.set(API_KEY_ACCOUNT, &key);
        match &result {
            // Counts only — never log the key itself.
            Ok(()) => log::info!("[acp-claude] API key saved to OS keychain (1 key)"),
            Err(error) => log::warn!("[acp-claude] API key save failed: {error}"),
        }
        result
    }

    pub fn delete_api_key(&self) -> Result<(), String> {
        let result = self.credentials.delete(API_KEY_ACCOUNT);
        match &result {
            Ok(()) => log::info!("[acp-claude] API key deleted from OS keychain (0 keys left)"),
            Err(error) => log::warn!("[acp-claude] API key delete failed: {error}"),
        }
        result
    }

    /// Prepare host authentication only for a verified host-installed Claude
    /// ACP entrypoint. Returns `true` when the host validated/prepared auth and
    /// `false` for every other config. Missing keychain state fails closed;
    /// custom or legacy configs never receive the credential.
    pub async fn prepare_managed_config(
        &self,
        config: &mut crate::acp::config::AgentConfig,
    ) -> Result<bool, String> {
        if !self.is_managed_config(config) {
            // A config that claims the managed claude-acp identity but fails
            // verification is a security-relevant boundary — log it. Custom
            // agents merely pass through silently.
            if config.config_id.as_deref() == Some("acp-registry:claude-acp") {
                log::warn!(
                    "[acp-claude] config claims the managed claude-acp identity but failed host verification; treating as unmanaged"
                );
            }
            return Ok(false);
        }
        if let Err(reason) = self.runtime_probe.ensure_supported().await {
            log::warn!("[acp-claude] managed config rejected: {reason}");
            return Err(reason);
        }
        match self.auth_mode() {
            Ok(ClaudeAuthMode::ClaudeCode) => {
                match self.runtime_probe.cli_authentication_status().await {
                    Ok(Some(true)) => {}
                    Ok(status) => {
                        log::warn!(
                            "[acp-claude] managed config rejected: Claude Code CLI not signed in (status={status:?})"
                        );
                        return Err(
                            "Claude Code CLI is not signed in. Run `claude auth login`, then retry."
                                .to_string(),
                        );
                    }
                    Err(error) => {
                        log::warn!("[acp-claude] managed config rejected: {error}");
                        return Err(error);
                    }
                }
                config.env.remove(ANTHROPIC_API_KEY_ENV);
                Ok(true)
            }
            Ok(ClaudeAuthMode::ApiKey) => match self.credentials.get(API_KEY_ACCOUNT) {
                Ok(Some(key)) if !key.trim().is_empty() => {
                    config.env.insert(ANTHROPIC_API_KEY_ENV.to_string(), key);
                    Ok(true)
                }
                Ok(_) => {
                    log::warn!(
                        "[acp-claude] managed config rejected: API-key mode selected but the OS keychain holds no API key"
                    );
                    Err(
                        "Claude API-key authentication is selected, but no API key is saved in the OS keychain."
                            .to_string(),
                    )
                }
                Err(error) => {
                    log::warn!("[acp-claude] managed config rejected: {error}");
                    Err(error)
                }
            },
            Err(error) => {
                log::warn!("[acp-claude] managed config rejected: {error}");
                Err(error)
            }
        }
    }

    fn is_managed_config(&self, config: &crate::acp::config::AgentConfig) -> bool {
        let Some(install_root) = &self.install_root else {
            return false;
        };
        if config.config_id.as_deref() != Some("acp-registry:claude-acp")
            || config.command != "node"
            || config.args.len() != 1
        {
            return false;
        }
        let package_dir = install_root
            .join("claude-acp")
            .join("node_modules")
            .join("@agentclientprotocol")
            .join("claude-agent-acp");
        let Ok(manifest) = std::fs::read_to_string(package_dir.join("package.json")) else {
            return false;
        };
        let Some(version) = serde_json::from_str::<serde_json::Value>(&manifest)
            .ok()
            .and_then(|value| value.get("version")?.as_str().map(str::to_string))
        else {
            return false;
        };
        let Some(entrypoint) = parse_claude_package_entrypoint(&manifest, &version) else {
            return false;
        };
        let Some((package_root, expected, actual)) = std::fs::canonicalize(&package_dir)
            .ok()
            .zip(std::fs::canonicalize(package_dir.join(entrypoint)).ok())
            .zip(std::fs::canonicalize(&config.args[0]).ok())
            .map(|((root, expected), actual)| (root, expected, actual))
        else {
            return false;
        };
        actual.starts_with(&package_root) && expected == actual
    }
}

#[cfg(test)]
#[derive(Default)]
pub struct InMemoryClaudeCredentialStore {
    values: parking_lot::Mutex<std::collections::HashMap<String, String>>,
}

#[cfg(test)]
impl ClaudeCredentialStore for InMemoryClaudeCredentialStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        Ok(self.values.lock().get(account).cloned())
    }

    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        self.values
            .lock()
            .insert(account.to_string(), value.to_string());
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        self.values.lock().remove(account);
        Ok(())
    }
}

#[cfg(test)]
mod tests;
