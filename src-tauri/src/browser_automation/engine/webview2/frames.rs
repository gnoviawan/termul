//! WebView2 frame guard on agent tabs. tauri's navigation hook sees only
//! the main frame, so a page could embed a local file in an iframe,
//! `<object>` or `<embed>` (each loads as a child frame) that no grant
//! covers, such as a key next to the project page the agent opened.
//! `FrameNavigationStarting` puts every child-frame navigation before the
//! core's frame policy: a `file://` frame loads only on the session's
//! exact grant of that file.

use tauri::Url;
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;
use webview2_com::{take_pwstr, NavigationStartingEventHandler};
use windows_core::PWSTR;

use crate::browser_automation::engine::events::TabEvents;

/// False when the runtime refused the handler.
pub fn attach(core: &ICoreWebView2, events: &TabEvents) -> bool {
    let events = events.clone();
    let handler = NavigationStartingEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else {
            return Ok(());
        };
        let mut uri = PWSTR::null();
        // SAFETY: COM calls on the event's own args, on the UI thread;
        // `take_pwstr` frees the returned string.
        if unsafe { args.Uri(&mut uri) }.is_err() {
            // A frame whose target cannot be read cannot be checked.
            log::warn!(
                "[browser-tab] frame navigation cancelled tab={} reason=uri_unreadable",
                events.label()
            );
            // SAFETY: as above.
            unsafe { args.SetCancel(true)? };
            return Ok(());
        }
        let uri = take_pwstr(uri);
        // Only file frames are guarded. A file URL the parser rejects
        // cannot be granted: refuse it.
        let allowed = !uri.get(..5).is_some_and(|scheme| scheme.eq_ignore_ascii_case("file:"))
            || uri.parse::<Url>().is_ok_and(|url| events.frame_starting(&url));
        if !allowed {
            // SAFETY: as above.
            unsafe { args.SetCancel(true)? };
        }
        Ok(())
    }));
    let mut token = 0i64;
    // SAFETY: runs on the UI thread that owns `core`, inside `with_webview`.
    unsafe { core.add_FrameNavigationStarting(&handler, &mut token) }.is_ok()
}
