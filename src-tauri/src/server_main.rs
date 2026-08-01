//! Standalone headless `termul-server` binary (Story 1.2).
//!
//! Constructs an [`AcpManager`] with a [`WsRelaySink`] stub (no Tauri
//! `AppHandle`) and serves the Axum skeleton from `termul_manager_lib::web`.
//! Live WS relay + static-embed serving are wired via the shared `web` module.
//!
//! Path is intentionally **outside** `src/bin/` so Tauri's bundler stage-2
//! disk scan (tauri#15325) does not re-add this target into the desktop
//! app bundle. Cargo still builds it via the explicit `[[bin]]` path +
//! `required-features = ["standalone-server"]`.
//!
//! This is a CONSOLE server — do NOT add `windows_subsystem = "windows"`.

use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use termul_manager_lib::web::config::ParseCliError;
use termul_manager_lib::web::{
    seed_from_file, serve, PermissionRendezvous, ProjectRegistry, ServerConfig, WsRelaySink,
};
use termul_manager_lib::{
    AcpManager, CwdTracker, ExitCodeTracker, FileProjectRegistry, GitTracker, PtyManager,
    SessionPersistence, TerminalEventHub,
};
use tracing::info;
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
        let sessions_dir = match cfg.sessions_dir.clone() {
            Some(path) => path,
            None => {
                eprintln!("termul-server: sessions directory is not configured");
                return ExitCode::from(1);
            }
        };
        let persistence = match SessionPersistence::open(sessions_dir).await {
            Ok(persistence) => persistence,
            Err(error) => {
                eprintln!("termul-server: failed to open sessions store: {error}");
                return ExitCode::from(1);
            }
        };
        let ws_relay = Arc::new(WsRelaySink::with_persistence(
            cfg.event_log_capacity,
            Arc::clone(&persistence),
        ));
        let acp = Arc::new(AcpManager::with_persistence(
            vec![ws_relay.clone()],
            persistence,
        ));
        // Story 1.7: attach the server-side permission rendezvous (bounded
        // timeout, at-most-one, first-response-wins, disconnect-deny, TOCTOU).
        // The relay snapshots `acp:permission_request` events into it; the
        // `/ws` `respond_permission` handler + disconnect cleanup enforce the
        // policy. The desktop path does NOT attach a rendezvous (it uses the
        // `acp_respond_permission` Tauri command directly).
        let rendezvous = Arc::new(PermissionRendezvous::with_timeout(
            Arc::clone(&acp),
            Duration::from_secs(cfg.permission_timeout_secs),
        ));
        ws_relay.set_rendezvous(rendezvous);
        // Story 4.1: the in-memory project registry. In VPS mode the
        // standalone binary is the source of truth — it seeds the registry
        // from the file-backed `FileProjectRegistry` at startup (when
        // --projects-file / $TERMUL_PROJECTS_FILE is configured). A missing
        // file is not fatal (loads as empty, so `/projects` returns empty);
        // a corrupt/invalid file IS fatal (abort startup so a misconfigured
        // VPS is obvious). Desktop-hosted mode never reaches here (it calls
        // `serve_router` directly with a renderer-fed registry).
        let registry = Arc::new(ProjectRegistry::new());
        let mut registry_persistence = None;
        if let Some(ref projects_file) = cfg.projects_file {
            match FileProjectRegistry::load(projects_file) {
                Ok(file_reg) => {
                    let n = file_reg.roots().len();
                    info!(
                        "loaded {} project root(s) from '{}'",
                        n,
                        projects_file.display()
                    );
                    seed_from_file(&registry, &file_reg);
                    registry_persistence = Some(Arc::new(parking_lot::Mutex::new(file_reg)));
                }
                Err(e) => {
                    eprintln!(
                        "termul-server: failed to load projects file '{}': {e}",
                        projects_file.display()
                    );
                    return ExitCode::from(1);
                }
            }
        }
        // The standalone binary owns its interactive PTYs and kills them only
        // after Axum drains. Desktop shared-live passes its existing manager and
        // never reaches that cleanup path.
        let terminal_events = TerminalEventHub::standalone();
        let cwd_tracker = Arc::new(CwdTracker::new(terminal_events.clone()));
        let git_tracker = Arc::new(GitTracker::with_cwd_tracker(
            cwd_tracker.clone(),
            terminal_events.clone(),
        ));
        let exit_code_tracker = Arc::new(ExitCodeTracker::new(terminal_events.clone()));
        let pty = Arc::new(PtyManager::new(
            terminal_events.clone(),
            Arc::clone(&cwd_tracker),
            Arc::clone(&git_tracker),
            Arc::clone(&exit_code_tracker),
        ));

        let projects_file = cfg.projects_file.clone();
        match serve(
            acp,
            pty,
            terminal_events,
            cwd_tracker,
            git_tracker,
            exit_code_tracker,
            ws_relay,
            registry,
            registry_persistence,
            projects_file,
            cfg,
        )
        .await
        {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("termul-server failed: {e}");
                ExitCode::from(1)
            }
        }
    })
}

fn usage() -> &'static str {
    "Usage: termul-server [--host HOST] [--port PORT] [--event-log-capacity N] [--permission-timeout SECS] [--project-root PATH] [--projects-file PATH] [--sessions-dir PATH]\n\n\
     Options:\n\
       --host HOST                 Bind host (default: 127.0.0.1; use 0.0.0.0 to expose)\n\
       --port PORT                 Bind port (default: 8080)\n\
       --event-log-capacity N      Per-session event-log ring capacity (default: 4096)\n\
       --permission-timeout SECS   Permission rendezvous timeout in seconds (default: 60)\n\
       --project-root PATH         Project-root boundary for /fs/* routes (default: $TERMUL_PROJECT_ROOT or $HOME)\n\
       --projects-file PATH        VFS-roots registry file (default: $TERMUL_PROJECTS_FILE; missing = empty list)\n\
       --sessions-dir PATH         Durable sessions root (default: $TERMUL_SESSIONS_DIR or service-account state dir)\n\
       -h, --help                  Show this help"
}
