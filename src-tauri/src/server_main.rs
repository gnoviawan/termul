//! Standalone headless `termul-server` binary (Story 1.2).
//!
//! Constructs an [`AcpManager`] with a [`WsRelaySink`] stub (no Tauri
//! `AppHandle`) and serves the Axum skeleton from `termul_manager_lib::web`.
//! Live WS relay is Story 1.4; static embedding is Story 1.11.
//!
//! Path is intentionally **outside** `src/bin/` so Tauri's bundler stage-2
//! disk scan (tauri#15325) does not re-add this target into the desktop
//! app bundle. Cargo still builds it via the explicit `[[bin]]` path +
//! `required-features = ["standalone-server"]`.
//!
//! This is a CONSOLE server — do NOT add `windows_subsystem = "windows"`.

use std::process::ExitCode;
use std::sync::Arc;

use termul_manager_lib::web::config::ParseCliError;
use termul_manager_lib::web::{serve, ServerConfig, WsRelaySink};
use termul_manager_lib::AcpManager;
use tracing_subscriber::EnvFilter;

fn main() -> ExitCode {
    // Parse CLI BEFORE any tokio / app setup (AC2).
    let cfg = match ServerConfig::from_args(std::env::args().skip(1)) {
        Ok(cfg) => cfg,
        Err(ParseCliError::Help) => {
            println!("{}", usage());
            return ExitCode::SUCCESS;
        }
        Err(ParseCliError::Message(msg)) => {
            eprintln!("error: {msg}");
            eprintln!();
            eprintln!("{}", usage());
            return ExitCode::from(2);
        }
    };

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let runtime = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("failed to start tokio runtime: {e}");
            return ExitCode::from(1);
        }
    };

    runtime.block_on(async move {
        // Story 1.4: construct the LIVE relay sink (per-session event logs +
        // seq counters + subscriber set) and pass it to BOTH the ACP manager
        // (as an event sink) and `serve` (so `/ws` can subscribe clients +
        // replay cursors). AC7: standalone registers ONLY WsRelaySink (1 sink).
        let ws_relay = Arc::new(WsRelaySink::with_log_capacity(cfg.event_log_capacity));
        let acp = Arc::new(AcpManager::new(vec![ws_relay.clone()]));
        // `serve` always kill_all()s after Axum returns (ok or err).
        match serve(acp, ws_relay, cfg).await {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("termul-server failed: {e}");
                ExitCode::from(1)
            }
        }
    })
}

fn usage() -> &'static str {
    "Usage: termul-server [--host HOST] [--port PORT] [--event-log-capacity N]\n\n\
     Options:\n\
       --host HOST                 Bind host (default: 127.0.0.1; use 0.0.0.0 to expose)\n\
       --port PORT                 Bind port (default: 8080)\n\
       --event-log-capacity N      Per-session event-log ring capacity (default: 4096)\n\
       -h, --help                  Show this help"
}
