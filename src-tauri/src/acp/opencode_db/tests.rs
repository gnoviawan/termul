use super::*;
use std::collections::HashMap;

fn config(config_id: &str, command: &str) -> AgentConfig {
    AgentConfig {
        config_id: Some(config_id.to_string()),
        name: "agent".to_string(),
        command: command.to_string(),
        args: vec!["acp".to_string()],
        env: HashMap::new(),
        allow_terminal: false,
    }
}

#[test]
fn registry_and_binary_names_are_opencode() {
    assert!(is_opencode(&config("acp-registry:opencode", "node")));
    assert!(is_opencode(&config("custom", "/opt/bin/opencode")));
    assert!(is_opencode(&config("custom", "opencode.exe")));
    assert!(!is_opencode(&config("acp-registry:codex-acp", "codex")));
}

#[test]
fn isolate_sets_a_private_database_and_keeps_an_explicit_one() {
    let dir = std::env::temp_dir().join(format!("termul-opencode-db-{}", uuid::Uuid::new_v4()));
    let mut config = config("acp-registry:opencode", "opencode");
    isolate_at(&mut config, &dir).unwrap();
    let database = config.env.get(DB_ENV).unwrap();
    assert!(database.ends_with("opencode.db"));
    assert!(std::path::Path::new(database).parent().unwrap().is_dir());

    config
        .env
        .insert(DB_ENV.to_string(), "/tmp/keep.db".to_string());
    isolate_at(&mut config, &dir).unwrap();
    assert_eq!(
        config.env.get(DB_ENV).map(String::as_str),
        Some("/tmp/keep.db")
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn isolate_ignores_other_agents() {
    let dir = std::env::temp_dir().join(format!("termul-opencode-skip-{}", uuid::Uuid::new_v4()));
    let mut config = config("acp-registry:codex-acp", "codex");
    isolate_at(&mut config, &dir).unwrap();
    assert!(!config.env.contains_key(DB_ENV));
    assert!(!dir.join("opencode").exists());
}
