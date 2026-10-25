//! `takeSnapshotWithConfiguration:completionHandler:` of the visible
//! viewport, encoded as PNG through `NSBitmapImageRep`.

use std::cell::Cell;

use block2::RcBlock;
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
use objc2_foundation::{NSDictionary, NSError};
use objc2_web_kit::WKWebView;
use tokio::sync::oneshot;

use crate::browser_automation::engine::EngineErrorKind;

pub type Shot = oneshot::Sender<Result<Vec<u8>, EngineErrorKind>>;

fn png_of(image: &NSImage) -> Option<Vec<u8>> {
    // SAFETY: AppKit calls on the snapshot image, on the main thread that
    // runs the completion handler.
    unsafe {
        let tiff = image.TIFFRepresentation()?;
        let rep = NSBitmapImageRep::imageRepWithData(&tiff)?;
        let png = rep
            .representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())?;
        Some(png.to_vec())
    }
}

/// Issue the snapshot. Runs inside `with_webview`, on the main thread.
pub fn capture(webview: &WKWebView, done: Shot) {
    let done = Cell::new(Some(done));
    let handler = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
        let Some(done) = done.take() else {
            return;
        };
        // SAFETY: WebKit passes the image or nil, valid for the callback.
        let image = unsafe { image.as_ref() }.filter(|_| error.is_null());
        let _ = done.send(image.and_then(png_of).ok_or(EngineErrorKind::Malformed));
    });
    // SAFETY: main thread; a nil configuration captures the visible bounds.
    unsafe { webview.takeSnapshotWithConfiguration_completionHandler(None, &handler) };
}
