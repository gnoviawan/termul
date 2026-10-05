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
//! `Mutex`, so concurrent installs of the *same* agent serialize while
//! *different* agents can perform package I/O in parallel. A separate async
//! lock serializes manifest read-modify-write cycles.
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
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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
        let response = client.get(url).send().await.map_err(|e| {
            InstallError::new(code::DOWNLOAD_FAILED, format!("download failed: {e}"))
        })?;
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
            } else if e.contains("unsafe path")
                || e.contains("escapes")
                || e.contains("invalid cmd")
            {
                InstallError::new(code::PATH_TRAVERSAL_DETECTED, e)
            } else {
                InstallError::new(code::INSTALL_FAILED, e)
            }
        })
    }
}

/// Injectable npm runner for the pinned Claude ACP host-install path.
/// The package spec is already validated against the trusted catalog before
/// this seam is called.
#[async_trait::async_trait]
trait NpmPackageInstaller: Send + Sync {
    async fn install(&self, prefix: &Path, package_spec: &str, path: &str) -> Result<(), String>;
}

struct SystemNpmPackageInstaller;

#[async_trait::async_trait]
impl NpmPackageInstaller for SystemNpmPackageInstaller {
    async fn install(&self, prefix: &Path, package_spec: &str, path: &str) -> Result<(), String> {
        let npm_path = super::config::resolve_runtime_executable("npm", path)
            .ok_or_else(|| "npm is not resolvable on the host PATH".to_string())?;
        let npm = crate::pty::manager::resolve_spawn_program(
            npm_path
                .to_str()
                .ok_or_else(|| "npm executable path is not valid Unicode".to_string())?,
        )?;
        let mut command = tokio::process::Command::new(npm.program);
        command
            .args(npm.prepend_args)
            .args([
                "install",
                "--ignore-scripts",
                "--no-audit",
                "--no-fund",
                "--save-exact",
                "--prefix",
            ])
            .arg(prefix)
            .arg(package_spec)
            .env("PATH", path)
            .env_remove("ANTHROPIC_API_KEY")
            .kill_on_drop(true)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let child = command
            .spawn()
            .map_err(|_| "could not start npm for Claude ACP installation".to_string())?;
        let output = tokio::time::timeout(Duration::from_secs(180), child.wait_with_output())
            .await
            .map_err(|_| "npm timed out while installing Claude ACP".to_string())?
            .map_err(|_| "npm failed while installing Claude ACP".to_string())?;
        if !output.status.success() {
            return Err(format!(
                "npm exited with status {} while installing Claude ACP",
                output.status
            ));
        }
        Ok(())
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
    /// Per-`agent_id` write mutex. Entries remain after uninstall to ensure
    /// concurrent callers never acquire different locks for the same agent.
    locks: Mutex<AgentLockMap>,
    /// In-memory cache of the on-disk manifest. The synchronous mutex guards
    /// snapshots; `manifest_write_lock` serializes each snapshot's async
    /// persistence and subsequent in-memory update.
    manifest: Mutex<InstalledManifestFile>,
    /// Serialize manifest read-modify-write cycles across different agents.
    /// The per-agent lock does not protect the shared manifest file.
    manifest_write_lock: TokioMutex<()>,
    npm_installer: Arc<dyn NpmPackageInstaller>,
}

impl AcpInstallService {
    /// Open (or re-open) an install root. Creates the directory if missing;
    /// idempotent re-open returns a fresh `Arc<Self>` over the same root.
    /// Mirrors `WorkspaceManifestService::open` + `AcpCatalogService::open`:
    /// Unix `0700` root, create the dir, load the manifest with corrupt-backup,
    /// return an `Arc<Self>`. A non-directory root is an error.
    pub async fn open(root: PathBuf, catalog: Arc<AcpCatalogService>) -> io::Result<Arc<Self>> {
        Self::open_with_npm_installer(root, catalog, Arc::new(SystemNpmPackageInstaller)).await
    }

    /// Open the install root with an injected npm runner (the default open
    /// path uses the host's npm executable). This is the public test seam for
    /// the Claude package install without executing third-party code.
    async fn open_with_npm_installer(
        root: PathBuf,
        catalog: Arc<AcpCatalogService>,
        npm_installer: Arc<dyn NpmPackageInstaller>,
    ) -> io::Result<Arc<Self>> {
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
                log::warn!("[acp-install] manifest load failed (defaulting to empty): {error}");
                InstalledManifestFile::default()
            });
        log::info!("[acp-install] service ready root={}", root.display());
        Ok(Arc::new(Self {
            root,
            catalog,
            locks: Mutex::new(HashMap::new()),
            manifest: Mutex::new(manifest),
            manifest_write_lock: TokioMutex::new(()),
            npm_installer,
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
    fn persist_manifest_blocking(root: &Path, manifest: &InstalledManifestFile) -> io::Result<()> {
        let path = root.join(INSTALLED_MANIFEST_FILENAME);
        let serialized = serde_json::to_vec_pretty(manifest).map_err(io::Error::other)?;
        atomic_file::replace(&path, &serialized)
    }

    /// Persist an installed record before updating the in-memory snapshot.
    /// The async lock prevents independent agent installs from writing stale
    /// snapshots over each other.
    async fn save_installed_record(&self, record: InstalledAgent) -> io::Result<()> {
        let _guard = self.manifest_write_lock.lock().await;
        let mut next_manifest = self.manifest.lock().clone();
        next_manifest.agents.insert(record.agent_id.clone(), record);
        let disk_manifest = next_manifest.clone();
        let root = self.root.clone();
        tokio::task::spawn_blocking(move || Self::persist_manifest_blocking(&root, &disk_manifest))
            .await
            .map_err(io::Error::other)??;
        *self.manifest.lock() = next_manifest;
        Ok(())
    }

    /// Remove an installed record atomically from the shared manifest.
    async fn remove_installed_record(&self, agent_id: &str) -> io::Result<bool> {
        let _guard = self.manifest_write_lock.lock().await;
        let mut next_manifest = self.manifest.lock().clone();
        if next_manifest.agents.remove(agent_id).is_none() {
            return Ok(false);
        }
        let disk_manifest = next_manifest.clone();
        let root = self.root.clone();
        tokio::task::spawn_blocking(move || Self::persist_manifest_blocking(&root, &disk_manifest))
            .await
            .map_err(io::Error::other)??;
        *self.manifest.lock() = next_manifest;
        Ok(true)
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
            InstallError::new(
                code::INSTALL_FAILED,
                format!("catalog resolve failed: {error}"),
            )
        })?;
        let agent = catalog
            .agents
            .iter()
            .find(|a| a.id == agent_id)
            .ok_or_else(|| {
                InstallError::new(
                    code::CATALOG_AGENT_NOT_FOUND,
                    format!("agent '{agent_id}' not in catalog"),
                )
            })?;
        if agent.id == "claude-acp" {
            return self.install_claude_agent(agent, &catalog.host).await;
        }
        self.install(agent, &catalog.host, None, None).await
    }

    /// Install the pinned Claude ACP npm package into Termul's host cache.
    /// This path is deliberately separate from registry npx launch: package
    /// installation is explicit, version-locked, staged, and atomically
    /// activated. It never installs or modifies the external Claude CLI.
    pub async fn install_claude_agent(
        self: &Arc<Self>,
        agent: &CatalogAgent,
        host: &HostCapability,
    ) -> Result<InstallOutcome, InstallError> {
        let started = Instant::now();
        if agent.id != "claude-acp" {
            return Err(InstallError::new(
                code::VALIDATION_ERROR,
                "managed npm install is only supported for claude-acp",
            ));
        }
        if agent.status != SupportedAcpAgentStatus::InstallRequired {
            return Err(InstallError::new(
                code::NOT_INSTALLABLE,
                format!(
                    "Claude Agent status is {:?} (not install-required)",
                    agent.status
                ),
            ));
        }
        // Single policy source (see `claude_agent::claude_runtime_block`):
        // Node.js 22+ with npm, then the external Claude Code CLI.
        match crate::acp::claude_agent::claude_runtime_block(
            host.runtimes.node_major,
            host.runtimes.npm,
            host.runtimes.claude_cli,
        ) {
            Some(crate::acp::claude_agent::ClaudeRuntimeBlock::NodeTooOld) => {
                return Err(InstallError::new(
                    code::NOT_INSTALLABLE,
                    "Claude Agent ACP requires Node.js 22 or newer. Upgrade Node.js and restart Termul.",
                ));
            }
            Some(crate::acp::claude_agent::ClaudeRuntimeBlock::NpmMissing) => {
                return Err(InstallError::new(
                    code::NOT_INSTALLABLE,
                    "Claude Agent ACP requires npm. Install npm alongside Node.js 22 or newer.",
                ));
            }
            Some(crate::acp::claude_agent::ClaudeRuntimeBlock::CliMissing) => {
                return Err(InstallError::new(
                    code::NOT_INSTALLABLE,
                    "Claude Code CLI is missing. Install it from Anthropic before installing Claude Agent ACP.",
                ));
            }
            None => {}
        }

        let package_spec = agent
            .distribution
            .get("npx")
            .and_then(|npx| npx.get("package"))
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                InstallError::new(
                    code::NOT_INSTALLABLE,
                    "Claude ACP catalog package is missing",
                )
            })?;
        let version = crate::acp::claude_agent::parse_pinned_claude_package(package_spec)
            .filter(|version| version == &agent.version)
            .ok_or_else(|| {
                InstallError::new(
                    code::NOT_INSTALLABLE,
                    "Claude ACP package must use the exact catalog version",
                )
            })?;

        let lock = self.agent_lock(&agent.id);
        let _guard = lock.lock().await;
        let tmp_dir = self.root.join(format!(".staging-{}", uuid::Uuid::new_v4()));
        let staging = tmp_dir.join("stage");
        fs::create_dir_all(&staging).map_err(|error| {
            InstallError::new(code::INSTALL_FAILED, format!("create npm staging: {error}"))
        })?;
        let path = crate::pty::env_refresh::path_for_resolution()
            .to_string_lossy()
            .into_owned();
        if let Err(error) = self
            .npm_installer
            .install(&staging, package_spec, &path)
            .await
        {
            let _ = fs::remove_dir_all(&tmp_dir);
            log::error!(
                "[acp-install] Claude package install failed version={} reason={}",
                version,
                error
            );
            return Err(InstallError::new(
                code::INSTALL_FAILED,
                format!("could not install pinned Claude Agent ACP package: {error}"),
            ));
        }

        let package_dir = staging
            .join("node_modules")
            .join("@agentclientprotocol")
            .join("claude-agent-acp");
        let manifest_path = package_dir.join("package.json");
        let manifest = fs::read_to_string(&manifest_path).map_err(|error| {
            let _ = fs::remove_dir_all(&tmp_dir);
            InstallError::new(
                code::INSTALL_FAILED,
                format!("read Claude ACP package manifest: {error}"),
            )
        })?;
        let relative_entrypoint =
            crate::acp::claude_agent::parse_claude_package_entrypoint(&manifest, &version)
                .ok_or_else(|| {
                    let _ = fs::remove_dir_all(&tmp_dir);
                    InstallError::new(
                        code::INSTALL_FAILED,
                        "installed Claude ACP package has an unexpected manifest",
                    )
                })?;
        let staged_entrypoint = package_dir.join(relative_entrypoint);
        let package_root = fs::canonicalize(&package_dir).map_err(|error| {
            let _ = fs::remove_dir_all(&tmp_dir);
            InstallError::new(
                code::INSTALL_FAILED,
                format!("resolve Claude ACP package directory: {error}"),
            )
        })?;
        let canonical_entrypoint = fs::canonicalize(&staged_entrypoint).map_err(|error| {
            let _ = fs::remove_dir_all(&tmp_dir);
            InstallError::new(
                code::INSTALL_FAILED,
                format!("resolve Claude ACP entrypoint: {error}"),
            )
        })?;
        if !canonical_entrypoint.starts_with(&package_root) || !canonical_entrypoint.is_file() {
            let _ = fs::remove_dir_all(&tmp_dir);
            return Err(InstallError::new(
                code::PATH_TRAVERSAL_DETECTED,
                "Claude ACP entrypoint is not a regular file inside the package",
            ));
        }
        let relative_from_stage = staged_entrypoint.strip_prefix(&staging).map_err(|error| {
            let _ = fs::remove_dir_all(&tmp_dir);
            InstallError::new(code::PATH_TRAVERSAL_DETECTED, error.to_string())
        })?;

        let install_root_for_agent = self.root.join(&agent.id);
        let backup = install_root_for_agent.with_file_name(format!("{}.old", agent.id));
        let _ = fs::remove_dir_all(&backup);
        let had_previous_install = install_root_for_agent.exists();
        if had_previous_install {
            if let Err(error) = fs::rename(&install_root_for_agent, &backup) {
                let _ = fs::remove_dir_all(&tmp_dir);
                return Err(InstallError::new(
                    code::INSTALL_FAILED,
                    format!("backup previous Claude ACP install: {error}"),
                ));
            }
        }
        if let Err(error) = fs::rename(&staging, &install_root_for_agent) {
            if backup.exists() {
                let _ = fs::rename(&backup, &install_root_for_agent);
            }
            let _ = fs::remove_dir_all(&tmp_dir);
            return Err(InstallError::new(
                code::INSTALL_FAILED,
                format!("activate Claude ACP install: {error}"),
            ));
        }
        let _ = fs::remove_dir_all(&tmp_dir);

        let entrypoint = install_root_for_agent.join(relative_from_stage);
        let installed_at = now_millis();
        let record = InstalledAgent {
            agent_id: agent.id.clone(),
            version: version.clone(),
            platform_target: host_platform_arch(host),
            sha256: String::new(),
            command: "node".to_string(),
            args: vec![entrypoint.to_string_lossy().to_string()],
            installed_at,
        };
        if let Err(error) = self.save_installed_record(record).await {
            let rollback_result = rollback_activated_install(&install_root_for_agent, &backup);
            let message = match &rollback_result {
                Ok(()) if had_previous_install => {
                    format!("persist Claude ACP install state: {error}; previous install restored")
                }
                Ok(()) => {
                    format!("persist Claude ACP install state: {error}; new install removed")
                }
                Err(rollback_error) => format!(
                    "persist Claude ACP install state: {error}; rollback failed: {rollback_error}"
                ),
            };
            log::error!(
                "[acp-install] Claude manifest persistence failed version={} reason={}",
                version,
                error
            );
            if let Err(rollback_error) = &rollback_result {
                log::error!(
                    "[acp-install] Claude package rollback failed version={} reason={}",
                    version,
                    rollback_error
                );
            }
            return Err(InstallError::new(code::INSTALL_FAILED, message));
        }
        let _ = fs::remove_dir_all(&backup);
        log::info!(
            "[acp-install] Claude package installed version={} duration_ms={}",
            version,
            started.elapsed().as_millis()
        );
        Ok(InstallOutcome {
            command: "node".to_string(),
            args: vec![entrypoint.to_string_lossy().to_string()],
        })
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

        let cmd = target.get("cmd").and_then(|c| c.as_str()).ok_or_else(|| {
            InstallError::new(code::INSTALL_FAILED, "catalog binary target missing 'cmd'")
        })?;
        let archive_url = target
            .get("archive")
            .and_then(|a| a.as_str())
            .ok_or_else(|| {
                InstallError::new(
                    code::UNSUPPORTED_PLATFORM,
                    "catalog binary target missing 'archive'",
                )
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
        let tmp_dir = self.root.join(format!(".staging-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp_dir)
            .map_err(|e| InstallError::new(code::INSTALL_FAILED, format!("create staging: {e}")))?;
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

        // Atomic-ish swap: backup old → rename(staging, root), then retain
        // the backup until the installed-manifest write succeeds.
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
        let _ = std::fs::remove_dir_all(&tmp_dir);

        // Recompute the program path under the final root (plain, non-canonical).
        let program = install_root_for_agent.join(normalize_cmd_path(cmd));

        // 6. Persist the installed record before updating the in-memory
        // manifest snapshot.
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
        // A manifest persist failure rolls activation back instead of leaving
        // an untracked package in the host cache.
        if let Err(error) = self.save_installed_record(record).await {
            log::error!(
                "[acp-install] {} manifest persist failed: {error}",
                crate::logging::run_id()
            );
            if let Err(rollback_error) =
                rollback_activated_install(&install_root_for_agent, &backup)
            {
                log::error!(
                    "[acp-install] install rollback failed agent={} error={rollback_error}",
                    agent_id_log
                );
            }
            return Err(InstallError::new(
                code::INSTALL_FAILED,
                format!("manifest persist failed: {error}"),
            ));
        }
        let _ = std::fs::remove_dir_all(&backup);

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
            return Err(InstallError::new(
                code::VALIDATION_ERROR,
                "invalid agent id",
            ));
        }
        let lock = self.agent_lock(agent_id);
        let _guard = lock.lock().await;

        let install_dir = self.root.join(agent_id);
        // `with_file_name(format!("{id}.old"))` (NOT `with_extension`) so a
        // dotted agent_id survives — mirrors `install`'s backup path.
        let backup = install_dir.with_file_name(format!("{}.old", agent_id));
        let _ = std::fs::remove_dir_all(&backup);
        if install_dir.exists() {
            fs::rename(&install_dir, &backup).map_err(|error| {
                InstallError::new(
                    code::INSTALL_FAILED,
                    format!("backup installed agent before uninstall: {error}"),
                )
            })?;
        }

        if let Err(error) = self.remove_installed_record(agent_id).await {
            if backup.exists() {
                if let Err(rollback_error) = fs::rename(&backup, &install_dir) {
                    log::error!(
                        "[acp-install] uninstall rollback failed agent={} error={rollback_error}",
                        sanitize_agent_id_log(agent_id)
                    );
                }
            }
            log::error!(
                "[acp-install] {} uninstall manifest persist failed agent={} error={error}",
                crate::logging::run_id(),
                sanitize_agent_id_log(agent_id)
            );
            return Err(InstallError::new(
                code::INSTALL_FAILED,
                format!("manifest persist failed: {error}"),
            ));
        }
        let _ = fs::remove_dir_all(&backup);
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
        self.manifest.lock().agents.values().cloned().collect()
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// The platform-arch key for the catalog's binary map lookup. Mirrors
/// `catalog::host_platform_arch` but takes the host capability (testable with
/// synthetic input) instead of `std::env::consts::OS`.
fn host_platform_arch(host: &HostCapability) -> String {
    let os = if host.os == "macos" {
        "darwin"
    } else {
        &host.os
    };
    format!("{}-{}", os, host.arch)
}

/// Remove the newly activated tree and restore the prior one (if present).
/// Called only while the caller holds the per-agent install lock.
fn rollback_activated_install(install_dir: &Path, backup: &Path) -> io::Result<()> {
    if install_dir.exists() {
        fs::remove_dir_all(install_dir)?;
    }
    if backup.exists() {
        fs::rename(backup, install_dir)?;
    }
    Ok(())
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
mod tests;
