//! Codex Account usage: a cached read of each Account's plan windows through
//! `codex app-server` on stdio. The child runs with that Account's
//! `CODEX_HOME`. `OPENAI_API_KEY` and `CODEX_ACCESS_TOKEN` are removed, so an
//! API key on the host is not treated as the ChatGPT login. Troupe never
//! reads or logs a token, and it never logs an Account id.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use super::CodexAgentService;
use crate::acp::codex_accounts::usage::{
    usage_from_verdict, verdict_from_rpc_error, CodexAccountUsage, CodexUsageStatus, ProbeVerdict,
};
use crate::acp::codex_accounts::CodexAccountStore;

/// A cached read is reused for this long.
const USAGE_MAX_AGE: Duration = Duration::from_secs(5 * 60);
/// A forced refresh still reuses a read this young.
const USAGE_MIN_AGE: Duration = Duration::from_secs(60);
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);

const OPENAI_API_KEY_ENV: &str = "OPENAI_API_KEY";
const CODEX_ACCESS_TOKEN_ENV: &str = "CODEX_ACCESS_TOKEN";

/// Runs the usage probe for one Codex home (`None` = the host's own) and
/// returns the verdict. The home directory must already exist.
#[async_trait::async_trait]
pub(super) trait CodexUsageProbe: Send + Sync {
    async fn probe(&self, codex_home: &Path) -> ProbeVerdict;
}

/// The probe over the Codex CLI (`codex app-server`).
pub(super) struct SystemCodexUsageProbe;

#[async_trait::async_trait]
impl CodexUsageProbe for SystemCodexUsageProbe {
    async fn probe(&self, codex_home: &Path) -> ProbeVerdict {
        let resolved = crate::acp::commands::resolve_codex_program(None, None);
        probe_app_server(&resolved.program, &resolved.prepend_args, codex_home).await
    }
}

/// A cached read plus the time of the last probe, including a failed one.
/// `usage.checked_at` stays on the windows that are shown. `attempted_at`
/// is the throttle: a new probe waits 60 seconds after the last attempt.
pub(super) struct CachedUsage {
    usage: CodexAccountUsage,
    attempted_at: i64,
}

/// Latest read per Account id.
pub(super) type UsageCache = parking_lot::Mutex<HashMap<String, CachedUsage>>;

impl CodexAgentService {
    /// Usage of every Account, in list order. Reads younger than 5 minutes
    /// come from the cache; `force` refreshes reads older than 60 seconds.
    /// A failed or unavailable read does not replace a previous good read.
    pub async fn accounts_usage(&self, force: bool) -> Result<Vec<CodexAccountUsage>, String> {
        let store = self.account_store()?;
        let snapshot = store.snapshot()?;
        let now = chrono::Utc::now().timestamp_millis();
        let max_age = if force { USAGE_MIN_AGE } else { USAGE_MAX_AGE };
        let max_age_ms = i64::try_from(max_age.as_millis()).unwrap_or(i64::MAX);
        let min_age_ms = i64::try_from(USAGE_MIN_AGE.as_millis()).unwrap_or(i64::MAX);
        let stale: Vec<(String, Option<PathBuf>)> = {
            let cache = self.usage_cache.lock();
            snapshot
                .profiles
                .iter()
                .filter(|row| {
                    cache.get(&row.id).is_none_or(|entry| {
                        now.saturating_sub(entry.attempted_at) >= min_age_ms
                            && now.saturating_sub(entry.usage.checked_at) >= max_age_ms
                    })
                })
                .map(|row| {
                    let home = store
                        .config_dir(&row.id)
                        .or_else(CodexAccountStore::host_shared_dir);
                    (row.id.clone(), home)
                })
                .collect()
        };
        if !stale.is_empty() {
            let reads = futures::future::join_all(stale.iter().map(|(id, home)| async move {
                let checked_at = chrono::Utc::now().timestamp_millis();
                let verdict = match home {
                    Some(home) => match ensure_home(home) {
                        Ok(()) => self.usage_probe.probe(home).await,
                        Err(message) => ProbeVerdict::Failed(message),
                    },
                    None => ProbeVerdict::Unavailable,
                };
                usage_from_verdict(id, verdict, checked_at)
            }))
            .await;
            let unavailable = reads
                .iter()
                .filter(|usage| usage.status == CodexUsageStatus::Unavailable)
                .count();
            let signed_out = reads
                .iter()
                .filter(|usage| usage.status == CodexUsageStatus::SignedOut)
                .count();
            let failed = reads
                .iter()
                .filter(|usage| usage.status == CodexUsageStatus::Error)
                .count();
            log::info!(
                "[codex-accounts] usage read for {} profiles ({unavailable} unavailable, {signed_out} signed out, {failed} failed)",
                reads.len()
            );
            let mut cache = self.usage_cache.lock();
            for usage in reads {
                remember(&mut cache, usage);
            }
        }
        let cache = self.usage_cache.lock();
        Ok(snapshot
            .profiles
            .iter()
            .filter_map(|row| cache.get(&row.id).map(|entry| entry.usage.clone()))
            .collect())
    }
}

/// Keep a good read when a later probe cannot reach Codex. A signed-out read
/// replaces it: the login is gone. A result older than the cached read is
/// dropped, so a slow probe cannot overwrite a newer one. A failed attempt
/// still moves `attempted_at`, which is the 60-second probe interval.
fn remember(cache: &mut HashMap<String, CachedUsage>, usage: CodexAccountUsage) {
    let attempt = usage.checked_at;
    if let Some(prev) = cache.get_mut(&usage.account_id) {
        if attempt < prev.usage.checked_at {
            return;
        }
        let failed = matches!(
            usage.status,
            CodexUsageStatus::Unavailable | CodexUsageStatus::Error
        );
        if failed && prev.usage.status == CodexUsageStatus::Ok {
            prev.attempted_at = prev.attempted_at.max(attempt);
            return;
        }
        *prev = CachedUsage {
            usage,
            attempted_at: attempt.max(prev.attempted_at),
        };
        return;
    }
    cache.insert(
        usage.account_id.clone(),
        CachedUsage {
            usage,
            attempted_at: attempt,
        },
    );
}

fn ensure_home(home: &Path) -> Result<(), &'static str> {
    if home.is_dir() {
        return Ok(());
    }
    match std::fs::create_dir_all(home) {
        Ok(()) => Ok(()),
        Err(error) => {
            log::warn!(
                "[codex-accounts] could not create Codex home before usage read: {:?}",
                error.kind()
            );
            Err("Could not create the Codex home folder")
        }
    }
}

/// Speak initialize, then `account/rateLimits/read`, then stop.
///
/// `program` is the Codex executable (or a test double). Missing program,
/// a handshake that does not complete, and a result this host does not
/// understand are [`ProbeVerdict::Unavailable`].
pub(crate) async fn probe_app_server(
    program: &str,
    prepend_args: &[String],
    codex_home: &Path,
) -> ProbeVerdict {
    if let Err(message) = ensure_home(codex_home) {
        return ProbeVerdict::Failed(message);
    }
    let Some(home) = codex_home.to_str() else {
        log::warn!("[codex-accounts] account home is not valid Unicode");
        return ProbeVerdict::Failed("The Codex account folder path is not supported");
    };
    let mut command = Command::new(program);
    crate::process_util::background_command_hygiene(&mut command);
    command
        .args(prepend_args)
        .arg("app-server")
        .env("CODEX_HOME", home)
        .env_remove(OPENAI_API_KEY_ENV)
        .env_remove(CODEX_ACCESS_TOKEN_ENV)
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut path_env = HashMap::new();
    crate::pty::env_refresh::apply_fresh_path(&mut path_env);
    if let Some(path) = path_env
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("path"))
        .map(|(_, value)| value.clone())
    {
        command.env("PATH", &path);
        #[cfg(windows)]
        command.env("Path", &path);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return ProbeVerdict::Unavailable;
        }
        Err(error) => {
            log::warn!(
                "[codex-accounts] usage probe could not start ({:?})",
                error.kind()
            );
            return ProbeVerdict::Unavailable;
        }
    };
    let result = tokio::time::timeout(PROBE_TIMEOUT, exchange(&mut child)).await;
    let _ = child.kill().await;
    match result {
        Ok(verdict) => verdict,
        Err(_) => {
            log::warn!("[codex-accounts] usage probe timed out");
            ProbeVerdict::Failed("Codex usage timed out")
        }
    }
}

async fn exchange(child: &mut tokio::process::Child) -> ProbeVerdict {
    let Some(stdin) = child.stdin.as_mut() else {
        return ProbeVerdict::Unavailable;
    };
    let Some(stdout) = child.stdout.take() else {
        return ProbeVerdict::Unavailable;
    };
    let mut reader = BufReader::new(stdout);
    if write_line(
        stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "clientInfo": { "name": "troupe", "title": "Troupe", "version": "0.0.0" },
                "capabilities": { "experimentalApi": true }
            }
        }),
    )
    .await
    .is_err()
    {
        return ProbeVerdict::Unavailable;
    }
    if rpc_result(&mut reader, 1).await.is_none() {
        return ProbeVerdict::Unavailable;
    }
    if write_line(stdin, &json!({ "jsonrpc": "2.0", "method": "initialized" }))
        .await
        .is_err()
    {
        return ProbeVerdict::Unavailable;
    }
    if write_line(
        stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "account/rateLimits/read",
            "params": {}
        }),
    )
    .await
    .is_err()
    {
        return ProbeVerdict::Unavailable;
    }
    match rpc_result(&mut reader, 2).await {
        Some(RpcReply::Result(result)) => ProbeVerdict::Limits(result),
        Some(RpcReply::Error(error)) => verdict_from_rpc_error(&error),
        None => ProbeVerdict::Unavailable,
    }
}

enum RpcReply {
    Result(Value),
    Error(Value),
}

async fn write_line(
    stdin: &mut tokio::process::ChildStdin,
    value: &Value,
) -> Result<(), std::io::Error> {
    let mut line = value.to_string();
    line.push('\n');
    stdin.write_all(line.as_bytes()).await?;
    stdin.flush().await
}

/// The JSON-RPC response with `id`, skipping notifications. `None` when the
/// stream ends or a line is not JSON (a handshake this host cannot use).
async fn rpc_result(
    reader: &mut BufReader<tokio::process::ChildStdout>,
    id: i64,
) -> Option<RpcReply> {
    let mut line = String::new();
    loop {
        line.clear();
        let read = reader.read_line(&mut line).await.ok()?;
        if read == 0 {
            return None;
        }
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            return None;
        };
        if value.get("id").and_then(Value::as_i64) != Some(id) {
            continue;
        }
        if let Some(error) = value.get("error") {
            return Some(RpcReply::Error(error.clone()));
        }
        return Some(RpcReply::Result(value.get("result")?.clone()));
    }
}

#[cfg(test)]
#[path = "usage_tests.rs"]
mod tests;
