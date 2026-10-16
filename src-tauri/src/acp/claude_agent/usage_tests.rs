use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::super::{
    ClaudeAgentService, ClaudeAuthMode, ClaudeRuntimeProbe, InMemoryClaudeCredentialStore,
};
use super::ClaudeUsageProbe;
use crate::acp::claude_accounts::usage::ClaudeUsageStatus;
use crate::acp::claude_accounts::ClaudeAccountStore;

struct SignedIn;

#[async_trait::async_trait]
impl ClaudeRuntimeProbe for SignedIn {
    async fn ensure_supported(&self) -> Result<(), String> {
        Ok(())
    }
    async fn cli_authentication_status(&self, _: Option<&Path>) -> Result<Option<bool>, String> {
        Ok(Some(true))
    }
}

/// Answers with the session percent of the probed dir and records each call.
struct FakeProbe {
    calls: parking_lot::Mutex<Vec<Option<PathBuf>>>,
    fail_for: Option<PathBuf>,
}

#[async_trait::async_trait]
impl ClaudeUsageProbe for FakeProbe {
    async fn probe(&self, config_dir: Option<&Path>) -> Result<String, String> {
        self.calls.lock().push(config_dir.map(Path::to_path_buf));
        if config_dir.is_some() && config_dir.map(Path::to_path_buf) == self.fail_for {
            return Err("Claude usage timed out".to_string());
        }
        let percent = if config_dir.is_some() { 80 } else { 10 };
        Ok(format!(
            r#"{{"subscription_type":"max","rate_limits_available":true,"rate_limits":{{"limits":[{{"kind":"session","percent":{percent},"resets_at":"2026-10-13T12:00:00+00:00"}}]}}}}"#
        ))
    }
}

struct Host {
    root: tempfile::TempDir,
    service: ClaudeAgentService,
    accounts: Arc<ClaudeAccountStore>,
    probe: Arc<FakeProbe>,
}

fn host(fail_work: bool) -> (Host, String) {
    let root = tempfile::tempdir().unwrap();
    let state = root.path().join("state");
    let accounts = Arc::new(ClaudeAccountStore::new(&state, root.path().join("shared")));
    let work = accounts.add("Work").unwrap();
    let probe = Arc::new(FakeProbe {
        calls: parking_lot::Mutex::new(Vec::new()),
        fail_for: fail_work.then(|| accounts.config_dir(&work.id).unwrap()),
    });
    let mut service = ClaudeAgentService::with_adapters(
        Arc::new(InMemoryClaudeCredentialStore::default()),
        Some(state.join("acp-registry-binaries")),
        Arc::new(SignedIn),
    );
    service.set_accounts_for_test(Arc::clone(&accounts));
    service.set_usage_probe_for_test(probe.clone());
    (
        Host {
            root,
            service,
            accounts,
            probe,
        },
        work.id,
    )
}

#[tokio::test]
async fn each_account_is_read_with_its_own_config_dir() {
    let (h, work) = host(false);
    let usage = h.service.accounts_usage(false).await.unwrap();
    let percents: Vec<(&str, f64)> = usage
        .iter()
        .map(|u| (u.account_id.as_str(), u.windows[0].percent))
        .collect();
    assert_eq!(percents, vec![("default", 10.0), (work.as_str(), 80.0)]);
    let mut calls = h.probe.calls.lock().clone();
    calls.sort();
    assert_eq!(calls, vec![None, h.accounts.config_dir(&work)]);
}

#[tokio::test]
async fn a_young_read_comes_from_the_cache_even_when_forced() {
    let (h, _) = host(false);
    h.service.accounts_usage(false).await.unwrap();
    h.service.accounts_usage(false).await.unwrap();
    h.service.accounts_usage(true).await.unwrap();
    assert_eq!(h.probe.calls.lock().len(), 2);
}

#[tokio::test]
async fn a_failed_read_is_an_error_entry_not_a_failed_call() {
    let (h, work) = host(true);
    let usage = h.service.accounts_usage(false).await.unwrap();
    let failed = usage.iter().find(|u| u.account_id == work).unwrap();
    assert_eq!(failed.status, ClaudeUsageStatus::Error);
    assert_eq!(failed.message.as_deref(), Some("Claude usage timed out"));
    assert_eq!(usage[0].status, ClaudeUsageStatus::Ok);
}

#[tokio::test]
async fn api_key_mode_reports_no_plan_limits_without_probing() {
    let (h, _) = host(false);
    h.service.set_auth_mode(ClaudeAuthMode::ApiKey).unwrap();
    let usage = h.service.accounts_usage(false).await.unwrap();
    assert!(usage
        .iter()
        .all(|u| u.status == ClaudeUsageStatus::Unavailable));
    assert!(h.probe.calls.lock().is_empty());
    drop(h.root);
}
