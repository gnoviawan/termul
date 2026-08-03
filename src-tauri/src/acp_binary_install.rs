//! Download and extract ACP registry release archives into app-local storage.

use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const FETCH_TIMEOUT_SECS: u64 = 120;
const MAX_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;
/// Decompressed-output quotas, to bound zip/tar bombs.
const MAX_EXTRACTED_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_EXTRACTED_FILES: usize = 50_000;

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
    // Must be a regular file: a directory would later fail at spawn time.
    if !canon_cmd
        .metadata()
        .map_err(|e| format!("installed binary stat failed: {e}"))?
        .is_file()
    {
        return Err("installed binary is a directory".to_string());
    }
    Ok(candidate)
}

/// Stream-copy a reader to disk while enforcing the global extracted-bytes
/// quota. `written` tracks the running total across all entries.
fn copy_bounded(
    mut reader: impl Read,
    out: &mut std::fs::File,
    written: &mut u64,
) -> Result<(), String> {
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        *written += n as u64;
        if *written > MAX_EXTRACTED_BYTES {
            return Err("archive expands beyond size limit".to_string());
        }
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn extract_zip(archive_path: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("zip: {e}"))?;
    let mut written: u64 = 0;
    let mut files: usize = 0;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        // enclosed_name() rejects path traversal (absolute / `..`) entries.
        let Some(name) = entry.enclosed_name().map(|p| p.to_owned()) else {
            continue;
        };
        let out_path = dest.join(name);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
        } else {
            files += 1;
            if files > MAX_EXTRACTED_FILES {
                return Err("archive contains too many files".to_string());
            }
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            // Capture mode before consuming the entry body.
            let unix_mode = entry.unix_mode();
            let mut out = std::fs::File::create(&out_path).map_err(|e| e.to_string())?;
            copy_bounded(&mut entry, &mut out, &mut written)?;
            drop(out);
            if let Some(mode) = unix_mode {
                apply_permission_bits(&out_path, mode);
            }
        }
    }
    Ok(())
}

fn extract_tar_gz(archive_path: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive_path).map_err(|e| e.to_string())?;
    let gz = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(gz);
    let canon_dest = dest
        .canonicalize()
        .map_err(|e| format!("extract dir missing: {e}"))?;
    let mut written: u64 = 0;
    let mut files: usize = 0;
    for entry in archive.entries().map_err(|e| format!("tar: {e}"))? {
        let mut entry = entry.map_err(|e| format!("tar: {e}"))?;
        let path = entry.path().map_err(|e| format!("tar: {e}"))?.into_owned();
        // Reject absolute paths and parent-dir traversal.
        if path.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) {
            return Err("tar entry has unsafe path".to_string());
        }
        let out_path = canon_dest.join(&path);
        if entry.header().entry_type().is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
        } else {
            files += 1;
            if files > MAX_EXTRACTED_FILES {
                return Err("archive contains too many files".to_string());
            }
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mode = entry.header().mode().ok();
            let mut out = std::fs::File::create(&out_path).map_err(|e| e.to_string())?;
            copy_bounded(&mut entry, &mut out, &mut written)?;
            drop(out);
            if let Some(mode) = mode {
                apply_permission_bits(&out_path, mode);
            }
        }
    }
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
fn apply_permission_bits(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    // Drop setuid/setgid/sticky from untrusted archives; keep rwx only.
    let mode = mode & 0o777;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
}

#[cfg(not(unix))]
fn apply_permission_bits(_path: &Path, _mode: u32) {}

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

/// True when `head` looks like a script or native executable that must be
/// runnable after extract. Zip extracts often land as `0644` even when the
/// archive carried unix modes (or omitted them entirely) — Cursor's bundled
/// `node` / `rg` hit Permission denied without this.
fn looks_like_spawnable(head: &[u8]) -> bool {
    if head.len() >= 2 && head[0] == b'#' && head[1] == b'!' {
        return true;
    }
    if head.len() >= 4 && head.starts_with(b"\x7fELF") {
        return true;
    }
    // Mach-O (32/64, LE/BE) and fat/universal.
    const MACHO: &[[u8; 4]] = &[
        [0xcf, 0xfa, 0xed, 0xfe], // MH_MAGIC_64
        [0xce, 0xfa, 0xed, 0xfe], // MH_MAGIC
        [0xfe, 0xed, 0xfa, 0xcf], // MH_CIGAM_64
        [0xfe, 0xed, 0xfa, 0xce], // MH_CIGAM
        [0xca, 0xfe, 0xba, 0xbe], // FAT_MAGIC
        [0xbe, 0xba, 0xfe, 0xca], // FAT_CIGAM
    ];
    if head.len() >= 4 {
        let magic = [head[0], head[1], head[2], head[3]];
        if MACHO.iter().any(|m| *m == magic) {
            return true;
        }
    }
    false
}

/// Walk `root` and +x any shebang / ELF / Mach-O file. Complements archive mode
/// restoration when the zip omitted unix permissions (common for registry
/// packages that ship a launcher script + companion `node` binary).
fn mark_spawnables_in_tree(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let mut stack: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
    while let Some(path) = stack.pop() {
        let Ok(meta) = path.symlink_metadata() else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            if let Ok(children) = std::fs::read_dir(&path) {
                stack.extend(children.filter_map(|e| e.ok().map(|e| e.path())));
            }
            continue;
        }
        if !meta.is_file() {
            continue;
        }
        let Ok(mut file) = std::fs::File::open(&path) else {
            continue;
        };
        let mut head = [0u8; 4];
        let Ok(n) = file.read(&mut head) else {
            continue;
        };
        if looks_like_spawnable(&head[..n]) {
            mark_executable(&path);
        }
    }
}

/// Download the archive into `tmp_dir`, extract it into `staging`, and validate
/// that `cmd` resolves to a regular file inside `staging`. Kept separate from
/// the swap logic so the caller can clean up staging on any failure.
async fn stage_archive(
    archive_url: &str,
    cmd: &str,
    tmp_dir: &Path,
    staging: &Path,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let response = client
        .get(archive_url)
        .send()
        .await
        .map_err(|e| format!("download failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("download returned HTTP {}", response.status()));
    }

    // Stream the body to disk, enforcing the download cap incrementally so a
    // hostile server can't force us to buffer an unbounded response.
    let archive_name = archive_url
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("archive.bin");
    let archive_path = tmp_dir.join(archive_name);
    let mut file = std::fs::File::create(&archive_path).map_err(|e| e.to_string())?;
    let mut downloaded: u64 = 0;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("download stream: {e}"))?;
        downloaded += chunk.len() as u64;
        if downloaded > MAX_ARCHIVE_BYTES {
            return Err("archive too large".to_string());
        }
        file.write_all(&chunk).map_err(|e| e.to_string())?;
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);

    extract_archive(&archive_path, staging)?;
    // Validate the cmd resolves to a regular file inside the staging dir.
    let staged_program = resolve_cmd_in_root(staging, cmd)?;
    mark_executable(&staged_program);
    // Registry packages (e.g. Cursor) ship a launcher that execs a sibling
    // `node` / helper binary — those must be runnable too.
    mark_spawnables_in_tree(staging);
    Ok(())
}

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
    if let Some(parent) = root.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create install parent: {e}"))?;
    }

    // Download + extract into a private staging directory; only swap it into the
    // real install root once everything succeeds, so a failure never destroys a
    // previously-working install.
    let tmp_dir = std::env::temp_dir().join(format!("termul-acp-dl-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
    let staging = tmp_dir.join("stage");
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;

    if let Err(e) = stage_archive(&req.archive_url, cmd_trim, &tmp_dir, &staging).await {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return Err(e);
    }

    // Atomic-ish swap: move the old install aside, promote staging, drop backup.
    let backup = root.with_extension("old");
    let _ = std::fs::remove_dir_all(&backup);
    if root.exists() {
        std::fs::rename(&root, &backup).map_err(|e| format!("backup old install: {e}"))?;
    }
    if let Err(e) = std::fs::rename(&staging, &root) {
        // Restore the previous install on swap failure.
        if backup.exists() {
            let _ = std::fs::rename(&backup, &root);
        }
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return Err(format!("promote install: {e}"));
    }
    let _ = std::fs::remove_dir_all(&backup);
    let _ = std::fs::remove_dir_all(&tmp_dir);

    // Recompute the program path under the final root (plain, non-canonical).
    let program = root.join(normalize_cmd_path(cmd_trim));

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn looks_like_spawnable_detects_shebang_elf_macho() {
        assert!(looks_like_spawnable(b"#!/bin/bash\n"));
        assert!(looks_like_spawnable(b"\x7fELF\x02\x01"));
        assert!(looks_like_spawnable(&[0xcf, 0xfa, 0xed, 0xfe, 0, 0]));
        assert!(!looks_like_spawnable(b"{\"ok\":true}"));
        assert!(!looks_like_spawnable(b""));
    }

    #[cfg(unix)]
    #[test]
    fn mark_spawnables_makes_companion_node_executable() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("termul-acp-exec-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let node = dir.join("node");
        let script = dir.join("cursor-agent");
        let text = dir.join("readme.txt");

        {
            let mut f = std::fs::File::create(&node).unwrap();
            f.write_all(&[0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]).unwrap();
        }
        {
            let mut f = std::fs::File::create(&script).unwrap();
            f.write_all(b"#!/usr/bin/env bash\necho hi\n").unwrap();
        }
        std::fs::write(&text, b"hello").unwrap();

        // Simulate zip extract: plain 0644 files.
        for p in [&node, &script, &text] {
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o644)).unwrap();
        }

        mark_spawnables_in_tree(&dir);

        let node_mode = std::fs::metadata(&node).unwrap().permissions().mode() & 0o111;
        let script_mode = std::fs::metadata(&script).unwrap().permissions().mode() & 0o111;
        let text_mode = std::fs::metadata(&text).unwrap().permissions().mode() & 0o111;
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(node_mode, 0o111);
        assert_eq!(script_mode, 0o111);
        assert_eq!(text_mode, 0);
    }
}
