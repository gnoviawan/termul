use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::{
    effective_home, CodexAgentService, HomeSource, CODEX_ACP_CONFIG_ID, CODEX_HOME_ENV,
    STRIP_CODEX_API_CREDENTIALS,
};
use crate::acp::codex_accounts::{strip_signed_out_tag, CodexAccountStore};
use crate::acp::config::AgentConfig;

/// Records each probed home. A home equal to `signed_out` reports signed out.
struct RecordingProbe {
    probed: parking_lot::Mutex<Vec<Option<PathBuf>>>,
    bins: parking_lot::Mutex<Vec<Option<String>>>,
    paths: parking_lot::Mutex<Vec<Option<String>>>,
    signed_out: Option<PathBuf>,
    /// The host home (`None`) reports signed out.
    host_signed_out: bool,
    /// The probe cannot run the Codex CLI.
    unavailable: bool,
    /// When set, the probe checks the directory already exists.
    require_dir: bool,
}

#[async_trait::async_trait]
impl super::CodexLoginStatus for RecordingProbe {
    async fn login_status(
        &self,
        codex_home: Option<&Path>,
        codex_bin: Option<&str>,
        project_path: Option<&str>,
    ) -> Result<Option<bool>, String> {
        self.bins.lock().push(codex_bin.map(str::to_string));
        self.paths.lock().push(project_path.map(str::to_string));
        if self.require_dir {
            let dir = codex_home.expect("a created home");
            assert!(dir.is_dir(), "Codex home must exist before the login probe");
        }
        self.probed.lock().push(codex_home.map(Path::to_path_buf));
        if self.unavailable {
            return Ok(None);
        }
        let signed_out = match codex_home {
            None => self.host_signed_out,
            Some(dir) => self.signed_out.as_deref() == Some(dir),
        };
        Ok(Some(!signed_out))
    }
}

struct Host {
    root: tempfile::TempDir,
    service: CodexAgentService,
    accounts: Arc<CodexAccountStore>,
    runtime: Arc<RecordingProbe>,
}

fn host(signed_out: impl FnOnce(&CodexAccountStore) -> Option<PathBuf>) -> Host {
    let root = tempfile::tempdir().unwrap();
    let state = root.path().join("state");
    let accounts = Arc::new(CodexAccountStore::new(&state, root.path().join("shared")));
    let runtime = Arc::new(RecordingProbe {
        probed: parking_lot::Mutex::new(Vec::new()),
        signed_out: signed_out(&accounts),
        bins: parking_lot::Mutex::new(Vec::new()),
        paths: parking_lot::Mutex::new(Vec::new()),
        host_signed_out: false,
        unavailable: false,
        require_dir: false,
    });
    let service = CodexAgentService::with_probe(Arc::clone(&accounts), runtime.clone());
    Host {
        root,
        service,
        accounts,
        runtime,
    }
}

fn managed() -> AgentConfig {
    AgentConfig {
        config_id: Some(CODEX_ACP_CONFIG_ID.to_string()),
        name: "Codex".to_string(),
        command: "npx".to_string(),
        args: vec![
            "-y".to_string(),
            "@agentclientprotocol/codex-acp@1.12.0".to_string(),
        ],
        env: HashMap::from([
            ("OPENAI_API_KEY".to_string(), "sk-test".to_string()),
            ("CODEX_ACCESS_TOKEN".to_string(), "token-test".to_string()),
        ]),
        allow_terminal: false,
    }
}

fn with_home(dir: &str) -> AgentConfig {
    let mut config = managed();
    config
        .env
        .insert(CODEX_HOME_ENV.to_string(), dir.to_string());
    config
}

#[tokio::test]
async fn a_project_account_exports_its_home_strips_keys_and_probes_that_login() {
    let h = host(|_| None);
    let work = h.accounts.add("Work").unwrap();
    h.accounts
        .set_project_account("office", Some(&work.id), None)
        .unwrap();
    let dir = h.accounts.config_dir(&work.id).unwrap();

    let mut config = managed();
    assert!(h
        .service
        .prepare_managed_config_for_project(&mut config, Some("office"))
        .await
        .unwrap());
    assert_eq!(
        config.env.get(CODEX_HOME_ENV).map(String::as_str),
        dir.to_str()
    );
    assert!(!config.env.contains_key("OPENAI_API_KEY"));
    assert!(!config.env.contains_key("CODEX_ACCESS_TOKEN"));
    assert_eq!(
        config
            .env
            .get(STRIP_CODEX_API_CREDENTIALS)
            .map(String::as_str),
        Some("1")
    );
    assert_eq!(h.runtime.probed.lock().as_slice(), &[Some(dir.clone())]);
    assert!(dir.join("sessions").is_dir());
}

#[tokio::test]
async fn the_builtin_account_unsets_codex_home_and_strips_keys() {
    let h = host(|_| None);
    let mut config = with_home("relative/home");
    assert!(h
        .service
        .prepare_managed_config_for_project(&mut config, Some("office"))
        .await
        .unwrap());
    assert!(!config.env.contains_key(CODEX_HOME_ENV));
    assert!(!config.env.contains_key("OPENAI_API_KEY"));
    assert!(!config.env.contains_key("CODEX_ACCESS_TOKEN"));
    assert_eq!(h.runtime.probed.lock().as_slice(), &[None]);
}

#[tokio::test]
async fn a_signed_out_project_account_names_the_account_and_leaves_env_unchanged() {
    let h = host(|accounts| {
        let work = accounts.add("Work").unwrap();
        accounts
            .set_project_account("office", Some(&work.id), None)
            .unwrap();
        accounts.config_dir(&work.id)
    });
    let mut config = managed();
    let error = h
        .service
        .prepare_managed_config_for_project(&mut config, Some("office"))
        .await
        .unwrap_err();
    assert_eq!(
        strip_signed_out_tag(&error),
        Some(
            "The Codex account \"Work\" is not signed in. Run `codex login` for that account, then retry."
        )
    );
    assert!(!config.env.contains_key(CODEX_HOME_ENV));
    assert_eq!(
        config.env.get("OPENAI_API_KEY").map(String::as_str),
        Some("sk-test")
    );
}

#[tokio::test]
async fn a_project_env_home_overrides_the_linked_account() {
    let h = host(|_| None);
    let work = h.accounts.add("Work").unwrap();
    h.accounts
        .set_project_account("office", Some(&work.id), None)
        .unwrap();
    let override_home = h.root.path().join("codex-work-home");
    let mut config = with_home(override_home.to_str().unwrap());
    assert!(h
        .service
        .prepare_managed_config_for_project(&mut config, Some("office"))
        .await
        .unwrap());
    assert_eq!(
        config.env.get(CODEX_HOME_ENV).map(String::as_str),
        override_home.to_str()
    );
    assert_eq!(h.runtime.probed.lock().as_slice(), &[Some(override_home)]);
    assert!(!config.env.contains_key("OPENAI_API_KEY"));
    assert!(!config.env.contains_key("CODEX_ACCESS_TOKEN"));
}

#[tokio::test]
async fn a_signed_out_project_env_home_names_the_project_env() {
    let root = tempfile::tempdir().unwrap();
    let override_home = root.path().join("codex-signed-out-home");
    let h = host(|_| Some(override_home.clone()));
    let mut config = with_home(override_home.to_str().unwrap());
    let error = h
        .service
        .prepare_managed_config_for_project(&mut config, Some("office"))
        .await
        .unwrap_err();
    assert_eq!(
        strip_signed_out_tag(&error),
        Some("The Codex profile set by CODEX_HOME in the project environment is not signed in. Run `codex login` with that CODEX_HOME, then retry.")
    );
}

#[tokio::test]
async fn a_relative_project_env_home_falls_back_to_the_account_dir() {
    let h = host(|_| None);
    let work = h.accounts.add("Work").unwrap();
    h.accounts
        .set_project_account("office", Some(&work.id), None)
        .unwrap();
    let account_dir = h.accounts.config_dir(&work.id).unwrap();
    let mut config = with_home("relative/dir");
    assert!(h
        .service
        .prepare_managed_config_for_project(&mut config, Some("office"))
        .await
        .unwrap());
    assert_eq!(
        config.env.get(CODEX_HOME_ENV).map(String::as_str),
        account_dir.to_str()
    );
    assert_eq!(h.runtime.probed.lock().as_slice(), &[Some(account_dir)]);
}

#[tokio::test]
async fn the_home_directory_exists_before_the_login_probe() {
    let root = tempfile::tempdir().unwrap();
    let state = root.path().join("state");
    let accounts = Arc::new(CodexAccountStore::new(&state, root.path().join("shared")));
    let runtime = Arc::new(RecordingProbe {
        probed: parking_lot::Mutex::new(Vec::new()),
        signed_out: None,
        bins: parking_lot::Mutex::new(Vec::new()),
        paths: parking_lot::Mutex::new(Vec::new()),
        host_signed_out: false,
        unavailable: false,
        require_dir: true,
    });
    let service = CodexAgentService::with_probe(accounts, runtime);
    let home = root.path().join("brand-new-home");
    assert!(!home.exists());
    let mut config = with_home(home.to_str().unwrap());
    assert!(service
        .prepare_managed_config_for_project(&mut config, Some("office"))
        .await
        .unwrap());
    assert!(home.is_dir());
}

#[test]
fn a_tilde_project_env_home_resolves_under_home() {
    let home = std::env::temp_dir().join("home-of-me");
    let env = HashMap::from([(CODEX_HOME_ENV.to_string(), "~/.codex-work".to_string())]);
    let (dir, source) = effective_home(&env, None, Some(&home));
    assert_eq!(dir, Some(home.join(".codex-work")));
    assert_eq!(source, HomeSource::ProjectEnv);
    let env = HashMap::from([(CODEX_HOME_ENV.to_string(), "~".to_string())]);
    let (dir, _) = effective_home(&env, None, Some(&home));
    assert_eq!(dir, Some(home));
}

#[test]
fn a_tilde_project_env_home_without_a_home_is_ignored() {
    let env = HashMap::from([(CODEX_HOME_ENV.to_string(), "~/.codex-work".to_string())]);
    let (dir, source) = effective_home(&env, None, None);
    assert_eq!(dir, None);
    assert_eq!(source, HomeSource::Host);
}

#[tokio::test]
async fn a_signed_out_builtin_account_names_the_host_login() {
    let root = tempfile::tempdir().unwrap();
    let accounts = Arc::new(CodexAccountStore::new(
        &root.path().join("state"),
        root.path().join("shared"),
    ));
    let runtime = Arc::new(RecordingProbe {
        probed: parking_lot::Mutex::new(Vec::new()),
        signed_out: None,
        bins: parking_lot::Mutex::new(Vec::new()),
        paths: parking_lot::Mutex::new(Vec::new()),
        host_signed_out: true,
        unavailable: false,
        require_dir: false,
    });
    let service = CodexAgentService::with_probe(accounts, runtime);
    let mut config = managed();
    let error = service
        .prepare_managed_config_for_project(&mut config, None)
        .await
        .unwrap_err();
    assert_eq!(
        strip_signed_out_tag(&error),
        Some("Codex CLI is not signed in. Run `codex login`, then retry.")
    );
}

#[tokio::test]
async fn another_agent_keeps_its_api_key_and_codex_home() {
    let h = host(|_| None);
    let mut config = managed();
    config.config_id = Some("acp-registry:claude-acp".to_string());
    config
        .env
        .insert(CODEX_HOME_ENV.to_string(), "/tmp/keep".to_string());
    assert!(!h
        .service
        .prepare_managed_config_for_project(&mut config, Some("office"))
        .await
        .unwrap());
    assert_eq!(
        config.env.get("OPENAI_API_KEY").map(String::as_str),
        Some("sk-test")
    );
    assert_eq!(
        config.env.get(CODEX_HOME_ENV).map(String::as_str),
        Some("/tmp/keep")
    );
    assert!(h.runtime.probed.lock().is_empty());
}

#[tokio::test]
async fn an_inactive_service_does_not_prepare_codex() {
    let service = CodexAgentService::without_host_state();
    let mut config = managed();
    assert!(!service
        .prepare_managed_config_for_project(&mut config, Some("office"))
        .await
        .unwrap());
    assert!(config.env.contains_key("OPENAI_API_KEY"));
}

#[tokio::test]
async fn a_missing_codex_cli_is_not_reported_as_signed_out() {
    let root = tempfile::tempdir().unwrap();
    let accounts = Arc::new(CodexAccountStore::new(
        &root.path().join("state"),
        root.path().join("shared"),
    ));
    let runtime = Arc::new(RecordingProbe {
        probed: parking_lot::Mutex::new(Vec::new()),
        bins: parking_lot::Mutex::new(Vec::new()),
        paths: parking_lot::Mutex::new(Vec::new()),
        signed_out: None,
        host_signed_out: false,
        unavailable: true,
        require_dir: false,
    });
    let service = CodexAgentService::with_probe(accounts, runtime);
    let mut config = managed();
    let error = service
        .prepare_managed_config_for_project(&mut config, None)
        .await
        .unwrap_err();
    assert!(strip_signed_out_tag(&error).is_none(), "{error}");
    assert!(error.contains("CODEX_PATH"), "{error}");
    assert!(!config.env.contains_key(STRIP_CODEX_API_CREDENTIALS));
}

#[tokio::test]
async fn the_login_probe_uses_the_project_codex_path() {
    let h = host(|_| None);
    let mut config = managed();
    config
        .env
        .insert("CODEX_PATH".to_string(), "/opt/codex".to_string());
    assert!(h
        .service
        .prepare_managed_config_for_project(&mut config, None)
        .await
        .unwrap());
    assert_eq!(
        h.runtime.bins.lock().as_slice(),
        &[Some("/opt/codex".to_string())]
    );
}

#[tokio::test]
async fn the_login_probe_receives_the_project_path() {
    let h = host(|_| None);
    let mut config = managed();
    config
        .env
        .insert("PATH".to_string(), "/opt/project-bin".to_string());
    config
        .env
        .insert("CODEX_PATH".to_string(), "codex".to_string());
    assert!(h
        .service
        .prepare_managed_config_for_project(&mut config, None)
        .await
        .unwrap());
    assert_eq!(
        h.runtime.paths.lock().as_slice(),
        &[Some("/opt/project-bin".to_string())]
    );
    assert_eq!(
        h.runtime.bins.lock().as_slice(),
        &[Some("codex".to_string())]
    );
}
