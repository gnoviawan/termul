//! Local files on WKWebView: `loadRequest` cannot read `file://` URLs, so
//! a host-checked file loads through `loadFileURL:allowingReadAccessToURL:`
//! with the narrowest read scope the host chose for it.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use objc2_foundation::{NSString, NSURL};
use objc2_web_kit::WKWebView;
use tauri::Url;
use tokio::sync::oneshot;

use super::super::{EngineError, EngineErrorKind};
use crate::browser_automation::budgets::EVAL_STEP;
use crate::browser_tab_manager::BrowserTabManager;

/// Start loading the file `url` in `tab`, its page allowed to read
/// `read_access`. Fails when WebKit refuses to start the load. A load the
/// main thread gets to only after the wait ran out is not started: the
/// caller already reported it failed, or never will.
pub async fn load(
    tabs: &Arc<BrowserTabManager>,
    tab: &str,
    url: &Url,
    read_access: &Path,
) -> Result<(), EngineError> {
    let path = url
        .to_file_path()
        .map_err(|()| EngineError::new(EngineErrorKind::Unsupported))?;
    let read_access = read_access.to_path_buf();
    let webview = tabs
        .webview(tab)
        .map_err(|_| EngineError::new(EngineErrorKind::TabNotFound))?;
    let (tx, rx) = oneshot::channel::<Result<(), EngineErrorKind>>();
    let abandoned = Arc::new(AtomicBool::new(false));
    let late = Arc::clone(&abandoned);
    let _caller = StoppedWaiting(Arc::clone(&abandoned));
    let tab_label = tab.to_string();
    webview
        .with_webview(move |platform| {
            if late.load(Ordering::Acquire) {
                log::info!("[browser-tab] local file load dropped tab={tab_label} reason=caller_gave_up");
                return;
            }
            // SAFETY: tauri hands out the tab's live WKWebView, and this
            // closure runs on the main thread that owns it.
            let webview = unsafe { &*platform.inner().cast::<WKWebView>() };
            let file = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
            let access = NSURL::fileURLWithPath(&NSString::from_str(&read_access.to_string_lossy()));
            // SAFETY: main thread; both are file URLs, and the access
            // scope is the file itself or a folder holding it.
            let started = unsafe { webview.loadFileURL_allowingReadAccessToURL(&file, &access) };
            let result = if started.is_some() {
                Ok(())
            } else {
                log::warn!(
                    "[browser-tab] WKWebView did not start loading a local file tab={tab_label} kind={:?}",
                    EngineErrorKind::Dispatch
                );
                Err(EngineErrorKind::Dispatch)
            };
            let _ = tx.send(result);
        })
        .map_err(|_| EngineError::new(EngineErrorKind::Dispatch))?;
    match tokio::time::timeout(EVAL_STEP, rx).await {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(kind))) => Err(EngineError::new(kind)),
        Ok(Err(_)) => Err(EngineError::new(EngineErrorKind::NoReply)),
        Err(_) => Err(EngineError::new(EngineErrorKind::Timeout)),
    }
}

/// Marks the load abandoned when the caller stops waiting: its timeout ran
/// out, or its future was dropped (a dialog interrupting the call). A
/// closure that runs afterwards starts nothing. After the closure ran the
/// mark is harmless.
struct StoppedWaiting(Arc<AtomicBool>);

impl Drop for StoppedWaiting {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}
