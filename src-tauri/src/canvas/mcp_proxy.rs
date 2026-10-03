//! Shared HTTP proxy to the active canvas daemon — mounted at every surface
//! (desktop agentation `/canvas/mcp` + `/canvas/<id>/mcp`; termul-server
//! `/canvas/mcp` + `/canvas/<id>/*` + the root canvas routes `/pkg|canvaskit|
//! /api`).
//!
//! Rules (AD-8):
//! - the daemon is always reached over loopback only; remote clients never
//!   see its port;
//! - the client `Origin`/`Cookie` headers are stripped (reqwest sends none),
//!   so the daemon's native-client path applies for proxied traffic;
//! - hop-by-hop headers are stripped both ways;
//! - the `ct` canvas session token is stripped from the forwarded query
//!   string (the daemon may log URLs — the token never reaches it);
//! - response bodies stream via reqwest `Body::from_stream` — SSE
//!   (`/api/mcp/events`, 15s heartbeat) must stream, not buffer, and is
//!   never subject to a timeout;
//! - path-proxy REQUEST bodies: GET/HEAD (the dominant canvas traffic —
//!   bundle, canvaskit, API reads, SSE) send no body at all. Body-carrying
//!   methods buffer under a 32 MiB cap. Why not stream them: the OpenPencil
//!   daemon parses request bodies via `Content-Length` ONLY (its
//!   hand-rolled HTTP/1.1 reader does not decode chunked transfer
//!   encoding), so a forwarded body must always declare a length — and the
//!   two streaming options cannot provide one: `Body::wrap_stream` forces
//!   chunked encoding (misparse), and `reqwest::Body::wrap(axum_body)`
//!   (which propagates the exact size hint) is unavailable because the
//!   axum request body is `Send`-only, not `Sync`. The buffer is the
//!   documented fallback the daemon's parser dictates. The MCP POST
//!   forward buffers for the same framing reason (plus: JSON-RPC payloads
//!   are small and the cap bounds hostile proxy memory).
//! - request completion (send + response headers) is bounded by a 30s
//!   timeout → typed `DAEMON_DOWN`-family error; only the streamed response
//!   BODY may run past it (SSE streams for the canvas session lifetime).

use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Duration;

use axum::body::Body;
use axum::extract::Request;
use axum::http::header::HeaderMap;
use axum::http::HeaderName;
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use super::managed::CanvasDaemon;
use super::{CanvasError, CODE_DAEMON_DOWN, CODE_SAVE_FAILED};

/// Cap for the buffered request bodies (path-proxy body-carrying methods +
/// the MCP JSON-RPC forward) — see the module doc for the framing
/// rationale.
const MAX_FORWARDED_BODY: usize = 32 * 1024 * 1024;

/// Deadline for request completion (send + response HEADERS) on every
/// forwarded call. A stalled daemon surfaces as a typed `DAEMON_DOWN`-family
/// error instead of a hung request. The streamed response body is NOT
/// bounded by this — SSE must stream indefinitely.
const PROXY_TIMEOUT: Duration = Duration::from_secs(30);

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            // No client timeout: SSE responses stay open for the canvas
            // session lifetime (completion deadlines are enforced per
            // request by PROXY_TIMEOUT around `send()`).
            .build()
            .expect("canvas proxy reqwest client builds")
    })
}

/// Headers never forwarded in either direction: hop-by-hop headers, the
/// framing headers axum/hyper recompute, plus `Origin`/`Cookie` — the proxy
/// speaks to the daemon as a native (originless) client by design.
fn is_stripped_header(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "host"
            | "content-length"
            | "origin"
            | "cookie"
    )
}

fn copy_forwardable_headers(
    mut builder: reqwest::RequestBuilder,
    headers: &HeaderMap,
) -> reqwest::RequestBuilder {
    for (name, value) in headers.iter() {
        if !is_stripped_header(name) {
            builder = builder.header(name, value.clone());
        }
    }
    builder
}

/// Rebuild a query string without the `ct` canvas session token (the daemon
/// may log URLs — the token must never reach it). All other params are kept
/// verbatim; `Some` only when at least one param survives.
fn strip_canvas_token_query(query: Option<&str>) -> Option<String> {
    let query = query?;
    let kept: Vec<&str> = query
        .split('&')
        .filter(|pair| {
            let key = pair.split_once('=').map_or(*pair, |(name, _)| name);
            key != "ct"
        })
        .collect();
    (!kept.is_empty()).then(|| kept.join("&"))
}

/// Typed 502 the renderer surfaces as "canvas closed" (IpcBody failure
/// shape; HTTP 200 is NOT used here — the proxy surface uses real status
/// codes for transport state, unlike the app-level IpcBody routes).
fn daemon_down_response(message: &str) -> Response {
    (
        StatusCode::BAD_GATEWAY,
        axum::Json(json!({
            "success": false,
            "error": message,
            "code": CODE_DAEMON_DOWN,
        })),
    )
        .into_response()
}

/// Serialize a typed proxy [`CanvasError`] onto the wire (same shape as
/// [`daemon_down_response`], carrying the error's own code and message).
fn canvas_error_response(err: CanvasError) -> Response {
    (
        StatusCode::BAD_GATEWAY,
        axum::Json(json!({
            "success": false,
            "error": err.message,
            "code": err.code,
        })),
    )
        .into_response()
}

/// Map a reqwest response onto an axum response, streaming the body
/// (`Body::from_stream`) so SSE and large bundles never buffer.
async fn response_from_reqwest(resp: reqwest::Response) -> Response {
    let status = StatusCode::from_u16(resp.status().as_u16())
        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut builder = Response::builder().status(status);
    for (name, value) in resp.headers().iter() {
        if !is_stripped_header(name) {
            builder = builder.header(name, value.clone());
        }
    }
    match builder.body(Body::from_stream(resp.bytes_stream())) {
        Ok(response) => response,
        Err(_) => daemon_down_response("failed to build canvas proxy response"),
    }
}

/// Await a forwarded request's completion (send + response headers) under
/// [`PROXY_TIMEOUT`]. A timeout is a typed `DAEMON_DOWN` error (the daemon
/// stalled); the streamed body that follows is never timed out. Callers
/// serialize the error via [`canvas_error_response`].
async fn send_with_timeout(
    builder: reqwest::RequestBuilder,
    failure_prefix: &str,
) -> Result<reqwest::Response, CanvasError> {
    match tokio::time::timeout(PROXY_TIMEOUT, builder.send()).await {
        Err(_) => {
            log::warn!("[canvas] {failure_prefix} timed out after {}s", PROXY_TIMEOUT.as_secs());
            Err(CanvasError::new(
                CODE_DAEMON_DOWN,
                format!(
                    "{failure_prefix} timed out after {}s (daemon stalled?)",
                    PROXY_TIMEOUT.as_secs()
                ),
            ))
        }
        Ok(Err(err)) => {
            log::warn!("[canvas] {failure_prefix} failed: {err}");
            Err(CanvasError::new(
                CODE_DAEMON_DOWN,
                format!("{failure_prefix} failed: {err}"),
            ))
        }
        Ok(Ok(resp)) => Ok(resp),
    }
}

/// Proxy the stable MCP endpoint: `POST` → daemon `POST /mcp` (status,
/// headers, and body passed through); any other method → 405 (mirroring the
/// daemon's own `GET /mcp` behavior); no active daemon → typed 502
/// `DAEMON_DOWN`.
///
/// The request body is buffered under [`MAX_FORWARDED_BODY`] (JSON-RPC
/// payloads are small and bounded; the cap bounds hostile proxy memory) —
/// see the module doc for the one-buffered-route rationale.
pub async fn proxy_mcp_request(daemon: Option<&Arc<CanvasDaemon>>, request: Request) -> Response {
    if request.method() != Method::POST {
        return (
            StatusCode::METHOD_NOT_ALLOWED,
            axum::Json(json!({
                "ok": false,
                "error": "Method not allowed. POST a JSON-RPC message to /mcp.",
            })),
        )
            .into_response();
    }
    let Some(daemon) = daemon else {
        log::debug!("[canvas] MCP proxy request with no active daemon");
        return daemon_down_response("canvas daemon is not running");
    };
    let (parts, body) = request.into_parts();
    let bytes = match axum::body::to_bytes(body, MAX_FORWARDED_BODY).await {
        Ok(bytes) => bytes,
        Err(err) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(json!({
                    "success": false,
                    "error": format!("failed to read MCP request body: {err}"),
                    "code": "BAD_REQUEST",
                })),
            )
                .into_response()
        }
    };
    let url = format!("http://127.0.0.1:{}/mcp", daemon.port);
    let forwarded = copy_forwardable_headers(client().post(&url), &parts.headers);
    match send_with_timeout(forwarded.body(bytes.to_vec()), "canvas MCP proxy").await {
        Ok(resp) => response_from_reqwest(resp).await,
        Err(err) => canvas_error_response(err),
    }
}

/// Proxy an arbitrary daemon path (same-origin embed surface: `/pkg/*`,
/// `/canvaskit/*`, REST `/api/*`, SSE `/api/mcp/events`). `subpath` is the
/// raw (still percent-encoded) daemon path; the request's query string is
/// forwarded with the `ct` canvas session token REMOVED (never reaches the
/// daemon) and every other param verbatim. GET/HEAD send no request body;
/// body-carrying methods buffer under [`MAX_FORWARDED_BODY`] — the daemon's
/// Content-Length-only parser dictates the framing (see the module doc).
/// No daemon → typed 502.
pub async fn proxy_canvas_path(
    daemon: Option<&Arc<CanvasDaemon>>,
    request: Request,
    subpath: &str,
) -> Response {
    let Some(daemon) = daemon else {
        return daemon_down_response("canvas daemon is not running");
    };
    let (parts, body) = request.into_parts();
    let query = strip_canvas_token_query(parts.uri.query());
    let url = format!(
        "http://127.0.0.1:{}{}{}",
        daemon.port,
        subpath,
        query.map(|q| format!("?{q}")).unwrap_or_default()
    );
    let method = parts.method.clone();
    let forwarded = copy_forwardable_headers(client().request(parts.method, &url), &parts.headers);
    // GET/HEAD carry no body semantics — send nothing (a zero-length
    // streaming body would force chunked encoding, which the daemon does
    // not parse). Other methods buffer so hyper frames the forward with an
    // exact Content-Length.
    let completion = if matches!(method, Method::GET | Method::HEAD) {
        send_with_timeout(forwarded, "canvas proxy").await
    } else {
        match axum::body::to_bytes(body, MAX_FORWARDED_BODY).await {
            Ok(bytes) => {
                send_with_timeout(forwarded.body(bytes.to_vec()), "canvas proxy").await
            }
            Err(err) => {
                return (
                    StatusCode::BAD_REQUEST,
                    axum::Json(json!({
                        "success": false,
                        "error": format!("failed to read canvas request body: {err}"),
                        "code": "BAD_REQUEST",
                    })),
                )
                    .into_response()
            }
        }
    };
    match completion {
        Ok(resp) => response_from_reqwest(resp).await,
        Err(err) => canvas_error_response(err),
    }
}

/// Save the daemon's document (`POST /api/file/save`) — the daemon is the
/// `.op` document authority; Termul never writes `.op` files. Returns the
/// daemon's JSON reply (success or version-conflict marker) for the caller
/// to surface; transport/protocol failures and timeouts are typed errors.
pub async fn daemon_save(daemon: &CanvasDaemon) -> Result<serde_json::Value, CanvasError> {
    let url = format!("http://127.0.0.1:{}/api/file/save", daemon.port);
    let request = client()
        .post(&url)
        .header("content-type", "application/json")
        .body("{}");
    let resp = match tokio::time::timeout(PROXY_TIMEOUT, request.send()).await {
        Err(_) => {
            log::warn!(
                "[canvas] save request timed out after {}s",
                PROXY_TIMEOUT.as_secs()
            );
            return Err(CanvasError::new(
                CODE_DAEMON_DOWN,
                format!(
                    "canvas save timed out after {}s (daemon stalled?)",
                    PROXY_TIMEOUT.as_secs()
                ),
            ));
        }
        Ok(Err(err)) => {
            log::warn!("[canvas] save request failed: {err}");
            return Err(CanvasError::new(
                CODE_DAEMON_DOWN,
                format!("canvas save failed: {err}"),
            ));
        }
        Ok(Ok(resp)) => resp,
    };
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|err| CanvasError::new(CODE_SAVE_FAILED, format!("canvas save body: {err}")))?;
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|_| {
        CanvasError::new(
            CODE_SAVE_FAILED,
            format!("canvas save returned a non-JSON body (status {status})"),
        )
    })?;
    log::info!("[canvas] save request dispatched status={status}");
    Ok(value)
}
