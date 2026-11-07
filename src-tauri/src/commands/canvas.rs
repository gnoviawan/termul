//! Canvas Tauri commands. `canvas_open` / `canvas_close` mount and unmount the
//! figcraft editor served by the loopback bundle listener; they mirror
//! `POST /canvas/open|close` in `web/canvas_api.rs` (same `IpcResult`
//! envelope, same typed codes) and share `canvas::static_server::open_canvas`.
//! The `canvas_*document*` / `canvas_dirty_changed` / `canvas_write_snapshot`
//! commands are the desktop transport of `canvas::persistence` and mirror the
//! web routes of the same names.

use std::sync::Arc;

use tauri::State;

use super::{sanitize_log_field, IpcResult};
use crate::canvas::doc_path::resolve_doc_path;
use crate::canvas::persistence::{
    self, canvas_mounts, CloseMode, CloseOutcome, ConflictChoice, DirtyOutcome, DiskOutcome,
    DocumentBytes, PersistenceView, Remount, ResolveOutcome, WriteOutcome,
};
use crate::canvas::static_server::{
    close_canvas, open_canvas, CanvasOpenInfo, OpenRequest, StaticServer, CODE_BUNDLE_LISTENER_DOWN,
};
use crate::canvas::CanvasError;
use crate::web::ProjectRegistry;

const LISTENER_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

fn persistence_result<T>(
    operation: &str,
    project_id: &str,
    result: Result<T, CanvasError>,
) -> IpcResult<T> {
    match result {
        Ok(value) => IpcResult::success(value),
        Err(err) => {
            log::warn!(
                "[canvas] {operation} failed project_id={} code={}",
                sanitize_log_field(project_id),
                err.code
            );
            IpcResult::error(err.message, err.code)
        }
    }
}

/// `canvas_open { docPath, projectId, request: { clientInstanceId, autosaveMs?, autosaveMaxMs?,
/// leaseGraceMs?, maxMounted?, crashTimeouts? } }` — the loopback bundle base
/// plus a minted `ct` token and a new `mountSeq` for the project's canvas,
/// leased to this window (AD-30). Typed `BUNDLE_LISTENER_DOWN` while the
/// listener is not bound; `PATH_VALIDATION_FAILED` for a doc outside the
/// opening project's registered root, as on the web route; `CANVAS_OPEN_ELSEWHERE`
/// when the renderer holding the lease could not save; `EVICTION_BLOCKED`
/// when a canvas that must make room (AD-26) could not be saved.
#[tauri::command]
pub async fn canvas_open(
    doc_path: String,
    project_id: String,
    request: OpenRequest,
    server: State<'_, Arc<StaticServer>>,
    registry: State<'_, Arc<ProjectRegistry>>,
) -> Result<IpcResult<CanvasOpenInfo>, String> {
    let log_project_id = sanitize_log_field(&project_id);
    let doc_key = match resolve_doc_path(&doc_path, &project_id, Some(&registry)) {
        Ok(doc_key) => doc_key,
        Err(err) => {
            log::warn!(
                "[canvas] open rejected project_id={log_project_id}: {}",
                err.message
            );
            return Ok(IpcResult::error(err.message, err.code));
        }
    };
    let Some(base) = server.wait_for_base(LISTENER_WAIT).await else {
        log::warn!(
            "[canvas] open failed project_id={log_project_id} code={CODE_BUNDLE_LISTENER_DOWN}"
        );
        return Ok(IpcResult::error(
            "canvas bundle listener is not running",
            CODE_BUNDLE_LISTENER_DOWN,
        ));
    };
    match open_canvas(base, &project_id, doc_key, request).await {
        Ok(info) => {
            log::info!(
                "[canvas] open project_id={log_project_id} canvas_id={} mount_seq={}",
                info.canvas_id,
                info.mount_seq
            );
            Ok(IpcResult::success(info))
        }
        Err(err) => {
            log::warn!(
                "[canvas] open failed project_id={log_project_id} code={}",
                err.code
            );
            Ok(IpcResult::error(err.message, err.code))
        }
    }
}

/// `canvas_close { projectId, mountSeq, discard? }` — unmount this window's
/// mount `mountSeq` through the AD-31 sequence (quiesce, save, verify,
/// unmount); a mount a newer open replaced is left alone. A failed save
/// answers `SAVE_FAILED` and keeps the mount; `discard: true` is the user's
/// explicit choice to drop unsaved changes. Idempotent.
#[tauri::command]
pub async fn canvas_close(
    project_id: String,
    mount_seq: u64,
    discard: Option<bool>,
) -> Result<IpcResult<CloseOutcome>, String> {
    let mode = close_mode(discard);
    let log_project_id = sanitize_log_field(&project_id);
    log::info!("[canvas] close project_id={log_project_id} mount_seq={mount_seq} mode={mode:?}");
    Ok(match close_canvas(&project_id, mount_seq, mode).await {
        Ok(outcome) => {
            log_closed(&log_project_id, &outcome);
            IpcResult::success(outcome)
        }
        Err(err) => {
            log::warn!(
                "[canvas] close refused project_id={log_project_id} code={}: {}",
                err.code,
                err.message
            );
            IpcResult::error(err.message, err.code)
        }
    })
}

/// The close mode a transport's `discard` flag asks for.
pub(crate) fn close_mode(discard: Option<bool>) -> CloseMode {
    if discard == Some(true) {
        CloseMode::Discard
    } else {
        CloseMode::Save
    }
}

fn log_closed(log_project_id: &str, outcome: &CloseOutcome) {
    if outcome.discarded {
        log::warn!(
            "[canvas] closed project_id={log_project_id}: unsaved changes discarded by the user"
        );
    } else {
        log::info!(
            "[canvas] closed project_id={log_project_id} unmounted={} saved={}",
            outcome.unmounted,
            outcome.saved_version.as_deref().unwrap_or("none")
        );
    }
}

/// `canvas_set_visible { projectId, mountSeq, visible }` — the user started
/// or stopped looking at the canvas; activity the mount cap ranks eviction
/// by. A mount that is gone (evicted) answers `CANVAS_CLOSED`.
#[tauri::command]
pub async fn canvas_set_visible(
    project_id: String,
    mount_seq: u64,
    visible: bool,
) -> Result<IpcResult<()>, String> {
    let result = canvas_mounts().set_visible(&project_id, mount_seq, visible);
    Ok(persistence_result("set visible", &project_id, result))
}

/// `canvas_read_document { projectId, mountSeq }` — the mounted document's
/// bytes as base64, `null` when the file does not exist yet.
#[tauri::command]
pub async fn canvas_read_document(
    project_id: String,
    mount_seq: u64,
) -> Result<IpcResult<DocumentBytes>, String> {
    let result = persistence::read_document(canvas_mounts(), &project_id, mount_seq).await;
    Ok(persistence_result("read document", &project_id, result))
}

/// `canvas_document_loaded { projectId, mountSeq, ack }` — the editor holds
/// the document; `ack` is the `host.openDocument` result text or `null` for
/// a new document.
#[tauri::command]
pub async fn canvas_document_loaded(
    project_id: String,
    mount_seq: u64,
    ack: Option<String>,
) -> Result<IpcResult<PersistenceView>, String> {
    let result =
        persistence::document_loaded(canvas_mounts(), &project_id, mount_seq, ack.as_deref());
    Ok(persistence_result("document loaded", &project_id, result))
}

/// `canvas_dirty_changed { projectId, mountSeq, dirty, contentVersion }` —
/// answers once the autosave debounce settles: `saveDue`, `idle`, or
/// `superseded` by a later notification.
#[tauri::command]
pub async fn canvas_dirty_changed(
    project_id: String,
    mount_seq: u64,
    dirty: bool,
    content_version: String,
) -> Result<IpcResult<DirtyOutcome>, String> {
    let result = persistence::dirty_changed(
        canvas_mounts(),
        &project_id,
        mount_seq,
        dirty,
        &content_version,
    )
    .await;
    Ok(persistence_result("dirty changed", &project_id, result))
}

/// `canvas_write_snapshot { projectId, mountSeq, snapshot }` — write the
/// `host.snapshot` result text to the project's document atomically.
#[tauri::command]
pub async fn canvas_write_snapshot(
    project_id: String,
    mount_seq: u64,
    snapshot: String,
) -> Result<IpcResult<WriteOutcome>, String> {
    let result =
        persistence::write_snapshot(canvas_mounts(), &project_id, mount_seq, &snapshot).await;
    if let Ok(outcome) = &result {
        log_write_outcome(&project_id, outcome);
    }
    Ok(persistence_result("write snapshot", &project_id, result))
}

fn log_write_outcome(project_id: &str, outcome: &WriteOutcome) {
    let project_id = sanitize_log_field(project_id);
    match (&outcome.mark_saved, &outcome.view.save_error) {
        (Some(version), _) => {
            log::info!("[canvas] saved project_id={project_id} content_version={version}");
        }
        (None, Some(error)) => {
            log::warn!("[canvas] save failed project_id={project_id}: {error}");
        }
        (None, None) => {}
    }
}

/// `canvas_disk_changed { projectId, mountSeq, reloadFailed? }` — Termul's
/// file watcher saw the mounted document change: `unchanged` (Termul's own
/// write), `reload` with the bytes for a clean editor, or `conflict`
/// (AD-27). `reloadFailed`: the editor did not load the bytes a `reload`
/// handed it, which makes the change a `conflict`.
#[tauri::command]
pub async fn canvas_disk_changed(
    project_id: String,
    mount_seq: u64,
    reload_failed: Option<bool>,
) -> Result<IpcResult<DiskOutcome>, String> {
    let result = crate::canvas::persistence::disk_changed(
        canvas_mounts(),
        &project_id,
        mount_seq,
        reload_failed.unwrap_or(false),
    )
    .await;
    if let Ok(outcome) = &result {
        log_disk_outcome(&project_id, outcome);
    }
    Ok(persistence_result("disk changed", &project_id, result))
}

/// The one log line per external change both transports write.
pub(crate) fn log_disk_outcome(project_id: &str, outcome: &DiskOutcome) {
    let project_id = sanitize_log_field(project_id);
    match outcome {
        DiskOutcome::Unchanged { .. } => {}
        DiskOutcome::Reload { .. } => {
            log::info!("[canvas] reloaded from disk project_id={project_id}: changed outside Termul");
        }
        DiskOutcome::Conflict { view } => log::warn!(
            "[canvas] conflict project_id={project_id}: changed on disk with unsaved edits deleted={}",
            view.conflict
                .as_ref()
                .is_some_and(|conflict| conflict.disk_hash.is_none())
        ),
    }
}

/// `canvas_resolve_conflict { projectId, mountSeq, choice, snapshot? }` —
/// the user's answer to a disk conflict; `snapshot` is the `host.snapshot`
/// result text for `saveCopy`.
#[tauri::command]
pub async fn canvas_resolve_conflict(
    project_id: String,
    mount_seq: u64,
    choice: ConflictChoice,
    snapshot: Option<String>,
) -> Result<IpcResult<ResolveOutcome>, String> {
    log::info!(
        "[canvas] conflict resolved project_id={} choice={choice:?}",
        sanitize_log_field(&project_id)
    );
    let result = persistence::resolve_conflict(
        canvas_mounts(),
        &project_id,
        mount_seq,
        choice,
        snapshot.as_deref(),
    )
    .await;
    Ok(persistence_result("resolve conflict", &project_id, result))
}

/// `canvas_crashed { projectId, mountSeq, reason }` — the editor reported
/// `event.crashed`: remount from the last saved bytes under a new
/// `mountSeq` (AD-31).
#[tauri::command]
pub async fn canvas_crashed(
    project_id: String,
    mount_seq: u64,
    reason: String,
) -> Result<IpcResult<Remount>, String> {
    let result = canvas_mounts().crashed(&project_id, mount_seq, &reason);
    Ok(persistence_result("crashed", &project_id, result))
}
