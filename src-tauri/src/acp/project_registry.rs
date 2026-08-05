//! File-backed project registry (VPS-mode-only) — server-owned VFS roots.
//!
//! The standalone `termul-server` binary loads this at startup so the web
//! client can list and switch between the operator's projects without the
//! browser holding any project state. The registry is the source of truth for
//! the `GET /projects` list and the `switch_project` WS request's cwd
//! resolution in VPS mode.
//!
//! # VPS-mode-only scope (architecture Gap #3)
//!
//! Desktop-hosted shared-live mode queries the live desktop `AcpManager` via
//! the in-memory `web::project_registry` renderer-fed bridge; this file is
//! NOT consulted there. The two registries are complementary, never
//! co-existing at runtime:
//!
//! - **VPS mode** (this module): the standalone binary has no desktop renderer
//!   to feed it, so it loads VFS roots from a JSON file at startup and seeds
//!   the in-memory `web::ProjectRegistry` from it (see `server_main.rs`).
//! - **Desktop-hosted mode**: `remote_sync_projects` pushes the renderer's
//!   project list into the in-memory `web::ProjectRegistry`; this file is
//!   never loaded.
//!
//! # Atomic writes + crash safety
//!
//! `save_atomic` writes a temp file **in the same directory** as the target,
//! `fsync`s the temp, then `rename`s it into place (atomic on POSIX, and
//! `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` on Windows), and (Unix-only)
//! `fsync`s the parent directory so the rename's directory-entry update is
//! durable. A corrupt present file is backed up before `load` errors out so
//! the operator can recover.
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
/// deserialize transparently via `#[serde(alias = "activeProjectId")]`.
pub const SCHEMA_VERSION: u32 = 3;

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
    #[serde(default, alias = "activeProjectId", skip_serializing_if = "Option::is_none")]
    pub default_project_id: Option<String>,
    /// The VFS roots (non-archived + archived; the web list shows both).
    pub projects: Vec<VfsRoot>,
}

/// In-memory loaded form of the registry (post-load + post-validation).
///
/// Built by [`load`] from a `RegistryFile` (paths canonicalized, schema
/// checked, roots validated). The standalone binary retains this registry so a
/// successful `set_default_project` can persist the default id with
/// [`save_atomic`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileProjectRegistry {
    roots: Vec<VfsRoot>,
    default_project_id: Option<String>,
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
    /// Active-project mutation targeted a root that is not switchable.
    InvalidActiveProject {
        /// Requested project id.
        id: String,
        /// Stable operator-facing reason.
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
            Self::InvalidActiveProject { id, reason } => {
                write!(f, "project '{id}' cannot become active: {reason}")
            }
        }
    }
}

impl std::error::Error for ProjectRegistryError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(e) => Some(e),
            Self::Parse(e) => Some(e),
            Self::BadSchemaVersion { .. }
            | Self::InvalidRoot { .. }
            | Self::InvalidActiveProject { .. } => None,
        }
    }
}

impl FileProjectRegistry {
    /// An empty registry (no roots, no default project). The Ok path for a
    /// missing registry file — the binary still serves; `GET /projects`
    /// returns an empty list.
    #[must_use]
    pub fn empty() -> Self {
        Self {
            roots: Vec::new(),
            default_project_id: None,
        }
    }

    /// Build a registry from already-loaded roots + a default id. Used by
    /// tests and seeders that construct the registry in-memory rather than
    /// from a file; the VPS runtime path is [`load`](Self::load).
    ///
    /// Drops `default_project_id` to `None` when it references a project not
    /// in `roots` (P4: no dangling default — a stale id left by a deleted
    /// project must not survive into the in-memory registry).
    #[must_use]
    pub fn from_roots(roots: Vec<VfsRoot>, default_project_id: Option<String>) -> Self {
        let default_project_id = default_project_id.filter(|id| {
            roots.iter().any(|r| {
                r.id == *id && !r.is_archived && !r.path.as_os_str().is_empty()
            })
        });
        Self {
            roots,
            default_project_id,
        }
    }

    /// Load + validate a registry file.
    ///
    /// - **Missing file → `Ok(empty)`**: a missing `--projects-file` is not a
    ///   fatal server error; `/projects` returns an empty list (the in-memory
    ///   bridge's "empty is valid success" semantics). An `info!` log surfaces it.
    /// - **Corrupt file → `Err(Parse)`**: the bad file is copied aside to
    ///   `<path>.corrupt-<nanos>.bak` BEFORE returning so the operator can
    ///   recover (best-effort; a backup failure only warns).
    /// - **Bad schema version → `Err(BadSchemaVersion)`** via the [`migrate`]
    ///   hook (today: reject; future: upgrade in-memory).
    /// - **Invalid root → `Err(InvalidRoot)`** (fail-first): each `VfsRoot.path`
    ///   is canonicalized + must be a directory so the fs boundary check is
    ///   stable and a misconfigured VPS aborts startup clearly.
    pub fn load(path: &Path) -> Result<Self, ProjectRegistryError> {
        let bytes = match fs::read(path) {
            Ok(b) => b,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                info!(
                    "projects file '{}' not found; serving an empty project list",
                    path.display()
                );
                return Ok(Self::empty());
            }
            Err(e) => return Err(ProjectRegistryError::Io(e)),
        };

        let file: RegistryFile = match serde_json::from_slice(&bytes) {
            Ok(f) => f,
            Err(e) => {
                backup_corrupt(path, &bytes);
                return Err(ProjectRegistryError::Parse(e));
            }
        };

        // Route any non-current schema through the migration hook. v1/v2
        // upgrade to v3: v1→v2 added empty per-project MCP configuration;
        // v2→v3 renamed `activeProjectId` → `defaultProjectId` (the serde
        // alias on the field handles the rename transparently, so the migrate
        // arm only bumps the version). Unknown versions fail.
        let file = if file.schema_version != SCHEMA_VERSION {
            migrate(file.schema_version, file)?
        } else {
            file
        };

        // Fail-first on a bad root: canonicalize + must-be-a-directory so the
        // boundary check is stable and a misconfigured VPS aborts startup.
        let mut roots = Vec::with_capacity(file.projects.len());
        for mut root in file.projects {
            root.path = validate_root_path(&root.path).map_err(|reason| {
                ProjectRegistryError::InvalidRoot {
                    id: root.id.clone(),
                    reason,
                }
            })?;
            roots.push(root);
        }

        // P4: drop a default_project_id that references a project not in the
        // loaded roots (a stale id left by a deleted project must not survive
        // into the in-memory registry). Also reject archived/empty-path
        // defaults (not switchable — same conditions as `set_default_project`).
        let default_project_id = file.default_project_id.filter(|id| {
            roots.iter().any(|r| {
                r.id == *id && !r.is_archived && !r.path.as_os_str().is_empty()
            })
        });

        Ok(Self {
            roots,
            default_project_id,
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
        };
        let bytes = serde_json::to_vec_pretty(&file).map_err(ProjectRegistryError::Parse)?;

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

    /// Validate and update the default project id in memory.
    ///
    /// Persistence remains an explicit caller-owned `save_atomic` step so a
    /// `set_default_project` transaction can broadcast + persist atomically
    /// (the caller persists after the registry + broadcast succeed, with
    /// rollback on failure).
    pub fn set_default_project(&mut self, project_id: &str) -> Result<(), ProjectRegistryError> {
        let root = self
            .roots
            .iter()
            .find(|root| root.id == project_id)
            .ok_or_else(|| ProjectRegistryError::InvalidActiveProject {
                id: project_id.to_string(),
                reason: "unknown project".to_string(),
            })?;
        if root.is_archived {
            return Err(ProjectRegistryError::InvalidActiveProject {
                id: project_id.to_string(),
                reason: "project is archived".to_string(),
            });
        }
        if root.path.as_os_str().is_empty() {
            return Err(ProjectRegistryError::InvalidActiveProject {
                id: project_id.to_string(),
                reason: "project has no working directory".to_string(),
            });
        }
        self.default_project_id = Some(project_id.to_string());
        Ok(())
    }

    /// Restore a previously captured default id during transaction rollback.
    ///
    /// This deliberately does not revalidate: the value came from this loaded
    /// registry immediately before a validated mutation, and may legitimately
    /// be `None`. Callers must persist the restored value with `save_atomic`.
    pub(crate) fn restore_default_project(&mut self, default_project_id: Option<String>) {
        self.default_project_id = default_project_id;
    }

    /// Resolve a project id → its canonical VFS root path. Returns `None` for
    /// an unknown id, an archived root, or an empty path (mirrors
    /// `web::ProjectRegistry::find_path`'s skip semantics — the shared
    /// read-path `switch_project` uses).
    #[must_use]
    pub fn resolve_path(&self, id: &str) -> Option<PathBuf> {
        self.roots
            .iter()
            .find(|r| r.id == id && !r.is_archived)
            .and_then(|r| {
                if r.path.as_os_str().is_empty() {
                    None
                } else {
                    Some(r.path.clone())
                }
            })
    }

    /// `true` when the registry holds no roots.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.roots.is_empty()
    }
}

/// Single schema migration seam. v1 upgrades in-memory to v3; v2 upgrades to
/// v3 (the `activeProjectId` → `defaultProjectId` rename is handled transparently
/// by the `#[serde(alias)]` on `RegistryFile.default_project_id`, so the v2
/// arm only bumps the version); unknown versions are rejected without
/// reinterpretation.
fn migrate(from: u32, mut file: RegistryFile) -> Result<RegistryFile, ProjectRegistryError> {
    match from {
        // v1 had the same project fields except project-scoped MCP servers.
        // `VfsRoot.mcp_servers` deserializes with `default`, so the explicit
        // migration is lossless and makes the new meaning/version deliberate.
        // v1 also used `activeProjectId` (now `defaultProjectId`); the serde
        // alias on the field accepts both names, so no manual field rename is
        // needed — the bump to v3 records the semantic change.
        1 => {
            file.schema_version = SCHEMA_VERSION;
            Ok(file)
        }
        // v2 → v3: the registry's `activeProjectId` became `defaultProjectId`
        // (the host default for new web clients, distinct from any client's
        // per-connection active selection). The serde alias on
        // `RegistryFile.default_project_id` deserializes a v2 file's
        // `activeProjectId` transparently, so the migration only bumps the
        // recorded schema version.
        2 => {
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
fn validate_root_path(raw: &Path) -> Result<PathBuf, String> {
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
mod tests {
    //! NOTE: this module MUST NOT import `crate::web::*` — the
    //! `web -> acp -> web` cycle invariant (see the module-level doc).
    //! These tests exercise the file-backed registry in isolation; the
    //! VfsRoot -> ProjectSummary mapping + mode-selection seam is tested in
    //! `web::project_registry` (which may import `acp`).

    use super::*;
    use std::path::PathBuf;

    /// Minimal std-only temp dir (reuses `web::config`'s pid+nanos pattern —
    /// no `tempfile` dev-dep). Caller must `cleanup` it.
    fn tempdir_like(label: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "termul-registry-{label}-{}-{}",
            std::process::id(),
            now_nanos()
        ));
        fs::create_dir_all(&p).expect("create tempdir");
        p
    }

    fn cleanup(p: &Path) {
        let _ = fs::remove_dir_all(p);
    }

    /// A real, on-disk directory to use as a valid VFS root path.
    fn real_dir(parent: &Path, name: &str) -> PathBuf {
        let d = parent.join(name);
        fs::create_dir_all(&d).expect("mkdir root");
        d
    }

    fn root(id: &str, path: &Path, archived: bool) -> VfsRoot {
        VfsRoot {
            id: id.to_string(),
            name: format!("Project {id}"),
            path: path.to_path_buf(),
            color: "blue".to_string(),
            is_archived: archived,
            mcp_servers: Vec::new(),
        }
    }

    fn write_json(path: &Path, json: &str) {
        fs::write(path, json).expect("write json");
    }

    // T5.1 — load reads VFS roots (schema 1, 2 roots, active id).
    #[test]
    fn load_reads_vfs_roots() {
        let dir = tempdir_like("load-reads");
        let root_a = real_dir(&dir, "proj-a");
        let root_b = real_dir(&dir, "proj-b");
        let file = dir.join("projects.json");
        write_json(
            &file,
            &serde_json::json!({
                "schemaVersion": 1,
                "activeProjectId": "p-1",
                "projects": [
                    { "id": "p-1", "name": "Project p-1", "path": root_a, "color": "blue", "isArchived": false },
                    { "id": "p-2", "name": "Project p-2", "path": root_b, "color": "green", "isArchived": false },
                ]
            })
            .to_string(),
        );

        let reg = FileProjectRegistry::load(&file).expect("load ok");
        assert_eq!(reg.roots().len(), 2, "two roots loaded");
        assert_eq!(reg.default_project_id(), Some("p-1"));
        let resolved = reg.resolve_path("p-1").expect("resolve p-1");
        // The loaded path is the canonical absolute form of root_a.
        assert!(resolved.is_absolute());
        assert_eq!(resolved, root_a.canonicalize().unwrap());
        cleanup(&dir);
    }

    // T5.2 — missing file => Ok(empty), NOT an error (the binary still serves).
    #[test]
    fn load_missing_file_returns_empty_not_error() {
        let dir = tempdir_like("load-missing");
        let missing = dir.join("does-not-exist.json");
        let reg = FileProjectRegistry::load(&missing).expect("missing => Ok(empty)");
        assert!(reg.is_empty());
        assert_eq!(reg.roots().len(), 0);
        assert_eq!(reg.default_project_id(), None);
        assert!(reg.resolve_path("anything").is_none());
        cleanup(&dir);
    }

    // T5.3 — corrupt JSON => Err(Parse) AND a .corrupt-<ts>.bak exists.
    #[test]
    fn load_backup_on_corrupt() {
        let dir = tempdir_like("load-corrupt");
        let file = dir.join("projects.json");
        fs::write(&file, "{ not valid json").expect("write garbage");

        let err = FileProjectRegistry::load(&file).expect_err("corrupt => Err");
        assert!(
            matches!(err, ProjectRegistryError::Parse(_)),
            "expected Parse, got {err:?}"
        );

        // A .corrupt-<ts>.bak backup must exist alongside the bad file.
        let mut backups: Vec<_> = fs::read_dir(&dir)
            .expect("read dir")
            .filter_map(Result::ok)
            .filter(|e| {
                e.file_name()
                    .to_str()
                    .map(|n| n.starts_with("projects.json.corrupt-") && n.ends_with(".bak"))
                    .unwrap_or(false)
            })
            .collect();
        assert_eq!(backups.len(), 1, "exactly one corrupt backup");
        // The backup contains the original garbage.
        let bak_path = backups.remove(0).path();
        assert_eq!(fs::read_to_string(&bak_path).unwrap(), "{ not valid json");
        cleanup(&dir);
    }

    // T5.4 — bad schema version => Err(BadSchemaVersion { expected: 1, found: 99 }).
    #[test]
    fn load_rejects_bad_schema_version() {
        let dir = tempdir_like("load-bad-schema");
        let file = dir.join("projects.json");
        write_json(
            &file,
            &serde_json::json!({
                "schemaVersion": 99,
                "activeProjectId": null,
                "projects": []
            })
            .to_string(),
        );

        let err = FileProjectRegistry::load(&file).expect_err("bad schema => Err");
        assert!(
            matches!(
                err,
                ProjectRegistryError::BadSchemaVersion {
                    expected: SCHEMA_VERSION,
                    found: 99
                }
            ),
            "expected BadSchemaVersion {{expected:{SCHEMA_VERSION}, found:99}}, got {err:?}"
        );
        cleanup(&dir);
    }

    // T5.5 — save_atomic round-trips, consumes the temp, and replaces a stale file.
    #[test]
    fn save_atomic_round_trips_and_is_atomic() {
        let dir = tempdir_like("save-roundtrip");
        let root_a = real_dir(&dir, "proj-a");
        // Canonicalize so the round-trip deep-equals: load() canonicalizes
        // each root's path, so the saved registry must already hold canonical
        // paths for save -> reload to compare equal (Windows adds the `\\?\`
        // verbatim prefix on canonicalize).
        let root_a = root_a.canonicalize().expect("canonicalize root-a");
        let file = dir.join("projects.json");

        // A stale existing file must be replaced.
        fs::write(&file, "STALE").expect("write stale");

        let reg = FileProjectRegistry::from_roots(
            vec![root("p-1", &root_a, false)],
            Some("p-1".to_string()),
        );
        reg.save_atomic(&file).expect("save_atomic ok");

        // The temp file must NOT linger (the rename consumed it).
        let temps: Vec<_> = fs::read_dir(&dir)
            .expect("read dir")
            .filter_map(Result::ok)
            .filter(|e| {
                e.file_name()
                    .to_str()
                    .map(|n| n.ends_with(".tmp"))
                    .unwrap_or(false)
            })
            .collect();
        assert!(temps.is_empty(), "no lingering temp file: {temps:?}");

        // The target no longer contains the stale content.
        assert_ne!(fs::read_to_string(&file).unwrap(), "STALE");

        // Reload + deep-equal round-trip.
        let reloaded = FileProjectRegistry::load(&file).expect("reload ok");
        assert_eq!(reloaded.roots(), reg.roots());
        assert_eq!(reloaded.default_project_id(), reg.default_project_id());
        assert_eq!(reloaded, reg);
        cleanup(&dir);
    }

    // T5.6 — the temp is written in the SAME directory as the target (same-dir
    // so rename is atomic; cross-device rename would fail CrossesDevices).
    #[test]
    fn save_atomic_writes_temp_in_same_dir() {
        let dir = tempdir_like("save-samedir");
        // A SEPARATE temp dir to prove the temp is NOT created there.
        let other = tempdir_like("save-other");
        let root_a = real_dir(&dir, "proj-a");
        let file = dir.join("projects.json");

        let reg = FileProjectRegistry::from_roots(vec![root("p-1", &root_a, false)], None);
        reg.save_atomic(&file).expect("save_atomic ok");

        // No temp file (or any file) created in the OTHER directory by save_atomic.
        let leaked: Vec<_> = fs::read_dir(&other)
            .expect("read other dir")
            .filter_map(Result::ok)
            .collect();
        assert!(
            leaked.is_empty(),
            "save_atomic must not write outside the target dir: {leaked:?}"
        );
        cleanup(&dir);
        cleanup(&other);
    }

    // T5.7 — resolve_path skips archived roots and empty paths.
    #[test]
    fn resolve_path_skips_archived_and_empty() {
        // Constructed directly (not via load, which canonicalizes/rejects).
        let reg = FileProjectRegistry::from_roots(
            vec![
                root("p-live", Path::new("/a/b"), false),
                root("p-archived", Path::new("/c/d"), true),
                VfsRoot {
                    id: "p-empty".to_string(),
                    name: "Empty".to_string(),
                    path: PathBuf::new(),
                    color: "blue".to_string(),
                    is_archived: false,
                    mcp_servers: Vec::new(),
                },
            ],
            None,
        );
        assert_eq!(
            reg.resolve_path("p-live").as_deref(),
            Some(std::path::Path::new("/a/b"))
        );
        // Archived => None (cannot switch).
        assert_eq!(reg.resolve_path("p-archived"), None);
        // Empty path => None (cannot switch).
        assert_eq!(reg.resolve_path("p-empty"), None);
        // Unknown id => None.
        assert_eq!(reg.resolve_path("missing"), None);
    }

    // P4 — from_roots drops a default_project_id that references a project not
    // in the roots list (no dangling default). Also drops a default pointing
    // at an archived or empty-path root (not switchable — same conditions as
    // `set_default_project`).
    #[test]
    fn from_roots_drops_dangling_or_unswitchable_default() {
        let reg = FileProjectRegistry::from_roots(
            vec![
                root("p-live", Path::new("/a"), false),
                root("p-archived", Path::new("/b"), true),
                VfsRoot {
                    id: "p-empty".to_string(),
                    name: "Empty".to_string(),
                    path: PathBuf::new(),
                    color: "blue".to_string(),
                    is_archived: false,
                    mcp_servers: Vec::new(),
                },
            ],
            // Dangling (p-deleted doesn't exist) — must be dropped.
            Some("p-deleted".to_string()),
        );
        assert_eq!(reg.default_project_id(), None);

        // A valid switchable default survives.
        let reg = FileProjectRegistry::from_roots(
            vec![root("p-live", Path::new("/a"), false)],
            Some("p-live".to_string()),
        );
        assert_eq!(reg.default_project_id(), Some("p-live"));

        // An archived default is dropped (not switchable).
        let reg = FileProjectRegistry::from_roots(
            vec![root("p-archived", Path::new("/b"), true)],
            Some("p-archived".to_string()),
        );
        assert_eq!(reg.default_project_id(), None);

        // An empty-path default is dropped (not switchable).
        let reg = FileProjectRegistry::from_roots(
            vec![VfsRoot {
                id: "p-empty".to_string(),
                name: "Empty".to_string(),
                path: PathBuf::new(),
                color: "blue".to_string(),
                is_archived: false,
                mcp_servers: Vec::new(),
            }],
            Some("p-empty".to_string()),
        );
        assert_eq!(reg.default_project_id(), None);
    }

    #[test]
    fn v1_migrates_to_v3_with_empty_mcp_configuration() {
        let dir = tempdir_like("migrate-v1");
        let root_a = real_dir(&dir, "proj-a");
        let file = dir.join("projects.json");
        write_json(
            &file,
            &serde_json::json!({
                "schemaVersion": 1,
                "activeProjectId": "p-1",
                "projects": [{
                    "id": "p-1", "name": "Project p-1", "path": root_a,
                    "color": "blue", "isArchived": false
                }]
            })
            .to_string(),
        );
        let reg = FileProjectRegistry::load(&file).expect("v1 migrates");
        assert!(reg.roots()[0].mcp_servers.is_empty());
        // The serde alias deserializes v1's `activeProjectId` into
        // `default_project_id` transparently.
        assert_eq!(reg.default_project_id(), Some("p-1"));
        reg.save_atomic(&file).expect("save v3");
        let saved: serde_json::Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        assert_eq!(saved["schemaVersion"], 3);
        assert_eq!(saved["defaultProjectId"], "p-1");
        assert!(
            saved.get("activeProjectId").is_none(),
            "v3 must serialize under the new field name"
        );
        cleanup(&dir);
    }

    /// v2 → v3 migration: a v2 file used `activeProjectId`; the serde alias on
    /// `RegistryFile.default_project_id` deserializes it transparently, and the
    /// migrate arm bumps the recorded schema version to 3. After a save→reload
    /// the field is stored under the new `defaultProjectId` name.
    #[test]
    fn v2_migrates_to_v3_via_serde_alias() {
        let dir = tempdir_like("migrate-v2");
        let root_a = real_dir(&dir, "proj-a");
        let file = dir.join("projects.json");
        write_json(
            &file,
            &serde_json::json!({
                "schemaVersion": 2,
                "activeProjectId": "p-1",
                "projects": [{
                    "id": "p-1", "name": "Project p-1", "path": root_a,
                    "color": "blue", "isArchived": false
                }]
            })
            .to_string(),
        );
        let reg = FileProjectRegistry::load(&file).expect("v2 migrates to v3");
        // The serde alias carried `activeProjectId` into `default_project_id`.
        assert_eq!(reg.default_project_id(), Some("p-1"));
        // Re-saving persists under the new field name + bumps the version.
        reg.save_atomic(&file).expect("save v3");
        let saved: serde_json::Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        assert_eq!(saved["schemaVersion"], 3);
        assert_eq!(saved["defaultProjectId"], "p-1");
        assert!(
            saved.get("activeProjectId").is_none(),
            "v3 must serialize under the new field name only"
        );
        cleanup(&dir);
    }

    /// P4 — load drops a `default_project_id` that references a project not in
    /// the file's roots (a stale id left by a deleted project must not survive
    /// into the in-memory registry).
    #[test]
    fn load_drops_dangling_default_project_id() {
        let dir = tempdir_like("load-dangling-default");
        let root_a = real_dir(&dir, "proj-a");
        let file = dir.join("projects.json");
        write_json(
            &file,
            &serde_json::json!({
                "schemaVersion": 3,
                "defaultProjectId": "p-deleted",
                "projects": [{
                    "id": "p-1", "name": "Project p-1", "path": root_a,
                    "color": "blue", "isArchived": false
                }]
            })
            .to_string(),
        );
        let reg = FileProjectRegistry::load(&file).expect("load ok");
        // The dangling default is dropped (no project with id "p-deleted").
        assert_eq!(reg.default_project_id(), None);
        assert_eq!(reg.roots().len(), 1);
        cleanup(&dir);
    }

    #[test]
    fn set_default_project_validates_before_mutating() {
        let reg_root = root("live", Path::new("/a"), false);
        let archived = root("archived", Path::new("/b"), true);
        let mut reg =
            FileProjectRegistry::from_roots(vec![reg_root, archived], Some("live".to_string()));
        assert!(reg.set_default_project("missing").is_err());
        assert_eq!(reg.default_project_id(), Some("live"));
        assert!(reg.set_default_project("archived").is_err());
        assert_eq!(reg.default_project_id(), Some("live"));
    }

    #[test]
    fn restore_default_project_supports_persistence_rollback() {
        let dir = tempdir_like("default-rollback");
        let root_a = real_dir(&dir, "proj-a");
        let root_b = real_dir(&dir, "proj-b");
        let file = dir.join("projects.json");
        let mut reg = FileProjectRegistry::from_roots(
            vec![root("p-1", &root_a, false), root("p-2", &root_b, false)],
            Some("p-1".to_string()),
        );
        reg.save_atomic(&file).expect("seed registry");
        let previous = reg.default_project_id().map(str::to_string);
        reg.set_default_project("p-2").expect("set default");
        reg.save_atomic(&file).expect("persist default");

        reg.restore_default_project(previous);
        reg.save_atomic(&file).expect("persist rollback");
        let reloaded = FileProjectRegistry::load(&file).expect("reload rolled back registry");
        assert_eq!(reloaded.default_project_id(), Some("p-1"));
        cleanup(&dir);
    }

    #[test]
    fn default_project_persists_across_reload() {
        let dir = tempdir_like("default-switch");
        let root_a = real_dir(&dir, "proj-a");
        let root_b = real_dir(&dir, "proj-b");
        let file = dir.join("projects.json");
        let mut reg = FileProjectRegistry::from_roots(
            vec![root("p-1", &root_a, false), root("p-2", &root_b, false)],
            Some("p-1".to_string()),
        );
        reg.save_atomic(&file).expect("seed registry");
        reg.set_default_project("p-2").expect("set default");
        reg.save_atomic(&file).expect("persist default");

        let reloaded = FileProjectRegistry::load(&file).expect("reload switched registry");
        assert_eq!(reloaded.default_project_id(), Some("p-2"));
        cleanup(&dir);
    }
}
