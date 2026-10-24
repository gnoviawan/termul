//! WebKitGTK trusted input (GTK3): GdkEvents built here and delivered to
//! the agent tab's WebKitWebView.
//!
//! - Pointer events go through `gtk_main_do_event` while the tab widget
//!   is non-focusable. A button press asks for GTK focus asynchronously,
//!   so the lock is held past the action, then released.
//! - Key events go to the tab widget with `gtk_widget_event`.
//!   `gtk_main_do_event` would route them to the toplevel's focus widget,
//!   which is the chat.
//!
//! HTML5 drag and drop needs a real pointer grab and is not delivered;
//! `drag` covers mouse-event drags only.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use gtk::ffi as gtk_sys;
use gtk::gdk::ffi as gdk_sys;
use gtk::glib;
use gtk::glib::translate::ToGlibPtr;
use gtk::prelude::*;
use tokio::sync::oneshot;

use super::eval;
use super::super::input::NativeInput;
use super::super::string_eval;
use super::super::{
    CapabilityId, EngineError, EngineErrorKind, EngineFuture, Key, KeyInput, NamedKey, Point,
    Support,
};
use crate::browser_automation::budgets::NATIVE_INPUT;
use crate::browser_tab_manager::BrowserTabManager;

const TIERS: &[(CapabilityId, Support)] = &[
    (CapabilityId::PointerClick, Support::Trusted),
    (CapabilityId::TrustedKey, Support::Trusted),
    (CapabilityId::PointerMove, Support::Trusted),
    (CapabilityId::Wheel, Support::Trusted),
    (CapabilityId::Drag, Support::Trusted),
];

/// How long the tab stays non-focusable after a pointer action, so the
/// press's deferred focus request finds it locked.
const FOCUS_LOCK_HOLD: Duration = Duration::from_millis(600);
const DRAG_STEPS: u32 = 6;
/// CSS px per unit of a smooth scroll delta in WebKitGTK.
const PX_PER_SCROLL_UNIT: f64 = 40.0;

#[derive(Debug, Clone, Copy)]
enum Step {
    Button { at: Point, press: bool },
    Motion { at: Point, held: bool },
    Scroll { at: Point, dx: f64, dy: f64 },
    Key { keyval: u32, text: Option<char>, press: bool },
}

impl Step {
    fn is_key(self) -> bool {
        matches!(self, Step::Key { .. })
    }
}

fn named_keyval(key: NamedKey) -> (u32, Option<char>) {
    match key {
        NamedKey::Enter => (0xff0d, Some('\r')),
        NamedKey::Tab => (0xff09, Some('\t')),
        NamedKey::Escape => (0xff1b, Some('\u{1b}')),
        NamedKey::Backspace => (0xff08, Some('\u{8}')),
        NamedKey::Delete => (0xffff, Some('\u{7f}')),
        NamedKey::ArrowLeft => (0xff51, None),
        NamedKey::ArrowUp => (0xff52, None),
        NamedKey::ArrowRight => (0xff53, None),
        NamedKey::ArrowDown => (0xff54, None),
        NamedKey::Home => (0xff50, None),
        NamedKey::End => (0xff57, None),
        NamedKey::PageUp => (0xff55, None),
        NamedKey::PageDown => (0xff56, None),
        NamedKey::Space => (0x20, Some(' ')),
    }
}

fn char_keyval(c: char) -> (u32, Option<char>) {
    match c {
        '\n' | '\r' => named_keyval(NamedKey::Enter),
        '\t' => named_keyval(NamedKey::Tab),
        // SAFETY: a pure table lookup.
        _ => (unsafe { gdk_sys::gdk_unicode_to_keyval(c as u32) }, Some(c)),
    }
}

fn key_steps(input: KeyInput<'_>) -> Vec<Step> {
    let keys: Vec<(u32, Option<char>)> = match input {
        KeyInput::Text(text) => text.chars().map(char_keyval).collect(),
        KeyInput::Press(Key::Named(k)) => vec![named_keyval(k)],
        KeyInput::Press(Key::Char(c)) => vec![char_keyval(c)],
    };
    keys.into_iter()
        .flat_map(|(keyval, text)| {
            [true, false].map(|press| Step::Key { keyval, text, press })
        })
        .collect()
}

fn lerp(from: Point, to: Point, t: f64) -> Point {
    Point {
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
    }
}

pub struct GdkInput {
    tabs: Arc<BrowserTabManager>,
    /// Bumped per pointer action; a lock release only runs when no later
    /// action took the lock again.
    lock_epoch: Arc<AtomicU64>,
}

impl GdkInput {
    pub fn new(tabs: Arc<BrowserTabManager>) -> Self {
        Self {
            tabs,
            lock_epoch: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Dispatch `steps` to the tab's widget in one UI-thread turn.
    fn run<'a>(&'a self, tab: &'a str, steps: Vec<Step>) -> EngineFuture<'a, ()> {
        Box::pin(async move {
            let webview = self
                .tabs
                .webview(tab)
                .map_err(|_| EngineError::new(EngineErrorKind::TabNotFound))?;
            let (tx, rx) = oneshot::channel::<Result<(), EngineErrorKind>>();
            let lock_epoch = self.lock_epoch.clone();
            webview
                .with_webview(move |platform| {
                    let widget = platform.inner().upcast::<gtk::Widget>();
                    let _ = tx.send(dispatch(&widget, &steps, &lock_epoch));
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

/// Runs on the GTK main thread.
fn dispatch(widget: &gtk::Widget, steps: &[Step], lock_epoch: &Arc<AtomicU64>) -> Result<(), EngineErrorKind> {
    let pointer = steps.iter().any(|s| !s.is_key());
    // SAFETY: GTK main thread (inside `with_webview`); `widget` is alive
    // for the whole call, and every event is freed after dispatch.
    unsafe {
        let display = gdk_sys::gdk_display_get_default();
        if display.is_null() {
            return Err(EngineErrorKind::Dispatch);
        }
        let seat = gdk_sys::gdk_display_get_default_seat(display);
        if seat.is_null() {
            return Err(EngineErrorKind::Dispatch);
        }
        let b: *mut gtk_sys::GtkWidget = widget.to_glib_none().0;
        if gtk_sys::gtk_widget_get_window(b).is_null() {
            return Err(EngineErrorKind::Dispatch);
        }
        if pointer {
            gtk_sys::gtk_widget_set_can_focus(b, glib::ffi::GFALSE);
        }
        for &step in steps {
            let device = if step.is_key() {
                gdk_sys::gdk_seat_get_keyboard(seat)
            } else {
                gdk_sys::gdk_seat_get_pointer(seat)
            };
            if device.is_null() {
                release_lock_later(widget, lock_epoch);
                return Err(EngineErrorKind::Dispatch);
            }
            let ev = build(b, display, step);
            gdk_sys::gdk_event_set_device(ev, device);
            gdk_sys::gdk_event_set_source_device(ev, device);
            if step.is_key() {
                gtk_sys::gtk_widget_event(b, ev);
            } else {
                gtk_sys::gtk_main_do_event(ev);
            }
            gdk_sys::gdk_event_free(ev);
        }
    }
    if pointer {
        release_lock_later(widget, lock_epoch);
    }
    Ok(())
}

fn release_lock_later(widget: &gtk::Widget, lock_epoch: &Arc<AtomicU64>) {
    let mine = lock_epoch.fetch_add(1, Ordering::SeqCst) + 1;
    let lock_epoch = lock_epoch.clone();
    let widget = widget.clone();
    let _ = glib::timeout_add_local_once(FOCUS_LOCK_HOLD, move || {
        if lock_epoch.load(Ordering::SeqCst) == mine {
            widget.set_can_focus(true);
        }
    });
}

/// Event window plus window-relative and root coordinates for a point in
/// the widget's CSS px.
///
/// # Safety
/// GTK main thread, realized widget. The returned window carries a new
/// reference that `gdk_event_free` drops.
unsafe fn coords(b: *mut gtk_sys::GtkWidget, at: Point) -> (*mut gdk_sys::GdkWindow, f64, f64, f64, f64) {
    let win = gtk_sys::gtk_widget_get_window(b);
    let (mut wx, mut wy) = (at.x, at.y);
    if gtk_sys::gtk_widget_get_has_window(b) == glib::ffi::GFALSE {
        let mut alloc: gtk_sys::GtkAllocation = std::mem::zeroed();
        gtk_sys::gtk_widget_get_allocation(b, &mut alloc);
        wx += f64::from(alloc.x);
        wy += f64::from(alloc.y);
    }
    let (mut ox, mut oy) = (0i32, 0i32);
    gdk_sys::gdk_window_get_origin(win, &mut ox, &mut oy);
    glib::gobject_ffi::g_object_ref(win.cast());
    (win, wx, wy, wx + f64::from(ox), wy + f64::from(oy))
}

fn now_ms() -> u32 {
    // GDK event times are 32-bit milliseconds that wrap.
    (glib::monotonic_time() / 1000) as u32
}

/// # Safety
/// GTK main thread, realized widget.
unsafe fn build(
    b: *mut gtk_sys::GtkWidget,
    display: *mut gdk_sys::GdkDisplay,
    step: Step,
) -> *mut gdk_sys::GdkEvent {
    match step {
        Step::Button { at, press } => {
            let (win, x, y, x_root, y_root) = coords(b, at);
            let ev = gdk_sys::gdk_event_new(if press {
                gdk_sys::GDK_BUTTON_PRESS
            } else {
                gdk_sys::GDK_BUTTON_RELEASE
            });
            let e = &mut (*ev).button;
            e.window = win;
            e.send_event = 0;
            e.time = now_ms();
            e.x = x;
            e.y = y;
            e.x_root = x_root;
            e.y_root = y_root;
            e.button = 1;
            e.state = if press { 0 } else { gdk_sys::GDK_BUTTON1_MASK };
            ev
        }
        Step::Motion { at, held } => {
            let (win, x, y, x_root, y_root) = coords(b, at);
            let ev = gdk_sys::gdk_event_new(gdk_sys::GDK_MOTION_NOTIFY);
            let e = &mut (*ev).motion;
            e.window = win;
            e.send_event = 0;
            e.time = now_ms();
            e.x = x;
            e.y = y;
            e.x_root = x_root;
            e.y_root = y_root;
            e.state = if held { gdk_sys::GDK_BUTTON1_MASK } else { 0 };
            e.is_hint = 0;
            ev
        }
        Step::Scroll { at, dx, dy } => {
            let (win, x, y, x_root, y_root) = coords(b, at);
            let ev = gdk_sys::gdk_event_new(gdk_sys::GDK_SCROLL);
            let e = &mut (*ev).scroll;
            e.window = win;
            e.send_event = 0;
            e.time = now_ms();
            e.x = x;
            e.y = y;
            e.x_root = x_root;
            e.y_root = y_root;
            e.state = 0;
            e.direction = gdk_sys::GDK_SCROLL_SMOOTH;
            e.delta_x = dx / PX_PER_SCROLL_UNIT;
            e.delta_y = dy / PX_PER_SCROLL_UNIT;
            ev
        }
        Step::Key { keyval, text, press } => {
            let win = gtk_sys::gtk_widget_get_window(b);
            glib::gobject_ffi::g_object_ref(win.cast());
            let ev = gdk_sys::gdk_event_new(if press {
                gdk_sys::GDK_KEY_PRESS
            } else {
                gdk_sys::GDK_KEY_RELEASE
            });
            let e = &mut (*ev).key;
            e.window = win;
            e.send_event = 0;
            e.time = now_ms();
            e.state = 0;
            e.keyval = keyval;
            e.hardware_keycode = hardware_keycode(display, keyval);
            e.group = 0;
            let mut buf = [0u8; 4];
            let s = text.map(|c| c.encode_utf8(&mut buf).to_string()).unwrap_or_default();
            let s = std::ffi::CString::new(s).unwrap_or_default();
            e.length = s.as_bytes().len() as i32;
            e.string = glib::ffi::g_strdup(s.as_ptr());
            ev
        }
    }
}

/// # Safety
/// GTK main thread.
unsafe fn hardware_keycode(display: *mut gdk_sys::GdkDisplay, keyval: u32) -> u16 {
    let keymap = gdk_sys::gdk_keymap_get_for_display(display);
    let mut keys: *mut gdk_sys::GdkKeymapKey = std::ptr::null_mut();
    let mut n: i32 = 0;
    let mut code = 0u16;
    if gdk_sys::gdk_keymap_get_entries_for_keyval(keymap, keyval, &mut keys, &mut n) != 0 && n > 0 {
        code = (*keys).keycode as u16;
        glib::ffi::g_free(keys.cast());
    }
    code
}

impl NativeInput for GdkInput {
    fn tiers(&self) -> &'static [(CapabilityId, Support)] {
        TIERS
    }

    fn click<'a>(&'a self, tab: &'a str, at: Point) -> EngineFuture<'a, ()> {
        self.run(
            tab,
            vec![
                Step::Motion { at, held: false },
                Step::Button { at, press: true },
                Step::Button { at, press: false },
            ],
        )
    }

    fn move_to<'a>(&'a self, tab: &'a str, at: Point) -> EngineFuture<'a, ()> {
        self.run(tab, vec![Step::Motion { at, held: false }])
    }

    fn wheel<'a>(&'a self, tab: &'a str, at: Point, dx: f64, dy: f64) -> EngineFuture<'a, ()> {
        self.run(tab, vec![Step::Motion { at, held: false }, Step::Scroll { at, dx, dy }])
    }

    fn drag<'a>(&'a self, tab: &'a str, from: Point, to: Point) -> EngineFuture<'a, ()> {
        let mut steps = vec![
            Step::Motion { at: from, held: false },
            Step::Button { at: from, press: true },
        ];
        steps.extend((1..=DRAG_STEPS).map(|i| Step::Motion {
            at: lerp(from, to, f64::from(i) / f64::from(DRAG_STEPS)),
            held: true,
        }));
        steps.push(Step::Button { at: to, press: false });
        self.run(tab, steps)
    }

    fn key<'a>(&'a self, tab: &'a str, input: KeyInput<'a>) -> EngineFuture<'a, ()> {
        Box::pin(async move {
            let steps = key_steps(input);
            let events = steps.len();
            self.run(tab, steps).await?;
            // WebKit hands the page one key event at a time, each after the
            // page acknowledged the one before, so most are still queued in
            // this process now and a click sent next would overtake them.
            // The page acknowledges an event before it answers an eval sent
            // after it, so each round trip lets at least one more through.
            for _ in 0..events {
                string_eval::call(&self.tabs, tab, |platform, done| {
                    eval::call(platform, "return 'null';", "{}", done)
                })
                .await?;
            }
            Ok(())
        })
    }
}
