//! Serves the figcraft web bundle at `/canvas/<id>/` (spine AD-22).
//!
//! One gate, one serving function, two listeners:
//! - the desktop binds [`StaticServer`] on `127.0.0.1:0` (OS-assigned port,
//!   rebuilt when the listener dies) and the renderer iframes it;
//! - `termul-server` (and the desktop's shared-live server) mount the same
//!   [`serve_bundle`] under `web::canvas_api` and the iframe is same-origin.
//!
//! Authorization is per canvas: the first request carries the `ct` query
//! token and gets the per-canvas cookie back, which then authorizes the
//! bundle's sub-resources (their relative URLs drop the query). Neither the
//! token nor the cookie value is ever logged.

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::any;
use axum::Router;
use parking_lot::Mutex;
use serde::Serialize;
use subtle::ConstantTimeEq;
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::persistence::{autosave_delay, canvas_mounts, CloseMode, CloseOutcome};
use super::pin::pinned_tag;
use super::{canvas_id_for_project, CanvasError, CODE_TOKEN_GENERATION_FAILED};
use crate::web::assets;

/// Cookie-name prefix for the per-canvas session cookie: `op_canvas_ct_<id>`.
pub const CANVAS_COOKIE_PREFIX: &str = "op_canvas_ct_";

/// Typed error for a renderer query while the desktop listener is not bound.
pub const CODE_BUNDLE_LISTENER_DOWN: &str = "BUNDLE_LISTENER_DOWN";

const RESTART_BACKOFF_MIN: Duration = Duration::from_millis(250);
const RESTART_BACKOFF_MAX: Duration = Duration::from_secs(5);

pub fn canvas_cookie_name(canvas_id: &str) -> String {
    format!("{CANVAS_COOKIE_PREFIX}{canvas_id}")
}

/// A fresh 32-hex-char token from the OS CSPRNG. Never logged.
pub fn generate_token() -> Result<String, &'static str> {
    let mut raw = [0u8; 16];
    getrandom::getrandom(&mut raw).map_err(|_| "CSPRNG failure")?;
    Ok(raw.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Raw (undecoded) query param. Canvas tokens are plain hex.
pub fn query_param<'a>(query: Option<&'a str>, key: &str) -> Option<&'a str> {
    query?.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        (name == key).then_some(value)
    })
}

fn cookie_values<'a>(headers: &'a HeaderMap, name: &'a str) -> impl Iterator<Item = &'a str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|cookies| cookies.split(';'))
        .filter_map(move |pair| {
            let (cookie_name, value) = pair.trim().split_once('=')?;
            (cookie_name == name).then_some(value)
        })
}

/// How a request proved it may read a canvas.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Denied,
    Query,
    Cookie,
}

impl Access {
    pub fn granted(self) -> bool {
        self != Self::Denied
    }
}

/// The cookie attributes differ by surface. A same-origin web iframe uses a
/// first-party `Lax` cookie, which also works over plain `http` on a LAN. The
/// desktop iframe lives on a loopback origin inside the app webview, so its
/// cookie is third-party there and must be `SameSite=None; Secure` (browsers
/// treat loopback `http` as a secure context for cookies).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CookiePolicy {
    SameOrigin,
    EmbeddedLoopback,
}

impl CookiePolicy {
    fn attributes(self) -> &'static str {
        match self {
            Self::SameOrigin => "HttpOnly; SameSite=Lax",
            Self::EmbeddedLoopback => "HttpOnly; SameSite=None; Secure",
        }
    }
}

/// Per-canvas session tokens for the bundle routes. Process-wide so the
/// desktop loopback listener, the in-process shared-live server and the
/// future minting path all see one registry; entries are keyed by canvas id,
/// so independent canvases never share state.
#[derive(Default)]
pub struct BundleTokens {
    by_canvas: Mutex<HashMap<String, String>>,
}

impl BundleTokens {
    /// The canvas's token, minted on first use and reused on repeat opens.
    pub fn issue(&self, canvas_id: &str) -> Result<String, &'static str> {
        let mut tokens = self.by_canvas.lock();
        if let Some(existing) = tokens.get(canvas_id) {
            return Ok(existing.clone());
        }
        let token = generate_token()?;
        tokens.insert(canvas_id.to_string(), token.clone());
        Ok(token)
    }

    pub fn revoke(&self, canvas_id: &str) {
        self.by_canvas.lock().remove(canvas_id);
    }

    pub fn is_issued(&self, canvas_id: &str) -> bool {
        self.by_canvas.lock().contains_key(canvas_id)
    }

    /// Constant-time check of the `ct` query token, then of any per-canvas
    /// cookie. A browser holding both a stale and a current cookie of the
    /// same name sends both, so every value is tried.
    pub fn authorize(&self, canvas_id: &str, query: Option<&str>, headers: &HeaderMap) -> Access {
        let tokens = self.by_canvas.lock();
        let Some(token) = tokens.get(canvas_id) else {
            return Access::Denied;
        };
        let matches = |presented: &str| -> bool {
            !presented.is_empty() && token.as_bytes().ct_eq(presented.as_bytes()).into()
        };
        if query_param(query, "ct").is_some_and(matches) {
            return Access::Query;
        }
        let name = canvas_cookie_name(canvas_id);
        if cookie_values(headers, &name).any(matches) {
            return Access::Cookie;
        }
        Access::Denied
    }

    fn session_cookie(&self, canvas_id: &str, policy: CookiePolicy) -> Option<HeaderValue> {
        let token = self.by_canvas.lock().get(canvas_id)?.clone();
        HeaderValue::from_str(&format!(
            "{}={token}; Path=/canvas/{canvas_id}/; {}",
            canvas_cookie_name(canvas_id),
            policy.attributes()
        ))
        .ok()
    }
}

pub fn bundle_tokens() -> &'static BundleTokens {
    static TOKENS: OnceLock<BundleTokens> = OnceLock::new();
    TOKENS.get_or_init(BundleTokens::default)
}

/// Where the renderer loads the bundle from, and which bundle the host
/// expects. `base_url` is empty on the web (same-origin).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CanvasBundleBase {
    pub base_url: String,
    pub pin_tag: String,
}

pub fn same_origin_base() -> CanvasBundleBase {
    CanvasBundleBase {
        base_url: String::new(),
        pin_tag: pinned_tag().to_string(),
    }
}

/// What the renderer needs to mount a project's canvas: it builds the iframe
/// URL `<baseUrl>/canvas/<canvasId>/?embed=kiosk&ct=<canvasToken>&ho=..&ms=<mountSeq>`
/// itself. No `Debug`: the token must never reach a log line.
#[derive(Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CanvasOpenInfo {
    pub canvas_id: String,
    pub base_url: String,
    pub canvas_token: String,
    pub pin_tag: String,
    pub doc_key: String,
    /// The new mount's sequence number (persistence registry); every bridge
    /// envelope and persistence call for this mount carries it.
    pub mount_seq: u64,
}

/// Mint (or reuse) the project's bundle token and start a new persistence
/// mount for the document. Shared by `canvas_open` and `POST /canvas/open`,
/// which differ only in the base they pass.
pub fn open_canvas(
    base: CanvasBundleBase,
    project_id: &str,
    doc_key: String,
    autosave_ms: Option<u64>,
) -> Result<CanvasOpenInfo, CanvasError> {
    let canvas_id = canvas_id_for_project(project_id);
    let canvas_token = bundle_tokens().issue(&canvas_id).map_err(|reason| {
        CanvasError::new(
            CODE_TOKEN_GENERATION_FAILED,
            format!("failed to mint the canvas session token: {reason}"),
        )
    })?;
    let mount_seq = canvas_mounts().mount(
        project_id,
        PathBuf::from(&doc_key),
        autosave_delay(autosave_ms),
    );
    Ok(CanvasOpenInfo {
        canvas_id,
        base_url: base.base_url,
        canvas_token,
        pin_tag: base.pin_tag,
        doc_key,
        mount_seq,
    })
}

/// Unmount the project's canvas through the AD-31 sequence (quiesce, save,
/// verify, unmount), then revoke its bundle token so the iframe URL and
/// cookie stop authorizing. Shared by `canvas_close` and `POST /canvas/close`.
/// Idempotent. A failed save keeps the mount and the token: the caller asks
/// the user, who retries or closes again with [`CloseMode::Discard`].
///
/// # Errors
/// `SAVE_FAILED` or `CANVAS_CLOSING` from the sequence.
pub async fn close_canvas(project_id: &str, mode: CloseMode) -> Result<CloseOutcome, CanvasError> {
    let outcome = canvas_mounts().close(project_id, mode).await?;
    bundle_tokens().revoke(&canvas_id_for_project(project_id));
    Ok(outcome)
}

/// How long app exit waits for the canvases to save before moving on.
pub const EXIT_FLUSH_BOUND: Duration = Duration::from_secs(5);

/// [`close_all_canvases`] bounded by [`EXIT_FLUSH_BOUND`], so an unresponsive
/// renderer cannot hold the rest of the exit cleanup.
pub async fn close_all_canvases_bounded() {
    if canvas_mounts().mounted_projects().is_empty() {
        return;
    }
    if tokio::time::timeout(EXIT_FLUSH_BOUND, close_all_canvases())
        .await
        .is_err()
    {
        log::error!(
            "[canvas] exit: canvases still saving after {}s; exiting without them",
            EXIT_FLUSH_BOUND.as_secs()
        );
    }
}

/// App exit (desktop quit, termul-server shutdown): save and unmount every
/// canvas, each through the AD-31 sequence. Nobody is left to ask at this
/// point, so a failed save is logged by project; the renderer's quit flow
/// asks the user before it gets here.
pub async fn close_all_canvases() -> usize {
    let closed = canvas_mounts().close_all().await;
    let mut failed = 0;
    for (project_id, result) in &closed {
        match result {
            Ok(outcome) => {
                bundle_tokens().revoke(&canvas_id_for_project(project_id));
                log::info!(
                    "[canvas] exit: closed project_id={} saved={} discarded={}",
                    crate::commands::sanitize_log_field(project_id),
                    outcome.saved_version.as_deref().unwrap_or("none"),
                    outcome.discarded
                );
            }
            Err(error) => {
                failed += 1;
                log::error!(
                    "[canvas] exit: unsaved canvas changes could not be saved project_id={} code={}: {}",
                    crate::commands::sanitize_log_field(project_id),
                    error.code,
                    error.message
                );
            }
        }
    }
    failed
}

/// `/canvas/<id>` is `(id, None)`; `/canvas/<id>/a/b` is `(id, Some("a/b"))`.
fn split_canvas_path(path: &str) -> Option<(&str, Option<&str>)> {
    let rest = path.strip_prefix("/canvas/")?;
    let (id, tail) = match rest.split_once('/') {
        Some((id, tail)) => (id, Some(tail)),
        None => (rest, None),
    };
    (!id.is_empty()).then_some((id, tail))
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({
            "success": false,
            "error": "canvas session token missing or invalid",
            "code": "UNAUTHORIZED",
        })),
    )
        .into_response()
}

/// Gate and serve one `/canvas/<id>[/...]` request from the bundle.
pub fn serve_bundle(
    policy: CookiePolicy,
    method: &Method,
    uri: &Uri,
    headers: &HeaderMap,
) -> Response {
    let Some((canvas_id, tail)) = split_canvas_path(uri.path()) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let tokens = bundle_tokens();
    let access = tokens.authorize(canvas_id, uri.query(), headers);
    if !access.granted() {
        log::warn!(
            "[canvas] bundle request rejected: missing or invalid session token path={}",
            uri.path()
        );
        return unauthorized();
    }

    let mut response = match tail {
        None => {
            let query = uri.query().map(|q| format!("?{q}")).unwrap_or_default();
            let mut redirect = StatusCode::PERMANENT_REDIRECT.into_response();
            if let Ok(location) = HeaderValue::from_str(&format!("/canvas/{canvas_id}/{query}")) {
                redirect.headers_mut().insert(header::LOCATION, location);
            }
            redirect
        }
        Some(_) if !assets::canvas_bundle_available() => {
            log_bundle_missing_once();
            assets::canvas_bundle_missing_response()
        }
        Some(path) => assets::canvas_bundle_response(method, path, headers),
    };
    if access == Access::Query {
        if let Some(cookie) = tokens.session_cookie(canvas_id, policy) {
            response.headers_mut().append(header::SET_COOKIE, cookie);
        }
    }
    response
}

fn log_bundle_missing_once() {
    static LOGGED: AtomicBool = AtomicBool::new(false);
    if !LOGGED.swap(true, Ordering::Relaxed) {
        log::warn!(
            "[canvas] figcraft bundle is not available in this build; \
             run scripts/canvas/fetch-figcraft-bundle.mjs"
        );
    }
}

/// Startup diagnostic shared by the desktop and `termul-server`.
pub fn log_bundle_status() {
    if assets::canvas_bundle_available() {
        log::info!(
            "[canvas] figcraft bundle available pin_tag={}",
            pinned_tag()
        );
    } else {
        log_bundle_missing_once();
    }
}

async fn desktop_bundle_handler(method: Method, uri: Uri, headers: HeaderMap) -> Response {
    serve_bundle(CookiePolicy::EmbeddedLoopback, &method, &uri, &headers)
}

/// The loopback listener's whole route set.
pub fn bundle_router() -> Router {
    Router::new()
        .route("/canvas/{id}", any(desktop_bundle_handler))
        .route("/canvas/{id}/", any(desktop_bundle_handler))
        .route("/canvas/{id}/{*rest}", any(desktop_bundle_handler))
}

/// Supervisor of the desktop loopback listener. Drive [`StaticServer::run`]
/// on the runtime; read the live address through [`StaticServer::base`].
pub struct StaticServer {
    bound: watch::Sender<Option<SocketAddr>>,
    drop_listener: watch::Sender<u64>,
    stop: CancellationToken,
    binds: AtomicU64,
}

impl StaticServer {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            bound: watch::channel(None).0,
            drop_listener: watch::channel(0).0,
            stop: CancellationToken::new(),
            binds: AtomicU64::new(0),
        })
    }

    pub fn addr(&self) -> Option<SocketAddr> {
        *self.bound.borrow()
    }

    /// `None` while the listener is down or rebinding.
    pub fn base(&self) -> Option<CanvasBundleBase> {
        self.addr().map(|addr| CanvasBundleBase {
            base_url: format!("http://{addr}"),
            pin_tag: pinned_tag().to_string(),
        })
    }

    /// The base once the listener is up, waiting up to `timeout` (app startup
    /// binds asynchronously, so an early renderer query must not see `None`).
    pub async fn wait_for_base(&self, timeout: Duration) -> Option<CanvasBundleBase> {
        let mut rx = self.bound.subscribe();
        let _ = tokio::time::timeout(timeout, rx.wait_for(Option::is_some)).await;
        self.base()
    }

    /// Close the live listener; the supervisor rebinds on a new port.
    pub fn drop_listener(&self) {
        self.drop_listener
            .send_modify(|generation| *generation += 1);
    }

    pub fn shutdown(&self) {
        self.stop.cancel();
    }

    pub fn bind_count(&self) -> u64 {
        self.binds.load(Ordering::Relaxed)
    }

    /// Bind, serve, and rebind whenever the listener ends, until shutdown.
    pub async fn run(self: Arc<Self>) {
        let mut backoff = RESTART_BACKOFF_MIN;
        while !self.stop.is_cancelled() {
            let listener = match TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await {
                Ok(listener) => listener,
                Err(err) => {
                    log::error!(
                        "[canvas] bundle listener bind failed: {err}; retrying in {backoff:?}"
                    );
                    tokio::select! {
                        () = tokio::time::sleep(backoff) => {}
                        () = self.stop.cancelled() => {}
                    }
                    backoff = (backoff * 2).min(RESTART_BACKOFF_MAX);
                    continue;
                }
            };
            backoff = RESTART_BACKOFF_MIN;
            let Ok(addr) = listener.local_addr() else {
                continue;
            };
            let restart = self.binds.fetch_add(1, Ordering::Relaxed) > 0;
            log::info!(
                "[canvas] bundle listener {} on {addr}",
                if restart { "restarted" } else { "started" }
            );

            let mut dropped = self.drop_listener.subscribe();
            let stop = self.stop.clone();
            let served = tokio::spawn(async move {
                axum::serve(listener, bundle_router())
                    .with_graceful_shutdown(async move {
                        tokio::select! {
                            () = stop.cancelled() => {}
                            _ = dropped.changed() => {}
                        }
                    })
                    .await
            });
            self.bound.send_replace(Some(addr));
            let outcome = served.await;
            self.bound.send_replace(None);
            if self.stop.is_cancelled() {
                break;
            }
            match outcome {
                Ok(Ok(())) => log::warn!("[canvas] bundle listener on {addr} closed; rebinding"),
                Ok(Err(err)) => {
                    log::warn!("[canvas] bundle listener on {addr} failed: {err}; rebinding")
                }
                Err(err) => {
                    log::error!("[canvas] bundle listener on {addr} crashed: {err}; rebinding")
                }
            }
        }
    }
}
