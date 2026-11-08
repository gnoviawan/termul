//! Local files on WKWebView: `loadRequest` cannot read `file://` URLs, so
//! a host-checked file loads through `loadFileURL:allowingReadAccessToURL:`
//! with the narrowest read scope the host chose for it.

use std::path::PathBuf;

use objc2_foundation::{NSString, NSURL};
use objc2_web_kit::WKWebView;
use tauri::{Url, Webview};

pub fn load(webview: &Webview, url: &Url, read_access: PathBuf) -> Result<(), String> {
    let path = url
        .to_file_path()
        .map_err(|()| "the URL does not name a local file".to_string())?;
    webview
        .with_webview(move |platform| {
            // SAFETY: tauri hands out the tab's live WKWebView, and this
            // closure runs on the main thread that owns it.
            let webview = unsafe { &*platform.inner().cast::<WKWebView>() };
            let file = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
            let access = NSURL::fileURLWithPath(&NSString::from_str(&read_access.to_string_lossy()));
            // SAFETY: main thread; both are file URLs, and the access
            // scope is the file itself or a folder holding it.
            let started = unsafe { webview.loadFileURL_allowingReadAccessToURL(&file, &access) };
            if started.is_none() {
                log::warn!("[browser-tab] WKWebView did not start loading a local file");
            }
        })
        .map_err(|e| format!("Navigation failed: {e}"))
}
