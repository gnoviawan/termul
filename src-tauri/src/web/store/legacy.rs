//! Pre-v2 (flat) store migration and first-device adoption (issue #1073).
//!
//! A flat store holds logical keys (`settings/app`, `shell-layout`, …). On
//! open, the keys that were shared across devices are renamed in place to
//! `shared/lww/<k>` / `shared/cas/<k>` (the table below, pinned equal to the
//! TS `KEY_SCOPES` block in `persistence.types.ts` by `legacy_tests`); every
//! other key was per-device state of an unknown device and is parked in
//! `host.legacy` until the first authenticated device that issues a store
//! request adopts it into its own `device/<id>/` partition. Adoption also
//! carries the retired workspace manifests ([`super::manifest_import`]) into
//! that partition, in the same write.

use std::collections::btree_map::Entry;
use std::collections::BTreeMap;

use serde_json::Value;

use super::records::{Adopted, ExtraKeys, HostMeta, Loaded, Record};
use super::scope::device_prefix;

/// Writer stamp of a record produced by the migration.
pub const LEGACY_CLIENT_INSTANCE: &str = "legacy";

/// Logical keys that were shared across devices and merge per field. An entry
/// ending in `/*` names a prefix family.
pub const SHARED_LWW_KEYS: &[&str] = &[
    "settings/app",
    "settings/keyboard-shortcuts",
    "settings/context-bar",
    "settings/toc",
    "settings/pinned-commands",
    "agents/custom",
    "acp/agents",
    "acp/auth-methods",
    "acp/mcp-servers",
];

/// Logical keys that were shared across devices and are compare-and-set.
pub const SHARED_CAS_KEYS: &[&str] = &["ssh/profiles"];

/// Parked device-key families whose logical key changed: `(old prefix, new
/// prefix)`. The renderer reads a project's editor state from `workspace/<id>`
/// since the workspace manifest was retired; it used to be `editor-state/<id>`.
pub const DEVICE_KEY_RENAMES: &[(&str, &str)] = &[("editor-state/", "workspace/")];

/// The logical key a parked device key is adopted under.
#[must_use]
pub fn adopted_key(flat_key: &str) -> String {
    DEVICE_KEY_RENAMES
        .iter()
        .find_map(|(old, new)| flat_key.strip_prefix(old).map(|rest| format!("{new}{rest}")))
        .unwrap_or_else(|| flat_key.to_string())
}

pub(super) fn listed(table: &[&str], key: &str) -> bool {
    table.iter().any(|entry| match entry.strip_suffix('*') {
        Some(prefix) if prefix.ends_with('/') => key.starts_with(prefix),
        _ => *entry == key,
    })
}

/// The scoped key a flat shared key migrates to, or `None` for a device key.
#[must_use]
pub fn shared_key(flat_key: &str) -> Option<String> {
    if listed(SHARED_LWW_KEYS, flat_key) {
        Some(format!("shared/lww/{flat_key}"))
    } else if listed(SHARED_CAS_KEYS, flat_key) {
        Some(format!("shared/cas/{flat_key}"))
    } else {
        None
    }
}

/// Build the v2 state of a flat (v1 or unversioned) key map.
pub fn from_flat(flat: BTreeMap<String, Value>, extra: ExtraKeys) -> Loaded {
    let mut data = BTreeMap::new();
    let mut host = HostMeta::default();
    for (key, value) in flat {
        match shared_key(&key) {
            Some(scoped) => {
                data.insert(scoped, imported(value));
            }
            None => {
                host.legacy.insert(key, value);
            }
        }
    }
    Loaded {
        data,
        host,
        extra,
        migrated: true,
    }
}

/// A record stamped as imported by a migration (revision 1, writer `legacy`).
pub(super) fn imported(value: Value) -> Record {
    Record {
        v: value,
        rev: 1,
        cid: LEGACY_CLIENT_INSTANCE.to_string(),
        cmd: None,
        fields: None,
    }
}

/// What one adoption moved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Adoption {
    /// Parked pre-v2 keys moved into the partition.
    pub parked: usize,
    /// Full keys of the retired workspace manifests written as
    /// `workspace/<projectId>`, in write order.
    pub workspaces: Vec<String>,
}

/// Move the parked keys, then the converted workspace manifests
/// (`(projectId, value)`), into `device_id`'s partition and mark them adopted.
/// Returns `None` (and changes nothing) when there is nothing to adopt or the
/// device has no namespace. A key the partition already holds is kept, so a
/// manifest never replaces a parked `editor-state/<projectId>`.
pub fn adopt(
    data: &mut BTreeMap<String, Record>,
    host: &mut HostMeta,
    device_id: &str,
    now_ms: u64,
    workspaces: Vec<(String, Value)>,
) -> Option<Adoption> {
    let prefix = device_prefix(device_id)?;
    if host.legacy.is_empty() && workspaces.is_empty() {
        return None;
    }
    let parked = host.legacy.len();
    for (key, value) in std::mem::take(&mut host.legacy) {
        data.entry(format!("{prefix}{}", adopted_key(&key)))
            .or_insert_with(|| imported(value));
    }
    let mut written = Vec::new();
    for (project_id, value) in workspaces {
        let key = format!("{prefix}workspace/{project_id}");
        if let Entry::Vacant(slot) = data.entry(key.clone()) {
            slot.insert(imported(value));
            written.push(key);
        }
    }
    host.adopted = Some(Adopted {
        device_id: device_id.to_string(),
        at_ms: now_ms,
    });
    Some(Adoption {
        parked,
        workspaces: written,
    })
}
