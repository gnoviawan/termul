//! WebKitGTK request observation on agent tabs: `resource-load-started`
//! for the main resource and every subresource, closed by the resource's
//! `finished` signal (after `failed` when the load failed). The engine
//! reports no resource type and no redirect hops, so an entry carries
//! neither: a redirected load is one entry for its final URL.

use std::cell::Cell;
use std::rc::Rc;
use std::time::Instant;

use webkit2gtk::{URIRequestExt, URIResponseExt, WebResourceExt, WebView, WebViewExt};

use crate::browser_automation::engine::events::{TabEvent, TabEvents};
use crate::browser_automation::engine::observe::{strip_url, NetworkEntry};

pub fn attach(webview: &WebView, events: TabEvents) {
    webview.connect_resource_load_started(move |_, resource, request| {
        let method: String = request
            .http_method()
            .map_or_else(|| "GET".to_string(), |m| m.chars().take(16).collect());
        let started = Instant::now();
        let failed = Rc::new(Cell::new(false));
        let mark = failed.clone();
        resource.connect_failed(move |_, _| mark.set(true));
        let events = events.clone();
        resource.connect_finished(move |resource| {
            let status = resource
                .response()
                .map(|r| r.status_code())
                .and_then(|s| u16::try_from(s).ok())
                .filter(|s| *s > 0);
            let url = resource.uri().map(|u| strip_url(&u)).unwrap_or_default();
            events.publish(TabEvent::Network(NetworkEntry {
                method: method.clone(),
                url,
                status,
                resource: None,
                duration_ms: u64::try_from(started.elapsed().as_millis()).ok(),
                failed: failed.get(),
            }));
        });
    });
}
