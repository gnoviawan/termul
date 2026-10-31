use std::sync::Arc;

use super::secrets::{SecretError, Secrets};
use super::store::AutomationStore;
use super::test_support::MemoryVault;

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
