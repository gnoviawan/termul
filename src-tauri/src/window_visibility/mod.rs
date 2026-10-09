//! Main-window visibility safety net (gh-719).
//!
//! `tauri.conf.json` creates the `main` window with `"visible": false`; the
//! renderer shows it once window-state restore finishes. If the frontend never
//! mounts (or a geometry call never settles) the window would stay unmapped on
//! Wayland/Hyprland. `spawn_show_fallback` is a one-shot Rust-side net that
//! shows the window shortly after setup if it is still hidden, without
//! fighting intentional hidden states (minimized, close-to-tray).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager, WindowEvent};

const MAIN_WINDOW_LABEL: &str = "main";
/// How long after setup we wait before forcing the main window visible.
const SHOW_FALLBACK_DELAY: Duration = Duration::from_secs(5);

/// Pure Wayland-session detection from the relevant environment values
/// (`XDG_SESSION_TYPE` wins when set; `WAYLAND_DISPLAY` is the fallback).
/// Always false on non-Linux targets.
pub(crate) fn is_wayland_from_env(
    xdg_session_type: Option<&str>,
    wayland_display: Option<&str>,
) -> bool {
    if !cfg!(target_os = "linux") {
        return false;
    }
    // Prefer the explicit session type: WAYLAND_DISPLAY can be inherited by an
    // X11/XWayland session where client-side positioning still works.
    if let Some(session) = xdg_session_type.map(str::trim).filter(|v| !v.is_empty()) {
        return session.eq_ignore_ascii_case("wayland");
    }
    wayland_display
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
}

/// Whether the fallback should force the main window visible.
pub(crate) fn should_force_show(visible: bool, minimized: bool, close_requested: bool) -> bool {
    !visible && !minimized && !close_requested
}

/// Tauri command: true when the desktop session is Linux Wayland. The renderer
/// uses it to skip client-side `setPosition`, which Wayland compositors ignore
/// or never settle.
#[tauri::command]
pub fn is_wayland_session() -> bool {
    is_wayland_from_env(
        std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
        std::env::var("WAYLAND_DISPLAY").ok().as_deref(),
    )
}

/// Spawn the one-shot fallback that shows the main window if it is still
/// hidden `SHOW_FALLBACK_DELAY` after setup.
pub fn spawn_show_fallback(app: &AppHandle) {
    let close_requested = Arc::new(AtomicBool::new(false));

    match app.get_webview_window(MAIN_WINDOW_LABEL) {
        Some(window) => {
            let flag = Arc::clone(&close_requested);
            window.on_window_event(move |event| {
                if matches!(event, WindowEvent::CloseRequested { .. }) {
                    flag.store(true, Ordering::SeqCst);
                }
            });
        }
        None => {
            log::warn!("[window-visibility] main window missing at setup; show fallback skipped");
            return;
        }
    }

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SHOW_FALLBACK_DELAY).await;

        let Some(window) = handle.get_webview_window(MAIN_WINDOW_LABEL) else {
            return;
        };

        let visible = match window.is_visible() {
            Ok(v) => v,
            Err(e) => {
                log::warn!("[window-visibility] is_visible failed, skipping fallback: {e}");
                return;
            }
        };
        let minimized = match window.is_minimized() {
            Ok(v) => v,
            Err(e) => {
                log::warn!("[window-visibility] is_minimized failed, skipping fallback: {e}");
                return;
            }
        };

        if should_force_show(visible, minimized, close_requested.load(Ordering::SeqCst)) {
            log::warn!(
                "[window-visibility] main window still hidden {}s after setup; forcing show",
                SHOW_FALLBACK_DELAY.as_secs()
            );
            if let Err(e) = window.show() {
                log::warn!("[window-visibility] fallback show failed: {e}");
            }
        }
    });
}

#[cfg(test)]
mod tests;
