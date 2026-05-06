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
}

impl BrowserTabManager {
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            app_handle,
            tabs: Arc::new(Mutex::new(HashMap::new())),
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

        let _webview = window
            .add_child(
                builder,
                tauri::LogicalPosition::new(bounds.x, bounds.y),
                tauri::LogicalSize::new(bounds.width, bounds.height),
            )
            .map_err(|e| format!("Failed to create webview: {}", e))?;

        // Note: Navigation events will be emitted from the frontend via IPC
        // when the URL changes, since tauri::Webview doesn't have an on_navigation handler.

        let info = BrowserTabInfo {
            id: tab_id.clone(),
            url,
            title: String::new(),
        };

        let mut tabs = self.tabs.lock().map_err(|_| "Lock poisoned")?;
        tabs.insert(tab_id, info.clone());
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
        webview
            .set_bounds(tauri::Rect {
                position: tauri::LogicalPosition::new(bounds.x, bounds.y).into(),
                size: tauri::LogicalSize::new(bounds.width, bounds.height).into(),
            })
            .map_err(|e| format!("Resize failed: {}", e))?;
        Ok(())
    }

    pub fn show(&self, tab_id: &str) -> Result<(), String> {
        let webview = self.get_webview(tab_id)?;
        webview
            .show()
            .map_err(|e| format!("Show failed: {}", e))?;
        Ok(())
    }

    pub fn hide(&self, tab_id: &str) -> Result<(), String> {
        let webview = self.get_webview(tab_id)?;
        webview
            .hide()
            .map_err(|e| format!("Hide failed: {}", e))?;
        Ok(())
    }

    pub fn destroy(&self, tab_id: &str) -> Result<(), String> {
        if let Ok(webview) = self.get_webview(tab_id) {
            let _ = webview.close();
        }
        let mut tabs = self.tabs.lock().map_err(|_| "Lock poisoned")?;
        tabs.remove(tab_id);
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

    pub fn destroy_all(&self) {
        let mut tabs = self.tabs.lock().unwrap_or_else(|e| e.into_inner());
        let ids: Vec<String> = tabs.keys().cloned().collect();
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
