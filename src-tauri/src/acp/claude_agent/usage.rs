//! Claude Account usage: a cached read of each Account's usage windows through
//! the Claude Agent SDK that ships with the managed Claude ACP package. The
//! probe runs Claude with the Account's own config dir, so Claude Code reads
//! and refreshes its own login; Termul never sees a token.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::{ClaudeAgentService, ClaudeAuthMode, ANTHROPIC_API_KEY_ENV, CLAUDE_CONFIG_DIR_ENV};
use crate::acp::claude_accounts::usage::{
    parse_probe_output, ClaudeAccountUsage, ClaudeUsageStatus,
};
use crate::acp::config::resolve_runtime_executable;

/// A cached read is reused for this long.
const USAGE_MAX_AGE: Duration = Duration::from_secs(5 * 60);
/// A forced refresh still reuses a read this young.
const USAGE_MIN_AGE: Duration = Duration::from_secs(60);
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);

/// Asks the SDK for the plan limits only (`skipBehaviors`), with no session
/// file, no MCP servers, and no user settings. Prints one JSON line with the
/// limits and the plan type — never the account email.
const PROBE_SCRIPT: &str = r#"
import { pathToFileURL } from 'node:url'
const out = (value) => { process.stdout.write(JSON.stringify(value) + '\n'); process.exit(0) }
setTimeout(() => out({ error: 'Claude usage timed out' }), 25000).unref()
try {
  const { query } = await import(pathToFileURL(process.env.TERMUL_CLAUDE_SDK).href)
  const idle = (async function* () { await new Promise(() => {}) })()
  const q = query({ prompt: idle, options: { persistSession: false, mcpServers: {}, strictMcpConfig: true, settingSources: [] } })
  await q.initializationResult()
  const usage = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })
  const limits = usage?.rate_limits
  out({
    subscription_type: usage?.subscription_type ?? null,
    rate_limits_available: usage?.rate_limits_available ?? null,
    rate_limits: limits ? {
      limits: limits.limits ?? null,
      five_hour: limits.five_hour ?? null,
      seven_day: limits.seven_day ?? null,
      seven_day_opus: limits.seven_day_opus ?? null,
      seven_day_sonnet: limits.seven_day_sonnet ?? null
    } : null
  })
} catch (error) {
  out({ error: String(error?.message ?? error) })
}
"#;

/// Runs the usage probe for one config dir (`None` = the host's own) and
/// returns its raw stdout.
#[async_trait::async_trait]
pub(super) trait ClaudeUsageProbe: Send + Sync {
    async fn probe(&self, config_dir: Option<&Path>) -> Result<String, String>;
}

/// The probe over `node` and the SDK inside the managed Claude ACP install.
pub(super) struct SystemClaudeUsageProbe {
    pub(super) install_root: Option<PathBuf>,
}

#[async_trait::async_trait]
impl ClaudeUsageProbe for SystemClaudeUsageProbe {
    async fn probe(&self, config_dir: Option<&Path>) -> Result<String, String> {
        let sdk = self
            .install_root
            .as_ref()
            .map(|root| {
                root.join("claude-acp")
                    .join("node_modules")
                    .join("@anthropic-ai")
                    .join("claude-agent-sdk")
                    .join("sdk.mjs")
            })
            .filter(|path| path.is_file())
            .ok_or_else(|| "Install Claude Agent ACP to read usage".to_string())?;
        let path = crate::acp::config::runtime_resolution_path();
        let node = resolve_runtime_executable("node", &path)
            .ok_or_else(|| "Node.js is not installed".to_string())?;
        let mut command = tokio::process::Command::new(node);
        crate::process_util::hide_console(&mut command);
        command
            .args(["--input-type=module", "-e", PROBE_SCRIPT])
            .current_dir(std::env::temp_dir())
            .env("PATH", path)
            .env("TERMUL_CLAUDE_SDK", sdk)
            .env_remove(ANTHROPIC_API_KEY_ENV)
            .kill_on_drop(true)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        if let Some(dir) = config_dir {
            command.env(CLAUDE_CONFIG_DIR_ENV, dir);
        }
        let child = command
            .spawn()
            .map_err(|_| "Could not start the Claude usage check".to_string())?;
        match tokio::time::timeout(PROBE_TIMEOUT, child.wait_with_output()).await {
            Ok(Ok(output)) => Ok(String::from_utf8_lossy(&output.stdout).into_owned()),
            Ok(Err(_)) => Err("The Claude usage check stopped unexpectedly".to_string()),
            Err(_) => Err("Claude usage timed out".to_string()),
        }
    }
}

/// Latest read per Account id.
pub(super) type UsageCache = parking_lot::Mutex<HashMap<String, ClaudeAccountUsage>>;

impl ClaudeAgentService {
    /// Usage of every Account, in list order. Reads younger than 5 minutes
    /// come from the cache; `force` refreshes reads older than 60 seconds.
    pub async fn accounts_usage(&self, force: bool) -> Result<Vec<ClaudeAccountUsage>, String> {
        let snapshot = self.account_store()?.snapshot()?;
        let now = chrono::Utc::now().timestamp_millis();
        if self.auth_mode().ok() == Some(ClaudeAuthMode::ApiKey) {
            return Ok(snapshot
                .profiles
                .iter()
                .map(|a| ClaudeAccountUsage {
                    account_id: a.id.clone(),
                    status: ClaudeUsageStatus::Unavailable,
                    subscription_type: None,
                    windows: Vec::new(),
                    checked_at: now,
                    message: Some("API-key mode has no plan limits".to_string()),
                })
                .collect());
        }
        let max_age = if force { USAGE_MIN_AGE } else { USAGE_MAX_AGE };
        let max_age_ms = i64::try_from(max_age.as_millis()).unwrap_or(i64::MAX);
        let stale: Vec<(String, Option<PathBuf>)> = {
            let cache = self.usage_cache.lock();
            snapshot
                .profiles
                .iter()
                .filter(|a| {
                    cache
                        .get(&a.id)
                        .is_none_or(|u| now.saturating_sub(u.checked_at) >= max_age_ms)
                })
                .map(|a| {
                    (
                        a.id.clone(),
                        self.account_store().ok().and_then(|s| s.config_dir(&a.id)),
                    )
                })
                .collect()
        };
        if !stale.is_empty() {
            let reads = futures::future::join_all(stale.iter().map(|(id, dir)| async move {
                let checked_at = chrono::Utc::now().timestamp_millis();
                match self.usage_probe.probe(dir.as_deref()).await {
                    Ok(output) => parse_probe_output(id, &output, checked_at),
                    Err(message) => ClaudeAccountUsage::error(id, message, checked_at),
                }
            }))
            .await;
            let failed = reads
                .iter()
                .filter(|u| u.status == ClaudeUsageStatus::Error)
                .count();
            log::info!(
                "[claude-accounts] usage read for {} accounts ({failed} failed)",
                reads.len()
            );
            let mut cache = self.usage_cache.lock();
            for usage in reads {
                cache.insert(usage.account_id.clone(), usage);
            }
        }
        let cache = self.usage_cache.lock();
        Ok(snapshot
            .profiles
            .iter()
            .filter_map(|a| cache.get(&a.id).cloned())
            .collect())
    }
}

#[cfg(test)]
#[path = "usage_tests.rs"]
mod tests;
