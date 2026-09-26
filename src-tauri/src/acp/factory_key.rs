//! Host-wide Factory Droid credential. Never expose the credential over IPC.
use keyring::Entry;

use super::config::AgentConfig;
use super::manager::{AcpManager, SessionCreationContext};

const SERVICE: &str = "com.termul.manager";
const ACCOUNT: &str = "acp.factory-droid.factory-api-key";
const ENV: &str = "FACTORY_API_KEY";

pub(crate) fn is_factory_droid(config: &AgentConfig) -> bool {
    config.config_id.as_deref() == Some("acp-registry:factory-droid")
}

/// Upgrade the catalog's old ACP daemon format. Droid can initialize in that
/// mode, but its child exits during session/new when Termul attaches MCP.
/// Apply at the host boundary so saved configs and remote catalog updates work.
pub(crate) fn normalize_launch_args(config: &mut AgentConfig) {
    if !is_factory_droid(config) || !config.args.iter().any(|arg| arg == "exec") {
        return;
    }
    for index in 1..config.args.len() {
        if config.args[index - 1] == "--output-format" && config.args[index] == "acp-daemon" {
            config.args[index] = "acp".to_string();
        }
    }
}

fn entry() -> Result<Entry, String> {
    let entry = Entry::new(SERVICE, ACCOUNT).map_err(|_| "OS keychain unavailable".to_string())?;
    // keyring's fallback backend accepts writes but never persists them.
    if entry.get_credential().is::<keyring::mock::MockCredential>() {
        return Err("OS keychain unavailable".to_string());
    }
    Ok(entry)
}

fn load() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(key) if !key.is_empty() => Ok(Some(key)),
        Ok(_) => Err("OS keychain contains an empty Factory key".to_string()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("OS keychain unavailable".to_string()),
    }
}

/// Status fails closed: an unavailable/locked keychain is never "configured".
pub fn configured() -> bool {
    match load() {
        Ok(value) => value.is_some(),
        Err(_) => {
            log::warn!("[acp-factory-key] status unavailable (keychain read failed)");
            false
        }
    }
}

/// Called at spawn time only. Existing processes are intentionally unchanged.
pub(crate) fn inject(config: &mut AgentConfig) -> Result<(), String> {
    if is_factory_droid(config) {
        match load() {
            Ok(Some(key)) => {
                config.env.insert(ENV.to_string(), key);
            }
            Ok(None) => {}
            Err(_) => {
                // Secure persistence is unavailable, but browser Login and
                // explicitly configured FACTORY_API_KEY must keep working.
                // Only saving a new host key fails closed.
                log::warn!("[acp-factory-key] keychain read failed; using agent configuration");
            }
        }
    }
    Ok(())
}

fn persist(key: &str) -> Result<(), String> {
    let credential = entry()?;
    credential
        .set_password(key)
        .map_err(|_| "Could not save Factory key in OS keychain".to_string())?;
    // A fresh entry must read back the exact credential. No success on a
    // write-only/locked backend; never use an in-process fallback.
    if entry()?.get_password().ok().as_deref() != Some(key) {
        return Err("Could not verify Factory key in OS keychain".to_string());
    }
    Ok(())
}

/// Validate with an isolated, short-lived ACP process before changing the
/// host credential. All errors are deliberately generic: agents may echo env.
pub async fn validate_and_save(
    manager: &AcpManager,
    mut config: AgentConfig,
    key: String,
) -> Result<(), String> {
    if !is_factory_droid(&config) {
        return Err("Factory Droid config is required".to_string());
    }
    if key.trim().is_empty() || key.contains('\0') {
        return Err("A non-empty Factory API key is required".to_string());
    }
    // Check storage availability before launching a potentially expensive agent.
    entry()?;
    config.env.insert(ENV.to_string(), key.clone());
    let agent = manager.spawn_factory_candidate(config).await.map_err(|_| {
        log::warn!("[acp-factory-key] validation spawn failed");
        "Could not start Factory Droid for validation".to_string()
    })?;
    let result = async {
        if !agent
            .auth_methods
            .iter()
            .any(|method| method.id == "factory-api-key")
        {
            return Err("Factory Droid did not offer API-key authentication".to_string());
        }
        manager
            .authenticate(&agent.agent_id, "factory-api-key".to_string())
            .await
            .map_err(|_| "Factory Droid rejected the API key".to_string())?;
        // Some agents accept authenticate before checking the remote key.
        // An ephemeral session exercises the authenticated path without
        // registering durable history or touching existing sessions.
        let cwd = std::env::current_dir()
            .map_err(|_| "Could not resolve validation directory".to_string())?
            .to_string_lossy()
            .into_owned();
        manager
            .new_session_with_context(
                &agent.agent_id,
                cwd,
                vec![],
                SessionCreationContext {
                    ephemeral: true,
                    ..Default::default()
                },
            )
            .await
            .map_err(|_| "Factory Droid could not create an authenticated session".to_string())?;
        Ok(())
    }
    .await;
    let _ = manager.kill(&agent.agent_id).await;
    result?;
    persist(&key)?;
    log::info!("[acp-factory-key] validated and saved to OS keychain");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn legacy_factory_format_is_upgraded_without_touching_custom_agents() {
        let mut config = AgentConfig {
            config_id: Some("acp-registry:factory-droid".to_string()),
            name: "Factory Droid".to_string(),
            command: "npx".to_string(),
            args: vec![
                "-y".into(),
                "droid@0.218.1".into(),
                "exec".into(),
                "--output-format".into(),
                "acp-daemon".into(),
            ],
            env: HashMap::new(),
            allow_terminal: false,
        };
        normalize_launch_args(&mut config);
        assert_eq!(config.args.last().map(String::as_str), Some("acp"));
        config.config_id = Some("custom-droid".to_string());
        *config.args.last_mut().unwrap() = "acp-daemon".to_string();
        normalize_launch_args(&mut config);
        assert_eq!(config.args.last().map(String::as_str), Some("acp-daemon"));
    }

    #[test]
    fn injection_is_limited_to_exact_factory_identity() {
        let mut config = AgentConfig {
            config_id: Some("custom-droid".to_string()),
            name: "Factory Droid".to_string(),
            command: "droid".to_string(),
            args: vec![],
            env: HashMap::new(),
            allow_terminal: false,
        };
        assert!(!is_factory_droid(&config));
        inject(&mut config).unwrap();
        assert!(!config.env.contains_key(ENV));
        config.config_id = Some("acp-registry:factory-droid".to_string());
        assert!(is_factory_droid(&config));
    }

    #[tokio::test]
    async fn invalid_candidate_never_reaches_keychain_or_agent() {
        let manager = AcpManager::new(vec![]);
        let config = AgentConfig {
            config_id: Some("acp-registry:factory-droid".to_string()),
            name: "Factory Droid".to_string(),
            command: "not-a-real-agent".to_string(),
            args: vec![],
            env: HashMap::new(),
            allow_terminal: false,
        };
        assert!(validate_and_save(&manager, config.clone(), "  ".into())
            .await
            .is_err());
        let mut other = config;
        other.config_id = Some("custom-droid".to_string());
        assert!(validate_and_save(&manager, other, "candidate".into())
            .await
            .is_err());
        assert!(manager.list_agents().is_empty());
    }
}
