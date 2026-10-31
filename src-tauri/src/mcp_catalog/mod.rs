//! The snapshot is embedded in the binary, so the service is one per process
//! rather than per `AppState`: the desktop and `termul-server` each own their
//! own copy, and every carrier in a process answers from the same one.

mod convert;
mod icon;
mod search;
mod snapshot;
mod sync;

#[cfg(test)]
mod convert_tests;
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

pub use convert::{McpCatalogReason, OptionKind, Runner};
pub use icon::{Icon, IconType};
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

pub struct McpCatalogService {
    catalog: RwLock<Arc<LoadedCatalog>>,
    phase: Mutex<SyncPhase>,
    sync: OnceLock<Arc<SyncHost>>,
    icons: OnceLock<Arc<IconCache>>,
    /// Set by tests in place of probing the host's PATH.
    fixed_runners: Option<RunnerAvailability>,
    runner_probe: Mutex<Option<(Instant, RunnerAvailability)>>,
    /// Held across a probe so concurrent cache misses share one.
    probe_gate: tokio::sync::Mutex<()>,
}

/// A failure every transport returns with the same code and message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpCatalogError {
    pub code: &'static str,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
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

impl McpCatalogService {
    /// The process's catalog. The first call decompresses and converts the
    /// embedded snapshot on the blocking pool; later calls share it.
    pub async fn shared() -> Arc<Self> {
        SHARED
            .get_or_init(|| async {
                let catalog = tokio::task::spawn_blocking(snapshot::load_embedded)
                    .await
                    .unwrap_or_else(|error| {
                        log::error!("[mcp-catalog] snapshot load task failed: {error}");
                        LoadedCatalog::default()
                    });
                Arc::new(Self::new(catalog, None))
            })
            .await
            .clone()
    }

    fn new(catalog: LoadedCatalog, fixed_runners: Option<RunnerAvailability>) -> Self {
        Self {
            catalog: RwLock::new(Arc::new(catalog)),
            phase: Mutex::new(SyncPhase::Idle),
            sync: OnceLock::new(),
            icons: OnceLock::new(),
            fixed_runners,
            runner_probe: Mutex::new(None),
            probe_gate: tokio::sync::Mutex::new(()),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_runners(catalog: LoadedCatalog, runners: RunnerAvailability) -> Self {
        Self::new(catalog, Some(runners))
    }

    pub async fn run(dir: PathBuf) {
        let service = Self::shared().await;
        match IconCache::new(dir.join("icons")) {
            Ok(icons) => service.attach_icons(Arc::new(icons)),
            Err(error) => log::error!("[mcp-catalog] icons disabled, no HTTP client: {error}"),
        }
        match Registry::new(sync::REGISTRY_BASE) {
            Ok(registry) => service.attach(dir, registry).await,
            Err(error) => log::error!("[mcp-catalog] sync disabled, no HTTP client: {error}"),
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
        log::info!("[mcp-catalog] sync attached enabled={}", host.enabled());
        self.run_sync(host).await;
    }

    fn catalog(&self) -> Arc<LoadedCatalog> {
        Arc::clone(&self.catalog.read())
    }

    fn swap(&self, catalog: LoadedCatalog) {
        *self.catalog.write() = Arc::new(catalog);
    }

    pub fn status(&self) -> McpCatalogStatus {
        let catalog = self.catalog();
        let sync = match self.sync.get() {
            Some(host) if host.enabled() => McpCatalogSync::Enabled(self.phase.lock().clone()),
            _ => McpCatalogSync::Disabled,
        };
        McpCatalogStatus {
            source: catalog.source.clone(),
            servers: catalog.items.len(),
            sync,
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
        Ok(self.status())
    }

    pub async fn search(
        &self,
        request: &McpCatalogSearchRequest,
    ) -> Result<McpCatalogPage, McpCatalogError> {
        let query = search::validate(request)?;
        let runners = self.runners().await;
        let catalog = self.catalog();
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
        let catalog = self.catalog();
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
        let probe = *self.runner_probe.lock();
        self.fixed_runners.or_else(|| {
            probe
                .filter(|(probed_at, _)| probed_at.elapsed() < RUNNER_PROBE_TTL)
                .map(|(_, runners)| runners)
        })
    }

    async fn runners(&self) -> RunnerAvailability {
        if let Some(runners) = self.cached_runners() {
            return runners;
        }
        let _probe_gate = self.probe_gate.lock().await;
        if let Some(runners) = self.cached_runners() {
            return runners;
        }
        let runners = tokio::task::spawn_blocking(probe_runners)
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
