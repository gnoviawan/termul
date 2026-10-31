//! Axum router for the ACP web server (standalone `termul-server` + desktop).
//!
//! Exposes `/health`, the live WS upgrade at `/ws`, and static serving of the
//! web client: from disk `ServeDir` in dev (`dist-web/` on disk) or the
//! embedded `rust-embed` bundle in release. The `/ws` route is registered
//! explicitly AHEAD of the static fallback so it is not shadowed by the static
//! mount (AC1).

use std::path::Path;
use std::sync::Arc;

use axum::{
    middleware,
    routing::{get, post, put},
    Router,
};

use crate::web::acp_api;
use crate::web::auth::WebAuth;

use crate::acp::{AcpCatalogService, AcpInstallService, AcpManager};

use crate::pty::PtyManager;
use crate::trackers::{CwdTracker, ExitCodeTracker, GitTracker, TerminalEventHub};
use crate::web::catalog_api;
use crate::web::mcp_catalog_api;
use crate::web::connection_runtime::ConnectionRuntime;
use crate::web::diagnostics_api;
use crate::web::fs_api;
use crate::web::git_api;
use crate::web::git_diff_stat_api;
use crate::web::git_history_api;
use crate::web::git_hunk_api;
use crate::web::install_api;
use crate::web::log_api;
use crate::web::mcp_oauth_api;
use crate::web::mcp_probe_api;
use crate::web::mcp_servers_api;
use crate::web::host_allow::{self, HostAllowList};
use crate::web::origin::{self, OriginPolicy};
use crate::web::project_icon_api;
use crate::web::project_registry::ProjectRegistry;
use crate::web::projects_api;
use crate::web::route_deadline;
use crate::web::search_api;
use crate::web::sink::WsRelaySink;
use crate::web::skills_api;
use crate::web::store::WebStore;
use crate::web::terminal_ws::terminal_ws_upgrade;
use crate::web::worktree_api;
use crate::web::worktree_rename_api;
use crate::web::ws::{ws_upgrade, AppState, HistoryMode};

use super::assets;

mod gate;
mod host_routes;

use gate::maybe_gate_api;
use host_routes::{agent_idle_window, health_check, set_agent_idle_window};

/// The desktop host pieces a local (in-process) relay connection needs: what
/// `lib.rs` already built for the Tauri app, shared with every carrier.
pub struct DesktopLocalParts {
    pub acp: Arc<AcpManager>,
    pub pty: Arc<PtyManager>,
    pub relay: Arc<WsRelaySink>,
    pub registry: Arc<ProjectRegistry>,
    pub acp_catalog: Option<Arc<AcpCatalogService>>,
    pub acp_install: Option<Arc<AcpInstallService>>,
    pub store: Arc<WebStore>,
}

impl AppState {
    /// The state behind the desktop's own Tauri `ipc::Channel` carrier.
    ///
    /// Unlike the shared-live host (token gate, every write denied because a
    /// tunnel forwards public traffic from loopback), the caller here is the
    /// app's own webview across the process boundary: no token gate
    /// (`web_auth: None`), writes allowed for the loopback peer
    /// (`shared_live_writes_denied: false`, `allow_remote_writes: false`).
    /// Never serve this state from a network listener. It owns a fresh
    /// [`ConnectionRuntime`] so the exit path can drain its connections.
    #[must_use]
    pub fn desktop_local(parts: DesktopLocalParts) -> Self {
        let history_mode = if parts.relay.persistence().is_some() {
            HistoryMode::Server
        } else {
            HistoryMode::LiveOnly
        };
        Self {
            terminal_events: parts.pty.terminal_events(),
            cwd_tracker: parts.pty.cwd_tracker(),
            git_tracker: parts.pty.git_tracker(),
            exit_code_tracker: parts.pty.exit_code_tracker(),
            acp: parts.acp,
            pty: parts.pty,
            relay: parts.relay,
            registry: parts.registry,
            history_mode,
            acp_catalog: parts.acp_catalog,
            acp_install: parts.acp_install,
            store: Some(parts.store),
            allow_remote_writes: false,
            shared_live_writes_denied: false,
            pending_oauth_flows: Arc::new(parking_lot::RwLock::new(
                std::collections::HashMap::new(),
            )),
            oauth_base_url: "http://127.0.0.1".to_string(),
            web_auth: None,
            connections: ConnectionRuntime::default(),
        }
    }
}

/// Build the ACP web-server Axum router (serves the web client + WS + health).
///
/// `ws_relay` is threaded into the router state so `/ws` can subscribe clients
/// and replay cursors (Story 1.4). The `/ws` + `/health` routes are registered
/// BEFORE the static fallback so the static mount cannot shadow them (AC1).
///
/// The containment boundary for the OPERATION routes (`/git/*`, `/worktree/*`,
/// `/skills`, `/search/*`, canvas open) is the project registry — enforced by
/// [`git_api::ensure_within_project_boundary`] (a path inside ANY registered,
/// non-archived project; rejects with `OUTSIDE_PROJECT_ROOT`). The `/fs/*`
/// browse/read routes (`ls`/`browse`/`read`) are intentionally broader — no
/// boundary check — for desktop parity, the directory picker, and editor
/// reads; `/fs/*` writes (`mkdir`/`write`/`delete`/`rename`/`copy`) and
/// `/fs/info` are loopback-guarded (`check_local_only`, `FORBIDDEN`). A
/// non-loopback peer admitted by `--allow-remote-writes` is confined to the
/// registered project roots for the writes only; `/fs/info` stays unconfined
/// like the other `/fs` reads. See ADR-007 for the recorded policy.
///
/// The static fallback serves from disk `ServeDir` in dev (`dist-web/` on disk)
/// or from the embedded `Assets` bundle in release — see
/// [`assets::static_fallback`].
///
/// `web_auth` is the web auth gate (CAP-1 interim, QA remediation Story 1).
/// `Some` requires the token (`Authorization: Bearer` header) on every gated API
/// route via the [`web_auth_gate`] middleware and stores it in [`AppState`]
/// for `/ws` + `/terminal/ws`. `None` = ungated (legacy behavior).
///
/// The `/canvas/*` routes serve the figcraft bundle same-origin. The API
/// routes are bearer-gated like the other prefixes; `/canvas/<id>/*` carries
/// the canvas session token instead (see `web::canvas_api`).
///
/// `connections` is the host's [`ConnectionRuntime`]: the shutdown handle every
/// upgraded `/ws` + `/terminal/ws` socket joins, and the outbound overflow
/// tolerance (AD-19).
///
/// `host_allow` names the `Host` values this listener serves beyond IP
/// literals and `localhost`; it is checked before anything else.
#[allow(clippy::too_many_arguments)]
pub fn router(
    acp: Arc<AcpManager>,
    pty: Arc<PtyManager>,
    terminal_events: TerminalEventHub,
    cwd_tracker: Arc<CwdTracker>,
    git_tracker: Arc<GitTracker>,
    exit_code_tracker: Arc<ExitCodeTracker>,
    ws_relay: Arc<WsRelaySink>,
    registry: Arc<ProjectRegistry>,
    history_mode: HistoryMode,
    acp_catalog: Option<Arc<AcpCatalogService>>,
    acp_install: Option<Arc<AcpInstallService>>,
    store: Option<Arc<WebStore>>,
    allow_remote_writes: bool,
    shared_live_writes_denied: bool,
    oauth_base_url: String,
    web_auth: Option<Arc<WebAuth>>,
    allowed_origins: OriginPolicy,
    host_allow: HostAllowList,
    connections: ConnectionRuntime,
) -> Router {
    let r = Router::new()
        .route("/health", get(health_check))
        .route(
            "/host/agent-idle-window",
            get(agent_idle_window).post(set_agent_idle_window),
        )
        .route("/ws", get(ws_upgrade))
        .route("/terminal/ws", get(terminal_ws_upgrade))
        // The host's project registry: the web client reads the non-archived +
        // archived projects here and adds one with `POST`. Registered AHEAD of
        // the static fallback so the SPA mount cannot shadow it.
        .route(
            "/projects",
            get(projects_api::list).post(projects_api::create_project),
        )
        // Explicit host-default change (Epic 7 — cross-client workspace
        // continuity). Mirrors the `set_default_project` WS request.
        .route("/projects/default", post(projects_api::set_default_project))
        // Project mutations through the shared command service.
        // `PUT /projects/{id}` patches display fields and archives/restores
        // (`isArchived`); `DELETE /projects/{id}` removes the project. Both
        // refuse `PROJECT_BUSY` while sessions/terminals are bound unless
        // `cascade` is set. Mirrors the `update_project`/`remove_project` WS
        // requests.
        .route(
            "/projects/{projectId}",
            put(projects_api::update_project).delete(projects_api::remove_project),
        )
        .route(
            "/mcp-servers",
            get(mcp_servers_api::get).put(mcp_servers_api::put),
        )
        // On-demand MCP client probe (web parity): runs on the termul-server
        // host where stdio commands execute. Mirrors the `acp_probe_mcp_server`
        // Tauri command; returns the same `IpcBody<ProbeResult>` shape.
        .route("/mcp-servers/probe", post(mcp_probe_api::probe))
        // MCP OAuth (web parity): start flow, check status, disconnect.
        // Registered AHEAD of the static fallback so the SPA mount cannot
        // shadow them.
        .route("/mcp-servers/oauth/start", post(mcp_oauth_api::oauth_start))
        .route(
            "/mcp-servers/oauth/status",
            post(mcp_oauth_api::oauth_status),
        )
        .route(
            "/mcp-servers/oauth/disconnect",
            post(mcp_oauth_api::oauth_disconnect),
        )
        // The OAuth callback redirect target (GET — the AS redirects here).
        .route("/oauth/callback", get(mcp_oauth_api::oauth_callback))
        // Project-creation fs/git/shell routes (Story: Web/remote project
        // creation). Registered AHEAD of the static fallback so `/health` +
        // `/ws` keep priority and the SPA fallback cannot shadow them.
        .route("/fs/mkdir", post(fs_api::mkdir))
        .route("/fs/write", post(fs_api::write))
        .route("/fs/ls", get(fs_api::ls))
        .route("/fs/browse", get(fs_api::browse))
        .route("/fs/read", get(fs_api::read))
        .route("/fs/raw", get(fs_api::raw))
        .route("/fs/info", get(fs_api::info))
        .route("/fs/delete", post(fs_api::delete))
        .route("/fs/rename", post(fs_api::rename))
        .route("/fs/copy", post(fs_api::copy))
        .route("/git/init", post(fs_api::git_init))
        // Git web routes (CAP-1: Web & Mobile 1:1 Parity). Each mirrors a
        // desktop `#[tauri::command] git_*` handler; see `web/git_api.rs`.
        // Registered AHEAD of the static fallback so the SPA mount cannot
        // shadow them. Write routes are loopback-guarded inside the handler.
        .route("/git/status", post(git_api::get_status))
        .route("/git/diff", post(git_api::get_diff))
        .route("/git/stage", post(git_api::stage))
        .route("/git/unstage", post(git_api::unstage))
        .route("/git/stage-hunk", post(git_hunk_api::stage_hunk))
        .route("/git/unstage-hunk", post(git_hunk_api::unstage_hunk))
        .route("/git/discard", post(git_api::discard))
        .route("/git/log", post(git_api::get_log))
        .route(
            "/git/commit-detail",
            post(git_history_api::get_commit_detail),
        )
        .route(
            "/git/commit-file-diff",
            post(git_history_api::get_commit_file_diff),
        )
        .route("/git/commit", post(git_api::commit))
        .route("/git/push", post(git_api::push))
        .route("/git/commit-context", post(git_api::get_commit_context))
        .route("/git/checkout-branch", post(git_api::checkout_branch))
        .route("/git/create-branch", post(git_api::create_branch))
        .route("/git/stash-save", post(git_api::stash_save))
        .route("/git/stash-list", get(git_api::stash_list))
        .route("/git/stash-apply", post(git_api::stash_apply))
        .route("/git/stash-pop", post(git_api::stash_pop))
        .route("/git/stash-drop", post(git_api::stash_drop))
        .route("/git/branch-list", get(git_api::branch_list))
        .route("/git/branch-switch", post(git_api::branch_switch))
        .route("/git/diff-stat", post(git_diff_stat_api::get_diff_stat))
        // Project icon resolution (spec-project-icon). Mirrors the desktop
        // `project_icon_resolve` command — same shared resolver, read-route
        // posture (boundary check, no write guard).
        .route("/project/icon", post(project_icon_api::resolve_icon))
        // Search web routes (CAP-2: Web & Mobile 1:1 Parity). Each mirrors a
        // desktop `#[tauri::command] search_*` handler; see `web/search_api.rs`.
        .route("/search/rg-info", get(search_api::rg_info))
        .route("/search/content", post(search_api::content))
        .route("/search/file-names", get(search_api::file_names))
        .route("/search/cancel", post(search_api::cancel))
        // Skills web routes (CAP-2): `GET /skills`, `GET /skills/:name`, and
        // `GET /skills-index` (SKILL.md paths for clickable chat chips).
        .route("/skills", get(skills_api::list))
        .route("/skills/{name}", get(skills_api::read))
        .route("/skills-index", get(skills_api::files))
        // Frontend error forwarding (CAP-2): `POST /log/frontend-error`.
        .route("/log/frontend-error", log_api::route())
        // Bug-report diagnostics + host-side `gh` submit
        // (spec-bug-report-dialog). Mirrors the
        // `collect_bug_report_context` / `submit_bug_report` commands; both
        // are guarded mutations (`check_local_only` in the handlers).
        .route("/log/diagnostics", diagnostics_api::diagnostics_route())
        .route("/log/report-bug", diagnostics_api::report_bug_route())
        .route("/shells", get(fs_api::shells))
        // ACP catalog web routes (CAP-6: Web & Mobile 1:1 Parity). Each
        // mirrors a desktop `#[tauri::command] acp_*_catalog` handler; see
        // `web/catalog_api.rs`. Registered AHEAD of the static fallback so
        // the SPA mount cannot shadow them. The read `GET` is open (read-only
        // host introspection, mirrors `GET /projects`); the `POST` opt-in
        // mirrors `set_default_project` posture (any connected client until
        // Epic 2).
        .route("/acp/catalog", get(catalog_api::list))
        .route(
            "/acp/factory-key",
            get(acp_api::factory_key_status).post(acp_api::factory_key_save),
        )
        .route("/acp/catalog/opt-in", post(catalog_api::set_opt_in))
        // MCP catalog search (spine AD-1), a read open to every connected
        // client; see `web/mcp_catalog_api.rs`.
        .route("/mcp-catalog/search", get(mcp_catalog_api::search))
        .route("/mcp-catalog/install/form", mcp_catalog_api::install_route(mcp_catalog_api::describe_install))
        .route("/mcp-catalog/install/plan", mcp_catalog_api::install_route(mcp_catalog_api::plan_install))
        .route("/mcp-catalog/install/commit", mcp_catalog_api::install_route(mcp_catalog_api::commit_install))
        .route("/mcp-catalog/install/cancel", mcp_catalog_api::install_route(mcp_catalog_api::cancel_install))
        .route("/mcp-catalog/status", get(mcp_catalog_api::status))
        .route("/mcp-catalog/sync", post(mcp_catalog_api::set_sync))
        // ACP install web route (CAP-6 / Story 9: verified-atomic install).
        // Mirrors the desktop `#[tauri::command] acp_install_agent` handler;
        // see `web/install_api.rs`. Registered AHEAD of the static fallback so
        // the SPA mount cannot shadow it. The request is `{ agentId }` only;
        // the host resolves everything from the trusted catalog.
        .route("/acp/install", post(install_api::install))
        // Worktree web routes (CAP — Web worktree parity). Each mirrors a
        // desktop `#[tauri::command] worktree_*` handler; see
        // `web/worktree_api.rs`. Registered AHEAD of the static fallback so the
        // SPA mount cannot shadow them.
        .route("/worktree/list", post(worktree_api::list))
        .route("/worktree/create", post(worktree_api::create))
        .route("/worktree/remove", post(worktree_api::remove))
        .route("/worktree/branches", get(worktree_api::branches))
        .route("/worktree/check-dirty", get(worktree_api::check_dirty))
        .route(
            "/worktree/resolve-base-branch",
            post(worktree_api::resolve_base_branch),
        )
        .route(
            "/worktree/copy-include-files",
            post(worktree_api::copy_include_files),
        )
        .route(
            "/worktree/rename-branch",
            post(worktree_rename_api::rename_branch),
        )
        .route(
            "/worktree/parse-gitignore",
            post(worktree_api::parse_gitignore),
        )
        .route(
            "/worktree/create-symlinks",
            post(worktree_api::create_symlinks),
        )
        .route(
            "/worktree/ensure-symlinks",
            post(worktree_api::ensure_symlinks),
        );
    let mut r = r
        .merge(crate::web::browser_policy_api::browser_policy_router(
            crate::web::browser_policy_api::PolicyRouteState {
                service: crate::acp::browser_policy::installed(),
                token_gated: web_auth.is_some(),
                write_flags: crate::web::capabilities::WriteFlags {
                    allow_remote_writes,
                    shared_live_writes_denied,
                },
            },
        ))
        .merge(crate::web::automation_api::automation_router(
            crate::web::automation_api::AutomationRouteState {
                service: crate::automation::service::installed(),
                token_gated: web_auth.is_some(),
                write_flags: crate::web::capabilities::WriteFlags {
                    allow_remote_writes,
                    shared_live_writes_denied,
                },
            },
        ))
        // Canvas web routes: open/close/persistence (IpcBody) and the
        // same-origin /canvas/<id>/* bundle. Merged BEFORE the static fallback
        // so the SPA mount cannot shadow them. The API routes are bearer-gated
        // via GATED_PREFIXES ("/canvas/"); /canvas/<id>/* is exempt
        // (is_bundle_path) and authenticated by the canvas session token
        // instead (browser iframes cannot send Authorization headers). The
        // boundary validates web-opened doc paths against the same project
        // registry the fs/git routes use.
        .merge(crate::web::canvas_api::canvas_router(
            crate::web::canvas_api::CanvasState {
                boundary: Some(crate::web::canvas_api::CanvasProjectBoundary {
                    registry: registry.clone(),
                }),
                write_flags: crate::web::capabilities::WriteFlags {
                    allow_remote_writes,
                    shared_live_writes_denied,
                },
            },
        ));
    // Static fallback: disk ServeDir in dev (dist-web/ on disk) or the embedded
    // bundle in release. `/health` + `/ws` are registered above so the static
    // mount cannot shadow them (Story 1.3 AC1).
    if assets::dist_web_ready() {
        r = r.fallback_service(assets::static_service());
    } else {
        r = r.fallback(assets::serve_embedded);
    }
    // PWA: the disk ServeDir sets no Cache-Control, so shell/PWA files would
    // fall under heuristic caching and stall service-worker updates. The
    // layer marks them `no-cache, must-revalidate`; on the embedded path it
    // writes the same value the embed already sets (idempotent).
    r = r.layer(middleware::from_fn(assets::shell_no_cache_headers));
    r = r.layer(middleware::from_fn(route_deadline::bound));
    // #857: gzip responses when `Accept-Encoding` allows (cold load 3.66 MB →
    // ~1 MB) + pin Vite-hashed `/assets/*` immutable for a year on the disk
    // `ServeDir` path (the embedded path already sets the same value in
    // `embedded_response`).
    r = r
        .layer(middleware::from_fn(assets::immutable_asset_cache_headers))
        .layer(assets::static_compression_layer());

    let state = AppState {
        acp,
        pty,
        terminal_events,
        cwd_tracker,
        git_tracker,
        exit_code_tracker,
        relay: ws_relay,
        registry,
        history_mode,
        acp_catalog,
        acp_install,
        store,
        allow_remote_writes,
        shared_live_writes_denied,
        pending_oauth_flows: std::sync::Arc::new(parking_lot::RwLock::new(
            std::collections::HashMap::new(),
        )),
        oauth_base_url,
        web_auth,
        connections,
    };
    // Origin check is the outer layer so `/ws` and `/terminal/ws` (public to
    // the token gate; they authenticate after the upgrade) are covered, and
    // a rejected origin does not reach a handler. Token checks still run
    // for every request this layer allows.
    host_allow::layer(
        origin::layer(maybe_gate_api(state.web_auth.clone(), r), allowed_origins),
        host_allow,
    )
    .with_state(state)
}

/// Same as [`router`], but with an injectable static-root for unit tests.
#[allow(clippy::too_many_arguments)]
pub fn router_with_static(
    acp: Arc<AcpManager>,
    pty: Arc<PtyManager>,
    ws_relay: Arc<WsRelaySink>,
    registry: Arc<ProjectRegistry>,
    static_dir: &Path,
    allow_remote_writes: bool,
    shared_live_writes_denied: bool,
    web_auth: Option<Arc<WebAuth>>,
    allowed_origins: OriginPolicy,
) -> Router {
    let r = Router::new()
        .route("/health", get(health_check))
        .route(
            "/host/agent-idle-window",
            get(agent_idle_window).post(set_agent_idle_window),
        )
        .route("/ws", get(ws_upgrade))
        .route("/terminal/ws", get(terminal_ws_upgrade))
        .route("/projects", get(projects_api::list))
        .route("/projects/default", post(projects_api::set_default_project))
        .route(
            "/mcp-servers",
            get(mcp_servers_api::get).put(mcp_servers_api::put),
        )
        .route("/mcp-servers/probe", post(mcp_probe_api::probe))
        .route("/fs/mkdir", post(fs_api::mkdir))
        .route("/fs/write", post(fs_api::write))
        .route("/fs/ls", get(fs_api::ls))
        .route("/fs/browse", get(fs_api::browse))
        .route("/fs/read", get(fs_api::read))
        .route("/fs/raw", get(fs_api::raw))
        .route("/fs/info", get(fs_api::info))
        .route("/fs/delete", post(fs_api::delete))
        .route("/fs/rename", post(fs_api::rename))
        .route("/fs/copy", post(fs_api::copy))
        .route("/git/init", post(fs_api::git_init))
        .route("/git/status", post(git_api::get_status))
        .route("/git/diff", post(git_api::get_diff))
        .route("/git/stage", post(git_api::stage))
        .route("/git/unstage", post(git_api::unstage))
        .route("/git/stage-hunk", post(git_hunk_api::stage_hunk))
        .route("/git/unstage-hunk", post(git_hunk_api::unstage_hunk))
        .route("/git/discard", post(git_api::discard))
        .route("/git/log", post(git_api::get_log))
        .route(
            "/git/commit-detail",
            post(git_history_api::get_commit_detail),
        )
        .route(
            "/git/commit-file-diff",
            post(git_history_api::get_commit_file_diff),
        )
        .route("/git/commit", post(git_api::commit))
        .route("/git/push", post(git_api::push))
        .route("/git/commit-context", post(git_api::get_commit_context))
        .route("/git/checkout-branch", post(git_api::checkout_branch))
        .route("/git/create-branch", post(git_api::create_branch))
        .route("/git/stash-save", post(git_api::stash_save))
        .route("/git/stash-list", get(git_api::stash_list))
        .route("/git/stash-apply", post(git_api::stash_apply))
        .route("/git/stash-pop", post(git_api::stash_pop))
        .route("/git/stash-drop", post(git_api::stash_drop))
        .route("/git/branch-list", get(git_api::branch_list))
        .route("/git/branch-switch", post(git_api::branch_switch))
        .route("/git/diff-stat", post(git_diff_stat_api::get_diff_stat))
        .route("/project/icon", post(project_icon_api::resolve_icon))
        .route("/search/rg-info", get(search_api::rg_info))
        .route("/search/content", post(search_api::content))
        .route("/search/file-names", get(search_api::file_names))
        .route("/search/cancel", post(search_api::cancel))
        .route("/skills", get(skills_api::list))
        .route("/skills/{name}", get(skills_api::read))
        .route("/skills-index", get(skills_api::files))
        .route("/log/frontend-error", log_api::route())
        .route("/log/diagnostics", diagnostics_api::diagnostics_route())
        .route("/log/report-bug", diagnostics_api::report_bug_route())
        .route("/shells", get(fs_api::shells))
        .route("/acp/catalog", get(catalog_api::list))
        .route("/acp/catalog/opt-in", post(catalog_api::set_opt_in))
        .route("/mcp-catalog/search", get(mcp_catalog_api::search))
        .route("/mcp-catalog/install/form", mcp_catalog_api::install_route(mcp_catalog_api::describe_install))
        .route("/mcp-catalog/install/plan", mcp_catalog_api::install_route(mcp_catalog_api::plan_install))
        .route("/mcp-catalog/install/commit", mcp_catalog_api::install_route(mcp_catalog_api::commit_install))
        .route("/mcp-catalog/install/cancel", mcp_catalog_api::install_route(mcp_catalog_api::cancel_install))
        .route("/mcp-catalog/status", get(mcp_catalog_api::status))
        .route("/mcp-catalog/sync", post(mcp_catalog_api::set_sync))
        .route("/acp/install", post(install_api::install))
        .route("/worktree/list", post(worktree_api::list))
        .route("/worktree/create", post(worktree_api::create))
        .route("/worktree/remove", post(worktree_api::remove))
        .route("/worktree/branches", get(worktree_api::branches))
        .route("/worktree/check-dirty", get(worktree_api::check_dirty))
        .route(
            "/worktree/resolve-base-branch",
            post(worktree_api::resolve_base_branch),
        )
        .route(
            "/worktree/copy-include-files",
            post(worktree_api::copy_include_files),
        )
        .route(
            "/worktree/rename-branch",
            post(worktree_rename_api::rename_branch),
        )
        .route(
            "/acp/factory-key",
            get(acp_api::factory_key_status).post(acp_api::factory_key_save),
        );
    // Canvas routes parity (test/dev variant): the boundary is wired so
    // open's doc-path validation behavior matches production.
    let r = r
        .merge(crate::web::browser_policy_api::browser_policy_router(
            crate::web::browser_policy_api::PolicyRouteState {
                service: crate::acp::browser_policy::installed(),
                token_gated: web_auth.is_some(),
                write_flags: crate::web::capabilities::WriteFlags {
                    allow_remote_writes,
                    shared_live_writes_denied,
                },
            },
        ))
        .merge(crate::web::automation_api::automation_router(
            crate::web::automation_api::AutomationRouteState {
                service: crate::automation::service::installed(),
                token_gated: web_auth.is_some(),
                write_flags: crate::web::capabilities::WriteFlags {
                    allow_remote_writes,
                    shared_live_writes_denied,
                },
            },
        ))
        .merge(crate::web::canvas_api::canvas_router(
            crate::web::canvas_api::CanvasState {
                boundary: Some(crate::web::canvas_api::CanvasProjectBoundary {
                    registry: registry.clone(),
                }),
                write_flags: crate::web::capabilities::WriteFlags {
                    allow_remote_writes,
                    shared_live_writes_denied,
                },
            },
        ))
        .fallback_service(assets::static_service_from(static_dir));
    // PWA parity with `router`: mark the unversioned shell/PWA files no-cache
    // so the disk-served bundle doesn't stall SW updates (same layer).
    let r = r.layer(middleware::from_fn(assets::shell_no_cache_headers));
    let r = r.layer(middleware::from_fn(route_deadline::bound));
    // #857 parity with `router`: gzip + immutable hashed-asset caching on the
    // disk-served static bundle.
    let r = r
        .layer(middleware::from_fn(assets::immutable_asset_cache_headers))
        .layer(assets::static_compression_layer());
    let host_allow = HostAllowList::from_origins(&allowed_origins);
    host_allow::layer(
        origin::layer(maybe_gate_api(web_auth.clone(), r), allowed_origins),
        host_allow,
    )
    .with_state({
        AppState {
            acp,
            terminal_events: pty.terminal_events(),
            cwd_tracker: pty.cwd_tracker(),
            git_tracker: pty.git_tracker(),
            exit_code_tracker: pty.exit_code_tracker(),
            pty,
            relay: ws_relay,
            registry,
            history_mode: HistoryMode::LiveOnly,
            acp_catalog: None,
            acp_install: None,
            store: None,
            allow_remote_writes,
            shared_live_writes_denied,
            pending_oauth_flows: std::sync::Arc::new(parking_lot::RwLock::new(
                std::collections::HashMap::new(),
            )),
            oauth_base_url: "http://127.0.0.1".to_string(),
            web_auth,
            connections: ConnectionRuntime::default(),
        }
    })
}

#[cfg(test)]
mod tests;
