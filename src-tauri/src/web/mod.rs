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

pub mod assets;
pub mod config;
pub mod fs_api;
pub mod mcp_probe_api;
pub mod mcp_servers_api;
pub mod permissions;
pub mod project_registry;
pub mod projects_api;
pub mod router;
pub mod sink;
pub mod terminal_ws;
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
/// `registry` is the in-memory [`ProjectRegistry`] the router reads for
/// `GET /projects` + `switch_project` cwd resolution. The standalone binary
/// seeds it from the file-backed [`crate::acp::project_registry::FileProjectRegistry`]
/// at startup (VPS mode); the desktop host seeds it via `remote_sync_projects`
/// and calls [`serve_router`] directly (it never reaches this `serve`
/// wrapper).
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
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let (_addr, handle) = serve_router(
        acp.clone(),
        pty.clone(),
        terminal_events,
        cwd_tracker,
        git_tracker,
        exit_code_tracker,
        ws_relay,
        registry,
        // The standalone VPS binary has no desktop chat-history store; it
        // relies on file-backed `SessionPersistence` (Story 4.3). The desktop
        // host attaches its Rust-owned durable history store instead.
        None,
        registry_persistence,
        projects_file,
        cfg,
        shutdown_signal_future(),
    )
    .await?;

    let serve_result = handle.await;

    // Cleanup: always attempt ALL resource cleanup even if one step fails.
    // PTY cleanup must not be skipped because ACP persistence errored.
    let mut cleanup_errors: Vec<Box<dyn std::error::Error + Send + Sync>> = Vec::new();

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
    chat_history_store: Option<Arc<crate::acp::ChatHistoryStore>>,
    registry_persistence: Option<Arc<parking_lot::Mutex<crate::acp::FileProjectRegistry>>>,
    projects_file: Option<PathBuf>,
    cfg: ServerConfig,
    shutdown: impl Future<Output = ()> + Send + 'static,
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

    // Advertise `Server` history mode when EITHER the durable Rust history
    // store is attached (desktop-hosted) OR file-backed persistence is attached
    // (standalone VPS, Story 4.3). Otherwise the web client negotiates
    // `live_only` (no stored transcript mirror).
    let history_mode = if chat_history_store.is_some() || ws_relay.persistence().is_some() {
        HistoryMode::Server
    } else {
        HistoryMode::LiveOnly
    };
    let app = router::router(
        Arc::clone(&acp),
        pty,
        terminal_events,
        cwd_tracker,
        git_tracker,
        exit_code_tracker,
        Arc::clone(&ws_relay),
        Arc::clone(&registry),
        chat_history_store,
        registry_persistence,
        projects_file,
        cfg.project_root.clone(),
        history_mode,
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
