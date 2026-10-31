use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::http::{StatusCode, Uri};
use axum::response::IntoResponse;
use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use serde_json::{json, Value};

use super::search::{McpCatalogSearchRequest, RunnerAvailability};
use super::snapshot::{item_from_row, LoadedCatalog, McpCatalogSource};
use super::sync::{
    commit, fetch, read_cache, read_enabled, Delta, McpCatalogSync, Registry, SyncPhase, SyncPlan,
};
use super::{McpCatalogService, McpCatalogStatus};

const OFFICIAL: &str = "io.modelcontextprotocol.registry/official";
const SNAPSHOT_AT: &str = "2026-10-27T00:00:00Z";

fn row(name: &str, version: &str, status: &str, latest: bool) -> Value {
    json!({
        "server": {
            "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
            "name": name,
            "description": format!("{name} server"),
            "version": version,
            "icons": [{ "src": "https://example.com/icon.png" }],
            "remotes": [{ "type": "streamable-http", "url": "https://mcp.example.com/mcp" }]
        },
        "_meta": { OFFICIAL: { "status": status, "isLatest": latest, "updatedAt": "2026-10-30T00:00:00Z" } }
    })
}

fn base(names: &[&str], sample: bool) -> LoadedCatalog {
    LoadedCatalog::from_items(
        names
            .iter()
            .filter_map(|name| item_from_row(row(name, "1.0.0", "active", true)))
            .collect(),
        McpCatalogSource {
            updated_at: Some(SNAPSHOT_AT.to_string()),
            sample,
        },
    )
}

#[derive(Clone, Copy)]
enum Mode {
    Serve,
    Status(u16),
    Oversized,
    Hang,
}

struct SetOnDrop<'a>(&'a AtomicBool);

impl Drop for SetOnDrop<'_> {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

struct MockRegistry {
    rows: Vec<Value>,
    latest: HashMap<String, Value>,
    mode: Mutex<Mode>,
    requests: Mutex<Vec<String>>,
    abandoned: AtomicBool,
}

impl MockRegistry {
    fn new(rows: Vec<Value>, latest: Vec<Value>) -> Arc<Self> {
        Arc::new(Self {
            rows,
            latest: latest
                .into_iter()
                .map(|row| (row["server"]["name"].as_str().unwrap().to_string(), row))
                .collect(),
            mode: Mutex::new(Mode::Serve),
            requests: Mutex::new(Vec::new()),
            abandoned: AtomicBool::new(false),
        })
    }

    fn requests(&self) -> Vec<String> {
        self.requests.lock().clone()
    }

    async fn respond(&self, uri: &Uri) -> axum::response::Response {
        let query = uri.query().unwrap_or("");
        self.requests.lock().push(format!("{}?{query}", uri.path()));
        let mode = *self.mode.lock();
        match mode {
            Mode::Serve => {}
            Mode::Status(code) => return StatusCode::from_u16(code).unwrap().into_response(),
            Mode::Oversized => return "x".repeat(9 * 1024 * 1024).into_response(),
            Mode::Hang => {
                let _abandoned = SetOnDrop(&self.abandoned);
                return std::future::pending().await;
            }
        }
        let path = uri.path().replace("%2F", "/");
        if path == "/v0.1/servers" {
            let offset: usize = url::form_urlencoded::parse(query.as_bytes())
                .find(|(key, _)| key == "cursor")
                .map_or(0, |(_, cursor)| cursor.parse().unwrap());
            let end = (offset + 2).min(self.rows.len());
            let next = (end < self.rows.len()).then(|| end.to_string());
            return axum::Json(json!({
                "servers": self.rows[offset..end],
                "metadata": { "nextCursor": next, "count": end - offset }
            }))
            .into_response();
        }
        let latest = path
            .strip_prefix("/v0.1/servers/")
            .and_then(|rest| rest.strip_suffix("/versions/latest"))
            .and_then(|name| self.latest.get(name));
        match latest {
            Some(row) => axum::Json(row.clone()).into_response(),
            None => StatusCode::NOT_FOUND.into_response(),
        }
    }
}

async fn serve(mock: &Arc<MockRegistry>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let mock = Arc::clone(mock);
    let app = axum::Router::new().fallback(move |uri: Uri| {
        let mock = Arc::clone(&mock);
        async move { mock.respond(&uri).await }
    });
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    base
}

fn start(catalog: LoadedCatalog, dir: &Path, registry: &str) -> Arc<McpCatalogService> {
    let service = Arc::new(McpCatalogService::with_runners(
        catalog,
        RunnerAvailability::default(),
    ));
    tokio::spawn(Arc::clone(&service).attach(dir.to_path_buf(), Registry::new(registry).unwrap()));
    service
}

async fn until(
    service: &McpCatalogService,
    done: impl Fn(&McpCatalogStatus) -> bool,
) -> McpCatalogStatus {
    for _ in 0..500 {
        let status = service.status();
        if done(&status) {
            return status;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("status never settled: {:?}", service.status());
}

async fn until_requested(mock: &MockRegistry, count: usize) {
    for _ in 0..500 {
        if mock.requests().len() >= count {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("the registry saw {:?}", mock.requests());
}

fn idle(status: &McpCatalogStatus) -> bool {
    status.sync == McpCatalogSync::Enabled(SyncPhase::Idle) && !status.source.sample
}

async fn rows(service: &McpCatalogService) -> Vec<(String, String, Value)> {
    let page = service
        .search(&McpCatalogSearchRequest::default())
        .await
        .unwrap();
    page.items
        .into_iter()
        .map(|row| {
            (
                row.name,
                row.version,
                serde_json::to_value(row.status).unwrap(),
            )
        })
        .collect()
}

fn write_setting(dir: &Path, enabled: bool) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(
        dir.join("config.json"),
        json!({ "schemaVersion": 1, "syncEnabled": enabled }).to_string(),
    )
    .unwrap();
}

#[test]
fn sync_states_serialize_as_the_wire_union() {
    let retry_at: DateTime<Utc> = "2026-10-31T02:00:00Z".parse().unwrap();
    let cases = [
        (McpCatalogSync::Disabled, json!({ "state": "disabled" })),
        (
            McpCatalogSync::Enabled(SyncPhase::Idle),
            json!({ "state": "idle" }),
        ),
        (
            McpCatalogSync::Enabled(SyncPhase::Syncing {
                full: true,
                fetched: 1200,
            }),
            json!({ "state": "syncing", "full": true, "fetched": 1200 }),
        ),
        (
            McpCatalogSync::Enabled(SyncPhase::Failed {
                error: "registry returned HTTP 503".to_string(),
                retry_at,
            }),
            json!({ "state": "failed", "error": "registry returned HTTP 503", "retryAt": "2026-10-31T02:00:00Z" }),
        ),
    ];
    for (sync, expected) in cases {
        assert_eq!(serde_json::to_value(&sync).unwrap(), expected);
    }
}

#[test]
fn the_plan_crawls_everything_only_for_a_sample_or_unloaded_catalog() {
    let at: DateTime<Utc> = SNAPSHOT_AT.parse().unwrap();
    assert_eq!(
        SyncPlan::for_catalog(&base(&[], true).source),
        SyncPlan::Full
    );
    assert_eq!(
        SyncPlan::for_catalog(&base(&[], false).source),
        SyncPlan::Since(at)
    );
    assert_eq!(
        SyncPlan::for_catalog(&McpCatalogSource::default()),
        SyncPlan::Full
    );
}

#[tokio::test]
async fn a_sample_catalog_is_replaced_by_a_full_crawl_and_reloads_from_the_cache() {
    let mock = MockRegistry::new(
        vec![
            row("io.example/alpha", "2.0.0", "active", true),
            row("io.example/beta", "1.0.0", "active", true),
            row("io.example/gamma", "3.1.0", "deprecated", true),
        ],
        vec![],
    );
    let registry = serve(&mock).await;
    let dir = tempfile::tempdir().unwrap();
    let service = start(base(&["io.sample/only"], true), dir.path(), &registry);

    let status = until(&service, idle).await;

    assert_eq!(status.servers, 3);
    assert!(status.source.updated_at.as_deref().unwrap() > SNAPSHOT_AT);
    assert_eq!(
        rows(&service).await,
        vec![
            (
                "io.example/alpha".to_string(),
                "2.0.0".to_string(),
                json!("active")
            ),
            (
                "io.example/beta".to_string(),
                "1.0.0".to_string(),
                json!("active")
            ),
            (
                "io.example/gamma".to_string(),
                "3.1.0".to_string(),
                json!("deprecated")
            ),
        ]
    );
    assert_eq!(
        mock.requests(),
        vec![
            "/v0.1/servers?limit=100&version=latest",
            "/v0.1/servers?limit=100&version=latest&cursor=2",
        ]
    );

    *mock.mode.lock() = Mode::Status(400);
    let restarted = start(base(&["io.sample/only"], true), dir.path(), &registry);
    let status = until(&restarted, |status| {
        matches!(
            status.sync,
            McpCatalogSync::Enabled(SyncPhase::Failed { .. })
        )
    })
    .await;
    assert_eq!((status.servers, status.source.sample), (3, false));
    let cursor = status.source.updated_at.unwrap();
    assert!(
        mock.requests()[2].contains(&format!("updated_since={}", cursor.replace(':', "%3A"))),
        "the second boot asks for changes since the crawl: {:?}",
        mock.requests()
    );
}

#[tokio::test]
async fn an_incremental_sync_applies_changes_and_refetches_withdrawn_and_deprecated_servers() {
    let mock = MockRegistry::new(
        vec![
            row("io.example/a", "2.0.0", "active", true),
            row("io.example/b", "0.9.0", "deleted", false),
            row("io.example/c", "2.0.0", "deprecated", true),
            row("io.example/d", "1.0.0", "active", true),
            row("io.example/e", "0.1.0", "active", false),
        ],
        vec![row("io.example/c", "2.0.0", "deprecated", true)],
    );
    let registry = serve(&mock).await;
    let dir = tempfile::tempdir().unwrap();
    let service = start(
        base(&["io.example/a", "io.example/b", "io.example/c"], false),
        dir.path(),
        &registry,
    );

    let status = until(&service, |status| {
        idle(status) && status.source.updated_at.as_deref() != Some(SNAPSHOT_AT)
    })
    .await;

    assert_eq!(status.servers, 3);
    assert_eq!(
        rows(&service).await,
        vec![
            (
                "io.example/a".to_string(),
                "2.0.0".to_string(),
                json!("active")
            ),
            (
                "io.example/c".to_string(),
                "2.0.0".to_string(),
                json!("deprecated")
            ),
            (
                "io.example/d".to_string(),
                "1.0.0".to_string(),
                json!("active")
            ),
        ]
    );
    assert_eq!(
        mock.requests(),
        vec![
            "/v0.1/servers?limit=100&updated_since=2026-10-27T00%3A00%3A00.000Z",
            "/v0.1/servers?limit=100&updated_since=2026-10-27T00%3A00%3A00.000Z&cursor=2",
            "/v0.1/servers?limit=100&updated_since=2026-10-27T00%3A00%3A00.000Z&cursor=4",
            "/v0.1/servers/io.example%2Fb/versions/latest?",
            "/v0.1/servers/io.example%2Fc/versions/latest?",
        ]
    );
}

#[tokio::test]
async fn sync_off_sends_no_request_until_it_is_turned_on() {
    let mock = MockRegistry::new(
        vec![row("io.example/alpha", "1.0.0", "active", true)],
        vec![],
    );
    let registry = serve(&mock).await;
    let dir = tempfile::tempdir().unwrap();
    write_setting(dir.path(), false);
    let service = start(base(&["io.sample/only"], true), dir.path(), &registry);

    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(service.status().sync, McpCatalogSync::Disabled);
    assert!(mock.requests().is_empty(), "{:?}", mock.requests());

    service.set_sync(true).await.unwrap();
    let status = until(&service, idle).await;
    assert_eq!(status.servers, 1);
    let sent = mock.requests().len();

    let off = service.set_sync(false).await.unwrap();
    assert_eq!(off.sync, McpCatalogSync::Disabled);
    let setting: Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("config.json")).unwrap()).unwrap();
    assert_eq!(setting["syncEnabled"], json!(false));
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(mock.requests().len(), sent);
}

#[tokio::test]
async fn turning_sync_off_during_a_retry_backoff_sends_no_retry() {
    let mock = MockRegistry::new(
        vec![row("io.example/alpha", "1.0.0", "active", true)],
        vec![],
    );
    *mock.mode.lock() = Mode::Status(503);
    let registry = serve(&mock).await;
    let dir = tempfile::tempdir().unwrap();
    let service = start(base(&["io.sample/only"], true), dir.path(), &registry);
    until_requested(&mock, 1).await;

    service.set_sync(false).await.unwrap();
    // The first retry would go out 2 s after the 503.
    tokio::time::sleep(Duration::from_millis(2500)).await;

    assert_eq!(
        mock.requests(),
        vec!["/v0.1/servers?limit=100&version=latest"]
    );
    assert_eq!(service.status().sync, McpCatalogSync::Disabled);
    assert!(!dir.path().join("registry-cache.json.gz").exists());

    *mock.mode.lock() = Mode::Serve;
    service.set_sync(true).await.unwrap();
    let status = until(&service, idle).await;
    assert_eq!(status.servers, 1);
}

#[tokio::test]
async fn turning_sync_off_abandons_the_request_in_flight() {
    let mock = MockRegistry::new(
        vec![row("io.example/alpha", "1.0.0", "active", true)],
        vec![],
    );
    *mock.mode.lock() = Mode::Hang;
    let registry = serve(&mock).await;
    let dir = tempfile::tempdir().unwrap();
    let service = start(base(&["io.sample/only"], true), dir.path(), &registry);
    until_requested(&mock, 1).await;

    service.set_sync(false).await.unwrap();
    for _ in 0..100 {
        if mock.abandoned.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    assert!(
        mock.abandoned.load(Ordering::SeqCst),
        "the request is still open"
    );
    assert_eq!(mock.requests().len(), 1);
    assert_eq!(service.status().sync, McpCatalogSync::Disabled);
    assert!(!dir.path().join("registry-cache.json.gz").exists());

    *mock.mode.lock() = Mode::Serve;
    service.set_sync(true).await.unwrap();
    let status = until(&service, idle).await;
    assert_eq!(status.servers, 1);
}

#[test]
fn only_a_missing_or_valid_setting_turns_sync_on() {
    let cases = [
        (None, true),
        (Some(r#"{"schemaVersion":1,"syncEnabled":true}"#), true),
        (Some(r#"{"schemaVersion":1,"syncEnabled":false}"#), false),
        (Some(r#"{"schemaVersion":2,"syncEnabled":true}"#), false),
        (Some(r#"{"schemaVersion":1,"syncEnabled":"yes"}"#), false),
        (Some("not json"), false),
    ];
    for (setting, enabled) in cases {
        let dir = tempfile::tempdir().unwrap();
        if let Some(setting) = setting {
            std::fs::write(dir.path().join("config.json"), setting).unwrap();
        }
        assert_eq!(read_enabled(dir.path()), enabled, "{setting:?}");
    }

    let unreadable = tempfile::tempdir().unwrap();
    std::fs::create_dir(unreadable.path().join("config.json")).unwrap();
    assert!(!read_enabled(unreadable.path()));
}

#[tokio::test]
async fn a_failed_sync_waits_an_hour_even_across_a_toggle() {
    let mock = MockRegistry::new(vec![], vec![]);
    *mock.mode.lock() = Mode::Status(400);
    let registry = serve(&mock).await;
    let dir = tempfile::tempdir().unwrap();
    let service = start(base(&[], false), dir.path(), &registry);

    let status = until(&service, |status| {
        matches!(
            status.sync,
            McpCatalogSync::Enabled(SyncPhase::Failed { .. })
        )
    })
    .await;
    let McpCatalogSync::Enabled(SyncPhase::Failed { error, retry_at }) = status.sync else {
        unreachable!()
    };
    assert_eq!(error, "registry returned HTTP 400");
    let wait = retry_at - Utc::now();
    assert!(wait > chrono::Duration::minutes(59) && wait <= chrono::Duration::minutes(60));

    service.set_sync(false).await.unwrap();
    service.set_sync(true).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(mock.requests().len(), 1);
    assert!(matches!(
        service.status().sync,
        McpCatalogSync::Enabled(SyncPhase::Failed { .. })
    ));
}

#[tokio::test]
async fn a_response_over_the_size_cap_fails_the_run() {
    let mock = MockRegistry::new(vec![], vec![]);
    *mock.mode.lock() = Mode::Oversized;
    let registry = Registry::new(serve(&mock).await).unwrap();

    let outcome = fetch(&registry, SyncPlan::Full, |_| {}).await;

    assert_eq!(
        outcome.map(|_| ()).unwrap_err().to_string(),
        "registry response exceeded 8388608 bytes"
    );
}

#[test]
fn a_cache_older_than_the_snapshot_never_loads() {
    let dir = tempfile::tempdir().unwrap();
    let mut delta = Delta::default();
    delta.rows.insert(
        "io.example/alpha".to_string(),
        Some(
            serde_json::value::to_raw_value(&row("io.example/alpha", "1.0.0", "active", true))
                .unwrap(),
        ),
    );
    let synced_at: DateTime<Utc> = "2026-10-28T00:00:00Z".parse().unwrap();
    commit(
        dir.path(),
        &base(&[], false),
        SyncPlan::Full,
        delta,
        synced_at,
    )
    .unwrap();

    let older_snapshot = base(&[], false).source;
    let newer_snapshot = McpCatalogSource {
        updated_at: Some("2026-10-29T00:00:00Z".to_string()),
        sample: false,
    };

    let cache = read_cache(dir.path(), &older_snapshot).expect("a newer cache loads");
    assert_eq!(cache.servers.len(), 1);
    assert!(read_cache(dir.path(), &newer_snapshot).is_none());
}
