//! `github_*` Tauri commands: desktop transport for [`GithubService`]. The
//! `/github/*` web routes (`web/github_api.rs`) call the same service.
//! Each command takes one `request` argument, as `lib/github-api.ts` sends it.

use super::{validate_project_path, IpcResult};
use crate::github::*;

/// Validate `cwd`, then run `op` on the blocking pool.
async fn run<T: Send + 'static>(
    command: &'static str,
    cwd: &str,
    op: impl FnOnce(&GithubService, String) -> Result<T, GithubError> + Send + 'static,
) -> Result<IpcResult<T>, String> {
    let cwd = match validate_project_path(cwd) {
        Ok(path) => path.to_string_lossy().into_owned(),
        Err(e) => {
            log::warn!("[{command}] invalid cwd: {e}");
            return Ok(IpcResult::error(e, "PATH_VALIDATION_FAILED"));
        }
    };
    let result = tokio::task::spawn_blocking(move || op(&GithubService::shared(), cwd))
        .await
        .map_err(|e| format!("{command} task failed: {e}"))?;
    Ok(match result {
        Ok(data) => IpcResult::success(data),
        Err(e) => IpcResult::error(e.to_string(), e.code()),
    })
}

#[tauri::command]
pub async fn github_get_context(
    request: GithubContextRequest,
) -> Result<IpcResult<GithubContext>, String> {
    run("github_get_context", &request.cwd, |service, cwd| {
        service.context(&cwd)
    })
    .await
}

#[tauri::command]
pub async fn github_list_items(
    request: GithubListRequest,
) -> Result<IpcResult<GithubListResult>, String> {
    let cwd = request.cwd.clone();
    run("github_list_items", &cwd, move |service, cwd| {
        service.list_items(&GithubListRequest { cwd, ..request })
    })
    .await
}

#[tauri::command]
pub async fn github_get_item(
    request: GithubItemRequest,
) -> Result<IpcResult<GithubItemDetail>, String> {
    let cwd = request.cwd.clone();
    run("github_get_item", &cwd, move |service, cwd| {
        service.get_item(&GithubItemRequest { cwd, ..request })
    })
    .await
}

#[tauri::command]
pub async fn github_get_checks(
    request: GithubChecksRequest,
) -> Result<IpcResult<GithubChecksResult>, String> {
    let cwd = request.cwd.clone();
    run("github_get_checks", &cwd, move |service, cwd| {
        service.get_checks(&GithubChecksRequest { cwd, ..request })
    })
    .await
}

#[tauri::command]
pub async fn github_get_check_log(
    request: GithubCheckLogRequest,
) -> Result<IpcResult<GithubCheckLog>, String> {
    let cwd = request.cwd.clone();
    run("github_get_check_log", &cwd, move |service, cwd| {
        service.get_check_log(&GithubCheckLogRequest { cwd, ..request })
    })
    .await
}

#[tauri::command]
pub async fn github_merge(
    request: GithubMergeRequest,
) -> Result<IpcResult<GithubMergeResult>, String> {
    let cwd = request.cwd.clone();
    run("github_merge", &cwd, move |service, cwd| {
        service.merge(&GithubMergeRequest { cwd, ..request })
    })
    .await
}

#[tauri::command]
pub async fn github_comment(
    request: GithubCommentRequest,
) -> Result<IpcResult<GithubCommentResult>, String> {
    let cwd = request.cwd.clone();
    run("github_comment", &cwd, move |service, cwd| {
        service.comment(&GithubCommentRequest { cwd, ..request })
    })
    .await
}

#[tauri::command]
pub async fn github_checkout_pr(
    request: GithubCheckoutPrRequest,
) -> Result<IpcResult<GithubCheckoutPrResult>, String> {
    let cwd = request.cwd.clone();
    run("github_checkout_pr", &cwd, move |service, cwd| {
        service.checkout_pr(&GithubCheckoutPrRequest { cwd, ..request })
    })
    .await
}
