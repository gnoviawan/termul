// Module declarations
mod acp;
mod acp_binary_install;
mod acp_registry_snapshot;
mod agent_registry;
mod browser_tab_manager;
mod commands;
mod logging;
mod migrations;
mod path_validation;
mod pty;
mod remote;
mod secure_storage;
mod shell_paths;
mod skills;
mod ssh;
mod trackers;
pub mod web;
mod worktree;

#[cfg(target_os = "windows")]
use crate::shell_paths::git_bash_paths;
use migrations::MigrationManager;
use remote::RemoteServerState;
use serde::{Deserialize, Serialize};
use std::env;
use std::path::Path;
use std::process::Command;
use std::sync::OnceLock;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, RunEvent};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

#[cfg(not(target_os = "linux"))]
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

const MENU_ID_CHECK_FOR_UPDATES: &str = "check-for-updates";
const MENU_ID_RELOAD: &str = "view-reload";
const MENU_ID_TOGGLE_DEVTOOLS: &str = "view-toggle-devtools";
const MENU_ID_ZOOM_RESET: &str = "view-zoom-reset";
const MENU_ID_ZOOM_IN: &str = "view-zoom-in";
const MENU_ID_ZOOM_OUT: &str = "view-zoom-out";
const MENU_ID_TOGGLE_FULLSCREEN: &str = "view-toggle-fullscreen";
const MENU_ID_LEARN_MORE: &str = "help-learn-more";
const MENU_ID_REVEAL_LOGS: &str = "help-reveal-logs";
const MENU_ID_EXPORT_LOG_FILE: &str = "help-export-log-file";
const MENU_ID_COPY_LOG_CONTENTS: &str = "help-copy-log-contents";
const MENU_ID_EXPORT_LOG_DEFAULT: &str = "help-export-log-default";
const MENU_ID_CLOSE_TAB: &str = "window-close-tab";
const MENU_EVENT_CLOSE_TAB: &str = "menu:close-tab";
const MENU_EVENT_CHECK_FOR_UPDATES_TRIGGERED: &str = "updater:check-for-updates-triggered";

// Tray menu IDs
const TRAY_ID: &str = "termul-tray";
const TRAY_MENU_SHOW: &str = "tray-show";
const TRAY_MENU_QUIT: &str = "tray-quit";
const TRAY_QUIT_REQUESTED_EVENT: &str = "tray:quit-requested";
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
pub use acp::{AcpManager, ChatHistoryStore, FileProjectRegistry, SessionPersistence};
pub use pty::PtyManager;
pub use trackers::{CwdTracker, ExitCodeTracker, GitTracker, TerminalEventHub};
// Desktop ACP event sink: wraps the Tauri `AppHandle` so the dispatcher's
// `Vec<Arc<dyn EventSink>>` fan-out reaches the renderer as `acp:*` events
// (byte-for-byte unchanged from before Story 1.1). The headless `termul-server`
// binary (Story 1.2) will instead pass a `WsRelaySink`-backed list with no
// `AppHandle` at all.
use web::{PermissionRendezvous, ProjectRegistry, QuestionRendezvous, TauriEventSink, WsRelaySink};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    pub name: String,
    pub path: String,
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DetectedShells {
    pub available: Vec<ShellInfo>,
    pub default: Option<ShellInfo>,
}

/// Cache for shell detection results to avoid repeated `where` command spawns
static AVAILABLE_SHELLS_CACHE: OnceLock<Vec<ShellInfo>> = OnceLock::new();
static CACHE_CALL_COUNT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[tauri::command]
fn detect_shells() -> Result<DetectedShells, String> {
    detect_shells_inner()
}

/// Reusable shell-detection entry point (same logic as the `detect_shells`
/// Tauri command, without the `#[tauri::command]` macro). The HTTP `/shells`
/// route (`web::fs_api::shells`) calls this directly so the web/remote path
/// can reach shell detection without a Tauri runtime.
pub(crate) fn detect_shells_inner() -> Result<DetectedShells, String> {
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

/// Temporarily remove the native application menu so its keyboard accelerators
/// (e.g. `Cmd+W`, `Cmd+R`, `Cmd+C`) stop intercepting key events before they
/// reach the webview. The renderer's shortcut recorder calls this while it is
/// capturing a keybinding so the user can record any combination, including
/// ones that collide with a menu accelerator. No-op on Linux (no app menu).
#[tauri::command]
fn suspend_app_menu(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(not(target_os = "linux"))]
    {
        app.remove_menu().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    let _ = &app;
    Ok(())
}

/// Restore the native application menu removed by `suspend_app_menu`. Rebuilds
/// the menu from scratch so accelerators resume working once recording ends.
#[tauri::command]
fn restore_app_menu(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(not(target_os = "linux"))]
    {
        let menu = build_app_menu(&app).map_err(|e| e.to_string())?;
        app.set_menu(menu).map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    let _ = &app;
    Ok(())
}

#[tauri::command]
fn reveal_log_dir_command(app: tauri::AppHandle) -> Result<(), String> {
    reveal_log_dir(&app)
}

#[tauri::command]
fn export_log_file_command(app: tauri::AppHandle) -> Result<(), String> {
    export_log_file(&app)
}

#[tauri::command]
fn copy_log_contents_command(app: tauri::AppHandle) -> Result<(), String> {
    copy_log_contents(&app)
}

#[tauri::command]
fn export_log_to_default_command(app: tauri::AppHandle) -> Result<(), String> {
    export_log_to_default(&app)
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
            (
                "powershell",
                r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
                None,
            ),
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

#[cfg(not(target_os = "linux"))]
fn build_app_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<tauri::menu::Menu<R>> {
    #[cfg(not(target_os = "macos"))]
    let file_menu = SubmenuBuilder::new(app, "File").quit().build()?;

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
    let zoom_reset = MenuItemBuilder::with_id(MENU_ID_ZOOM_RESET, "Actual Size").build(app)?;
    let zoom_in = MenuItemBuilder::with_id(MENU_ID_ZOOM_IN, "Zoom In").build(app)?;
    let zoom_out = MenuItemBuilder::with_id(MENU_ID_ZOOM_OUT, "Zoom Out").build(app)?;
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

    #[cfg(target_os = "macos")]
    let window_menu = {
        let close_tab = MenuItemBuilder::with_id(MENU_ID_CLOSE_TAB, "Close Tab")
            .accelerator("Cmd+W")
            .build(app)?;
        SubmenuBuilder::new(app, "Window")
            .minimize()
            .maximize()
            .separator()
            .item(&close_tab)
            .build()?
    };

    #[cfg(not(target_os = "macos"))]
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
    let reveal_logs =
        MenuItemBuilder::with_id(MENU_ID_REVEAL_LOGS, "Reveal Log File").build(app)?;
    let export_log_file =
        MenuItemBuilder::with_id(MENU_ID_EXPORT_LOG_FILE, "Export Log File...").build(app)?;
    let copy_log_contents =
        MenuItemBuilder::with_id(MENU_ID_COPY_LOG_CONTENTS, "Copy Log Contents").build(app)?;
    let export_log_default = MenuItemBuilder::with_id(
        MENU_ID_EXPORT_LOG_DEFAULT,
        "Export Log to Default Directory",
    )
    .build(app)?;

    let help_menu = SubmenuBuilder::new(app, "Help")
        .item(&check_for_updates)
        .separator()
        .item(&reveal_logs)
        .item(&export_log_file)
        .item(&copy_log_contents)
        .item(&export_log_default)
        .item(&learn_more)
        .build()?;

    #[cfg(target_os = "macos")]
    {
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

        return MenuBuilder::new(app)
            .item(&app_menu)
            .item(&edit_menu)
            .item(&view_menu)
            .item(&window_menu)
            .item(&help_menu)
            .build();
    }

    #[cfg(not(target_os = "macos"))]
    MenuBuilder::new(app)
        .item(&file_menu)
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
    } else if event.id() == MENU_ID_REVEAL_LOGS {
        if let Err(error) = reveal_log_dir(app) {
            log::error!("Failed to reveal log directory from menu: {}", error);
        }
    } else if event.id() == MENU_ID_EXPORT_LOG_FILE {
        if let Err(error) = export_log_file(app) {
            log::error!("Failed to export log file from menu: {}", error);
        }
    } else if event.id() == MENU_ID_COPY_LOG_CONTENTS {
        if let Err(error) = copy_log_contents(app) {
            log::error!("Failed to copy log contents from menu: {}", error);
        }
    } else if event.id() == MENU_ID_EXPORT_LOG_DEFAULT {
        if let Err(error) = export_log_to_default(app) {
            log::error!(
                "Failed to export log to default directory from menu: {}",
                error
            );
        }
    } else if event.id() == MENU_ID_CLOSE_TAB {
        if let Err(error) = app.emit(MENU_EVENT_CLOSE_TAB, ()) {
            log::error!("Failed to emit close-tab menu event: {}", error);
        }
    }
}

/// Open the OS log directory (where the rotated log file lives) in the system
/// file manager so users can locate and attach it to bug reports (issue #244).
fn reveal_log_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("could not resolve log directory: {}", e))?;

    // The plugin creates the directory lazily on first write; ensure it exists
    // so revealing it never fails on a fresh install that hasn't logged yet.
    if !log_dir.exists() {
        std::fs::create_dir_all(&log_dir)
            .map_err(|e| format!("could not create log directory: {}", e))?;
    }

    open_external_url(&log_dir.to_string_lossy())
}

fn show_log_action_error<R: tauri::Runtime>(app: &tauri::AppHandle<R>, message: &str) {
    app.dialog()
        .message(message)
        .title("Error")
        .kind(MessageDialogKind::Error)
        .show(|_| {});
}

fn export_log_file<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    let log_path = match logging::log_file_path(app) {
        Some(path) => path,
        None => {
            let msg = "Could not resolve log file path";
            show_log_action_error(app, msg);
            return Err(msg.to_string());
        }
    };

    if !log_path.exists() {
        let msg = "Log file does not exist yet";
        show_log_action_error(app, msg);
        return Err(msg.to_string());
    }

    let app_handle = app.clone();
    app.dialog()
        .file()
        .add_filter("Log Files", &["log"])
        .set_file_name("termul.log")
        .save_file(move |file_path| {
            if let Some(tauri_plugin_dialog::FilePath::Path(dest_path)) = file_path {
                match std::fs::copy(&log_path, &dest_path) {
                    Ok(_) => {
                        app_handle
                            .dialog()
                            .message(format!(
                                "Log file successfully exported to {}",
                                dest_path.display()
                            ))
                            .title("Success")
                            .kind(MessageDialogKind::Info)
                            .show(|_| {});
                    }
                    Err(e) => {
                        app_handle
                            .dialog()
                            .message(format!("Failed to export log file: {}", e))
                            .title("Error")
                            .kind(MessageDialogKind::Error)
                            .show(|_| {});
                    }
                }
            }
        });

    Ok(())
}

fn copy_log_contents<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    let log_path = match logging::log_file_path(app) {
        Some(path) => path,
        None => {
            let msg = "Could not resolve log file path";
            show_log_action_error(app, msg);
            return Err(msg.to_string());
        }
    };

    if !log_path.exists() {
        let msg = "Log file does not exist yet";
        show_log_action_error(app, msg);
        return Err(msg.to_string());
    }

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        match std::fs::read_to_string(&log_path) {
            Ok(contents) => {
                if let Err(e) = app_handle.clipboard().write_text(contents) {
                    app_handle
                        .dialog()
                        .message(format!("Failed to copy to clipboard: {}", e))
                        .title("Error")
                        .kind(MessageDialogKind::Error)
                        .show(|_| {});
                } else {
                    app_handle
                        .dialog()
                        .message("Log contents successfully copied to clipboard.")
                        .title("Copied")
                        .kind(MessageDialogKind::Info)
                        .show(|_| {});
                }
            }
            Err(e) => {
                app_handle
                    .dialog()
                    .message(format!("Failed to read log file: {}", e))
                    .title("Error")
                    .kind(MessageDialogKind::Error)
                    .show(|_| {});
            }
        }
    });

    Ok(())
}

fn export_log_to_default<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    let log_path = match logging::log_file_path(app) {
        Some(path) => path,
        None => {
            let msg = "Could not resolve log file path";
            show_log_action_error(app, msg);
            return Err(msg.to_string());
        }
    };

    if !log_path.exists() {
        let msg = "Log file does not exist yet";
        show_log_action_error(app, msg);
        return Err(msg.to_string());
    }

    let default_dir = match app
        .path()
        .download_dir()
        .or_else(|_| app.path().desktop_dir())
    {
        Ok(dir) => dir,
        Err(e) => {
            let msg = format!(
                "Could not resolve a default directory (Downloads or Desktop): {}",
                e
            );
            show_log_action_error(app, &msg);
            return Err(msg);
        }
    };

    let dest_path = default_dir.join("termul.log");
    let app_handle = app.clone();

    tauri::async_runtime::spawn(async move {
        match std::fs::copy(&log_path, &dest_path) {
            Ok(_) => {
                app_handle
                    .dialog()
                    .message(format!(
                        "Log file successfully exported to {}",
                        dest_path.display()
                    ))
                    .title("Success")
                    .kind(MessageDialogKind::Info)
                    .show(|_| {});
            }
            Err(e) => {
                app_handle
                    .dialog()
                    .message(format!("Failed to export log file: {}", e))
                    .title("Error")
                    .kind(MessageDialogKind::Error)
                    .show(|_| {});
            }
        }
    });

    Ok(())
}

static CLEANUP_DONE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
// Claimed synchronously when we enter the async cleanup path and never reset.
// Prevents a second ExitRequested (e.g. an OS exit signal, or the exit(0) we
// call at the end of cleanup re-entering before the first task finishes) from
// spawning a duplicate cleanup that races kill_all()/destroy_all()/exit(0).
// CLEANUP_DONE still marks final completion so the trailing exit(0) re-entry
// returns immediately via the check above.
static CLEANUP_IN_PROGRESS: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Install the panic hook before anything can panic so Rust panics are
    // captured to the log file with a backtrace (issue #244).
    logging::install_panic_hook();

    let builder = tauri::Builder::default();

    // Native menu bar:
    // - macOS: top OS menu (expected, native UX)
    // - Windows: hidden behind decorations:false (custom title bar handles it)
    // - Linux/GTK: would render as a separate widget bar inside the window,
    //   creating a double bar with the custom title bar. Skip the native menu
    //   on Linux and let the custom title bar / shortcuts cover those actions.
    #[cfg(not(target_os = "linux"))]
    let builder = builder
        .menu(build_app_menu)
        .on_menu_event(handle_menu_event);

    #[cfg(target_os = "linux")]
    let builder = builder.on_menu_event(handle_menu_event);

    // Single-instance must be the first plugin: Tauri initializes plugins in
    // registration order, so duplicate launches must be rejected before any
    // other plugin performs setup or side effects. The plugin is desktop-only.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            // Unminimize before focus so the restored window is reliably
            // foregrounded on every platform.
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }));

    let mut builder = builder
        // Logging is first among the remaining plugins so the global logger is
        // installed before their setup code emits log lines.
        .plugin(logging::build_log_plugin())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init());

    // MCP Bridge in all builds
    builder = builder.plugin(tauri_plugin_mcp_bridge::init());

    let app = builder
        .setup(|app| {
            let handle = app.handle().clone();

            // Startup diagnostic banner (issue #244): version, OS/arch, build
            // channel, session id, and resolved log path on a single line.
            logging::log_startup_banner(&handle);

            // Window chrome is configured before show(). macOS overlay settings
            // live in tauri.conf.json — avoid set_decorations(true) there because
            // it resets hiddenTitle/full-size content view. Win/Linux drop native
            // frame so the HTML titlebar owns window controls.
            #[cfg(target_os = "macos")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(e) = window.set_title_bar_style(tauri::TitleBarStyle::Overlay) {
                        log::warn!("[macOS] Failed to set overlay title bar style: {}", e);
                    }
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(e) = window.set_decorations(false) {
                        log::warn!("Failed to disable native window decorations: {}", e);
                    }
                }
            }

            app.manage(ViewMenuState::default());

            // Transport-neutral terminal event fan-out: desktop events remain
            // byte-compatible while the web terminal socket subscribes to the
            // same lifecycle/metadata stream.
            let terminal_events = TerminalEventHub::tauri(handle.clone());

            let cwd_tracker = Arc::new(CwdTracker::new(terminal_events.clone()));
            app.manage(cwd_tracker.clone());

            let git_tracker = Arc::new(GitTracker::new(
                Some(handle.clone()),
                terminal_events.clone(),
            ));
            app.manage(git_tracker.clone());

            let exit_code_tracker = Arc::new(ExitCodeTracker::new(terminal_events.clone()));
            app.manage(exit_code_tracker.clone());

            let pty_manager = Arc::new(PtyManager::new(
                terminal_events,
                cwd_tracker,
                git_tracker,
                exit_code_tracker,
            ));
            app.manage(pty_manager.clone());

            // Create Browser Tab Manager
            let browser_tab_manager =
                Arc::new(browser_tab_manager::BrowserTabManager::new(handle.clone()));
            app.manage(browser_tab_manager);

            // Desktop renderer chat history lives outside tauri-plugin-store so
            // loading unrelated preferences never materializes full transcripts
            // in the WebView. The app-data path is mandatory for safe startup.
            let chat_history_root = handle
                .path()
                .app_data_dir()
                .map_err(|error| format!("failed to resolve app data directory: {error}"))?
                .join("acp-chat-history");
            let chat_history_store = ChatHistoryStore::open(chat_history_root)
                .map_err(|error| format!("failed to open ACP chat history store: {error}"))?;
            log::info!(
                "[acp-history] store ready path={}",
                chat_history_store.root().display()
            );

            // Host-owned durable ACP history (CAP-2). The desktop attaches the
            // same file-backed `SessionPersistence` the standalone server uses,
            // so every non-ephemeral session becomes durable at the host
            // event/session layer regardless of which client created it. The
            // sessions root is desktop-private: NEVER share it with a
            // standalone `termul-server` on the same machine (two processes on
            // one JSONL store would corrupt both). The persistence must exist
            // BEFORE any agent spawn — driver threads clone it at spawn time.
            let sessions_root = handle
                .path()
                .app_data_dir()
                .map_err(|error| format!("failed to resolve app data directory: {error}"))?
                .join("acp-sessions");
            let session_persistence =
                match tauri::async_runtime::block_on(SessionPersistence::open(
                    sessions_root.clone(),
                )) {
                    Ok(persistence) => {
                        log::info!(
                            "[acp-history] host persistence ready path={}",
                            persistence.root().display()
                        );
                        Some(persistence)
                    }
                    Err(error) => {
                        // Degrade, don't crash: history becomes live-only, the
                        // app must still boot (parity with the store-free web
                        // negotiation path).
                        log::error!(
                            "[acp-history] host persistence unavailable path={} error={error}",
                            sessions_root.display()
                        );
                        None
                    }
                };
            // Idempotent incremental import of legacy renderer-authored
            // history so existing desktop sessions survive the ownership
            // transfer. Runs at every startup; per-entry fail-open inside.
            if let Some(persistence) = &session_persistence {
                let imported = tauri::async_runtime::block_on(
                    crate::acp::import_chat_history(persistence, &chat_history_store),
                );
                if imported > 0 {
                    log::info!("[acp-history] legacy store imported sessions={imported}");
                }
            }
            app.manage(chat_history_store);
            app.manage(commands::HostHistoryStore(session_persistence.clone()));

            // Create ACP Manager — spawns/owns ACP agent subprocesses.
            //
            // Desktop mode fans ACP events out to TWO sinks: `TauriEventSink`
            // (the renderer's `acp:*` events, byte-for-byte unchanged) and a
            // `WsRelaySink` (the shared-live web server's per-session event log
            // + subscriber set). `fan_out` serializes once and fans N, so adding
            // the second sink does not change the `TauriEventSink` payloads.
            // With host persistence attached, the relay additionally durables
            // every session-scoped event (the same seam the standalone server
            // uses) — transport-agnostic, so desktop-origin and browser-origin
            // sessions are persisted identically.
            //
            // The shared-live web server (`remote/host.rs`) pulls both
            // `Arc<AcpManager>` and `Arc<WsRelaySink>` as Tauri state and serves
            // the desktop's live sessions to a browser/phone over the LAN.
            let mut sinks: Vec<Arc<dyn crate::web::EventSink>> =
                vec![Arc::new(TauriEventSink::new(handle.clone()))];
            let (ws_relay, acp_manager) = match &session_persistence {
                Some(persistence) => {
                    let relay = Arc::new(WsRelaySink::with_persistence(
                        4096,
                        Arc::clone(persistence),
                    ));
                    sinks.push(relay.clone());
                    let manager = Arc::new(AcpManager::with_persistence(
                        sinks,
                        Arc::clone(persistence),
                    ));
                    (relay, manager)
                }
                None => {
                    let relay = Arc::new(WsRelaySink::new());
                    sinks.push(relay.clone());
                    let manager = Arc::new(AcpManager::new(sinks));
                    (relay, manager)
                }
            };
            // Attach the server-side permission rendezvous so a phone can
            // respond to `acp:permission_request` over WS. The desktop renderer
            // still responds via the `acp_respond_permission` Tauri command
            // (direct `AcpManager::respond_permission`); the rendezvous's
            // at-most-one `take_permission` gate ensures whichever path responds
            // first wins.
            //
            // Capture the runtime handle explicitly (`tauri::async_runtime`)
            // rather than relying on `Handle::try_current()` — `setup` runs on
            // the main thread and is not guaranteed to be inside a tokio runtime
            // context, so capturing the handle here keeps `arm_timeout` reliable
            // when it runs later on the agent driver thread.
            let rendezvous = Arc::new(PermissionRendezvous::with_handle_and_policy(
                Arc::clone(&acp_manager),
                std::time::Duration::from_secs(60),
                std::time::Duration::from_secs(15),
                tauri::async_runtime::handle().inner().clone(),
            ));
            ws_relay.set_rendezvous(rendezvous);
            // Attach the server-side question rendezvous so a phone attached
            // to a desktop host can answer structured questions over WS too
            // (desktop renderer answers via the `acp_answer_question` Tauri
            // command; first-response-wins across both paths).
            let question_rendezvous = Arc::new(QuestionRendezvous::with_handle(
                Arc::clone(&acp_manager),
                std::time::Duration::from_secs(60),
                tauri::async_runtime::handle().inner().clone(),
            ));
            ws_relay.set_question_rendezvous(question_rendezvous);
            app.manage(acp_manager);
            app.manage(ws_relay);

            // In-memory project registry (Epic-4 bridge) — renderer-fed via
            // `remote_sync_projects`; the source for `GET /projects` +
            // `switch_project` cwd resolution on the shared-live web server.
            // Lives only while the server runs; cleared on `remote_server_stop`.
            let project_registry = Arc::new(ProjectRegistry::new());
            app.manage(project_registry);

            // Create SSH Manager
            let ssh_manager = Arc::new(ssh::SSHManager::new(handle.clone()));
            app.manage(ssh_manager);

            // Verify the OS keychain backend actually persists secrets. If this
            // fails, stored SSH passwords/passphrases silently vanish (mock
            // store), so surface it loudly in logs.
            match ssh::credential_store::self_test() {
                Ok(()) => log::info!("[SSH] Credential keychain self-test passed"),
                Err(e) => log::error!(
                    "[SSH] Credential keychain self-test FAILED: {} -- stored SSH credentials will not persist",
                    e
                ),
            }

            // Create Migration Manager
            let migration_manager = Arc::new(MigrationManager::new(handle.clone()));
            app.manage(migration_manager.clone());

            // Create Remote Server State
            let remote_state = Arc::new(RemoteServerState::new());
            app.manage(remote_state);

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

            // ── System Tray Icon ────────────────────────────────────────────
            // Buat tray icon dengan menu klik kanan seperti Telegram.
            // Klik icon → show/focus window.
            // Close button (X) → minimize ke tray, bukan quit.
            #[cfg(desktop)]
            {
                use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem};
                use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

                let show_item = MenuItemBuilder::with_id(TRAY_MENU_SHOW, "Show Termul")
                    .build(app)?;
                let quit_item = MenuItemBuilder::with_id(TRAY_MENU_QUIT, "Quit Termul")
                    .build(app)?;
                let separator = PredefinedMenuItem::separator(app)?;

                let tray_menu = MenuBuilder::new(app)
                    .item(&show_item)
                    .item(&separator)
                    .item(&quit_item)
                    .build()?;

                let _tray = TrayIconBuilder::with_id(TRAY_ID)
                    .tooltip("Termul Manager")
                    .icon(app.default_window_icon().cloned().unwrap())
                    .menu(&tray_menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event({
                        let app_handle = handle.clone();
                        move |_tray, event| match event.id().as_ref() {
                            id if id == TRAY_MENU_SHOW => {
                                if let Some(window) = app_handle.get_webview_window("main") {
                                    let _ = window.show();
                                    let _ = window.unminimize();
                                    let _ = window.set_focus();
                                }
                            }
                            id if id == TRAY_MENU_QUIT => {
                                // Let the renderer run the existing dirty-file
                                // prompt and persistence flush before it destroys
                                // the window. Direct app.exit(0) would bypass it.
                                let _ = app_handle.emit_to(
                                    "main",
                                    TRAY_QUIT_REQUESTED_EVENT,
                                    (),
                                );
                            }
                            _ => {}
                        }
                    })
                    .on_tray_icon_event({
                        let app_handle = handle.clone();
                        move |_tray, event| {
                            if let TrayIconEvent::Click {
                                button: MouseButton::Left,
                                button_state: MouseButtonState::Up,
                                ..
                            } = event
                            {
                                if let Some(window) = app_handle.get_webview_window("main") {
                                    let _ = window.show();
                                    let _ = window.unminimize();
                                    let _ = window.set_focus();
                                }
                            }
                        }
                    })
                    .build(app)?;

            }
            // ── End Tray ────────────────────────────────────────────────────

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Shell detection commands
            detect_shells,
            get_default_shell,
            get_home_directory,
            suspend_app_menu,
            restore_app_menu,
            reveal_log_dir_command,
            export_log_file_command,
            copy_log_contents_command,
            export_log_to_default_command,
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
            commands::terminal_set_protected,
            commands::terminal_set_visibility,
            // Agent registry (ADR-004.6: identity/discovery, opt-in, read-only)
            commands::agent_registry_fetch,
            // Browser tab commands
            commands::browser_tab_create,
            commands::browser_tab_navigate,
            commands::browser_tab_resize,
            commands::browser_tab_show,
            commands::browser_tab_hide,
            commands::browser_tab_destroy,
            commands::browser_tab_go_back,
            commands::browser_tab_go_forward,
            commands::browser_tab_reload,
            commands::browser_tab_open_devtools,
            commands::browser_tab_inject_annotation,
            commands::browser_tab_remove_annotation_overlay,
            commands::browser_tab_inject_annotation_markers,
            commands::browser_tab_update_annotation_marker_selection,
            // Browser tab URL sync commands (called by injected JS)
            commands::browser_tab_report_url,
            commands::browser_tab_report_loaded,
            commands::browser_tab_report_region_captured,
            commands::browser_tab_report_element_captured,
            commands::browser_tab_report_title,
            commands::browser_tab_report_annotation_marker_clicked,
            // Worktree commands
            commands::worktree_list,
            commands::worktree_create,
            commands::worktree_remove,
            commands::worktree_branches,
            commands::worktree_check_dirty,
            commands::worktree_remove_all_managed,
            commands::worktree_parse_gitignore,
            commands::worktree_create_symlinks,
            commands::worktree_ensure_symlinks,
            commands::worktree_archive,
            commands::worktree_restore,
            commands::worktree_merge_preview,
            commands::worktree_merge_execute,
            // Filesystem/search commands
            commands::search_get_rg_info,
            commands::search_content,
            commands::search_content_stream,
            commands::search_content_cancel,
            commands::search_file_names_stream,
            commands::search_file_names_cancel,
            // Attachment binary reads (brokered; fs:allow-read-file is not granted)
            commands::read_attachment_bytes,
            // SSH commands
            commands::ssh_list_profiles,
            commands::ssh_save_profile,
            commands::ssh_delete_profile,
            commands::ssh_import_config,
            commands::ssh_connect,
            commands::ssh_disconnect,
            commands::ssh_get_connections,
            commands::ssh_port_forward_start,
            commands::ssh_port_forward_stop,
            commands::sftp_list_dir,
            commands::sftp_download,
            commands::sftp_upload,
            commands::sftp_delete,
            commands::sftp_mkdir,
            commands::sftp_rename,
            // SSH askpass helper
            commands::ssh_create_askpass,
            // SFTP file operations
            commands::sftp_read_file,
            commands::sftp_write_file,
            commands::sftp_create_file,
            // Data migration commands
            commands::data_migration_get_version,
            commands::data_migration_get_history,
            commands::data_migration_run_migrations,
            commands::data_migration_get_schema_info,
            commands::data_migration_get_registered,
            commands::data_migration_rollback,
            // Git commands
            commands::git_get_status,
            commands::git_get_diff,
            commands::git_stage,
            commands::git_unstage,
            commands::git_discard,
            commands::git_get_log,
            commands::git_commit,
            commands::git_push,
            commands::git_get_commit_context,
            commands::git_init,
            commands::git_checkout_branch,
            commands::git_create_branch,
            commands::git_stash_save,
            commands::git_stash_list,
            commands::git_stash_apply,
            commands::git_stash_pop,
            commands::git_stash_drop,
            commands::git_branch_list,
            commands::git_branch_switch,
            commands::git_branch_create,
            // Secure storage commands
            secure_storage::secure_storage_set,
            secure_storage::secure_storage_get,
            secure_storage::secure_storage_delete,
            // ACP (Agent Client Protocol) commands — ADR-003 P0
            acp::commands::acp_spawn_agent,
            acp::commands::acp_kill_agent,
            acp::commands::acp_list_agents,
            acp::commands::acp_new_session,
            acp::commands::acp_load_session,
            acp::commands::acp_resume_session,
            acp::commands::acp_close_session,
            acp::commands::acp_dispose_ephemeral_session,
            acp::commands::acp_list_sessions,
            acp::commands::acp_send_prompt,
            acp::commands::acp_cancel_prompt,
            acp::commands::acp_set_config_option,
            acp::commands::acp_set_mode,
            acp::commands::acp_set_model,
            acp::commands::acp_respond_permission,
            acp::commands::acp_answer_question,
            acp::commands::acp_authenticate,
            acp::commands::acp_probe_runtime,
            acp::commands::acp_set_turn_timeout,
            acp::commands::acp_set_turn_idle_timeout,
            acp::commands::acp_set_session_new_timeout,
            acp::commands::acp_set_session_reopen_timeout,
            acp::commands::acp_set_first_prompt_warmup_timeout,
            acp::commands::acp_probe_mcp_server,
            acp_registry_snapshot::acp_fetch_registry_snapshot,
            acp_binary_install::acp_install_registry_binary,
            // Agent Skills (Zed-compatible SKILL.md packages)
            skills::commands::list_agent_skills_cmd,
            skills::commands::read_agent_skill_cmd,
            // Remote server commands
            commands::remote_server_start,
            commands::remote_server_stop,
            commands::remote_server_status,
            commands::remote_sync_projects,
            commands::remote_sync_chat_history,
            // Desktop ACP renderer-history storage
            commands::acp_history_list,
            commands::acp_history_get,
            commands::acp_history_save,
            commands::acp_history_delete,
            commands::acp_history_flush,
            commands::acp_history_mark_legacy_import_complete,
            commands::acp_history_list_legacy,
            commands::acp_history_get_legacy,
            // Frontend error forwarding (issue #244)
            commands::log_frontend_error,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let RunEvent::ExitRequested { api, .. } = event {
            // Cleanup already finished — let the app exit immediately.
            if CLEANUP_DONE.load(std::sync::atomic::Ordering::SeqCst) {
                return;
            }
            // Prevent every exit request while the single cleanup task runs.
            // A re-entrant request must not bypass cleanup through Tauri's
            // default exit behavior while CLEANUP_IN_PROGRESS is already true.
            api.prevent_exit();

            // Atomically claim the cleanup path. If a previous ExitRequested
            // already started the async cleanup (not yet done), short-circuit
            // so we don't spawn a second task racing kill_all()/destroy_all().
            if CLEANUP_IN_PROGRESS
                .compare_exchange(
                    false,
                    true,
                    std::sync::atomic::Ordering::SeqCst,
                    std::sync::atomic::Ordering::SeqCst,
                )
                .is_err()
            {
                return;
            }

            let browser_tab_manager = app_handle
                .try_state::<Arc<browser_tab_manager::BrowserTabManager>>()
                .map(|state| state.inner().clone());
            let ssh_manager = app_handle
                .try_state::<Arc<ssh::SSHManager>>()
                .map(|state| state.inner().clone());
            let remote_state = app_handle
                .try_state::<Arc<RemoteServerState>>()
                .map(|state| state.inner().clone());

            let acp_manager = app_handle
                .try_state::<Arc<AcpManager>>()
                .map(|state| state.inner().clone());

            if let Some(pty_manager) = app_handle.try_state::<Arc<PtyManager>>() {
                let pty_manager_clone = pty_manager.inner().clone();
                let app_handle_clone = app_handle.clone();

                // Spawn async cleanup task via tauri::async_runtime
                // (not tokio::spawn directly — the run callback may fire on
                // a thread without a Tokio reactor, e.g. macOS WKWebView events)
                tauri::async_runtime::spawn(async move {
                    if let Some(ssh_manager) = ssh_manager {
                        ssh_manager.shutdown().await;
                    }
                    if let Some(remote_state) = remote_state {
                        let _ = remote_state.stop().await;
                    }
                    pty_manager_clone.kill_all().await;
                    if let Some(acp_manager) = acp_manager {
                        // kill_all -> kill_all_checked flushes durable queues;
                        // shutdown_persistence then stops the writers so the
                        // host history index is canonical at exit.
                        acp_manager.kill_all().await;
                        if let Err(error) = acp_manager.shutdown_persistence().await {
                            log::error!(
                                "[acp-history] persistence shutdown failed at exit: {error}"
                            );
                        }
                    }
                    if let Some(browser_tab_manager) = browser_tab_manager {
                        browser_tab_manager.destroy_all();
                    }
                    // Mark cleanup as done so the subsequent exit event isn't prevented
                    CLEANUP_DONE.store(true, std::sync::atomic::Ordering::SeqCst);
                    // After cleanup completes, allow the app to exit with code 0
                    app_handle_clone.exit(0);
                });
            } else if let Some(acp_manager) = acp_manager {
                let app_handle_clone = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    acp_manager.kill_all().await;
                    if let Err(error) = acp_manager.shutdown_persistence().await {
                        log::error!("[acp-history] persistence shutdown failed at exit: {error}");
                    }
                    if let Some(browser_tab_manager) = browser_tab_manager {
                        browser_tab_manager.destroy_all();
                    }
                    CLEANUP_DONE.store(true, std::sync::atomic::Ordering::SeqCst);
                    app_handle_clone.exit(0);
                });
            } else {
                let app_handle_clone = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(ssh_manager) = ssh_manager {
                        ssh_manager.shutdown().await;
                    }
                    if let Some(remote_state) = remote_state {
                        let _ = remote_state.stop().await;
                    }
                    if let Some(browser_tab_manager) = browser_tab_manager {
                        browser_tab_manager.destroy_all();
                    }
                    CLEANUP_DONE.store(true, std::sync::atomic::Ordering::SeqCst);
                    // No PTY or ACP manager, just exit
                    app_handle_clone.exit(0);
                });
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
        // Verify primary Git Bash candidates are defined (compile-time guard)
        const { assert!(!git_bash_paths::PRIMARY_PATHS.is_empty()) };

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
        // Verify fallback Git Bash candidates are defined (compile-time guard)
        const { assert!(!git_bash_paths::FALLBACK_PATHS.is_empty()) };

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
