//! OS notification that focuses the main window when the user clicks it.
//!
//! The Tauri notification plugin shows a toast and drops the click handle, so
//! a click never reaches the renderer. This command owns the `notify-rust`
//! handle and focuses `main` on the default body click.

use tauri::{AppHandle, Manager};

/// A body click reports `"default"`. Dismiss and close report `"__closed"`.
pub(crate) fn notification_click_should_focus(action: &str) -> bool {
    action == "default"
}

fn focus_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        log::warn!("notification click: main window is missing");
        return;
    };
    if let Err(error) = window.unminimize() {
        log::warn!("notification click: unminimize failed: {error}");
    }
    if let Err(error) = window.show() {
        log::warn!("notification click: show failed: {error}");
    }
    if let Err(error) = window.set_focus() {
        log::warn!("notification click: set_focus failed: {error}");
        return;
    }
    log::info!("notification click focused the main window");
}

/// Show a system notification. The command returns after the toast is posted.
/// A later default click focuses the main window. The title and body are not logged.
#[tauri::command]
pub fn notification_show(app: AppHandle, title: String, body: String) -> Result<(), String> {
    show_notification(app, &title, &body)
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
fn show_notification(app: AppHandle, title: &str, body: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let identifier = app.config().identifier.clone();
        let bundle_id = if tauri::is_dev() {
            "com.apple.Terminal"
        } else {
            identifier.as_str()
        };
        if let Err(error) = notify_rust::set_application(bundle_id) {
            log::warn!("notification show: set_application failed: {error}");
        }
    }

    let mut notification = notify_rust::Notification::new();
    notification.summary(title).body(body).auto_icon();

    #[cfg(target_os = "windows")]
    apply_windows_app_id(&mut notification, app.config().identifier.as_str());

    let handle = match notification.show() {
        Ok(handle) => handle,
        Err(error) => {
            log::warn!("notification show failed: {error}");
            return Err(error.to_string());
        }
    };

    if let Err(error) = std::thread::Builder::new()
        .name("notification-click".to_string())
        .spawn(move || {
            handle.wait_for_action(|action| {
                if notification_click_should_focus(action) {
                    focus_main_window(&app);
                }
            });
        })
    {
        log::warn!("notification click watcher failed to start: {error}");
    }

    Ok(())
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn show_notification(_app: AppHandle, _title: &str, _body: &str) -> Result<(), String> {
    log::warn!("notification show is unavailable on this platform");
    Err("notifications are unavailable on this platform".to_string())
}

/// Installed Windows builds set the toast AppUserModelID. Dev builds under
/// `target/debug` or `target/release` skip it, matching the notification plugin.
#[cfg(target_os = "windows")]
fn apply_windows_app_id(notification: &mut notify_rust::Notification, identifier: &str) {
    let Ok(exe) = tauri::utils::platform::current_exe() else {
        return;
    };
    let Some(exe_dir) = exe.parent() else {
        return;
    };
    let curr_dir = exe_dir.display().to_string();
    let debug_suffix = format!(
        "{}target{}debug",
        std::path::MAIN_SEPARATOR,
        std::path::MAIN_SEPARATOR
    );
    let release_suffix = format!(
        "{}target{}release",
        std::path::MAIN_SEPARATOR,
        std::path::MAIN_SEPARATOR
    );
    if curr_dir.ends_with(&debug_suffix) || curr_dir.ends_with(&release_suffix) {
        return;
    }
    notification.app_id(identifier);
}
