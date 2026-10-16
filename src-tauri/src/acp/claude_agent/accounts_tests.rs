use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::super::{ClaudeAgentService, ClaudeRuntimeProbe, InMemoryClaudeCredentialStore};
use crate::acp::claude_accounts::ClaudeAccountStore;
use crate::acp::config::AgentConfig;

/// Records each probed config dir; reports signed out for `signed_out`.
struct RecordingRuntime {
    probed: parking_lot::Mutex<Vec<Option<PathBuf>>>,
    signed_out: Option<PathBuf>,
}

#[async_trait::async_trait]
impl ClaudeRuntimeProbe for RecordingRuntime {
    async fn ensure_supported(&self) -> Result<(), String> {
        Ok(())
    }

    async fn cli_authentication_status(
        &self,
        config_dir: Option<&Path>,
    ) -> Result<Option<bool>, String> {
        self.probed.lock().push(config_dir.map(Path::to_path_buf));
        let signed_out = config_dir.is_some_and(|dir| self.signed_out.as_deref() == Some(dir));
        Ok(Some(!signed_out))
    }
}

struct Host {
    _root: tempfile::TempDir,
    service: ClaudeAgentService,
    accounts: Arc<ClaudeAccountStore>,
    runtime: Arc<RecordingRuntime>,
    entrypoint: PathBuf,
}

fn host(signed_out: impl FnOnce(&ClaudeAccountStore) -> Option<PathBuf>) -> Host {
    let root = tempfile::tempdir().unwrap();
    let state = root.path().join("state");
    let install_root = state.join("acp-registry-binaries");
    let package = install_root
        .join("claude-acp")
        .join("node_modules")
        .join("@agentclientprotocol")
        .join("claude-agent-acp");
    std::fs::create_dir_all(package.join("dist")).unwrap();
    std::fs::write(
        package.join("package.json"),
        r#"{"name":"@agentclientprotocol/claude-agent-acp","version":"1.0.0","bin":{"claude-agent-acp":"dist/index.js"}}"#,
    )
    .unwrap();
    let entrypoint = package.join("dist").join("index.js");
    std::fs::write(&entrypoint, b"").unwrap();
    let accounts = Arc::new(ClaudeAccountStore::new(&state, root.path().join("shared")));
    let runtime = Arc::new(RecordingRuntime {
        probed: parking_lot::Mutex::new(Vec::new()),
        signed_out: signed_out(&accounts),
    });
    let mut service = ClaudeAgentService::with_adapters(
        Arc::new(InMemoryClaudeCredentialStore::default()),
        Some(install_root),
        runtime.clone(),
    );
    service.set_accounts_for_test(Arc::clone(&accounts));
    Host {
        _root: root,
        service,
        accounts,
        runtime,
        entrypoint,
    }
}

fn managed(entrypoint: &Path) -> AgentConfig {
    AgentConfig {
        config_id: Some("acp-registry:claude-acp".to_string()),
        name: "Claude Agent".to_string(),
        command: "node".to_string(),
        args: vec![entrypoint.to_string_lossy().to_string()],
        env: HashMap::new(),
        allow_terminal: false,
    }
}

#[tokio::test]
async fn a_project_account_exports_its_config_dir_and_probes_that_login() {
    let h = host(|_| None);
    let work = h.accounts.add("Work").unwrap();
    h.accounts
        .set_project_account("office", Some(&work.id))
        .unwrap();
    let dir = h.accounts.config_dir(&work.id).unwrap();

    let mut config = managed(&h.entrypoint);
    assert!(h
        .service
        .prepare_managed_config_for_project(&mut config, Some("office"))
        .await
        .unwrap());
    assert_eq!(
        config.env.get("CLAUDE_CONFIG_DIR").map(String::as_str),
        dir.to_str()
    );
    assert_eq!(h.runtime.probed.lock().as_slice(), &[Some(dir)]);
}

#[tokio::test]
async fn the_builtin_account_leaves_the_host_config_dir_alone() {
    let h = host(|_| None);
    let mut config = managed(&h.entrypoint);
    assert!(h
        .service
        .prepare_managed_config_for_project(&mut config, Some("office"))
        .await
        .unwrap());
    assert!(!config.env.contains_key("CLAUDE_CONFIG_DIR"));
    assert_eq!(h.runtime.probed.lock().as_slice(), &[None]);
}

#[tokio::test]
async fn a_signed_out_project_account_names_the_account() {
    let h = host(|accounts| {
        let work = accounts.add("Work").unwrap();
        accounts
            .set_project_account("office", Some(&work.id))
            .unwrap();
        accounts.config_dir(&work.id)
    });
    let mut config = managed(&h.entrypoint);
    let error = h
        .service
        .prepare_managed_config_for_project(&mut config, Some("office"))
        .await
        .unwrap_err();
    assert!(error.contains("\"Work\" is not signed in"), "{error}");
    assert!(!config.env.contains_key("CLAUDE_CONFIG_DIR"));
}

#[tokio::test]
async fn the_snapshot_reports_the_login_state_of_each_account() {
    let h = host(|accounts| {
        let work = accounts.add("Work").unwrap();
        accounts.config_dir(&work.id)
    });
    let snapshot = h.service.accounts_snapshot().await.unwrap();
    let states: Vec<(&str, Option<bool>)> = snapshot
        .profiles
        .iter()
        .map(|a| (a.name.as_str(), a.signed_in))
        .collect();
    assert_eq!(states, vec![("Default", Some(true)), ("Work", Some(false))]);
}

#[test]
fn cancelling_without_a_running_login_is_a_no_op() {
    let h = host(|_| None);
    assert!(!h.service.cancel_login("default"));
}

#[tokio::test]
async fn a_service_without_host_state_has_no_accounts() {
    let service = ClaudeAgentService::without_host_state();
    assert!(service.accounts_snapshot().await.is_err());
    assert!(service.add_account("Work").is_err());
}
