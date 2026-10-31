use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{self, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::Value;

use super::snapshot::{item_from_row, CatalogItem, LoadedCatalog, McpCatalogSource, OFFICIAL_META};
use super::McpCatalogService;

pub(crate) const REGISTRY_BASE: &str = "https://registry.modelcontextprotocol.io";
const POLL_INTERVAL: Duration = Duration::from_secs(60 * 60);
const RETRY_INTERVAL: Duration = Duration::from_secs(60 * 60);
const PAGE_LIMIT: usize = 100;
const MAX_PAGES: usize = 5000;
const MAX_PAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_SERVER_BYTES: usize = 1024 * 1024;
const MAX_CACHE_JSON_BYTES: u64 = 512 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const REQUEST_ATTEMPTS: u32 = 3;
/// 2 keeps `icons`; a version 1 cache predates them and is re-fetched.
const CACHE_FORMAT_VERSION: u32 = 2;
const CONFIG_SCHEMA_VERSION: u32 = 1;
const CACHE_FILE: &str = "registry-cache.json.gz";
const CONFIG_FILE: &str = "config.json";
const DROPPED_SERVER_FIELDS: [&str; 2] = ["$schema", "_meta"];
const ICON_FIELDS: [&str; 4] = ["src", "mimeType", "sizes", "theme"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum SyncPhase {
    Idle,
    Syncing {
        full: bool,
        fetched: usize,
    },
    Failed {
        error: String,
        retry_at: DateTime<Utc>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum McpCatalogSync {
    Disabled,
    #[serde(untagged)]
    Enabled(SyncPhase),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SyncPlan {
    Full,
    Since(DateTime<Utc>),
}

impl SyncPlan {
    pub(crate) fn for_catalog(source: &McpCatalogSource) -> Self {
        match source
            .updated_at
            .as_deref()
            .map(DateTime::parse_from_rfc3339)
        {
            Some(Ok(at)) if !source.sample => Self::Since(at.with_timezone(&Utc)),
            _ => Self::Full,
        }
    }

    fn is_full(self) -> bool {
        self == Self::Full
    }
}

#[derive(Debug)]
pub(crate) enum SyncError {
    Cancelled,
    Request(String),
    Status(u16),
    TooLarge(usize),
    Malformed(String),
    TooManyPages,
    Cache(String),
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cancelled => f.write_str("sync was turned off"),
            Self::Request(error) => write!(f, "registry request failed: {error}"),
            Self::Status(status) => write!(f, "registry returned HTTP {status}"),
            Self::TooLarge(cap) => write!(f, "registry response exceeded {cap} bytes"),
            Self::Malformed(error) => write!(f, "registry response is malformed: {error}"),
            Self::TooManyPages => {
                write!(f, "registry crawl did not finish within {MAX_PAGES} pages")
            }
            Self::Cache(error) => write!(f, "catalog cache write failed: {error}"),
        }
    }
}

impl SyncError {
    fn retryable(&self) -> bool {
        match self {
            Self::Request(_) => true,
            Self::Status(status) => *status == 429 || *status >= 500,
            _ => false,
        }
    }
}

pub(crate) struct Registry {
    base: String,
    client: reqwest::Client,
}

#[derive(Deserialize)]
struct RegistryPage {
    servers: Vec<Box<RawValue>>,
    #[serde(default)]
    metadata: PageMetadata,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageMetadata {
    next_cursor: Option<String>,
}

impl Registry {
    pub(crate) fn new(base: impl Into<String>) -> reqwest::Result<Self> {
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .redirect(crate::acp::https_only::redirect_policy())
            .build()?;
        Ok(Self {
            base: base.into(),
            client,
        })
    }

    fn url(&self, segments: &[&str]) -> Result<reqwest::Url, SyncError> {
        let mut url = reqwest::Url::parse(&self.base)
            .map_err(|error| SyncError::Request(error.to_string()))?;
        url.path_segments_mut()
            .map_err(|()| SyncError::Request("registry base is not a URL".to_string()))?
            .pop_if_empty()
            .extend(segments);
        Ok(url)
    }

    async fn page(&self, plan: SyncPlan, cursor: Option<&str>) -> Result<RegistryPage, SyncError> {
        let mut url = self.url(&["v0.1", "servers"])?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("limit", &PAGE_LIMIT.to_string());
            match plan {
                SyncPlan::Full => query.append_pair("version", "latest"),
                SyncPlan::Since(at) => query.append_pair("updated_since", &rfc3339(at)),
            };
            if let Some(cursor) = cursor {
                query.append_pair("cursor", cursor);
            }
        }
        let body = self.get(url, MAX_PAGE_BYTES).await?;
        serde_json::from_slice(&body).map_err(|error| SyncError::Malformed(error.to_string()))
    }

    async fn latest(&self, name: &str) -> Result<Option<Box<RawValue>>, SyncError> {
        let url = self.url(&["v0.1", "servers", name, "versions", "latest"])?;
        match self.get(url, MAX_SERVER_BYTES).await {
            Err(SyncError::Status(404)) => Ok(None),
            Err(error) => Err(error),
            Ok(body) => serde_json::from_slice(&body)
                .map(Some)
                .map_err(|error| SyncError::Malformed(error.to_string())),
        }
    }

    async fn get(&self, url: reqwest::Url, cap: usize) -> Result<Vec<u8>, SyncError> {
        let mut attempt = 1;
        loop {
            match self.get_once(url.clone(), cap).await {
                Err(error) if error.retryable() && attempt < REQUEST_ATTEMPTS => {
                    log::debug!("[mcp-catalog] sync request attempt {attempt} failed: {error}");
                    tokio::time::sleep(Duration::from_secs(1 << attempt)).await;
                    attempt += 1;
                }
                outcome => return outcome,
            }
        }
    }

    async fn get_once(&self, url: reqwest::Url, cap: usize) -> Result<Vec<u8>, SyncError> {
        use futures_util::StreamExt;
        let request_error =
            |error: reqwest::Error| SyncError::Request(error.without_url().to_string());
        let response = self.client.get(url).send().await.map_err(request_error)?;
        if !response.status().is_success() {
            return Err(SyncError::Status(response.status().as_u16()));
        }
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(request_error)?;
            if body.len() + chunk.len() > cap {
                return Err(SyncError::TooLarge(cap));
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RowStatus {
    Active,
    Deprecated,
    Deleted,
}

struct Row {
    name: String,
    latest: bool,
    status: RowStatus,
    slim: Box<RawValue>,
}

impl Row {
    fn parse(raw: &RawValue) -> Option<Self> {
        let mut row: Value = serde_json::from_str(raw.get()).ok()?;
        let official = row["_meta"][OFFICIAL_META].take();
        let mut server = row.get_mut("server").map(Value::take)?;
        let name = server["name"]
            .as_str()
            .filter(|name| !name.is_empty())?
            .to_string();
        if let Some(fields) = server.as_object_mut() {
            for field in DROPPED_SERVER_FIELDS {
                fields.remove(field);
            }
            slim_icons(fields);
        }
        let status = match official["status"].as_str() {
            Some("deleted") => RowStatus::Deleted,
            Some("deprecated") => RowStatus::Deprecated,
            _ => RowStatus::Active,
        };
        let latest = official["isLatest"].as_bool() == Some(true);
        let slim = serde_json::value::to_raw_value(&serde_json::json!({
            "server": server,
            "_meta": { OFFICIAL_META: official },
        }))
        .ok()?;
        Some(Self {
            name,
            latest,
            status,
            slim,
        })
    }

    fn browsable(self) -> Option<Box<RawValue>> {
        (self.latest && self.status != RowStatus::Deleted).then_some(self.slim)
    }
}

/// Keeps [`ICON_FIELDS`] of each icon with a string `src`, like the snapshot
/// script does.
fn slim_icons(server: &mut serde_json::Map<String, Value>) {
    let icons: Vec<Value> = match server.remove("icons") {
        Some(Value::Array(icons)) => icons
            .into_iter()
            .filter(|icon| icon["src"].is_string())
            .map(|mut icon| {
                Value::Object(
                    ICON_FIELDS
                        .iter()
                        .filter_map(|field| Some((field.to_string(), icon.get_mut(field)?.take())))
                        .collect(),
                )
            })
            .collect(),
        _ => return,
    };
    if !icons.is_empty() {
        server.insert("icons".to_string(), Value::Array(icons));
    }
}

#[derive(Debug, Default)]
pub(crate) struct Delta {
    pub rows: BTreeMap<String, Option<Box<RawValue>>>,
    pub received: usize,
    pub refetched: usize,
}

pub(crate) async fn fetch(
    registry: &Registry,
    plan: SyncPlan,
    progress: impl Fn(usize),
) -> Result<Delta, SyncError> {
    let mut delta = Delta::default();
    let mut refetch = BTreeSet::new();
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let page = registry.page(plan, cursor.as_deref()).await?;
        for row in page.servers.iter().filter_map(|raw| Row::parse(raw)) {
            delta.received += 1;
            // The registry moves `isLatest` to another version without bumping its
            // `updated_at`, so an `updated_since` page never shows the new latest row.
            if !plan.is_full() && row.status != RowStatus::Active {
                refetch.insert(row.name);
                continue;
            }
            let name = row.name.clone();
            if let Some(slim) = row.browsable() {
                delta.rows.insert(name, Some(slim));
            }
        }
        progress(delta.received);
        cursor = page.metadata.next_cursor.filter(|next| !next.is_empty());
        if cursor.is_none() {
            for name in refetch {
                let latest = registry.latest(&name).await?;
                delta.refetched += 1;
                let row = latest
                    .as_deref()
                    .and_then(Row::parse)
                    .and_then(Row::browsable);
                delta.rows.insert(name, row);
            }
            return Ok(delta);
        }
    }
    Err(SyncError::TooManyPages)
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RegistryCache {
    format_version: u32,
    pub cursor: DateTime<Utc>,
    pub full: bool,
    pub servers: BTreeMap<String, Option<Box<RawValue>>>,
}

impl RegistryCache {
    fn new(cursor: DateTime<Utc>, full: bool) -> Self {
        Self {
            format_version: CACHE_FORMAT_VERSION,
            cursor,
            full,
            servers: BTreeMap::new(),
        }
    }

    fn changes(&self) -> impl Iterator<Item = (String, Option<CatalogItem>)> + '_ {
        self.servers
            .iter()
            .map(|(name, row)| (name.clone(), row.as_deref().and_then(item_from_raw)))
    }
}

fn item_from_raw(row: &RawValue) -> Option<CatalogItem> {
    serde_json::from_str(row.get()).ok().and_then(item_from_row)
}

fn rfc3339(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub(crate) fn read_cache(dir: &Path, snapshot: &McpCatalogSource) -> Option<RegistryCache> {
    let path = dir.join(CACHE_FILE);
    let file = match fs::File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return None,
        Err(error) => {
            log::warn!("[mcp-catalog] sync cache unreadable: {error}");
            return None;
        }
    };
    let reader = BufReader::new(GzDecoder::new(file).take(MAX_CACHE_JSON_BYTES));
    let cache: RegistryCache = match serde_json::from_reader(reader) {
        Ok(cache) => cache,
        Err(error) => {
            log::warn!("[mcp-catalog] sync cache is invalid, ignoring it: {error}");
            return None;
        }
    };
    if cache.format_version != CACHE_FORMAT_VERSION {
        log::warn!(
            "[mcp-catalog] sync cache format {} ignored",
            cache.format_version
        );
        return None;
    }
    let snapshot_at = snapshot
        .updated_at
        .as_deref()
        .and_then(|at| DateTime::parse_from_rfc3339(at).ok());
    if snapshot_at.is_some_and(|at| cache.cursor < at) {
        log::info!(
            "[mcp-catalog] sync cache cursor={} is older than the snapshot, discarding it",
            rfc3339(cache.cursor)
        );
        return None;
    }
    Some(cache)
}

fn write_cache(dir: &Path, cache: &RegistryCache) -> io::Result<()> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    serde_json::to_writer(&mut encoder, cache).map_err(io::Error::other)?;
    encoder.flush()?;
    crate::acp::atomic_file::replace(&dir.join(CACHE_FILE), &encoder.finish()?)
}

pub(crate) fn merge(base: &LoadedCatalog, cache: &RegistryCache) -> LoadedCatalog {
    let source = McpCatalogSource {
        updated_at: Some(rfc3339(cache.cursor)),
        sample: base.source.sample && !cache.full,
    };
    if cache.full {
        LoadedCatalog::from_items(
            cache.changes().filter_map(|(_, item)| item).collect(),
            source,
        )
    } else {
        base.with_changes(cache.changes(), source)
    }
}

pub(crate) fn commit(
    dir: &Path,
    current: &LoadedCatalog,
    plan: SyncPlan,
    delta: Delta,
    started_at: DateTime<Utc>,
) -> io::Result<LoadedCatalog> {
    let mut cache = match plan {
        SyncPlan::Full => RegistryCache::new(started_at, true),
        SyncPlan::Since(_) => read_cache(dir, &current.source)
            .unwrap_or_else(|| RegistryCache::new(started_at, false)),
    };
    cache.cursor = started_at;
    if plan.is_full() {
        cache.servers = delta.rows;
        write_cache(dir, &cache)?;
        return Ok(merge(&LoadedCatalog::default(), &cache));
    }
    let changes: Vec<_> = delta
        .rows
        .iter()
        .map(|(name, row)| (name.clone(), row.as_deref().and_then(item_from_raw)))
        .collect();
    cache.servers.extend(delta.rows);
    write_cache(dir, &cache)?;
    let source = McpCatalogSource {
        updated_at: Some(rfc3339(started_at)),
        sample: current.source.sample,
    };
    Ok(current.with_changes(changes, source))
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncConfig {
    schema_version: u32,
    sync_enabled: bool,
}

pub(crate) fn read_enabled(dir: &Path) -> bool {
    let path = dir.join(CONFIG_FILE);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return true,
        Err(error) => {
            log::warn!("[mcp-catalog] sync setting unreadable, keeping sync off: {error}");
            return false;
        }
    };
    match serde_json::from_slice::<SyncConfig>(&bytes) {
        Ok(config) if config.schema_version == CONFIG_SCHEMA_VERSION => config.sync_enabled,
        Ok(config) => {
            log::warn!(
                "[mcp-catalog] sync setting schema {} unsupported, keeping sync off",
                config.schema_version
            );
            false
        }
        Err(error) => {
            // serde_json's message quotes the offending value, so log only where it failed.
            log::warn!(
                "[mcp-catalog] sync setting is invalid ({:?} at {}:{}), keeping sync off",
                error.classify(),
                error.line(),
                error.column()
            );
            let _ = crate::acp::atomic_file::backup_corrupt(&path, &bytes);
            false
        }
    }
}

fn write_enabled(dir: &Path, enabled: bool) -> io::Result<()> {
    let config = SyncConfig {
        schema_version: CONFIG_SCHEMA_VERSION,
        sync_enabled: enabled,
    };
    let bytes = serde_json::to_vec_pretty(&config).map_err(io::Error::other)?;
    crate::acp::atomic_file::replace(&dir.join(CONFIG_FILE), &bytes)
}

pub(crate) struct SyncHost {
    dir: PathBuf,
    registry: Registry,
    enabled: tokio::sync::watch::Sender<bool>,
    setting: tokio::sync::Mutex<()>,
}

impl SyncHost {
    pub(crate) fn new(dir: PathBuf, registry: Registry) -> Self {
        let enabled = read_enabled(&dir);
        Self {
            dir,
            registry,
            enabled: tokio::sync::watch::Sender::new(enabled),
            setting: tokio::sync::Mutex::new(()),
        }
    }

    pub(crate) fn enabled(&self) -> bool {
        *self.enabled.borrow()
    }

    async fn until_enabled_is(&self, enabled: bool) {
        // `wait_for` fails only once the sender is dropped, and `self` owns it.
        let _ = self
            .enabled
            .subscribe()
            .wait_for(|now| *now == enabled)
            .await;
    }

    pub(crate) async fn set_enabled(&self, enabled: bool) -> io::Result<()> {
        let _setting = self.setting.lock().await;
        let dir = self.dir.clone();
        tokio::task::spawn_blocking(move || write_enabled(&dir, enabled))
            .await
            .map_err(io::Error::other)??;
        self.enabled.send_replace(enabled);
        Ok(())
    }
}

impl McpCatalogService {
    pub(crate) async fn run_sync(self: Arc<Self>, host: Arc<SyncHost>) {
        let dir = host.dir.clone();
        let base = self.catalog();
        let cached = tokio::task::spawn_blocking(move || {
            read_cache(&dir, &base.source).map(|cache| merge(&base, &cache))
        })
        .await
        .ok()
        .flatten();
        if let Some(catalog) = cached {
            log::info!(
                "[mcp-catalog] sync cache loaded items={} cursor={} sample={}",
                catalog.items.len(),
                catalog.source.updated_at.as_deref().unwrap_or(""),
                catalog.source.sample
            );
            self.swap(catalog);
        }
        let mut next_run = tokio::time::Instant::now();
        loop {
            if !host.enabled() {
                log::info!("[mcp-catalog] sync is off");
                host.until_enabled_is(true).await;
                continue;
            }
            if tokio::time::Instant::now() < next_run {
                tokio::select! {
                    () = tokio::time::sleep_until(next_run) => {}
                    () = host.until_enabled_is(false) => {}
                }
                continue;
            }
            let phase = match self.sync_once(&host).await {
                Ok(()) => SyncPhase::Idle,
                Err(SyncError::Cancelled) => {
                    log::info!("[mcp-catalog] sync stopped: turned off");
                    *self.phase.lock() = SyncPhase::Idle;
                    continue;
                }
                Err(error) => {
                    log::warn!("[mcp-catalog] sync failed: {error}");
                    SyncPhase::Failed {
                        error: error.to_string(),
                        retry_at: Utc::now() + RETRY_INTERVAL,
                    }
                }
            };
            next_run = tokio::time::Instant::now()
                + if phase == SyncPhase::Idle {
                    POLL_INTERVAL
                } else {
                    RETRY_INTERVAL
                };
            *self.phase.lock() = phase;
        }
    }

    async fn sync_once(&self, host: &SyncHost) -> Result<(), SyncError> {
        let started_at = Utc::now();
        let plan = SyncPlan::for_catalog(&self.catalog().source);
        let full = plan.is_full();
        match plan {
            SyncPlan::Full => log::info!("[mcp-catalog] sync start: full crawl"),
            SyncPlan::Since(at) => log::info!("[mcp-catalog] sync start: cursor={}", rfc3339(at)),
        }
        *self.phase.lock() = SyncPhase::Syncing { full, fetched: 0 };
        // Biased so the setting is checked before every poll of the crawl: no page,
        // refetch, or retry goes out once sync is off, and a request in flight is dropped.
        let delta = tokio::select! {
            biased;
            () = host.until_enabled_is(false) => return Err(SyncError::Cancelled),
            delta = fetch(&host.registry, plan, |fetched| {
                *self.phase.lock() = SyncPhase::Syncing { full, fetched };
            }) => delta?,
        };
        let (received, refetched, changed) = (delta.received, delta.refetched, delta.rows.len());
        let dir = host.dir.clone();
        let current = self.catalog();
        let catalog =
            tokio::task::spawn_blocking(move || commit(&dir, &current, plan, delta, started_at))
                .await
                .map_err(|error| SyncError::Cache(error.to_string()))?
                .map_err(|error| SyncError::Cache(error.to_string()))?;
        log::info!(
            "[mcp-catalog] sync done: full={full} received={received} refetched={refetched} changed={changed} items={} cursor={}",
            catalog.items.len(),
            rfc3339(started_at)
        );
        self.swap(catalog);
        Ok(())
    }
}
