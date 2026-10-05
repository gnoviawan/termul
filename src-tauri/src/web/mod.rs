//! Web ACP Agent runtime — headless server + browser client support.
//!
//! This module owns the transport-neutral seams the `acp` dispatcher emits
//! through, plus the standalone Axum server (Stories 1.2–1.3) and the live WS
//! relay (Story 1.4).
//!
//! - Desktop registers a [`sink::TauriEventSink`] (`acp:*` Tauri events).
//! - Standalone `termul-server` registers a live [`sink::WsRelaySink`] (Story
//!   1.4 — owns per-session event logs + seq counters + subscriber set) and
//!   calls [`serve`].
//! - Dev static serving of `dist-web/` is [`assets`] (Story 1.3); production
//!   rust-embed embedding/serving is complete.
//!
//! Auth / sandbox land in later stories. The WS relay protocol (envelope, seq,
//! event log, cursor, tiers) is [`ws`] (Story 1.4).

pub mod agent_reaper;
#[cfg(test)]
mod agent_reaper_tests;

pub mod assets;
pub mod acp_api;
pub mod auth;
pub mod canvas_api;
pub mod catalog_api;
pub mod config;
pub mod fs_api;
pub mod fs_watcher;
pub mod git_api;
pub mod install_api;
pub mod log_api;
pub mod mcp_oauth_api;
pub mod mcp_probe_api;
pub mod mcp_servers_api;
pub mod origin;
pub mod permissions;
pub mod project_icon_api;
pub mod project_registry;
pub mod projects_api;
pub mod router;
pub mod search_api;
pub mod sink;
pub mod skills_api;
pub mod store;
pub mod terminal_ws;
pub mod workspace_api;
pub mod worktree_api;
pub mod ws;

pub use config::ServerConfig;
pub use permissions::PermissionRendezvous;
pub use permissions::QuestionRendezvous;
pub use project_registry::{
    seed_from_file, ProjectListPayload, ProjectRegistry, ProjectSummary, ProjectsChangedPayload,
};
pub use sink::{
    broadcast_chat_history_changed, broadcast_projects_changed, fan_out, EventSink, TauriEventSink,
    WsRelaySink,
};
pub use ws::{AppState, HistoryMode, ReliabilityTier, RuntimePolicy, SequencedEvent, WsErrorCode};

use std::future::Future;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tracing::{error, info, warn};

use crate::acp::AcpManager;
use crate::pty::PtyManager;
use crate::trackers::{CwdTracker, ExitCodeTracker, GitTracker, TerminalEventHub};
use crate::web::store::WebStore;

#[cfg(test)]
pub(crate) fn test_pty_manager() -> Arc<PtyManager> {
    let events = TerminalEventHub::standalone();
    let cwd = Arc::new(CwdTracker::new(events.clone()));
    let git = Arc::new(GitTracker::new(None, events.clone()));
    let exit = Arc::new(ExitCodeTracker::new(events.clone()));
    Arc::new(PtyManager::new(events, cwd, git, exit))
}

/// Bind and serve the standalone ACP HTTP server until SIGINT/SIGTERM.
///
/// `ws_relay` is the live [`WsRelaySink`] — passed to both `AcpManager::new`
/// (as an event sink) and the router (so `/ws` can subscribe clients + replay
/// cursors). On signal: drains Axum first (graceful shutdown), then kills all
/// agent subprocesses via [`AcpManager::kill_all`]. Bind failures are returned
/// to the caller. On serve error, agents are still killed before returning.
///
/// `canvas_pool` is the standalone server's own [`crate::canvas::pool::CanvasDaemonPool`]
/// (OpenPencil canvas mode) — never shared with a desktop host on the same
/// machine. It is threaded into the `/canvas/*` routes and shut down
/// (stdin-EOF → kill) in the serve cleanup, after Axum drains.
///
/// `registry` is the in-memory [`ProjectRegistry`] the router reads for
/// `GET /projects` + `switch_project` cwd resolution. The standalone binary
/// seeds it from the file-backed [`crate::acp::project_registry::FileProjectRegistry`]
/// at startup (VPS mode — `projects_file` resolves from `--projects-file` /
/// `$TERMUL_PROJECTS_FILE` / the state-dir default); the desktop host seeds
/// it via `remote_sync_projects` and calls [`serve_router`] directly (it
/// never reaches this `serve` wrapper).
///
/// `workspace_manifest` is the host-owned [`WorkspaceManifestService`] for
/// CAP-5 / Story 5 — atomically persists one versioned workspace manifest per
/// project. The standalone binary opens it under
/// `<service_account_state_dir>/workspace-manifests`; the desktop host opens
/// its own under `<app_data_dir>/workspace-manifests` (never shared across
/// processes — `Never`-clause). `None` degrades to fresh-only mode.
///
/// `acp_catalog` is the host-owned [`AcpCatalogService`] for CAP-6 / Story 8 —
/// resolves the trusted ACP catalog (OS/arch/runtime + per-agent status). The
/// standalone binary opens it under `<service_account_state_dir>/acp-catalog`;
/// the desktop host opens its own under `<app_data_dir>/acp-catalog`. `None`
/// degrades to `ACP_CATALOG_UNAVAILABLE`.
///
/// `acp_install` is the host-owned [`AcpInstallService`] for CAP-6 / Story 9 —
/// downloads + verifies (sha256) + extracts + atomically activates ACP agent
/// archives resolved from the catalog. The standalone binary opens it under
/// `<service_account_state_dir>/acp-registry-binaries`; the desktop host opens
/// its own under `<app_data_dir>/acp-registry-binaries`. `None` degrades to
/// `ACP_INSTALL_UNAVAILABLE`.
///
/// The standalone binary owns its agent lifetime end-to-end, so it kills agents
/// on exit. The desktop-hosted shared-live path calls [`serve_router`] directly
/// and must NOT kill the desktop's live agents — see [`serve_router`].
#[allow(clippy::too_many_arguments)]
pub async fn serve(
    acp: Arc<AcpManager>,
    pty: Arc<PtyManager>,
    terminal_events: TerminalEventHub,
    cwd_tracker: Arc<CwdTracker>,
    git_tracker: Arc<GitTracker>,
    exit_code_tracker: Arc<ExitCodeTracker>,
    ws_relay: Arc<WsRelaySink>,
    registry: Arc<crate::web::project_registry::ProjectRegistry>,
    registry_persistence: Option<Arc<parking_lot::Mutex<crate::acp::FileProjectRegistry>>>,
    projects_file: Option<PathBuf>,
    cfg: ServerConfig,
    workspace_manifest: Option<Arc<crate::acp::WorkspaceManifestService>>,
    acp_catalog: Option<Arc<crate::acp::AcpCatalogService>>,
    acp_install: Option<Arc<crate::acp::install::AcpInstallService>>,
    web_auth: Option<Arc<auth::WebAuth>>,
    canvas_pool: Option<Arc<crate::canvas::pool::CanvasDaemonPool>>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Issue #837: idle agent reaper (standalone server only — see the module
    // doc for why this is NOT in `serve_router`). The shutdown future resolves
    // on SIGINT/SIGTERM OR when the router task finishes for any other reason
    // (bind failure, panic, early exit) so `serve` never hangs waiting on a
    // reaper whose signal can no longer arrive in-process.
    let (reaper_stop_tx, reaper_stop_rx) = tokio::sync::oneshot::channel::<()>();
    let reaper_window = agent_reaper::idle_reap_window_from_env();
    let reaper_handle = agent_reaper::spawn_agent_idle_reaper(
        acp.clone(),
        ws_relay.clone(),
        reaper_window,
        Box::pin(async move {
            tokio::select! {
                _ = shutdown_signal_future() => {}
                _ = reaper_stop_rx => {}
            }
        }),
    );

    let (_addr, handle) = serve_router(
        acp.clone(),
        pty.clone(),
        terminal_events,
        cwd_tracker,
        git_tracker,
        exit_code_tracker,
        ws_relay,
        registry,
        registry_persistence,
        projects_file,
        cfg,
        shutdown_signal_future(),
        workspace_manifest,
        acp_catalog,
        acp_install,
        // Standalone binary is NOT shared-live — its admission path is the
        // `--allow-remote-writes` opt-in, not a deployment-mode deny.
        false,
        web_auth,
        canvas_pool.clone(),
    )
    .await?;

    let serve_result = handle.await;

    // Reap loop cleanup: signal it to stop (no-op if the OS signal already
    // resolved its shutdown future) and join so a slow sweep cannot leak the
    // task past serve's own cleanup path.
    let _ = reaper_stop_tx.send(());
    let _ = reaper_handle.await;

    // Cleanup: always attempt ALL resource cleanup even if one step fails.
    // PTY cleanup must not be skipped because ACP persistence errored.
    let mut cleanup_errors: Vec<Box<dyn std::error::Error + Send + Sync>> = Vec::new();

    // Order is load-bearing (#842 / #880): `kill_all_checked` joins each
    // agent driver, which drains that session's writer and appends the
    // interrupted marker before status is closed. `shutdown_persistence`
    // then marks any writer the driver did not already close. Scanning
    // for the marker before this join lets the tail chunks land after it
    // — or misses the session entirely once finalize removes the writer.
    if let Err(e) = acp.kill_all_checked().await {
        let e: Box<dyn std::error::Error + Send + Sync> = e.into();
        log::error!("[termul-server] ACP kill_all failed during shutdown: {e}");
        cleanup_errors.push(e);
    }
    if let Err(e) = acp.shutdown_persistence().await {
        let e: Box<dyn std::error::Error + Send + Sync> = e.into();
        log::error!("[termul-server] ACP persistence shutdown failed: {e}");
        cleanup_errors.push(e);
    }
    // PTY cleanup always runs — never skip terminal process-tree kill.
    pty.kill_all().await;

    // Canvas mode (OpenPencil): dispose every managed canvas daemon (stdin
    // EOF → kill) once Axum has drained. Runs unconditionally — never skip
    // daemon cleanup because an earlier step failed.
    if let Some(pool) = &canvas_pool {
        pool.shutdown_all().await;
    }

    if let Some(first) = cleanup_errors.into_iter().next() {
        return Err(first);
    }

    match serve_result {
        Ok(()) => {
            info!("termul-server stopped");
            Ok(())
        }
        Err(join_err) if join_err.is_cancelled() => {
            warn!("termul-server serve task cancelled");
            Ok(())
        }
        Err(join_err) => Err(Box::new(join_err)),
    }
}

/// Bind the Axum router and spawn the serve loop with an external shutdown.
///
/// Binds the listener synchronously (so the caller learns the bound address
/// before serving starts), warns when `dist-web/` is missing, then spawns the
/// `axum::serve` loop on the current runtime. The returned [`JoinHandle`]
/// completes when the server has drained on shutdown or errored; the bound
/// [`SocketAddr`] is returned immediately so the host manager can build the
/// URL without waiting for the server to stop.
///
/// **Does NOT call `kill_all`** — the caller owns the agent-lifetime decision.
/// The standalone binary wraps this + adds `kill_all` in [`serve`]; the
/// desktop-hosted shared-live server (`remote/host.rs`) calls this directly so
/// toggling the server off never kills the desktop's live agents.
///
/// `web_auth` is the CAP-1 interim token gate threaded into the router +
/// `/ws` + `/terminal/ws`. The desktop shared-live host passes `None` (its
/// cloudflared exposure predates this story — Epic-2 territory); `None` keeps
/// every endpoint byte-identical to the pre-gate server.
#[allow(clippy::too_many_arguments)]
pub async fn serve_router(
    acp: Arc<AcpManager>,
    pty: Arc<PtyManager>,
    terminal_events: TerminalEventHub,
    cwd_tracker: Arc<CwdTracker>,
    git_tracker: Arc<GitTracker>,
    exit_code_tracker: Arc<ExitCodeTracker>,
    ws_relay: Arc<WsRelaySink>,
    registry: Arc<crate::web::project_registry::ProjectRegistry>,
    registry_persistence: Option<Arc<parking_lot::Mutex<crate::acp::FileProjectRegistry>>>,
    projects_file: Option<PathBuf>,
    cfg: ServerConfig,
    shutdown: impl Future<Output = ()> + Send + 'static,
    workspace_manifest: Option<Arc<crate::acp::WorkspaceManifestService>>,
    acp_catalog: Option<Arc<crate::acp::AcpCatalogService>>,
    acp_install: Option<Arc<crate::acp::install::AcpInstallService>>,
    shared_live_writes_denied: bool,
    web_auth: Option<Arc<auth::WebAuth>>,
    canvas_pool: Option<Arc<crate::canvas::pool::CanvasDaemonPool>>,
) -> Result<(SocketAddr, JoinHandle<()>), Box<dyn std::error::Error + Send + Sync>> {
    let bind_addr = cfg.bind_addr().ok_or_else(|| {
        format!(
            "invalid host '{}': use 127.0.0.1 (default) or 0.0.0.0 (expose)",
            cfg.host
        )
    })?;

    let listener = TcpListener::bind(bind_addr).await?;
    let addr = listener.local_addr()?;
    info!("ACP web server listening on http://{}", addr);

    if !assets::dist_web_ready() {
        warn!(
            "dist-web/index.html not found at {:?} — run `bun run build:web` before browsing; \
             /health still works, static routes will 404",
            assets::dist_web_dir()
        );
    }

    // Advertise `Server` history mode when the host-owned file-backed
    // `SessionPersistence` is attached to the relay (both desktop shared-live
    // and the standalone VPS attach it now — CAP-2). Otherwise the web client
    // negotiates `live_only` (no stored transcript mirror).
    let history_mode = if ws_relay.persistence().is_some() {
        HistoryMode::Server
    } else {
        HistoryMode::LiveOnly
    };
    // Issue #613: resolve the server-side store path — explicit
    // `--store-file` wins, otherwise default under the service-account state
    // dir (same resolution posture as workspace-manifests / acp-catalog). The
    // desktop shared-live host passes `store_file: None`, so it lands on the
    // same default and gets a durable store too.
    let store = Some(Arc::new(WebStore::open(
        cfg.store_file
            .clone()
            .unwrap_or_else(|| cfg.service_account_state_dir().join("store.json")),
    )));
    // CAP-1 + #856: build the live project-root handle ONCE per server —
    // the same `Arc` the router registers with the registry (a project
    // switch rebinds it in place) AND the server-side fs watcher reads to
    // re-arm at the new root.
    let project_root_handle =
        std::sync::Arc::new(parking_lot::RwLock::new(cfg.project_root.clone()));
    // #856: spawn the FS watcher daemon here — once per SERVE, not per
    // `router()` call (tests build routers freely and must never spawn an
    // unkillable watcher). It broadcasts debounced `fs_changed` events to
    // connected web clients over the control WS.
    fs_watcher::spawn_fs_watcher(
        std::sync::Arc::clone(&project_root_handle),
        Arc::clone(&ws_relay),
    );
    let app = router::router(
        Arc::clone(&acp),
        pty,
        terminal_events,
        cwd_tracker,
        git_tracker,
        exit_code_tracker,
        Arc::clone(&ws_relay),
        Arc::clone(&registry),
        registry_persistence,
        projects_file,
        project_root_handle,
        history_mode,
        workspace_manifest,
        acp_catalog,
        acp_install,
        store,
        cfg.allow_remote_writes,
        shared_live_writes_denied,
        // The effective externally reachable origin for OAuth redirect URIs.
        // The bound address is known here (before `router()` is called), so
        // the callback route's `redirect_uri` uses it instead of the
        // hardcoded loopback default. Desktop shared-live denies all OAuth
        // control routes before this is read, so it stays `http://127.0.0.1`
        // (harmless — never used).
        format!("http://{}", addr),
        web_auth,
        // OpenPencil canvas mode: the /canvas/* routes' daemon pool. `None`
        // (desktop shared-live) degrades those routes to typed 502
        // DAEMON_DOWN — the desktop mounts its MCP proxy on the agentation
        // server instead (AD-8).
        canvas_pool,
        cfg.allowed_origins.clone(),
    );

    let handle = tokio::spawn(async move {
        // Patch D: `into_make_service_with_connect_info::<SocketAddr>()` so
        // the fs WRITE routes can extract `ConnectInfo<SocketAddr>` for the
        // localhost-only guard. Read routes and `/ws` are unaffected.
        let serve_result = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(shutdown)
        .await
        .inspect_err(|e| error!("ACP web server error: {}", e));

        match serve_result {
            Ok(()) => info!("ACP web server stopped"),
            Err(e) => error!("ACP web server stopped with error: {}", e),
        }
    });

    Ok((addr, handle))
}

/// Build the shutdown-signal future for the standalone binary path.
///
/// Waits for Ctrl-C (SIGINT) or, on Unix, SIGTERM. On signal-handler setup
/// failure, parks forever rather than completing (which would stop the server
/// immediately). The desktop-hosted path uses an `oneshot`-driven shutdown
/// instead.
async fn shutdown_signal_future() {
    match shutdown_signal().await {
        Ok(()) => info!("termul-server shutting down…"),
        Err(e) => {
            warn!("shutdown signal setup failed ({e}); serving until process exit");
            // Do not complete the shutdown future — that would stop the
            // server immediately. Park until the process is killed.
            std::future::pending::<()>().await;
        }
    }
}

/// Wait for Ctrl-C (SIGINT) or, on Unix, SIGTERM.
///
/// Returns `Err` if signal handlers cannot be installed (no `expect`/`unwrap`).
async fn shutdown_signal() -> Result<(), std::io::Error> {
    let ctrl_c = tokio::signal::ctrl_c();

    #[cfg(unix)]
    {
        let mut sigterm =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! {
            result = ctrl_c => result?,
            _ = sigterm.recv() => {},
        }
        Ok(())
    }

    #[cfg(not(unix))]
    {
        // Windows: Ctrl-C / console ctrl handler via tokio. SIGTERM is not a
        // portable Win32 signal; service-stop is out of scope for this scaffold.
        ctrl_c.await
    }
}
