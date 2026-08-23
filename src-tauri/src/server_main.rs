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

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use termul_manager_lib::server_update::{
    check_and_apply_update, current_version, embedded_public_key, is_update_enabled,
    restart_binary, restore_previous, UpdateChannel, UpdateOptions, UpdateOutcome,
    SERVER_PLATFORM_KEY,
};
use termul_manager_lib::web::config::ParseCliError;
use termul_manager_lib::web::{
    seed_from_file, serve, PermissionRendezvous, ProjectRegistry, QuestionRendezvous, ServerConfig,
    WsRelaySink,
};
use termul_manager_lib::{
    AcpCatalogService, AcpInstallService, AcpManager, CwdTracker, ExitCodeTracker,
    FileProjectRegistry, GitTracker, PtyManager, SessionPersistence, TerminalEventHub,
    WorkspaceManifestService,
};
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

fn main() -> ExitCode {
    let raw_args: Vec<String> = std::env::args().skip(1).collect();

    // `--check-update`: operator-explicit one-shot self-update. Handled before
    // `ServerConfig::from_args` so the flag (unknown to the shared parser) does
    // not trip it. Performs fetch → verify → swap → reexec, then exits.
    if raw_args.iter().any(|arg| arg == "--check-update") {
        init_tracing();
        return run_one_shot_update_check();
    }

    // `--internal-mcp-plan-server`: self-spawned child of the host-injected
    // `plan` MCP tool. The agent spawns `current_exe()` with this flag
    // (the injected `McpServer::Stdio`); the child runs an rmcp MCP server over
    // stdio + forwards calls to the parent's TCP listener. Branch BEFORE any
    // tokio/app setup (AC2) so the standalone binary never inits the server
    // stack for the child path. See `acp::host_mcp::child` + spec
    // `spec-acp-host-todo-plan-tool.md`.
    if termul_manager_lib::host_mcp::is_child_invocation() {
        return ExitCode::from(termul_manager_lib::host_mcp::child::run() as u8);
    }

    // Parse CLI BEFORE any tokio / app setup (AC2).
    let cfg = match ServerConfig::from_args(raw_args) {
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

    init_tracing();

    // Operator opt-in boundary log (AGENTS.md durable-log policy). When the
    // standalone server enables `--allow-remote-writes`, any non-loopback peer
    // gains write access to a broad set of mutation routes — surface it
    // loudly at boot so it shows up in machine logs (e.g. /tmp/termul-server.log).
    if cfg.allow_remote_writes {
        let host = &cfg.host;
        tracing::warn!(
            "termul-server: remote writes ENABLED (--allow-remote-writes); non-loopback peers \
             on {} gain: fs mkdir/write/delete/rename/copy CONFINED to project_root '{}'; \
             git + worktree operations confined to project_root; AND host-state mutation via \
             /projects/default, /acp/install, /log/frontend-error, /workspace/*. Loopback callers \
             keep ADR-007 breadth (any path). No web auth is enforced yet (Epic 2).",
            host,
            cfg.project_root.display()
        );
        if cfg.bind_mode() == Some(termul_manager_lib::web::config::BindMode::Localhost) {
            tracing::warn!(
                "termul-server: --allow-remote-writes is a no-op when bound to 127.0.0.1 \
                 (no non-loopback peer can ever reach the server)"
            );
        }
    }

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
        // CAP-5 / Story 5: open the host-owned workspace-manifests root. The
        // standalone binary owns its own root — NEVER shared with a desktop
        // host on the same machine (two processes on one JSONL store would
        // corrupt both). Defaults to `<state dir>/workspace-manifests`; the
        // explicit `--workspace-manifests-dir` flag overrides.
        let workspace_manifests_dir = cfg
            .workspace_manifests_dir
            .clone()
            .unwrap_or_else(|| cfg.service_account_state_dir().join("workspace-manifests"));
        let workspace_manifest = match WorkspaceManifestService::open(workspace_manifests_dir).await {
            Ok(service) => Some(service),
            Err(error) => {
                eprintln!("termul-server: failed to open workspace-manifests store: {error}");
                return ExitCode::from(1);
            }
        };
        // CAP-6 / Story 8: open the host-owned ACP catalog root. The
        // standalone binary owns its own root — NEVER shared with a desktop
        // host on the same machine. Defaults to `<state dir>/acp-catalog`.
        let acp_catalog_dir = cfg
            .acp_catalog_dir
            .clone()
            .unwrap_or_else(|| cfg.service_account_state_dir().join("acp-catalog"));
        let acp_catalog = match AcpCatalogService::open(acp_catalog_dir).await {
            Ok(service) => Some(service),
            Err(error) => {
                eprintln!("termul-server: failed to open acp-catalog store: {error}");
                return ExitCode::from(1);
            }
        };
        // CAP-6 / Story 9: open the host-owned verified-atomic ACP install
        // root. The standalone binary owns its own root — NEVER shared with a
        // desktop host on the same machine. Defaults to
        // `<state dir>/acp-registry-binaries`. The install service holds the
        // catalog `Arc` for the convenience `install_by_id` path.
        let acp_install_dir = cfg
            .service_account_state_dir()
            .join("acp-registry-binaries");
        let acp_install = match AcpInstallService::open(
            acp_install_dir,
            std::sync::Arc::clone(acp_catalog.as_ref().expect("catalog opened above")),
        )
        .await
        {
            Ok(service) => Some(service),
            Err(error) => {
                eprintln!("termul-server: failed to open acp-install store: {error}");
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
        let rendezvous = Arc::new(PermissionRendezvous::with_policy(
            Arc::clone(&acp),
            Duration::from_secs(cfg.permission_timeout_secs),
            Duration::from_secs(cfg.permission_reconnect_grace_secs),
        ));
        ws_relay.set_rendezvous(rendezvous);
        // Issue #411: attach the server-side question rendezvous (bounded
        // timeout, first-response-wins, TOCTOU). The relay snapshots
        // `acp:question_request` events into it; the `/ws` `answer_question`
        // handler + disconnect cleanup enforce the policy. The desktop path
        // does NOT attach one (it uses the `acp_answer_question` Tauri command
        // directly).
        let question_rendezvous = Arc::new(QuestionRendezvous::with_timeout(
            Arc::clone(&acp),
            Duration::from_secs(cfg.permission_timeout_secs),
        ));
        ws_relay.set_question_rendezvous(question_rendezvous);
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
        // Opt-in self-update loop (default off): only runs when the operator set
        // TERMUL_SERVER_UPDATE_ENABLED=true + TERMUL_SERVER_UPDATE_CHANNEL. A bad
        // signature keeps the current binary running (verify-before-swap), so an
        // unattended server is never bricked by a failed update attempt.
        spawn_periodic_update_loop();
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
            workspace_manifest,
            acp_catalog,
            acp_install,
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

/// Initialize `tracing` + `tracing-subscriber` (EnvFilter, `RUST_LOG`; floor `info`).
/// Extracted so both the normal server path and the `--check-update` one-shot
/// share the same setup.
fn init_tracing() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();
}

/// Resolve the server's own binary path for the self-update swap/reexec.
fn current_binary_path() -> PathBuf {
    std::env::current_exe().unwrap_or_else(|_| PathBuf::from("termul-server"))
}

/// Build the self-update options from env + the embedded pubkey. `Err` when
/// self-update is unavailable (no pubkey baked in) — the caller logs + skips.
///
/// `default_channel`: when `TERMUL_SERVER_UPDATE_CHANNEL` is unset/invalid,
/// `Some(c)` falls back to `c` (used by the operator-explicit `--check-update`
/// one-shot, which defaults to Stable), while `None` surfaces an error (used by
/// the periodic loop, which requires the env to opt in).
fn build_update_options(default_channel: Option<UpdateChannel>) -> Result<UpdateOptions, String> {
    let channel = UpdateChannel::parse(
        &std::env::var("TERMUL_SERVER_UPDATE_CHANNEL").unwrap_or_default(),
    )
    .or(default_channel);
    let channel = match channel {
        Some(c) => c,
        None => {
            return Err(
                "TERMUL_SERVER_UPDATE_CHANNEL is unset or not stable/insider/nightly".to_owned(),
            )
        }
    };
    // `embedded_public_key()` returns `Result<&'static PublicKey>` backed by a
    // `OnceLock`; the `&'static` ref moves into `UpdateOptions` (and across the
    // spawned periodic task) directly — no clone needed.
    let public_key = embedded_public_key().map_err(|e| e.to_string())?;
    Ok(UpdateOptions {
        channel,
        current_version: current_version().to_owned(),
        binary_path: current_binary_path(),
        platform_key: SERVER_PLATFORM_KEY,
        public_key,
    })
}

/// `--check-update`: fetch → verify → swap, then exit SUCCESS. Operator-
/// explicit, so the channel defaults to Stable when the env is unset (the
/// periodic loop, by contrast, requires the env to opt in). Does **not**
/// re-exec: re-exec would start the server in this one-shot's place; the
/// operator restarts the server to run the new version (the `.old` binary is
/// retained for manual rollback). Never auto-restarts an unattended server
/// without this explicit trigger or the env gate.
fn run_one_shot_update_check() -> ExitCode {
    info!(
        target: "termul::server_update",
        "one-shot server self-update requested (--check-update)"
    );
    // Operator-explicit one-shot: default to Stable when the channel env is
    // unset (matches the `--check-update` usage docs); the env still wins when set.
    let opts = match build_update_options(Some(UpdateChannel::Stable)) {
        Ok(o) => o,
        Err(reason) => {
            error!(target: "termul::server_update", "self-update unavailable: {reason}");
            return ExitCode::from(1);
        }
    };

    let runtime = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(e) => {
            error!(
                target: "termul::server_update",
                "failed to start tokio runtime for update check: {e}"
            );
            return ExitCode::from(1);
        }
    };

    match runtime.block_on(check_and_apply_update(&opts)) {
        Ok(UpdateOutcome::NoUpdate) => {
            info!(
                target: "termul::server_update",
                "no newer server binary on channel {:?} (current {})",
                opts.channel,
                opts.current_version
            );
            ExitCode::SUCCESS
        }
        Ok(UpdateOutcome::Updated { new_version, old_path }) => {
            // One-shot: apply the update but do NOT re-exec — re-exec would
            // start the server in this one-shot's place. The operator restarts
            // the server to run the new version; the `.old` binary is retained
            // for manual rollback.
            info!(
                target: "termul::server_update",
                "verified + swapped to {new_version}; previous binary retained at {}. \
                 Restart the server to run the new version (no auto-reexec from --check-update)",
                old_path.display()
            );
            ExitCode::SUCCESS
        }
        Err(e) => {
            error!(
                target: "termul::server_update",
                "update check failed (keeping current binary): {e}"
            );
            ExitCode::from(1)
        }
    }
}

/// Spawn the background periodic self-update loop on the server's tokio runtime.
/// No-op (with an info log) when the operator did not opt in via env — the
/// default is off so an unattended server never auto-updates.
fn spawn_periodic_update_loop() {
    if !is_update_enabled() {
        info!(
            target: "termul::server_update",
            "self-update disabled (set TERMUL_SERVER_UPDATE_ENABLED=true + \
             TERMUL_SERVER_UPDATE_CHANNEL to opt in)"
        );
        return;
    }

    // Periodic loop: opt-in requires the channel env (no default) — an
    // unattended server never auto-updates unless the operator named a channel.
    let opts = match build_update_options(None) {
        Ok(o) => o,
        Err(reason) => {
            warn!(
                target: "termul::server_update",
                "TERMUL_SERVER_UPDATE_ENABLED=true but self-update unavailable: {reason} \
                 (periodic loop disabled)"
            );
            return;
        }
    };

    // Default 6h, mirroring the desktop's periodic cadence. Overridable so an
    // operator can tune the polling frequency for their deployment.
    let interval_secs = std::env::var("TERMUL_SERVER_UPDATE_INTERVAL_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(6 * 60 * 60);

    let channel = opts.channel;
    info!(
        target: "termul::server_update",
        "periodic self-update enabled on channel {:?} (every {}s)", channel, interval_secs
    );

    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(interval_secs));
        loop {
            ticker.tick().await;
            match check_and_apply_update(&opts).await {
                Ok(UpdateOutcome::NoUpdate) => {
                    tracing::debug!(
                        target: "termul::server_update",
                        "no newer server binary on channel {:?}", opts.channel
                    );
                }
                Ok(UpdateOutcome::Updated { new_version, old_path }) => {
                    info!(
                        target: "termul::server_update",
                        "verified + swapped to {new_version}; restarting into the new binary"
                    );
                    // Re-exec the canonical install path (NOT current_exe(),
                    // which would resolve to the `.old` inode after the swap).
                    if let Err(e) = restart_binary(&opts.binary_path) {
                        error!(
                            target: "termul::server_update",
                            "reexec failed: {e}; rolling back to the previous binary"
                        );
                        // Roll the swap back so the deployment keeps running the
                        // known-good binary instead of a new binary that can't re-exec.
                        if let Err(restore_err) = restore_previous(&opts.binary_path, &old_path) {
                            error!(
                                target: "termul::server_update",
                                "rollback also failed: {restore_err}; the new binary is at {} \
                                 and the previous at {} — recover manually",
                                opts.binary_path.display(),
                                old_path.display()
                            );
                        }
                    }
                    // restart_binary never returns on success.
                    return;
                }
                Err(e) => {
                    warn!(
                        target: "termul::server_update",
                        "periodic update check failed (keeping current binary): {e}"
                    );
                }
            }
        }
    });
}

fn usage() -> &'static str {
r#"termul-server — standalone headless ACP web server

USAGE:
    termul-server [OPTIONS]

OPTIONS:
  Network:
    --host <HOST>                 Bind host. Accepted: 127.0.0.1, localhost,
                                  loopback (loopback only); 0.0.0.0, all, any
                                  (all interfaces).
                                  [default: 127.0.0.1]
    --port <PORT>                 Bind port. Range 1-65535 (0 is rejected).
                                  [default: 8080]

  Sessions & state:
    --sessions-dir <PATH>         Durable sessions root.
                                  [default: $TERMUL_SESSIONS_DIR or state dir]
    --project-root <PATH>         Boundary for /git/*, /skills, /search/content
                                  routes (NOT /fs/* — ADR-007). Must exist and
                                  be a directory; validated at startup.
                                  [default: $TERMUL_PROJECT_ROOT or $HOME]
    --projects-file <PATH>        VFS-roots registry file. A missing file loads
                                  as an empty registry (not fatal); a corrupt
                                  file is fatal.
                                  [default: $TERMUL_PROJECTS_FILE; unset = empty]
    --workspace-manifests-dir <PATH>
                                  Workspace manifests root.
                                  [default: <state dir>/workspace-manifests]
    --acp-catalog-dir <PATH>      ACP catalog root.
                                  [default: <state dir>/acp-catalog]
    --store-file <PATH>           Server-side key-value store for the web client
                                  (terminal layout, settings, editor state,
                                  command history, SSH profiles, ...).
                                  [default: $TERMUL_STORE_FILE or
                                  <state dir>/store.json]

  Tuning:
    --event-log-capacity <N>      Per-session event-log ring capacity.
                                  [default: 4096]
    --permission-timeout <SECS>   Permission rendezvous timeout. On expiry the
                                  pending permission resolves as deny.
                                  [default: 60]
    --permission-reconnect-grace <SECS>
                                  Grace after last subscriber disconnect before
                                  pending permissions are denied.
                                  [default: 60]

  Security & updates:
    --allow-remote-writes         Admit non-loopback peers on all guarded write
                                  routes. /fs/* writes reject only .. traversal
                                  (ADR-007 breadth, any path); /git/* and
                                  /worktree/* writes confined to --project-root;
                                  AND host-state writes (/projects/default,
                                  /acp/install, /log/frontend-error,
                                  /workspace/*). Loopback callers keep ADR-007
                                  breadth (any path). No-op when bound to
                                  127.0.0.1. No web auth is enforced yet
                                  (Epic 2). Only enable on a trusted network.
                                  [env: TERMUL_SERVER_ALLOW_REMOTE_WRITES=true|1]
    --check-update                Run one opt-in self-update now: fetch the channel
                                  manifest, verify the downloaded binary signature,
                                  and atomically swap. Does NOT auto-reexec —
                                  restart the server to run the new version (the
                                  .old binary is retained for rollback). Defaults
                                  to the stable channel when
                                  TERMUL_SERVER_UPDATE_CHANNEL is unset; the env
                                  wins when set. A locally-built binary without a
                                  baked-in pubkey reports self-update unavailable.

    -h, --help                    Show this help

ENVIRONMENT:
    <state dir>                   Unix: $XDG_STATE_HOME/termul or
                                  $HOME/.local/state/termul
                                  Windows: %LOCALAPPDATA%\Termul
                                  Fallback: <tmp>/termul
    RUST_LOG                      tracing filter (floor: info). Try
                                  RUST_LOG=termul_manager_lib=debug
    TERMUL_PROJECT_ROOT           Fallback for --project-root
    TERMUL_PROJECTS_FILE          Fallback for --projects-file
    TERMUL_SESSIONS_DIR           Fallback for --sessions-dir
    TERMUL_STORE_FILE             Fallback for --store-file
    TERMUL_SERVER_ALLOW_REMOTE_WRITES  true|1 enables --allow-remote-writes
    TERMUL_SERVER_UPDATE_ENABLED  true gates the periodic self-update loop
    TERMUL_SERVER_UPDATE_CHANNEL  stable|insider|nightly (required for periodic loop)
    TERMUL_SERVER_UPDATE_INTERVAL_SECS  periodic loop interval [default: 21600]

EXAMPLES:
    # Local: serve the embedded web client on loopback
    termul-server --project-root $HOME/src/myproj

    # LAN: expose to phone browsers on the trusted network
    termul-server --host 0.0.0.0 --port 8080 \
        --project-root $HOME/src/myproj

    # LAN with remote writes (trusted network only)
    termul-server --host 0.0.0.0 --project-root $HOME/src/myproj \
        --allow-remote-writes

    # Background with debug logging
    RUST_LOG=termul_manager_lib=debug termul-server --host 0.0.0.0 \
        --project-root $HOME/src/myproj > /tmp/termul-server.log 2>&1 &

    # One-shot self-update check
    termul-server --check-update
"#
}
