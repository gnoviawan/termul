//! Codex Account operations on [`CodexAgentService`]: the store calls, the
//! per-home login probe, `codex logout` on remove, and the ChatGPT sign-in
//! spawn that skips the signed-out gate.

use std::path::PathBuf;
use std::sync::Arc;

use super::{strip_api_credentials, CodexAgentService, CODEX_ACP_CONFIG_ID, CODEX_HOME_ENV};
use crate::acp::codex_accounts::{
    signed_out_error, CodexAccount, CodexAccountStore, CodexAccountsSnapshot, BUILTIN_ACCOUNT_ID,
};
use crate::acp::config::AgentConfig;

/// Whether choosing an Account first checks that its login is confirmed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexSignInCheck {
    /// A switch from the desktop or web UI. The renderer restarts the
    /// Project's open Codex chats right after it, and the spawn gate rejects
    /// an Account that is not signed in, so refuse it before anything changes.
    Required,
    /// Headless setup (`troupe-server codex account`), where an admin may
    /// choose an Account before running `login`. Nothing restarts there.
    Skip,
}

/// Which Account a choice names: the one picked, or the Default Account a
/// Project follows.
#[derive(Debug, Clone, Copy)]
enum Choice {
    Account,
    FollowDefault,
}

impl CodexAgentService {
    pub(super) fn account_store(&self) -> Result<&Arc<CodexAccountStore>, String> {
        self.profile_store
            .as_ref()
            .ok_or_else(|| "Codex accounts are not available on this host".to_string())
    }

    /// The Account list with the Codex CLI login state of each home.
    pub async fn accounts_snapshot(&self) -> Result<CodexAccountsSnapshot, String> {
        self.profile_list().await
    }

    /// Same list as [`Self::accounts_snapshot`]. The CLI prints these ids, so
    /// this name stays free of the word "account".
    pub async fn profile_list(&self) -> Result<CodexAccountsSnapshot, String> {
        let store = self.account_store()?;
        let mut snapshot = store.snapshot()?;
        let dirs: Vec<Option<PathBuf>> = snapshot
            .profiles
            .iter()
            .map(|row| store.config_dir(&row.id))
            .collect();
        let probes = dirs
            .iter()
            .map(|dir| self.login_probe.login_status(dir.as_deref(), None, None));
        let states = futures::future::join_all(probes).await;
        for (row, state) in snapshot.profiles.iter_mut().zip(states) {
            row.signed_in = state.unwrap_or_else(|_error| {
                log::warn!("[codex-accounts] login probe failed");
                None
            });
        }
        Ok(snapshot)
    }

    pub fn add_account(&self, name: &str) -> Result<CodexAccount, String> {
        self.insert_profile(name)
    }

    /// Same as [`Self::add_account`]. The CLI prints the new id, so this name
    /// stays free of the word "account".
    pub fn insert_profile(&self, name: &str) -> Result<CodexAccount, String> {
        self.account_store()?.add(name)
    }

    pub fn has_account(&self, id: &str) -> Result<bool, String> {
        Ok(self
            .account_store()?
            .snapshot()?
            .profiles
            .iter()
            .any(|row| row.id == id))
    }

    pub fn rename_account(&self, id: &str, name: &str) -> Result<(), String> {
        self.account_store()?.rename(id, name)
    }

    pub async fn set_default_account(
        &self,
        id: &str,
        check: CodexSignInCheck,
    ) -> Result<(), String> {
        let store = self.account_store()?;
        if check == CodexSignInCheck::Required {
            self.ensure_signed_in(store, id, Choice::Account).await?;
        }
        store.set_default(id)
    }

    pub fn set_auto_switch(&self, enabled: bool) -> Result<(), String> {
        self.account_store()?.set_auto_switch(enabled)
    }

    /// `account_id: None` returns the Project to the Default Account, so the
    /// check probes the Default Account. `expected` makes the choice a
    /// compare-and-set. Returns whether the choice applied.
    pub async fn set_project_account(
        &self,
        project_id: &str,
        account_id: Option<&str>,
        expected: Option<&str>,
        check: CodexSignInCheck,
    ) -> Result<bool, String> {
        let store = self.account_store()?;
        if let Some(expected) = expected {
            let snapshot = store.snapshot()?;
            let current = snapshot
                .project_profiles
                .get(project_id.trim())
                .unwrap_or(&snapshot.default_account_id);
            if current != expected {
                log::info!(
                    "[codex-accounts] project profile unchanged: the project no longer uses the expected profile"
                );
                return Ok(false);
            }
        }
        if check == CodexSignInCheck::Required {
            match account_id {
                Some(id) => self.ensure_signed_in(store, id, Choice::Account).await?,
                None => {
                    let default_id = store.snapshot()?.default_account_id;
                    self.ensure_signed_in(store, &default_id, Choice::FollowDefault)
                        .await?;
                }
            }
        }
        store.set_project_account(project_id, account_id, expected)
    }

    /// Only a confirmed login (`codex login status` exits 0) may be chosen.
    /// An unknown id passes here; the store setter reports it.
    async fn ensure_signed_in(
        &self,
        store: &CodexAccountStore,
        id: &str,
        choice: Choice,
    ) -> Result<(), String> {
        let snapshot = store.snapshot()?;
        let Some(account) = snapshot.profiles.iter().find(|row| row.id == id) else {
            return Ok(());
        };
        let status = self
            .login_probe
            .login_status(store.config_dir(id).as_deref(), None, None)
            .await;
        if matches!(status, Ok(Some(true))) {
            return Ok(());
        }
        log::warn!(
            "[codex-accounts] refused to choose an account that is not signed in (status={status:?})"
        );
        let subject = match choice {
            Choice::FollowDefault => format!("The default Codex account \"{}\"", account.name),
            Choice::Account => format!("The Codex account \"{}\"", account.name),
        };
        let state = if matches!(status, Ok(Some(false))) {
            "is not signed in"
        } else {
            "could not be checked for a sign-in"
        };
        Err(signed_out_error(format!(
            "{subject} {state}. Sign in to it in Settings → Provider, then choose it again."
        )))
    }

    /// Run `codex logout` with the Account's home, then remove it. A failed
    /// sign-out is logged; the Account is still removed. Returns the Projects
    /// that moved to the built-in Account.
    pub async fn remove_account(&self, id: &str) -> Result<Vec<String>, String> {
        let store = self.account_store()?;
        if id == BUILTIN_ACCOUNT_ID {
            return store.remove(id);
        }
        let known = self.has_account(id)?;
        if let Some(dir) = store.config_dir(id).filter(|_| known) {
            match self.login_probe.logout(Some(dir.as_path())).await {
                Ok(()) => log::info!("[codex-accounts] signed out before removal"),
                Err(_error) => log::warn!("[codex-accounts] sign-out failed"),
            }
        }
        store.remove(id)
    }

    /// Run `codex login --device-auth` for one Account in the caller's
    /// terminal (headless `troupe-server codex account login`).
    pub fn run_account_cli_login(&self, id: &str) -> Result<(), String> {
        if !self.has_account(id)? {
            return Err("That Codex account does not exist".to_string());
        }
        let dir = self.account_store()?.config_dir(id);
        log::info!("[codex-accounts] terminal login started");
        crate::acp::commands::run_codex_device_login(dir.as_deref())
    }

    /// Point a Codex ACP config at one Account's home and do not require a
    /// login. Chat spawn still uses [`Self::prepare_managed_config_for_project`],
    /// which refuses a signed-out home. This path is only for the sign-in
    /// agent that then runs ACP `authenticate`.
    pub async fn prepare_sign_in_config(
        &self,
        config: &mut AgentConfig,
        account_id: &str,
    ) -> Result<(), String> {
        if !self.active || config.config_id.as_deref() != Some(CODEX_ACP_CONFIG_ID) {
            log::warn!("[codex-accounts] sign-in spawn refused: not the Codex agent");
            return Err("Sign-in is only available for the Codex agent".to_string());
        }
        let store = self.account_store()?;
        if !self.has_account(account_id)? {
            return Err("That Codex account does not exist".to_string());
        }
        let home = if account_id == BUILTIN_ACCOUNT_ID {
            None
        } else {
            store.config_dir(account_id)
        };
        if let Some(dir) = &home {
            if let Err(error) = std::fs::create_dir_all(dir) {
                log::warn!(
                    "[codex-accounts] could not create Codex home before sign-in: {:?}",
                    error.kind()
                );
                return Err("Could not create the Codex home folder".to_string());
            }
        }
        strip_api_credentials(&mut config.env);
        config.env.insert(
            super::STRIP_CODEX_API_CREDENTIALS.to_string(),
            "1".to_string(),
        );
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
            _ => {
                // The built-in Account is the host home. Leave `CODEX_HOME`
                // unset so the agent inherits it, the same as a chat spawn.
                config.env.remove(CODEX_HOME_ENV);
            }
        }
        log::info!("[codex-accounts] sign-in spawn prepared");
        Ok(())
    }
}

/// Login probe for tests: a home directory whose file name is in the list is
/// signed out. The built-in Account (`None`) is signed out when the list
/// contains `default`. Logout calls are recorded and succeed.
#[cfg(test)]
pub(crate) struct FixedLogins {
    signed_out: Vec<String>,
    pub logouts: std::sync::Mutex<Vec<Option<PathBuf>>>,
}

#[cfg(test)]
impl FixedLogins {
    pub(crate) fn new(signed_out: &[&str]) -> Self {
        Self {
            signed_out: signed_out.iter().map(ToString::to_string).collect(),
            logouts: std::sync::Mutex::new(Vec::new()),
        }
    }
}

#[cfg(test)]
#[async_trait::async_trait]
impl super::CodexLoginStatus for FixedLogins {
    async fn login_status(
        &self,
        codex_home: Option<&std::path::Path>,
        _codex_bin: Option<&str>,
        _project_path: Option<&str>,
    ) -> Result<Option<bool>, String> {
        let id = codex_home
            .and_then(|dir| dir.file_name()?.to_str())
            .unwrap_or(BUILTIN_ACCOUNT_ID);
        Ok(Some(!self.signed_out.iter().any(|out| out == id)))
    }

    async fn logout(&self, codex_home: Option<&std::path::Path>) -> Result<(), String> {
        self.logouts
            .lock()
            .expect("logout record")
            .push(codex_home.map(std::path::Path::to_path_buf));
        Ok(())
    }
}

#[cfg(test)]
impl CodexAgentService {
    /// A host store under `state_dir` whose login probe reports the named
    /// homes signed out. `default` is the built-in Account.
    pub(crate) fn with_logins_for_test(state_dir: &std::path::Path, signed_out: &[&str]) -> Self {
        let store = Arc::new(CodexAccountStore::new(state_dir, state_dir.join("shared")));
        Self::with_probe(
            store,
            Arc::new(FixedLogins::new(signed_out)) as Arc<dyn super::CodexLoginStatus>,
        )
    }
}

#[cfg(test)]
#[path = "accounts_tests.rs"]
mod tests;
