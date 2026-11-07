//! The agent tab's `WKUIDelegate`: it answers the page's JavaScript
//! panels (alert, confirm, prompt) by holding them for the core, answers
//! file panels with the files an upload staged (cancelling any other), and
//! forwards every other delegate call to the delegate wry installed (new
//! windows, media permissions). WKWebView has no public `beforeunload`
//! panel, so pages unload without asking.
//!
//! `UIDelegate` is a weak property: the webview keeps this proxy alive
//! through an associated object, and the proxy keeps wry's delegate.

use std::ffi::c_void;
use std::ptr;

use block2::DynBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, NSObject, NSObjectProtocol, ProtocolObject, Sel};
use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_foundation::{NSArray, NSString, NSURL};
use objc2_web_kit::{WKFrameInfo, WKOpenPanelParameters, WKUIDelegate, WKWebView};

use crate::browser_automation::engine::dialogs::{self, HeldDialog};
use crate::browser_automation::engine::file_chooser;
use crate::browser_automation::engine::events::{DialogAnswer, DialogKind, TabEvents};

pub struct Ivars {
    inner: Retained<ProtocolObject<dyn WKUIDelegate>>,
    events: TabEvents,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = Ivars]
    pub struct AgentUiDelegate;

    impl AgentUiDelegate {
        #[unsafe(method(respondsToSelector:))]
        fn responds_to_selector(&self, selector: Sel) -> bool {
            // SAFETY: NSObject implements respondsToSelector:.
            let own: bool = unsafe { msg_send![super(self), respondsToSelector: selector] };
            own || self.ivars().inner.respondsToSelector(selector)
        }

        #[unsafe(method(forwardingTargetForSelector:))]
        fn forwarding_target_for_selector(&self, _selector: Sel) -> *mut AnyObject {
            Retained::as_ptr(&self.ivars().inner).cast_mut().cast()
        }
    }

    unsafe impl NSObjectProtocol for AgentUiDelegate {}

    unsafe impl WKUIDelegate for AgentUiDelegate {
        #[unsafe(method(webView:runJavaScriptAlertPanelWithMessage:initiatedByFrame:completionHandler:))]
        fn alert_panel(
            &self,
            _webview: &WKWebView,
            message: &NSString,
            _frame: &WKFrameInfo,
            completion: &DynBlock<dyn Fn()>,
        ) {
            let completion = completion.copy();
            self.hold(DialogKind::Alert, message, None, move |_| completion.call(()));
        }

        #[unsafe(method(webView:runJavaScriptConfirmPanelWithMessage:initiatedByFrame:completionHandler:))]
        fn confirm_panel(
            &self,
            _webview: &WKWebView,
            message: &NSString,
            _frame: &WKFrameInfo,
            completion: &DynBlock<dyn Fn(Bool)>,
        ) {
            let completion = completion.copy();
            self.hold(DialogKind::Confirm, message, None, move |answer| {
                let accepted = matches!(answer, DialogAnswer::Accept { .. });
                completion.call((Bool::new(accepted),));
            });
        }

        #[unsafe(method(webView:runJavaScriptTextInputPanelWithPrompt:defaultText:initiatedByFrame:completionHandler:))]
        fn text_input_panel(
            &self,
            _webview: &WKWebView,
            prompt: &NSString,
            default_text: Option<&NSString>,
            _frame: &WKFrameInfo,
            completion: &DynBlock<dyn Fn(*mut NSString)>,
        ) {
            let completion = completion.copy();
            self.hold(DialogKind::Prompt, prompt, Some(default_text), move |answer| match answer {
                DialogAnswer::Accept { text } => {
                    let text = NSString::from_str(text.as_deref().unwrap_or_default());
                    completion.call((Retained::as_ptr(&text).cast_mut(),));
                }
                DialogAnswer::Dismiss => completion.call((ptr::null_mut(),)),
            });
        }

        #[unsafe(method(webView:runOpenPanelWithParameters:initiatedByFrame:completionHandler:))]
        fn open_panel(
            &self,
            _webview: &WKWebView,
            _parameters: &WKOpenPanelParameters,
            frame: &WKFrameInfo,
            completion: &DynBlock<dyn Fn(*mut NSArray<NSURL>)>,
        ) {
            // Uploads open the main frame's chooser; a subframe's never
            // takes their files.
            // SAFETY: main thread; the frame info is WebKit's own.
            let staged = unsafe { frame.isMainFrame() }
                .then(|| file_chooser::answer(self.ivars().events.label()))
                .flatten();
            let Some(files) = staged else {
                log::info!("[browser-tab] page file chooser cancelled on an agent tab");
                completion.call((ptr::null_mut(),));
                return;
            };
            let urls: Vec<Retained<NSURL>> = files
                .iter()
                .map(|file| NSURL::fileURLWithPath(&NSString::from_str(&file.to_string_lossy())))
                .collect();
            let urls = NSArray::from_retained_slice(&urls);
            completion.call((Retained::as_ptr(&urls).cast_mut(),));
        }
    }
);

impl AgentUiDelegate {
    fn hold(
        &self,
        kind: DialogKind,
        message: &NSString,
        default_text: Option<Option<&NSString>>,
        complete: impl FnOnce(&DialogAnswer) + 'static,
    ) {
        let events = &self.ivars().events;
        let default_text =
            default_text.map(|text| text.map(NSString::to_string).unwrap_or_default());
        let id = events.dialog_opened(kind, message.to_string(), default_text);
        dialogs::hold(events.label(), id, HeldDialog::new(complete));
    }
}

/// The associated-object key: the address of this static.
static PROXY_KEY: u8 = 0;

/// Put the proxy in front of wry's delegate. False when the webview has
/// no delegate to forward to.
pub fn install(webview: &WKWebView, events: TabEvents, mtm: MainThreadMarker) -> bool {
    // SAFETY: main thread; the getter returns the delegate wry set.
    let Some(inner) = (unsafe { webview.UIDelegate() }) else {
        return false;
    };
    let proxy = mtm
        .alloc::<AgentUiDelegate>()
        .set_ivars(Ivars { inner, events });
    // SAFETY: NSObject's designated initializer.
    let proxy: Retained<AgentUiDelegate> = unsafe { msg_send![super(proxy), init] };
    // Agent input on this engine is page-script events, which the popup
    // blocker refuses; every popup still meets the host's popup policy.
    // SAFETY: main thread; the preferences object is the webview's own.
    unsafe {
        webview
            .configuration()
            .preferences()
            .setJavaScriptCanOpenWindowsAutomatically(true);
    }
    // SAFETY: main thread; the associated object retains the proxy for
    // the webview's life, which outlasts the weak delegate reference.
    unsafe {
        objc2::ffi::objc_setAssociatedObject(
            ptr::from_ref(webview).cast_mut().cast(),
            ptr::from_ref(&PROXY_KEY).cast::<c_void>(),
            Retained::as_ptr(&proxy).cast_mut().cast(),
            objc2::ffi::OBJC_ASSOCIATION_RETAIN_NONATOMIC,
        );
        webview.setUIDelegate(Some(ProtocolObject::from_ref(&*proxy)));
    }
    true
}
