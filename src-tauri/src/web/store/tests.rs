use serde_json::json;

use super::*;

/// Minimal std-only temp dir (reuses the repo's pid+nanos pattern — no
/// `tempfile` dev-dep).
pub(super) fn tempdir_like(label: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let p = std::env::temp_dir().join(format!(
        "termul-store-{label}-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&p).expect("create tempdir");
    p
}

pub(super) fn cleanup(p: &PathBuf) {
    let _ = std::fs::remove_dir_all(p);
}

pub(super) fn who(device: &str, tab: &str) -> ClientIdentity {
    ClientIdentity {
        device_id: device.to_string(),
        client_instance_id: tab.to_string(),
    }
}

pub(super) fn open(file: &Path) -> WebStore {
    WebStore::open(file.to_path_buf(), StorePolicy::default()).unwrap()
}

pub(super) fn open_with(file: &Path, policy: StorePolicy) -> WebStore {
    WebStore::open(file.to_path_buf(), policy).unwrap()
}

pub(super) fn backups_with_prefix(dir: &PathBuf, prefix: &str) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .expect("read dir")
        .filter_map(Result::ok)
        .filter(|e| {
            e.file_name()
                .to_str()
                .is_some_and(|n| n.starts_with(prefix) && n.ends_with(".bak"))
        })
        .map(|e| e.path())
        .collect()
}

pub(super) fn on_disk(file: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap()
}

/// Device-key write with no preconditions.
pub(super) fn put(store: &WebStore, key: &str, value: Value, who: &ClientIdentity) -> WriteOutcome {
    store
        .write(key, value, Precondition::default(), who, 1)
        .unwrap()
}

fn cas(expected: Value, command_id: &str) -> Precondition {
    Precondition {
        expected: Some(expected),
        command_id: Some(command_id.to_string()),
        ..Precondition::default()
    }
}

#[test]
fn device_values_round_trip_with_revisions_across_a_restart() {
    let dir = tempdir_like("roundtrip");
    let file = dir.join("store.json");
    let a1 = who("dev-a", "tab-1");
    let store = open(&file);
    let missing = store.read("device/dev-a/missing", &a1, 1).unwrap();
    assert_eq!(
        missing,
        Stamped {
            value: None,
            revision: 0,
            client_instance_id: None
        }
    );

    assert_eq!(
        put(&store, "device/dev-a/layout", json!({ "n": 1 }), &a1),
        WriteOutcome::Device { revision: 1 }
    );
    assert_eq!(
        put(&store, "device/dev-a/layout", json!({ "n": 2 }), &a1),
        WriteOutcome::Device { revision: 2 }
    );

    // A restart reloads the value AND its revision: a watermark must not reset.
    let reloaded = open(&file);
    let read = reloaded.read("device/dev-a/layout", &a1, 2).unwrap();
    assert_eq!(read.value, Some(json!({ "n": 2 })));
    assert_eq!(read.revision, 2);
    assert_eq!(read.client_instance_id.as_deref(), Some("tab-1"));
    assert_eq!(
        put(&reloaded, "device/dev-a/layout", json!({ "n": 3 }), &a1),
        WriteOutcome::Device { revision: 3 }
    );

    assert!(reloaded
        .delete("device/dev-a/layout", Precondition::default(), &a1, 3)
        .unwrap());
    assert!(!reloaded
        .delete("device/dev-a/layout", Precondition::default(), &a1, 3)
        .unwrap());
    assert_eq!(open(&file).read("device/dev-a/layout", &a1, 4).unwrap().revision, 0);
    cleanup(&dir);
}

#[test]
fn two_tabs_of_one_device_converge_on_the_last_arrival_with_its_stamp() {
    let dir = tempdir_like("two-tabs");
    let store = open(&dir.join("store.json"));
    let tab1 = who("dev-a", "tab-1");
    let tab2 = who("dev-a", "tab-2");
    put(&store, "device/dev-a/shell-layout", json!("from-1"), &tab1);
    // A stale base from tab 2 does not matter on a device key.
    let late = Precondition {
        base_revision: Some(0),
        ..Precondition::default()
    };
    let outcome = store
        .write("device/dev-a/shell-layout", json!("from-2"), late, &tab2, 2)
        .unwrap();
    assert_eq!(outcome, WriteOutcome::Device { revision: 2 });
    for reader in [&tab1, &tab2] {
        let read = store.read("device/dev-a/shell-layout", reader, 3).unwrap();
        assert_eq!(read.value, Some(json!("from-2")));
        assert_eq!(read.revision, 2);
        assert_eq!(read.client_instance_id.as_deref(), Some("tab-2"));
    }
    cleanup(&dir);
}

#[test]
fn devices_are_isolated_and_cannot_touch_each_others_partitions() {
    let dir = tempdir_like("isolation");
    let store = open(&dir.join("store.json"));
    let a = who("dev-a", "t");
    let b = who("dev-b", "t");
    put(&store, "device/dev-a/shell-layout", json!("desktop"), &a);
    put(&store, "device/dev-b/shell-layout", json!("phone"), &b);
    assert_eq!(
        store.read("device/dev-a/shell-layout", &a, 1).unwrap().value,
        Some(json!("desktop"))
    );
    assert_eq!(
        store.read("device/dev-b/shell-layout", &b, 1).unwrap().value,
        Some(json!("phone"))
    );
    assert!(matches!(
        store.read("device/dev-a/shell-layout", &b, 1),
        Err(StoreError::Scope(_))
    ));
    assert!(matches!(
        store.write("device/dev-a/shell-layout", json!("x"), Precondition::default(), &b, 1),
        Err(StoreError::Scope(_))
    ));
    assert!(matches!(
        store.delete("device/dev-a/shell-layout", Precondition::default(), &b, 1),
        Err(StoreError::Scope(_))
    ));
    assert_eq!(
        store.read("device/dev-a/shell-layout", &a, 1).unwrap().value,
        Some(json!("desktop")),
        "a refused request changes nothing"
    );
    cleanup(&dir);
}

#[test]
fn a_device_id_with_a_slash_has_no_namespace() {
    let dir = tempdir_like("slash-device");
    let store = open(&dir.join("store.json"));
    let odd = who("a/b", "t");
    for key in ["device/a/b/k", "device/a/k", "device//k"] {
        assert!(
            matches!(
                store.write(key, json!(1), Precondition::default(), &odd, 1),
                Err(StoreError::Scope(_))
            ),
            "{key}"
        );
    }
    cleanup(&dir);
}

#[test]
fn keys_outside_the_three_scopes_are_refused_before_the_store_is_touched() {
    let dir = tempdir_like("unscoped");
    let file = dir.join("store.json");
    let store = open(&file);
    let a = who("dev-a", "t");
    for key in ["shell-layout", "host/x", "legacy/x", "shared/other/x", "shared/lww/", "device/dev-a/"] {
        assert!(
            matches!(store.read(key, &a, 1), Err(StoreError::Scope(_))),
            "read {key}"
        );
        assert!(
            matches!(
                store.write(key, json!(1), Precondition::default(), &a, 1),
                Err(StoreError::Scope(_))
            ),
            "write {key}"
        );
    }
    assert!(!file.exists(), "a refused request never writes the file");
    cleanup(&dir);
}

#[test]
fn cas_needs_expected_and_a_command_id() {
    let dir = tempdir_like("cas-required");
    let store = open(&dir.join("store.json"));
    let a = who("dev-a", "t");
    let write = |pre: Precondition| store.write("shared/cas/ssh/profiles", json!(1), pre, &a, 1);
    assert!(matches!(write(Precondition::default()), Err(StoreError::Invalid(_))));
    assert!(matches!(
        write(Precondition {
            command_id: Some("c1".into()),
            ..Precondition::default()
        }),
        Err(StoreError::Invalid(_))
    ));
    assert!(matches!(
        write(Precondition {
            expected: Some(Value::Null),
            ..Precondition::default()
        }),
        Err(StoreError::Invalid(_))
    ));
    assert!(matches!(write(cas(Value::Null, "bad id!")), Err(StoreError::Invalid(_))));
    assert!(matches!(write(cas(Value::Null, "c1")), Ok(WriteOutcome::Shared { .. })));
    cleanup(&dir);
}

#[test]
fn cas_resend_with_the_same_command_id_succeeds_and_a_stale_expected_does_not() {
    let dir = tempdir_like("cas");
    let file = dir.join("store.json");
    let store = open(&file);
    let a = who("dev-a", "t");
    let b = who("dev-b", "t");
    let key = "shared/cas/ssh/profiles";
    let v1 = json!({ "_version": 1, "data": ["p1"] });
    let first = store.write(key, v1.clone(), cas(Value::Null, "cmd-1"), &a, 1).unwrap();
    assert_eq!(
        first,
        WriteOutcome::Shared { value: v1.clone(), revision: 1, merged: false }
    );

    // The reply was lost; the client resends the identical write.
    let resend = store.write(key, v1.clone(), cas(Value::Null, "cmd-1"), &a, 2).unwrap();
    assert_eq!(resend, first, "no revision bump on a resend");

    // Another command with the stale `expected` loses.
    let stale = store.write(key, json!({ "_version": 1, "data": ["p2"] }), cas(Value::Null, "cmd-2"), &b, 3);
    assert!(matches!(stale, Err(StoreError::CasFailed(_))));

    // Same command id, different value: not a resend.
    let reused = store.write(key, json!({ "_version": 1, "data": ["p3"] }), cas(Value::Null, "cmd-1"), &a, 4);
    assert!(matches!(reused, Err(StoreError::CasFailed(_))));

    // With the right `expected` it applies and the record keeps the new command.
    let v2 = json!({ "_version": 1, "data": ["p1", "p2"] });
    let applied = store.write(key, v2.clone(), cas(v1.clone(), "cmd-2"), &b, 5).unwrap();
    assert_eq!(applied, WriteOutcome::Shared { value: v2.clone(), revision: 2, merged: false });
    let again = store.write(key, v2.clone(), cas(v1, "cmd-2"), &b, 6).unwrap();
    assert_eq!(again, applied);

    // The stored command id survives a restart.
    let reloaded = open(&file);
    let after_restart = reloaded.write(key, v2, cas(Value::Null, "cmd-2"), &b, 7).unwrap();
    assert_eq!(after_restart, applied);
    cleanup(&dir);
}

#[test]
fn shared_delete_follows_the_same_preconditions() {
    let dir = tempdir_like("shared-delete");
    let store = open(&dir.join("store.json"));
    let a = who("dev-a", "t");
    let cas_key = "shared/cas/ssh/profiles";
    store.write(cas_key, json!(["p"]), cas(Value::Null, "c1"), &a, 1).unwrap();
    assert!(matches!(
        store.delete(cas_key, Precondition::default(), &a, 2),
        Err(StoreError::Invalid(_))
    ));
    assert!(matches!(
        store.delete(cas_key, cas(json!(["other"]), "c2"), &a, 2),
        Err(StoreError::CasFailed(_))
    ));
    assert!(store.delete(cas_key, cas(json!(["p"]), "c2"), &a, 2).unwrap());

    let lww_key = "shared/lww/settings/app";
    put(&store, lww_key, json!({ "a": 1 }), &a);
    assert!(matches!(
        store.delete(lww_key, Precondition::default(), &a, 3),
        Err(StoreError::BaseRequired)
    ));
    let stale = Precondition { base_revision: Some(0), ..Precondition::default() };
    assert!(matches!(store.delete(lww_key, stale, &a, 3), Err(StoreError::CasFailed(_))));
    let current = Precondition { base_revision: Some(1), ..Precondition::default() };
    assert!(store.delete(lww_key, current, &a, 3).unwrap());
    cleanup(&dir);
}

#[test]
fn a_partition_over_its_byte_budget_refuses_growth_and_leaves_the_file_untouched() {
    let dir = tempdir_like("budget");
    let file = dir.join("store.json");
    let store = open_with(
        &file,
        StorePolicy { partition_byte_budget: 600, ..StorePolicy::default() },
    );
    let a = who("dev-a", "t");
    let b = who("dev-b", "t");
    put(&store, "device/dev-a/k1", json!("x".repeat(300)), &a);
    let before = std::fs::read(&file).unwrap();
    let full = store.write("device/dev-a/k2", json!("y".repeat(400)), Precondition::default(), &a, 2);
    assert!(matches!(full, Err(StoreError::PartitionFull { budget: 600, .. })), "{full:?}");
    assert_eq!(std::fs::read(&file).unwrap(), before, "file untouched");

    // The budget is per device, shrinking is always allowed, and a smaller
    // replacement of the same key fits.
    put(&store, "device/dev-b/k1", json!("z".repeat(400)), &b);
    put(&store, "device/dev-a/k1", json!("x"), &a);
    put(&store, "device/dev-a/k2", json!("y".repeat(300)), &a);
    cleanup(&dir);
}

#[test]
fn an_unreadable_store_is_unavailable_never_empty() {
    let dir = tempdir_like("unavailable");
    // A directory where the file should be: not NotFound, so a real read error.
    let file = dir.join("store.json");
    std::fs::create_dir_all(&file).unwrap();
    let store = open(&file);
    let a = who("dev-a", "t");
    assert!(matches!(store.read("device/dev-a/k", &a, 1), Err(StoreError::Unavailable)));
    assert!(matches!(
        store.write("device/dev-a/k", json!(1), Precondition::default(), &a, 1),
        Err(StoreError::Unavailable)
    ));
    assert!(matches!(
        store.delete("device/dev-a/k", Precondition::default(), &a, 1),
        Err(StoreError::Unavailable)
    ));
    cleanup(&dir);
}

#[test]
fn a_failed_write_leaves_the_previous_record_in_place() {
    let dir = tempdir_like("failed-write");
    let file = dir.join("store.json");
    let store = open(&file);
    let a = who("dev-a", "t");
    put(&store, "device/dev-a/k", json!(1), &a);
    // Replace the target with a directory so the atomic rename fails.
    std::fs::remove_file(&file).unwrap();
    std::fs::create_dir_all(&file).unwrap();
    let error = store.write("device/dev-a/k", json!(2), Precondition::default(), &a, 2);
    assert!(matches!(error, Err(StoreError::Io(_))), "{error:?}");
    let read = store.read("device/dev-a/k", &a, 3).unwrap();
    assert_eq!((read.value, read.revision), (Some(json!(1)), 1));
    cleanup(&dir);
}

#[test]
fn corrupt_file_is_backed_up_and_treated_as_empty() {
    let dir = tempdir_like("corrupt");
    let file = dir.join("store.json");
    std::fs::write(&file, "{ not valid json").expect("write garbage");

    let store = open(&file);
    let a = who("dev-a", "t");
    assert_eq!(store.read("device/dev-a/anything", &a, 1).unwrap().revision, 0);
    assert_eq!(
        backups_with_prefix(&dir, "store.json.corrupt-").len(),
        1,
        "exactly one corrupt backup"
    );

    put(&store, "device/dev-a/k", json!("v"), &a);
    let reloaded = open(&file);
    assert_eq!(
        reloaded.read("device/dev-a/k", &a, 2).unwrap().value,
        Some(json!("v"))
    );
    cleanup(&dir);
}

#[test]
fn writes_are_stored_in_the_schema_v2_envelope() {
    let dir = tempdir_like("envelope");
    let file = dir.join("store.json");
    let store = open(&file);
    let a = who("dev-a", "tab-1");
    store
        .write("device/dev-a/k", json!({ "a": 1 }), Precondition::default(), &a, 5)
        .unwrap();

    let disk = on_disk(&file);
    assert_eq!(disk["schemaVersion"], json!(2));
    assert_eq!(
        disk["data"]["device/dev-a/k"],
        json!({ "v": { "a": 1 }, "rev": 1, "cid": "tab-1" })
    );
    assert_eq!(disk["host"]["lastSeen"]["dev-a"], json!(5));
    assert_eq!(store.path(), file.as_path());
    cleanup(&dir);
}

#[test]
fn newer_schema_is_refused_and_the_file_is_left_byte_identical() {
    let dir = tempdir_like("newer");
    let file = dir.join("store.json");
    let future = br#"{"schemaVersion":3,"data":{"k":1},"newThing":{"x":[1]}}"#;
    std::fs::write(&file, future).unwrap();

    let error = match WebStore::open(file.clone(), StorePolicy::default()) {
        Ok(_) => panic!("a newer schema must be refused"),
        Err(error) => error,
    };
    match &error {
        WebStoreError::NewerSchema(newer) => {
            assert_eq!((newer.found, newer.supported), (3, STORE_SCHEMA_VERSION));
            assert_eq!(newer.path, file);
        }
        other => panic!("expected NewerSchema, got {other:?}"),
    }
    assert!(error.to_string().contains("store.json"));
    assert_eq!(std::fs::read(&file).unwrap(), future);
    assert!(
        backups_with_prefix(&dir, "store.json.").is_empty(),
        "refusing must not create backups"
    );
    cleanup(&dir);
}

#[test]
fn unknown_top_level_envelope_keys_survive_writes_and_deletes() {
    let dir = tempdir_like("extra-keys");
    let file = dir.join("store.json");
    let a = who("dev-a", "t");
    std::fs::write(
        &file,
        br#"{"schemaVersion":2,"data":{"device/dev-a/k":{"v":1,"rev":1,"cid":"t"}},"futureThing":{"x":[1,2]}}"#,
    )
    .unwrap();

    let store = open(&file);
    assert!(backups_with_prefix(&dir, "store.json.").is_empty(), "a v2 file is not migrated");
    put(&store, "device/dev-a/j", json!(2), &a);
    store
        .delete("device/dev-a/k", Precondition::default(), &a, 1)
        .unwrap();

    let disk = on_disk(&file);
    assert_eq!(disk["futureThing"], json!({ "x": [1, 2] }));
    assert_eq!(disk["data"]["device/dev-a/j"]["v"], json!(2));
    assert!(disk["data"].get("device/dev-a/k").is_none());
    cleanup(&dir);
}

#[test]
fn write_limit_applies_to_the_data_payload_not_the_envelope() {
    let dir = tempdir_like("limit");
    let file = dir.join("store.json");
    let a = who("dev-a", "t");
    // A v2 file whose `data` payload is just under the limit: the envelope
    // around it (host object, extra keys) pushes the file past it, yet writes
    // of the same size must keep working.
    let record_overhead = br#"{"device/dev-a/a":{"v":"","rev":1,"cid":"t"}}"#.len();
    let value_len = MAX_DATA_BYTES - record_overhead - 8;
    let seed = format!(
        r#"{{"schemaVersion":2,"data":{{"device/dev-a/a":{{"v":"{}","rev":1,"cid":"t"}}}},"pad":"{}"}}"#,
        "x".repeat(value_len),
        "p".repeat(64)
    );
    std::fs::write(&file, &seed).unwrap();

    let store = open_with(
        &file,
        StorePolicy { partition_byte_budget: u64::MAX, ..StorePolicy::default() },
    );
    // Same-size rewrite fits although the whole file is over the limit.
    put(&store, "device/dev-a/a", json!("y".repeat(value_len)), &a);
    assert!(std::fs::metadata(&file).unwrap().len() as usize > MAX_DATA_BYTES);
    // Growing the payload past the limit is refused, file untouched.
    let before = std::fs::read(&file).unwrap();
    let error = store
        .write("device/dev-a/a", json!("y".repeat(value_len + 64)), Precondition::default(), &a, 2)
        .unwrap_err();
    match error {
        StoreError::Io(io) => assert_eq!(io.kind(), io::ErrorKind::InvalidData),
        other => panic!("expected the file cap, got {other:?}"),
    }
    assert_eq!(std::fs::read(&file).unwrap(), before);
    cleanup(&dir);
}
