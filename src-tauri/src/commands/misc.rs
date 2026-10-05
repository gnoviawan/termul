use super::{validate_project_path, IpcResult};
use crate::path_validation;
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::ipc::Response;
use tauri::AppHandle;

// ==================== Attachment Commands ====================

/// Maximum attachment image size the renderer may read through this command.
/// Mirrors the renderer's `MAX_IMAGE_BYTES` (10 MB) so the brokered read can
/// reject oversized files before transferring them across IPC.
const ATTACHMENT_MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

/// Image extensions the attachment flow is allowed to read by path. The
/// generic `fs:allow-read-file` permission was removed from the renderer
/// capability; this command is the only binary-read path left, and it is
/// intentionally restricted to images (the only content type the composer and
/// chat preview need to read by path) to limit the confidentiality surface.
const ATTACHMENT_IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg", "ico",
];

fn attachment_is_image_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            ATTACHMENT_IMAGE_EXTENSIONS
                .iter()
                .any(|allowed| allowed.eq_ignore_ascii_case(ext))
        })
        .unwrap_or(false)
}

/// Read attachment image bytes by path. Replaces direct renderer
/// `fs:allow-read-file` access so binary reads go through one validated,
/// size- and type-constrained command instead of the generic fs plugin.
///
/// Returns the raw bytes via `Response::new`, which arrives on the JS side as
/// an `ArrayBuffer`. Rejects (throws on JS) when the path is not absolute,
/// does not exist, is not a regular file, exceeds the size cap, or is not an
/// image — callers fall back to a file-icon preview on rejection.
#[tauri::command]
pub fn read_attachment_bytes(path: String) -> Result<Response, String> {
    let stripped = path_validation::strip_verbatim_prefix(&path);
    let candidate = PathBuf::from(stripped.as_ref());

    if !candidate.is_absolute() {
        return Err("Attachment path must be absolute".to_string());
    }

    let canonical = candidate
        .canonicalize()
        .map_err(|e| format!("Invalid or inaccessible attachment path: {}", e))?;

    if !attachment_is_image_extension(&canonical) {
        return Err("Attachment path is not an image".to_string());
    }

    let mut file =
        std::fs::File::open(&canonical).map_err(|e| format!("Failed to open attachment: {}", e))?;
    let metadata = file
        .metadata()
        .map_err(|e| format!("Failed to read attachment metadata: {}", e))?;
    if !metadata.is_file() {
        return Err("Attachment path is not a regular file".to_string());
    }
    if metadata.len() > ATTACHMENT_MAX_IMAGE_BYTES {
        return Err("Attachment image exceeds the 10 MB limit".to_string());
    }

    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|e| format!("Failed to read attachment: {}", e))?;
    if bytes.len() as u64 > ATTACHMENT_MAX_IMAGE_BYTES {
        return Err("Attachment image exceeds the 10 MB limit".to_string());
    }
    Ok(Response::new(bytes))
}

// ==================== Agent Registry Commands ====================

/// ADR-004.6: Fetch the ACP Registry catalog for agent IDENTITY & DISCOVERY
/// only (id, name, description, website, icon). Opt-in and read-only; runs from
/// the Rust side, caches on disk, and degrades to cache/empty on failure. The
/// returned entries deliberately omit `distribution` so they can never be used
/// to derive a terminal-native launch command.
#[tauri::command]
pub async fn agent_registry_fetch(
    app: AppHandle,
    force_refresh: Option<bool>,
) -> Result<IpcResult<crate::agent_registry::AcpRegistryCatalog>, String> {
    match crate::agent_registry::fetch_acp_registry(&app, force_refresh.unwrap_or(false)).await {
        Ok(catalog) => Ok(IpcResult::success(catalog)),
        Err(e) => Ok(IpcResult::error(e, "AGENT_REGISTRY_FETCH_FAILED")),
    }
}

// ==================== Filesystem Scope Commands ====================

/// Per-path failure detail for [`fs_scope_grant`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsScopeGrantFailure {
    pub path: String,
    pub error: String,
}

/// Summary of a [`fs_scope_grant`] call: granted paths and per-path failures.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsScopeGrantSummary {
    pub granted: Vec<String>,
    pub failed: Vec<FsScopeGrantFailure>,
}

/// Re-grant runtime filesystem scope for restored project roots and worktrees.
///
/// The dialog plugin extends the fs scope at runtime when a folder is picked
/// (that is why the first Add Project works), but the grant is in-memory and
/// lost on restart, while the static `fs:scope` capability only allowlists
/// specific drives. Restored projects on any other drive then fail every
/// `readDir` with "forbidden path" after restart. The renderer calls this
/// before hydrating the file explorer so restored roots are re-authorized.
///
/// Individual path failures (e.g. a detached external drive) are reported in
/// the summary instead of failing the whole call, so one stale project cannot
/// block the others from loading.
#[tauri::command]
pub async fn fs_scope_grant(
    app: AppHandle,
    paths: Vec<String>,
) -> Result<IpcResult<FsScopeGrantSummary>, String> {
    use tauri_plugin_fs::FsExt;

    log::info!("[fs-scope] grant start count={}", paths.len());
    let mut granted: Vec<String> = Vec::new();
    let mut failed: Vec<FsScopeGrantFailure> = Vec::new();

    for raw in paths {
        if raw.trim().is_empty() {
            continue;
        }
        match validate_project_path(&raw) {
            Ok(path) => {
                // Recursive so the file explorer can descend the whole tree,
                // including `.termul/worktrees/*` created under the root.
                match app.fs_scope().allow_directory(&path, true) {
                    Ok(()) => granted.push(path.to_string_lossy().into_owned()),
                    Err(e) => {
                        log::warn!("[fs-scope] grant failed path={} error={}", raw, e);
                        failed.push(FsScopeGrantFailure {
                            path: raw,
                            error: e.to_string(),
                        });
                    }
                }
            }
            Err(e) => {
                log::warn!(
                    "[fs-scope] grant validation failed path={} error={}",
                    raw,
                    e
                );
                failed.push(FsScopeGrantFailure {
                    path: raw,
                    error: e,
                });
            }
        }
    }

    log::info!(
        "[fs-scope] grant done granted={} failed={}",
        granted.len(),
        failed.len()
    );
    Ok(IpcResult::success(FsScopeGrantSummary { granted, failed }))
}

/// Cap on any single renderer-supplied field to keep one forwarded error from
/// ballooning the log file.
pub(crate) const MAX_FRONTEND_FIELD_LEN: usize = 4096;

/// Sanitize untrusted renderer text for single-line logging: escape newlines
/// and control characters so a crafted error message/stack cannot forge
/// additional, authoritative-looking log lines (log injection), and truncate
/// to a sane bound.
pub(crate) fn sanitize_log_field(value: &str) -> String {
    let mut out = String::with_capacity(value.len().min(MAX_FRONTEND_FIELD_LEN));
    for ch in value.chars().take(MAX_FRONTEND_FIELD_LEN) {
        match ch {
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            // Strip other C0 control chars (incl. ESC) that could corrupt or
            // spoof terminal/log output; keep everything else verbatim.
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    if value.chars().count() > MAX_FRONTEND_FIELD_LEN {
        out.push_str("…[truncated]");
    }
    out
}

/// Forward a renderer-side error to the backend log file (issue #244).
///
/// Global `window.onerror` / `onunhandledrejection` handlers and the React
/// ErrorBoundary route through this so frontend failures survive a closed
/// production DevTools console and land in the same rotated log file as the
/// Rust logs. `level` accepts "error" (default) or "warn". All renderer-supplied
/// fields are sanitized to prevent log injection.
#[tauri::command]
pub fn log_frontend_error(
    level: Option<String>,
    message: String,
    source: Option<String>,
    stack: Option<String>,
    component_stack: Option<String>,
) -> Result<(), String> {
    let context = sanitize_log_field(&source.unwrap_or_else(|| "renderer".to_string()));
    let message = sanitize_log_field(&message);
    let stack_part = stack
        .map(|s| format!(" | stack: {}", sanitize_log_field(&s)))
        .unwrap_or_default();
    let component_part = component_stack
        .map(|s| format!(" | component stack: {}", sanitize_log_field(&s)))
        .unwrap_or_default();

    let line = format!(
        "[frontend] [{}] {}{}{}",
        context, message, stack_part, component_part
    );

    match level.as_deref() {
        Some("warn") => log::warn!("{}", line),
        Some("info") => log::info!("{}", line),
        _ => log::error!("{}", line),
    }

    Ok(())
}
