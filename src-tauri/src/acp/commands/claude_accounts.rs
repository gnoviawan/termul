//! Desktop `#[tauri::command]` wrappers over the Claude Account operations of
//! [`ClaudeAgentService`]. The web client has only the list/default/project
//! subset (`web::ws::claude_accounts`).

use std::sync::Arc;

use tauri::State;

use crate::acp::claude_accounts::usage::ClaudeAccountUsage;
use crate::acp::claude_accounts::{ClaudeAccount, ClaudeAccountsSnapshot};
use crate::acp::ClaudeAgentService;

#[tauri::command]
pub async fn claude_accounts_list(
    service: State<'_, Arc<ClaudeAgentService>>,
) -> Result<ClaudeAccountsSnapshot, String> {
    service.accounts_snapshot().await
}

/// Usage windows of every Account; `force` refreshes reads older than 60s.
#[tauri::command]
pub async fn claude_accounts_usage(
    service: State<'_, Arc<ClaudeAgentService>>,
    force: Option<bool>,
) -> Result<Vec<ClaudeAccountUsage>, String> {
    let service = Arc::clone(service.inner());
    service.accounts_usage(force.unwrap_or(false)).await
}

#[tauri::command]
pub fn claude_accounts_add(
    service: State<'_, Arc<ClaudeAgentService>>,
    name: String,
) -> Result<ClaudeAccount, String> {
    service.add_account(&name)
}

/// Run the Claude browser login for one Account. Resolves when it finishes.
#[tauri::command]
pub async fn claude_accounts_login(
    service: State<'_, Arc<ClaudeAgentService>>,
    account_id: String,
) -> Result<(), String> {
    let service = Arc::clone(service.inner());
    service.login_account(&account_id).await
}

/// Stop a running browser login. Returns `false` when none was running.
#[tauri::command]
pub fn claude_accounts_login_cancel(
    service: State<'_, Arc<ClaudeAgentService>>,
    account_id: String,
) -> bool {
    service.cancel_login(&account_id)
}

#[tauri::command]
pub fn claude_accounts_rename(
    service: State<'_, Arc<ClaudeAgentService>>,
    account_id: String,
    name: String,
) -> Result<(), String> {
    service.rename_account(&account_id, &name)
}

/// Returns the ids of the Projects that moved to the Default Account.
#[tauri::command]
pub async fn claude_accounts_remove(
    service: State<'_, Arc<ClaudeAgentService>>,
    account_id: String,
) -> Result<Vec<String>, String> {
    let service = Arc::clone(service.inner());
    service.remove_account(&account_id).await
}

#[tauri::command]
pub fn claude_accounts_set_default(
    service: State<'_, Arc<ClaudeAgentService>>,
    account_id: String,
) -> Result<(), String> {
    service.set_default_account(&account_id)
}

#[tauri::command]
pub fn claude_accounts_set_project(
    service: State<'_, Arc<ClaudeAgentService>>,
    project_id: String,
    account_id: Option<String>,
) -> Result<(), String> {
    service.set_project_account(&project_id, account_id.as_deref())
}
