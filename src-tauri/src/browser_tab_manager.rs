//! Native webviews for browser tabs: building them with the engine's
//! hooks, confirming the engine really created them, placing, showing and
//! closing them. Tab state (owner, epoch, URL, title) lives in the
//! automation core's tab registry; this module only drives webviews.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

use crate::browser_automation::engine::profile::{self, AgentProfiles, DataStore};
use crate::browser_automation::engine::{events::TabEvents, hooks};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabInfo {
    pub id: String,
    pub url: String,
    pub title: String,
    /// True while an ACP session is driving this tab via the `browser` tool
    /// (`browser_automation`). The renderer shows an "Agent" badge and a
    /// revoke control; user-close revokes control.
    #[serde(default)]
    pub agent_controlled: bool,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub struct BrowserTabManager {
    app_handle: AppHandle,
    /// Event channel of every webview this manager built, by label.
    tabs: Arc<Mutex<HashMap<String, TabEvents>>>,
    /// The agent profiles under app data; agent tabs are refused without.
    profiles: Result<Arc<AgentProfiles>, String>,
    agentation_endpoint: Arc<Mutex<Option<String>>>,
    agentation_enabled: Arc<Mutex<bool>>,
    #[cfg(windows)]
    saved_grants: crate::browser_tab_saved_grants::ClearOnce,
}

impl BrowserTabManager {
    pub fn new(app_handle: AppHandle) -> Self {
        let profiles = open_profiles(&app_handle);
        Self {
            app_handle,
            tabs: Arc::new(Mutex::new(HashMap::new())),
            profiles,

            agentation_endpoint: Arc::new(Mutex::new(None)),
            agentation_enabled: Arc::new(Mutex::new(true)),
            #[cfg(windows)]
            saved_grants: crate::browser_tab_saved_grants::ClearOnce::default(),
        }
    }

    fn get_window(&self) -> Result<tauri::Window, String> {
        self.app_handle
            .get_window("main")
            .ok_or_else(|| "Main window not found".to_string())
    }

    fn get_webview(&self, tab_id: &str) -> Result<tauri::Webview, String> {
        self.app_handle
            .get_webview(tab_id)
            .ok_or_else(|| format!("Webview '{}' not found", tab_id))
    }

    /// Webview handle for in-crate callers (browser_automation eval/CDP).
    pub(crate) fn webview(&self, tab_id: &str) -> Result<tauri::Webview, String> {
        self.get_webview(tab_id)
    }

    /// Build the tab's webview on `store` with the builder hooks installed,
    /// then confirm the engine created it and attach the adapter's own
    /// hooks. Those come after the first navigation started, which is why
    /// the core builds agent tabs at `about:blank`. A webview the engine
    /// failed to build is closed and the tab refused.
    pub async fn create(
        &self,
        tab_id: String,
        url: String,
        bounds: BrowserBounds,
        events: TabEvents,
        store: DataStore,
    ) -> Result<(), String> {
        let window = self.get_window()?;
        let parsed_url: tauri::Url = url.parse().map_err(|e| format!("Invalid URL: {}", e))?;
        crate::host_perimeter::check_tab_target(&self.app_handle, &tab_id, &parsed_url)?;

        // User tabs share the app's profile, so clearing through the main
        // webview resets saved site grants before the first user tab loads a
        // page. The app UI's own origin keeps its grants.
        #[cfg(windows)]
        if let (DataStore::App, Some(main)) = (&store, self.app_handle.get_webview("main")) {
            use crate::browser_tab_saved_grants::{clear_saved_grants, ClearError};
            let app_origin = main
                .url()
                .map(|url| url.origin().ascii_serialization())
                .unwrap_or_default();
            match self
                .saved_grants
                .run(|| clear_saved_grants(&main, app_origin))
                .await
            {
                Some(Ok(report)) if report.reset > 0 => log::warn!(
                    "[BrowserTab] reset {} saved web permission grants before opening tab={}",
                    report.reset,
                    tab_id
                ),
                Some(Err(ClearError::Unsupported)) => log::warn!(
                    "[BrowserTab] webview runtime cannot clear saved web permissions; tab={}",
                    tab_id
                ),
                Some(Err(ClearError::Failed)) => log::warn!(
                    "[BrowserTab] could not clear saved web permissions, the next tab retries; tab={}",
                    tab_id
                ),
                Some(Ok(_)) | None => {}
            }
        }

        let mut builder = tauri::webview::WebviewBuilder::new(
            tab_id.clone(),
            tauri::WebviewUrl::External(parsed_url),
        )
        .on_permission_request(crate::browser_tab_permissions::on_permission_request);
        builder = hooks::install(builder, &events);

        // Inject agentation globals via initialization_script (runs before page JS).
        // The toolbar bundle itself is injected via eval AFTER page load,
        // because the agentation library accesses document.head at module
        // top-level — initialization_script runs before DOM exists.
        let (endpoint, enabled) = {
            let ep = self
                .agentation_endpoint
                .lock()
                .map_err(|_| "Lock poisoned")?
                .clone();
            let en = *self
                .agentation_enabled
                .lock()
                .map_err(|_| "Lock poisoned")?;
            (ep, en)
        };
        if enabled && crate::host_perimeter::agentation_allowed(&tab_id) {
            if let Some(endpoint_url) = &endpoint {
                let init_script = format!(
                    r#"
                    window.__TERMUL_AGENTATION_ENDPOINT__ = "{endpoint_url}";
                    window.__TERMUL_ANNOTATION_MODE__ = true;
                    "#
                );
                builder = builder.initialization_script(&init_script);
                log::info!("[BrowserTab] Agentation init script set for tab={tab_id}");
            }
        }

        if store != DataStore::App {
            let profiles = self.profiles.as_ref().map_err(Clone::clone)?;
            builder = profiles.configure(builder, &tab_id, &store)?;
        }
        match self.mount(&window, builder, &tab_id, bounds, events.clone()).await {
            Ok(webview) => {
                if let Ok(profiles) = &self.profiles {
                    profiles.built(&webview, &tab_id, &store).await;
                }
            }
            Err(error) => {
                self.release_profile(&tab_id);
                return Err(error);
            }
        }
        self.tabs
            .lock()
            .map_err(|_| "Lock poisoned")?
            .insert(tab_id, events);
        Ok(())
    }

    fn release_profile(&self, tab_id: &str) {
        if let Ok(profiles) = &self.profiles {
            profiles.dropped(&self.app_handle, tab_id);
        }
    }

    /// Clear the global agent profile. No webview may use it any more.
    pub async fn wipe_global_profile(&self) -> Result<(), String> {
        let profiles = self.profiles.as_ref().map_err(Clone::clone)?;
        profiles.wipe_global(&self.app_handle).await
    }

    /// Add the built webview to the window and confirm the engine created it.
    async fn mount(
        &self,
        window: &tauri::Window,
        builder: tauri::webview::WebviewBuilder<tauri::Wry>,
        tab_id: &str,
        bounds: BrowserBounds,
        events: TabEvents,
    ) -> Result<tauri::Webview, String> {
        let _webview = window
            .add_child(
                builder,
                tauri::LogicalPosition::new(bounds.x, bounds.y),
                tauri::LogicalSize::new(bounds.width, bounds.height),
            )
            .map_err(|e| format!("Failed to create webview: {}", e))?;

        #[cfg(target_os = "linux")]
        {
            // Confirm the main webview still exists before changing the GTK hierarchy.
            if window.get_webview("main").is_none() {
                let _ = _webview.close();
                return Err("Main webview not found".to_string());
            }

            let (reparent_tx, reparent_rx) = tokio::sync::oneshot::channel();
            let reparent_bounds = bounds.clone();
            let dispatch_result = _webview.with_webview(move |child_platform| {
                let result = (|| -> Result<(), String> {
                    use gtk::prelude::*;

                    let child_widget = child_platform.inner();
                    let parent = child_widget
                        .parent()
                        .ok_or_else(|| "Child webview has no parent".to_string())?;
                    let vbox = parent
                        .dynamic_cast::<gtk::Box>()
                        .map_err(|_| "Child webview parent is not GtkBox".to_string())?;

                    // On first creation the main and child webviews are siblings in the
                    // window's default GtkBox. Later tabs reuse the overlay already placed
                    // beside the newly-created child, so no GTK handle crosses callbacks.
                    vbox.remove(&child_widget);
                    let overlay = if let Some(existing) = vbox
                        .children()
                        .into_iter()
                        .find_map(|widget| widget.dynamic_cast::<gtk::Overlay>().ok())
                    {
                        existing
                    } else {
                        let main_widget = vbox
                            .children()
                            .into_iter()
                            .find(|widget| widget.type_().name() == "WebKitWebView")
                            .ok_or_else(|| "Main GTK webview widget not found".to_string())?;
                        let overlay = gtk::Overlay::new();
                        overlay.set_hexpand(true);
                        overlay.set_vexpand(true);
                        main_widget.set_hexpand(true);
                        main_widget.set_vexpand(true);
                        vbox.remove(&main_widget);
                        vbox.pack_start(&overlay, true, true, 0);
                        overlay.add(&main_widget);
                        main_widget.show();
                        overlay.show();
                        overlay
                    };

                    child_widget.set_halign(gtk::Align::Start);
                    child_widget.set_valign(gtk::Align::Start);
                    child_widget.set_margin_start(reparent_bounds.x.round() as i32);
                    child_widget.set_margin_top(reparent_bounds.y.round() as i32);
                    child_widget.set_size_request(
                        reparent_bounds.width.round() as i32,
                        reparent_bounds.height.round() as i32,
                    );
                    overlay.add_overlay(&child_widget);
                    child_widget.show();
                    overlay.show();
                    Ok(())
                })();

                let _ = reparent_tx.send(result);
            });

            if let Err(error) = dispatch_result {
                let _ = _webview.close();
                return Err(format!("Failed to dispatch Linux GTK reparent: {error}"));
            }

            match reparent_rx.await {
                Ok(Ok(())) => {
                    log::info!("[BrowserTab] Linux GTK reparent succeeded");
                }
                Ok(Err(error)) => {
                    let _ = _webview.close();
                    return Err(format!("Linux GTK reparent failed: {error}"));
                }
                Err(error) => {
                    let _ = _webview.close();
                    return Err(format!("Linux GTK reparent callback canceled: {error}"));
                }
            }
        }

        if let Err(error) = hooks::attach(&_webview, events).await {
            let _ = _webview.close();
            log::warn!("[BrowserTab] tab {tab_id} refused: engine did not confirm the webview ({error})");
            return Err(format!("the browser engine did not create the tab: {error}"));
        }
        Ok(_webview)
    }

    pub fn navigate(&self, tab_id: &str, url: String) -> Result<(), String> {
        let webview = self.get_webview(tab_id)?;
        let parsed_url: tauri::Url = url.parse().map_err(|e| format!("Invalid URL: {}", e))?;
        crate::host_perimeter::check_tab_target(&self.app_handle, tab_id, &parsed_url)?;
        webview
            .navigate(parsed_url)
            .map_err(|e| format!("Navigation failed: {}", e))?;
        Ok(())
    }

    pub fn resize(&self, tab_id: &str, bounds: BrowserBounds) -> Result<(), String> {
        let webview = self.get_webview(tab_id)?;

        #[cfg(target_os = "linux")]
        {
            webview
                .with_webview(move |child_platform| {
                    use gtk::prelude::*;
                    let child_widget = child_platform.inner();
                    child_widget.set_margin_start(bounds.x.round() as i32);
                    child_widget.set_margin_top(bounds.y.round() as i32);
                    child_widget.set_size_request(
                        bounds.width.round() as i32,
                        bounds.height.round() as i32,
                    );
                    child_widget.queue_resize();
                })
                .map_err(|e| format!("Resize dispatch failed: {e}"))?;
            Ok(())
        }

        #[cfg(not(target_os = "linux"))]
        {
            webview
                .set_bounds(tauri::Rect {
                    position: tauri::LogicalPosition::new(bounds.x, bounds.y).into(),
                    size: tauri::LogicalSize::new(bounds.width, bounds.height).into(),
                })
                .map_err(|e| format!("Resize failed: {}", e))?;
            Ok(())
        }
    }

    pub fn show(&self, tab_id: &str) -> Result<(), String> {
        let webview = self.get_webview(tab_id)?;

        #[cfg(target_os = "linux")]
        {
            webview
                .with_webview(move |child_platform| {
                    use gtk::prelude::*;
                    let child_widget = child_platform.inner();
                    child_widget.show();
                })
                .map_err(|e| format!("Show dispatch failed: {e}"))?;
        }

        webview.show().map_err(|e| format!("Show failed: {}", e))?;
        Ok(())
    }

    pub fn hide(&self, tab_id: &str) -> Result<(), String> {
        let webview = self.get_webview(tab_id)?;

        #[cfg(target_os = "linux")]
        {
            webview
                .with_webview(move |child_platform| {
                    use gtk::prelude::*;
                    let child_widget = child_platform.inner();
                    child_widget.hide();
                })
                .map_err(|e| format!("Hide dispatch failed: {e}"))?;
        }

        webview.hide().map_err(|e| format!("Hide failed: {}", e))?;
        Ok(())
    }

    /// Set the agentation HTTP endpoint (called when the Rust server starts).
    /// This makes the endpoint available for injection into new browser tabs.
    pub fn set_agentation_endpoint(&self, endpoint: String) {
        let mut ep = self
            .agentation_endpoint
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        *ep = Some(endpoint);
    }

    /// Enable/disable agentation annotation mode (feature flag from AppPreferences).
    pub fn set_agentation_enabled(&self, enabled: bool) {
        let mut en = self
            .agentation_enabled
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        *en = enabled;
    }

    /// Check if agentation mode is enabled.
    pub fn is_agentation_enabled(&self) -> bool {
        *self
            .agentation_enabled
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    /// Inject the agentation toolbar bundle into a browser tab via eval.
    /// Runs after a page load because the agentation library accesses
    /// document.head at module top-level.
    pub fn inject_agentation_toolbar(&self, tab_id: &str) -> Result<(), String> {
        if !crate::host_perimeter::agentation_allowed(tab_id) {
            return Err("Agentation is not available in agent tabs".to_string());
        }
        let webview = self.get_webview(tab_id)?;

        // Inject the agentation toolbar bundle (bundled IIFE).
        // The bundle self-checks __TERMUL_AGENTATION_HOST__ to avoid double-mount.
        let toolbar_script = include_str!("../resources/agentation-toolbar.js");
        webview
            .eval(toolbar_script)
            .map_err(|e| format!("Failed to inject agentation toolbar: {}", e))?;

        log::info!(
            "[BrowserTab] Agentation toolbar injected (post-load) for tab={}",
            tab_id
        );
        Ok(())
    }

    /// The toolbar's post-load injection on user tabs, when enabled.
    pub(crate) fn inject_agentation_after_load(&self, tab_id: &str) {
        if !self.is_agentation_enabled() {
            return;
        }
        if let Err(e) = self.inject_agentation_toolbar(tab_id) {
            log::warn!("[BrowserTab] Agentation toolbar injection failed for tab={tab_id}: {e}");
        }
    }

    /// Close the tab's webview and wait until the engine has destroyed it,
    /// then publish the close on the tab's event stream. A no-op for
    /// labels this manager never built.
    pub async fn destroy(&self, tab_id: &str) {
        let events = self
            .tabs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(tab_id);
        let Some(events) = events else {
            return;
        };
        if let Ok(webview) = self.get_webview(tab_id) {
            #[cfg(target_os = "linux")]
            {
                let _ = webview.with_webview(move |child_platform| {
                    use gtk::prelude::*;
                    let child_widget = child_platform.inner();
                    if let Some(parent) = child_widget.parent() {
                        if let Ok(overlay) = parent.dynamic_cast::<gtk::Overlay>() {
                            overlay.remove(&child_widget);
                        }
                    }
                });
            }
            hooks::close(&webview).await;
        }
        self.release_profile(tab_id);
        events.publish(crate::browser_automation::engine::events::TabEvent::Closed);
    }

    pub fn go_back(&self, tab_id: &str) -> Result<(), String> {
        let webview = self.get_webview(tab_id)?;
        step_history(&webview, HistoryDirection::Back).map_err(|e| format!("Go back failed: {}", e))
    }

    pub fn go_forward(&self, tab_id: &str) -> Result<(), String> {
        let webview = self.get_webview(tab_id)?;
        step_history(&webview, HistoryDirection::Forward)
            .map_err(|e| format!("Go forward failed: {}", e))
    }

    pub fn reload(&self, tab_id: &str) -> Result<(), String> {
        let webview = self.get_webview(tab_id)?;
        webview
            .reload()
            .map_err(|e| format!("Reload failed: {}", e))?;
        Ok(())
    }

    /// Open DevTools for the webview backing this browser tab.
    ///
    /// Debug-gated: only exists in debug builds. In release builds, the
    /// `browser_tab_open_devtools` Tauri command is a cfg-gated stub that
    /// returns `Ok(IpcResult::error("DevTools disabled in production", ...))`
    /// directly — it never calls this method, so there's no release stub
    /// (avoids dead_code).
    /// The desktop "Toggle DevTools" menu item is already debug-gated
    /// separately in `lib.rs`.
    #[cfg(debug_assertions)]
    pub fn open_devtools(&self, tab_id: &str) -> Result<(), String> {
        let webview = self.get_webview(tab_id)?;
        webview.open_devtools();
        Ok(())
    }

    pub fn destroy_all(&self) {
        let mut tabs = self.tabs.lock().unwrap_or_else(|e| e.into_inner());
        let ids: Vec<String> = tabs.keys().cloned().collect();

        #[cfg(target_os = "linux")]
        {
            for id in &ids {
                if let Ok(webview) = self.get_webview(id) {
                    let _ = webview.with_webview(move |child_platform| {
                        use gtk::prelude::*;
                        let child_widget = child_platform.inner();
                        if let Some(parent) = child_widget.parent() {
                            if let Ok(overlay) = parent.dynamic_cast::<gtk::Overlay>() {
                                overlay.remove(&child_widget);
                            }
                        }
                    });
                }
            }
        }

        for id in ids {
            if let Ok(webview) = self.get_webview(&id) {
                let _ = webview.close();
            }
            self.release_profile(&id);
        }
        tabs.clear();
    }
}

/// Open the agent profiles under app data and delete what an earlier run
/// left of retired global generations.
fn open_profiles(app: &AppHandle) -> Result<Arc<AgentProfiles>, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join(profile::GLOBAL_ROOT);
    let profiles = AgentProfiles::open(root).map(Arc::new).map_err(|e| {
        log::error!("[BrowserTab] agent profile unavailable; agent tabs are refused: {e}");
        format!("the agent browser profile is unavailable: {e}")
    })?;
    let sweeping = profiles.clone();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let removed = sweeping.sweep(&handle).await;
        if removed > 0 {
            log::info!("[BrowserTab] removed {removed} retired agent profile generation(s)");
        }
    });
    Ok(profiles)
}

impl Drop for BrowserTabManager {
    fn drop(&mut self) {
        self.destroy_all();
    }
}

#[derive(Debug, Clone, Copy)]
enum HistoryDirection {
    Back,
    Forward,
}

/// Move the tab along the engine's own back-forward list. Page script
/// cannot intercept it the way it can `window.history`.
fn step_history(webview: &tauri::Webview, direction: HistoryDirection) -> tauri::Result<()> {
    webview.with_webview(move |platform| native_history(&platform, direction))
}

#[cfg(target_os = "windows")]
fn native_history(platform: &tauri::webview::PlatformWebview, direction: HistoryDirection) {
    // SAFETY: this closure runs on the UI thread that owns the WebView2
    // COM objects.
    let stepped = unsafe {
        platform.controller().CoreWebView2().and_then(|core| match direction {
            HistoryDirection::Back => core.GoBack(),
            HistoryDirection::Forward => core.GoForward(),
        })
    };
    if stepped.is_err() {
        log::warn!("[BrowserTab] WebView2 history step ({direction:?}) failed");
    }
}

#[cfg(target_os = "macos")]
fn native_history(platform: &tauri::webview::PlatformWebview, direction: HistoryDirection) {
    use objc2_web_kit::WKWebView;
    // SAFETY: tauri hands out the tab's live WKWebView, and this closure
    // runs on the main thread that owns it.
    let webview = unsafe { &*platform.inner().cast::<WKWebView>() };
    // SAFETY: main thread, as above. A missing history item returns nil,
    // so there is nothing to report.
    let _ = unsafe {
        match direction {
            HistoryDirection::Back => webview.goBack(),
            HistoryDirection::Forward => webview.goForward(),
        }
    };
}

#[cfg(target_os = "linux")]
fn native_history(platform: &tauri::webview::PlatformWebview, direction: HistoryDirection) {
    use webkit2gtk::WebViewExt;
    let webview = platform.inner();
    match direction {
        HistoryDirection::Back => webview.go_back(),
        HistoryDirection::Forward => webview.go_forward(),
    }
}
