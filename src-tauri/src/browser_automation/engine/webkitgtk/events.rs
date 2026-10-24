//! WebKitGTK tab events tauri does not expose: same-document URL changes,
//! script dialogs and requests on agent tabs, and the downloads of this
//! tab.
//!
//! `notify::uri` fires for every URL change; while a load is in progress
//! the change belongs to that load (its commit carries the URL), so only
//! changes outside a load are same-document commits.
//!
//! Downloads start on the web context every tab shares, so each tab
//! listens there and keeps only the downloads its own webview started.
//! Those are started again by the host, which then holds the download
//! before WebKitGTK picks a destination for it.

use std::cell::{Cell, RefCell};
use std::path::Path;
use std::rc::Rc;

use gtk::glib::prelude::*;
use gtk::glib::ControlFlow;
use gtk::prelude::WidgetExt;
use tauri::webview::PlatformWebview;
use tauri::Url;
use webkit2gtk::{
    Download, DownloadExt, SettingsExt, URIRequestExt, URIResponseExt, WebContextExt, WebViewExt,
};

use super::{chooser, dialogs};
use crate::browser_automation::engine::events::{DownloadSize, TabEvents, TabRole};

pub fn attach(platform: &PlatformWebview, events: TabEvents) -> bool {
    let webview = platform.inner();
    if events.role() == TabRole::Agent {
        dialogs::attach(&webview, events.clone());
        super::observe::attach(&webview, events.clone());
        chooser::attach(&webview, events.label().to_string());
        // Agent input on this engine is page-script events, which the
        // popup blocker refuses; every popup still meets the host's popup
        // policy.
        if let Some(settings) = WebViewExt::settings(&webview) {
            settings.set_javascript_can_open_windows_automatically(true);
        }
    }
    if events.holds_downloads() {
        attach_downloads(&webview, events.clone());
    }
    let _ = webview.connect_notify_local(Some("uri"), move |webview, _| {
        if webview.property::<bool>("is-loading") {
            return;
        }
        if let Some(uri) = webview.property::<Option<String>>("uri") {
            events.same_document(&uri);
        }
    });
    true
}

fn download_url(download: &Download) -> Option<Url> {
    download.request()?.uri()?.parse().ok()
}

fn attach_downloads(webview: &webkit2gtk::WebView, events: TabEvents) {
    let Some(context) = webview.context() else {
        return;
    };
    let own = webview.downgrade();
    let reissued: Rc<RefCell<Vec<Download>>> = Rc::default();
    let reissuing = Rc::new(Cell::new(false));
    let handler = context.connect_download_started(move |_, download| {
        let Some(own) = own.upgrade() else {
            return;
        };
        if reissuing.get()
            || download.web_view().as_ref() != Some(&own)
            || reissued.borrow().contains(download)
        {
            return;
        }
        // WebKitGTK chooses where a page-started download goes before this
        // handler can, so the host cancels it and starts it again itself,
        // on an object it holds before any byte arrives.
        download.cancel();
        let Some(url) = download_url(download).filter(|u| matches!(u.scheme(), "http" | "https"))
        else {
            log::info!("[browser-agent] download cancelled reason=unsupported_source");
            return;
        };
        reissuing.set(true);
        let again = own.download_uri(url.as_str());
        reissuing.set(false);
        let Some(again) = again else {
            return;
        };
        reissued.borrow_mut().push(again.clone());
        take_download(&again, &url, &events, reissued.clone());
    });
    let handler = RefCell::new(Some(handler));
    webview.connect_destroy(move |_| {
        if let Some(handler) = handler.take() {
            context.disconnect(handler);
        }
    });
}

/// Write `download` only where the host says, and report how it ended.
fn take_download(
    download: &Download,
    url: &Url,
    events: &TabEvents,
    reissued: Rc<RefCell<Vec<Download>>>,
) {
    let Some(path) = events.download_starting(url, Path::new("")) else {
        reissued.borrow_mut().retain(|d| d != download);
        download.cancel();
        return;
    };
    let destination = path.to_string_lossy().into_owned();
    let announced = events.clone();
    let announced_url = url.clone();
    download.connect_decide_destination(move |download, _| {
        // The response is in by now: a length past the cap is refused
        // before any byte lands.
        let length = download.response().map_or(0, |r| r.content_length());
        let size = DownloadSize {
            received: 0,
            announced: Some(length),
        };
        if !announced.download_progress(&announced_url, size) {
            download.cancel();
            return true;
        }
        download.set_destination(&destination);
        true
    });
    // Set once the download is cancelled or finished: nothing more to check.
    let ended = Rc::new(Cell::new(false));
    let check = {
        let events = events.clone();
        let url = url.clone();
        let ended = ended.clone();
        move |download: &Download| {
            let size = DownloadSize {
                received: download.received_data_length(),
                announced: None,
            };
            if !ended.get() && !events.download_progress(&url, size) {
                ended.set(true);
                download.cancel();
            }
        }
    };
    let on_data = check.clone();
    download.connect_received_data(move |download, _| on_data(download));
    // While no byte arrives, the host's idle timeout and deadline still run.
    let ticking = download.clone();
    let tick_ended = ended.clone();
    let _ = gtk::glib::timeout_add_seconds_local(1, move || {
        check(&ticking);
        if tick_ended.get() {
            ControlFlow::Break
        } else {
            ControlFlow::Continue
        }
    });
    let failed = Rc::new(Cell::new(false));
    let failed_flag = failed.clone();
    download.connect_failed(move |_, _| failed_flag.set(true));
    let finished = events.clone();
    let url = url.clone();
    download.connect_finished(move |download| {
        ended.set(true);
        reissued.borrow_mut().retain(|d| d != download);
        finished.download_finished(&url, !failed.get());
    });
}
