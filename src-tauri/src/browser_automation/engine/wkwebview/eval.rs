//! `callAsyncJavaScript:arguments:inFrame:inContentWorld:completionHandler:`
//! in the agent content world. The page world shares the DOM with it and
//! nothing else, and the helper's JSON text comes back as the call's own
//! return value.

use std::cell::Cell;

use block2::RcBlock;
use objc2::runtime::AnyObject;
use objc2::MainThreadMarker;
use objc2_foundation::{NSDictionary, NSError, NSString};
use objc2_web_kit::{WKContentWorld, WKWebView};
use tauri::webview::PlatformWebview;

use crate::browser_automation::engine::assets::WORLD_NAME;
use crate::browser_automation::engine::string_eval::{Completion, PARAMS_ARG};
use crate::browser_automation::engine::EngineErrorKind;

/// Named content worlds and `callAsyncJavaScript` arrived in macOS 11.
pub fn content_worlds_available() -> bool {
    objc2::available!(macos = 11.0)
}

/// Issue one helper call. Runs inside `with_webview`, on the main thread.
pub fn call(platform: &PlatformWebview, body: &str, params: &str, done: Completion) {
    let Some(mtm) = MainThreadMarker::new() else {
        let _ = done.send(Err(EngineErrorKind::Dispatch));
        return;
    };
    // SAFETY: tauri hands out the tab's live WKWebView, and this closure
    // runs on the main thread that owns it.
    let webview = unsafe { &*platform.inner().cast::<WKWebView>() };
    // SAFETY: main thread, as above.
    let world = unsafe { WKContentWorld::worldWithName(&NSString::from_str(WORLD_NAME), mtm) };
    let key = NSString::from_str(PARAMS_ARG);
    let value = NSString::from_str(params);
    let value: &AnyObject = &value;
    let arguments = NSDictionary::<NSString, AnyObject>::from_slices(&[&*key], &[value]);
    let done = Cell::new(Some(done));
    let handler = RcBlock::new(move |result: *mut AnyObject, error: *mut NSError| {
        let Some(done) = done.take() else {
            return;
        };
        let outcome = if error.is_null() {
            // SAFETY: WebKit passes the converted return value or nil, valid
            // for the duration of the callback.
            match unsafe { result.as_ref() }.and_then(|r| r.downcast_ref::<NSString>()) {
                Some(json) => Ok(json.to_string()),
                None => Err(EngineErrorKind::Malformed),
            }
        } else {
            Err(EngineErrorKind::PageException)
        };
        let _ = done.send(outcome);
    });
    // SAFETY: main thread; the arguments dictionary holds only strings, the
    // type the call requires of its values.
    unsafe {
        webview.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(
            &NSString::from_str(body),
            Some(&*arguments),
            None,
            &world,
            Some(&*handler),
        );
    }
}
