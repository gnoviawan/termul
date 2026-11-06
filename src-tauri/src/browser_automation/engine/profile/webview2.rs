//! WebView2 environments shared by object across the tabs of one folder.
//!
//! Tauri gives every webview a fresh environment, even for the same data
//! folder. A second environment on a folder that a running browser process
//! already holds fails controller creation (`0x8007139F`) whenever its
//! options differ, and tauri still reports the webview as built. So each
//! folder's first webview lends its environment to the next ones, and the
//! environment is released when the folder's last tab closes.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use parking_lot::Mutex;
use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, Webview, Wry};
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment;

use crate::browser_automation::budgets;

/// Only called on the UI thread, where webviews are built and their
/// environments used; other threads only hold and pass the reference.
#[derive(Clone)]
struct SharedEnvironment(ICoreWebView2Environment);

// SAFETY: the interface is never called off the UI thread (see above), the
// same contract tauri relies on when its builder carries an environment
// across threads.
unsafe impl Send for SharedEnvironment {}
unsafe impl Sync for SharedEnvironment {}

#[derive(Default)]
struct Folder {
    environment: Option<SharedEnvironment>,
    tabs: HashSet<String>,
}

#[derive(Default)]
struct State {
    folders: HashMap<PathBuf, Folder>,
    folder_of: HashMap<String, PathBuf>,
}

#[derive(Default)]
pub struct Environments(Mutex<State>);

impl Environments {
    /// Build `label` on `dir`, on the folder's shared environment when it
    /// has one.
    pub fn configure(
        &self,
        builder: WebviewBuilder<Wry>,
        label: &str,
        dir: PathBuf,
    ) -> WebviewBuilder<Wry> {
        let mut state = self.0.lock();
        state.folder_of.insert(label.to_string(), dir.clone());
        let folder = state.folders.entry(dir.clone()).or_default();
        folder.tabs.insert(label.to_string());
        let builder = builder.data_directory(dir);
        match &folder.environment {
            Some(shared) => builder.with_environment(shared.0.clone()),
            None => builder,
        }
    }

    /// Keep the environment the engine built `label` on, when its folder
    /// has none yet.
    pub async fn adopt(&self, webview: &Webview, label: &str) {
        let needed = {
            let state = self.0.lock();
            state
                .folder_of
                .get(label)
                .and_then(|dir| state.folders.get(dir))
                .is_some_and(|folder| folder.environment.is_none())
        };
        if !needed {
            return;
        }
        let (tx, rx) = tokio::sync::oneshot::channel();
        if webview
            .with_webview(move |platform| {
                let _ = tx.send(SharedEnvironment(platform.environment()));
            })
            .is_err()
        {
            return;
        }
        let Ok(Ok(environment)) = tokio::time::timeout(budgets::TAB_CONFIRM, rx).await else {
            return;
        };
        let mut state = self.0.lock();
        let Some(dir) = state.folder_of.get(label).cloned() else {
            return;
        };
        if let Some(folder) = state.folders.get_mut(&dir) {
            folder.environment.get_or_insert(environment);
        }
    }

    /// `label` closed or was never built. The folder's last tab releases
    /// its environment, on the UI thread.
    pub fn release(&self, app: &AppHandle, label: &str) {
        let released = {
            let mut state = self.0.lock();
            let Some(dir) = state.folder_of.remove(label) else {
                return;
            };
            let Some(folder) = state.folders.get_mut(&dir) else {
                return;
            };
            folder.tabs.remove(label);
            if !folder.tabs.is_empty() {
                return;
            }
            state
                .folders
                .remove(&dir)
                .and_then(|folder| folder.environment)
        };
        if let Some(environment) = released {
            if let Err(error) = app.run_on_main_thread(move || drop(environment)) {
                log::warn!("[browser-profile] environment release not scheduled: {error}");
            }
        }
    }
}
