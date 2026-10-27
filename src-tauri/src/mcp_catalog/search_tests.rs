use std::time::Instant;

use serde_json::{json, Value};

use super::search::{
    search as scan, validate, McpCatalogPage, McpCatalogSearchRequest, McpCatalogState,
    RunnerAvailability, SearchError, MAX_QUERY_CHARS, MAX_QUERY_TERMS,
};
use super::snapshot::{item_from_row, LoadedCatalog};
use super::{McpCatalogError, McpCatalogService};

fn search(
    catalog: &LoadedCatalog,
    runners: RunnerAvailability,
    request: &McpCatalogSearchRequest,
) -> Result<McpCatalogPage, SearchError> {
    validate(request).and_then(|query| scan(catalog, runners, &query))
}

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
fn exact_names_rank_first_then_prefixes_then_name_title_and_description_substrings() {
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
            "io.github.someone/gamma",
            "io.example/alpha"
        ]
    );
    assert_eq!(names(&catalog, "github bridge"), ["io.example/beta"]);
    assert_eq!(names(&catalog, "").len(), 5);
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
    assert_eq!(
        search(&catalog, runners, &request("a b c d e f g h i", None, None)),
        Err(SearchError::TooManyTerms)
    );
    assert_eq!(
        search(&catalog, runners, &request("a a a a a a a a", None, None))
            .unwrap()
            .total,
        1
    );
}

#[tokio::test]
async fn the_service_rejects_a_bad_request_as_a_validation_error() {
    let service = McpCatalogService::with_runners(
        catalog(vec![row("io.example/a", None, "a", "active")]),
        RunnerAvailability::default(),
    );
    assert_eq!(
        service
            .search(&request("a b c d e f g h i", None, None))
            .await,
        Err(McpCatalogError {
            code: "VALIDATION_ERROR",
            message: format!("query has more than {MAX_QUERY_TERMS} terms"),
        })
    );
}

/// Worst case for the scan: the most terms the cap allows, each as long as
/// the length cap allows, each matching every item only at the end of its
/// description, so no term short-circuits. Run with
/// `cargo test --lib worst_case_search_latency -- --ignored --nocapture`.
#[tokio::test]
#[ignore = "measurement, not a check"]
async fn worst_case_search_latency() {
    const ITEMS: usize = 52_000;
    let term_len = (MAX_QUERY_CHARS - (MAX_QUERY_TERMS - 1)) / MAX_QUERY_TERMS;
    let term = format!("{}b", "a".repeat(term_len - 1));
    let description = format!("{}b", "a".repeat(189));
    let service = McpCatalogService::with_runners(
        catalog(
            (0..ITEMS)
                .map(|i| row(&format!("io.example/server-{i}"), None, &description, "active"))
                .collect(),
        ),
        RunnerAvailability::default(),
    );
    let query = vec![term.as_str(); MAX_QUERY_TERMS].join(" ");
    let started = Instant::now();
    let page = service
        .search(&request(&query, None, Some(1)))
        .await
        .unwrap();
    eprintln!(
        "worst-case search: {ITEMS} items, {MAX_QUERY_TERMS} terms of {term_len} chars, {} matched, {:?}",
        page.total,
        started.elapsed()
    );
    assert_eq!(page.total, ITEMS);
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
