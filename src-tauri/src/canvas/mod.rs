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
//! - [`mcp_proxy`] — shared HTTP path proxy to the active daemon (streaming
//!   via reqwest).
//! - [`persistence`] — the figcraft mount registry: load floor, autosave
//!   debounce, saved version and the atomic document write (AD-23, AD-31).

pub mod managed;
pub mod mcp_proxy;
pub mod persistence;
pub mod pin;
pub mod pool;
pub mod static_server;

#[cfg(test)]
mod pin_tests;
#[cfg(test)]
mod static_server_tests;
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
/// The canvas is running its unmount sequence (AD-31 quiesce).
pub const CODE_CANVAS_CLOSING: &str = "CANVAS_CLOSING";
/// A save failed: the daemon transport, or a figcraft mount's flush before
/// unmount (the mount stays open and the user is asked).
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
