//! WebView2 download progress on tabs whose downloads the host holds.
//! Tauri's hook decides where a download lands and reports how it ended;
//! this handler reports its size while the bytes stream, so the host's cap
//! cancels it there instead of after the whole body is written.

use tauri::Url;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2DownloadOperation, ICoreWebView2_4,
};
use webview2_com::{take_pwstr, BytesReceivedChangedEventHandler, DownloadStartingEventHandler};
use windows_core::{Interface, BOOL, PWSTR};

use crate::browser_automation::engine::events::TabEvents;

/// The download's URL as tauri's hook reports it.
fn url_of(operation: &ICoreWebView2DownloadOperation) -> Option<Url> {
    let mut uri = PWSTR::null();
    // SAFETY: COM call on the event's own operation, on the UI thread;
    // `take_pwstr` frees the string.
    unsafe { operation.Uri(&mut uri) }.ok()?;
    take_pwstr(uri).parse().ok()
}

/// The size the operation has, or announced it will have.
fn size_of(operation: &ICoreWebView2DownloadOperation) -> u64 {
    let (mut received, mut total) = (0i64, -1i64);
    // SAFETY: as above. An unknown total stays -1.
    unsafe {
        let _ = operation.BytesReceived(&mut received);
        let _ = operation.TotalBytesToReceive(&mut total);
    }
    received.max(total).max(0).unsigned_abs()
}

pub fn attach(core: &ICoreWebView2, events: &TabEvents) -> bool {
    let Ok(core) = core.cast::<ICoreWebView2_4>() else {
        return false;
    };
    let events = events.clone();
    let handler = DownloadStartingEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else {
            return Ok(());
        };
        let mut cancelled = BOOL::default();
        // SAFETY: COM calls on the event's own args, on the UI thread.
        unsafe { args.Cancel(&mut cancelled)? };
        if cancelled.as_bool() {
            return Ok(());
        }
        // SAFETY: as above.
        let operation = unsafe { args.DownloadOperation()? };
        let Some(url) = url_of(&operation) else {
            return Ok(());
        };
        if !events.download_progress(&url, size_of(&operation)) {
            // SAFETY: as above. Cancelled here, no byte is written.
            unsafe { args.SetCancel(true)? };
            events.download_finished(&url, false);
            return Ok(());
        }
        let progress = events.clone();
        let on_bytes = BytesReceivedChangedEventHandler::create(Box::new(move |operation, _| {
            let Some(operation) = operation else {
                return Ok(());
            };
            if !progress.download_progress(&url, size_of(&operation)) {
                // SAFETY: COM call on the event's own operation, on the UI
                // thread. The interrupted state ends the download through
                // tauri's hook, which deletes the partial file.
                unsafe { operation.Cancel()? };
            }
            Ok(())
        }));
        let mut token = 0i64;
        // SAFETY: as above.
        unsafe { operation.add_BytesReceivedChanged(&on_bytes, &mut token) }
    }));
    let mut token = 0i64;
    // SAFETY: runs on the UI thread that owns `core`, inside `with_webview`.
    unsafe { core.add_DownloadStarting(&handler, &mut token) }.is_ok()
}
