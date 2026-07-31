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
        Ok(()) => log::info!(
            "cloudflared tunnel reachable — edge routes to origin ({url})"
        ),
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

    let mut child = command
        .spawn()
        .map_err(|e| {
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
                        return;
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
mod tests {
    use super::*;

    #[test]
    fn sidecar_name_is_nonempty() {
        assert!(!cloudflared_sidecar_name().is_empty());
    }

    #[test]
    fn resolve_path_returns_a_string_and_known_source() {
        let (path, source) = resolve_cloudflared_path();
        assert!(!path.is_empty());
        // "env" only with the env var set; "sidecar" when a bundled file is
        // found; "path" is the bare-name fallback (dev/CI without the binary).
        assert!(
            matches!(source.as_str(), "env" | "sidecar" | "path"),
            "unexpected source: {source}"
        );
    }

    #[test]
    fn detect_caches_first_resolution() {
        let a = detect_cloudflared_path();
        let b = detect_cloudflared_path();
        assert_eq!(a, b, "detect_cloudflared_path must be idempotent");
    }

    #[test]
    fn url_regex_matches_trycloudflare_hostnames() {
        let line = "2026-07-30 INF Your quick Tunnel has been created! Visit it at: https://foo-bar-baz.trycloudflare.com";
        let m = TRY_TUNNEL_URL_RE.find(line).expect("must match");
        assert_eq!(m.as_str(), "https://foo-bar-baz.trycloudflare.com");
    }

    #[test]
    fn url_regex_matches_inside_json_logs() {
        let line = "{\"level\":\"info\",\"url\":\"https://random-words-1234.trycloudflare.com\"}";
        let m = TRY_TUNNEL_URL_RE.find(line).expect("must match");
        assert_eq!(m.as_str(), "https://random-words-1234.trycloudflare.com");
    }

    #[test]
    fn url_regex_ignores_localhost_urls() {
        // The QR must encode the PUBLIC tunnel URL, never the local one.
        assert!(TRY_TUNNEL_URL_RE
            .find("listening on http://localhost:5123")
            .is_none());
    }

    #[test]
    fn url_regex_ignores_arbitrary_https_urls() {
        assert!(TRY_TUNNEL_URL_RE
            .find("redirect to https://example.com/path")
            .is_none());
    }

    #[tokio::test]
    async fn probe_returns_err_for_unreachable_url_near_deadline() {
        // Port 1 on loopback → connection refused (fast), so each GET returns
        // immediately; the 2s deadline bounds total elapsed time. Asserts the
        // probe gives up near the deadline (never hangs) + surfaces the error.
        let start = std::time::Instant::now();
        let result = probe_tunnel_ready_with(
            "http://127.0.0.1:1/",
            std::time::Duration::from_secs(2),
            std::time::Duration::from_millis(250),
        )
        .await;
        assert!(result.is_err(), "unreachable URL must not be reported ready");
        // Tight bound: the deadline + capped retry sleep can't overshoot by a
        // full interval, so ~2s + small epsilon — well under 3s.
        assert!(
            start.elapsed() < std::time::Duration::from_secs(3),
            "probe must give up near the deadline, not hang; took {:?}",
            start.elapsed()
        );
        assert!(result.unwrap_err().contains("not reachable within 2s"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn probe_bounded_by_deadline_against_hanging_listener() {
        // A listener that accepts the TCP connection but never sends an HTTP
        // response — so the only thing that unblocks each GET is the probe's
        // per-request timeout. This exercises the timeout + capped-retry-sleep
        // path the port-1 (instant-refuse) test can't.
        let addr = spawn_hanging_listener().await;
        let url = format!("http://{addr}/");
        let start = std::time::Instant::now();
        let result = probe_tunnel_ready_with(
            &url,
            std::time::Duration::from_secs(2),
            std::time::Duration::from_millis(500),
        )
        .await;
        assert!(result.is_err(), "hanging listener must not be reported ready");
        // The per-request timeout is capped to the remaining deadline, so total
        // wait must hug the 2s bound — not the 3s per-request default.
        assert!(
            start.elapsed() < std::time::Duration::from_secs(3),
            "probe overshot the deadline: {:?}",
            start.elapsed()
        );
    }

    /// A local TCP listener that accepts connections but never sends an HTTP
    /// response, so a probe client's per-request timeout is the only unblock.
    async fn spawn_hanging_listener() -> std::net::SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind hanging listener");
        let addr = listener.local_addr().expect("local addr");
        tokio::spawn(async move {
            // Accept connections but never send an HTTP response — a probe
            // client's per-request timeout is the only unblock.
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let _ = tokio::time::sleep(std::time::Duration::from_secs(120)).await;
                    drop(stream);
                });
            }
        });
        addr
    }
}
