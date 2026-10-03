//! OpenPencil canvas mode — managed sidecar daemon subsystem.
//!
//! Embeds the OpenPencil editor as a supervised `op-host-web-server
//! --serve-web --managed` sidecar (one daemon per open `.op` document), per
//! the daemon contract mirrored from the sibling OpenPencil repo:
//!
//! - argv: `--serve-web --managed --port 0 --file <doc> --allow-origin <origin>`
//! - first stdout line is the handshake JSON `{"ok":true,"port":N,"token":
//!   "<hex>","version":"…"}` (10s timeout);
//! - stdin-EOF is the shutdown lease (kill after 3s grace);
//! - the daemon binds loopback only.
//!
//! Everything in this module is **Tauri-free** so both the desktop
//! (`lib.rs`) and the standalone `termul-server` (`server_main.rs`) compose
//! the same pool. Boundary logging uses the `log` crate (desktop seam
//! convention); the web/agentation route mounts log their own seams.
//! Document contents and lifecycle tokens are never logged.
//!
//! - [`managed`] — binary resolution, argv, spawn + handshake, dispose.
//! - [`pool`] — `CanvasDaemonPool`: doc-keyed map, coalesced acquires,
//!   respawn-once-then-evict crash policy.
//! - [`mcp_proxy`] — shared HTTP proxy to the active daemon (`/mcp` + path
//!   proxy, streaming via reqwest).

pub mod managed;
pub mod mcp_proxy;
pub mod pool;

#[cfg(test)]
pub(crate) mod tests;

use serde::Serialize;

pub use managed::{DaemonSpawner, RealDaemonSpawner};
pub use pool::CanvasDaemonPool;

/// Stable SCREAMING_SNAKE error code: the `op-host-web-server` binary could
/// not be resolved (`TERMUL_OP_HOST_SERVER` / `TERMUL_OPENPENCIL_ROOT` /
/// sibling checkout).
pub const CODE_BINARY_NOT_FOUND: &str = "BINARY_NOT_FOUND";
/// The daemon did not print a handshake line within the 10s deadline.
pub const CODE_HANDSHAKE_TIMEOUT: &str = "HANDSHAKE_TIMEOUT";
/// The first stdout line was not a valid handshake JSON document.
pub const CODE_HANDSHAKE_INVALID: &str = "HANDSHAKE_INVALID";
/// The child could not be spawned (non-NotFound IO error).
pub const CODE_SPAWN_FAILED: &str = "SPAWN_FAILED";
/// No live daemon backs the requested proxy/command surface.
pub const CODE_DAEMON_DOWN: &str = "DAEMON_DOWN";
/// The doc path could not be canonicalized.
pub const CODE_PATH_VALIDATION_FAILED: &str = "PATH_VALIDATION_FAILED";
/// The canvas was closed (or the pool shut down) mid-operation.
pub const CODE_CANVAS_CLOSED: &str = "CANVAS_CLOSED";
/// A save request failed at the daemon transport or protocol level.
pub const CODE_SAVE_FAILED: &str = "SAVE_FAILED";
/// The web canvas session token could not be generated (CSPRNG failure).
pub const CODE_TOKEN_GENERATION_FAILED: &str = "TOKEN_GENERATION_FAILED";

/// Typed canvas error: a stable SCREAMING_SNAKE `code` plus a human message
/// (never a token or document contents). Mirrors `acp::install::InstallError`
/// — typed errors instead of `Result<_, String>` at new seams.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CanvasError {
    pub code: String,
    pub message: String,
}

impl CanvasError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for CanvasError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for CanvasError {}

/// Snapshot of one live managed daemon (no token — never leaves the host).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasDaemonInfo {
    pub doc_key: String,
    pub port: u16,
    pub version: String,
}

/// Result of opening a canvas. Desktop returns the loopback embed URL (the
/// renderer iframes it directly — no proxy, no canvas token; `canvas_token`
/// is `None`); web returns the same-origin proxy path plus the `canvasId`
/// the proxy routes on.
///
/// Embed URL shapes (both append params as raw query text — the editor
/// refuses URL-encoded `embed%3Dvscode`):
/// - desktop: `http://127.0.0.1:<port>/?embed=vscode`
/// - web: `/canvas/<canvasId>/?embed=vscode&ct=<32-hex>` — the `ct` canvas
///   session token authenticates the iframe's `/canvas/<id>/*` requests
///   through the canvas-token gate (`web::canvas_api::canvas_token_gate`).
///
/// The same token is ALSO returned as `canvas_token` (web only) so the
/// renderer can set it as the same-origin `op_canvas_ct` cookie: the
/// cookie authenticates the editor's root-relative traffic — the root
/// canvas routes `/pkg/*`, `/canvaskit/*`, `/api/*` (the editor wasm
/// derives its daemon base from `window.location.origin` and uses
/// absolute paths, so a `/canvas/<id>/` iframe still requests those at
/// the server root) — and the `op_canvas_ct` cookie path of
/// `/canvas/mcp`. It is dropped with the pool entry on close/evict, so a
/// stale token yields 401.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasOpenInfo {
    pub embed_url: String,
    /// Stable Termul-proxied MCP endpoint. Desktop: the id-scoped agentation
    /// route `http://127.0.0.1:<port>/canvas/<canvasId>/mcp` (agents of
    /// project A never reach project B's canvas; the id is deterministic so
    /// the URL is stable across re-opens). Web: the global `/canvas/mcp`
    /// (bearer-or-cookie authed, routes to the active canvas). `None` when
    /// the desktop agentation server is unavailable.
    pub mcp_url: Option<String>,
    /// Canonicalized absolute doc path (the pool's daemon key).
    pub doc_key: String,
    /// Web-only: the project-derived id the `/canvas/<id>/*` proxy routes on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canvas_id: Option<String>,
    /// Web-only: the canvas session token (the `ct` embed param / the
    /// `op_canvas_ct` cookie value the renderer sets). `None` on desktop.
    /// Never logged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canvas_token: Option<String>,
}

/// Pool status for `canvas_status` / `POST /canvas/status`-style queries.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasStatus {
    pub daemons: Vec<CanvasDaemonInfo>,
    pub active_doc_key: Option<String>,
}

/// Deterministic, URL-safe proxy id for a project's canvas (singleton per
/// project, so the id is derived from the project — not the doc — and stays
/// stable across doc re-binds). FNV-1a 64 of the project id, hex-encoded.
pub fn canvas_id_for_project(project_id: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in project_id.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("cv{hash:016x}")
}
