//! Why a store could not be opened or an operation was refused.

use std::io;
use std::path::PathBuf;

use crate::acp::atomic_file::NewerSchema;

/// Why `WebStore::open` refused to open the store file. Both variants are
/// startup-fatal for the host that hit them.
#[derive(Debug)]
pub enum WebStoreError {
    /// The file was written by a newer host (`schemaVersion` above
    /// `STORE_SCHEMA_VERSION`); it was not modified.
    NewerSchema(NewerSchema),
    /// An older (or unversioned) file could not be backed up before
    /// migration, so the migration was not attempted and the file was not
    /// modified.
    MigrationBackup { path: PathBuf, source: io::Error },
}

impl std::fmt::Display for WebStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NewerSchema(error) => write!(f, "web store {error}"),
            Self::MigrationBackup { path, source } => write!(
                f,
                "web store '{}' is an older schema and could not be backed up \
                 before migration: {source}; refusing to open it, the file was left untouched",
                path.display()
            ),
        }
    }
}

impl std::error::Error for WebStoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::NewerSchema(error) => Some(error),
            Self::MigrationBackup { source, .. } => Some(source),
        }
    }
}

/// Why a store operation was refused or failed.
#[derive(Debug)]
pub enum StoreError {
    /// The store could not be read at startup; nothing is served from it.
    Unavailable,
    /// The key is outside the three scopes or in another device's partition.
    Scope(String),
    /// A shared/lww key exists and the write named no `baseRevision`.
    BaseRequired,
    /// The shared key's current value is not the `expected` one (or, for a
    /// shared/lww delete, changed since `baseRevision`).
    CasFailed(String),
    /// The write would push the device partition past its byte budget.
    PartitionFull { used: usize, budget: u64 },
    /// A precondition the scope requires is missing or malformed.
    Invalid(String),
    /// The file could not be written (including the 10 MiB file cap).
    Io(io::Error),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable => write!(f, "server store is unavailable"),
            Self::Scope(message) | Self::CasFailed(message) | Self::Invalid(message) => {
                write!(f, "{message}")
            }
            Self::BaseRequired => write!(
                f,
                "this shared key already exists: read it first and send its revision as baseRevision"
            ),
            Self::PartitionFull { used, budget } => write!(
                f,
                "device partition would use {used} bytes (budget {budget}); delete something first"
            ),
            Self::Io(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<io::Error> for StoreError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}
