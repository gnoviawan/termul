//! Local `file://` pages in agent tabs: how a host-checked file is loaded.
//! The frame guard that keeps a file page from embedding files it holds
//! no grant for is per engine: WebKit engines send every frame navigation
//! through the tab's navigation hook, and WebView2 adds a frame
//! navigation handler (`webview2::frames`).

use std::path::PathBuf;

use tauri::{Url, Webview};

/// Load the host-checked file `url` into `webview`. WKWebView reads a
/// local file only through `loadFileURL:allowingReadAccessToURL:`, scoped
/// to `read_access` (the project folder for a project file, the file
/// itself for any other); the other engines navigate to it.
#[cfg(target_os = "macos")]
pub fn load(webview: &Webview, url: Url, read_access: PathBuf) -> Result<(), String> {
    super::wkwebview::files::load(webview, &url, read_access)
}

#[cfg(not(target_os = "macos"))]
pub fn load(webview: &Webview, url: Url, _read_access: PathBuf) -> Result<(), String> {
    webview
        .navigate(url)
        .map_err(|e| format!("Navigation failed: {e}"))
}
