//! Claude Account WS handlers: list the Accounts and their usage, choose the
//! Default or a Project Account, and turn automatic switching on or off. Adding, signing in, renaming, and
//! removing an Account stay on the host (desktop UI or
//! `termul-server claude account`), because they
//! start a browser login or delete login state on the host.

use super::*;
use crate::acp::SignInCheck;

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
