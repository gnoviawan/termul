use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

struct SendWrapper<T>(pub T);
unsafe impl<T> Send for SendWrapper<T> {}
unsafe impl<T> Sync for SendWrapper<T> {}

impl<T> SendWrapper<T> {
    pub fn take(self) -> T {
        self.0
    }
}


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
    annotation_injected: Arc<Mutex<HashMap<String, Option<String>>>>,
}

impl BrowserTabManager {
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            app_handle,
            tabs: Arc::new(Mutex::new(HashMap::new())),
            annotation_injected: Arc::new(Mutex::new(HashMap::new())),
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
        });
    }

    pub fn create(
        &self,
        tab_id: String,
        url: String,
        bounds: BrowserBounds,
    ) -> Result<BrowserTabInfo, String> {
        let window = self.get_window()?;
        let parsed_url: tauri::Url = url
            .parse()
            .map_err(|e| format!("Invalid URL: {}", e))?;

        let builder = tauri::webview::WebviewBuilder::new(
            tab_id.clone(),
            tauri::WebviewUrl::External(parsed_url),
        );

        let scale_factor = window.scale_factor().unwrap_or(1.0);
        log::info!("[BrowserTab] create original bounds: x={}, y={}, w={}, h={}, scale_factor={}", bounds.x, bounds.y, bounds.width, bounds.height, scale_factor);

        #[cfg(target_os = "linux")]
        let (x, y, w, h) = (
            bounds.x / scale_factor,
            bounds.y / scale_factor,
            bounds.width / scale_factor,
            bounds.height / scale_factor,
        );

        #[cfg(not(target_os = "linux"))]
        let (x, y, w, h) = (bounds.x, bounds.y, bounds.width, bounds.height);

        log::info!("[BrowserTab] create scaled bounds: x={}, y={}, w={}, h={}", x, y, w, h);

        let _webview = window
            .add_child(
                builder,
                tauri::LogicalPosition::new(x, y),
                tauri::LogicalSize::new(w, h),
            )
            .map_err(|e| format!("Failed to create webview: {}", e))?;

        #[cfg(target_os = "linux")]
        {
            let child_webview = _webview.clone();
            if let Ok(main_webview) = window.get_webview("main").ok_or_else(|| "Main webview not found".to_string()) {
                let bounds_clone = bounds.clone();
                let _ = main_webview.with_webview(move |main_platform| {
                    let main_widget = main_platform.inner().clone();
                    let main_widget_wrapped = SendWrapper(main_widget);
                    let _ = child_webview.with_webview(move |child_platform| {
                        let child_widget = child_platform.inner().clone();
                        let main_widget = main_widget_wrapped.take();
                        let handle_reparent = || -> Result<(), String> {
                            use gtk::prelude::*;

                            let parent = main_widget.parent()
                                .ok_or_else(|| "Main webview has no parent".to_string())?;

                            let overlay = if parent.type_().name() == "GtkOverlay" {
                                parent.dynamic_cast::<gtk::Overlay>()
                                    .map_err(|_| "Parent is not GtkOverlay".to_string())?
                            } else {
                                let vbox = parent.dynamic_cast::<gtk::Box>()
                                    .map_err(|_| "Main webview parent is not GtkBox".to_string())?;

                                let new_overlay = gtk::Overlay::new();
                                new_overlay.set_hexpand(true);
                                new_overlay.set_vexpand(true);

                                main_widget.set_hexpand(true);
                                main_widget.set_vexpand(true);

                                vbox.remove(&main_widget);
                                vbox.pack_start(&new_overlay, true, true, 0);
                                new_overlay.add(&main_widget);
                                new_overlay.show();
                                new_overlay
                            };

                            if let Some(child_parent) = child_widget.parent() {
                                if let Ok(vbox) = child_parent.dynamic_cast::<gtk::Box>() {
                                    vbox.remove(&child_widget);
                                }
                            }

                            let width = (bounds_clone.width / scale_factor) as i32;
                            let height = (bounds_clone.height / scale_factor) as i32;
                            let x_pos = (bounds_clone.x / scale_factor) as i32;
                            let y_pos = (bounds_clone.y / scale_factor) as i32;

                            child_widget.set_halign(gtk::Align::Start);
                            child_widget.set_valign(gtk::Align::Start);
                            child_widget.set_margin_start(x_pos);
                            child_widget.set_margin_top(y_pos);
                            child_widget.set_size_request(width, height);
                            child_widget.show();

                            overlay.add_overlay(&child_widget);
                            overlay.show_all();
                            Ok(())
                        };

                        if let Err(e) = handle_reparent() {
                            log::error!("[BrowserTab] Linux GTK reparent failed: {}", e);
                        } else {
                            log::info!("[BrowserTab] Linux GTK reparent succeeded");
                        }
                    });
                });
            } else {
                log::error!("[BrowserTab] Linux GTK reparent failed: Main webview not found");
            }
        }

        // Start background poller to sync URL and loading state from webview
        self.start_url_poller(tab_id.clone());

        let info = BrowserTabInfo {
            id: tab_id.clone(),
            url,
            title: String::new(),
        };

        let mut tabs = self.tabs.lock().map_err(|_| "Lock poisoned")?;
        tabs.insert(tab_id.clone(), info.clone());
        drop(tabs);

        let mut annotation_injected = self.annotation_injected.lock().map_err(|_| "Lock poisoned")?;
        annotation_injected.insert(tab_id, None);
        drop(annotation_injected);

        Ok(info)
    }

    pub fn inject_annotation_script(&self, tab_id: &str, mode: &str) -> Result<(), String> {
        let normalized_mode = match mode {
            "select" => "select",
            _ => "draw",
        };

        {
            let annotation_injected = self.annotation_injected.lock().map_err(|_| "Lock poisoned")?;
            let current_mode = annotation_injected
                .get(tab_id)
                .and_then(|value| value.as_deref());
            if current_mode == Some(normalized_mode) {
                return Ok(());
            }
        }

        let webview = self.get_webview(tab_id)?;

        {
            let annotation_injected = self.annotation_injected.lock().map_err(|_| "Lock poisoned")?;
            let current_mode = annotation_injected
                .get(tab_id)
                .and_then(|value| value.as_deref());
            if current_mode.is_some() && current_mode != Some(normalized_mode) {
                drop(annotation_injected);
                self.remove_annotation_overlay(tab_id)?;
            }
        }

        let overlay_script = include_str!("../resources/annotation-overlay.js");
        let bootstrap_script = format!(
            r#"
            window.__termul_annotation_mode = {mode:?};
            window.__termul_annotation_tab_id = {tab_id:?};
            {overlay_script}
            "#,
            mode = normalized_mode,
            tab_id = tab_id,
            overlay_script = overlay_script,
        );

        webview
            .eval(&bootstrap_script)
            .map_err(|e| format!("Failed to inject annotation overlay: {}", e))?;

        webview
            .eval(
                r#"
                if (typeof window.__termul_remove_annotation_overlay !== 'function') {
                    throw new Error('Annotation overlay bootstrap probe failed');
                }
                "#,
            )
            .map_err(|e| format!("Annotation overlay probe failed: {}", e))?;

        let mut annotation_injected = self.annotation_injected.lock().map_err(|_| "Lock poisoned")?;
        annotation_injected.insert(tab_id.to_string(), Some(normalized_mode.to_string()));
        log::info!(
            "[BrowserTab] Injected annotation overlay for tab={} mode={}",
            tab_id,
            normalized_mode
        );
        Ok(())
    }

    pub fn remove_annotation_overlay(&self, tab_id: &str) -> Result<(), String> {
        // Do NOT gate the JS cleanup on the `annotation_injected` map: navigation/load
        // reporting (`browser_tab_report_loaded`/`_url`) invalidates the map entry to
        // `None` BEFORE the renderer-driven remove runs. Gating here would skip the JS
        // cleanup and leave a stale overlay in the webview DOM. The cleanup script is
        // self-guarded, so calling it when no overlay exists is a safe no-op.
        let webview = match self.get_webview(tab_id) {
            Ok(webview) => webview,
            // No webview (tab gone / not yet created) means nothing to clean up.
            Err(e) => {
                log::debug!(
                    "[BrowserTab] remove_annotation_overlay: no webview for tab={} ({}); clearing state",
                    tab_id,
                    e
                );
                let mut annotation_injected =
                    self.annotation_injected.lock().map_err(|_| "Lock poisoned")?;
                annotation_injected.insert(tab_id.to_string(), None);
                return Ok(());
            }
        };

        let cleanup_script = r#"
            if (window.__termul_remove_annotation_overlay) {
                window.__termul_remove_annotation_overlay();
            }
        "#;
        let _ = webview.eval(cleanup_script);

        let mut annotation_injected = self.annotation_injected.lock().map_err(|_| "Lock poisoned")?;
        annotation_injected.insert(tab_id.to_string(), None);
        log::info!("[BrowserTab] Removed annotation overlay for tab={}", tab_id);
        Ok(())
    }

    fn escape_js_string_literal(value: &str) -> String {
        value
            .replace('\\', "\\\\")
            .replace('\'', "\\'")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
            .replace('\r', "\\r")
            .replace('\0', "\\0")
            .replace('\u{2028}', "\\u2028")
            .replace('\u{2029}', "\\u2029")
    }

    pub fn inject_annotation_markers(
        &self,
        tab_id: &str,
        annotations_json: &str,
        selected_id: Option<&str>,
    ) -> Result<(), String> {
        let annotation_injected = self.annotation_injected.lock().map_err(|_| "Lock poisoned")?;
        if annotation_injected.get(tab_id).is_none() || annotation_injected.get(tab_id).and_then(|v| v.as_deref()).is_none() {
            return Err(format!("Annotation overlay not injected for tab={}", tab_id));
        }
        drop(annotation_injected);

        let webview = self.get_webview(tab_id)?;

        let probe = r#"
            if (typeof window.__termul_remove_annotation_overlay !== 'function') {
                throw new Error('Annotation overlay probe failed');
            }
        "#;
        if webview.eval(probe).is_err() {
            let mut annotation_injected = self.annotation_injected.lock().map_err(|_| "Lock poisoned")?;
            annotation_injected.insert(tab_id.to_string(), None);
            return Err(format!("Annotation overlay was cleared by navigation for tab={}", tab_id));
        }
        let escaped_json = Self::escape_js_string_literal(annotations_json);
        let selected_id_js = selected_id.map_or_else(|| "null".to_string(), |id| format!("'{}'", Self::escape_js_string_literal(id)));
        let js = format!(
            "window.__termul_render_markers(JSON.parse('{}'), {});",
            escaped_json,
            selected_id_js,
        );
        webview
            .eval(&js)
            .map_err(|e| format!("Failed to inject annotation markers: {}", e))?;
        Ok(())
    }

    pub fn update_annotation_marker_selection(
        &self,
        tab_id: &str,
        selected_id: Option<&str>,
    ) -> Result<(), String> {
        let annotation_injected = self.annotation_injected.lock().map_err(|_| "Lock poisoned")?;
        if annotation_injected.get(tab_id).is_none() || annotation_injected.get(tab_id).and_then(|v| v.as_deref()).is_none() {
            return Err(format!("Annotation overlay not injected for tab={}", tab_id));
        }
        drop(annotation_injected);

        let webview = self.get_webview(tab_id)?;

        let probe = r#"
            if (typeof window.__termul_remove_annotation_overlay !== 'function') {
                throw new Error('Annotation overlay probe failed');
            }
        "#;
        if webview.eval(probe).is_err() {
            let mut annotation_injected = self.annotation_injected.lock().map_err(|_| "Lock poisoned")?;
            annotation_injected.insert(tab_id.to_string(), None);
            return Err(format!("Annotation overlay was cleared by navigation for tab={}", tab_id));
        }
        let selected_id_js = selected_id.map_or_else(|| "null".to_string(), |id| format!("'{}'", Self::escape_js_string_literal(id)));
        let js = format!(
            "window.__termul_update_marker_selection({});",
            selected_id_js,
        );
        webview
            .eval(&js)
            .map_err(|e| format!("Failed to update annotation marker selection: {}", e))?;
        Ok(())
    }

    pub fn navigate(&self, tab_id: &str, url: String) -> Result<(), String> {
        self.invalidate_annotation_injected(tab_id);
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
            let window = self.get_window()?;
            let scale_factor = window.scale_factor().unwrap_or(1.0);
            let w = bounds.width / scale_factor;
            let h = bounds.height / scale_factor;
            let x = bounds.x / scale_factor;
            let y = bounds.y / scale_factor;

            log::info!("[BrowserTab] resize: scaled target bounds x={}, y={}, w={}, h={}, scale={}", x, y, w, h, scale_factor);

            let _ = webview.with_webview(move |child_platform| {
                use gtk::prelude::*;
                let child_widget = child_platform.inner();
                child_widget.set_margin_start(x as i32);
                child_widget.set_margin_top(y as i32);
                child_widget.set_size_request(w as i32, h as i32);
                child_widget.queue_resize();
            });
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
            let _ = webview.with_webview(move |child_platform| {
                use gtk::prelude::*;
                let child_widget = child_platform.inner();
                child_widget.show();
            });
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
            let _ = webview.with_webview(move |child_platform| {
                use gtk::prelude::*;
                let child_widget = child_platform.inner();
                child_widget.hide();
            });
        }

        webview
            .hide()
            .map_err(|e| format!("Hide failed: {}", e))?;
        Ok(())
    }

    pub fn invalidate_annotation_injected(&self, tab_id: &str) {
        let mut annotation_injected = self.annotation_injected.lock().unwrap_or_else(|e| e.into_inner());
        annotation_injected.insert(tab_id.to_string(), None);
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
        let mut annotation_injected = self.annotation_injected.lock().map_err(|_| "Lock poisoned")?;
        annotation_injected.remove(tab_id);
        Ok(())
    }

    pub fn go_back(&self, tab_id: &str) -> Result<(), String> {
        self.invalidate_annotation_injected(tab_id);
        let webview = self.get_webview(tab_id)?;
        webview
            .eval("window.history.back()")
            .map_err(|e| format!("Go back failed: {}", e))?;
        Ok(())
    }

    pub fn go_forward(&self, tab_id: &str) -> Result<(), String> {
        self.invalidate_annotation_injected(tab_id);
        let webview = self.get_webview(tab_id)?;
        webview
            .eval("window.history.forward()")
            .map_err(|e| format!("Go forward failed: {}", e))?;
        Ok(())
    }

    pub fn reload(&self, tab_id: &str) -> Result<(), String> {
        self.invalidate_annotation_injected(tab_id);
        let webview = self.get_webview(tab_id)?;
        webview
            .eval("window.location.reload()")
            .map_err(|e| format!("Reload failed: {}", e))?;
        Ok(())
    }

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
        let mut annotation_injected = self.annotation_injected.lock().unwrap_or_else(|e| e.into_inner());
        annotation_injected.clear();
    }
}

impl Drop for BrowserTabManager {
    fn drop(&mut self) {
        self.destroy_all();
    }
}
