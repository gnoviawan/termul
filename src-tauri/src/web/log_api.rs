//! HTTP handler for frontend error forwarding (CAP-2: Web & Mobile 1:1 Parity).
//!
//! Mirrors the desktop `#[tauri::command] log_frontend_error` handler over
//! HTTP. The web client has no Tauri runtime to invoke the command; this route
//! lets the renderer forward errors to the server's log file so they survive a
//! closed DevTools console (same motivation as the desktop path, issue #244).
//!
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
use std::time::{Duration, Instant};

use axum::{
    extract::{ConnectInfo, DefaultBodyLimit, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{post, MethodRouter},
    Extension, Json,
};
use parking_lot::Mutex;
use serde::Deserialize;

use crate::commands::{sanitize_log_field, MAX_FRONTEND_FIELD_LEN};
use crate::web::auth::BearerVerified;
use crate::web::capabilities::{write_decision, WriteFlags};
use crate::web::fs_api::{check_local_only, IpcBody};
use crate::web::ws::AppState;

const FRONTEND_FIELDS: usize = 4;
const MAX_UTF8_CHAR_BYTES: usize = 4;
pub const MAX_BODY_BYTES: usize = FRONTEND_FIELDS * MAX_UTF8_CHAR_BYTES * MAX_FRONTEND_FIELD_LEN;

/// Process-wide: tunnelled peers share one loopback address, so a per-peer
/// budget could not tell them apart.
static REMOTE_LINE_BUDGET: Mutex<LineBudget> =
    Mutex::new(LineBudget::new(30, Duration::from_secs(60)));

#[derive(Debug, PartialEq, Eq)]
struct Dropped {
    in_window: u32,
}

struct LineBudget {
    lines: u32,
    window: Duration,
    window_start: Option<Instant>,
    used: u32,
}

impl LineBudget {
    const fn new(lines: u32, window: Duration) -> Self {
        Self {
            lines,
            window,
            window_start: None,
            used: 0,
        }
    }

    fn take(&mut self, now: Instant) -> Result<(), Dropped> {
        if self
            .window_start
            .is_none_or(|start| now.saturating_duration_since(start) >= self.window)
        {
            self.window_start = Some(now);
            self.used = 0;
        }
        self.used += 1;
        if self.used <= self.lines {
            Ok(())
        } else {
            Err(Dropped {
                in_window: self.used - self.lines,
            })
        }
    }
}

pub fn route() -> MethodRouter<AppState> {
    post(frontend_error).layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
}

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

async fn frontend_error(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    verified: Option<Extension<BearerVerified>>,
    Json(req): Json<FrontendErrorRequest>,
) -> impl IntoResponse {
    let verified_remote =
        verified.is_some() && !write_decision(peer, WriteFlags::from_state(&state)).is_allowed();
    if verified_remote {
        if let Err(dropped) = REMOTE_LINE_BUDGET.lock().take(Instant::now()) {
            if dropped.in_window == 1 {
                tracing::warn!(
                    target: "termul::web::log_api",
                    peer = %peer,
                    "remote frontend log budget spent; dropping lines until the window resets"
                );
            }
            return (
                StatusCode::OK,
                Json(IpcBody::<()>::err(
                    "remote frontend log budget spent; line dropped",
                    "RATE_LIMITED",
                )),
            );
        }
    } else if let Some(forbidden) = check_local_only::<()>(
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
