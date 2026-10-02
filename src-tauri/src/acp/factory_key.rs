//! Host-wide Factory Droid credential. Never expose the credential over IPC.
use super::config::AgentConfig;
use super::credentials;
use super::manager::{AcpManager, SessionCreationContext};

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

fn load() -> Result<Option<String>, String> {
    credentials::read_secret(ACCOUNT, "OS keychain contains an empty Factory key")
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
    // A fresh entry must read back the exact credential. No success on a
    // write-only/locked backend; never use an in-process fallback.
    credentials::write_secret(
        ACCOUNT,
        key,
        "Could not save Factory key in OS keychain",
        "Could not verify Factory key in OS keychain",
    )
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
    credentials::open_entry(ACCOUNT)?;
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
mod tests;
