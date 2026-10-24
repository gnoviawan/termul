//! WKWebView downloads on tabs whose downloads the host holds. Tauri's
//! hook decides where a download lands, but reports no progress and names
//! a finished download only by its URL, which two downloads can share.
//! This navigation-delegate proxy takes each download as it starts,
//! forwards it to wry's delegate, and puts a download-delegate proxy in
//! front of the one wry gave it. That proxy learns the path the host
//! chose, reads the download's progress on a timer, so the host's size
//! cap, idle timeout and deadline cancel it while it streams, and reports
//! how it ended under that path. Every other delegate call goes to wry's
//! delegates.
//!
//! Both delegate properties are weak: the webview keeps the navigation
//! proxy alive and each download its own proxy, through associated
//! objects, and each proxy keeps wry's delegate.

use std::cell::{Cell, RefCell};
use std::ffi::c_void;
use std::path::PathBuf;
use std::ptr::{self, NonNull};
use std::rc::Rc;
use std::time::Instant;

use block2::{Block, RcBlock};
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, NSObject, NSObjectProtocol, Sel};
use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_foundation::NSURL;
use objc2_web_kit::WKWebView;

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
            self.take_over(download);
        }

        #[unsafe(method(webView:navigationResponse:didBecomeDownload:))]
        fn response_download(&self, webview: &AnyObject, response: &AnyObject, download: &AnyObject) {
            // SAFETY: as above.
            let _: () = unsafe {
                msg_send![&*self.ivars().inner, webView: webview, navigationResponse: response, didBecomeDownload: download]
            };
            self.take_over(download);
        }
    }

    unsafe impl NSObjectProtocol for AgentNavigationDelegate {}
);

pub struct DownloadIvars {
    inner: Retained<AnyObject>,
    events: TabEvents,
    /// The host's path for the download, once wry's delegate chose it.
    path: Rc<RefCell<Option<PathBuf>>>,
    /// Set once the download finished or failed, so the progress timer
    /// stops whether or not WebKit marks the progress done.
    ended: Rc<Cell<bool>>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = DownloadIvars]
    pub struct AgentDownloadDelegate;

    impl AgentDownloadDelegate {
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

        #[unsafe(method(download:decideDestinationUsingResponse:suggestedFilename:completionHandler:))]
        fn decide_destination(
            &self,
            download: &AnyObject,
            response: &AnyObject,
            suggested: &AnyObject,
            handler: &Block<dyn Fn(*const NSURL)>,
        ) {
            let handler = handler.copy();
            let chosen = self.ivars().path.clone();
            let events = self.ivars().events.clone();
            let ended = self.ivars().ended.clone();
            // SAFETY: a live WKDownload WebKit handed to its delegate.
            let watched = unsafe { Retained::retain(ptr::from_ref(download).cast_mut()) };
            let answer: RcBlock<dyn Fn(*const NSURL)> = RcBlock::new(move |url: *const NSURL| {
                // SAFETY: wry answers with null or a file URL that lives
                // through this call.
                let path = unsafe { url.as_ref() }
                    .and_then(NSURL::path)
                    .map(|p| PathBuf::from(p.to_string()));
                if let (Some(path), Some(watched)) = (path, watched.as_deref()) {
                    *chosen.borrow_mut() = Some(path.clone());
                    watch(watched, path, events.clone(), ended.clone());
                }
                handler.call((url,));
            });
            // SAFETY: main thread; wry's delegate implements this method
            // with these WebKit objects and a handler of this type.
            let _: () = unsafe {
                msg_send![
                    &*self.ivars().inner,
                    download: download,
                    decideDestinationUsingResponse: response,
                    suggestedFilename: suggested,
                    completionHandler: &*answer
                ]
            };
        }

        #[unsafe(method(downloadDidFinish:))]
        fn did_finish(&self, download: &AnyObject) {
            // SAFETY: as above.
            let _: () = unsafe { msg_send![&*self.ivars().inner, downloadDidFinish: download] };
            self.ended(true);
        }

        #[unsafe(method(download:didFailWithError:resumeData:))]
        fn did_fail(&self, download: &AnyObject, error: &AnyObject, resume: *mut AnyObject) {
            // SAFETY: as above; the nullable resume data goes on as WebKit
            // gave it.
            let _: () = unsafe {
                msg_send![&*self.ivars().inner, download: download, didFailWithError: error, resumeData: resume]
            };
            self.ended(false);
        }
    }

    unsafe impl NSObjectProtocol for AgentDownloadDelegate {}
);

impl AgentDownloadDelegate {
    fn ended(&self, success: bool) {
        self.ivars().ended.set(true);
        if let Some(path) = self.ivars().path.borrow().as_deref() {
            self.ivars().events.download_finished(path, success);
        }
    }
}

/// The associated-object key of each download's proxy: the address of
/// this static.
static DOWNLOAD_PROXY_KEY: u8 = 0;

impl AgentNavigationDelegate {
    /// Put a download-delegate proxy in front of the delegate wry just gave
    /// `download`.
    fn take_over(&self, download: &AnyObject) {
        // SAFETY: main thread; the getter returns the delegate wry set.
        let inner: Option<Retained<AnyObject>> = unsafe { msg_send![download, delegate] };
        let (Some(inner), Some(mtm)) = (inner, MainThreadMarker::new()) else {
            return;
        };
        let proxy = mtm.alloc::<AgentDownloadDelegate>().set_ivars(DownloadIvars {
            inner,
            events: self.ivars().events.clone(),
            path: Rc::default(),
            ended: Rc::default(),
        });
        // SAFETY: NSObject's designated initializer.
        let proxy: Retained<AgentDownloadDelegate> = unsafe { msg_send![super(proxy), init] };
        // SAFETY: main thread; the associated object retains the proxy for
        // the download's life, which outlasts the weak delegate reference.
        unsafe {
            objc2::ffi::objc_setAssociatedObject(
                ptr::from_ref(download).cast_mut().cast(),
                ptr::from_ref(&DOWNLOAD_PROXY_KEY).cast::<c_void>(),
                Retained::as_ptr(&proxy).cast_mut().cast(),
                objc2::ffi::OBJC_ASSOCIATION_RETAIN_NONATOMIC,
            );
            let _: () = msg_send![download, setDelegate: &*proxy];
        }
    }
}

/// Report `download`'s size to the host every tick until it ends, and
/// cancel it when the host says so.
fn watch(download: &AnyObject, path: PathBuf, events: TabEvents, ended: Rc<Cell<bool>>) {
    let Some(timer_class) = AnyClass::get(c"NSTimer") else {
        return;
    };
    // SAFETY: a live WKDownload.
    let Some(download) = (unsafe { Retained::retain(ptr::from_ref(download).cast_mut()) }) else {
        return;
    };
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
        if ended.get() || finished || cancelled || started.elapsed() > budgets::DOWNLOAD_TOTAL {
            return stop();
        }
        let size = DownloadSize {
            received: done.max(0).unsigned_abs(),
            announced: u64::try_from(total).ok(),
        };
        if events.download_progress(&path, size) {
            return;
        }
        stop();
        let no_resume: Option<&Block<dyn Fn(*mut AnyObject)>> = None;
        // SAFETY: main thread; `cancel:` takes a nullable handler.
        let _: () = unsafe { msg_send![&*download, cancel: no_resume] };
        // WebKit does not document whether a cancel also reaches the
        // delegate's failure; the host ignores a second report of one end.
        events.download_finished(&path, false);
    });
    // SAFETY: main thread; the run loop retains the scheduled timer.
    let _: Option<Retained<AnyObject>> = unsafe {
        msg_send![timer_class, scheduledTimerWithTimeInterval: TICK, repeats: true, block: &*tick]
    };
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
