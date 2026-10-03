//! Canvas Tauri commands (OpenPencil canvas mode). Mirrors the web routes in
//! `web/canvas_api.rs` — same `IpcResult` envelope, same typed codes.
//!
//! All lifecycle goes through the shared [`CanvasDaemonPool`] (managed in
//! `lib.rs`); `AppHandle` is used ONLY here (main-window URL origin for
//! `--allow-origin`, agentation port for the stable MCP URL) — the pool
//! itself stays Tauri-free so `termul-server` composes it too. The pure
//! assembly helpers ([`window_origin_from_url`], [`agentation_scoped_mcp_url`],
//! [`open_info_for_daemon`], [`open_failure`]) are extracted so they are
//! unit-testable without an `AppHandle`/pool.

use std::sync::Arc;

use tauri::{AppHandle, Manager, State};

use super::{sanitize_log_field, validate_project_path, IpcResult};
use crate::canvas::mcp_proxy;
use crate::canvas::pool::CanvasDaemonPool;
use crate::canvas::{CanvasOpenInfo, CanvasStatus, CanvasError, CODE_DAEMON_DOWN};

/// Serialize a webview URL's origin manually (`scheme://host[:port]`) so
/// opaque custom schemes (`tauri://localhost`) still produce a usable
/// string — `url::Origin::ascii_serialization` would render them as the
/// literal "null". Carried to the daemon as the exact-string
/// `--allow-origin` value.
fn window_origin_from_url(url: &tauri::Url) -> String {
    let scheme = url.scheme();
    let host = url.host_str().unwrap_or("localhost");
    match url.port() {
        Some(port) => format!("{scheme}://{host}:{port}"),
        None => format!("{scheme}://{host}"),
    }
}

/// The main webview's origin, carried to the daemon as `--allow-origin`
/// (exact string). Falls back to the production Windows/Linux webview
/// origin when the window/URL is unavailable.
fn main_window_origin(app: &AppHandle) -> String {
    app.get_webview_window("main")
        .and_then(|window| window.url().ok())
        .map(|url| window_origin_from_url(&url))
        .unwrap_or_else(|| "http://tauri.localhost".to_string())
}

/// Pure: the per-project stable MCP URL on the desktop agentation server —
/// `http://127.0.0.1:<port>/canvas/<canvasId>/mcp`. Id-scoped so agents of
/// project A never route to project B's canvas; the canvas id is
/// deterministic per project, so the URL stays stable across re-opens.
fn agentation_scoped_mcp_url(port: u16, project_id: &str) -> String {
    format!(
        "http://127.0.0.1:{port}/canvas/{}/mcp",
        crate::canvas::canvas_id_for_project(project_id)
    )
}

/// Stable Termul-proxied MCP URL from the desktop agentation server's
/// dynamic port; `None` when the agentation service failed to start (the
/// renderer skips the MCP entry upsert then).
fn agentation_mcp_url(app: &AppHandle, project_id: &str) -> Option<String> {
    app.try_state::<crate::agentation::AgentationService>()
        .map(|service| agentation_scoped_mcp_url(service.http_port(), project_id))
}

/// Pure: assemble the desktop `CanvasOpenInfo` for a live daemon (loopback
/// embed URL with raw-concat `?embed=vscode` — never URL-encoded). The
/// desktop canvas token IS the daemon's managed (handshake) token: the
/// renderer/agents present it as the `Authorization: Bearer` credential on
/// the agentation `/canvas(/<canvasId>)/mcp` mounts.
fn open_info_for_daemon(
    daemon: &crate::canvas::managed::CanvasDaemon,
    mcp_url: Option<String>,
) -> CanvasOpenInfo {
    CanvasOpenInfo {
        embed_url: format!("http://127.0.0.1:{}/?embed=vscode", daemon.port),
        mcp_url,
        doc_key: daemon.doc_key.clone(),
        canvas_id: None,
        canvas_token: Some(daemon.managed_token().to_string()),
    }
}

/// Pure: map a typed pool error onto the command's `IpcResult` failure
/// envelope (stable code preserved verbatim — the renderer switches on it).
fn open_failure(err: &CanvasError) -> IpcResult<CanvasOpenInfo> {
    IpcResult::error(err.message.clone(), err.code.clone())
}

/// `canvas_open { docPath, projectId }` — spawn (or reuse) the doc's managed
/// daemon and return the loopback embed URL plus the id-scoped stable MCP
/// URL.
#[tauri::command]
pub async fn canvas_open(
    app: AppHandle,
    doc_path: String,
    project_id: String,
    pool: State<'_, Arc<CanvasDaemonPool>>,
) -> Result<IpcResult<CanvasOpenInfo>, String> {
    let validated = validate_and_stringify!(&doc_path);
    let log_project_id = sanitize_log_field(&project_id);
    log::info!("[canvas] open start project_id={log_project_id}");
    let allow_origin = main_window_origin(&app);
    match pool.acquire(&validated, &allow_origin, &project_id).await {
        Ok(daemon) => {
            log::info!(
                "[canvas] open success project_id={log_project_id} port={}",
                daemon.port
            );
            Ok(IpcResult::success(open_info_for_daemon(
                &daemon,
                agentation_mcp_url(&app, &project_id),
            )))
        }
        Err(err) => {
            log::warn!(
                "[canvas] open failed project_id={log_project_id} code={}",
                err.code
            );
            Ok(open_failure(&err))
        }
    }
}

/// `canvas_close { docPath }` — evict the doc's daemon (stdin EOF → kill).
/// Idempotent: closing an unopened canvas is a success.
#[tauri::command]
pub async fn canvas_close(
    doc_path: String,
    pool: State<'_, Arc<CanvasDaemonPool>>,
) -> Result<IpcResult<bool>, String> {
    let validated = validate_and_stringify!(&doc_path);
    log::info!("[canvas] close start");
    pool.release(&validated).await;
    Ok(IpcResult::success(true))
}

/// `canvas_save { docPath }` — save through the daemon (`POST
/// /api/file/save`); the daemon is the `.op` document authority. No live
/// daemon → typed `DAEMON_DOWN` (the "canvas closed" signal).
#[tauri::command]
pub async fn canvas_save(
    doc_path: String,
    pool: State<'_, Arc<CanvasDaemonPool>>,
) -> Result<IpcResult<serde_json::Value>, String> {
    let validated = validate_and_stringify!(&doc_path);
    let Some(daemon) = pool.daemon_for_doc(&validated) else {
        log::warn!("[canvas] save with no live daemon");
        return Ok(IpcResult::error(
            "canvas daemon is not running",
            CODE_DAEMON_DOWN,
        ));
    };
    match mcp_proxy::daemon_save(daemon.as_ref()).await {
        Ok(value) => {
            log::info!("[canvas] save dispatched");
            Ok(IpcResult::success(value))
        }
        Err(err) => {
            log::warn!("[canvas] save failed code={}", err.code);
            Ok(IpcResult::error(err.message, err.code))
        }
    }
}

/// `canvas_status` — pool snapshot (live daemons + active doc key).
#[tauri::command]
pub async fn canvas_status(
    pool: State<'_, Arc<CanvasDaemonPool>>,
) -> Result<IpcResult<CanvasStatus>, String> {
    Ok(IpcResult::success(pool.status()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_origin_serializes_http_with_port() {
        let url = tauri::Url::parse("http://localhost:5180/tauri-index.html").unwrap();
        assert_eq!(window_origin_from_url(&url), "http://localhost:5180");
    }

    #[test]
    fn window_origin_serializes_scheme_without_port() {
        let url = tauri::Url::parse("https://example.com/some/path").unwrap();
        assert_eq!(window_origin_from_url(&url), "https://example.com");
    }

    #[test]
    fn window_origin_handles_opaque_custom_schemes() {
        // macOS webviews run on `tauri://localhost` — `url::Origin` would
        // serialize opaque schemes as "null"; the manual form must not.
        let url = tauri::Url::parse("tauri://localhost/index.html").unwrap();
        assert_eq!(window_origin_from_url(&url), "tauri://localhost");
    }

    #[test]
    fn agentation_mcp_url_is_id_scoped_and_stable() {
        let url = agentation_scoped_mcp_url(43123, "proj-7");
        let expected_id = crate::canvas::canvas_id_for_project("proj-7");
        assert_eq!(
            url,
            format!("http://127.0.0.1:43123/canvas/{expected_id}/mcp")
        );
        // Deterministic per project → stable across re-opens.
        assert_eq!(url, agentation_scoped_mcp_url(43123, "proj-7"));
        assert_ne!(url, agentation_scoped_mcp_url(43123, "proj-8"));
    }

    #[test]
    fn open_info_builds_loopback_embed_url_with_managed_token() {
        let daemon =
            crate::canvas::managed::synthetic_daemon("doc", 45111, "http://tauri.localhost");
        let info = open_info_for_daemon(&daemon, Some("http://127.0.0.1:1/canvas/cvx/mcp".into()));
        assert_eq!(info.embed_url, "http://127.0.0.1:45111/?embed=vscode");
        assert_eq!(info.mcp_url.as_deref(), Some("http://127.0.0.1:1/canvas/cvx/mcp"));
        assert_eq!(info.doc_key, "doc");
        // Desktop embeds the daemon URL directly: no proxy id. The canvas
        // token IS the daemon managed token (the MCP bearer credential).
        assert_eq!(info.canvas_id, None);
        assert_eq!(
            info.canvas_token.as_deref(),
            Some(daemon.managed_token()),
            "canvasToken carries the managed token for the MCP bearer"
        );
    }

    #[test]
    fn open_failure_maps_typed_codes_verbatim() {
        for (code, message) in [
            ("BINARY_NOT_FOUND", "op-host-web-server binary not found"),
            ("HANDSHAKE_TIMEOUT", "daemon handshake not received"),
            ("PATH_VALIDATION_FAILED", "doc path outside the boundary"),
        ] {
            let err = CanvasError::new(code, message);
            let result = open_failure(&err);
            assert!(!result.success);
            assert_eq!(result.code.as_deref(), Some(code), "code {code}");
            assert_eq!(result.error.as_deref(), Some(message));
            assert!(result.data.is_none());
        }
    }
}
