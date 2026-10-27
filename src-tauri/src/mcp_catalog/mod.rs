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
//!
//! Installing is plan, consent, commit (AD-5): `describe_install` generates
//! the form, `plan_install` builds the immutable plan and its consent view,
//! `commit_install` resolves the secrets and returns the entry, and
//! `cancel_install` drops the plan. The plan store is per process too, so a
//! plan made over one carrier is answered consistently by the other.

mod consent;
mod convert;
mod form;
mod import;
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
    catalog: LoadedCatalog,
    /// Set by tests in place of probing the host's PATH.
    fixed_runners: Option<RunnerAvailability>,
    runner_probe: Mutex<Option<(Instant, RunnerAvailability)>>,
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
                    catalog,
                    fixed_runners: None,
                    runner_probe: Mutex::new(None),
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
            catalog,
            fixed_runners: Some(runners),
            runner_probe: Mutex::new(None),
            plans: PlanStore::new(ttl),
        }
    }

    pub async fn search(
        &self,
        request: &McpCatalogSearchRequest,
    ) -> Result<McpCatalogPage, McpCatalogError> {
        let runners = self.runners().await;
        Ok(search::search(&self.catalog, runners, request)?)
    }

    /// The generated install form of a source (install-form.md), or the
    /// typed reason the chosen option cannot install.
    pub async fn describe_install(
        &self,
        request: &FormRequest,
    ) -> Result<FormReply, McpCatalogError> {
        let runners = self.runners().await;
        plan::describe_install(&self.catalog, runners, request)
    }

    /// Build an immutable plan from the filled non-secret inputs, bound to
    /// `caller` (AD-5).
    pub async fn plan_install(
        &self,
        request: &PlanRequest,
        caller: PlanCaller,
    ) -> Result<PlanReply, McpCatalogError> {
        let runners = self.runners().await;
        plan::plan_install(&self.catalog, runners, &self.plans, request, caller)
    }

    /// Resolve the secrets into the consented plan and return the entry. The
    /// plan is consumed on success and on a digest mismatch.
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
        if let Some(runners) = self.fixed_runners {
            return runners;
        }
        if let Some((probed_at, runners)) = *self.runner_probe.lock() {
            if probed_at.elapsed() < RUNNER_PROBE_TTL {
                return runners;
            }
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
