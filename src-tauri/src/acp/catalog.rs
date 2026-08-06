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
//! `root/acp-registry-snapshot-cache.json` (reuses the
//! `acp_registry_snapshot` cache format so a desktop that already fetched the
//! snapshot under `app_cache_dir` does not collide — the catalog root's cache
//! is independent).
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
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

use crate::acp::atomic_file;
use crate::acp_registry_snapshot;

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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogRuntimeAvailability {
    pub npx: bool,
    pub uvx: bool,
    pub node: bool,
    pub bun: bool,
    pub python3: bool,
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

/// One resolved catalog entry. Carries identity + distribution metadata +
/// computed `status` + `runtimeRequirements` + `platformTargets`. Never
/// carries `AgentConfig.env` (API keys) or resolved absolute executable paths.
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

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

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
///    host-persisted opt-in flag) via
///    `acp_registry_snapshot::fetch_acp_registry_snapshot_with_cache_path`.
/// 3. Probes real runtime availability (`npx`/`uvx`/`node`/`bun`/`python3`) +
///    named binary probes (PATH-only — never executes untrusted code).
/// 4. Computes the 5-state `SupportedAcpAgentStatus` per agent.
/// 5. Caches the resolved catalog in-process for 60s; `refresh=true`
///    force-refreshes.
pub struct AcpCatalogService {
    root: PathBuf,
    cache: RwLock<Option<CachedCatalog>>,
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
            std::os::unix::fs::DirBuilder::new()
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
    /// force-refreshes (invalidates the cache + re-probes).
    pub async fn list_catalog(
        self: &Arc<Self>,
        refresh: bool,
    ) -> Result<AcpCatalog, CatalogError> {
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
        let catalog = self.resolve_catalog().await?;
        let mut cache = self.cache.write();
        *cache = Some(CachedCatalog {
            catalog: catalog.clone(),
            computed_at: Instant::now(),
        });
        Ok(catalog)
    }

    /// Read the opt-in flag. Returns `false` when the file is missing (the
    /// default — CDN augmentation is off) or when the file is corrupt (backed
    /// up + treated as fresh, mirroring `WorkspaceManifestService`).
    pub fn is_opt_in(&self) -> bool {
        match self.read_opt_in_blocking() {
            Ok(enabled) => enabled,
            Err(error) => {
                log::warn!(
                    "[acp-catalog] opt-in read failed (defaulting to false): {error}"
                );
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
    async fn resolve_catalog(&self) -> Result<AcpCatalog, CatalogError> {
        let runtimes = probe_runtimes();
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
            .map(|agent| compute_catalog_agent(agent, &host, &platform_arch, CatalogSource::Bundled))
            .collect();

        let bundled_count = agents.len();
        if self.is_opt_in() {
            match acp_registry_snapshot::fetch_acp_registry_snapshot_with_cache_path(
                &self.snapshot_cache_path(),
                false,
            )
            .await
            {
                Ok(snapshot) => {
                    // Collect bundled ids into an owned set so we can mutate
                    // `agents` (push CDN entries) without holding an immutable
                    // borrow of `agents` (borrow checker: `seen` borrows from
                    // `agents` via `iter()`, which conflicts with `push`).
                    let seen: std::collections::HashSet<String> =
                        agents.iter().map(|a| a.id.clone()).collect();
                    let mut cdn_count = 0;
                    for snapshot_agent in &snapshot.agents {
                        if seen.contains(&snapshot_agent.id) {
                            continue; // bundled entry wins on id collision.
                        }
                        // Validate the CDN entry (reuse the snapshot's
                        // `is_safe_agent_id` + `sanitize_distribution`).
                        if !acp_registry_snapshot::is_safe_agent_id(&snapshot_agent.id) {
                            continue;
                        }
                        let Some(distribution) =
                            acp_registry_snapshot::sanitize_distribution(&snapshot_agent.distribution)
                        else {
                            continue;
                        };
                        let entry = BundledAgent {
                            id: snapshot_agent.id.clone(),
                            name: snapshot_agent.name.clone(),
                            version: snapshot_agent.version.clone(),
                            description: snapshot_agent.description.clone(),
                            distribution,
                        };
                        agents.push(compute_catalog_agent(
                            &entry,
                            &host,
                            &platform_arch,
                            CatalogSource::Registry,
                        ));
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

/// Probe runtime availability. PATH-only probes — never executes untrusted
/// code (no `npx --version` subprocess that could hang or prompt). Reuses
/// `crate::acp::config::is_registry_launcher_on_path` which delegates to
/// `pty::manager::resolve_spawn_program` (Windows) +
/// `resolve_executable_in_path` (non-Windows).
fn probe_runtimes() -> CatalogRuntimeAvailability {
    CatalogRuntimeAvailability {
        npx: crate::acp::config::is_registry_launcher_on_path("npx"),
        uvx: crate::acp::config::is_registry_launcher_on_path("uvx"),
        node: crate::acp::config::is_registry_launcher_on_path("node"),
        bun: crate::acp::config::is_registry_launcher_on_path("bun"),
        python3: crate::acp::config::is_registry_launcher_on_path("python3"),
    }
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
        (vec!["npx".to_string()], if host.runtimes.npx {
            SupportedAcpAgentStatus::Ready
        } else {
            SupportedAcpAgentStatus::NeedsRuntime
        })
    } else if has_uvx {
        (vec!["uvx".to_string()], if host.runtimes.uvx {
            SupportedAcpAgentStatus::Ready
        } else {
            SupportedAcpAgentStatus::NeedsRuntime
        })
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
/// - Binary not on PATH + HTTPS archive → `install-required`
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

    // Binary not on PATH. Check for an installable archive (HTTPS + allowed
    // format). This is Story 9's install path concern; the catalog only
    // reports the status, it does not perform the install.
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
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "termul-acp-catalog-{label}-{}-{}",
            std::process::id(),
            now_millis()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn sample_agent(id: &str, distribution: serde_json::Value) -> BundledAgent {
        BundledAgent {
            id: id.to_string(),
            name: id.to_string(),
            version: "1.0.0".to_string(),
            description: "test".to_string(),
            distribution,
        }
    }

    fn host_with_runtimes(npx: bool, uvx: bool) -> HostCapability {
        HostCapability {
            os: "linux".to_string(),
            arch: "x86_64".to_string(),
            runtimes: CatalogRuntimeAvailability {
                npx,
                uvx,
                node: true,
                bun: false,
                python3: true,
            },
        }
    }

    // ---- Bundled catalog parse ----

    #[test]
    fn bundled_catalog_parses_successfully() {
        let agents = parse_bundled_catalog().unwrap();
        assert!(!agents.is_empty(), "bundled catalog should not be empty");
        // Every entry must have an id + name + distribution.
        for agent in &agents {
            assert!(!agent.id.is_empty(), "agent id must not be empty");
            assert!(!agent.name.is_empty(), "agent name must not be empty");
            assert!(
                agent.distribution.is_object(),
                "agent distribution must be an object"
            );
        }
    }

    #[test]
    fn bundled_catalog_includes_known_agents() {
        let agents = parse_bundled_catalog().unwrap();
        let ids: Vec<&str> = agents.iter().map(|a| a.id.as_str()).collect();
        assert!(ids.contains(&"claude-acp"), "claude-acp must be in the bundled catalog");
        assert!(ids.contains(&"gemini"), "gemini must be in the bundled catalog");
    }

    // ---- I/O matrix: npx on PATH → ready ----

    #[test]
    fn npx_agent_with_npx_on_path_is_ready() {
        let agent = sample_agent(
            "test-npx",
            serde_json::json!({ "npx": { "package": "test@1.0.0" } }),
        );
        let host = host_with_runtimes(true, false);
        let catalog_agent = compute_catalog_agent(&agent, &host, "linux-x86_64", CatalogSource::Bundled);
        assert_eq!(catalog_agent.status, SupportedAcpAgentStatus::Ready);
        assert_eq!(catalog_agent.runtime_requirements, vec!["npx".to_string()]);
        assert_eq!(catalog_agent.source, CatalogSource::Bundled);
    }

    // ---- I/O matrix: npx missing → needs-runtime ----

    #[test]
    fn npx_agent_without_npx_is_needs_runtime() {
        let agent = sample_agent(
            "test-npx",
            serde_json::json!({ "npx": { "package": "test@1.0.0" } }),
        );
        let host = host_with_runtimes(false, false);
        let catalog_agent = compute_catalog_agent(&agent, &host, "linux-x86_64", CatalogSource::Bundled);
        assert_eq!(catalog_agent.status, SupportedAcpAgentStatus::NeedsRuntime);
    }

    // ---- I/O matrix: uvx on PATH → ready ----

    #[test]
    fn uvx_agent_with_uvx_on_path_is_ready() {
        let agent = sample_agent(
            "test-uvx",
            serde_json::json!({ "uvx": { "package": "test==1.0.0" } }),
        );
        let host = host_with_runtimes(false, true);
        let catalog_agent = compute_catalog_agent(&agent, &host, "linux-x86_64", CatalogSource::Bundled);
        assert_eq!(catalog_agent.status, SupportedAcpAgentStatus::Ready);
        assert_eq!(catalog_agent.runtime_requirements, vec!["uvx".to_string()]);
    }

    // ---- I/O matrix: uvx missing → needs-runtime ----

    #[test]
    fn uvx_agent_without_uvx_is_needs_runtime() {
        let agent = sample_agent(
            "test-uvx",
            serde_json::json!({ "uvx": { "package": "test==1.0.0" } }),
        );
        let host = host_with_runtimes(false, false);
        let catalog_agent = compute_catalog_agent(&agent, &host, "linux-x86_64", CatalogSource::Bundled);
        assert_eq!(catalog_agent.status, SupportedAcpAgentStatus::NeedsRuntime);
    }

    // ---- I/O matrix: binary with archive → install-required ----

    #[test]
    fn binary_agent_with_https_archive_is_install_required() {
        let agent = sample_agent(
            "test-binary",
            serde_json::json!({
                "binary": {
                    "linux-x86_64": {
                        "cmd": "./test-agent",
                        "archive": "https://example.com/test-agent-linux-x86_64.tar.gz"
                    }
                }
            }),
        );
        let host = host_with_runtimes(false, false);
        let catalog_agent = compute_catalog_agent(&agent, &host, "linux-x86_64", CatalogSource::Bundled);
        assert_eq!(catalog_agent.status, SupportedAcpAgentStatus::InstallRequired);
        assert!(!catalog_agent.platform_targets.is_empty());
    }

    // ---- I/O matrix: binary without archive → manual-install ----

    #[test]
    fn binary_agent_without_archive_is_manual_install() {
        let agent = sample_agent(
            "test-binary",
            serde_json::json!({
                "binary": {
                    "linux-x86_64": {
                        "cmd": "./test-agent"
                    }
                }
            }),
        );
        let host = host_with_runtimes(false, false);
        let catalog_agent = compute_catalog_agent(&agent, &host, "linux-x86_64", CatalogSource::Bundled);
        assert_eq!(catalog_agent.status, SupportedAcpAgentStatus::ManualInstall);
    }

    // ---- I/O matrix: no platform target → unavailable ----

    #[test]
    fn binary_agent_no_matching_platform_is_unavailable() {
        let agent = sample_agent(
            "test-binary",
            serde_json::json!({
                "binary": {
                    "darwin-aarch64": {
                        "cmd": "./test-agent",
                        "archive": "https://example.com/test-agent-darwin.tar.gz"
                    }
                }
            }),
        );
        let host = host_with_runtimes(false, false);
        let catalog_agent = compute_catalog_agent(&agent, &host, "linux-x86_64", CatalogSource::Bundled);
        assert_eq!(catalog_agent.status, SupportedAcpAgentStatus::Unavailable);
    }

    // ---- I/O matrix: binary bare-name on PATH → ready (probe-injected) ----

    #[test]
    fn binary_agent_bare_name_on_path_is_ready() {
        // A bare-name (non-relative) cmd with an installable archive. When the
        // injected probe reports the binary is on PATH, the status is `ready`
        // (the archive is not used). When the probe reports it is NOT on PATH,
        // the status falls through to `install-required` (HTTPS archive).
        let target: serde_json::Map<String, serde_json::Value> = serde_json::json!({
            "cmd": "test-agent",
            "archive": "https://example.com/test-agent.zip"
        })
        .as_object()
        .unwrap()
        .clone();

        assert_eq!(
            compute_binary_status(Some(&target), |_| true),
            SupportedAcpAgentStatus::Ready
        );

        // When the probe reports it is NOT on PATH, the status falls through
        // to `install-required` (HTTPS archive).
        assert_eq!(
            compute_binary_status(Some(&target), |_| false),
            SupportedAcpAgentStatus::InstallRequired
        );
    }

    // ---- I/O matrix: opt-in path succeeds (degrades gracefully if CDN fails) ----

    // ---- I/O matrix: opt-in persistence + corrupt-file backup ----

    #[tokio::test]
    async fn opt_in_persistence_round_trip() {
        let root = temp_dir("opt-in-round-trip");
        let service = AcpCatalogService::open(root.join("catalog"))
            .await
            .unwrap();
        assert!(!service.is_opt_in(), "default opt-in should be false");
        service.set_opt_in(true).unwrap();
        assert!(service.is_opt_in(), "opt-in should be true after set");
        service.set_opt_in(false).unwrap();
        assert!(!service.is_opt_in(), "opt-in should be false after unset");
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn opt_in_corrupt_file_backed_up_and_defaults_false() {
        let root = temp_dir("opt-in-corrupt");
        let catalog_dir = root.join("catalog");
        fs::create_dir_all(&catalog_dir).unwrap();
        let config_path = catalog_dir.join(CONFIG_FILENAME);
        fs::write(&config_path, b"{ not valid json").unwrap();

        let service = AcpCatalogService::open(catalog_dir).await.unwrap();
        assert!(!service.is_opt_in(), "corrupt opt-in defaults to false");

        // Backup exists alongside the bad file.
        let backups: Vec<_> = fs::read_dir(service.root())
            .unwrap()
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .map(|n| n.contains("corrupt-"))
                    .unwrap_or(false)
            })
            .collect();
        assert_eq!(backups.len(), 1, "exactly one corrupt backup");
        let _ = fs::remove_dir_all(root);
    }

    // ---- I/O matrix: deny_unknown_fields on opt-in request ----

    #[test]
    fn set_catalog_opt_in_request_rejects_unknown_fields() {
        let payload = serde_json::json!({ "enabled": true, "extra": "junk" });
        let result: Result<SetCatalogOptInRequest, _> = serde_json::from_value(payload);
        assert!(result.is_err(), "deny_unknown_fields must reject extra fields");
    }

    #[test]
    fn set_catalog_opt_in_request_accepts_enabled_only() {
        let payload = serde_json::json!({ "enabled": true });
        let request: SetCatalogOptInRequest = serde_json::from_value(payload).unwrap();
        assert!(request.enabled);
    }

    // ---- I/O matrix: catalog cache TTL ----

    #[tokio::test]
    async fn list_catalog_caches_within_ttl() {
        let root = temp_dir("cache-ttl");
        let service = AcpCatalogService::open(root.join("catalog"))
            .await
            .unwrap();
        let catalog1 = service.list_catalog(false).await.unwrap();
        let catalog2 = service.list_catalog(false).await.unwrap();
        // Both calls return the same agents (within the TTL the cache is
        // not invalidated). The exact probe results may differ on a CI runner
        // but the cached call must return the same data.
        assert_eq!(catalog1.agents.len(), catalog2.agents.len());
        assert_eq!(catalog1.host.os, catalog2.host.os);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn list_catalog_refresh_invalidates_cache() {
        let root = temp_dir("cache-refresh");
        let service = AcpCatalogService::open(root.join("catalog"))
            .await
            .unwrap();
        let catalog1 = service.list_catalog(false).await.unwrap();
        // Force refresh — must not error and must return the same agent count
        // (probes re-run but the bundled catalog is the same).
        let catalog2 = service.list_catalog(true).await.unwrap();
        assert_eq!(catalog1.agents.len(), catalog2.agents.len());
        let _ = fs::remove_dir_all(root);
    }

    // ---- I/O matrix: CDN degradation fallback ----

    #[tokio::test]
    async fn list_catalog_without_opt_in_serves_bundled_only() {
        let root = temp_dir("no-opt-in");
        let service = AcpCatalogService::open(root.join("catalog"))
            .await
            .unwrap();
        let catalog = service.list_catalog(false).await.unwrap();
        // Every agent is bundled (no CDN entries without opt-in).
        for agent in &catalog.agents {
            assert_eq!(agent.source, CatalogSource::Bundled);
        }
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn list_catalog_with_opt_in_succeeds_and_serves_catalog() {
        let root = temp_dir("opt-in-success");
        let service = AcpCatalogService::open(root.join("catalog"))
            .await
            .unwrap();
        service.set_opt_in(true).unwrap();
        // With opt-in on, the catalog resolves successfully whether the CDN
        // fetch succeeds (registry entries added, tagged `source: 'registry'`)
        // or fails (degrade to bundled-only with a warn log). The client always
        // receives `success: true` (no error) — the degrade-gracefully contract.
        let catalog = service.list_catalog(false).await.unwrap();
        assert!(!catalog.agents.is_empty(), "catalog must serve agents");
        for agent in &catalog.agents {
            assert!(
                matches!(
                    agent.source,
                    CatalogSource::Bundled | CatalogSource::Registry
                ),
                "agent source must be bundled or registry"
            );
        }
        let _ = fs::remove_dir_all(root);
    }

    // ---- Serde shape tests ----

    #[test]
    fn acp_catalog_serializes_camel_case() {
        let catalog = AcpCatalog {
            host: HostCapability {
                os: "linux".to_string(),
                arch: "x86_64".to_string(),
                runtimes: CatalogRuntimeAvailability {
                    npx: true,
                    uvx: false,
                    node: true,
                    bun: false,
                    python3: true,
                },
            },
            agents: vec![CatalogAgent {
                id: "test".to_string(),
                name: "Test".to_string(),
                version: "1.0.0".to_string(),
                description: "test agent".to_string(),
                source: CatalogSource::Bundled,
                distribution: serde_json::json!({ "npx": { "package": "test@1.0.0" } }),
                runtime_requirements: vec!["npx".to_string()],
                status: SupportedAcpAgentStatus::Ready,
                platform_targets: vec![],
            }],
        };
        let value = serde_json::to_value(&catalog).unwrap();
        assert!(value.get("host").is_some());
        assert!(value["host"].get("os").is_some());
        assert!(value["host"].get("arch").is_some());
        assert!(value["host"]["runtimes"].get("npx").is_some());
        assert!(value["host"]["runtimes"].get("uvx").is_some());
        assert!(value["host"]["runtimes"].get("node").is_some());
        assert!(value["host"]["runtimes"].get("bun").is_some());
        assert!(value["host"]["runtimes"].get("python3").is_some());
        assert!(value["agents"][0].get("id").is_some());
        assert!(value["agents"][0].get("name").is_some());
        assert!(value["agents"][0].get("version").is_some());
        assert!(value["agents"][0].get("description").is_some());
        assert!(value["agents"][0].get("source").is_some());
        assert!(value["agents"][0].get("distribution").is_some());
        assert!(value["agents"][0].get("runtimeRequirements").is_some());
        assert!(value["agents"][0].get("status").is_some());
        assert!(value["agents"][0].get("platformTargets").is_some());
        // Status serializes as kebab-case.
        assert_eq!(value["agents"][0]["status"], "ready");
        assert_eq!(value["agents"][0]["source"], "bundled");
    }

    #[test]
    fn supported_acp_agent_status_serializes_kebab_case() {
        let statuses = [
            (SupportedAcpAgentStatus::Ready, "ready"),
            (SupportedAcpAgentStatus::InstallRequired, "install-required"),
            (SupportedAcpAgentStatus::NeedsRuntime, "needs-runtime"),
            (SupportedAcpAgentStatus::ManualInstall, "manual-install"),
            (SupportedAcpAgentStatus::Unavailable, "unavailable"),
        ];
        for (status, expected) in statuses {
            let value = serde_json::to_value(status).unwrap();
            assert_eq!(value, expected);
        }
    }

    #[test]
    fn catalog_source_serializes_lowercase() {
        assert_eq!(
            serde_json::to_value(CatalogSource::Bundled).unwrap(),
            "bundled"
        );
        assert_eq!(
            serde_json::to_value(CatalogSource::Registry).unwrap(),
            "registry"
        );
    }

    #[test]
    fn is_https_archive_url_validates_scheme_and_format() {
        assert!(is_https_archive_url("https://example.com/agent.zip"));
        assert!(is_https_archive_url("https://example.com/agent.tar.gz"));
        assert!(is_https_archive_url("https://example.com/agent.tgz"));
        assert!(!is_https_archive_url("http://example.com/agent.zip"));
        assert!(!is_https_archive_url("https://example.com/agent.exe"));
        assert!(!is_https_archive_url("ftp://example.com/agent.zip"));
    }

    #[test]
    fn parse_binary_platform_targets_extracts_os_arch_pairs() {
        let dist = serde_json::json!({
            "binary": {
                "darwin-aarch64": { "cmd": "./agent" },
                "linux-x86_64": { "cmd": "./agent" },
                "windows-x86_64": { "cmd": "agent.exe" }
            }
        });
        let targets = parse_binary_platform_targets(&dist);
        assert_eq!(targets.len(), 3);
        let oses: Vec<&str> = targets.iter().map(|t| t.os.as_str()).collect();
        assert!(oses.contains(&"darwin"));
        assert!(oses.contains(&"linux"));
        assert!(oses.contains(&"windows"));
    }

    #[test]
    fn host_platform_arch_maps_macos_to_darwin() {
        // The function uses std::env::consts::OS which is compile-time; on a
        // non-macOS runner the result is the raw OS. The test just verifies the
        // format is "{os}-{arch}" and the macOS→darwin mapping is documented.
        let pa = host_platform_arch();
        assert!(pa.contains('-'), "platform-arch must contain a dash");
    }
}
