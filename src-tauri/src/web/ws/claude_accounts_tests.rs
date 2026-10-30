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
async fn an_expected_account_makes_the_project_choice_a_compare_and_set() {
    let (root, acp) = manager_with_account(&[]);
    let first = handle_set_project_claude_account(
        "1".into(),
        &json!({ "projectId": "office", "accountId": "ab12", "expectedAccountId": "default" }),
        &acp,
    )
    .await;
    assert_eq!(first.payload.unwrap(), json!({ "applied": true }));
    // A second client reacting to the same limit loses: the project moved on.
    let second = handle_set_project_claude_account(
        "2".into(),
        &json!({ "projectId": "office", "accountId": null, "expectedAccountId": "default" }),
        &acp,
    )
    .await;
    assert_eq!(second.payload.unwrap(), json!({ "applied": false }));
    assert_eq!(stored(&root)["projectAccounts"]["office"], "ab12");
}

#[tokio::test]
async fn automatic_switching_is_on_by_default_and_toggles_on_the_host() {
    let (root, acp) = manager_with_account(&[]);
    let listed = handle_list_claude_accounts("1".into(), &acp).await;
    assert_eq!(listed.payload.unwrap()["autoSwitch"], true);
    let reply = handle_set_claude_auto_switch("2".into(), &json!({ "enabled": false }), &acp).await;
    assert_eq!(reply.payload.unwrap(), json!({}));
    assert_eq!(stored(&root)["autoSwitch"], false);
    let listed = handle_list_claude_accounts("3".into(), &acp).await;
    assert_eq!(listed.payload.unwrap()["autoSwitch"], false);
    let malformed = handle_set_claude_auto_switch("4".into(), &json!({}), &acp).await;
    assert_eq!(malformed.err.unwrap().code, "unsupported");
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
async fn an_account_added_over_ws_is_stored_signed_out_on_the_host() {
    let (root, acp) = manager_with_account(&[]);
    let reply = handle_add_claude_account("1".into(), &json!({ "name": "Personal" }), &acp).await;
    let account = reply.payload.unwrap();
    assert_eq!(account["name"], "Personal");
    let id = account["id"].as_str().unwrap();
    let file = stored(&root);
    let names: Vec<&str> = file["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["id"] == id)
        .map(|row| row["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["Personal"]);

    let duplicate =
        handle_add_claude_account("2".into(), &json!({ "name": "Personal" }), &acp).await;
    assert_eq!(duplicate.err.unwrap().code, "unsupported");
    let malformed = handle_add_claude_account("3".into(), &json!({}), &acp).await;
    assert_eq!(malformed.err.unwrap().code, "unsupported");
}

#[tokio::test]
async fn a_code_with_no_sign_in_waiting_says_to_start_again() {
    let (_root, acp) = manager_with_account(&[]);
    let reply = handle_finish_claude_link_login(
        "1".into(),
        &json!({ "accountId": "ab12", "code": "abc#def" }),
        &acp,
    )
    .await;
    let err = reply.err.unwrap();
    assert_eq!(err.code, "unsupported");
    assert_eq!(
        err.message,
        "No sign-in is waiting for a code. Start the sign-in again."
    );
}

#[tokio::test]
async fn a_blank_code_is_incomplete_and_a_malformed_finish_never_echoes_the_code() {
    let (_root, acp) = manager_with_account(&[]);
    let reply = handle_finish_claude_link_login(
        "1".into(),
        &json!({ "accountId": "ab12", "code": " \n" }),
        &acp,
    )
    .await;
    assert_eq!(reply.err.unwrap().code, "claude_login_code_incomplete");

    let reply = handle_finish_claude_link_login(
        "2".into(),
        &json!({ "accountId": 7, "code": "secret#code" }),
        &acp,
    )
    .await;
    let err = reply.err.unwrap();
    assert_eq!(err.code, "unsupported");
    assert!(!err.message.contains("secret"));
}

#[tokio::test]
async fn cancel_reports_whether_a_sign_in_was_running() {
    let (_root, acp) = manager_with_account(&[]);
    let reply = handle_cancel_claude_login("1".into(), &json!({ "accountId": "ab12" }), &acp).await;
    assert_eq!(reply.payload.unwrap(), json!({ "cancelled": false }));
    let malformed = handle_cancel_claude_login("2".into(), &json!({}), &acp).await;
    assert_eq!(malformed.err.unwrap().code, "unsupported");
}

#[tokio::test]
async fn a_link_sign_in_for_an_unknown_account_is_refused_before_the_cli_starts() {
    let (_root, acp) = manager_with_account(&[]);
    let reply =
        handle_start_claude_link_login("1".into(), &json!({ "accountId": "ffff" }), &acp).await;
    let err = reply.err.unwrap();
    assert_eq!(err.code, "unsupported");
    assert_eq!(err.message, "That Claude account does not exist");
}

#[tokio::test]
async fn an_account_renamed_over_ws_keeps_its_id_and_a_repeat_succeeds() {
    let (root, acp) = manager_with_account(&[]);
    let rename = |n: &str| json!({ "accountId": "ab12", "name": n });
    let reply = handle_rename_claude_account("1".into(), &rename("Office"), &acp).await;
    assert_eq!(reply.payload.unwrap(), json!({}));
    let reply = handle_rename_claude_account("2".into(), &rename("Office"), &acp).await;
    assert!(
        reply.ok,
        "renaming to the current name answers like the first"
    );
    assert_eq!(
        stored(&root)["accounts"][1],
        json!({ "id": "ab12", "name": "Office", "createdAt": 1 })
    );

    let taken = handle_rename_claude_account(
        "3".into(),
        &json!({ "accountId": "ab12", "name": "default" }),
        &acp,
    )
    .await;
    assert_eq!(
        taken.err.unwrap().message,
        "An account named \"default\" already exists"
    );
    let unknown = handle_rename_claude_account(
        "4".into(),
        &json!({ "accountId": "ffff", "name": "Side" }),
        &acp,
    )
    .await;
    assert_eq!(
        unknown.err.unwrap().message,
        "That Claude account does not exist"
    );
    let malformed =
        handle_rename_claude_account("5".into(), &json!({ "accountId": "ab12" }), &acp).await;
    assert_eq!(malformed.err.unwrap().code, "unsupported");
    assert_eq!(stored(&root)["accounts"][1]["name"], "Office");
}

#[tokio::test]
async fn removing_an_account_moves_its_projects_and_a_repeat_converges() {
    let (root, acp) = manager_with_account(&[]);
    let reply = handle_set_project_claude_account(
        "1".into(),
        &json!({ "projectId": "office", "accountId": "ab12" }),
        &acp,
    )
    .await;
    assert!(reply.ok);
    let remove = json!({ "accountId": "ab12" });
    let reply = handle_remove_claude_account("2".into(), &remove, &acp).await;
    assert_eq!(
        reply.payload.unwrap(),
        json!({ "movedProjectIds": ["office"] })
    );
    let file = stored(&root);
    assert_eq!(file["accounts"].as_array().unwrap().len(), 1);
    assert!(file
        .get("projectAccounts")
        .is_none_or(|p| p.get("office").is_none()));

    let repeat = handle_remove_claude_account("3".into(), &remove, &acp).await;
    assert_eq!(repeat.payload.unwrap(), json!({ "movedProjectIds": [] }));
}

#[tokio::test]
async fn the_built_in_account_is_never_removed() {
    let (root, acp) = manager_with_account(&[]);
    let reply =
        handle_remove_claude_account("1".into(), &json!({ "accountId": "default" }), &acp).await;
    let err = reply.err.unwrap();
    assert_eq!(err.code, "unsupported");
    assert_eq!(err.message, "The built-in account cannot be removed");
    assert_eq!(stored(&root)["accounts"].as_array().unwrap().len(), 2);
    let malformed = handle_remove_claude_account("2".into(), &json!({}), &acp).await;
    assert_eq!(malformed.err.unwrap().code, "unsupported");
}
