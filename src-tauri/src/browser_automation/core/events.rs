//! Consumes the engine's per-tab event streams: each event updates the
//! tab registry (epoch, URL, title, loading, waiting navigations, script
//! dialogs) and the renderer gets the new tab state as a projection.
//! Dialogs and popups then get their host side effects.

use std::sync::{Arc, Weak};

use parking_lot::Mutex;
use tokio::sync::mpsc::UnboundedReceiver;

use super::dialogs::Disposition;
use super::page_events::log_external_launch;
use super::surface::TabSurface;
use super::tabs::{Owner, TabRegistry, TabView};
use super::DesktopBrowserHost;
use crate::acp::events as acp_events;
use crate::browser_automation::engine::events::{DialogKind, TabEvent};
use crate::web::EventSink;

/// What the renderer mirrors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TabProjection {
    Updated(TabView),
    Closed { tab_id: String },
}

impl TabProjection {
    /// The desktop renderer's event name.
    pub fn event_name(&self) -> &'static str {
        match self {
            TabProjection::Updated(_) => "browser_tab_updated",
            TabProjection::Closed { .. } => "browser_tab_closed",
        }
    }

    /// The session-stream event name, for agent tabs.
    fn session_event_name(&self) -> &'static str {
        match self {
            TabProjection::Updated(_) => "acp:browser_tab_updated",
            TabProjection::Closed { .. } => "acp:browser_tab_closed",
        }
    }
}

/// The outcome of one event, for the consumer's side effects.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Applied {
    Projected {
        projection: TabProjection,
        /// The owning session of an agent tab.
        session: Option<String>,
    },
    /// A user tab finished a load: page-load extras may run on it.
    UserPageLoaded(TabView),
    /// The engine holds a dialog; the registry decided what happens to it.
    Dialog {
        id: u64,
        kind: DialogKind,
        disposition: Disposition,
    },
    /// An agent tab's page asked for a new window.
    NewWindow { session: String, url: String },
    Ignored,
}

/// Send a registry change to the desktop renderer and, for an agent tab,
/// down its session's stream to every client.
pub(super) fn publish(
    surface: &dyn TabSurface,
    sinks: &[Arc<dyn EventSink>],
    session: Option<&str>,
    projection: &TabProjection,
) {
    surface.publish(projection);
    let Some(session) = session else {
        return;
    };
    let name = projection.session_event_name();
    match projection {
        TabProjection::Updated(view) => acp_events::fan_out(sinks, Some(session), name, view),
        TabProjection::Closed { tab_id } => acp_events::fan_out(
            sinks,
            Some(session),
            name,
            &serde_json::json!({ "tabId": tab_id }),
        ),
    }
}

/// Apply one event to the registry. Events for unknown labels (a tab
/// already closed) are dropped.
pub(super) fn apply(registry: &mut TabRegistry, label: &str, event: TabEvent) -> Applied {
    if let TabEvent::Closed = event {
        return match registry.remove(label) {
            Some(record) => Applied::Projected {
                projection: TabProjection::Closed {
                    tab_id: label.to_string(),
                },
                session: record.session_id().map(str::to_string),
            },
            None => Applied::Ignored,
        };
    }
    if let TabEvent::ExternalProtocolBlocked = event {
        log_external_launch(label);
        return Applied::Ignored;
    }
    let Some(record) = registry.get_mut(label) else {
        return Applied::Ignored;
    };
    match event {
        TabEvent::Console(entry) => {
            record.observed.console.push(record.epoch, entry);
            Applied::Ignored
        }
        TabEvent::Network(entry) => {
            record.observed.network.push(record.epoch, entry);
            Applied::Ignored
        }
        TabEvent::DialogOpened {
            id,
            kind,
            message,
            default_text,
        } => {
            let navigating = record.agent_navigating();
            let disposition = record
                .dialogs
                .opened(id, kind, &message, default_text.as_deref(), navigating);
            Applied::Dialog {
                id,
                kind,
                disposition,
            }
        }
        TabEvent::NewWindowRequested { url } => {
            match record.session_id() {
                Some(session) if record.is_live() => Applied::NewWindow {
                    session: session.to_string(),
                    url,
                },
                _ => Applied::Ignored,
            }
        }
        event => apply_navigation(registry, label, event),
    }
}

/// Navigation, load and title events: they change what the renderer shows.
fn apply_navigation(registry: &mut TabRegistry, label: &str, event: TabEvent) -> Applied {
    let Some(record) = registry.get_mut(label) else {
        return Applied::Ignored;
    };
    let finished_user_load = matches!(event, TabEvent::LoadFinished) && record.owner == Owner::User;
    let session = record.session_id().map(str::to_string);
    match event {
        TabEvent::NavStarting {
            nav_id, verdict, ..
        } => record.nav_starting(nav_id, verdict),
        TabEvent::NavCommitted { nav_id, kind, url } => record.committed(nav_id, kind, &url),
        TabEvent::LoadFinished => record.load_finished(),
        TabEvent::TitleChanged { title } => record.title = title,
        TabEvent::Closed
        | TabEvent::DialogOpened { .. }
        | TabEvent::NewWindowRequested { .. }
        | TabEvent::Console(_)
        | TabEvent::Network(_)
        | TabEvent::ExternalProtocolBlocked => unreachable!("handled by apply"),
    }
    let Some(view) = registry.view(label) else {
        return Applied::Ignored;
    };
    if finished_user_load {
        Applied::UserPageLoaded(view)
    } else {
        Applied::Projected {
            projection: TabProjection::Updated(view),
            session,
        }
    }
}

/// Drain the event channel until every sender is gone.
pub(super) async fn consume(
    mut rx: UnboundedReceiver<(String, TabEvent)>,
    registry: Arc<Mutex<TabRegistry>>,
    surface: Arc<dyn TabSurface>,
    sinks: Vec<Arc<dyn EventSink>>,
    host: Weak<DesktopBrowserHost>,
) {
    while let Some((label, event)) = rx.recv().await {
        let kind = event_kind(&event);
        let applied = apply(&mut registry.lock(), &label, event);
        // Observations arrive per request and per message: too many to log.
        if !matches!(kind, "console" | "network") {
            log::debug!("[browser-tab] {kind} on tab {}", label_prefix(&label));
        }
        match applied {
            Applied::Projected {
                projection,
                session,
            } => {
                publish(surface.as_ref(), &sinks, session.as_deref(), &projection);
            }
            Applied::UserPageLoaded(view) => {
                surface.publish(&TabProjection::Updated(view));
                surface.user_page_loaded(&label);
            }
            Applied::Dialog {
                id,
                kind,
                disposition,
            } => {
                if let Some(host) = host.upgrade() {
                    host.on_dialog(&label, id, kind, disposition);
                }
            }
            Applied::NewWindow { session, url } => {
                if let Some(host) = host.upgrade() {
                    host.on_new_window(&label, &session, &url);
                }
            }
            Applied::Ignored => {}
        }
    }
}

fn event_kind(event: &TabEvent) -> &'static str {
    match event {
        TabEvent::NavStarting { .. } => "nav_starting",
        TabEvent::NavCommitted { .. } => "nav_committed",
        TabEvent::LoadFinished => "load_finished",
        TabEvent::TitleChanged { .. } => "title_changed",
        TabEvent::Closed => "closed",
        TabEvent::DialogOpened { .. } => "dialog_opened",
        TabEvent::NewWindowRequested { .. } => "new_window_requested",
        TabEvent::ExternalProtocolBlocked => "external_protocol_blocked",
        TabEvent::Console(_) => "console",
        TabEvent::Network(_) => "network",
    }
}

/// `agent-1a2b3c4d…`: enough to correlate log lines, no more.
pub(super) fn label_prefix(label: &str) -> &str {
    let cut = label.char_indices().nth(14).map_or(label.len(), |(i, _)| i);
    &label[..cut]
}

#[cfg(test)]
#[path = "events_tests.rs"]
mod tests;
