//! Agent browsing identities: where a tab webview keeps its cookies,
//! storage and cache, per engine.
//!
//! Agent tabs never use the app's own profile. The global agent profile is
//! one persistent store under app data, shared by every agent session in
//! every project. An ephemeral tab starts logged out and its data goes with
//! its session.
//!
//! The global profile lives in a *generation*: a directory under the global
//! root named by a UUID, recorded in the root's `current` file. Clearing it
//! retires the generation and starts a fresh one, so the next agent tab can
//! never reach the old data even while the engine still releases it; the
//! old generation is deleted once the engine lets go, and any generation a
//! crash left behind is deleted at the next start. WebKitGTK keeps a data
//! directory's context alive for the life of the process, and macOS names
//! data stores by UUID, so a fresh generation is the only clean wipe there.
//!
//! | Engine | Global | Ephemeral |
//! | --- | --- | --- |
//! | WebView2 | generation folder, one environment shared by object | per-session folder + InPrivate |
//! | WKWebView | data store named by the generation UUID (macOS 14+) | non-persistent data store |
//! | WebKitGTK | generation data directory (one context per process) | ephemeral context |
//!
//! Agent tabs never show the engine's save-password bubble or offer saved
//! form data, since that is interface noise in a tab an agent drives.
//! Typing and submitting passwords stays unrestricted. WebView2 has both
//! switches and they are turned off per tab. WKWebView and WebKitGTK have
//! no password manager or autofill to turn off. Cookies are never cleared
//! by the app: the profile belongs to the user.

#[cfg(target_os = "windows")]
mod webview2;
#[cfg(target_os = "windows")]
mod webview2_settings;

use std::path::{Path, PathBuf};
use std::time::Duration;

use parking_lot::Mutex;
use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, Webview, Wry};
use uuid::Uuid;

use super::Support;

/// Directory under app data that holds the global agent profile. Separate
/// from the per-session root, so the session sweep never reaches it.
pub const GLOBAL_ROOT: &str = "browser-agent-profile";
const CURRENT_FILE: &str = "current";

/// Where a tab webview keeps its browsing data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DataStore {
    /// The app's own profile, shared with the app UI: user tabs only.
    App,
    /// The global agent profile.
    Global,
    /// Logged out and discarded with its session. `dir` is the session's
    /// profile directory, for engines that need one on disk.
    Ephemeral { dir: PathBuf },
}

/// Whether this engine can keep the global agent profile.
pub fn persistent_profile_support() -> Support {
    #[cfg(target_os = "macos")]
    {
        let major = match tauri_plugin_os::version() {
            tauri_plugin_os::Version::Semantic(major, _, _) => Some(major),
            _ => None,
        };
        macos_support(major)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Support::Trusted
    }
}

/// Named data stores need macOS 14; below that agent tabs run ephemeral.
#[cfg(any(test, target_os = "macos"))]
pub(crate) fn macos_support(major: Option<u64>) -> Support {
    match major {
        Some(major) if major >= 14 => Support::Trusted,
        _ => Support::Unavailable("macos_version"),
    }
}

/// Attempts at deleting a directory whose files the engine may still hold
/// for a moment after its webviews closed: WebView2 keeps a user-data
/// folder locked until that folder's browser process exits.
const DELETE_ATTEMPTS: u32 = 7;
const DELETE_FIRST_RETRY: Duration = Duration::from_millis(250);

/// Delete `dir`, retrying with backoff while files are still held. Missing
/// is done. Blocks for at most about 16 s.
pub fn delete_dir(dir: &Path) -> bool {
    let mut wait = DELETE_FIRST_RETRY;
    for attempt in 1..=DELETE_ATTEMPTS {
        match std::fs::remove_dir_all(dir) {
            Ok(()) => return true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return true,
            Err(_) if attempt < DELETE_ATTEMPTS => {
                std::thread::sleep(wait);
                wait *= 2;
            }
            Err(_) => {}
        }
    }
    false
}

/// The global profile's current generation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Generation(Uuid);

impl Generation {
    fn name(self) -> String {
        self.0.simple().to_string()
    }

    fn parse(name: &str) -> Option<Self> {
        let id = Uuid::try_parse(name.trim()).ok()?;
        (id.simple().to_string() == name.trim()).then_some(Self(id))
    }
}

/// The agent profiles of one app: the global profile's generation, and on
/// WebView2 the environments shared by the tabs of each folder.
pub struct AgentProfiles {
    root: PathBuf,
    current: Mutex<Generation>,
    #[cfg(target_os = "windows")]
    environments: webview2::Environments,
}

impl AgentProfiles {
    /// Open the global profile under `root`, starting a generation when
    /// none is recorded.
    pub fn open(root: PathBuf) -> std::io::Result<Self> {
        let recorded = std::fs::read_to_string(root.join(CURRENT_FILE))
            .ok()
            .and_then(|name| Generation::parse(&name));
        let current = match recorded {
            Some(generation) => generation,
            None => {
                let generation = Generation(Uuid::new_v4());
                write_current(&root, generation)?;
                generation
            }
        };
        std::fs::create_dir_all(root.join(current.name()))?;
        Ok(Self {
            root,
            current: Mutex::new(current),
            #[cfg(target_os = "windows")]
            environments: webview2::Environments::default(),
        })
    }

    /// The global profile's data directory on WebView2 and WebKitGTK.
    #[cfg(any(test, not(target_os = "macos")))]
    fn global_dir(&self) -> PathBuf {
        self.root.join(self.current.lock().name())
    }

    /// Point `builder` at `store`. Fails when the store cannot be prepared;
    /// the caller then refuses the tab rather than build it elsewhere.
    pub fn configure(
        &self,
        builder: WebviewBuilder<Wry>,
        label: &str,
        store: &DataStore,
    ) -> Result<WebviewBuilder<Wry>, String> {
        if *store == DataStore::App {
            return Ok(builder);
        }
        let builder = builder.general_autofill_enabled(false);
        #[cfg(target_os = "windows")]
        {
            let (dir, incognito) = match store {
                DataStore::Global => (self.global_dir(), false),
                DataStore::Ephemeral { dir } => (dir.clone(), true),
                DataStore::App => unreachable!("handled above"),
            };
            std::fs::create_dir_all(&dir).map_err(|e| format!("agent profile folder: {e}"))?;
            Ok(self
                .environments
                .configure(builder.incognito(incognito), label, dir))
        }
        #[cfg(target_os = "linux")]
        {
            let _ = label;
            match store {
                DataStore::Global => {
                    let dir = self.global_dir();
                    std::fs::create_dir_all(&dir)
                        .map_err(|e| format!("agent profile directory: {e}"))?;
                    Ok(builder.data_directory(dir))
                }
                _ => Ok(builder.incognito(true)),
            }
        }
        #[cfg(target_os = "macos")]
        {
            let _ = label;
            match store {
                DataStore::Global => {
                    if persistent_profile_support() != Support::Trusted {
                        return Err("this macOS cannot keep a named agent profile".to_string());
                    }
                    Ok(builder.data_store_identifier(*self.current.lock().0.as_bytes()))
                }
                _ => Ok(builder.incognito(true)),
            }
        }
    }

    /// The engine confirmed `webview`: share its environment with the next
    /// tabs of the same folder, and apply the agent-tab settings to a tab
    /// that is on an agent profile.
    pub async fn built(&self, webview: &Webview, label: &str, store: &DataStore) {
        #[cfg(target_os = "windows")]
        self.environments.adopt(webview, label).await;
        #[cfg(not(target_os = "windows"))]
        let _ = label;
        if *store == DataStore::App {
            return;
        }
        #[cfg(target_os = "windows")]
        {
            let applied = webview.with_webview(|platform| {
                // SAFETY: COM call on the UI thread that owns the controller.
                let Ok(core) = (unsafe { platform.controller().CoreWebView2() }) else {
                    return;
                };
                if !webview2_settings::disable_credential_prompts(&core) {
                    log::warn!("[browser-profile] password and autofill prompts stay as the runtime defaults");
                }
            });
            if applied.is_err() {
                log::warn!("[browser-profile] agent tab settings not applied");
            }
        }
        #[cfg(not(target_os = "windows"))]
        let _ = webview;
    }

    /// `label`'s webview is gone, or was never built.
    pub fn dropped(&self, app: &AppHandle, label: &str) {
        #[cfg(target_os = "windows")]
        self.environments.release(app, label);
        #[cfg(not(target_os = "windows"))]
        let _ = (app, label);
    }

    /// Retire the global profile's generation and delete its data. Call
    /// only once no webview uses the global profile. New global tabs get
    /// an empty profile from the moment this returns, even when deleting
    /// the old data failed (the next start retries it).
    pub async fn wipe_global(&self, app: &AppHandle) -> Result<(), String> {
        let old = self
            .rotate()
            .map_err(|e| format!("agent profile generation: {e}"))?;
        if !retire(app, &self.root, old).await {
            log::warn!(
                "[browser-profile] old agent profile data not deleted yet; the next start retries"
            );
        }
        Ok(())
    }

    /// Start a fresh generation; returns the retired one.
    fn rotate(&self) -> std::io::Result<Generation> {
        let fresh = Generation(Uuid::new_v4());
        std::fs::create_dir_all(self.root.join(fresh.name()))?;
        write_current(&self.root, fresh)?;
        Ok(std::mem::replace(&mut *self.current.lock(), fresh))
    }

    /// Delete every generation but the current one. Returns how many went.
    pub async fn sweep(&self, app: &AppHandle) -> usize {
        let mut removed = 0;
        for generation in self.stale_generations() {
            if retire(app, &self.root, generation).await {
                removed += 1;
            }
        }
        removed
    }

    fn stale_generations(&self) -> Vec<Generation> {
        let current = *self.current.lock();
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return Vec::new();
        };
        entries
            .flatten()
            .filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir()))
            .filter_map(|entry| Generation::parse(&entry.file_name().to_string_lossy()))
            .filter(|generation| *generation != current)
            .collect()
    }
}

fn write_current(root: &Path, generation: Generation) -> std::io::Result<()> {
    crate::acp::atomic_file::replace(&root.join(CURRENT_FILE), generation.name().as_bytes())
}

/// Delete one retired generation's data: the engine's store, then its
/// directory.
async fn retire(app: &AppHandle, root: &Path, generation: Generation) -> bool {
    #[cfg(target_os = "macos")]
    if !remove_data_store(app, generation).await {
        return false;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    let dir = root.join(generation.name());
    tokio::task::spawn_blocking(move || delete_dir(&dir))
        .await
        .unwrap_or(false)
}

/// WebKit refuses to remove a data store while a webview still holds it,
/// which can outlast the close by a moment. Named stores need macOS 14, so
/// below that no generation ever had one.
#[cfg(target_os = "macos")]
async fn remove_data_store(app: &AppHandle, generation: Generation) -> bool {
    if persistent_profile_support() != Support::Trusted {
        return true;
    }
    let id = *generation.0.as_bytes();
    match app.fetch_data_store_identifiers().await {
        Ok(ids) if !ids.contains(&id) => return true,
        Ok(_) => {}
        Err(_) => return false,
    }
    let mut wait = DELETE_FIRST_RETRY;
    for attempt in 1..=DELETE_ATTEMPTS {
        match app.remove_data_store(id).await {
            Ok(()) => return true,
            Err(_) if attempt < DELETE_ATTEMPTS => {
                tokio::time::sleep(wait).await;
                wait *= 2;
            }
            Err(_) => {}
        }
    }
    false
}

#[cfg(test)]
mod tests;
