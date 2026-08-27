//! Host-owned atomic ACP install service (CAP-6 / Story 9).
//!
//! Builds the host-owned install flow on top of the catalog (Story 8's
//! `AcpCatalogService`): downloads the catalog-resolved HTTPS archive,
//! extracts safely, atomically activates, serializes per-agent, records an
//! installed-agents manifest, and exposes `install_agent(agentId)` across all
//! three transports (Tauri `acp_install_agent`, HTTP `POST /acp/install`, WS
//! `install_acp_agent`).
//!
//! # Integrity source
//!
//! The catalog is the trusted Zed ACP registry, so the install service does
//! NOT verify a `sha256` digest: it downloads + extracts + activates without
//! integrity verification. A `sha256` field, if present in the catalog's
//! `binary.{os-arch}` target, is recorded in the manifest as a best-effort
//! audit value (not validated, not used to gate the install). The catalog's
//! `compute_binary_status` reports any HTTPS archive as `install-required`
//! (clickable) regardless of a digest.
//!
//! # Per-agent serialization
//!
//! An `Arc<TokioMutex<()>>` map keyed by `agent_id` (mirrors
//! `WorkspaceManifestService::project_lock`), held under a parking_lot
//! `Mutex`, evicted on successful uninstall, so concurrent installs of the
//! *same* agent serialize while *different* agents install in parallel.
//!
//! # Atomic activation
//!
//! Download + verify + extract into a temp staging dir under the install root;
//! `backup old (rename to .old) → rename(staging, root) → drop backup` with
//! restore-on-failure (the existing `install_registry_binary` swap pattern). A
//! tampered/failed install leaves the previous installation (if any) intact.
//!
//! # Installed-agents manifest
//!
//! A schema-versioned envelope `{ schema_version, agents: HashMap<agent_id,
//! InstalledAgent> }` at `<install_root>/installed.json`, written via
//! `atomic_file::replace`, corrupt-file backup via
//! `atomic_file::backup_corrupt` then treated as empty. Updated **after**
//! successful activation. The manifest IS the audit record (no separate audit
//! log concept exists).
//!
//! # Testability
//!
//! `Downloader` + `Extractor` traits injected into `install` mirror Story 8's
//! `compute_binary_status(target, probe)` probe-injection, so the I/O matrix
//! rows (sha256-mismatch / quota / traversal / download-failure) are
//! unit-testable without network.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
#[cfg(test)]
use sha2::{Digest, Sha256};
use tokio::sync::Mutex as TokioMutex;

use crate::acp::archive::{
    extract_archive, mark_executable, mark_spawnables_in_tree, normalize_cmd_path,
    resolve_cmd_in_root, MAX_ARCHIVE_BYTES,
};
use crate::acp::atomic_file;
use crate::acp::catalog::{CatalogAgent, HostCapability, SupportedAcpAgentStatus};
use crate::acp::AcpCatalogService;
use crate::acp_registry_snapshot::is_safe_agent_id;

// ---------------------------------------------------------------------------
// Wire types (camelCase serde, byte-identical to the TS shapes)
// ---------------------------------------------------------------------------

/// `POST /acp/install` + WS `install_acp_agent` + Tauri `acp_install_agent`
/// request body. `deny_unknown_fields` rejects an over-serialized payload
/// loudly at the host boundary — maps to `VALIDATION_ERROR`. The request
/// carries ONLY `{ agentId }`; the host resolves everything (archive URL, cmd,
/// args, env, sha256) from the trusted catalog — never accepts browser-supplied
/// URLs, commands, executable paths, or args.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallRequest {
    pub agent_id: String,
}

/// The install outcome (the existing contract the renderer wraps into
/// `AgentConfig` via `installedBinaryConfig`). `command` is the absolute path
/// to the resolved executable under the install root; `args` is the catalog
/// target's `args` (or empty).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    pub command: String,
    pub args: Vec<String>,
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

/// Install failure. Carries a stable SCREAMING_SNAKE_CASE `code` string
/// byte-identical across all three transports (Tauri `IpcResult.code`, HTTP
/// `IpcBody.code`, WS `WsReply.err.code`). The WS path uses
/// `WsReply::err_with_code` (a raw-string constructor) so the install-specific
/// codes are not collapsed into the protocol-level `WsErrorCode` enum.
#[derive(Debug, Clone)]
pub struct InstallError {
    pub code: &'static str,
    pub message: String,
}

impl InstallError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// The stable SCREAMING_SNAKE_CASE machine code.
    #[must_use]
    pub fn code(&self) -> &'static str {
        self.code
    }
}

impl std::fmt::Display for InstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for InstallError {}

// Stable error codes (mirrors the spec's I/O & Edge-Case Matrix). The
// `InstallError` constructors use these; the degrade-mode handlers
// (`commands.rs` + `install_api.rs` + `ws.rs`) ALSO reference these constants
// (not literal strings) so a rename in this mod cannot silently drift from
// the wire bytes.
#[allow(dead_code)]
pub(crate) mod code {
    pub const INTEGRITY_MISMATCH: &str = "INTEGRITY_MISMATCH";
    pub const INTEGRITY_METADATA_MISSING: &str = "INTEGRITY_METADATA_MISSING";
    pub const UNSUPPORTED_PLATFORM: &str = "UNSUPPORTED_PLATFORM";
    pub const ARCHIVE_TOO_LARGE: &str = "ARCHIVE_TOO_LARGE";
    pub const EXTRACTION_QUOTA_EXCEEDED: &str = "EXTRACTION_QUOTA_EXCEEDED";
    pub const PATH_TRAVERSAL_DETECTED: &str = "PATH_TRAVERSAL_DETECTED";
    pub const DOWNLOAD_FAILED: &str = "DOWNLOAD_FAILED";
    pub const CATALOG_AGENT_NOT_FOUND: &str = "CATALOG_AGENT_NOT_FOUND";
    pub const NOT_INSTALLABLE: &str = "NOT_INSTALLABLE";
    pub const ACP_INSTALL_UNAVAILABLE: &str = "ACP_INSTALL_UNAVAILABLE";
    pub const VALIDATION_ERROR: &str = "VALIDATION_ERROR";
    pub const INSTALL_FAILED: &str = "INSTALL_FAILED";
}

// ---------------------------------------------------------------------------
// Downloader / Extractor traits (injected for testability)
// ---------------------------------------------------------------------------

/// Downloaded archive descriptor. The production downloader streams the body
/// to a temp file under `target_dir` (never holding the full archive in RAM
/// — the 256 MiB cap bounds memory to the streaming buffer); tests inject a
/// canned-bytes impl that writes the bytes to a temp file.
pub struct DownloadedArchive {
    /// The temp file holding the downloaded archive bytes.
    pub path: PathBuf,
    /// The archive filename (last path segment of the URL, query stripped),
    /// used to dispatch `.zip` vs `.tar.gz`/`.tgz` extraction.
    pub filename: String,
    /// Downloaded byte count (for logging).
    pub size: u64,
}

/// Async download seam. The production impl streams the HTTPS archive to a
/// temp file with an incremental size cap (never holding the full archive in
/// RAM — a 256 MiB × N parallel installs OOM hazard); tests inject a
/// canned-bytes impl to drive the sha256-mismatch / archive-too-large /
/// download-failure matrix rows without network.
#[async_trait::async_trait]
pub trait Downloader: Send + Sync {
    /// Download the archive into `target_dir` (a private staging dir the
    /// caller manages + cleans up). Enforce `MAX_ARCHIVE_BYTES`
    /// incrementally. The returned `path` lives under `target_dir`.
    async fn download(
        &self,
        url: &str,
        target_dir: &Path,
    ) -> Result<DownloadedArchive, InstallError>;
}

/// Async extract seam. The production impl calls `archive::extract_archive`
/// with the traversal/quota protections; tests inject a failing impl to drive
/// the path-traversal / quota matrix rows without touching the filesystem.
#[async_trait::async_trait]
pub trait Extractor: Send + Sync {
    /// Extract `archive_path` into `dest`. Enforce path-traversal rejection +
    /// `MAX_EXTRACTED_BYTES` / `MAX_EXTRACTED_FILES` quotas.
    async fn extract(&self, archive_path: &Path, dest: &Path) -> Result<(), InstallError>;
}

/// Production downloader: streams the HTTPS archive to a temp file under
/// `target_dir` with an incremental size cap (never holds the full archive in
/// RAM — the legacy `stage_archive` pattern). Used by the default `install`
/// path.
struct HttpDownloader;

#[async_trait::async_trait]
impl Downloader for HttpDownloader {
    async fn download(
        &self,
        url: &str,
        target_dir: &Path,
    ) -> Result<DownloadedArchive, InstallError> {
        use futures_util::StreamExt;
        use std::io::Write;
        use std::time::Duration;

        if !url.starts_with("https://") {
            return Err(InstallError::new(
                code::DOWNLOAD_FAILED,
                "archive URL must be https",
            ));
        }
        // Redirects: follow HTTPS→HTTPS redirects (GitHub releases 302 to
        // `objects.githubusercontent.com`, still HTTPS — a no-redirect policy
        // breaks every CDN-fronted archive), but REFUSE an https→http
        // downgrade (would download over plaintext, leaking the URL
        // path/query). The custom policy follows only https redirect
        // targets; an http target stops → the 3xx surfaces below as
        // "redirected — refused".
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(crate::acp::archive::FETCH_TIMEOUT_SECS))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                let is_https = attempt.url().scheme() == "https";
                if is_https {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .build()
            .map_err(|e| InstallError::new(code::DOWNLOAD_FAILED, format!("http client: {e}")))?;
        let response = client
            .get(url)
            .send()
            .await
            .map_err(|e| InstallError::new(code::DOWNLOAD_FAILED, format!("download failed: {e}")))?;
        if response.status().is_redirection() {
            // An https→http downgrade was refused by the redirect policy
            // (it stopped following). Surface it as a download failure.
            return Err(InstallError::new(
                code::DOWNLOAD_FAILED,
                format!("download redirected (HTTP {}) — refused", response.status()),
            ));
        }
        if !response.status().is_success() {
            return Err(InstallError::new(
                code::DOWNLOAD_FAILED,
                format!("download returned HTTP {}", response.status()),
            ));
        }

        // Derive the archive filename from the URL, stripping the query
        // string + fragment so `https://x/y.zip?id=1` → `y.zip` (not
        // `y.zip?id=1`, which would break extension dispatch).
        let path_part = url.split(['?', '#']).next().unwrap_or(url);
        let filename = path_part
            .rsplit('/')
            .next()
            .filter(|s| !s.is_empty())
            .unwrap_or("archive.bin")
            .to_string();
        let archive_path = target_dir.join(&filename);
        let mut file = std::fs::File::create(&archive_path)
            .map_err(|e| InstallError::new(code::DOWNLOAD_FAILED, format!("create temp: {e}")))?;
        let mut downloaded: u64 = 0;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk
                .map_err(|e| InstallError::new(code::DOWNLOAD_FAILED, format!("stream: {e}")))?;
            downloaded += chunk.len() as u64;
            if downloaded > MAX_ARCHIVE_BYTES {
                return Err(InstallError::new(
                    code::ARCHIVE_TOO_LARGE,
                    "archive exceeds download cap",
                ));
            }
            file.write_all(&chunk)
                .map_err(|e| InstallError::new(code::DOWNLOAD_FAILED, format!("write: {e}")))?;
        }
        file.flush()
            .map_err(|e| InstallError::new(code::DOWNLOAD_FAILED, format!("flush: {e}")))?;
        Ok(DownloadedArchive {
            path: archive_path,
            filename,
            size: downloaded,
        })
    }
}

/// Production extractor: delegates to `archive::extract_archive`.
struct ArchiveExtractor;

#[async_trait::async_trait]
impl Extractor for ArchiveExtractor {
    async fn extract(&self, archive_path: &Path, dest: &Path) -> Result<(), InstallError> {
        tokio::task::spawn_blocking({
            let archive_path = archive_path.to_path_buf();
            let dest = dest.to_path_buf();
            move || extract_archive(&archive_path, &dest)
        })
        .await
        .map_err(|e| InstallError::new(code::INSTALL_FAILED, format!("extract task: {e}")))?
        .map_err(|e| {
            // Map the archive helpers' coarse strings to install codes.
            if e.contains("too many files") || e.contains("size limit") {
                InstallError::new(code::EXTRACTION_QUOTA_EXCEEDED, e)
            } else if e.contains("unsafe path") || e.contains("escapes") || e.contains("invalid cmd")
            {
                InstallError::new(code::PATH_TRAVERSAL_DETECTED, e)
            } else {
                InstallError::new(code::INSTALL_FAILED, e)
            }
        })
    }
}

// ---------------------------------------------------------------------------
// Installed-agents manifest
// ---------------------------------------------------------------------------

/// Current on-disk installed-agents manifest schema version.
const INSTALLED_MANIFEST_SCHEMA_VERSION: u32 = 1;
const INSTALLED_MANIFEST_FILENAME: &str = "installed.json";

/// One installed-agent record. The manifest IS the audit record (no separate
/// audit log concept exists).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledAgent {
    pub agent_id: String,
    pub version: String,
    /// The `{os}-{arch}` platform target key this install resolved.
    pub platform_target: String,
    /// The verified sha256 hex digest of the downloaded archive.
    pub sha256: String,
    /// The absolute resolved executable path under the install root.
    pub command: String,
    /// The catalog target's args (or empty).
    pub args: Vec<String>,
    /// Epoch-millis install timestamp.
    pub installed_at: u64,
}

/// Schema-versioned envelope for `installed.json`. Mirrors the
/// `WorkspaceManifestFile` pattern so future migrations route through a
/// `migrate` hook. A corrupt file is backed up via `backup_corrupt` then
/// treated as empty (fresh install proceeds).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstalledManifestFile {
    pub schema_version: u32,
    pub agents: HashMap<String, InstalledAgent>,
}

impl Default for InstalledManifestFile {
    fn default() -> Self {
        Self {
            schema_version: INSTALLED_MANIFEST_SCHEMA_VERSION,
            agents: HashMap::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// Per-agent lock map (mirrors WorkspaceManifestService::ProjectLockMap)
// ---------------------------------------------------------------------------

type AgentLockMap = HashMap<String, Arc<TokioMutex<()>>>;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/// Host-owned verified-atomic ACP install service. One instance per host
/// runtime (desktop OR standalone `termul-server`, never shared across
/// processes). Constructed via [`AcpInstallService::open`], which creates the
/// root directory + idempotent re-open (mirrors `WorkspaceManifestService::open`
/// + `AcpCatalogService::open`).
///
/// The service holds an `Arc<AcpCatalogService>` for the convenience
/// `install_by_id` path only; the catalog-agnostic `install(agent, host)`
/// method takes a `&CatalogAgent` + `&HostCapability` + injected
/// `Downloader`/`Extractor` so the I/O matrix rows are unit-testable without a
/// real catalog service.
pub struct AcpInstallService {
    root: PathBuf,
    catalog: Arc<AcpCatalogService>,
    /// Per-`agent_id` write mutex. Grows on first install; evicted on
    /// successful uninstall. Bounded by the number of distinct agents.
    locks: Mutex<AgentLockMap>,
    /// In-memory cache of the on-disk manifest. Held under a `Mutex` (not
    /// `RwLock`) because every install both reads + writes; the per-agent
    /// `TokioMutex` serializes the long install, this only guards the manifest
    /// read/update which is sub-ms.
    manifest: Mutex<InstalledManifestFile>,
}

impl AcpInstallService {
    /// Open (or re-open) an install root. Creates the directory if missing;
    /// idempotent re-open returns a fresh `Arc<Self>` over the same root.
    /// Mirrors `WorkspaceManifestService::open` + `AcpCatalogService::open`:
    /// Unix `0700` root, create the dir, load the manifest with corrupt-backup,
    /// return an `Arc<Self>`. A non-directory root is an error.
    pub async fn open(root: PathBuf, catalog: Arc<AcpCatalogService>) -> io::Result<Arc<Self>> {
        if root.exists() && !root.is_dir() {
            return Err(io::Error::other(format!(
                "acp-install root '{}' is not a directory",
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
        let manifest = Self::load_manifest_blocking(&root.join(INSTALLED_MANIFEST_FILENAME))
            .unwrap_or_else(|error| {
                log::warn!(
                    "[acp-install] manifest load failed (defaulting to empty): {error}"
                );
                InstalledManifestFile::default()
            });
        log::info!("[acp-install] service ready root={}", root.display());
        Ok(Arc::new(Self {
            root,
            catalog,
            locks: Mutex::new(HashMap::new()),
            manifest: Mutex::new(manifest),
        }))
    }

    /// The install root directory.
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Per-`agent_id` lock — get-or-insert (mirrors `project_lock`). The lock
    /// entry persists until `uninstall` evicts it; an invalid agent_id never
    /// reaches here (the caller validates first).
    fn agent_lock(self: &Arc<Self>, agent_id: &str) -> Arc<TokioMutex<()>> {
        let mut locks = self.locks.lock();
        if let Some(lock) = locks.get(agent_id) {
            return Arc::clone(lock);
        }
        let lock = Arc::new(TokioMutex::new(()));
        locks.insert(agent_id.to_string(), Arc::clone(&lock));
        lock
    }

    /// Load the on-disk manifest (blocking). A missing file = empty (fresh
    /// start). A corrupt file is backed up via `backup_corrupt` then treated as
    /// empty. A wrong schema version is backed up + empty.
    fn load_manifest_blocking(path: &Path) -> io::Result<InstalledManifestFile> {
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(InstalledManifestFile::default());
            }
            Err(error) => return Err(error),
        };
        match serde_json::from_slice::<InstalledManifestFile>(&bytes) {
            Ok(file) if file.schema_version == INSTALLED_MANIFEST_SCHEMA_VERSION => Ok(file),
            Ok(file) => {
                log::warn!(
                    "[acp-install] manifest bad schema_version expected={} found={} — backing up + fresh start",
                    INSTALLED_MANIFEST_SCHEMA_VERSION,
                    file.schema_version
                );
                let _ = atomic_file::backup_corrupt(path, &bytes);
                Ok(InstalledManifestFile::default())
            }
            Err(error) => {
                log::warn!(
                    "[acp-install] manifest corrupt error={error} — backing up + fresh start"
                );
                let _ = atomic_file::backup_corrupt(path, &bytes);
                Ok(InstalledManifestFile::default())
            }
        }
    }

    /// Persist the manifest atomically (mirrors `WorkspaceManifestService::write`'s
    /// `spawn_blocking` + `atomic_file::replace`).
    fn persist_manifest_blocking(
        root: &Path,
        manifest: &InstalledManifestFile,
    ) -> io::Result<()> {
        let path = root.join(INSTALLED_MANIFEST_FILENAME);
        let serialized = serde_json::to_vec_pretty(manifest).map_err(io::Error::other)?;
        atomic_file::replace(&path, &serialized)
    }

    /// `install_by_id(agent_id)` — resolve the agent via the catalog, then
    /// delegate to the catalog-agnostic `install`. The convenience path for
    /// the three transports; the handler could also resolve the catalog entry
    /// itself and call `install` directly.
    pub async fn install_by_id(
        self: &Arc<Self>,
        agent_id: &str,
    ) -> Result<InstallOutcome, InstallError> {
        if !is_safe_agent_id(agent_id) {
            return Err(InstallError::new(
                code::VALIDATION_ERROR,
                "invalid agent id",
            ));
        }
        let catalog = self.catalog.list_catalog(false).await.map_err(|error| {
            InstallError::new(code::INSTALL_FAILED, format!("catalog resolve failed: {error}"))
        })?;
        let agent = catalog
            .agents
            .iter()
            .find(|a| a.id == agent_id)
            .ok_or_else(|| {
                InstallError::new(code::CATALOG_AGENT_NOT_FOUND, format!("agent '{agent_id}' not in catalog"))
            })?;
        self.install(agent, &catalog.host, None, None).await
    }

    /// Catalog-agnostic install. Takes a resolved `&CatalogAgent` + the host
    /// capability + OPTIONAL injected `Downloader`/`Extractor` (production
    /// uses `HttpDownloader`/`ArchiveExtractor` when `None`; tests inject
    /// canned-bytes/failing impls to drive the I/O matrix without network).
    ///
    /// This is the core of the install flow:
    /// 1. Validate the catalog status is `install-required`.
    /// 2. Resolve the host's `binary.{os-arch}` target.
    /// 3. Best-effort read the catalog-declared `sha256` (audit only — NOT
    ///    verified; the catalog is trusted).
    /// 4. Acquire the per-`agent_id` mutex (serialize same-agent installs).
    /// 5. Download → extract into staging → atomic swap.
    /// 6. Update the manifest.
    pub async fn install(
        self: &Arc<Self>,
        agent: &CatalogAgent,
        host: &HostCapability,
        downloader: Option<Arc<dyn Downloader>>,
        extractor: Option<Arc<dyn Extractor>>,
    ) -> Result<InstallOutcome, InstallError> {
        // 0. Defense-in-depth: validate the agent_id even though the catalog
        // already validated it. `install()` is catalog-agnostic (takes a
        // `&CatalogAgent`) and a synthetic/dotted id could escape the install
        // root via `root.join(&agent.id)`. Mirrors `install_by_id`'s gate.
        if !is_safe_agent_id(&agent.id) {
            return Err(InstallError::new(
                code::VALIDATION_ERROR,
                "invalid agent id",
            ));
        }
        // 1. Status gate.
        if agent.status != SupportedAcpAgentStatus::InstallRequired {
            return Err(InstallError::new(
                code::NOT_INSTALLABLE,
                format!(
                    "agent '{}' status is {:?} (not install-required)",
                    agent.id, agent.status
                ),
            ));
        }

        // 2. Resolve the host's binary target.
        let platform_arch = host_platform_arch(host);
        let target = agent
            .distribution
            .get("binary")
            .and_then(|b| b.as_object())
            .and_then(|b| b.get(&platform_arch))
            .and_then(|t| t.as_object())
            .ok_or_else(|| {
                InstallError::new(
                    code::UNSUPPORTED_PLATFORM,
                    format!("no binary target for {platform_arch}"),
                )
            })?;

        let cmd = target
            .get("cmd")
            .and_then(|c| c.as_str())
            .ok_or_else(|| {
                InstallError::new(code::INSTALL_FAILED, "catalog binary target missing 'cmd'")
            })?;
        let archive_url = target
            .get("archive")
            .and_then(|a| a.as_str())
            .ok_or_else(|| {
                InstallError::new(code::UNSUPPORTED_PLATFORM, "catalog binary target missing 'archive'")
            })?;
        // No sha256 verification: the catalog is the trusted Zed ACP registry,
        // so the host downloads + extracts + activates without integrity
        // verification. Keep a best-effort read of the catalog-declared digest
        // for the manifest audit field (may be empty/absent — not validated,
        // not used to gate the install).
        let sha256_hex = target
            .get("sha256")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string();
        let args: Vec<String> = target
            .get("args")
            .and_then(|a| a.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();

        // 4. Per-agent serialization.
        let lock = self.agent_lock(&agent.id);
        let _guard = lock.lock().await;

        let agent_id_log = sanitize_agent_id_log(&agent.id);
        let archive_host = archive_host_for_log(archive_url);
        log::info!(
            "[acp-install] {} install start agent={} target={} archive_host={}",
            crate::logging::run_id(),
            agent_id_log,
            platform_arch,
            archive_host
        );
        let started = Instant::now();

        // 5. Download → verify → extract → swap.
        let downloader = downloader.unwrap_or_else(|| Arc::new(HttpDownloader));
        let extractor = extractor.unwrap_or_else(|| Arc::new(ArchiveExtractor));

        // Staging dir under the install root. Owns BOTH the downloaded
        // archive temp file AND the extracted tree — a single
        // `remove_dir_all` cleans up on any failure path.
        let tmp_dir = self
            .root
            .join(format!(".staging-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp_dir).map_err(|e| {
            InstallError::new(code::INSTALL_FAILED, format!("create staging: {e}"))
        })?;
        let staging = tmp_dir.join("stage");
        std::fs::create_dir_all(&staging).map_err(|e| {
            let _ = std::fs::remove_dir_all(&tmp_dir);
            InstallError::new(code::INSTALL_FAILED, format!("create staging stage: {e}"))
        })?;

        // Download streams the archive body to a temp file under `tmp_dir`
        // (never held in RAM — the 256 MiB cap bounds memory to the streaming
        // buffer). The archive temp file lives inside `tmp_dir` so a failure
        // path's `remove_dir_all(&tmp_dir)` reclaims it too.
        let downloaded = match downloader.download(archive_url, &tmp_dir).await {
            Ok(d) => d,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&tmp_dir);
                log::error!(
                    "[acp-install] {} install failure agent={} code={} msg={}",
                    crate::logging::run_id(),
                    agent_id_log,
                    e.code,
                    e.message
                );
                return Err(e);
            }
        };
        let bytes_len = downloaded.size;
        let archive_path = downloaded.path;

        if let Err(e) = extractor.extract(&archive_path, &staging).await {
            let _ = std::fs::remove_dir_all(&tmp_dir);
            log::error!(
                "[acp-install] {} extract failure agent={} code={} msg={}",
                crate::logging::run_id(),
                agent_id_log,
                e.code,
                e.message
            );
            return Err(e);
        }

        // Validate the cmd resolves to a regular file inside staging.
        if let Err(e) = resolve_cmd_in_root(&staging, cmd) {
            let _ = std::fs::remove_dir_all(&tmp_dir);
            log::error!(
                "[acp-install] {} cmd resolution failure agent={} msg={}",
                crate::logging::run_id(),
                agent_id_log,
                e
            );
            return Err(InstallError::new(code::PATH_TRAVERSAL_DETECTED, e));
        }
        // Mark spawnables (zip extracts often land as 0644).
        mark_spawnables_in_tree(&staging);
        let staged_program = staging.join(normalize_cmd_path(cmd));
        mark_executable(&staged_program);

        // Atomic-ish swap: backup old → rename(staging, root) → drop backup.
        // Use `with_file_name(format!("{id}.old"))` (NOT `with_extension`) so a
        // dotted agent_id like `com.foo.agent` survives (with_extension would
        // mangle it to `com.foo.old`, colliding/destroying unrelated paths
        // and breaking restore-on-failure).
        let install_root_for_agent = self.root.join(&agent.id);
        let backup = install_root_for_agent.with_file_name(format!("{}.old", agent.id));
        let _ = std::fs::remove_dir_all(&backup);
        if install_root_for_agent.exists() {
            if let Err(e) = std::fs::rename(&install_root_for_agent, &backup) {
                let _ = std::fs::remove_dir_all(&tmp_dir);
                return Err(InstallError::new(
                    code::INSTALL_FAILED,
                    format!("backup old install: {e}"),
                ));
            }
        }
        if let Err(e) = std::fs::rename(&staging, &install_root_for_agent) {
            // Restore the previous install on swap failure.
            if backup.exists() {
                let _ = std::fs::rename(&backup, &install_root_for_agent);
            }
            let _ = std::fs::remove_dir_all(&tmp_dir);
            return Err(InstallError::new(
                code::INSTALL_FAILED,
                format!("promote install: {e}"),
            ));
        }
        let _ = std::fs::remove_dir_all(&backup);
        let _ = std::fs::remove_dir_all(&tmp_dir);

        // Recompute the program path under the final root (plain, non-canonical).
        let program = install_root_for_agent.join(normalize_cmd_path(cmd));

        // 6. Update the manifest. Clone the updated state under the guard,
        // then drop the guard before `spawn_blocking` so the `parking_lot`
        // MutexGuard (which is `!Send`) is not held across the `.await`.
        let installed_at = now_millis();
        let record = InstalledAgent {
            agent_id: agent.id.clone(),
            version: agent.version.clone(),
            platform_target: platform_arch,
            sha256: sha256_hex.clone(),
            command: program.to_string_lossy().to_string(),
            args: args.clone(),
            installed_at,
        };
        let manifest_clone = {
            let mut manifest = self.manifest.lock();
            manifest.agents.insert(agent.id.clone(), record.clone());
            manifest.clone()
        };
        let root = self.root.clone();
        // `spawn_blocking` returns `io::Result<()>` from the inner closure, so
        // the outer `.await` is `Result<io::Result<()>, JoinError>` — handle
        // BOTH layers. A manifest persist failure leaves a stale audit record
        // (the binary is activated but the manifest does not reflect it), so
        // surface it as an `INSTALL_FAILED` error rather than silently
        // discarding it (the previous `if let Err(e)` only caught the
        // `JoinError`, dropping the inner `io::Result` on the floor).
        match tokio::task::spawn_blocking(move || {
            Self::persist_manifest_blocking(&root, &manifest_clone)
        })
        .await
        {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                log::error!(
                    "[acp-install] {} manifest persist failed (stale audit record): {e}",
                    crate::logging::run_id()
                );
                return Err(InstallError::new(
                    code::INSTALL_FAILED,
                    format!("manifest persist failed: {e}"),
                ));
            }
            Err(e) => {
                log::error!(
                    "[acp-install] {} manifest persist task failed: {e}",
                    crate::logging::run_id()
                );
                return Err(InstallError::new(
                    code::INSTALL_FAILED,
                    format!("manifest persist task failed: {e}"),
                ));
            }
        }

        let elapsed = started.elapsed();
        log::info!(
            "[acp-install] {} install success agent={} bytes={} duration_ms={}",
            crate::logging::run_id(),
            agent_id_log,
            bytes_len,
            elapsed.as_millis()
        );

        Ok(InstallOutcome {
            command: program.to_string_lossy().to_string(),
            args,
        })
    }

    /// Remove an installed agent: delete the install dir + remove the manifest
    /// entry. Idempotent (no error if not installed).
    ///
    /// The per-agent lock-map entry is NOT evicted — a concurrent caller that
    /// called `agent_lock` between guard-acquire and eviction would hold a
    /// clone of the OLD `Arc<TokioMutex>`, while a new caller arriving after
    /// eviction gets a FRESH `Arc`, so two same-agent operations would run in
    /// parallel (breaking the serialization invariant). The map is naturally
    /// bounded by the number of distinct catalog agents (small); letting the
    /// entry linger is the safe choice (mirrors the conservative path).
    pub async fn uninstall(self: &Arc<Self>, agent_id: &str) -> Result<(), InstallError> {
        if !is_safe_agent_id(agent_id) {
            return Err(InstallError::new(code::VALIDATION_ERROR, "invalid agent id"));
        }
        let lock = self.agent_lock(agent_id);
        let _guard = lock.lock().await;

        let install_dir = self.root.join(agent_id);
        let _ = std::fs::remove_dir_all(&install_dir);
        // `with_file_name(format!("{id}.old"))` (NOT `with_extension`) so a
        // dotted agent_id survives — mirrors `install`'s backup path.
        let backup = install_dir.with_file_name(format!("{}.old", agent_id));
        let _ = std::fs::remove_dir_all(&backup);

        // Clone the updated manifest + drop the guard before spawn_blocking
        // (parking_lot MutexGuard is `!Send`).
        let (manifest_clone, removed) = {
            let mut manifest = self.manifest.lock();
            let removed = manifest.agents.remove(agent_id).is_some();
            (manifest.clone(), removed)
        };
        if removed {
            let root = self.root.clone();
            let _ = tokio::task::spawn_blocking(move || {
                Self::persist_manifest_blocking(&root, &manifest_clone)
            })
            .await;
        }
        // NOTE: the per-agent lock-map entry is intentionally NOT evicted
        // (see the doc comment above).
        log::info!(
            "[acp-install] {} uninstall agent={}",
            crate::logging::run_id(),
            sanitize_agent_id_log(agent_id)
        );
        Ok(())
    }

    /// Read-only snapshot of the installed-agents manifest (for the catalog's
    /// deferred "ready for already-installed agents" refresh — story 9 only
    /// writes the manifest; the catalog-status refresh is a deferred parity
    /// item).
    pub fn installed_agents(&self) -> Vec<InstalledAgent> {
        self.manifest
            .lock()
            .agents
            .values()
            .cloned()
            .collect()
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// The platform-arch key for the catalog's binary map lookup. Mirrors
/// `catalog::host_platform_arch` but takes the host capability (testable with
/// synthetic input) instead of `std::env::consts::OS`.
fn host_platform_arch(host: &HostCapability) -> String {
    let os = if host.os == "macos" { "darwin" } else { &host.os };
    format!("{}-{}", os, host.arch)
}

/// Epoch-millis timestamp (mirrors `workspace_manifest::now_millis`).
fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Hex-encode a byte slice (lowercase). Avoids pulling a `hex` crate dep.
/// Test-only: used by `tiny_zip` to compute a reference sha256 (the install
/// service no longer verifies digests, so `sha256_file` + this helper are
/// test-only after the integrity-check removal).
#[cfg(test)]
fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// Sanitize an agent_id for logging (it's already safe per `is_safe_agent_id`,
/// but this is a single chokepoint).
fn sanitize_agent_id_log(id: &str) -> &str {
    id
}

/// Extract the archive URL's host for logging — never the full URL with
/// path/query (may carry tokens in some registries), never env/args. The
/// `http://` branch is intentionally absent: the `HttpDownloader` rejects
/// non-https URLs with `DOWNLOAD_FAILED`, so a plaintext URL never reaches
/// logging.
fn archive_host_for_log(url: &str) -> &str {
    // `https://host/path...` → `host`.
    url.strip_prefix("https://")
        .unwrap_or(url)
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
}


// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::catalog::{CatalogSource, HostCapability, PlatformTarget};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "termul-acp-install-{label}-{}-{}",
            std::process::id(),
            now_millis()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn host() -> HostCapability {
        HostCapability {
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            runtimes: crate::acp::catalog::CatalogRuntimeAvailability {
                npx: false,
                uvx: false,
                node: false,
                bun: false,
                python3: false,
            },
        }
    }

    fn platform_arch_for(host: &HostCapability) -> String {
        host_platform_arch(host)
    }

    fn sample_binary_agent(
        id: &str,
        platform_arch: &str,
        sha256: Option<&str>,
        cmd: &str,
        archive: &str,
    ) -> CatalogAgent {
        let mut target = serde_json::json!({
            "cmd": cmd,
            "archive": archive,
            "args": ["acp"],
        });
        if let Some(hex) = sha256 {
            target["sha256"] = serde_json::json!(hex);
        }
        CatalogAgent {
            id: id.to_string(),
            name: id.to_string(),
            version: "1.0.0".to_string(),
            description: "test".to_string(),
            source: CatalogSource::Bundled,
            distribution: serde_json::json!({
                "binary": { platform_arch: target }
            }),
            runtime_requirements: Vec::new(),
            status: SupportedAcpAgentStatus::InstallRequired,
            platform_targets: vec![PlatformTarget {
                os: host().os,
                arch: host().arch,
            }],
            installed: None,
        }
    }

    /// Build a tiny valid zip archive in memory (a single `acp` text file) so
    /// the production extractor can extract it. Returns the bytes + the
    /// expected sha256 hex.
    fn tiny_zip(payload: &str) -> (Vec<u8>, String) {
        use std::io::Write;
        let tmp = std::env::temp_dir()
            .join(format!("termul-acp-install-zip-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let payload_path = tmp.join("acp");
        let mut f = std::fs::File::create(&payload_path).unwrap();
        f.write_all(payload.as_bytes()).unwrap();
        drop(f);

        let zip_path = tmp.join("archive.zip");
        {
            let file = std::fs::File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let opts = zip::write::SimpleFileOptions::default();
            zip.start_file("acp", opts).unwrap();
            let mut f = std::fs::File::open(&payload_path).unwrap();
            std::io::copy(&mut f, &mut zip).unwrap();
            zip.finish().unwrap();
        }
        let bytes = std::fs::read(&zip_path).unwrap();
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let hex = hex_encode(&hasher.finalize());
        let _ = std::fs::remove_dir_all(&tmp);
        (bytes, hex)
    }

    async fn open_service(root: PathBuf) -> Arc<AcpInstallService> {
        let catalog = crate::acp::AcpCatalogService::open(root.join("catalog"))
            .await
            .unwrap();
        AcpInstallService::open(root.join("installs"), catalog)
            .await
            .unwrap()
    }

    /// A downloader that writes canned bytes to a temp file under `target_dir`
    /// (the production extractor will extract them). Used for happy-path +
    /// sha256-mismatch.
    struct CannedDownloader {
        bytes: Vec<u8>,
        filename: String,
        fail: bool,
    }

    #[async_trait::async_trait]
    impl Downloader for CannedDownloader {
        async fn download(
            &self,
            _url: &str,
            target_dir: &Path,
        ) -> Result<DownloadedArchive, InstallError> {
            if self.fail {
                return Err(InstallError::new(code::DOWNLOAD_FAILED, "canned download failure"));
            }
            use std::io::Write;
            let path = target_dir.join(&self.filename);
            let mut f = std::fs::File::create(&path)
                .map_err(|e| InstallError::new(code::INSTALL_FAILED, format!("canned create: {e}")))?;
            f.write_all(&self.bytes)
                .map_err(|e| InstallError::new(code::INSTALL_FAILED, format!("canned write: {e}")))?;
            Ok(DownloadedArchive {
                path,
                filename: self.filename.clone(),
                size: self.bytes.len() as u64,
            })
        }
    }

    /// A downloader that exceeds the size cap.
    struct TooLargeDownloader;
    #[async_trait::async_trait]
    impl Downloader for TooLargeDownloader {
        async fn download(
            &self,
            _url: &str,
            _target_dir: &Path,
        ) -> Result<DownloadedArchive, InstallError> {
            Err(InstallError::new(
                code::ARCHIVE_TOO_LARGE,
                "canned too-large",
            ))
        }
    }

    /// An extractor that always fails with a traversal-style message.
    struct FailingExtractor { message: String }
    #[async_trait::async_trait]
    impl Extractor for FailingExtractor {
        async fn extract(&self, _archive_path: &Path, _dest: &Path) -> Result<(), InstallError> {
            Err(InstallError::new(
                code::PATH_TRAVERSAL_DETECTED,
                self.message.clone(),
            ))
        }
    }

    // ---- Happy-path install ----

    #[tokio::test]
    async fn happy_path_install_activates() {
        let root = temp_dir("happy");
        let service = open_service(root.clone()).await;
        let (bytes, sha) = tiny_zip("acp payload");
        let pa = platform_arch_for(&host());
        let agent = sample_binary_agent(
            "test-agent",
            &pa,
            Some(&sha),
            "./acp",
            "https://example.com/test.zip",
        );
        let downloader: Arc<dyn Downloader> = Arc::new(CannedDownloader {
            bytes: bytes.clone(),
            filename: "archive.zip".to_string(),
            fail: false,
        });
        let outcome = service
            .install(&agent, &host(), Some(downloader), None)
            .await
            .expect("happy path install");
        assert!(outcome.command.contains("test-agent"));
        assert_eq!(outcome.args, vec!["acp".to_string()]);
        // Manifest has the entry.
        let installed = service.installed_agents();
        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].agent_id, "test-agent");
        assert_eq!(installed[0].sha256, sha);
        // On-disk manifest persisted.
        let manifest_path = service.root().join(INSTALLED_MANIFEST_FILENAME);
        let on_disk: InstalledManifestFile =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        assert_eq!(on_disk.agents.len(), 1);
        let _ = std::fs::remove_dir_all(root);
    }

    // ---- sha256 mismatch (tampered) ----

    #[tokio::test]
    async fn install_proceeds_without_integrity_check() {
        // No sha256 verification: a mismatched declared digest does NOT abort
        // the install. The catalog is trusted (Zed ACP registry); the host
        // downloads + extracts + activates regardless of the declared digest.
        let root = temp_dir("no-verify");
        let service = open_service(root.clone()).await;
        let (bytes, _sha) = tiny_zip("real payload");
        let host = host();
        let pa = platform_arch_for(&host);
        let tampered_sha = "deadbeef".repeat(8);
        let agent = sample_binary_agent(
            "tampered",
            &pa,
            Some(tampered_sha.as_str()),
            "./acp",
            "https://example.com/tampered.zip",
        );
        let downloader: Arc<dyn Downloader> = Arc::new(CannedDownloader {
            bytes: bytes.clone(),
            filename: "archive.zip".to_string(),
            fail: false,
        });
        let extractor_calls = Arc::new(AtomicUsize::new(0));
        let counting_extractor: Arc<dyn Extractor> =
            Arc::new(CountingExtractor::new(extractor_calls.clone()));
        let outcome = service
            .install(&agent, &host, Some(downloader), Some(counting_extractor))
            .await
            .expect("install proceeds without integrity check");
        assert!(outcome.command.contains("acp"));
        // Extraction MUST have run — no abort-before-extraction.
        assert!(extractor_calls.load(Ordering::SeqCst) >= 1);
        let _ = std::fs::remove_dir_all(root);
    }

    /// Wraps ArchiveExtractor to count calls (for the mismatch assertion).
    struct CountingExtractor {
        calls: Arc<AtomicUsize>,
        inner: ArchiveExtractor,
    }
    impl CountingExtractor {
        fn new(calls: Arc<AtomicUsize>) -> Self {
            Self {
                calls,
                inner: ArchiveExtractor,
            }
        }
    }
    #[async_trait::async_trait]
    impl Extractor for CountingExtractor {
        async fn extract(&self, archive_path: &Path, dest: &Path) -> Result<(), InstallError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.inner.extract(archive_path, dest).await
        }
    }

    // ---- sha256 absent (proceeds — no verification) ----

    #[tokio::test]
    async fn sha256_absent_proceeds_without_verification() {
        // No sha256 gate: an agent whose catalog target has NO `sha256` still
        // installs — the host does not verify integrity.
        let root = temp_dir("no-sha");
        let service = open_service(root.clone()).await;
        let (bytes, _sha) = tiny_zip("acp payload");
        let pa = platform_arch_for(&host());
        let agent = sample_binary_agent(
            "no-sha",
            &pa,
            None,
            "./acp",
            "https://example.com/no-sha.zip",
        );
        let downloader: Arc<dyn Downloader> = Arc::new(CannedDownloader {
            bytes: bytes.clone(),
            filename: "archive.zip".to_string(),
            fail: false,
        });
        let outcome = service
            .install(&agent, &host(), Some(downloader), None)
            .await
            .expect("install proceeds without sha256");
        assert!(outcome.command.contains("acp"));
        let _ = std::fs::remove_dir_all(root);
    }

    // ---- sha256 empty / malformed (proceeds — not validated) ----

    #[tokio::test]
    async fn sha256_empty_string_proceeds() {
        // An empty-string `sha256` is not validated — the install proceeds.
        let root = temp_dir("empty-sha");
        let service = open_service(root.clone()).await;
        let (bytes, _sha) = tiny_zip("acp payload");
        let pa = platform_arch_for(&host());
        let agent = sample_binary_agent(
            "empty-sha",
            &pa,
            Some(""),
            "./acp",
            "https://example.com/empty-sha.zip",
        );
        let downloader: Arc<dyn Downloader> = Arc::new(CannedDownloader {
            bytes: bytes.clone(),
            filename: "archive.zip".to_string(),
            fail: false,
        });
        let outcome = service
            .install(&agent, &host(), Some(downloader), None)
            .await
            .expect("install proceeds with empty sha256");
        assert!(outcome.command.contains("acp"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn sha256_malformed_proceeds() {
        // A malformed `sha256` is not validated — the install proceeds.
        let root = temp_dir("bad-sha");
        let service = open_service(root.clone()).await;
        let (bytes, _sha) = tiny_zip("acp payload");
        let pa = platform_arch_for(&host());
        let agent = sample_binary_agent(
            "bad-sha",
            &pa,
            Some("not-a-real-digest"),
            "./acp",
            "https://example.com/bad-sha.zip",
        );
        let downloader: Arc<dyn Downloader> = Arc::new(CannedDownloader {
            bytes: bytes.clone(),
            filename: "archive.zip".to_string(),
            fail: false,
        });
        let outcome = service
            .install(&agent, &host(), Some(downloader), None)
            .await
            .expect("install proceeds with malformed sha256");
        assert!(outcome.command.contains("acp"));
        let _ = std::fs::remove_dir_all(root);
    }

    // ---- unsupported platform ----

    #[tokio::test]
    async fn unsupported_platform_rejects_before_download() {
        let root = temp_dir("no-platform");
        let service = open_service(root.clone()).await;
        // Agent with a binary target for a DIFFERENT platform.
        let agent = sample_binary_agent(
            "no-platform",
            "darwin-aarch64",
            Some("abc"),
            "./acp",
            "https://example.com/no-platform.zip",
        );
        // Use the test host (linux/windows-x86_64) so the lookup misses.
        let err = service
            .install(&agent, &host(), None, None)
            .await
            .expect_err("no-platform must error");
        assert_eq!(err.code(), code::UNSUPPORTED_PLATFORM);
        let _ = std::fs::remove_dir_all(root);
    }

    // ---- not installable ----

    #[tokio::test]
    async fn not_installable_rejects_non_install_required_status() {
        let root = temp_dir("not-installable");
        let service = open_service(root.clone()).await;
        let pa = platform_arch_for(&host());
        let mut agent = sample_binary_agent(
            "ready-agent",
            &pa,
            Some("abc"),
            "./acp",
            "https://example.com/ready.zip",
        );
        agent.status = SupportedAcpAgentStatus::Ready;
        let err = service
            .install(&agent, &host(), None, None)
            .await
            .expect_err("ready must error");
        assert_eq!(err.code(), code::NOT_INSTALLABLE);
        let _ = std::fs::remove_dir_all(root);
    }

    // ---- archive too large ----

    #[tokio::test]
    async fn archive_too_large_aborts_download() {
        let root = temp_dir("too-large");
        let service = open_service(root.clone()).await;
        let pa = platform_arch_for(&host());
        // No integrity check — the download is attempted regardless of the
        // `sha256` field. The TooLargeDownloader then trips ARCHIVE_TOO_LARGE.
        let agent = sample_binary_agent(
            "big",
            &pa,
            None,
            "./acp",
            "https://example.com/big.zip",
        );
        let downloader: Arc<dyn Downloader> = Arc::new(TooLargeDownloader);
        let err = service
            .install(&agent, &host(), Some(downloader), None)
            .await
            .expect_err("too-large must error");
        assert_eq!(err.code(), code::ARCHIVE_TOO_LARGE);
        let _ = std::fs::remove_dir_all(root);
    }

    // ---- extraction quota / path traversal ----

    #[tokio::test]
    async fn extraction_failure_propagates_code() {
        let root = temp_dir("extract-fail");
        let service = open_service(root.clone()).await;
        let (bytes, sha) = tiny_zip("payload");
        let pa = platform_arch_for(&host());
        let agent = sample_binary_agent(
            "traversal",
            &pa,
            Some(&sha),
            "./acp",
            "https://example.com/traversal.zip",
        );
        let downloader: Arc<dyn Downloader> = Arc::new(CannedDownloader {
            bytes,
            filename: "archive.zip".to_string(),
            fail: false,
        });
        let extractor: Arc<dyn Extractor> = Arc::new(FailingExtractor {
            message: "unsafe path detected".to_string(),
        });
        let err = service
            .install(&agent, &host(), Some(downloader), Some(extractor))
            .await
            .expect_err("extract failure must error");
        assert_eq!(err.code(), code::PATH_TRAVERSAL_DETECTED);
        let _ = std::fs::remove_dir_all(root);
    }

    // ---- real-archive traversal + quota (Category D) ----
    //
    // The existing `extraction_failure_propagates_code` mocks the extractor
    // returning a string. These tests feed REAL hostile zip/tar archives
    // (crafted with the `zip`/`tar`/`flate2` crates already in Cargo.toml)
    // through the production `ArchiveExtractor` — proving the traversal/quota
    // guards fire on real archive contents, not just mocked error returns.

    /// Craft a zip containing a single `../evil` traversal entry. The `zip`
    /// crate accepts the raw name on WRITE (`start_file`); the production
    /// `extract_zip` guard rejects it on READ via `enclosed_name()` (returns
    /// `None` → the entry is skipped, so no file is written outside the
    /// extraction dir). Returns the archive bytes + their sha256 hex.
    fn slip_zip() -> (Vec<u8>, String) {
        use std::io::Write;
        let tmp = std::env::temp_dir()
            .join(format!("termul-acp-install-slip-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let zip_path = tmp.join("evil.zip");
        {
            let file = std::fs::File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let opts = zip::write::SimpleFileOptions::default();
            zip.start_file("../evil", opts)
                .expect("zip start_file accepts a traversal name on write");
            zip.write_all(b"pwned").unwrap();
            zip.finish().unwrap();
        }
        let bytes = std::fs::read(&zip_path).unwrap();
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let hex = hex_encode(&hasher.finalize());
        let _ = std::fs::remove_dir_all(&tmp);
        (bytes, hex)
    }

    /// Craft a tar.gz containing a single `../../evil` traversal entry. The
    /// `tar` crate's `Header::set_path` rejects `..` on WRITE, so a hostile
    /// tar (the kind a non-Rust packager or attacker produces — the tar format
    /// stores the name verbatim) must be crafted by writing the raw header
    /// name bytes directly + recomputing the checksum. The production
    /// `extract_tar_gz` guard then rejects it on READ (`entry.path()` returns
    /// the raw `..` components → "tar entry has unsafe path"). Returns the
    /// archive bytes + their sha256 hex.
    fn slip_tar_gz() -> (Vec<u8>, String) {
        use std::io::Write;
        let tmp = std::env::temp_dir()
            .join(format!("termul-acp-install-tarslip-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let tar_gz_path = tmp.join("evil.tar.gz");
        {
            let file = std::fs::File::create(&tar_gz_path).unwrap();
            let gz = flate2::write::GzEncoder::new(file, flate2::Compression::default());
            let mut tar = tar::Builder::new(gz);
            // Build a regular-file header with a benign name (sets size/mode/
            // magic), then overwrite the name field with the traversal path +
            // set the typeflag + recompute the checksum. `Builder::append` takes
            // `&Header` (immutable) so it cannot re-validate or re-set the path —
            // the raw bytes are written verbatim.
            let mut header = tar::Header::new_gnu();
            header.set_path("evil").unwrap();
            header.set_size(5);
            header.set_mode(0o644);
            let name = b"../../evil";
            let bytes = header.as_mut_bytes();
            bytes[..name.len()].copy_from_slice(name);
            for slot in &mut bytes[name.len()..100] {
                *slot = 0;
            }
            bytes[156] = b'0'; // typeflag = regular file
            header.set_cksum();
            tar.append(&header, &b"pwned"[..]).unwrap();
            tar.finish().unwrap();
            let gz = tar.into_inner().unwrap();
            let mut file = gz.finish().unwrap();
            file.flush().unwrap();
        }
        let bytes = std::fs::read(&tar_gz_path).unwrap();
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let hex = hex_encode(&hasher.finalize());
        let _ = std::fs::remove_dir_all(&tmp);
        (bytes, hex)
    }

    /// Craft a zip with `n` single-byte file entries (used to exceed
    /// `MAX_EXTRACTED_FILES`). Each entry is a flat, traversal-safe name so
    /// the production `extract_zip` file counter (not `enclosed_name`) is what
    /// trips. Returns the archive bytes + their sha256 hex.
    fn overfull_zip(n: usize) -> (Vec<u8>, String) {
        use std::io::Write;
        let tmp = std::env::temp_dir()
            .join(format!("termul-acp-install-overfull-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let zip_path = tmp.join("overfull.zip");
        {
            let file = std::fs::File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let opts = zip::write::SimpleFileOptions::default();
            for i in 0..n {
                zip.start_file(format!("f{i}"), opts)
                    .expect("start_file for overfull entry");
                zip.write_all(b"x").unwrap();
            }
            zip.finish().unwrap();
        }
        let bytes = std::fs::read(&zip_path).unwrap();
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let hex = hex_encode(&hasher.finalize());
        let _ = std::fs::remove_dir_all(&tmp);
        (bytes, hex)
    }

    #[tokio::test]
    async fn real_zip_slip_entry_rejected_before_extraction() {
        let root = temp_dir("zip-slip");
        let (bytes, sha) = slip_zip();
        let pa = platform_arch_for(&host());

        // Phase 1: the REAL `ArchiveExtractor` (not the `FailingExtractor`
        // mock) on the hostile zip in isolation. `enclosed_name()` skips the
        // `../evil` entry → extraction Ok, dest left empty, and NO file
        // escapes the dest dir (the slip target `dest/../evil` = `root/evil`
        // does not exist). Proves the production `enclosed_name` guard fires
        // on a real hostile archive.
        {
            let dest = root.join("direct");
            std::fs::create_dir_all(&dest).unwrap();
            let archive_path = root.join("evil.zip");
            std::fs::write(&archive_path, &bytes).unwrap();
            let extractor = ArchiveExtractor;
            let result = extractor.extract(&archive_path, &dest).await;
            assert!(
                result.is_ok(),
                "enclosed_name skips the slip entry (Ok, no write): {:?}",
                result.err()
            );
            assert!(!root.join("evil").exists(), "no file escaped the dest dir");
            assert!(
                std::fs::read_dir(&dest).unwrap().next().is_none(),
                "dest empty — the slip entry was skipped"
            );
        }

        // Phase 2: the full install flow with `CannedDownloader` + the REAL
        // `ArchiveExtractor`. The catalog `cmd` is the slip path so the
        // production `resolve_cmd_in_root` ALSO fires (the install returns
        // `PATH_TRAVERSAL_DETECTED` from cmd resolution — proving extraction
        // succeeded, i.e. `enclosed_name` skipped the entry, then the cmd
        // guard rejected it). No staging dir lingers + no activation.
        let service = open_service(root.clone()).await;
        let agent = sample_binary_agent(
            "slip-agent",
            &pa,
            Some(&sha),
            "../evil",
            "https://example.com/evil.zip",
        );
        let downloader: Arc<dyn Downloader> = Arc::new(CannedDownloader {
            bytes: bytes.clone(),
            filename: "archive.zip".to_string(),
            fail: false,
        });
        let err = service
            .install(&agent, &host(), Some(downloader), None)
            .await
            .expect_err("zip slip must be rejected before extraction");
        assert_eq!(err.code(), code::PATH_TRAVERSAL_DETECTED);
        assert!(
            err.message.contains("cmd"),
            "rejection must come from resolve_cmd_in_root: {}",
            err.message
        );
        assert!(!service.root().join("evil").exists());
        assert!(
            !service.root().join("slip-agent").exists(),
            "no activation on rejection"
        );
        for entry in std::fs::read_dir(service.root()).unwrap().flatten() {
            let name = entry.file_name();
            assert!(
                !name.to_string_lossy().contains(".staging-"),
                "staging dir must be cleaned up: {}",
                name.to_string_lossy()
            );
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn real_tar_traversal_rejected_before_extraction() {
        let root = temp_dir("tar-slip");
        let (bytes, sha) = slip_tar_gz();
        let pa = platform_arch_for(&host());
        let service = open_service(root.clone()).await;
        // `cmd` is benign here — the production `extract_tar_gz` guard rejects
        // the `../../evil` entry DURING extraction (before cmd resolution), so
        // the install returns `PATH_TRAVERSAL_DETECTED` from the extractor
        // itself (mapped from "tar entry has unsafe path").
        let agent = sample_binary_agent(
            "tar-slip-agent",
            &pa,
            Some(&sha),
            "./acp",
            "https://example.com/evil.tar.gz",
        );
        let downloader: Arc<dyn Downloader> = Arc::new(CannedDownloader {
            bytes,
            filename: "evil.tar.gz".to_string(),
            fail: false,
        });
        let err = service
            .install(&agent, &host(), Some(downloader), None)
            .await
            .expect_err("tar traversal must be rejected before extraction");
        assert_eq!(err.code(), code::PATH_TRAVERSAL_DETECTED);
        assert!(
            err.message.contains("unsafe path"),
            "rejection must come from the tar traversal guard: {}",
            err.message
        );
        assert!(
            !service.root().join("tar-slip-agent").exists(),
            "no activation on rejection"
        );
        for entry in std::fs::read_dir(service.root()).unwrap().flatten() {
            let name = entry.file_name();
            assert!(
                !name.to_string_lossy().contains(".staging-"),
                "staging dir must be cleaned up: {}",
                name.to_string_lossy()
            );
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn extracted_file_count_quota_enforced_on_real_archive() {
        // Craft a zip with one more entry than `MAX_EXTRACTED_FILES`. The
        // production `extract_zip` counter trips on the (N+1)th non-dir entry
        // → `EXTRACTION_QUOTA_EXCEEDED` + the staging dir is cleaned up.
        // NOTE: this writes MAX_EXTRACTED_FILES files to disk during extraction
        // before tripping (the production guard checks AFTER incrementing) —
        // correct per the spec, but the slowest test in the module.
        let n = crate::acp::archive::MAX_EXTRACTED_FILES + 1;
        let (bytes, sha) = overfull_zip(n);
        let root = temp_dir("quota");
        let pa = platform_arch_for(&host());
        let service = open_service(root.clone()).await;
        let agent = sample_binary_agent(
            "quota-agent",
            &pa,
            Some(&sha),
            "./acp",
            "https://example.com/overfull.zip",
        );
        let downloader: Arc<dyn Downloader> = Arc::new(CannedDownloader {
            bytes,
            filename: "archive.zip".to_string(),
            fail: false,
        });
        let err = service
            .install(&agent, &host(), Some(downloader), None)
            .await
            .expect_err("file-count quota must be exceeded");
        assert_eq!(err.code(), code::EXTRACTION_QUOTA_EXCEEDED);
        assert!(
            !service.root().join("quota-agent").exists(),
            "no activation on quota failure"
        );
        for entry in std::fs::read_dir(service.root()).unwrap().flatten() {
            let name = entry.file_name();
            assert!(
                !name.to_string_lossy().contains(".staging-"),
                "staging dir must be cleaned up: {}",
                name.to_string_lossy()
            );
        }
        let _ = std::fs::remove_dir_all(root);
    }

    // ---- download failure ----

    #[tokio::test]
    async fn download_failure_propagates_code() {
        let root = temp_dir("dl-fail");
        let service = open_service(root.clone()).await;
        let pa = platform_arch_for(&host());
        // No integrity check — the download is attempted regardless of the
        // `sha256` field. The failing CannedDownloader then trips
        // DOWNLOAD_FAILED.
        let agent = sample_binary_agent(
            "dl-fail",
            &pa,
            None,
            "./acp",
            "https://example.com/dl-fail.zip",
        );
        let downloader: Arc<dyn Downloader> = Arc::new(CannedDownloader {
            bytes: vec![],
            filename: "archive.zip".to_string(),
            fail: true,
        });
        let err = service
            .install(&agent, &host(), Some(downloader), None)
            .await
            .expect_err("download failure must error");
        assert_eq!(err.code(), code::DOWNLOAD_FAILED);
        let _ = std::fs::remove_dir_all(root);
    }

    // ---- manifest corrupt backup ----

    #[tokio::test]
    async fn manifest_corrupt_file_backed_up_and_treated_as_empty() {
        let root = temp_dir("manifest-corrupt");
        let install_dir = root.join("installs");
        fs::create_dir_all(&install_dir).unwrap();
        let manifest_path = install_dir.join(INSTALLED_MANIFEST_FILENAME);
        fs::write(&manifest_path, b"{ not valid json").unwrap();

        let catalog = crate::acp::AcpCatalogService::open(root.join("catalog"))
            .await
            .unwrap();
        let service = AcpInstallService::open(install_dir, catalog)
            .await
            .unwrap();
        assert!(service.installed_agents().is_empty());

        // Backup exists.
        let backups: Vec<_> = fs::read_dir(service.root())
            .unwrap()
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_str()
                    .map(|n| n.contains("corrupt-"))
                    .unwrap_or(false)
            })
            .collect();
        assert_eq!(backups.len(), 1, "exactly one corrupt backup");
        let _ = std::fs::remove_dir_all(root);
    }

    // ---- concurrent same-agent install serializes ----

    #[tokio::test]
    async fn concurrent_same_agent_install_serializes() {
        let root = temp_dir("concurrent-same");
        let service = open_service(root.clone()).await;
        let (bytes, sha) = tiny_zip("payload");
        let host = host();
        let pa = platform_arch_for(&host);
        let agent = sample_binary_agent(
            "concurrent",
            &pa,
            Some(&sha),
            "./acp",
            "https://example.com/concurrent.zip",
        );

        // Two concurrent installs of the SAME agent. Both share the per-agent
        // mutex; both should succeed (idempotent re-install). The manifest
        // should have exactly one entry.
        let svc = service.clone();
        let agent1 = agent.clone();
        let dl1: Arc<dyn Downloader> = Arc::new(CannedDownloader {
            bytes: bytes.clone(),
            filename: "archive.zip".to_string(),
            fail: false,
        });
        let svc2 = service.clone();
        let agent2 = agent.clone();
        let dl2: Arc<dyn Downloader> = Arc::new(CannedDownloader {
            bytes: bytes.clone(),
            filename: "archive.zip".to_string(),
            fail: false,
        });
        let (r1, r2) = tokio::join!(
            svc.install(&agent1, &host, Some(dl1), None),
            svc2.install(&agent2, &host, Some(dl2), None)
        );
        let o1 = r1.expect("first install ok");
        let o2 = r2.expect("second install ok");
        assert_eq!(o1.command, o2.command, "both return same command");
        assert_eq!(service.installed_agents().len(), 1);
        let _ = std::fs::remove_dir_all(root);
    }

    // ---- concurrent different-agent install runs in parallel ----

    #[tokio::test]
    async fn concurrent_different_agent_install_parallel() {
        let root = temp_dir("concurrent-diff");
        let service = open_service(root.clone()).await;
        let (bytes, sha) = tiny_zip("payload");
        let host = host();
        let pa = platform_arch_for(&host);
        let agent_a = sample_binary_agent(
            "agent-a",
            &pa,
            Some(&sha),
            "./acp",
            "https://example.com/a.zip",
        );
        let agent_b = sample_binary_agent(
            "agent-b",
            &pa,
            Some(&sha),
            "./acp",
            "https://example.com/b.zip",
        );
        let svc = service.clone();
        let dl1: Arc<dyn Downloader> = Arc::new(CannedDownloader {
            bytes: bytes.clone(),
            filename: "archive.zip".to_string(),
            fail: false,
        });
        let svc2 = service.clone();
        let dl2: Arc<dyn Downloader> = Arc::new(CannedDownloader {
            bytes: bytes.clone(),
            filename: "archive.zip".to_string(),
            fail: false,
        });
        let (r1, r2) = tokio::join!(
            svc.install(&agent_a, &host, Some(dl1), None),
            svc2.install(&agent_b, &host, Some(dl2), None)
        );
        r1.expect("a install ok");
        r2.expect("b install ok");
        assert_eq!(service.installed_agents().len(), 2);
        let _ = std::fs::remove_dir_all(root);
    }

    // ---- idempotent re-install ----

    #[tokio::test]
    async fn idempotent_reinstall_overwrites() {
        let root = temp_dir("idempotent");
        let service = open_service(root.clone()).await;
        let (bytes, sha) = tiny_zip("payload");
        let pa = platform_arch_for(&host());
        let agent = sample_binary_agent(
            "idem",
            &pa,
            Some(&sha),
            "./acp",
            "https://example.com/idem.zip",
        );
        let dl: Arc<dyn Downloader> = Arc::new(CannedDownloader {
            bytes: bytes.clone(),
            filename: "archive.zip".to_string(),
            fail: false,
        });
        let o1 = service
            .install(&agent, &host(), Some(dl), None)
            .await
            .expect("first install");
        let dl2: Arc<dyn Downloader> = Arc::new(CannedDownloader {
            bytes: bytes.clone(),
            filename: "archive.zip".to_string(),
            fail: false,
        });
        let o2 = service
            .install(&agent, &host(), Some(dl2), None)
            .await
            .expect("re-install");
        assert_eq!(o1.command, o2.command);
        assert_eq!(service.installed_agents().len(), 1);
        let _ = std::fs::remove_dir_all(root);
    }

    // ---- validation: invalid agent id ----

    #[tokio::test]
    async fn install_by_id_rejects_invalid_agent_id() {
        let root = temp_dir("bad-id");
        let service = open_service(root.clone()).await;
        let err = service.install_by_id("").await.expect_err("empty id errors");
        assert_eq!(err.code(), code::VALIDATION_ERROR);
        let err = service.install_by_id("../escape").await.expect_err("bad id errors");
        assert_eq!(err.code(), code::VALIDATION_ERROR);
        // Bare `.` / `..` denote the current/parent directory and would escape
        // the install root via `root.join(&agent.id)` (CWE-22) — reject.
        let err = service.install_by_id(".").await.expect_err("dot id errors");
        assert_eq!(err.code(), code::VALIDATION_ERROR);
        let err = service.install_by_id("..").await.expect_err("dotdot id errors");
        assert_eq!(err.code(), code::VALIDATION_ERROR);
        let _ = std::fs::remove_dir_all(root);
    }

    // ---- install_by_id: agent not in catalog ----

    #[tokio::test]
    async fn install_by_id_agent_not_in_catalog() {
        let root = temp_dir("not-in-catalog");
        let service = open_service(root.clone()).await;
        let err = service
            .install_by_id("nonexistent-agent")
            .await
            .expect_err("not in catalog errors");
        assert_eq!(err.code(), code::CATALOG_AGENT_NOT_FOUND);
        let _ = std::fs::remove_dir_all(root);
    }

    // ---- uninstall ----

    #[tokio::test]
    async fn uninstall_removes_dir_and_manifest_entry() {
        let root = temp_dir("uninstall");
        let service = open_service(root.clone()).await;
        let (bytes, sha) = tiny_zip("payload");
        let pa = platform_arch_for(&host());
        let agent = sample_binary_agent(
            "to-remove",
            &pa,
            Some(&sha),
            "./acp",
            "https://example.com/to-remove.zip",
        );
        let dl: Arc<dyn Downloader> = Arc::new(CannedDownloader {
            bytes,
            filename: "archive.zip".to_string(),
            fail: false,
        });
        service
            .install(&agent, &host(), Some(dl), None)
            .await
            .expect("install");
        assert_eq!(service.installed_agents().len(), 1);
        service.uninstall("to-remove").await.expect("uninstall");
        assert!(service.installed_agents().is_empty());
        assert!(!service.root().join("to-remove").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    // ---- serde shape tests ----

    #[test]
    fn install_request_rejects_unknown_fields() {
        let payload = serde_json::json!({ "agentId": "opencode", "extra": "junk" });
        let result: Result<InstallRequest, _> = serde_json::from_value(payload);
        assert!(result.is_err(), "deny_unknown_fields must reject extra");
    }

    #[test]
    fn install_request_accepts_agent_id_only() {
        let payload = serde_json::json!({ "agentId": "opencode" });
        let req: InstallRequest = serde_json::from_value(payload).unwrap();
        assert_eq!(req.agent_id, "opencode");
    }

    #[test]
    fn install_outcome_serializes_camel_case() {
        let outcome = InstallOutcome {
            command: "/path/to/opencode".to_string(),
            args: vec!["acp".to_string()],
        };
        let value = serde_json::to_value(&outcome).unwrap();
        assert_eq!(value["command"], "/path/to/opencode");
        assert_eq!(value["args"][0], "acp");
    }

    #[test]
    fn archive_host_for_log_extracts_host_only() {
        assert_eq!(
            archive_host_for_log("https://github.com/anomalyco/opencode/releases/download/v1/opencode.zip"),
            "github.com"
        );
        assert_eq!(archive_host_for_log("https://example.com/path?query=1"), "example.com");
        assert_eq!(archive_host_for_log("not-a-url"), "not-a-url");
    }
}
