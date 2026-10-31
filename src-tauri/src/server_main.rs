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

use termul_manager_lib::data_lock::StandalonePaths;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use termul_manager_lib::server_update::{
    check_and_apply_update, current_version, embedded_public_key, restart_binary,
    restore_previous, UpdateChannel, UpdateOptions, UpdateOutcome, SERVER_PLATFORM_KEY,
};
use termul_manager_lib::web::auth::{resolve as resolve_web_auth, WebAuthResolution};
use termul_manager_lib::web::config::{BindMode, ParseCliError};
use termul_manager_lib::web::server_config_file;
use termul_manager_lib::web::setup;
use termul_manager_lib::web::{
    serve, PermissionRendezvous, ProjectRegistry, QuestionRendezvous, ServerConfig,
    WsRelaySink,
};
use termul_manager_lib::web::project_registry::RootCheck;
use termul_manager_lib::web::store::{legacy_manifests_dir, StorePolicy, WebStore};
use termul_manager_lib::{
    AcpCatalogService, AcpInstallService, AcpManager, CwdTracker, ExitCodeTracker,
    GitTracker, PtyManager, SessionPersistence, TerminalEventHub,
};
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

fn main() -> ExitCode {
    // Marks this process as the headless server. Windows agent spawns read it
    // to hide browser login (`NO_BROWSER=1`). Desktop builds never set it.
    std::env::set_var("TERMUL_SERVER", "1");
    let raw_args: Vec<String> = std::env::args().skip(1).collect();

    // `--check-update`: operator-explicit one-shot self-update. Handled before
    // `ServerConfig::from_args` so the flag (unknown to the shared parser) does
    // not trip it. Performs fetch → verify → swap → reexec, then exits.
    if raw_args.iter().any(|arg| arg == "--check-update") {
        init_tracing();
        return run_one_shot_update_check();
    }

    // `onboard`: guided interactive setup + background launch. Handled before
    // `ServerConfig::from_args` so the `--onboard` flag (unknown to the shared
    // parser) does not trip it. The wizard performs the background launch
    // itself (systemd unit or setsid detach); it does NOT fall through to the
    // foreground bootstrap. Only the binary wiring here is gated by
    // `standalone-server`; the `onboard` lib module is unconditionally compiled.
    if raw_args
        .first()
        .is_some_and(|arg| arg == "onboard" || arg == "--onboard")
    {
        init_tracing();
        return termul_manager_lib::onboard::run();
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

    // Local-only Claude setup commands. They run before the server binds a
    // socket, so API-key provisioning is never exposed through HTTP or WS.
    // The admin CLI lives in the lib (`claude_admin`, re-exported from
    // `acp`), mirroring the `onboard` module wiring.
    if raw_args.first().is_some_and(|arg| arg == "claude") {
        init_tracing();
        return termul_manager_lib::claude_admin::run(&raw_args[1..]);
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
    // Tracing is only live now, so removed-flag warnings queued during
    // `ServerConfig::from_args` are emitted here, one per flag.
    for warning in &cfg.deprecation_warnings {
        warn!("{warning}");
    }

    // AD-14: one host per durable path. Lock the state dir and every store
    // path (sessions, projects, workspace manifests, acp catalog, store file)
    // BEFORE anything opens or writes them — including the web-auth token
    // file below. A held lock means another Termul host (desktop app or
    // termul-server) owns the path: refuse to start, never share it. The
    // locks live until `main` returns.
    let data_paths = StandalonePaths::resolve(&cfg);
    let _data_locks = match data_paths.lock() {
        Ok(locks) => locks,
        Err(error) => {
            error!("termul-server: refusing to start: {error}");
            eprintln!("termul-server: {error}");
            return ExitCode::from(1);
        }
    };

    // gh-1105: decide the setup-mode boot BEFORE web-auth resolution so the
    // gate resolves against the bind this process will ACTUALLY serve. Setup
    // mode binds 0.0.0.0 by default (spec Decision 2 — token-gated /setup/*
    // only) so a headless install is reachable; resolving against that
    // public bind makes `resolve` mint + persist the web-auth token the
    // post-setup server reloads after re-exec — which is also the token the
    // `/setup/apply` reply hands to the browser (`webAuthToken`). An
    // explicit --host keeps its choice.
    let state_dir = cfg.service_account_state_dir();
    let setup_required = cfg.setup_required();
    let effective_bind_mode = if setup_required && !cfg.host_explicit {
        Some(BindMode::All)
    } else {
        cfg.bind_mode()
    };

    // QA remediation Story 1 (CAP-1 interim): resolve the web auth gate
    // BEFORE any binding/serving setup. Fail-closed: a public bind whose
    // token can be neither resolved nor persisted aborts here with an
    // explicit error (never runs open). A loopback bind with no configured
    // token resolves Ungated (byte-identical legacy behavior; the token file
    // is not even read).
    let web_auth = match resolve_web_auth(
        effective_bind_mode,
        cfg.web_auth_token.clone(),
        &state_dir,
    ) {
        Ok(resolution) => resolution,
        Err(error) => {
            // Durable tracing event (stderr is lost for detached services);
            // the message carries resolution context only — never the token.
            error!("termul-server: web auth resolution failed, refusing to start: {error}");
            eprintln!("termul-server: {error}");
            return ExitCode::from(1);
        }
    };
    let gate_active = !matches!(web_auth, WebAuthResolution::Ungated);
    // The plaintext-transport warning applies only when bearer traffic
    // actually crosses a network. Loaded/Generated origins imply a public
    // bind (loopback never reads/generates the token file); a Configured
    // token can also gate a LOOPBACK bind, where the warning would be wrong.
    let public_bind = effective_bind_mode == Some(BindMode::All);
    let web_auth = match web_auth {
        WebAuthResolution::Ungated => None,
        WebAuthResolution::Gated { auth, origin } => {
            match &origin {
                termul_manager_lib::web::auth::WebAuthOrigin::Configured => {
                    info!("termul-server: web auth enabled (operator-configured token)");
                    if public_bind {
                        warn_plaintext_transport();
                    }
                }
                termul_manager_lib::web::auth::WebAuthOrigin::Loaded(path) => {
                    // No secret in the log — only the source path.
                    info!(
                        "termul-server: web auth enabled (token loaded from {})",
                        path.display()
                    );
                    // Loaded implies a public bind — the warning always applies.
                    warn_plaintext_transport();
                }
                termul_manager_lib::web::auth::WebAuthOrigin::Generated(path) => {
                    // The token is NEVER printed: stdout of a detached
                    // service lands in durable logs (journald / nohup files),
                    // and secrets must not. It lives only in the
                    // owner-protected file; later boots load it silently.
                    // In setup mode the actionable URL is the `?setup=` one
                    // printed below — the apply reply hands this token to the
                    // browser itself, so skip the read-the-file directions.
                    if !setup_required {
                        println!(
                            "termul-server: generated a web auth token (first boot on a public bind).\n\
                             The token is never printed or logged — read it from the\n\
                             owner-protected file (mode 0600 on Unix): {}\n\
                             Then open http://<host>:{}/#token=<token> — the token travels in\n\
                             the URL FRAGMENT (never sent to the server or logged by it).\n\
                             NOTE: this is a PLAINTEXT HTTP/WebSocket server — bearer traffic,\n\
                             including the token, is readable by network observers. For\n\
                             non-local access, place the server behind an HTTPS reverse proxy\n\
                             that terminates TLS.",
                            path.display(),
                            cfg.port,
                        );
                    }
                    info!(
                        "termul-server: web auth enabled (token generated, persisted to {})",
                        path.display()
                    );
                    warn_plaintext_transport();
                }
            }
            Some(auth)
        }
    };

    // gh-1105: capture the resolved gate token's TEXT for the setup-mode
    // `/setup/apply` reply (`webAuthToken`) — the browser lands on the
    // post-restart origin already authenticated. A configured token comes
    // straight from cfg; a generated/loaded token is re-read from the
    // owner-only token file `resolve` just wrote/validated (the re-exec'd
    // server loads the same secret). NEVER logged.
    let resolved_gate_token: Option<String> = if gate_active {
        cfg.web_auth_token
            .as_ref()
            .map(|token| token.as_str().to_string())
            .or_else(|| persisted_web_auth_token(&state_dir))
    } else {
        None
    };

    // Operator opt-in boundary log (AGENTS.md durable-log policy). When the
    // standalone server enables `--allow-remote-writes`, any non-loopback peer
    // gains write access to a broad set of mutation routes — surface it
    // loudly at boot so it shows up in machine logs (e.g. /tmp/termul-server.log).
    if cfg.allow_remote_writes {
        let host = &cfg.host;
        let auth_tail = if gate_active {
            "The web auth token gate is ON: unauthenticated peers are refused."
        } else {
            "No web auth is enforced yet (Epic 2)."
        };
        tracing::warn!(
            "termul-server: remote writes ENABLED (--allow-remote-writes); non-loopback peers \
             on {} gain: fs mkdir/write/delete/rename/copy CONFINED to the registered project roots; \
             git + worktree operations confined to the registered project roots; AND host-state mutation via \
             /projects/default, /acp/install, /log/frontend-error. Loopback callers \
             keep ADR-007 breadth (any path). {auth_tail}",
            host,
            auth_tail = auth_tail,
        );
        if cfg.bind_mode() == Some(BindMode::Localhost) {
            tracing::warn!(
                "termul-server: --allow-remote-writes is a no-op when bound to 127.0.0.1 \
                 (no non-loopback peer can ever reach the server)"
            );
        }
    }

    if !cfg.allowed_origins.is_empty() {
        info!(
            "termul-server: extra request origins allowed ({})",
            cfg.allowed_origins
        );
    }

    // gh-1105: no completed server config → run the minimal setup-mode
    // server INSTEAD of the full stack: `/health` (+ `setupRequired`),
    // the setup-token-gated `/setup/*` API, and the SPA fallback — the
    // onboarding page loads and the wizard's apply persists
    // `server-config.json` then re-execs back through this `main` in normal
    // mode. `AppState`/`AcpManager`/the store/PTYs are never constructed
    // here, and no gated API prefix is mounted.
    if setup_required {
        return run_setup_mode(&cfg, resolved_gate_token, &state_dir);
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
                error!("termul-server: sessions directory is not configured");
                eprintln!("termul-server: sessions directory is not configured");
                return ExitCode::from(1);
            }
        };
        // Boundary log for the #839/#879 path resolution: sessions and
        // projects must follow `--state-dir` when that flag is the only
        // location override. Paths only — never tokens or credentials.
        info!(
            "termul-server: resolved sessions '{}' projects '{}' state '{}'",
            sessions_dir.display(),
            cfg.projects_file
                .as_ref()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|| "(none)".to_string()),
            cfg.service_account_state_dir().display()
        );
        // AD-14/AD-18: the web store is opened here, after the data locks are
        // held. A newer-schema file (or a legacy file that cannot be backed
        // up before migration) refuses startup visibly instead of degrading;
        // the file is left untouched.
        let store = match WebStore::open(data_paths.store_file.clone(), StorePolicy::from_config(&cfg)) {
            // The retired workspace manifests move into the first device that
            // adopts the store (renamed afterwards).
            Ok(store) => Arc::new(store.with_legacy_manifests(legacy_manifests_dir(&data_paths.state_dir))),
            Err(error) => {
                error!("termul-server: refusing to start: {error}");
                eprintln!("termul-server: {error}");
                return ExitCode::from(1);
            }
        };
        let persistence = match SessionPersistence::open(sessions_dir).await {
            Ok(persistence) => persistence,
            Err(error) => {
                error!("termul-server: failed to open sessions store: {error}");
                eprintln!("termul-server: failed to open sessions store: {error}");
                return ExitCode::from(1);
            }
        };
        tokio::spawn(termul_manager_lib::mcp_catalog::McpCatalogService::run(
            data_paths.state_dir.join("mcp-catalog"),
        ));
        // CAP-6 / Story 8: open the host-owned ACP catalog root. The
        // standalone binary owns its own root — NEVER shared with a desktop
        // host on the same machine. Defaults to `<state dir>/acp-catalog`.
        let acp_catalog_dir = data_paths.acp_catalog_dir.clone();
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
        let claude_agent = Arc::new(termul_manager_lib::ClaudeAgentService::system(
            acp_install_dir.clone(),
        ));
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
        let ws_relay = Arc::new(
            WsRelaySink::with_persistence(cfg.event_log_capacity, Arc::clone(&persistence))
                .with_ledger(termul_manager_lib::web::command_ledger::CommandLedger::new(
                    Duration::from_secs(cfg.receipt_retention_secs),
                )),
        );
        let acp = Arc::new(AcpManager::with_persistence_and_claude_agent(
            vec![ws_relay.clone()],
            persistence,
            claude_agent,
        ));
        // Attach the permission and question rendezvous. The relay snapshots
        // `acp:permission_request` and `acp:question_request` events into them
        // (at-most-one per session, first-response-wins, TOCTOU). A ticket has
        // no timer: it waits until it is answered or its session ends.
        let rendezvous = Arc::new(PermissionRendezvous::new(Arc::clone(&acp)));
        ws_relay.set_rendezvous(rendezvous);
        let question_rendezvous = Arc::new(QuestionRendezvous::new(Arc::clone(&acp)));
        ws_relay.set_question_rendezvous(question_rendezvous);
        // The host's ONE project registry, durable at the resolved projects
        // file. `cfg.projects_file` is resolved by `ServerConfig::from_args`
        // from --projects-file / $TERMUL_PROJECTS_FILE / the state-dir default
        // (<state dir>/projects.json), so `None` only survives when no
        // platform state dir is discoverable. A missing file is not fatal
        // (opens empty, so `/projects` returns empty and the first project
        // command creates the file); a corrupt/invalid/newer-schema file IS
        // fatal (abort startup so a misconfigured VPS is obvious). Desktop
        // shared-live never reaches here: it builds its own registry once at
        // desktop setup and calls `serve_router` directly.
        let registry = if let Some(ref projects_file) = cfg.projects_file {
            match ProjectRegistry::open_durable(projects_file, RootCheck::Strict) {
                Ok(registry) => {
                    info!(
                        "loaded {} project(s) from '{}'",
                        registry.len(),
                        projects_file.display()
                    );
                    Arc::new(registry)
                }
                Err(e) => {
                    eprintln!(
                        "termul-server: failed to load projects file '{}': {e}",
                        projects_file.display()
                    );
                    return ExitCode::from(1);
                }
            }
        } else {
            // No projects file resolved: no explicit --projects-file /
            // $TERMUL_PROJECTS_FILE AND no platform state dir discoverable.
            // The registry stays memory-only — warn loudly instead of
            // silently losing every project on restart.
            warn!(
                "termul-server: no projects file resolved (no --projects-file / \
                 $TERMUL_PROJECTS_FILE and no platform state dir); the project \
                 registry is in-memory only and projects will NOT persist \
                 across restarts"
            );
            Arc::new(ProjectRegistry::new())
        };
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
        pty.set_max_terminals_per_project(cfg.max_terminals_per_project);

        // The `/canvas/<id>/` figcraft bundle route rides the same web router,
        // same-origin; there is no separate listener to start here.
        termul_manager_lib::canvas::static_server::log_bundle_status();
        // Opt-in self-update loop (default off): enablement + channel +
        // interval resolve via `resolve_update_settings` — the
        // `server-config.json` file written by onboarding wins over the
        // legacy TERMUL_SERVER_UPDATE_* env vars, so the web wizard can
        // steer the loop even on an argv-pinned install. A bad signature
        // keeps the current binary running (verify-before-swap), so an
        // unattended server is never bricked by a failed update attempt.
        spawn_periodic_update_loop(&data_paths.state_dir);
        match serve(
            acp,
            pty,
            terminal_events,
            cwd_tracker,
            git_tracker,
            exit_code_tracker,
            ws_relay,
            registry,
            cfg,
            acp_catalog,
            acp_install,
            store,
            web_auth,
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

/// Durable plaintext-transport warning for gated public binds (AGENTS.md
/// durable-log policy): the web auth bearer token — and every HTTP/WebSocket
/// frame — crosses the network unencrypted, so any on-path observer can read
/// it. Recommends a TLS-terminating HTTPS reverse proxy. Carries NO secret —
/// safe for journald/nohup logs.
fn warn_plaintext_transport() {
    warn!(
        "termul-server: PLAINTEXT transport — HTTP/WebSocket bearer traffic, including the \
         web auth token, is readable by network observers on this public bind. For \
         non-loopback exposure, place the server behind an HTTPS reverse proxy that \
         terminates TLS."
    );
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

/// Read the persisted `<state dir>/web-auth-token` for the setup-mode apply
/// reply. `resolve` already generated + validated (or configured) it this
/// boot; a read failure is non-fatal — the reply just omits `webAuthToken`.
/// NEVER log the contents.
fn persisted_web_auth_token(state_dir: &Path) -> Option<String> {
    use termul_manager_lib::web::auth::{WebAuthToken, WEB_AUTH_TOKEN_FILE};
    let path = state_dir.join(WEB_AUTH_TOKEN_FILE);
    match std::fs::read_to_string(&path) {
        Ok(contents) => WebAuthToken::new(&contents).map(|token| token.as_str().to_string()),
        Err(error) => {
            warn!(
                "termul-server: could not re-read the web auth token file for the \
                 setup apply reply: {error}"
            );
            None
        }
    }
}

/// gh-1105 setup mode: no completed `server-config.json`. Mint the one-time
/// setup token, print the full bootstrap URL to stdout AND tracing (it is
/// the only credential hand-off a headless install gets — spec Decision 1,
/// the one token the spec permits to print), then serve ONLY the setup
/// router (`web::setup`) until the operator finishes the wizard or the
/// process exits. The apply route schedules a `restart_binary` re-exec
/// back through `main`, which then boots the normal stack.
fn run_setup_mode(
    cfg: &ServerConfig,
    resolved_gate_token: Option<String>,
    state_dir: &Path,
) -> ExitCode {
    // A present-but-corrupt config file lands here too —
    // `ServerConfig::setup_required` already error-logged it durably, so a
    // single boundary info! suffices either way.
    info!("termul-server: no usable server config — entering setup mode");
    let setup_token = match server_config_file::generate_setup_token() {
        Ok(token) => token,
        Err(e) => {
            error!("termul-server: {e}");
            eprintln!("termul-server: {e}");
            return ExitCode::from(1);
        }
    };
    // Spec Decision 2: the unconfigured default bind is 0.0.0.0 (setup
    // routes are token-gated) so the page is reachable off-box; an explicit
    // --host keeps the operator's choice.
    let bind_mode = if cfg.host_explicit {
        cfg.bind_mode().unwrap_or(BindMode::All)
    } else {
        BindMode::All
    };
    let bind_addr = bind_mode.bind_addr(cfg.port);
    let setup_url = format!(
        "http://{}:{}/?setup={setup_token}",
        bind_mode.display_host(),
        cfg.port
    );
    // `0.0.0.0` binds every interface but is not a browsable destination —
    // tell the operator to substitute the machine's reachable hostname/IP.
    let host_hint = if bind_mode == BindMode::All {
        "\n    (replace 0.0.0.0 with this machine's hostname or IP address)"
    } else {
        ""
    };
    println!(
        "termul-server: setup required — no completed server config.\n\
         Open this one-time URL to configure the server (valid for this boot only):\n\
         \n    {setup_url}{host_hint}\n"
    );
    info!("termul-server: setup mode — configure the server at {setup_url}");

    let state = setup::SetupState::new(
        setup_token,
        state_dir.to_path_buf(),
        // The wizard's sessions/projects defaults come from the RESOLVED
        // config (honors `--state-dir`), never `dirs` — a `--state-dir`
        // install must pre-fill paths under its own state dir.
        cfg.sessions_dir
            .clone()
            .unwrap_or_else(|| state_dir.join("sessions")),
        cfg.projects_file
            .clone()
            .unwrap_or_else(|| state_dir.join("projects.json")),
        resolved_gate_token,
        cfg.web_auth_token.is_some(),
    );
    let allowed_origins = cfg.allowed_origins.clone();

    let runtime = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("failed to start tokio runtime: {e}");
            return ExitCode::from(1);
        }
    };
    match runtime.block_on(setup::serve(state, bind_addr, allowed_origins)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            error!("termul-server: setup-mode server failed: {e}");
            eprintln!("termul-server setup mode failed: {e}");
            ExitCode::from(1)
        }
    }
}

/// Build the self-update options from env + the embedded pubkey. `Err` when
/// self-update is unavailable (no pubkey baked in) — the caller logs + skips.
///
/// `default_channel`: when `TERMUL_SERVER_UPDATE_CHANNEL` is unset/invalid,
/// `Some(c)` falls back to `c` (the operator-explicit `--check-update`
/// one-shot defaults to Stable), while `None` surfaces an error. The
/// periodic loop does NOT go through this — its channel comes from
/// `resolve_update_settings` (file-wins) and reaches
/// [`update_options_for_channel`] directly.
fn build_update_options(default_channel: Option<UpdateChannel>) -> Result<UpdateOptions, String> {
    let channel =
        UpdateChannel::parse(&std::env::var("TERMUL_SERVER_UPDATE_CHANNEL").unwrap_or_default())
            .or(default_channel);
    let channel = match channel {
        Some(c) => c,
        None => {
            return Err(
                "TERMUL_SERVER_UPDATE_CHANNEL is unset or not stable/insider/nightly".to_owned(),
            )
        }
    };
    update_options_for_channel(channel)
}

/// Shared tail of [`build_update_options`]: build `UpdateOptions` for an
/// already-resolved channel. The periodic loop's channel comes from
/// `resolve_update_settings` (config file wins over env); the `--check-update`
/// one-shot's channel comes from env-or-Stable — each caller resolves its
/// own precedence, so the env is never re-parsed here.
///
/// `embedded_public_key()` returns `Result<&'static PublicKey>` backed by a
/// `OnceLock`; the `&'static` ref moves into `UpdateOptions` (and across the
/// spawned periodic task) directly — no clone needed.
fn update_options_for_channel(channel: UpdateChannel) -> Result<UpdateOptions, String> {
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
        Ok(UpdateOutcome::Updated {
            new_version,
            old_path,
        }) => {
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
/// Enablement, channel, and interval come from
/// `server_config_file::resolve_update_settings(state_dir)` — once
/// `server-config.json` exists (web onboarding or `termul-server onboard`),
/// the file is authoritative; otherwise the legacy
/// `TERMUL_SERVER_UPDATE_ENABLED`/`_CHANNEL`/`_INTERVAL_SECS` env vars apply.
/// No-op (with an info log) when the resolved settings are disabled — the
/// default stays off so an unattended server never auto-updates.
fn spawn_periodic_update_loop(state_dir: &Path) {
    let settings = server_config_file::resolve_update_settings(state_dir);
    if !settings.enabled {
        info!(
            target: "termul::server_update",
            "self-update disabled (no update channel in server-config.json; or set \
             TERMUL_SERVER_UPDATE_ENABLED=true + TERMUL_SERVER_UPDATE_CHANNEL to opt in)"
        );
        return;
    }
    let Some(channel) = settings.channel else {
        warn!(
            target: "termul::server_update",
            "self-update enabled without a channel — periodic loop disabled"
        );
        return;
    };

    // Periodic loop: the resolved settings already named a channel (file or
    // env) — an unattended server never auto-updates without one.
    let opts = match update_options_for_channel(channel) {
        Ok(o) => o,
        Err(reason) => {
            warn!(
                target: "termul::server_update",
                "self-update enabled but unavailable: {reason} (periodic loop disabled)"
            );
            return;
        }
    };

    // Resolved interval (file: the wizard's choice; env: the legacy var; else
    // 6h, mirroring the desktop's periodic cadence).
    let interval_secs = settings.interval_secs;

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
                Ok(UpdateOutcome::Updated {
                    new_version,
                    old_path,
                }) => {
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
    termul-server onboard          Guided setup + background launch
    termul-server --check-update   One-shot self-update

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
                                  [default: $TERMUL_SESSIONS_DIR, else
                                  <--state-dir>/sessions when --state-dir
                                  is set, else the platform state dir]
    --project-root <PATH>         REMOVED (still parsed, with a startup
                                  warning). There is no single host project
                                  root: the boundary is "inside any registered
                                  project". The value only seeds one project
                                  while the registry is empty. Must exist and
                                  be a directory. [default: none]
    --projects-file <PATH>        VFS-roots registry file. A missing file loads
                                  as an empty registry (not fatal); a corrupt
                                  file is fatal. With no state dir
                                  discoverable, the registry is in-memory only.
                                  [default: $TERMUL_PROJECTS_FILE, else
                                  <--state-dir>/projects.json when
                                  --state-dir is set, else the platform
                                  state dir]
    --acp-catalog-dir <PATH>      ACP catalog root.
                                  [default: <state dir>/acp-catalog]
    --store-file <PATH>           Server-side key-value store for the web client
                                  (terminal layout, settings, editor state,
                                  command history, SSH profiles, ...).
                                  [default: $TERMUL_STORE_FILE or
                                  <state dir>/store.json]
    --state-dir <PATH>            Service-account state dir override. Wins over
                                  $XDG_STATE_HOME/$HOME (%LOCALAPPDATA% on
                                  Windows) for the state dir itself and, when
                                  --sessions-dir / --projects-file are omitted,
                                  for sessions and projects.json too. Explicit
                                  --sessions-dir, --projects-file,
                                  $TERMUL_SESSIONS_DIR, and $TERMUL_PROJECTS_FILE
                                  still win. The onboard wizard passes this so
                                  the background-launched server uses the exact
                                  state dir it printed (web auth token, store,
                                  workspace manifests, ACP catalog) while also
                                  pinning sessions and projects with their flags.
                                  [default: <state dir> resolution below]

  Tuning:
    --event-log-capacity <N>      Per-session event-log ring capacity.
                                  [default: 4096]
    --agent-idle-window-secs <SECS>
                                  Idle window after which an idle agent is
                                  reaped. Positive integer.
                                  [env: TERMUL_AGENT_IDLE_REAP_SECS]
                                  [default: 1800]
    --max-terminals-per-project <N>
                                  Most live terminals one project may have.
                                  The host refuses a spawn past it with
                                  TERMINAL_LIMIT; the host-wide cap is 30.
                                  Positive integer.
                                  [env: TERMUL_MAX_TERMINALS_PER_PROJECT]
                                  [default: 10]
    --overflow-tolerance <N>      Reliable-queue overflow tolerance per client.
                                  Positive integer. Reserved: the host
                                  validates it but does not read it yet.
                                  [default: 15]
    --receipt-retention-secs <SECS>
                                  How long the command ledger keeps a
                                  command's outcome, so a resend after a lost
                                  reply gets the original answer (bare command
                                  ids are kept six times as long). Positive
                                  integer; values above 604800 (7 days) are
                                  clamped.
                                  [default: 600]
    --partition-gc-age-secs <SECS>
                                  Age after which the web store partition of
                                  a device that has not connected (and is not
                                  connected now) is garbage collected.
                                  Positive integer.
                                  [env: TERMUL_PARTITION_GC_AGE_SECS]
                                  [default: 7776000]
    --partition-byte-budget <BYTES>
                                  Per-device web store partition byte budget;
                                  a write past it is refused
                                  (STORE_PARTITION_FULL). Positive integer.
                                  [env: TERMUL_PARTITION_BYTE_BUDGET]
                                  [default: 16777216]
    --permission-timeout <SECS>, --permission-reconnect-grace <SECS>,
    --workspace-manifests-dir <PATH>
                                  Removed. Still accepted so existing launch
                                  commands keep starting, but ignored (a
                                  warning is logged at startup).

  Security & updates:
    --allow-remote-writes         Admit non-loopback peers on all guarded write
                                  routes. /fs/* writes reject only .. traversal
                                  (ADR-007 breadth, any path); /git/* and
                                  /worktree/* writes confined to registered projects;
                                  AND host-state writes (/projects/default,
                                  /acp/install, /log/frontend-error).
                                  Loopback callers keep ADR-007
                                  breadth (any path). No-op when bound to
                                  127.0.0.1. The web auth token gate still
                                  applies (see --web-auth-token). Only enable
                                  on a trusted network.
                                  [env: TERMUL_SERVER_ALLOW_REMOTE_WRITES=true|1]
    --web-auth-token <TOKEN>    Require this bearer token on the /ws
                                  authenticate handshake, /terminal/ws, and
                                  every HTTP API route (/health, both WS
                                  endpoints, /oauth/callback, and static/SPA
                                  assets stay open). On a public bind
                                  (--host 0.0.0.0) with no configured token,
                                  one is generated and persisted to
                                  <state dir>/web-auth-token (owner-only:
                                  mode 0600 on Unix; the token is never
                                  printed or logged — read it from the file);
                                  startup aborts before binding if no token
                                  can be resolved or persisted (fail closed).
                                  Loopback binds stay ungated unless a token
                                  is configured. NOTE: a flag value is visible
                                  to local users via the process list — prefer
                                  TERMUL_WEB_AUTH_TOKEN or the token file.
                                  [env: TERMUL_WEB_AUTH_TOKEN]
    --allowed-origins <ORIGINS>   Extra http(s) origins for a reverse proxy
                                  whose public origin does not match Host.
                                  Comma-separated. Repeatable. Replaces
                                  TERMUL_ALLOWED_ORIGINS when both are set.
                                  [env: TERMUL_ALLOWED_ORIGINS]
    --check-update                Run one opt-in self-update now: fetch the channel
                                  manifest, verify the downloaded binary signature,
                                  and atomically swap. Does NOT auto-reexec —
                                  restart the server to run the new version (the
                                  .old binary is retained for rollback). Defaults
                                  to the stable channel when
                                  TERMUL_SERVER_UPDATE_CHANNEL is unset; the env
                                  wins when set. A locally-built binary without a
                                  baked-in pubkey reports self-update unavailable.

  Commands:
    onboard                       Guided interactive setup + background launch.
                                  Auto-detects the service manager (systemd unit
                                  or setsid detach) so the server survives SSH
                                  logout. Non-TTY stdin prints the resolved
                                  default command + mechanism tip and exits 0
                                  without launching.

    -h, --help                    Show this help

ENVIRONMENT:
    <state dir>                   Unix: $XDG_STATE_HOME/termul or
                                  $HOME/.local/state/termul
                                  Windows: %LOCALAPPDATA%\Termul
                                  Fallback: <tmp>/termul
    RUST_LOG                      tracing filter (floor: info). Try
                                  RUST_LOG=termul_manager_lib=debug
    TERMUL_PROJECT_ROOT           Removed fallback for --project-root (seed only)
    TERMUL_PROJECTS_FILE          Fallback for --projects-file
    TERMUL_SESSIONS_DIR           Fallback for --sessions-dir
    TERMUL_STORE_FILE             Fallback for --store-file
    TERMUL_SERVER_ALLOW_REMOTE_WRITES  true|1 enables --allow-remote-writes
    TERMUL_WEB_AUTH_TOKEN         Fallback for --web-auth-token
    TERMUL_ALLOWED_ORIGINS        Fallback for --allowed-origins (comma-separated)
    TERMUL_SERVER_UPDATE_ENABLED  true gates the periodic self-update loop
    TERMUL_SERVER_UPDATE_CHANNEL  stable|insider|nightly (required for periodic loop)
    TERMUL_SERVER_UPDATE_INTERVAL_SECS  periodic loop interval [default: 21600]

EXAMPLES:
    # Local: serve the embedded web client on loopback
    termul-server

    # LAN: expose to phone browsers on the trusted network
    termul-server --host 0.0.0.0 --port 8080

    # LAN with remote writes (trusted network only)
    termul-server --host 0.0.0.0 --allow-remote-writes

    # Background with debug logging
    RUST_LOG=termul_manager_lib=debug termul-server --host 0.0.0.0 \
        > /tmp/termul-server.log 2>&1 &

    # Guided setup (auto-detects systemd or setsid, survives SSH logout)
    termul-server onboard

    # One-shot self-update check
    termul-server --check-update
"#
}
