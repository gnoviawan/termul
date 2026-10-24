//! WKWebView downloads on tabs whose downloads the host holds. Tauri's
//! hook decides where a download lands and reports how it ended, but
//! reports no progress. This navigation-delegate proxy takes each download
//! as it starts, forwards it to wry's delegate, and reads its progress on a
//! timer, so the host's size cap, idle timeout and deadline cancel it while
//! it streams. Every other delegate call goes to wry's delegate.
//!
//! `navigationDelegate` is a weak property: the webview keeps this proxy
//! alive through an associated object, and the proxy keeps wry's delegate.

use std::ffi::c_void;
use std::ptr::{self, NonNull};
use std::time::Instant;

use block2::{Block, RcBlock};
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, NSObject, NSObjectProtocol, Sel};
use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_foundation::{NSString, NSURL};
use objc2_web_kit::WKWebView;
use tauri::Url;

use crate::browser_automation::budgets;
use crate::browser_automation::engine::events::{DownloadSize, TabEvents};

/// Seconds between progress checks of a download in progress.
const TICK: f64 = 1.0;

pub struct Ivars {
    inner: Retained<AnyObject>,
    events: TabEvents,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = Ivars]
    pub struct AgentNavigationDelegate;

    impl AgentNavigationDelegate {
        #[unsafe(method(respondsToSelector:))]
        fn responds_to_selector(&self, selector: Sel) -> bool {
            // SAFETY: NSObject and wry's delegate implement respondsToSelector:.
            let own: bool = unsafe { msg_send![super(self), respondsToSelector: selector] };
            own || unsafe { msg_send![&*self.ivars().inner, respondsToSelector: selector] }
        }

        #[unsafe(method(forwardingTargetForSelector:))]
        fn forwarding_target_for_selector(&self, _selector: Sel) -> *mut AnyObject {
            Retained::as_ptr(&self.ivars().inner).cast_mut()
        }

        #[unsafe(method(webView:navigationAction:didBecomeDownload:))]
        fn action_download(&self, webview: &AnyObject, action: &AnyObject, download: &AnyObject) {
            // SAFETY: main thread; wry's delegate implements this method
            // with these WebKit objects.
            let _: () = unsafe {
                msg_send![&*self.ivars().inner, webView: webview, navigationAction: action, didBecomeDownload: download]
            };
            self.watch(download);
        }

        #[unsafe(method(webView:navigationResponse:didBecomeDownload:))]
        fn response_download(&self, webview: &AnyObject, response: &AnyObject, download: &AnyObject) {
            // SAFETY: as above.
            let _: () = unsafe {
                msg_send![&*self.ivars().inner, webView: webview, navigationResponse: response, didBecomeDownload: download]
            };
            self.watch(download);
        }
    }

    unsafe impl NSObjectProtocol for AgentNavigationDelegate {}
);

/// The URL tauri's hook reports for `download`: its original request's.
fn download_url(download: &AnyObject) -> Option<Url> {
    // SAFETY: main thread; WKDownload, NSURLRequest and NSURL answer these.
    let text: Option<Retained<NSString>> = unsafe {
        let request: Option<Retained<AnyObject>> = msg_send![download, originalRequest];
        let url: Option<Retained<NSURL>> = msg_send![&*request?, URL];
        msg_send![&*url?, absoluteString]
    };
    text?.to_string().parse().ok()
}

impl AgentNavigationDelegate {
    /// Report `download`'s size to the host every tick until it ends, and
    /// cancel it when the host says so.
    fn watch(&self, download: &AnyObject) {
        let Some(url) = download_url(download) else {
            return;
        };
        let Some(timer_class) = AnyClass::get(c"NSTimer") else {
            return;
        };
        // SAFETY: a live WKDownload WebKit just handed over.
        let Some(download) = (unsafe { Retained::retain(ptr::from_ref(download).cast_mut()) }) else {
            return;
        };
        let events = self.ivars().events.clone();
        let started = Instant::now();
        let tick = RcBlock::new(move |timer: NonNull<AnyObject>| {
            // SAFETY: main thread; the timer is the one running this block.
            let stop = || unsafe {
                let _: () = msg_send![timer.as_ref(), invalidate];
            };
            // SAFETY: main thread; WKDownload's progress is an NSProgress.
            let progress: Option<Retained<AnyObject>> = unsafe { msg_send![&*download, progress] };
            let Some(progress) = progress else {
                return stop();
            };
            // SAFETY: as above.
            let (finished, cancelled, done, total): (bool, bool, i64, i64) = unsafe {
                (
                    msg_send![&*progress, isFinished],
                    msg_send![&*progress, isCancelled],
                    msg_send![&*progress, completedUnitCount],
                    msg_send![&*progress, totalUnitCount],
                )
            };
            // A download the host never held reports no end: the deadline
            // bounds the watch.
            if finished || cancelled || started.elapsed() > budgets::DOWNLOAD_TOTAL {
                return stop();
            }
            let size = DownloadSize {
                received: done.max(0).unsigned_abs(),
                announced: u64::try_from(total).ok(),
            };
            if events.download_progress(&url, size) {
                return;
            }
            stop();
            let no_resume: Option<&Block<dyn Fn(*mut AnyObject)>> = None;
            // SAFETY: main thread; `cancel:` takes a nullable handler.
            let _: () = unsafe { msg_send![&*download, cancel: no_resume] };
            events.download_finished(&url, false);
        });
        // SAFETY: main thread; the run loop retains the scheduled timer.
        let _: Option<Retained<AnyObject>> = unsafe {
            msg_send![timer_class, scheduledTimerWithTimeInterval: TICK, repeats: true, block: &*tick]
        };
    }
}

/// The associated-object key: the address of this static.
static PROXY_KEY: u8 = 0;

/// Put the proxy in front of wry's navigation delegate. False when the
/// webview has none to forward to.
pub fn install(webview: &WKWebView, events: TabEvents, mtm: MainThreadMarker) -> bool {
    // SAFETY: main thread; the getter returns the delegate wry set.
    let inner: Option<Retained<AnyObject>> = unsafe { msg_send![webview, navigationDelegate] };
    let Some(inner) = inner else {
        return false;
    };
    let proxy = mtm.alloc::<AgentNavigationDelegate>().set_ivars(Ivars { inner, events });
    // SAFETY: NSObject's designated initializer.
    let proxy: Retained<AgentNavigationDelegate> = unsafe { msg_send![super(proxy), init] };
    // SAFETY: main thread; the associated object retains the proxy for
    // the webview's life, which outlasts the weak delegate reference.
    unsafe {
        objc2::ffi::objc_setAssociatedObject(
            ptr::from_ref(webview).cast_mut().cast(),
            ptr::from_ref(&PROXY_KEY).cast::<c_void>(),
            Retained::as_ptr(&proxy).cast_mut().cast(),
            objc2::ffi::OBJC_ASSOCIATION_RETAIN_NONATOMIC,
        );
        let _: () = msg_send![webview, setNavigationDelegate: &*proxy];
    }
    true
}
