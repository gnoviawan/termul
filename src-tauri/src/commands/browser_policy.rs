//! Browser policy Tauri commands. Thin shells over
//! [`BrowserPolicyService`]; the web routes in `web/browser_policy_api.rs`
//! call the same service, so both transports return identical replies.
//!
//! Only the `main` webview may call them: browser tabs share the app-wide
//! command surface and must never edit the policy that governs them.

use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Manager, Webview};

use super::IpcResult;
use crate::acp::browser_policy::{
    AppPolicyView, BrowserPolicyService, CallerScope, PolicyRefusal, ProjectPolicyView,
};

fn reply<T>(result: Result<T, PolicyRefusal>) -> IpcResult<T> {
    match result {
        Ok(data) => IpcResult::success(data),
        Err(refusal) => IpcResult::error(refusal.envelope_error(), refusal.code().as_str()),
    }
}

fn service(app: &AppHandle, webview: &Webview) -> Result<Arc<BrowserPolicyService>, PolicyRefusal> {
    if webview.label() != "main" {
        log::warn!(
            "[Security] browser policy command rejected from '{}'",
            webview.label()
        );
        return Err(PolicyRefusal::AppScopeRequired);
    }
    app.try_state::<Arc<BrowserPolicyService>>()
        .map(|state| state.inner().clone())
        .ok_or(PolicyRefusal::StoreUnavailable)
}

pub(crate) async fn get_project_policy(
    service: &BrowserPolicyService,
    caller: &CallerScope,
    project_id: &str,
) -> IpcResult<ProjectPolicyView> {
    reply(service.project_view(caller, project_id).await)
}

pub(crate) async fn get_app_policy(
    service: &BrowserPolicyService,
    caller: &CallerScope,
) -> IpcResult<AppPolicyView> {
    reply(service.app_view(caller).await)
}

pub(crate) async fn apply_project_policy(
    service: &BrowserPolicyService,
    caller: &CallerScope,
    project_id: &str,
    expected_revision: u64,
    op: &Value,
) -> IpcResult<ProjectPolicyView> {
    reply(
        service
            .apply_project(caller, project_id, expected_revision, op)
            .await,
    )
}

pub(crate) async fn apply_app_policy(
    service: &BrowserPolicyService,
    caller: &CallerScope,
    expected_revision: u64,
    op: &Value,
) -> IpcResult<AppPolicyView> {
    reply(service.apply_app(caller, expected_revision, op).await)
}

#[tauri::command]
pub async fn browser_policy_get_project(
    project_id: String,
    app: AppHandle,
    webview: Webview,
) -> IpcResult<ProjectPolicyView> {
    match service(&app, &webview) {
        Ok(service) => get_project_policy(&service, &CallerScope::App, &project_id).await,
        Err(refusal) => reply(Err(refusal)),
    }
}

#[tauri::command]
pub async fn browser_policy_get_app(app: AppHandle, webview: Webview) -> IpcResult<AppPolicyView> {
    match service(&app, &webview) {
        Ok(service) => get_app_policy(&service, &CallerScope::App).await,
        Err(refusal) => reply(Err(refusal)),
    }
}

#[tauri::command]
pub async fn browser_policy_apply_project(
    project_id: String,
    expected_revision: u64,
    op: Value,
    app: AppHandle,
    webview: Webview,
) -> IpcResult<ProjectPolicyView> {
    match service(&app, &webview) {
        Ok(service) => {
            apply_project_policy(
                &service,
                &CallerScope::App,
                &project_id,
                expected_revision,
                &op,
            )
            .await
        }
        Err(refusal) => reply(Err(refusal)),
    }
}

#[tauri::command]
pub async fn browser_policy_apply_app(
    expected_revision: u64,
    op: Value,
    app: AppHandle,
    webview: Webview,
) -> IpcResult<AppPolicyView> {
    match service(&app, &webview) {
        Ok(service) => apply_app_policy(&service, &CallerScope::App, expected_revision, &op).await,
        Err(refusal) => reply(Err(refusal)),
    }
}

#[cfg(test)]
#[path = "browser_policy_tests.rs"]
mod tests;
