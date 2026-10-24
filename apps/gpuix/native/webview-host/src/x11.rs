//! X11 plumbing the webviews need beyond wry: find the GPUIX window, move X input focus, keep
//! key events away from unfocused webviews, and watch every button press on the display.

use std::collections::HashMap;
use std::ffi::CString;
use std::os::raw::{c_int, c_uchar, c_ulong};

use gtk::gdk;
use gtk::prelude::*;
use x11_dl::xinput2::{XIEventMask, XInput2};
use x11_dl::xlib::{Display, Xlib};

pub type Xid = c_ulong;

/// The helper's own X connection. Event masks are per client, so the key gate works on GDK's
/// connection instead (`gdk_display`), the one that selected the webview windows' events.
pub struct X {
    pub xlib: Xlib,
    xi: XInput2,
    pub dpy: *mut Display,
    xi_opcode: c_int,
    /// Masks removed from webview windows by the key gate, restored when it opens.
    gated_core: HashMap<Xid, i64>,
    gated_xi: HashMap<Xid, Vec<(c_int, Vec<u8>)>>,
}

const XI_RAW_BUTTON_PRESS: c_int = 15;
const XI_KEY_PRESS: u8 = 2;
const XI_KEY_RELEASE: u8 = 3;
const KEY_MASKS: i64 = 0b11; // KeyPressMask | KeyReleaseMask

impl X {
    pub fn open() -> Result<X, String> {
        let xlib = Xlib::open().map_err(|e| format!("libX11: {e}"))?;
        let xi = XInput2::open().map_err(|e| format!("libXi: {e}"))?;
        let dpy = unsafe { (xlib.XOpenDisplay)(std::ptr::null()) };
        if dpy.is_null() {
            return Err("cannot open the X display (is DISPLAY set?)".into());
        }
        let name = CString::new("XInputExtension").unwrap();
        let (mut opcode, mut event, mut error) = (0, 0, 0);
        if unsafe { (xlib.XQueryExtension)(dpy, name.as_ptr(), &mut opcode, &mut event, &mut error) } == 0 {
            return Err("the X server has no XInput extension".into());
        }
        let (mut major, mut minor) = (2, 2);
        if unsafe { (xi.XIQueryVersion)(dpy, &mut major, &mut minor) } != 0 {
            return Err("the X server has no XInput 2".into());
        }
        Ok(X { xlib, xi, dpy, xi_opcode: opcode, gated_core: HashMap::new(), gated_xi: HashMap::new() })
    }

    fn atom(&self, name: &str) -> c_ulong {
        let c = CString::new(name).unwrap();
        unsafe { (self.xlib.XInternAtom)(self.dpy, c.as_ptr(), 1) }
    }

    fn children(&self, dpy: *mut Display, win: Xid) -> Vec<Xid> {
        unsafe {
            let (mut root, mut parent, mut kids, mut n) = (0, 0, std::ptr::null_mut(), 0u32);
            if (self.xlib.XQueryTree)(dpy, win, &mut root, &mut parent, &mut kids, &mut n) == 0 || kids.is_null() {
                return Vec::new();
            }
            let out = std::slice::from_raw_parts(kids, n as usize).to_vec();
            (self.xlib.XFree)(kids as _);
            out
        }
    }

    fn cardinal(&self, win: Xid, atom: c_ulong) -> Option<u64> {
        if atom == 0 {
            return None;
        }
        unsafe {
            let (mut ty, mut format, mut n, mut after) = (0, 0, 0, 0);
            let mut data: *mut c_uchar = std::ptr::null_mut();
            let status = (self.xlib.XGetWindowProperty)(
                self.dpy, win, atom, 0, 1, 0, 0, &mut ty, &mut format, &mut n, &mut after, &mut data,
            );
            if status != 0 || data.is_null() {
                return None;
            }
            let value = if n == 1 && format == 32 { Some(*(data as *const c_ulong) as u64) } else { None };
            (self.xlib.XFree)(data as _);
            value
        }
    }

    fn viewable(&self, win: Xid) -> bool {
        unsafe {
            let mut attrs: x11_dl::xlib::XWindowAttributes = std::mem::zeroed();
            (self.xlib.XGetWindowAttributes)(self.dpy, win, &mut attrs) != 0 && attrs.map_state == 2
        }
    }

    /// The mapped top-level window of process `pid`: GPUI sets `_NET_WM_PID` on its windows. A
    /// reparenting window manager puts it a level or two below the root, so search a few deep.
    pub fn find_window_of_pid(&self, pid: u32) -> Option<Xid> {
        let atom = self.atom("_NET_WM_PID");
        let root = unsafe { (self.xlib.XDefaultRootWindow)(self.dpy) };
        let mut level = vec![root];
        for _ in 0..4 {
            let mut next = Vec::new();
            for win in level {
                for kid in self.children(self.dpy, win) {
                    if self.cardinal(kid, atom) == Some(pid as u64) && self.viewable(kid) {
                        return Some(kid);
                    }
                    next.push(kid);
                }
            }
            level = next;
        }
        None
    }

    pub fn focus(&self, win: Xid) {
        unsafe {
            (self.xlib.XSetInputFocus)(self.dpy, win, 1 /* RevertToPointerRoot */, 0);
            (self.xlib.XFlush)(self.dpy);
        }
    }

    /// X sends a key to the window under the pointer when that window is inside the focus
    /// window, so a webview child would take typing meant for the app whenever the mouse rests
    /// over it. Closing the gate drops KeyPress/KeyRelease (core and XI2) from every window of
    /// the webview; opening it restores what was there.
    pub fn key_gate(&mut self, top: Xid, open: bool) {
        let dpy = gdk_display();
        let mut stack = vec![top];
        while let Some(win) = stack.pop() {
            stack.extend(self.children(dpy, win));
            unsafe {
                if open {
                    if let Some(mask) = self.gated_core.remove(&win) {
                        (self.xlib.XSelectInput)(dpy, win, mask);
                    }
                    for (device, mut bytes) in self.gated_xi.remove(&win).unwrap_or_default() {
                        let mut em = XIEventMask { deviceid: device, mask_len: bytes.len() as c_int, mask: bytes.as_mut_ptr() };
                        (self.xi.XISelectEvents)(dpy, win, &mut em, 1);
                    }
                    continue;
                }
                let mut count = 0;
                let masks = (self.xi.XIGetSelectedEvents)(dpy, win, &mut count);
                if !masks.is_null() {
                    let mut saved = Vec::new();
                    for i in 0..count as usize {
                        let m = &*masks.add(i);
                        let bytes = std::slice::from_raw_parts(m.mask, m.mask_len as usize).to_vec();
                        let mut cut = bytes.clone();
                        if let Some(first) = cut.first_mut() {
                            *first &= !((1 << XI_KEY_PRESS) | (1 << XI_KEY_RELEASE));
                        }
                        if cut != bytes {
                            let mut em = XIEventMask { deviceid: m.deviceid, mask_len: cut.len() as c_int, mask: cut.as_mut_ptr() };
                            (self.xi.XISelectEvents)(dpy, win, &mut em, 1);
                            saved.push((m.deviceid, bytes));
                        }
                    }
                    (self.xlib.XFree)(masks as _);
                    if !saved.is_empty() {
                        self.gated_xi.entry(win).or_insert(saved);
                    }
                }
                let mut attrs: x11_dl::xlib::XWindowAttributes = std::mem::zeroed();
                if (self.xlib.XGetWindowAttributes)(dpy, win, &mut attrs) != 0 && attrs.your_event_mask & KEY_MASKS != 0 {
                    self.gated_core.entry(win).or_insert(attrs.your_event_mask);
                    (self.xlib.XSelectInput)(dpy, win, attrs.your_event_mask & !KEY_MASKS);
                }
            }
        }
        unsafe { (self.xlib.XFlush)(dpy) };
    }

    /// Map or unmap a window on GDK's connection, so GDK sees the change in event order.
    pub fn set_mapped(&self, win: Xid, mapped: bool) {
        let dpy = gdk_display();
        unsafe {
            if mapped {
                (self.xlib.XMapWindow)(dpy, win);
            } else {
                (self.xlib.XUnmapWindow)(dpy, win);
            }
            (self.xlib.XFlush)(dpy);
        }
    }

    /// Forget gate records of windows that no longer exist (a destroyed tab).
    pub fn forget(&mut self, top: Xid) {
        let dpy = gdk_display();
        let mut stack = vec![top];
        while let Some(win) = stack.pop() {
            stack.extend(self.children(dpy, win));
            self.gated_core.remove(&win);
            self.gated_xi.remove(&win);
        }
    }

    /// Ask for a raw event on every button press anywhere on the display.
    pub fn watch_button_presses(&self) {
        unsafe {
            let root = (self.xlib.XDefaultRootWindow)(self.dpy);
            let mut bits = [0u8; 4];
            bits[(XI_RAW_BUTTON_PRESS / 8) as usize] |= 1 << (XI_RAW_BUTTON_PRESS % 8);
            let mut em = XIEventMask { deviceid: 1 /* XIAllMasterDevices */, mask_len: bits.len() as c_int, mask: bits.as_mut_ptr() };
            (self.xi.XISelectEvents)(self.dpy, root, &mut em, 1);
            (self.xlib.XFlush)(self.dpy);
        }
    }

    pub fn fd(&self) -> c_int {
        unsafe { (self.xlib.XConnectionNumber)(self.dpy) }
    }

    /// Drain queued events; true when one of them was a button press.
    pub fn take_button_presses(&self) -> bool {
        let mut pressed = false;
        unsafe {
            while (self.xlib.XPending)(self.dpy) > 0 {
                let mut ev: x11_dl::xlib::XEvent = std::mem::zeroed();
                (self.xlib.XNextEvent)(self.dpy, &mut ev);
                let cookie = &mut ev.generic_event_cookie;
                if cookie.type_ == 35 /* GenericEvent */ && cookie.extension == self.xi_opcode && cookie.evtype == XI_RAW_BUTTON_PRESS {
                    pressed = true;
                }
            }
        }
        pressed
    }

    /// Windows under the pointer, from the root's child down to the deepest one.
    pub fn pointer_path(&self) -> Vec<Xid> {
        let mut path = Vec::new();
        unsafe {
            let mut win = (self.xlib.XDefaultRootWindow)(self.dpy);
            loop {
                let (mut root, mut child, mut rx, mut ry, mut wx, mut wy, mut mask) = (0, 0, 0, 0, 0, 0, 0);
                if (self.xlib.XQueryPointer)(self.dpy, win, &mut root, &mut child, &mut rx, &mut ry, &mut wx, &mut wy, &mut mask) == 0
                    || child == 0
                {
                    break;
                }
                path.push(child);
                win = child;
            }
        }
        path
    }
}

pub fn gdk_display() -> *mut Display {
    let display = gdk::Display::default().expect("gtk is initialised");
    let x11: &gdkx11::X11Display = display.downcast_ref().expect("an X11 display");
    unsafe { gdkx11::ffi::gdk_x11_display_get_xdisplay(x11.as_ptr()) as *mut Display }
}
