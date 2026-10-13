//! SFTP operations on a session's connection (russh-sftp).

use russh_sftp::client::fs::Metadata;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Largest file the editor opens (it holds the whole file in memory).
const MAX_EDIT_BYTES: u64 = 5 * 1024 * 1024;
const TRANSFER_CHUNK: usize = 32 * 1024;
/// Emit transfer progress every this many bytes.
const PROGRESS_STEP: u64 = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SFTPEntry {
    pub name: String,
    pub path: String,
    pub entry_type: String, // "file" | "directory" | "symlink"
    pub size: u64,
    pub permissions: u32,
    pub modified_at: String,
    pub owner: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SFTPTransferProgress {
    pub connection_id: String,
    pub remote_path: String,
    pub local_path: String,
    pub bytes_transferred: u64,
    pub total_bytes: u64,
    pub direction: String, // "upload" | "download"
    pub status: String,    // "in-progress" | "completed" | "failed" | "cancelled"
    pub error: Option<String>,
}

pub(crate) fn entry_type(meta: &Metadata) -> &'static str {
    if meta.is_symlink() {
        "symlink"
    } else if meta.is_dir() {
        "directory"
    } else {
        "file"
    }
}

pub(crate) fn mtime_to_iso(mtime: Option<u32>) -> String {
    mtime
        .and_then(|t| chrono::DateTime::from_timestamp(i64::from(t), 0))
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_string())
}

pub(crate) fn join(parent: &str, name: &str) -> String {
    if parent.ends_with('/') {
        format!("{}{}", parent, name)
    } else {
        format!("{}/{}", parent, name)
    }
}

/// Directories first, then by name (case-insensitive).
pub(crate) fn sort_entries(entries: &mut [SFTPEntry]) {
    entries.sort_by(|a, b| {
        let a_dir = a.entry_type == "directory";
        let b_dir = b.entry_type == "directory";
        b_dir
            .cmp(&a_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

pub async fn list_dir(sftp: &SftpSession, remote_path: &str) -> Result<Vec<SFTPEntry>, String> {
    let entries = sftp
        .read_dir(remote_path)
        .await
        .map_err(|e| format!("Failed to read directory '{}': {}", remote_path, e))?;
    let mut result: Vec<SFTPEntry> = entries
        .filter(|entry| {
            let name = entry.file_name();
            name != "." && name != ".."
        })
        .map(|entry| {
            let name = entry.file_name();
            let meta = entry.metadata();
            SFTPEntry {
                path: join(remote_path, &name),
                entry_type: entry_type(&meta).to_string(),
                size: meta.size.unwrap_or(0),
                permissions: meta.permissions.unwrap_or(0),
                modified_at: mtime_to_iso(meta.mtime),
                owner: meta
                    .user
                    .clone()
                    .or_else(|| meta.uid.map(|u| u.to_string())),
                name,
            }
        })
        .collect();
    sort_entries(&mut result);
    Ok(result)
}

/// Absolute form of a remote path (`.` is the login directory).
pub async fn realpath(sftp: &SftpSession, remote_path: &str) -> Result<String, String> {
    sftp.canonicalize(remote_path)
        .await
        .map_err(|e| format!("Failed to resolve '{}': {}", remote_path, e))
}

/// Read a remote file for the editor (bounded, UTF-8).
pub async fn read_file_to_string(sftp: &SftpSession, remote_path: &str) -> Result<String, String> {
    let meta = sftp
        .metadata(remote_path)
        .await
        .map_err(|e| format!("Failed to read '{}': {}", remote_path, e))?;
    if meta.size.unwrap_or(0) > MAX_EDIT_BYTES {
        return Err(format!(
            "'{}' is larger than {} MB; download it instead",
            remote_path,
            MAX_EDIT_BYTES / 1024 / 1024
        ));
    }
    // The size above is advisory (it can be missing or stale), so the read
    // itself stops one byte past the limit.
    let mut file = sftp
        .open(remote_path)
        .await
        .map_err(|e| format!("Failed to read '{}': {}", remote_path, e))?;
    let bytes = read_capped(&mut file, MAX_EDIT_BYTES)
        .await
        .map_err(|e| format!("Failed to read '{}': {}", remote_path, e))?
        .ok_or_else(|| {
            format!(
                "'{}' is larger than {} MB; download it instead",
                remote_path,
                MAX_EDIT_BYTES / 1024 / 1024
            )
        })?;
    String::from_utf8(bytes).map_err(|_| format!("'{}' is not a text file", remote_path))
}

/// Read at most `limit` bytes; `None` when the source holds more.
pub(crate) async fn read_capped<R>(reader: &mut R, limit: u64) -> std::io::Result<Option<Vec<u8>>>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut bytes = Vec::new();
    reader.take(limit + 1).read_to_end(&mut bytes).await?;
    Ok((bytes.len() as u64 <= limit).then_some(bytes))
}

/// Write content to a remote file (creates or overwrites).
pub async fn write_file_from_string(
    sftp: &SftpSession,
    remote_path: &str,
    content: &str,
) -> Result<(), String> {
    let mut file = sftp
        .create(remote_path)
        .await
        .map_err(|e| format!("Failed to open '{}' for writing: {}", remote_path, e))?;
    file.write_all(content.as_bytes())
        .await
        .map_err(|e| format!("Failed to write '{}': {}", remote_path, e))?;
    file.shutdown()
        .await
        .map_err(|e| format!("Failed to save '{}': {}", remote_path, e))
}

/// Create an empty file; fails when something already exists at the path.
pub async fn create_file(sftp: &SftpSession, remote_path: &str) -> Result<(), String> {
    // One exclusive open: an existing file is refused, never truncated.
    let flags = OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE;
    let mut file = sftp
        .open_with_flags(remote_path, flags)
        .await
        .map_err(|e| {
            format!(
                "Could not create '{}' (it may already exist): {}",
                remote_path, e
            )
        })?;
    let _ = file.shutdown().await;
    Ok(())
}

/// Delete a file, a symlink (not its target) or an empty directory.
pub async fn delete_path(sftp: &SftpSession, remote_path: &str) -> Result<(), String> {
    let meta = sftp
        .symlink_metadata(remote_path)
        .await
        .map_err(|e| format!("Failed to read '{}': {}", remote_path, e))?;
    if meta.is_dir() && !meta.is_symlink() {
        sftp.remove_dir(remote_path).await.map_err(|e| {
            format!(
                "Failed to remove folder '{}' (it must be empty): {}",
                remote_path, e
            )
        })
    } else {
        sftp.remove_file(remote_path)
            .await
            .map_err(|e| format!("Failed to delete '{}': {}", remote_path, e))
    }
}

pub async fn mkdir(sftp: &SftpSession, remote_path: &str) -> Result<(), String> {
    sftp.create_dir(remote_path)
        .await
        .map_err(|e| format!("Failed to create folder '{}': {}", remote_path, e))
}

pub async fn rename(sftp: &SftpSession, old_path: &str, new_path: &str) -> Result<(), String> {
    sftp.rename(old_path, new_path)
        .await
        .map_err(|e| format!("Failed to rename '{}' to '{}': {}", old_path, new_path, e))
}

struct Progress<'a> {
    app: &'a AppHandle,
    connection_id: &'a str,
    remote_path: &'a str,
    local_path: &'a str,
    direction: &'static str,
    total: u64,
}

impl Progress<'_> {
    fn emit(&self, transferred: u64, status: &str, error: Option<String>) {
        let progress = SFTPTransferProgress {
            connection_id: self.connection_id.to_string(),
            remote_path: self.remote_path.to_string(),
            local_path: self.local_path.to_string(),
            bytes_transferred: transferred,
            total_bytes: self.total,
            direction: self.direction.to_string(),
            status: status.to_string(),
            error,
        };
        let _ = self.app.emit("ssh-transfer-progress", &progress);
    }
}

/// Copy `reader` to `writer`, reporting progress; returns bytes copied. A
/// failure carries the bytes copied before it, for the final progress event.
async fn copy_with_progress<R, W>(
    reader: &mut R,
    writer: &mut W,
    progress: &Progress<'_>,
) -> Result<u64, (u64, String)>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    let mut buffer = vec![0u8; TRANSFER_CHUNK];
    let mut transferred = 0u64;
    let mut last_emit = 0u64;
    loop {
        let n = reader
            .read(&mut buffer)
            .await
            .map_err(|e| (transferred, format!("Read error: {}", e)))?;
        if n == 0 {
            break;
        }
        writer
            .write_all(&buffer[..n])
            .await
            .map_err(|e| (transferred, format!("Write error: {}", e)))?;
        transferred += n as u64;
        if transferred - last_emit >= PROGRESS_STEP {
            progress.emit(transferred, "in-progress", None);
            last_emit = transferred;
        }
    }
    writer
        .shutdown()
        .await
        .map_err(|e| (transferred, format!("Write error: {}", e)))?;
    Ok(transferred)
}

pub async fn download_file(
    sftp: &SftpSession,
    remote_path: &str,
    local_path: &str,
    app: &AppHandle,
    connection_id: &str,
) -> Result<(), String> {
    let total = sftp
        .metadata(remote_path)
        .await
        .map_err(|e| format!("Failed to read '{}': {}", remote_path, e))?
        .size
        .unwrap_or(0);
    let progress = Progress {
        app,
        connection_id,
        remote_path,
        local_path,
        direction: "download",
        total,
    };
    let result = async {
        let mut remote = sftp
            .open(remote_path)
            .await
            .map_err(|e| (0, format!("Failed to open '{}': {}", remote_path, e)))?;
        let mut local = tokio::fs::File::create(local_path)
            .await
            .map_err(|e| (0, format!("Failed to create '{}': {}", local_path, e)))?;
        copy_with_progress(&mut remote, &mut local, &progress).await
    }
    .await;
    match result {
        Ok(transferred) => {
            progress.emit(transferred, "completed", None);
            Ok(())
        }
        Err((transferred, e)) => {
            progress.emit(transferred, "failed", Some(e.clone()));
            Err(e)
        }
    }
}

pub async fn upload_file(
    sftp: &SftpSession,
    local_path: &str,
    remote_path: &str,
    app: &AppHandle,
    connection_id: &str,
) -> Result<(), String> {
    let total = tokio::fs::metadata(local_path)
        .await
        .map_err(|e| format!("Local file not found: {} ({})", local_path, e))?
        .len();
    let progress = Progress {
        app,
        connection_id,
        remote_path,
        local_path,
        direction: "upload",
        total,
    };
    let result = async {
        let mut local = tokio::fs::File::open(local_path)
            .await
            .map_err(|e| (0, format!("Failed to open '{}': {}", local_path, e)))?;
        let mut remote = sftp
            .create(remote_path)
            .await
            .map_err(|e| (0, format!("Failed to create '{}': {}", remote_path, e)))?;
        copy_with_progress(&mut local, &mut remote, &progress).await
    }
    .await;
    match result {
        Ok(transferred) => {
            progress.emit(transferred, "completed", None);
            Ok(())
        }
        Err((transferred, e)) => {
            progress.emit(transferred, "failed", Some(e.clone()));
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests;
