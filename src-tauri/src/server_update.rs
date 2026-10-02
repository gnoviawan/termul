//! Opt-in self-update subsystem for the standalone `termul-server` binary.
//!
//! The desktop app updates via the signed `@tauri-apps/plugin-updater` flow; the
//! standalone server has no Tauri runtime, so it ships its own bespoke updater
//! that reuses the **same** minisign keypair the desktop updater trusts.
//!
//! Flow (opt-in, default off — `server_main.rs` only wires it when
//! `TERMUL_SERVER_UPDATE_ENABLED=true` + `TERMUL_SERVER_UPDATE_CHANNEL` are set):
//!
//! 1. Fetch the per-channel manifest (`latest-<channel>.json`) from GitHub
//!    Releases.
//! 2. Compare the manifest `version` against `CARGO_PKG_VERSION` with full
//!    SemVer 2.0 prerelease precedence (`0.5.0` > `0.5.0-rc.1` >
//!    `0.0.0-nightly.*`).
//! 3. Download the `linux-x86_64-server` binary + its minisign `.sig`.
//! 4. **Verify the signature before any filesystem mutation** — on failure the
//!    running binary is untouched (no brick).
//! 5. Atomic swap: write `<bin>.new` → `fsync` → rename current → `<bin>.old`
//!    → rename `.new` → current (executable on Unix). The `.old` file is kept
//!    so a failed new-binary start can be rolled back with one `mv`.
//! 6. Restart: self-reexec into the new binary (`CommandExt::exec`), which
//!    preserves the PID (works standalone AND under systemd `Restart=`).
//!
//! The verify-before-swap ordering is the invariant that lets a bad signature
//! leave the old binary running — see `apply_verified_update` + its tests.

use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use futures::StreamExt;
use minisign_verify::{PublicKey, Signature};
use serde::Deserialize;

/// GitHub release channel the server tracks. Mirrors the desktop renderer's
/// `UpdateChannel` so both targets share one channel model + manifest scheme.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateChannel {
    Stable,
    Insider,
    Nightly,
}

impl UpdateChannel {
    /// Parse the `TERMUL_SERVER_UPDATE_CHANNEL` env value. `None` for anything
    /// unrecognized — the caller treats an absent/invalid channel as "no checks".
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "stable" => Some(Self::Stable),
            "insider" => Some(Self::Insider),
            "nightly" => Some(Self::Nightly),
            _ => None,
        }
    }

    /// Per-channel manifest URL. Matches the desktop facade's
    /// `CHANNEL_MANIFEST_URLS` exactly so both targets consult the same asset.
    pub fn manifest_url(self) -> &'static str {
        match self {
            Self::Stable => {
                "https://github.com/gnoviawan/termul/releases/latest/download/latest-stable.json"
            }
            Self::Insider => {
                "https://github.com/gnoviawan/termul/releases/download/insider/latest-insider.json"
            }
            Self::Nightly => {
                "https://github.com/gnoviawan/termul/releases/download/nightly/latest-nightly.json"
            }
        }
    }
}

/// The manifest platform key the server downloads. `linux-x86_64-server` is
/// additive to the desktop keys (`windows-x86_64`, `darwin-*`, …) so one
/// manifest covers both targets.
pub const SERVER_PLATFORM_KEY: &str = "linux-x86_64-server";

/// Per-channel updater manifest (Tauri updater format).
#[derive(Debug, Deserialize)]
pub struct Manifest {
    pub version: String,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(rename = "pub_date", default)]
    pub pub_date: Option<String>,
    #[serde(default)]
    pub platforms: std::collections::HashMap<String, PlatformRecord>,
}

#[derive(Debug, Deserialize)]
pub struct PlatformRecord {
    pub url: String,
    pub signature: String,
}

/// True only when the operator explicitly opts in via
/// `TERMUL_SERVER_UPDATE_ENABLED=true` (case-insensitive). Absent → off.
pub fn is_update_enabled() -> bool {
    std::env::var("TERMUL_SERVER_UPDATE_ENABLED")
        .map(|v| v.trim().eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

/// The compile-time-embedded minisign public key, reused from the desktop
/// updater's `TAURI_SIGNING_PUBLIC_KEY` secret (the same base64-wrapped
/// `minisign.pub` text that lives in `tauri.conf.json`'s `pubkey` field).
/// `None` when the secret was absent at build time — self-update is then
/// disabled because signatures cannot be verified (safe default).
pub fn embedded_public_key_outer() -> Option<&'static str> {
    option_env!("TAURI_SIGNING_PUBLIC_KEY")
}

/// Parse the base64-wrapped minisign pubkey text into a verifiable `PublicKey`.
/// `outer_b64` decodes to the `minisign.pub` file text (untrusted comment line
/// + raw pubkey line), which `PublicKey::decode` accepts directly.
pub fn resolve_public_key(outer_b64: &str) -> Result<PublicKey> {
    let decoded = BASE64_STANDARD
        .decode(outer_b64.trim())
        .context("embedded pubkey is not valid base64")?;
    let text =
        std::str::from_utf8(&decoded).context("decoded minisign pubkey text is not UTF-8")?;
    PublicKey::decode(text).context("decoded text is not a valid minisign public key")
}

/// Lazily-resolved embedded public key. Repeated periodic checks reuse the
/// single parse; a parse failure is sticky (the key won't change at runtime).
pub fn embedded_public_key() -> Result<&'static PublicKey> {
    static KEY: OnceLock<Result<PublicKey>> = OnceLock::new();
    KEY.get_or_init(|| {
        let outer = embedded_public_key_outer().ok_or_else(|| {
            anyhow!(
                "TAURI_SIGNING_PUBLIC_KEY is not baked into this build; \
                     server self-update is disabled (cannot verify signatures)"
            )
        })?;
        resolve_public_key(outer)
    })
    .as_ref()
    .map_err(|e| anyhow!("{e}"))
}

// ---------------------------------------------------------------------------
// Version comparison — full SemVer 2.0 prerelease precedence.
// Ported from the desktop `compareVersions` so both targets agree, and so
// `0.0.0-nightly.*` (core 0.0.0 + prerelease) is always less than any real
// release: a nightly server that switches to Stable is always offered it.
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct ParsedSemver {
    core: [u64; 3],
    prerelease: Vec<String>,
}

/// Normalize a version for comparison: trim, strip a leading `v`, drop build
/// metadata (`+...`). The prerelease segment (`-rc.1`, `-nightly.*`) is
/// preserved so prerelease precedence is honored across channels.
pub fn normalize_version(version: &str) -> String {
    let trimmed = version.trim().trim_start_matches(['v', 'V']);
    // A leading `v`/`V` is already stripped above; drop build metadata only.
    trimmed.split('+').next().unwrap_or(trimmed).to_owned()
}

fn parse_semver(version: &str) -> ParsedSemver {
    let (core_str, pre_str) = match version.find('-') {
        Some(idx) => (&version[..idx], &version[idx + 1..]),
        None => (version, ""),
    };
    let mut core = [0u64; 3];
    for (idx, part) in core_str.split('.').take(3).enumerate() {
        core[idx] = part.parse::<u64>().unwrap_or(0);
    }
    let prerelease = if pre_str.is_empty() {
        Vec::new()
    } else {
        pre_str.split('.').map(String::from).collect()
    };
    ParsedSemver { core, prerelease }
}

fn is_numeric_identifier(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit())
}

/// Compare two prerelease identifier lists per SemVer 2.0 precedence.
fn compare_prerelease(a: &[String], b: &[String]) -> Ordering {
    let len = a.len().max(b.len());
    for i in 0..len {
        match (a.get(i), b.get(i)) {
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) => {
                let x_num = is_numeric_identifier(x);
                let y_num = is_numeric_identifier(y);
                match (x_num, y_num) {
                    (true, true) => {
                        let xi: u64 = x.parse().unwrap_or(0);
                        let yi: u64 = y.parse().unwrap_or(0);
                        match xi.cmp(&yi) {
                            Ordering::Equal => continue,
                            other => return other,
                        }
                    }
                    // Numeric identifiers always precede alphanumeric ones.
                    (true, false) => return Ordering::Less,
                    (false, true) => return Ordering::Greater,
                    (false, false) => match x.cmp(y) {
                        Ordering::Equal => continue,
                        other => return other,
                    },
                }
            }
            (None, None) => break,
        }
    }
    Ordering::Equal
}

/// Compare two versions with full SemVer 2.0 prerelease precedence.
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    let pa = parse_semver(&normalize_version(a));
    let pb = parse_semver(&normalize_version(b));

    for i in 0..3 {
        match pa.core[i].cmp(&pb.core[i]) {
            Ordering::Equal => continue,
            other => return other,
        }
    }

    let a_has = !pa.prerelease.is_empty();
    let b_has = !pb.prerelease.is_empty();
    match (a_has, b_has) {
        (false, false) => Ordering::Equal,
        // A release (no prerelease) is greater than any prerelease.
        (false, true) => Ordering::Greater,
        (true, false) => Ordering::Less,
        (true, true) => compare_prerelease(&pa.prerelease, &pb.prerelease),
    }
}

/// True when `manifest_version` is strictly greater than `current_version`
/// (SemVer prerelease precedence).
pub fn is_newer(manifest_version: &str, current_version: &str) -> bool {
    compare_versions(manifest_version, current_version) == Ordering::Greater
}

/// The running crate version (`CARGO_PKG_VERSION`), stamped to the channel
/// version at build time (nightly rewrites it to `0.0.0-nightly.*`).
pub fn current_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Select the server's platform record from a channel manifest.
pub fn select_platform_record<'a>(
    manifest: &'a Manifest,
    platform_key: &str,
) -> Option<&'a PlatformRecord> {
    manifest.platforms.get(platform_key)
}

// ---------------------------------------------------------------------------
// Network I/O seams (not unit-tested — exercised by the manual checks).
// ---------------------------------------------------------------------------

/// Allowed origin for downloaded server binaries. Mirrors the desktop's
/// `releaseUrlAssetName` validator: a manifest `url` outside the termul GitHub
/// repo is rejected so a compromised manifest can't redirect the server at an
/// attacker-controlled binary (the signature check would still catch a forged
/// binary, but rejecting the origin is defense-in-depth).
const ALLOWED_BINARY_URL_PREFIX: &str = "https://github.com/gnoviawan/termul/";

/// Cap on a downloaded server binary so a manifest endpoint that lies about
/// Content-Length (or omits it) can't exhaust memory. 200 MiB is generous for
/// the standalone `termul-server` binary (a stripped release build is tens of
/// MiB) while bounding the exposure.
const MAX_BINARY_BYTES: usize = 200 * 1024 * 1024;

/// Shared reqwest client (constructed once): sets a `User-Agent` so GitHub's
/// anonymous request gate doesn't 403, and a total request timeout so a hung
/// manifest/binary endpoint can't stall the periodic loop indefinitely.
fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("termul-server-updater")
            .timeout(Duration::from_secs(120))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// Reject a server-binary download URL outside the termul GitHub origin.
pub fn validate_binary_url(url: &str) -> Result<()> {
    if !url.trim().starts_with(ALLOWED_BINARY_URL_PREFIX) {
        bail!("server binary url {url} is outside the allowed origin {ALLOWED_BINARY_URL_PREFIX}");
    }
    Ok(())
}

/// Fetch + parse the per-channel manifest.
pub async fn fetch_manifest(channel: UpdateChannel) -> Result<Manifest> {
    let url = channel.manifest_url();
    let response = http_client()
        .get(url)
        .send()
        .await
        .with_context(|| format!("failed to fetch channel manifest from {url}"))?;
    if !response.status().is_success() {
        bail!("channel manifest {url} returned HTTP {}", response.status());
    }
    let manifest: Manifest = response
        .json()
        .await
        .with_context(|| format!("failed to decode channel manifest from {url}"))?;
    Ok(manifest)
}

/// Download the signed server binary bytes for a platform record. Rejects URLs
/// outside the termul GitHub origin, and caps the body at [`MAX_BINARY_BYTES`]
/// (checked against Content-Length up front AND enforced mid-stream so a server
/// that lies about the length can't exhaust memory).
pub async fn download_binary(url: &str) -> Result<Vec<u8>> {
    validate_binary_url(url)?;
    let response = http_client()
        .get(url)
        .send()
        .await
        .with_context(|| format!("failed to download server binary from {url}"))?;
    if !response.status().is_success() {
        bail!("server binary {url} returned HTTP {}", response.status());
    }
    if let Some(len) = response.content_length() {
        if len > MAX_BINARY_BYTES as u64 {
            bail!(
                "server binary {url} content-length {len} exceeds the {MAX_BINARY_BYTES}-byte cap"
            );
        }
    }
    // Stream + cap so a server that omits/under-reports Content-Length still
    // can't push an unbounded body.
    let mut buf = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.with_context(|| format!("failed to read server binary body from {url}"))?;
        if buf.len() + chunk.len() > MAX_BINARY_BYTES {
            bail!("server binary {url} exceeded the {MAX_BINARY_BYTES}-byte cap mid-stream");
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

// ---------------------------------------------------------------------------
// Signature verification.
// ---------------------------------------------------------------------------

/// Verify a minisign signature over `binary` using `public_key`.
///
/// `allow_legacy = true` accepts both modern (prehashed `B2`) and legacy (`Ed`)
/// signatures, so the same keypair verifies regardless of which minisign
/// variant the Tauri signer emits. Forging either still requires the private
/// key, so accepting legacy does not weaken against forgery.
pub fn verify_signature(binary: &[u8], signature_text: &str, public_key: &PublicKey) -> Result<()> {
    let signature =
        Signature::decode(signature_text).context("failed to decode minisign signature")?;
    public_key
        .verify(binary, &signature, true)
        .map_err(|e| anyhow!("signature verification failed: {e}"))
}

// ---------------------------------------------------------------------------
// Atomic swap with rollback.
// ---------------------------------------------------------------------------

/// Sibling path: `<binary>.new` / `<binary>.old` (ASCII suffix append).
fn sibling(path: &Path, suffix: &str) -> PathBuf {
    PathBuf::from(format!("{}{suffix}", path.to_string_lossy()))
}

/// Atomically replace `binary_path` with `new_bytes`, keeping the previous
/// binary at `<binary>.old` for rollback. Writes `<binary>.new`, fsyncs, then
/// renames current → `.old` and `.new` → current; if the second rename fails
/// the `.old` is restored so the deployment is never left without a binary.
/// On Unix the new binary is made executable.
pub fn atomic_swap(binary_path: &Path, new_bytes: &[u8]) -> Result<PathBuf> {
    let new_path = sibling(binary_path, ".new");
    let old_path = sibling(binary_path, ".old");
    // Capture the running binary's mode before renaming it away so the promoted
    // file inherits the operator's chosen permissions (not a hardcoded 0o755).
    let prev_mode = preserved_mode(binary_path);

    {
        let mut file = std::fs::File::create(&new_path)
            .with_context(|| format!("failed to create {}", new_path.display()))?;
        use std::io::Write;
        file.write_all(new_bytes)
            .with_context(|| format!("failed to write {}", new_path.display()))?;
        // Durability: the downloaded bytes must reach disk before the rename.
        file.sync_all()
            .with_context(|| format!("failed to fsync {}", new_path.display()))?;
    }

    // Drop a stale `.old` from a prior (aborted) swap so the rename below lands.
    if old_path.exists() {
        std::fs::remove_file(&old_path)
            .with_context(|| format!("remove stale {}", old_path.display()))?;
    }

    // Preserve the running binary for rollback before promoting the new one.
    if binary_path.exists() {
        std::fs::rename(binary_path, &old_path).with_context(|| {
            format!("rename {} -> {}", binary_path.display(), old_path.display())
        })?;
    }

    // Promote `.new` → current. If this fails, restore `.old` so a binary always
    // exists at `binary_path` (never brick the deployment mid-swap). If the
    // restore ALSO fails, the deployment has no binary — surface that
    // double-failure loudly instead of silently swallowing it.
    if let Err(e) = std::fs::rename(&new_path, binary_path) {
        match std::fs::rename(&old_path, binary_path) {
            Ok(()) => {}
            Err(restore_err) => {
                eprintln!(
                    "termul-server self-update: CRITICAL — promote {} -> {} failed ({e}) \
                     AND restore {} -> {} also failed ({restore_err}); \
                     no binary at {} — recover the `.old` file manually",
                    new_path.display(),
                    binary_path.display(),
                    old_path.display(),
                    binary_path.display(),
                    binary_path.display()
                );
            }
        }
        return Err(e).with_context(|| {
            format!("rename {} -> {}", new_path.display(), binary_path.display())
        });
    }

    make_executable(binary_path, prev_mode)?;
    Ok(old_path)
}

/// Restore the previous binary from `<binary>.old` (manual rollback path).
pub fn restore_previous(binary_path: &Path, old_path: &Path) -> Result<()> {
    if !old_path.exists() {
        bail!("no previous binary at {} to restore", old_path.display());
    }
    let prev_mode = preserved_mode(old_path);
    std::fs::rename(old_path, binary_path).with_context(|| {
        format!(
            "restore {} -> {}",
            old_path.display(),
            binary_path.display()
        )
    })?;
    make_executable(binary_path, prev_mode)?;
    Ok(())
}

/// Capture a file's current Unix mode (for preserving the replaced binary's
/// permissions across the atomic swap). `None` on non-Unix or when the file is
/// absent.
#[cfg(unix)]
fn preserved_mode(path: &Path) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .ok()
        .map(|m| m.permissions().mode() & 0o7777)
}

#[cfg(not(unix))]
fn preserved_mode(_path: &Path) -> Option<u32> {
    None
}

/// Apply `prev_mode` (the replaced binary's mode) to `path`, ensuring the
/// owner-execute bit is set. Don't hardcode 0o755 — an operator may have chosen
/// a different mode (e.g. restrict group/other) that should survive the swap;
/// only the execute bit is added on top.
#[cfg(unix)]
fn make_executable(path: &Path, prev_mode: Option<u32>) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mode = prev_mode.unwrap_or(0o755);
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode | 0o100))
        .with_context(|| format!("set executable perms on {}", path.display()))
}

#[cfg(not(unix))]
fn make_executable(_path: &Path, _prev_mode: Option<u32>) -> Result<()> {
    Ok(())
}

// ---------------------------------------------------------------------------
// Orchestrator: verify-before-swap (the no-brick-on-bad-sig invariant).
// ---------------------------------------------------------------------------

/// Apply a downloaded update: **verify the signature first**, then atomically
/// swap. Returns the `.old` path on success. On signature failure this returns
/// `Err` without touching the running binary — see the
/// `apply_verified_update_*` tests.
pub fn apply_verified_update(
    binary_path: &Path,
    new_bytes: &[u8],
    signature_text: &str,
    public_key: &PublicKey,
) -> Result<PathBuf> {
    // Verify BEFORE any filesystem mutation — a bad signature leaves the old
    // binary running (no `.new`/`.old` artifacts created).
    verify_signature(new_bytes, signature_text, public_key)?;
    atomic_swap(binary_path, new_bytes)
}

/// Outcome of a periodic / one-shot update check.
#[derive(Debug)]
pub enum UpdateOutcome {
    /// Manifest fetched but no newer server binary is available.
    NoUpdate,
    /// Verified, swapped, and ready to restart into this new version. Carries
    /// the `.old` path so the caller can roll back if the reexec fails.
    Updated {
        new_version: String,
        old_path: PathBuf,
    },
}

/// Options for a full check-and-apply cycle.
pub struct UpdateOptions {
    pub channel: UpdateChannel,
    pub current_version: String,
    pub binary_path: PathBuf,
    pub platform_key: &'static str,
    // `&'static` — the key is resolved once from a `OnceLock` and lives for the
    // process lifetime, so a spawned periodic task can hold the ref directly
    // without cloning.
    pub public_key: &'static PublicKey,
}

/// Full cycle: fetch manifest → decide → download → verify → atomic swap.
/// Does **not** restart — the caller logs + reexecs on `Updated` so the
/// orchestrator stays unit-testable (no process replacement in the hot path).
pub async fn check_and_apply_update(opts: &UpdateOptions) -> Result<UpdateOutcome> {
    let manifest = fetch_manifest(opts.channel).await?;

    let Some(record) = select_platform_record(&manifest, opts.platform_key) else {
        // Manifest has no server entry for this platform key — nothing to do.
        return Ok(UpdateOutcome::NoUpdate);
    };

    if !is_newer(&manifest.version, &opts.current_version) {
        return Ok(UpdateOutcome::NoUpdate);
    }

    let new_bytes = download_binary(&record.url).await?;
    // verify-before-swap guarantees a bad signature never bricks the server.
    let old_path = apply_verified_update(
        &opts.binary_path,
        &new_bytes,
        &record.signature,
        opts.public_key,
    )?;

    Ok(UpdateOutcome::Updated {
        new_version: manifest.version,
        old_path,
    })
}

/// Restart into the (just-swapped) new binary via self-reexec. `exec` replaces
/// the process image in place, preserving the PID — so this works standalone
/// AND under a systemd unit with `Restart=` (the supervisor sees continuity,
/// not a crash-restart). The `--check-update` one-shot flag is stripped so the
/// reexec'd binary starts the server normally instead of re-looping the check.
///
/// `binary_path` is the canonical install path (NOT `current_exe()`): on Linux
/// `/proc/self/exe` follows the inode, so after `atomic_swap` renames the
/// running binary to `<bin>.old`, `current_exe()` would resolve to `<bin>.old`
/// and re-exec the OLD binary. Exec the install path directly — it now points
/// at the freshly-promoted new binary.
///
/// Only meaningful on Unix (the server target is linux-x64); returns an error
/// on other platforms without touching the process.
pub fn restart_binary(binary_path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Drop `--check-update` so the new binary runs the server / periodic
        // loop rather than re-entering the one-shot check (which would loop).
        let args: Vec<String> = std::env::args()
            .skip(1)
            .filter(|arg| arg != "--check-update")
            .collect();
        let error = std::process::Command::new(binary_path).args(&args).exec();
        // `exec` only returns on failure.
        Err(anyhow!(
            "re-exec of {} failed: {error}",
            binary_path.display()
        ))
    }

    #[cfg(not(unix))]
    {
        // The server target is linux-x64; reexec is unsupported elsewhere so the
        // build still compiles on Windows/macOS dev hosts + under `cargo test`.
        let _ = binary_path;
        Err(anyhow!("self-reexec is not supported on this platform"))
    }
}

#[cfg(test)]
mod tests;
