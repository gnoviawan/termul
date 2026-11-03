use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::json;

use super::test_support::{registry, search_tool, server, FakeMcp, SENTINEL_SECRET};
use super::{Lookup, McpFailure, McpTools, OnListingChanged};
use crate::automation::test_support::FakeClock;

struct Fixture {
    fake: Arc<FakeMcp>,
    clock: Arc<FakeClock>,
    changes: Arc<Mutex<Vec<(String, String)>>>,
    tools: Arc<McpTools>,
}

fn fixture() -> Fixture {
    let fake = FakeMcp::new();
    let clock = FakeClock::at(1_000);
    let changes = Arc::new(Mutex::new(Vec::new()));
    let seen = changes.clone();
    let on_change: OnListingChanged = Arc::new(move |project: &str, server: &str| {
        seen.lock().push((project.to_string(), server.to_string()))
    });
    let tools = McpTools::new(
        registry(vec![server("srv-1", "files"), server("srv-2", "remote")]),
        fake.clone(),
        clock.clone(),
        on_change,
    );
    Fixture {
        fake,
        clock,
        changes,
        tools,
    }
}

async fn until(mut ready: impl FnMut() -> bool) {
    for _ in 0..200 {
        if ready() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("condition never held");
}

#[tokio::test]
async fn a_first_lookup_is_pending_lists_once_and_announces_the_result() {
    let f = fixture();
    f.fake.lists("files", Ok(vec![search_tool()]));
    let servers = f.tools.servers("p1");
    assert_eq!(f.tools.lookup("p1", &servers, "srv-1"), Lookup::Pending);
    assert_eq!(f.tools.lookup("p1", &servers, "srv-1"), Lookup::Pending);
    until(|| !f.changes.lock().is_empty()).await;
    assert_eq!(
        f.tools.lookup("p1", &servers, "srv-1"),
        Lookup::Ready(vec![search_tool()])
    );
    assert_eq!(f.fake.list_count(), 1);
    assert_eq!(
        *f.changes.lock(),
        vec![("p1".to_string(), "srv-1".to_string())]
    );
    assert_eq!(
        f.tools.lookup("p1", &servers, "srv-9"),
        Lookup::UnknownServer
    );
}

#[tokio::test]
async fn a_stale_listing_answers_and_revalidates_and_only_a_change_is_announced() {
    let f = fixture();
    f.fake.lists("files", Ok(vec![search_tool()]));
    let servers = f.tools.servers("p1");
    f.tools.lookup("p1", &servers, "srv-1");
    until(|| f.changes.lock().len() == 1).await;

    f.clock.set(1_000 + 60_000);
    assert_eq!(
        f.tools.lookup("p1", &servers, "srv-1"),
        Lookup::Ready(vec![search_tool()])
    );
    until(|| f.fake.list_count() == 2).await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(f.changes.lock().len(), 1, "the same tools are no change");

    f.fake
        .lists("files", Err(McpFailure::Unavailable("spawn failed".into())));
    f.clock.set(1_000 + 120_000);
    assert_eq!(
        f.tools.lookup("p1", &servers, "srv-1"),
        Lookup::Ready(vec![search_tool()])
    );
    until(|| f.changes.lock().len() == 2).await;
    assert_eq!(
        f.tools.lookup("p1", &servers, "srv-1"),
        Lookup::Failed(McpFailure::Unavailable("spawn failed".into()))
    );
}

#[tokio::test]
async fn an_edited_server_config_is_listed_again() {
    let f = fixture();
    f.fake.lists("files", Ok(vec![search_tool()]));
    let servers = f.tools.servers("p1");
    f.tools.lookup("p1", &servers, "srv-1");
    until(|| f.changes.lock().len() == 1).await;
    let mut edited = servers.clone();
    edited[0].config.args = vec!["--other".into()];
    assert_eq!(f.tools.lookup("p1", &edited, "srv-1"), Lookup::Pending);
}

#[tokio::test]
async fn refresh_reports_every_server_without_its_command_env_headers_or_args() {
    let f = fixture();
    f.fake.lists("files", Ok(vec![search_tool()]));
    f.fake.lists("remote", Err(McpFailure::AuthRequired));
    let payload = serde_json::to_value(f.tools.refresh("p1").await).unwrap();
    assert_eq!(
        payload,
        json!([
            { "server_id": "srv-1", "name": "files", "transport": "stdio", "status": "connected",
              "error": null, "tools": [{
                  "name": "search", "description": "search tool",
                  "input_schema": search_tool().input_schema, "output_schema": null }] },
            { "server_id": "srv-2", "name": "remote", "transport": "stdio", "status": "auth_required",
              "error": "sign in to this server in the MCP settings", "tools": [] }
        ])
    );
    assert!(!payload.to_string().contains(SENTINEL_SECRET));
    assert!(!payload.to_string().contains("/opt/"));
    let servers = f.tools.servers("p1");
    assert_eq!(
        f.tools.lookup("p1", &servers, "srv-2"),
        Lookup::Failed(McpFailure::AuthRequired)
    );
}

#[test]
fn a_lookup_off_the_runtime_stays_pending_without_listing() {
    let f = fixture();
    let servers = f.tools.servers("p1");
    assert_eq!(f.tools.lookup("p1", &servers, "srv-1"), Lookup::Pending);
    assert_eq!(f.fake.list_count(), 0);
}
