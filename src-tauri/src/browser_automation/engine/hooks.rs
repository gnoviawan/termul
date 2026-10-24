//! Engine hooks every tab webview is built with, through tauri's
//! cross-engine builder hooks: navigation start (with the core's verdict),
//! new-document commit, load finish and title change, and on agent tabs
//! the new-window request. Each adapter adds what tauri does not expose
//! (same-document URL changes, script dialogs, external-app launches)
//! when the webview is confirmed.

use tauri::webview::{NewWindowResponse, PageLoadEvent, PlatformWebview, WebviewBuilder};
use tauri::{Webview, Wry};
use tokio::sync::oneshot;

use super::dialogs;
use super::events::{TabEvent, TabEvents, TabRole};
use crate::browser_automation::budgets;

pub fn install(builder: WebviewBuilder<Wry>, events: &TabEvents) -> WebviewBuilder<Wry> {
    let nav = events.clone();
    let load = events.clone();
    let title = events.clone();
    let builder = builder
        .on_navigation(move |url| nav.nav_starting(url))
        .on_page_load(move |_, payload| match payload.event() {
            PageLoadEvent::Started => load.committed(payload.url().as_str()),
            PageLoadEvent::Finished => load.publish(TabEvent::LoadFinished),
        })
        .on_document_title_changed(move |_, t| title.publish(TabEvent::TitleChanged { title: t }));
    let builder = install_downloads(builder, events);
    if events.role() != TabRole::Agent {
        return builder;
    }
    // WebView2 observes the console through CDP instead.
    #[cfg(not(target_os = "windows"))]
    let builder = builder.initialization_script_for_all_frames(super::assets::CONSOLE_SHIM);
    // The engine window never opens: the opener-less tab the core may open
    // instead is the popup's only form.
    let popup = events.clone();
    builder.on_new_window(move |url, _| {
        popup.publish(TabEvent::NewWindowRequested { url: url.to_string() });
        NewWindowResponse::Deny
    })
}

/// WebView2 and WKWebView raise downloads per webview through tauri's hook.
#[cfg(not(target_os = "linux"))]
fn install_downloads(builder: WebviewBuilder<Wry>, events: &TabEvents) -> WebviewBuilder<Wry> {
    use tauri::webview::DownloadEvent;

    if !events.holds_downloads() {
        return builder;
    }
    let downloads = events.clone();
    builder.on_download(move |_, event| match event {
        DownloadEvent::Requested { url, destination } => {
            match downloads.download_starting(&url, destination) {
                Some(path) => {
                    *destination = path;
                    true
                }
                None => false,
            }
        }
        DownloadEvent::Finished { url, success, .. } => {
            downloads.download_finished(&url, success);
            true
        }
        _ => true,
    })
}

/// WebKitGTK raises downloads on the web context every tab shares, so the
/// adapter attaches its own handler per webview (`webkitgtk::events`).
#[cfg(target_os = "linux")]
fn install_downloads(builder: WebviewBuilder<Wry>, _events: &TabEvents) -> WebviewBuilder<Wry> {
    builder
}

/// Why a built webview is refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachError {
    /// The UI thread never ran the attach step: tauri accepted the
    /// webview but the engine failed to create it.
    NotCreated,
    /// The engine object exists but refused the adapter's hooks.
    Refused,
    Timeout,
}

impl std::fmt::Display for AttachError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            AttachError::NotCreated => "not created",
            AttachError::Refused => "hooks refused",
            AttachError::Timeout => "no answer",
        })
    }
}

/// Confirm the engine created `webview` and attach the adapter's own
/// hooks, in one round trip to the UI thread.
pub async fn attach(webview: &Webview, events: TabEvents) -> Result<(), AttachError> {
    let (tx, rx) = oneshot::channel();
    webview
        .with_webview(move |platform| {
            let _ = tx.send(attach_platform(&platform, events));
        })
        .map_err(|_| AttachError::NotCreated)?;
    match tokio::time::timeout(budgets::TAB_CONFIRM, rx).await {
        Ok(Ok(true)) => Ok(()),
        Ok(Ok(false)) => Err(AttachError::Refused),
        Ok(Err(_)) => Err(AttachError::NotCreated),
        Err(_) => Err(AttachError::Timeout),
    }
}

#[cfg(target_os = "windows")]
fn attach_platform(platform: &PlatformWebview, events: TabEvents) -> bool {
    super::webview2::events::attach(platform, events)
}

#[cfg(target_os = "linux")]
fn attach_platform(platform: &PlatformWebview, events: TabEvents) -> bool {
    super::webkitgtk::events::attach(platform, events)
}

#[cfg(target_os = "macos")]
fn attach_platform(platform: &PlatformWebview, events: TabEvents) -> bool {
    super::wkwebview::events::attach(platform, events)
}

/// Close `webview` and return once the UI thread has processed the close:
/// the UI thread handles webview messages in order, so a closure queued
/// behind the close settles only after the webview is destroyed.
pub async fn close(webview: &Webview) {
    let label = webview.label().to_string();
    let _ = webview.with_webview(move |_| {
        dialogs::release_tab(&label);
        #[cfg(target_os = "windows")]
        super::webview2::observe::release_tab(&label);
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        super::file_chooser::release_tab(&label);
    });
    let _ = webview.close();
    let (tx, rx) = oneshot::channel::<()>();
    if webview.with_webview(move |_| drop(tx)).is_ok() {
        let _ = tokio::time::timeout(budgets::TAB_CONFIRM, rx).await;
    }
}
