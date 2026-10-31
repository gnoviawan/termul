use std::sync::Arc;

use serde_json::json;

use super::engine::HttpConfig;
use super::model::Op;
use super::secrets::{choose_vault, SecretError, Secrets, FILE_VAULT_NAME};
use super::service::AutomationService;
use super::store::AutomationStore;
use super::test_support::{test_engine, MemoryVault};
use crate::web::log_capture::logged_lines;

fn secrets(vault: Arc<MemoryVault>) -> Secrets {
    Secrets::new(vault, Arc::new(AutomationStore::open_in_memory().unwrap()))
}

#[test]
fn values_go_to_the_vault_under_the_project_account_and_names_are_listed() {
    let vault = Arc::new(MemoryVault::default());
    let secrets = secrets(vault.clone());
    secrets.set("p1", "API_KEY", "sk-1").unwrap();
    secrets.set("p1", "HOOK", "h-1").unwrap();
    secrets.set("p2", "API_KEY", "sk-2").unwrap();

    assert_eq!(secrets.list_names("p1").unwrap(), vec!["API_KEY", "HOOK"]);
    assert_eq!(
        vault
            .entries
            .lock()
            .get("automation:p1:API_KEY")
            .map(String::as_str),
        Some("sk-1")
    );
    let resolved = secrets
        .resolve("p1", &["API_KEY".to_string(), "HOOK".to_string()])
        .unwrap();
    assert_eq!(resolved["API_KEY"], "sk-1");
    assert_eq!(resolved["HOOK"], "h-1");

    secrets.delete("p1", "HOOK").unwrap();
    assert_eq!(secrets.list_names("p1").unwrap(), vec!["API_KEY"]);
    assert_eq!(
        secrets
            .resolve("p1", &["HOOK".to_string()])
            .unwrap_err()
            .to_string(),
        "secret_missing:HOOK"
    );
}

#[test]
fn a_locked_keychain_fails_closed() {
    let secrets = secrets(Arc::new(MemoryVault {
        unavailable: true,
        ..MemoryVault::default()
    }));
    let error = secrets.set("p1", "API_KEY", "sk-1").unwrap_err();
    assert_eq!(error.to_string(), "keychain_unavailable");
    assert!(secrets.list_names("p1").unwrap().is_empty());
    assert_eq!(
        secrets.resolve("p1", &["API_KEY".to_string()]).unwrap_err(),
        SecretError::KeychainUnavailable
    );
}

#[test]
fn names_must_be_template_segments_and_values_non_empty() {
    let secrets = secrets(Arc::new(MemoryVault::default()));
    assert_eq!(
        secrets.set("p1", "has space", "v").unwrap_err(),
        SecretError::InvalidName("has space".to_string())
    );
    assert_eq!(
        secrets.set("p1", "OK", "").unwrap_err(),
        SecretError::EmptyValue
    );
}

const FILE_VALUE: &str = "sk-file-vault-7f3a";

fn vault_file(dir: &std::path::Path) -> serde_json::Value {
    serde_json::from_slice(&std::fs::read(dir.join(FILE_VAULT_NAME)).unwrap()).unwrap()
}

#[test]
fn without_a_keychain_values_round_trip_through_an_owner_only_file() {
    let dir = tempfile::tempdir().unwrap();
    let secrets = Secrets::new(
        choose_vault(dir.path(), || false),
        Arc::new(AutomationStore::open_in_memory().unwrap()),
    );

    secrets.set("p1", "API_KEY", FILE_VALUE).unwrap();
    secrets.set("p1", "HOOK", "h-1").unwrap();

    assert_eq!(
        vault_file(dir.path()),
        json!({ "automation:p1:API_KEY": FILE_VALUE, "automation:p1:HOOK": "h-1" })
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(dir.path().join(FILE_VAULT_NAME))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    let reopened = Secrets::new(
        choose_vault(dir.path(), || false),
        Arc::new(AutomationStore::open_in_memory().unwrap()),
    );
    assert_eq!(
        reopened.resolve("p1", &["API_KEY".to_string()]).unwrap()["API_KEY"],
        FILE_VALUE
    );

    secrets.delete("p1", "API_KEY").unwrap();
    assert_eq!(
        vault_file(dir.path()),
        json!({ "automation:p1:HOOK": "h-1" })
    );
    assert_eq!(
        secrets
            .resolve("p1", &["API_KEY".to_string()])
            .unwrap_err()
            .to_string(),
        "secret_missing:API_KEY"
    );
}

#[test]
fn a_host_that_already_keeps_a_secrets_file_stays_on_it() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join(FILE_VAULT_NAME),
        r#"{"automation:p1:API_KEY":"kept"}"#,
    )
    .unwrap();

    let vault = choose_vault(dir.path(), || panic!("the keychain is not probed"));

    assert_eq!(
        vault.get("automation:p1:API_KEY").unwrap().as_deref(),
        Some("kept")
    );
}

#[test]
fn a_host_with_a_keychain_writes_no_secrets_file() {
    let _ = logged_lines();
    let dir = tempfile::tempdir().unwrap();

    let _vault = choose_vault(dir.path(), || true);

    assert!(!dir.path().join(FILE_VAULT_NAME).exists());
    assert!(logged_lines()
        .iter()
        .any(|line| line.contains("secrets are kept in the OS keychain")));
}

#[test]
fn a_file_vault_value_never_reaches_the_logs_or_the_service_views() {
    let _ = logged_lines();
    let dir = tempfile::tempdir().unwrap();
    let engine = test_engine(
        dir.path().to_path_buf(),
        choose_vault(dir.path(), || false),
        HttpConfig::default(),
    )
    .engine;
    let service = AutomationService::new(engine);
    service.set_secret("p1", "API_KEY", FILE_VALUE).unwrap();
    let created = service.create("p1", "Digest").unwrap();
    let applied = service
        .apply_ops(
            &created.id,
            1,
            &serde_json::from_value::<Vec<Op>>(json!([
                { "op": "add_node", "node": { "id": "post", "label": "Post", "spec": {
                    "kind": "http", "method": "POST", "url": "https://hooks.example.com/in",
                    "headers": [{ "name": "Authorization", "value": "Bearer {{secrets.API_KEY}}" }],
                    "allowed_hosts": ["hooks.example.com"] } } },
                { "op": "connect", "edge": { "from": "trigger", "port": "out", "to": "post" } }
            ]))
            .unwrap(),
        )
        .unwrap();

    let views = json!({
        "applied": applied,
        "detail": service.get(&created.id).unwrap(),
        "list": service.list("p1").unwrap(),
        "names": service.list_secret_names("p1").unwrap(),
    })
    .to_string();
    assert!(views.contains("API_KEY"), "{views}");
    assert!(!views.contains(FILE_VALUE), "{views}");
    let logs = logged_lines().join("\n");
    assert!(logs.contains("secret API_KEY set for project p1"), "{logs}");
    assert!(!logs.contains(FILE_VALUE), "{logs}");
}
