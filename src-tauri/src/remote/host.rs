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
            let from_registry = registry.default_project_path().and_then(|p| {
                match crate::web::config::resolve_and_validate_project_root(std::path::Path::new(
                    &p,
                )) {
                    Ok(canonical) => Some(canonical),
                    Err(e) => {
                        warn!(
                            "shared-live: registry default project path '{}' failed \
                                 canonicalization: {}; falling back to home",
                            p, e
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
            // The web auth token gate (CAP-1 interim) is standalone-only: the
            // desktop shared-live host passes None (ungated; its cloudflared
            // exposure predates this story — Epic-2 territory).
            web_auth_token: None,
            // `--state-dir` is standalone-only (onboard-generated launches);
            // the desktop host keeps env-based state dir resolution.
            state_dir: None,
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
            // Desktop shared-live: the cloudflared tunnel forwards public
            // traffic to a loopback source, so the guard denies ALL writes
            // before peer evaluation regardless of allow_remote_writes.
            true,
            // No web auth gate on the desktop shared-live path (see the
            // `web_auth_token: None` note above).
            None,
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
mod tests;
