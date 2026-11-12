use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::engine::HttpConfig;
use super::mcp::test_support::{registry, search_tool, server, FakeMcp};
use super::mcp::McpFailure;
use super::model::{Automation, AutomationChanged, Issue, IssueCode, McpToolPolicy};
use super::service::AutomationService;
use super::test_support::{no_history, node_id, ops, test_engine_with_mcp, MemoryVault};

fn service(fake: Arc<FakeMcp>) -> AutomationService {
    let te = test_engine_with_mcp(
        std::env::temp_dir(),
        Arc::new(MemoryVault::default()),
        HttpConfig::default(),
        registry(vec![server("srv-1", "files"), server("srv-2", "remote")]),
        fake,
    );
    AutomationService::new(te.engine, no_history())
}

/// An automation in `p1` whose one node calls `tool` on `server_id`.
fn with_tool(
    service: &AutomationService,
    server_id: &str,
    tool: &str,
    arguments: Value,
) -> Automation {
    let created = service.create("p1", "Lookup").unwrap();
    service
        .apply_ops(
            &created.id,
            1,
            &ops(json!([
                { "op": "add_node", "node": { "id": "call", "label": "Call", "spec": {
                    "kind": "mcp_tool", "server_id": server_id, "tool": tool, "arguments": arguments } } },
                { "op": "connect", "edge": { "from": "trigger", "port": "out", "to": "call" } }
            ])),
        )
        .unwrap()
        .automation
}

fn issues(service: &AutomationService, a: &Automation) -> Vec<(IssueCode, String)> {
    service
        .get(&a.id)
        .unwrap()
        .issues
        .into_iter()
        .map(|Issue { code, message, .. }| (code, message))
        .collect()
}

/// Reads until the background listing has landed.
async fn settled(service: &AutomationService, a: &Automation) -> Vec<(IssueCode, String)> {
    for _ in 0..200 {
        let now = issues(service, a);
        if now
            .iter()
            .all(|(code, _)| *code != IssueCode::McpToolsPending)
        {
            return now;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("the listing never landed");
}

fn query() -> Value {
    json!([{ "name": "query", "value": "open bugs" }])
}

#[tokio::test]
async fn a_tool_is_pending_until_its_listing_lands_then_clean_and_the_automation_is_told() {
    let fake = FakeMcp::new();
    fake.lists("files", Ok(vec![search_tool()]));
    let service = service(fake.clone());
    let a = with_tool(&service, "srv-1", "search", query());
    let mut changes = service.subscribe();
    let first = issues(&service, &a);
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].0, IssueCode::McpToolsPending);
    assert_eq!(settled(&service, &a).await, vec![]);
    let change = tokio::time::timeout(Duration::from_secs(1), changes.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        change,
        AutomationChanged {
            project_id: "p1".into(),
            automation_id: Some(a.id.clone()),
            proposed: false,
            proposed_by: None,
        }
    );
    assert_eq!(fake.list_count(), 1);
    assert_eq!(
        service
            .approve(&a.id, a.revision)
            .unwrap()
            .approved_revision,
        Some(2)
    );
}

#[tokio::test]
async fn an_unknown_server_points_at_capabilities() {
    let service = service(FakeMcp::new());
    let a = with_tool(&service, "srv-9", "search", query());
    assert_eq!(
        issues(&service, &a),
        vec![(
            IssueCode::UnknownMcpServer,
            "\"srv-9\" is not an enabled MCP server of this project; pick a server_id from automation_capabilities".to_string()
        )]
    );
}

#[tokio::test]
async fn the_tool_and_its_arguments_are_checked_against_the_live_listing() {
    let fake = FakeMcp::new();
    fake.lists("files", Ok(vec![search_tool()]));
    let service = service(fake);
    let unknown = with_tool(&service, "srv-1", "delete_all", json!([]));
    assert_eq!(
        settled(&service, &unknown).await,
        vec![(
            IssueCode::UnknownMcpTool,
            "MCP server \"srv-1\" has no tool \"delete_all\"; it has: search".to_string()
        )]
    );
    let wrong_args = with_tool(
        &service,
        "srv-1",
        "search",
        json!([{ "name": "limit", "value": "5" }, { "name": "sort", "value": "new" }]),
    );
    assert_eq!(
        settled(&service, &wrong_args).await,
        vec![
            (
                IssueCode::InvalidMcpArguments,
                "tool search requires argument query".to_string()
            ),
            (
                IssueCode::InvalidMcpArguments,
                "tool search takes no argument sort".to_string()
            ),
        ]
    );
}

#[tokio::test]
async fn a_literal_that_fits_no_declared_type_is_an_argument_issue() {
    let fake = FakeMcp::new();
    fake.lists("files", Ok(vec![search_tool()]));
    let service = service(fake);
    let fits = with_tool(
        &service,
        "srv-1",
        "search",
        json!([{ "name": "query", "value": "42" }, { "name": "limit", "value": "5" }]),
    );
    assert_eq!(settled(&service, &fits).await, vec![]);
    let unfit = with_tool(
        &service,
        "srv-1",
        "search",
        json!([{ "name": "query", "value": "open bugs" }, { "name": "limit", "value": "five" }]),
    );
    assert_eq!(
        settled(&service, &unfit).await,
        vec![(
            IssueCode::InvalidMcpArguments,
            "tool search: argument limit is not a valid integer".to_string()
        )]
    );
}

#[tokio::test]
async fn an_unavailable_or_signed_out_server_says_why() {
    let fake = FakeMcp::new();
    fake.lists(
        "files",
        Err(McpFailure::Unavailable("spawn failed: not found".into())),
    );
    fake.lists("remote", Err(McpFailure::AuthRequired));
    let service = service(fake);
    let down = with_tool(&service, "srv-1", "search", query());
    let signed_out = with_tool(&service, "srv-2", "search", query());
    assert_eq!(
        settled(&service, &down).await,
        vec![(
            IssueCode::McpServerUnavailable,
            "MCP server \"srv-1\" did not list its tools: spawn failed: not found".to_string()
        )]
    );
    assert_eq!(
        settled(&service, &signed_out).await,
        vec![(
            IssueCode::McpServerUnavailable,
            "MCP server \"srv-2\" needs a sign-in; sign in to it in the MCP settings".to_string()
        )]
    );
}

#[tokio::test]
async fn the_policy_names_the_server_a_tool_runs_on() {
    let service = service(FakeMcp::new());
    let a = with_tool(&service, "srv-2", "search", query());
    assert_eq!(
        service.policy(&a.id).unwrap().mcp_tools,
        vec![McpToolPolicy {
            node_id: node_id("call"),
            server_id: "srv-2".into(),
            server_name: Some("remote".into()),
            tool: "search".into(),
        }]
    );
}
