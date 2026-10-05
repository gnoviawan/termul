//! Shared crash-consistent same-directory atomic file replacement.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Atomically replace `path` with `bytes` using a same-directory temp file.
///
/// The temp is created with `create_new`, fully written, flushed and synced,
/// closed, then renamed over the destination. Unix additionally syncs the
/// parent directory. Windows replacement/open-sharing failures are returned to
/// the caller; no portable parent-directory fsync claim is made there.
pub fn replace(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::other(format!("atomic target '{}' has no parent", path.display()))
    })?;
    fs::create_dir_all(parent)?;

    let tmp = temp_path(path);
    let write_result = (|| -> io::Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        file.write_all(bytes)?;
        file.flush()?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)?;
        #[cfg(unix)]
        {
            fs::File::open(parent)?.sync_all()?;
        }
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    write_result
}

/// Preserve a bad artifact alongside the original with a collision-safe name.
pub fn backup_corrupt(path: &Path, bytes: &[u8]) -> io::Result<PathBuf> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::other(format!("backup target '{}' has no parent", path.display()))
    })?;
    fs::create_dir_all(parent)?;
    for attempt in 0..1000u32 {
        let backup = path.with_file_name(format!(
            "{}.corrupt-{}-{attempt}.bak",
            path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("artifact"),
            unique_suffix()
        ));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&backup)
        {
            Ok(mut file) => {
                file.write_all(bytes)?;
                file.flush()?;
                file.sync_all()?;
                return Ok(backup);
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate corrupt backup name",
    ))
}

fn temp_path(path: &Path) -> PathBuf {
    path.with_file_name(format!(
        "{}.{}.{}.tmp",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("artifact"),
        std::process::id(),
        unique_suffix()
    ))
}

fn unique_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests;
