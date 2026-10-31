//! `gh auth status` → the hosts `gh` is signed in to, and the
//! [`GithubAuthStatus`] for one host (CAP-1, CAP-9).
//!
//! `gh auth status --json hosts` (gh ≥ 2.80) is preferred; older `gh` falls
//! back to parsing the text report. The text report prints a masked token
//! line, so neither output is ever logged.

use std::collections::BTreeMap;

use serde::Deserialize;

use super::error::GithubError;
use super::runner::{GhCall, GhRunner};
use super::types::{GithubAuthStatus, GithubTokenSource};

/// Scopes the GitHub tab needs, each with the scopes that also grant it.
const REQUIRED_SCOPES: &[(&str, &[&str])] = &[
    ("repo", &["repo"]),
    ("read:org", &["read:org", "write:org", "admin:org"]),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum TokenOrigin {
    /// gh's own login: the system keyring or its `hosts.yml`.
    Stored,
    /// An environment variable such as `GH_TOKEN`.
    Env(String),
    Unknown,
}

impl TokenOrigin {
    fn parse(source: &str) -> Self {
        let source = source.trim();
        let looks_like_path = source.contains('/') || source.contains('\\');
        if source == "keyring" || source == "oauth_token" || looks_like_path {
            Self::Stored
        } else if source.contains("TOKEN") && source == source.to_ascii_uppercase() {
            Self::Env(source.to_string())
        } else {
            Self::Unknown
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct HostAccount {
    pub ok: bool,
    pub active: bool,
    pub login: String,
    pub origin: TokenOrigin,
    /// `None` when gh reports no scope list (fine-grained or app tokens).
    pub scopes: Option<Vec<String>>,
}

/// Every host `gh` has an account for, keyed by lowercase hostname.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct HostInventory {
    pub hosts: BTreeMap<String, Vec<HostAccount>>,
}

pub(super) fn login_command(host: &str) -> String {
    format!("gh auth login --hostname {host}")
}

fn unset_command(var: &str) -> String {
    if cfg!(windows) {
        format!("Remove-Item Env:{var}")
    } else {
        format!("unset {var}")
    }
}

impl HostInventory {
    pub fn knows(&self, host: &str) -> bool {
        self.hosts.contains_key(host)
    }

    pub fn status_for(&self, host: &str) -> GithubAuthStatus {
        let unauthenticated = || GithubAuthStatus::Unauthenticated {
            host: host.to_string(),
            login_command: login_command(host),
        };
        let Some(accounts) = self.hosts.get(host) else {
            return unauthenticated();
        };
        let Some(active) = accounts
            .iter()
            .find(|account| account.active)
            .or(accounts.first())
        else {
            return unauthenticated();
        };
        if !active.ok {
            return unauthenticated();
        }
        let scopes = active.scopes.clone().unwrap_or_default();
        let missing_scopes: Vec<String> = match &active.scopes {
            Some(granted) if !granted.is_empty() => REQUIRED_SCOPES
                .iter()
                .filter(|(_, satisfied_by)| {
                    !satisfied_by.iter().any(|s| granted.iter().any(|g| g == s))
                })
                .map(|(scope, _)| scope.to_string())
                .collect(),
            _ => Vec::new(),
        };
        let hidden_stored_login = accounts
            .iter()
            .any(|account| !account.active && account.ok && account.origin == TokenOrigin::Stored);
        let mut fix_commands = Vec::new();
        let token_source = match &active.origin {
            TokenOrigin::Env(var) => {
                // gh refuses to refresh an env token, so the fix is to drop it.
                if hidden_stored_login || !missing_scopes.is_empty() {
                    fix_commands.push(unset_command(var));
                }
                if !hidden_stored_login && !missing_scopes.is_empty() {
                    fix_commands.push(login_command(host));
                }
                GithubTokenSource::Env
            }
            origin => {
                if !missing_scopes.is_empty() {
                    fix_commands.push(format!(
                        "gh auth refresh -h {host} -s {}",
                        missing_scopes.join(",")
                    ));
                }
                if *origin == TokenOrigin::Stored {
                    GithubTokenSource::Keyring
                } else {
                    GithubTokenSource::Unknown
                }
            }
        };
        GithubAuthStatus::Connected {
            host: host.to_string(),
            account: active.login.clone(),
            scopes,
            token_source,
            missing_scopes,
            fix_commands,
        }
    }
}

#[derive(Deserialize)]
struct AuthJson {
    hosts: BTreeMap<String, Vec<AuthJsonEntry>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthJsonEntry {
    state: String,
    #[serde(default)]
    active: bool,
    #[serde(default)]
    login: String,
    #[serde(default)]
    token_source: String,
    scopes: Option<String>,
}

fn split_scopes(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|scope| scope.trim().trim_matches('\'').trim())
        .filter(|scope| !scope.is_empty() && *scope != "none")
        .map(str::to_string)
        .collect()
}

pub(super) fn parse_auth_json(stdout: &[u8]) -> Option<HostInventory> {
    let parsed: AuthJson = serde_json::from_slice(stdout).ok()?;
    let hosts = parsed
        .hosts
        .into_iter()
        .map(|(host, entries)| {
            let accounts = entries
                .into_iter()
                .map(|entry| HostAccount {
                    ok: entry.state == "success",
                    active: entry.active,
                    login: entry.login,
                    origin: TokenOrigin::parse(&entry.token_source),
                    scopes: entry.scopes.as_deref().map(split_scopes),
                })
                .collect();
            (host.to_ascii_lowercase(), accounts)
        })
        .collect();
    Some(HostInventory { hosts })
}

/// Parse the human `gh auth status` report (stdout and stderr together).
/// Handles the current layout (`account <login> (<source>)`, `Active
/// account:` lines) and the pre-2.40 one (`as <login> (<source>)`).
pub(super) fn parse_auth_text(text: &str) -> HostInventory {
    let mut inventory = HostInventory::default();
    let mut host: Option<String> = None;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if !raw.starts_with(char::is_whitespace) && !line.contains(' ') {
            let name = line.to_ascii_lowercase();
            inventory.hosts.entry(name.clone()).or_default();
            host = Some(name);
            continue;
        }
        let Some(accounts) = host.as_ref().and_then(|h| inventory.hosts.get_mut(h)) else {
            continue;
        };
        let body = line.trim_start_matches(['✓', 'X', '✗', '!', '-', ' ']);
        if let Some(rest) = body.strip_prefix("Logged in to ") {
            let login = rest
                .split_once(" account ")
                .or_else(|| rest.split_once(" as "))
                .map(|(_, tail)| tail.split(" (").next().unwrap_or("").trim().to_string())
                .unwrap_or_default();
            accounts.push(HostAccount {
                ok: true,
                active: true,
                login,
                origin: TokenOrigin::parse(paren_tail(rest)),
                scopes: None,
            });
        } else if let Some(rest) = body.strip_prefix("Failed to log in to ") {
            accounts.push(HostAccount {
                ok: false,
                active: true,
                login: String::new(),
                origin: TokenOrigin::parse(paren_tail(rest)),
                scopes: None,
            });
        } else if let Some(value) = body.strip_prefix("Active account:") {
            if let Some(account) = accounts.last_mut() {
                account.active = value.trim() == "true";
            }
        } else if let Some(value) = body.strip_prefix("Token scopes:") {
            if let Some(account) = accounts.last_mut() {
                account.scopes = Some(split_scopes(value));
            }
        }
    }
    inventory
}

fn paren_tail(text: &str) -> &str {
    text.rsplit_once('(')
        .map(|(_, tail)| tail.trim_end_matches(')').trim())
        .unwrap_or("")
}

/// Ask `gh` for every host it is signed in to. `--json` exits 0 even when an
/// account fails to validate; the text report exits 1 then, but still lists
/// every host, so its exit status is ignored.
pub(super) fn load_inventory(runner: &GhRunner) -> Result<HostInventory, GithubError> {
    let json = runner.output(&GhCall::new(None, ["auth", "status", "--json", "hosts"]))?;
    if json.success {
        if let Some(inventory) = parse_auth_json(&json.stdout) {
            return Ok(inventory);
        }
    }
    log::info!("[github] gh auth status has no usable --json output; parsing the text report");
    let text = runner.output(&GhCall::new(None, ["auth", "status"]))?;
    let combined = format!("{}\n{}", String::from_utf8_lossy(&text.stdout), text.stderr);
    Ok(parse_auth_text(&combined))
}
