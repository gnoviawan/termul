use super::*;
use crate::acp::ClaudeAgentService;

/// A host state dir whose account list already holds one non-built-in Account,
/// so the handlers never create links into the real Claude config folder.
fn manager_with_account() -> (tempfile::TempDir, Arc<AcpManager>) {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(
        root.path().join("claude-accounts.json"),
        br#"{"version":1,"accounts":[{"id":"default","name":"Default","createdAt":0},{"id":"ab12","name":"Work","createdAt":1}],"defaultAccountId":"default"}"#,
    )
    .unwrap();
    let service = ClaudeAgentService::system(root.path().join("acp-registry-binaries"));
    let acp = Arc::new(AcpManager::with_claude_agent(vec![], Arc::new(service)));
    (root, acp)
}

fn stored(root: &tempfile::TempDir) -> Value {
    serde_json::from_slice(&std::fs::read(root.path().join("claude-accounts.json")).unwrap())
        .unwrap()
}

#[test]
fn set_default_and_project_account_persist_on_the_host() {
    let (root, acp) = manager_with_account();
    let reply =
        handle_set_default_claude_account("1".into(), &json!({ "accountId": "ab12" }), &acp);
    assert!(reply.ok);
    let reply = handle_set_project_claude_account(
        "2".into(),
        &json!({ "projectId": "office", "accountId": "ab12" }),
        &acp,
    );
    assert!(reply.ok);
    let file = stored(&root);
    assert_eq!(file["defaultAccountId"], "ab12");
    assert_eq!(file["projectAccounts"]["office"], "ab12");

    let reply = handle_set_project_claude_account(
        "3".into(),
        &json!({ "projectId": "office", "accountId": null }),
        &acp,
    );
    assert!(reply.ok);
    assert!(stored(&root)["projectAccounts"].get("office").is_none());
}

#[test]
fn unknown_accounts_and_malformed_payloads_are_rejected() {
    let (_root, acp) = manager_with_account();
    let reply =
        handle_set_default_claude_account("1".into(), &json!({ "accountId": "ffff" }), &acp);
    assert_eq!(reply.err.unwrap().code, "not_found");
    let reply =
        handle_set_project_claude_account("2".into(), &json!({ "accountId": "ab12" }), &acp);
    assert_eq!(reply.err.unwrap().code, "unsupported");
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
    let (root, acp) = manager_with_account();
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
