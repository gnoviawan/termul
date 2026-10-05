use super::*;
use std::collections::HashMap;

#[test]
fn legacy_factory_format_is_upgraded_without_touching_custom_agents() {
    let mut config = AgentConfig {
        config_id: Some("acp-registry:factory-droid".to_string()),
        name: "Factory Droid".to_string(),
        command: "npx".to_string(),
        args: vec![
            "-y".into(),
            "droid@0.218.1".into(),
            "exec".into(),
            "--output-format".into(),
            "acp-daemon".into(),
        ],
        env: HashMap::new(),
        allow_terminal: false,
    };
    normalize_launch_args(&mut config);
    assert_eq!(config.args.last().map(String::as_str), Some("acp"));
    config.config_id = Some("custom-droid".to_string());
    *config.args.last_mut().unwrap() = "acp-daemon".to_string();
    normalize_launch_args(&mut config);
    assert_eq!(config.args.last().map(String::as_str), Some("acp-daemon"));
}

#[test]
fn injection_is_limited_to_exact_factory_identity() {
    let mut config = AgentConfig {
        config_id: Some("custom-droid".to_string()),
        name: "Factory Droid".to_string(),
        command: "droid".to_string(),
        args: vec![],
        env: HashMap::new(),
        allow_terminal: false,
    };
    assert!(!is_factory_droid(&config));
    inject(&mut config).unwrap();
    assert!(!config.env.contains_key(ENV));
    config.config_id = Some("acp-registry:factory-droid".to_string());
    assert!(is_factory_droid(&config));
}

#[tokio::test]
async fn invalid_candidate_never_reaches_keychain_or_agent() {
    let manager = AcpManager::new(vec![]);
    let config = AgentConfig {
        config_id: Some("acp-registry:factory-droid".to_string()),
        name: "Factory Droid".to_string(),
        command: "not-a-real-agent".to_string(),
        args: vec![],
        env: HashMap::new(),
        allow_terminal: false,
    };
    assert!(validate_and_save(&manager, config.clone(), "  ".into())
        .await
        .is_err());
    let mut other = config;
    other.config_id = Some("custom-droid".to_string());
    assert!(validate_and_save(&manager, other, "candidate".into())
        .await
        .is_err());
    assert!(manager.list_agents().is_empty());
}
