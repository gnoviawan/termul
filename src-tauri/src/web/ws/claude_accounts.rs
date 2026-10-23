//! Claude Account WS handlers: list the Accounts and their usage, choose the
//! Default or a Project Account, and manage the Accounts (add, sign in,
//! cancel a sign-in, rename, remove). Management starts a browser login or
//! deletes login state on the host, so the capability check admits it only
//! for a `host_local` connection (`web::capabilities`). The handlers call the
//! same [`crate::acp::ClaudeAgentService`] methods as the desktop commands.

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

/// `set_project_claude_account { projectId, accountId | null }`.
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
            SignInCheck::Required,
        )
        .await
    {
        Ok(()) => {
            info!(
                project = %parsed.project_id,
                account = parsed.account_id.as_deref().unwrap_or("default"),
                "project Claude account set over ws"
            );
            WsReply::ok(id, Some(json!({})))
        }
        Err(error) => choice_refused(id, error),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountNamePayload {
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountIdPayload {
    account_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameAccountPayload {
    account_id: String,
    name: String,
}

fn parse<T: serde::de::DeserializeOwned>(
    id: &str,
    request: &str,
    want: &str,
    payload: &Value,
) -> Result<T, WsReply> {
    serde_json::from_value(payload.clone()).map_err(|error| {
        WsReply::err(
            id.to_string(),
            WsErrorCode::Unsupported,
            format!("malformed {request} payload (want {want}): {error}"),
        )
    })
}

/// A refused management call. The host's text is user-facing and secret-free
/// (account names, never login state); an unknown id answers `not_found`.
fn management_refused(id: String, request: &str, error: String) -> WsReply {
    warn!(request, error = %error, "Claude account management refused over ws");
    let code = if error == crate::acp::claude_accounts::UNKNOWN_ACCOUNT {
        WsErrorCode::NotFound
    } else {
        WsErrorCode::Unsupported
    };
    WsReply::err(id, code, error)
}

/// `add_claude_account { name }` → the new `ClaudeAccount`.
pub(super) fn handle_add_claude_account(id: String, payload: &Value, acp: &Arc<AcpManager>) -> WsReply {
    let parsed: AccountNamePayload = match parse(&id, "add_claude_account", "name", payload) {
        Ok(parsed) => parsed,
        Err(reply) => return reply,
    };
    match acp.claude_agent().add_account(&parsed.name) {
        Ok(account) => {
            info!(account = %account.id, "Claude account added over ws");
            ok_with_payload(id, &account)
        }
        Err(error) => management_refused(id, "add_claude_account", error),
    }
}

/// `login_claude_account { accountId }` → `{}` once the host's browser login
/// finishes. A cancelled login fails with the host's cancelled text.
pub(super) async fn handle_login_claude_account(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
) -> WsReply {
    let parsed: AccountIdPayload = match parse(&id, "login_claude_account", "accountId", payload) {
        Ok(parsed) => parsed,
        Err(reply) => return reply,
    };
    info!(account = %parsed.account_id, "Claude account sign-in started over ws");
    match acp.claude_agent().login_account(&parsed.account_id).await {
        Ok(()) => WsReply::ok(id, Some(json!({}))),
        Err(error) => management_refused(id, "login_claude_account", error),
    }
}

/// `cancel_claude_account_login { accountId }` → `{ cancelled }`; `false`
/// when no sign-in of that Account was running.
pub(super) fn handle_cancel_claude_account_login(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
) -> WsReply {
    let parsed: AccountIdPayload =
        match parse(&id, "cancel_claude_account_login", "accountId", payload) {
            Ok(parsed) => parsed,
            Err(reply) => return reply,
        };
    let cancelled = acp.claude_agent().cancel_login(&parsed.account_id);
    info!(account = %parsed.account_id, cancelled, "Claude account sign-in cancel over ws");
    WsReply::ok(id, Some(json!({ "cancelled": cancelled })))
}

/// `rename_claude_account { accountId, name }` → `{}`.
pub(super) fn handle_rename_claude_account(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
) -> WsReply {
    let parsed: RenameAccountPayload =
        match parse(&id, "rename_claude_account", "accountId, name", payload) {
            Ok(parsed) => parsed,
            Err(reply) => return reply,
        };
    match acp.claude_agent().rename_account(&parsed.account_id, &parsed.name) {
        Ok(()) => {
            info!(account = %parsed.account_id, "Claude account renamed over ws");
            WsReply::ok(id, Some(json!({})))
        }
        Err(error) => management_refused(id, "rename_claude_account", error),
    }
}

/// `remove_claude_account { accountId }` → `{ movedProjectIds }`, the
/// Projects that moved to the Default Account.
pub(super) async fn handle_remove_claude_account(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
) -> WsReply {
    let parsed: AccountIdPayload = match parse(&id, "remove_claude_account", "accountId", payload) {
        Ok(parsed) => parsed,
        Err(reply) => return reply,
    };
    match acp.claude_agent().remove_account(&parsed.account_id).await {
        Ok(moved) => {
            info!(account = %parsed.account_id, moved = moved.len(), "Claude account removed over ws");
            WsReply::ok(id, Some(json!({ "movedProjectIds": moved })))
        }
        Err(error) => management_refused(id, "remove_claude_account", error),
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
