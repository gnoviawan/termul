//! WKWebView tab events. Starts, commits, loads and titles come from
//! tauri's builder hooks (navigation delegate and title observer). Same-
//! document URL changes need key-value observation of `URL`, which this
//! adapter does not do yet, so `pushState` URLs reach the registry only
//! with the next commit on macOS. Agent tabs get the JavaScript-panel
//! delegate.

use objc2::MainThreadMarker;
use objc2_web_kit::WKWebView;
use tauri::webview::PlatformWebview;

use super::ui_delegate;
use crate::browser_automation::engine::events::{TabEvents, TabRole};

/// Confirm the engine created the `WKWebView` and, on an agent tab, put
/// the panel delegate in front of wry's.
pub fn attach(platform: &PlatformWebview, events: TabEvents) -> bool {
    if platform.inner().is_null() {
        return false;
    }
    if events.role() != TabRole::Agent {
        return true;
    }
    let Some(mtm) = MainThreadMarker::new() else {
        return false;
    };
    // SAFETY: tauri hands out the tab's live WKWebView, and this closure
    // runs on the main thread that owns it.
    let webview = unsafe { &*platform.inner().cast::<WKWebView>() };
    ui_delegate::install(webview, events, mtm)
}
