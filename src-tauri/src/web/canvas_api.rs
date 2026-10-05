//! Canvas web routes (OpenPencil canvas mode, CAP-5): `POST /canvas/open` /
//! `/canvas/close` / `/canvas/save` (`IpcBody` envelope, HTTP 200 for
//! app-level failures like their Tauri command twins), the stable
//! `POST|GET /canvas/mcp` proxy, the same-origin `/canvas/<id>/*` embed
//! proxy, and the ROOT canvas routes (`/pkg/*`, `/canvaskit/*`, `/api/*`)
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
//!   canvas A's requests and cross-canvas pairing is rejected;
//! - `/canvas/mcp` is EXEMPT from the bearer gate and accepts EITHER the
//!   web auth bearer token (agent clients → active daemon) OR the
//!   Referer-scoped per-canvas canvas cookie (the embedded editor's own
//!   MCP settings → that canvas's daemon).
//!
//! Closing/evicting the canvas drops the pool entry, so stale `ct` params
//! and cookies stop authenticating. Remote clients reach the canvas only
//! through these same-origin routes (AD-8); the daemon's loopback port is
//! never exposed.
//!
//! The router's state carries the pool handle plus the web auth gate (both
//! optional — the test `router_with_static` variant passes `pool: None` →
//! routes degrade to typed `DAEMON_DOWN`).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::header::{self, HeaderMap};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{any, get, post};
use axum::Router;
use parking_lot::RwLock;
use serde::Deserialize;

use crate::canvas::mcp_proxy;
use crate::canvas::pool::CanvasDaemonPool;
use crate::canvas::{canvas_id_for_project, CanvasOpenInfo};
use crate::web::auth::WebAuth;
use crate::web::fs_api::IpcBody;
use crate::web::project_registry::ProjectRegistry;

/// Router state: the pool handle + the web auth gate + the project-root
/// boundary for doc-path validation (any may be `None` in test/degraded
/// compositions — a `None` boundary skips validation).
#[derive(Clone)]
pub struct CanvasState {
    pub pool: Option<Arc<CanvasDaemonPool>>,
    pub web_auth: Option<Arc<WebAuth>>,
    pub boundary: Option<CanvasProjectBoundary>,
}

/// Project-root boundary for the web doc-path validation on open — the SAME
/// containment semantics the fs/git routes enforce (`git_api::
/// ensure_within_project_boundary`): the path is accepted when it is within
/// the live (rebindable) project root OR any registered project root.
#[derive(Clone)]
pub struct CanvasProjectBoundary {
    /// The same `Arc<RwLock<PathBuf>>` handle `AppState.project_root` owns —
    /// the boundary follows active-project switches.
    pub project_root: Arc<RwLock<PathBuf>>,
    pub registry: Arc<ProjectRegistry>,
}

/// Validate a canvas doc path against the project boundary — mirrors the
/// fs/git route validation (`fs_api::resolve_request_path` canonicalization +
/// `git_api::ensure_within_project_boundary` containment): the doc a web
/// client opens must live inside the live project root or a registered
/// project root, exactly like every other web fs operation. Returns the
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
    // Containment vs the live project root OR any registered root.
    let outside = {
        let project_root = boundary.project_root.read();
        crate::web::git_api::ensure_within_project_boundary::<()>(
            &resolved,
            &project_root,
            &boundary.registry,
        )
        .is_some()
    };
    if outside {
        return Err(failed(format!(
            "doc path '{}' is outside the project boundary",
            resolved.display()
        )));
    }
    // Tool-friendly string form (verbatim-stripped), like `git_api::cwd_string`.
    Ok(
        crate::path_validation::strip_verbatim_prefix(&resolved.to_string_lossy()).into_owned(),
    )
}

/// Cookie-name prefix for the per-canvas canvas session cookies. The
/// renderer sets one cookie PER CANVAS after each successful web open —
/// `op_canvas_ct_<canvasId>` (e.g. `op_canvas_ct_cv51af1ee63efc6982`) —
/// carrying that open's `CanvasOpenInfo.canvasToken`. Per-canvas names are
/// what keeps multiple open canvases isolated: canvas A's cookie survives
/// canvas B opening (the old shared `op_canvas_ct` name let B's token
/// silently authenticate A's requests). Cookie values are never logged.
pub const CANVAS_COOKIE_PREFIX: &str = "op_canvas_ct_";

/// The per-canvas canvas session cookie name the renderer must set.
#[must_use]
pub fn canvas_cookie_name(canvas_id: &str) -> String {
    format!("{CANVAS_COOKIE_PREFIX}{canvas_id}")
}

/// Routes exempt from the `ct` query-param gate: the API routes carry their
/// own auth (`open|close|save` — the outer bearer gate; `mcp` — bearer OR
/// the canvas cookie, enforced in the handler).
const CT_GATE_EXEMPT_PATHS: &[&str] =
    &["/canvas/open", "/canvas/close", "/canvas/save", "/canvas/mcp"];

/// `POST /canvas/open` body: `{ "docPath": "...", "projectId": "..." }`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CanvasOpenRequest {
    doc_path: String,
    project_id: String,
}

/// `POST /canvas/close` / `POST /canvas/save` body: `{ "docPath": "..." }`.
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
        .route("/canvas/mcp", post(mcp).get(mcp))
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

/// Generate a fresh 32-hex-char canvas session token from the OS CSPRNG
/// (same primitive + shape convention as `web::auth`'s bearer tokens, at
/// half the entropy budget — the token authorizes one embed URL, not the
/// whole server). Never logged.
fn generate_canvas_token() -> Result<String, &'static str> {
    let mut raw = [0u8; 16];
    getrandom::getrandom(&mut raw).map_err(|_| "CSPRNG failure")?;
    let mut hex = String::with_capacity(raw.len() * 2);
    for byte in raw {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    Ok(hex)
}

/// Extract a raw (undecoded) query param value. The canvas token is plain
/// hex, so no percent-decoding is needed.
fn query_param<'a>(query: Option<&'a str>, key: &str) -> Option<&'a str> {
    let query = query?;
    query.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        (name == key).then_some(value)
    })
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
    if !path.starts_with("/canvas/") || CT_GATE_EXEMPT_PATHS.contains(&path) {
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
        .is_some_and(|pool| pool.verify_canvas_token(canvas_id, presented));
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

/// The `--allow-origin` value for web-spawned daemons: the requesting
/// client's own HTTP origin (from the Host header). Proxied daemon traffic
/// carries no `Origin` header (the proxy strips it), so the daemon's
/// native-client path applies; this value only honors the allowlist
/// contract. Never `*`.
fn request_origin(headers: &HeaderMap) -> String {
    headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .map(|host| format!("http://{host}"))
        .unwrap_or_else(|| "http://127.0.0.1".to_string())
}

/// `POST /canvas/open` — validate the doc path, spawn (or reuse) the doc's
/// daemon, and return the same-origin embed path + stable MCP path + the
/// project's canvas id and session token (the renderer sets it as the
/// per-canvas `op_canvas_ct_<canvasId>` cookie). Idempotent for a live
/// entry: a repeat open of the same doc returns the SAME embed URL + token
/// (no iframe rebuild, no live editor state loss); the token is minted only
/// on a fresh entry.
async fn open(
    State(state): State<CanvasState>,
    headers: HeaderMap,
    Json(req): Json<CanvasOpenRequest>,
) -> Json<IpcBody<CanvasOpenInfo>> {
    tracing::info!(
        target: "termul::web::canvas",
        "canvas open (web) project_id={}",
        crate::commands::sanitize_log_field(&req.project_id)
    );
    let Some(pool) = state.pool else {
        return Json(IpcBody::err(
            "canvas daemon pool is unavailable on this server",
            "DAEMON_DOWN",
        ));
    };
    // Project-root containment FIRST: a web client may only open a doc the
    // fs/git routes could also touch (the daemon receives `--file <path>`).
    let doc_path = match validate_doc_path(state.boundary.as_ref(), &req.doc_path) {
        Ok(path) => path,
        Err((message, code)) => {
            tracing::warn!(
                target: "termul::web::canvas",
                "canvas open rejected: {message}"
            );
            return Json(IpcBody::err(message, code));
        }
    };
    let allow_origin = request_origin(&headers);
    match pool.acquire(&doc_path, &allow_origin, &req.project_id).await {
        Ok(daemon) => {
            let canvas_id = canvas_id_for_project(&req.project_id);
            // Idempotent repeat open: a live entry with a live token keeps
            // the SAME embed URL + token (no iframe rebuild — the live
            // editor state survives). Rotation happens only when no token
            // is set (fresh spawn / fresh entry after close or evict).
            let canvas_token = match pool.canvas_token_for_doc(&daemon.doc_key) {
                Some(existing) => existing,
                None => {
                    let token = match generate_canvas_token() {
                        Ok(token) => token,
                        Err(message) => {
                            tracing::error!(
                                target: "termul::web::canvas",
                                "failed to generate canvas session token"
                            );
                            // No orphaned live daemon with an unusable
                            // token — evict what acquire just installed.
                            pool.release(&daemon.doc_key).await;
                            return Json(IpcBody::err(
                                format!("failed to generate canvas session token: {message}"),
                                crate::canvas::CODE_TOKEN_GENERATION_FAILED,
                            ));
                        }
                    };
                    if !pool.set_canvas_token(&daemon.doc_key, token.clone()) {
                        // The entry vanished (release/shutdown raced the
                        // open) — the daemon has no owner from this
                        // caller's view; release it.
                        tracing::warn!(
                            target: "termul::web::canvas",
                            "canvas entry closed while opening — releasing daemon"
                        );
                        pool.release(&daemon.doc_key).await;
                        return Json(IpcBody::err(
                            "canvas closed while the daemon was starting",
                            crate::canvas::CODE_CANVAS_CLOSED,
                        ));
                    }
                    token
                }
            };
            // Embed URL shape (raw query text — the editor refuses
            // URL-encoded params): `/canvas/<id>/?embed=vscode&ct=<32-hex>`.
            // The `ct` token authenticates the iframe's subsequent
            // `/canvas/<id>/*` requests; the same token is returned as
            // `canvas_token` for the renderer's per-canvas
            // `op_canvas_ct_<canvasId>` cookie (the root canvas routes +
            // the `/canvas/mcp` cookie path).
            Json(IpcBody::ok(CanvasOpenInfo {
                embed_url: format!("/canvas/{canvas_id}/?embed=vscode&ct={canvas_token}"),
                mcp_url: Some("/canvas/mcp".to_string()),
                doc_key: daemon.doc_key.clone(),
                canvas_id: Some(canvas_id),
                canvas_token: Some(canvas_token),
            }))
        }
        Err(err) => Json(IpcBody::err(err.message, err.code)),
    }
}

/// `POST /canvas/close` — evict the doc's daemon (stdin EOF → kill).
async fn close(
    State(state): State<CanvasState>,
    Json(req): Json<CanvasDocRequest>,
) -> Json<IpcBody<bool>> {
    let Some(pool) = state.pool else {
        return Json(IpcBody::err(
            "canvas daemon pool is unavailable on this server",
            "DAEMON_DOWN",
        ));
    };
    tracing::info!(target: "termul::web::canvas", "canvas close (web)");
    pool.release(&req.doc_path).await;
    Json(IpcBody::ok(true))
}

/// `POST /canvas/save` — save through the daemon (`POST /api/file/save`);
/// the daemon is the `.op` document authority. No live daemon → typed
/// `DAEMON_DOWN` (the "canvas closed" signal).
async fn save(
    State(state): State<CanvasState>,
    Json(req): Json<CanvasDocRequest>,
) -> Json<IpcBody<serde_json::Value>> {
    let Some(pool) = state.pool else {
        return Json(IpcBody::err(
            "canvas daemon pool is unavailable on this server",
            "DAEMON_DOWN",
        ));
    };
    let Some(daemon) = pool.daemon_for_doc(&req.doc_path) else {
        tracing::warn!(target: "termul::web::canvas", "canvas save with no live daemon");
        return Json(IpcBody::err(
            "canvas daemon is not running",
            "DAEMON_DOWN",
        ));
    };
    match mcp_proxy::daemon_save(daemon.as_ref()).await {
        Ok(value) => Json(IpcBody::ok(value)),
        Err(err) => Json(IpcBody::err(err.message, err.code)),
    }
}

/// `POST|GET /canvas/mcp` — the stable Termul-proxied MCP endpoint. The
/// route is exempt from the outer bearer gate; credentials resolve the
/// TARGET daemon (never a canvas the credential does not belong to):
/// - the per-canvas canvas cookie (the embedded editor's MCP settings
///   card): Referer-scoped when the request's `Referer` names a canvas —
///   THAT canvas's cookie validates against THAT canvas's daemon; without
///   a Referer, the ACTIVE canvas's cookie validates against the active
///   daemon;
/// - the web auth bearer token (agent clients) → the active daemon;
/// - an ungated server (no `WebAuth`) stays open → the active daemon
///   (legacy posture).
///
/// 401 otherwise.
async fn mcp(State(state): State<CanvasState>, request: Request) -> Response {
    // (b) the canvas cookie path — Referer-scoped target resolution.
    if let Some(pool) = state.pool.as_ref() {
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
        if daemon.is_some() {
            let presented =
                cookie_value(request.headers(), &canvas_cookie_name(&canvas_id))
                    .unwrap_or_default();
            if pool.verify_canvas_token(&canvas_id, presented) {
                return mcp_proxy::proxy_mcp_request(daemon.as_ref(), request).await;
            }
        }
    }
    // (a) the web auth bearer (agent clients) → active daemon; an ungated
    // server stays open (legacy posture).
    let daemon = state.pool.as_ref().and_then(|pool| pool.active_daemon());
    match state.web_auth.as_ref() {
        Some(auth) => {
            if mcp_proxy::presented_bearer(request.headers())
                .is_some_and(|token| auth.accepts(&token))
            {
                mcp_proxy::proxy_mcp_request(daemon.as_ref(), request).await
            } else {
                tracing::warn!(
                    target: "termul::web::canvas",
                    "canvas mcp request rejected: no bearer token or canvas cookie"
                );
                canvas_unauthorized(
                    "canvas mcp requires a web auth bearer token or canvas cookie",
                )
            }
        }
        None => mcp_proxy::proxy_mcp_request(daemon.as_ref(), request).await,
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
    let presented = cookie_value(request.headers(), &canvas_cookie_name(&canvas_id))
        .unwrap_or_default();
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
        tracing::warn!(
            target: "termul::web::canvas",
            "canvas proxy request for unknown canvas id"
        );
        return daemon_down("canvas daemon is not running");
    }
    mcp_proxy::proxy_canvas_path(daemon.as_ref(), request, subpath).await
}
