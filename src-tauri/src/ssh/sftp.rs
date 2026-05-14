//! SFTP Operations
//!
//! Provides file system operations over SSH using the SFTP subsystem.

use serde::{Deserialize, Serialize};
use ssh2::{FileStat, Session, Sftp};
use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use tauri::{AppHandle, Emitter};

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

/// Create an SFTP subsystem from an SSH session
pub fn create_sftp(session: &Session) -> Result<Sftp, String> {
    session
        .sftp()
        .map_err(|e| format!("Failed to open SFTP subsystem: {}", e))
}

/// Convert FileStat to entry type string
fn stat_to_entry_type(stat: &FileStat) -> &str {
    if stat.is_dir() {
        "directory"
    } else if stat.perm.is_some_and(|p| p & 0o120000 == 0o120000) {
        "symlink"
    } else {
        "file"
    }
}

/// Convert FileStat mtime to ISO string
fn mtime_to_iso(stat: &FileStat) -> String {
    stat.mtime
        .map(|t| {
            chrono::DateTime::from_timestamp(t as i64, 0)
                .map(|dt| dt.to_rfc3339())
                .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_string())
        })
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_string())
}

/// List directory contents over SFTP
pub fn list_dir(sftp: &Sftp, remote_path: &str) -> Result<Vec<SFTPEntry>, String> {
    let path = Path::new(remote_path);

    let entries = sftp
        .readdir(path)
        .map_err(|e| format!("Failed to read directory '{}': {}", remote_path, e))?;

    let mut result = Vec::with_capacity(entries.len());

    for (entry_path, stat) in entries {
        let name = entry_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        // Skip . and ..
        if name == "." || name == ".." {
            continue;
        }

        let full_path = if remote_path.ends_with('/') {
            format!("{}{}", remote_path, name)
        } else {
            format!("{}/{}", remote_path, name)
        };

        result.push(SFTPEntry {
            name,
            path: full_path,
            entry_type: stat_to_entry_type(&stat).to_string(),
            size: stat.size.unwrap_or(0),
            permissions: stat.perm.unwrap_or(0),
            modified_at: mtime_to_iso(&stat),
            owner: stat.uid.map(|u| u.to_string()),
        });
    }

    // Sort: directories first, then alphabetically
    result.sort_by(|a, b| {
        let a_is_dir = a.entry_type == "directory";
        let b_is_dir = b.entry_type == "directory";
        b_is_dir
            .cmp(&a_is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(result)
}

/// Download a file from remote to local
pub fn download_file(
    sftp: &Sftp,
    remote_path: &str,
    local_path: &str,
    app_handle: &AppHandle,
    connection_id: &str,
) -> Result<(), String> {
    let remote = Path::new(remote_path);

    // Get file size for progress
    let stat = sftp
        .stat(remote)
        .map_err(|e| format!("Failed to stat remote file '{}': {}", remote_path, e))?;

    let total_bytes = stat.size.unwrap_or(0);

    // Open remote file
    let mut remote_file = sftp
        .open(remote)
        .map_err(|e| format!("Failed to open remote file '{}': {}", remote_path, e))?;

    // Create local file
    let mut local_file = fs::File::create(local_path)
        .map_err(|e| format!("Failed to create local file '{}': {}", local_path, e))?;

    // Transfer with progress
    let mut buffer = [0u8; 32768]; // 32KB chunks
    let mut bytes_transferred: u64 = 0;
    let mut last_progress_emit: u64 = 0;

    loop {
        let bytes_read = remote_file
            .read(&mut buffer)
            .map_err(|e| format!("Read error: {}", e))?;

        if bytes_read == 0 {
            break;
        }

        local_file
            .write_all(&buffer[..bytes_read])
            .map_err(|e| format!("Write error: {}", e))?;

        bytes_transferred += bytes_read as u64;

        // Emit progress every 256KB
        if bytes_transferred - last_progress_emit >= 262144 || bytes_transferred == total_bytes {
            let progress = SFTPTransferProgress {
                connection_id: connection_id.to_string(),
                remote_path: remote_path.to_string(),
                local_path: local_path.to_string(),
                bytes_transferred,
                total_bytes,
                direction: "download".to_string(),
                status: "in-progress".to_string(),
                error: None,
            };

            let _ = app_handle.emit("ssh-transfer-progress", &progress);
            last_progress_emit = bytes_transferred;
        }
    }

    // Emit completion
    let progress = SFTPTransferProgress {
        connection_id: connection_id.to_string(),
        remote_path: remote_path.to_string(),
        local_path: local_path.to_string(),
        bytes_transferred,
        total_bytes,
        direction: "download".to_string(),
        status: "completed".to_string(),
        error: None,
    };
    let _ = app_handle.emit("ssh-transfer-progress", &progress);

    Ok(())
}

/// Upload a file from local to remote
pub fn upload_file(
    sftp: &Sftp,
    local_path: &str,
    remote_path: &str,
    app_handle: &AppHandle,
    connection_id: &str,
) -> Result<(), String> {
    let local = Path::new(local_path);

    if !local.exists() {
        return Err(format!("Local file not found: {}", local_path));
    }

    let metadata =
        fs::metadata(local).map_err(|e| format!("Failed to read local file metadata: {}", e))?;

    let total_bytes = metadata.len();

    // Open local file
    let mut local_file = fs::File::open(local)
        .map_err(|e| format!("Failed to open local file '{}': {}", local_path, e))?;

    // Create remote file
    let remote = Path::new(remote_path);
    let mut remote_file = sftp
        .create(remote)
        .map_err(|e| format!("Failed to create remote file '{}': {}", remote_path, e))?;

    // Transfer with progress
    let mut buffer = [0u8; 32768];
    let mut bytes_transferred: u64 = 0;
    let mut last_progress_emit: u64 = 0;

    loop {
        let bytes_read = local_file
            .read(&mut buffer)
            .map_err(|e| format!("Read error: {}", e))?;

        if bytes_read == 0 {
            break;
        }

        remote_file
            .write_all(&buffer[..bytes_read])
            .map_err(|e| format!("Write error: {}", e))?;

        bytes_transferred += bytes_read as u64;

        // Emit progress every 256KB
        if bytes_transferred - last_progress_emit >= 262144 || bytes_transferred == total_bytes {
            let progress = SFTPTransferProgress {
                connection_id: connection_id.to_string(),
                remote_path: remote_path.to_string(),
                local_path: local_path.to_string(),
                bytes_transferred,
                total_bytes,
                direction: "upload".to_string(),
                status: "in-progress".to_string(),
                error: None,
            };

            let _ = app_handle.emit("ssh-transfer-progress", &progress);
            last_progress_emit = bytes_transferred;
        }
    }

    // Emit completion
    let progress = SFTPTransferProgress {
        connection_id: connection_id.to_string(),
        remote_path: remote_path.to_string(),
        local_path: local_path.to_string(),
        bytes_transferred,
        total_bytes,
        direction: "upload".to_string(),
        status: "completed".to_string(),
        error: None,
    };
    let _ = app_handle.emit("ssh-transfer-progress", &progress);

    Ok(())
}

/// Read a remote file's content into a string (for editing)
pub fn read_file_to_string(sftp: &Sftp, remote_path: &str) -> Result<String, String> {
    let path = Path::new(remote_path);
    let mut file = sftp
        .open(path)
        .map_err(|e| format!("Failed to open remote file '{}': {}", remote_path, e))?;

    let mut contents = String::new();
    use std::io::Read;
    file.read_to_string(&mut contents)
        .map_err(|e| format!("Failed to read remote file '{}': {}", remote_path, e))?;

    Ok(contents)
}

/// Write content to a remote file (creates or overwrites)
pub fn write_file_from_string(sftp: &Sftp, remote_path: &str, content: &str) -> Result<(), String> {
    let path = Path::new(remote_path);
    let mut file = sftp
        .create(path)
        .map_err(|e| format!("Failed to create remote file '{}': {}", remote_path, e))?;

    use std::io::Write;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("Failed to write to remote file '{}': {}", remote_path, e))?;
    file.flush()
        .map_err(|e| format!("Failed to flush remote file '{}': {}", remote_path, e))?;

    Ok(())
}

/// Create an empty file on the remote
pub fn create_file(sftp: &Sftp, remote_path: &str) -> Result<(), String> {
    let path = Path::new(remote_path);
    // Check the remote filesystem, not the local filesystem.
    if sftp.stat(path).is_ok() {
        return Err(format!("File already exists: {}", remote_path));
    }

    let mut file = sftp
        .create(path)
        .map_err(|e| format!("Failed to create file '{}': {}", remote_path, e))?;
    use std::io::Write;
    file.flush().ok();
    Ok(())
}

/// Delete a remote file or empty directory
pub fn delete_path(sftp: &Sftp, remote_path: &str) -> Result<(), String> {
    let path = Path::new(remote_path);

    let stat = sftp
        .stat(path)
        .map_err(|e| format!("Failed to stat '{}': {}", remote_path, e))?;

    if stat.is_dir() {
        sftp.rmdir(path)
            .map_err(|e| format!("Failed to remove directory '{}': {}", remote_path, e))
    } else {
        sftp.unlink(path)
            .map_err(|e| format!("Failed to delete file '{}': {}", remote_path, e))
    }
}

/// Create a remote directory
pub fn mkdir(sftp: &Sftp, remote_path: &str) -> Result<(), String> {
    let path = Path::new(remote_path);
    sftp.mkdir(path, 0o755)
        .map_err(|e| format!("Failed to create directory '{}': {}", remote_path, e))
}

/// Rename a remote file or directory
pub fn rename(sftp: &Sftp, old_path: &str, new_path: &str) -> Result<(), String> {
    let old = Path::new(old_path);
    let new = Path::new(new_path);
    sftp.rename(old, new, None)
        .map_err(|e| format!("Failed to rename '{}' to '{}': {}", old_path, new_path, e))
}
