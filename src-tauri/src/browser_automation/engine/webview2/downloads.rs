//! WebView2 downloads on tabs whose downloads the host holds. Tauri's hook
//! decides where a download lands. This handler, which runs after it,
//! reports the download's size while the bytes stream, and again on a
//! timer while none arrive, so the host's size cap, idle timeout and
//! deadline cancel it there instead of after the whole body is written,
//! and reports how it ended. Every report names the download by the path
//! the host chose for it.

use std::cell::{Cell, RefCell};
use std::path::PathBuf;

use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2DownloadOperation, ICoreWebView2_4,
    COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED, COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS,
};
use webview2_com::{
    take_pwstr, BytesReceivedChangedEventHandler, DownloadStartingEventHandler,
    StateChangedEventHandler,
};
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
    path: PathBuf,
}

thread_local! {
    static HELD: RefCell<Vec<Held>> = const { RefCell::new(Vec::new()) };
    static TIMER: Cell<usize> = const { Cell::new(0) };
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
        if held.events.download_progress(&held.path, size_of(&held.operation)) {
            live.push(held);
            continue;
        }
        // SAFETY: as above. The interrupted state reports the end, and
        // the host deletes the partial file.
        let _ = unsafe { held.operation.Cancel() };
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
        // SAFETY: as above. Tauri's handler, attached first, has set the
        // host's path; `take_pwstr` frees the string.
        let (operation, path) = unsafe {
            let mut path = PWSTR::null();
            args.ResultFilePath(&mut path)?;
            (args.DownloadOperation()?, PathBuf::from(take_pwstr(path)))
        };
        if !events.download_progress(&path, size_of(&operation)) {
            // SAFETY: as above. Cancelled here, no byte is written and no
            // state change follows.
            unsafe { args.SetCancel(true)? };
            events.download_finished(&path, false);
            return Ok(());
        }
        let progress = events.clone();
        let progress_path = path.clone();
        let on_bytes = BytesReceivedChangedEventHandler::create(Box::new(move |operation, _| {
            let Some(operation) = operation else {
                return Ok(());
            };
            if !progress.download_progress(&progress_path, size_of(&operation)) {
                // SAFETY: COM call on the event's own operation, on the UI
                // thread. The interrupted state reports the end.
                unsafe { operation.Cancel()? };
            }
            Ok(())
        }));
        let ended = events.clone();
        let ended_path = path.clone();
        let on_state = StateChangedEventHandler::create(Box::new(move |operation, _| {
            let Some(operation) = operation else {
                return Ok(());
            };
            let mut state = COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS;
            // SAFETY: as above.
            unsafe { operation.State(&mut state)? };
            if state != COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS {
                ended.download_finished(&ended_path, state == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED);
            }
            Ok(())
        }));
        let mut token = 0i64;
        // SAFETY: as above.
        unsafe {
            operation.add_BytesReceivedChanged(&on_bytes, &mut token)?;
            operation.add_StateChanged(&on_state, &mut token)?;
        }
        hold(Held {
            operation,
            events: events.clone(),
            path,
        });
        Ok(())
    }));
    let mut token = 0i64;
    // SAFETY: runs on the UI thread that owns `core`, inside `with_webview`.
    unsafe { core.add_DownloadStarting(&handler, &mut token) }.is_ok()
}
