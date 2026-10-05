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

fn sqlite_with(path: &std::path::Path, sql: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    let connection = rusqlite::Connection::open(path).unwrap();
    connection.execute_batch(sql).unwrap();
}

#[test]
fn registry_and_binary_names_are_opencode() {
    assert!(is_opencode(&config("acp-registry:opencode", "node")));
    assert!(is_opencode(&config("custom", "/opt/bin/opencode")));
    assert!(is_opencode(&config("custom", "opencode.exe")));
    assert!(is_opencode(&config("custom", "opencode.cmd")));
    assert!(is_opencode(&config("custom", "opencode.bat")));
    assert!(!is_opencode(&config("acp-registry:codex-acp", "codex")));
}

#[test]
fn cli_database_path_uses_xdg_data_home_then_home() {
    let mut config = config("acp-registry:opencode", "opencode");
    config
        .env
        .insert("XDG_DATA_HOME".to_string(), "/data".to_string());
    config
        .env
        .insert("HOME".to_string(), "/should-not-win".to_string());
    assert_eq!(
        cli_database_path(&config),
        Some(std::path::PathBuf::from("/data/opencode/opencode.db"))
    );

    config
        .env
        .insert("XDG_DATA_HOME".to_string(), "relative".to_string());
    assert_eq!(
        cli_database_path(&config),
        Some(std::path::PathBuf::from(
            "/should-not-win/.local/share/opencode/opencode.db"
        ))
    );

    config.env.remove("XDG_DATA_HOME");
    assert_eq!(
        cli_database_path(&config),
        Some(std::path::PathBuf::from(
            "/should-not-win/.local/share/opencode/opencode.db"
        ))
    );
}

#[test]
fn missing_or_healthy_cli_database_is_shared() {
    let private_root = tempfile::tempdir().unwrap();
    let cli_root = tempfile::tempdir().unwrap();
    let cli = cli_root.path().join("opencode.db");

    let mut missing = config("acp-registry:opencode", "opencode");
    isolate_against(&mut missing, private_root.path(), Some(&cli)).unwrap();
    assert!(!missing.env.contains_key(DB_ENV));
    assert!(!private_root.path().join("opencode").exists());

    sqlite_with(&cli, "");
    let mut empty = config("acp-registry:opencode", "opencode");
    isolate_against(&mut empty, private_root.path(), Some(&cli)).unwrap();
    assert!(!empty.env.contains_key(DB_ENV));

    sqlite_with(&cli, "CREATE TABLE session (id TEXT);");
    let mut healthy = config("acp-registry:opencode", "opencode");
    isolate_against(&mut healthy, private_root.path(), Some(&cli)).unwrap();
    assert!(!healthy.env.contains_key(DB_ENV));
}

#[test]
fn unreadable_cli_database_uses_a_private_file() {
    let private_root = tempfile::tempdir().unwrap();
    let cli_root = tempfile::tempdir().unwrap();
    let cli = cli_root.path().join("opencode.db");
    std::fs::write(&cli, "not a sqlite database").unwrap();

    let mut config = config("acp-registry:opencode", "opencode");
    isolate_against(&mut config, private_root.path(), Some(&cli)).unwrap();
    assert_eq!(
        config.env.get(DB_ENV).map(std::path::Path::new),
        Some(
            private_root
                .path()
                .join("opencode")
                .join("opencode.db")
                .as_path()
        )
    );
}

#[test]
fn cli_database_without_session_table_uses_a_private_file() {
    let private_root = tempfile::tempdir().unwrap();
    let cli_root = tempfile::tempdir().unwrap();
    let cli = cli_root.path().join("opencode.db");
    sqlite_with(&cli, "CREATE TABLE auth (id TEXT);");

    let mut config = config("acp-registry:opencode", "opencode");
    isolate_against(&mut config, private_root.path(), Some(&cli)).unwrap();
    let database = config.env.get(DB_ENV).unwrap();
    assert_eq!(
        std::path::Path::new(database),
        private_root.path().join("opencode").join("opencode.db")
    );
    assert!(std::path::Path::new(database).parent().unwrap().is_dir());

    config
        .env
        .insert(DB_ENV.to_string(), "/tmp/keep.db".to_string());
    isolate_against(&mut config, private_root.path(), Some(&cli)).unwrap();
    assert_eq!(
        config.env.get(DB_ENV).map(String::as_str),
        Some("/tmp/keep.db")
    );
}

#[test]
fn isolate_ignores_other_agents() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = config("acp-registry:codex-acp", "codex");
    isolate_against(&mut config, dir.path(), None).unwrap();
    assert!(!config.env.contains_key(DB_ENV));
    assert!(!dir.path().join("opencode").exists());
}
