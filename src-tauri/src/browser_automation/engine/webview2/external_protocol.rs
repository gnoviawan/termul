//! WebView2 external-app launches (`mailto:`, `ms-*`, custom schemes):
//! every one is cancelled, on every tab. The navigation hook already
//! denies a main-frame hop to such a URL; this covers frames and scripts
//! the hook does not see.

use webview2_com::LaunchingExternalUriSchemeEventHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2, ICoreWebView2_18};
use windows_core::Interface;

use crate::browser_automation::engine::events::{TabEvent, TabEvents};

/// False when the runtime predates `LaunchingExternalUriScheme`.
pub fn attach(core: &ICoreWebView2, events: &TabEvents) -> bool {
    let Ok(core) = core.cast::<ICoreWebView2_18>() else {
        return false;
    };
    let events = events.clone();
    let handler = LaunchingExternalUriSchemeEventHandler::create(Box::new(move |_, args| {
        if let Some(args) = args {
            // SAFETY: COM call on the event's own args, on the UI thread.
            unsafe { args.SetCancel(true)? };
            events.publish(TabEvent::ExternalProtocolBlocked);
        }
        Ok(())
    }));
    let mut token = 0i64;
    // SAFETY: runs on the UI thread that owns `core`, inside `with_webview`.
    unsafe { core.add_LaunchingExternalUriScheme(&handler, &mut token) }.is_ok()
}
