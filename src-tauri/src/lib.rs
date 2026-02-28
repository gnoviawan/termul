use serde::Serialize;
use std::env;
use std::path::Path;

#[derive(Debug, Serialize, Clone)]
pub struct ShellInfo {
    pub name: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
pub struct DetectedShells {
    pub shells: Vec<ShellInfo>,
    #[serde(rename = "defaultShell")]
    pub default_shell: ShellInfo,
}

#[tauri::command]
fn detect_shells() -> Result<DetectedShells, String> {
    let shells = get_available_shells();
    let default = get_default_shell_info()
        .unwrap_or_else(|| fallback_shell());

    Ok(DetectedShells {
        shells,
        default_shell: default,
    })
}

#[tauri::command]
fn get_default_shell() -> Result<ShellInfo, String> {
    get_default_shell_info()
        .ok_or_else(|| "No default shell found".to_string())
}

#[tauri::command]
fn get_home_directory() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        Ok(env::var("USERPROFILE")
            .or_else(|_| env::var("HOME"))
            .unwrap_or_else(|_| "C:\\".to_string()))
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(env::var("HOME").unwrap_or_else(|_| "/tmp".to_string()))
    }
}

fn fallback_shell() -> ShellInfo {
    #[cfg(target_os = "windows")]
    {
        ShellInfo {
            name: "cmd".to_string(),
            path: "cmd.exe".to_string(),
            args: None,
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        ShellInfo {
            name: "sh".to_string(),
            path: "/bin/sh".to_string(),
            args: None,
        }
    }
}

fn get_default_shell_info() -> Option<ShellInfo> {
    #[cfg(target_os = "windows")]
    {
        let comspec = env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
        let name = if comspec.to_lowercase().contains("powershell") {
            "powershell"
        } else {
            "cmd"
        };
        Some(ShellInfo {
            name: name.to_string(),
            path: comspec,
            args: None,
        })
    }
    #[cfg(not(target_os = "windows"))]
    {
        let shell = env::var("SHELL").ok()?;
        let name = shell.split('/').last().unwrap_or("sh").to_string();
        Some(ShellInfo {
            name,
            path: shell,
            args: None,
        })
    }
}

fn get_available_shells() -> Vec<ShellInfo> {
    let mut shells: Vec<ShellInfo> = Vec::new();

    #[cfg(target_os = "windows")]
    {
        let candidates = vec![
            ("powershell", "powershell.exe", None),
            ("pwsh", "pwsh.exe", None),
            ("cmd", "cmd.exe", None),
            ("git-bash", "C:\\Program Files\\Git\\bin\\bash.exe", None),
            ("git-bash", "C:\\Program Files (x86)\\Git\\bin\\bash.exe", None),
            ("wsl", "wsl.exe", None),
        ];

        for (name, path, args) in candidates {
            if is_shell_available(path) {
                // Skip duplicate names
                if !shells.iter().any(|s| s.name == name) {
                    shells.push(ShellInfo {
                        name: name.to_string(),
                        path: path.to_string(),
                        args: args.map(|a: &str| vec![a.to_string()]),
                    });
                }
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let candidates = vec![
            ("bash", "/bin/bash"),
            ("zsh", "/bin/zsh"),
            ("zsh", "/usr/bin/zsh"),
            ("fish", "/bin/fish"),
            ("fish", "/usr/bin/fish"),
            ("sh", "/bin/sh"),
        ];

        for (name, path) in candidates {
            if is_shell_available(path) && !shells.iter().any(|s| s.name == name) {
                shells.push(ShellInfo {
                    name: name.to_string(),
                    path: path.to_string(),
                    args: None,
                });
            }
        }
    }

    shells
}

fn is_shell_available(shell_path: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        if !shell_path.contains('\\') && !shell_path.contains('/') {
            // Verify PATH-based shells actually exist using `where`
            return std::process::Command::new("where")
                .arg(shell_path)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
        }
        Path::new(shell_path).exists()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Path::new(shell_path).exists()
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_pty::init())
        .plugin(tauri_plugin_os::init())
        .invoke_handler(tauri::generate_handler![
            detect_shells,
            get_default_shell,
            get_home_directory
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fallback_shell() {
        let shell = fallback_shell();
        #[cfg(target_os = "windows")]
        assert_eq!(shell.name, "cmd");
        #[cfg(not(target_os = "windows"))]
        assert_eq!(shell.name, "sh");
    }

    #[test]
    fn test_get_default_shell_returns_some() {
        let shell = get_default_shell_info();
        assert!(shell.is_some());
    }

    #[test]
    fn test_get_available_shells_not_empty() {
        let shells = get_available_shells();
        assert!(!shells.is_empty());
    }

    #[test]
    fn test_get_home_directory_command() {
        let result = get_home_directory();
        assert!(result.is_ok());
        assert!(!result.unwrap().is_empty());
    }
}
