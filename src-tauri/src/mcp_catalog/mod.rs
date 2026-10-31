//! Host-owned MCP server catalog (SPEC CAP-1, CAP-2, CAP-4; spine AD-1 to
//! AD-4).
//!
//! The catalog is the bundled registry snapshot, converted through the AD-4
//! contract and kept current by live sync (`sync.rs`). It answers paged
//! search, sync status and the sync setting over every transport (HTTP under
//! `/mcp-catalog/`, the matching `/ws` requests on the web socket and the
//! desktop channel). Only the sync loop touches the network.
//!
//! The snapshot is embedded in the binary, so the service is one per process
//! rather than per `AppState`: the desktop and `termul-server` each own their
//! own copy, and every carrier in a process answers from the same one.

mod convert;
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
pub use search::{
    McpCatalogDefaultOption, McpCatalogPage, McpCatalogRow, McpCatalogSearchRequest,
    McpCatalogState, RunnerAvailability, SearchError,
};
pub use snapshot::{McpCatalogSource, RegistryStatus};
pub use sync::{McpCatalogSync, SyncPhase};

use snapshot::LoadedCatalog;
use sync::{Registry, SyncHost};

/// Runner availability is re-probed at most this often (the ACP catalog's
/// probe TTL), so installing a runtime shows up without a restart.
const RUNNER_PROBE_TTL: Duration = Duration::from_secs(60);
const MIN_DOTNET_SDK_MAJOR: u64 = 10;

static SHARED: OnceCell<Arc<McpCatalogService>> = OnceCell::const_new();

pub struct McpCatalogService {
    /// Swapped whole after each sync; a search keeps the one it started on.
    catalog: RwLock<Arc<LoadedCatalog>>,
    phase: Mutex<SyncPhase>,
    /// Set once at boot by [`Self::start`]; without it sync reads as off.
    sync: OnceLock<Arc<SyncHost>>,
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

/// Where the catalog comes from and what sync is doing.
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
            fixed_runners,
            runner_probe: Mutex::new(None),
            probe_gate: tokio::sync::Mutex::new(()),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_runners(catalog: LoadedCatalog, runners: RunnerAvailability) -> Self {
        Self::new(catalog, Some(runners))
    }

    /// Starts live sync for this process with its cache and setting under
    /// `dir` (`<state>/mcp-catalog`). Runs until the process exits.
    pub async fn start(dir: PathBuf) {
        Self::shared()
            .await
            .attach(dir, Registry::new(sync::REGISTRY_BASE))
            .await;
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

    /// Persists the host setting, wakes the loop, and returns the new status.
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
