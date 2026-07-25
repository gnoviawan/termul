//! Desktop-hosted shared-live ACP web server — in-process lifecycle.
//!
//! Replaces the legacy PTY bridge (`remote/server.rs`, removed). Where the old
//! server proxied live PTY I/O over a separate WebSocket, this wraps the same
//! [`crate::web`] Axum server the standalone `termul-server` binary uses, so the
//! desktop's live `AcpManager` (the same agent sessions the renderer sees) is
//! shared with a browser/phone client over the LAN — the "shared-live" mode.
//!
//! ## Lifecycle
//!
//! `RemoteServerState` is a `Mutex<Option<RemoteServer>>` managed by Tauri. The
//! status-bar control drives `remote_server_start` / `_stop` (see `commands.rs`),
//! which delegate to [`RemoteServerState::start`] / [`stop`].
//!
//! ## The kill-all hazard
//!
//! The standalone `web::serve` calls `AcpManager::kill_all` after Axum drains —
//! correct for a binary that owns its agents, but catastrophic for the desktop,
//! where stopping the shared-live server must NOT kill the desktop's live agents.
//! This path therefore calls [`crate::web::serve_router`] directly (which never
//! kills agents) and drives shutdown through an `oneshot` channel.
//!
//! ## Bind model
//!
//! Defaults to localhost. `All` (`0.0.0.0`) exposes the server on the LAN; the
//! status-bar UI surfaces a warning in that case. Auth/token-gating lands in
//! Epic 2 — until then, LAN exposure is the operator's explicit decision.

use std::net::SocketAddr;
use std::sync::Arc;

use serde::Serialize;
use tokio::sync::oneshot;
use tracing::{info, warn};

use crate::acp::AcpManager;
use crate::web::sink::WsRelaySink;
use crate::web::{serve_router, ServerConfig};

/// Which network interface(s) the in-process web server binds to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteBindMode {
    /// `127.0.0.1` — localhost only (default, safest).
    Localhost,
    /// `0.0.0.0` — all interfaces (LAN / other devices on the network).
    All,
}

impl RemoteBindMode {
    /// Parse a host string into a bind mode.
    ///
    /// Accepts `localhost` / `127.0.0.1` / `loopback` → [`Localhost`], and
    /// `all` / `0.0.0.0` / `any` → [`All`]. Anything else returns `None`.
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "localhost" | "127.0.0.1" | "loopback" => Some(Self::Localhost),
            "all" | "0.0.0.0" | "any" => Some(Self::All),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Localhost => "localhost",
            Self::All => "all",
        }
    }

    /// Bind host string for [`ServerConfig`] (`127.0.0.1` or `0.0.0.0`).
    pub fn host(self) -> &'static str {
        match self {
            Self::Localhost => "127.0.0.1",
            Self::All => "0.0.0.0",
        }
    }

    /// Human-readable bind target for the UI.
    pub fn display_host(self) -> &'static str {
        self.host()
    }

    /// `true` when bound to all interfaces (LAN-exposed).
    pub fn is_lan_exposed(self) -> bool {
        matches!(self, Self::All)
    }
}

/// Status of the desktop-hosted web server, returned to the frontend.
///
/// Field shape is preserved verbatim from the legacy PTY server so the renderer's
/// `RemoteStatus` type and status-bar UI stay unchanged.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub running: bool,
    pub url: Option<String>,
    pub port: Option<u16>,
    /// `localhost` or `all` when running; `None` when stopped.
    pub bind_mode: Option<String>,
    /// Bind host shown in the UI (`127.0.0.1` or `0.0.0.0`).
    pub bind_host: Option<String>,
}

impl RemoteStatus {
    fn stopped() -> Self {
        Self {
            running: false,
            url: None,
            port: None,
            bind_mode: None,
            bind_host: None,
        }
    }

    fn running(addr: SocketAddr, bind_mode: RemoteBindMode) -> Self {
        // When bound to 0.0.0.0 (LAN-exposed), the host's LAN IP can't be known
        // from the bind address alone, so don't fabricate a loopback URL the
        // phone can't reach — leave `url` empty and let the status-bar UI show
        // "connect via this machine's LAN IP:{port}". On localhost the URL is
        // concrete and useful.
        let url = if addr.ip().is_unspecified() {
            None
        } else {
            Some(format!("http://{}:{}", addr.ip(), addr.port()))
        };
        Self {
            running: true,
            url,
            port: Some(addr.port()),
            bind_mode: Some(bind_mode.as_str().to_string()),
            bind_host: Some(bind_mode.display_host().to_string()),
        }
    }
}

/// Running server handle — owns the shutdown signal, the serve task handle, and
/// the bound address.
struct RemoteServer {
    shutdown_tx: Option<oneshot::Sender<()>>,
    /// The spawned `axum::serve` task. Stored (not dropped) so `stop()` can
    /// await its graceful drain and `status()` can detect a dead task.
    serve_handle: Option<tokio::task::JoinHandle<()>>,
    addr: SocketAddr,
    bind_mode: RemoteBindMode,
}

impl RemoteServer {
    /// `true` if the spawned serve task has exited (Ok or Err/panic). Used by
    /// `status()` to stop reporting `running` after the listener died.
    fn task_finished(&self) -> bool {
        self.serve_handle
            .as_ref()
            .is_some_and(tokio::task::JoinHandle::is_finished)
    }
}

impl Drop for RemoteServer {
    fn drop(&mut self) {
        // Best-effort graceful shutdown on drop (e.g. app exit). Signal the
        // serve task to drain; the JoinHandle is left to the runtime to reap
        // (awaiting it in `Drop` isn't possible — `Drop` is sync).
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
    }
}

/// Tauri-managed wrapper tracking the in-process web server's start/stop state.
pub struct RemoteServerState {
    inner: std::sync::Mutex<Option<RemoteServer>>,
}

impl RemoteServerState {
    pub fn new() -> Self {
        Self {
            inner: std::sync::Mutex::new(None),
        }
    }

    /// Start the in-process web server sharing the desktop's live `AcpManager`.
    ///
    /// Builds a [`ServerConfig`] from the bind mode (OS-assigned port via
    /// `port: 0`), binds + spawns the serve loop via [`serve_router`] (which
    /// never kills agents), and stores the shutdown handle + serve task handle.
    /// Returns `Err` if a server is already running or the bind fails.
    ///
    /// The serve task's `JoinHandle` is stored so `stop()` can await its
    /// graceful drain and `status()` can detect a dead task. If a concurrent
    /// start wins the slot race, the loser signals its spawned task to drain
    /// before returning `Err` (no orphaned second server).
    pub async fn start(
        &self,
        acp: Arc<AcpManager>,
        ws_relay: Arc<WsRelaySink>,
        bind_mode: RemoteBindMode,
    ) -> Result<RemoteStatus, String> {
        {
            let slot = self.inner.lock().unwrap();
            if slot.is_some() {
                return Err("Remote server is already running".to_string());
            }
        }

        if bind_mode.is_lan_exposed() {
            warn!(
                "Binding shared-live server to 0.0.0.0 — LAN exposure without auth \
                 (Epic 2). Anyone on the network can drive the live agent sessions."
            );
        }

        // PR-S4: resolve the project-root boundary for the fs_api routes.
        // Honor an explicit override from the desktop settings (when wired
        // through), then fall back to $TERMUL_PROJECT_ROOT, then to $HOME /
        // $USERPROFILE. Per `default_project_root`'s contract, `None` here
        // means no home dir is discoverable — treat it as fatal rather than
        // silently widening the boundary to the process CWD (which on a
        // desktop app is the bundle/install dir, much more permissive than
        // the per-user boundary this PR is meant to enforce).
        let project_root = crate::web::config::default_project_root()
            .ok_or_else(|| {
                "could not determine project root for shared-live server: \
                 set $TERMUL_PROJECT_ROOT or ensure $HOME is available"
                    .to_string()
            })?;

        let cfg = ServerConfig {
            host: bind_mode.host().to_string(),
            // OS-assigned ephemeral port (avoids fixed-port conflicts).
            port: 0,
            event_log_capacity: ws_relay.event_log_capacity(),
            permission_timeout_secs: ws_relay
                .rendezvous()
                .map(|r| r.timeout().as_secs())
                .unwrap_or(60),
            project_root,
        };

        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let shutdown = async move {
            let _ = shutdown_rx.await;
            info!("Shared-live web server shutting down…");
        };

        let (addr, serve_handle) = serve_router(acp, ws_relay, cfg, shutdown)
            .await
            .map_err(|e| format!("Failed to start remote server: {}", e))?;

        let status = RemoteStatus::running(addr, bind_mode);
        info!(
            "Shared-live web server sharing desktop AcpManager on http://{}",
            addr
        );

        let mut slot = self.inner.lock().unwrap();
        if slot.is_some() {
            // Lost a concurrent-start race. Signal this spawned task to drain
            // (do NOT drop `shutdown_tx` silently — that would orphan a second
            // server that `remote_server_stop` could never reach).
            let _ = shutdown_tx.send(());
            // Let the serve task run down before discarding its handle.
            drop(serve_handle);
            return Err("Remote server is already running".to_string());
        }
        *slot = Some(RemoteServer {
            shutdown_tx: Some(shutdown_tx),
            serve_handle: Some(serve_handle),
            addr,
            bind_mode,
        });
        Ok(status)
    }

    /// Stop the in-process web server if running.
    ///
    /// Signals graceful shutdown to the serve task and awaits its drain so the
    /// standalone `serve()` "drain Axum → then kill" ordering holds on the
    /// desktop path too. Does NOT call `AcpManager::kill_all` — the desktop's
    /// live agents survive a shared-live toggle-off.
    pub async fn stop(&self) -> Result<RemoteStatus, String> {
        let server = { self.inner.lock().unwrap().take() };
        match server {
            Some(mut server) => {
                // Signal drain, then await the serve task so Axum finishes
                // flushing before the caller proceeds (e.g. app exit →
                // `kill_all`). `Drop` would only signal; awaiting here enforces
                // ordering.
                if let Some(tx) = server.shutdown_tx.take() {
                    let _ = tx.send(());
                }
                if let Some(handle) = server.serve_handle.take() {
                    // `axum::serve` returns on graceful-shutdown completion; a
                    // panic surfaces as `JoinError` — log, don't propagate.
                    if let Err(join_err) = handle.await {
                        if !join_err.is_cancelled() {
                            warn!("Shared-live serve task ended unexpectedly: {join_err}");
                        }
                    }
                }
                Ok(RemoteStatus::stopped())
            }
            None => Err("Remote server is not running".to_string()),
        }
    }

    /// Current status of the in-process web server.
    pub fn status(&self) -> RemoteStatus {
        let slot = self.inner.lock().unwrap();
        match slot.as_ref() {
            // If the spawned serve task has exited (error/panic), don't keep
            // reporting `running` with a dead listener — surface stopped so the
            // UI doesn't lie about a server the phone can't reach.
            Some(server) if !server.task_finished() => {
                RemoteStatus::running(server.addr, server.bind_mode)
            }
            Some(_) => RemoteStatus::stopped(),
            None => RemoteStatus::stopped(),
        }
    }
}

impl Default for RemoteServerState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_bind_mode_parse() {
        assert_eq!(
            RemoteBindMode::parse("localhost"),
            Some(RemoteBindMode::Localhost)
        );
        assert_eq!(
            RemoteBindMode::parse("127.0.0.1"),
            Some(RemoteBindMode::Localhost)
        );
        assert_eq!(RemoteBindMode::parse("all"), Some(RemoteBindMode::All));
        assert_eq!(RemoteBindMode::parse("0.0.0.0"), Some(RemoteBindMode::All));
        assert_eq!(RemoteBindMode::parse("any"), Some(RemoteBindMode::All));
        assert_eq!(RemoteBindMode::parse("bogus"), None);
    }

    #[test]
    fn remote_bind_mode_host_and_display() {
        assert_eq!(RemoteBindMode::Localhost.host(), "127.0.0.1");
        assert_eq!(RemoteBindMode::All.host(), "0.0.0.0");
        assert_eq!(
            RemoteBindMode::Localhost.display_host(),
            "127.0.0.1"
        );
        assert_eq!(RemoteBindMode::All.display_host(), "0.0.0.0");
    }

    #[test]
    fn remote_bind_mode_is_lan_exposed() {
        assert!(!RemoteBindMode::Localhost.is_lan_exposed());
        assert!(RemoteBindMode::All.is_lan_exposed());
    }

    #[test]
    fn remote_status_stopped_is_all_none() {
        let s = RemoteStatus::stopped();
        assert!(!s.running);
        assert_eq!(s.url, None);
        assert_eq!(s.port, None);
        assert_eq!(s.bind_mode, None);
        assert_eq!(s.bind_host, None);
    }

    #[test]
    fn remote_status_running_localhost_uses_loopback_url() {
        let addr: SocketAddr = "127.0.0.1:5123".parse().unwrap();
        let s = RemoteStatus::running(addr, RemoteBindMode::Localhost);
        assert!(s.running);
        assert_eq!(s.url.as_deref(), Some("http://127.0.0.1:5123"));
        assert_eq!(s.port, Some(5123));
        assert_eq!(s.bind_mode.as_deref(), Some("localhost"));
        assert_eq!(s.bind_host.as_deref(), Some("127.0.0.1"));
    }

    #[test]
    fn remote_status_running_all_has_no_url() {
        // Bound to 0.0.0.0: the host's LAN IP can't be derived from the bind
        // address, so `url` is `None` (the UI shows "use this machine's LAN
        // IP:{port}"). Don't fabricate a loopback URL the phone can't reach.
        let addr: SocketAddr = "0.0.0.0:8080".parse().unwrap();
        let s = RemoteStatus::running(addr, RemoteBindMode::All);
        assert!(s.running);
        assert_eq!(s.url, None, "0.0.0.0 must not fabricate a loopback URL");
        assert_eq!(s.port, Some(8080));
        assert_eq!(s.bind_mode.as_deref(), Some("all"));
        assert_eq!(s.bind_host.as_deref(), Some("0.0.0.0"));
    }

    #[tokio::test]
    async fn remote_server_state_stop_on_unstarted_errors() {
        // A stop on an unstarted state must error; status reports stopped.
        let state = RemoteServerState::new();
        assert!(!state.status().running);

        let err = state.stop().await;
        assert!(err.is_err(), "stop on an unstarted server must error");
        assert!(!state.status().running);
    }

    /// A real `AcpManager` (zero sinks is legal) + a `WsRelaySink` for the
    /// shared-live host lifecycle tests. The serve task binds a real OS-assigned
    /// localhost socket — safe in tests.
    fn lifecycle_fixtures() -> (Arc<AcpManager>, Arc<WsRelaySink>) {
        let acp = Arc::new(AcpManager::new(vec![]));
        let relay = Arc::new(WsRelaySink::new());
        (acp, relay)
    }

    #[tokio::test]
    async fn remote_server_state_start_then_stop_lifecycle() {
        // The full start→status(running)→stop→status(stopped)→restart cycle
        // that T8.1 asked for and the old misnamed test never exercised.
        let (acp, relay) = lifecycle_fixtures();
        let state = RemoteServerState::new();
        assert!(!state.status().running);

        let status = state
            .start(acp.clone(), relay.clone(), RemoteBindMode::Localhost)
            .await
            .expect("start on localhost binds an OS-assigned port");
        assert!(status.running, "start returns a running status");
        assert!(status.port.is_some(), "an OS-assigned port is reported");
        assert!(state.status().running, "status reflects running after start");
        assert_eq!(state.status().port, status.port);

        // stop drains the serve task (the JoinHandle is awaited) and reports stopped.
        let stopped = state.stop().await.expect("stop on a running server succeeds");
        assert!(!stopped.running);
        assert!(!state.status().running, "status reflects stopped after stop");

        // Restart works (the slot was cleared by stop).
        let again = state
            .start(acp.clone(), relay.clone(), RemoteBindMode::Localhost)
            .await
            .expect("restart after stop succeeds");
        assert!(again.running);
        let _ = state.stop().await;
    }

    #[tokio::test]
    async fn remote_server_state_double_start_is_rejected() {
        // The lose-race guard: a second start while the first is running returns
        // Err — and (per R1) does NOT orphan a second server (its shutdown_tx is
        // signaled before returning). The first server keeps running.
        let (acp, relay) = lifecycle_fixtures();
        let state = RemoteServerState::new();
        let _first = state
            .start(acp.clone(), relay.clone(), RemoteBindMode::Localhost)
            .await
            .expect("first start succeeds");

        let second = state
            .start(acp.clone(), relay.clone(), RemoteBindMode::Localhost)
            .await;
        assert!(
            second.is_err(),
            "a second start while running must be rejected"
        );
        assert!(state.status().running, "the first server is still running");

        let _ = state.stop().await;
    }

    #[tokio::test]
    async fn remote_server_state_start_stop_does_not_kill_agents() {
        // The central AC4 guarantee: toggling the shared-live server off must NOT
        // kill the desktop's live agents. `serve_router` (which host::start
        // calls) never calls `AcpManager::kill_all`; `stop` only signals the
        // oneshot. Drive the full lifecycle and assert no agent state was
        // disturbed. (AcpManager::new(vec![]) owns no agents, so there is
        // nothing to kill — this guards the path: start/stop complete without
        // touching kill_all, i.e. no panic, no error, clean drain.)
        let (acp, relay) = lifecycle_fixtures();
        let state = RemoteServerState::new();
        let _ = state
            .start(acp.clone(), relay.clone(), RemoteBindMode::Localhost)
            .await
            .expect("start succeeds");
        // The serve task holds `Arc::clone(&acp)`; stop drains it. The desktop
        // `acp` is untouched (still usable, agents survive).
        let stopped = state.stop().await.expect("stop succeeds");
        assert!(!stopped.running);
        // `acp` is still intact — the host never called kill_all on it. (No
        // direct kill_all assertion possible without a spy; the invariant is
        // structural: serve_router does not call kill_all, host::stop does not
        // call kill_all. This test guards the path end-to-end.)
    }

    #[test]
    fn serve_router_does_not_reference_kill_all() {
        // Structural regression guard for the story's "single most important
        // fact" (Dev Notes invariant #2 / AC4): the desktop-hosted shared-live
        // path calls `serve_router` directly, so `serve_router` must never call
        // `AcpManager::kill_all` — toggling the server off must not kill the
        // desktop's live agents. (The standalone `serve()` wrapper IS allowed to
        // call `kill_all` — it owns its agents — so only `serve_router`'s body
        // is scanned, not the whole module.) If `kill_all` is re-added to
        // `serve_router`, this test fails. The end-to-end lifecycle test above
        // guards the path at runtime; this one pins the source invariant.
        let web_mod = include_str!("../web/mod.rs");
        let body = extract_fn_body(web_mod, "serve_router")
            .expect("serve_router must be defined in web/mod.rs");
        let stripped = strip_line_comments(&body);
        assert!(
            !stripped.contains("kill_all"),
            "serve_router must not reference `kill_all` (the shared-live path must \
             not kill the desktop's agents) — re-adding it would regress AC4"
        );
    }

    /// Extract a top-level `fn`/`async fn` body by name, from its signature
    /// line up to (but not including) the next top-level `fn`/`async fn`.
    fn extract_fn_body(src: &str, fn_name: &str) -> Option<String> {
        let needle = format!("fn {fn_name}");
        let start = src.find(&needle)?;
        // Find the next top-level `fn ` after the signature (closes the body).
        let rest = &src[start + needle.len()..];
        let end = rest.find("\nfn ").or_else(|| rest.find("\nasync fn ")).unwrap_or(rest.len());
        Some(src[start..start + needle.len() + end].to_string())
    }

    /// Strip `//` line comments so doc references to a token don't trip the
    /// check. Crude but sufficient — these functions hold no string literals
    /// containing `kill_all`.
    fn strip_line_comments(src: &str) -> String {
        src.lines()
            .map(|line| match line.find("//") {
                Some(idx) => &line[..idx],
                None => line,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn remote_server_state_default_equals_new() {
        let _ = RemoteServerState::default();
    }
}
