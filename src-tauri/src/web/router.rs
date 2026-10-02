//! Axum router for the ACP web server (standalone `termul-server` + desktop).
//!
//! Exposes `/health`, the live WS upgrade at `/ws`, and static serving of the
//! web client: from disk `ServeDir` in dev (`dist-web/` on disk) or the
//! embedded `rust-embed` bundle in release. The `/ws` route is registered
//! explicitly AHEAD of the static fallback so it is not shadowed by the static
//! mount (AC1).

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::{
    extract::{ConnectInfo, Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use serde::Serialize;

use crate::web::acp_api;
use crate::web::auth::WebAuth;

use crate::acp::{
    AcpCatalogService, AcpInstallService, AcpManager, FileProjectRegistry, WorkspaceManifestService,
};
use crate::pty::PtyManager;
use crate::trackers::{CwdTracker, ExitCodeTracker, GitTracker, TerminalEventHub};
use crate::web::catalog_api;
use crate::web::fs_api;
use crate::web::git_api;
use crate::web::install_api;
use crate::web::log_api;
use crate::web::mcp_oauth_api;
use crate::web::mcp_probe_api;
use crate::web::mcp_servers_api;
use crate::web::project_registry::ProjectRegistry;
use crate::web::projects_api;
use crate::web::search_api;
use crate::web::sink::WsRelaySink;
use crate::web::skills_api;
use crate::web::store::WebStore;
use crate::web::terminal_ws::terminal_ws_upgrade;
use crate::web::workspace_api;
use crate::web::worktree_api;
use crate::web::ws::{ws_upgrade, AppState, HistoryMode};

use super::assets;

/// Build the ACP web-server Axum router (serves the web client + WS + health).
///
/// `ws_relay` is threaded into the router state so `/ws` can subscribe clients
/// and replay cursors (Story 1.4). The `/ws` + `/health` routes are registered
/// BEFORE the static fallback so the static mount cannot shadow them (AC1).
///
/// `project_root` (PR-S4) is the containment boundary for the OPERATION
/// routes (`/git/*`, `/skills`, `/search/content`) — enforced by
/// [`git_api::ensure_within_project_boundary`] (accepts the default
/// `project_root` or any registered, non-archived project root; rejects
/// with `OUTSIDE_PROJECT_ROOT`). The `/fs/*` browse/read routes (`ls`/`browse`/
/// `read`) are intentionally broader — no `project_root` check — for desktop
/// parity, the directory picker, and editor reads; `/fs/*` writes (`mkdir`/
/// `write`/`delete`/`rename`/`copy`) and `/fs/info` are loopback-guarded
/// (`check_local_only`, `FORBIDDEN`). See ADR-007 for the recorded policy.
/// Resolved by the caller from `ServerConfig::project_root` (or its default).
///
/// The static fallback serves from disk `ServeDir` in dev (`dist-web/` on disk)
/// or from the embedded `Assets` bundle in release — see
/// [`assets::static_fallback`].
///
/// `web_auth` is the web auth gate (CAP-1 interim, QA remediation Story 1).
/// `Some` requires the token (`Authorization: Bearer` header) on every gated API
/// route via the [`web_auth_gate`] middleware and stores it in [`AppState`]
/// for `/ws` + `/terminal/ws`. `None` = ungated (legacy behavior).
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
    registry_persistence: Option<Arc<parking_lot::Mutex<FileProjectRegistry>>>,
    projects_file: Option<PathBuf>,
    project_root: PathBuf,
    history_mode: HistoryMode,
    workspace_manifest: Option<Arc<WorkspaceManifestService>>,
    acp_catalog: Option<Arc<AcpCatalogService>>,
    acp_install: Option<Arc<AcpInstallService>>,
    store: Option<Arc<WebStore>>,
    allow_remote_writes: bool,
    shared_live_writes_denied: bool,
    oauth_base_url: String,
    web_auth: Option<Arc<WebAuth>>,
) -> Router {
    let mut r = Router::new()
        .route("/health", get(health_check))
        .route("/ws", get(ws_upgrade))
        .route("/terminal/ws", get(terminal_ws_upgrade))
        // Project list mirror (Epic-4 bridge): the web client reads the
        // desktop's non-archived + archived projects here. Registered AHEAD of
        // the static fallback so the SPA mount cannot shadow it.
        .route(
            "/projects",
            get(projects_api::list).post(projects_api::create_project),
        )
        // Explicit host-default change (Epic 7 — cross-client workspace
        // continuity). Mirrors the `set_default_project` WS request + the
        // `set_host_default_project` Tauri command (transport parity).
        .route("/projects/default", post(projects_api::set_default_project))
        // Option B: project-list mutations (the standalone server is a
        // first-class project-list authority, not just a read-only mirror).
        // `PUT /projects/{id}` patches display fields; `DELETE /projects/{id}`
        // removes the root. Both persist to `FileProjectRegistry` (VPS) with
        // rollback + broadcast `projects_changed`. Mirrors the
        // `add_project`/`update_project`/`remove_project` WS requests.
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
        .route("/git/discard", post(git_api::discard))
        .route("/git/log", post(git_api::get_log))
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
        .route("/git/branch-create", post(git_api::branch_create))
        // Search web routes (CAP-2: Web & Mobile 1:1 Parity). Each mirrors a
        // desktop `#[tauri::command] search_*` handler; see `web/search_api.rs`.
        .route("/search/rg-info", get(search_api::rg_info))
        .route("/search/content", post(search_api::content))
        .route("/search/cancel", post(search_api::cancel))
        // Skills web routes (CAP-2): `GET /skills` + `GET /skills/:name`.
        .route("/skills", get(skills_api::list))
        .route("/skills/{name}", get(skills_api::read))
        // Frontend error forwarding (CAP-2): `POST /log/frontend-error`.
        // Loopback-only (enforced inside the handler).
        .route("/log/frontend-error", post(log_api::frontend_error))
        .route("/shells", get(fs_api::shells))
        // Workspace manifest web routes (CAP-5: Web & Mobile 1:1 Parity).
        // Each mirrors a desktop `#[tauri::command] workspace_manifest_*`
        // handler; see `web/workspace_api.rs`. Registered AHEAD of the static
        // fallback so the SPA mount cannot shadow them. Write + delete are
        // loopback-guarded inside the handler.
        .route("/workspace/{projectId}", get(workspace_api::get))
        .route("/workspace/{projectId}/write", post(workspace_api::write))
        .route("/workspace/{projectId}/delete", post(workspace_api::delete))
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
        // ACP install web route (CAP-6 / Story 9: verified-atomic install).
        // Mirrors the desktop `#[tauri::command] acp_install_agent` handler;
        // see `web/install_api.rs`. Registered AHEAD of the static fallback so
        // the SPA mount cannot shadow it. The request is `{ agentId }` only;
        // the host resolves everything from the trusted catalog.
        .route("/acp/install", post(install_api::install))
        // Worktree web routes (CAP — Web worktree parity). Each mirrors a
        // desktop `#[tauri::command] worktree_*` handler; see
        // `web/worktree_api.rs`. Registered AHEAD of the static fallback so the
        // SPA mount cannot shadow them. Write routes (`create`/`remove`/
        // `copy-include-files`) are loopback-guarded inside the handler; read
        // routes (`list`/`branches`/`check-dirty`/`resolve-base-branch`)
        // enforce containment only. Only the 7 launch-flow routes ship here;
        // the 8 advanced ops are deferred (see deferred-work.md).
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
        );
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
    // CAP-1: wrap the initial project_root in `Arc<RwLock<PathBuf>>` so the
    // registry can rebind it in place on a project switch (the handle is
    // the *same* `Arc` `AppState.project_root` owns). Register it with the
    // registry before building `AppState` so `set` / `set_default_project`
    // mutations can recompute + write the canonical path here.
    let project_root_handle = std::sync::Arc::new(parking_lot::RwLock::new(project_root));
    registry.set_project_root_handle(std::sync::Arc::clone(&project_root_handle));

    let state = AppState {
        acp,
        pty,
        terminal_events,
        cwd_tracker,
        git_tracker,
        exit_code_tracker,
        relay: ws_relay,
        registry,
        registry_persistence,
        projects_file: projects_file.map(Arc::new),
        history_mode,
        workspace_manifest,
        acp_catalog,
        acp_install,
        store,
        allow_remote_writes,
        shared_live_writes_denied,
        project_root: project_root_handle,
        pending_oauth_flows: std::sync::Arc::new(parking_lot::RwLock::new(
            std::collections::HashMap::new(),
        )),
        oauth_base_url,
        web_auth,
    };
    maybe_gate_api(state.web_auth.clone(), r).with_state(state)
}

/// Apply the web auth middleware to the router when the gate is active.
/// Public paths (`/health`, `/ws`, `/terminal/ws`, `/oauth/callback`, and all
/// non-API static/SPA paths) always pass — see [`web_auth_gate`]. Generic over
/// the router's (still-missing) state type so both `router` and
/// `router_with_static` can call it before `with_state`.
fn maybe_gate_api<S>(web_auth: Option<Arc<WebAuth>>, r: Router<S>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    match web_auth {
        Some(auth) => r.layer(middleware::from_fn_with_state(auth, web_auth_gate)),
        None => r,
    }
}

/// Exact paths that never require the token: the liveness probe, both WS
/// endpoints (they gate in-protocol, after the upgrade), and the OAuth
/// redirect target (the authorization server cannot carry the token).
const PUBLIC_PATHS: &[&str] = &["/health", "/ws", "/terminal/ws", "/oauth/callback"];

/// API route prefixes that require the token when the gate is active
/// (CAP-1 intent: "every endpoint"). Everything else — the static bundle and
/// SPA client routes — stays public so the login page can load.
const GATED_PREFIXES: &[&str] = &[
    "/projects",
    "/mcp-servers",
    "/fs/",
    "/git/",
    "/search/",
    "/skills",
    "/log/",
    "/shells",
    "/workspace/",
    "/acp/",
    "/worktree/",
];

/// Whether `path` is a gated API route. Pure decision fn (unit-testable).
fn requires_token(path: &str) -> bool {
    if PUBLIC_PATHS.contains(&path) {
        return false;
    }
    GATED_PREFIXES.iter().any(|prefix| path.starts_with(prefix))
}

/// Extract the presented token from the `Authorization: Bearer <token>`
/// header (scheme match is case-insensitive, RFC 7235). There is
/// deliberately NO `?token=` query-param fallback on gated API routes:
/// query strings end up in access logs, proxy logs, and `Referer` headers,
/// which is exactly where a bearer credential must not live. The bootstrap
/// URL carries the token in the URL FRAGMENT (`#token=`) instead —
/// fragments are never sent to the server — and the browser client moves it
/// to localStorage + the `Authorization` header on first load
/// (`src/renderer/lib/web-auth-token.ts`).
fn presented_token(request: &Request) -> Option<String> {
    let value = request.headers().get(axum::http::header::AUTHORIZATION)?;
    let value = value.to_str().ok()?;
    let bytes = value.as_bytes();
    if bytes.len() > 7 && value[..6].eq_ignore_ascii_case("bearer") && bytes[6] == b' ' {
        return Some(value[7..].to_string());
    }
    None
}

/// Axum middleware enforcing the web auth gate on gated API routes. The 401
/// body mirrors the `IpcBody` failure shape (`{success, error, code}`) the
/// renderer's REST helpers parse; the token is never logged or echoed.
async fn web_auth_gate(State(auth): State<Arc<WebAuth>>, request: Request, next: Next) -> Response {
    if !requires_token(request.uri().path()) {
        return next.run(request).await;
    }
    let presented = presented_token(&request);
    match presented {
        Some(token) if auth.accepts(&token) => next.run(request).await,
        _ => {
            tracing::warn!(
                target: "termul::web::router",
                path = request.uri().path(),
                "web auth gate refused API request"
            );
            (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({
                    "success": false,
                    "error": "Unauthorized",
                    "code": "UNAUTHORIZED",
                })),
            )
                .into_response()
        }
    }
}

/// Same as [`router`], but with an injectable static-root for unit tests.
///
/// Patch 9: this variant ALWAYS sets `workspace_manifest: None` so the
/// `/workspace/*` routes run in degraded fresh-only mode (get → `Ok(None)`;
/// write → `WORKSPACE_MANIFEST_UNAVAILABLE`; delete → `Ok(())`). It is
/// intended for tests/dev only — production callers must use [`router`]
/// (which threads the real `WorkspaceManifestService`) so the web/remote
/// client gets a live manifest store. Adding a `workspace_manifest`
/// parameter here would break every test call site for no real benefit
/// (the tests do not exercise the manifest routes); the doc comment
/// surfaces the degraded behavior loudly enough that a production caller
/// won't silently pick this variant.
#[allow(clippy::too_many_arguments)]
pub fn router_with_static(
    acp: Arc<AcpManager>,
    pty: Arc<PtyManager>,
    ws_relay: Arc<WsRelaySink>,
    registry: Arc<ProjectRegistry>,
    static_dir: &Path,
    project_root: PathBuf,
    allow_remote_writes: bool,
    shared_live_writes_denied: bool,
    web_auth: Option<Arc<WebAuth>>,
) -> Router {
    let r = Router::new()
        .route("/health", get(health_check))
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
        .route("/fs/info", get(fs_api::info))
        .route("/fs/delete", post(fs_api::delete))
        .route("/fs/rename", post(fs_api::rename))
        .route("/fs/copy", post(fs_api::copy))
        .route("/git/init", post(fs_api::git_init))
        .route("/git/status", post(git_api::get_status))
        .route("/git/diff", post(git_api::get_diff))
        .route("/git/stage", post(git_api::stage))
        .route("/git/unstage", post(git_api::unstage))
        .route("/git/discard", post(git_api::discard))
        .route("/git/log", post(git_api::get_log))
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
        .route("/git/branch-create", post(git_api::branch_create))
        .route("/search/rg-info", get(search_api::rg_info))
        .route("/search/content", post(search_api::content))
        .route("/search/cancel", post(search_api::cancel))
        .route("/skills", get(skills_api::list))
        .route("/skills/{name}", get(skills_api::read))
        .route("/log/frontend-error", post(log_api::frontend_error))
        .route("/shells", get(fs_api::shells))
        .route("/workspace/{projectId}", get(workspace_api::get))
        .route("/workspace/{projectId}/write", post(workspace_api::write))
        .route("/workspace/{projectId}/delete", post(workspace_api::delete))
        .route("/acp/catalog", get(catalog_api::list))
        .route("/acp/catalog/opt-in", post(catalog_api::set_opt_in))
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
            "/acp/factory-key",
            get(acp_api::factory_key_status).post(acp_api::factory_key_save),
        )
        .fallback_service(assets::static_service_from(static_dir));
    // PWA parity with `router`: mark the unversioned shell/PWA files no-cache
    // so the disk-served bundle doesn't stall SW updates (same layer).
    let r = r.layer(middleware::from_fn(assets::shell_no_cache_headers));
    // CAP-1: same RwLock wrap + handle registration as `router`.
    maybe_gate_api(web_auth.clone(), r).with_state({
        let project_root_handle = std::sync::Arc::new(parking_lot::RwLock::new(project_root));
        registry.set_project_root_handle(std::sync::Arc::clone(&project_root_handle));
        AppState {
            acp,
            terminal_events: pty.terminal_events(),
            cwd_tracker: pty.cwd_tracker(),
            git_tracker: pty.git_tracker(),
            exit_code_tracker: pty.exit_code_tracker(),
            pty,
            relay: ws_relay,
            registry,
            registry_persistence: None,
            projects_file: None,
            history_mode: HistoryMode::LiveOnly,
            workspace_manifest: None,
            acp_catalog: None,
            acp_install: None,
            store: None,
            allow_remote_writes,
            shared_live_writes_denied,
            project_root: project_root_handle,
            pending_oauth_flows: std::sync::Arc::new(parking_lot::RwLock::new(
                std::collections::HashMap::new(),
            )),
            oauth_base_url: "http://127.0.0.1".to_string(),
            web_auth,
        }
    })
}

/// Liveness + capability probe for the ACP web server. Returns JSON so the
/// web client can discover the server's write-admission policy
/// (`allowRemoteWrites`) instead of guessing from `window.location.hostname`
/// (wrong for Cloudflare tunnel domains). The admission bool mirrors the
/// EXACT per-request `check_local_only` admission for the requesting peer:
/// `!shared_live_writes_denied && (peer.is_loopback() || allow_remote_writes)`.
/// A loopback peer (e.g. a `localhost` browser on the standalone server, no
/// opt-in) is admitted regardless of `allow_remote_writes`, so `/health`
/// reports `true` for it — matching what its `/worktree/*` writes would face.
/// Desktop shared-live sets `shared_live_writes_denied`, so it reports `false`
/// for every peer (writes are genuinely denied there).
async fn health_check(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
) -> impl IntoResponse {
    let allow =
        !state.shared_live_writes_denied && (peer.ip().is_loopback() || state.allow_remote_writes);
    // Durable boundary log (AGENTS.md): record the capability-admission
    // decision. No peer address or credentials logged — only the decision
    // + whether the deployment-mode deny or opt-in governed it.
    tracing::debug!(
        target: "termul::web::router",
        allow_remote_writes = allow,
        shared_live_denied = state.shared_live_writes_denied,
        opt_in = state.allow_remote_writes,
        "health capability probe",
    );
    (
        StatusCode::OK,
        Json(HealthBody {
            status: "ok",
            allow_remote_writes: allow,
        }),
    )
}

/// `GET /health` response body.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthBody {
    status: &'static str,
    allow_remote_writes: bool,
}

#[cfg(test)]
mod tests;
