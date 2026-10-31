//! Automation Tauri commands: one per row of the contract's Operations
//! table, thin shells over [`AutomationService`]. The web routes in
//! `web/automation_api.rs` share the helpers below, so both transports parse
//! input and shape replies the same way.
//!
//! Only the `main` webview may call them: browser tabs share the app-wide
//! command surface and must never author, approve or run an automation, or
//! touch its secrets.

use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::Webview;

use super::IpcResult;
use crate::automation::agents::KnownAgent;
use crate::automation::model::{
    ApplyOpsResult, Automation, AutomationId, Op, Run, RunId, Schedule, Step,
};
use crate::automation::service::{
    self, AutomationDetail, AutomationService, ServiceError, ServiceResult,
};

/// Wire code when the host has no automation service (its store could not
/// open).
pub(crate) const UNAVAILABLE: &str = "unavailable";
const UNAVAILABLE_MESSAGE: &str = "automations are unavailable on this host";

/// `previewSchedule` reply: an invalid schedule is an answer, not a failure,
/// so the editor can show why while the user types.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SchedulePreview {
    pub next_runs: Vec<i64>,
    pub error: Option<String>,
}

pub(crate) fn parse_ops(ops: Value) -> ServiceResult<Vec<Op>> {
    serde_json::from_value(ops).map_err(|e| ServiceError::InvalidInput(format!("ops: {e}")))
}

pub(crate) fn preview_schedule(service: &AutomationService, schedule: Value) -> SchedulePreview {
    let next_runs = serde_json::from_value::<Schedule>(schedule)
        .map_err(|e| ServiceError::InvalidInput(format!("schedule: {e}")))
        .and_then(|schedule| service.preview(&schedule));
    match next_runs {
        Ok(next_runs) => SchedulePreview {
            next_runs,
            error: None,
        },
        Err(error) => SchedulePreview {
            next_runs: Vec::new(),
            error: Some(error.to_string()),
        },
    }
}

/// Keychain writes can block on an OS prompt, so they leave the async
/// runtime.
pub(crate) async fn set_secret(
    service: Arc<AutomationService>,
    project_id: String,
    name: String,
    value: String,
) -> ServiceResult<()> {
    blocking(move || service.set_secret(&project_id, &name, &value)).await
}

pub(crate) async fn delete_secret(
    service: Arc<AutomationService>,
    project_id: String,
    name: String,
) -> ServiceResult<()> {
    blocking(move || service.delete_secret(&project_id, &name)).await
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> ServiceResult<T> + Send + 'static,
) -> ServiceResult<T> {
    tokio::task::spawn_blocking(work)
        .await
        .unwrap_or_else(|e| Err(ServiceError::Internal(format!("keychain task failed: {e}"))))
}

fn reply<T>(result: ServiceResult<T>) -> IpcResult<T> {
    match result {
        Ok(data) => IpcResult::success(data),
        Err(error) => IpcResult::error(error.to_string(), error.code()),
    }
}

fn service<T>(webview: &Webview) -> Result<Arc<AutomationService>, IpcResult<T>> {
    if webview.label() != "main" {
        log::warn!(
            "[Security] automation command rejected from '{}'",
            webview.label()
        );
        return Err(IpcResult::error(
            "automations are managed from the main window only",
            "FORBIDDEN",
        ));
    }
    service::installed().ok_or_else(|| IpcResult::error(UNAVAILABLE_MESSAGE, UNAVAILABLE))
}

/// Runs `op` against the host service, or answers why it cannot.
fn call<T>(
    webview: &Webview,
    op: impl FnOnce(&AutomationService) -> ServiceResult<T>,
) -> IpcResult<T> {
    match service(webview) {
        Ok(service) => reply(op(&service)),
        Err(refused) => refused,
    }
}

#[tauri::command]
pub async fn automation_list(project_id: String, webview: Webview) -> IpcResult<Vec<Automation>> {
    call(&webview, |s| s.list(&project_id))
}

#[tauri::command]
pub async fn automation_get(id: String, webview: Webview) -> IpcResult<AutomationDetail> {
    call(&webview, |s| s.get(&AutomationId::from(id)))
}

#[tauri::command]
pub async fn automation_create(
    project_id: String,
    name: String,
    webview: Webview,
) -> IpcResult<Automation> {
    call(&webview, |s| s.create(&project_id, &name))
}

#[tauri::command]
pub async fn automation_apply_ops(
    id: String,
    base_revision: u64,
    ops: Value,
    webview: Webview,
) -> IpcResult<ApplyOpsResult> {
    call(&webview, |s| {
        s.apply_ops(&AutomationId::from(id), base_revision, &parse_ops(ops)?)
    })
}

#[tauri::command]
pub async fn automation_delete(id: String, webview: Webview) -> IpcResult<()> {
    call(&webview, |s| s.delete(&AutomationId::from(id)))
}

#[tauri::command]
pub async fn automation_set_enabled(
    id: String,
    enabled: bool,
    webview: Webview,
) -> IpcResult<Automation> {
    call(&webview, |s| {
        s.set_enabled(&AutomationId::from(id), enabled)
    })
}

#[tauri::command]
pub async fn automation_approve(
    id: String,
    revision: u64,
    webview: Webview,
) -> IpcResult<Automation> {
    call(&webview, |s| s.approve(&AutomationId::from(id), revision))
}

#[tauri::command]
pub async fn automation_run_now(id: String, webview: Webview) -> IpcResult<Run> {
    call(&webview, |s| s.run_now(&AutomationId::from(id)))
}

#[tauri::command]
pub async fn automation_cancel_run(run_id: String, webview: Webview) -> IpcResult<bool> {
    call(&webview, |s| s.cancel_run(&RunId::from(run_id)))
}

#[tauri::command]
pub async fn automation_list_runs(
    id: String,
    limit: usize,
    webview: Webview,
) -> IpcResult<Vec<Run>> {
    call(&webview, |s| s.list_runs(&AutomationId::from(id), limit))
}

#[tauri::command]
pub async fn automation_run_steps(run_id: String, webview: Webview) -> IpcResult<Vec<Step>> {
    call(&webview, |s| s.get_run_steps(&RunId::from(run_id)))
}

#[tauri::command]
pub async fn automation_mark_seen(id: String, webview: Webview) -> IpcResult<()> {
    call(&webview, |s| s.mark_seen(&AutomationId::from(id)))
}

#[tauri::command]
pub async fn automation_preview_schedule(
    schedule: Value,
    webview: Webview,
) -> IpcResult<SchedulePreview> {
    call(&webview, |s| Ok(preview_schedule(s, schedule)))
}

#[tauri::command]
pub async fn automation_list_agents(webview: Webview) -> IpcResult<Vec<KnownAgent>> {
    call(&webview, |s| Ok(s.list_agents()))
}

#[tauri::command]
pub async fn automation_list_secrets(
    project_id: String,
    webview: Webview,
) -> IpcResult<Vec<String>> {
    call(&webview, |s| s.list_secret_names(&project_id))
}

#[tauri::command]
pub async fn automation_set_secret(
    project_id: String,
    name: String,
    value: String,
    webview: Webview,
) -> IpcResult<()> {
    match service(&webview) {
        Ok(service) => reply(set_secret(service, project_id, name, value).await),
        Err(refused) => refused,
    }
}

#[tauri::command]
pub async fn automation_delete_secret(
    project_id: String,
    name: String,
    webview: Webview,
) -> IpcResult<()> {
    match service(&webview) {
        Ok(service) => reply(delete_secret(service, project_id, name).await),
        Err(refused) => refused,
    }
}
