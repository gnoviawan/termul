// Module declarations
mod commands;
mod migrations;
mod pty;
mod trackers;

/// Git Bash path candidates shared between shell detection and PTY resolver.
/// When updating this list, ensure BOTH lib.rs and pty/manager.rs are updated.
/// Version: v1.0
mod git_bash_paths {

    /// Primary Git Bash installation paths (Program Files)
    pub const PRIMARY_PATHS: &[&str] = &[
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files\Git\usr\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\usr\bin\bash.exe",
    ];

    /// Fallback Git Bash paths for non-standard installations
    pub const FALLBACK_PATHS: &[&str] = &[
        r"C:\tools\msys64\usr\bin\bash.exe",
        r"C:\msys64\usr\bin\bash.exe",
        r"C:\Git\bin\bash.exe",
        r"C:\Git\usr\bin\bash.exe",
    ];
}

use migrations::MigrationManager;
use serde::Serialize;
use std::env;
use std::path::Path;
use std::sync::Arc;
use std::sync::OnceLock;
use tauri::Manager;

#[cfg(target_os = "windows")]
fn resolve_executable_from_path(command: &str) -> Option<String> {
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};

    if command.contains('\\') || command.contains('/') {
        let candidate = Path::new(command);
        return candidate.exists().then(|| command.to_string());
    }

    let path_var = env::var_os("PATH")?;
    let pathext_var =
        env::var_os("PATHEXT").unwrap_or_else(|| OsString::from(".COM;.EXE;.BAT;.CMD"));

    let command_path = Path::new(command);
    let has_extension = command_path.extension().is_some();

    let mut extensions: Vec<OsString> = Vec::new();
    if has_extension {
        extensions.push(OsString::new());
    } else {
        extensions.push(OsString::new());
        for ext in pathext_var
            .to_string_lossy()
            .split(';')
            .filter(|s| !s.trim().is_empty())
        {
            extensions.push(OsString::from(ext.trim()));
        }
    }

    for dir in env::split_paths(&path_var) {
        for ext in &extensions {
            let candidate: PathBuf = if ext.is_empty() {
                dir.join(command)
            } else {
                dir.join(format!("{}{}", command, ext.to_string_lossy()))
            };
            if candidate.exists() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }

    None
}

// Re-exports for commands
pub use pty::PtyManager;
pub use trackers::{CwdTracker, ExitCodeTracker, GitTracker};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    pub name: String,
    pub path: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
pub struct DetectedShells {
    pub available: Vec<ShellInfo>,
    pub default: Option<ShellInfo>,
}

/// Cache for shell detection results to avoid repeated `where` command spawns
static AVAILABLE_SHELLS_CACHE: OnceLock<Vec<ShellInfo>> = OnceLock::new();
static CACHE_CALL_COUNT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[tauri::command]
fn detect_shells() -> Result<DetectedShells, String> {
    let count = CACHE_CALL_COUNT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    log::debug!("[ShellDetect] detect_shells called (call #{})", count);

    let shells = AVAILABLE_SHELLS_CACHE.get_or_init(|| {
        log::debug!("[ShellDetect] Computing available shells (cached)");
        get_available_shells()
    });
    let default = get_default_shell_info();

    Ok(DetectedShells {
        available: shells.clone(),
        default,
    })
}

#[tauri::command]
fn get_default_shell() -> Result<ShellInfo, String> {
    get_default_shell_info().ok_or_else(|| "No default shell found".to_string())
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

fn get_default_shell_info() -> Option<ShellInfo> {
    #[cfg(target_os = "windows")]
    {
        let comspec = env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
        let (name, display_name) = if comspec.to_lowercase().contains("powershell") {
            ("powershell", "PowerShell")
        } else {
            ("cmd", "Command Prompt")
        };
        Some(ShellInfo {
            name: name.to_string(),
            path: comspec,
            display_name: display_name.to_string(),
            args: None,
        })
    }
    #[cfg(not(target_os = "windows"))]
    {
        let shell = env::var("SHELL").ok()?;
        let name = shell.split('/').last().unwrap_or("sh").to_string();
        let display_name = shell_display_name(&name);
        Some(ShellInfo {
            name,
            path: shell,
            display_name,
            args: None,
        })
    }
}

fn shell_display_name(name: &str) -> String {
    match name {
        "powershell" => "PowerShell".to_string(),
        "pwsh" => "PowerShell 7".to_string(),
        "cmd" => "Command Prompt".to_string(),
        "git-bash" => "Git Bash".to_string(),
        "wsl" => "WSL".to_string(),
        "bash" => "Bash".to_string(),
        "zsh" => "Zsh".to_string(),
        "fish" => "Fish".to_string(),
        "sh" => "Shell".to_string(),
        other => other.to_string(),
    }
}

fn get_available_shells() -> Vec<ShellInfo> {
    let mut shells: Vec<ShellInfo> = Vec::new();

    #[cfg(target_os = "windows")]
    {
        let mut candidates = vec![
            ("powershell", "powershell.exe", None),
            ("pwsh", "pwsh.exe", None), // PowerShell 7 via PATH
            ("pwsh", "C:\\Program Files\\PowerShell\\7\\pwsh.exe", None), // PowerShell 7 explicit path
            ("cmd", "cmd.exe", None),
            ("wsl", "wsl.exe", None),
        ];

        // Git Bash via PATH
        candidates.push(("git-bash", "bash.exe", None));

        // Add primary paths from shared constants
        for path in git_bash_paths::PRIMARY_PATHS {
            candidates.push(("git-bash", path, None));
        }

        // Add fallback paths from shared constants
        for path in git_bash_paths::FALLBACK_PATHS {
            candidates.push(("git-bash", path, None));
        }

        for (name, path, args) in candidates {
            if is_shell_available(path) {
                // Skip duplicate names
                if !shells.iter().any(|s| s.name == name) {
                    shells.push(ShellInfo {
                        name: name.to_string(),
                        path: path.to_string(),
                        display_name: shell_display_name(name),
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
                    display_name: shell_display_name(name),
                    args: None,
                });
            }
        }
    }

    shells
}

#[cfg(target_os = "windows")]
fn is_builtin_windows_shell(shell_path: &str) -> bool {
    let normalized = shell_path.to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "cmd"
            | "cmd.exe"
            | "powershell"
            | "powershell.exe"
            | "pwsh"
            | "pwsh.exe"
            | "wsl"
            | "wsl.exe"
    )
}

fn is_shell_available(shell_path: &str) -> bool {
    log::debug!("[ShellDetect] Checking availability: {}", shell_path);
    #[cfg(target_os = "windows")]
    {
        if !shell_path.contains('\\') && !shell_path.contains('/') {
            if is_builtin_windows_shell(shell_path) {
                log::debug!(
                    "[ShellDetect] Built-in Windows shell, skipping PATH resolution: {}",
                    shell_path
                );
                return true;
            }

            let resolved = resolve_executable_from_path(shell_path);
            if resolved.is_some() {
                log::debug!(
                    "[ShellDetect] Resolved from PATH without spawning cmd: {}",
                    shell_path
                );
            }
            return resolved.is_some();
        }

        Path::new(shell_path).exists()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Path::new(shell_path).exists()
    }
}

/// Register default application migrations
///
/// This function is called during app setup to register all known migrations.
/// Add new migrations here as the application schema evolves.
fn register_default_migrations(manager: &MigrationManager) {
    // Example migrations - replace with actual application migrations
    // Migration 1.0.0: Initial schema setup
    let _ = manager.register_migration(
        "1.0.0".to_string(),
        "Initial schema setup".to_string(),
        || {
            // Migration logic here
            // For now, this is a no-op placeholder
            // In production, this would initialize the data store
            Ok(())
        },
        Some(|| {
            // Rollback logic for 1.0.0
            // Typically cannot rollback initial schema
            Err("Cannot rollback initial schema migration".to_string())
        }),
    );

    // Migration 1.0.1: Add terminal history persistence
    let _ = manager.register_migration(
        "1.0.1".to_string(),
        "Add terminal history persistence".to_string(),
        || {
            // Migration logic: migrate old history format to new format
            Ok(())
        },
        Some(|| {
            // Rollback: revert to old history format
            Ok(())
        }),
    );

    // Migration 1.1.0: Add workspace state tracking
    let _ = manager.register_migration(
        "1.1.0".to_string(),
        "Add workspace state tracking".to_string(),
        || {
            // Migration logic: initialize workspace state
            Ok(())
        },
        Some(|| {
            // Rollback: remove workspace state
            Ok(())
        }),
    );

    // Migration 1.2.0: Add orphan detection settings
    let _ = manager.register_migration(
        "1.2.0".to_string(),
        "Add orphan detection settings".to_string(),
        || {
            // Migration logic: migrate orphan detection config
            Ok(())
        },
        Some(|| {
            // Rollback: remove orphan detection config
            Ok(())
        }),
    );

    // Migration 2.0.0: Session persistence redesign
    let _ = manager.register_migration(
        "2.0.0".to_string(),
        "Session persistence redesign".to_string(),
        || {
            // Migration logic: migrate session data to new format
            Ok(())
        },
        Some(|| {
            // Rollback: revert to old session format
            Ok(())
        }),
    );
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    // MCP Bridge in all builds
    builder = builder.plugin(tauri_plugin_mcp_bridge::init());

    builder
        .setup(|app| {
            let handle = app.handle().clone();

            // Create CWD Tracker (takes app_handle directly)
            let cwd_tracker = Arc::new(CwdTracker::new(handle.clone()));
            app.manage(cwd_tracker.clone());

            // Create Git Tracker (takes app_handle directly)
            let git_tracker = Arc::new(GitTracker::new(handle.clone()));
            app.manage(git_tracker.clone());

            // Create Exit Code Tracker (takes app_handle directly)
            let exit_code_tracker = Arc::new(ExitCodeTracker::new(handle.clone()));
            app.manage(exit_code_tracker.clone());

            // Create PTY Manager (depends on trackers)
            let pty_manager = Arc::new(PtyManager::new(
                handle.clone(),
                cwd_tracker,
                git_tracker,
                exit_code_tracker,
            ));
            app.manage(pty_manager);

            // Create Migration Manager
            let migration_manager = Arc::new(MigrationManager::new(handle.clone()));
            app.manage(migration_manager.clone());

            // Register default migrations
            register_default_migrations(migration_manager.as_ref());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Shell detection commands
            detect_shells,
            get_default_shell,
            get_home_directory,
            // Terminal commands
            commands::terminal_spawn,
            commands::terminal_write,
            commands::terminal_resize,
            commands::terminal_kill,
            commands::terminal_get_cwd,
            commands::terminal_get_git_branch,
            commands::terminal_get_git_status,
            commands::terminal_get_exit_code,
            commands::terminal_update_orphan_detection,
            commands::terminal_add_renderer_ref,
            commands::terminal_remove_renderer_ref,
            commands::terminal_set_visibility,
            // Data migration commands
            commands::data_migration_get_version,
            commands::data_migration_get_history,
            commands::data_migration_run_migrations,
            commands::data_migration_get_schema_info,
            commands::data_migration_get_registered,
            commands::data_migration_rollback,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fallback_shell() {
        let shell = get_default_shell_info().unwrap();
        #[cfg(target_os = "windows")]
        assert_eq!(shell.name, "cmd");
        #[cfg(not(target_os = "windows"))]
        assert!(shell.name == "sh" || shell.name == "bash" || shell.name == "zsh");
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

    #[cfg(target_os = "windows")]
    #[test]
    fn test_is_builtin_windows_shell() {
        assert!(is_builtin_windows_shell("cmd"));
        assert!(is_builtin_windows_shell("CMD.EXE"));
        assert!(is_builtin_windows_shell("powershell"));
        assert!(is_builtin_windows_shell("pwsh"));
        assert!(is_builtin_windows_shell("wsl"));
        assert!(!is_builtin_windows_shell("bash.exe"));
        assert!(!is_builtin_windows_shell("git-bash"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_resolve_executable_from_path_nonexistent() {
        let result = resolve_executable_from_path("definitely-not-a-real-shell-xyz");
        assert!(result.is_none());
    }

    // ========== Git Bash candidate sync tests ==========

    #[cfg(target_os = "windows")]
    #[test]
    fn test_git_bash_primary_candidates_defined() {
        // Verify primary Git Bash candidates are defined
        assert!(
            !git_bash_paths::PRIMARY_PATHS.is_empty(),
            "PRIMARY_PATHS should not be empty"
        );

        // Verify specific well-known paths exist
        assert!(git_bash_paths::PRIMARY_PATHS
            .iter()
            .any(|p| p.contains("Program Files") && p.contains("Git\\bin")));
        assert!(git_bash_paths::PRIMARY_PATHS
            .iter()
            .any(|p| p.contains("Git\\usr\\bin")));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_git_bash_fallback_candidates_defined() {
        // Verify fallback Git Bash candidates are defined
        assert!(
            !git_bash_paths::FALLBACK_PATHS.is_empty(),
            "FALLBACK_PATHS should not be empty"
        );

        // All fallback paths should contain bash.exe
        for path in git_bash_paths::FALLBACK_PATHS {
            assert!(
                path.contains("bash.exe"),
                "Fallback path should contain bash.exe: {}",
                path
            );
        }
    }

    #[test]
    fn test_git_bash_shell_display_name() {
        let display_name = shell_display_name("git-bash");
        assert_eq!(display_name, "Git Bash");
    }
}
