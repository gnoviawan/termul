use super::*;

#[test]
fn test_parse_basic_config() {
    let content = r#"
Host myserver
    HostName 192.168.1.100
    User admin
    Port 2222
    IdentityFile ~/.ssh/id_rsa

Host production
    HostName prod.example.com
    User deploy
"#;

    let profiles = parse_ssh_config_content(content);
    assert_eq!(profiles.len(), 2);

    assert_eq!(profiles[0].name, "myserver");
    assert_eq!(profiles[0].host, "192.168.1.100");
    assert_eq!(profiles[0].port, 2222);
    assert_eq!(profiles[0].username, "admin");
    assert_eq!(profiles[0].auth_method, "key");
    assert!(profiles[0].private_key_path.is_some());

    assert_eq!(profiles[1].name, "production");
    assert_eq!(profiles[1].host, "prod.example.com");
    assert_eq!(profiles[1].port, 22);
    assert_eq!(profiles[1].username, "deploy");
    assert_eq!(profiles[1].auth_method, "password");
}

#[test]
fn test_skip_wildcard_hosts() {
    let content = r#"
Host *
    ServerAliveInterval 60

Host myserver
    HostName 10.0.0.1
    User root
"#;

    let profiles = parse_ssh_config_content(content);
    assert_eq!(profiles.len(), 1);
    assert_eq!(profiles[0].name, "myserver");
}

#[test]
fn test_empty_config() {
    let profiles = parse_ssh_config_content("");
    assert!(profiles.is_empty());
}

#[test]
fn test_comments_only() {
    let content = "# This is a comment\n# Another comment\n";
    let profiles = parse_ssh_config_content(content);
    assert!(profiles.is_empty());
}

#[test]
fn test_equals_separator() {
    let content = r#"
Host equaltest
    HostName=example.com
    User=testuser
    Port=3022
"#;

    let profiles = parse_ssh_config_content(content);
    assert_eq!(profiles.len(), 1);
    assert_eq!(profiles[0].host, "example.com");
    assert_eq!(profiles[0].username, "testuser");
    assert_eq!(profiles[0].port, 3022);
}
