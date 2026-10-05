use super::{
    claude_status, node_major_is_supported, parse_claude_package_entrypoint, parse_node_major,
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
    let store: Arc<dyn ClaudeCredentialStore> = Arc::new(InMemoryClaudeCredentialStore::default());
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
    let store: Arc<dyn ClaudeCredentialStore> = Arc::new(InMemoryClaudeCredentialStore::default());
    let root = std::env::temp_dir().join(format!("termul-claude-auth-{}", uuid::Uuid::new_v4()));
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
    let entrypoint =
        root.join("claude-acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js");
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
