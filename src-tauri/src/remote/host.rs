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
use tokio::process::Child;
use tokio::sync::oneshot;
use tracing::{info, warn};

use crate::acp::{AcpCatalogService, AcpInstallService, AcpManager, WorkspaceManifestService};
use crate::pty::PtyManager;
use crate::web::sink::WsRelaySink;
use crate::web::{serve_router, ProjectRegistry, ServerConfig};

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
    ///
    /// Currently unused: the desktop-hosted server always binds localhost
    /// because the cloudflared quick-tunnel targets it (the LAN `all` mode is
    /// removed from the popover and deferred — see
    /// `spec-remote-qr-cloudflared-tunnel`). Retained + tested for the
    /// deferred LAN-only connect mode.
    #[allow(dead_code)]
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
    /// Ephemeral `https://*.trycloudflare.com` tunnel URL when the built-in
    /// cloudflared quick-tunnel is up; `None` when stopped or before the URL
    /// arrives. The StatusBar QR encodes this (never the local `url`).
    pub tunnel_url: Option<String>,
}

impl RemoteStatus {
    fn stopped() -> Self {
        Self {
            running: false,
            url: None,
            port: None,
            bind_mode: None,
            bind_host: None,
            tunnel_url: None,
        }
    }

    fn running(addr: SocketAddr, bind_mode: RemoteBindMode, tunnel_url: Option<String>) -> Self {
        // The desktop-hosted server always binds localhost (the cloudflared
        // quick-tunnel targets it), so `url` is a concrete loopback URL — kept
        // for "open on this machine" diagnostics. The phone-reachable address
        // is `tunnel_url`, which the popover renders as a QR.
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
            tunnel_url,
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
    /// Ephemeral trycloudflare URL (set when the quick-tunnel came up).
    tunnel_url: Option<String>,
    /// `true` once the cloudflared watchdog observed the child exit. Read by
    /// `status()` (sync) to drop the stale `tunnel_url` so the renderer poller
    /// clears the QR (it would otherwise offer a link that yields "This site
    /// can't be reached"). `None` when no tunnel is attached.
    tunnel_dead: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    /// The watchdog task owning the cloudflared child: it `wait()`s for exit
    /// then flips `tunnel_dead`. Aborted on `stop()`/`Drop` so the owned child
    /// is reaped via `kill_on_drop` — the child is NOT held here directly,
    /// which keeps `status()` sync (no try_wait-across-`.await` dance).
    tunnel_watchdog: Option<tokio::task::JoinHandle<()>>,
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
        // Abort the cloudflared watchdog so the child it owns is reaped via
        // `kill_on_drop` (the child lives inside the watchdog task; aborting
        // drops its future → drops the child). Without this, dropping the
        // JoinHandle would detach the task and the cloudflared process could
        // outlive the server on a hard exit where `stop()` never ran.
        if let Some(handle) = self.tunnel_watchdog.take() {
            handle.abort();
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
    ///
    /// `workspace_manifest` is the desktop's own `WorkspaceManifestService`
    /// (opened under `<app_data_dir>/workspace-manifests` in `lib.rs`).
    /// Threaded through to `serve_router` so the web/remote client can
    /// read/write a project's manifest through `/workspace/*`. `None`
    /// degrades to fresh-only mode.
    ///
    /// `acp_catalog` is the desktop's own `AcpCatalogService` (opened under
    /// `<app_data_dir>/acp-catalog` in `lib.rs`). Threaded through to
    /// `serve_router` so the web/remote client can resolve the catalog through
    /// `GET /acp/catalog` + WS `list_acp_catalog`. `None` degrades to
    /// `ACP_CATALOG_UNAVAILABLE`.
    ///
    /// `acp_install` is the desktop's own `AcpInstallService` (opened under
    /// `<app_data_dir>/acp-registry-binaries` in `lib.rs`). Threaded through
    /// to `serve_router` so the web/remote client can install through
    /// `POST /acp/install` + WS `install_acp_agent`. `None` degrades to
    /// `ACP_INSTALL_UNAVAILABLE`.
    #[allow(clippy::too_many_arguments)]
    pub async fn start(
        &self,
        acp: Arc<AcpManager>,
        pty: Arc<PtyManager>,
        ws_relay: Arc<WsRelaySink>,
        registry: Arc<ProjectRegistry>,
        _bind_mode: RemoteBindMode,
        workspace_manifest: Option<Arc<WorkspaceManifestService>>,
        acp_catalog: Option<Arc<AcpCatalogService>>,
        acp_install: Option<Arc<AcpInstallService>>,
    ) -> Result<RemoteStatus, String> {
        // The built-in cloudflared quick-tunnel forwards to localhost, so the
        // desktop-hosted server always binds localhost regardless of the
        // caller's bind mode — the LAN `all` mode is removed from the popover
        // and deferred (see spec-remote-qr-cloudflared-tunnel). The param stays
        // for API stability / the standalone binary's parity path; it is
        // ignored here (`_bind_mode`) to avoid churning every caller.
        let bind_mode = RemoteBindMode::Localhost;
        {
            let slot = self.inner.lock().unwrap();
            if slot.is_some() {
                return Err("Remote server is already running".to_string());
            }
        }

        // CAP-1 / Story 1: resolve the project-root boundary for the
        // shared-live server from the **active project** (the
        // `ProjectRegistry`'s default-project path), NOT the user home dir.
        // On a cross-drive setup (profile on C:, project on E:) the home-dir
        // fallback rejects every `/skills`, `/git/*`, and `/search/content`
        // probe for the real project with `OUTSIDE_PROJECT_ROOT`. The registry
        // carries display paths (not canonical forms), so we run the result
        // through `resolve_and_validate_project_root` so the value stored in
        // `ServerConfig::project_root` is a canonical absolute path to an
        // existing directory — exactly like the standalone `termul-server`.
        //
        // Fallback chain:
        // 1. Registry default project path → canonicalize.
        // 2. `default_project_root()` ($TERMUL_PROJECT_ROOT / $HOME) → canonicalize.
        // 3. None discoverable → fatal (the server cannot enforce a boundary).
        //
        // A transient canonicalization failure on the registry default (deleted
        // between sync and start) falls through to the home fallback rather
        // than refusing to start — the operator can still re-sync the registry
        // and rebind live. A `warn!` is logged so the operator notices.
        let project_root = {
            // 1. Try the registry's default-project path first.
            let from_registry = registry
                .default_project_path()
                .and_then(|p| {
                    match crate::web::config::resolve_and_validate_project_root(
                        std::path::Path::new(&p),
                    ) {
                        Ok(canonical) => Some(canonical),
                        Err(e) => {
                            warn!(
                                "shared-live: registry default project path '{}' failed \
                                 canonicalization: {}; falling back to home",
                                p,
                                e
                            );
                            None
                        }
                    }
                });
            if let Some(root) = from_registry {
                root
            } else {
                // 2. Empty registry / bad default → home fallback + warn.
                let raw_root = crate::web::config::default_project_root().ok_or_else(|| {
                    "could not determine project root for shared-live server: \
                     set $TERMUL_PROJECT_ROOT or ensure $HOME is available"
                        .to_string()
                })?;
                warn!(
                    "shared-live started with no usable registry default; project_root \
                     fell back to home ({}). /skills, /git/*, /search/content will \
                     reject any project outside this tree until a project is synced.",
                    raw_root.display()
                );
                crate::web::config::resolve_and_validate_project_root(&raw_root).map_err(|e| {
                    format!(
                        "shared-live server refused to start: {e} \
                         (set $TERMUL_PROJECT_ROOT to a valid directory)"
                    )
                })?
            }
        };

        let cfg = ServerConfig {
            host: bind_mode.host().to_string(),
            // OS-assigned ephemeral port (avoids fixed-port conflicts).
            port: 0,
            event_log_capacity: ws_relay.event_log_capacity(),
            permission_timeout_secs: ws_relay
                .rendezvous()
                .map(|r| r.timeout().as_secs())
                .unwrap_or(60),
            permission_reconnect_grace_secs: ws_relay
                .rendezvous()
                .map(|r| r.disconnect_grace().as_secs())
                .unwrap_or(15),
            project_root,
            // Desktop-hosted shared-live mode queries the live desktop
            // `AcpManager` via the in-memory renderer-fed registry, NOT a
            // server-owned file (AC2 / architecture Gap #3). The
            // file-backed `acp::project_registry` is VPS-mode-only.
            projects_file: None,
            sessions_dir: None,
            // CAP-5 / Story 5: this path-override field is standalone-only.
            // The desktop shared-live host passes its already-opened
            // `WorkspaceManifestService` directly to `serve_router` (see the
            // `workspace_manifest` argument below), so no path is resolved
            // from the config here — `None` degrades nothing on this path.
            workspace_manifests_dir: None,
            acp_catalog_dir: None,
            // Issue #613: `None` → resolve `<service_account_state_dir>/store.json`
            // at serve time (the shared-live host gets a durable store too).
            store_file: None,
            // Desktop shared-live LAN clients stay view-only for mutations
            // (CWE-306 guard stays on); only the standalone `termul-server`
            // honors the `--allow-remote-writes` opt-in.
            allow_remote_writes: false,
        };

        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let shutdown = async move {
            let _ = shutdown_rx.await;
            info!("Shared-live web server shutting down…");
        };

        let (addr, serve_handle) = serve_router(
            acp,
            Arc::clone(&pty),
            pty.terminal_events(),
            pty.cwd_tracker(),
            pty.git_tracker(),
            pty.exit_code_tracker(),
            ws_relay,
            registry,
            None,
            None,
            cfg,
            shutdown,
            workspace_manifest,
            acp_catalog,
            acp_install,
        )
        .await
        .map_err(|e| format!("Failed to start remote server: {}", e))?;

        let status = RemoteStatus::running(addr, bind_mode, None);
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
            // Tunnel URL + watchdog are attached after
            // `cloudflared::start_quick_tunnel` resolves in
            // `remote_server_start` — keeps this method testable without a real
            // cloudflared binary (the lifecycle tests bind/stop/status here).
            tunnel_url: None,
            tunnel_dead: None,
            tunnel_watchdog: None,
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
                // Abort the cloudflared watchdog so the owned child is reaped
                // via `kill_on_drop` (the child lives inside the watchdog task;
                // aborting drops its future → drops the child). Done before
                // Axum drains so the public tunnel stops forwarding new traffic
                // before existing conns flush. An already-exited child (the
                // watchdog already completed) is a no-op.
                if let Some(handle) = server.tunnel_watchdog.take() {
                    handle.abort();
                    // Await completion of the abort so the child is reaped
                    // before we proceed (returns Err(Cancelled) — ignored).
                    let _ = handle.await;
                }
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
    ///
    /// Also detects a dead cloudflared child: if the watchdog flag reports the
    /// child has exited, the public trycloudflare URL no longer routes, so the
    /// stale `tunnel_url` is cleared — the renderer poller then drops the QR
    /// (it would otherwise offer a link that yields "This site can't be
    /// reached"). Stays sync (reads an `AtomicBool`) so callers need no
    /// `.await`.
    pub fn status(&self) -> RemoteStatus {
        let mut slot = self.inner.lock().unwrap();
        let Some(server) = slot.as_mut() else {
            return RemoteStatus::stopped();
        };
        // If the spawned serve task has exited (error/panic), don't keep
        // reporting `running` with a dead listener — surface stopped so the
        // UI doesn't lie about a server the phone can't reach.
        if server.task_finished() {
            return RemoteStatus::stopped();
        }
        // Clear the tunnel URL once the cloudflared watchdog reports the child
        // dead (the public URL no longer routes). Logged once: the flag stays
        // set but `tunnel_url` is cleared here so subsequent polls skip the arm.
        if server
            .tunnel_dead
            .as_ref()
            .is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Relaxed))
            && server.tunnel_url.is_some()
        {
            warn!("cloudflared tunnel child exited; clearing stale tunnel URL");
            server.tunnel_url = None;
        }
        RemoteStatus::running(server.addr, server.bind_mode, server.tunnel_url.clone())
    }

    /// Attach a started cloudflared quick-tunnel (URL + live child) to the
    /// running server so [`status`](Self::status) reports the tunnel URL and
    /// [`stop`](Self::stop) kills the child. Called by `remote_server_start`
    /// after the server binds and `cloudflared::start_quick_tunnel` resolves.
    ///
    /// If the server stopped/died between `start` and this call, the orphaned
    /// child is killed (sync `start_kill`) so no cloudflared lingers. Keeping
    /// this out of `start` lets the server-lifecycle unit tests run without a
    /// real cloudflared binary.
    pub fn attach_tunnel(&self, url: String, child: Child) -> Result<(), String> {
        let mut child = Some(child);
        let mut slot = self.inner.lock().unwrap();
        match slot.as_mut() {
            Some(server) if !server.task_finished() => {
                let child = child.take().expect("child present after take");
                let dead_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
                let flag = dead_flag.clone();
                // The watchdog owns the child: `wait()` for natural exit, then
                // flag death so the next `status()` poll clears the stale URL.
                // Aborted on `stop()`/`Drop`; at that point the owned child is
                // reaped via its `kill_on_drop`. Owning the child in a task
                // (not in `RemoteServer`) keeps `status()` sync — no
                // `try_wait`-across-`.await` + no `!Send` MutexGuard hazard.
                let watchdog = tokio::spawn(async move {
                    let mut child = child;
                    let _ = child.wait().await;
                    flag.store(true, std::sync::atomic::Ordering::Relaxed);
                });
                server.tunnel_url = Some(url);
                server.tunnel_dead = Some(dead_flag);
                server.tunnel_watchdog = Some(watchdog);
                Ok(())
            }
            _ => {
                // Server gone — kill the orphan we still hold (sync).
                if let Some(c) = child.as_mut() {
                    let _ = c.start_kill();
                }
                Err("remote server stopped before tunnel attached".to_string())
            }
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

    /// Percent-encode a filesystem path for use as a query-string value in a
    /// test URL (Windows backslashes, spaces, etc. would otherwise break the
    /// URL parse). Mirrors the `urlencoding` helper in `git_api::tests`.
    fn percent_encode_path(path: &std::path::Path) -> String {
        let mut out = String::with_capacity(path.as_os_str().len());
        for c in path.to_string_lossy().chars() {
            match c {
                ' ' => out.push_str("%20"),
                '\\' => out.push_str("%5C"),
                _ if c.is_ascii_alphanumeric()
                    || matches!(c, '-' | '_' | '.' | '~' | '/' | ':') =>
                {
                    out.push(c)
                }
                _ => {
                    for byte in c.to_string().as_bytes() {
                        out.push_str(&format!("%{:02X}", byte));
                    }
                }
            }
        }
        out
    }

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
        assert_eq!(RemoteBindMode::Localhost.display_host(), "127.0.0.1");
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
        assert_eq!(s.tunnel_url, None);
    }

    #[test]
    fn remote_status_running_localhost_uses_loopback_url() {
        let addr: SocketAddr = "127.0.0.1:5123".parse().unwrap();
        let s = RemoteStatus::running(addr, RemoteBindMode::Localhost, None);
        assert!(s.running);
        assert_eq!(s.url.as_deref(), Some("http://127.0.0.1:5123"));
        assert_eq!(s.port, Some(5123));
        assert_eq!(s.bind_mode.as_deref(), Some("localhost"));
        assert_eq!(s.bind_host.as_deref(), Some("127.0.0.1"));
        assert_eq!(s.tunnel_url, None);
    }

    #[test]
    fn remote_status_running_carries_tunnel_url() {
        let addr: SocketAddr = "127.0.0.1:5123".parse().unwrap();
        let s = RemoteStatus::running(
            addr,
            RemoteBindMode::Localhost,
            Some("https://foo-bar.trycloudflare.com".to_string()),
        );
        assert_eq!(
            s.tunnel_url.as_deref(),
            Some("https://foo-bar.trycloudflare.com")
        );
    }

    #[test]
    fn remote_status_running_all_has_no_url() {
        // Bound to 0.0.0.0: the host's LAN IP can't be derived from the bind
        // address, so `url` is `None` (the UI shows "use this machine's LAN
        // IP:{port}"). Don't fabricate a loopback URL the phone can't reach.
        let addr: SocketAddr = "0.0.0.0:8080".parse().unwrap();
        let s = RemoteStatus::running(addr, RemoteBindMode::All, None);
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
    fn lifecycle_fixtures() -> (
        Arc<AcpManager>,
        Arc<PtyManager>,
        Arc<WsRelaySink>,
        Arc<ProjectRegistry>,
    ) {
        let acp = Arc::new(AcpManager::new(vec![]));
        let pty = crate::web::test_pty_manager();
        let relay = Arc::new(WsRelaySink::new());
        let registry = Arc::new(ProjectRegistry::new());
        (acp, pty, relay, registry)
    }

    #[tokio::test]
    async fn remote_server_state_start_then_stop_lifecycle() {
        // The full start→status(running)→stop→status(stopped)→restart cycle
        // that T8.1 asked for and the old misnamed test never exercised.
        let (acp, pty, relay, registry) = lifecycle_fixtures();
        let state = RemoteServerState::new();
        assert!(!state.status().running);

        let status = state
            .start(
                acp.clone(),
                pty.clone(),
                relay.clone(),
                registry.clone(),
                RemoteBindMode::Localhost,
                None,
                None,
                None,
                )
            .await
            .expect("start on localhost binds an OS-assigned port");
        assert!(status.running, "start returns a running status");
        assert!(status.port.is_some(), "an OS-assigned port is reported");
        assert!(
            state.status().running,
            "status reflects running after start"
        );
        assert_eq!(state.status().port, status.port);

        // stop drains the serve task (the JoinHandle is awaited) and reports stopped.
        let stopped = state
            .stop()
            .await
            .expect("stop on a running server succeeds");
        assert!(!stopped.running);
        assert!(
            !state.status().running,
            "status reflects stopped after stop"
        );

        // Restart works (the slot was cleared by stop).
        let again = state
            .start(
                acp.clone(),
                pty.clone(),
                relay.clone(),
                registry.clone(),
                RemoteBindMode::Localhost,
                None,
                None,
                None,
                )
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
        let (acp, pty, relay, registry) = lifecycle_fixtures();
        let state = RemoteServerState::new();
        let _first = state
            .start(
                acp.clone(),
                pty.clone(),
                relay.clone(),
                registry.clone(),
                RemoteBindMode::Localhost,
                None,
                None,
                None,
                )
            .await
            .expect("first start succeeds");

        let second = state
            .start(
                acp.clone(),
                pty.clone(),
                relay.clone(),
                registry.clone(),
                RemoteBindMode::Localhost,
                None,
                None,
                None,
                )
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
        let (acp, pty, relay, registry) = lifecycle_fixtures();
        let state = RemoteServerState::new();
        let _ = state
            .start(
                acp.clone(),
                pty.clone(),
                relay.clone(),
                registry.clone(),
                RemoteBindMode::Localhost,
                None,
                None,
                None,
                )
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn status_clears_tunnel_url_when_cloudflared_child_exits() {
        // The watchdog flips `tunnel_dead` once the child exits; `status()`
        // then clears `tunnel_url` so the renderer poller drops the stale QR
        // (it would otherwise offer a link that yields "This site can't be
        // reached").
        let (acp, pty, relay, registry) = lifecycle_fixtures();
        let state = RemoteServerState::new();
        let _ = state
            .start(
                acp.clone(),
                pty.clone(),
                relay.clone(),
                registry.clone(),
                RemoteBindMode::Localhost,
                None,
                None,
                None,
                )
            .await
            .expect("start");

        // Attach a tunnel child that exits almost immediately (cross-platform
        // exit-0). kill_on_drop mirrors the real start_quick_tunnel child.
        let mut cmd = quick_exit_command();
        cmd.kill_on_drop(true);
        let child = cmd.spawn().expect("spawn quick-exit child");
        state
            .attach_tunnel("https://stale.trycloudflare.com".to_string(), child)
            .expect("attach");

        // Poll status until the dead-child path clears the tunnel URL. The
        // child exits within a few ms; allow up to 1s for the OS + watchdog.
        let mut cleared = false;
        for _ in 0..20 {
            let s = state.status();
            if s.running && s.tunnel_url.is_none() {
                cleared = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(
            cleared,
            "status() must clear tunnel_url once cloudflared exits"
        );

        let _ = state.stop().await;
    }

    /// A cross-platform command that exits 0 almost immediately, for the
    /// dead-child staleness test.
    fn quick_exit_command() -> tokio::process::Command {
        #[cfg(target_os = "windows")]
        let mut c = tokio::process::Command::new("cmd");
        #[cfg(target_os = "windows")]
        c.args(["/c", "exit", "0"]);
        #[cfg(not(target_os = "windows"))]
        let mut c = tokio::process::Command::new("true");

        c.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        c
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
        let end = rest
            .find("\nfn ")
            .or_else(|| rest.find("\nasync fn "))
            .unwrap_or(rest.len());
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

    /// CAP-1 / CAP-8: the keystone cross-drive integration test.
    ///
    /// Seeds a `ProjectRegistry` with a default project whose path is provably
    /// OUTSIDE the user home tree, starts `RemoteServerState`, and asserts
    /// `GET /skills` + `POST /git/status` pass the containment check (not
    /// `OUTSIDE_PROJECT_ROOT`) over the real shared-live HTTP socket. Then
    /// switches the default to a second project and asserts the new project is
    /// accepted WITHOUT a server restart — proving the live rebind threads
    /// through.
    ///
    /// The bug this guards against is the `project_root = %USERPROFILE%` (home)
    /// binding that rejects every project outside the home tree. To reproduce
    /// that rejection, the project dirs MUST NOT be under the home dir. On
    /// Windows `std::env::temp_dir()` resolves to `%USERPROFILE%\AppData\Local\
    /// Temp` — i.e. INSIDE the home tree — so using it would let the buggy
    /// `project_root = home` code accept the project (false pass). We instead
    /// derive the project dirs from an outside-home base: `$TERMUL_TEST_OUTSIDE_
    /// HOME_BASE` when set (so CI can pin a known-writable path outside home),
    /// falling back to `home.parent()` (a sibling of home) when unset. If the
    /// base cannot be resolved or (without an override) is not writable, the
    /// test skips rather than false-pass; an explicit override that is unusable
    /// panics so a broken CI setup is loud, not silent.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn shared_live_binds_project_root_to_active_cross_drive_project() {
        let (acp, pty, relay, registry) = lifecycle_fixtures();

        // Resolve the user home dir the way the buggy `default_project_root()`
        // does, then pick a base provably OUTSIDE the home tree so the project
        // dirs reproduce the cross-drive / outside-home rejection the bug caused.
        let Some(home) = crate::web::config::default_project_root() else {
            eprintln!("skip: cannot resolve user home dir for cross-drive test");
            return;
        };
        // `$TERMUL_TEST_OUTSIDE_HOME_BASE` lets CI pin a known-writable path
        // outside home (e.g. `/var/tmp` or a separate drive on runners where
        // `home.parent()` is locked down). When unset, fall back to
        // `home.parent()`. An explicit override that is unusable is a hard
        // error — the operator asked for it, so a silent skip would mask a
        // broken setup.
        let override_set = std::env::var_os("TERMUL_TEST_OUTSIDE_HOME_BASE").is_some();
        let outside_base = match std::env::var("TERMUL_TEST_OUTSIDE_HOME_BASE") {
            Ok(raw) if !raw.trim().is_empty() => std::path::PathBuf::from(raw.trim()),
            _ => match home.parent() {
                Some(p) => p.to_path_buf(),
                None => {
                    eprintln!(
                        "skip: home dir has no parent and \
                         TERMUL_TEST_OUTSIDE_HOME_BASE is unset"
                    );
                    return;
                }
            },
        };
        // Probe the base is writable. An explicit override that is not writable
        // panics (CI must not silently skip a test the operator forced on);
        // without an override, skip silently — local dev may lack a writable
        // outside-home path.
        let probe = outside_base.join(format!(
            "termul-xdrive-probe-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        if std::fs::create_dir_all(&probe).is_err() {
            if override_set {
                panic!(
                    "TERMUL_TEST_OUTSIDE_HOME_BASE='{}' is not writable; CI cannot \
                     run the cross-drive test reliably — fix the override path",
                    outside_base.display()
                );
            }
            eprintln!(
                "skip: cannot write outside-home base '{}'; cross-drive layout \
                 not reproducible on this filesystem (set \
                 TERMUL_TEST_OUTSIDE_HOME_BASE to force)",
                outside_base.display()
            );
            return;
        }
        let _ = std::fs::remove_dir_all(&probe);

        // RAII cleanup guards — remove the dirs even if an assertion panics
        // mid-test (avoids leaking random-named dirs on the dev/CI machine).
        struct TempDirGuard(std::path::PathBuf);
        impl Drop for TempDirGuard {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }

        let dir_a = outside_base.join(format!(
            "termul-cross-drive-a-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let dir_b = outside_base.join(format!(
            "termul-cross-drive-b-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir_a).expect("create dir_a outside home");
        std::fs::create_dir_all(&dir_b).expect("create dir_b outside home");
        let _guard_a = TempDirGuard(dir_a.clone());
        let _guard_b = TempDirGuard(dir_b.clone());

        // Sanity: the project dirs are provably outside the home tree. If this
        // ever fails (unexpected home layout), the test would false-pass — skip.
        let home_canonical = home.canonicalize().unwrap_or_else(|_| home.clone());
        let dir_a_canonical = dir_a.canonicalize().unwrap_or_else(|_| dir_a.clone());
        if dir_a_canonical.starts_with(&home_canonical) {
            eprintln!(
                "skip: project dir '{}' is inside home '{}'; cross-drive layout \
                 not reproducible",
                dir_a_canonical.display(),
                home_canonical.display()
            );
            return;
        }

        // Optionally init a git repo in dir_a so /git/status can return a real
        // status (not just pass the containment check). When git is unavailable
        // the route still exercises the containment boundary and returns
        // GIT_STATUS_ERROR — never OUTSIDE_PROJECT_ROOT.
        let git_available = crate::trackers::GitTracker::run_git_command(
            std::env::temp_dir().to_str().unwrap(),
            &["--version"],
        )
        .is_some();
        if git_available {
            for args in [
                ["init", "-q"].as_slice(),
                ["config", "user.email", "t@example.com"].as_slice(),
                ["config", "user.name", "Test"].as_slice(),
                ["config", "commit.gpgsign", "false"].as_slice(),
            ] {
                let out = crate::trackers::GitTracker::run_git_command(
                    dir_a.to_str().unwrap(),
                    args,
                )
                .expect("git command runs");
                assert!(
                    out.status.success(),
                    "git {:?} failed: {}",
                    args,
                    String::from_utf8_lossy(&out.stderr)
                );
            }
            std::fs::write(dir_a.join("README.md"), "hello\n").expect("write file");
        }

        // Seed the registry with both projects; dir_a is the default (the
        // "active" project the host should bind to).
        let project_a = crate::web::ProjectSummary {
            id: "p-a".to_string(),
            name: "Project A".to_string(),
            color: "blue".to_string(),
            path: Some(dir_a.to_string_lossy().into_owned()),
            is_archived: false,
            is_default: true,
        };
        let project_b = crate::web::ProjectSummary {
            id: "p-b".to_string(),
            name: "Project B".to_string(),
            color: "green".to_string(),
            path: Some(dir_b.to_string_lossy().into_owned()),
            is_archived: false,
            is_default: false,
        };
        registry.set(vec![project_a, project_b], Some("p-a".to_string()));

        // Start the shared-live server. CAP-1: `start` now derives project_root
        // from the registry default (dir_a), NOT the user home dir.
        let state = RemoteServerState::new();
        let status = state
            .start(
                acp.clone(),
                pty.clone(),
                relay.clone(),
                registry.clone(),
                RemoteBindMode::Localhost,
                None,
                None,
                None,
            )
            .await
            .expect("start with a cross-drive project must succeed");
        assert!(status.running, "server should be running");
        let url = status
            .url
            .expect("localhost bind produces a loopback URL")
            .clone();

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("build reqwest client");

        // GET /skills?projectRoot=dir_a — must succeed (not OUTSIDE_PROJECT_ROOT).
        // The route canonicalizes dir_a and checks it against project_root
        // (which is now dir_a's canonical form, not the home dir). Build the
        // URL with percent-encoding so Windows backslash paths parse correctly.
        let skills_url_a = format!(
            "{url}/skills?projectRoot={}",
            percent_encode_path(&dir_a)
        );
        let resp = client
            .get(&skills_url_a)
            .send()
            .await
            .expect("GET /skills");
        let body: serde_json::Value = resp.json().await.expect("parse /skills body");
        // The containment claim is "not OUTSIDE_PROJECT_ROOT" — do NOT also
        // assert success==true, since /skills success depends on the global
        // skills scan (~/.agents/skills) which may be unreadable/empty in CI
        // for reasons unrelated to the boundary fix. The cross-drive fix is
        // proven by the absence of the OUTSIDE_PROJECT_ROOT rejection.
        assert!(
            body.get("code").and_then(|v| v.as_str()) != Some("OUTSIDE_PROJECT_ROOT"),
            "/skills must not reject the active project (cross-drive fix), got: {body}"
        );

        // POST /git/status { cwd: dir_a } — must not be OUTSIDE_PROJECT_ROOT.
        // When git is available + repo initialized, returns success with a
        // status list; otherwise GIT_STATUS_ERROR (the containment check still
        // passed).
        let resp = client
            .post(format!("{url}/git/status"))
            .json(&serde_json::json!({ "cwd": dir_a.to_string_lossy() }))
            .send()
            .await
            .expect("POST /git/status");
        let body: serde_json::Value = resp.json().await.expect("parse /git/status body");
        assert!(
            body.get("code").and_then(|v| v.as_str()) != Some("OUTSIDE_PROJECT_ROOT"),
            "/git/status must not reject the active project (cross-drive fix), got: {body}"
        );
        if git_available {
            assert!(
                body.get("success").and_then(|v| v.as_bool()).unwrap_or(false),
                "/git/status should succeed for a git repo, got: {body}"
            );
        }

        // ---- Switch the default to project B (dir_b) WITHOUT a restart ----
        // CAP-1: the registry's set_default_project triggers rebind_project_root,
        // which recomputes project_root from the new default (dir_b) and writes
        // the canonical path to the AppState.project_root handle in place.
        assert!(
            registry.set_default_project("p-b"),
            "set_default_project must succeed for a switchable project"
        );

        // GET /skills?projectRoot=dir_b — must succeed with the new boundary.
        let skills_url_b = format!(
            "{url}/skills?projectRoot={}",
            percent_encode_path(&dir_b)
        );
        let resp = client
            .get(&skills_url_b)
            .send()
            .await
            .expect("GET /skills after switch");
        let body: serde_json::Value = resp.json().await.expect("parse /skills body");
        // Containment claim only (see above) — do not couple to skills-scan success.
        assert!(
            body.get("code").and_then(|v| v.as_str()) != Some("OUTSIDE_PROJECT_ROOT"),
            "/skills must not reject the new active project after switch, got: {body}"
        );

        // The old project (dir_a) is now OUTSIDE the new project_root (dir_b),
        // so /skills?projectRoot=dir_a should be rejected. This proves the
        // rebound boundary actually moved (not just widened to cover both).
        let resp = client
            .get(&skills_url_a)
            .send()
            .await
            .expect("GET /skills old project after switch");
        let body: serde_json::Value = resp.json().await.expect("parse /skills body");
        assert_eq!(
            body.get("code").and_then(|v| v.as_str()),
            Some("OUTSIDE_PROJECT_ROOT"),
            "the old project must be rejected after the boundary moved to dir_b, got: {body}"
        );

        let _ = state.stop().await;
        // dir_a / dir_b are removed by the TempDirGuard RAII guards on drop,
        // even if an assertion above panicked.
    }
}
