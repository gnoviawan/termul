//! Web ACP Agent runtime — headless server + browser client support.
//!
//! This module owns the transport-neutral seams the `acp` dispatcher emits
//! through, plus the standalone Axum server skeleton (Story 1.2).
//!
//! - Desktop registers a [`sink::TauriEventSink`] (`acp:*` Tauri events).
//! - Standalone `termul-server` registers a [`sink::WsRelaySink`] stub
//!   (live WS wiring is Story 1.4) and calls [`serve`].
//!
//! Auth / sandbox / production embedding land in later stories.

pub mod config;
pub mod router;
pub mod sink;

pub use config::ServerConfig;
pub use sink::{EventSink, TauriEventSink, WsRelaySink, fan_out};

use std::sync::Arc;

use tokio::net::TcpListener;
use tracing::{error, info};

use crate::acp::AcpManager;

/// Bind and serve the standalone ACP HTTP server until SIGINT/SIGTERM.
///
/// On signal: drains Axum (graceful shutdown) and kills all agent subprocesses
/// via [`AcpManager::kill_all`]. Bind failures are returned to the caller.
pub async fn serve(
    acp: Arc<AcpManager>,
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

    let app = router::router(Arc::clone(&acp));
    let acp_for_shutdown = Arc::clone(&acp);

    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            info!("termul-server shutting down…");
            acp_for_shutdown.kill_all().await;
        })
        .await
        .inspect_err(|e| error!("termul-server error: {}", e))?;

    info!("termul-server stopped");
    Ok(())
}

/// Wait for Ctrl-C (SIGINT) or, on Unix, SIGTERM.
async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    {
        let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler");
        tokio::select! {
            () = ctrl_c => {},
            _ = sigterm.recv() => {},
        }
    }

    #[cfg(not(unix))]
    {
        ctrl_c.await;
    }
}
