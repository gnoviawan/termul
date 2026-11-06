//! WebView2 console and network observation on agent tabs, and the CDP
//! sessions of out-of-process frames, all over in-process CDP events.
//!
//! A tab has its page session plus one session per out-of-process frame,
//! which auto-attach announces, and announces again with a new session
//! after the frame reloads or navigates. Every session gets the same
//! domains enabled, and its file choosers cancelled, when it appears. The
//! table lives on the UI thread that raises the events and issues the
//! calls.

use std::cell::RefCell;
use std::collections::HashMap;

use serde_json::Value;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2DevToolsProtocolEventReceivedEventArgs,
    ICoreWebView2DevToolsProtocolEventReceivedEventArgs2, ICoreWebView2_11,
};
use webview2_com::{take_pwstr, CallDevToolsProtocolMethodCompletedHandler, DevToolsProtocolEventReceivedEventHandler};
use windows_core::{Interface, HSTRING, PWSTR};

use crate::browser_automation::engine::cdp::observe::{self as cdp_observe, NetworkTracker, Observed};
use crate::browser_automation::engine::cdp::{self, CdpMethod};
use crate::browser_automation::engine::events::{TabEvent, TabEvents};

struct FrameSession {
    frame: String,
    /// The session the frame was attached on; empty for the page.
    parent: String,
}

struct TabSessions {
    events: TabEvents,
    tracker: NetworkTracker,
    /// Out-of-process frames by session id.
    frames: HashMap<String, FrameSession>,
}

thread_local! {
    static TABS: RefCell<HashMap<String, TabSessions>> = RefCell::new(HashMap::new());
}

/// Subscribe to the observed events and enable their domains on the page
/// session. Runs on the UI thread, inside `with_webview`.
pub fn attach(core: &ICoreWebView2, events: &TabEvents) -> bool {
    let label = events.label().to_string();
    TABS.with(|tabs| {
        tabs.borrow_mut().insert(
            label.clone(),
            TabSessions {
                events: events.clone(),
                tracker: NetworkTracker::default(),
                frames: HashMap::new(),
            },
        )
    });
    for name in cdp_observe::EVENTS {
        // SAFETY: UI thread, on the tab's own live `ICoreWebView2`.
        let Ok(receiver) = (unsafe { core.GetDevToolsProtocolEventReceiver(&HSTRING::from(name)) }) else {
            return false;
        };
        let label = label.clone();
        let handler = DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |sender, args| {
            if let (Some(sender), Some(args)) = (sender, args) {
                on_event(&label, name, &sender, &args);
            }
            Ok(())
        }));
        let mut token = 0i64;
        // SAFETY: as above; WebView2 holds the handler for the webview's life.
        if unsafe { receiver.add_DevToolsProtocolEventReceived(&handler, &mut token) }.is_err() {
            return false;
        }
    }
    enable(core, None)
}

/// Fire the enable and file-chooser calls on `session` (`None`: the
/// page). Their replies carry nothing the adapter needs.
fn enable(core: &ICoreWebView2, session: Option<&str>) -> bool {
    cdp_observe::enable_calls()
        .into_iter()
        .chain(cdp::file_chooser_calls())
        .all(|(method, params)| issue(core, session, method, &params))
}

fn issue(core: &ICoreWebView2, session: Option<&str>, method: CdpMethod, params: &Value) -> bool {
    let name = method.as_str();
    let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |hr, _| {
        if hr.is_err() {
            log::warn!("[browser-tab] WebView2 refused {name} on an agent tab session");
        }
        Ok(())
    }));
    let method = HSTRING::from(name);
    let params = HSTRING::from(params.to_string());
    // SAFETY: UI thread, on the tab's own live `ICoreWebView2`; WebView2
    // addrefs the completion handler for the round trip.
    let issued = match session {
        None => unsafe { core.CallDevToolsProtocolMethod(&method, &params, &handler) },
        Some(session) => core.cast::<ICoreWebView2_11>().and_then(|core| unsafe {
            core.CallDevToolsProtocolMethodForSession(&HSTRING::from(session), &method, &params, &handler)
        }),
    };
    issued.is_ok()
}

fn read(get: impl FnOnce(*mut PWSTR) -> windows_core::Result<()>) -> Option<String> {
    let mut text = PWSTR::null();
    get(&mut text).ok().map(|()| take_pwstr(text))
}

fn on_event(label: &str, name: &str, core: &ICoreWebView2, args: &ICoreWebView2DevToolsProtocolEventReceivedEventArgs) {
    // SAFETY: COM calls on the event's own args, on the UI thread.
    let Some(json) = read(|out| unsafe { args.ParameterObjectAsJson(out) }) else {
        return;
    };
    let Ok(params) = serde_json::from_str::<Value>(&json) else {
        return;
    };
    let session = args
        .cast::<ICoreWebView2DevToolsProtocolEventReceivedEventArgs2>()
        .ok()
        // SAFETY: as above.
        .and_then(|args| read(|out| unsafe { args.SessionId(out) }))
        .unwrap_or_default();
    let observed = TABS.with(|tabs| {
        let mut tabs = tabs.borrow_mut();
        let tab = tabs.get_mut(label)?;
        let observed = cdp_observe::parse(&mut tab.tracker, &session, name, &params);
        match &observed {
            Observed::Console(entry) => tab.events.publish(TabEvent::Console(entry.clone())),
            Observed::Network(entry) => tab.events.publish(TabEvent::Network(entry.clone())),
            Observed::FrameAttached { session: child, frame } => {
                tab.frames.insert(
                    child.clone(),
                    FrameSession {
                        frame: frame.clone(),
                        parent: session.clone(),
                    },
                );
            }
            Observed::Detached { session: gone } => {
                tab.frames.remove(gone);
            }
            Observed::None => {}
        }
        Some(observed)
    });
    if let Some(Observed::FrameAttached { session: child, .. }) = observed {
        if !enable(core, Some(&child)) {
            log::warn!("[browser-tab] WebView2 refused CDP calls on a frame session");
        }
    }
}

/// The live session of out-of-process frame `frame` on `tab`.
pub fn session_of(tab: &str, frame: &str) -> Option<String> {
    TABS.with(|tabs| {
        let tabs = tabs.borrow();
        let found = tabs.get(tab)?.frames.iter().find(|(_, f)| f.frame == frame);
        found.map(|(session, _)| session.clone())
    })
}

/// Every out-of-process frame on `tab`, with its parent frame's id
/// (`None`: the page).
pub fn frames(tab: &str) -> Vec<(String, Option<String>)> {
    TABS.with(|tabs| {
        let tabs = tabs.borrow();
        let Some(tab) = tabs.get(tab) else {
            return Vec::new();
        };
        tab.frames
            .values()
            .filter_map(|f| match f.parent.as_str() {
                "" => Some((f.frame.clone(), None)),
                parent => tab.frames.get(parent).map(|p| (f.frame.clone(), Some(p.frame.clone()))),
            })
            .collect()
    })
}

pub fn release_tab(tab: &str) {
    TABS.with(|tabs| tabs.borrow_mut().remove(tab));
}
