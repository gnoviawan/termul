//! WebView2 download progress on tabs whose downloads the host holds.
//! Tauri's hook decides where a download lands and reports how it ended;
//! this handler reports its size while the bytes stream, and again on a
//! timer while none arrive, so the host's size cap, idle timeout and
//! deadline cancel it there instead of after the whole body is written.

use std::cell::{Cell, RefCell};

use tauri::Url;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2DownloadOperation, ICoreWebView2_4,
    COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS,
};
use webview2_com::{take_pwstr, BytesReceivedChangedEventHandler, DownloadStartingEventHandler};
use windows_core::{Interface, BOOL, PWSTR};
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::UI::WindowsAndMessaging::{KillTimer, SetTimer};

use crate::browser_automation::engine::events::{DownloadSize, TabEvents};

/// How often a download in progress is checked while no byte arrives.
const TICK_MS: u32 = 1000;

/// A download in progress the host holds.
struct Held {
    operation: ICoreWebView2DownloadOperation,
    events: TabEvents,
    url: Url,
}

thread_local! {
    static HELD: RefCell<Vec<Held>> = const { RefCell::new(Vec::new()) };
    static TIMER: Cell<usize> = const { Cell::new(0) };
}

/// The download's URL as tauri's hook reports it.
fn url_of(operation: &ICoreWebView2DownloadOperation) -> Option<Url> {
    let mut uri = PWSTR::null();
    // SAFETY: COM call on the event's own operation, on the UI thread;
    // `take_pwstr` frees the string.
    unsafe { operation.Uri(&mut uri) }.ok()?;
    take_pwstr(uri).parse().ok()
}

/// How far the operation got.
fn size_of(operation: &ICoreWebView2DownloadOperation) -> DownloadSize {
    let (mut received, mut total) = (0i64, -1i64);
    // SAFETY: as above. An unknown total stays -1.
    unsafe {
        let _ = operation.BytesReceived(&mut received);
        let _ = operation.TotalBytesToReceive(&mut total);
    }
    DownloadSize {
        received: received.max(0).unsigned_abs(),
        announced: u64::try_from(total).ok(),
    }
}

/// Check `held` on every tick until it ends.
fn hold(held: Held) {
    HELD.with_borrow_mut(|all| all.push(held));
    if TIMER.get() == 0 {
        // SAFETY: a thread timer of the UI thread, whose message loop
        // runs `tick` on this same thread.
        TIMER.set(unsafe { SetTimer(std::ptr::null_mut(), 0, TICK_MS, Some(tick)) });
    }
}

unsafe extern "system" fn tick(_: HWND, _: u32, _: usize, _: u32) {
    let mut live = Vec::new();
    for held in HELD.take() {
        let mut state = COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS;
        // SAFETY: COM calls on an operation this UI thread holds.
        let running = unsafe { held.operation.State(&mut state) }.is_ok()
            && state == COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS;
        if !running {
            continue;
        }
        if held.events.download_progress(&held.url, size_of(&held.operation)) {
            live.push(held);
            continue;
        }
        // SAFETY: as above. The interrupted state ends the download
        // through tauri's hook, which deletes the partial file.
        let _ = unsafe { held.operation.Cancel() };
        held.events.download_finished(&held.url, false);
    }
    HELD.with_borrow_mut(|all| all.extend(live));
    if HELD.with_borrow(Vec::is_empty) {
        // SAFETY: the timer `hold` set on this thread.
        unsafe { KillTimer(std::ptr::null_mut(), TIMER.replace(0)) };
    }
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
        let progress_url = url.clone();
        let on_bytes = BytesReceivedChangedEventHandler::create(Box::new(move |operation, _| {
            let Some(operation) = operation else {
                return Ok(());
            };
            if !progress.download_progress(&progress_url, size_of(&operation)) {
                // SAFETY: COM call on the event's own operation, on the UI
                // thread. The interrupted state ends the download through
                // tauri's hook, which deletes the partial file.
                unsafe { operation.Cancel()? };
            }
            Ok(())
        }));
        let mut token = 0i64;
        // SAFETY: as above.
        unsafe { operation.add_BytesReceivedChanged(&on_bytes, &mut token)? };
        hold(Held {
            operation,
            events: events.clone(),
            url,
        });
        Ok(())
    }));
    let mut token = 0i64;
    // SAFETY: runs on the UI thread that owns `core`, inside `with_webview`.
    unsafe { core.add_DownloadStarting(&handler, &mut token) }.is_ok()
}
