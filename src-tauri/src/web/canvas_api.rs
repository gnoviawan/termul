//! Canvas web routes (OpenPencil canvas mode, CAP-5): `POST /canvas/open` /
//! `/canvas/close` / `/canvas/save` (`IpcBody` envelope, HTTP 200 for
//! app-level failures like their Tauri command twins), the same-origin
//! `/canvas/<id>/*` embed proxy, and the ROOT canvas routes (`/pkg/*`, `/canvaskit/*`, `/api/*`)
//! that carry the editor's absolute-path traffic (the editor wasm derives
//! its daemon base from `window.location.origin` only and the host page
//! imports `/pkg/op_host_web.js` root-relative, so a web iframe served at
//! `/canvas/<id>/` still requests those paths at the server root).
//!
//! Registered AHEAD of the static fallback, so the SPA mount cannot shadow
//! any of it (verified: termul-server has no other `/pkg`, `/canvaskit`,
//! or `/api` routes). Doc paths on `/canvas/open` are validated against the
//! project-root boundary exactly like the fs/git routes (`validate_doc_path`).
//! Auth split (browser iframes cannot send `Authorization: Bearer` headers):
//! - `/canvas/open|close|save` stay behind the outer bearer `web_auth_gate`
//!   (`"/canvas/"` in `GATED_PREFIXES` — the renderer facades already hold
//!   the web auth token);
//! - `/canvas/<id>/*` (the embed + proxy catch-all) is EXEMPT from the
//!   bearer gate (`router::is_canvas_proxy_path`) and authenticated by
//!   [`canvas_token_gate`]: every request must carry a `ct` query param that
//!   constant-time-matches the canvas session token minted on the first web
//!   open of a live entry (reused on idempotent repeat opens) and embedded
//!   in the returned embed URL;
//! - the ROOT canvas routes (`/pkg|/canvaskit|/api`) are authenticated by
//!   the PER-CANVAS cookie `op_canvas_ct_<canvasId>` (constant-time vs that
//!   canvas's session token) and routed to THAT canvas's daemon — the
//!   target canvas is resolved from the request's `Referer` when it names
//!   `/canvas/<id>/…` (the browser sends it automatically for the editor's
//!   iframe traffic), else the ACTIVE canvas. A canvas's own cookie is
//!   scoped to its own daemon, so opening canvas B never contaminates
//!   canvas A's requests and cross-canvas pairing is rejected.
//!
//! `POST /canvas/open` mounts the figcraft editor: it mints the project's
//! bundle token (`static_server::open_canvas`) and the same `/canvas/<id>/*`
//! routes then serve the embedded bundle (`canvas::static_server`) for any
//! canvas id that holds a bundle token and has no legacy daemon; the `ct`
//! query token or the per-canvas cookie it sets authorizes those requests.
//! `POST /canvas/close` revokes the token, so stale `ct` params and cookies
//! stop authenticating. `GET /canvas/bundle-base` reports the (same-origin)
//! base plus the pinned bundle tag. Remote clients reach the canvas only
//! through these same-origin routes (AD-8); the daemon's loopback port is
//! never exposed.
//!
//! The router's state carries the pool handle plus the web auth gate (both
//! optional — the test `router_with_static` variant passes `pool: None` →
//! routes degrade to typed `DAEMON_DOWN`).

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::extract::{ConnectInfo, Request, State};
use axum::http::header::{self, HeaderMap};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{any, get, post};
use axum::Router;
use serde::Deserialize;

use crate::canvas::mcp_proxy;
use crate::canvas::persistence::CloseOutcome;
use crate::canvas::pool::CanvasDaemonPool;
use crate::canvas::static_server::{
    bundle_tokens, close_canvas, open_canvas, query_param, same_origin_base, serve_bundle,
    CanvasOpenInfo, CookiePolicy,
};
use crate::web::auth::WebAuth;
use crate::web::canvas_persistence_api::PERSISTENCE_ROUTES;
use crate::web::capabilities::WriteFlags;
use crate::web::fs_api::{check_local_only, IpcBody};
use crate::web::project_registry::ProjectRegistry;

/// Router state: the pool handle + the web auth gate + the project-root
/// boundary for doc-path validation (any may be `None` in test/degraded
/// compositions — a `None` boundary skips validation).
#[derive(Clone)]
pub struct CanvasState {
    pub pool: Option<Arc<CanvasDaemonPool>>,
    pub web_auth: Option<Arc<WebAuth>>,
    pub boundary: Option<CanvasProjectBoundary>,
    /// Deployment flags for the shared write predicate: `/canvas/open|close|
    /// save` start/stop host daemons and write the `.op` document, so they
    /// are write routes like the fs/git ones.
    pub write_flags: WriteFlags,
}

/// Project-root boundary for the web doc-path validation on open — the SAME
/// containment semantics the fs/git routes enforce (`git_api::
/// ensure_within_project_boundary`): the path is accepted when it is within
/// any registered, non-archived project root.
#[derive(Clone)]
pub struct CanvasProjectBoundary {
    pub registry: Arc<ProjectRegistry>,
}

/// The shared write predicate for the canvas open/close/save routes.
pub(crate) fn check_canvas_write<T>(
    state: &CanvasState,
    peer: SocketAddr,
    route: &str,
) -> Option<IpcBody<T>> {
    check_local_only::<T>(
        peer,
        state.write_flags.allow_remote_writes,
        state.write_flags.shared_live_writes_denied,
        route,
    )
}

/// Validate a canvas doc path against the project boundary — mirrors the
/// fs/git route validation (`fs_api::resolve_request_path` canonicalization +
/// `git_api::ensure_within_project_boundary` containment): the doc a web
/// client opens must live inside a registered, non-archived project root,
/// exactly like every other web fs operation. Returns the
/// canonicalized, verbatim-stripped doc path on success; a typed
/// `PATH_VALIDATION_FAILED` pair on rejection. `None` boundary (test
/// compositions) skips validation and returns the verbatim-stripped path.
fn validate_doc_path(
    boundary: Option<&CanvasProjectBoundary>,
    doc_path: &str,
) -> Result<String, (String, String)> {
    let failed = |message: String| {
        (
            message,
            crate::canvas::CODE_PATH_VALIDATION_FAILED.to_string(),
        )
    };
    let Some(boundary) = boundary else {
        return Ok(crate::path_validation::strip_verbatim_prefix(doc_path).into_owned());
    };
    // Traversal rejection + canonicalization (same helper the fs routes use;
    // ancestor-walks for not-yet-existing tails, which then fail at spawn).
    let resolved: PathBuf = crate::web::fs_api::resolve_request_path(Path::new(doc_path))
        .map_err(|(message, code)| failed(format!("{message} (code {code})")))?;
    // Containment vs any registered, non-archived project root.
    let outside =
        crate::web::git_api::ensure_within_project_boundary::<()>(&resolved, &boundary.registry)
            .is_some();
    if outside {
        return Err(failed(format!(
            "doc path '{}' is outside the project boundary",
            resolved.display()
        )));
    }
    // Tool-friendly string form (verbatim-stripped), like `git_api::cwd_string`.
    Ok(crate::path_validation::strip_verbatim_prefix(&resolved.to_string_lossy()).into_owned())
}

/// Cookie-name prefix for the per-canvas canvas session cookies. The
/// renderer sets one cookie PER CANVAS after each successful web open —
/// `op_canvas_ct_<canvasId>` (e.g. `op_canvas_ct_cv51af1ee63efc6982`) —
/// carrying that open's `CanvasOpenInfo.canvasToken`. Per-canvas names are
/// what keeps multiple open canvases isolated: canvas A's cookie survives
/// canvas B opening (the old shared `op_canvas_ct` name let B's token
/// silently authenticate A's requests). Cookie values are never logged.
pub const CANVAS_COOKIE_PREFIX: &str = crate::canvas::static_server::CANVAS_COOKIE_PREFIX;

/// The per-canvas canvas session cookie name the renderer must set.
#[must_use]
pub fn canvas_cookie_name(canvas_id: &str) -> String {
    crate::canvas::static_server::canvas_cookie_name(canvas_id)
}

/// Routes exempt from the `ct` query-param gate: the API routes carry their
/// own auth (`open|close|save` — the outer bearer gate; `bundle-base` — the
/// bearer check in the handler).
const CT_GATE_EXEMPT_PATHS: &[&str] = &[
    "/canvas/open",
    "/canvas/close",
    "/canvas/save",
    "/canvas/bundle-base",
];

/// `POST /canvas/open` body: `{ "docPath": "...", "projectId": "...",
/// "autosaveMs"?: n }`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CanvasOpenRequest {
    doc_path: String,
    project_id: String,
    #[serde(default)]
    autosave_ms: Option<u64>,
}

/// `POST /canvas/close` body: `{ "projectId": "...", "discard"?: bool }`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CanvasCloseRequest {
    project_id: String,
    #[serde(default)]
    discard: Option<bool>,
}

/// `POST /canvas/save` body: `{ "docPath": "..." }`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CanvasDocRequest {
    doc_path: String,
}

/// Build the canvas sub-router with its state APPLIED (so the
/// canvas-token middleware can hold it) — generic over the caller's outer
/// router state so it merges into both `router()` and
/// `router_with_static()` like any stateless router.
pub fn canvas_router<S>(state: CanvasState) -> Router<S> {
    Router::new()
        .route("/canvas/open", post(open))
        .route("/canvas/close", post(close))
        .route("/canvas/save", post(save))
        .route("/canvas/bundle-base", get(bundle_base))
        .merge(crate::web::canvas_persistence_api::persistence_routes())
        // Same-origin embed surface: `/canvas/<id>/` (the iframe src — the
        // trailing slash keeps the editor's relative asset URLs inside the
        // proxy prefix) plus the catch-all. The bare and trailing-slash
        // forms are both registered (axum does not collapse them) and both
        // map to the daemon root. All of these sit behind the ct gate.
        .route("/canvas/{id}", get(embed_root))
        .route("/canvas/{id}/", get(embed_root))
        .route("/canvas/{id}/{*rest}", any(proxy_path))
        // Root canvas routes: the editor's absolute-path bundle/API/SSE
        // traffic from a web-embed iframe (`/pkg/op_host_web.js`,
        // `/canvaskit/canvaskit.js`, `/api/mcp/*` incl. the SSE stream).
        // Routed to the REFERER-scoped target canvas's daemon (else the
        // active canvas), authenticated by the per-canvas
        // `op_canvas_ct_<id>` cookie in the handler. The bare and
        // trailing-slash forms are registered alongside the wildcard
        // (matchit's catch-all does not match the empty tail). Verified
        // unused by every other termul-server route.
        .route("/pkg", get(root_proxy))
        .route("/pkg/", get(root_proxy))
        .route("/pkg/{*rest}", any(root_proxy))
        .route("/canvaskit", get(root_proxy))
        .route("/canvaskit/", get(root_proxy))
        .route("/canvaskit/{*rest}", any(root_proxy))
        .route("/api", get(root_proxy))
        .route("/api/", get(root_proxy))
        .route("/api/{*rest}", any(root_proxy))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            canvas_token_gate,
        ))
        .with_state(state)
}

/// Extract a named cookie's value from a `Cookie` header. Cookie values are
/// never logged — the canvas cookies carry the session tokens.
fn cookie_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok())
        .and_then(|cookies| {
            cookies.split(';').find_map(|pair| {
                let (cookie_name, value) = pair.trim().split_once('=')?;
                (cookie_name == name).then_some(value)
            })
        })
}

/// Extract the canvas id a request's `Referer` points at, when the Referer
/// URL contains a `/canvas/<id>/…` path segment with a plausible canvas id
/// (`cv` + 16 hex chars). Tolerant parsing: scheme/host are ignored (the
/// `/canvas/` segment is searched anywhere in the URL), query and fragment
/// are dropped, and the id is the segment following `/canvas/` up to the
/// next `/` or end. The browser sends this automatically for the editor's
/// absolute-path traffic (`/pkg/*`, `/api/*`) originating from its
/// `/canvas/<id>/` iframe page — that is what scopes root-route requests to
/// the RIGHT canvas even when several are open. Referer values are never
/// logged.
fn canvas_id_from_referer(headers: &HeaderMap) -> Option<String> {
    let referer = headers
        .get(header::REFERER)
        .and_then(|value| value.to_str().ok())?;
    let path = referer.split('#').next()?;
    let path = path.split('?').next()?;
    let index = path.find("/canvas/")?;
    let rest = &path[index + "/canvas/".len()..];
    let id = rest.split('/').next().unwrap_or_default();
    let plausible = id.len() == 18
        && id.starts_with("cv")
        && id[2..].bytes().all(|byte| byte.is_ascii_hexdigit());
    plausible.then(|| id.to_string())
}

/// 401 in the IpcBody failure shape with a caller-named layer message. The
/// messages are deliberately distinct from the outer bearer gate's
/// "Unauthorized" so logs and tests can tell WHICH layer rejected a
/// request. Never includes the presented token/cookie.
fn canvas_unauthorized(message: &str) -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({
            "success": false,
            "error": message,
            "code": "UNAUTHORIZED",
        })),
    )
        .into_response()
}

/// Typed 502 in the IpcBody failure shape (no live daemon — the "canvas
/// closed" signal).
fn daemon_down(message: &str) -> Response {
    (
        StatusCode::BAD_GATEWAY,
        Json(serde_json::json!({
            "success": false,
            "error": message,
            "code": "DAEMON_DOWN",
        })),
    )
        .into_response()
}

/// Canvas-token gate for the `/canvas/<id>/*` embed + proxy surface: requires
/// a `ct` query param that constant-time-matches the canvas entry's session
/// token. Everything else (API routes, root canvas routes) passes through —
/// they carry their own auth.
///
/// Logging: rejections record the request PATH only — never the query
/// string, which carries the `ct` token.
async fn canvas_token_gate(
    State(state): State<CanvasState>,
    request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path();
    if !path.starts_with("/canvas/")
        || CT_GATE_EXEMPT_PATHS.contains(&path)
        || PERSISTENCE_ROUTES.contains(&path)
    {
        return next.run(request).await;
    }
    let canvas_id = path
        .strip_prefix("/canvas/")
        .and_then(|rest| rest.split('/').next())
        .unwrap_or_default();
    let presented = query_param(request.uri().query(), "ct").unwrap_or_default();
    let accepted = state
        .pool
        .as_ref()
        .is_some_and(|pool| pool.verify_canvas_token(canvas_id, presented))
        || bundle_tokens()
            .authorize(canvas_id, request.uri().query(), request.headers())
            .granted();
    if !accepted {
        tracing::warn!(
            target: "termul::web::canvas",
            path = path,
            "canvas proxy request rejected: missing or invalid canvas session token"
        );
        return canvas_unauthorized("canvas session token missing or invalid");
    }
    next.run(request).await
}

/// `POST /canvas/open` — validate the doc path against the project boundary,
/// then return the same-origin bundle base plus the project's minted `ct`
/// token (the twin of the `canvas_open` Tauri command).
async fn open(
    State(state): State<CanvasState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<CanvasOpenRequest>,
) -> Json<IpcBody<CanvasOpenInfo>> {
    if let Some(forbidden) = check_canvas_write(&state, peer, "/canvas/open") {
        return Json(forbidden);
    }
    let log_project_id = crate::commands::sanitize_log_field(&req.project_id);
    let doc_key = match validate_doc_path(state.boundary.as_ref(), &req.doc_path) {
        Ok(path) => path,
        Err((message, code)) => {
            tracing::warn!(
                target: "termul::web::canvas",
                "canvas open rejected project_id={log_project_id}: {message}"
            );
            return Json(IpcBody::err(message, code));
        }
    };
    match open_canvas(
        same_origin_base(),
        &req.project_id,
        doc_key,
        req.autosave_ms,
    ) {
        Ok(info) => {
            tracing::info!(
                target: "termul::web::canvas",
                "canvas open (web) project_id={log_project_id} canvas_id={}",
                info.canvas_id
            );
            Json(IpcBody::ok(info))
        }
        Err(err) => {
            tracing::warn!(
                target: "termul::web::canvas",
                "canvas open failed project_id={log_project_id} code={}",
                err.code
            );
            Json(IpcBody::err(err.message, err.code))
        }
    }
}

/// `POST /canvas/close` — unmount the project's canvas through the AD-31
/// sequence (`static_server::close_canvas`, shared with `canvas_close`). A
/// failed save answers `SAVE_FAILED` and keeps the mount; `discard: true` is
/// the user's explicit choice to drop unsaved changes. Idempotent.
async fn close(
    State(state): State<CanvasState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<CanvasCloseRequest>,
) -> Json<IpcBody<CloseOutcome>> {
    if let Some(forbidden) = check_canvas_write(&state, peer, "/canvas/close") {
        return Json(forbidden);
    }
    let mode = crate::commands::close_mode(req.discard);
    let project_id = crate::commands::sanitize_log_field(&req.project_id);
    tracing::info!(
        target: "termul::web::canvas",
        "canvas close (web) project_id={project_id} mode={mode:?}"
    );
    match close_canvas(&req.project_id, mode).await {
        Ok(outcome) => {
            if outcome.discarded {
                tracing::warn!(
                    target: "termul::web::canvas",
                    "canvas closed project_id={project_id}: unsaved changes discarded by the user"
                );
            } else {
                tracing::info!(
                    target: "termul::web::canvas",
                    "canvas closed project_id={project_id} unmounted={} saved={}",
                    outcome.unmounted,
                    outcome.saved_version.as_deref().unwrap_or("none")
                );
            }
            Json(IpcBody::ok(outcome))
        }
        Err(err) => {
            tracing::warn!(
                target: "termul::web::canvas",
                "canvas close refused project_id={project_id} code={}: {}",
                err.code,
                err.message
            );
            Json(IpcBody::err(err.message, err.code))
        }
    }
}

/// `POST /canvas/save` — save through the daemon (`POST /api/file/save`);
/// the daemon is the `.op` document authority. No live daemon → typed
/// `DAEMON_DOWN` (the "canvas closed" signal).
async fn save(
    State(state): State<CanvasState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<CanvasDocRequest>,
) -> Json<IpcBody<serde_json::Value>> {
    if let Some(forbidden) = check_canvas_write(&state, peer, "/canvas/save") {
        return Json(forbidden);
    }
    let Some(pool) = state.pool else {
        return Json(IpcBody::err(
            "canvas daemon pool is unavailable on this server",
            "DAEMON_DOWN",
        ));
    };
    let Some(daemon) = pool.daemon_for_doc(&req.doc_path) else {
        tracing::warn!(target: "termul::web::canvas", "canvas save with no live daemon");
        return Json(IpcBody::err("canvas daemon is not running", "DAEMON_DOWN"));
    };
    match mcp_proxy::daemon_save(daemon.as_ref()).await {
        Ok(value) => Json(IpcBody::ok(value)),
        Err(err) => Json(IpcBody::err(err.message, err.code)),
    }
}

/// Root canvas routes (`/pkg`, `/canvaskit`, `/api` — the editor's
/// absolute-path bundle/API/SSE traffic): proxy to the TARGET canvas's
/// daemon with the raw path forwarded verbatim (the editor requests the
/// same paths on the daemon). Target + credential resolution:
/// - a resolvable `Referer` pointing at `/canvas/<id>/…` scopes the request
///   to THAT canvas: its daemon and its `op_canvas_ct_<id>` cookie
///   (constant-time). This keeps canvas A's iframe working after canvas B
///   opens — and makes cross-canvas contamination impossible (the cookie
///   must belong to the canvas the Referer names);
/// - without a Referer (direct agent/tool clients), the ACTIVE canvas is
///   the target: the active canvas's per-canvas cookie validates against
///   the active canvas's daemon — the credential always matches the
///   routing, never a different canvas.
///
/// No target daemon → typed 502 `DAEMON_DOWN` (the "canvas closed" signal);
/// missing/invalid cookie → 401 naming the canvas cookie layer. Rejection
/// logs carry the request path only — never the cookie or Referer values.
async fn root_proxy(State(state): State<CanvasState>, request: Request) -> Response {
    let Some(pool) = state.pool.as_ref() else {
        return daemon_down("canvas daemon pool is unavailable on this server");
    };
    let (canvas_id, daemon) = match canvas_id_from_referer(request.headers()) {
        Some(referer_id) => {
            let daemon = pool.daemon_for_canvas_id(&referer_id);
            (referer_id, daemon)
        }
        None => (
            pool.active_canvas_id().unwrap_or_default(),
            pool.active_daemon(),
        ),
    };
    let Some(daemon) = daemon else {
        tracing::warn!(
            target: "termul::web::canvas",
            path = request.uri().path(),
            "canvas root-route request with no target daemon"
        );
        return daemon_down("canvas daemon is not running");
    };
    let presented =
        cookie_value(request.headers(), &canvas_cookie_name(&canvas_id)).unwrap_or_default();
    if !pool.verify_canvas_token(&canvas_id, presented) {
        tracing::warn!(
            target: "termul::web::canvas",
            path = request.uri().path(),
            "canvas root-route request rejected: missing or invalid canvas session cookie"
        );
        return canvas_unauthorized("canvas session cookie missing or invalid");
    }
    // Root-relative path maps 1:1 onto the daemon path (that is the whole
    // point of these routes). Query string forwards verbatim (SSE etc.).
    let subpath = request.uri().path().to_string();
    mcp_proxy::proxy_canvas_path(Some(&daemon), request, &subpath).await
}

/// `GET /canvas/{id}` — embed root without the trailing slash.
async fn embed_root(State(state): State<CanvasState>, request: Request) -> Response {
    proxy_for_request_path(state.pool, request, "/").await
}

/// Any method under `/canvas/{id}/{*rest}` — same-origin proxy to the
/// canvas's daemon. The daemon subpath is recovered from the RAW request URI
/// (still percent-encoded) so asset URLs round-trip byte-for-byte.
async fn proxy_path(State(state): State<CanvasState>, request: Request) -> Response {
    let raw_path = request.uri().path().to_string();
    // "/canvas/<id>/<rest…>" → ("<id>", "/<rest…>"); a bare trailing slash
    // maps to the daemon root.
    let subpath = match raw_path.strip_prefix("/canvas/") {
        Some(rest) => match rest.find('/') {
            Some(index) => rest[index..].to_string(),
            None => "/".to_string(),
        },
        None => "/".to_string(),
    };
    proxy_for_request_path(state.pool, request, &subpath).await
}

async fn proxy_for_request_path(
    pool: Option<Arc<CanvasDaemonPool>>,
    request: Request,
    subpath: &str,
) -> Response {
    // Recover the canvas id from the raw path to look up the daemon.
    let raw_path = request.uri().path().to_string();
    let canvas_id = raw_path
        .strip_prefix("/canvas/")
        .map(|rest| rest.split('/').next().unwrap_or_default())
        .unwrap_or_default()
        .to_string();
    let daemon = pool
        .as_ref()
        .and_then(|pool| pool.daemon_for_canvas_id(&canvas_id));
    if daemon.is_none() {
        if bundle_tokens().is_issued(&canvas_id) {
            return serve_bundle(
                CookiePolicy::SameOrigin,
                request.method(),
                request.uri(),
                request.headers(),
            );
        }
        tracing::warn!(
            target: "termul::web::canvas",
            "canvas proxy request for unknown canvas id"
        );
        return daemon_down("canvas daemon is not running");
    }
    mcp_proxy::proxy_canvas_path(daemon.as_ref(), request, subpath).await
}

/// `GET /canvas/bundle-base` — where the editor bundle loads from on this
/// surface (same-origin, so an empty base) and the bundle tag this build
/// pins. Exempt from the outer bearer gate like the other `/canvas/<x>`
/// paths, so it checks the web auth bearer itself.
async fn bundle_base(State(state): State<CanvasState>, request: Request) -> Response {
    if let Some(auth) = state.web_auth.as_ref() {
        let authorized = mcp_proxy::presented_bearer(request.headers())
            .is_some_and(|token| auth.accepts(&token));
        if !authorized {
            return canvas_unauthorized("canvas bundle base requires a web auth bearer token");
        }
    }
    Json(IpcBody::ok(same_origin_base())).into_response()
}
