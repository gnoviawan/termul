//! Host-owned ACP catalog service (CAP-6 / Story 8).
//!
//! Moves catalog loading, host capability resolution (OS/arch/runtime), and
//! per-agent installability computation from the renderer to the host. The host
//! embeds the trusted `agents.json` at build time (`include_str!`), optionally
//! augments with the explicitly-approved CDN registry snapshot (reusing
//! `acp_registry_snapshot`), probes real runtime availability, computes the
//! 5-state `SupportedAcpAgentStatus` per agent, and serves the resolved catalog
//! via a single `list_catalog()` operation exposed across all three transports
//! (Tauri command `acp_list_catalog`, HTTP `GET /acp/catalog`, WS
//! `list_acp_catalog`).
//!
//! # Storage layout
//!
//! The service root is `<app_data_dir>/acp-catalog` (desktop) or
//! `<service_account_state_dir>/acp-catalog` (standalone). The opt-in config
//! file lives at `root/acp-catalog-config.json`, written via
//! [`crate::acp::atomic_file::replace`]. The CDN snapshot cache lives at
//! `root/acp-registry-snapshot-cache.json` — the single shared snapshot cache
//! per host. The catalog augmentation serves it with a 24h TTL (see
//! `acp_registry_snapshot`), and the desktop "Check for updates" command
//! rewrites this same file, so a manual refresh flows into the next catalog
//! resolution.
//!
//! # Concurrency
//!
//! `AcpCatalogService::open` returns an `Arc<Self>` shared by the host runtime
//! (desktop OR standalone, never both). The probe cache is an `RwLock<Option<…>>`
//! so concurrent `list_catalog` callers share the cached probes within the TTL;
//! a `refresh=true` force-refresh invalidates the cache and re-probes.
//!
//! # What the catalog NEVER carries
//!
//! `AgentConfig.env` (carries API keys), resolved absolute executable paths
//! (leaks host filesystem layout), or non-HTTPS download URLs. The catalog is
//! credential-free, path-free, read-only host introspection.

use std::fs;
use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};

use crate::acp::atomic_file;
use crate::acp_registry_snapshot::{
    self, AcpRegistrySnapshot, ResolvedSnapshot, SnapshotFetchOutcome,
};

// ---------------------------------------------------------------------------
// Wire types (camelCase serde, byte-identical to the TS shapes)
// ---------------------------------------------------------------------------

/// The 5-state per-agent installability status. Mirrors the existing renderer
/// `SupportedAcpAgentStatus` (`supported-acp-agents.ts:70-80`). Serialized as
/// kebab-case to match the TS union
/// `'ready' | 'install-required' | 'needs-runtime' | 'manual-install' |
/// 'unavailable'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SupportedAcpAgentStatus {
    Ready,
    InstallRequired,
    NeedsRuntime,
    ManualInstall,
    Unavailable,
}

/// Runtime availability on the host. Extends the existing `AcpRuntimeProbe`
/// (`config.rs:141-154`) to cover `node`/`bun`/`python3` + named binary probes.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogRuntimeAvailability {
    pub npx: bool,
    pub uvx: bool,
    pub node: bool,
    pub bun: bool,
    pub python3: bool,
    #[serde(default)]
    pub npm: bool,
    #[serde(default)]
    pub node_major: Option<u64>,
    #[serde(default)]
    pub claude_cli: bool,
    /// Why the most-preferred runtime (currently Claude ACP) is blocked, in
    /// the renderer's own copy. `None` when no computed block applies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

/// Host capability block: OS + arch + runtime availability. The host is the
/// single source of truth — web clients never probe `@tauri-apps/plugin-os` or
/// PATH locally.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostCapability {
    pub os: String,
    pub arch: String,
    pub runtimes: CatalogRuntimeAvailability,
}

/// A platform target pair (e.g. `{ os: "linux", arch: "x86_64" }`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformTarget {
    pub os: String,
    pub arch: String,
}

/// Whether a catalog entry came from the trusted bundled baseline or the
/// explicitly-approved CDN registry augmentation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CatalogSource {
    Bundled,
    Registry,
}

/// Resolved installed-binary info for a host-installed agent. Populated by
/// `overlay_installed` from the `AcpInstallService` manifest so the web client
/// (which has no renderer persistence) can build a spawn config from the
/// host-resolved absolute `command`/`args` without re-deriving it locally.
/// Carries NO env/API keys — the renderer pulls env from the distribution.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledCatalogInfo {
    pub command: String,
    pub args: Vec<String>,
    /// The installed manifest version — what the user actually runs. Clients
    /// detect per-agent updates by comparing this against the registry version.
    pub version: String,
}

/// One resolved catalog entry. Carries identity + distribution metadata +
/// computed `status` + `runtimeRequirements` + `platformTargets`. The
/// optional `installed` block carries the host-resolved absolute
/// `command`/`args` for an already-installed agent (populated by
/// `overlay_installed`); it carries NO `AgentConfig.env` (API keys).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogAgent {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub source: CatalogSource,
    pub distribution: serde_json::Value,
    pub runtime_requirements: Vec<String>,
    pub status: SupportedAcpAgentStatus,
    pub platform_targets: Vec<PlatformTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed: Option<InstalledCatalogInfo>,
}

/// The resolved catalog payload served across all three transports.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpCatalog {
    pub host: HostCapability,
    pub agents: Vec<CatalogAgent>,
}

/// `POST /acp/catalog/opt-in` + WS `set_catalog_opt_in` request body.
/// `deny_unknown_fields` rejects an over-serialized payload (e.g.
/// `{ enabled: true, extra: "junk" }`) loudly at the host boundary — maps to
/// `VALIDATION_ERROR`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetCatalogOptInRequest {
    pub enabled: bool,
}

// ---------------------------------------------------------------------------
// Opt-in config persistence
// ---------------------------------------------------------------------------

/// Current on-disk opt-in config schema version.
const CATALOG_CONFIG_SCHEMA_VERSION: u32 = 1;

/// Schema-versioned envelope for the opt-in config file. Mirrors the
/// `WorkspaceManifestFile` pattern so future migrations route through a
/// `migrate` hook. A corrupt file is backed up via
/// [`atomic_file::backup_corrupt`] then treated as fresh (opt-in = false).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogConfigFile {
    pub schema_version: u32,
    pub opt_in_cdn: bool,
}

const CONFIG_FILENAME: &str = "acp-catalog-config.json";
const SNAPSHOT_CACHE_FILENAME: &str = "acp-registry-snapshot-cache.json";

// ---------------------------------------------------------------------------
// Bundled catalog (trusted baseline, embedded at build time)
// ---------------------------------------------------------------------------

/// The trusted baseline catalog, embedded at build time via `include_str!`.
/// The path is relative to this file and resolves to
/// `src/renderer/assets/agent-icons/acp/agents.json` within the workspace.
/// Cannot be tampered without rebuilding the host binary.
const BUNDLED_CATALOG_JSON: &str =
    include_str!("../../../src/renderer/assets/agent-icons/acp/agents.json");

/// A raw bundled agent entry (the shape of `agents.json`).
#[derive(Debug, Clone, Deserialize)]
struct BundledAgent {
    id: String,
    name: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    description: String,
    distribution: serde_json::Value,
}

// ---------------------------------------------------------------------------
// Probe cache
// ---------------------------------------------------------------------------

/// Cached probe results + the resolved catalog. Held under an `RwLock` so
/// concurrent `list_catalog` callers share the cached probes within the TTL.
struct CachedCatalog {
    catalog: AcpCatalog,
    computed_at: Instant,
}

/// Probe cache TTL — 60s. Avoids re-probing PATH on every catalog request; a
/// `refresh=true` force-refresh invalidates the cache and re-probes.
const PROBE_TTL: Duration = Duration::from_secs(60);

/// Minimum interval between non-forced CDN snapshot fetch attempts after a
/// failure (1h). Bounds the offline stall: without it, each probe-cache
/// expiry would block up to the 15s fetch timeout before the stale fallback.
const SNAPSHOT_FETCH_RETRY_INTERVAL: Duration = Duration::from_secs(60 * 60);

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/// The CDN snapshot fetch the augmentation path delegates to. Injected so
/// the catalog I/O matrix (opt-in success / fetch failure / force-refresh
/// wiring) is unit-testable without touching the network; production installs
/// [`snapshot_fetcher`] over [`production_snapshot_delegate`].
type SnapshotFetcher = Arc<
    dyn Fn(PathBuf, bool) -> Pin<Box<dyn Future<Output = Result<ResolvedSnapshot, String>> + Send>>
        + Send
        + Sync,
>;

/// The delegate a [`SnapshotFetcher`] forwards `(path, force_refresh)` to.
/// Parameterizing the constructor over this seam pins the forwarding: a
/// dropped `force_refresh` pass-through here would silently break manual
/// refresh while leaving every fetcher-injected test green.
type SnapshotFetchDelegate =
    fn(PathBuf, bool) -> Pin<Box<dyn Future<Output = Result<ResolvedSnapshot, String>> + Send>>;

/// Production delegate: the shared TTL/caching snapshot path (the single
/// code path shared with the desktop Tauri command).
fn production_snapshot_delegate(
    path: PathBuf,
    force_refresh: bool,
) -> Pin<Box<dyn Future<Output = Result<ResolvedSnapshot, String>> + Send>> {
    Box::pin(async move {
        acp_registry_snapshot::fetch_acp_registry_snapshot_with_cache_path(&path, force_refresh)
            .await
    })
}

/// Build a [`SnapshotFetcher`] that forwards `(path, force_refresh)`
/// unchanged to `delegate`.
fn snapshot_fetcher(delegate: SnapshotFetchDelegate) -> SnapshotFetcher {
    Arc::new(move |path, force_refresh| delegate(path, force_refresh))
}

/// Host-owned ACP catalog service. One instance per host runtime (desktop OR
/// standalone `termul-server`, never shared across processes). Constructed via
/// [`AcpCatalogService::open`], which creates the root directory + idempotent
/// re-open (mirrors `WorkspaceManifestService::open`).
///
/// The service:
/// 1. Parses the bundled `agents.json` (embedded via `include_str!`) at
///    construction — a parse failure is fatal (should not happen with a
///    build-time-embedded file) and surfaces as `CATALOG_LOAD_FAILED`.
/// 2. Optionally augments with the CDN registry snapshot (gated on the
///    host-persisted opt-in flag) via the injected [`SnapshotFetcher`]
///    (production: `acp_registry_snapshot`'s shared TTL/caching path).
/// 3. Probes real runtime availability (`npx`/`uvx`/`node`/`bun`/`python3`) +
///    named binary probes (PATH-only — never executes untrusted code).
/// 4. Computes the 5-state `SupportedAcpAgentStatus` per agent.
/// 5. Caches the resolved catalog in-process for 60s; `refresh=true`
///    force-refreshes.
pub struct AcpCatalogService {
    root: PathBuf,
    cache: RwLock<Option<CachedCatalog>>,
    snapshot_fetch: SnapshotFetcher,
    /// Last failed non-forced snapshot fetch attempt. While within
    /// [`SNAPSHOT_FETCH_RETRY_INTERVAL`], non-forced resolutions skip the
    /// fetch and serve the on-disk cache directly — otherwise an offline host
    /// with an expired cache would stall up to the fetch timeout on EVERY
    /// catalog resolution (each time the 60s probe cache expires). Forced
    /// refreshes always bypass the gate; a success clears it.
    snapshot_fetch_gate: Mutex<Option<Instant>>,
    /// Cached OpenCode 2 PATH/`~/.opencode/bin` probe. `None` inside the pair
    /// means the last probe found no v2 binary. Shares [`PROBE_TTL`] with the
    /// catalog probe cache so a catalog list does not spawn `--version` on
    /// every call.
    opencode_probe: Mutex<Option<(Instant, Option<PathBuf>)>>,
}

impl AcpCatalogService {
    /// Open (or re-open) an acp-catalog root. Creates the directory if
    /// missing; idempotent re-open returns a fresh `Arc<Self>` over the same
    /// root. Mirrors `WorkspaceManifestService::open`: Unix 0700 root, create
    /// the dir, return an `Arc<Self>`. A non-directory root is an error so a
    /// misconfigured host fails loudly at startup.
    pub async fn open(root: PathBuf) -> io::Result<Arc<Self>> {
        if root.exists() && !root.is_dir() {
            return Err(io::Error::other(format!(
                "acp-catalog root '{}' is not a directory",
                root.display()
            )));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new()
                .mode(0o700)
                .recursive(true)
                .create(&root)?;
        }
        #[cfg(not(unix))]
        {
            fs::create_dir_all(&root)?;
        }
        // Eagerly parse the bundled catalog at startup so a malformed
        // `include_str!` (should not happen — it is build-time-trusted) is
        // logged immediately. The parse still re-runs per `list_catalog` call,
        // so a failure also surfaces as `CatalogError::BundledParse` to the
        // first caller; this log only advances the visibility to startup.
        if let Err(error) = parse_bundled_catalog() {
            log::error!(
                "[acp-catalog] bundled catalog parse failed (should not happen with include_str!): {error}"
            );
        }
        log::info!("[acp-catalog] service ready root={}", root.display());
        Ok(Arc::new(Self {
            root,
            cache: RwLock::new(None),
            snapshot_fetch: snapshot_fetcher(production_snapshot_delegate),
            snapshot_fetch_gate: Mutex::new(None),
            opencode_probe: Mutex::new(None),
        }))
    }

    /// The catalog root directory.
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Path to the opt-in config file.
    fn config_path(&self) -> PathBuf {
        self.root.join(CONFIG_FILENAME)
    }

    /// Path to the CDN snapshot cache file (reuses the
    /// `acp_registry_snapshot` cache format).
    fn snapshot_cache_path(&self) -> PathBuf {
        self.root.join(SNAPSHOT_CACHE_FILENAME)
    }

    /// Resolve the catalog. Returns the cached catalog if fresh (within TTL);
    /// otherwise re-probes + re-computes + re-caches. `refresh=true`
    /// force-refreshes: invalidates the cache, re-probes, AND bypasses the
    /// CDN snapshot cache TTL so a manual refresh actually reaches the served
    /// catalog.
    pub async fn list_catalog(self: &Arc<Self>, refresh: bool) -> Result<AcpCatalog, CatalogError> {
        // Fast path: return the cached catalog if fresh.
        if !refresh {
            let cache = self.cache.read();
            if let Some(cached) = cache.as_ref() {
                if cached.computed_at.elapsed() < PROBE_TTL {
                    return Ok(cached.catalog.clone());
                }
            }
        }
        // Slow path: re-probe + re-compute + re-cache.
        let catalog = self.resolve_catalog(refresh).await?;
        let mut cache = self.cache.write();
        *cache = Some(CachedCatalog {
            catalog: catalog.clone(),
            computed_at: Instant::now(),
        });
        Ok(catalog)
    }

    /// When OpenCode has no Termul-managed install, attach a v2 binary found
    /// on PATH or under `~/.opencode/bin`. A managed install already in
    /// `installed` wins and this probe does not run.
    pub async fn apply_external_opencode(&self, catalog: &mut AcpCatalog) {
        let needs_probe = catalog
            .agents
            .iter()
            .any(|agent| agent.id == "opencode" && agent.installed.is_none());
        if !needs_probe {
            return;
        }
        let binary = self.cached_external_opencode().await;
        apply_external_opencode_binary(catalog, binary.as_deref());
    }

    async fn cached_external_opencode(&self) -> Option<PathBuf> {
        {
            let guard = self.opencode_probe.lock();
            if let Some((probed_at, cached)) = guard.as_ref() {
                if probed_at.elapsed() < PROBE_TTL {
                    return cached.clone();
                }
            }
        }
        let probed = match tokio::task::spawn_blocking(
            crate::acp::opencode_version::probe_external_opencode_v2,
        )
        .await
        {
            Ok(path) => path,
            Err(_) => {
                log::warn!("[acp-catalog] opencode probe task failed");
                tracing::warn!("[acp-catalog] opencode probe task failed");
                None
            }
        };
        let mut guard = self.opencode_probe.lock();
        *guard = Some((Instant::now(), probed.clone()));
        probed
    }

    /// Fetch the CDN registry snapshot through this host's shared snapshot
    /// cache (`root/acp-registry-snapshot-cache.json`). Backs the desktop
    /// "Check for updates" Tauri command (`acp_fetch_registry_snapshot`) so a
    /// manual refresh rewrites the SAME cache the catalog augmentation serves
    /// (applying the remote registry is a separate renderer flow that goes
    /// through `setCatalogOptIn`, not this command). On success the in-memory
    /// resolved catalog is invalidated so the NEXT `list_catalog` resolution
    /// — even within the 60s probe TTL — serves the refreshed snapshot.
    pub async fn fetch_registry_snapshot(
        &self,
        force_refresh: bool,
    ) -> Result<AcpRegistrySnapshot, String> {
        let result = (self.snapshot_fetch)(self.snapshot_cache_path(), force_refresh).await;
        self.apply_snapshot_fetch_outcome(&result, force_refresh);
        match result {
            Ok(resolved) => {
                if resolved.persisted {
                    // Invalidate the resolved-catalog cache (mirrors
                    // `set_opt_in`) so the manual refresh actually reaches
                    // the served catalog. `persisted` is true for any
                    // cache-served outcome and for a confirmed cache rewrite.
                    let mut cache = self.cache.write();
                    *cache = None;
                } else {
                    // Network fetch succeeded but the on-disk cache was NOT
                    // rewritten: keep the in-memory catalog intact — the next
                    // resolution must not re-resolve against a stale disk
                    // cache on the assumption the fresh snapshot persisted.
                    log::warn!(
                        "[acp-catalog] snapshot fetched but cache persistence unconfirmed — keeping in-memory catalog"
                    );
                }
                Ok(resolved.snapshot)
            }
            Err(error) => Err(error),
        }
    }

    /// Whether a non-forced snapshot fetch is gated: a previous non-forced
    /// attempt failed within [`SNAPSHOT_FETCH_RETRY_INTERVAL`].
    fn snapshot_fetch_gated(&self) -> bool {
        let gate = self.snapshot_fetch_gate.lock();
        matches!(*gate, Some(last) if last.elapsed() < SNAPSHOT_FETCH_RETRY_INTERVAL)
    }

    /// Apply the retry-gate semantics for a completed fetch attempt. The
    /// gate tracks the REAL network outcome, not the resolver `Result` (a
    /// network failure with a stale-cache fallback is `Ok`):
    /// - `NetworkFresh` → clear the gate (any path; the rewritten cache's
    ///   own TTL governs freshness from there).
    /// - `StaleAfterFailure` or `Err` → set the gate ONLY for non-forced
    ///   attempts; a forced failure (manual "Check for updates" while
    ///   offline) leaves the gate unchanged so auto-refresh resumes as soon
    ///   as connectivity recovers.
    /// - `FreshCache` → unchanged (no network attempt happened).
    fn apply_snapshot_fetch_outcome(
        &self,
        result: &Result<ResolvedSnapshot, String>,
        force_refresh: bool,
    ) {
        let mut gate = self.snapshot_fetch_gate.lock();
        match result {
            Ok(resolved) => match resolved.outcome {
                SnapshotFetchOutcome::NetworkFresh => *gate = None,
                SnapshotFetchOutcome::FreshCache => {}
                SnapshotFetchOutcome::StaleAfterFailure => {
                    if !force_refresh {
                        *gate = Some(Instant::now());
                    }
                }
            },
            Err(_) => {
                if !force_refresh {
                    *gate = Some(Instant::now());
                }
            }
        }
    }

    /// Read the opt-in flag. Returns `false` when the file is missing (the
    /// default — CDN augmentation is off) or when the file is corrupt (backed
    /// up + treated as fresh, mirroring `WorkspaceManifestService`).
    pub fn is_opt_in(&self) -> bool {
        match self.read_opt_in_blocking() {
            Ok(enabled) => enabled,
            Err(error) => {
                log::warn!("[acp-catalog] opt-in read failed (defaulting to false): {error}");
                false
            }
        }
    }

    /// Set the opt-in flag. Persists to `root/acp-catalog-config.json` via
    /// `atomic_file::replace` (crash-consistent). A corrupt file on the
    /// read-back is backed up + treated as fresh.
    pub fn set_opt_in(&self, enabled: bool) -> Result<(), CatalogError> {
        let path = self.config_path();
        let envelope = CatalogConfigFile {
            schema_version: CATALOG_CONFIG_SCHEMA_VERSION,
            opt_in_cdn: enabled,
        };
        let serialized = serde_json::to_vec_pretty(&envelope)?;
        atomic_file::replace(&path, &serialized)?;
        // Invalidate the probe cache so the next `list_catalog` re-evaluates
        // the CDN augmentation (the opt-in change flips whether CDN entries
        // are included).
        let mut cache = self.cache.write();
        *cache = None;
        log::info!("[acp-catalog] opt-in set enabled={enabled}");
        Ok(())
    }

    // --- Internals -----------------------------------------------------------

    /// Read the opt-in flag (blocking — the file is tiny JSON, sub-ms).
    fn read_opt_in_blocking(&self) -> Result<bool, CatalogError> {
        let path = self.config_path();
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                // Missing file = opt-in is off (the default).
                return Ok(false);
            }
            Err(error) => return Err(error.into()),
        };
        match serde_json::from_slice::<CatalogConfigFile>(&bytes) {
            Ok(file) if file.schema_version == CATALOG_CONFIG_SCHEMA_VERSION => Ok(file.opt_in_cdn),
            Ok(file) => {
                log::warn!(
                    "[acp-catalog] opt-in bad schema_version expected={} found={} — backing up + fresh start",
                    CATALOG_CONFIG_SCHEMA_VERSION,
                    file.schema_version
                );
                let _ = atomic_file::backup_corrupt(&path, &bytes);
                Ok(false)
            }
            Err(error) => {
                log::warn!(
                    "[acp-catalog] opt-in file corrupt error={error} — backing up + fresh start"
                );
                let _ = atomic_file::backup_corrupt(&path, &bytes);
                Ok(false)
            }
        }
    }

    /// Resolve the full catalog: probe runtimes + parse bundled + optional CDN
    /// augmentation + per-agent status computation.
    /// `force_snapshot_refresh=true` bypasses the CDN snapshot cache TTL
    /// (manual refresh); `false` applies the shared TTL semantics (fresh cache
    /// served with zero network; expired cache refetched, stale fallback on
    /// failure).
    async fn resolve_catalog(
        &self,
        force_snapshot_refresh: bool,
    ) -> Result<AcpCatalog, CatalogError> {
        // Runtime probes do filesystem checks + a (cached) `node --version`
        // spawn — run them on the blocking pool so a hung `node` child cannot
        // stall the async core beyond the probe's own 5s cap. A join failure
        // here only happens when the whole runtime is shutting down; surface a
        // fully-unavailable probe rather than failing catalog resolution.
        let runtimes = tokio::task::spawn_blocking(probe_runtimes)
            .await
            .unwrap_or_default();
        let host = HostCapability {
            os: host_os().to_string(),
            arch: std::env::consts::ARCH.to_string(),
            runtimes,
        };
        let platform_arch = host_platform_arch();

        // Parse the bundled catalog (trusted baseline).
        let bundled = parse_bundled_catalog()?;

        // Optional CDN augmentation (gated on the host-persisted opt-in).
        let mut agents: Vec<CatalogAgent> = bundled
            .iter()
            .map(|agent| {
                compute_catalog_agent(agent, &host, &platform_arch, CatalogSource::Bundled)
            })
            .collect();

        let bundled_count = agents.len();
        if self.is_opt_in() {
            let snapshot = if !force_snapshot_refresh && self.snapshot_fetch_gated() {
                // A non-forced fetch failed within the retry interval — skip
                // the fetch (no 15s stall loop on an offline host) and serve
                // the on-disk cache directly, however stale. Forced refreshes
                // never take this path.
                log::debug!(
                    "[acp-catalog] snapshot fetch gated after recent failure — serving on-disk cache"
                );
                acp_registry_snapshot::read_cached_snapshot(&self.snapshot_cache_path())
                    .map(|snapshot| ResolvedSnapshot {
                        snapshot,
                        // Never fed to the gate (this branch records no
                        // attempt); the cache came straight from disk.
                        outcome: SnapshotFetchOutcome::FreshCache,
                        persisted: true,
                    })
                    .ok_or_else(|| {
                        "snapshot fetch gated after recent failure and no cache present".to_string()
                    })
            } else {
                let result =
                    (self.snapshot_fetch)(self.snapshot_cache_path(), force_snapshot_refresh).await;
                self.apply_snapshot_fetch_outcome(&result, force_snapshot_refresh);
                result
            };
            match snapshot {
                Ok(resolved) => {
                    let snapshot = resolved.snapshot;
                    let mut cdn_count = 0;
                    for snapshot_agent in &snapshot.agents {
                        // Validate the CDN entry (reuse the snapshot's
                        // `is_safe_agent_id` + `sanitize_distribution`).
                        if !acp_registry_snapshot::is_safe_agent_id(&snapshot_agent.id) {
                            continue;
                        }
                        let Some(distribution) = acp_registry_snapshot::sanitize_distribution(
                            &snapshot_agent.distribution,
                        ) else {
                            continue;
                        };
                        let entry = BundledAgent {
                            id: snapshot_agent.id.clone(),
                            name: snapshot_agent.name.clone(),
                            version: snapshot_agent.version.clone(),
                            description: snapshot_agent.description.clone(),
                            distribution,
                        };
                        let computed = compute_catalog_agent(
                            &entry,
                            &host,
                            &platform_arch,
                            CatalogSource::Registry,
                        );
                        // Applied Registry wins on id collision (ADR-0002):
                        // the user explicitly applied this snapshot, so its
                        // version + distribution must govern launches and
                        // installs. An additive-only merge left binary
                        // installs resolving the stale bundled archive —
                        // update drift never cleared and every "Update"
                        // click reinstalled the same old version.
                        if let Some(existing) =
                            agents.iter_mut().find(|a| a.id == snapshot_agent.id)
                        {
                            *existing = computed;
                        } else {
                            agents.push(computed);
                        }
                        cdn_count += 1;
                    }
                    log::info!(
                        "[acp-catalog] resolved bundled={} cdn={} total={}",
                        bundled_count,
                        cdn_count,
                        agents.len()
                    );
                }
                Err(error) => {
                    // CDN fetch failed — degrade gracefully to bundled-only.
                    // The client receives success (no error); a warn log
                    // records the CDN failure.
                    log::warn!(
                        "[acp-catalog] CDN fetch failed (degrading to bundled-only): {error}"
                    );
                }
            }
        } else {
            log::debug!(
                "[acp-catalog] opt-in off — serving bundled-only ({} agents)",
                bundled_count
            );
        }

        // Sort by name for stable display order (mirrors the renderer's
        // `buildSupportedAcpAgents` sort).
        agents.sort_by(|a, b| a.name.cmp(&b.name));

        Ok(AcpCatalog { host, agents })
    }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Catalog load / persistence failure.
#[derive(Debug)]
pub enum CatalogError {
    /// The bundled `agents.json` failed to parse (should not happen with
    /// `include_str!`).
    BundledParse(serde_json::Error),
    /// Filesystem read/write failure (permission, disk full, …).
    Io(io::Error),
}

impl std::fmt::Display for CatalogError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BundledParse(error) => {
                write!(f, "bundled catalog parse failed: {error}")
            }
            Self::Io(error) => write!(f, "acp-catalog io error: {error}"),
        }
    }
}

impl std::error::Error for CatalogError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::BundledParse(error) => Some(error),
            Self::Io(error) => Some(error),
        }
    }
}

impl From<io::Error> for CatalogError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for CatalogError {
    fn from(value: serde_json::Error) -> Self {
        Self::BundledParse(value)
    }
}

// ---------------------------------------------------------------------------
// Host capability + probe helpers
// ---------------------------------------------------------------------------

/// The host OS string. `std::env::consts::OS` returns `"linux"` / `"macos"` /
/// `"windows"`. The bundled catalog's binary map keys use `"darwin"` for macOS
/// (mirrors `currentPlatformArch()` in `acp-registry.ts:127-131`), so the
/// `host_platform_arch()` helper maps `"macos"` → `"darwin"` for the binary
/// map lookup. The `host.os` field in the catalog response keeps the
/// `std::env::consts::OS` value (the raw OS string the web client can display).
fn host_os() -> &'static str {
    std::env::consts::OS
}

/// The platform-arch key for the bundled catalog's binary map lookup.
/// Mirrors `currentPlatformArch()` in `acp-registry.ts:127-131`: maps
/// `"macos"` → `"darwin"` and returns `"{os}-{arch}"`.
fn host_platform_arch() -> String {
    let os = if std::env::consts::OS == "macos" {
        "darwin"
    } else {
        std::env::consts::OS
    };
    format!("{}-{}", os, std::env::consts::ARCH)
}

/// Probe executable availability through PATH and query only `node --version`
/// for Claude's major-version preflight. Never launches npm, npx, or agent code.
///
/// Blocking (filesystem probes + one cached `node --version` spawn): callers
/// on the async core run this through `spawn_blocking`.
fn probe_runtimes() -> CatalogRuntimeAvailability {
    let mut runtimes = CatalogRuntimeAvailability {
        npx: crate::acp::config::is_registry_launcher_on_path("npx"),
        uvx: crate::acp::config::is_registry_launcher_on_path("uvx"),
        node: crate::acp::config::is_registry_launcher_on_path("node"),
        bun: crate::acp::config::is_registry_launcher_on_path("bun"),
        python3: crate::acp::config::is_registry_launcher_on_path("python3"),
        npm: crate::acp::config::is_registry_launcher_on_path("npm"),
        node_major: crate::acp::claude_agent::probe_node_major(),
        claude_cli: crate::acp::config::is_registry_launcher_on_path("claude"),
        unavailable_reason: None,
    };
    // Finding 8: the host knows why the Claude ACP runtime is blocked — emit
    // the reason so web clients can render it without re-deriving thresholds.
    // `InstallRequired` here only means "policy clear"; the reason is emitted
    // for blocked paths only.
    runtimes.unavailable_reason = crate::acp::claude_agent::claude_status(
        &runtimes,
        SupportedAcpAgentStatus::InstallRequired,
    )
    .1
    .map(str::to_string);
    runtimes
}

// ---------------------------------------------------------------------------
// Bundled catalog parsing
// ---------------------------------------------------------------------------

/// Parse the embedded `agents.json` into typed entries. Called at construction
/// (eager parse so a malformed file surfaces at startup) and on each catalog
/// resolution (cheap — the file is small, ~10KB).
fn parse_bundled_catalog() -> Result<Vec<BundledAgent>, serde_json::Error> {
    let agents: Vec<BundledAgent> = serde_json::from_str(BUNDLED_CATALOG_JSON)?;
    Ok(agents)
}

// ---------------------------------------------------------------------------
// Per-agent status computation
// ---------------------------------------------------------------------------

/// Compute the `CatalogAgent` for a bundled or CDN-sourced agent entry.
/// Determines the preferred distribution (npx > uvx > binary), probes runtime
/// availability + binary-on-PATH, and computes the 5-state
/// `SupportedAcpAgentStatus`.
fn compute_catalog_agent(
    agent: &BundledAgent,
    host: &HostCapability,
    platform_arch: &str,
    source: CatalogSource,
) -> CatalogAgent {
    let dist = &agent.distribution;
    let dist_obj = dist.as_object();

    // Determine the preferred distribution + runtime requirements.
    let has_npx = dist_obj.is_some_and(|o| o.contains_key("npx"));
    let has_uvx = dist_obj.is_some_and(|o| o.contains_key("uvx"));
    let has_binary = dist_obj.is_some_and(|o| o.contains_key("binary"));

    let (runtime_reqs, status) = if has_npx {
        // npx is the preferred distribution.
        if agent.id == "claude-acp" {
            // Single policy source (see `claude_agent::claude_status`).
            let (status, _) = crate::acp::claude_agent::claude_status(
                &host.runtimes,
                SupportedAcpAgentStatus::InstallRequired,
            );
            let requirements = vec!["node".to_string(), "npm".to_string(), "claude".to_string()];
            (requirements, status)
        } else {
            (
                vec!["npx".to_string()],
                if host.runtimes.npx {
                    SupportedAcpAgentStatus::Ready
                } else {
                    SupportedAcpAgentStatus::NeedsRuntime
                },
            )
        }
    } else if has_uvx {
        (
            vec!["uvx".to_string()],
            if host.runtimes.uvx {
                SupportedAcpAgentStatus::Ready
            } else {
                SupportedAcpAgentStatus::NeedsRuntime
            },
        )
    } else if has_binary {
        // Binary-only distribution. Look up the platform target.
        let target = dist_obj
            .and_then(|o| o.get("binary"))
            .and_then(|b| b.as_object())
            .and_then(|b| b.get(platform_arch))
            .and_then(|t| t.as_object());

        let status =
            compute_binary_status(target, crate::acp::config::is_registry_launcher_on_path);
        (Vec::new(), status)
    } else {
        // No recognized distribution kind.
        (Vec::new(), SupportedAcpAgentStatus::Unavailable)
    };

    // Platform targets: empty for npx/uvx (works on any platform where the
    // runtime exists); parsed binary keys for binary distributions.
    let platform_targets = if has_binary && !has_npx && !has_uvx {
        parse_binary_platform_targets(dist)
    } else {
        Vec::new()
    };

    CatalogAgent {
        id: agent.id.clone(),
        name: agent.name.clone(),
        version: agent.version.clone(),
        description: agent.description.clone(),
        source,
        distribution: dist.clone(),
        runtime_requirements: runtime_reqs,
        status,
        platform_targets,
        // Populated later by `overlay_installed` from the host install manifest;
        // `None` here — the catalog's own resolution never knows install state.
        installed: None,
    }
}

/// Parse the binary distribution map keys into `PlatformTarget` pairs.
/// Keys are `"{os}-{arch}"` (e.g. `"darwin-aarch64"`, `"linux-x86_64"`).
fn parse_binary_platform_targets(dist: &serde_json::Value) -> Vec<PlatformTarget> {
    let Some(binary) = dist.get("binary").and_then(|b| b.as_object()) else {
        return Vec::new();
    };
    let mut targets = Vec::new();
    for key in binary.keys() {
        if let Some((os, arch)) = key.split_once('-') {
            targets.push(PlatformTarget {
                os: os.to_string(),
                arch: arch.to_string(),
            });
        }
    }
    targets
}

/// Compute the status for a binary-distributed agent.
/// - Binary on PATH (bare name) → `ready`
/// - Binary not on PATH + HTTPS archive → `install-required` (clickable
///   one-click install). The catalog is the trusted Zed ACP registry, so no
///   `sha256` digest is required or verified — `AcpInstallService::install`
///   downloads + extracts + activates without integrity verification.
/// - Binary not on PATH + no archive → `manual-install`
/// - No platform target → `unavailable`
///
/// The PATH probe is injected so the "binary on PATH → ready" branch (matrix
/// row 7) is unit-testable without a real binary on PATH.
fn compute_binary_status(
    target: Option<&serde_json::Map<String, serde_json::Value>>,
    probe: impl Fn(&str) -> bool,
) -> SupportedAcpAgentStatus {
    let Some(target) = target else {
        return SupportedAcpAgentStatus::Unavailable;
    };
    let cmd = target.get("cmd").and_then(|c| c.as_str()).unwrap_or("");
    let archive = target.get("archive").and_then(|a| a.as_str());

    // If the command is a bare name (not a relative path), probe it on PATH.
    let is_relative = cmd.starts_with("./") || cmd.starts_with(".\\");
    if !is_relative && !cmd.is_empty() && probe(cmd) {
        return SupportedAcpAgentStatus::Ready;
    }

    // Binary not on PATH. Any installable HTTPS archive (zip/tar.gz/tgz) is
    // `install-required` — the catalog is trusted (Zed ACP registry), so no
    // `sha256` digest is required. `AcpInstallService::install` proceeds
    // without integrity verification.
    if let Some(url) = archive {
        if is_https_archive_url(url) {
            return SupportedAcpAgentStatus::InstallRequired;
        }
    }
    SupportedAcpAgentStatus::ManualInstall
}

/// Check if a URL is HTTPS + an allowed archive format (zip / tar.gz / tgz).
/// Mirrors `supportedArchiveUrl` in `acp-registry.ts:148-154`.
fn is_https_archive_url(url: &str) -> bool {
    if !url.starts_with("https://") {
        return false;
    }
    let path = url.split(['?', '#']).next().unwrap_or(url).to_lowercase();
    path.ends_with(".zip") || path.ends_with(".tar.gz") || path.ends_with(".tgz")
}

/// Fill the OpenCode catalog row from an external v2 binary.
///
/// A row that already has `installed` (the Termul install manifest) is left
/// alone. `binary == None` leaves an install-required row unchanged. The
/// reported `version` is the catalog pin, so a newer PATH binary does not
/// show as a downgrade against that pin.
pub(crate) fn apply_external_opencode_binary(catalog: &mut AcpCatalog, binary: Option<&Path>) {
    let Some(binary) = binary else {
        return;
    };
    let Some(agent) = catalog
        .agents
        .iter_mut()
        .find(|agent| agent.id == "opencode")
    else {
        return;
    };
    if agent.installed.is_some() {
        return;
    }
    let version = agent.version.clone();
    agent.status = SupportedAcpAgentStatus::Ready;
    agent.installed = Some(InstalledCatalogInfo {
        command: binary.to_string_lossy().into_owned(),
        args: vec!["acp".to_string()],
        version,
    });
}

/// Overlay host-installed state onto a resolved catalog. For each catalog
/// agent whose `id` matches an entry in `installed`, populate `installed` with
/// the host-resolved `command`/`args` from the install manifest. Installed
/// agents become `ready`, except Claude ACP which must still pass its Node/npm
/// and external Claude CLI preflight. This makes the host the single source of truth for
/// "is this agent installed" — desktop and web both see installed agents as
/// `ready` (the web has no renderer persistence, so without this overlay it
/// could not reuse a host install). Idempotent; call after `list_catalog`.
///
/// Install-state must NOT downgrade a `ready` npx/uvx agent whose runtime is
/// present (those are never in the install manifest — the install service
/// only installs binary archives), and must NOT override an agent the catalog
/// resolved `unavailable`/`needs-runtime` (an installed binary whose runtime
/// disappeared is still installed — its `command` is absolute, not PATH-bound).
pub fn overlay_installed(
    catalog: &mut AcpCatalog,
    installed: &[crate::acp::install::InstalledAgent],
) {
    if installed.is_empty() {
        return;
    }
    let by_id: std::collections::HashMap<&str, &crate::acp::install::InstalledAgent> =
        installed.iter().map(|i| (i.agent_id.as_str(), i)).collect();
    for agent in &mut catalog.agents {
        if let Some(inst) = by_id.get(agent.id.as_str()) {
            if agent.id == "claude-acp" {
                // Single policy source (see `claude_agent::claude_status`) —
                // installed agents still pass the Node/npm + CLI preflight.
                let (status, _) = crate::acp::claude_agent::claude_status(
                    &catalog.host.runtimes,
                    SupportedAcpAgentStatus::Ready,
                );
                agent.status = status;
            } else {
                agent.status = SupportedAcpAgentStatus::Ready;
            }
            agent.installed = Some(InstalledCatalogInfo {
                command: inst.command.clone(),
                args: inst.args.clone(),
                version: inst.version.clone(),
            });
        }
    }
}

/// Epoch-millis timestamp (mirrors `workspace_manifest::now_millis`).
#[allow(dead_code)]
fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests;
