//! Standalone headless `termul-server` binary (Story 1.2).
//!
//! Constructs an [`AcpManager`] with a [`WsRelaySink`] stub (no Tauri
//! `AppHandle`) and serves the Axum skeleton from `termul_manager_lib::web`.
//! Live WS relay is Story 1.4; static embedding is Story 1.11.
//!
//! This is a CONSOLE server — do NOT add `windows_subsystem = "windows"`.

use std::process::ExitCode;
use std::sync::Arc;

use termul_manager_lib::web::{serve, ServerConfig, WsRelaySink};
use termul_manager_lib::web::config::ParseCliError;
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
        let acp = Arc::new(AcpManager::new(vec![Arc::new(WsRelaySink::new())]));
        match serve(acp, cfg).await {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("termul-server failed: {e}");
                ExitCode::from(1)
            }
        }
    })
}

fn usage() -> &'static str {
    "Usage: termul-server [--host HOST] [--port PORT]\n\n\
     Options:\n\
       --host HOST   Bind host (default: 127.0.0.1; use 0.0.0.0 to expose)\n\
       --port PORT   Bind port (default: 8080)\n\
       -h, --help    Show this help"
}
