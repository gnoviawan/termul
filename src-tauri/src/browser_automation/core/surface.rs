//! The tab surface the core drives: building, navigating and closing tab
//! webviews, projecting registry changes to the renderer, and the app-data
//! roots it writes under. The browser pane's tab manager on the desktop, a
//! fake in tests.

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, Url};

use super::events::TabProjection;
use crate::browser_automation::engine::events::TabEvents;
use crate::browser_automation::engine::profile::{self, DataStore};
use crate::browser_automation::engine::Support;
use crate::browser_tab_manager::{BrowserBounds, BrowserTabManager};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryStep {
    Back,
    Forward,
    Reload,
}

pub type SurfaceFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait TabSurface: Send + Sync {
    /// Build `label` at `url` on `store` with the engine hooks publishing
    /// into `events`; resolves once the engine confirmed the webview.
    fn create<'a>(
        &'a self,
        label: &'a str,
        url: &'a str,
        bounds: BrowserBounds,
        events: TabEvents,
        store: DataStore,
    ) -> SurfaceFuture<'a, Result<(), String>>;
    fn navigate(&self, tab: &str, url: String) -> Result<(), String>;
    fn history(&self, tab: &str, step: HistoryStep) -> Result<(), String>;
    /// The host perimeter's verdict for one navigation hop of `tab`. Runs
    /// on the UI thread inside the engine's navigation hook.
    fn allows_navigation(&self, tab: &str, url: &Url) -> bool;
    /// Close the webview; resolves once the engine destroyed it and the
    /// close was published on the tab's event stream.
    fn close<'a>(&'a self, tab: &'a str) -> SurfaceFuture<'a, ()>;
    fn publish(&self, projection: &TabProjection);
    /// A user tab finished loading a page.
    fn user_page_loaded(&self, tab: &str);
    /// Where screenshots are written.
    fn artifacts_root(&self) -> Result<PathBuf, String>;
    /// Root of the per-session directories teardown deletes and the
    /// startup sweep clears.
    fn session_data_root(&self) -> Result<PathBuf, String>;
    /// Whether the engine can keep the global agent profile.
    fn persistent_profile(&self) -> Support;
    /// Delete the global agent profile's data. No webview uses it.
    fn wipe_global_profile(&self) -> SurfaceFuture<'_, Result<(), String>>;
}

const MAIN_WEBVIEW: &str = "main";

/// The desktop browser pane.
pub struct PaneSurface {
    pub app: AppHandle,
    pub tabs: Arc<BrowserTabManager>,
}

impl PaneSurface {
    fn app_data(&self, dir: &str) -> Result<PathBuf, String> {
        self.app
            .path()
            .app_data_dir()
            .map(|root| root.join(dir))
            .map_err(|e| format!("app_data_dir: {e}"))
    }
}

impl TabSurface for PaneSurface {
    fn create<'a>(
        &'a self,
        label: &'a str,
        url: &'a str,
        bounds: BrowserBounds,
        events: TabEvents,
        store: DataStore,
    ) -> SurfaceFuture<'a, Result<(), String>> {
        Box::pin(
            self.tabs
                .create(label.to_string(), url.to_string(), bounds, events, store),
        )
    }

    fn navigate(&self, tab: &str, url: String) -> Result<(), String> {
        self.tabs.navigate(tab, url)
    }

    fn history(&self, tab: &str, step: HistoryStep) -> Result<(), String> {
        match step {
            HistoryStep::Back => self.tabs.go_back(tab),
            HistoryStep::Forward => self.tabs.go_forward(tab),
            HistoryStep::Reload => self.tabs.reload(tab),
        }
    }

    fn allows_navigation(&self, tab: &str, url: &Url) -> bool {
        crate::host_perimeter::allow_tab_navigation(&self.app, tab, url)
    }

    fn close<'a>(&'a self, tab: &'a str) -> SurfaceFuture<'a, ()> {
        Box::pin(self.tabs.destroy(tab))
    }

    fn publish(&self, projection: &TabProjection) {
        // Only the app window: tab webviews must not learn other tabs' URLs.
        let name = projection.event_name();
        let sent = match projection {
            TabProjection::Updated(view) => self.app.emit_to(MAIN_WEBVIEW, name, view),
            TabProjection::Closed { tab_id } => {
                self.app
                    .emit_to(MAIN_WEBVIEW, name, serde_json::json!({ "tabId": tab_id }))
            }
        };
        if sent.is_err() {
            log::warn!("[browser-tab] {} not delivered to the renderer", projection.event_name());
        }
    }

    fn user_page_loaded(&self, tab: &str) {
        self.tabs.inject_agentation_after_load(tab);
    }

    fn artifacts_root(&self) -> Result<PathBuf, String> {
        self.app_data("browser-artifacts")
    }

    fn session_data_root(&self) -> Result<PathBuf, String> {
        self.app_data("browser-sessions")
    }

    fn persistent_profile(&self) -> Support {
        profile::persistent_profile_support()
    }

    fn wipe_global_profile(&self) -> SurfaceFuture<'_, Result<(), String>> {
        Box::pin(self.tabs.wipe_global_profile())
    }
}
