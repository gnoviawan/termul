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
//!   rust-embed serving is Story 1.11.
//!
//! Auth / sandbox land in later stories. The WS relay protocol (envelope, seq,
//! event log, cursor, tiers) is [`ws`] (Story 1.4).

pub mod assets;
pub mod config;
pub mod router;
pub mod sink;
pub mod ws;

pub use config::ServerConfig;
pub use sink::{EventSink, TauriEventSink, WsRelaySink, fan_out};
pub use ws::{AppState, ReliabilityTier, SequencedEvent, WsErrorCode};

use std::sync::Arc;

use tokio::net::TcpListener;
use tracing::{error, info, warn};

use crate::acp::AcpManager;

/// Bind and serve the standalone ACP HTTP server until SIGINT/SIGTERM.
///
/// `ws_relay` is the live [`WsRelaySink`] (Story 1.4) — passed to both
/// `AcpManager::new` (as an event sink) and the router (so `/ws` can subscribe
/// clients + replay cursors). On signal: drains Axum first (graceful shutdown),
/// then kills all agent subprocesses via [`AcpManager::kill_all`]. Bind
/// failures are returned to the caller. On serve error, agents are still
/// killed before returning.
pub async fn serve(
    acp: Arc<AcpManager>,
    ws_relay: Arc<WsRelaySink>,
    cfg: ServerConfig,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let bind_addr = cfg.bind_addr().ok_or_else(|| {
        format!(
            "invalid --host '{}': use 127.0.0.1 (default) or 0.0.0.0 (expose)",
            cfg.host
        )
    })?;

    let listener = TcpListener::bind(bind_addr).await?;
    let addr = listener.local_addr()?;
    info!("termul-server listening on http://{}", addr);

    if !assets::dist_web_ready() {
        warn!(
            "dist-web/index.html not found at {:?} — run `bun run build:web` before browsing; \
             /health still works, static routes will 404",
            assets::dist_web_dir()
        );
    }

    let app = router::router(Arc::clone(&acp), Arc::clone(&ws_relay));

    let serve_result = axum::serve(listener, app)
        .with_graceful_shutdown(async {
            match shutdown_signal().await {
                Ok(()) => info!("termul-server shutting down…"),
                Err(e) => {
                    warn!(
                        "shutdown signal setup failed ({e}); serving until process exit"
                    );
                    // Do not complete the shutdown future — that would stop the
                    // server immediately. Park until the process is killed.
                    std::future::pending::<()>().await;
                }
            }
        })
        .await
        .inspect_err(|e| error!("termul-server error: {}", e));

    // Kill agents after Axum has drained (or failed) — AC2 ordering.
    acp.kill_all().await;

    serve_result?;
    info!("termul-server stopped");
    Ok(())
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
