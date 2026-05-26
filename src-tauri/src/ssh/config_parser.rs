//! Parser for ~/.ssh/config files
//!
//! Reads OpenSSH config format and converts entries into SSHProfile structs.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedSSHProfile {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    pub private_key_path: Option<String>,
    pub imported_from: Option<String>,
}

/// Get the path to ~/.ssh/config
fn get_ssh_config_path() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        env::var("USERPROFILE")
            .or_else(|_| env::var("HOME"))
            .ok()
            .map(|home| PathBuf::from(home).join(".ssh").join("config"))
    }

    #[cfg(not(target_os = "windows"))]
    {
        env::var("HOME")
            .ok()
            .map(|home| PathBuf::from(home).join(".ssh").join("config"))
    }
}

/// Expand ~ in paths to the user's home directory
fn expand_tilde(path: &str) -> String {
    if path.starts_with("~/") || path.starts_with("~\\") {
        let home = {
            #[cfg(target_os = "windows")]
            {
                env::var("USERPROFILE")
                    .or_else(|_| env::var("HOME"))
                    .unwrap_or_default()
            }
            #[cfg(not(target_os = "windows"))]
            {
                env::var("HOME").unwrap_or_default()
            }
        };
        format!("{}{}", home, &path[1..])
    } else {
        path.to_string()
    }
}

/// Parse a single SSH config host block into a profile
fn parse_host_block(
    host_pattern: &str,
    options: &HashMap<String, String>,
) -> Option<ParsedSSHProfile> {
    // Skip wildcard patterns (e.g., Host *)
    if host_pattern.contains('*') || host_pattern.contains('?') {
        return None;
    }

    let hostname = options
        .get("hostname")
        .cloned()
        .unwrap_or_else(|| host_pattern.to_string());

    let port = options
        .get("port")
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(22);

    let username = options
        .get("user")
        .cloned()
        .unwrap_or_else(|| whoami().unwrap_or_else(|| "root".to_string()));

    let identity_file = options.get("identityfile").map(|p| expand_tilde(p));

    let auth_method = if identity_file.is_some() {
        "key".to_string()
    } else {
        "password".to_string()
    };

    Some(ParsedSSHProfile {
        name: host_pattern.to_string(),
        host: hostname,
        port,
        username,
        auth_method,
        private_key_path: identity_file,
        imported_from: Some("~/.ssh/config".to_string()),
    })
}

/// Get the current username
fn whoami() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        env::var("USERNAME").ok()
    }
    #[cfg(not(target_os = "windows"))]
    {
        env::var("USER").ok()
    }
}

/// Parse the SSH config file and return a list of profiles
///
/// Returns an empty Vec if the file doesn't exist or can't be read.
/// Skips entries that can't be parsed (logs warnings).
pub fn parse_ssh_config() -> Vec<ParsedSSHProfile> {
    let config_path = match get_ssh_config_path() {
        Some(path) => path,
        None => {
            log::debug!("[SSH] Could not determine SSH config path");
            return Vec::new();
        }
    };

    if !config_path.exists() {
        log::debug!("[SSH] SSH config not found at {:?}", config_path);
        return Vec::new();
    }

    let content = match fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(e) => {
            log::warn!("[SSH] Failed to read SSH config: {}", e);
            return Vec::new();
        }
    };

    parse_ssh_config_content(&content)
}

/// Parse SSH config content string (testable without filesystem)
pub fn parse_ssh_config_content(content: &str) -> Vec<ParsedSSHProfile> {
    let mut profiles = Vec::new();
    let mut current_host: Option<String> = None;
    let mut current_options: HashMap<String, String> = HashMap::new();

    for line in content.lines() {
        let line = line.trim();

        // Skip empty lines and comments
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        // Split on first whitespace or '='
        let (key, value) = if let Some(eq_pos) = line.find('=') {
            let k = line[..eq_pos].trim().to_lowercase();
            let v = line[eq_pos + 1..].trim().to_string();
            (k, v)
        } else if let Some(space_pos) = line.find(|c: char| c.is_whitespace()) {
            let k = line[..space_pos].trim().to_lowercase();
            let v = line[space_pos..].trim().to_string();
            (k, v)
        } else {
            continue;
        };

        if key == "host" {
            // Save previous host block
            if let Some(host) = current_host.take() {
                if let Some(profile) = parse_host_block(&host, &current_options) {
                    profiles.push(profile);
                }
            }
            
            // Split multi-host lines: "Host a b c" should create 3 profiles
            let hosts: Vec<&str> = value.split_whitespace()
                .filter(|h| !h.contains('*') && !h.contains('?')) // Skip wildcards
                .collect();
            
            if hosts.is_empty() {
                current_host = None;
                current_options.clear();
            } else if hosts.len() == 1 {
                current_host = Some(hosts[0].to_string());
                current_options.clear();
            } else {
                // Multiple hosts: create a profile for each with the same options
                for host in hosts {
                    if let Some(profile) = parse_host_block(host, &current_options) {
                        profiles.push(profile);
                    }
                }
                current_host = None;
                current_options.clear();
            }
        } else {
            // Store option for current host
            current_options.insert(key, value);
        }
    }

    // Don't forget the last host block
    if let Some(host) = current_host {
        if let Some(profile) = parse_host_block(&host, &current_options) {
            profiles.push(profile);
        }
    }

    profiles
}

#[cfg(test)]
mod tests {
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
}
