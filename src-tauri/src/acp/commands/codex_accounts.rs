//! Desktop `#[tauri::command]` wrappers over the Codex Account operations of
//! [`CodexAgentService`]. Adding, renaming, removing and the ChatGPT sign-in
//! spawn are `/ws` requests (`web::ws::codex_accounts`). The desktop renderer
//! reaches those over its Tauri Channel carrier, the same way it reaches the
//! Claude Account writes.

use std::sync::Arc;

use tauri::State;

use crate::acp::codex_accounts::usage::CodexAccountUsage;
use crate::acp::codex_accounts::CodexAccountsSnapshot;
use crate::acp::{CodexAgentService, CodexSignInCheck};

#[tauri::command]
pub async fn codex_accounts_usage(
    service: State<'_, Arc<CodexAgentService>>,
    force: Option<bool>,
) -> Result<Vec<CodexAccountUsage>, String> {
    service.accounts_usage(force.unwrap_or(false)).await
}

#[tauri::command]
pub async fn codex_accounts_list(
    service: State<'_, Arc<CodexAgentService>>,
) -> Result<CodexAccountsSnapshot, String> {
    service.accounts_snapshot().await
}

#[tauri::command]
pub async fn codex_accounts_set_default(
    service: State<'_, Arc<CodexAgentService>>,
    account_id: String,
) -> Result<(), String> {
    let service = Arc::clone(service.inner());
    service
        .set_default_account(&account_id, CodexSignInCheck::Required)
        .await
}

/// With `expected_account_id`, the choice applies only while the Project still
/// uses that Account. Returns whether it applied.
#[tauri::command]
pub async fn codex_accounts_set_project(
    service: State<'_, Arc<CodexAgentService>>,
    project_id: String,
    account_id: Option<String>,
    expected_account_id: Option<String>,
) -> Result<bool, String> {
    let service = Arc::clone(service.inner());
    service
        .set_project_account(
            &project_id,
            account_id.as_deref(),
            expected_account_id.as_deref(),
            CodexSignInCheck::Required,
        )
        .await
}

#[tauri::command]
pub fn codex_accounts_set_auto_switch(
    service: State<'_, Arc<CodexAgentService>>,
    enabled: bool,
) -> Result<(), String> {
    service.set_auto_switch(enabled)
}
