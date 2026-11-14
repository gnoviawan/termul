use std::sync::Arc;

use super::{CodexAgentService, CodexSignInCheck, FixedLogins};
use crate::acp::codex_accounts::{strip_signed_out_tag, CodexAccountStore};
use crate::acp::codex_agent::{CODEX_ACP_CONFIG_ID, CODEX_HOME_ENV};
use crate::acp::config::AgentConfig;

fn host(signed_out: &[&str]) -> (tempfile::TempDir, CodexAgentService, Arc<FixedLogins>) {
    let root = tempfile::tempdir().unwrap();
    let store = Arc::new(CodexAccountStore::new(
        root.path(),
        root.path().join("shared"),
    ));
    let probe = Arc::new(FixedLogins::new(signed_out));
    let service = CodexAgentService::with_probe(
        Arc::clone(&store),
        probe.clone() as Arc<dyn crate::acp::codex_agent::CodexLoginStatus>,
    );
    (root, service, probe)
}

fn codex_config() -> AgentConfig {
    AgentConfig {
        config_id: Some(CODEX_ACP_CONFIG_ID.to_string()),
        name: "Codex".to_string(),
        command: "npx".to_string(),
        args: vec![],
        env: [("OPENAI_API_KEY".to_string(), "sk-test".to_string())]
            .into_iter()
            .collect(),
        allow_terminal: false,
    }
}

#[tokio::test]
async fn the_snapshot_reports_each_home_login_and_no_secret() {
    let (_root, service, _) = host(&["default"]);
    let work = service.insert_profile("Work").unwrap();
    let snapshot = service.profile_list().await.unwrap();
    let text = serde_json::to_string(&snapshot).unwrap();
    assert!(!text.to_ascii_lowercase().contains("token"));
    assert!(!text.contains("sk-"));
    let signed_in = |id: &str| {
        snapshot
            .profiles
            .iter()
            .find(|row| row.id == id)
            .unwrap()
            .signed_in
    };
    assert_eq!(signed_in("default"), Some(false));
    assert_eq!(signed_in(&work.id), Some(true));
    assert!(snapshot.auto_switch);
}

#[tokio::test]
async fn choosing_a_signed_out_account_leaves_the_store_unchanged() {
    let root = tempfile::tempdir().unwrap();
    let store = Arc::new(CodexAccountStore::new(
        root.path(),
        root.path().join("shared"),
    ));
    let work = store.add("Work").unwrap();
    let service = CodexAgentService::with_probe(
        Arc::clone(&store),
        Arc::new(FixedLogins::new(&[work.id.as_str()]))
            as Arc<dyn crate::acp::codex_agent::CodexLoginStatus>,
    );
    let error = service
        .set_project_account("office", Some(&work.id), None, CodexSignInCheck::Required)
        .await
        .unwrap_err();
    assert_eq!(
        strip_signed_out_tag(&error),
        Some(
            "The Codex account \"Work\" is not signed in. Sign in to it in Settings → Provider, then choose it again."
        )
    );
    assert!(service
        .set_default_account(&work.id, CodexSignInCheck::Required)
        .await
        .unwrap_err()
        .contains("ACP_CODEX_ACCOUNT_SIGNED_OUT"));
    assert!(store.snapshot().unwrap().project_profiles.is_empty());
    assert_eq!(store.snapshot().unwrap().default_account_id, "default");
    assert!(service
        .set_default_account(&work.id, CodexSignInCheck::Skip)
        .await
        .is_ok());
    assert_eq!(store.snapshot().unwrap().default_account_id, work.id);
}

#[tokio::test]
async fn an_expected_account_loses_before_the_sign_in_probe() {
    let (_root, service, _) = host(&[]);
    let work = service.insert_profile("Work").unwrap();
    assert!(service
        .set_project_account(
            "office",
            Some(&work.id),
            Some("default"),
            CodexSignInCheck::Required
        )
        .await
        .unwrap());
    let applied = service
        .set_project_account("office", None, Some("default"), CodexSignInCheck::Required)
        .await
        .unwrap();
    assert!(!applied);
}

#[tokio::test]
async fn remove_signs_out_that_home_then_moves_projects() {
    let (root, service, probe) = host(&[]);
    let work = service.insert_profile("Work").unwrap();
    service
        .set_project_account("office", Some(&work.id), None, CodexSignInCheck::Required)
        .await
        .unwrap();
    let moved = service.remove_account(&work.id).await.unwrap();
    assert_eq!(moved, vec!["office".to_string()]);
    let logouts = probe.logouts.lock().unwrap().clone();
    assert_eq!(
        logouts[0].as_deref(),
        Some(root.path().join("codex-accounts").join(&work.id).as_path())
    );
    assert!(!service.has_account(&work.id).unwrap());
    assert!(service.remove_account("default").await.is_err());
    assert_eq!(probe.logouts.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn sign_in_spawn_sets_the_account_home_without_a_login_check() {
    let root = tempfile::tempdir().unwrap();
    let store = Arc::new(CodexAccountStore::new(
        root.path(),
        root.path().join("shared"),
    ));
    let work = store.add("Work").unwrap();
    let probe = Arc::new(FixedLogins::new(&[work.id.as_str()]));
    let service = CodexAgentService::with_probe(
        store,
        probe.clone() as Arc<dyn crate::acp::codex_agent::CodexLoginStatus>,
    );
    let mut config = codex_config();
    service
        .prepare_sign_in_config(&mut config, &work.id)
        .await
        .unwrap();
    assert!(probe.logouts.lock().unwrap().is_empty());
    assert!(!config.env.contains_key("OPENAI_API_KEY"));
    let home = config.env.get(CODEX_HOME_ENV).unwrap();
    assert!(home.ends_with(&work.id));
    assert!(std::path::Path::new(home).is_dir());
    config.config_id = Some("acp-registry:claude-acp".to_string());
    assert!(service
        .prepare_sign_in_config(&mut config, &work.id)
        .await
        .is_err());
}

#[tokio::test]
async fn the_built_in_sign_in_spawn_does_not_set_codex_home() {
    let (_root, service, _) = host(&["default"]);
    let mut config = codex_config();
    config
        .env
        .insert(CODEX_HOME_ENV.to_string(), "/tmp/other".to_string());
    service
        .prepare_sign_in_config(&mut config, "default")
        .await
        .unwrap();
    assert!(!config.env.contains_key(CODEX_HOME_ENV));
    assert!(!config.env.contains_key("OPENAI_API_KEY"));
}

#[test]
fn a_missing_account_cannot_start_a_terminal_login() {
    let (_root, service, _) = host(&[]);
    let error = service.run_account_cli_login("ffff").unwrap_err();
    assert_eq!(error, "That Codex account does not exist");
}

#[test]
fn device_login_args_are_chatgpt_only() {
    assert_eq!(
        crate::acp::commands::CODEX_DEVICE_LOGIN_ARGS,
        &["login", "--device-auth"][..]
    );
}
