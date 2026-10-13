//! One-shot import of the desktop's retired plugin-store file (issue #1073).
//!
//! Until the desktop renderer reached the host store over the Channel carrier,
//! it kept its state in the tauri-plugin-store file `<app data dir>/termul-data.json`:
//! one JSON object of logical key → value, every value wrapped
//! `{"_version":1,"data":…}` by the renderer. That file stops being an
//! authority: the first device that reaches the desktop store over the desktop
//! carrier ([`WebStore::claim_desktop_import`]) takes it over, in one write:
//!
//! - keys that are shared across devices ([`super::legacy`]'s table) become
//!   `shared/lww/<k>` / `shared/cas/<k>`, only where the store holds no value
//!   (a shared-live client may have written one already) and the key was not
//!   deleted on purpose;
//! - every other key becomes `device/<id>/<k>` (`editor-state/<pid>` as
//!   `workspace/<pid>`), only where the partition holds none;
//! - a value over the per-value cap is skipped with a warning; keys that do not
//!   fit the device's byte budget (or the 10 MiB file cap) are dropped with a
//!   warning, the largest first, so the many small keys survive.
//!
//! This cannot reuse the generic adoption ([`super::legacy::adopt`]): the
//! desktop store may have been adopted long before (shared-live web clients),
//! so the import has its own pending set and its own marker
//! (`host.desktopImported`). The pending set is read from the file at startup
//! and lives in memory; the file stays the durable copy until the store write
//! succeeded. Afterwards the file is renamed to
//! `termul-data.json.imported-<unix-secs>` (a backup, never deleted). A failed
//! write leaves the file and the pending set for the next request; an
//! unreadable or corrupt file is skipped with a warning and left in place.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};
use tracing::{info, warn};

use super::legacy::{adopted_key, imported, shared_key};
use super::manifest_import::retired_target;
use super::records::{record_bytes, Adopted, Record};
use super::scope::device_prefix;
use super::{unix_ms, State, StoreError, WebStore, MAX_DATA_BYTES, STORE_VALUE_MAX_BYTES};
use crate::web::ws::ClientIdentity;

/// The plugin-store file the desktop renderer used, under the app data dir.
pub const DESKTOP_LEGACY_FILE: &str = "termul-data.json";

/// Where a desktop host keeps the retired plugin-store file.
#[must_use]
pub fn desktop_legacy_file(data_dir: &Path) -> PathBuf {
    data_dir.join(DESKTOP_LEGACY_FILE)
}

/// Largest plugin-store file read at startup.
const MAX_LEGACY_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// Longest key imported (the bound the `store_*` requests apply to a key).
const MAX_KEY_BYTES: usize = 1024;

/// Room left unused under the file cap, for the envelope and byte-count drift.
const FILE_MARGIN_BYTES: usize = 16 * 1024;

/// Bytes a record adds to the serialized `data` map beyond [`record_bytes`]:
/// the key's quotes, the colon and the comma.
const ENTRY_OVERHEAD_BYTES: usize = 4;

/// What the plugin-store file held, sorted into where each key goes.
pub(super) struct DesktopImport {
    path: PathBuf,
    /// `(scoped shared key, wrapped value)`, by key.
    shared: Vec<(String, Value)>,
    /// `(logical device key, wrapped value)`, by key (`editor-state/` already
    /// renamed).
    device: Vec<(String, Value)>,
}

/// What an [`apply`] moved into the store.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct Applied {
    pub shared: usize,
    pub device: usize,
    /// Keys the store already held (kept).
    pub kept: usize,
    /// Keys dropped because they did not fit.
    pub dropped: usize,
}

/// The renderer wraps every value `{_version, data}`; a bare value (written by
/// a build that did not) gets the same wrapper, which is what the facade reads.
fn stored(value: Value) -> Value {
    if value
        .as_object()
        .is_some_and(|map| map.contains_key("_version"))
    {
        value
    } else {
        json!({ "_version": 1, "data": value })
    }
}

/// Parse the plugin-store file at `path`. `None` when it is absent, unreadable
/// or corrupt (warned about; the file is left in place).
fn read(path: &Path) -> Option<DesktopImport> {
    let length = match fs::metadata(path) {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return None,
        Err(error) => {
            warn!(
                target: "termul::web::store",
                "could not read the desktop plugin-store file '{}': {error}; it is left in place",
                path.display()
            );
            return None;
        }
    };
    if length > MAX_LEGACY_FILE_BYTES {
        warn!(
            target: "termul::web::store",
            "the desktop plugin-store file '{}' is {length} bytes (max {MAX_LEGACY_FILE_BYTES}); it is skipped and left in place",
            path.display()
        );
        return None;
    }
    let parsed = fs::read(path)
        .map_err(|error| error.to_string())
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).map_err(|e| e.to_string()));
    let entries = match parsed {
        Ok(Value::Object(entries)) => entries,
        Ok(_) => {
            warn!(
                target: "termul::web::store",
                "the desktop plugin-store file '{}' is not a JSON object; it is skipped and left in place",
                path.display()
            );
            return None;
        }
        Err(reason) => {
            warn!(
                target: "termul::web::store",
                "could not parse the desktop plugin-store file '{}': {reason}; it is skipped and left in place",
                path.display()
            );
            return None;
        }
    };
    let mut import = DesktopImport {
        path: path.to_path_buf(),
        shared: Vec::new(),
        device: Vec::new(),
    };
    for (key, value) in entries {
        if value.is_null() || key.is_empty() || key.len() > MAX_KEY_BYTES {
            continue;
        }
        let value = stored(value);
        let bytes = serde_json::to_vec(&value).map_or(usize::MAX, |bytes| bytes.len());
        if bytes > STORE_VALUE_MAX_BYTES {
            warn!(
                target: "termul::web::store",
                "skipped the desktop key '{key}': its value is {bytes} bytes (max {STORE_VALUE_MAX_BYTES})"
            );
            continue;
        }
        match shared_key(&key) {
            Some(scoped) => import.shared.push((scoped, value)),
            None => import.device.push((adopted_key(&key), value)),
        }
    }
    import.shared.sort_by(|a, b| a.0.cmp(&b.0));
    import.device.sort_by(|a, b| a.0.cmp(&b.0));
    Some(import)
}

/// Rename the imported file to `<name>.imported-<unix-secs>`. A failure only
/// warns: the store already holds the import and its marker.
fn retire(path: &Path, now_ms: u64) {
    let Some(target) = retired_target(path, now_ms) else {
        return;
    };
    match fs::rename(path, &target) {
        Ok(()) => info!(
            target: "termul::web::store",
            "desktop plugin-store file imported; it is kept as '{}'",
            target.display()
        ),
        Err(error) => warn!(
            target: "termul::web::store",
            "could not rename the imported desktop plugin-store file '{}' to '{}': {error}",
            path.display(),
            target.display()
        ),
    }
}

/// Move `import` into `state` for `device_id`, within `partition_budget` bytes
/// for the device's partition and `file_room` bytes for the whole `data` map.
/// Sets the `desktopImported` marker. `None` (nothing changed) when the device
/// has no namespace.
pub(super) fn apply(
    import: &DesktopImport,
    state: &mut State,
    device_id: &str,
    now_ms: u64,
    partition_budget: u64,
    mut file_room: usize,
) -> Option<Applied> {
    let prefix = device_prefix(device_id)?;
    let mut applied = Applied::default();
    let mut partition_used = state.partition_bytes(&prefix);

    // Shared keys first: few, small, and every device depends on them.
    for (key, value) in &import.shared {
        if state.data.contains_key(key) || state.host.deleted_revs.contains_key(key) {
            applied.kept += 1;
            continue;
        }
        let record = imported(value.clone());
        let cost = record_bytes(key, &record) + ENTRY_OVERHEAD_BYTES;
        if cost > file_room {
            warn!(
                target: "termul::web::store",
                "dropped the desktop key '{key}': the store file would exceed its size limit"
            );
            applied.dropped += 1;
            continue;
        }
        file_room -= cost;
        state.data.insert(key.clone(), record);
        applied.shared += 1;
    }

    // Device keys, smallest first: when the budget runs out the largest keys
    // (scrollback, snapshots) are the ones dropped.
    let mut device: Vec<(String, Record, usize)> = Vec::new();
    for (key, value) in &import.device {
        let full = format!("{prefix}{key}");
        if state.data.contains_key(&full) {
            applied.kept += 1;
            continue;
        }
        let record = imported(value.clone());
        let bytes = record_bytes(&full, &record);
        device.push((full, record, bytes));
    }
    device.sort_by(|a, b| (a.2, &a.0).cmp(&(b.2, &b.0)));
    for (full, record, bytes) in device {
        let cost = bytes + ENTRY_OVERHEAD_BYTES;
        if partition_used + bytes > usize::try_from(partition_budget).unwrap_or(usize::MAX)
            || cost > file_room
        {
            warn!(
                target: "termul::web::store",
                "dropped the desktop key '{full}': it does not fit the device partition budget ({partition_budget} bytes) or the store file limit"
            );
            applied.dropped += 1;
            continue;
        }
        partition_used += bytes;
        file_room -= cost;
        state.data.insert(full, record);
        applied.device += 1;
    }

    state.host.desktop_imported = Some(Adopted {
        device_id: device_id.to_string(),
        at_ms: now_ms,
    });
    Some(applied)
}

impl WebStore {
    /// Import the desktop's retired plugin-store file at `path` into the first
    /// device that reaches the store over the desktop carrier (see the module
    /// doc). A no-op when the file is absent or unreadable. When an earlier run
    /// imported it but could not rename it, the rename is tried again.
    #[must_use]
    pub fn with_desktop_legacy(self, path: PathBuf) -> Self {
        if let Some(state) = self.inner.lock().as_mut() {
            if state.host.desktop_imported.is_some() {
                if path.is_file() {
                    retire(&path, unix_ms());
                }
            } else if let Some(import) = read(&path) {
                state.desktop_import = Some(Arc::new(import));
            }
        }
        self
    }

    /// Run before a store request that arrived over the desktop carrier: the
    /// first such device takes over the pending plugin-store import. A failed
    /// write leaves the import pending and returns the error, so the request
    /// never sees a store that is missing keys it was about to import.
    pub fn claim_desktop_import(
        &self,
        identity: &ClientIdentity,
        now_ms: u64,
    ) -> Result<(), StoreError> {
        self.with_state(|state| {
            let Some(import) = state.desktop_import.clone() else {
                return Ok(());
            };
            if device_prefix(&identity.device_id).is_none() {
                return Ok(());
            }
            let held = serde_json::to_vec(&state.data)
                .map_err(|error| StoreError::Io(io::Error::other(error.to_string())))?
                .len();
            let file_room = MAX_DATA_BYTES.saturating_sub(held + FILE_MARGIN_BYTES);
            let mut next = state.clone();
            next.desktop_import = None;
            let Some(applied) = apply(
                &import,
                &mut next,
                &identity.device_id,
                now_ms,
                self.policy.partition_byte_budget,
                file_room,
            ) else {
                return Ok(());
            };
            next.persist(&self.path, &self.extra, now_ms)?;
            retire(&import.path, now_ms);
            info!(
                target: "termul::web::store",
                device_id = %ClientIdentity::log_label(&identity.device_id),
                shared = applied.shared,
                device = applied.device,
                kept = applied.kept,
                dropped = applied.dropped,
                "device imported the desktop plugin-store file"
            );
            *state = next;
            Ok(())
        })
    }
}
