//! Codex Account WS handlers: list the Accounts, choose the Default or a
//! Project Account, turn the automatic-switching placeholder on or off, add,
//! rename and remove an Account, and start a ChatGPT sign-in by spawning the
//! Codex agent with that Account's home. The client then calls `authenticate`
//! (`chat-gpt` or `chat-gpt-device-code`). No secret is logged.

use super::*;
use crate::acp::config::AgentConfig;
use crate::acp::CodexSignInCheck;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SetDefaultCodexAccountPayload {
    account_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SetProjectCodexAccountPayload {
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
pub(super) struct SetCodexAutoSwitchPayload {
    enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AddCodexAccountPayload {
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CodexAccountIdPayload {
    account_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RenameCodexAccountPayload {
    account_id: String,
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StartCodexAccountLoginPayload {
    account_id: String,
    config: AgentConfig,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ListCodexUsagePayload {
    #[serde(default)]
    force: bool,
}

/// `list_codex_usage { force? }` → the usage windows of every Account.
/// Reads are cached 5 minutes; a forced read still reuses one younger than 60 seconds.
pub(super) async fn handle_list_codex_usage(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
) -> WsReply {
    let parsed: ListCodexUsagePayload = serde_json::from_value(payload.clone()).unwrap_or_default();
    match acp.codex_agent().accounts_usage(parsed.force).await {
        Ok(usage) => ok_with_payload(id, &json!({ "usage": usage })),
        Err(error) => {
            warn!(error = %error, "list_codex_usage failed");
            WsReply::err(id, WsErrorCode::Unsupported, error)
        }
    }
}

/// `list_codex_accounts` → the secret-free Account snapshot.
pub(super) async fn handle_list_codex_accounts(id: String, acp: &Arc<AcpManager>) -> WsReply {
    match acp.codex_agent().accounts_snapshot().await {
        Ok(snapshot) => ok_with_payload(id, &snapshot),
        Err(error) => {
            warn!(error = %error, "list_codex_accounts failed");
            WsReply::err(id, WsErrorCode::Unsupported, error)
        }
    }
}

/// `set_default_codex_account { accountId }`.
pub(super) async fn handle_set_default_codex_account(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
) -> WsReply {
    let parsed: SetDefaultCodexAccountPayload = match serde_json::from_value(payload.clone()) {
        Ok(parsed) => parsed,
        Err(error) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed set_default_codex_account payload (want accountId): {error}"),
            )
        }
    };
    match acp
        .codex_agent()
        .set_default_account(&parsed.account_id, CodexSignInCheck::Required)
        .await
    {
        Ok(()) => {
            info!("default Codex profile set over ws");
            WsReply::ok(id, Some(json!({})))
        }
        Err(error) => choice_refused(id, error),
    }
}

/// `set_project_codex_account { projectId, accountId | null, expectedAccountId? }`
/// → `{ applied }`.
pub(super) async fn handle_set_project_codex_account(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
) -> WsReply {
    let parsed: SetProjectCodexAccountPayload = match serde_json::from_value(payload.clone()) {
        Ok(parsed) => parsed,
        Err(error) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!(
                "malformed set_project_codex_account payload (want projectId, accountId): {error}"
            ),
            )
        }
    };
    match acp
        .codex_agent()
        .set_project_account(
            &parsed.project_id,
            parsed.account_id.as_deref(),
            parsed.expected_account_id.as_deref(),
            CodexSignInCheck::Required,
        )
        .await
    {
        Ok(applied) => {
            info!(applied, "project Codex profile set over ws");
            WsReply::ok(id, Some(json!({ "applied": applied })))
        }
        Err(error) => choice_refused(id, error),
    }
}

/// `set_codex_auto_switch { enabled }` → `{}`. The flag is stored. Automatic
/// switching itself waits until a usage probe exists.
pub(super) async fn handle_set_codex_auto_switch(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
) -> WsReply {
    let parsed: SetCodexAutoSwitchPayload = match serde_json::from_value(payload.clone()) {
        Ok(parsed) => parsed,
        Err(error) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed set_codex_auto_switch payload (want enabled): {error}"),
            )
        }
    };
    match acp.codex_agent().set_auto_switch(parsed.enabled) {
        Ok(()) => {
            info!(
                enabled = parsed.enabled,
                "Codex automatic switching flag set over ws"
            );
            WsReply::ok(id, Some(json!({})))
        }
        Err(error) => {
            warn!(error = %error, "set_codex_auto_switch failed");
            WsReply::err(id, WsErrorCode::Unsupported, error)
        }
    }
}

/// `add_codex_account { name }` → the new account, signed out.
pub(super) async fn handle_add_codex_account(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
) -> WsReply {
    let parsed: AddCodexAccountPayload = match serde_json::from_value(payload.clone()) {
        Ok(parsed) => parsed,
        Err(error) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed add_codex_account payload (want name): {error}"),
            )
        }
    };
    match acp.codex_agent().add_account(&parsed.name) {
        Ok(created) => {
            info!("Codex profile added over ws");
            ok_with_payload(id, &created)
        }
        Err(error) => {
            warn!(error = %error, "add_codex_account failed");
            WsReply::err(id, WsErrorCode::Unsupported, error)
        }
    }
}

/// `rename_codex_account { accountId, name }` → `{}`.
pub(super) async fn handle_rename_codex_account(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
) -> WsReply {
    let parsed: RenameCodexAccountPayload = match serde_json::from_value(payload.clone()) {
        Ok(parsed) => parsed,
        Err(error) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed rename_codex_account payload (want accountId, name): {error}"),
            )
        }
    };
    match acp
        .codex_agent()
        .rename_account(&parsed.account_id, &parsed.name)
    {
        Ok(()) => {
            info!("Codex profile renamed over ws");
            WsReply::ok(id, Some(json!({})))
        }
        Err(error) => {
            warn!(error = %error, "rename_codex_account failed");
            WsReply::err(id, WsErrorCode::Unsupported, error)
        }
    }
}

/// `remove_codex_account { accountId }` → `{ movedProjectIds }`. Runs
/// `codex logout` for that home first. The built-in Account is refused. An
/// Account that is already gone answers `{ movedProjectIds: [] }`.
pub(super) async fn handle_remove_codex_account(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
) -> WsReply {
    let parsed: CodexAccountIdPayload = match serde_json::from_value(payload.clone()) {
        Ok(parsed) => parsed,
        Err(error) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed remove_codex_account payload (want accountId): {error}"),
            )
        }
    };
    let profile_id = parsed.account_id;
    let service = acp.codex_agent();
    match service.remove_account(&profile_id).await {
        Ok(moved) => {
            info!(moved = moved.len(), "Codex profile removed over ws");
            WsReply::ok(id, Some(json!({ "movedProjectIds": moved })))
        }
        Err(_) if matches!(service.has_account(&profile_id), Ok(false)) => {
            info!("Codex profile already removed");
            WsReply::ok(id, Some(json!({ "movedProjectIds": [] })))
        }
        Err(error) => {
            warn!(error = %error, "remove_codex_account failed");
            WsReply::err(id, WsErrorCode::Unsupported, error)
        }
    }
}

/// `start_codex_account_login { accountId, config }` → the spawn outcome of an
/// agent whose `CODEX_HOME` is that Account. The client authenticates it with
/// `chat-gpt` or `chat-gpt-device-code`.
pub(super) async fn handle_start_codex_account_login(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
    command_id: Option<String>,
) -> WsReply {
    let mut parsed: StartCodexAccountLoginPayload = match serde_json::from_value(payload.clone()) {
        Ok(parsed) => parsed,
        Err(error) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!(
                    "malformed start_codex_account_login payload (want accountId, config): {error}"
                ),
            )
        }
    };
    if let Err(error) = crate::acp::config::validate_spawn_config(&mut parsed.config) {
        return acp_err_to_reply(id, error);
    }
    match acp
        .spawn_codex_sign_in(parsed.config, &parsed.account_id, command_id)
        .await
    {
        Ok(outcome) => {
            info!("Codex profile sign-in spawn started over ws");
            ok_with_payload(id, &outcome)
        }
        Err(error) => {
            warn!("start_codex_account_login failed");
            acp_err_to_reply(id, error)
        }
    }
}

/// A refused Account choice: `codex_account_signed_out` when the Account is
/// not signed in (the stored choice is unchanged), else `not_found`.
fn choice_refused(id: String, error: String) -> WsReply {
    match crate::acp::codex_accounts::strip_signed_out_tag(&error) {
        Some(message) => {
            info!("Codex account choice refused over ws: the account is not signed in");
            WsReply::err(id, WsErrorCode::CodexAccountSignedOut, message.to_string())
        }
        None => WsReply::err(id, WsErrorCode::NotFound, error),
    }
}

#[cfg(test)]
#[path = "codex_accounts_tests.rs"]
mod tests;
