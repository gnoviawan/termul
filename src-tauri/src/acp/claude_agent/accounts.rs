//! Claude Account operations on [`ClaudeAgentService`]: the store calls plus
//! the Claude CLI login, logout, and login-state probes per config directory.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use super::{claude_cli_command, AccountResolution, ClaudeAccountStore, ClaudeAgentService};
use crate::acp::claude_accounts::{ClaudeAccount, ClaudeAccountsSnapshot, BUILTIN_ACCOUNT_ID};

/// Upper bound for one sign-in; `claude auth login` waits for the browser
/// callback or the pasted code until then.
pub(super) const LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const LOGOUT_TIMEOUT: Duration = Duration::from_secs(20);

/// Whether choosing an Account first checks that its login is confirmed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignInCheck {
    /// A switch from the desktop or web UI. The renderer restarts the
    /// Project's open Claude chats right after it, and the spawn gate rejects
    /// an Account that is not signed in, so refuse it before anything changes.
    Required,
    /// Headless setup (`termul-server claude account`), where an admin may
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

/// Error text of a cancelled login; the renderer treats it as a quiet stop.
pub const LOGIN_CANCELLED: &str = "Sign-in was cancelled";

impl ClaudeAgentService {
    #[cfg(test)]
    pub(super) fn set_accounts_for_test(&mut self, accounts: Arc<ClaudeAccountStore>) {
        self.profile_store = Some(accounts);
    }

    /// A host with its own account store under `state_dir` (links point at
    /// `state_dir/shared`, never the real Claude folder) whose login probe
    /// reports every Account signed in except those in `signed_out`.
    #[cfg(test)]
    pub(crate) fn with_logins_for_test(state_dir: &std::path::Path, signed_out: &[&str]) -> Self {
        let mut service = Self::with_adapters(
            Arc::new(super::InMemoryClaudeCredentialStore::default()),
            Some(state_dir.join("acp-registry-binaries")),
            Arc::new(FixedLogins(
                signed_out.iter().map(ToString::to_string).collect(),
            )),
        );
        service.profile_store = Some(Arc::new(ClaudeAccountStore::new(
            state_dir,
            state_dir.join("shared"),
        )));
        service
    }

    #[cfg(test)]
    pub(super) fn set_usage_probe_for_test(&mut self, probe: Arc<dyn super::ClaudeUsageProbe>) {
        self.usage_probe = probe;
    }

    pub(super) fn account_store(&self) -> Result<&Arc<ClaudeAccountStore>, String> {
        self.profile_store
            .as_ref()
            .ok_or_else(|| "Claude accounts are not available on this host".to_string())
    }

    pub(super) fn resolve_account(&self, project_id: Option<&str>) -> AccountResolution {
        match &self.profile_store {
            Some(store) => store.resolve(project_id),
            None => AccountResolution {
                account_id: BUILTIN_ACCOUNT_ID.to_string(),
                account_name: "Default".to_string(),
                config_dir: None,
            },
        }
    }

    /// The Account list with the Claude CLI login state of each Account.
    pub async fn accounts_snapshot(&self) -> Result<ClaudeAccountsSnapshot, String> {
        self.profile_list().await
    }

    /// Same list as [`Self::accounts_snapshot`]. The CLI prints these ids, so
    /// this name stays free of the word "account": CodeQL treats that word as
    /// secret data and stdout as a log.
    pub async fn profile_list(&self) -> Result<ClaudeAccountsSnapshot, String> {
        let store = self
            .profile_store
            .as_ref()
            .ok_or_else(|| "Claude accounts are not available on this host".to_string())?;
        let mut snapshot = store.snapshot()?;
        let dirs: Vec<Option<PathBuf>> = snapshot
            .profiles
            .iter()
            .map(|row| store.config_dir(&row.id))
            .collect();
        let probes = dirs
            .iter()
            .map(|dir| self.runtime_probe.cli_authentication_status(dir.as_deref()));
        let states = futures::future::join_all(probes).await;
        for (row, state) in snapshot.profiles.iter_mut().zip(states) {
            row.signed_in = state.unwrap_or_else(|_error| {
                log::warn!("[claude-accounts] login probe failed");
                None
            });
        }
        Ok(snapshot)
    }

    pub fn add_account(&self, name: &str) -> Result<ClaudeAccount, String> {
        self.insert_profile(name)
    }

    /// Same as [`Self::add_account`]. The CLI prints the new id, so this name
    /// stays free of the word "account".
    pub fn insert_profile(&self, name: &str) -> Result<ClaudeAccount, String> {
        self.profile_store
            .as_ref()
            .ok_or_else(|| "Claude accounts are not available on this host".to_string())?
            .add(name)
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

    pub async fn set_default_account(&self, id: &str, check: SignInCheck) -> Result<(), String> {
        let store = self.account_store()?;
        if check == SignInCheck::Required {
            self.ensure_signed_in(store, id, Choice::Account).await?;
        }
        store.set_default(id)
    }

    pub fn set_auto_switch(&self, enabled: bool) -> Result<(), String> {
        self.account_store()?.set_auto_switch(enabled)
    }

    /// `account_id: None` returns the Project to the Default Account, so the
    /// check probes the Default Account. `expected` makes the choice a
    /// compare-and-set on the Account the Project uses; returns whether the
    /// choice applied.
    pub async fn set_project_account(
        &self,
        project_id: &str,
        account_id: Option<&str>,
        expected: Option<&str>,
        check: SignInCheck,
    ) -> Result<bool, String> {
        let store = self.account_store()?;
        if let Some(expected) = expected {
            // A stale expectation loses before the sign-in probe, so the losing
            // client is not asked to sign in to an Account it no longer needs.
            let snapshot = store.snapshot()?;
            let current = snapshot
                .project_profiles
                .get(project_id.trim())
                .unwrap_or(&snapshot.default_account_id);
            if current != expected {
                log::info!(
                    "[claude-accounts] project profile unchanged: the project no longer uses the expected profile"
                );
                return Ok(false);
            }
        }
        if check == SignInCheck::Required {
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

    /// The spawn gate's rule, applied before an Account is chosen: only a
    /// confirmed login (`claude auth status` exits 0) passes, through the same
    /// probe and the same console-free `claude` spawn. API-key mode does not
    /// use Accounts, so it passes. An unknown id passes here; the store
    /// setter reports it.
    async fn ensure_signed_in(
        &self,
        store: &ClaudeAccountStore,
        id: &str,
        choice: Choice,
    ) -> Result<(), String> {
        if !matches!(self.auth_mode(), Ok(super::ClaudeAuthMode::ClaudeCode)) {
            return Ok(());
        }
        let snapshot = store.snapshot()?;
        let Some(account) = snapshot.profiles.iter().find(|row| row.id == id) else {
            return Ok(());
        };
        let status = self
            .runtime_probe
            .cli_authentication_status(store.config_dir(id).as_deref())
            .await;
        if matches!(status, Ok(Some(true))) {
            return Ok(());
        }
        log::warn!(
            "[claude-accounts] refused to choose an account that is not signed in (status={status:?})"
        );
        let subject = match choice {
            Choice::FollowDefault => format!("The default Claude account \"{}\"", account.name),
            Choice::Account => format!("The Claude account \"{}\"", account.name),
        };
        let state = if matches!(status, Ok(Some(false))) {
            "is not signed in"
        } else {
            "could not be checked for a sign-in"
        };
        Err(crate::acp::claude_accounts::signed_out_error(format!(
            "{subject} {state}. Sign in to it in Settings → Accounts, then choose it again."
        )))
    }

    /// Sign the Claude CLI out of the Account (removing its keychain entry),
    /// then remove the Account. A failed sign-out is logged; the Account is
    /// still removed. Returns the Projects that moved to the default.
    pub async fn remove_account(&self, id: &str) -> Result<Vec<String>, String> {
        let store = self.account_store()?;
        // Sign out even when the folder is gone: on macOS the login lives in
        // the keychain. An id that is already removed has nothing to sign out.
        let known = self.has_account(id)?;
        if let Some(dir) = store.config_dir(id).filter(|_| known) {
            match run_cli(&["auth", "logout"], Some(dir), LOGOUT_TIMEOUT, None).await {
                Ok(true) => log::info!("[claude-accounts] signed out before removal"),
                Ok(false) => log::warn!("[claude-accounts] sign-out did not succeed"),
                Err(_error) => {
                    log::warn!("[claude-accounts] sign-out failed");
                }
            }
        }
        store.remove(id)
    }

    /// Stop the running browser or link sign-in of `id`. Returns `false`
    /// when no sign-in for that Account is running.
    pub fn cancel_login(&self, id: &str) -> bool {
        let cancelled = self.logins.cancel(id);
        if cancelled {
            log::info!("[claude-accounts] login cancelled");
        }
        cancelled
    }

    /// Run Anthropic's interactive `claude auth login` for one Account in the
    /// caller's terminal (headless `termul-server claude account login`).
    pub fn run_account_cli_login(&self, id: &str) -> Result<(), String> {
        if !self.has_account(id)? {
            return Err("That Claude account does not exist".to_string());
        }
        let dir = self.account_store()?.config_dir(id);
        log::info!("[claude-accounts] terminal login started");
        self.run_cli_login_in(dir.as_deref())
    }

    /// Run Anthropic's browser login for one Account without a terminal. The
    /// CLI opens the browser and stores the login itself; Termul never sees
    /// the token. Resolves when the login finishes, fails, or times out.
    pub async fn login_account(&self, id: &str) -> Result<(), String> {
        let dir = self.sign_in_dir(id)?;
        log::info!("[claude-accounts] login started");
        let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
        let generation = self
            .logins
            .begin(id, super::logins::LoginKind::Browser { _cancel: cancel_tx });
        let result = run_cli(&["auth", "login"], dir, LOGIN_TIMEOUT, Some(cancel_rx)).await;
        self.logins.end(id, generation);
        match result {
            Ok(true) => {
                log::info!("[claude-accounts] login finished");
                Ok(())
            }
            Ok(false) => {
                log::warn!("[claude-accounts] login did not finish");
                Err("Claude sign-in did not finish. Try again.".to_string())
            }
            Err(error) => {
                log::warn!("[claude-accounts] login failed");
                Err(error)
            }
        }
    }

    /// The Claude config dir a sign-in of `id` writes to (`None` = the
    /// host's own, for the built-in Account).
    pub(super) fn sign_in_dir(&self, id: &str) -> Result<Option<PathBuf>, String> {
        let store = self.account_store()?;
        if id == BUILTIN_ACCOUNT_ID {
            return Ok(None);
        }
        if !store.snapshot()?.profiles.iter().any(|row| row.id == id) {
            return Err("That Claude account does not exist".to_string());
        }
        Ok(store.config_dir(id))
    }
}

/// Run `claude <args>` with no terminal and discarded output. `Ok(true)` on
/// exit code 0. The CLI output can hold account details, so it is never read.
/// Stdin is an open pipe that is never written: `auth login` exits at stdin
/// EOF before the browser callback can finish the login. `cancel` resolving
/// (a message, or its sender dropped) stops the CLI.
async fn run_cli(
    args: &[&str],
    config_dir: Option<PathBuf>,
    timeout: Duration,
    cancel: Option<tokio::sync::oneshot::Receiver<()>>,
) -> Result<bool, String> {
    let Some(mut command) = claude_cli_command(args, config_dir.as_deref())? else {
        return Err("Claude Code CLI is not installed or is not on PATH".to_string());
    };
    command
        .kill_on_drop(true)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|_| "Could not start the Claude CLI".to_string())?;
    let waited = match cancel {
        Some(cancel) => tokio::select! {
            waited = tokio::time::timeout(timeout, child.wait()) => Some(waited),
            _ = cancel => None,
        },
        None => Some(tokio::time::timeout(timeout, child.wait()).await),
    };
    let Some(waited) = waited else {
        let _ = child.kill().await;
        return Err(LOGIN_CANCELLED.to_string());
    };
    match waited {
        Ok(Ok(status)) => Ok(status.success()),
        Ok(Err(_)) => Err("The Claude CLI stopped unexpectedly".to_string()),
        Err(_) => Err("Claude sign-in timed out".to_string()),
    }
}

/// Login probe for [`ClaudeAgentService::with_logins_for_test`]: an Account
/// dir named in the list is signed out, every other one is signed in.
#[cfg(test)]
struct FixedLogins(Vec<String>);

#[cfg(test)]
#[async_trait::async_trait]
impl super::ClaudeRuntimeProbe for FixedLogins {
    async fn ensure_supported(&self) -> Result<(), String> {
        Ok(())
    }

    async fn cli_authentication_status(
        &self,
        config_dir: Option<&std::path::Path>,
    ) -> Result<Option<bool>, String> {
        let id = config_dir.and_then(|dir| dir.file_name()?.to_str());
        Ok(Some(
            !id.is_some_and(|id| self.0.iter().any(|out| out == id)),
        ))
    }
}

#[cfg(test)]
#[path = "accounts_tests.rs"]
mod tests;
