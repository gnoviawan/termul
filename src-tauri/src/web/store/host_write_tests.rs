use serde_json::json;

use super::tests::{cleanup, open, tempdir_like, who};

const KEY: &str = "shared/lww/host-only";

#[test]
fn insert_if_absent_keeps_a_stored_value_and_replace_as_host_overwrites_it() {
    let dir = tempdir_like("host-write");
    let file = dir.join("store.json");
    let store = open(&file);

    assert!(store.insert_if_absent(KEY, json!(1), 1).unwrap());
    assert!(!store.insert_if_absent(KEY, json!(2), 2).unwrap());
    assert_eq!(store.peek(KEY).unwrap(), Some(json!(1)));

    store.replace_as_host(KEY, json!(3), 3).unwrap();
    assert_eq!(store.peek(KEY).unwrap(), Some(json!(3)));
    let read = store.read(KEY, &who("d1", "t"), 4).unwrap();
    assert_eq!(read.revision, 2, "a replacement bumps the revision");

    drop(store);
    assert_eq!(open(&file).peek(KEY).unwrap(), Some(json!(3)));
    cleanup(&dir);
}

#[test]
fn host_writes_refuse_a_key_outside_shared_lww() {
    let dir = tempdir_like("host-write-scope");
    let store = open(&dir.join("store.json"));
    assert!(store.insert_if_absent("shared/cas/k", json!(1), 1).is_err());
    assert!(store.replace_as_host("device/d1/k", json!(1), 1).is_err());
    assert_eq!(store.peek("device/d1/k").unwrap(), None);
    cleanup(&dir);
}
