//! WKWebView tab events. Starts, commits, loads and titles come from
//! tauri's builder hooks (navigation delegate and title observer). Same-
//! document URL changes need key-value observation of `URL`, which this
//! adapter does not do yet, so `pushState` URLs reach the registry only
//! with the next commit on macOS. Agent tabs get the JavaScript-panel
//! delegate, and tabs whose downloads the host holds the download watch.

use objc2::MainThreadMarker;
use objc2_web_kit::WKWebView;
use tauri::webview::PlatformWebview;

use super::{downloads, ui_delegate};
use crate::browser_automation::engine::events::{TabEvents, TabRole};

/// Confirm the engine created the `WKWebView` and put the download watch
/// and, on an agent tab, the panel delegate in front of wry's delegates.
pub fn attach(platform: &PlatformWebview, events: TabEvents) -> bool {
    if platform.inner().is_null() {
        return false;
    }
    let agent = events.role() == TabRole::Agent;
    let holds_downloads = events.holds_downloads();
    if !agent && !holds_downloads {
        return true;
    }
    let Some(mtm) = MainThreadMarker::new() else {
        return false;
    };
    // SAFETY: tauri hands out the tab's live WKWebView, and this closure
    // runs on the main thread that owns it.
    let webview = unsafe { &*platform.inner().cast::<WKWebView>() };
    if holds_downloads && !downloads::install(webview, events.clone(), mtm) {
        return false;
    }
    !agent || ui_delegate::install(webview, events, mtm)
}
