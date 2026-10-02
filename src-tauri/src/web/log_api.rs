//! HTTP handler for frontend error forwarding (CAP-2: Web & Mobile 1:1 Parity).
//!
//! Mirrors the desktop `#[tauri::command] log_frontend_error` handler over
//! HTTP. The web client has no Tauri runtime to invoke the command; this route
//! lets the renderer forward errors to the server's log file so they survive a
//! closed DevTools console (same motivation as the desktop path, issue #244).
//!
//! - **Loopback-only:** like fs write routes, refused from non-loopback peers
//!   (`check_local_only`) so a LAN client cannot spam the server's log.
//! - **Sanitization:** reuses `crate::sanitize_log_field` (log-injection
//!   defense: newlines/CR/tab escaped, control chars stripped, truncated to
//!   `MAX_FRONTEND_FIELD_LEN`) so a crafted error message cannot forge
//!   authoritative-looking log lines.
//! - **Best-effort:** logging failure is swallowed — a failure to log must not
//!   cascade into another error (matching `log-api.ts` swallow semantics).
//! - **tracing:** the standalone server uses `tracing::error!`/`warn!` (NOT
//!   the `log` facade the desktop command uses) — the `web` module is the
//!   standalone boundary.

use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::Deserialize;

use crate::commands::sanitize_log_field;
use crate::web::fs_api::{check_local_only, IpcBody};
use crate::web::ws::AppState;

/// `POST /log/frontend-error` body. Mirrors the desktop
/// `log_frontend_error` command parameters (camelCase for JSON parity).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendErrorRequest {
    pub level: Option<String>,
    pub message: String,
    pub source: Option<String>,
    pub stack: Option<String>,
    pub component_stack: Option<String>,
}

/// `POST /log/frontend-error` — forward a renderer error to the server log.
/// Loopback-only (refused from non-loopback peers). Returns `IpcBody::ok(())`
/// on success; logging failures are swallowed (best-effort, no loop).
pub async fn frontend_error(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<FrontendErrorRequest>,
) -> impl IntoResponse {
    if let Some(forbidden) = check_local_only::<()>(
        peer,
        state.allow_remote_writes,
        state.shared_live_writes_denied,
        "/log/frontend-error",
    ) {
        return (StatusCode::OK, Json(forbidden));
    }

    let context = sanitize_log_field(&req.source.unwrap_or_else(|| "renderer".to_string()));
    let message = sanitize_log_field(&req.message);
    let stack_part = req
        .stack
        .map(|s| format!(" | stack: {}", sanitize_log_field(&s)))
        .unwrap_or_default();
    let component_part = req
        .component_stack
        .map(|s| format!(" | component stack: {}", sanitize_log_field(&s)))
        .unwrap_or_default();

    let line = format!("[frontend] [{context}] {message}{stack_part}{component_part}");

    match req.level.as_deref() {
        Some("warn") => tracing::warn!("{line}"),
        Some("info") => tracing::info!("{line}"),
        _ => tracing::error!("{line}"),
    }

    (StatusCode::OK, Json(IpcBody::<()>::ok(())))
}

#[cfg(test)]
mod tests;
