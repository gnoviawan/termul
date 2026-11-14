use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::super::{CodexAgentService, CodexLoginStatus};
use super::{probe_app_server, remember, CachedUsage, CodexUsageProbe};
use crate::acp::codex_accounts::usage::{CodexAccountUsage, CodexUsageStatus, ProbeVerdict};
use crate::acp::codex_accounts::CodexAccountStore;

fn script(mode: &str) -> String {
    format!(
        r#"#!/usr/bin/env python3
import json, os, sys
mode = {mode:?}
for raw in sys.stdin:
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        continue
    if "id" not in msg:
        continue
    method = msg.get("method")
    if method == "initialize":
        if mode == "handshake":
            sys.exit(0)
        sys.stdout.write(json.dumps({{"jsonrpc":"2.0","id":msg["id"],"result":{{"userAgent":"mock"}}}}) + "\n")
        sys.stdout.flush()
        continue
    if method != "account/rateLimits/read":
        continue
    if os.environ.get("OPENAI_API_KEY") or os.environ.get("CODEX_ACCESS_TOKEN"):
        reply = {{"jsonrpc":"2.0","id":msg["id"],"error":{{"code":-32603,"message":"credentials present"}}}}
    elif not os.environ.get("CODEX_HOME"):
        reply = {{"jsonrpc":"2.0","id":msg["id"],"error":{{"code":-32603,"message":"home missing"}}}}
    elif mode == "signed_out":
        reply = {{"jsonrpc":"2.0","id":msg["id"],"error":{{"code":-32000,"message":"Not logged in"}}}}
    elif mode == "malformed":
        sys.stdout.write("this is not json\n")
        sys.stdout.flush()
        break
    else:
        reply = {{"jsonrpc":"2.0","id":msg["id"],"result":{{
            "rateLimits": {{
                "planType": "plus",
                "primary": {{"usedPercent": 42, "windowDurationMins": 300, "resetsAt": 1700000000}},
                "secondary": {{"usedPercent": 11, "windowDurationMins": 10080, "resetsAt": 1700086400}}
            }}
        }}}}
    sys.stdout.write(json.dumps(reply) + "\n")
    sys.stdout.flush()
    break
"#,
        mode = mode
    )
}

fn program(dir: &Path, mode: &str) -> PathBuf {
    let path = dir.join(format!("codex-{mode}"));
    std::fs::write(&path, script(mode)).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&path, permissions).unwrap();
    }
    path
}

fn home(dir: &Path) -> PathBuf {
    dir.join("codex-home")
}

/// Run the mock app-server. On Windows the script is not a program, so Python
/// runs it. The interpreter path is absolute so the probe's PATH refresh
/// cannot hide it.
async fn probe_script(script: &Path, dir: &Path) -> ProbeVerdict {
    if cfg!(windows) {
        let python = python_executable();
        return probe_app_server(&python, &[script.to_string_lossy().into_owned()], dir).await;
    }
    probe_app_server(&script.to_string_lossy(), &[], dir).await
}

fn python_executable() -> String {
    let output = std::process::Command::new("python")
        .arg("-c")
        .arg("import sys; print(sys.executable)")
        .output()
        .expect("python is required to run the mock app-server on Windows");
    assert!(
        output.status.success(),
        "python -c failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .expect("python executable path")
        .trim()
        .to_string()
}

#[tokio::test]
async fn a_mock_app_server_reports_five_hour_and_weekly_windows() {
    let root = tempfile::tempdir().unwrap();
    let bin = program(root.path(), "ok");
    let dir = home(root.path());
    let verdict = probe_script(&bin, &dir).await;
    let usage = crate::acp::codex_accounts::usage::usage_from_verdict("default", verdict, 1);
    assert_eq!(usage.status, CodexUsageStatus::Ok);
    assert_eq!(usage.plan_type.as_deref(), Some("plus"));
    assert_eq!(usage.windows[0].kind, "session");
    assert!((usage.windows[0].percent - 42.0).abs() < f64::EPSILON);
    assert_eq!(usage.windows[1].kind, "weekly");
    assert!(
        dir.is_dir(),
        "the probe creates CODEX_HOME before it starts"
    );
}

#[tokio::test]
async fn a_signed_out_app_server_is_signed_out() {
    let root = tempfile::tempdir().unwrap();
    let bin = program(root.path(), "signed_out");
    let dir = home(root.path());
    std::fs::create_dir_all(&dir).unwrap();
    let verdict = probe_script(&bin, &dir).await;
    let usage = crate::acp::codex_accounts::usage::usage_from_verdict("default", verdict, 1);
    assert_eq!(usage.status, CodexUsageStatus::SignedOut);
    assert!(usage.windows.is_empty());
    assert!(usage.message.is_none());
}

#[tokio::test]
async fn a_missing_cli_is_unavailable() {
    let root = tempfile::tempdir().unwrap();
    let dir = home(root.path());
    std::fs::create_dir_all(&dir).unwrap();
    let missing = root.path().join("no-such-codex");
    let verdict = probe_app_server(&missing.to_string_lossy(), &[], &dir).await;
    let usage = crate::acp::codex_accounts::usage::usage_from_verdict("default", verdict, 1);
    assert_eq!(usage.status, CodexUsageStatus::Unavailable);
}

#[tokio::test]
async fn malformed_app_server_output_is_unavailable() {
    let root = tempfile::tempdir().unwrap();
    let bin = program(root.path(), "malformed");
    let dir = home(root.path());
    std::fs::create_dir_all(&dir).unwrap();
    let verdict = probe_script(&bin, &dir).await;
    let usage = crate::acp::codex_accounts::usage::usage_from_verdict("default", verdict, 1);
    assert_eq!(usage.status, CodexUsageStatus::Unavailable);
}

#[tokio::test]
async fn a_failed_probe_keeps_the_last_good_read() {
    let mut cache = std::collections::HashMap::new();
    let good = CodexAccountUsage {
        account_id: "default".to_string(),
        status: CodexUsageStatus::Ok,
        plan_type: Some("plus".to_string()),
        windows: vec![],
        checked_at: 10,
        message: None,
    };
    remember(&mut cache, good.clone());
    remember(
        &mut cache,
        CodexAccountUsage::status_only(
            "default",
            CodexUsageStatus::Error,
            "Codex usage timed out",
            12,
        ),
    );
    let kept = cache.get("default").expect("cached read");
    assert_eq!(kept.usage, good);
    assert_eq!(kept.attempted_at, 12);
    remember(
        &mut cache,
        CodexAccountUsage {
            account_id: "default".to_string(),
            status: CodexUsageStatus::SignedOut,
            plan_type: None,
            windows: vec![],
            checked_at: 3,
            message: None,
        },
    );
    assert_eq!(
        cache.get("default").map(|entry| entry.usage.status),
        Some(CodexUsageStatus::Ok)
    );
    remember(
        &mut cache,
        CodexAccountUsage {
            account_id: "default".to_string(),
            status: CodexUsageStatus::SignedOut,
            plan_type: None,
            windows: vec![],
            checked_at: 13,
            message: None,
        },
    );
    assert_eq!(
        cache.get("default").map(|entry| entry.usage.status),
        Some(CodexUsageStatus::SignedOut)
    );
}

struct Boom;

#[async_trait::async_trait]
impl CodexUsageProbe for Boom {
    async fn probe(&self, _codex_home: &Path) -> ProbeVerdict {
        ProbeVerdict::Failed("Codex usage timed out")
    }
}

struct SignedIn;

#[async_trait::async_trait]
impl CodexLoginStatus for SignedIn {
    async fn login_status(
        &self,
        _codex_home: Option<&Path>,
        _codex_bin: Option<&str>,
        _project_path: Option<&str>,
    ) -> Result<Option<bool>, String> {
        Ok(Some(true))
    }
}

#[tokio::test]
async fn the_service_keeps_a_good_read_when_the_next_probe_fails() {
    let root = tempfile::tempdir().unwrap();
    let state = root.path().join("state");
    let store = Arc::new(CodexAccountStore::new(&state, root.path().join("shared")));
    let mut service = CodexAgentService::with_probe(store, Arc::new(SignedIn));
    service.usage_probe = Arc::new(Boom);
    service.usage_cache.lock().insert(
        "default".to_string(),
        CachedUsage {
            usage: CodexAccountUsage {
                account_id: "default".to_string(),
                status: CodexUsageStatus::Ok,
                plan_type: Some("plus".to_string()),
                windows: vec![],
                checked_at: 0,
                message: None,
            },
            attempted_at: 0,
        },
    );
    let usage = service.accounts_usage(true).await.unwrap();
    assert_eq!(usage.len(), 1);
    assert_eq!(usage[0].status, CodexUsageStatus::Ok);
    assert_eq!(usage[0].plan_type.as_deref(), Some("plus"));
}

struct SignsOut;

#[async_trait::async_trait]
impl CodexUsageProbe for SignsOut {
    async fn probe(&self, _codex_home: &Path) -> ProbeVerdict {
        ProbeVerdict::SignedOut
    }
}

#[tokio::test]
async fn a_recent_attempt_is_not_probed_again() {
    let root = tempfile::tempdir().unwrap();
    let state = root.path().join("state");
    let store = Arc::new(CodexAccountStore::new(&state, root.path().join("shared")));
    let mut service = CodexAgentService::with_probe(store, Arc::new(SignedIn));
    service.usage_probe = Arc::new(SignsOut);
    service.usage_cache.lock().insert(
        "default".to_string(),
        CachedUsage {
            usage: CodexAccountUsage {
                account_id: "default".to_string(),
                status: CodexUsageStatus::Ok,
                plan_type: Some("plus".to_string()),
                windows: vec![],
                checked_at: 0,
                message: None,
            },
            attempted_at: chrono::Utc::now().timestamp_millis(),
        },
    );
    let usage = service.accounts_usage(true).await.unwrap();
    assert_eq!(usage[0].status, CodexUsageStatus::Ok);
    assert_eq!(usage[0].plan_type.as_deref(), Some("plus"));
}
