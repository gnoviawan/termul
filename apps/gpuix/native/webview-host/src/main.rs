//! Browser-pane webviews for the Termul GPUIX client on Linux X11.
//!
//! Each tab is a wry webview built as an X11 child of the GPUIX window, so the X server clips
//! and moves it with the app. The app drives it over stdio (`protocol.rs`). The helper also owns
//! keyboard routing between the app window and the webviews: a press inside a webview hands it
//! the keyboard, a press anywhere else in the app (or a `blur` from the app) takes it back.
//!
//! Lifetime: stdin EOF, `quit`, or the parent process dying ends the helper; each webview owns
//! its WebKit context, so dropping a tab ends that tab's WebKit processes.

mod protocol;
mod x11;

use std::cell::RefCell;
use std::collections::HashMap;
use std::io::{BufRead, Write};

use gtk::glib;
use gtk::prelude::*;
use protocol::{Bounds, Command, Event, PageMessage};
use raw_window_handle::{
    DisplayHandle, HandleError, HasDisplayHandle, HasWindowHandle, RawWindowHandle, WindowHandle,
    XlibWindowHandle,
};
use wry::dpi::{LogicalPosition, LogicalSize};
use wry::{PageLoadEvent, Rect, WebView, WebViewBuilder, WebViewExtUnix};
use x11::{Xid, X};

fn emit(event: Event) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{}", protocol::encode(&event));
    let _ = out.flush();
}

fn log(message: &str) {
    eprintln!("[termul-webview-host] {message}");
}

struct Parent(Xid);

impl HasWindowHandle for Parent {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        let handle = XlibWindowHandle::new(self.0);
        Ok(unsafe { WindowHandle::borrow_raw(RawWindowHandle::Xlib(handle)) })
    }
}

impl HasDisplayHandle for Parent {
    fn display_handle(&self) -> Result<DisplayHandle<'_>, HandleError> {
        Err(HandleError::NotSupported)
    }
}

struct Tab {
    view: WebView,
    /// The X window wry made inside the parent; every window of the webview is below it.
    container: Xid,
    visible: bool,
}

struct Host {
    parent: Xid,
    x: X,
    tabs: HashMap<String, Tab>,
    /// The tab holding the keyboard; `None` means the app window does.
    keyboard: Option<String>,
}

thread_local! {
    static HOST: RefCell<Option<Host>> = const { RefCell::new(None) };
}

fn with_host<R>(f: impl FnOnce(&mut Host) -> R) -> Option<R> {
    HOST.with(|cell| cell.borrow_mut().as_mut().map(f))
}

/// Main frame only. Reports console output and same-document URL changes, which no wry
/// callback covers (pushState, replaceState, back/forward between entries, hash changes).
const INIT_JS: &str = r#"
(function () {
  if (window.__termulBrowserPane) return;
  window.__termulBrowserPane = true;
  var post = function (m) { try { window.ipc.postMessage(JSON.stringify(m)); } catch (e) {} };
  var text = function (v) {
    if (typeof v === 'string') return v;
    try { var s = JSON.stringify(v); return s === undefined ? String(v) : s; } catch (e) { return String(v); }
  };
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    var original = console[level];
    console[level] = function () {
      post({ kind: 'console', level: level, text: Array.prototype.map.call(arguments, text).join(' ') });
      return original.apply(console, arguments);
    };
  });
  window.addEventListener('error', function (e) { post({ kind: 'console', level: 'error', text: 'Uncaught ' + e.message }); });
  window.addEventListener('unhandledrejection', function (e) { post({ kind: 'console', level: 'error', text: 'Unhandled rejection ' + text(e.reason) }); });
  var url = function () { post({ kind: 'url', url: location.href }); };
  ['pushState', 'replaceState'].forEach(function (name) {
    var original = history[name];
    history[name] = function () { var r = original.apply(this, arguments); url(); return r; };
  });
  window.addEventListener('popstate', url);
  window.addEventListener('hashchange', url);
})();
"#;

fn rect(b: &Bounds) -> Rect {
    Rect {
        position: LogicalPosition::new(b.x, b.y).into(),
        size: LogicalSize::new(b.width.max(1.0), b.height.max(1.0)).into(),
    }
}

fn container_of(view: &WebView) -> Result<Xid, String> {
    view.webview()
        .toplevel()
        .and_then(|top| top.window())
        .and_then(|window| window.downcast::<gdkx11::X11Window>().ok())
        .map(|window| window.xid())
        .ok_or_else(|| "webview has no X11 container window".to_string())
}

fn flush() {
    if let Some(display) = gtk::gdk::Display::default() {
        display.flush();
    }
}

impl Host {
    fn tab(&self, id: &str) -> Result<&Tab, String> {
        self.tabs.get(id).ok_or_else(|| format!("no such tab: {id}"))
    }

    fn give_keyboard_to_app(&mut self) {
        let containers: Vec<Xid> = self.tabs.values().map(|t| t.container).collect();
        for container in containers {
            self.x.key_gate(container, false);
        }
        self.x.focus(self.parent);
        if self.keyboard.take().is_some() {
            emit(Event::Keyboard { owner: None });
        }
    }

    fn give_keyboard_to_tab(&mut self, id: &str) {
        if self.keyboard.as_deref() == Some(id) {
            return;
        }
        let Some(container) = self.tabs.get(id).map(|t| t.container) else { return };
        let others: Vec<Xid> = self.tabs.iter().filter(|(k, _)| *k != id).map(|(_, t)| t.container).collect();
        for other in others {
            self.x.key_gate(other, false);
        }
        self.x.key_gate(container, true);
        self.x.focus(container);
        self.keyboard = Some(id.to_string());
        emit(Event::Keyboard { owner: Some(id.to_string()) });
    }

    /// A button went down somewhere on the display: route the keyboard to where it landed.
    fn on_button_press(&mut self) {
        let path = self.x.pointer_path();
        let hit = self.tabs.iter().find(|(_, t)| t.visible && path.contains(&t.container)).map(|(id, _)| id.clone());
        match hit {
            Some(id) => self.give_keyboard_to_tab(&id),
            None if path.contains(&self.parent) && self.keyboard.is_some() => self.give_keyboard_to_app(),
            None => {}
        }
    }

    fn create(&mut self, id: String, url: String, bounds: Bounds) -> Result<(), String> {
        if self.tabs.contains_key(&id) {
            self.destroy(&id)?;
        }
        let (nav_id, load_id, title_id, ipc_id) = (id.clone(), id.clone(), id.clone(), id.clone());
        let view = WebViewBuilder::new()
            .with_url(&url)
            .with_bounds(rect(&bounds))
            .with_visible(true)
            .with_devtools(true)
            .with_initialization_script_for_main_only(INIT_JS, true)
            .with_ipc_handler(move |request| match protocol::parse_page_message(request.body()) {
                Some(PageMessage::Console { level, text }) => emit(Event::Console { id: ipc_id.clone(), level, text }),
                Some(PageMessage::Url { url }) => emit(Event::Navigated { id: ipc_id.clone(), url }),
                None => {}
            })
            .with_document_title_changed_handler(move |title| emit(Event::Title { id: title_id.clone(), title }))
            .with_on_page_load_handler(move |phase, url| match phase {
                PageLoadEvent::Started => emit(Event::Navigated { id: nav_id.clone(), url }),
                PageLoadEvent::Finished => {
                    emit(Event::Navigated { id: load_id.clone(), url: url.clone() });
                    emit(Event::Loaded { id: load_id.clone(), url });
                }
            })
            .build_as_child(&Parent(self.parent))
            .map_err(|e| format!("create webview: {e}"))?;
        let container = container_of(&view)?;
        self.x.key_gate(container, false);
        self.tabs.insert(id, Tab { view, container, visible: false });
        Ok(())
    }

    fn set_visible(&mut self, id: &str, visible: bool) -> Result<(), String> {
        let container = self.tab(id)?.container;
        // Map state of the container only. wry's set_visible also hides the GTK widgets, and a
        // webview hidden that way never repaints when shown again (measured: black until a reload).
        self.x.set_mapped(container, visible);
        if let Some(tab) = self.tabs.get_mut(id) {
            tab.visible = visible;
        }
        if visible {
            // Mapping can realize new windows inside the webview; keep them gated too.
            let holds_keyboard = self.keyboard.as_deref() == Some(id);
            self.x.key_gate(container, holds_keyboard);
        } else if self.keyboard.as_deref() == Some(id) {
            self.give_keyboard_to_app();
        }
        flush();
        Ok(())
    }

    fn destroy(&mut self, id: &str) -> Result<(), String> {
        if self.keyboard.as_deref() == Some(id) {
            self.give_keyboard_to_app();
        }
        let tab = self.tabs.remove(id).ok_or_else(|| format!("no such tab: {id}"))?;
        self.x.forget(tab.container);
        drop(tab);
        flush();
        Ok(())
    }

    fn eval(&self, id: &str, js: &str) -> Result<(), String> {
        self.tab(id)?.view.evaluate_script(js).map_err(|e| e.to_string())
    }

    fn handle(&mut self, cmd: Command) -> Result<(), String> {
        match cmd {
            Command::Create { id, url, bounds, .. } => self.create(id, url, bounds),
            Command::Bounds { id, bounds, .. } => {
                self.tab(&id)?.view.set_bounds(rect(&bounds)).map_err(|e| e.to_string())?;
                flush();
                Ok(())
            }
            Command::Show { id, .. } => self.set_visible(&id, true),
            Command::Hide { id, .. } => self.set_visible(&id, false),
            Command::Navigate { id, url, .. } => self.tab(&id)?.view.load_url(&url).map_err(|e| e.to_string()),
            // The same scripts the desktop app evaluates (src-tauri browser_tab_manager.rs).
            Command::Back { id, .. } => self.eval(&id, "window.history.back()"),
            Command::Forward { id, .. } => self.eval(&id, "window.history.forward()"),
            Command::Reload { id, .. } => self.eval(&id, "window.location.reload()"),
            Command::Devtools { id, .. } => {
                self.tab(&id)?.view.open_devtools();
                Ok(())
            }
            Command::Destroy { id, .. } => self.destroy(&id),
            Command::Blur { .. } => {
                self.give_keyboard_to_app();
                Ok(())
            }
            Command::Quit => unreachable!("dispatch handles quit"),
        }
    }
}

fn quit() -> ! {
    HOST.with(|cell| {
        if let Some(host) = cell.borrow_mut().as_mut() {
            host.tabs.clear();
        }
    });
    flush();
    std::process::exit(0)
}

fn dispatch(line: String) {
    if std::env::var_os("TERMUL_WEBVIEW_HOST_TRACE").is_some() {
        log(&format!("command {line}"));
    }
    let cmd = match protocol::parse_command(&line) {
        Ok(cmd) => cmd,
        Err(error) => return emit(Event::Invalid { line, error }),
    };
    if cmd == Command::Quit {
        quit();
    }
    let req = cmd.req();
    let result = with_host(|host| {
        let result = host.handle(cmd);
        // Round trips above can pull a press into Xlib's queue without the socket waking us.
        if host.x.take_button_presses() {
            host.on_button_press();
        }
        result
    })
    .unwrap_or_else(|| Err("host not ready".into()));
    if let Some(req) = req {
        match result {
            Ok(()) => emit(Event::Ack { req, ok: true, error: None }),
            Err(error) => emit(Event::Ack { req, ok: false, error: Some(error) }),
        }
    }
}

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn parse_xid(text: &str) -> Option<Xid> {
    match text.strip_prefix("0x") {
        Some(hex) => Xid::from_str_radix(hex, 16).ok(),
        None => text.parse().ok(),
    }
}

fn fatal(error: String) -> ! {
    log(&error);
    emit(Event::Fatal { error });
    std::process::exit(2)
}

fn main() {
    // Die with the app even when it is killed without closing our stdin.
    unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) };
    if unsafe { libc::getppid() } == 1 {
        std::process::exit(0);
    }
    let args: Vec<String> = std::env::args().collect();
    if gtk::init().is_err() {
        fatal("gtk could not open the display".into());
    }
    let x = X::open().unwrap_or_else(|e| fatal(e));
    let parent = match (arg(&args, "--parent"), arg(&args, "--parent-pid")) {
        (Some(xid), _) => parse_xid(&xid).unwrap_or_else(|| fatal(format!("bad --parent {xid}"))),
        (None, Some(pid)) => {
            let pid: u32 = pid.parse().unwrap_or_else(|_| fatal(format!("bad --parent-pid {pid}")));
            (0..50)
                .find_map(|attempt| {
                    if attempt > 0 {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                    x.find_window_of_pid(pid)
                })
                .unwrap_or_else(|| fatal(format!("no mapped X11 window of pid {pid}")))
        }
        (None, None) => fatal("usage: termul-webview-host --parent-pid <pid> | --parent <xid>".into()),
    };
    x.watch_button_presses();
    let fd = x.fd();
    HOST.with(|cell| *cell.borrow_mut() = Some(Host { parent, x, tabs: HashMap::new(), keyboard: None }));
    emit(Event::Ready { parent, pid: std::process::id() });
    log(&format!("ready, parent window {parent:#x}"));

    glib::unix_fd_add_local(fd, glib::IOCondition::IN, |_, _| {
        with_host(|host| {
            if host.x.take_button_presses() {
                host.on_button_press();
            }
        });
        glib::ControlFlow::Continue
    });

    std::thread::spawn(|| {
        let context = glib::MainContext::default();
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            context.invoke(move || dispatch(line));
        }
        context.invoke(|| quit());
    });

    gtk::main();
}
