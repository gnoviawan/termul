//! Claude Account WS handlers: list the Accounts and their usage, choose the
//! Default or a Project Account, turn automatic switching on or off, add,
//! rename and remove an Account, and sign it in with a link: the host hands
//! out the Claude sign-in link and takes back the code the Claude page shows.
//! The sign-in link and the code are never logged.

use super::*;
use crate::acp::{LinkCodeError, SignInCheck};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SetDefaultClaudeAccountPayload {
    account_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SetProjectClaudeAccountPayload {
    project_id: String,
    /// `null` returns the Project to the Default Account.
    #[serde(default)]
    account_id: Option<String>,
    /// Apply only while the Project still uses this Account.
    #[serde(default)]
    expected_account_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SetClaudeAutoSwitchPayload {
    enabled: bool,
}

/// `list_claude_accounts` → the secret-free Account snapshot.
pub(super) async fn handle_list_claude_accounts(id: String, acp: &Arc<AcpManager>) -> WsReply {
    match acp.claude_agent().accounts_snapshot().await {
        Ok(snapshot) => ok_with_payload(id, &snapshot),
        Err(error) => {
            warn!(error = %error, "list_claude_accounts failed");
            WsReply::err(id, WsErrorCode::Unsupported, error)
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ListClaudeUsagePayload {
    #[serde(default)]
    force: bool,
}

/// `list_claude_usage { force? }` → the usage windows of every Account.
pub(super) async fn handle_list_claude_usage(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
) -> WsReply {
    let parsed: ListClaudeUsagePayload =
        serde_json::from_value(payload.clone()).unwrap_or_default();
    match acp.claude_agent().accounts_usage(parsed.force).await {
        Ok(usage) => ok_with_payload(id, &json!({ "usage": usage })),
        Err(error) => {
            warn!(error = %error, "list_claude_usage failed");
            WsReply::err(id, WsErrorCode::Unsupported, error)
        }
    }
}

/// `set_default_claude_account { accountId }`.
pub(super) async fn handle_set_default_claude_account(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
) -> WsReply {
    let parsed: SetDefaultClaudeAccountPayload = match serde_json::from_value(payload.clone()) {
        Ok(parsed) => parsed,
        Err(error) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed set_default_claude_account payload (want accountId): {error}"),
            )
        }
    };
    match acp
        .claude_agent()
        .set_default_account(&parsed.account_id, SignInCheck::Required)
        .await
    {
        Ok(()) => {
            info!(account = %parsed.account_id, "default Claude account set over ws");
            WsReply::ok(id, Some(json!({})))
        }
        Err(error) => choice_refused(id, error),
    }
}

/// `set_project_claude_account { projectId, accountId | null, expectedAccountId? }`
/// → `{ applied }`; `applied` is `false` when the Project no longer uses
/// `expectedAccountId`.
pub(super) async fn handle_set_project_claude_account(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
) -> WsReply {
    let parsed: SetProjectClaudeAccountPayload = match serde_json::from_value(payload.clone()) {
        Ok(parsed) => parsed,
        Err(error) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!(
                "malformed set_project_claude_account payload (want projectId, accountId): {error}"
            ),
            )
        }
    };
    match acp
        .claude_agent()
        .set_project_account(
            &parsed.project_id,
            parsed.account_id.as_deref(),
            parsed.expected_account_id.as_deref(),
            SignInCheck::Required,
        )
        .await
    {
        Ok(applied) => {
            info!(
                project = %parsed.project_id,
                account = parsed.account_id.as_deref().unwrap_or("default"),
                applied,
                "project Claude account set over ws"
            );
            WsReply::ok(id, Some(json!({ "applied": applied })))
        }
        Err(error) => choice_refused(id, error),
    }
}

/// `set_claude_auto_switch { enabled }` → `{}`.
pub(super) async fn handle_set_claude_auto_switch(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
) -> WsReply {
    let parsed: SetClaudeAutoSwitchPayload = match serde_json::from_value(payload.clone()) {
        Ok(parsed) => parsed,
        Err(error) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed set_claude_auto_switch payload (want enabled): {error}"),
            )
        }
    };
    match acp.claude_agent().set_auto_switch(parsed.enabled) {
        Ok(()) => {
            info!(
                enabled = parsed.enabled,
                "Claude automatic switching set over ws"
            );
            WsReply::ok(id, Some(json!({})))
        }
        Err(error) => {
            warn!(error = %error, "set_claude_auto_switch failed");
            WsReply::err(id, WsErrorCode::Unsupported, error)
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AddClaudeAccountPayload {
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AccountIdPayload {
    account_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RenameClaudeAccountPayload {
    account_id: String,
    name: String,
}

/// No `Debug`: the code must never reach a log line.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FinishClaudeLinkLoginPayload {
    account_id: String,
    code: String,
}

/// `add_claude_account { name }` → the new `ClaudeAccount`, signed out.
pub(super) async fn handle_add_claude_account(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
) -> WsReply {
    let parsed: AddClaudeAccountPayload = match serde_json::from_value(payload.clone()) {
        Ok(parsed) => parsed,
        Err(error) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed add_claude_account payload (want name): {error}"),
            )
        }
    };
    match acp.claude_agent().add_account(&parsed.name) {
        Ok(account) => {
            info!(account = %account.id, "Claude account added over ws");
            ok_with_payload(id, &account)
        }
        Err(error) => {
            warn!(error = %error, "add_claude_account failed");
            WsReply::err(id, WsErrorCode::Unsupported, error)
        }
    }
}

/// `rename_claude_account { accountId, name }` → `{}`. Renaming to the
/// current name succeeds, so a repeat answers like the first.
pub(super) async fn handle_rename_claude_account(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
) -> WsReply {
    let parsed: RenameClaudeAccountPayload = match serde_json::from_value(payload.clone()) {
        Ok(parsed) => parsed,
        Err(error) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed rename_claude_account payload (want accountId, name): {error}"),
            )
        }
    };
    match acp
        .claude_agent()
        .rename_account(&parsed.account_id, &parsed.name)
    {
        Ok(()) => {
            info!(account = %parsed.account_id, "Claude account renamed over ws");
            WsReply::ok(id, Some(json!({})))
        }
        Err(error) => {
            warn!(account = %parsed.account_id, error = %error, "rename_claude_account failed");
            WsReply::err(id, WsErrorCode::Unsupported, error)
        }
    }
}

/// `remove_claude_account { accountId }` → `{ movedProjectIds }`, the Projects
/// that moved to the Default Account. The built-in Account is refused. An
/// Account that is already gone answers `{ movedProjectIds: [] }`, so a repeat
/// (a second click, another client) converges instead of failing.
pub(super) async fn handle_remove_claude_account(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
) -> WsReply {
    let parsed: AccountIdPayload = match serde_json::from_value(payload.clone()) {
        Ok(parsed) => parsed,
        Err(error) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed remove_claude_account payload (want accountId): {error}"),
            )
        }
    };
    let account = parsed.account_id;
    let service = acp.claude_agent();
    match service.remove_account(&account).await {
        Ok(moved) => {
            info!(account = %account, moved = moved.len(), "Claude account removed over ws");
            WsReply::ok(id, Some(json!({ "movedProjectIds": moved })))
        }
        Err(_) if matches!(service.has_account(&account), Ok(false)) => {
            info!(account = %account, "Claude account already removed");
            WsReply::ok(id, Some(json!({ "movedProjectIds": [] })))
        }
        Err(error) => {
            warn!(account = %account, error = %error, "remove_claude_account failed");
            WsReply::err(id, WsErrorCode::Unsupported, error)
        }
    }
}

/// `start_claude_link_login { accountId }` → `{ url }`, the Claude sign-in
/// link. Replaces a sign-in already running for the Account.
pub(super) async fn handle_start_claude_link_login(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
) -> WsReply {
    let parsed: AccountIdPayload = match serde_json::from_value(payload.clone()) {
        Ok(parsed) => parsed,
        Err(error) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed start_claude_link_login payload (want accountId): {error}"),
            )
        }
    };
    match acp
        .claude_agent()
        .start_link_login(&parsed.account_id)
        .await
    {
        Ok(url) => {
            info!(account = %parsed.account_id, "Claude link sign-in started over ws");
            WsReply::ok(id, Some(json!({ "url": url })))
        }
        Err(error) => {
            warn!(account = %parsed.account_id, error = %error, "start_claude_link_login failed");
            WsReply::err(id, WsErrorCode::Unsupported, error)
        }
    }
}

/// `finish_claude_link_login { accountId, code }` → `{}` once the Claude CLI
/// stored the login. `claude_login_code_incomplete` keeps the sign-in waiting
/// for another paste; any other error ended it.
pub(super) async fn handle_finish_claude_link_login(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
) -> WsReply {
    let Ok(parsed) = serde_json::from_value::<FinishClaudeLinkLoginPayload>(payload.clone()) else {
        return WsReply::err(
            id,
            WsErrorCode::Unsupported,
            "malformed finish_claude_link_login payload (want accountId, code)".to_string(),
        );
    };
    let account = parsed.account_id;
    match acp
        .claude_agent()
        .finish_link_login(&account, &parsed.code)
        .await
    {
        Ok(()) => {
            info!(account = %account, "Claude link sign-in finished over ws");
            WsReply::ok(id, Some(json!({})))
        }
        Err(error @ LinkCodeError::Incomplete) => {
            info!(account = %account, "Claude sign-in code incomplete over ws");
            WsReply::err(
                id,
                WsErrorCode::ClaudeLoginCodeIncomplete,
                error.message().to_string(),
            )
        }
        Err(error @ LinkCodeError::Ended(_)) => {
            warn!(account = %account, "Claude link sign-in ended without a login over ws");
            WsReply::err(id, WsErrorCode::Unsupported, error.message().to_string())
        }
    }
}

/// `cancel_claude_login { accountId }` → `{ cancelled }`; stops a browser or
/// link sign-in and answers once its CLI is gone. `cancelled` is `false` when
/// none was running.
pub(super) async fn handle_cancel_claude_login(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
) -> WsReply {
    let parsed: AccountIdPayload = match serde_json::from_value(payload.clone()) {
        Ok(parsed) => parsed,
        Err(error) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed cancel_claude_login payload (want accountId): {error}"),
            )
        }
    };
    let cancelled = acp.claude_agent().cancel_login(&parsed.account_id).await;
    info!(account = %parsed.account_id, cancelled, "Claude sign-in cancel over ws");
    WsReply::ok(id, Some(json!({ "cancelled": cancelled })))
}

/// A refused Account choice: `claude_account_signed_out` when the Account is
/// not signed in (the stored choice is unchanged), else `not_found`.
fn choice_refused(id: String, error: String) -> WsReply {
    match crate::acp::claude_accounts::strip_signed_out_tag(&error) {
        Some(message) => {
            info!("Claude account choice refused over ws: the account is not signed in");
            WsReply::err(id, WsErrorCode::ClaudeAccountSignedOut, message.to_string())
        }
        None => WsReply::err(id, WsErrorCode::NotFound, error),
    }
}

#[cfg(test)]
#[path = "claude_accounts_tests.rs"]
mod tests;
