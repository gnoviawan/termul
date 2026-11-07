//! WKWebView trusted input (AppKit), public API only.
//!
//! - Clicks call `mouseDown:`/`mouseUp:` on the WKWebView itself. Routing
//!   them through `-[NSWindow sendEvent:]` would make the tab first
//!   responder and blur the chat.
//! - The wheel goes to `scrollWheel:` as a CGEvent-built NSEvent. That
//!   event has no window, so WebKit reads its location as window
//!   coordinates, and the point is encoded that way.
//! - An element taking focus in the tab, by click or by script, makes
//!   the tab first responder and blurs the chat. Text entry needs a
//!   focused element, and a plain `keyDown:` types into the chat, so keys
//!   stay synthetic and the core sends no trusted click that would focus
//!   an element.
//! - Hover needs private API since WebKit dropped `mouseMoved:`, and a
//!   held button reads as `buttons: 0`, so pointer moves and drags stay
//!   synthetic.

use std::ffi::c_void;
use std::sync::Arc;
use std::time::Duration;

use objc2::encode::{Encode, Encoding};
use objc2::rc::autoreleasepool;
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use tokio::sync::oneshot;

use super::super::input::NativeInput;
use super::super::{CapabilityId, EngineError, EngineErrorKind, EngineFuture, Point, Support};
use crate::browser_automation::budgets::NATIVE_INPUT;
use crate::browser_tab_manager::BrowserTabManager;

const TIERS: &[(CapabilityId, Support)] = &[
    (CapabilityId::PointerClick, Support::Trusted),
    (CapabilityId::TrustedKey, Support::Synthetic),
    (CapabilityId::PointerMove, Support::Synthetic),
    (CapabilityId::Wheel, Support::Trusted),
    (CapabilityId::Drag, Support::Synthetic),
];

const LEFT_MOUSE_DOWN: usize = 1;
const LEFT_MOUSE_UP: usize = 2;
const SCROLL_UNIT_PIXEL: u32 = 0;
/// Largest scroll a single wheel event carries, in px.
const WHEEL_CHUNK: f64 = 100.0;

#[repr(C)]
#[derive(Debug, Clone, Copy)]
struct CGPoint {
    x: f64,
    y: f64,
}

// SAFETY: matches the C layout and the runtime's type encoding.
unsafe impl Encode for CGPoint {
    const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
struct CGSize {
    width: f64,
    height: f64,
}

// SAFETY: as above.
unsafe impl Encode for CGSize {
    const ENCODING: Encoding = Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

// SAFETY: as above.
unsafe impl Encode for CGRect {
    const ENCODING: Encoding = Encoding::Struct("CGRect", &[CGPoint::ENCODING, CGSize::ENCODING]);
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventCreateScrollWheelEvent2(
        source: *const c_void,
        units: u32,
        wheel_count: u32,
        wheel1: i32,
        wheel2: i32,
        wheel3: i32,
    ) -> *mut c_void;
    fn CGEventSetLocation(event: *mut c_void, location: CGPoint);
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: *const c_void);
}

/// Between a click's press and release. WebKit drops the click when both
/// arrive in one run-loop turn.
const CLICK_HOLD: Duration = Duration::from_millis(80);

#[derive(Debug, Clone)]
enum Op {
    Button { at: Point, down: bool },
    Wheel { at: Point, dx: f64, dy: f64 },
}

pub struct AppKitInput {
    tabs: Arc<BrowserTabManager>,
}

impl AppKitInput {
    pub fn new(tabs: Arc<BrowserTabManager>) -> Self {
        Self { tabs }
    }

    fn run<'a>(&'a self, tab: &'a str, op: Op) -> EngineFuture<'a, ()> {
        Box::pin(async move {
            let webview = self
                .tabs
                .webview(tab)
                .map_err(|_| EngineError::new(EngineErrorKind::TabNotFound))?;
            let (tx, rx) = oneshot::channel::<Result<(), EngineErrorKind>>();
            webview
                .with_webview(move |platform| {
                    let wk = platform.inner().cast::<AnyObject>();
                    // SAFETY: main thread (inside `with_webview`), and `wk`
                    // is the live WKWebView of this tab.
                    let result = autoreleasepool(|_| unsafe { perform(wk, &op) });
                    let _ = tx.send(result);
                })
                .map_err(|_| EngineError::new(EngineErrorKind::Dispatch))?;
            match tokio::time::timeout(NATIVE_INPUT, rx).await {
                Ok(Ok(Ok(()))) => Ok(()),
                Ok(Ok(Err(kind))) => Err(EngineError::new(kind)),
                Ok(Err(_)) => Err(EngineError::new(EngineErrorKind::NoReply)),
                Err(_) => Err(EngineError::new(EngineErrorKind::Timeout)),
            }
        })
    }
}

/// # Safety
/// Main thread; `wk` is a live WKWebView.
unsafe fn perform(wk: *mut AnyObject, op: &Op) -> Result<(), EngineErrorKind> {
    if wk.is_null() {
        return Err(EngineErrorKind::TabNotFound);
    }
    let window: *mut AnyObject = msg_send![wk, window];
    if window.is_null() {
        return Err(EngineErrorKind::Dispatch);
    }
    match op {
        Op::Button { at, down } => {
            let p = window_point(wk, window, *at);
            let number: isize = msg_send![window, windowNumber];
            let (kind, pressure) = if *down { (LEFT_MOUSE_DOWN, 1.0) } else { (LEFT_MOUSE_UP, 0.0) };
            let event = mouse_event(kind, p, number, pressure);
            if event.is_null() {
                return Err(EngineErrorKind::Dispatch);
            }
            if *down {
                let _: () = msg_send![wk, mouseDown: event];
            } else {
                let _: () = msg_send![wk, mouseUp: event];
            }
        }
        Op::Wheel { at, dx, dy } => {
            let p = window_point(wk, window, *at);
            let screens: *mut AnyObject = msg_send![class!(NSScreen), screens];
            let main: *mut AnyObject = msg_send![screens, firstObject];
            if main.is_null() {
                return Err(EngineErrorKind::Dispatch);
            }
            let frame: CGRect = msg_send![main, frame];
            let chunks = (dx.abs().max(dy.abs()) / WHEEL_CHUNK).ceil().max(1.0);
            for _ in 0..chunks as u32 {
                let event = CGEventCreateScrollWheelEvent2(
                    std::ptr::null(),
                    SCROLL_UNIT_PIXEL,
                    2,
                    (-dy / chunks).round() as i32,
                    (-dx / chunks).round() as i32,
                    0,
                );
                if event.is_null() {
                    return Err(EngineErrorKind::Dispatch);
                }
                CGEventSetLocation(
                    event,
                    CGPoint {
                        x: p.x,
                        y: frame.size.height - p.y,
                    },
                );
                let ns: *mut AnyObject = msg_send![class!(NSEvent), eventWithCGEvent: event];
                CFRelease(event);
                if ns.is_null() {
                    return Err(EngineErrorKind::Dispatch);
                }
                let _: () = msg_send![wk, scrollWheel: ns];
            }
        }
    }
    Ok(())
}

/// A point in the view's CSS px, in window coordinates.
///
/// WebKit insets the page by the part of the view under the titlebar
/// (above the window's content layout rect), so CSS y = 0 sits that far
/// below the view's top.
///
/// # Safety
/// Main thread; `wk` is a live view in `window`.
unsafe fn window_point(wk: *mut AnyObject, window: *mut AnyObject, at: Point) -> CGPoint {
    let flipped: bool = msg_send![wk, isFlipped];
    let bounds: CGRect = msg_send![wk, bounds];
    let in_window: CGRect = msg_send![wk, convertRect: bounds, toView: std::ptr::null_mut::<AnyObject>()];
    let layout: CGRect = msg_send![window, contentLayoutRect];
    let top_inset = ((in_window.origin.y + in_window.size.height) - (layout.origin.y + layout.size.height)).max(0.0);
    let from_top = at.y + top_inset;
    let local = CGPoint {
        x: at.x,
        y: if flipped { from_top } else { bounds.size.height - from_top },
    };
    msg_send![wk, convertPoint: local, toView: std::ptr::null_mut::<AnyObject>()]
}

/// # Safety
/// Main thread.
unsafe fn mouse_event(kind: usize, location: CGPoint, window_number: isize, pressure: f32) -> *mut AnyObject {
    let info: *mut AnyObject = msg_send![class!(NSProcessInfo), processInfo];
    let uptime: f64 = msg_send![info, systemUptime];
    msg_send![
        class!(NSEvent),
        mouseEventWithType: kind,
        location: location,
        modifierFlags: 0usize,
        timestamp: uptime,
        windowNumber: window_number,
        context: std::ptr::null_mut::<AnyObject>(),
        eventNumber: 0isize,
        clickCount: 1isize,
        pressure: pressure
    ]
}

impl NativeInput for AppKitInput {
    fn tiers(&self) -> &'static [(CapabilityId, Support)] {
        TIERS
    }

    fn element_focus_moves_tab_focus(&self) -> bool {
        true
    }

    fn click<'a>(&'a self, tab: &'a str, at: Point) -> EngineFuture<'a, ()> {
        Box::pin(async move {
            self.run(tab, Op::Button { at, down: true }).await?;
            tokio::time::sleep(CLICK_HOLD).await;
            self.run(tab, Op::Button { at, down: false }).await
        })
    }

    fn wheel<'a>(&'a self, tab: &'a str, at: Point, dx: f64, dy: f64) -> EngineFuture<'a, ()> {
        self.run(tab, Op::Wheel { at, dx, dy })
    }
}
