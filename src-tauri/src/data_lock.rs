//! One host per durable path (AD-14).
//!
//! Before any store is opened a host takes an exclusive advisory lock
//! (`std::fs::File::try_lock`, Rust 1.89+) on a SIDECAR lock file for every
//! canonical durable path it will use, and holds the locks for the life of the
//! process (drop = release; the OS also releases them if the process dies).
//!
//! The data files themselves are never locked: every store replaces its file
//! through temp + rename (`atomic_file::replace`), which changes the inode, and
//! on Windows `LockFileEx` is mandatory so locking a data file would break the
//! stores' own reads/renames. Sidecars are:
//!
//! - directory store (`state dir`, `sessions`, `acp-catalog`, …):
//!   `<dir>/.termul.lock`;
//! - single-file store (`store.json`, `projects.json`): `<file>.lock` next to
//!   the file.
//!
//! A second host that finds a lock held refuses to start with
//! [`DataLockError::Busy`], which names the path and says another Termul host
//! owns it. Lock paths are canonicalized and de-duplicated, so aliases and
//! symlinks of one path (and the same path named twice, e.g. a default that an
//! override also points at) are locked once — a second `try_lock` on a second
//! handle in the SAME process would otherwise fail against ourselves.
//!
//! This module is Tauri-free so `termul-server` and the desktop share it.

use std::collections::HashSet;
use std::fs::{self, File, TryLockError};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use crate::web::ServerConfig;

/// Upper bound on the bytes read from a rival's lock file to learn its pid.
const MAX_PID_RECORD_BYTES: usize = 256;

/// Sidecar lock file name inside a directory store.
pub const DIR_LOCK_FILE_NAME: &str = ".termul.lock";

/// File name of the desktop's web store under `app_data_dir`.
pub const DESKTOP_STORE_FILE_NAME: &str = "store.json";

/// File name of the desktop's durable project registry under `app_data_dir`.
pub const DESKTOP_PROJECTS_FILE_NAME: &str = "projects.json";

/// Directory of the verified ACP install root, under the state / app data dir.
pub const ACP_INSTALL_DIR_NAME: &str = "acp-registry-binaries";

/// Why a data path could not be locked.
#[derive(Debug)]
pub enum DataLockError {
    /// Another process holds the lock: another Termul host owns this path.
    Busy {
        /// The durable path the caller asked to protect.
        path: PathBuf,
        /// The sidecar lock file that is held.
        lock_file: PathBuf,
        /// PID recorded by the holder, when readable (advisory only).
        holder_pid: Option<u32>,
    },
    /// The lock file could not be created or locked for another reason.
    Io { path: PathBuf, source: io::Error },
}

impl std::fmt::Display for DataLockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Busy {
                path,
                lock_file,
                holder_pid,
            } => {
                write!(
                    f,
                    "data path '{}' is already in use by another Termul host (lock file '{}' is held",
                    path.display(),
                    lock_file.display()
                )?;
                if let Some(pid) = holder_pid {
                    write!(f, " by pid {pid}")?;
                }
                write!(
                    f,
                    "); stop the other host (desktop app or termul-server) or point this one at a different data directory"
                )
            }
            Self::Io { path, source } => write!(
                f,
                "could not lock data path '{}': {source}",
                path.display()
            ),
        }
    }
}

impl std::error::Error for DataLockError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Busy { .. } => None,
            Self::Io { source, .. } => Some(source),
        }
    }
}

impl DataLockError {
    /// `true` when another host owns the path (as opposed to an I/O fault).
    #[must_use]
    pub fn is_busy(&self) -> bool {
        matches!(self, Self::Busy { .. })
    }
}

/// The set of locks one host holds. Keep it alive for the whole process.
#[derive(Debug, Default)]
pub struct DataLocks {
    /// Canonical lock-file paths already held (de-duplication key).
    held: HashSet<PathBuf>,
    /// Open handles; dropping them releases the OS locks.
    files: Vec<File>,
}

impl DataLocks {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of distinct lock files held.
    #[must_use]
    pub fn len(&self) -> usize {
        self.held.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.held.is_empty()
    }

    /// Whether the canonical lock file `lock_file` is held by this value.
    #[must_use]
    pub fn holds(&self, lock_file: &Path) -> bool {
        self.held.contains(lock_file)
    }

    /// Lock a directory store: creates the directory if needed and locks
    /// `<dir>/.termul.lock`.
    pub fn lock_dir(&mut self, dir: &Path) -> Result<(), DataLockError> {
        create_private_dir_all(dir).map_err(|source| io_error(dir, source))?;
        let canonical = fs::canonicalize(dir).map_err(|source| io_error(dir, source))?;
        let lock_path = canonical.join(DIR_LOCK_FILE_NAME);
        self.acquire(&canonical, lock_path)
    }

    /// Lock a single-file store: creates the parent directory if needed and
    /// locks `<file>.lock` beside it. The data file itself is never opened.
    pub fn lock_file(&mut self, file: &Path) -> Result<(), DataLockError> {
        let parent = match file.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => parent,
            _ => Path::new("."),
        };
        let name = file.file_name().ok_or_else(|| {
            io_error(
                file,
                io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"),
            )
        })?;
        create_private_dir_all(parent).map_err(|source| io_error(file, source))?;
        // Resolve a symlinked data file to its real location so two aliases of
        // one file share one sidecar; a not-yet-created file is resolved via
        // its canonical parent.
        let target = match fs::canonicalize(file) {
            Ok(real) => real,
            Err(_) => fs::canonicalize(parent)
                .map_err(|source| io_error(file, source))?
                .join(name),
        };
        let mut lock_name = target
            .file_name()
            .map(std::ffi::OsStr::to_os_string)
            .unwrap_or_else(|| name.to_os_string());
        lock_name.push(".lock");
        let lock_path = target.with_file_name(lock_name);
        self.acquire(&target, lock_path)
    }

    fn acquire(&mut self, protected: &Path, lock_path: PathBuf) -> Result<(), DataLockError> {
        if self.held.contains(&lock_path) {
            return Ok(());
        }
        let mut options = fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        // The sidecar sits in a user-writable data dir: never follow a
        // symlink planted at its path (it would let the pid record clobber
        // the link target). `O_NOFOLLOW` makes the open fail with `ELOOP`.
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        let mut file = options
            .open(&lock_path)
            .map_err(|source| io_error(protected, source))?;
        match file.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => {
                // Advisory only: bounded read (the rival's file is untrusted
                // input) of the pid it recorded.
                let mut buf = Vec::with_capacity(MAX_PID_RECORD_BYTES);
                let _ = (&file)
                    .take(MAX_PID_RECORD_BYTES as u64)
                    .read_to_end(&mut buf);
                return Err(DataLockError::Busy {
                    path: protected.to_path_buf(),
                    lock_file: lock_path,
                    holder_pid: String::from_utf8_lossy(&buf)
                        .lines()
                        .next()
                        .and_then(|line| line.trim().parse().ok()),
                });
            }
            Err(TryLockError::Error(source)) => return Err(io_error(protected, source)),
        }
        // Advisory: record our pid so a refused host can name its rival.
        // Written at offset 0 and never truncating; readers parse only the
        // first line, so leftovers of an older, longer record are ignored.
        // `O_NOFOLLOW` does not stop a hard link planted at the sidecar path:
        // writing through it would overwrite the first bytes of the linked
        // file, so a multi-linked sidecar keeps its lock but gets no record.
        if has_other_links(&file) {
            tracing::warn!(
                "data lock: '{}' has several hard links; not recording the pid in it",
                lock_path.display()
            );
        } else {
            let record = file
                .seek(SeekFrom::Start(0))
                .and_then(|_| file.write_all(format!("{}\n", std::process::id()).as_bytes()));
            if let Err(error) = record {
                tracing::warn!(
                    "data lock: could not record pid in '{}': {error}",
                    lock_path.display()
                );
            }
        }
        tracing::info!(
            "data lock: acquired '{}' for '{}'",
            lock_path.display(),
            protected.display()
        );
        self.held.insert(lock_path);
        self.files.push(file);
        Ok(())
    }
}

/// `true` when the opened sidecar is reachable under more than one name (a
/// hard link). Where the link count is not available (non-Unix), this returns
/// `true`, so the host never writes the pid record through a sidecar it cannot
/// prove is a plain file. The pid record is advisory only.
fn has_other_links(file: &File) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        file.metadata().map(|meta| meta.nlink() > 1).unwrap_or(true)
    }
    #[cfg(not(unix))]
    {
        let _ = file;
        true
    }
}

fn io_error(path: &Path, source: io::Error) -> DataLockError {
    DataLockError::Io {
        path: path.to_path_buf(),
        source,
    }
}

/// `create_dir_all` with owner-only mode on Unix, matching the catalog and
/// install roots (a pre-existing directory keeps its permissions).
fn create_private_dir_all(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().mode(0o700).recursive(true).create(dir)
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(dir)
    }
}

/// The durable paths the standalone `termul-server` uses, resolved once from
/// its [`ServerConfig`] so locking, store opening and logging agree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StandalonePaths {
    pub state_dir: PathBuf,
    pub sessions_dir: Option<PathBuf>,
    pub projects_file: Option<PathBuf>,
    pub acp_catalog_dir: PathBuf,
    pub store_file: PathBuf,
}

impl StandalonePaths {
    #[must_use]
    pub fn resolve(cfg: &ServerConfig) -> Self {
        let state_dir = cfg.service_account_state_dir();
        Self {
            sessions_dir: cfg.sessions_dir.clone(),
            projects_file: cfg.projects_file.clone(),
            acp_catalog_dir: cfg
                .acp_catalog_dir
                .clone()
                .unwrap_or_else(|| state_dir.join("acp-catalog")),
            store_file: cfg
                .store_file
                .clone()
                .unwrap_or_else(|| state_dir.join("store.json")),
            state_dir,
        }
    }

    /// Lock the state dir and every store path this server will open. Must be
    /// called before any of them is opened.
    pub fn lock(&self) -> Result<DataLocks, DataLockError> {
        let mut locks = DataLocks::new();
        locks.lock_dir(&self.state_dir)?;
        if let Some(sessions) = &self.sessions_dir {
            locks.lock_dir(sessions)?;
        }
        if let Some(projects) = &self.projects_file {
            locks.lock_file(projects)?;
        }
        locks.lock_dir(&self.acp_catalog_dir)?;
        locks.lock_dir(&self.state_dir.join(ACP_INSTALL_DIR_NAME))?;
        locks.lock_file(&self.store_file)?;
        Ok(locks)
    }
}

/// Lock everything the desktop host keeps under `app_data_dir`: the directory
/// itself plus the stores a standalone server could be pointed at by override
/// (`acp-sessions`, `acp-catalog`, `acp-registry-binaries`,
/// `store.json`, `projects.json`), so an
/// override into the desktop's data dir is detected too.
pub fn lock_desktop_data(app_data_dir: &Path) -> Result<DataLocks, DataLockError> {
    let mut locks = DataLocks::new();
    locks.lock_dir(app_data_dir)?;
    locks.lock_dir(&app_data_dir.join("acp-sessions"))?;
    locks.lock_dir(&app_data_dir.join("acp-catalog"))?;
    locks.lock_dir(&app_data_dir.join(ACP_INSTALL_DIR_NAME))?;
    locks.lock_file(&desktop_store_file(app_data_dir))?;
    locks.lock_file(&desktop_projects_file(app_data_dir))?;
    Ok(locks)
}

/// Path of the desktop's (shared-live) web store.
#[must_use]
pub fn desktop_store_file(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(DESKTOP_STORE_FILE_NAME)
}

/// Path of the desktop's durable project registry.
#[must_use]
pub fn desktop_projects_file(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(DESKTOP_PROJECTS_FILE_NAME)
}

#[cfg(test)]
#[path = "data_lock_tests.rs"]
mod tests;
