use serde_json::json;

use super::lww::merge;
use super::records::Record;
use super::*;

fn record(v: Value, rev: u64, fields: Option<&[(&str, u64)]>) -> Record {
    Record {
        v,
        rev,
        cid: "t".to_string(),
        cmd: None,
        fields: fields.map(|f| f.iter().map(|(k, r)| ((*k).to_string(), *r)).collect()),
    }
}

fn wrapped(data: Value) -> Value {
    json!({ "_version": 1, "data": data })
}

#[test]
fn a_new_key_stores_the_value_with_every_field_at_the_new_revision() {
    let merged = merge(None, &json!({ "a": 1, "b": 2 }), 0, 1);
    assert!(merged.changed);
    assert_eq!(merged.value, json!({ "a": 1, "b": 2 }));
    assert_eq!(merged.fields.get("a"), Some(&1));
    assert_eq!(merged.fields.get("b"), Some(&1));
}

#[test]
fn concurrent_edits_of_different_fields_both_survive() {
    // Both devices read revision 3; A set f1 (-> rev 4), now B sets f2.
    let current = record(json!({ "f1": "A", "f2": 0 }), 4, Some(&[("f1", 4), ("f2", 1)]));
    let merged = merge(Some(&current), &json!({ "f1": 0, "f2": "B" }), 3, 5);
    assert!(merged.changed);
    assert_eq!(merged.value, json!({ "f1": "A", "f2": "B" }), "A's field is kept");
    assert_eq!(merged.fields.get("f1"), Some(&4));
    assert_eq!(merged.fields.get("f2"), Some(&5));
}

#[test]
fn a_field_changed_since_the_base_is_never_overwritten() {
    let current = record(json!({ "f": "A" }), 4, Some(&[("f", 4)]));
    let merged = merge(Some(&current), &json!({ "f": "B" }), 3, 5);
    assert!(!merged.changed);
    assert_eq!(merged.value, json!({ "f": "A" }));
    // From the current base the same edit applies.
    let merged = merge(Some(&current), &json!({ "f": "B" }), 4, 5);
    assert!(merged.changed);
    assert_eq!(merged.value, json!({ "f": "B" }));
}

#[test]
fn a_removed_field_leaves_a_tombstone_that_a_stale_writer_cannot_undo() {
    let current = record(json!({ "keep": 1, "gone": 2 }), 3, Some(&[("keep", 1), ("gone", 1)]));
    let removed = merge(Some(&current), &json!({ "keep": 1 }), 3, 4);
    assert!(removed.changed);
    assert_eq!(removed.value, json!({ "keep": 1 }));
    assert_eq!(removed.fields.get("gone"), Some(&4), "tombstone revision");

    let after = record(removed.value, 4, Some(&removed.fields.iter().map(|(k, r)| (k.as_str(), *r)).collect::<Vec<_>>()));
    // A writer based on revision 3 re-sends the removed field: refused.
    let stale = merge(Some(&after), &json!({ "keep": 1, "gone": 2 }), 3, 5);
    assert!(!stale.changed);
    assert_eq!(stale.value, json!({ "keep": 1 }));
    // A writer that has seen the removal may add it back.
    let fresh = merge(Some(&after), &json!({ "keep": 1, "gone": 9 }), 4, 5);
    assert!(fresh.changed);
    assert_eq!(fresh.value, json!({ "keep": 1, "gone": 9 }));
}

#[test]
fn a_field_a_writer_never_saw_is_not_removed_by_its_stale_value() {
    // B (base 3) never saw `added` (rev 4); its whole-value write omits it.
    let current = record(json!({ "a": 1, "added": true }), 4, Some(&[("a", 1), ("added", 4)]));
    let merged = merge(Some(&current), &json!({ "a": 2 }), 3, 5);
    assert_eq!(merged.value, json!({ "a": 2, "added": true }));
}

#[test]
fn an_identical_merge_is_a_no_op() {
    let current = record(json!({ "a": 1 }), 2, Some(&[("a", 2)]));
    let merged = merge(Some(&current), &json!({ "a": 1 }), 0, 3);
    assert!(!merged.changed);
}

#[test]
fn the_wrapper_is_kept_and_fields_are_the_keys_of_data() {
    let current = record(wrapped(json!({ "theme": "dark", "zoom": 1 })), 2, Some(&[("theme", 1), ("zoom", 2)]));
    let merged = merge(Some(&current), &wrapped(json!({ "theme": "light", "zoom": 5 })), 1, 3);
    assert!(merged.changed);
    assert_eq!(merged.value, wrapped(json!({ "theme": "light", "zoom": 1 })));
    assert_eq!(merged.fields.get("theme"), Some(&3));
    assert_eq!(merged.fields.get("zoom"), Some(&2));
}

#[test]
fn an_array_is_one_field() {
    let current = record(wrapped(json!(["a"])), 2, Some(&[("\u{0}whole", 2)]));
    let stale = merge(Some(&current), &wrapped(json!(["b"])), 1, 3);
    assert!(!stale.changed);
    assert_eq!(stale.value, wrapped(json!(["a"])));
    let fresh = merge(Some(&current), &wrapped(json!(["b"])), 2, 3);
    assert!(fresh.changed);
    assert_eq!(fresh.value, wrapped(json!(["b"])));
}

#[test]
fn a_migrated_record_without_field_revisions_counts_every_field_at_its_revision() {
    let current = record(json!({ "a": 1, "b": 2 }), 1, None);
    let stale = merge(Some(&current), &json!({ "a": 9, "b": 2 }), 0, 2);
    assert!(!stale.changed);
    let fresh = merge(Some(&current), &json!({ "a": 9, "b": 2 }), 1, 2);
    assert!(fresh.changed);
    assert_eq!(fresh.value, json!({ "a": 9, "b": 2 }));
}

#[test]
fn a_value_of_a_different_shape_replaces_the_whole_only_from_the_current_base() {
    let current = record(json!({ "a": 1 }), 2, Some(&[("a", 2)]));
    assert!(!merge(Some(&current), &json!([1]), 1, 3).changed);
    let replaced = merge(Some(&current), &json!([1]), 2, 3);
    assert!(replaced.changed);
    assert_eq!(replaced.value, json!([1]));
}

#[test]
fn per_field_merge_through_the_store_bumps_the_revision_only_on_change() {
    let dir = tests::tempdir_like("lww-store");
    let store = tests::open(&dir.join("store.json"));
    let a = tests::who("dev-a", "tab-a");
    let b = tests::who("dev-b", "tab-b");
    let key = "shared/lww/settings/app";
    let write = |value: Value, base: Option<u64>, who: &ClientIdentity| {
        let pre = Precondition { base_revision: base, ..Precondition::default() };
        store.write(key, value, pre, who, 1)
    };

    // First write to an absent key needs no base.
    let first = write(wrapped(json!({ "f1": 0, "f2": 0 })), None, &a).unwrap();
    assert_eq!(first, WriteOutcome::Shared { value: wrapped(json!({ "f1": 0, "f2": 0 })), revision: 1, merged: false });

    // Both devices read revision 1; A sets f1, B sets f2.
    let a_write = write(wrapped(json!({ "f1": "A", "f2": 0 })), Some(1), &a).unwrap();
    assert_eq!(a_write, WriteOutcome::Shared { value: wrapped(json!({ "f1": "A", "f2": 0 })), revision: 2, merged: false });
    let b_write = write(wrapped(json!({ "f1": 0, "f2": "B" })), Some(1), &b).unwrap();
    assert_eq!(
        b_write,
        WriteOutcome::Shared { value: wrapped(json!({ "f1": "A", "f2": "B" })), revision: 3, merged: true },
        "B's reply carries the merged value and the new revision"
    );

    // Re-sending the same merge changes nothing and does not bump the revision.
    let noop = write(wrapped(json!({ "f1": "A", "f2": "B" })), Some(3), &a).unwrap();
    assert_eq!(noop, WriteOutcome::Shared { value: wrapped(json!({ "f1": "A", "f2": "B" })), revision: 3, merged: false });
    let read = store.read(key, &a, 2).unwrap();
    assert_eq!((read.revision, read.client_instance_id.as_deref()), (3, Some("tab-b")));
    tests::cleanup(&dir);
}

#[test]
fn writing_an_existing_shared_key_without_a_base_revision_is_refused() {
    let dir = tests::tempdir_like("lww-base");
    let store = tests::open(&dir.join("store.json"));
    let a = tests::who("dev-a", "t");
    let key = "shared/lww/settings/app";
    tests::put(&store, key, json!({ "a": 1 }), &a);
    let before = store.read(key, &a, 1).unwrap();
    let refused = store.write(key, json!({ "a": 2 }), Precondition::default(), &a, 2);
    assert!(matches!(refused, Err(StoreError::BaseRequired)));
    assert_eq!(store.read(key, &a, 3).unwrap(), before);
    tests::cleanup(&dir);
}
