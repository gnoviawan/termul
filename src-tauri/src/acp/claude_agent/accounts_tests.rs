use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::super::{
    effective_config_dir, ClaudeAgentService, ClaudeRuntimeProbe, ConfigDirSource,
    InMemoryClaudeCredentialStore,
};
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

fn work_dir() -> PathBuf {
    std::env::temp_dir().join("claude-work")
}

fn env_with_config_dir(dir: &str) -> HashMap<String, String> {
    HashMap::from([("CLAUDE_CONFIG_DIR".to_string(), dir.to_string())])
}

fn with_env_config_dir(entrypoint: &Path, dir: &str) -> AgentConfig {
    let mut config = managed(entrypoint);
    config
        .env
        .insert("CLAUDE_CONFIG_DIR".to_string(), dir.to_string());
    config
}

#[tokio::test]
async fn a_project_env_config_dir_on_the_builtin_account_is_the_one_probed() {
    let h = host(|_| None);
    let mut config = with_env_config_dir(&h.entrypoint, work_dir().to_str().unwrap());
    assert!(h
        .service
        .prepare_managed_config_for_project(&mut config, Some("office"))
        .await
        .unwrap());
    assert_eq!(
        config.env.get("CLAUDE_CONFIG_DIR").map(String::as_str),
        work_dir().to_str()
    );
    assert_eq!(h.runtime.probed.lock().as_slice(), &[Some(work_dir())]);
}

#[tokio::test]
async fn a_project_env_config_dir_overrides_the_project_account() {
    let h = host(|_| None);
    let work = h.accounts.add("Work").unwrap();
    h.accounts
        .set_project_account("office", Some(&work.id))
        .unwrap();
    let mut config = with_env_config_dir(&h.entrypoint, work_dir().to_str().unwrap());
    assert!(h
        .service
        .prepare_managed_config_for_project(&mut config, Some("office"))
        .await
        .unwrap());
    assert_eq!(
        config.env.get("CLAUDE_CONFIG_DIR").map(String::as_str),
        work_dir().to_str()
    );
    assert_eq!(h.runtime.probed.lock().as_slice(), &[Some(work_dir())]);
}

#[tokio::test]
async fn a_signed_out_project_env_config_dir_names_the_project_env() {
    let h = host(|_| Some(work_dir()));
    let mut config = with_env_config_dir(&h.entrypoint, work_dir().to_str().unwrap());
    let error = h
        .service
        .prepare_managed_config_for_project(&mut config, Some("office"))
        .await
        .unwrap_err();
    assert_eq!(
        error,
        "The Claude profile set by CLAUDE_CONFIG_DIR in the project environment is not signed in. Run `claude auth login` with that CLAUDE_CONFIG_DIR, then retry."
    );
}

#[tokio::test]
async fn a_relative_project_env_config_dir_falls_back_to_the_account_dir_for_probe_and_launch() {
    let h = host(|_| None);
    let work = h.accounts.add("Work").unwrap();
    h.accounts
        .set_project_account("office", Some(&work.id))
        .unwrap();
    let account_dir = h.accounts.config_dir(&work.id).unwrap();
    let mut config = with_env_config_dir(&h.entrypoint, "relative/dir");
    assert!(h
        .service
        .prepare_managed_config_for_project(&mut config, Some("office"))
        .await
        .unwrap());
    assert_eq!(
        config.env.get("CLAUDE_CONFIG_DIR").map(String::as_str),
        account_dir.to_str()
    );
    assert_eq!(h.runtime.probed.lock().as_slice(), &[Some(account_dir)]);
}

#[tokio::test]
async fn a_relative_project_env_config_dir_without_an_account_uses_the_host_dir() {
    let h = host(|_| None);
    let mut config = with_env_config_dir(&h.entrypoint, "relative/dir");
    assert!(h
        .service
        .prepare_managed_config_for_project(&mut config, Some("office"))
        .await
        .unwrap());
    assert!(!config.env.contains_key("CLAUDE_CONFIG_DIR"));
    assert_eq!(h.runtime.probed.lock().as_slice(), &[None]);
}

#[test]
fn a_tilde_project_env_config_dir_resolves_under_home() {
    let home = std::env::temp_dir().join("home-of-me");
    let (dir, source) =
        effective_config_dir(&env_with_config_dir("~/.claude-work"), None, Some(&home));
    assert_eq!(dir, Some(home.join(".claude-work")));
    assert_eq!(source, ConfigDirSource::ProjectEnv);
    let (dir, _) = effective_config_dir(&env_with_config_dir("~"), None, Some(&home));
    assert_eq!(dir, Some(home));
}

#[test]
fn a_tilde_project_env_config_dir_without_a_home_is_ignored() {
    let (dir, source) = effective_config_dir(&env_with_config_dir("~/.claude-work"), None, None);
    assert_eq!(dir, None);
    assert_eq!(source, ConfigDirSource::Host);
}

#[test]
fn an_absolute_project_env_config_dir_is_kept_as_given() {
    let home = std::env::temp_dir().join("home-of-me");
    let (dir, source) = effective_config_dir(
        &env_with_config_dir(work_dir().to_str().unwrap()),
        None,
        Some(&home),
    );
    assert_eq!(dir, Some(work_dir()));
    assert_eq!(source, ConfigDirSource::ProjectEnv);
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
