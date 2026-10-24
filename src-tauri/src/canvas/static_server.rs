//! Serves the figcraft web bundle at `/canvas/<id>/` (spine AD-22).
//!
//! One gate, one serving function, two listeners:
//! - the desktop binds [`StaticServer`] on `127.0.0.1:0` (OS-assigned port,
//!   rebuilt when the listener dies) and the renderer iframes it;
//! - `termul-server` (and the desktop's shared-live server) mount the same
//!   [`serve_bundle`] under `web::canvas_api` and the iframe is same-origin.
//!
//! Authorization is per canvas: the canvas token is the path segment after
//! the canvas id, `/canvas/<id>/<token>/...`, so the bundle's relative
//! sub-resource URLs carry it as well. A cookie cannot do this on the
//! desktop: the loopback iframe is a cross-site frame inside the app
//! webview, and WKWebView and WebKitGTK drop third-party cookies by default.
//! The token is never logged.

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

use super::fallback_fonts;
use super::persistence::{
    autosave_delay, autosave_max_wait, canvas_mounts, crash_timeouts, lease_grace, mount_cap,
    CloseMode, CloseOutcome, Eviction, LeaseChange, MountRequest, RendererId,
};
use super::pin::pinned_tag;
use super::{canvas_id_for_project, CanvasError, CODE_TOKEN_GENERATION_FAILED};
use crate::web::assets;

/// Typed error for a renderer query while the desktop listener is not bound.
pub const CODE_BUNDLE_LISTENER_DOWN: &str = "BUNDLE_LISTENER_DOWN";

const RESTART_BACKOFF_MIN: Duration = Duration::from_millis(250);
const RESTART_BACKOFF_MAX: Duration = Duration::from_secs(5);

/// A fresh 32-hex-char token from the OS CSPRNG. Never logged.
pub fn generate_token() -> Result<String, &'static str> {
    let mut raw = [0u8; 16];
    getrandom::getrandom(&mut raw).map_err(|_| "CSPRNG failure")?;
    Ok(raw.iter().map(|byte| format!("{byte:02x}")).collect())
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

    /// Constant-time check of the token a bundle path presents.
    pub fn authorize(&self, canvas_id: &str, presented: &str) -> bool {
        let tokens = self.by_canvas.lock();
        tokens.get(canvas_id).is_some_and(|token| {
            !presented.is_empty() && token.as_bytes().ct_eq(presented.as_bytes()).into()
        })
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
    /// Font URLs, relative to the bundle page, for `host.fallbackFonts`.
    /// Only the desktop loopback listener serves any ([`fallback_fonts`]).
    pub fallback_fonts: Vec<String>,
}

pub fn same_origin_base() -> CanvasBundleBase {
    CanvasBundleBase {
        base_url: String::new(),
        pin_tag: pinned_tag().to_string(),
        fallback_fonts: Vec::new(),
    }
}

/// What the renderer needs to mount a project's canvas: it builds the iframe
/// URL `<baseUrl>/canvas/<canvasId>/<canvasToken>/?embed=kiosk&ho=..&ms=<mountSeq>`
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
    /// Canvases this open unloaded to stay under `canvas.max_mounted` (AD-26),
    /// each saved first. The renderer shows them as unloaded.
    pub evicted: Vec<Eviction>,
    /// [`CanvasBundleBase::fallback_fonts`].
    pub fallback_fonts: Vec<String>,
}

/// What a renderer's open carries besides the document: the one shape both
/// transports accept, `canvas_open`'s `request` argument and the rest of
/// `POST /canvas/open`'s body. Every setting is optional; the host clamps it.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    /// The opening window or tab; it gets the lease.
    pub client_instance_id: String,
    /// `canvas.autosave_ms`.
    pub autosave_ms: Option<u64>,
    /// `canvas.autosave_max_ms`.
    pub autosave_max_ms: Option<u64>,
    /// `canvas.lease_grace_ms`.
    pub lease_grace_ms: Option<u64>,
    /// `canvas.max_mounted`.
    pub max_mounted: Option<u64>,
    /// `canvas.crash_timeouts`.
    pub crash_timeouts: Option<u32>,
}

/// Mint (or reuse) the project's bundle token and start a new persistence
/// mount for the document, leased to the opening renderer (AD-30). The least
/// recently active canvases beyond `max_mounted` are evicted first (AD-26),
/// and another renderer's mount of this project is saved and unmounted
/// first. Shared by `canvas_open` and `POST /canvas/open`, which differ only
/// in the base they pass.
///
/// # Errors
/// `INVALID_PAYLOAD` for a malformed `clientInstanceId`;
/// `EVICTION_BLOCKED` when a canvas that must make room could not be saved
/// (it stays mounted and nothing new mounts); `CANVAS_OPEN_ELSEWHERE` when
/// the renderer holding the lease could not save; `TOKEN_GENERATION_FAILED`.
pub async fn open_canvas(
    base: CanvasBundleBase,
    project_id: &str,
    doc_key: String,
    request: OpenRequest,
) -> Result<CanvasOpenInfo, CanvasError> {
    let canvas_id = canvas_id_for_project(project_id);
    let renderer_id = RendererId::parse(request.client_instance_id)?;
    let renderer = renderer_id.log_label();
    let cap = mount_cap(request.max_mounted);
    let admitted = canvas_mounts()
        .open(
            project_id,
            MountRequest {
                renderer: renderer_id,
                doc_path: PathBuf::from(&doc_key),
                autosave: autosave_delay(request.autosave_ms),
                autosave_max: autosave_max_wait(request.autosave_max_ms),
                lease_grace: lease_grace(request.lease_grace_ms),
                crash_timeouts: crash_timeouts(request.crash_timeouts),
            },
            cap,
        )
        .await;
    for eviction in &admitted.evicted {
        release_token(&eviction.project_id);
        log::info!(
            "[canvas] evicted project_id={} reason=\"{}\" max_mounted={cap} for project_id={}",
            crate::commands::sanitize_log_field(&eviction.project_id),
            eviction.reason,
            crate::commands::sanitize_log_field(project_id)
        );
    }
    let opened = admitted.opened.inspect_err(|error| {
        log::warn!(
            "[canvas] open refused project_id={} renderer={renderer}: {}: {}",
            crate::commands::sanitize_log_field(project_id),
            error.code,
            error.message
        );
    })?;
    log_lease_change(project_id, &renderer, opened.mount_seq, &opened.lease);
    let mount_seq = opened.mount_seq;
    let canvas_token = bundle_tokens().issue(&canvas_id).map_err(|reason| {
        canvas_mounts().unmount(project_id);
        CanvasError::new(
            CODE_TOKEN_GENERATION_FAILED,
            format!("failed to mint the canvas session token: {reason}"),
        )
    })?;
    Ok(CanvasOpenInfo {
        canvas_id,
        base_url: base.base_url,
        canvas_token,
        pin_tag: base.pin_tag,
        doc_key,
        mount_seq,
        evicted: admitted.evicted,
        fallback_fonts: base.fallback_fonts,
    })
}

fn log_lease_change(project_id: &str, renderer: &str, mount_seq: u64, change: &LeaseChange) {
    let project_id = crate::commands::sanitize_log_field(project_id);
    match change {
        LeaseChange::Granted => log::info!(
            "[canvas] lease granted project_id={project_id} renderer={renderer} mount_seq={mount_seq}"
        ),
        LeaseChange::Remounted { previous } => log::info!(
            "[canvas] lease kept by its renderer project_id={project_id} renderer={renderer} mount_seq={mount_seq} replaced={previous}"
        ),
        LeaseChange::TakenOver {
            previous,
            saved_version,
        } => log::info!(
            "[canvas] lease taken over project_id={project_id} renderer={renderer} mount_seq={mount_seq} from_mount_seq={previous} saved={}",
            saved_version.as_deref().unwrap_or("none")
        ),
    }
}

/// Unmount the renderer's mount `mount_seq` of the project through the AD-31
/// sequence (quiesce, save, verify, unmount), then revoke the project's
/// bundle token once no mount is left, so the iframe URL stops authorizing.
/// A mount a newer open replaced is not the project's mount any more: the
/// close leaves the newer one and its token alone. Shared by `canvas_close`
/// and `POST /canvas/close`. Idempotent. A failed save keeps the mount and
/// the token: the caller asks the user, who retries or closes again with
/// [`CloseMode::Discard`].
///
/// # Errors
/// `SAVE_FAILED` or `CANVAS_CLOSING` from the sequence.
pub async fn close_canvas(
    project_id: &str,
    mount_seq: u64,
    mode: CloseMode,
) -> Result<CloseOutcome, CanvasError> {
    let outcome = canvas_mounts()
        .close_mount(project_id, mount_seq, mode)
        .await?;
    release_token(project_id);
    Ok(outcome)
}

/// Revoke the project's bundle token unless it has a mount: an open reuses
/// the token, so revoking it under a live mount would lock out its iframe.
fn release_token(project_id: &str) {
    canvas_mounts().when_unmounted(project_id, || {
        bundle_tokens().revoke(&canvas_id_for_project(project_id));
    });
}

/// Close whatever the project has mounted; test cleanup.
#[cfg(test)]
pub(crate) async fn close_current_canvas(
    project_id: &str,
    mode: CloseMode,
) -> Result<CloseOutcome, CanvasError> {
    let outcome = canvas_mounts().close(project_id, mode).await?;
    release_token(project_id);
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
                release_token(project_id);
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

/// `/canvas/<id>/<token>[/<tail>]`. `tail` is `None` for the bare
/// `/canvas/<id>/<token>`, which redirects to its trailing-slash form so
/// relative URLs resolve under the token.
struct BundlePath<'a> {
    canvas_id: &'a str,
    token: &'a str,
    tail: Option<&'a str>,
}

impl<'a> BundlePath<'a> {
    fn parse(path: &'a str) -> Option<Self> {
        let (canvas_id, rest) = path.strip_prefix("/canvas/")?.split_once('/')?;
        let (token, tail) = match rest.split_once('/') {
            Some((token, tail)) => (token, Some(tail)),
            None => (rest, None),
        };
        (!canvas_id.is_empty() && !token.is_empty()).then_some(Self {
            canvas_id,
            token,
            tail,
        })
    }
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

/// Gate and serve one `/canvas/<id>/<token>[/...]` request from the bundle.
pub fn serve_bundle(method: &Method, uri: &Uri, headers: &HeaderMap) -> Response {
    let Some(path) = BundlePath::parse(uri.path())
        .filter(|path| bundle_tokens().authorize(path.canvas_id, path.token))
    else {
        log::warn!("[canvas] bundle request rejected: missing or invalid canvas token");
        return unauthorized();
    };
    match path.tail {
        None => {
            let query = uri.query().map(|q| format!("?{q}")).unwrap_or_default();
            let mut redirect = StatusCode::PERMANENT_REDIRECT.into_response();
            if let Ok(location) = HeaderValue::from_str(&format!(
                "/canvas/{}/{}/{query}",
                path.canvas_id, path.token
            )) {
                redirect.headers_mut().insert(header::LOCATION, location);
            }
            redirect
        }
        Some(_) if !assets::canvas_bundle_available() => {
            log_bundle_missing_once();
            assets::canvas_bundle_missing_response()
        }
        Some(tail) => assets::canvas_bundle_response(method, tail, headers),
    }
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
    let font = BundlePath::parse(uri.path())
        .filter(|path| bundle_tokens().authorize(path.canvas_id, path.token))
        .and_then(|path| path.tail?.strip_prefix(fallback_fonts::ROUTE));
    match font {
        Some(file) => fallback_fonts::response(&method, file).await,
        None => serve_bundle(&method, &uri, &headers),
    }
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
            fallback_fonts: fallback_fonts::urls(),
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
