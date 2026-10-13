//! Server-side generic key-value store for the web client (issue #613, v2 in
//! issue #1073).
//!
//! The browser client persists terminal layout, settings, editor state,
//! command history, snapshots, SSH profiles, etc. through `persistenceApi`.
//! This store gives the server a durable home for that state: a single JSON
//! file written atomically (temp + rename + fsync, the same `atomic_file`
//! machinery `FileProjectRegistry::save_atomic` uses), so the state survives
//! browser switches and server restarts.
//!
//! # Key scopes
//!
//! Every key is `device/<deviceId>/<key>` (one device's partition, last host
//! arrival wins), `shared/lww/<key>` (per-field merge against the writer's
//! base revision, see [`lww`]) or `shared/cas/<key>` (whole-value
//! compare-and-set with a stored `commandId`). Anything else is refused
//! ([`scope`]); the device segment must be the caller's own authenticated
//! `deviceId`. Each key is a [`Record`] `{v, rev, cid, cmd?, fields?}`: the
//! revision is monotonic per key and survives restarts.
//!
//! # Schema (AD-18)
//!
//! On disk the file is `{"schemaVersion":2,"data":{ "key": record, … },
//! "host":{ "lastSeen":{…}, "legacy":{…}, "adopted":{…} }}`. The `host` object
//! is internal: per-device last-seen times, the parked pre-v2 device keys and
//! the adoption marker. A v1 file (or a legacy bare map) is migrated on open:
//! the original bytes are first copied to `<file>.pre-v2-<unix-ts>.bak` (a
//! backup failure aborts the open); keys that were shared across devices are
//! renamed to `shared/*`, every other key is parked and moved into the first
//! authenticated device's partition ([`legacy`]). A file whose `schemaVersion`
//! is newer than this build understands is refused with
//! [`WebStoreError::NewerSchema`] and left byte-identical.
//!
//! An object is an envelope only when it has a numeric `schemaVersion` AND a
//! `data` key; any other object is a legacy map, so a user key that happens to
//! be named `schemaVersion` is not misread. Unknown extra top-level keys are
//! kept verbatim across rewrites. The 10 MiB write limit is measured on the
//! `data` payload, not the enveloped file.
//!
//! Partitions are bounded: a device partition has a byte budget and a stale
//! one (device unseen for the GC age and not connected) is swept ([`gc`]).
//!
//! The retired per-project workspace manifests are imported once, into the
//! first device that adopts the store ([`manifest_import`]); a parked
//! `editor-state/<projectId>` key is adopted as `workspace/<projectId>`.
//!
//! Exposed to browsers as the `store_read` / `store_write` / `store_delete`
//! WS requests (see `ws/store.rs`). The client debounces high-frequency
//! writes, so write volume here is low.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde_json::Value;
use tracing::{info, warn};

use crate::acp::atomic_file::{self, NewerSchema};
use crate::web::command_ledger::is_valid_command_id;
use crate::web::config::{
    ServerConfig, DEFAULT_PARTITION_BYTE_BUDGET, DEFAULT_PARTITION_GC_AGE_SECS,
};
use crate::web::ws::ClientIdentity;

mod gc;
mod legacy;
mod lww;
mod manifest_import;
mod records;
mod scope;

pub use gc::spawn_gc_task;
pub use records::{Record, STORE_SCHEMA_VERSION};
pub use scope::{classify, KeyScope};
use records::{decode, encode, envelope_overhead, DecodeFailure, ExtraKeys, HostMeta};
use scope::{device_prefix, partition_of};

/// Why [`WebStore::open`] refused to open the store file. Both variants are
/// startup-fatal for the host that hit them.
#[derive(Debug)]
pub enum WebStoreError {
    /// The file was written by a newer host (`schemaVersion` above
    /// [`STORE_SCHEMA_VERSION`]); it was not modified.
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

/// Partition limits, from [`ServerConfig`] (one default each, in
/// `web/config.rs`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StorePolicy {
    /// Seconds a device may stay unseen before its partition is collected.
    pub partition_gc_age_secs: u64,
    /// Serialized bytes one device partition may hold.
    pub partition_byte_budget: u64,
}

impl StorePolicy {
    /// The limits a host configured.
    #[must_use]
    pub fn from_config(cfg: &ServerConfig) -> Self {
        Self {
            partition_gc_age_secs: cfg.partition_gc_age_secs,
            partition_byte_budget: cfg.partition_byte_budget,
        }
    }

    fn gc_age_ms(&self) -> u64 {
        self.partition_gc_age_secs.saturating_mul(1000)
    }
}

impl Default for StorePolicy {
    /// The config defaults, for hosts that carry no `ServerConfig` (desktop).
    fn default() -> Self {
        Self {
            partition_gc_age_secs: DEFAULT_PARTITION_GC_AGE_SECS,
            partition_byte_budget: DEFAULT_PARTITION_BYTE_BUDGET,
        }
    }
}

/// What a `store_write` / `store_delete` asserts about the key's current state.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Precondition {
    /// shared/lww: the revision the client derived its value from.
    pub base_revision: Option<u64>,
    /// shared/cas: the whole current value; `Some(Null)` = key must be absent.
    pub expected: Option<Value>,
    /// shared/cas: the writer's command id, kept on the record.
    pub command_id: Option<String>,
}

/// A read: the value (`None` = absent) and its stamp.
#[derive(Debug, Clone, PartialEq)]
pub struct Stamped {
    pub value: Option<Value>,
    /// 0 when the key is absent.
    pub revision: u64,
    pub client_instance_id: Option<String>,
}

/// What a successful write reports back.
#[derive(Debug, Clone, PartialEq)]
pub enum WriteOutcome {
    /// A device key: its new revision.
    Device { revision: u64 },
    /// A shared key: the stored value, its revision, and whether the stored
    /// value differs from what the caller sent.
    Shared {
        value: Value,
        revision: u64,
        merged: bool,
    },
}

/// Maximum size of the `data` payload a write may persist.
const MAX_DATA_BYTES: usize = 10 * 1024 * 1024;

/// Per-value serialized size cap for `store_write` (CAP-11). The whole-file
/// cap above still applies; this bound rejects a single oversized value BEFORE
/// it reaches the store so the on-disk file stays untouched.
pub const STORE_VALUE_MAX_BYTES: usize = 256 * 1024;

/// Where a host kept the retired per-project workspace manifests under its
/// data directory (`<app data dir>` on desktop, `<state dir>` for
/// `termul-server`).
#[must_use]
pub fn legacy_manifests_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("workspace-manifests")
}

/// Unix milliseconds now.
#[must_use]
pub fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
}

/// Everything the mutex guards.
#[derive(Clone)]
struct State {
    data: BTreeMap<String, Record>,
    host: HostMeta,
    /// A last-seen update has not reached the file yet.
    last_seen_dirty: bool,
    /// When the file was last written (unix ms).
    last_flush_ms: u64,
    /// The retired workspace-manifest directory, while its one-shot import
    /// into the first adopting device is still pending.
    import_dir: Option<PathBuf>,
}

/// Most deleted-key revision floors kept in the host metadata.
const MAX_DELETED_REVS: usize = 1024;

/// Keep `rev` as the revision floor of the deleted shared `key`.
fn remember_deleted_rev(host: &mut HostMeta, key: &str, rev: u64) {
    host.deleted_revs.insert(key.to_string(), rev);
    while host.deleted_revs.len() > MAX_DELETED_REVS {
        match host.deleted_revs.keys().find(|k| k.as_str() != key).cloned() {
            Some(oldest) => host.deleted_revs.remove(&oldest),
            None => break,
        };
    }
}

impl State {
    /// Serialize and atomically replace the file.
    fn persist(&mut self, path: &Path, extra: &ExtraKeys, now_ms: u64) -> io::Result<()> {
        let bytes = encode(&self.data, &self.host, extra)?;
        if bytes.len() - envelope_overhead(&self.host, extra)? > MAX_DATA_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "store data exceeds 10MB limit",
            ));
        }
        atomic_file::replace(path, &bytes)?;
        self.last_seen_dirty = false;
        self.last_flush_ms = now_ms;
        Ok(())
    }
}

/// A key → record map persisted to one JSON file.
///
/// All mutation goes through a single `parking_lot::Mutex`; each write
/// serializes the whole map and replaces the file atomically (see the module
/// doc for the on-disk envelope).
pub struct WebStore {
    path: PathBuf,
    policy: StorePolicy,
    /// Unknown top-level envelope keys, written back unchanged.
    extra: ExtraKeys,
    inner: Mutex<Option<State>>,
}

impl WebStore {
    /// Open (and load) the store at `path`.
    ///
    /// - Missing file → empty store (first run); the envelope appears on the
    ///   first write.
    /// - Current envelope → loaded.
    /// - v1 envelope or legacy bare map → backed up to
    ///   `<path>.pre-v2-<ts>.bak`, migrated (see the module doc), then
    ///   rewritten. Backup failure → `Err`, file untouched. A failed rewrite
    ///   only warns (the next write persists the envelope).
    /// - Newer `schemaVersion` → `Err(NewerSchema)`, file untouched.
    /// - Corrupt file → backed up to `<path>.corrupt-<ts>.bak`, then treated
    ///   as empty — the web client degrades to defaults rather than the
    ///   server refusing to start (same corrupt-handling posture as
    ///   `AcpCatalogService` / `AcpInstallService`).
    /// - Other read failure → warn + unavailable store (every operation
    ///   returns [`StoreError::Unavailable`]; the file is not touched).
    ///
    /// A stale-partition sweep runs once the store is loaded.
    pub fn open(path: PathBuf, policy: StorePolicy) -> Result<Self, WebStoreError> {
        let now_ms = unix_ms();
        let mut extra = ExtraKeys::new();
        let state = match fs::read(&path) {
            Ok(bytes) => match decode(&path, &bytes) {
                Ok(loaded) => {
                    extra = loaded.extra;
                    let mut state = State {
                        data: loaded.data,
                        host: loaded.host,
                        last_seen_dirty: false,
                        last_flush_ms: now_ms,
                        import_dir: None,
                    };
                    if loaded.migrated {
                        Self::migrate(&path, &bytes, &extra, &mut state, now_ms)?;
                    }
                    Some(state)
                }
                Err(DecodeFailure::Newer(newer)) => {
                    warn!("{}", WebStoreError::NewerSchema(newer.clone()));
                    return Err(WebStoreError::NewerSchema(newer));
                }
                Err(DecodeFailure::Corrupt(reason)) => {
                    match atomic_file::backup_corrupt(&path, &bytes) {
                        Ok(_) => {
                            warn!(
                                "store file '{}' is corrupt ({reason}); backed up and starting with an empty store",
                                path.display()
                            );
                            Some(Self::empty_state(now_ms))
                        }
                        Err(backup_err) => {
                            warn!(
                                "store file '{}' is corrupt ({reason}) and backup failed: {backup_err}; store is unavailable",
                                path.display()
                            );
                            None
                        }
                    }
                }
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                info!(
                    "store file '{}' not found; starting with an empty store",
                    path.display()
                );
                Some(Self::empty_state(now_ms))
            }
            Err(e) => {
                warn!(
                    "could not read store file '{}': {e}; store is unavailable",
                    path.display()
                );
                None
            }
        };
        let store = Self {
            path,
            policy,
            extra,
            inner: Mutex::new(state),
        };
        if store.inner.lock().is_some() {
            if let Err(error) = store.sweep(now_ms, &std::collections::HashSet::new()) {
                warn!("web store sweep at open failed: {error}");
            }
        }
        Ok(store)
    }

    fn empty_state(now_ms: u64) -> State {
        State {
            data: BTreeMap::new(),
            host: HostMeta::default(),
            last_seen_dirty: false,
            last_flush_ms: now_ms,
            import_dir: None,
        }
    }

    /// Import the retired workspace manifests under `dir` into the first
    /// device that adopts the store (see [`manifest_import`]). A no-op when a
    /// device already adopted or `dir` does not exist.
    #[must_use]
    pub fn with_legacy_manifests(self, dir: PathBuf) -> Self {
        if let Some(state) = self.inner.lock().as_mut() {
            if state.host.adopted.is_none() && dir.is_dir() {
                state.import_dir = Some(dir);
            }
        }
        self
    }

    fn migrate(
        path: &Path,
        original: &[u8],
        extra: &ExtraKeys,
        state: &mut State,
        now_ms: u64,
    ) -> Result<(), WebStoreError> {
        let backup = atomic_file::backup_pre_migration(path, original, STORE_SCHEMA_VERSION)
            .map_err(|source| WebStoreError::MigrationBackup {
                path: path.to_path_buf(),
                source,
            })?;
        info!(
            "store file '{}' is an older schema; original backed up to '{}', migrating to schema v{STORE_SCHEMA_VERSION}",
            path.display(),
            backup.display()
        );
        if let Err(e) = state.persist(path, extra, now_ms) {
            warn!(
                "could not rewrite migrated store '{}': {e}; the envelope is written on the next successful write",
                path.display()
            );
        }
        Ok(())
    }

    /// The backing file path.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    fn with_state<T>(
        &self,
        f: impl FnOnce(&mut State) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        let mut lock = self.inner.lock();
        let state = lock.as_mut().ok_or(StoreError::Unavailable)?;
        f(state)
    }

    /// What every request does first, under the lock: mark the device seen,
    /// let the first authenticated device adopt the parked pre-v2 keys and the
    /// retired workspace manifests (atomically, in one write), and flush a
    /// last-seen update that has waited an hour.
    fn enter(
        &self,
        state: &mut State,
        identity: &ClientIdentity,
        now_ms: u64,
    ) -> Result<(), StoreError> {
        state.touch(&identity.device_id, now_ms);
        if state.host.adopted.is_none()
            && (!state.host.legacy.is_empty() || state.import_dir.is_some())
            && device_prefix(&identity.device_id).is_some()
        {
            self.adopt(state, identity, now_ms)?;
        }
        if state.last_seen_dirty && now_ms.saturating_sub(state.last_flush_ms) >= gc::LAST_SEEN_FLUSH_MS
        {
            if let Err(error) = state.persist(&self.path, &self.extra, now_ms) {
                warn!(
                    target: "termul::web::store",
                    "could not persist device last-seen times: {error}"
                );
            }
        }
        Ok(())
    }

    /// The first device to ask adopts what no device owned yet. The file is
    /// written once; only after that does the manifest directory move aside,
    /// so a failed write leaves both the state and the import pending.
    fn adopt(
        &self,
        state: &mut State,
        identity: &ClientIdentity,
        now_ms: u64,
    ) -> Result<(), StoreError> {
        let manifests = state.import_dir.clone();
        let workspaces = manifests
            .as_deref()
            .map(manifest_import::read_workspaces)
            .unwrap_or_default();
        let mut next = state.clone();
        next.import_dir = None;
        let mut adoption = legacy::adopt(
            &mut next.data,
            &mut next.host,
            &identity.device_id,
            now_ms,
            workspaces,
        );
        if let Some(adoption) = adoption.as_mut() {
            self.fit_adopted_workspaces(&mut next, &identity.device_id, adoption);
            next.persist(&self.path, &self.extra, now_ms)?;
        }
        if let Some(dir) = &manifests {
            manifest_import::retire_dir(dir, now_ms);
        }
        if let Some(adoption) = adoption {
            info!(
                target: "termul::web::store",
                device_id = %ClientIdentity::log_label(&identity.device_id),
                parked = adoption.parked,
                workspaces = adoption.workspaces.len(),
                "device adopted the pre-v2 store keys"
            );
        }
        *state = next;
        Ok(())
    }

    /// Keep the adopting device's partition within the byte budget that every
    /// later write enforces: an adoption that overshot it would make each write
    /// that grows the partition fail. The imported workspaces that do not fit
    /// (the last ones by project id) are dropped with a warning; they stay in
    /// the renamed manifest directory.
    fn fit_adopted_workspaces(
        &self,
        next: &mut State,
        device_id: &str,
        adoption: &mut legacy::Adoption,
    ) {
        let Some(prefix) = device_prefix(device_id) else {
            return;
        };
        let budget = self.policy.partition_byte_budget;
        let mut used = next.partition_bytes(&prefix);
        while used as u64 > budget {
            let Some(key) = adoption.workspaces.pop() else {
                break;
            };
            if let Some(record) = next.data.remove(&key) {
                used -= records::record_bytes(&key, &record);
            }
            warn!(
                target: "termul::web::store",
                "dropped the imported workspace '{key}': the device partition would exceed its {budget} byte budget"
            );
        }
    }

    /// Read `key` for the connection `identity`. A key that cannot be read is
    /// an error, never a default.
    pub fn read(
        &self,
        key: &str,
        identity: &ClientIdentity,
        now_ms: u64,
    ) -> Result<Stamped, StoreError> {
        classify(key, &identity.device_id).map_err(|v| StoreError::Scope(v.0))?;
        self.with_state(|state| {
            self.enter(state, identity, now_ms)?;
            Ok(match state.data.get(key) {
                Some(record) => Stamped {
                    value: Some(record.v.clone()),
                    revision: record.rev,
                    client_instance_id: Some(record.cid.clone()),
                },
                None => Stamped {
                    value: None,
                    revision: 0,
                    client_instance_id: None,
                },
            })
        })
    }

    /// Write `value` under `key` with the semantics of the key's scope.
    pub fn write(
        &self,
        key: &str,
        value: Value,
        pre: Precondition,
        identity: &ClientIdentity,
        now_ms: u64,
    ) -> Result<WriteOutcome, StoreError> {
        let scope = classify(key, &identity.device_id).map_err(|v| StoreError::Scope(v.0))?;
        self.with_state(|state| {
            self.enter(state, identity, now_ms)?;
            let current = state.data.get(key);
            let next_rev = current.map_or_else(
                || state.host.deleted_revs.get(key).copied().unwrap_or(0) + 1,
                |record| record.rev + 1,
            );
            let cid = identity.client_instance_id.clone();
            let (record, outcome) = match scope {
                KeyScope::Device => (
                    Record {
                        v: value,
                        rev: next_rev,
                        cid,
                        cmd: None,
                        fields: None,
                    },
                    WriteOutcome::Device { revision: next_rev },
                ),
                KeyScope::SharedLww => {
                    let base = match (current, pre.base_revision) {
                        (Some(_), None) => return Err(StoreError::BaseRequired),
                        (_, base) => base.unwrap_or(0),
                    };
                    let merged = lww::merge(current, &value, base, next_rev);
                    let differs = merged.value != value;
                    if !merged.changed {
                        let revision = current.map_or(0, |record| record.rev);
                        return Ok(WriteOutcome::Shared {
                            value: merged.value,
                            revision,
                            merged: differs,
                        });
                    }
                    let record = Record {
                        v: merged.value.clone(),
                        rev: next_rev,
                        cid,
                        cmd: None,
                        fields: Some(merged.fields),
                    };
                    let outcome = WriteOutcome::Shared {
                        value: merged.value,
                        revision: next_rev,
                        merged: differs,
                    };
                    (record, outcome)
                }
                KeyScope::SharedCas => {
                    let (expected, command_id) = cas_preconditions(&pre)?;
                    if let Some(record) = current {
                        if record.cmd.as_deref() == Some(command_id) && record.v == value {
                            // The same write again (its reply was lost).
                            return Ok(WriteOutcome::Shared {
                                value,
                                revision: record.rev,
                                merged: false,
                            });
                        }
                    }
                    check_expected(current, expected)?;
                    let record = Record {
                        v: value.clone(),
                        rev: next_rev,
                        cid,
                        cmd: Some(command_id.to_string()),
                        fields: None,
                    };
                    let outcome = WriteOutcome::Shared {
                        value,
                        revision: next_rev,
                        merged: false,
                    };
                    (record, outcome)
                }
            };
            self.put(state, key, record, now_ms)?;
            state.host.deleted_revs.remove(key);
            Ok(outcome)
        })
    }

    /// Delete `key`; shared scopes follow the same preconditions as a write.
    /// Returns whether the key existed.
    pub fn delete(
        &self,
        key: &str,
        pre: Precondition,
        identity: &ClientIdentity,
        now_ms: u64,
    ) -> Result<bool, StoreError> {
        let scope = classify(key, &identity.device_id).map_err(|v| StoreError::Scope(v.0))?;
        self.with_state(|state| {
            self.enter(state, identity, now_ms)?;
            let current = state.data.get(key);
            match scope {
                KeyScope::Device => {}
                KeyScope::SharedLww => {
                    if let Some(record) = current {
                        let base = pre.base_revision.ok_or(StoreError::BaseRequired)?;
                        if record.rev > base {
                            return Err(StoreError::CasFailed(
                                "store delete rejected: the value changed since baseRevision"
                                    .to_string(),
                            ));
                        }
                    }
                }
                KeyScope::SharedCas => {
                    let (expected, _) = cas_preconditions(&pre)?;
                    check_expected(current, expected)?;
                }
            }
            if current.is_none() {
                return Ok(false);
            }
            let previous = state.data.remove(key);
            let floor_before = state.host.deleted_revs.get(key).copied();
            if scope != KeyScope::Device {
                if let Some(previous) = &previous {
                    remember_deleted_rev(&mut state.host, key, previous.rev);
                }
            }
            if let Err(error) = state.persist(&self.path, &self.extra, now_ms) {
                match floor_before {
                    Some(rev) => state.host.deleted_revs.insert(key.to_string(), rev),
                    None => state.host.deleted_revs.remove(key),
                };
                if let Some(previous) = previous {
                    state.data.insert(key.to_string(), previous);
                }
                return Err(error.into());
            }
            Ok(true)
        })
    }

    /// Insert `record` under `key` after the partition budget check, and
    /// persist; the previous record comes back if the file cannot be written.
    fn put(
        &self,
        state: &mut State,
        key: &str,
        record: Record,
        now_ms: u64,
    ) -> Result<(), StoreError> {
        if let Some(device) = partition_of(key) {
            let prefix = format!("device/{device}/");
            let old = state
                .data
                .get(key)
                .map_or(0, |existing| records::record_bytes(key, existing));
            let new = records::record_bytes(key, &record);
            // A write that does not grow the partition is always allowed, so
            // a lowered budget never traps a device in an unfixable state.
            if new > old {
                let used = state.partition_bytes(&prefix) - old + new;
                if used as u64 > self.policy.partition_byte_budget {
                    return Err(StoreError::PartitionFull {
                        used,
                        budget: self.policy.partition_byte_budget,
                    });
                }
            }
        }
        let previous = state.data.insert(key.to_string(), record);
        if let Err(error) = state.persist(&self.path, &self.extra, now_ms) {
            match previous {
                Some(previous) => state.data.insert(key.to_string(), previous),
                None => state.data.remove(key),
            };
            return Err(error.into());
        }
        Ok(())
    }
}

/// The `expected` and `commandId` a shared/cas operation must carry.
fn cas_preconditions(pre: &Precondition) -> Result<(&Value, &str), StoreError> {
    let expected = pre.expected.as_ref().ok_or_else(|| {
        StoreError::Invalid(
            "a shared/cas operation needs `expected` (null = the key must be absent)".to_string(),
        )
    })?;
    let command_id = pre
        .command_id
        .as_deref()
        .filter(|id| is_valid_command_id(id))
        .ok_or_else(|| {
            StoreError::Invalid("a shared/cas operation needs a valid `commandId`".to_string())
        })?;
    Ok((expected, command_id))
}

fn check_expected(current: Option<&Record>, expected: &Value) -> Result<(), StoreError> {
    let actual = current.map_or(&Value::Null, |record| &record.v);
    if actual == expected {
        Ok(())
    } else {
        Err(StoreError::CasFailed(
            "store write rejected: value changed concurrently".to_string(),
        ))
    }
}

#[cfg(test)]
mod gc_tests;
#[cfg(test)]
mod legacy_tests;
#[cfg(test)]
mod lww_tests;
#[cfg(test)]
mod manifest_import_tests;
#[cfg(test)]
mod scope_tests;
#[cfg(test)]
mod tests;
