use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabInfo {
    pub id: String,
    pub url: String,
    pub title: String,
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
    tabs: Arc<Mutex<HashMap<String, BrowserTabInfo>>>,
    agentation_endpoint: Arc<Mutex<Option<String>>>,
    agentation_enabled: Arc<Mutex<bool>>,
}

impl BrowserTabManager {
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            app_handle,
            tabs: Arc::new(Mutex::new(HashMap::new())),

            agentation_endpoint: Arc::new(Mutex::new(None)),
            agentation_enabled: Arc::new(Mutex::new(false)),
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

    fn start_url_poller(&self, tab_id: String) {
        let app_handle = self.app_handle.clone();
        std::thread::spawn(move || {
            // Wait for webview to fully initialize before injecting scripts
            std::thread::sleep(std::time::Duration::from_millis(1500));

            // Script that polls URL, title and readyState continuously.
            // This is more reliable than window.load for SPAs (React, Vue, Angular).
            let poller_script = format!(
                r#"
                (function() {{
                    if (window.__termul_poller) return;
                    window.__termul_poller = true;

                    var tabId = '{}';
                    var lastUrl = location.href;
                    var lastTitle = '';
                    var lastReady = '';
                    var loadedReported = false;

                    var invoke = function(cmd, args) {{
                        try {{
                            if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {{
                                window.__TAURI_INTERNALS__.invoke(cmd, args);
                                return true;
                            }}
                        }} catch(e) {{}}
                        try {{
                            if (window.__TAURI__ && window.__TAURI__.invoke) {{
                                window.__TAURI__.invoke(cmd, args);
                                return true;
                            }}
                        }} catch(e) {{}}
                        try {{
                            if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {{
                                window.__TAURI__.core.invoke(cmd, args);
                                return true;
                            }}
                        }} catch(e) {{}}
                        return false;
                    }};

                    var reportUrl = function(url) {{
                        invoke('browser_tab_report_url', {{ tabId: tabId, url: url }});
                    }};

                    var reportTitle = function(title) {{
                        invoke('browser_tab_report_title', {{ tabId: tabId, title: title }});
                    }};

                    var reportLoaded = function() {{
                        if (loadedReported) return;
                        loadedReported = true;
                        invoke('browser_tab_report_loaded', {{ tabId: tabId }});
                    }};

                    var check = function() {{
                        var url = location.href;
                        var ready = document.readyState;
                        var title = document.title || '';

                        // Report URL change
                        if (url !== lastUrl) {{
                            lastUrl = url;
                            reportUrl(url);
                            // Reset loaded flag on navigation — new page needs to load
                            loadedReported = false;
                            lastReady = '';
                        }}

                        // Report title change
                        if (title !== lastTitle) {{
                            lastTitle = title;
                            reportTitle(title);
                        }}

                        // Report loaded when readyState stabilizes at 'complete'
                        if (ready === 'complete' && lastReady !== 'complete') {{
                            reportLoaded();
                        }}
                        lastReady = ready;
                    }};

                    // Poll every 400ms
                    setInterval(check, 400);

                    // Hook history.pushState for SPA navigation
                    var origPush = history.pushState;
                    var origReplace = history.replaceState;
                    history.pushState = function() {{
                        origPush.apply(this, arguments);
                        setTimeout(check, 50);
                        setTimeout(check, 300);
                    }};
                    history.replaceState = function() {{
                        origReplace.apply(this, arguments);
                        setTimeout(check, 50);
                        setTimeout(check, 300);
                    }};
                    window.addEventListener('popstate', function() {{
                        setTimeout(check, 50);
                        setTimeout(check, 300);
                    }});

                    // Initial check
                    check();
                }})();
                "#,
                tab_id
            );

            // Try to inject the poller script. Retry a few times if webview not ready.
            for attempt in 0..5 {
                match app_handle.get_webview(&tab_id) {
                    Some(webview) => {
                        let _ = webview.eval(&poller_script);
                        log::info!("[BrowserTab] Injected URL poller for tab={} (attempt={})", tab_id, attempt);
                        break;
                    }
                    None => {
                        std::thread::sleep(std::time::Duration::from_millis(500));
                    }
                }
            }

            // Inject agentation toolbar via eval after a delay for DOM readiness.
            // The agentation library accesses document.head at module top-level,
            // so it needs a ready DOM. 3s delay matches the poller's init time.
            let app_handle_clone = app_handle.clone();
            let tab_id_clone = tab_id.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(3000));
                log::info!("[BrowserTab] Agentation delayed injection check for tab={}", tab_id_clone);
                if let Some(bt) = app_handle_clone.try_state::<Arc<BrowserTabManager>>() {
                    let enabled = bt.is_agentation_enabled();
                    log::info!("[BrowserTab] Agentation enabled={} for tab={}", enabled, tab_id_clone);
                    if enabled {
                        match bt.inject_agentation_toolbar(&tab_id_clone) {
                            Ok(()) => {}
                            Err(e) => log::warn!("[BrowserTab] Agentation toolbar eval failed for tab={}: {}", tab_id_clone, e),
                        }
                    }
                } else {
                    log::warn!("[BrowserTab] Could not get BrowserTabManager from state for tab={}", tab_id_clone);
                }
            });
        });
    }

    pub async fn create(
        &self,
        tab_id: String,
        url: String,
        bounds: BrowserBounds,
    ) -> Result<BrowserTabInfo, String> {
        let window = self.get_window()?;
        let parsed_url: tauri::Url = url
            .parse()
            .map_err(|e| format!("Invalid URL: {}", e))?;

        let mut builder = tauri::webview::WebviewBuilder::new(
            tab_id.clone(),
            tauri::WebviewUrl::External(parsed_url),
        );

        // Inject agentation globals via initialization_script (runs before page JS).
        // The toolbar bundle itself is injected via eval AFTER page load,
        // because the agentation library accesses document.head at module
        // top-level — initialization_script runs before DOM exists.
        let (endpoint, enabled) = {
            let ep = self.agentation_endpoint.lock().map_err(|_| "Lock poisoned")?.clone();
            let en = *self.agentation_enabled.lock().map_err(|_| "Lock poisoned")?;
            (ep, en)
        };
        if enabled {
            if let Some(endpoint_url) = &endpoint {
                let init_script = format!(
                    r#"
                    window.__TERMUL_AGENTATION_ENDPOINT__ = "{endpoint_url}";
                    window.__TERMUL_ANNOTATION_MODE__ = true;
                    "#
                );
                builder = builder.initialization_script(&init_script);
                log::info!("[BrowserTab] Agentation init script set for tab={} endpoint={}", tab_id, endpoint_url);
            }
        }

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

        // Start background poller only after native placement succeeds.
        self.start_url_poller(tab_id.clone());

        let info = BrowserTabInfo {
            id: tab_id.clone(),
            url,
            title: String::new(),
        };

        let mut tabs = self.tabs.lock().map_err(|_| "Lock poisoned")?;
        tabs.insert(tab_id.clone(), info.clone());
        drop(tabs);

        Ok(info)
    }
    pub fn navigate(&self, tab_id: &str, url: String) -> Result<(), String> {
        let webview = self.get_webview(tab_id)?;
        let parsed_url: tauri::Url = url
            .parse()
            .map_err(|e| format!("Invalid URL: {}", e))?;
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

        webview
            .show()
            .map_err(|e| format!("Show failed: {}", e))?;
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

        webview
            .hide()
            .map_err(|e| format!("Hide failed: {}", e))?;
        Ok(())
    }

    /// Set the agentation HTTP endpoint (called when the Rust server starts).
    /// This makes the endpoint available for injection into new browser tabs.
    pub fn set_agentation_endpoint(&self, endpoint: String) {
        let mut ep = self.agentation_endpoint.lock().unwrap_or_else(|e| e.into_inner());
        *ep = Some(endpoint);
    }

    /// Enable/disable agentation annotation mode (feature flag from AppPreferences).
    pub fn set_agentation_enabled(&self, enabled: bool) {
        let mut en = self.agentation_enabled.lock().unwrap_or_else(|e| e.into_inner());
        *en = enabled;
    }

    /// Check if agentation mode is enabled.
    pub fn is_agentation_enabled(&self) -> bool {
        *self.agentation_enabled.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Inject the agentation toolbar bundle into a browser tab via eval.
    /// Called after page load (browser_tab_report_loaded) because the
    /// agentation library accesses document.head at module top-level.
    pub fn inject_agentation_toolbar(&self, tab_id: &str) -> Result<(), String> {
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

    pub fn destroy(&self, tab_id: &str) -> Result<(), String> {
        #[cfg(target_os = "linux")]
        {
            if let Ok(webview) = self.get_webview(tab_id) {
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

        if let Ok(webview) = self.get_webview(tab_id) {
            let _ = webview.close();
        }
        let mut tabs = self.tabs.lock().map_err(|_| "Lock poisoned")?;
        tabs.remove(tab_id);
        drop(tabs);
        Ok(())
    }

    pub fn go_back(&self, tab_id: &str) -> Result<(), String> {
        let webview = self.get_webview(tab_id)?;
        webview
            .eval("window.history.back()")
            .map_err(|e| format!("Go back failed: {}", e))?;
        Ok(())
    }

    pub fn go_forward(&self, tab_id: &str) -> Result<(), String> {
        let webview = self.get_webview(tab_id)?;
        webview
            .eval("window.history.forward()")
            .map_err(|e| format!("Go forward failed: {}", e))?;
        Ok(())
    }

    pub fn reload(&self, tab_id: &str) -> Result<(), String> {
        let webview = self.get_webview(tab_id)?;
        webview
            .eval("window.location.reload()")
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
        }
        tabs.clear();
    }
}

impl Drop for BrowserTabManager {
    fn drop(&mut self) {
        self.destroy_all();
    }
}
