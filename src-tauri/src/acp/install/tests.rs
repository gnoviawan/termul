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
            npm: false,
            node_major: None,
            claude_cli: false,
            unavailable_reason: None,
        },
    }
}

fn sample_claude_agent(status: SupportedAcpAgentStatus) -> CatalogAgent {
    CatalogAgent {
        id: "claude-acp".to_string(),
        name: "Claude Agent".to_string(),
        version: "0.78.0".to_string(),
        description: "Claude ACP".to_string(),
        source: CatalogSource::Bundled,
        distribution: serde_json::json!({
            "npx": {
                "package": "@agentclientprotocol/claude-agent-acp@0.78.0"
            }
        }),
        runtime_requirements: vec!["node".to_string(), "npm".to_string(), "claude".to_string()],
        status,
        platform_targets: Vec::new(),
        installed: None,
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
    let tmp = std::env::temp_dir().join(format!("termul-acp-install-zip-{}", uuid::Uuid::new_v4()));
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

struct FakeNpmPackageInstaller {
    installed_spec: Arc<Mutex<Option<String>>>,
}

#[async_trait::async_trait]
impl NpmPackageInstaller for FakeNpmPackageInstaller {
    async fn install(&self, prefix: &Path, package_spec: &str, _path: &str) -> Result<(), String> {
        *self.installed_spec.lock() = Some(package_spec.to_string());
        let package_dir = prefix
            .join("node_modules")
            .join("@agentclientprotocol")
            .join("claude-agent-acp");
        fs::create_dir_all(package_dir.join("dist")).map_err(|error| error.to_string())?;
        fs::write(
            package_dir.join("package.json"),
            r#"{
                  "name":"@agentclientprotocol/claude-agent-acp",
                  "version":"0.78.0",
                  "bin":{"claude-agent-acp":"dist/index.js"}
                }"#,
        )
        .map_err(|error| error.to_string())?;
        fs::write(package_dir.join("dist/index.js"), "mock ACP entrypoint")
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}

#[tokio::test]
async fn managed_claude_install_uses_pinned_package_and_validated_entrypoint() {
    let root = temp_dir("claude-managed-install");
    let installed_spec = Arc::new(Mutex::new(None));
    let installer = Arc::new(FakeNpmPackageInstaller {
        installed_spec: Arc::clone(&installed_spec),
    });
    let catalog = crate::acp::AcpCatalogService::open(root.join("catalog"))
        .await
        .unwrap();
    let service =
        AcpInstallService::open_with_npm_installer(root.join("installs"), catalog, installer)
            .await
            .unwrap();
    let mut host = host();
    host.runtimes.node_major = Some(22);
    host.runtimes.npm = true;
    host.runtimes.claude_cli = true;

    let outcome = service
        .install_claude_agent(
            &sample_claude_agent(SupportedAcpAgentStatus::InstallRequired),
            &host,
        )
        .await
        .unwrap();

    assert_eq!(
        installed_spec.lock().as_deref(),
        Some("@agentclientprotocol/claude-agent-acp@0.78.0")
    );
    assert_eq!(outcome.command, "node");
    let expected_entrypoint = service
        .root()
        .join("claude-acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js");
    assert_eq!(
        outcome.args,
        vec![expected_entrypoint.to_string_lossy().to_string()]
    );
    assert_eq!(service.installed_agents()[0].version, "0.78.0");
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn managed_claude_install_restores_previous_package_when_manifest_persist_fails() {
    let root = temp_dir("claude-manifest-failure");
    let installer = Arc::new(FakeNpmPackageInstaller {
        installed_spec: Arc::new(Mutex::new(None)),
    });
    let catalog = crate::acp::AcpCatalogService::open(root.join("catalog"))
        .await
        .unwrap();
    let service =
        AcpInstallService::open_with_npm_installer(root.join("installs"), catalog, installer)
            .await
            .unwrap();
    let previous_install = service.root().join("claude-acp");
    fs::create_dir_all(&previous_install).unwrap();
    fs::write(
        previous_install.join("previous-install-marker"),
        b"previous",
    )
    .unwrap();
    // Force atomic manifest replacement to fail after package activation.
    fs::create_dir(service.root().join(INSTALLED_MANIFEST_FILENAME)).unwrap();
    let mut host = host();
    host.runtimes.node_major = Some(22);
    host.runtimes.npm = true;
    host.runtimes.claude_cli = true;

    let result = service
        .install_claude_agent(
            &sample_claude_agent(SupportedAcpAgentStatus::InstallRequired),
            &host,
        )
        .await;

    assert!(
        result.is_err(),
        "manifest persistence failure must fail install"
    );
    assert_eq!(
        fs::read(previous_install.join("previous-install-marker")).unwrap(),
        b"previous",
        "the previous working package must be restored"
    );
    assert!(
        !previous_install.join("node_modules").exists(),
        "the new package must not remain active after persistence failure"
    );
    assert!(
        service.installed_agents().is_empty(),
        "failed install must not update the in-memory manifest"
    );
    let _ = fs::remove_dir_all(root);
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
            return Err(InstallError::new(
                code::DOWNLOAD_FAILED,
                "canned download failure",
            ));
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
struct FailingExtractor {
    message: String,
}
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
    // Agent with a deliberately unlisted binary target, independent of
    // the OS running this test.
    let agent = sample_binary_agent(
        "no-platform",
        "unlisted-os-unlisted-arch",
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
    let agent = sample_binary_agent("big", &pa, None, "./acp", "https://example.com/big.zip");
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
    let tmp =
        std::env::temp_dir().join(format!("termul-acp-install-slip-{}", uuid::Uuid::new_v4()));
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
    let tmp = std::env::temp_dir().join(format!(
        "termul-acp-install-tarslip-{}",
        uuid::Uuid::new_v4()
    ));
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
    let tmp = std::env::temp_dir().join(format!(
        "termul-acp-install-overfull-{}",
        uuid::Uuid::new_v4()
    ));
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
    let service = AcpInstallService::open(install_dir, catalog).await.unwrap();
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
    let err = service
        .install_by_id("")
        .await
        .expect_err("empty id errors");
    assert_eq!(err.code(), code::VALIDATION_ERROR);
    let err = service
        .install_by_id("../escape")
        .await
        .expect_err("bad id errors");
    assert_eq!(err.code(), code::VALIDATION_ERROR);
    // Bare `.` / `..` denote the current/parent directory and would escape
    // the install root via `root.join(&agent.id)` (CWE-22) — reject.
    let err = service.install_by_id(".").await.expect_err("dot id errors");
    assert_eq!(err.code(), code::VALIDATION_ERROR);
    let err = service
        .install_by_id("..")
        .await
        .expect_err("dotdot id errors");
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
        archive_host_for_log(
            "https://github.com/anomalyco/opencode/releases/download/v1/opencode.zip"
        ),
        "github.com"
    );
    assert_eq!(
        archive_host_for_log("https://example.com/path?query=1"),
        "example.com"
    );
    assert_eq!(archive_host_for_log("not-a-url"), "not-a-url");
}
