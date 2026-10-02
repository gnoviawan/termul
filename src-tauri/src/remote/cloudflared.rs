//! Built-in `cloudflared` quick-tunnel sidecar for the desktop-hosted
//! shared-live server.
//!
//! Spawns `cloudflared tunnel --url http://localhost:{port}` so the desktop's
//! live agent sessions become reachable from a phone on any network via an
//! ephemeral `https://*.trycloudflare.com` URL (edge TLS, no account). The
//! StatusBar popover encodes that URL as a QR — scan to open.
//!
//! ## Sidecar resolution
//!
//! Mirrors the `rg` sidecar convention (`resolve_rg_path` in
//! `crate::commands`): per-target binary name + an env override
//! (`TERMUL_CLOUDFLARED_PATH`) + the same candidate dirs (`src-tauri/bin`,
//! `bin`, the running exe's dir, `../Resources`, `../lib`) + a `OnceLock`
//! cache. In dev/cloudflare-installed setups the bare `cloudflared` on PATH is
//! the last-resort fallback (`source = "path"`); production bundles resolve via
//! the `sidecar` candidate once the license-gated release step ships the binary
//! (see `spec-remote-qr-cloudflared-tunnel.md` Ask First).
//!
//! ## URL detection
//!
//! cloudflared prints the random trycloudflare hostname to stdout **or**
//! stderr (varies across versions). We regex-match the URL shape
//! `https://[a-z0-9-]+\.trycloudflare\.com` from both streams — the URL is the
//! invariant, not the surrounding human sentence ("Your quick Tunnel…").
//!
//! ## Lifecycle
//!
//! The spawned [`tokio::process::Child`] is returned to the caller
//! ([`RemoteServerState`]) so `stop()` can kill it alongside the Axum drain,
//! and `kill_on_drop(true)` is a safety net for the panic/abort path.
//! The pipe scanners keep draining the child's stdout/stderr for the whole
//! tunnel lifetime — closing the read ends early kills cloudflared with
//! EPIPE/SIGPIPE seconds after the URL appears (issue #593). Stopping the
//! tunnel kills the child, which closes the pipes and lets the scanners exit.
//! cloudflared provides edge TLS; application-level auth lands in Epic 2 —
//! until then the random ephemeral URL is the only gate.

use std::path::PathBuf;
use std::sync::OnceLock;

use lazy_static::lazy_static;
use regex::Regex;
use tokio::process::{Child, Command};
use tokio::sync::{oneshot, Mutex};

/// Spawn → URL deadline. cloudflared usually prints the URL within a few
/// seconds; 25s tolerates slow cold starts / sluggish networks. Beyond this we
/// give up, kill the child, and surface an error so the popover never hangs.
const TUNNEL_URL_TIMEOUT_SECS: u64 = 25;

lazy_static! {
    static ref TRY_TUNNEL_URL_RE: Regex =
        Regex::new(r"https://[a-z0-9-]+\.trycloudflare\.com").expect("valid static regex");
}

static CLOUDFLARED_PATH_CACHE: OnceLock<String> = OnceLock::new();

#[cfg(target_os = "windows")]
fn cloudflared_sidecar_name() -> &'static str {
    "cloudflared-x86_64-pc-windows-msvc.exe"
}
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn cloudflared_sidecar_name() -> &'static str {
    "cloudflared-aarch64-apple-darwin"
}
#[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
fn cloudflared_sidecar_name() -> &'static str {
    "cloudflared-x86_64-apple-darwin"
}
#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
fn cloudflared_sidecar_name() -> &'static str {
    "cloudflared-aarch64-unknown-linux-gnu"
}
#[cfg(all(target_os = "linux", not(target_arch = "aarch64")))]
fn cloudflared_sidecar_name() -> &'static str {
    "cloudflared-x86_64-unknown-linux-musl"
}
#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn cloudflared_sidecar_name() -> &'static str {
    "cloudflared"
}

/// Resolve the cloudflared binary path. Mirrors `resolve_rg_path`:
/// env override `TERMUL_CLOUDFLARED_PATH` (absolute, or relative to cwd /
/// `src-tauri`), then the bundled sidecar under the same candidate dirs as
/// `rg`. Returns `(path, source)`; `source = "path"` is the bare-name
/// last-resort fallback (resolved via PATH at spawn time).
///
/// Keep this function pure / side-effect-free so it can be unit-tested without
/// spawning processes.
pub fn resolve_cloudflared_path() -> (String, String) {
    if let Ok(env_val) = std::env::var("TERMUL_CLOUDFLARED_PATH") {
        let trimmed = env_val.trim();
        if !trimmed.is_empty() {
            let env_path = PathBuf::from(trimmed);
            if env_path.is_absolute() {
                return (trimmed.to_string(), "env".to_string());
            }
            if let Ok(cwd) = std::env::current_dir() {
                let direct = cwd.join(&env_path);
                if direct.exists() && direct.is_file() {
                    return (direct.to_string_lossy().to_string(), "env".to_string());
                }
                let from_src_tauri = cwd.join("src-tauri").join(&env_path);
                if from_src_tauri.exists() && from_src_tauri.is_file() {
                    return (
                        from_src_tauri.to_string_lossy().to_string(),
                        "env".to_string(),
                    );
                }
            }
            return (trimmed.to_string(), "env".to_string());
        }
    }

    let binary = cloudflared_sidecar_name();
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("src-tauri").join("bin").join(binary));
        candidates.push(cwd.join("bin").join(binary));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.join(binary));
            candidates.push(exe_dir.join("../Resources").join(binary));
            candidates.push(exe_dir.join("../lib").join(binary));
        }
    }
    if let Some(found) = candidates.into_iter().find(|p| p.exists() && p.is_file()) {
        return (found.to_string_lossy().to_string(), "sidecar".to_string());
    }
    ("cloudflared".to_string(), "path".to_string())
}

/// Cached resolved path (first call wins; mirrors `detect_rg_path`).
pub fn detect_cloudflared_path() -> String {
    if let Some(cached) = CLOUDFLARED_PATH_CACHE.get() {
        return cached.clone();
    }
    let (detected, _source) = resolve_cloudflared_path();
    let _ = CLOUDFLARED_PATH_CACHE.set(detected.clone());
    detected
}

#[cfg(target_os = "windows")]
fn configure_background_command(command: &mut Command) {
    // Reuse the same CREATE_NO_WINDOW flag (0x08000000) as the rg sidecar so
    // spawning cloudflared never flashes a console window on Windows. tokio's
    // `Command` exposes `creation_flags` as an inherent method on Windows.
    command.creation_flags(0x0800_0000);
}
#[cfg(not(target_os = "windows"))]
fn configure_background_command(_command: &mut Command) {}

/// A started quick tunnel: the public URL to expose (e.g. as a QR) and the live
/// child handle to kill on server stop / app exit.
pub struct QuickTunnel {
    pub url: String,
    pub child: Child,
}

/// Deadline for the post-URL reachability probe (see [`probe_tunnel_ready`]).
/// cloudflared prints the trycloudflare URL *before* the edge route is live;
/// this bounds how long we wait for the edge → origin path to return 2xx before
/// giving up + surfacing a "not reachable" error so the popover never offers a
/// dead QR.
const TUNNEL_READY_PROBE_TIMEOUT_SECS: u64 = 10;
/// Probe interval — balances responsiveness against edge/request load.
const TUNNEL_READY_PROBE_INTERVAL_MS: u64 = 500;

/// HTTP-probe the public trycloudflare URL until the edge routes to the origin
/// (2xx) or [`TUNNEL_READY_PROBE_TIMEOUT_SECS`] elapses. The probe round-trips
/// desktop → trycloudflare edge → cloudflared → localhost origin, exercising
/// the full path the phone will use — so a 2xx here is the only signal that the
/// QR will actually load (vs. cloudflared's "URL created" log line, which
/// fires before the edge route + phone-DNS converge and yields "This site
/// can't be reached" for an eager scan).
///
/// `reqwest` (rustls, already a dep) is the client — no new crate.
async fn probe_tunnel_ready(url: &str) -> Result<(), String> {
    probe_tunnel_ready_with(
        url,
        std::time::Duration::from_secs(TUNNEL_READY_PROBE_TIMEOUT_SECS),
        std::time::Duration::from_millis(TUNNEL_READY_PROBE_INTERVAL_MS),
    )
    .await
}

/// Parameterized probe core so tests can run a short deadline against a
/// definitely-unreachable URL without waiting the full 10s.
async fn probe_tunnel_ready_with(
    url: &str,
    timeout: std::time::Duration,
    interval: std::time::Duration,
) -> Result<(), String> {
    // No global client timeout — each request is capped to the *remaining*
    // deadline budget inside the loop, so a straggler near the deadline can't
    // push total wait past `timeout`. A hung send() still yields: reqwest errors
    // on the per-request timeout → reachable=false → the loop re-checks the
    // deadline + exits.
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("tunnel probe client build failed: {e}"))?;
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        // Cap each GET to the remaining budget (≤3s) so the probe can't
        // overshoot the documented `timeout` bound by a full request's duration.
        let per_request_timeout = deadline
            .saturating_duration_since(std::time::Instant::now())
            .min(std::time::Duration::from_secs(3));
        // Any 2xx means the edge is routing to the origin. Non-2xx / network
        // errors (edge not yet routing, NXDOMAIN, origin refused, per-request
        // timeout) → retry until the deadline.
        let reachable = client
            .get(url)
            .timeout(per_request_timeout)
            .send()
            .await
            .map(|resp| resp.status().is_success())
            .unwrap_or(false);
        if reachable {
            return Ok(());
        }
        // Cap the retry sleep by the remaining deadline so a sleep started near
        // the deadline can't push total wait past `timeout` by a full interval.
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        tokio::time::sleep(interval.min(remaining)).await;
    }
    Err(format!(
        "tunnel URL not reachable within {}s",
        timeout.as_secs()
    ))
}

/// Best-effort, non-blocking reachability probe: GET the public tunnel URL
/// until 2xx or the deadline, then log the outcome. Spawned in the background
/// by `remote_server_start` after the tunnel is attached, so the QR appears
/// immediately and the probe only informs the log — it never hides the QR on a
/// timeout (a slow edge / cold start must not block the connect UI).
pub async fn log_tunnel_reachability(url: String) {
    match probe_tunnel_ready(&url).await {
        Ok(()) => log::info!("cloudflared tunnel reachable — edge routes to origin ({url})"),
        Err(e) => log::warn!(
            "cloudflared tunnel not confirmed reachable within deadline ({url}): {e} \
             — QR shown anyway; rescan if the page doesn't load"
        ),
    }
}

/// Spawn `cloudflared tunnel --url http://localhost:{port}` and wait (up to
/// [`TUNNEL_URL_TIMEOUT_SECS`]) for the ephemeral trycloudflare URL.
///
/// # Errors
/// - `cloudflared binary not found at <path>: <io>` — spawn failed (binary
///   not installed / not bundled / PATH miss).
/// - `cloudflared exited before producing a tunnel URL` — the process died
///   without printing the URL.
/// - `tunnel URL not received within <N>s` — cloudflared ran but never
///   printed the URL (no internet, registration rejected, slow cold start).
///
/// On any error the child is killed before returning — no orphaned process.
pub async fn start_quick_tunnel(port: u16) -> Result<QuickTunnel, String> {
    let path = detect_cloudflared_path();
    let mut command = Command::new(&path);
    command
        .args(["tunnel", "--url", &format!("http://localhost:{port}")])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    configure_background_command(&mut command);

    let mut child = command.spawn().map_err(|e| {
        log::error!("cloudflared failed to spawn at {path}: {e}");
        format!("cloudflared binary not found at {path}: {e}")
    })?;
    log::info!(
        "cloudflared spawned (pid={:?}) from {path}; waiting for tunnel URL…",
        child.id()
    );

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "cloudflared stdout pipe missing".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "cloudflared stderr pipe missing".to_string())?;

    let (url_tx, url_rx) = oneshot::channel::<String>();
    let url_tx = std::sync::Arc::new(Mutex::new(Some(url_tx)));

    spawn_line_scanner(stdout, url_tx.clone());
    spawn_line_scanner(stderr, url_tx);

    match tokio::time::timeout(
        std::time::Duration::from_secs(TUNNEL_URL_TIMEOUT_SECS),
        url_rx,
    )
    .await
    {
        Ok(Ok(url)) => {
            // Return the URL + child immediately. The edge-reachability probe is
            // best-effort and runs in the background from `remote_server_start`
            // (after attach) — fail-closed probing hid the QR entirely on slow
            // edges / cold starts, which was worse than a scan that might need a
            // rescan. The staleness watchdog in `host::status` clears the QR
            // if cloudflared dies.
            log::info!("cloudflared tunnel URL obtained ({url})");
            Ok(QuickTunnel { url, child })
        }
        // Sender dropped without sending → cloudflared exited before printing.
        Ok(Err(_)) => {
            let _ = child.kill().await;
            log::warn!("cloudflared exited before producing a tunnel URL");
            Err("cloudflared exited before producing a tunnel URL".to_string())
        }
        Err(_) => {
            let _ = child.kill().await;
            log::warn!("tunnel URL not received within {TUNNEL_URL_TIMEOUT_SECS}s");
            Err(format!(
                "tunnel URL not received within {TUNNEL_URL_TIMEOUT_SECS}s"
            ))
        }
    }
}

/// Read lines from `reader` and fire the first trycloudflare URL match through
/// `url_tx`. On EOF without a match it drops the sender so the caller's oneshot
/// resolves with `Err` (→ "exited before producing a URL").
///
/// After the URL is delivered the scanner **keeps draining** the pipe until
/// EOF instead of returning. `start_quick_tunnel` `take()`s the child's
/// stdout/stderr handles, so this task is the sole owner of the read ends —
/// returning early closes them, cloudflared's next log write hits a closed
/// pipe (EPIPE/SIGPIPE), and the tunnel dies seconds after the QR appears
/// (issue #593). The child is killed on tunnel stop, which closes the pipes
/// and lets the scanner reach EOF and exit cleanly.
fn spawn_line_scanner<R>(reader: R, url_tx: std::sync::Arc<Mutex<Option<oneshot::Sender<String>>>>)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    use tokio::io::{AsyncBufReadExt, BufReader};

    tokio::spawn(async move {
        let mut reader = BufReader::new(reader);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => break, // EOF
                Ok(_) => {
                    if let Some(m) = TRY_TUNNEL_URL_RE.find(&line) {
                        if let Some(tx) = url_tx.lock().await.take() {
                            let _ = tx.send(m.as_str().to_string());
                        }
                        // Do NOT return here — keep draining so cloudflared's
                        // read end stays open (issue #593).
                    }
                }
                Err(_) => break,
            }
        }
        // EOF without a URL — drop the sender so the caller resolves Err.
        url_tx.lock().await.take();
    });
}

#[cfg(test)]
mod tests;
