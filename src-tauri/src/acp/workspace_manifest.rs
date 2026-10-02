//! Host-owned versioned workspace manifest service (CAP-5 / Story 5).
//!
//! Atomically persists one portable workspace manifest per project so a second
//! client (reload, reconnect, device handoff) can restore pane/tab topology,
//! focused session, editor paths, and terminal descriptors from host authority
//! rather than renderer-only state. Story 5 ships the schema, persistence API,
//! parity surfaces (Tauri + HTTP), and exclusion enforcement; Story 6 wires the
//! renderer to read/write/conflict-render through this contract.
//!
//! # Storage layout
//!
//! One JSON file per project at `<root>/<project_id>.json`, written via
//! [`crate::acp::atomic_file::replace`] (same-directory temp + fsync + rename,
//! plus Unix parent fsync). A schema-versioned envelope
//! `{ schemaVersion, manifest }` wraps every file so future migrations route
//! through a `migrate` hook (mirrors `FileProjectRegistry`). A corrupt file is
//! backed up via [`atomic_file::backup_corrupt`] then `load` returns `Ok(None)`
//! — a workspace reload starts fresh, the corruption is recoverable not fatal.
//!
//! # Concurrency
//!
//! `WorkspaceManifestService::open` returns an `Arc<Self>` shared by the host
//! runtime (Tauri desktop OR standalone `termul-server`, never both —
//! `Never`-clause). Concurrent writers within the process serialize through a
//! per-project `tokio::Mutex` keyed by `project_id`, so two racing writes to
//! the same project deterministically produce one `Updated` and one `Conflict`
//! (no lost update, no duplicate revision).
//!
//! # Exclusion enforcement
//!
//! The manifest struct simply does not declare any field on the exclusion list
//! (`envVars`, `env`, `tokens`, `credentials`, raw `claim`, `viewport`,
//! `windowState`, `fullscreenPaneId`, `agentLauncherPaneId`). Every manifest +
//! descriptor struct carries `#[serde(deny_unknown_fields)]` so an
//! over-serialized payload is rejected loudly at the host boundary (mapped to
//! `VALIDATION_ERROR` by the Tauri commands and HTTP routes) — never silently
//! dropped. The raw CAP-3 claim credential lives only in the renderer terminal
//! store (Story 4 in-memory `claim?` field); the manifest carries only an
//! opaque `claimHandle` string the renderer pairs back to its in-memory claim.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex as PlMutex;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as TokioMutex;

use crate::acp::atomic_file;

/// Current on-disk manifest envelope schema version. Bump when the
/// [`WorkspaceManifest`] shape changes; future versions route through a
/// `migrate` hook (today: reject as `BadSchemaVersion` and treat the file as
/// fresh — Story 5 has no migration path yet, the workspace reloads fresh).
pub const WORKSPACE_MANIFEST_SCHEMA_VERSION: u32 = 1;

// ---------------------------------------------------------------------------
// Portable workspace shapes (camelCase serde, byte-identical to the TS shapes)
// ---------------------------------------------------------------------------

/// Portable terminal descriptor. Mirrors just enough of a `WorkspaceTab`
/// terminal entry for cross-client restore: identity + shell/cwd/name +
/// `worktreeId` (so a restored worktree-aware terminal reattaches in the right
/// branch) + `claimHandle` (opaque caller-supplied string the host never
/// dereferences — the renderer pairs it back to its in-memory CAP-3 claim).
///
/// Never carries env vars, tokens, or the raw CAP-3 claim credential. The
/// host boundary's `#[serde(deny_unknown_fields)]` rejects any over-serialized
/// payload carrying those fields.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalDescriptor {
    pub terminal_id: String,
    pub project_id: String,
    pub shell: String,
    pub cwd: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_id: Option<String>,
    /// Opaque caller-supplied handle the renderer pairs back to its in-memory
    /// CAP-3 claim credential. The host NEVER dereferences, logs, or persists
    /// the raw claim — only this opaque string mirror.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claim_handle: Option<String>,
}

/// Portable editor descriptor. A restored editor tab reopens a file path inside
/// the project; no view-state, scroll position, or unsent draft crosses the
/// host boundary (drafts are deferred — `continuity-contract.md` says "where
/// policy permits"; the policy decision is not in this story's scope).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorDescriptor {
    pub editor_id: String,
    pub file_path: String,
}

/// Direction for a split node. Mirrors `PaneDirection` in
/// `src/renderer/types/workspace.types.ts` (`'horizontal' | 'vertical'`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PaneDirection {
    Horizontal,
    Vertical,
}

/// Portable split node. Mirrors `SplitNode` (without the workspace-only `tabs`
/// children of `LeafNode`; child shapes are themselves portable `PaneNode`s).
/// The `sizes` array is the proportional pane-size split the renderer restores
/// verbatim — it carries no viewport dimensions or window-state.
///
/// Note: `PartialEq` only (not `Eq`) — `f64` does not implement `Eq` so the
/// derive chain stops at `PartialEq`. Tests compare topology structurally
/// (the `sizes` arrays match exactly when the renderer restores the same
/// split).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SplitNode {
    pub id: String,
    pub direction: PaneDirection,
    pub children: Vec<PaneNode>,
    pub sizes: Vec<f64>,
}

/// Portable leaf node. Mirrors `LeafNode` minus the workspace-only `tabs`
/// field (a restored workspace repopulates `tabs` from `terminalIds` +
/// `editorIds` + the active id). Carrying the full `WorkspaceTab[]` here would
/// pull in renderer-only state (browser tab ids, git cwd, agent-chat session
/// pointers) that the host has no authority over; the portable descriptor list
/// is the durable projection.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LeafNode {
    pub id: String,
    pub terminal_ids: Vec<String>,
    pub editor_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_tab_id: Option<String>,
}

/// Portable pane tree node. A `PaneNode` is either a `SplitNode` or a
/// `LeafNode`. Tagged via the `type` discriminator (`"split"` / `"leaf"`) so
/// the renderer can pattern-match without guessing from field presence.
///
/// `PartialEq` only (not `Eq`) — `SplitNode::sizes: Vec<f64>` cannot derive
/// `Eq` (f64 has no Eq impl). Structural equality is enough for the
/// round-trip tests.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum PaneNode {
    Split(SplitNode),
    Leaf(LeafNode),
}

/// The portable workspace manifest. Owned by the host, one per project; carries
/// the topology tree, focused session, active pane, and the terminal + editor
/// descriptor lists a second client needs to restore.
///
/// `revision` is monotonic from 1, incremented on each successful write;
/// `updateIdentity` is caller-supplied opaque string (Epic 2 wires real auth);
/// `updatedAt` is epoch millis. `#[serde(deny_unknown_fields)]` enforces the
/// exclusion list at the host boundary — any over-serialized payload
/// (`envVars`, raw `claim`, `fullscreenPaneId`, …) is rejected loudly.
///
/// `PartialEq` only — topology's `PaneNode::Split` carries `Vec<f64>` sizes
/// (no `Eq`); structural equality is enough for tests + serde round-trip.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceManifest {
    pub project_id: String,
    pub revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update_identity: Option<String>,
    pub updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topology: Option<PaneNode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_pane_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focused_session_id: Option<String>,
    #[serde(default)]
    pub terminals: Vec<TerminalDescriptor>,
    #[serde(default)]
    pub editors: Vec<EditorDescriptor>,
}

/// Schema-versioned envelope. Mirrors `FileProjectRegistry::RegistryFile`'s
/// pattern so future migrations route through a `migrate` hook. A corrupt file
/// is backed up via [`atomic_file::backup_corrupt`] then `load` returns
/// `Ok(None)` (manifest-missing is the success path; a corrupt file is
/// recoverable, not fatal — a workspace reload starts fresh).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceManifestFile {
    pub schema_version: u32,
    pub manifest: WorkspaceManifest,
}

// ---------------------------------------------------------------------------
// Write outcome
// ---------------------------------------------------------------------------

/// Result of a revision-checked `write`. `Updated` is the success path (the
/// on-disk `revision` matched `basedRevision`, the host applied, incremented,
/// persisted). `Conflict` is the stale-revision path: the on-disk state is
/// byte-for-byte unchanged, and the three conflict fields a reload/reconcile
/// client needs (`currentRevision`, `currentUpdatedAt`, `currentUpdateIdentity`)
/// are returned WITHOUT mutating state.
///
/// Serialized via `#[serde(tag = "status", rename_all = "lowercase")]` so the
/// wire shape is byte-identical between the Tauri command and the HTTP route
/// (and matches the TS `WriteOutcome` discriminated union:
/// `{ status: 'updated'; revision; updatedAt } | { status: 'conflict';
/// currentRevision; currentUpdatedAt; currentUpdateIdentity }`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum WriteOutcome {
    #[serde(rename_all = "camelCase")]
    Updated { revision: u64, updated_at: u64 },
    #[serde(rename_all = "camelCase")]
    Conflict {
        current_revision: u64,
        current_updated_at: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        current_update_identity: Option<String>,
    },
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Load / write / delete failure for [`WorkspaceManifestService`].
#[derive(Debug)]
pub enum WorkspaceManifestError {
    /// Filesystem read/write failure (permission, disk full, …).
    Io(io::Error),
    /// The file exists but is not valid JSON or does not match the
    /// [`WorkspaceManifestFile`] shape (a `.corrupt-<nanos>.bak` copy is
    /// stashed alongside before this is returned on load — see [`load`]).
    Parse(serde_json::Error),
    /// The file's `schemaVersion` does not equal
    /// [`WORKSPACE_MANIFEST_SCHEMA_VERSION`]. Story 5 treats this as a fresh
    /// start (backup + `Ok(None)`) — there is no migration path yet.
    BadSchemaVersion {
        /// Expected ([`WORKSPACE_MANIFEST_SCHEMA_VERSION`]).
        expected: u32,
        /// Found in the file.
        found: u32,
    },
    /// The caller-supplied `project_id` failed validation (empty, contains
    /// path separators, traversal components, NUL bytes, or Windows reserved
    /// names). Distinct from [`Self::Io`] so callers can surface validation
    /// failures to the client as `VALIDATION_ERROR` rather than a storage
    /// error.
    InvalidProjectId {
        /// Operator-facing reason (which check failed).
        reason: String,
    },
}

impl std::fmt::Display for WorkspaceManifestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "workspace manifest io error: {error}"),
            Self::Parse(error) => {
                write!(
                    f,
                    "workspace manifest file is corrupt (invalid JSON): {error}"
                )
            }
            Self::BadSchemaVersion { expected, found } => write!(
                f,
                "workspace manifest schema version mismatch: expected {expected}, found {found}"
            ),
            Self::InvalidProjectId { reason } => {
                write!(f, "invalid project_id: {reason}")
            }
        }
    }
}

impl std::error::Error for WorkspaceManifestError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Parse(error) => Some(error),
            Self::BadSchemaVersion { .. } | Self::InvalidProjectId { .. } => None,
        }
    }
}

impl From<io::Error> for WorkspaceManifestError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}
impl From<serde_json::Error> for WorkspaceManifestError {
    fn from(value: serde_json::Error) -> Self {
        Self::Parse(value)
    }
}

type Result<T> = std::result::Result<T, WorkspaceManifestError>;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/// Per-project write-serialization lock. Keyed by `project_id` so two racing
/// writes to the SAME project deterministically produce one `Updated` and
/// one `Conflict`; writes to DIFFERENT projects do not block each other.
///
/// Entries are evicted on a successful [`Self::delete`] so the map does not
/// grow unboundedly across a long-lived host runtime (a deleted project's
/// lock is no longer needed — a fresh write re-creates the entry). Invalid
/// `project_id`s never insert an entry: [`Self::write`] calls
/// [`Self::project_path`] (which validates the id) BEFORE acquiring the
/// lock. See the `write`/`delete` impls for the exact ordering.
type ProjectLockMap = HashMap<String, Arc<TokioMutex<()>>>;

/// Host-owned versioned workspace manifest service. One instance per host
/// runtime (desktop OR standalone `termul-server`, never shared across
/// processes — `Never`-clause). Constructed via
/// [`WorkspaceManifestService::open`], which creates the root directory +
/// idempotent re-open (mirrors `SessionPersistence::open`).
///
/// Story 5 ships the schema, persistence API, and exclusion enforcement;
/// Story 6 wires the renderer to read/write/conflict-render through this
/// contract.
pub struct WorkspaceManifestService {
    root: PathBuf,
    /// Per-project `tokio::Mutex` keyed by `project_id` for write
    /// serialization. Grows on first write to a project; shrinks on a
    /// successful delete (see [`Self::project_lock`]'s doc + the `delete`
    /// impl). Bounded by the number of live projects.
    locks: PlMutex<ProjectLockMap>,
}

impl WorkspaceManifestService {
    /// Open (or re-open) a workspace-manifests root. Creates the directory if
    /// missing; idempotent re-open returns a fresh `Arc<Self>` over the same
    /// root (the per-project mutex map is per-instance, but writes through
    /// different instances of the same root still serialize via the atomic
    /// rename — the in-process mutex only avoids the lost-update race between
    /// concurrent writers in the SAME process, never across processes).
    ///
    /// Mirrors `SessionPersistence::open`: create the root dir, return an
    /// `Arc<Self>`. A non-directory root (e.g. a stray file at the path) is an
    /// error so a misconfigured host fails loudly at startup.
    pub async fn open(root: PathBuf) -> Result<Arc<Self>> {
        if root.exists() && !root.is_dir() {
            return Err(WorkspaceManifestError::Io(io::Error::other(format!(
                "workspace-manifests root '{}' is not a directory",
                root.display()
            ))));
        }
        // Patch 8: the manifests root carries terminal cwd paths, shell
        // choices, worktree IDs — other host users should not be able to read
        // them. On Unix, create the dir with mode 0o700 (owner-only). On
        // non-Unix, default umask applies (Windows ACLs inherit from the
        // parent — tightening is a per-target decision beyond this story's
        // scope).
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new()
                .mode(0o700)
                .recursive(true)
                .create(&root)?;
        }
        #[cfg(not(unix))]
        {
            fs::create_dir_all(&root)?;
        }
        log::info!("[workspace-manifest] service ready root={}", root.display());
        Ok(Arc::new(Self {
            root,
            locks: PlMutex::new(HashMap::new()),
        }))
    }

    /// The manifests root directory (host data dir + `workspace-manifests`).
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Per-project file path: `<root>/<project_id>.json`. Project ids are
    /// renderer-chosen opaque strings; we validate them so a crafted id
    /// cannot escape the root or create a hidden / device-name file
    /// (defense-in-depth on top of the host boundary's
    /// `deny_unknown_fields`).
    ///
    /// Rejects:
    /// - empty `project_id`;
    /// - path separators (`/`, `\`, or the OS `MAIN_SEPARATOR`);
    /// - exact `..` (parent-dir traversal) — `foo..bar` is a legitimate name
    ///   and is NOT rejected (a `..` substring is fine; only the exact id
    ///   `..` is dangerous);
    /// - exact `.` (would create a hidden `.json` file);
    /// - NUL bytes (`\0`);
    /// - on Windows: `:` and DOS device names (`CON`, `PRN`, `AUX`, `NUL`,
    ///   `COM1`..`COM9`, `LPT1`..`LPT9`).
    fn project_path(&self, project_id: &str) -> Result<PathBuf> {
        if project_id.is_empty() {
            return Err(WorkspaceManifestError::InvalidProjectId {
                reason: "project_id is empty".to_string(),
            });
        }
        // Reject path separators / parent-dir components / hidden-file / NUL.
        if project_id == ".." {
            return Err(WorkspaceManifestError::InvalidProjectId {
                reason: "project_id is '..' (parent-dir traversal)".to_string(),
            });
        }
        if project_id == "." {
            return Err(WorkspaceManifestError::InvalidProjectId {
                reason: "project_id is '.' (would create a hidden file)".to_string(),
            });
        }
        if project_id.contains('\0') {
            return Err(WorkspaceManifestError::InvalidProjectId {
                reason: "project_id contains a NUL byte".to_string(),
            });
        }
        if project_id.contains(std::path::MAIN_SEPARATOR)
            || project_id.contains('/')
            || project_id.contains('\\')
        {
            return Err(WorkspaceManifestError::InvalidProjectId {
                reason: "project_id contains path separators".to_string(),
            });
        }
        #[cfg(windows)]
        {
            if project_id.contains(':') {
                return Err(WorkspaceManifestError::InvalidProjectId {
                    reason: "project_id contains ':' (Windows reserved)".to_string(),
                });
            }
            // DOS device name check (case-insensitive, exact match). `CON.txt`
            // is also reserved on Windows, but every id is suffixed with
            // `.json` here (see the `format!` below), so only the bare device
            // name is the dangerous case this guard must reject.
            let upper = project_id.to_ascii_uppercase();
            let reserved = [
                "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
                "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8",
                "LPT9",
            ];
            if reserved.contains(&upper.as_str()) {
                return Err(WorkspaceManifestError::InvalidProjectId {
                    reason: format!("project_id is a Windows reserved device name ('{upper}')"),
                });
            }
        }
        Ok(self.root.join(format!("{project_id}.json")))
    }

    /// Acquire (or create) the per-project write mutex. Two racing writes to
    /// the same project serialize through this lock — the second sees the
    /// first's revision and either updates or conflicts. Writes to different
    /// projects get different locks and do not block each other.
    fn project_lock(self: &Arc<Self>, project_id: &str) -> Arc<TokioMutex<()>> {
        let mut locks = self.locks.lock();
        if let Some(lock) = locks.get(project_id) {
            return Arc::clone(lock);
        }
        let lock = Arc::new(TokioMutex::new(()));
        locks.insert(project_id.to_string(), Arc::clone(&lock));
        lock
    }

    /// Load a project's manifest. Returns `Ok(None)` when the file is
    /// missing (the success path — a workspace reload starts fresh) OR when
    /// the file is corrupt / wrong schema version (backed up to
    /// `<file>.corrupt-<nanos>.bak` first, then treated as fresh). Returns
    /// `Err` only on a real I/O failure (permission, disk error).
    ///
    /// Story 5 has no migration path — a future schema version is backed up +
    /// `Ok(None)` (the workspace reloads fresh). The `BadSchemaVersion` error
    /// is exposed for callers that want to distinguish, but `load` itself
    /// collapses it to the fresh-start path.
    pub async fn load(self: &Arc<Self>, project_id: &str) -> Result<Option<WorkspaceManifest>> {
        let root = Arc::clone(self);
        let project_id = project_id.to_string();
        // Blocking file read on the async runtime — manifests are tiny JSON
        // files (a few KB), the read is sub-millisecond. spawn_blocking keeps
        // the WS runtime responsive without complicating the API.
        tokio::task::spawn_blocking(move || root.load_blocking(&project_id))
            .await
            .map_err(|error| {
                WorkspaceManifestError::Io(io::Error::other(format!("load task panicked: {error}")))
            })?
    }

    /// Blocking load implementation (mirrors `SessionPersistence::recover`'s
    /// `decode_versioned` pattern). A missing file is `Ok(None)`; a corrupt
    /// file is backed up + `Ok(None)`; a wrong schema version is backed up +
    /// `Ok(None)` (Story 5 has no migration path — fresh start).
    fn load_blocking(&self, project_id: &str) -> Result<Option<WorkspaceManifest>> {
        let path = self.project_path(project_id)?;
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                // Missing file = fresh start (the success path).
                return Ok(None);
            }
            Err(error) => return Err(error.into()),
        };

        // Schema-versioned envelope decode (mirrors `decode_versioned` in
        // session_persistence). A parse failure OR a bad schema version is
        // backed up + treated as fresh — the workspace reloads, the operator
        // can recover the corrupt file from the backup.
        match serde_json::from_slice::<WorkspaceManifestFile>(&bytes) {
            Ok(file) => {
                if file.schema_version == WORKSPACE_MANIFEST_SCHEMA_VERSION {
                    log::debug!(
                        "[workspace-manifest] load success project_id={} revision={}",
                        project_id,
                        file.manifest.revision
                    );
                    Ok(Some(file.manifest))
                } else {
                    log::warn!(
                        "[workspace-manifest] load bad schema_version project_id={} expected={} found={} — backing up + fresh start",
                        project_id,
                        WORKSPACE_MANIFEST_SCHEMA_VERSION,
                        file.schema_version
                    );
                    let _ = atomic_file::backup_corrupt(&path, &bytes);
                    Ok(None)
                }
            }
            Err(error) => {
                log::warn!(
                    "[workspace-manifest] load corrupt project_id={} error={error} — backing up + fresh start",
                    project_id
                );
                let _ = atomic_file::backup_corrupt(&path, &bytes);
                Ok(None)
            }
        }
    }

    /// Revision-checked write. `basedRevision: None` means "no prior revision,
    /// treat as initial write". The host compares `basedRevision` against the
    /// on-disk `revision`:
    ///
    /// - Equal (or `None` against a missing file) → apply, increment,
    ///   persist atomically, return [`WriteOutcome::Updated`].
    /// - Not equal (or `None` against an existing file) → return
    ///   [`WriteOutcome::Conflict`] WITHOUT mutating state.
    ///
    /// Per-project `tokio::Mutex` serializes concurrent writers within the
    /// process — exactly one `Updated`, the rest `Conflict`. The PTY / agent
    /// layer is NEVER touched on conflict (the manifest is a passive durable
    /// projection; the live process layer is unaffected by stale revisions).
    pub async fn write(
        self: &Arc<Self>,
        project_id: &str,
        based_revision: Option<u64>,
        mut manifest: WorkspaceManifest,
    ) -> Result<WriteOutcome> {
        // Validate the project_id BEFORE acquiring the per-project lock so an
        // invalid id never inserts a lock entry (Patch 3: the lock map must
        // not grow on validation failures).
        let path = self.project_path(project_id)?;
        let lock = self.project_lock(project_id);
        let _guard = lock.lock().await;
        let root = Arc::clone(self);
        let project_id_owned = project_id.to_string();
        // The write path is short (read-or-missing + serialize + atomic
        // rename), but the atomic rename's fsync can stall on a slow disk;
        // keep it off the async runtime via spawn_blocking.
        let outcome = tokio::task::spawn_blocking(move || {
            root.write_blocking(&project_id_owned, based_revision, &mut manifest, &path)
        })
        .await
        .map_err(|error| {
            WorkspaceManifestError::Io(io::Error::other(format!("write task panicked: {error}")))
        })??;
        // Boundary logging: info for Updated, warn for Conflict (with
        // project_id + revision + update_identity — never the topology or
        // claim). The block context already has the manifest mutated in place
        // by `write_blocking` so we can read the persisted revision /
        // update_identity from it.
        match &outcome {
            WriteOutcome::Updated { revision, .. } => {
                log::info!(
                    "[workspace-manifest] write updated project_id={} revision={}",
                    project_id,
                    revision
                );
            }
            WriteOutcome::Conflict {
                current_revision,
                current_update_identity,
                ..
            } => {
                log::warn!(
                    "[workspace-manifest] write conflict project_id={} current_revision={} current_update_identity={}",
                    project_id,
                    current_revision,
                    current_update_identity.as_deref().unwrap_or("(none)")
                );
            }
        }
        Ok(outcome)
    }

    /// Blocking write implementation. Reads the on-disk revision (or treats
    /// missing as `None`), compares against `based_revision`, applies +
    /// persists atomically on match, returns `Conflict` on mismatch. The
    /// manifest is mutated in place: `revision` is incremented, `updatedAt`
    /// is refreshed to `now`, and `projectId` is forced to the request's
    /// `project_id` (a caller cannot cross-write another project's manifest).
    fn write_blocking(
        &self,
        project_id: &str,
        based_revision: Option<u64>,
        manifest: &mut WorkspaceManifest,
        path: &Path,
    ) -> Result<WriteOutcome> {
        // Read current on-disk state. A missing file = revision `None`
        // (initial write). A corrupt / wrong-schema file is backed up +
        // treated as fresh — the write then proceeds as the initial write
        // (the corrupt state is recoverable, not fatal). A real I/O error
        // propagates.
        let current: Option<WorkspaceManifest> = match fs::read(path) {
            Ok(bytes) => match serde_json::from_slice::<WorkspaceManifestFile>(&bytes) {
                Ok(file) if file.schema_version == WORKSPACE_MANIFEST_SCHEMA_VERSION => {
                    Some(file.manifest)
                }
                Ok(file) => {
                    log::warn!(
                        "[workspace-manifest] write encountered bad schema_version project_id={} expected={} found={} — backing up + treating as fresh",
                        project_id,
                        WORKSPACE_MANIFEST_SCHEMA_VERSION,
                        file.schema_version
                    );
                    let _ = atomic_file::backup_corrupt(path, &bytes);
                    None
                }
                Err(error) => {
                    log::warn!(
                        "[workspace-manifest] write encountered corrupt file project_id={} error={error} — backing up + treating as fresh",
                        project_id
                    );
                    let _ = atomic_file::backup_corrupt(path, &bytes);
                    None
                }
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };

        let current_revision = current.as_ref().map(|m| m.revision);
        let current_updated_at = current.as_ref().map_or(0, |m| m.updated_at);
        let current_update_identity = current.as_ref().and_then(|m| m.update_identity.clone());

        // Revision check: based_revision must equal current_revision (with
        // `None == None` for the initial write against a missing file).
        // - based_revision `None` + on-disk exists → conflict (a fresh write
        //   against an existing manifest is stale; the caller must reload).
        // - based_revision `Some(n)` + on-disk `Some(m)` with `n != m` →
        //   conflict (stale revision).
        // - based_revision `None` + on-disk missing → initial write (apply).
        // - based_revision `Some(n)` + on-disk `Some(n)` → apply.
        let matches = match (based_revision, current_revision) {
            (Some(based), Some(current)) => based == current,
            (None, None) => true,
            _ => false,
        };

        if !matches {
            return Ok(WriteOutcome::Conflict {
                current_revision: current_revision.unwrap_or(0),
                current_updated_at,
                current_update_identity,
            });
        }

        // Apply: increment revision (1 for initial write, current + 1 for
        // subsequent), refresh updatedAt, force projectId to the request's
        // project_id (a caller cannot cross-write another project's manifest
        // by passing a mismatched `manifest.projectId`).
        let new_revision = current_revision.unwrap_or(0) + 1;
        let now = now_millis();
        manifest.project_id = project_id.to_string();
        manifest.revision = new_revision;
        manifest.updated_at = now;
        // update_identity is caller-supplied — pass through verbatim. The
        // host NEVER invents or augments it (Epic 2 wires real auth).

        let envelope = WorkspaceManifestFile {
            schema_version: WORKSPACE_MANIFEST_SCHEMA_VERSION,
            manifest: manifest.clone(),
        };
        let serialized = serde_json::to_vec_pretty(&envelope)?;
        atomic_file::replace(path, &serialized)?;

        Ok(WriteOutcome::Updated {
            revision: new_revision,
            updated_at: now,
        })
    }

    /// Delete a project's manifest. Idempotent: a missing file returns
    /// `Ok(())` (delete-again is a no-op). The PTY / agent layer is NEVER
    /// touched (the manifest is a passive durable projection; deleting it
    /// does not kill or interrupt any live process).
    ///
    /// Acquires the per-project lock BEFORE the delete so a concurrent `write`
    /// cannot race the file removal (Patch 2: write's `atomic_file::replace`
    /// could otherwise land after delete's `fs::remove_file`, "losing" the
    /// delete). On success, evicts the lock entry (Patch 3: the map must not
    /// grow unboundedly across delete/re-create cycles).
    pub async fn delete(self: &Arc<Self>, project_id: &str) -> Result<()> {
        // Validate the project_id BEFORE acquiring the lock (mirrors `write`'s
        // ordering — an invalid id must not insert a lock entry).
        let path = self.project_path(project_id)?;
        let lock = self.project_lock(project_id);
        let _guard = lock.lock().await;
        let root = Arc::clone(self);
        let project_id_owned = project_id.to_string();
        tokio::task::spawn_blocking(move || root.delete_blocking(&project_id_owned, &path))
            .await
            .map_err(|error| {
                WorkspaceManifestError::Io(io::Error::other(format!(
                    "delete task panicked: {error}"
                )))
            })??;
        // Evict the lock entry on a successful delete so the map does not grow
        // unboundedly. A failed delete (e.g. permission error) does NOT evict —
        // the lock stays so a retry still serializes.
        //
        // Evict ONLY when this guard holds the last reference besides the map
        // entry itself. A waiter that already cloned the `Arc` (via
        // `project_lock`) would otherwise keep using the removed lock while a
        // fresh caller creates a second `Arc<TokioMutex>`, allowing two
        // concurrent writers on the same project (both read revision N, both
        // write N+1, one update silently lost). `<= 2` = the map entry +
        // `delete`'s local `lock` binding; any cloned waiter makes it >= 3.
        // The check+remove run under `self.locks` (the std mutex that gates
        // every `project_lock` clone), so the count is stable across the
        // check — no TOCTOU window.
        {
            let mut locks = self.locks.lock();
            if locks
                .get(project_id)
                .is_some_and(|entry| Arc::strong_count(entry) <= 2)
            {
                locks.remove(project_id);
            }
        }
        log::info!("[workspace-manifest] delete project_id={}", project_id);
        Ok(())
    }

    fn delete_blocking(&self, _project_id: &str, path: &Path) -> Result<()> {
        // Idempotent: a missing file is Ok. A real I/O error (permission,
        // disk) propagates. Never touches the PTY layer.
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                // Idempotent — already gone.
            }
            Err(error) => return Err(error.into()),
        }
        Ok(())
    }
}

/// Epoch-millis timestamp. Shared with `session_persistence::now_millis`
/// (kept local to avoid a cross-module dependency for one helper).
///
/// Falls back to `0` on a clock-skew / pre-Unix-epoch `SystemTime` reading.
/// The `0` fallback is acceptable (practically impossible in production), but
/// a `log::warn!` fires when it triggers so the cross-client "newer" revision
/// comparison does not silently break (Patch 13).
#[must_use]
pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_else(|_error| {
            log::warn!(
                "[workspace-manifest] system clock appears to be before Unix epoch; \
                 using 0 as now_millis fallback"
            );
            0
        })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests;
