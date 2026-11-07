//! Canvas mode: the figcraft editor embedded in a Termul tab.
//!
//! The editor is a prebuilt web bundle (pinned by [`pin`]) that Termul serves
//! at `/canvas/<id>/` and drives over a control protocol; Termul owns the
//! document file, never the editor. Everything here is **Tauri-free** so the
//! desktop (`lib.rs`) and the standalone `termul-server` share one
//! implementation. Boundary logging uses the `log` crate (desktop seam
//! convention); the web route mounts log their own seams. Document contents
//! and session tokens are never logged.
//!
//! - [`static_server`] — bundle serving, the per-canvas token store and its
//!   path gate, and the open/close sequences both transports share.
//! - [`persistence`] — the mount registry: load floor, autosave debounce,
//!   saved version and the atomic document write (AD-23, AD-31).
//! - [`pin`] — the figcraft bundle tag this build expects.
//! - [`bundle_path`] — the `/canvas/<id>/<token>/...` path shape, and the
//!   redaction every log line naming a request path goes through.
//! - [`fallback_fonts`] — the system fonts the desktop lends the editor for
//!   characters its embedded font lacks.

pub mod bundle_path;
pub mod doc_path;
pub mod fallback_fonts;
pub mod persistence;
pub mod pin;
pub mod static_server;

#[cfg(test)]
mod bundle_path_tests;
#[cfg(test)]
mod doc_path_tests;
#[cfg(test)]
mod loopback_log_tests;
#[cfg(test)]
mod pin_tests;
#[cfg(test)]
mod static_server_tests;
#[cfg(test)]
mod tests;

use serde::Serialize;

/// The doc path could not be canonicalized.
pub const CODE_PATH_VALIDATION_FAILED: &str = "PATH_VALIDATION_FAILED";
/// The canvas was closed mid-operation.
pub const CODE_CANVAS_CLOSED: &str = "CANVAS_CLOSED";
/// The canvas is running its unmount sequence (AD-31 quiesce).
pub const CODE_CANVAS_CLOSING: &str = "CANVAS_CLOSING";
/// Another renderer holds the canvas's mount lease (AD-30), and taking it
/// over failed because the holder could not save.
pub const CODE_CANVAS_OPEN_ELSEWHERE: &str = "CANVAS_OPEN_ELSEWHERE";
/// A save failed: a mount's flush before unmount (the mount stays open and
/// the user is asked).
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

/// Deterministic, URL-safe id for a project's canvas (singleton per
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
