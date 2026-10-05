//! POSIX browser-open shim for headless ACP OAuth (spec-acp-terminal-auth).
//!
//! On headless `termul-server`, an agent whose auth flow opens a browser on the
//! host (`xdg-open <auth-url>`) can never complete login: the OAuth redirect
//! targets `127.0.0.1` on the server, unreachable from the user's browser.
//!
//! This module installs a per-agent shim directory under
//! `temp_dir()/termul-acp-shim/<agent_id>/` holding tiny POSIX `sh` scripts for
//! the common browser-open entry points (`xdg-open`, `sensible-browser`,
//! `x-www-browser`, `www-browser`, `gnome-open`, `kde-open`, `open`, `gio`).
//! Each script appends its last `http(s)://` argument to a `urls` sink file and
//! exits 0 so the agent proceeds to its callback wait. The shim dir is
//! prepended to the agent's `PATH` (and `BROWSER` points at the shim
//! `xdg-open`) by [`inject_shim_env`], called from
//! `AgentConfig::to_mcp_server` — POSIX only; Windows keeps the native open.
//!
//! [`ShimWatcher`] polls the sink file (~500ms) on a dedicated thread and fans
//! each captured URL out as `acp:browser_open_request` `{agentId, url}`
//! (agent-level, `sid = None`) so it reaches the Tauri emit + WS relay
//! unchanged. The paste-back half lives in [`deliver_auth_redirect`]: the user
//! copies the failed loopback redirect URL from their own browser, the host
//! validates it is http(s) AND loopback-only (SSRF guard — never fetch
//! non-loopback URLs), then replays it with a plain GET (no redirect
//! following, 15s timeout) so the agent's own callback listener completes the
//! flow.
//!
//! Logging policy: captured/pasted URLs carry OAuth state — only scheme+host
//! (capture) or host+port (replay) are ever logged, never the full URL.

#[cfg(unix)]
use std::collections::{HashMap, HashSet};
use std::net::ToSocketAddrs;
#[cfg(unix)]
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(unix)]
use std::sync::Arc;
use std::time::Duration;

#[cfg(unix)]
use crate::acp::config::AgentId;
#[cfg(unix)]
use crate::acp::events::{self, BrowserOpenRequestEvent};
#[cfg(unix)]
use crate::web::EventSink;

/// Browser-open entry points shadowed by the shim. `gio` covers GLib's
/// `gio open`; `open` covers macOS-style launchers some agents shell out to.
#[cfg(unix)]
const SHIM_PROGRAMS: &[&str] = &[
    "xdg-open",
    "sensible-browser",
    "x-www-browser",
    "www-browser",
    "gnome-open",
    "kde-open",
    "open",
    "gio",
];

/// Name of the sink file each shim script appends captured URLs to.
#[cfg(unix)]
const SINK_FILE_NAME: &str = "urls";

/// Sink poll interval for the watcher thread.
#[cfg(unix)]
const SINK_POLL_INTERVAL: Duration = Duration::from_millis(500);

/// Timeout for the paste-back replay GET. The agent's loopback callback
/// listener answers locally, so 15s is generous; the bound exists so a dead
/// listener can't wedge the caller forever.
const REPLAY_TIMEOUT: Duration = Duration::from_secs(15);

/// The ~7-line POSIX `sh` shim body. Two jobs:
///   1. Capture: take the LAST argument matching `^https?://` (browser openers
///      may pass flags before the URL) and append it to the `urls` sink next
///      to the script.
///   2. Fall-through: if a REAL binary of the same name exists further down
///      PATH (the shim dir is stripped from PATH before `command -v`), exec it
///      so non-URL opens still reach the real opener. Guard against re-exec'ing
///      the shim itself (infinite loop) when the shim is all that resolves.
///
/// Always `exit 0` on a captured URL so the agent believes the browser opened
/// and proceeds to wait on its loopback callback.
#[cfg(unix)]
const SHIM_SCRIPT: &str = r#"#!/bin/sh
dir="$(cd "$(dirname "$0")" && pwd)"
url=""
for a in "$@"; do case "$a" in http://*|https://*) url="$a";; esac; done
if [ -n "$url" ]; then printf '%s\n' "$url" >> "$dir/urls"; exit 0; fi
case "$PATH" in "$dir:"*) PATH="${PATH#$dir:}";; esac
real="$(command -v "$(basename "$0")" 2>/dev/null)"
[ -n "$real" ] && [ "$real" != "$0" ] && exec "$real" "$@"
exit 0
"#;

/// Root directory holding every agent's shim dir:
/// `temp_dir()/termul-acp-shim/`.
#[cfg(unix)]
fn shim_root() -> PathBuf {
    std::env::temp_dir().join("termul-acp-shim")
}

/// Per-agent shim directory: `temp_dir()/termul-acp-shim/<agent_id>/`.
///
/// `AgentId` is a UUID (safe charset); the component filter is defense-in-depth
/// so a non-UUID id can never escape the shim root via `..` or `/`. An id that
/// sanitizes to nothing maps to the fixed `"_"` component rather than the shim
/// root itself (which would collide with every other agent's scripts).
#[cfg(unix)]
pub(crate) fn shim_dir_for(agent_id: &AgentId) -> PathBuf {
    let safe: String = agent_id
        .0
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    let safe = if safe.is_empty() {
        "_".to_string()
    } else {
        safe
    };
    shim_root().join(safe)
}

/// Install the shim scripts for `agent_id`, returning the shim dir on success.
///
/// Idempotent: re-install overwrites the scripts and truncates the sink so a
/// respawned agent never replays a stale URL. Returns `None` on any I/O
/// failure — the caller logs and continues WITHOUT the shim (the agent's
/// browser-open then fails exactly as it does today; the shim is strictly
/// additive).
#[cfg(unix)]
pub(crate) fn install_shim(agent_id: &AgentId) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;

    let dir = shim_dir_for(agent_id);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        log::warn!(
            "[acp] {agent_id} browser shim: failed to create {}: {e}",
            dir.display()
        );
        return None;
    }
    // The sink holds OAuth URLs — keep the dir owner-only (0700) so other users
    // on the host can't read captured auth state. `create_dir_all` doesn't
    // tighten an existing dir's mode, so set it explicitly.
    if let Err(e) = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)) {
        log::warn!(
            "[acp] {agent_id} browser shim: failed to chmod dir {}: {e}",
            dir.display()
        );
        return None;
    }
    for program in SHIM_PROGRAMS {
        let path = dir.join(program);
        if let Err(e) = std::fs::write(&path, SHIM_SCRIPT) {
            log::warn!(
                "[acp] {agent_id} browser shim: failed to write {}: {e}",
                path.display()
            );
            return None;
        }
        if let Err(e) = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)) {
            log::warn!(
                "[acp] {agent_id} browser shim: failed to chmod {}: {e}",
                path.display()
            );
            return None;
        }
    }
    // Truncate/create the sink so a stale capture from a previous run is never
    // re-emitted.
    if let Err(e) = std::fs::write(dir.join(SINK_FILE_NAME), b"") {
        log::warn!("[acp] {agent_id} browser shim: failed to reset sink: {e}");
        return None;
    }
    log::info!(
        "[acp] {agent_id} browser shim installed at {}",
        dir.display()
    );
    Some(dir)
}

/// Remove the agent's shim dir (best-effort; called on agent teardown).
#[cfg(unix)]
pub(crate) fn remove_shim(agent_id: &AgentId) {
    let dir = shim_dir_for(agent_id);
    if dir.exists() {
        if let Err(e) = std::fs::remove_dir_all(&dir) {
            log::warn!(
                "[acp] {agent_id} browser shim: failed to remove {}: {e}",
                dir.display()
            );
        }
    }
}

/// Inject the shim into the agent's environment: prepend `shim_dir` to the
/// (already login-shell-merged) `PATH` and point `BROWSER` at the shim
/// `xdg-open`. POSIX only — `to_mcp_server` calls this under `#[cfg(unix)]`.
///
/// Runs AFTER `apply_fresh_path` so the shim dir is FIRST on PATH: any real
/// `xdg-open`/`gio` the agent would otherwise resolve is shadowed. A
/// user-supplied `BROWSER` in `config.env` is overridden on purpose — the
/// whole point is that the agent must not reach a real browser on a headless
/// host (and on desktop the modal's "Open" button is the deliberate path).
#[cfg(unix)]
pub(crate) fn inject_shim_env(env: &mut HashMap<String, String>, shim_dir: &Path) {
    let shim = shim_dir.to_string_lossy();
    let merged = match env.get("PATH") {
        Some(existing) if !existing.is_empty() => format!("{shim}:{existing}"),
        _ => shim.into_owned(),
    };
    env.insert("PATH".to_string(), merged);
    env.insert(
        "BROWSER".to_string(),
        shim_dir.join("xdg-open").to_string_lossy().into_owned(),
    );
}

/// Watcher handle: polls the shim sink file and fans each new URL out as
/// `acp:browser_open_request`. Dropping the handle stops the thread (it exits
/// within one poll interval); the thread also self-terminates if the shim dir
/// disappears (teardown removed it).
#[cfg(unix)]
pub(crate) struct ShimWatcher {
    stop: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
}

#[cfg(unix)]
impl ShimWatcher {
    /// Spawn the watcher for `shim_dir` (must be the dir returned by
    /// [`install_shim`]). `sinks` is the agent's event fan-out list; the event
    /// is agent-level (`sid = None`) so every connected client sees it.
    pub(crate) fn spawn(
        agent_id: AgentId,
        shim_dir: PathBuf,
        sinks: Vec<Arc<dyn EventSink>>,
    ) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let sink_path = shim_dir.join(SINK_FILE_NAME);
        // The closure owns a clone; `agent_id` stays usable for the spawn-fail
        // log below.
        let thread_agent_id = agent_id.clone();
        let join = std::thread::Builder::new()
            .name(format!("acp-shim-watch-{agent_id}"))
            .spawn(move || {
                let mut offset: u64 = 0;
                // Bytes of a not-yet-newline-terminated line carried between
                // polls — a URL is only emitted once its line is complete.
                let mut pending_line: Vec<u8> = Vec::new();
                // URLs already emitted, so a truncated/rotated sink can't
                // re-fan the same capture. Bounded: cleared if it ever grows
                // past a generous cap (auth opens are rare).
                let mut seen: HashSet<String> = HashSet::new();
                loop {
                    if thread_stop.load(Ordering::Acquire) {
                        return;
                    }
                    if !shim_dir.exists() {
                        // Teardown removed the shim dir — nothing left to watch.
                        return;
                    }
                    match std::fs::metadata(&sink_path) {
                        Ok(meta) => {
                            if meta.len() < offset {
                                // Sink was truncated/rotated — restart from the
                                // top and drop any partial line from before.
                                offset = 0;
                                pending_line.clear();
                            }
                            if meta.len() > offset {
                                match read_range(&sink_path, offset, meta.len() - offset) {
                                    Ok(bytes) => {
                                        offset += bytes.len() as u64;
                                        pending_line.extend_from_slice(&bytes);
                                        // Drain complete '\n'-terminated lines;
                                        // keep the trailing partial line for
                                        // the next poll.
                                        let mut start = 0;
                                        while let Some(nl) =
                                            pending_line[start..].iter().position(|b| *b == b'\n')
                                        {
                                            let end = start + nl; // index of '\n'
                                            let line =
                                                String::from_utf8_lossy(&pending_line[start..end])
                                                    .into_owned();
                                            start = end + 1;
                                            let url = line.trim();
                                            if url.is_empty() {
                                                continue;
                                            }
                                            if seen.contains(url) {
                                                continue;
                                            }
                                            if seen.len() >= 4096 {
                                                seen.clear();
                                            }
                                            seen.insert(url.to_string());
                                            emit_browser_open(&sinks, &thread_agent_id, url);
                                        }
                                        pending_line.drain(..start);
                                    }
                                    Err(e) => {
                                        log::warn!(
                                            "[acp] {thread_agent_id} browser shim: sink read failed: {e}"
                                        );
                                        offset = meta.len();
                                    }
                                }
                            }
                        }
                        Err(_) => {
                            // Sink not created yet — the agent hasn't opened a
                            // URL (or the dir was just installed). Keep polling.
                        }
                    }
                    std::thread::sleep(SINK_POLL_INTERVAL);
                }
            })
            .ok();
        if join.is_none() {
            log::warn!("[acp] {agent_id} browser shim: failed to spawn sink watcher thread");
        }
        Self { stop, join }
    }
}

/// Read exactly the byte range `[offset, offset+len)` of `path` (or fewer if
/// the file shrank). Incremental — only the new bytes are read, not the whole
/// file each poll.
#[cfg(unix)]
fn read_range(path: &Path, offset: u64, len: u64) -> std::io::Result<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(offset))?;
    let mut buf = Vec::with_capacity(len as usize);
    file.take(len).read_to_end(&mut buf)?;
    Ok(buf)
}

#[cfg(unix)]
impl Drop for ShimWatcher {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(join) = self.join.take() {
            // The thread sleeps at most one poll interval; joining keeps
            // teardown deterministic without risking a hang.
            let _ = join.join();
        }
    }
}

/// Fan one captured URL out as `acp:browser_open_request`. Logs scheme+host
/// only — the full URL carries OAuth state and must never hit the log.
#[cfg(unix)]
fn emit_browser_open(sinks: &[Arc<dyn EventSink>], agent_id: &AgentId, url: &str) {
    let parsed = match reqwest::Url::parse(url) {
        Ok(u) => u,
        Err(_) => return,
    };
    // Only http(s) is a real browser-open — a `javascript:`/`file:` line (the
    // sink is writable by the agent process) must never reach the Open button.
    if !matches!(parsed.scheme(), "http" | "https") {
        return;
    }
    let (scheme, host) = (
        parsed.scheme().to_string(),
        parsed.host_str().unwrap_or("?").to_string(),
    );
    log::info!("[acp] {agent_id} browser shim captured auth URL ({scheme}://{host})");
    let event = BrowserOpenRequestEvent {
        agent_id: agent_id.clone(),
        url: url.to_string(),
    };
    events::fan_out(sinks, None, events::EVENT_BROWSER_OPEN_REQUEST, &event);
}

/// True when `ip` is loopback: `127.0.0.0/8` or `::1`, including an
/// IPv4-mapped IPv6 (`::ffff:127.x`) form.
fn ip_is_loopback(ip: &std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => v4.octets()[0] == 127,
        std::net::IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6
                    .to_ipv4_mapped()
                    .map(|v4| v4.octets()[0] == 127)
                    .unwrap_or(false)
        }
    }
}

/// Resolve `host` (a `localhost`/`*.localhost` name) and require EVERY resolved
/// address to be loopback. Fails closed: an unresolvable or partially-external
/// answer is NOT loopback. `to_socket_addrs` on a loopback name is answered by
/// the resolver/hosts file (no network round-trip), so the blocking call is
/// effectively instant.
fn resolves_to_loopback_only(host: &str) -> bool {
    // `to_socket_addrs` needs a port; any port works — only the IP matters.
    match (host, 0u16).to_socket_addrs() {
        Ok(addrs) => {
            let addrs: Vec<std::net::SocketAddr> = addrs.collect();
            // At least one address, and ALL of them loopback.
            !addrs.is_empty() && addrs.iter().all(|a| ip_is_loopback(&a.ip()))
        }
        Err(_) => false,
    }
}

/// Validate that `url` is an http(s) URL whose host is loopback-only:
/// `localhost`, `*.localhost`, `127.0.0.0/8`, or `[::1]` (incl. IPv4-mapped
/// `::ffff:127.x`). This is the SSRF guard for the paste-back replay — a
/// non-loopback URL is rejected BEFORE any outbound request is made.
///
/// `Url::parse` lowercases the domain and strips brackets/IPv6 normalisation,
/// so `LOCALHOST`, `Localhost.evil.com` (rejected — not a loopback suffix),
/// and `[::1]` are all handled by the same checks. A trailing `.` (FQDN form
/// `localhost.`) is stripped before the name check. `localhost`/`*.localhost`
/// names are additionally resolved and required to map to loopback only, so a
/// host that merely *looks* like localhost but resolves externally is refused.
pub(crate) fn is_loopback_url(url: &str) -> bool {
    let parsed = match reqwest::Url::parse(url) {
        Ok(u) => u,
        Err(_) => return false,
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return false;
    }
    let host = match parsed.host_str() {
        Some(h) => h,
        None => return false,
    };
    // Strip a single trailing dot (FQDN form: `localhost.`).
    let host = host.strip_suffix('.').unwrap_or(host);
    // Domain hosts: `localhost` or any `*.localhost` subdomain — but only if
    // the name actually resolves to loopback and nothing else.
    if host == "localhost" || host.ends_with(".localhost") {
        return resolves_to_loopback_only(host);
    }
    // Literal IPs: 127.0.0.0/8 or ::1 (incl. IPv4-mapped). `host_str` keeps the
    // dotted IPv4 form but brackets IPv6 (`[::1]`), so strip the brackets.
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    match bare.parse::<std::net::IpAddr>() {
        Ok(ip) => ip_is_loopback(&ip),
        Err(_) => false,
    }
}

/// Replay a user-pasted loopback redirect URL against the agent's own
/// callback listener (the paste-back half of the headless OAuth flow).
///
/// `is_loopback_url` runs BEFORE any outbound request — the URL must be
/// http(s) on a loopback host (SSRF guard; a non-loopback URL is refused
/// outright). The agent's listener binds the port embedded in the pasted URL,
/// so the replay needs no port knowledge.
///
/// Then GET it with `redirect::Policy::none()` (the listener's 3xx IS the
/// answer — following it could chase an external URL) and a 15s timeout.
/// Returns the HTTP status code; any non-2xx/3xx or transport error is
/// surfaced so the renderer can show "agent listener gone" vs. success.
pub(crate) async fn deliver_auth_redirect(url: &str) -> Result<u16, String> {
    if !is_loopback_url(url) {
        return Err(
            "refused: auth redirect URL must be http(s) on a loopback host \
             (localhost, *.localhost, 127.0.0.0/8, [::1])"
                .to_string(),
        );
    }
    // Log host+port only — the full URL carries OAuth state.
    let (host, port) = reqwest::Url::parse(url)
        .map(|u| {
            (
                u.host_str().unwrap_or("?").to_string(),
                u.port_or_known_default().unwrap_or(0),
            )
        })
        .unwrap_or_else(|_| ("?".to_string(), 0));
    log::info!("[acp] replaying pasted auth redirect to {host}:{port}");

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(REPLAY_TIMEOUT)
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let response = client.get(url).send().await.map_err(|e| {
        // `without_url` strips the URL reqwest embeds in the error — it
        // carries OAuth state and must not reach the log/renderer.
        format!(
            "redirect replay to {host}:{port} failed: {}",
            e.without_url()
        )
    })?;
    let status = response.status().as_u16();
    log::info!("[acp] auth redirect replay to {host}:{port} answered status {status}");
    Ok(status)
}

#[cfg(test)]
mod tests;
