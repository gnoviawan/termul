use serde_json::{json, Value};

use super::search::{
    search, McpCatalogSearchRequest, McpCatalogState, RunnerAvailability, SearchError,
};
use super::snapshot::{item_from_row, LoadedCatalog};
use super::McpCatalogService;

fn row(name: &str, title: Option<&str>, description: &str, status: &str) -> Value {
    json!({
        "server": {
            "name": name,
            "title": title,
            "description": description,
            "version": "1.0.0",
            "remotes": [{ "type": "streamable-http", "url": "https://mcp.example.com/mcp" }]
        },
        "_meta": { "io.modelcontextprotocol.registry/official": { "status": status, "isLatest": true } }
    })
}

fn catalog(rows: Vec<Value>) -> LoadedCatalog {
    let mut items: Vec<_> = rows.into_iter().filter_map(item_from_row).collect();
    items.sort_by(|a, b| a.name.cmp(&b.name));
    LoadedCatalog {
        items,
        fetched_at: Some("2026-10-27T00:00:00Z".to_string()),
    }
}

fn request(query: &str, cursor: Option<&str>, limit: Option<usize>) -> McpCatalogSearchRequest {
    McpCatalogSearchRequest {
        query: Some(query.to_string()),
        cursor: cursor.map(str::to_string),
        limit,
    }
}

fn names(catalog: &LoadedCatalog, query: &str) -> Vec<String> {
    search(
        catalog,
        RunnerAvailability::default(),
        &request(query, None, Some(100)),
    )
    .unwrap()
    .items
    .into_iter()
    .map(|row| row.name)
    .collect()
}

#[test]
fn paging_walks_every_match_once_in_a_stable_order() {
    let catalog = catalog(
        (0..7)
            .map(|i| {
                row(
                    &format!("io.example/server-{i}"),
                    None,
                    "weather tools",
                    "active",
                )
            })
            .collect(),
    );
    let mut seen = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let page = search(
            &catalog,
            RunnerAvailability::default(),
            &request("weather", cursor.as_deref(), Some(3)),
        )
        .unwrap();
        assert_eq!(page.total, 7);
        let again = search(
            &catalog,
            RunnerAvailability::default(),
            &request("weather", cursor.as_deref(), Some(3)),
        )
        .unwrap();
        assert_eq!(page, again, "the same request returns the same page");
        seen.extend(page.items.into_iter().map(|row| row.name));
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    let expected: Vec<String> = (0..7).map(|i| format!("io.example/server-{i}")).collect();
    assert_eq!(seen, expected);
}

#[test]
fn the_query_matches_name_title_and_description_ranked_in_that_order() {
    let catalog = catalog(vec![
        row(
            "io.example/alpha",
            None,
            "talks to the github api",
            "active",
        ),
        row(
            "io.example/beta",
            Some("GitHub Bridge"),
            "a bridge",
            "active",
        ),
        row("io.github.someone/gamma", None, "a gamma server", "active"),
        row("io.example/github", None, "exact short name", "active"),
        row("io.example/unrelated", None, "nothing here", "active"),
    ]);
    assert_eq!(
        names(&catalog, "GitHub"),
        [
            "io.example/github",
            "io.example/beta",
            "io.example/alpha",
            "io.github.someone/gamma"
        ]
    );
    assert_eq!(names(&catalog, "github bridge"), ["io.example/beta"]);
    assert_eq!(names(&catalog, "io.example/alpha"), ["io.example/alpha"]);
    assert_eq!(names(&catalog, "").len(), 5);
}

#[test]
fn title_and_description_hits_outrank_namespace_only_hits() {
    let catalog = catalog(vec![
        row("io.github.aaa/one", None, "a server", "active"),
        row("io.github.bbb/two", None, "a server", "active"),
        row("io.example/zulu", Some("GitHub Issues"), "a server", "active"),
        row("io.example/yankee", None, "reads github issues", "active"),
    ]);
    assert_eq!(
        names(&catalog, "github"),
        [
            "io.example/zulu",
            "io.example/yankee",
            "io.github.aaa/one",
            "io.github.bbb/two"
        ]
    );
}

#[test]
fn whole_word_hits_outrank_substring_hits_in_each_field() {
    let catalog = catalog(vec![
        row("io.git.example/umber", None, "a server", "active"),
        row("io.example/violet", None, "legitimate tools", "active"),
        row("io.example/whale", None, "works with git", "active"),
        row("io.example/xray", Some("Digital Toolkit"), "a server", "active"),
        row("io.example/yak", Some("Tools for git"), "a server", "active"),
        row("io.example/zeta", Some("Git Tools"), "a server", "active"),
    ]);
    assert_eq!(
        names(&catalog, "git"),
        [
            "io.example/zeta",
            "io.example/yak",
            "io.example/xray",
            "io.example/whale",
            "io.example/violet",
            "io.git.example/umber"
        ]
    );
}

#[test]
fn deleted_and_non_latest_rows_never_browse() {
    let mut old = row("io.example/old", None, "an older version", "active");
    old["_meta"]["io.modelcontextprotocol.registry/official"]["isLatest"] = json!(false);
    let catalog = catalog(vec![
        row("io.example/withdrawn", None, "withdrawn server", "deleted"),
        row("io.example/kept", None, "deprecated server", "deprecated"),
        old,
    ]);
    assert_eq!(names(&catalog, ""), ["io.example/kept"]);
    assert!(names(&catalog, "withdrawn").is_empty());
}

#[test]
fn bad_requests_are_validation_errors() {
    let catalog = catalog(vec![row("io.example/a", None, "a", "active")]);
    let runners = RunnerAvailability::default();
    assert_eq!(
        search(&catalog, runners, &request("", Some("not-a-cursor"), None)),
        Err(SearchError::InvalidCursor)
    );
    assert_eq!(
        search(&catalog, runners, &request("", Some("9"), None)),
        Err(SearchError::InvalidCursor)
    );
    assert_eq!(
        search(&catalog, runners, &request("", None, Some(0))),
        Err(SearchError::InvalidLimit)
    );
    assert_eq!(
        search(&catalog, runners, &request("", None, Some(101))),
        Err(SearchError::InvalidLimit)
    );
    assert_eq!(
        search(&catalog, runners, &request(&"x".repeat(201), None, None)),
        Err(SearchError::QueryTooLong)
    );
}

#[test]
fn search_requests_reject_unknown_fields() {
    assert!(
        serde_json::from_value::<McpCatalogSearchRequest>(json!({ "query": "a", "extra": 1 }))
            .is_err()
    );
    assert!(serde_json::from_value::<McpCatalogSearchRequest>(json!({})).is_ok());
}

#[tokio::test]
async fn the_service_applies_runner_availability_to_states() {
    let package_row = json!({
        "server": {
            "name": "io.example/pkg",
            "description": "a package",
            "version": "1.0.0",
            "packages": [{ "registryType": "npm", "identifier": "pkg", "version": "1.0.0", "transport": { "type": "stdio" } }]
        },
        "_meta": { "io.modelcontextprotocol.registry/official": { "status": "active", "isLatest": true } }
    });
    let without = McpCatalogService::with_runners(
        catalog(vec![package_row.clone()]),
        RunnerAvailability::default(),
    );
    let with = McpCatalogService::with_runners(
        catalog(vec![package_row]),
        RunnerAvailability {
            npx: true,
            ..RunnerAvailability::default()
        },
    );
    let request = McpCatalogSearchRequest::default();
    assert_eq!(
        without.search(&request).await.unwrap().items[0].state,
        McpCatalogState::NeedsRuntime
    );
    assert_eq!(
        with.search(&request).await.unwrap().items[0].state,
        McpCatalogState::Installable
    );
}
