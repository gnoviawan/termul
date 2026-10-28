//! Desktop-side channel manifest fetch for the insider/nightly updater path.
//!
//! The renderer's `fetchChannelManifest` previously did a `fetch()` to
//! `https://github.com/.../releases/download/...`, which is blocked by CSP
//! (`connect-src` allows only `https://api.github.com`) AND CORS (GitHub
//! release-download assets return no `Access-Control-Allow-Origin`). This
//! module performs the same fetch server-side via reqwest — where CSP/CORS do
//! not apply — and returns the parsed manifest JSON as `IpcResult<Value>`.
//!
//! URL source of truth: [`server_update::UpdateChannel::manifest_url`] —
//! reused (not duplicated) so the desktop command, the standalone server, and
//! the renderer error messages never drift.

use std::sync::OnceLock;
use std::time::Duration;

use crate::commands::IpcResult;
use crate::server_update::UpdateChannel;

/// Desktop-specific User-Agent so GitHub's anonymous request gate doesn't 403.
/// Distinct from `server_update.rs`'s `termul-server-updater` so access logs
/// can attribute requests to the desktop manager vs. the standalone server.
const USER_AGENT: &str = "termul-manager-updater";

/// Total request timeout — caps a hung manifest endpoint so the periodic
/// check cannot stall indefinitely. Mirrors `server_update.rs`'s 120s cap.
const REQUEST_TIMEOUT_SECS: u64 = 120;

/// Shared reqwest client (constructed once): sets a `User-Agent` so GitHub's
/// anonymous request gate doesn't 403, and a total request timeout so a hung
/// manifest endpoint can't stall the check indefinitely. Mirrors the
/// `embedded_public_key()` `OnceLock<Result<T>>` pattern in `server_update.rs`.
///
/// Returns `Result` so a `ClientBuilder::build()` failure (TLS init, resolver
/// config) propagates as an `Err` that `fetch_channel_manifest` maps to
/// `NETWORK_ERROR` — NOT a panic. (`reqwest::Client::new()` internally
/// `expect`s the build result, so the previous `unwrap_or_else` fallback could
/// unwind the periodic check on a TLS-init failure instead of surfacing an
/// error.)
fn http_client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .user_agent(USER_AGENT)
                .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
                .build()
                .map_err(|e| format!("network error: failed to build updater HTTP client: {e}"))
        })
        .as_ref()
        .map_err(|e| e.to_string())
}

/// Fetch + parse the per-channel manifest.
///
/// Validates `channel` via [`UpdateChannel::parse`] (the single source of
/// truth for the accepted values + URLs), then GETs the manifest with a
/// `User-Agent` + 120s timeout. Returns the parsed manifest JSON, or an
/// `Err(String)` describing the failure (unknown channel, network error,
/// non-2xx, or non-object body).
///
/// No live network is exercised for an unknown channel — the parse fails first.
pub async fn fetch_channel_manifest(channel: &str) -> Result<serde_json::Value, String> {
    let parsed = UpdateChannel::parse(channel)
        .ok_or_else(|| format!("unknown update channel: {channel}"))?;
    let url = parsed.manifest_url();
    log::info!(
        "[updater] fetching channel manifest channel={} url={}",
        channel,
        url
    );

    let response = http_client()?
        .get(url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("network error fetching channel manifest from {url}: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        log::warn!(
            "[updater] channel manifest fetch failed channel={} url={} status={}",
            channel,
            url,
            status
        );
        return Err(format!("channel manifest {url} returned HTTP {status}"));
    }

    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("failed to decode channel manifest from {url}: {e}"))?;

    if !body.is_object() {
        log::warn!(
            "[updater] channel manifest is not a JSON object channel={} url={}",
            channel,
            url
        );
        return Err(format!("channel manifest {url} is not a JSON object"));
    }

    log::info!(
        "[updater] channel manifest fetch ok channel={} url={} status={}",
        channel,
        url,
        status
    );
    Ok(body)
}

/// Desktop command: fetch the per-channel update manifest server-side (where
/// CSP/CORS do not apply) and return it as `IpcResult<Value>`. The renderer
/// facade `fetchChannelManifest` invokes this instead of a raw `fetch()` to
/// `github.com`.
///
/// Error codes:
/// - `INVALID_UPDATE_CHANNEL` — `channel` is not `stable`/`insider`/`nightly`
///   (no network call made).
/// - `NETWORK_ERROR` — reqwest failed to send or receive (DNS, TLS, timeout,
///   connection reset).
/// - `UPDATE_CHECK_FAILED` — the manifest endpoint returned a non-2xx status
///   (e.g. 404 for an unreleased insider channel).
/// - `INVALID_UPDATE_INFO` — the response body is not a JSON object.
#[tauri::command]
pub async fn updater_fetch_channel_manifest(
    channel: String,
) -> Result<IpcResult<serde_json::Value>, String> {
    match fetch_channel_manifest(&channel).await {
        Ok(value) => Ok(IpcResult::success(value)),
        Err(message) => {
            let code = if message.starts_with("unknown update channel") {
                "INVALID_UPDATE_CHANNEL"
            } else if message.contains("network error") {
                "NETWORK_ERROR"
            } else if message.contains("returned HTTP") {
                "UPDATE_CHECK_FAILED"
            } else {
                "INVALID_UPDATE_INFO"
            };
            Ok(IpcResult::error(message, code))
        }
    }
}

/// Manifest URL for channels that update in-app through the signed updater
/// flow. Only Nightly: Stable keeps the build-time `plugins.updater.endpoints`
/// (JS `check()`), Insider stays on the manual release-page flow. Keep in sync
/// with `SIGNED_CHANNELS` in `src/renderer/lib/tauri-updater-api.ts`.
pub fn signed_channel_endpoint(channel: UpdateChannel) -> Option<&'static str> {
    match channel {
        UpdateChannel::Nightly => Some(channel.manifest_url()),
        UpdateChannel::Stable | UpdateChannel::Insider => None,
    }
}

/// Validate a renderer-supplied channel for the signed check. No network.
pub fn resolve_signed_channel(channel: &str) -> Result<UpdateChannel, String> {
    let parsed = UpdateChannel::parse(channel)
        .ok_or_else(|| format!("unknown update channel: {channel}"))?;
    if signed_channel_endpoint(parsed).is_none() {
        return Err(format!(
            "update channel {channel} does not support in-app updates through updater_check_channel"
        ));
    }
    Ok(parsed)
}

/// `(date, build)` from a nightly prerelease `nightly.<YYYYMMDD>.<sha>`.
fn nightly_build(version: &semver::Version) -> Option<(&str, &str)> {
    let mut parts = version.pre.as_str().splitn(3, '.');
    match (parts.next(), parts.next(), parts.next()) {
        (Some("nightly"), Some(date), Some(build)) => Some((date, build)),
        _ => None,
    }
}

/// Version gate for the signed channel check (replaces the plugin's default
/// `remote > current`). Nightly only accepts a newer build whose prerelease
/// is `nightly.<date>.<sha>`, so a stable or insider build that ever lands in
/// the nightly manifest is not installed from it. A stable build switching to
/// Nightly (e.g. 0.4.52 -> 0.5.0-nightly.*) is accepted because it is newer.
///
/// Same-day nightlies differ only in the short SHA, which SemVer compares
/// lexically and which carries no order. The nightly manifest is a moving
/// pointer to the latest build, so a different same-day build in it is
/// treated as newer instead of being skipped until the next date.
pub fn accepts_channel_update(
    channel: UpdateChannel,
    current: &semver::Version,
    remote: &semver::Version,
) -> bool {
    match channel {
        UpdateChannel::Nightly => {
            let Some((remote_date, remote_build)) = nightly_build(remote) else {
                return false;
            };
            let same_core = (remote.major, remote.minor, remote.patch)
                == (current.major, current.minor, current.patch);
            match nightly_build(current) {
                Some((current_date, current_build)) if same_core && current_date == remote_date => {
                    current_build != remote_build
                }
                _ => remote > current,
            }
        }
        UpdateChannel::Stable | UpdateChannel::Insider => false,
    }
}

/// Mirrors the updater plugin's `check` command response so the renderer can
/// wrap it in the plugin's JS `Update` class (`new Update(metadata)`).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedUpdateMetadata {
    rid: tauri::ResourceId,
    current_version: String,
    version: String,
    date: Option<String>,
    body: Option<String>,
    raw_json: serde_json::Value,
}

/// Desktop command: signed in-app update check for a non-stable channel.
///
/// Runs the updater plugin against the channel manifest from
/// [`signed_channel_endpoint`], inheriting the configured pubkey, so the
/// download is signature-verified exactly like Stable. Returns `None` when no
/// acceptable newer build exists. Errors (unsupported channel, unreachable or
/// invalid manifest, no entry for this platform) make the renderer fall back
/// to the manual release-page flow.
#[tauri::command]
pub async fn updater_check_channel<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    channel: String,
) -> Result<Option<SignedUpdateMetadata>, String> {
    let result = check_signed_channel(&webview, &channel).await;
    if let Err(message) = &result {
        log::warn!(
            "[updater] signed channel check failed channel={channel}, renderer falls back to manual download: {message}"
        );
    }
    result
}

async fn check_signed_channel<R: tauri::Runtime>(
    webview: &tauri::Webview<R>,
    channel: &str,
) -> Result<Option<SignedUpdateMetadata>, String> {
    use tauri::Manager;
    use tauri_plugin_updater::UpdaterExt;

    let parsed = resolve_signed_channel(channel)?;
    let url = signed_channel_endpoint(parsed)
        .ok_or_else(|| format!("no signed endpoint for update channel {channel}"))?;
    let endpoint = url::Url::parse(url).map_err(|e| format!("invalid manifest url {url}: {e}"))?;
    log::info!("[updater] signed channel check channel={channel} url={url}");

    let update = webview
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| format!("failed to configure updater endpoint {url}: {e}"))?
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .version_comparator(move |current, remote| {
            accepts_channel_update(parsed, &current, &remote.version)
        })
        .build()
        .map_err(|e| format!("failed to build updater for {url}: {e}"))?
        .check()
        .await
        .map_err(|e| format!("signed update check failed for {url}: {e}"))?;

    let Some(update) = update else {
        log::info!("[updater] signed channel check channel={channel}: up to date");
        return Ok(None);
    };
    log::info!(
        "[updater] signed channel check channel={channel}: {} -> {}",
        update.current_version,
        update.version
    );
    let date = update
        .raw_json
        .get("pub_date")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    Ok(Some(SignedUpdateMetadata {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        date,
        body: update.body.clone(),
        raw_json: update.raw_json.clone(),
        rid: webview.resources_table().add(update),
    }))
}

#[cfg(test)]
mod tests;
