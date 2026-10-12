//! `expected` precondition of `POST /fs/write` and the `contentHash` of
//! `GET /fs/read`: a write that names the content it replaces (`{sha256}`) or
//! the absence of the file (`"absent"`) is refused with `PRECONDITION_FAILED`
//! when the file changed since it was read, and nothing is written.
//!
//! The check and the write run under one lock per path and the write is atomic
//! (temp file in the same directory + rename), so a reader never sees a torn
//! file and two checked writers of one path cannot both pass the same check.
//!
//! A symlink at the path is followed first, so the link's target is updated and
//! the link survives. A rename replaces the inode: hard links to the old file
//! keep the old content and a file's owner/ACLs are not carried over (its
//! permission bits are).

use std::collections::HashMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use parking_lot::Mutex;
use serde::{Deserialize, Deserializer};
use sha2::{Digest, Sha256};

use super::IpcBody;

/// Locks of paths with a checked write in flight; entries nobody holds are
/// pruned once the map grows past [`PRUNE_ABOVE`].
static PATH_LOCKS: LazyLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
const PRUNE_ABOVE: usize = 256;

/// Lower-case hex sha256 of `bytes` (the `contentHash` of `/fs/read` and the
/// `sha256` of an `expected` precondition).
#[must_use]
pub fn sha256_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    Sha256::digest(bytes)
        .iter()
        .fold(String::with_capacity(64), |mut out, byte| {
            let _ = write!(out, "{byte:02x}");
            out
        })
}

/// What a checked write requires of the file as it is now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Expected {
    /// The file does not exist (`"absent"`).
    Absent,
    /// The file's bytes hash to this sha256 hex (`{"sha256": "..."}`).
    Sha256(String),
}

impl<'de> Deserialize<'de> for Expected {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Wire {
            Marker(String),
            Hash { sha256: String },
        }
        match Wire::deserialize(deserializer)? {
            Wire::Marker(marker) if marker == "absent" => Ok(Self::Absent),
            Wire::Marker(other) => Err(serde::de::Error::custom(format!(
                "expected must be \"absent\" or {{\"sha256\": ...}}, got \"{other}\""
            ))),
            Wire::Hash { sha256 } if sha256.len() == 64 && sha256.bytes().all(|b| b.is_ascii_hexdigit()) => {
                Ok(Self::Sha256(sha256.to_ascii_lowercase()))
            }
            Wire::Hash { .. } => Err(serde::de::Error::custom(
                "expected.sha256 must be 64 hex characters",
            )),
        }
    }
}

/// How a checked write ended.
#[derive(Debug, PartialEq, Eq)]
pub enum CheckedWrite {
    /// The content is on disk now (written, or already there: see
    /// `already_applied`).
    Written,
    /// The file no longer matches `expected`; nothing was written.
    Stale,
}

fn lock_for(path: &Path) -> Arc<Mutex<()>> {
    let mut locks = PATH_LOCKS.lock();
    if locks.len() > PRUNE_ABOVE {
        locks.retain(|_, lock| Arc::strong_count(lock) > 1);
    }
    Arc::clone(locks.entry(path.to_path_buf()).or_default())
}

/// Write `content` to `path` if the file still matches `expected`.
///
/// `already_applied`: a resend of the same command (it carries a `commandId`)
/// finds the content it wrote already on disk and its `expected` no longer
/// matching; that is the first run's effect, not a conflict, so it answers
/// `Written` without touching the file.
pub fn write_checked(
    path: &Path,
    content: &[u8],
    expected: &Expected,
    already_applied: bool,
) -> io::Result<CheckedWrite> {
    let resolved = resolve_symlink(path);
    let path = resolved.as_path();
    let lock = lock_for(path);
    let _held = lock.lock();
    let current = match fs::read(path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    let matches = match (expected, &current) {
        (Expected::Absent, None) => true,
        (Expected::Sha256(hash), Some(bytes)) => sha256_hex(bytes) == *hash,
        _ => false,
    };
    if !matches {
        return Ok(
            if already_applied && current.as_deref() == Some(content) {
                CheckedWrite::Written
            } else {
                CheckedWrite::Stale
            },
        );
    }
    write_atomic(path, content, current.is_some())?;
    Ok(CheckedWrite::Written)
}

/// The file a write to `path` must update: the symlink's target when `path` is
/// a link (a dangling link resolves to where it points), else `path` itself.
fn resolve_symlink(path: &Path) -> PathBuf {
    if !fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return path.to_path_buf();
    }
    fs::canonicalize(path).unwrap_or_else(|_| match fs::read_link(path) {
        Ok(target) if target.is_absolute() => target,
        Ok(target) => path.parent().map_or(target.clone(), |dir| dir.join(&target)),
        Err(_) => path.to_path_buf(),
    })
}

/// Temp file next to `path`, then rename over it. An existing file keeps its
/// permissions.
fn write_atomic(path: &Path, content: &[u8], keep_permissions: bool) -> io::Result<()> {
    let parent = path.parent().filter(|p| !p.as_os_str().is_empty());
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    let mut temp_name = std::ffi::OsString::from(".");
    temp_name.push(name);
    temp_name.push(format!(".termul-{}-{nanos}.tmp", std::process::id()));
    let temp = match parent {
        Some(dir) => dir.join(&temp_name),
        None => PathBuf::from(&temp_name),
    };
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(content)?;
        file.sync_all()?;
        drop(file);
        if keep_permissions {
            if let Ok(metadata) = fs::metadata(path) {
                fs::set_permissions(&temp, metadata.permissions())?;
            }
        }
        fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

/// The effect of `POST /fs/write`: a plain write without `expected`, a checked
/// one with it. `has_command_id`: the request is a resend candidate (see
/// [`write_checked`]).
pub async fn write_effect(
    path: PathBuf,
    content: String,
    expected: Option<Expected>,
    has_command_id: bool,
) -> IpcBody<()> {
    let result = tokio::task::spawn_blocking(move || match expected {
        None => fs::write(&path, content.as_bytes()).map(|()| CheckedWrite::Written),
        Some(expected) => write_checked(&path, content.as_bytes(), &expected, has_command_id),
    })
    .await;
    match result {
        Ok(Ok(CheckedWrite::Written)) => IpcBody::ok(()),
        Ok(Ok(CheckedWrite::Stale)) => IpcBody::err(
            "the file changed since it was read; nothing was written",
            crate::web::command_ledger::PRECONDITION_FAILED_CODE,
        ),
        Ok(Err(e)) => IpcBody::err(format!("{e}"), "WRITE_ERROR"),
        Err(e) => IpcBody::err(format!("write task failed: {e}"), "WRITE_ERROR"),
    }
}

#[cfg(test)]
#[path = "precondition_tests.rs"]
mod tests;
