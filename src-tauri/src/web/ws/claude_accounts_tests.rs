use super::*;
use crate::acp::ClaudeAgentService;

/// A host state dir whose account list holds the built-in Account and "Work"
/// (`ab12`); the login probe reports the Accounts in `signed_out` signed out.
fn manager_with_account(signed_out: &[&str]) -> (tempfile::TempDir, Arc<AcpManager>) {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(
        root.path().join("claude-accounts.json"),
        br#"{"version":1,"accounts":[{"id":"default","name":"Default","createdAt":0},{"id":"ab12","name":"Work","createdAt":1}],"defaultAccountId":"default"}"#,
    )
    .unwrap();
    let service = ClaudeAgentService::with_logins_for_test(root.path(), signed_out);
    let acp = Arc::new(AcpManager::with_claude_agent(vec![], Arc::new(service)));
    (root, acp)
}

fn stored(root: &tempfile::TempDir) -> Value {
    serde_json::from_slice(&std::fs::read(root.path().join("claude-accounts.json")).unwrap())
        .unwrap()
}

#[tokio::test]
async fn set_default_and_project_account_persist_on_the_host() {
    let (root, acp) = manager_with_account(&[]);
    let reply =
        handle_set_default_claude_account("1".into(), &json!({ "accountId": "ab12" }), &acp).await;
    assert!(reply.ok);
    let reply = handle_set_project_claude_account(
        "2".into(),
        &json!({ "projectId": "office", "accountId": "ab12" }),
        &acp,
    )
    .await;
    assert!(reply.ok);
    let file = stored(&root);
    assert_eq!(file["defaultAccountId"], "ab12");
    assert_eq!(file["projectAccounts"]["office"], "ab12");

    let reply = handle_set_project_claude_account(
        "3".into(),
        &json!({ "projectId": "office", "accountId": null }),
        &acp,
    )
    .await;
    assert!(reply.ok);
    assert!(stored(&root)["projectAccounts"].get("office").is_none());
}

#[tokio::test]
async fn unknown_accounts_and_malformed_payloads_are_rejected() {
    let (_root, acp) = manager_with_account(&[]);
    let reply =
        handle_set_default_claude_account("1".into(), &json!({ "accountId": "ffff" }), &acp).await;
    assert_eq!(reply.err.unwrap().code, "not_found");
    let reply =
        handle_set_project_claude_account("2".into(), &json!({ "accountId": "ab12" }), &acp).await;
    assert_eq!(reply.err.unwrap().code, "unsupported");
}

#[tokio::test]
async fn a_signed_out_account_is_refused_with_its_code_and_the_choice_stays() {
    let (root, acp) = manager_with_account(&["ab12"]);
    let reply = handle_set_project_claude_account(
        "1".into(),
        &json!({ "projectId": "office", "accountId": "ab12" }),
        &acp,
    )
    .await;
    let err = reply.err.unwrap();
    assert_eq!(err.code, "claude_account_signed_out");
    assert_eq!(
        err.message,
        "The Claude account \"Work\" is not signed in. Sign in to it in Settings → Accounts, then choose it again."
    );
    let reply =
        handle_set_default_claude_account("2".into(), &json!({ "accountId": "ab12" }), &acp).await;
    assert_eq!(reply.err.unwrap().code, "claude_account_signed_out");
    let file = stored(&root);
    assert_eq!(file["defaultAccountId"], "default");
    assert!(file
        .get("projectAccounts")
        .is_none_or(|p| p.get("office").is_none()));
}

#[test]
fn a_signed_out_spawn_reply_carries_the_code_without_the_tag() {
    let reply = acp_err_to_reply(
        "1".into(),
        crate::acp::claude_accounts::signed_out_error(
            "The Claude account \"Work\" is not signed in.",
        ),
    );
    let err = reply.err.unwrap();
    assert_eq!(err.code, "claude_account_signed_out");
    assert_eq!(err.message, "The Claude account \"Work\" is not signed in.");
}

#[tokio::test]
async fn a_host_without_state_reports_no_accounts() {
    let acp = Arc::new(AcpManager::new(vec![]));
    let reply = handle_list_claude_accounts("1".into(), &acp).await;
    assert!(!reply.ok);
    let reply = handle_list_claude_usage("2".into(), &json!({ "force": true }), &acp).await;
    assert_eq!(reply.err.unwrap().code, "unsupported");
}

#[tokio::test]
async fn usage_in_api_key_mode_lists_every_account_without_a_probe() {
    let (root, acp) = manager_with_account(&[]);
    std::fs::write(root.path().join("claude-auth-mode"), b"api-key").unwrap();
    let reply = handle_list_claude_usage("1".into(), &json!({}), &acp).await;
    assert!(reply.ok);
    let usage = &reply.payload.unwrap()["usage"];
    let ids: Vec<&str> = usage
        .as_array()
        .unwrap()
        .iter()
        .map(|u| u["accountId"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["default", "ab12"]);
    assert_eq!(usage[0]["status"], "unavailable");
}

#[tokio::test]
async fn add_rename_and_remove_change_the_host_account_list() {
    let (root, acp) = manager_with_account(&[]);
    let reply = handle_add_claude_account("1".into(), &json!({ "name": "Side" }), &acp);
    assert!(reply.ok, "{:?}", reply.err);
    let added = reply.payload.unwrap();
    assert_eq!(added["name"], "Side");
    let new_id = added["id"].as_str().unwrap().to_string();

    let reply = handle_rename_claude_account(
        "2".into(),
        &json!({ "accountId": new_id, "name": "Personal" }),
        &acp,
    );
    assert!(reply.ok, "{:?}", reply.err);
    let names: Vec<String> = stored(&root)["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["name"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(names, vec!["Default", "Work", "Personal"]);

    let reply = handle_set_project_claude_account(
        "3".into(),
        &json!({ "projectId": "office", "accountId": new_id }),
        &acp,
    )
    .await;
    assert!(reply.ok);
    let reply = handle_remove_claude_account("4".into(), &json!({ "accountId": new_id }), &acp).await;
    assert!(reply.ok, "{:?}", reply.err);
    assert_eq!(reply.payload.unwrap(), json!({ "movedProjectIds": ["office"] }));
    assert_eq!(stored(&root)["accounts"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn management_refusals_carry_the_host_text() {
    let (_root, acp) = manager_with_account(&[]);
    let reply = handle_add_claude_account("1".into(), &json!({ "name": "Work" }), &acp);
    let err = reply.err.unwrap();
    assert_eq!(err.code, "unsupported");
    assert_eq!(err.message, "An account named \"Work\" already exists");

    let reply = handle_rename_claude_account(
        "2".into(),
        &json!({ "accountId": "ffff", "name": "X" }),
        &acp,
    );
    assert_eq!(reply.err.unwrap().code, "not_found");
    let reply = handle_login_claude_account("3".into(), &json!({ "accountId": "ffff" }), &acp).await;
    let err = reply.err.unwrap();
    assert_eq!((err.code.as_str(), err.message.as_str()), ("not_found", "That Claude account does not exist"));
    let reply = handle_remove_claude_account("4".into(), &json!({ "accountId": "default" }), &acp).await;
    assert_eq!(reply.err.unwrap().message, "The built-in account cannot be removed");
    let reply = handle_add_claude_account("5".into(), &json!({}), &acp);
    assert!(reply.err.unwrap().message.starts_with("malformed add_claude_account payload (want name)"));
}

#[test]
fn cancelling_without_a_running_sign_in_reports_false() {
    let (_root, acp) = manager_with_account(&[]);
    let reply = handle_cancel_claude_account_login("1".into(), &json!({ "accountId": "ab12" }), &acp);
    assert_eq!(reply.payload.unwrap(), json!({ "cancelled": false }));
}
