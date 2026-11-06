//! `webkit_web_view_get_snapshot` of the visible region, written as PNG.

use tokio::sync::oneshot;
use webkit2gtk::{gio, SnapshotOptions, SnapshotRegion, WebView, WebViewExt};

use crate::browser_automation::engine::EngineErrorKind;

pub type Shot = oneshot::Sender<Result<Vec<u8>, EngineErrorKind>>;

/// Issue the snapshot. Runs inside `with_webview`, on the GTK main thread;
/// the callback runs there too.
pub fn capture(webview: &WebView, done: Shot) {
    webview.snapshot(
        SnapshotRegion::Visible,
        SnapshotOptions::NONE,
        None::<&gio::Cancellable>,
        move |result| {
            let png = result.ok().and_then(|surface| {
                let mut out = Vec::new();
                surface.write_to_png(&mut out).ok().map(|()| out)
            });
            let _ = done.send(png.ok_or(EngineErrorKind::Malformed));
        },
    );
}
