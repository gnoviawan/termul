use super::{validate_project_path, IpcResult};
use crate::media_bytes::{log_name, read_media, MediaErrorCode, MediaReadError};
use crate::path_validation;
use serde::Serialize;
use std::path::PathBuf;
use tauri::ipc::Response;
use tauri::AppHandle;

/// Read an image, video, or PDF by absolute path. The bytes arrive in JS as an
/// `ArrayBuffer`; a failure rejects the invoke with the serialized
/// [`MediaReadError`] `{ code, message }`.
#[tauri::command]
pub async fn read_media_bytes(path: String) -> Result<Response, MediaReadError> {
    let candidate = PathBuf::from(path_validation::strip_verbatim_prefix(&path).as_ref());
    let name = log_name(&candidate);
    if !candidate.is_absolute() {
        log::warn!("read_media_bytes refused {name}: INVALID_PATH");
        return Err(MediaReadError::new(
            MediaErrorCode::InvalidPath,
            "media path must be absolute",
        ));
    }
    let result = tauri::async_runtime::spawn_blocking(move || read_media(&candidate))
        .await
        .unwrap_or_else(|e| {
            Err(MediaReadError::new(
                MediaErrorCode::ReadError,
                format!("read task failed: {e}"),
            ))
        });
    match result {
        Ok(media) => {
            log::debug!("read_media_bytes {name}: {} bytes", media.bytes.len());
            Ok(Response::new(media.bytes))
        }
        Err(err) => {
            log::warn!("read_media_bytes failed for {name}: {}", err.code.as_str());
            Err(err)
        }
    }
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
