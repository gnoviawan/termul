// Module declarations
mod commands;
mod migrations;
mod pty;
mod shell_paths;
mod trackers;

#[cfg(target_os = "windows")]
use crate::shell_paths::git_bash_paths;
use migrations::MigrationManager;
use serde::Serialize;
use std::env;
use std::path::Path;
use std::process::Command;
use std::sync::OnceLock;
use std::sync::{Arc, Mutex};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    Emitter, Manager, RunEvent,
};

const MENU_ID_CHECK_FOR_UPDATES: &str = "check-for-updates";
const MENU_ID_RELOAD: &str = "view-reload";
const MENU_ID_TOGGLE_DEVTOOLS: &str = "view-toggle-devtools";
const MENU_ID_ZOOM_RESET: &str = "view-zoom-reset";
const MENU_ID_ZOOM_IN: &str = "view-zoom-in";
const MENU_ID_ZOOM_OUT: &str = "view-zoom-out";
const MENU_ID_TOGGLE_FULLSCREEN: &str = "view-toggle-fullscreen";
const MENU_ID_LEARN_MORE: &str = "help-learn-more";
const MENU_EVENT_CHECK_FOR_UPDATES_TRIGGERED: &str = "updater:check-for-updates-triggered";
const LEARN_MORE_URL: &str = "https://github.com/gnoviawan/termul";
const DEFAULT_ZOOM_FACTOR: f64 = 1.0;
const MIN_ZOOM_FACTOR: f64 = 0.5;
const MAX_ZOOM_FACTOR: f64 = 3.0;
const ZOOM_STEP: f64 = 0.1;

struct ViewMenuState {
    zoom_factor: Mutex<f64>,
}

impl Default for ViewMenuState {
    fn default() -> Self {
        Self {
            zoom_factor: Mutex::new(DEFAULT_ZOOM_FACTOR),
        }
    }
}

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
        let name = shell.split('/').next_back().unwrap_or("sh").to_string();
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
        // CRITICAL: Check explicit paths FIRST, then PATH entries
        // This ensures the correct shell is found when multiple versions exist
        let mut candidates = vec![
            // PowerShell 7 explicit paths (checked first)
            ("pwsh", r"C:\Program Files\PowerShell\7\pwsh.exe", None),
            ("pwsh", r"C:\Program Files\PowerShell\6\pwsh.exe", None),
            // Windows PowerShell 5 (explicit path)
            ("powershell", r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe", None),
            // PATH-based fallbacks (checked last)
            ("pwsh", "pwsh.exe", None),
            ("powershell", "powershell.exe", None),
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
    // NOTE: pwsh is NOT a built-in - it must be resolved from PATH
    matches!(
        normalized.as_str(),
        "cmd"
            | "cmd.exe"
            | "powershell"
            | "powershell.exe"
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
fn register_default_migrations(_manager: &MigrationManager) {
    // Intentionally left empty until real migrations are implemented.
}

fn get_main_webview_window<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<tauri::WebviewWindow<R>, String> {
    app.get_webview_window("main")
        .ok_or_else(|| "Main webview window not found".to_string())
}

fn set_zoom_factor<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    zoom_factor: f64,
) -> Result<(), String> {
    let state = app
        .try_state::<ViewMenuState>()
        .ok_or_else(|| "View menu state is not initialized".to_string())?;
    let mut current_zoom = state
        .zoom_factor
        .lock()
        .map_err(|_| "View menu zoom state is unavailable".to_string())?;

    let clamped_zoom = zoom_factor.clamp(MIN_ZOOM_FACTOR, MAX_ZOOM_FACTOR);
    get_main_webview_window(app)?
        .set_zoom(clamped_zoom)
        .map_err(|error| error.to_string())?;
    *current_zoom = clamped_zoom;
    Ok(())
}

fn adjust_zoom_factor<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    delta: f64,
) -> Result<(), String> {
    let state = app
        .try_state::<ViewMenuState>()
        .ok_or_else(|| "View menu state is not initialized".to_string())?;
    let current_zoom = state
        .zoom_factor
        .lock()
        .map_err(|_| "View menu zoom state is unavailable".to_string())?;
    let next_zoom = (*current_zoom + delta).clamp(MIN_ZOOM_FACTOR, MAX_ZOOM_FACTOR);
    drop(current_zoom);

    set_zoom_factor(app, next_zoom)
}

fn toggle_fullscreen<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    let webview_window = get_main_webview_window(app)?;
    let is_fullscreen = webview_window
        .is_fullscreen()
        .map_err(|error| error.to_string())?;
    webview_window
        .set_fullscreen(!is_fullscreen)
        .map_err(|error| error.to_string())
}

fn reload_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    get_main_webview_window(app)?
        .reload()
        .map_err(|error| error.to_string())
}

#[cfg(debug_assertions)]
fn toggle_devtools<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    let webview_window = get_main_webview_window(app)?;

    if webview_window.is_devtools_open() {
        webview_window.close_devtools();
    } else {
        webview_window.open_devtools();
    }

    Ok(())
}

#[cfg(not(debug_assertions))]
fn toggle_devtools<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) -> Result<(), String> {
    Err("DevTools are not available in this build".to_string())
}

#[cfg(target_os = "windows")]
fn open_external_url(url: &str) -> Result<(), String> {
    Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn open_external_url(url: &str) -> Result<(), String> {
    Command::new("open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn open_external_url(url: &str) -> Result<(), String> {
    Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn build_app_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<tauri::menu::Menu<R>> {
    let file_menu = {
        #[cfg(target_os = "macos")]
        let builder = SubmenuBuilder::new(app, "File").close_window();

        #[cfg(not(target_os = "macos"))]
        let builder = SubmenuBuilder::new(app, "File").quit();

        builder.build()?
    };

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let reload = MenuItemBuilder::with_id(MENU_ID_RELOAD, "Reload")
        .accelerator("CmdOrCtrl+R")
        .build(app)?;
    let zoom_reset = MenuItemBuilder::with_id(MENU_ID_ZOOM_RESET, "Actual Size")
        .accelerator("CmdOrCtrl+0")
        .build(app)?;
    let zoom_in = MenuItemBuilder::with_id(MENU_ID_ZOOM_IN, "Zoom In")
        .accelerator("CmdOrCtrl+=")
        .build(app)?;
    let zoom_out = MenuItemBuilder::with_id(MENU_ID_ZOOM_OUT, "Zoom Out")
        .accelerator("CmdOrCtrl+-")
        .build(app)?;
    let toggle_fullscreen =
        MenuItemBuilder::with_id(MENU_ID_TOGGLE_FULLSCREEN, "Toggle Full Screen").build(app)?;

    let view_menu = {
        let builder = SubmenuBuilder::new(app, "View").item(&reload);

        #[cfg(debug_assertions)]
        let builder = {
            let toggle_devtools =
                MenuItemBuilder::with_id(MENU_ID_TOGGLE_DEVTOOLS, "Toggle DevTools")
                    .accelerator("CmdOrCtrl+Shift+I")
                    .build(app)?;
            builder.item(&toggle_devtools)
        };

        builder
            .separator()
            .item(&zoom_reset)
            .item(&zoom_in)
            .item(&zoom_out)
            .separator()
            .item(&toggle_fullscreen)
            .build()?
    };

    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;

    let check_for_updates =
        MenuItemBuilder::with_id(MENU_ID_CHECK_FOR_UPDATES, "Check for Updates...")
            .accelerator("CmdOrCtrl+Shift+U")
            .build(app)?;
    let learn_more = MenuItemBuilder::with_id(MENU_ID_LEARN_MORE, "Learn More").build(app)?;

    let help_menu = SubmenuBuilder::new(app, "Help")
        .item(&check_for_updates)
        .separator()
        .item(&learn_more)
        .build()?;

    #[cfg(target_os = "macos")]
    let menu = {
        let app_menu = SubmenuBuilder::new(app, app.package_info().name.clone())
            .about(None)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;

        MenuBuilder::new(app).item(&app_menu)
    };

    #[cfg(not(target_os = "macos"))]
    let menu = MenuBuilder::new(app);

    menu.item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&window_menu)
        .item(&help_menu)
        .build()
}

fn handle_menu_event<R: tauri::Runtime>(app: &tauri::AppHandle<R>, event: tauri::menu::MenuEvent) {
    if event.id() == MENU_ID_CHECK_FOR_UPDATES {
        if let Err(error) = app.emit(MENU_EVENT_CHECK_FOR_UPDATES_TRIGGERED, ()) {
            log::error!("Failed to emit updater menu event: {}", error);
        }
    } else if event.id() == MENU_ID_RELOAD {
        if let Err(error) = reload_main_window(app) {
            log::error!("Failed to reload main window from menu: {}", error);
        }
    } else if event.id() == MENU_ID_TOGGLE_DEVTOOLS {
        if let Err(error) = toggle_devtools(app) {
            log::error!("Failed to toggle devtools from menu: {}", error);
        }
    } else if event.id() == MENU_ID_ZOOM_RESET {
        if let Err(error) = set_zoom_factor(app, DEFAULT_ZOOM_FACTOR) {
            log::error!("Failed to reset zoom from menu: {}", error);
        }
    } else if event.id() == MENU_ID_ZOOM_IN {
        if let Err(error) = adjust_zoom_factor(app, ZOOM_STEP) {
            log::error!("Failed to zoom in from menu: {}", error);
        }
    } else if event.id() == MENU_ID_ZOOM_OUT {
        if let Err(error) = adjust_zoom_factor(app, -ZOOM_STEP) {
            log::error!("Failed to zoom out from menu: {}", error);
        }
    } else if event.id() == MENU_ID_TOGGLE_FULLSCREEN {
        if let Err(error) = toggle_fullscreen(app) {
            log::error!("Failed to toggle fullscreen from menu: {}", error);
        }
    } else if event.id() == MENU_ID_LEARN_MORE {
        if let Err(error) = open_external_url(LEARN_MORE_URL) {
            log::error!("Failed to open Learn More link from menu: {}", error);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .menu(build_app_menu)
        .on_menu_event(handle_menu_event)
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    // MCP Bridge in all builds
    builder = builder.plugin(tauri_plugin_mcp_bridge::init());

    let app = builder
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(ViewMenuState::default());

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
            app.manage(pty_manager.clone());

            // Create Migration Manager
            let migration_manager = Arc::new(MigrationManager::new(handle.clone()));
            app.manage(migration_manager.clone());

            // Register default migrations
            register_default_migrations(migration_manager.as_ref());

            let migration_result = migration_manager.run_migrations();
            let mut migration_failures = Vec::new();

            if !migration_result.success {
                migration_failures.push(
                    migration_result
                        .error
                        .clone()
                        .unwrap_or_else(|| "unknown migration error".to_string()),
                );
            }

            if let Some(results) = migration_result.data.as_ref() {
                for result in results.iter().filter(|result| !result.success) {
                    migration_failures.push(format!(
                        "Migration {} failed: {}",
                        result.version,
                        result.error.as_deref().unwrap_or("unknown migration error")
                    ));
                }

                if migration_failures.is_empty() && !results.is_empty() {
                    log::info!(
                        "Completed {} data migration(s) during startup",
                        results.len()
                    );
                }
            }

            if !migration_failures.is_empty() {
                let failure_message = format!(
                    "Data migration startup failed:\n{}",
                    migration_failures.join("\n")
                );

                let _ = app.emit("startup-migration-failed", failure_message.clone());
                log::error!("{}", failure_message);

                return Err(anyhow::anyhow!(failure_message).into());
            }

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
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let RunEvent::ExitRequested { api, .. } = event {
            // Prevent the default exit behavior so we can cleanup first
            api.prevent_exit();

            if let Some(pty_manager) = app_handle.try_state::<Arc<PtyManager>>() {
                let pty_manager_clone = pty_manager.inner().clone();
                let app_handle_clone = app_handle.clone();

                // Spawn async cleanup task
                tokio::spawn(async move {
                    pty_manager_clone.kill_all().await;
                    // After cleanup completes, allow the app to exit with code 0
                    app_handle_clone.exit(0);
                });
            } else {
                // No PTY manager, just exit
                app_handle.exit(0);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "windows")]
    fn with_test_comspec<T>(f: impl FnOnce() -> T) -> T {
        use std::ffi::OsString;

        struct ComspecGuard(Option<OsString>);

        impl Drop for ComspecGuard {
            fn drop(&mut self) {
                if let Some(value) = &self.0 {
                    std::env::set_var("COMSPEC", value);
                } else {
                    std::env::remove_var("COMSPEC");
                }
            }
        }

        let _guard = ComspecGuard(std::env::var_os("COMSPEC"));
        std::env::set_var("COMSPEC", r"C:\Windows\System32\cmd.exe");
        f()
    }

    #[test]
    fn test_fallback_shell() {
        #[cfg(target_os = "windows")]
        let shell = with_test_comspec(|| get_default_shell_info().unwrap());
        #[cfg(not(target_os = "windows"))]
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
