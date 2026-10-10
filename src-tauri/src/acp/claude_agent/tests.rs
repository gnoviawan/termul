use super::{
    claude_status, node_major_is_supported, parse_claude_package_entrypoint, parse_node_major,
    parse_pinned_claude_package, ClaudeAgentService, ClaudeAuthMode, ClaudeCredentialStore,
    ClaudeRuntimeProbe, InMemoryClaudeCredentialStore, API_KEY_ACCOUNT, AUTH_MODE_ACCOUNT,
};
use crate::acp::config::AgentConfig;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
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

/// Every operation reports the keychain unavailable — simulates a host with
/// no working Secret Service provider.
struct FailingClaudeCredentialStore;

impl ClaudeCredentialStore for FailingClaudeCredentialStore {
    fn get(&self, _account: &str) -> Result<Option<String>, String> {
        Err("OS keychain unavailable".to_string())
    }
    fn set(&self, _account: &str, _value: &str) -> Result<(), String> {
        Err("OS keychain unavailable".to_string())
    }
    fn delete(&self, _account: &str) -> Result<(), String> {
        Err("OS keychain unavailable".to_string())
    }
}

/// Unique host state dir holding `acp-registry-binaries/` and the
/// `claude-auth-mode` file, mirroring the production layout where the mode
/// file is a sibling of the install root.
struct TempState {
    state_dir: PathBuf,
}

impl TempState {
    fn new() -> Self {
        let state_dir =
            std::env::temp_dir().join(format!("termul-claude-auth-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&state_dir).unwrap();
        Self { state_dir }
    }

    fn install_root(&self) -> PathBuf {
        self.state_dir.join("acp-registry-binaries")
    }

    fn mode_file(&self) -> PathBuf {
        self.state_dir.join("claude-auth-mode")
    }

    /// Write a valid managed claude-acp package under the install root and
    /// return its verified entrypoint path.
    fn managed_entrypoint(&self) -> PathBuf {
        let package_dir = self
            .install_root()
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
        let entrypoint = package_dir.join("dist/index.js");
        std::fs::write(&entrypoint, "mock ACP entrypoint").unwrap();
        entrypoint
    }
}

impl Drop for TempState {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.state_dir);
    }
}

fn managed_config(entrypoint: &Path) -> AgentConfig {
    AgentConfig {
        config_id: Some("acp-registry:claude-acp".to_string()),
        name: "Claude Agent".to_string(),
        command: "node".to_string(),
        args: vec![entrypoint.to_string_lossy().to_string()],
        env: HashMap::new(),
        allow_terminal: false,
    }
}

#[test]
fn parses_supported_node_version_output() {
    assert_eq!(parse_node_major("v22.23.1"), Some(22));
    assert_eq!(parse_node_major("v24.1.0\n"), Some(24));
    assert_eq!(parse_node_major("v20.19.0"), Some(20));
}

fn policy_runtimes(
    node_major: Option<u64>,
    npm: bool,
    claude_cli: bool,
) -> crate::acp::catalog::CatalogRuntimeAvailability {
    crate::acp::catalog::CatalogRuntimeAvailability {
        npx: true,
        uvx: true,
        node: true,
        bun: false,
        python3: true,
        npm,
        node_major,
        claude_cli,
        unavailable_reason: None,
    }
}

/// `claude_status` is the single policy source: Node 22+ + npm + the
/// external CLI, in that evaluation order, with the renderer's copy as
/// the unavailable reason.
#[test]
fn claude_status_is_the_single_policy_source() {
    use crate::acp::catalog::SupportedAcpAgentStatus;
    let (status, reason) = claude_status(
        &policy_runtimes(Some(20), true, true),
        SupportedAcpAgentStatus::InstallRequired,
    );
    assert_eq!(status, SupportedAcpAgentStatus::NeedsRuntime);
    assert_eq!(
            reason,
            Some("Claude Agent ACP requires Node.js 22 or newer. Install or upgrade Node.js, then restart Termul.")
        );

    let (status, reason) = claude_status(
        &policy_runtimes(Some(22), false, true),
        SupportedAcpAgentStatus::InstallRequired,
    );
    assert_eq!(status, SupportedAcpAgentStatus::NeedsRuntime);
    assert_eq!(
            reason,
            Some("Claude Agent ACP requires npm. Install npm alongside Node.js 22 or newer, then restart Termul.")
        );

    let (status, reason) = claude_status(
        &policy_runtimes(Some(22), true, false),
        SupportedAcpAgentStatus::InstallRequired,
    );
    assert_eq!(status, SupportedAcpAgentStatus::ManualInstall);
    assert_eq!(
        reason,
        Some("Install Claude Code CLI from Anthropic, then run `claude auth login` in a terminal.")
    );

    // Clear runtime → the caller's clear-status (catalog: install-required,
    // installed overlay: ready) and no reason.
    let (status, reason) = claude_status(
        &policy_runtimes(Some(22), true, true),
        SupportedAcpAgentStatus::InstallRequired,
    );
    assert_eq!(status, SupportedAcpAgentStatus::InstallRequired);
    assert_eq!(reason, None);
    let (status, reason) = claude_status(
        &policy_runtimes(Some(22), true, true),
        SupportedAcpAgentStatus::Ready,
    );
    assert_eq!(status, SupportedAcpAgentStatus::Ready);
    assert_eq!(reason, None);
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
    let state = TempState::new();
    let store: Arc<dyn ClaudeCredentialStore> = Arc::new(InMemoryClaudeCredentialStore::default());
    let service = ClaudeAgentService::with_adapters(
        Arc::clone(&store),
        Some(state.install_root()),
        Arc::new(SupportedRuntime),
    );
    assert_eq!(service.auth_mode().unwrap(), ClaudeAuthMode::ClaudeCode);
    service.save_api_key("test-key".to_string()).unwrap();
    service.set_auth_mode(ClaudeAuthMode::ApiKey).unwrap();
    let status = service.status().unwrap();
    assert_eq!(status.auth_mode, ClaudeAuthMode::ApiKey);
    assert!(status.api_key_configured);
    assert!(status.keychain_available);
    assert!(!serde_json::to_string(&status).unwrap().contains("test-key"));
}

/// `without_host_state()` services hold no state dir: no mode file is read
/// or written and the mode is always the default.
#[test]
fn without_host_state_uses_default_mode() {
    let store: Arc<dyn ClaudeCredentialStore> = Arc::new(InMemoryClaudeCredentialStore::default());
    store.set(AUTH_MODE_ACCOUNT, "api-key").unwrap();
    let service =
        ClaudeAgentService::with_adapters(store, None, Arc::new(SupportedRuntime));
    assert_eq!(service.auth_mode().unwrap(), ClaudeAuthMode::ClaudeCode);
    assert!(service.set_auth_mode(ClaudeAuthMode::ApiKey).is_err());
}

/// A host with no working keychain still launches the default `claude-code`
/// mode: the mode file is absent, the legacy keychain probe degrades to
/// "unset" (and must NOT persist that default so a recovered keychain can
/// still migrate the true preference), and no key enters the environment.
#[tokio::test]
async fn keychain_unavailable_launches_default_claude_code_mode() {
    let state = TempState::new();
    let entrypoint = state.managed_entrypoint();
    let service = ClaudeAgentService::with_adapters(
        Arc::new(FailingClaudeCredentialStore),
        Some(state.install_root()),
        Arc::new(SupportedRuntime),
    );
    assert_eq!(service.auth_mode().unwrap(), ClaudeAuthMode::ClaudeCode);
    assert!(
        !state.mode_file().exists(),
        "a failed keychain probe must not persist a default mode"
    );

    let mut managed = managed_config(&entrypoint);
    managed
        .env
        .insert("ANTHROPIC_API_KEY".to_string(), "leaked-value".to_string());
    assert!(
        service.prepare_managed_config(&mut managed).await.unwrap(),
        "claude-code mode must launch when the keychain is unavailable"
    );
    assert!(
        !managed.env.contains_key("ANTHROPIC_API_KEY"),
        "claude-code mode strips ANTHROPIC_API_KEY from the environment"
    );
}

/// `api-key` mode with an unreachable keychain fails closed — no plaintext
/// or in-memory fallback for the key.
#[tokio::test]
async fn api_key_mode_fails_closed_when_keychain_unavailable() {
    let state = TempState::new();
    let entrypoint = state.managed_entrypoint();
    let service = ClaudeAgentService::with_adapters(
        Arc::new(FailingClaudeCredentialStore),
        Some(state.install_root()),
        Arc::new(SupportedRuntime),
    );
    // The preference write itself needs no keychain (file-backed).
    service.set_auth_mode(ClaudeAuthMode::ApiKey).unwrap();
    let mut managed = managed_config(&entrypoint);
    let error = service
        .prepare_managed_config(&mut managed)
        .await
        .unwrap_err();
    assert!(
        error.contains("OS keychain unavailable"),
        "error must name the unavailable key state: {error}"
    );
    assert!(!managed.env.contains_key("ANTHROPIC_API_KEY"));
}

/// Legacy hosts whose mode exists only in the keychain get a one-time
/// migration into the mode file; the file is authoritative afterward.
#[test]
fn legacy_keychain_mode_migrates_into_the_mode_file() {
    let state = TempState::new();
    let store: Arc<dyn ClaudeCredentialStore> = Arc::new(InMemoryClaudeCredentialStore::default());
    store.set(AUTH_MODE_ACCOUNT, "api-key").unwrap();
    let service = ClaudeAgentService::with_adapters(
        Arc::clone(&store),
        Some(state.install_root()),
        Arc::new(SupportedRuntime),
    );
    assert_eq!(service.auth_mode().unwrap(), ClaudeAuthMode::ApiKey);
    assert_eq!(
        std::fs::read_to_string(state.mode_file()).unwrap(),
        "api-key",
        "a valid legacy keychain value migrates into the mode file"
    );
    assert_eq!(
        store.get(AUTH_MODE_ACCOUNT).unwrap(),
        None,
        "the migrated legacy keychain entry is removed so a stale value cannot re-migrate"
    );

    // The file is authoritative: a later keychain change or outage cannot
    // move the resolved mode.
    store.set(AUTH_MODE_ACCOUNT, "claude-code").unwrap();
    assert_eq!(service.auth_mode().unwrap(), ClaudeAuthMode::ApiKey);
    let offline = ClaudeAgentService::with_adapters(
        Arc::new(FailingClaudeCredentialStore),
        Some(state.install_root()),
        Arc::new(SupportedRuntime),
    );
    assert_eq!(offline.auth_mode().unwrap(), ClaudeAuthMode::ApiKey);
}

/// An invalid legacy keychain value keeps the historical error and is not
/// migrated into the file.
#[test]
fn invalid_legacy_keychain_mode_errors_without_migrating() {
    let state = TempState::new();
    let store: Arc<dyn ClaudeCredentialStore> = Arc::new(InMemoryClaudeCredentialStore::default());
    store.set(AUTH_MODE_ACCOUNT, "bogus").unwrap();
    let service = ClaudeAgentService::with_adapters(
        store,
        Some(state.install_root()),
        Arc::new(SupportedRuntime),
    );
    assert_eq!(
        service.auth_mode().unwrap_err(),
        "Claude auth preference is invalid"
    );
    assert!(
        !state.mode_file().exists(),
        "an invalid legacy value must not be persisted"
    );
}

/// If the migration write fails (unwritable parent), the read still returns
/// the keychain-derived mode — migration is best-effort. `/proc` rejects
/// file creation even for root.
#[cfg(target_os = "linux")]
#[test]
fn legacy_mode_migration_tolerates_a_failed_file_write() {
    let store: Arc<dyn ClaudeCredentialStore> = Arc::new(InMemoryClaudeCredentialStore::default());
    store.set(AUTH_MODE_ACCOUNT, "api-key").unwrap();
    let service = ClaudeAgentService::with_adapters(
        store,
        Some(PathBuf::from("/proc/self/acp-registry-binaries")),
        Arc::new(SupportedRuntime),
    );
    assert_eq!(service.auth_mode().unwrap(), ClaudeAuthMode::ApiKey);
}

/// File contents are whitespace-tolerant: a trailing newline still parses.
#[test]
fn mode_file_trims_surrounding_whitespace() {
    let state = TempState::new();
    let service = ClaudeAgentService::with_adapters(
        Arc::new(InMemoryClaudeCredentialStore::default()),
        Some(state.install_root()),
        Arc::new(SupportedRuntime),
    );
    std::fs::write(state.mode_file(), "api-key\n").unwrap();
    assert_eq!(service.auth_mode().unwrap(), ClaudeAuthMode::ApiKey);
}

/// A non-UTF-8 (corrupt) mode file is the same invalid-preference error.
#[test]
fn non_utf8_mode_file_is_an_invalid_preference_error() {
    let state = TempState::new();
    let service = ClaudeAgentService::with_adapters(
        Arc::new(InMemoryClaudeCredentialStore::default()),
        Some(state.install_root()),
        Arc::new(SupportedRuntime),
    );
    std::fs::write(state.mode_file(), [0xFF, 0xFE]).unwrap();
    assert_eq!(
        service.auth_mode().unwrap_err(),
        "Claude auth preference is invalid"
    );
}

/// `set_auth_mode` persists the file atomically and clears the legacy
/// keychain account — the file is authoritative once it exists.
#[test]
fn set_auth_mode_writes_file_and_clears_legacy_keychain_account() {
    let state = TempState::new();
    let store: Arc<dyn ClaudeCredentialStore> = Arc::new(InMemoryClaudeCredentialStore::default());
    store.set(AUTH_MODE_ACCOUNT, "claude-code").unwrap();
    let service = ClaudeAgentService::with_adapters(
        Arc::clone(&store),
        Some(state.install_root()),
        Arc::new(SupportedRuntime),
    );
    service.set_auth_mode(ClaudeAuthMode::ApiKey).unwrap();
    assert_eq!(
        std::fs::read_to_string(state.mode_file()).unwrap(),
        "api-key"
    );
    assert_eq!(
        store.get(AUTH_MODE_ACCOUNT).unwrap(),
        None,
        "legacy keychain account is removed once the file exists"
    );
    assert_eq!(service.auth_mode().unwrap(), ClaudeAuthMode::ApiKey);
}

/// A corrupt mode file is the same invalid-preference error as today's
/// invalid keychain value, across every entry point.
#[tokio::test]
async fn corrupt_mode_file_is_an_invalid_preference_error() {
    let state = TempState::new();
    let entrypoint = state.managed_entrypoint();
    let service = ClaudeAgentService::with_adapters(
        Arc::new(InMemoryClaudeCredentialStore::default()),
        Some(state.install_root()),
        Arc::new(SupportedRuntime),
    );
    std::fs::write(state.mode_file(), "bogus-mode").unwrap();
    assert_eq!(
        service.auth_mode().unwrap_err(),
        "Claude auth preference is invalid"
    );
    assert_eq!(
        service.status().unwrap_err(),
        "Claude auth preference is invalid"
    );
    let mut managed = managed_config(&entrypoint);
    assert_eq!(
        service
            .prepare_managed_config(&mut managed)
            .await
            .unwrap_err(),
        "Claude auth preference is invalid"
    );
}

/// `auth status` keeps working on a keychain-less host: mode and CLI fields
/// still report, keychain-derived fields degrade to "unavailable".
#[test]
fn status_reports_keychain_fields_unavailable_when_keychain_is_down() {
    let state = TempState::new();
    let service = ClaudeAgentService::with_adapters(
        Arc::new(FailingClaudeCredentialStore),
        Some(state.install_root()),
        Arc::new(SupportedRuntime),
    );
    let status = service.status().unwrap();
    assert_eq!(status.auth_mode, ClaudeAuthMode::ClaudeCode);
    assert!(!status.api_key_configured);
    assert!(!status.keychain_available);

    // A file-backed mode still reports correctly with no keychain.
    service.set_auth_mode(ClaudeAuthMode::ApiKey).unwrap();
    let status = service.status().unwrap();
    assert_eq!(status.auth_mode, ClaudeAuthMode::ApiKey);
    assert!(!status.api_key_configured);
    assert!(!status.keychain_available);
}

#[tokio::test]
async fn api_key_is_injected_only_for_the_managed_claude_install() {
    let state = TempState::new();
    let entrypoint = state.managed_entrypoint();
    let store: Arc<dyn ClaudeCredentialStore> = Arc::new(InMemoryClaudeCredentialStore::default());
    let service = ClaudeAgentService::with_adapters(
        Arc::clone(&store),
        Some(state.install_root()),
        Arc::new(SupportedRuntime),
    );
    service.save_api_key("test-key".to_string()).unwrap();
    service.set_auth_mode(ClaudeAuthMode::ApiKey).unwrap();
    let mut managed = managed_config(&entrypoint);

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
    // An empty stored key is also fail-closed.
    store.set(API_KEY_ACCOUNT, "  ").unwrap();
    assert!(
        service.prepare_managed_config(&mut managed).await.is_err(),
        "API-key mode must fail closed when the stored key is empty"
    );
    store.delete(API_KEY_ACCOUNT).unwrap();
    let unsupported_service = ClaudeAgentService::with_adapters(
        Arc::clone(&store),
        Some(state.install_root()),
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
        Some(state.install_root()),
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
        Some(state.install_root()),
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
}
