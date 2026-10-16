//! Shared crash-consistent same-directory atomic file replacement.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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

/// Atomically create `path` with `bytes`, failing `AlreadyExists` when the
/// destination already exists — never clobbers. Same temp+sync discipline as
/// `replace`; the atomic step is a same-directory hard link, which only
/// succeeds when the target is absent on Linux, macOS, and Windows/NTFS.
/// Non-`AlreadyExists` link failures propagate: callers decide whether an
/// unwritable or linkless filesystem is tolerable.
pub fn create_new(path: &Path, bytes: &[u8]) -> io::Result<()> {
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
        fs::hard_link(&tmp, path)?;
        #[cfg(unix)]
        {
            fs::File::open(parent)?.sync_all()?;
        }
        Ok(())
    })();
    let _ = fs::remove_file(&tmp);
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
        match write_new_synced(&backup, bytes) {
            Ok(()) => return Ok(backup),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate corrupt backup name",
    ))
}

/// Preserve the pre-migration bytes of `path` before the first write in schema
/// version `to_version` (AD-18): `<name>.pre-v<to_version>-<unix-secs>.bak`,
/// with a `-<n>` suffix when that name is taken (two migrations in one second
/// never overwrite each other). Created with `create_new`, fully written and
/// synced. Callers MUST abort the migration when this fails — a migration
/// without a recoverable original is not allowed.
pub fn backup_pre_migration(path: &Path, bytes: &[u8], to_version: u32) -> io::Result<PathBuf> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::other(format!("backup target '{}' has no parent", path.display()))
    })?;
    fs::create_dir_all(parent)?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("artifact");
    let unix_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    for attempt in 0..1000u32 {
        let suffix = if attempt == 0 {
            String::new()
        } else {
            format!("-{attempt}")
        };
        let backup =
            path.with_file_name(format!("{name}.pre-v{to_version}-{unix_secs}{suffix}.bak"));
        match write_new_synced(&backup, bytes) {
            Ok(()) => return Ok(backup),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate pre-migration backup name",
    ))
}

/// Create `path` (never clobbering), write, sync, and sync the parent
/// directory (unix) so the new directory entry is durable, like [`replace`].
/// Backups hold the same secrets as the file they preserve (MCP env, tokens),
/// so on unix they are created owner-only (`0600`) regardless of umask.
fn write_new_synced(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.flush()?;
    file.sync_all()?;
    drop(file);
    #[cfg(unix)]
    {
        if let Some(parent) = path.parent() {
            let parent = if parent.as_os_str().is_empty() {
                Path::new(".")
            } else {
                parent
            };
            fs::File::open(parent)?.sync_all()?;
        }
    }
    Ok(())
}

/// A store file written by a NEWER host than this one (AD-18: a host refuses,
/// with a visible error, to open a store whose schema it does not understand;
/// the file is never rewritten or backed up).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewerSchema {
    pub path: PathBuf,
    pub found: u32,
    pub supported: u32,
}

impl NewerSchema {
    /// `Err` when `bytes` carry a `schemaVersion` greater than `supported`.
    /// Bytes without a readable `schemaVersion` pass (the caller's own
    /// decoder classifies them as legacy or corrupt).
    pub fn check(path: &Path, bytes: &[u8], supported: u32) -> Result<(), Self> {
        match peek_schema_version(bytes) {
            Some(found) if found > supported => Err(Self {
                path: path.to_path_buf(),
                found,
                supported,
            }),
            _ => Ok(()),
        }
    }
}

impl NewerSchema {
    /// Carry this refusal through an `io::Result` API (kind `InvalidData`);
    /// recover it with [`NewerSchema::from_io`].
    #[must_use]
    pub fn into_io_error(self) -> io::Error {
        io::Error::new(io::ErrorKind::InvalidData, self)
    }

    /// The typed refusal inside `error`, when it came from
    /// [`NewerSchema::into_io_error`].
    #[must_use]
    pub fn from_io(error: &io::Error) -> Option<&Self> {
        error.get_ref()?.downcast_ref::<Self>()
    }
}

impl std::fmt::Display for NewerSchema {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "'{}' was written by a newer Termul (schema version {}, this build understands up to {}); \
             refusing to open it. Upgrade Termul or restore a backup; the file was left untouched",
            self.path.display(),
            self.found,
            self.supported
        )
    }
}

impl std::error::Error for NewerSchema {}

/// The numeric top-level `schemaVersion` of a JSON document, or `None` when
/// the bytes are not a JSON object carrying one. Decoded loosely so a future
/// shape that no longer fits today's structs is still recognised as "newer"
/// rather than "corrupt".
pub fn peek_schema_version(bytes: &[u8]) -> Option<u32> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let version = value.as_object()?.get("schemaVersion")?.as_u64()?;
    Some(u32::try_from(version).unwrap_or(u32::MAX))
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

/// Whether `path` is a temp file [`replace`] or [`create_new`] made for a
/// target named `target_name`, last written more than `max_age` ago.
pub fn is_stale_temp(path: &Path, target_name: &str, max_age: Duration) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| is_temp_name(name, target_name))
        && fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > max_age)
}

fn is_temp_name(file_name: &str, target_name: &str) -> bool {
    let Some(stamp) = file_name
        .strip_prefix(target_name)
        .and_then(|rest| rest.strip_prefix('.'))
        .and_then(|rest| rest.strip_suffix(".tmp"))
    else {
        return false;
    };
    let mut parts = stamp.split('.');
    let mut numeric = || {
        parts
            .next()
            .is_some_and(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
    };
    numeric() && numeric() && parts.next().is_none()
}

fn unique_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests;
