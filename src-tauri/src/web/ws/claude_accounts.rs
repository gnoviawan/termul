//! Claude Account WS handlers: list the Accounts and their usage, and choose
//! the Default or a Project Account. Adding, signing in, renaming, and
//! removing an Account stay on the host (desktop UI or
//! `termul-server claude account`), because they
//! start a browser login or delete login state on the host.

use super::*;

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
pub(super) fn handle_set_default_claude_account(
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
    match acp.claude_agent().set_default_account(&parsed.account_id) {
        Ok(()) => {
            info!(account = %parsed.account_id, "default Claude account set over ws");
            WsReply::ok(id, Some(json!({})))
        }
        Err(error) => WsReply::err(id, WsErrorCode::NotFound, error),
    }
}

/// `set_project_claude_account { projectId, accountId | null }`.
pub(super) fn handle_set_project_claude_account(
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
        .set_project_account(&parsed.project_id, parsed.account_id.as_deref())
    {
        Ok(()) => {
            info!(
                project = %parsed.project_id,
                account = parsed.account_id.as_deref().unwrap_or("default"),
                "project Claude account set over ws"
            );
            WsReply::ok(id, Some(json!({})))
        }
        Err(error) => WsReply::err(id, WsErrorCode::NotFound, error),
    }
}

#[cfg(test)]
#[path = "claude_accounts_tests.rs"]
mod tests;
