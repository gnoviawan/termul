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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server_update::UpdateChannel;

    /// An unknown channel must fail WITHOUT any network call — the parse is
    /// the gate, so a bogus value never reaches reqwest.
    #[tokio::test]
    async fn fetch_channel_manifest_rejects_unknown_channel_without_network() {
        let result = fetch_channel_manifest("bogus").await;
        let err = result.expect_err("bogus channel must error");
        assert!(
            err.contains("unknown update channel"),
            "unexpected error: {err}"
        );
    }

    /// Parity guard: the three accepted channels must map to the same URLs
    /// `server_update::UpdateChannel::manifest_url()` returns. If someone
    /// changes the Rust constant, this breaks — prompting a check that the
    /// renderer `CHANNEL_MANIFEST_URLS` constant (the error-message source)
    /// is updated in lockstep so the surfaced error keeps naming the right URL.
    #[test]
    fn channel_manifest_urls_match_server_update() {
        assert_eq!(
            UpdateChannel::Stable.manifest_url(),
            "https://github.com/gnoviawan/termul/releases/latest/download/latest-stable.json"
        );
        assert_eq!(
            UpdateChannel::Insider.manifest_url(),
            "https://github.com/gnoviawan/termul/releases/download/insider/latest-insider.json"
        );
        assert_eq!(
            UpdateChannel::Nightly.manifest_url(),
            "https://github.com/gnoviawan/termul/releases/download/nightly/latest-nightly.json"
        );
    }
}
