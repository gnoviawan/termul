//! `webkit_web_view_call_async_javascript_function` in the agent script
//! world. The page world shares the DOM with it and nothing else, and the
//! helper's JSON text comes back as the call's own return value.

use javascriptcore::ValueExt;
use tauri::webview::PlatformWebview;
use webkit2gtk::glib::{self, ToVariant};
use webkit2gtk::{gio, WebViewExt};

use crate::browser_automation::engine::assets::WORLD_NAME;
use crate::browser_automation::engine::string_eval::{Completion, PARAMS_ARG};
use crate::browser_automation::engine::EngineErrorKind;

/// Issue one helper call. Runs inside `with_webview`, on the GTK main
/// thread; the callback runs there too.
pub fn call(platform: &PlatformWebview, body: &str, params: &str, done: Completion) {
    let arguments = glib::VariantDict::new(None);
    arguments.insert_value(PARAMS_ARG, &params.to_variant());
    platform.inner().call_async_javascript_function(
        body,
        Some(&arguments.end()),
        Some(WORLD_NAME),
        None,
        None::<&gio::Cancellable>,
        move |result| {
            let outcome = match result {
                Ok(value) if value.is_string() => Ok(value.to_str().to_string()),
                Ok(_) => Err(EngineErrorKind::Malformed),
                Err(_) => Err(EngineErrorKind::PageException),
            };
            let _ = done.send(outcome);
        },
    );
}
