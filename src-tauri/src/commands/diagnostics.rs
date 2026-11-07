//! Bug-report commands (spec-bug-report-dialog): thin Tauri adapters over
//! `crate::diagnostics`, mirroring the `/log/diagnostics` + `/log/report-bug`
//! web routes so the renderer facade sees the same `IpcResult` envelope on
//! both transports.
//!
//! The wire names are pinned for the parallel facade slice:
//! `collect_bug_report_context` and `submit_bug_report`. Tauri derives the
//! invoke name from the function name verbatim, so these commands carry NO
//! `_command` suffix — unlike the lib.rs log commands
//! (`reveal_log_dir_command`) where the suffix is itself part of the wire
//! name.

use tauri::AppHandle;

use super::IpcResult;
use crate::diagnostics::{BugReportContext, BugReportSubmitResult};

/// `collect_bug_report_context` — resolve the app's active log file
/// (`<app_log_dir>/termul.log`) and return the bounded, redacted diagnostics
/// bundle. Never fails at the service level: a missing or unreadable log
/// arrives as `logAvailable: false` with an empty tail. The file read runs
/// on the blocking pool, off the async runtime.
#[tauri::command]
pub async fn collect_bug_report_context(
    app: AppHandle,
) -> Result<IpcResult<BugReportContext>, String> {
    match tauri::async_runtime::spawn_blocking(move || {
        crate::diagnostics::collect_bug_report_context_for_app(&app)
    })
    .await
    {
        Ok(context) => Ok(IpcResult::success(context)),
        Err(error) => {
            log::warn!("[diagnostics] collect worker failed: {error}");
            Ok(IpcResult::error(
                format!("diagnostics collection failed: {error}"),
                "COLLECT_FAILED",
            ))
        }
    }
}

/// `submit_bug_report` — file the report through the host `gh` CLI
/// (`gh issue create`, arg array + staged `--body-file`; never a shell). The
/// probe/spawn is BLOCKING and stays on the blocking pool — never inline on
/// the async path. The `BugReportSubmitResult` payload
/// (`submitted` | `unavailable` | `failed`) is data, not an IPC error: an
/// absent or unauthenticated `gh` yields `unavailable` so the caller takes
/// the clipboard + prefilled-URL fallback. A blocking-pool join failure is
/// the one case mapped into the in-contract `failed` kind.
#[tauri::command]
pub async fn submit_bug_report(
    title: String,
    body: String,
) -> Result<IpcResult<BugReportSubmitResult>, String> {
    match tauri::async_runtime::spawn_blocking(move || {
        crate::diagnostics::submit_bug_report(&title, &body)
    })
    .await
    {
        Ok(result) => Ok(IpcResult::success(result)),
        Err(error) => {
            log::warn!("[diagnostics] submit worker failed: {error}");
            Ok(IpcResult::success(BugReportSubmitResult::Failed {
                reason: "the submit worker failed before a result was produced".to_string(),
            }))
        }
    }
}
