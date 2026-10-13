//! Pre-v2 (flat) store migration and first-device adoption (issue #1073).
//!
//! A flat store holds logical keys (`settings/app`, `shell-layout`, …). On
//! open, the keys that were shared across devices are renamed in place to
//! `shared/lww/<k>` / `shared/cas/<k>` (the table below, pinned equal to the
//! TS `KEY_SCOPES` block in `persistence.types.ts` by `legacy_tests`); every
//! other key was per-device state of an unknown device and is parked in
//! `host.legacy` until the first authenticated device that issues a store
//! request adopts it into its own `device/<id>/` partition.

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

fn imported(value: Value) -> Record {
    Record {
        v: value,
        rev: 1,
        cid: LEGACY_CLIENT_INSTANCE.to_string(),
        cmd: None,
        fields: None,
    }
}

/// Move the parked keys into `device_id`'s partition and mark them adopted.
/// Returns `false` (and changes nothing) when there is nothing to adopt or the
/// device has no namespace. A key the partition already holds is kept.
pub fn adopt(
    data: &mut BTreeMap<String, Record>,
    host: &mut HostMeta,
    device_id: &str,
    now_ms: u64,
) -> bool {
    let Some(prefix) = device_prefix(device_id) else {
        return false;
    };
    if host.legacy.is_empty() {
        return false;
    }
    for (key, value) in std::mem::take(&mut host.legacy) {
        data.entry(format!("{prefix}{key}"))
            .or_insert_with(|| imported(value));
    }
    host.adopted = Some(Adopted {
        device_id: device_id.to_string(),
        at_ms: now_ms,
    });
    true
}
