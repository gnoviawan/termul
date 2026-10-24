//! WebView2 tab events tauri does not expose: same-document URL changes
//! (`pushState`, fragments, same-document history steps) through
//! `SourceChanged`, which reports whether a new document came with them;
//! external-app launches on every tab; script dialogs, file choosers, the
//! console, requests and out-of-process frame sessions on agent tabs.

use tauri::webview::PlatformWebview;
use webview2_com::{take_pwstr, SourceChangedEventHandler};
use windows_core::{BOOL, PWSTR};

use super::{dialogs, downloads, external_protocol, observe};
use crate::browser_automation::engine::events::{TabEvents, TabRole};

/// Confirm the controller has a live `ICoreWebView2` and register the
/// handlers. False when the engine never created the webview, or refused
/// a handler an agent tab needs.
pub fn attach(platform: &PlatformWebview, events: TabEvents) -> bool {
    // SAFETY: runs on the UI thread that owns the controller (inside
    // `with_webview`); the handler is reference-counted by WebView2.
    let Ok(core) = (unsafe { platform.controller().CoreWebView2() }) else {
        return false;
    };
    if !external_protocol::attach(&core, &events) {
        log::warn!("[browser-tab] WebView2 runtime has no external-launch hook; the navigation hook alone denies them");
    }
    if events.role() == TabRole::Agent && !(dialogs::attach(&core, &events) && observe::attach(&core, &events)) {
        return false;
    }
    if events.holds_downloads() && !downloads::attach(&core, &events) {
        return false;
    }
    let handler = SourceChangedEventHandler::create(Box::new(move |webview, args| {
        let (Some(webview), Some(args)) = (webview, args) else {
            return Ok(());
        };
        let mut new_document = BOOL::default();
        // SAFETY: COM calls on the event's own objects, on the UI thread.
        unsafe { args.IsNewDocument(&mut new_document)? };
        // A new document's URL arrives with its commit.
        if new_document.as_bool() {
            return Ok(());
        }
        let mut source = PWSTR::null();
        // SAFETY: as above; `take_pwstr` frees the returned string.
        unsafe { webview.Source(&mut source)? };
        events.same_document(&take_pwstr(source));
        Ok(())
    }));
    let mut token = 0i64;
    // SAFETY: as above.
    unsafe { core.add_SourceChanged(&handler, &mut token) }.is_ok()
}
