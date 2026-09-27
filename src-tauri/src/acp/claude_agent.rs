//! Host-managed lifecycle for the Claude ACP adapter.

use std::path::PathBuf;
use std::sync::Arc;

const MIN_NODE_MAJOR: u64 = 22;
const CLAUDE_PACKAGE_PREFIX: &str = "@agentclientprotocol/claude-agent-acp@";
const KEYCHAIN_SERVICE: &str = "com.termul.manager";
const API_KEY_ACCOUNT: &str = "acp.claude-agent.api-key";
const AUTH_MODE_ACCOUNT: &str = "acp.claude-agent.auth-mode";
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

pub(crate) fn probe_node_major() -> Option<u64> {
    let path = crate::pty::env_refresh::path_for_resolution()
        .to_string_lossy()
        .into_owned();
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

/// Claude Agent ACP requires Node.js 22 or newer.
pub fn node_major_is_supported(major: Option<u64>) -> bool {
    major.is_some_and(|major| major >= MIN_NODE_MAJOR)
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ClaudeAuthMode {
    ClaudeCode,
    ApiKey,
}

impl Default for ClaudeAuthMode {
    fn default() -> Self {
        Self::ClaudeCode
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
        let path = crate::pty::env_refresh::path_for_resolution()
            .to_string_lossy()
            .into_owned();
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
        if !node_major_is_supported(probe_node_major()) {
            return Err(
                "Claude Agent ACP requires Node.js 22 or newer. Install or upgrade Node.js, then restart Termul."
                    .to_string(),
            );
        }
        Ok(())
    }

    async fn cli_authentication_status(&self) -> Result<Option<bool>, String> {
        let path = crate::pty::env_refresh::path_for_resolution()
            .to_string_lossy()
            .into_owned();
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

/// System keychain adapter. It intentionally does not fall back to files or
/// process memory when the OS keychain is unavailable.
struct SystemClaudeCredentialStore;

impl ClaudeCredentialStore for SystemClaudeCredentialStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        let entry = self.entry(account)?;
        match entry.get_password() {
            Ok(value) if !value.is_empty() => Ok(Some(value)),
            Ok(_) => Err("OS keychain contains an empty Claude credential".to_string()),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("OS keychain unavailable".to_string()),
        }
    }

    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        let entry = self.entry(account)?;
        entry
            .set_password(value)
            .map_err(|_| "Could not save Claude credential in OS keychain".to_string())?;
        if self.get(account)?.as_deref() != Some(value) {
            return Err("Could not verify Claude credential in OS keychain".to_string());
        }
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        let entry = self.entry(account)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("Could not remove Claude credential from OS keychain".to_string()),
        }
    }
}

impl SystemClaudeCredentialStore {
    fn entry(&self, account: &str) -> Result<keyring::Entry, String> {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account)
            .map_err(|_| "OS keychain unavailable".to_string())?;
        // The default backend can degrade to a mock that accepts writes but
        // does not persist them. Reject that backend before reporting success.
        if entry.get_credential().is::<keyring::mock::MockCredential>() {
            return Err("OS keychain unavailable".to_string());
        }
        Ok(entry)
    }
}

/// Safe status shape for desktop settings and local server administration.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAuthStatus {
    pub auth_mode: ClaudeAuthMode,
    pub api_key_configured: bool,
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
        let api_key_configured = self
            .credentials
            .get(API_KEY_ACCOUNT)?
            .is_some_and(|key| !key.is_empty());
        Ok(ClaudeAuthStatus {
            auth_mode,
            api_key_configured,
            cli_installed: false,
            cli_authenticated: None,
        })
    }

    /// Resolve Claude CLI installation and read its documented auth-status
    /// exit code. The CLI's JSON output is discarded and never logged.
    pub async fn setup_status(&self) -> Result<ClaudeAuthStatus, String> {
        let mut status = self.status()?;
        let path = crate::pty::env_refresh::path_for_resolution()
            .to_string_lossy()
            .into_owned();
        status.cli_installed = resolve_runtime_executable("claude", &path).is_some();
        if status.cli_installed {
            status.cli_authenticated = self.runtime_probe.cli_authentication_status().await?;
        }
        Ok(status)
    }

    /// Run Anthropic's interactive `claude auth login` in the caller's
    /// terminal. Termul never installs or updates the external Claude CLI.
    pub fn run_cli_login(&self) -> Result<(), String> {
        let path = crate::pty::env_refresh::path_for_resolution()
            .to_string_lossy()
            .into_owned();
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
            .map_err(|_| "could not start Claude CLI login".to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("Claude CLI login exited with status {status}"))
        }
    }

    pub fn auth_mode(&self) -> Result<ClaudeAuthMode, String> {
        match self.credentials.get(AUTH_MODE_ACCOUNT)?.as_deref() {
            None | Some("claude-code") => Ok(ClaudeAuthMode::ClaudeCode),
            Some("api-key") => Ok(ClaudeAuthMode::ApiKey),
            Some(_) => Err("Claude auth preference is invalid".to_string()),
        }
    }

    pub fn set_auth_mode(&self, mode: ClaudeAuthMode) -> Result<(), String> {
        let value = match mode {
            ClaudeAuthMode::ClaudeCode => "claude-code",
            ClaudeAuthMode::ApiKey => "api-key",
        };
        self.credentials.set(AUTH_MODE_ACCOUNT, value)
    }

    pub fn save_api_key(&self, key: String) -> Result<(), String> {
        if key.trim().is_empty() || key.contains('\0') {
            return Err("A non-empty Claude API key is required".to_string());
        }
        self.credentials.set(API_KEY_ACCOUNT, &key)
    }

    pub fn delete_api_key(&self) -> Result<(), String> {
        self.credentials.delete(API_KEY_ACCOUNT)
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
            return Ok(false);
        }
        self.runtime_probe.ensure_supported().await?;
        match self.auth_mode()? {
            ClaudeAuthMode::ClaudeCode => {
                if self.runtime_probe.cli_authentication_status().await? != Some(true) {
                    return Err(
                        "Claude Code CLI is not signed in. Run `claude auth login`, then retry."
                            .to_string(),
                    );
                }
                config.env.remove(ANTHROPIC_API_KEY_ENV);
                Ok(true)
            }
            ClaudeAuthMode::ApiKey => match self.credentials.get(API_KEY_ACCOUNT)? {
                Some(key) if !key.trim().is_empty() => {
                    config.env.insert(ANTHROPIC_API_KEY_ENV.to_string(), key);
                    Ok(true)
                }
                _ => Err(
                    "Claude API-key authentication is selected, but no API key is saved in the OS keychain."
                        .to_string(),
                ),
            },
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

fn resolve_runtime_executable(command: &str, path: &str) -> Option<PathBuf> {
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
mod tests {
    use super::{
        node_major_is_supported, parse_claude_package_entrypoint, parse_node_major,
        parse_pinned_claude_package, ClaudeAgentService, ClaudeAuthMode, ClaudeCredentialStore,
        ClaudeRuntimeProbe, InMemoryClaudeCredentialStore,
    };
    use crate::acp::config::AgentConfig;
    use std::collections::HashMap;
    use std::sync::Arc;

    struct SupportedRuntime;

    #[async_trait::async_trait]
    impl ClaudeRuntimeProbe for SupportedRuntime {
        async fn ensure_supported(&self) -> Result<(), String> {
            Ok(())
        }

        async fn cli_authentication_status(&self) -> Result<Option<bool>, String> {
            Ok(Some(true))
        }
    }

    struct UnsupportedRuntime;

    #[async_trait::async_trait]
    impl ClaudeRuntimeProbe for UnsupportedRuntime {
        async fn ensure_supported(&self) -> Result<(), String> {
            Err("Claude Agent ACP requires Node.js 22 or newer.".to_string())
        }

        async fn cli_authentication_status(&self) -> Result<Option<bool>, String> {
            Ok(None)
        }
    }

    struct SignedOutRuntime;

    #[async_trait::async_trait]
    impl ClaudeRuntimeProbe for SignedOutRuntime {
        async fn ensure_supported(&self) -> Result<(), String> {
            Ok(())
        }

        async fn cli_authentication_status(&self) -> Result<Option<bool>, String> {
            Ok(Some(false))
        }
    }

    #[test]
    fn parses_supported_node_version_output() {
        assert_eq!(parse_node_major("v22.23.1"), Some(22));
        assert_eq!(parse_node_major("v24.1.0\n"), Some(24));
        assert_eq!(parse_node_major("v20.19.0"), Some(20));
    }

    #[test]
    fn rejects_missing_or_malformed_node_version_output() {
        for output in ["", "node 22", "v22", "not found", "v-1.2.3"] {
            assert_eq!(parse_node_major(output), None, "output: {output:?}");
        }
    }

    #[test]
    fn claude_acp_requires_node_22_or_newer() {
        assert!(!node_major_is_supported(Some(20)));
        assert!(!node_major_is_supported(None));
        assert!(node_major_is_supported(Some(22)));
        assert!(node_major_is_supported(Some(24)));
    }

    #[test]
    fn managed_install_accepts_only_the_exact_claude_package_version() {
        assert_eq!(
            parse_pinned_claude_package("@agentclientprotocol/claude-agent-acp@0.78.0"),
            Some("0.78.0".to_string())
        );
        for package in [
            "@agentclientprotocol/claude-agent-acp",
            "@agentclientprotocol/claude-agent-acp@latest",
            "@agentclientprotocol/claude-agent-acp@^0.78.0",
            "@other/agent@0.78.0",
        ] {
            assert_eq!(parse_pinned_claude_package(package), None, "{package}");
        }
    }

    #[test]
    fn package_entrypoint_must_match_package_version_and_remain_relative() {
        let manifest = r#"{
          "name":"@agentclientprotocol/claude-agent-acp",
          "version":"0.78.0",
          "bin":{"claude-agent-acp":"dist/index.js"}
        }"#;
        assert_eq!(
            parse_claude_package_entrypoint(manifest, "0.78.0"),
            Some(std::path::PathBuf::from("dist/index.js"))
        );
        assert_eq!(parse_claude_package_entrypoint(manifest, "0.79.0"), None);
        for unsafe_path in ["../outside.js", "/tmp/agent.js", r"..\outside.js"] {
            let malicious = manifest.replace("dist/index.js", unsafe_path);
            assert_eq!(
                parse_claude_package_entrypoint(&malicious, "0.78.0"),
                None,
                "entrypoint: {unsafe_path}"
            );
        }
    }

    #[test]
    fn auth_mode_defaults_to_claude_code_and_status_never_contains_the_key() {
        let store: Arc<dyn ClaudeCredentialStore> =
            Arc::new(InMemoryClaudeCredentialStore::default());
        let service =
            ClaudeAgentService::with_adapters(Arc::clone(&store), None, Arc::new(SupportedRuntime));
        assert_eq!(service.auth_mode().unwrap(), ClaudeAuthMode::ClaudeCode);
        service.save_api_key("test-key".to_string()).unwrap();
        service.set_auth_mode(ClaudeAuthMode::ApiKey).unwrap();
        let status = service.status().unwrap();
        assert_eq!(status.auth_mode, ClaudeAuthMode::ApiKey);
        assert!(status.api_key_configured);
        assert!(!serde_json::to_string(&status).unwrap().contains("test-key"));
    }

    #[tokio::test]
    async fn api_key_is_injected_only_for_the_managed_claude_install() {
        let store: Arc<dyn ClaudeCredentialStore> =
            Arc::new(InMemoryClaudeCredentialStore::default());
        let root =
            std::env::temp_dir().join(format!("termul-claude-auth-{}", uuid::Uuid::new_v4()));
        let package_dir = root
            .join("claude-acp")
            .join("node_modules")
            .join("@agentclientprotocol")
            .join("claude-agent-acp");
        std::fs::create_dir_all(package_dir.join("dist")).unwrap();
        std::fs::write(
            package_dir.join("package.json"),
            r#"{
              "name":"@agentclientprotocol/claude-agent-acp",
              "version":"0.78.0",
              "bin":{"claude-agent-acp":"dist/index.js"}
            }"#,
        )
        .unwrap();
        std::fs::write(package_dir.join("dist/index.js"), "mock ACP entrypoint").unwrap();
        let service = ClaudeAgentService::with_adapters(
            Arc::clone(&store),
            Some(root.clone()),
            Arc::new(SupportedRuntime),
        );
        service.save_api_key("test-key".to_string()).unwrap();
        service.set_auth_mode(ClaudeAuthMode::ApiKey).unwrap();
        let entrypoint = root
            .join("claude-acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js");
        let mut managed = AgentConfig {
            config_id: Some("acp-registry:claude-acp".to_string()),
            name: "Claude Agent".to_string(),
            command: "node".to_string(),
            args: vec![entrypoint.to_string_lossy().to_string()],
            env: HashMap::new(),
            allow_terminal: false,
        };

        assert!(
            service.prepare_managed_config(&mut managed).await.unwrap(),
            "a managed API-key config is host-auth-ready after key injection"
        );

        assert_eq!(
            managed.env.get("ANTHROPIC_API_KEY").map(String::as_str),
            Some("test-key")
        );
        service.delete_api_key().unwrap();
        managed.env.clear();
        assert!(
            service.prepare_managed_config(&mut managed).await.is_err(),
            "API-key mode must fail closed when keychain state is empty"
        );
        let unsupported_service = ClaudeAgentService::with_adapters(
            Arc::clone(&store),
            Some(root.clone()),
            Arc::new(UnsupportedRuntime),
        );
        assert_eq!(
            unsupported_service
                .prepare_managed_config(&mut managed)
                .await
                .unwrap_err(),
            "Claude Agent ACP requires Node.js 22 or newer."
        );
        let cli_service = ClaudeAgentService::with_adapters(
            Arc::clone(&store),
            Some(root.clone()),
            Arc::new(SignedOutRuntime),
        );
        cli_service
            .set_auth_mode(ClaudeAuthMode::ClaudeCode)
            .unwrap();
        assert_eq!(
            cli_service
                .prepare_managed_config(&mut managed)
                .await
                .unwrap_err(),
            "Claude Code CLI is not signed in. Run `claude auth login`, then retry."
        );
        let cli_store: Arc<dyn ClaudeCredentialStore> =
            Arc::new(InMemoryClaudeCredentialStore::default());
        let cli_service = ClaudeAgentService::with_adapters(
            cli_store,
            Some(root.clone()),
            Arc::new(SupportedRuntime),
        );
        assert!(
            cli_service
                .prepare_managed_config(&mut managed)
                .await
                .unwrap(),
            "verified Claude Code CLI auth marks the managed config host-auth-ready"
        );

        let mut custom = AgentConfig {
            config_id: Some("acp-registry:claude-acp".to_string()),
            name: "Custom wrapper".to_string(),
            command: "node".to_string(),
            args: vec!["/tmp/custom.js".to_string()],
            env: HashMap::new(),
            allow_terminal: false,
        };
        assert!(
            !service.prepare_managed_config(&mut custom).await.unwrap(),
            "custom configs must not claim host-managed authentication"
        );
        assert!(!custom.env.contains_key("ANTHROPIC_API_KEY"));
        let _ = std::fs::remove_dir_all(root);
    }
}
