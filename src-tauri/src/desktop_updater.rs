//! Signed in-app update for the desktop app.
//!
//! The JavaScript updater `check()` can only use the endpoint baked into
//! `tauri.conf.json` (the stable manifest). This module builds the updater at
//! runtime with the manifest for the channel the user selected, keeps the
//! verified `Update` handle, then downloads, installs, and restarts.
//!
//! Stable accepts a manifest only when its version is newer. Insider and
//! Nightly accept a different version so a channel switch can install a
//! prerelease or a nightly build whose SemVer is lower than the running app.
//! The plugin still verifies the minisign signature before install.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{ipc::Channel, AppHandle, State};
use tauri_plugin_updater::UpdaterExt;

use crate::commands::IpcResult;
use crate::server_update::{is_newer, UpdateChannel};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const STABLE_ALIAS_URL: &str =
    "https://github.com/gnoviawan/termul/releases/latest/download/latest.json";

/// Result of storing a check while an install may already own the handle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SlotStore {
    Stored,
    InstallInProgress,
}

/// Result of taking the handle for install.
#[derive(Debug)]
enum SlotBegin<T> {
    Ready(T),
    Empty,
    InstallInProgress,
}

/// One pending update, plus the flag that an install currently owns it.
///
/// A check must not replace the slot while `installing` is set. A failed
/// install restores its handle only when a channel switch did not clear it
/// and a newer check did not store a replacement.
#[derive(Debug)]
struct PendingSlot<T> {
    update: Option<T>,
    installing: bool,
    discard_on_abort: bool,
}

impl<T> Default for PendingSlot<T> {
    fn default() -> Self {
        Self {
            update: None,
            installing: false,
            discard_on_abort: false,
        }
    }
}

impl<T> PendingSlot<T> {
    fn store_check(&mut self, update: Option<T>) -> SlotStore {
        if self.installing {
            return SlotStore::InstallInProgress;
        }
        self.update = update;
        self.discard_on_abort = false;
        SlotStore::Stored
    }

    fn begin_install(&mut self) -> SlotBegin<T> {
        if self.installing {
            return SlotBegin::InstallInProgress;
        }
        match self.update.take() {
            Some(update) => {
                self.installing = true;
                self.discard_on_abort = false;
                SlotBegin::Ready(update)
            }
            None => SlotBegin::Empty,
        }
    }

    fn abort_install(&mut self, update: T) {
        self.installing = false;
        if self.discard_on_abort {
            self.discard_on_abort = false;
            return;
        }
        if self.update.is_none() {
            self.update = Some(update);
        }
    }

    fn finish_install(&mut self) {
        self.installing = false;
        self.discard_on_abort = false;
    }

    fn clear(&mut self) {
        self.update = None;
        if self.installing {
            self.discard_on_abort = true;
        }
    }
}

/// Verified update waiting for the user to confirm install.
pub struct PendingSignedUpdate(Mutex<PendingSlot<tauri_plugin_updater::Update>>);

impl Default for PendingSignedUpdate {
    fn default() -> Self {
        Self(Mutex::new(PendingSlot::default()))
    }
}

impl PendingSignedUpdate {
    fn lock(&self) -> std::sync::MutexGuard<'_, PendingSlot<tauri_plugin_updater::Update>> {
        self.0.lock().unwrap_or_else(|err| err.into_inner())
    }

    fn store_check(&self, update: Option<tauri_plugin_updater::Update>) -> SlotStore {
        self.lock().store_check(update)
    }

    fn begin_install(&self) -> SlotBegin<tauri_plugin_updater::Update> {
        self.lock().begin_install()
    }

    fn abort_install(&self, update: tauri_plugin_updater::Update) {
        self.lock().abort_install(update);
    }

    fn finish_install(&self) {
        self.lock().finish_install();
    }

    fn clear(&self) {
        self.lock().clear();
    }
}

const UPDATE_INSTALL_IN_PROGRESS: &str = "UPDATE_INSTALL_IN_PROGRESS";

/// Metadata returned to the renderer. The bundle URL and signature stay in Rust.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedUpdateInfo {
    pub version: String,
    pub current_version: String,
    pub release_notes: Option<String>,
    pub release_date: Option<String>,
}

/// Download progress for the update dialog. Field names match the renderer mapper.
#[derive(Clone, Serialize)]
pub struct SignedDownloadEvent {
    pub event: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<SignedDownloadData>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedDownloadData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_length: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunk_length: Option<usize>,
}

/// Manifest URLs the updater tries, in order.
///
/// Stable tries `latest-stable.json`, then the `latest.json` alias the plugin
/// config already uses. Insider and Nightly have one manifest each.
pub fn channel_manifest_endpoints(channel: UpdateChannel) -> Vec<&'static str> {
    match channel {
        UpdateChannel::Stable => vec![channel.manifest_url(), STABLE_ALIAS_URL],
        UpdateChannel::Insider | UpdateChannel::Nightly => vec![channel.manifest_url()],
    }
}

/// Whether the manifest version should be offered for this channel.
///
/// Stable keeps the default "newer only" rule. Insider and Nightly offer any
/// different version so the selected channel wins over raw SemVer order.
pub fn channel_should_update(channel: UpdateChannel, current: &str, remote: &str) -> bool {
    match channel {
        UpdateChannel::Stable => is_newer(remote, current),
        UpdateChannel::Insider | UpdateChannel::Nightly => !remote.is_empty() && remote != current,
    }
}

fn parse_endpoints(channel: UpdateChannel) -> Result<Vec<reqwest::Url>, String> {
    channel_manifest_endpoints(channel)
        .into_iter()
        .map(|endpoint| {
            reqwest::Url::parse(endpoint)
                .map_err(|err| format!("invalid update manifest URL {endpoint}: {err}"))
        })
        .collect()
}

fn map_updater_error(err: &tauri_plugin_updater::Error) -> &'static str {
    let message = err.to_string().to_ascii_lowercase();
    if message.contains("network")
        || message.contains("timed out")
        || message.contains("dns")
        || message.contains("connection")
    {
        "NETWORK_ERROR"
    } else {
        "UPDATE_CHECK_FAILED"
    }
}

async fn check_channel(
    app: &AppHandle,
    channel: UpdateChannel,
) -> Result<Option<tauri_plugin_updater::Update>, tauri_plugin_updater::Error> {
    let endpoints = parse_endpoints(channel).map_err(tauri_plugin_updater::Error::Network)?;
    app.updater_builder()
        .timeout(REQUEST_TIMEOUT)
        .endpoints(endpoints)?
        .version_comparator(move |current, release| {
            channel_should_update(channel, &current.to_string(), &release.version.to_string())
        })
        .build()?
        .check()
        .await
}

fn info_from_update(update: &tauri_plugin_updater::Update) -> SignedUpdateInfo {
    SignedUpdateInfo {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        release_notes: update.body.clone(),
        release_date: update.date.map(|date| date.to_string()),
    }
}

/// Check the signed manifest for `channel` and store the verified handle.
#[tauri::command]
pub async fn updater_check_signed(
    app: AppHandle,
    pending: State<'_, PendingSignedUpdate>,
    channel: String,
) -> Result<IpcResult<Option<SignedUpdateInfo>>, String> {
    let Some(parsed) = UpdateChannel::parse(&channel) else {
        log::warn!("[updater] rejected unknown update channel={channel}");
        return Ok(IpcResult::error(
            format!("unknown update channel: {channel}"),
            "INVALID_UPDATE_CHANNEL",
        ));
    };

    log::info!("[updater] checking signed update channel={channel}");
    match check_channel(&app, parsed).await {
        Ok(update) => {
            let info = update.as_ref().map(info_from_update);
            if let Some(found) = &info {
                log::info!(
                    "[updater] signed update available channel={channel} version={}",
                    found.version
                );
            } else {
                log::info!("[updater] no signed update channel={channel}");
            }
            if pending.store_check(update) == SlotStore::InstallInProgress {
                log::info!(
                    "[updater] kept the in-flight install and ignored check result channel={channel}"
                );
                return Ok(IpcResult::error(
                    "An update install is already in progress",
                    UPDATE_INSTALL_IN_PROGRESS,
                ));
            }
            Ok(IpcResult::success(info))
        }
        Err(err) => {
            log::warn!("[updater] signed update check failed channel={channel} error={err}");
            if pending.store_check(None) == SlotStore::InstallInProgress {
                log::info!(
                    "[updater] kept the in-flight install after a failed check channel={channel}"
                );
                return Ok(IpcResult::error(
                    "An update install is already in progress",
                    UPDATE_INSTALL_IN_PROGRESS,
                ));
            }
            Ok(IpcResult::error(err.to_string(), map_updater_error(&err)))
        }
    }
}

/// Drop a stored update after the user switches channel.
#[tauri::command]
pub async fn updater_clear_pending(
    pending: State<'_, PendingSignedUpdate>,
) -> Result<IpcResult<()>, String> {
    pending.clear();
    log::info!("[updater] cleared pending signed update");
    Ok(IpcResult::success(()))
}

/// Download the stored update, verify it, install it, and restart the app.
///
/// On Windows the installer closes this process and starts the new app.
/// On macOS and Linux this command restarts after install returns.
#[tauri::command]
pub async fn updater_install_signed(
    app: AppHandle,
    pending: State<'_, PendingSignedUpdate>,
    on_event: Channel<SignedDownloadEvent>,
) -> Result<IpcResult<()>, String> {
    let update = match pending.begin_install() {
        SlotBegin::Ready(update) => update,
        SlotBegin::Empty => {
            log::warn!("[updater] install requested with no pending signed update");
            return Ok(IpcResult::error(
                "No update available to install",
                "UPDATE_NOT_AVAILABLE",
            ));
        }
        SlotBegin::InstallInProgress => {
            log::warn!("[updater] install requested while another install is in progress");
            return Ok(IpcResult::error(
                "An update install is already in progress",
                UPDATE_INSTALL_IN_PROGRESS,
            ));
        }
    };

    let version = update.version.clone();
    log::info!("[updater] installing signed update version={version}");

    let finished = on_event.clone();
    let progress = on_event;
    let mut started = false;
    let install_result = update
        .download_and_install(
            move |chunk_length, content_length| {
                if !started {
                    started = true;
                    let _ = progress.send(SignedDownloadEvent {
                        event: "Started",
                        data: Some(SignedDownloadData {
                            content_length,
                            chunk_length: None,
                        }),
                    });
                }
                let _ = progress.send(SignedDownloadEvent {
                    event: "Progress",
                    data: Some(SignedDownloadData {
                        content_length: None,
                        chunk_length: Some(chunk_length),
                    }),
                });
            },
            move || {
                let _ = finished.send(SignedDownloadEvent {
                    event: "Finished",
                    data: None,
                });
            },
        )
        .await;

    if let Err(err) = install_result {
        log::warn!("[updater] signed install failed version={version} error={err}");
        pending.abort_install(update);
        let code = if err.to_string().to_ascii_lowercase().contains("signature") {
            "INSTALL_FAILED"
        } else {
            "DOWNLOAD_FAILED"
        };
        return Ok(IpcResult::error(err.to_string(), code));
    }

    pending.finish_install();

    // Windows NSIS exits this process from inside install. macOS and Linux
    // return here, and the new bundle runs only after an explicit restart.
    #[cfg(not(target_os = "windows"))]
    {
        log::info!("[updater] signed install finished, restarting app version={version}");
        app.restart();
    }

    #[cfg(target_os = "windows")]
    {
        log::info!("[updater] signed install finished version={version}");
        let _ = app;
    }

    #[allow(unreachable_code)]
    Ok(IpcResult::success(()))
}

#[cfg(test)]
mod tests;
