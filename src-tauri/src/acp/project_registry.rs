//! File-backed project registry — the durable persistence layer of the host's
//! single `web::ProjectRegistry`.
//!
//! Every host (standalone `termul-server` via `--projects-file`, desktop via
//! `<app_data_dir>/projects.json`) opens its durable registry once at startup;
//! `web::ProjectRegistry` owns the in-memory read model and writes a candidate
//! through [`FileProjectRegistry::save_atomic`] before it swaps memory, so a
//! failed write leaves the registry exactly as it was. This module only knows
//! the on-disk shape, validation of roots and crash-safe writes.
//!
//! # Atomic writes + crash safety
//!
//! `save_atomic` writes a temp file **in the same directory** as the target,
//! `fsync`s the temp, then `rename`s it into place (atomic on POSIX, and
//! `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` on Windows), and (Unix-only)
//! `fsync`s the parent directory so the rename's directory-entry update is
//! durable. A corrupt present file is backed up before `load` errors out so
//! the operator can recover. The first write over an older schema keeps the
//! original in `<name>.pre-v<N>-<ts>.bak` (AD-18); a newer schema is never
//! read or overwritten.
//!
//! # No `web` imports (module-cycle invariant)
//!
//! The `web` module already depends on `acp` (`web::mod`/`router`/`ws` all use
//! `crate::acp::AcpManager`), so this module MUST NOT import anything from
//! `web` — that would close a `web -> acp -> web` cycle. Path validation is
//! therefore duplicated here as a std-only leaf (see `validate_root_path`)
//! rather than reaching back into `web::config::resolve_and_validate_project_root`.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use agent_client_protocol::schema::v1::McpServer;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

/// Current on-disk JSON schema version. Bump when the [`RegistryFile`] shape
/// changes; [`FileProjectRegistry::load`] routes any other version through
/// the [`migrate`] hook. v3 renamed `activeProjectId` → `defaultProjectId`
/// (the host default, distinct from any client's active selection); v2 files
/// deserialize transparently via `#[serde(alias = "activeProjectId")]`. v4
/// added `imported` (the desktop's one-shot import of the renderer's old
/// project list has run).
pub const SCHEMA_VERSION: u32 = 4;

/// A single VFS root served to the web client in VPS mode.
///
/// `path` is the canonical absolute project root (canonicalized + validated
/// to be a directory at load via [`validate_root_path`]). Public project
/// summaries omit all MCP details; the file may contain MCP environment values
/// because it is a server-local operator configuration, not a web payload.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VfsRoot {
    /// Stable project id (the operator-chosen key; must be unique within the file).
    pub id: String,
    /// Display name.
    pub name: String,
    /// Canonical absolute project root (validated at load to exist + be a dir).
    pub path: PathBuf,
    /// Color token (one of the desktop `ProjectColor` literals, as a string).
    pub color: String,
    /// `true` when the project is archived (rendered greyed, not switchable).
    pub is_archived: bool,
    /// Project-scoped MCP attachments passed to ACP `session/new`.
    /// This field is never mapped into the public web project summary or logs.
    #[serde(default)]
    pub mcp_servers: Vec<McpServer>,
}

/// On-disk JSON schema for the registry file. CamelCase wire casing (consistent
/// with `web::project_registry`'s wire types). `schema_version` gates loading.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RegistryFile {
    /// Schema version; must equal [`SCHEMA_VERSION`] (routed through [`migrate`]).
    pub schema_version: u32,
    /// The host's default project id (seeds new web clients' initial
    /// `activeProjectId`), or `None` when none is set. v2 files used the
    /// field name `activeProjectId`; the serde alias deserializes both names
    /// transparently so a v2 file loads without a manual rename step.
    #[serde(
        default,
        alias = "activeProjectId",
        skip_serializing_if = "Option::is_none"
    )]
    pub default_project_id: Option<String>,
    /// The VFS roots (non-archived + archived; the web list shows both).
    pub projects: Vec<VfsRoot>,
    /// `true` once the desktop's one-shot import of the renderer's old
    /// project list has run (v4). Files written before v4 read `false`.
    #[serde(default)]
    pub imported: bool,
}

/// In-memory loaded form of the registry file (post-load + post-validation).
///
/// Built by [`FileProjectRegistry::load`] from a `RegistryFile` (schema
/// checked, roots validated) and by the host registry as the candidate it
/// writes through [`FileProjectRegistry::save_atomic`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileProjectRegistry {
    roots: Vec<VfsRoot>,
    default_project_id: Option<String>,
    imported: bool,
}

/// How [`FileProjectRegistry::load_with`] treats a root whose path cannot be
/// resolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RootCheck {
    /// Fail the load (`InvalidRoot`): a misconfigured VPS aborts startup.
    Strict,
    /// Keep the root as stored (an empty path means "no working directory");
    /// a moved or deleted directory stays in the list and the boundary
    /// rechecks it lazily. Used by the desktop, where a project folder that
    /// is currently unmounted must not take the whole list down.
    Lenient,
}

/// Load / save failure for [`FileProjectRegistry`].
#[derive(Debug)]
pub enum ProjectRegistryError {
    /// Filesystem read/write failure (permission, disk full, cross-device rename, …).
    Io(io::Error),
    /// The file exists but is not a valid `RegistryFile` (a `.corrupt-<ts>.bak`
    /// copy is stashed alongside before this is returned — see [`load`]).
    Parse(serde_json::Error),
    /// The file's `schema_version` does not equal [`SCHEMA_VERSION`].
    BadSchemaVersion {
        /// Expected ([`SCHEMA_VERSION`]).
        expected: u32,
        /// Found in the file.
        found: u32,
    },
    /// A `VfsRoot` path failed validation (missing / not a directory). Fail-first
    /// so a misconfigured VPS aborts startup clearly rather than routing agent
    /// fs ops outside the intended jail.
    InvalidRoot {
        /// The offending root's id.
        id: String,
        /// Why the path was rejected (canonicalize / not-a-directory message).
        reason: String,
    },
}

impl std::fmt::Display for ProjectRegistryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "registry io error: {e}"),
            Self::Parse(e) => write!(f, "registry file is corrupt (invalid JSON): {e}"),
            Self::BadSchemaVersion { expected, found } => write!(
                f,
                "registry schema version mismatch: expected {expected}, found {found}"
            ),
            Self::InvalidRoot { id, reason } => {
                write!(f, "registry root '{id}' is invalid: {reason}")
            }
        }
    }
}

impl std::error::Error for ProjectRegistryError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(e) => Some(e),
            Self::Parse(e) => Some(e),
            Self::BadSchemaVersion { .. } | Self::InvalidRoot { .. } => None,
        }
    }
}

impl FileProjectRegistry {
    /// An empty registry (no roots, no default project, nothing imported).
    /// The Ok path for a missing registry file.
    #[must_use]
    pub fn empty() -> Self {
        Self {
            roots: Vec::new(),
            default_project_id: None,
            imported: false,
        }
    }

    /// Build a registry from already-loaded roots + a default id. Used by
    /// tests that construct the registry in memory rather than from a file.
    ///
    /// Drops `default_project_id` to `None` when it references a project not
    /// in `roots` (P4: no dangling default — a stale id left by a deleted
    /// project must not survive into the in-memory registry).
    #[cfg(test)]
    #[must_use]
    pub fn from_roots(roots: Vec<VfsRoot>, default_project_id: Option<String>) -> Self {
        let default_project_id = default_project_id.filter(|id| {
            roots
                .iter()
                .any(|r| r.id == *id && !r.is_archived && !r.path.as_os_str().is_empty())
        });
        Self {
            roots,
            default_project_id,
            imported: false,
        }
    }

    /// Build the candidate the host registry writes through
    /// [`save_atomic`](Self::save_atomic). The caller has already normalized
    /// `default_project_id`, so nothing is filtered here.
    #[must_use]
    pub fn from_parts(
        roots: Vec<VfsRoot>,
        default_project_id: Option<String>,
        imported: bool,
    ) -> Self {
        Self {
            roots,
            default_project_id,
            imported,
        }
    }

    /// Load + validate a registry file, failing on a root whose path cannot
    /// be resolved ([`RootCheck::Strict`]; the standalone server's posture).
    #[cfg(test)]
    pub fn load(path: &Path) -> Result<Self, ProjectRegistryError> {
        Self::load_with(path, RootCheck::Strict)
    }

    /// Load + validate a registry file.
    ///
    /// - **Missing file → `Ok(empty)`**: not fatal; the host serves an empty
    ///   list and creates the file on its first write.
    /// - **Corrupt file → `Err(Parse)`**: the bad file is copied aside to
    ///   `<path>.corrupt-<nanos>.bak` BEFORE returning so the operator can
    ///   recover (best-effort; a backup failure only warns).
    /// - **Bad schema version → `Err(BadSchemaVersion)`** via the [`migrate`]
    ///   hook: older versions upgrade in memory (the first write keeps the
    ///   original, AD-18); a newer version is refused.
    /// - **Invalid root**: with [`RootCheck::Strict`] → `Err(InvalidRoot)`
    ///   (canonicalize + must be a directory, fail-first). With
    ///   [`RootCheck::Lenient`] the root is kept (canonicalized when it
    ///   resolves, as stored otherwise).
    pub fn load_with(path: &Path, check: RootCheck) -> Result<Self, ProjectRegistryError> {
        let bytes = match fs::read(path) {
            Ok(b) => b,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                info!(
                    "projects file '{}' not found; starting with an empty project list",
                    path.display()
                );
                return Ok(Self::empty());
            }
            Err(e) => return Err(ProjectRegistryError::Io(e)),
        };

        // A newer schema is refused before it is parsed as this version's
        // shape: it is neither read nor backed up as corrupt.
        if let Some(found) = crate::acp::atomic_file::peek_schema_version(&bytes) {
            if found > SCHEMA_VERSION {
                return Err(ProjectRegistryError::BadSchemaVersion {
                    expected: SCHEMA_VERSION,
                    found,
                });
            }
        }
        let file: RegistryFile = match serde_json::from_slice(&bytes) {
            Ok(f) => f,
            Err(e) => {
                backup_corrupt(path, &bytes);
                return Err(ProjectRegistryError::Parse(e));
            }
        };

        // Route any non-current schema through the migration hook (v1/v2/v3
        // upgrade to v4; unknown versions fail).
        let file = if file.schema_version != SCHEMA_VERSION {
            migrate(file.schema_version, file)?
        } else {
            file
        };

        let mut roots = Vec::with_capacity(file.projects.len());
        for mut root in file.projects {
            match check {
                // Fail-first on a bad root: canonicalize + must-be-a-directory
                // so the boundary check is stable and a misconfigured VPS
                // aborts startup.
                RootCheck::Strict => {
                    root.path = validate_root_path(&root.path).map_err(|reason| {
                        ProjectRegistryError::InvalidRoot {
                            id: root.id.clone(),
                            reason,
                        }
                    })?;
                }
                RootCheck::Lenient => {
                    if let Ok(canonical) = validate_root_path(&root.path) {
                        root.path = canonical;
                    } else if !root.path.as_os_str().is_empty() {
                        warn!(
                            project_id = root.id.as_str(),
                            "registered project path cannot be resolved; keeping it and rechecking lazily"
                        );
                    }
                }
            }
            roots.push(root);
        }

        // P4: drop a default_project_id that references a project not in the
        // loaded roots (a stale id left by a deleted project must not survive
        // into the in-memory registry). Also reject archived/empty-path
        // defaults (not switchable).
        let default_project_id = file.default_project_id.filter(|id| {
            roots
                .iter()
                .any(|r| r.id == *id && !r.is_archived && !r.path.as_os_str().is_empty())
        });

        Ok(Self {
            roots,
            default_project_id,
            imported: file.imported,
        })
    }

    /// Persist the registry atomically (AC1: temp + rename + fsync).
    ///
    /// Writes a temp file `<path>.<pid>.<nanos>.tmp` **in the same directory**
    /// as `path` (same-filesystem so `rename` is atomic; cross-device rename
    /// fails `CrossesDevices`), `fsync`s the temp, then `rename`s it into place.
    /// On Unix the parent directory is `fsync`d so the rename's directory-entry
    /// update is durable. The temp uses `create_new(true)` (stable since the
    /// crate MSRV 1.85) so concurrent writers fail loudly on a name collision
    /// rather than trampling each other. On any failure the temp is removed.
    pub fn save_atomic(&self, path: &Path) -> Result<(), ProjectRegistryError> {
        let file = RegistryFile {
            schema_version: SCHEMA_VERSION,
            default_project_id: self.default_project_id.clone(),
            projects: self.roots.clone(),
            imported: self.imported,
        };
        let bytes = serde_json::to_vec_pretty(&file).map_err(ProjectRegistryError::Parse)?;

        // AD-18: `load` migrates older schemas in memory only. The first write
        // after that replaces the old-schema bytes, so preserve them in
        // `<name>.pre-v<N>-<ts>.bak` first; a backup failure aborts the write
        // (no migration without a recoverable original). A newer-schema file
        // is never overwritten (same refusal `load` gives it).
        match fs::read(path) {
            Ok(existing) => match crate::acp::atomic_file::peek_schema_version(&existing) {
                Some(found) if found > SCHEMA_VERSION => {
                    warn!(
                        "refusing to overwrite projects file '{}': schema version {found} is newer than {SCHEMA_VERSION}",
                        path.display()
                    );
                    return Err(ProjectRegistryError::BadSchemaVersion {
                        expected: SCHEMA_VERSION,
                        found,
                    });
                }
                // Only versions `migrate` knows (1, 2, 3) may be rewritten;
                // any other lower version (e.g. 0) is rejected exactly as
                // `load` rejects it, never backed up and overwritten.
                Some(found) if found < SCHEMA_VERSION && !matches!(found, 1..=3) => {
                    warn!(
                        "refusing to overwrite projects file '{}': unsupported schema version {found}",
                        path.display()
                    );
                    return Err(ProjectRegistryError::BadSchemaVersion {
                        expected: SCHEMA_VERSION,
                        found,
                    });
                }
                Some(found) if found < SCHEMA_VERSION => {
                    let backup = crate::acp::atomic_file::backup_pre_migration(
                        path,
                        &existing,
                        SCHEMA_VERSION,
                    )
                    .map_err(|e| {
                        warn!(
                            "could not back up projects file '{}' before migrating v{found} -> v{SCHEMA_VERSION}: {e}",
                            path.display()
                        );
                        ProjectRegistryError::Io(e)
                    })?;
                    info!(
                        "migrating projects file '{}' v{found} -> v{SCHEMA_VERSION}; original saved to '{}'",
                        path.display(),
                        backup.display()
                    );
                }
                _ => {}
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(ProjectRegistryError::Io(e)),
        }

        crate::acp::atomic_file::replace(path, &bytes).map_err(ProjectRegistryError::Io)
    }

    /// The loaded VFS roots (canonicalized paths).
    #[must_use]
    pub fn roots(&self) -> &[VfsRoot] {
        &self.roots
    }

    /// The host's default project id, or `None`.
    #[must_use]
    pub fn default_project_id(&self) -> Option<&str> {
        self.default_project_id.as_deref()
    }

    /// `true` once the desktop's one-shot import has run.
    #[must_use]
    pub fn imported(&self) -> bool {
        self.imported
    }

    /// `true` when the registry holds no roots.
    #[cfg(test)]
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.roots.is_empty()
    }
}

/// Single schema migration seam. v1, v2 and v3 upgrade in memory to v4;
/// unknown versions are rejected without reinterpretation.
///
/// - v1 had the same project fields except project-scoped MCP servers, which
///   deserialize with `default`.
/// - v2 → v3 renamed `activeProjectId` → `defaultProjectId`; the serde alias
///   on `RegistryFile.default_project_id` reads both names, so only the
///   version moves.
/// - v3 → v4 added `imported`, which reads `false` from an older file.
fn migrate(from: u32, mut file: RegistryFile) -> Result<RegistryFile, ProjectRegistryError> {
    match from {
        1..=3 => {
            file.schema_version = SCHEMA_VERSION;
            Ok(file)
        }
        _ => Err(ProjectRegistryError::BadSchemaVersion {
            expected: SCHEMA_VERSION,
            found: from,
        }),
    }
}

/// Validate a raw VFS-root path: canonicalize (exists + accessible) and require
/// a directory. Mirrors `web::config::resolve_and_validate_project_root` but is
/// duplicated here as a std-only leaf so this module never imports `web::*`
/// (the `web -> acp -> web` cycle invariant). Returns the canonical absolute
/// path on success, or an operator-facing message on failure.
pub fn validate_root_path(raw: &Path) -> Result<PathBuf, String> {
    let canonical = raw
        .canonicalize()
        .map_err(|e| format!("project root '{}' is not accessible: {e}", raw.display()))?;
    if !canonical.is_dir() {
        return Err(format!(
            "project root '{}' is not a directory",
            canonical.display()
        ));
    }
    Ok(canonical)
}

/// Best-effort backup of a corrupt registry file before `load` errors out.
/// Writes `<path>.corrupt-<nanos>.bak` alongside the bad file (same directory
/// so it's recoverable). Never returns an error — the parse error is the real
/// signal; a backup failure only warns.
fn backup_corrupt(path: &Path, bytes: &[u8]) {
    let bak = path.with_file_name(format!(
        "{}.corrupt-{}.bak",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("registry"),
        now_nanos()
    ));
    match fs::write(&bak, bytes) {
        Ok(()) => warn!(
            "backed up corrupt registry file '{}' -> '{}'",
            path.display(),
            bak.display()
        ),
        Err(e) => warn!(
            "could not back up corrupt registry file '{}': {e}",
            path.display()
        ),
    }
}

/// Monotonic-ish nanos suffix for unique temp/backup names (best-effort; 0 on
/// clock failure). Reuses the same hand-rolled pattern as `web::config`'s
/// `tempdir_like` (no `tempfile` dev-dep in this crate).
fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests;
