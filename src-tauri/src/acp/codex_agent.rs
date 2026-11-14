//! Host-managed Codex homes for the catalog Codex ACP agent
//! (`acp-registry:codex-acp`).
//!
//! A Project's Account chooses the `CODEX_HOME` of that spawn. An absolute
//! `CODEX_HOME` in the project env wins, then the linked Account directory,
//! then the host home with the variable unset. ChatGPT-login mode strips
//! `OPENAI_API_KEY` and `CODEX_ACCESS_TOKEN`. The Codex CLI must already see
//! the home as a directory, so the directory is created before `codex login
//! status` and before the agent process starts.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use usage::UsageCache;

use super::codex_accounts::{
    signed_out_error, AccountResolution, CodexAccountStore, BUILTIN_ACCOUNT_ID,
};
use super::commands::{codex_login_status, CodexLoginProbe as CodexLoginState};
use super::config::AgentConfig;

/// Catalog id of the managed Codex ACP agent.
pub const CODEX_ACP_CONFIG_ID: &str = "acp-registry:codex-acp";
/// Codex home override. Unset means the host default (`~/.codex`).
pub const CODEX_HOME_ENV: &str = "CODEX_HOME";
const OPENAI_API_KEY_ENV: &str = "OPENAI_API_KEY";
const CODEX_ACCESS_TOKEN_ENV: &str = "CODEX_ACCESS_TOKEN";
/// Set on the agent env only as a signal to the spawn path. The child
/// command removes this name and the two credential names from its own
/// environment, including values inherited from the host process.
pub(crate) const STRIP_CODEX_API_CREDENTIALS: &str = "TERMUL_STRIP_CODEX_API_CREDENTIALS";

/// Which setting chose the Codex home of a managed agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HomeSource {
    /// The host's own Codex home. The spawn leaves `CODEX_HOME` unset.
    Host,
    /// The directory of the Project's linked Codex Account.
    Linked,
    /// An explicit absolute `CODEX_HOME` in the agent env.
    ProjectEnv,
}

impl HomeSource {
    fn label(self) -> &'static str {
        match self {
            Self::Host => "host",
            Self::Linked => "linked",
            Self::ProjectEnv => "project env",
        }
    }
}

/// The `CODEX_HOME` a managed Codex agent runs with. `None` is the host home
/// (the variable is removed). A blank env value counts as unset. A value that
/// is not absolute, after a leading `~` expands to `home`, is ignored.
fn effective_home(
    env: &HashMap<String, String>,
    linked_dir: Option<&Path>,
    home: Option<&Path>,
) -> (Option<PathBuf>, HomeSource) {
    if let Some(value) = env.get(CODEX_HOME_ENV).filter(|dir| !dir.trim().is_empty()) {
        match absolute_home(value, home) {
            Some(dir) => return (Some(dir), HomeSource::ProjectEnv),
            None => log::warn!(
                "[acp-codex] the project env CODEX_HOME is not an absolute path and was ignored"
            ),
        }
    }
    match linked_dir {
        Some(dir) => (Some(dir.to_path_buf()), HomeSource::Linked),
        None => (None, HomeSource::Host),
    }
}

/// Expand a leading `~` to `home`, then keep the result only when absolute.
fn absolute_home(value: &str, home: Option<&Path>) -> Option<PathBuf> {
    let is_separator = |c: char| c == '/' || (cfg!(windows) && c == '\\');
    let path = match value.strip_prefix('~') {
        Some("") => home?.to_path_buf(),
        Some(rest) if rest.starts_with(is_separator) => {
            home?.join(rest.trim_start_matches(is_separator))
        }
        _ => PathBuf::from(value),
    };
    path.is_absolute().then_some(path)
}

#[async_trait::async_trait]
pub(crate) trait CodexLoginStatus: Send + Sync {
    async fn login_status(
        &self,
        codex_home: Option<&Path>,
        codex_bin: Option<&str>,
        project_path: Option<&str>,
    ) -> Result<Option<bool>, String>;

    /// Best-effort `codex logout` for one home. The default does nothing so a
    /// test probe can ignore sign-out.
    async fn logout(&self, _codex_home: Option<&Path>) -> Result<(), String> {
        Ok(())
    }
}

struct SystemCodexLoginProbe;

#[async_trait::async_trait]
impl CodexLoginStatus for SystemCodexLoginProbe {
    async fn login_status(
        &self,
        codex_home: Option<&Path>,
        codex_bin: Option<&str>,
        project_path: Option<&str>,
    ) -> Result<Option<bool>, String> {
        let home = match codex_home {
            Some(dir) => Some(dir.to_str().ok_or_else(|| {
                log::warn!("[acp-codex] account home is not valid Unicode");
                "The Codex account folder path is not supported".to_string()
            })?),
            None => None,
        };
        Ok(
            match codex_login_status(home.map(str::to_string), codex_bin, project_path).await {
                CodexLoginState::SignedIn => Some(true),
                CodexLoginState::SignedOut => Some(false),
                CodexLoginState::Unavailable => None,
            },
        )
    }

    async fn logout(&self, codex_home: Option<&Path>) -> Result<(), String> {
        let home = match codex_home {
            Some(dir) => Some(dir.to_str().ok_or_else(|| {
                log::warn!("[acp-codex] account home is not valid Unicode");
                "The Codex account folder path is not supported".to_string()
            })?),
            None => None,
        };
        super::commands::codex_logout(home.map(str::to_string)).await
    }
}

/// Shared host-wide Codex Account service. Spawn preparation is active only
/// for a service built with [`CodexAgentService::system`]. Test managers use
/// [`CodexAgentService::without_host_state`] and leave Codex spawns unchanged.
pub struct CodexAgentService {
    active: bool,
    profile_store: Option<Arc<CodexAccountStore>>,
    login_probe: Arc<dyn CodexLoginStatus>,
    usage_cache: UsageCache,
    usage_probe: Arc<dyn usage::CodexUsageProbe>,
}

impl CodexAgentService {
    /// Account store under the parent of `install_root` (the host state dir),
    /// linking Account directories to the host Codex home.
    #[must_use]
    pub fn system(install_root: PathBuf) -> Self {
        let store = install_root
            .parent()
            .zip(CodexAccountStore::host_shared_dir())
            .map(|(state_dir, shared)| Arc::new(CodexAccountStore::new(state_dir, shared)));
        if store.is_none() {
            log::warn!(
                "[codex-accounts] no home directory; only the built-in account is available"
            );
        }
        Self::assemble(true, store, Arc::new(SystemCodexLoginProbe))
    }

    /// A service that does not select a Codex home. Used by unit-test managers.
    #[must_use]
    pub fn without_host_state() -> Self {
        Self::assemble(false, None, Arc::new(SystemCodexLoginProbe))
    }

    fn assemble(
        active: bool,
        profile_store: Option<Arc<CodexAccountStore>>,
        login_probe: Arc<dyn CodexLoginStatus>,
    ) -> Self {
        Self {
            active,
            profile_store,
            login_probe,
            usage_cache: parking_lot::Mutex::new(HashMap::new()),
            usage_probe: Arc::new(usage::SystemCodexUsageProbe),
        }
    }

    #[cfg(test)]
    fn with_probe(store: Arc<CodexAccountStore>, login_probe: Arc<dyn CodexLoginStatus>) -> Self {
        Self::assemble(true, Some(store), login_probe)
    }

    fn resolve_account(&self, project_id: Option<&str>) -> AccountResolution {
        match &self.profile_store {
            Some(store) => store.resolve(project_id),
            None => AccountResolution {
                account_id: BUILTIN_ACCOUNT_ID.to_string(),
                account_name: "Default".to_string(),
                config_dir: None,
            },
        }
    }

    /// Prepare `acp-registry:codex-acp` for `project_id`. Returns `true` when
    /// this service applied a Codex home, and `false` for every other config.
    /// A home that is not signed in fails before the agent process starts.
    pub async fn prepare_managed_config_for_project(
        &self,
        config: &mut AgentConfig,
        project_id: Option<&str>,
    ) -> Result<bool, String> {
        if !self.active || config.config_id.as_deref() != Some(CODEX_ACP_CONFIG_ID) {
            return Ok(false);
        }
        let account = self.resolve_account(project_id);
        let (home, source) = effective_home(
            &config.env,
            account.config_dir.as_deref(),
            CodexAccountStore::host_home_dir().as_deref(),
        );
        if source == HomeSource::ProjectEnv && account.config_dir.is_some() {
            log::info!(
                "[acp-codex] the project env CODEX_HOME overrides the project's linked Codex profile"
            );
        }
        if let Some(dir) = &home {
            let dir = dir.to_str().ok_or_else(|| {
                log::warn!("[acp-codex] account home is not valid Unicode");
                "The Codex account folder path is not supported".to_string()
            })?;
            if let Err(error) = std::fs::create_dir_all(dir) {
                log::warn!(
                    "[acp-codex] could not create Codex home before spawn: {:?}",
                    error.kind()
                );
                return Err("Could not create the Codex home folder".to_string());
            }
        }
        let codex_bin = config.env.get("CODEX_PATH").map(String::as_str);
        let project_path = project_path_override(&config.env);
        match self
            .login_probe
            .login_status(home.as_deref(), codex_bin, project_path)
            .await
        {
            Ok(Some(true)) => {}
            Ok(Some(false)) => {
                log::warn!(
                    "[acp-codex] managed config rejected: {} profile is not signed in",
                    source.label()
                );
                let message = match source {
                    HomeSource::Host => {
                        "Codex CLI is not signed in. Run `codex login`, then retry.".to_string()
                    }
                    HomeSource::Linked => format!(
                        "The Codex account \"{}\" is not signed in. Run `codex login` for that account, then retry.",
                        account.account_name
                    ),
                    HomeSource::ProjectEnv => "The Codex profile set by CODEX_HOME in the project environment is not signed in. Run `codex login` with that CODEX_HOME, then retry."
                        .to_string(),
                };
                return Err(signed_out_error(message));
            }
            Ok(None) => {
                log::warn!(
                    "[acp-codex] managed config rejected: {} profile login could not be checked",
                    source.label()
                );
                return Err(
                    "Could not check the Codex login. Install the Codex CLI, or set CODEX_PATH to the codex binary, then retry."
                        .to_string(),
                );
            }
            Err(error) => {
                log::warn!("[acp-codex] managed config rejected: {error}");
                return Err(error);
            }
        }
        strip_api_credentials(&mut config.env);
        config
            .env
            .insert(STRIP_CODEX_API_CREDENTIALS.to_string(), "1".to_string());
        match &home {
            Some(dir) => {
                let dir = dir.to_str().ok_or_else(|| {
                    log::warn!("[acp-codex] account home is not valid Unicode");
                    "The Codex account folder path is not supported".to_string()
                })?;
                config
                    .env
                    .insert(CODEX_HOME_ENV.to_string(), dir.to_string());
            }
            None => {
                config.env.remove(CODEX_HOME_ENV);
            }
        }
        log::info!(
            "[acp-codex] managed config uses the {} Codex profile",
            source.label()
        );
        Ok(true)
    }
}

fn strip_api_credentials(env: &mut HashMap<String, String>) {
    env.remove(OPENAI_API_KEY_ENV);
    env.remove(CODEX_ACCESS_TOKEN_ENV);
}

/// The project env `PATH`, when one is set. The login probe merges it the
/// same way the spawned adapter does.
fn project_path_override(env: &HashMap<String, String>) -> Option<&str> {
    env.iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("path"))
        .map(|(_, value)| value.as_str())
        .filter(|value| !value.trim().is_empty())
}

mod accounts;
mod usage;
pub use accounts::CodexSignInCheck;

#[cfg(test)]
#[path = "codex_agent/tests.rs"]
mod tests;
