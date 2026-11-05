//! The snapshot is embedded in the binary, so the service is one per process
//! rather than per `AppState`: the desktop and `termul-server` each own their
//! own copy, and every carrier in a process answers from the same one.
//!
//! A release snapshot is tens of thousands of rows. Parsing it at startup
//! keeps that whole catalog resident even when nobody opens it, so the
//! service stays unloaded until the first status, search, icon, or install
//! request. Sync still runs immediately and writes its cache to disk.

mod consent;
mod convert;
mod form;
mod icon;
mod import;
mod launch_check;
mod plan;
mod resolved;
mod search;
mod snapshot;
mod sync;
pub mod trust;

#[cfg(test)]
mod convert_tests;
#[cfg(test)]
mod launch_check_tests;
#[cfg(test)]
mod plan_tests;
#[cfg(test)]
mod search_tests;
#[cfg(test)]
mod snapshot_tests;
#[cfg(test)]
mod sync_tests;

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use tokio::sync::OnceCell;

pub use consent::{ConsentProvenance, ConsentValue, ConsentView, ConsentWarning, Namespace};
pub use convert::{McpCatalogReason, OptionKind, Runner};
pub use form::{Field, FieldFormat, FieldTarget, Origin};
pub use icon::{Icon, IconType};
pub use plan::{
    CancelRequest, CommitRequest, CommitResult, FormReply, FormRequest, InstallForm, InstallPlan,
    PlanCaller, PlanChoice, PlanReply, PlanRequest, PlanSource, PlanStore, ResolvedSecret,
    SecretSlot, MAX_PLAN_REQUEST_BYTES, PLAN_TTL,
};
pub use resolved::{Provenance, ResolvedConfig, ValueSlot};
pub use search::{
    McpCatalogDefaultOption, McpCatalogPage, McpCatalogRow, McpCatalogSearchRequest,
    McpCatalogState, RunnerAvailability, SearchError,
};
pub use snapshot::{McpCatalogSource, RegistryStatus};
pub use sync::{McpCatalogSync, SyncPhase};

use icon::IconCache;
use snapshot::LoadedCatalog;
use sync::{Registry, SyncHost};

/// Runner availability is re-probed at most this often (the ACP catalog's
/// probe TTL), so installing a runtime shows up without a restart.
const RUNNER_PROBE_TTL: Duration = Duration::from_secs(60);
const MIN_DOTNET_SDK_MAJOR: u64 = 10;

static SHARED: OnceCell<Arc<McpCatalogService>> = OnceCell::const_new();

type RunnerProbe = Arc<dyn Fn() -> RunnerAvailability + Send + Sync>;
/// `Some(dir)` merges the on-disk sync cache into the embedded snapshot.
type CatalogLoader = Arc<dyn Fn(Option<PathBuf>) -> LoadedCatalog + Send + Sync>;

pub struct McpCatalogService {
    phase: Mutex<SyncPhase>,
    sync: OnceLock<Arc<SyncHost>>,
    icons: OnceLock<Arc<IconCache>>,
    probe: RunnerProbe,
    loader: CatalogLoader,
    runner_probe: Mutex<Option<(Instant, RunnerAvailability)>>,
    /// Held across a probe so concurrent cache misses share one.
    probe_gate: tokio::sync::Mutex<()>,
    /// Held on the blocking thread for the whole parse or cache commit, so
    /// cancelling a request does not release it early.
    load_gate: Arc<Mutex<()>>,
    /// `mcp-catalog/` directory of the accepted sync host.
    state_dir: Mutex<Option<PathBuf>>,
    /// Last sync cursor. Lets the next sync plan a delta without parsing rows.
    sync_cursor: Arc<Mutex<Option<McpCatalogSource>>>,
    catalog: Arc<RwLock<Option<Arc<LoadedCatalog>>>>,
    plans: PlanStore,
}

/// A failure every transport returns with the same code and message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpCatalogError {
    pub code: &'static str,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpCatalogStatus {
    #[serde(flatten)]
    pub source: McpCatalogSource,
    pub servers: usize,
    pub sync: McpCatalogSync,
}

impl From<SearchError> for McpCatalogError {
    fn from(error: SearchError) -> Self {
        Self {
            code: "VALIDATION_ERROR",
            message: error.to_string(),
        }
    }
}

fn load_for_use(dir: Option<PathBuf>) -> LoadedCatalog {
    let base = snapshot::load_embedded();
    let cache = dir
        .as_deref()
        .and_then(|dir| sync::read_cache(dir, &base.source));
    fold_cache(base, cache)
}

/// A failed snapshot has no rows and no fetch time. An incremental cache is
/// only a delta, so folding it onto that empty base would hide every server
/// the delta did not mention and leave the next sync incremental.
pub(crate) fn fold_cache(base: LoadedCatalog, cache: Option<sync::RegistryCache>) -> LoadedCatalog {
    let failed = base.items.is_empty() && base.source.updated_at.is_none();
    if failed && cache.as_ref().is_none_or(|cache| !cache.full) {
        log::warn!("[mcp-catalog] snapshot load failed, waiting for a full crawl");
        return LoadedCatalog {
            items: Vec::new(),
            source: McpCatalogSource {
                updated_at: None,
                sample: true,
            },
        };
    }
    match cache {
        Some(cache) => {
            let catalog = sync::merge(&base, &cache);
            log::info!(
                "[mcp-catalog] sync cache loaded items={} cursor={} sample={}",
                catalog.items.len(),
                catalog.source.updated_at.as_deref().unwrap_or(""),
                catalog.source.sample
            );
            catalog
        }
        None => base,
    }
}

fn publish(
    catalog: &RwLock<Option<Arc<LoadedCatalog>>>,
    cursor: &Mutex<Option<McpCatalogSource>>,
    loaded: LoadedCatalog,
) -> Arc<LoadedCatalog> {
    let loaded = Arc::new(loaded);
    *cursor.lock() = Some(loaded.source.clone());
    *catalog.write() = Some(Arc::clone(&loaded));
    loaded
}

fn default_loader() -> CatalogLoader {
    Arc::new(load_for_use)
}

impl McpCatalogService {
    /// The process's catalog service. The embedded snapshot stays unparsed
    /// until a request needs rows.
    pub async fn shared() -> Arc<Self> {
        SHARED
            .get_or_init(|| async {
                Arc::new(Self::with_plan_ttl(
                    None,
                    Arc::new(probe_runners),
                    PLAN_TTL,
                    default_loader(),
                ))
            })
            .await
            .clone()
    }

    #[cfg(test)]
    fn new(catalog: LoadedCatalog, probe: RunnerProbe) -> Self {
        Self::with_plan_ttl(Some(catalog), probe, PLAN_TTL, default_loader())
    }

    fn with_plan_ttl(
        catalog: Option<LoadedCatalog>,
        probe: RunnerProbe,
        ttl: Duration,
        loader: CatalogLoader,
    ) -> Self {
        Self {
            phase: Mutex::new(SyncPhase::Idle),
            sync: OnceLock::new(),
            icons: OnceLock::new(),
            probe,
            loader,
            runner_probe: Mutex::new(None),
            probe_gate: tokio::sync::Mutex::new(()),
            load_gate: Arc::new(Mutex::new(())),
            state_dir: Mutex::new(None),
            sync_cursor: Arc::new(Mutex::new(None)),
            catalog: Arc::new(RwLock::new(catalog.map(Arc::new))),
            plans: PlanStore::new(ttl),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_runners(catalog: LoadedCatalog, runners: RunnerAvailability) -> Self {
        Self::new(catalog, Arc::new(move || runners))
    }

    #[cfg(test)]
    pub(crate) fn with_runner_probe(
        catalog: LoadedCatalog,
        probe: impl Fn() -> RunnerAvailability + Send + Sync + 'static,
    ) -> Self {
        Self::new(catalog, Arc::new(probe))
    }

    #[cfg(test)]
    pub(crate) fn with_runners_and_ttl(
        catalog: LoadedCatalog,
        runners: RunnerAvailability,
        ttl: Duration,
    ) -> Self {
        Self::with_plan_ttl(
            Some(catalog),
            Arc::new(move || runners),
            ttl,
            default_loader(),
        )
    }

    /// An unloaded service. `loader` is the only path that parses the snapshot,
    /// so tests can count parses.
    #[cfg(test)]
    pub(crate) fn deferred(runners: RunnerAvailability, loader: CatalogLoader) -> Self {
        Self::with_plan_ttl(None, Arc::new(move || runners), PLAN_TTL, loader)
    }

    pub async fn run(dir: PathBuf) {
        let service = Self::shared().await;
        log::info!("[mcp-catalog] catalog deferred until the first catalog request");
        match IconCache::new(dir.join("icons")) {
            Ok(icons) => service.attach_icons(Arc::new(icons)),
            Err(error) => log::error!("[mcp-catalog] icons disabled, no HTTP client: {error}"),
        }
        match Registry::new(sync::REGISTRY_BASE) {
            Ok(registry) => service.attach(dir, registry).await,
            Err(error) => {
                log::error!("[mcp-catalog] sync disabled, no HTTP client: {error}");
                service.adopt_state_dir(dir);
            }
        }
    }

    pub(crate) fn attach_icons(&self, icons: Arc<IconCache>) {
        if self.icons.set(icons).is_err() {
            log::warn!("[mcp-catalog] icons already attached");
        }
    }

    #[cfg(test)]
    pub(crate) fn attach_fixed_icon(&self, dir: PathBuf, icon: Icon) {
        let fetch: icon::FetchIcon = Arc::new(move |_| {
            let icon = icon.clone();
            Box::pin(async move { Ok(icon) })
        });
        self.attach_icons(Arc::new(IconCache::with(
            dir,
            fetch,
            Arc::new(std::time::SystemTime::now),
            u64::MAX,
        )));
    }

    pub(crate) async fn attach(self: Arc<Self>, dir: PathBuf, registry: Registry) {
        let host_dir = dir.clone();
        let host = match tokio::task::spawn_blocking(move || SyncHost::new(dir, registry)).await {
            Ok(host) => Arc::new(host),
            Err(error) => {
                log::error!("[mcp-catalog] sync setup task failed: {error}");
                return;
            }
        };
        if self.sync.set(Arc::clone(&host)).is_err() {
            log::warn!("[mcp-catalog] sync already started");
            return;
        }
        self.adopt_state_dir(host_dir);
        log::info!("[mcp-catalog] sync attached enabled={}", host.enabled());
        self.run_sync(host).await;
    }

    /// The first accepted host owns the directory. A later `attach` that loses
    /// the `OnceLock` returns before this, so it cannot redirect reads.
    fn adopt_state_dir(&self, dir: PathBuf) {
        let mut slot = self.state_dir.lock();
        if slot.is_none() {
            *slot = Some(dir);
        }
    }

    fn loaded(&self) -> Option<Arc<LoadedCatalog>> {
        self.catalog.read().clone()
    }

    async fn ensure_loaded(&self) -> Arc<LoadedCatalog> {
        if let Some(catalog) = self.loaded() {
            return catalog;
        }
        let gate = Arc::clone(&self.load_gate);
        let loader = Arc::clone(&self.loader);
        let catalog = Arc::clone(&self.catalog);
        let cursor = Arc::clone(&self.sync_cursor);
        let dir = self.state_dir.lock().clone();
        match tokio::task::spawn_blocking(move || {
            let _gate = gate.lock();
            if let Some(existing) = catalog.read().clone() {
                return existing;
            }
            publish(&catalog, &cursor, loader(dir))
        })
        .await
        {
            Ok(catalog) => catalog,
            Err(error) => {
                log::error!("[mcp-catalog] snapshot load task failed: {error}");
                Arc::new(LoadedCatalog::default())
            }
        }
    }

    fn sync_status(&self) -> McpCatalogSync {
        match self.sync.get() {
            Some(host) if host.enabled() => McpCatalogSync::Enabled(self.phase.lock().clone()),
            _ => McpCatalogSync::Disabled,
        }
    }

    #[cfg(test)]
    pub(crate) fn is_loaded(&self) -> bool {
        self.catalog.read().is_some()
    }

    #[cfg(test)]
    pub(crate) fn sync_attached(&self) -> bool {
        self.sync.get().is_some()
    }

    #[cfg(test)]
    pub(crate) fn sync_view(&self) -> McpCatalogSync {
        self.sync_status()
    }

    pub async fn status(&self) -> McpCatalogStatus {
        let catalog = self.ensure_loaded().await;
        McpCatalogStatus {
            source: catalog.source.clone(),
            servers: catalog.items.len(),
            sync: self.sync_status(),
        }
    }

    pub async fn set_sync(&self, enabled: bool) -> Result<McpCatalogStatus, McpCatalogError> {
        let Some(host) = self.sync.get() else {
            return Err(McpCatalogError {
                code: "MCP_CATALOG_SYNC_UNAVAILABLE",
                message: "mcp catalog sync is not running on this host".to_string(),
            });
        };
        host.set_enabled(enabled).await.map_err(|error| {
            log::error!("[mcp-catalog] sync setting write failed: {error}");
            McpCatalogError {
                code: "MCP_CATALOG_SYNC_SETTING_FAILED",
                message: "the mcp catalog sync setting could not be saved".to_string(),
            }
        })?;
        log::info!("[mcp-catalog] sync setting enabled={enabled}");
        Ok(self.status().await)
    }

    pub async fn search(
        &self,
        request: &McpCatalogSearchRequest,
    ) -> Result<McpCatalogPage, McpCatalogError> {
        let query = search::validate(request)?;
        let runners = self.runners().await;
        let catalog = self.ensure_loaded().await;
        tokio::task::spawn_blocking(move || search::search(&catalog, runners, &query))
            .await
            .map_err(|error| {
                log::error!("[mcp-catalog] search task failed: {error}");
                McpCatalogError {
                    code: "SEARCH_ERROR",
                    message: "mcp catalog search failed".to_string(),
                }
            })?
            .map_err(McpCatalogError::from)
    }

    pub async fn icon(&self, name: &str) -> Result<Icon, McpCatalogError> {
        let catalog = self.ensure_loaded().await;
        let source = catalog
            .items
            .binary_search_by(|item| item.name.as_str().cmp(name))
            .ok()
            .and_then(|index| catalog.items[index].icon.clone())
            .ok_or_else(|| McpCatalogError {
                code: "NOT_FOUND",
                message: "this catalog server has no icon".to_string(),
            })?;
        let unavailable = || McpCatalogError {
            code: "MCP_CATALOG_ICON_UNAVAILABLE",
            message: "the icon could not be loaded".to_string(),
        };
        let icons = self.icons.get().ok_or_else(unavailable)?;
        icons.icon(&source).await.map_err(|_| unavailable())
    }

    fn cached_runners(&self) -> Option<RunnerAvailability> {
        (*self.runner_probe.lock())
            .filter(|(probed_at, _)| probed_at.elapsed() < RUNNER_PROBE_TTL)
            .map(|(_, runners)| runners)
    }

    pub async fn describe_install(
        &self,
        request: &FormRequest,
    ) -> Result<FormReply, McpCatalogError> {
        let runners = self.runners().await;
        let catalog = self.ensure_loaded().await;
        plan::describe_install(&catalog, runners, request)
    }

    pub async fn plan_install(
        &self,
        request: &PlanRequest,
        caller: PlanCaller,
    ) -> Result<PlanReply, McpCatalogError> {
        let runners = self.fresh_runners().await;
        let catalog = self.ensure_loaded().await;
        plan::plan_install(&catalog, runners, &self.plans, request, caller)
    }

    pub fn commit_install(
        &self,
        request: &CommitRequest,
        caller: &PlanCaller,
    ) -> Result<CommitResult, McpCatalogError> {
        plan::commit_install(&self.plans, request, caller)
    }

    pub fn cancel_install(
        &self,
        request: &CancelRequest,
        caller: &PlanCaller,
    ) -> Result<(), McpCatalogError> {
        plan::cancel_install(&self.plans, request, caller)
    }

    /// Drops the install plans a closed `/ws` connection held. A process
    /// whose catalog never loaded holds no plans, so this does not load it.
    pub fn forget_connection_plans(connection_id: &str) {
        let Some(service) = SHARED.get() else {
            return;
        };
        let dropped = service
            .plans
            .forget_caller(&PlanCaller::Connection(connection_id.to_string()));
        if dropped > 0 {
            log::info!("[mcp-catalog] dropped {dropped} plan(s) of a closed connection");
        }
    }

    #[cfg(test)]
    pub(crate) fn stored_plans(&self) -> usize {
        self.plans.count()
    }

    async fn runners(&self) -> RunnerAvailability {
        if let Some(runners) = self.cached_runners() {
            return runners;
        }
        let _probe_gate = self.probe_gate.lock().await;
        if let Some(runners) = self.cached_runners() {
            return runners;
        }
        self.probe_and_cache().await
    }

    async fn fresh_runners(&self) -> RunnerAvailability {
        let _probe_gate = self.probe_gate.lock().await;
        self.probe_and_cache().await
    }

    async fn probe_and_cache(&self) -> RunnerAvailability {
        let probe = Arc::clone(&self.probe);
        let runners = tokio::task::spawn_blocking(move || probe())
            .await
            .unwrap_or_default();
        log::debug!("[mcp-catalog] runner probe {runners:?}");
        *self.runner_probe.lock() = Some((Instant::now(), runners));
        runners
    }
}

/// PATH lookups plus one `dotnet --version` when `dotnet` is present. Never
/// runs a runner against a package. Blocking.
fn probe_runners() -> RunnerAvailability {
    use crate::acp::config::is_registry_launcher_on_path as on_path;
    RunnerAvailability {
        npx: on_path("npx"),
        uvx: on_path("uvx"),
        docker: on_path("docker"),
        dotnet: on_path("dotnet")
            && crate::acp::claude_agent::probe_runtime_stdout("dotnet", &["--version"])
                .and_then(|output| parse_dotnet_major(&output))
                .is_some_and(|major| major >= MIN_DOTNET_SDK_MAJOR),
    }
}

fn parse_dotnet_major(output: &str) -> Option<u64> {
    output.trim().split('.').next()?.parse().ok()
}
