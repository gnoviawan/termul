//! Host-owned MCP server catalog (SPEC CAP-1, CAP-4; spine AD-1 to AD-4).
//!
//! The catalog is the bundled registry snapshot, converted once per process
//! through the AD-4 contract, and answered as paged search over every
//! transport (HTTP `GET /mcp-catalog/search`, `/ws` `search_mcp_catalog` on
//! the web socket and the desktop channel). Nothing here touches the network.
//!
//! The snapshot is embedded in the binary, so the service is one per process
//! rather than per `AppState`: the desktop and `termul-server` each own their
//! own copy, and every carrier in a process answers from the same one.

mod consent;
mod convert;
mod form;
mod import;
mod launch_check;
mod plan;
mod resolved;
mod search;
mod snapshot;
pub mod trust;

#[cfg(test)]
mod convert_tests;
#[cfg(test)]
mod plan_tests;
#[cfg(test)]
mod search_tests;
#[cfg(test)]
mod snapshot_tests;

use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tokio::sync::OnceCell;

pub use consent::{ConsentProvenance, ConsentValue, ConsentView, ConsentWarning, Namespace};
pub use convert::{McpCatalogReason, OptionKind, Runner};
pub use form::{Field, FieldFormat, FieldTarget, Origin};
pub use plan::{
    CancelRequest, CommitRequest, CommitResult, FormReply, FormRequest, InstallForm, InstallPlan,
    PlanCaller, PlanChoice, PlanReply, PlanRequest, PlanSource, PlanStore, ResolvedSecret,
    SecretSlot, PLAN_TTL,
};
pub use resolved::{Provenance, ResolvedConfig, ValueSlot};
pub use search::{
    McpCatalogDefaultOption, McpCatalogPage, McpCatalogRow, McpCatalogSearchRequest,
    McpCatalogState, RunnerAvailability, SearchError,
};
pub use snapshot::RegistryStatus;

use snapshot::LoadedCatalog;

/// Runner availability is re-probed at most this often (the ACP catalog's
/// probe TTL), so installing a runtime shows up without a restart.
const RUNNER_PROBE_TTL: Duration = Duration::from_secs(60);
const MIN_DOTNET_SDK_MAJOR: u64 = 10;

static SHARED: OnceCell<Arc<McpCatalogService>> = OnceCell::const_new();

pub struct McpCatalogService {
    catalog: Arc<LoadedCatalog>,
    /// Set by tests in place of probing the host's PATH.
    fixed_runners: Option<RunnerAvailability>,
    runner_probe: Mutex<Option<(Instant, RunnerAvailability)>>,
    /// Held across a probe so concurrent cache misses share one.
    probe_gate: tokio::sync::Mutex<()>,
    plans: PlanStore,
}

/// A failure every transport returns with the same code and message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpCatalogError {
    pub code: &'static str,
    pub message: String,
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
                Arc::new(Self {
                    catalog: Arc::new(catalog),
                    fixed_runners: None,
                    runner_probe: Mutex::new(None),
                    probe_gate: tokio::sync::Mutex::new(()),
                    plans: PlanStore::default(),
                })
            })
            .await
            .clone()
    }

    #[cfg(test)]
    pub(crate) fn with_runners(catalog: LoadedCatalog, runners: RunnerAvailability) -> Self {
        Self::with_runners_and_ttl(catalog, runners, PLAN_TTL)
    }

    #[cfg(test)]
    pub(crate) fn with_runners_and_ttl(
        catalog: LoadedCatalog,
        runners: RunnerAvailability,
        ttl: Duration,
    ) -> Self {
        Self {
            catalog: Arc::new(catalog),
            fixed_runners: Some(runners),
            runner_probe: Mutex::new(None),
            probe_gate: tokio::sync::Mutex::new(()),
            plans: PlanStore::new(ttl),
        }
    }

    pub async fn search(
        &self,
        request: &McpCatalogSearchRequest,
    ) -> Result<McpCatalogPage, McpCatalogError> {
        let query = search::validate(request)?;
        let runners = self.runners().await;
        let catalog = Arc::clone(&self.catalog);
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

    pub async fn describe_install(
        &self,
        request: &FormRequest,
    ) -> Result<FormReply, McpCatalogError> {
        let runners = self.runners().await;
        plan::describe_install(&self.catalog, runners, request)
    }

    pub async fn plan_install(
        &self,
        request: &PlanRequest,
        caller: PlanCaller,
    ) -> Result<PlanReply, McpCatalogError> {
        let runners = self.runners().await;
        plan::plan_install(&self.catalog, runners, &self.plans, request, caller)
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
