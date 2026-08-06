//! Shared ACP archive download + extract + permission helpers (CAP-6 / Story 9).
//!
//! Extracted from the legacy desktop-only `acp_binary_install.rs` so both the
//! legacy desktop command (kept for back-compat) and the new host-owned
//! [`crate::acp::install::AcpInstallService`] share ONE implementation. All
//! helpers are `pub(crate)` and take explicit args (no `AppHandle`) so the
//! install service can call them with its own resolved paths.
//!
//! # Protections (mirrors the legacy command)
//!
//! - Streaming download cap: `MAX_ARCHIVE_BYTES` (256 MiB), enforced
//!   incrementally during `stage_archive` so a hostile server can't force an
//!   unbounded buffer.
//! - Decompressed-output quotas: `MAX_EXTRACTED_BYTES` (1 GiB) +
//!   `MAX_EXTRACTED_FILES` (50_000), to bound zip/tar bombs.
//! - Path-traversal rejection: zip `enclosed_name`, tar rejects
//!   `ParentDir`/`RootDir`/`Prefix`.
//! - `resolve_cmd_in_root` re-validates the resolved `cmd` stays inside the
//!   install root post-extract.
//! - `mark_spawnables_in_tree` restores the executable bit by magic-number
//!   sniff (zip extracts often land as `0644`).
//! - Archive-format allowlist: `.zip` / `.tar.gz` / `.tgz` only.

use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use futures_util::StreamExt;

/// Fetch timeout for the archive download (mirrors the legacy command).
pub(crate) const FETCH_TIMEOUT_SECS: u64 = 120;
/// Streaming-download cap: a hostile server can't force an unbounded buffer.
pub(crate) const MAX_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;
/// Decompressed-output quotas, to bound zip/tar bombs.
pub(crate) const MAX_EXTRACTED_BYTES: u64 = 1024 * 1024 * 1024;
pub(crate) const MAX_EXTRACTED_FILES: usize = 50_000;

/// Strip a leading `./` / `.\` and trim so a catalog `cmd` like
/// `./dist-package/cursor-agent` resolves relative to the install root.
pub(crate) fn normalize_cmd_path(cmd: &str) -> PathBuf {
    let trimmed = cmd.trim();
    let stripped = trimmed
        .strip_prefix("./")
        .or_else(|| trimmed.strip_prefix(".\\"))
        .unwrap_or(trimmed);
    Path::new(stripped).to_path_buf()
}

/// Validate that `cmd` resolves to a regular file inside `root` after
/// extraction. Canonicalizes ONLY to validate the path cannot escape the
/// install root — returns the plain (non-canonicalized) joined path so Windows
/// downstream consumers don't choke on the `\\?\` extended-length prefix.
pub(crate) fn resolve_cmd_in_root(root: &Path, cmd: &str) -> Result<PathBuf, String> {
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
    let canon_root = root
        .canonicalize()
        .map_err(|e| format!("install dir missing: {e}"))?;
    let canon_cmd = candidate
        .canonicalize()
        .map_err(|e| format!("installed binary not found ({cmd}): {e}"))?;
    if !canon_cmd.starts_with(&canon_root) {
        return Err("cmd escapes install directory".to_string());
    }
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
        if path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
        {
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

/// Dispatch extraction by archive extension. Allowlist: `.zip` /
/// `.tar.gz` / `.tgz` only.
pub(crate) fn extract_archive(archive_path: &Path, dest: &Path) -> Result<(), String> {
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
pub(crate) fn apply_permission_bits(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    // Drop setuid/setgid/sticky from untrusted archives; keep rwx only.
    let mode = mode & 0o777;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
}

#[cfg(not(unix))]
pub(crate) fn apply_permission_bits(_path: &Path, _mode: u32) {}

#[cfg(unix)]
pub(crate) fn mark_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(path) {
        let mut perms = meta.permissions();
        perms.set_mode(perms.mode() | 0o111);
        let _ = std::fs::set_permissions(path, perms);
    }
}

#[cfg(not(unix))]
pub(crate) fn mark_executable(_path: &Path) {}

/// True when `head` looks like a script or native executable that must be
/// runnable after extract. Zip extracts often land as `0644` even when the
/// archive carried unix modes (or omitted them entirely).
pub(crate) fn looks_like_spawnable(head: &[u8]) -> bool {
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
        if MACHO.contains(&magic) {
            return true;
        }
    }
    false
}

/// Walk `root` and `+x` any shebang / ELF / Mach-O file. Complements archive
/// mode restoration when the zip omitted unix permissions.
pub(crate) fn mark_spawnables_in_tree(root: &Path) {
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
///
/// Used by the legacy desktop `install_registry_binary` command. The new
/// `AcpInstallService` uses injected `Downloader`/`Extractor` traits for
/// testability; its production `Downloader` impl reuses this function's
/// streaming + cap logic.
pub(crate) async fn stage_archive(
    archive_url: &str,
    cmd: &str,
    tmp_dir: &Path,
    staging: &Path,
) -> Result<PathBuf, String> {
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

    // Stream the body to disk, enforcing the download cap incrementally.
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
    mark_spawnables_in_tree(staging);
    Ok(staged_program)
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn extract_archive_rejects_unknown_extension() {
        let dir = std::env::temp_dir().join(format!("termul-acp-rej-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let archive = dir.join("evil.7z");
        std::fs::write(&archive, b"").unwrap();
        let dest = dir.join("dest");
        std::fs::create_dir_all(&dest).unwrap();
        let result = extract_archive(&archive, &dest);
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
