use super::*;

/// A profile written by the previous release: no `group`/`favorite`.
const LEGACY: &str = r#"[{
    "id": "1717000000000",
    "name": "prod",
    "host": "prod.example",
    "port": 22,
    "username": "deploy",
    "authMethod": "key",
    "privateKeyPath": "~/.ssh/id_ed25519",
    "jumpHostId": null,
    "portForwards": [],
    "tags": ["web"],
    "lastConnected": null,
    "importedFrom": "~/.ssh/config",
    "hasStoredPassphrase": true
}]"#;

#[test]
fn legacy_profiles_load_with_defaults() {
    let stored: Vec<StoredSSHProfile> = serde_json::from_str(LEGACY).expect("legacy file parses");
    let profile = SSHProfile::from(stored.into_iter().next().unwrap());
    assert_eq!(profile.group, None);
    assert!(!profile.favorite);
    assert!(profile.has_stored_passphrase);
    assert!(!profile.has_stored_password);
    assert_eq!(profile.tags.as_deref(), Some(&["web".to_string()][..]));
    assert_eq!(profile.password, None);
}

#[test]
fn stored_form_never_contains_secrets() {
    let stored: Vec<StoredSSHProfile> = serde_json::from_str(LEGACY).unwrap();
    let mut profile = SSHProfile::from(stored.into_iter().next().unwrap());
    profile.password = Some("hunter2".into());
    profile.passphrase = Some("open sesame".into());
    profile.group = Some("Production".into());
    let json = serde_json::to_string(&StoredSSHProfile::from(&profile)).unwrap();
    assert!(!json.contains("hunter2") && !json.contains("open sesame"));
    assert!(json.contains("\"group\":\"Production\""));
}

#[test]
fn debug_output_redacts_secrets() {
    let stored: Vec<StoredSSHProfile> = serde_json::from_str(LEGACY).unwrap();
    let mut profile = SSHProfile::from(stored.into_iter().next().unwrap());
    profile.password = Some("hunter2".into());
    let debug = format!("{:?}", profile);
    assert!(!debug.contains("hunter2"));
    assert!(debug.contains("<redacted>"));
}

fn agent_profile(id: &str) -> SSHProfile {
    let stored: Vec<StoredSSHProfile> = serde_json::from_str(LEGACY).unwrap();
    let mut profile = SSHProfile::from(stored.into_iter().next().unwrap());
    profile.id = id.to_string();
    profile.auth_method = "agent".into();
    profile.has_stored_passphrase = false;
    profile
}

#[test]
fn two_hosts_on_one_data_dir_see_and_keep_each_others_writes() {
    let dir = tempfile::tempdir().unwrap();
    let desktop = ProfileManager::new(dir.path());
    let server = ProfileManager::new(dir.path());
    desktop.save(agent_profile("a")).unwrap();
    assert_eq!(server.list().unwrap().len(), 1, "a list reads the file, not a stale copy");
    server.save(agent_profile("b")).unwrap();
    desktop.update_last_connected("a").unwrap();
    let ids: Vec<String> = server.list().unwrap().into_iter().map(|p| p.id).collect();
    assert_eq!(ids, ["a", "b"], "the timestamp write kept the other host's profile");
    let leftovers = std::fs::read_dir(dir.path()).unwrap().count();
    assert_eq!(leftovers, 1, "no temp file stays behind");
}
