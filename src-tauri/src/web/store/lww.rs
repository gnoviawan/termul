//! Per-field last-writer-wins merge for `shared/lww/` keys (issue #1073).
//!
//! A write carries the whole value plus the `baseRevision` it was derived
//! from. A field of it is accepted only when nobody changed that field since
//! the base (`field revision <= base`); otherwise the current field is kept.
//! A field the writer dropped is removed under the same rule and leaves a
//! tombstone revision, so a stale writer cannot resurrect it.
//!
//! The "fields" of a value are the top-level keys of an object. Clients wrap
//! values as `{"_version": n, "data": …}`; the fields are then the keys of
//! `data` when it is an object. Any other value (an array, a scalar) is ONE
//! field. When the current and the incoming value differ in shape, the whole
//! value is one field.

use std::collections::BTreeMap;

use serde_json::{Map, Value};

use super::records::Record;

/// Field name of a value that is not an object (one field for the whole).
const WHOLE: &str = "\u{0}whole";
/// Tombstones kept per record; the oldest are dropped past this.
const MAX_TOMBSTONES: usize = 256;

/// Result of merging an incoming write into the current record.
#[derive(Debug, PartialEq)]
pub struct Merged {
    /// The stored value after the merge (wrapper included).
    pub value: Value,
    /// Per-field revisions after the merge (tombstones included).
    pub fields: BTreeMap<String, u64>,
    /// `false` when the merge left the stored value and fields untouched: no
    /// revision bump, no write.
    pub changed: bool,
}

/// The value split into its wrapper (`_version`) and the part holding fields.
struct Shape<'a> {
    version: Option<&'a Value>,
    inner: &'a Value,
}

fn shape(value: &Value) -> Shape<'_> {
    if let Value::Object(map) = value {
        if map.len() == 2 {
            if let (Some(version), Some(inner)) = (map.get("_version"), map.get("data")) {
                return Shape {
                    version: Some(version),
                    inner,
                };
            }
        }
    }
    Shape {
        version: None,
        inner: value,
    }
}

fn rewrap(version: Option<&Value>, inner: Value) -> Value {
    match version {
        Some(version) => {
            let mut map = Map::new();
            map.insert("_version".to_string(), version.clone());
            map.insert("data".to_string(), inner);
            Value::Object(map)
        }
        None => inner,
    }
}

/// Revisions of a freshly written value: every field at `rev`.
fn stamp_all(inner: &Value, rev: u64) -> BTreeMap<String, u64> {
    match inner {
        Value::Object(map) => map.keys().map(|field| (field.clone(), rev)).collect(),
        _ => BTreeMap::from([(WHOLE.to_string(), rev)]),
    }
}

/// Revision at which `field` last changed in `current` (0 = never existed).
fn field_rev(current: &Record, present: bool, field: &str) -> u64 {
    match current.fields.as_ref().and_then(|fields| fields.get(field)) {
        Some(rev) => *rev,
        // A migrated record has no per-field revisions: every field it holds
        // changed at the record's revision.
        None if present => current.rev,
        None => 0,
    }
}

/// Merge `incoming` (derived from revision `base`) into `current`, stamping
/// accepted fields with `next_rev` (the revision the record gets if it changes).
#[must_use]
pub fn merge(current: Option<&Record>, incoming: &Value, base: u64, next_rev: u64) -> Merged {
    let in_shape = shape(incoming);
    let Some(current) = current else {
        return Merged {
            value: incoming.clone(),
            fields: stamp_all(in_shape.inner, next_rev),
            changed: true,
        };
    };
    let cur_shape = shape(&current.v);
    let cur_fields = current.fields.clone().unwrap_or_default();
    match (cur_shape.inner, in_shape.inner) {
        (Value::Object(cur), Value::Object(inc)) if cur_shape.version.is_some() == in_shape.version.is_some() => {
            merge_objects(current, &cur_shape, in_shape.version, cur, inc, base, next_rev)
        }
        (cur, inc)
            if !cur.is_object()
                && !inc.is_object()
                && cur_shape.version.is_some() == in_shape.version.is_some() =>
        {
            if cur == inc || field_rev(current, true, WHOLE) > base {
                return unchanged(current, cur_fields);
            }
            Merged {
                value: incoming.clone(),
                fields: BTreeMap::from([(WHOLE.to_string(), next_rev)]),
                changed: true,
            }
        }
        // Different shapes: the whole value is one field.
        _ => {
            if current.v == *incoming || current.rev > base {
                return unchanged(current, cur_fields);
            }
            Merged {
                value: incoming.clone(),
                fields: stamp_all(in_shape.inner, next_rev),
                changed: true,
            }
        }
    }
}

fn unchanged(current: &Record, fields: BTreeMap<String, u64>) -> Merged {
    Merged {
        value: current.v.clone(),
        fields,
        changed: false,
    }
}

fn merge_objects(
    current: &Record,
    cur_shape: &Shape<'_>,
    in_version: Option<&Value>,
    cur: &Map<String, Value>,
    inc: &Map<String, Value>,
    base: u64,
    next_rev: u64,
) -> Merged {
    let mut out = cur.clone();
    let mut fields = current.fields.clone().unwrap_or_default();
    let mut changed = false;
    for (field, value) in inc {
        if cur.get(field) == Some(value) {
            continue;
        }
        if field_rev(current, cur.contains_key(field), field) <= base {
            out.insert(field.clone(), value.clone());
            fields.insert(field.clone(), next_rev);
            changed = true;
        }
    }
    for field in cur.keys().filter(|field| !inc.contains_key(*field)) {
        if field_rev(current, true, field) <= base {
            out.remove(field);
            fields.insert(field.clone(), next_rev);
            changed = true;
        }
    }
    if !changed {
        return unchanged(current, current.fields.clone().unwrap_or_default());
    }
    prune_tombstones(&mut fields, &out);
    Merged {
        value: rewrap(in_version.or(cur_shape.version), Value::Object(out)),
        fields,
        changed: true,
    }
}

/// Drop the oldest tombstones past [`MAX_TOMBSTONES`].
fn prune_tombstones(fields: &mut BTreeMap<String, u64>, live: &Map<String, Value>) {
    let mut tombstones: Vec<(u64, String)> = fields
        .iter()
        .filter(|(field, _)| !live.contains_key(*field))
        .map(|(field, rev)| (*rev, field.clone()))
        .collect();
    if tombstones.len() <= MAX_TOMBSTONES {
        return;
    }
    tombstones.sort();
    for (_, field) in tombstones.drain(..tombstones.len() - MAX_TOMBSTONES) {
        fields.remove(&field);
    }
}
