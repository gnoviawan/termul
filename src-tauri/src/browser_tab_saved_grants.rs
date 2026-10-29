//! Saved web-permission grants for browser-tab webviews.
//!
//! The deny handler in `browser_tab_permissions` only sees permission requests the
//! engine raises. A grant that is already saved in the webview profile can answer a
//! page without raising one, so a browser tab clears them before it loads a page.
//!
//! WebView2 persists per-origin permission state in the profile, and every user tab
//! shares that profile with the app's own UI, so [`clear_saved_grants`] resets each
//! non-default entry of a site back to `Default` through `ICoreWebView2Profile4`. Entries
//! of the app's own origin are left alone: only the main webview loads it, and the deny
//! handler does not govern it. Every tab carries the deny handler, so once a clear has
//! finished no tab can save a new grant; [`ClearOnce`] therefore clears once per process,
//! and a clear that fails never keeps the user's tab from opening. WKWebView asks its delegate for
//! camera and microphone access on every request and keeps no per-site state of its
//! own, and WebKitGTK has no persistent permission store, so there is nothing to clear
//! on macOS and Linux.

/// Outcome of a clear: how many saved entries were reset and how many resets failed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct ClearReport {
    pub reset: usize,
    pub failed: usize,
}

/// Why a clear did not finish: the runtime lacks the profile API, or a call failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code, reason = "only the WebView2 clear can fail"))]
pub(crate) enum ClearError {
    Unsupported,
    Failed,
}

/// Whether a saved entry's origin is the app UI's own origin.
#[cfg_attr(not(windows), allow(dead_code, reason = "only the WebView2 clear filters entries"))]
pub(crate) fn is_app_origin(saved: &str, app_origin: &str) -> bool {
    saved
        .trim_end_matches('/')
        .eq_ignore_ascii_case(app_origin.trim_end_matches('/'))
}

/// Runs the profile clear until one settles it: a finished clear, or a runtime
/// that cannot clear at all. A failed clear stays unsettled, so the next tab
/// tries again.
#[derive(Default)]
#[cfg_attr(
    not(windows),
    allow(dead_code, reason = "only WebView2 user tabs share a profile with saved grants")
)]
pub(crate) struct ClearOnce {
    settled: tokio::sync::Mutex<bool>,
}

#[cfg_attr(
    not(windows),
    allow(dead_code, reason = "only WebView2 user tabs share a profile with saved grants")
)]
impl ClearOnce {
    /// `None` once an earlier clear settled; otherwise this attempt's result.
    pub async fn run<F, Fut>(&self, clear: F) -> Option<Result<ClearReport, ClearError>>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<ClearReport, ClearError>>,
    {
        let mut settled = self.settled.lock().await;
        if *settled {
            return None;
        }
        let result = clear().await;
        *settled = !matches!(result, Err(ClearError::Failed));
        Some(result)
    }
}

/// Counts the asynchronous resets a clear issued and yields the report when the
/// last one answers.
#[cfg_attr(not(windows), allow(dead_code, reason = "only the WebView2 clear issues async resets"))]
pub(crate) struct ResetTally {
    pending: usize,
    report: ClearReport,
}

#[cfg_attr(not(windows), allow(dead_code, reason = "only the WebView2 clear issues async resets"))]
impl ResetTally {
    pub fn new(total: usize) -> Self {
        Self {
            pending: total,
            report: ClearReport::default(),
        }
    }

    /// Record one answer. `Some` when it was the last outstanding reset.
    pub fn record(&mut self, succeeded: bool) -> Option<ClearReport> {
        if succeeded {
            self.report.reset += 1;
        } else {
            self.report.failed += 1;
        }
        self.pending = self.pending.saturating_sub(1);
        (self.pending == 0).then_some(self.report)
    }
}

#[cfg(windows)]
mod windows_impl {
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::time::Duration;

    use tokio::sync::oneshot;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2PermissionSetting, ICoreWebView2Profile4, ICoreWebView2_13,
        COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_STATE,
        COREWEBVIEW2_PERMISSION_STATE_DEFAULT,
    };
    use webview2_com::{
        take_pwstr, GetNonDefaultPermissionSettingsCompletedHandler,
        SetPermissionStateCompletedHandler,
    };
    use windows_core::{Interface, HSTRING, PWSTR};

    use super::{is_app_origin, ClearError, ClearReport, ResetTally};

    const CLEAR_TIMEOUT: Duration = Duration::from_secs(3);

    type Reply = Rc<RefCell<Option<oneshot::Sender<Result<ClearReport, ()>>>>>;

    /// Reset every saved permission entry of the profile `webview` runs in,
    /// except those of `app_origin`.
    pub(crate) async fn clear_saved_grants(
        webview: &tauri::Webview,
        app_origin: String,
    ) -> Result<ClearReport, ClearError> {
        let (tx, rx) = oneshot::channel::<Result<ClearReport, ()>>();
        let (support_tx, support_rx) = oneshot::channel::<bool>();
        webview
            .with_webview(move |platform| {
                // SAFETY: runs on the UI thread that owns the WebView2 objects. The
                // profile handle is cloned into the completion handlers, which
                // WebView2 invokes on this same thread.
                let profile = unsafe { platform.controller().CoreWebView2() }
                    .and_then(|core| core.cast::<ICoreWebView2_13>())
                    .and_then(|core| unsafe { core.Profile() })
                    .and_then(|profile| profile.cast::<ICoreWebView2Profile4>());
                let Ok(profile) = profile else {
                    let _ = support_tx.send(false);
                    return;
                };
                let _ = support_tx.send(true);
                let reply: Reply = Rc::new(RefCell::new(Some(tx)));
                issue(&profile, app_origin, reply);
            })
            .map_err(|_| ClearError::Failed)?;
        if !support_rx.await.map_err(|_| ClearError::Failed)? {
            return Err(ClearError::Unsupported);
        }
        match tokio::time::timeout(CLEAR_TIMEOUT, rx).await {
            Ok(Ok(Ok(report))) if report.failed == 0 => Ok(report),
            _ => Err(ClearError::Failed),
        }
    }

    fn finish(reply: &Reply, result: Result<ClearReport, ()>) {
        if let Some(tx) = reply.borrow_mut().take() {
            let _ = tx.send(result);
        }
    }

    fn issue(profile: &ICoreWebView2Profile4, app_origin: String, reply: Reply) {
        let list_profile = profile.clone();
        let list_reply = reply.clone();
        let handler = GetNonDefaultPermissionSettingsCompletedHandler::create(Box::new(
            move |hr, collection| {
                let entries = match (hr, collection) {
                    (Ok(()), Some(collection)) => saved_entries(&collection, &app_origin),
                    _ => Err(()),
                };
                match entries {
                    Ok(entries) => reset_all(&list_profile, entries, list_reply),
                    Err(()) => finish(&list_reply, Err(())),
                }
                Ok(())
            },
        ));
        // SAFETY: on the UI thread; WebView2 addrefs the handler for the round trip.
        if unsafe { profile.GetNonDefaultPermissionSettings(&handler) }.is_err() {
            finish(&reply, Err(()));
        }
    }

    fn saved_entries(
        collection: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2PermissionSettingCollectionView,
        app_origin: &str,
    ) -> Result<Vec<(COREWEBVIEW2_PERMISSION_KIND, String)>, ()> {
        let mut count = 0u32;
        // SAFETY: the collection is valid for the duration of the callback.
        unsafe { collection.Count(&mut count) }.map_err(|_| ())?;
        let mut entries = Vec::new();
        for index in 0..count {
            let setting =
                unsafe { collection.GetValueAtIndex(index) }.map_err(|_| ())?;
            let (kind, origin, state) = read_setting(&setting)?;
            if state != COREWEBVIEW2_PERMISSION_STATE_DEFAULT && !is_app_origin(&origin, app_origin) {
                entries.push((kind, origin));
            }
        }
        Ok(entries)
    }

    fn read_setting(
        setting: &ICoreWebView2PermissionSetting,
    ) -> Result<(COREWEBVIEW2_PERMISSION_KIND, String, COREWEBVIEW2_PERMISSION_STATE), ()> {
        let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
        let mut state = COREWEBVIEW2_PERMISSION_STATE::default();
        let mut origin = PWSTR::null();
        // SAFETY: out-pointers are valid locals; the origin string is CoTaskMem-owned
        // and released by `take_pwstr`.
        unsafe {
            setting.PermissionKind(&mut kind).map_err(|_| ())?;
            setting.PermissionState(&mut state).map_err(|_| ())?;
            setting.PermissionOrigin(&mut origin).map_err(|_| ())?;
        }
        Ok((kind, take_pwstr(origin), state))
    }

    fn reset_all(
        profile: &ICoreWebView2Profile4,
        entries: Vec<(COREWEBVIEW2_PERMISSION_KIND, String)>,
        reply: Reply,
    ) {
        if entries.is_empty() {
            finish(&reply, Ok(ClearReport::default()));
            return;
        }
        let tally = Rc::new(RefCell::new(ResetTally::new(entries.len())));
        for (kind, origin) in entries {
            let answered = tally.clone();
            let done_reply = reply.clone();
            let handler = SetPermissionStateCompletedHandler::create(Box::new(move |hr| {
                if let Some(report) = answered.borrow_mut().record(hr.is_ok()) {
                    finish(&done_reply, Ok(report));
                }
                Ok(())
            }));
            // SAFETY: on the UI thread; the origin string outlives the call.
            let issued = unsafe {
                profile.SetPermissionState(
                    kind,
                    &HSTRING::from(origin),
                    COREWEBVIEW2_PERMISSION_STATE_DEFAULT,
                    &handler,
                )
            };
            if issued.is_err() {
                if let Some(report) = tally.borrow_mut().record(false) {
                    finish(&reply, Ok(report));
                }
            }
        }
    }
}

#[cfg(windows)]
pub(crate) use windows_impl::clear_saved_grants;

#[cfg(test)]
#[path = "browser_tab_saved_grants_tests.rs"]
mod tests;
