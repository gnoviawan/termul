use super::*;
use crate::acp::CodexAgentService;

fn manager_with_account(signed_out: &[&str]) -> (tempfile::TempDir, Arc<AcpManager>) {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(
        root.path().join("codex-accounts.json"),
        br#"{"version":1,"accounts":[{"id":"default","name":"Default","createdAt":0},{"id":"ab12","name":"Work","createdAt":1}],"defaultAccountId":"default","projectAccounts":{},"autoSwitch":true}"#,
    )
    .unwrap();
    std::fs::create_dir_all(root.path().join("codex-accounts").join("ab12")).unwrap();
    let service = CodexAgentService::with_logins_for_test(root.path(), signed_out);
    let acp = Arc::new(AcpManager::with_host_agents(
        vec![],
        Arc::new(crate::acp::ClaudeAgentService::without_host_state()),
        Arc::new(service),
    ));
    (root, acp)
}

fn stored(root: &tempfile::TempDir) -> Value {
    serde_json::from_slice(&std::fs::read(root.path().join("codex-accounts.json")).unwrap())
        .unwrap()
}

#[tokio::test]
async fn set_default_and_project_account_persist_on_the_host() {
    let (root, acp) = manager_with_account(&[]);
    let reply =
        handle_set_default_codex_account("1".into(), &json!({ "accountId": "ab12" }), &acp).await;
    assert!(reply.ok);
    let reply = handle_set_project_codex_account(
        "2".into(),
        &json!({ "projectId": "office", "accountId": "ab12" }),
        &acp,
    )
    .await;
    assert!(reply.ok);
    let file = stored(&root);
    assert_eq!(file["defaultAccountId"], "ab12");
    assert_eq!(file["projectAccounts"]["office"], "ab12");

    let reply = handle_set_project_codex_account(
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
    let first = handle_set_project_codex_account(
        "1".into(),
        &json!({ "projectId": "office", "accountId": "ab12", "expectedAccountId": "default" }),
        &acp,
    )
    .await;
    assert_eq!(first.payload.unwrap(), json!({ "applied": true }));
    let second = handle_set_project_codex_account(
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
    let listed = handle_list_codex_accounts("1".into(), &acp).await;
    assert_eq!(listed.payload.unwrap()["autoSwitch"], true);
    let reply = handle_set_codex_auto_switch("2".into(), &json!({ "enabled": false }), &acp).await;
    assert_eq!(reply.payload.unwrap(), json!({}));
    assert_eq!(stored(&root)["autoSwitch"], false);
    let listed = handle_list_codex_accounts("3".into(), &acp).await;
    assert_eq!(listed.payload.unwrap()["autoSwitch"], false);
    let malformed = handle_set_codex_auto_switch("4".into(), &json!({}), &acp).await;
    assert_eq!(malformed.err.unwrap().code, "unsupported");
}

#[tokio::test]
async fn the_list_fills_signed_in_and_hides_secrets() {
    let (_root, acp) = manager_with_account(&["ab12"]);
    let listed = handle_list_codex_accounts("1".into(), &acp).await;
    let payload = listed.payload.unwrap();
    let text = payload.to_string();
    assert!(!text.to_ascii_lowercase().contains("token"));
    assert!(!text.contains("sk-"));
    assert_eq!(payload["accounts"][0]["signedIn"], true);
    assert_eq!(payload["accounts"][1]["id"], "ab12");
    assert_eq!(payload["accounts"][1]["signedIn"], false);
}

#[tokio::test]
async fn a_signed_out_account_is_refused_with_its_code_and_the_choice_stays() {
    let (root, acp) = manager_with_account(&["ab12"]);
    let reply = handle_set_project_codex_account(
        "1".into(),
        &json!({ "projectId": "office", "accountId": "ab12" }),
        &acp,
    )
    .await;
    let err = reply.err.unwrap();
    assert_eq!(err.code, "codex_account_signed_out");
    assert_eq!(
        err.message,
        "The Codex account \"Work\" is not signed in. Sign in to it in Settings → Provider, then choose it again."
    );
    let reply =
        handle_set_default_codex_account("2".into(), &json!({ "accountId": "ab12" }), &acp).await;
    assert_eq!(reply.err.unwrap().code, "codex_account_signed_out");
    let file = stored(&root);
    assert_eq!(file["defaultAccountId"], "default");
    assert!(file["projectAccounts"].get("office").is_none());
}

#[tokio::test]
async fn add_rename_and_remove_round_trip() {
    let (root, acp) = manager_with_account(&[]);
    let added = handle_add_codex_account("1".into(), &json!({ "name": "Side" }), &acp).await;
    assert!(added.ok);
    let id = added.payload.unwrap()["id"].as_str().unwrap().to_string();
    let renamed = handle_rename_codex_account(
        "2".into(),
        &json!({ "accountId": id, "name": "Side 2" }),
        &acp,
    )
    .await;
    assert!(renamed.ok);
    handle_set_project_codex_account(
        "3".into(),
        &json!({ "projectId": "office", "accountId": id }),
        &acp,
    )
    .await;
    let removed = handle_remove_codex_account("4".into(), &json!({ "accountId": id }), &acp).await;
    assert_eq!(
        removed.payload.unwrap()["movedProjectIds"],
        json!(["office"])
    );
    let again = handle_remove_codex_account("5".into(), &json!({ "accountId": id }), &acp).await;
    assert_eq!(again.payload.unwrap()["movedProjectIds"], json!([]));
    let builtin =
        handle_remove_codex_account("6".into(), &json!({ "accountId": "default" }), &acp).await;
    assert!(!builtin.ok);
    assert!(stored(&root)["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["id"] == "default"));
}

#[tokio::test]
async fn unknown_accounts_and_malformed_payloads_are_rejected() {
    let (_root, acp) = manager_with_account(&[]);
    let reply =
        handle_set_default_codex_account("1".into(), &json!({ "accountId": "ffff" }), &acp).await;
    assert_eq!(reply.err.unwrap().code, "not_found");
    let reply =
        handle_set_project_codex_account("2".into(), &json!({ "accountId": "ab12" }), &acp).await;
    assert_eq!(reply.err.unwrap().code, "unsupported");
    let reply =
        handle_start_codex_account_login("3".into(), &json!({ "accountId": "nope" }), &acp, None)
            .await;
    assert_eq!(reply.err.unwrap().code, "unsupported");
}

#[tokio::test]
async fn a_sign_in_spawn_refuses_a_non_codex_config_before_a_process_starts() {
    let (_root, acp) = manager_with_account(&[]);
    let reply = handle_start_codex_account_login(
        "1".into(),
        &json!({
            "accountId": "ab12",
            "config": {
                "configId": "acp-registry:claude-acp",
                "name": "Claude",
                "command": "node",
                "args": [],
                "env": {}
            }
        }),
        &acp,
        None,
    )
    .await;
    assert!(!reply.ok);
    assert!(reply.err.unwrap().message.contains("Codex agent"));
}

#[tokio::test]
async fn a_host_without_state_reports_no_accounts() {
    let acp = Arc::new(AcpManager::new(vec![]));
    let reply = handle_list_codex_accounts("1".into(), &acp).await;
    assert!(!reply.ok);
}
