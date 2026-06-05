//! Download and extract ACP registry release archives into app-local storage.

use std::io::copy;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const FETCH_TIMEOUT_SECS: u64 = 120;
const MAX_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallAcpRegistryBinaryRequest {
    pub agent_id: String,
    pub archive_url: String,
    pub cmd: String,
    pub args: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallAcpRegistryBinaryOutcome {
    pub command: String,
    pub args: Vec<String>,
}

fn is_safe_agent_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

fn is_allowed_archive_url(url: &str) -> bool {
    url.len() <= 2048 && url.starts_with("https://")
}

fn install_root(app: &AppHandle, agent_id: &str) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    Ok(base.join("acp-registry-binaries").join(agent_id))
}

fn normalize_cmd_path(cmd: &str) -> PathBuf {
    let trimmed = cmd.trim();
    let stripped = trimmed
        .strip_prefix("./")
        .or_else(|| trimmed.strip_prefix(".\\"))
        .unwrap_or(trimmed);
    Path::new(stripped).to_path_buf()
}

fn resolve_cmd_in_root(root: &Path, cmd: &str) -> Result<PathBuf, String> {
    let rel = normalize_cmd_path(cmd);
    for comp in rel.components() {
        match comp {
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("invalid cmd path".to_string());
            }
            _ => {}
        }
    }
    let candidate = root.join(&rel);
    // Canonicalize ONLY to validate the path cannot escape the install root.
    // We must not return the canonicalized form: on Windows it carries the
    // `\\?\` extended-length prefix, which breaks downstream consumers (e.g.
    // the cursor PowerShell shim's `$scriptPath` math, leading node to receive
    // a truncated `C:` script path). Return the plain joined path instead.
    let canon_root = root
        .canonicalize()
        .map_err(|e| format!("install dir missing: {e}"))?;
    let canon_cmd = candidate
        .canonicalize()
        .map_err(|e| format!("installed binary not found ({cmd}): {e}"))?;
    if !canon_cmd.starts_with(&canon_root) {
        return Err("cmd escapes install directory".to_string());
    }
    Ok(candidate)
}

fn extract_zip(archive_path: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("zip: {e}"))?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let Some(name) = entry.enclosed_name().map(|p| p.to_owned()) else {
            continue;
        };
        let out_path = dest.join(name);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out = std::fs::File::create(&out_path).map_err(|e| e.to_string())?;
            copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn extract_tar_gz(archive_path: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive_path).map_err(|e| e.to_string())?;
    let gz = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(gz);
    archive.unpack(dest).map_err(|e| format!("tar: {e}"))?;
    Ok(())
}

fn extract_archive(archive_path: &Path, dest: &Path) -> Result<(), String> {
    let name = archive_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if name.ends_with(".zip") {
        extract_zip(archive_path, dest)
    } else if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        extract_tar_gz(archive_path, dest)
    } else {
        Err("unsupported archive type (expected .zip or .tar.gz)".to_string())
    }
}

#[cfg(unix)]
fn mark_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(path) {
        let mut perms = meta.permissions();
        perms.set_mode(perms.mode() | 0o111);
        let _ = std::fs::set_permissions(path, perms);
    }
}

#[cfg(not(unix))]
fn mark_executable(_path: &Path) {}

pub async fn install_registry_binary(
    app: &AppHandle,
    req: InstallAcpRegistryBinaryRequest,
) -> Result<InstallAcpRegistryBinaryOutcome, String> {
    if !is_safe_agent_id(&req.agent_id) {
        return Err("invalid agent id".to_string());
    }
    if !is_allowed_archive_url(&req.archive_url) {
        return Err("archive URL must be https".to_string());
    }
    let cmd_trim = req.cmd.trim();
    if cmd_trim.is_empty() {
        return Err("cmd is required".to_string());
    }

    let root = install_root(app, &req.agent_id)?;
    if root.exists() {
        std::fs::remove_dir_all(&root).map_err(|e| format!("clear install dir: {e}"))?;
    }
    std::fs::create_dir_all(&root).map_err(|e| format!("create install dir: {e}"))?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let response = client
        .get(&req.archive_url)
        .send()
        .await
        .map_err(|e| format!("download failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("download returned HTTP {}", response.status()));
    }

    let body = response
        .bytes()
        .await
        .map_err(|e| format!("download body: {e}"))?;
    if body.len() as u64 > MAX_ARCHIVE_BYTES {
        return Err("archive too large".to_string());
    }

    let tmp_dir = std::env::temp_dir().join(format!("termul-acp-dl-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
    let archive_name = req
        .archive_url
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("archive.bin");
    let archive_path = tmp_dir.join(archive_name);
    std::fs::write(&archive_path, &body).map_err(|e| e.to_string())?;

    let extract_result = extract_archive(&archive_path, &root);
    let _ = std::fs::remove_dir_all(&tmp_dir);

    extract_result?;

    let program = resolve_cmd_in_root(&root, cmd_trim)?;
    mark_executable(&program);

    let args = req.args.unwrap_or_default();
    Ok(InstallAcpRegistryBinaryOutcome {
        command: program.to_string_lossy().to_string(),
        args,
    })
}

#[tauri::command]
pub async fn acp_install_registry_binary(
    app: AppHandle,
    request: InstallAcpRegistryBinaryRequest,
) -> Result<InstallAcpRegistryBinaryOutcome, String> {
    install_registry_binary(&app, request).await
}