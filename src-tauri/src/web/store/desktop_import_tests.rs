//! The one-shot import of the desktop plugin-store file `termul-data.json`:
//! key mapping, the first-device takeover, the size limits and the retry rules.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::desktop_import::{desktop_legacy_file, DESKTOP_LEGACY_FILE};
use super::tests::{cleanup, on_disk, open, open_with, put, tempdir_like, who};
use super::{
    Precondition, StoreError, StorePolicy, WebStore, MAX_DATA_BYTES, STORE_VALUE_MAX_BYTES,
};

fn wrapped(data: Value) -> Value {
    json!({ "_version": 1, "data": data })
}

fn write_legacy(dir: &Path, content: &Value) -> PathBuf {
    let path = desktop_legacy_file(dir);
    std::fs::write(&path, serde_json::to_vec(content).unwrap()).unwrap();
    path
}

/// The files in `dir` that are `termul-data.json` backups of an import.
fn backups(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name.starts_with(&format!("{DESKTOP_LEGACY_FILE}.imported-")))
        .collect();
    names.sort();
    names
}

fn value_of(store: &WebStore, key: &str, device: &str) -> Option<Value> {
    store.read(key, &who(device, "tab"), 5).unwrap().value
}

/// A desktop file as a long-time user would have it.
fn typical_file() -> Value {
    json!({
        "settings/app": wrapped(json!({ "theme": "dark", "fontSize": 14 })),
        "acp/agents": wrapped(json!([{ "id": "custom-1" }])),
        "ssh/profiles": wrapped(json!([{ "id": "prod" }])),
        "shell-layout": wrapped(json!({ "columns": 3 })),
        "projects": wrapped(json!({ "projects": [{ "id": "p1" }] })),
        "editor-state/p1": wrapped(json!({ "tabs": ["a.ts"] })),
        "terminals/p1": wrapped(json!({ "terminals": [] })),
        // A build that wrote no wrapper.
        "window-state": json!({ "width": 1200 }),
        "never-stored": Value::Null,
    })
}

#[test]
fn shared_keys_and_device_keys_land_in_their_scopes_and_the_file_is_kept_as_a_backup() {
    let dir = tempdir_like("desktop-map");
    let file = dir.join("store.json");
    let legacy = write_legacy(&dir, &typical_file());
    let original = std::fs::read(&legacy).unwrap();
    let store = open(&file).with_desktop_legacy(legacy.clone());
    let desk = who("desk", "tab-1");

    store.claim_desktop_import(&desk, 7_000_000).unwrap();

    let shared = |key: &str| value_of(&store, key, "desk");
    assert_eq!(
        shared("shared/lww/settings/app"),
        Some(wrapped(json!({ "theme": "dark", "fontSize": 14 })))
    );
    assert_eq!(
        shared("shared/lww/acp/agents"),
        Some(wrapped(json!([{ "id": "custom-1" }])))
    );
    assert_eq!(
        shared("shared/cas/ssh/profiles"),
        Some(wrapped(json!([{ "id": "prod" }])))
    );
    let device = |key: &str| value_of(&store, &format!("device/desk/{key}"), "desk");
    assert_eq!(
        device("shell-layout"),
        Some(wrapped(json!({ "columns": 3 })))
    );
    assert_eq!(
        device("projects"),
        Some(wrapped(json!({ "projects": [{ "id": "p1" }] })))
    );
    assert_eq!(
        device("terminals/p1"),
        Some(wrapped(json!({ "terminals": [] })))
    );
    assert_eq!(
        device("window-state"),
        Some(wrapped(json!({ "width": 1200 }))),
        "a bare value is wrapped"
    );
    assert_eq!(
        device("workspace/p1"),
        Some(wrapped(json!({ "tabs": ["a.ts"] })))
    );
    assert_eq!(device("editor-state/p1"), None, "renamed, not copied");
    assert_eq!(device("never-stored"), None);

    let record = &on_disk(&file)["data"]["shared/lww/settings/app"];
    assert_eq!(
        (record["rev"].clone(), record["cid"].clone()),
        (json!(1), json!("legacy"))
    );
    assert_eq!(
        on_disk(&file)["host"]["desktopImported"]["deviceId"],
        json!("desk")
    );

    assert!(!legacy.exists(), "the file is renamed after the write");
    let kept = backups(&dir);
    assert_eq!(kept, vec![format!("{DESKTOP_LEGACY_FILE}.imported-7000")]);
    assert_eq!(
        std::fs::read(dir.join(&kept[0])).unwrap(),
        original,
        "never rewritten or deleted"
    );
    cleanup(&dir);
}

#[test]
fn only_the_first_device_takes_the_import_and_it_never_runs_twice() {
    let dir = tempdir_like("desktop-first");
    let file = dir.join("store.json");
    let legacy = write_legacy(&dir, &typical_file());
    let store = open(&file).with_desktop_legacy(legacy);

    store
        .claim_desktop_import(&who("desk", "t"), 1_000)
        .unwrap();
    store
        .claim_desktop_import(&who("other", "t"), 2_000)
        .unwrap();

    assert!(value_of(&store, "device/desk/shell-layout", "desk").is_some());
    assert_eq!(value_of(&store, "device/other/shell-layout", "other"), None);
    assert_eq!(
        on_disk(&file)["host"]["desktopImported"]["deviceId"],
        json!("desk")
    );

    // A restart (even with a new plugin-store file in place) imports nothing
    // and sets the stray file aside.
    drop(store);
    let again = write_legacy(&dir, &json!({ "shell-layout": wrapped(json!("late")) }));
    let store = open(&file).with_desktop_legacy(again.clone());
    store
        .claim_desktop_import(&who("other", "t"), 3_000)
        .unwrap();
    assert_eq!(value_of(&store, "device/other/shell-layout", "other"), None);
    assert!(!again.exists());
    assert_eq!(backups(&dir).len(), 2);
    cleanup(&dir);
}

#[test]
fn a_shared_key_is_imported_only_where_the_store_holds_none_and_none_was_deleted() {
    let dir = tempdir_like("desktop-absent");
    let file = dir.join("store.json");
    let legacy = write_legacy(&dir, &typical_file());
    let store = open(&file);
    let web = who("web", "tab-w");
    // A shared-live client wrote the settings before the desktop reached the store.
    put(
        &store,
        "shared/lww/settings/app",
        wrapped(json!({ "theme": "light" })),
        &web,
    );
    // Another shared key was deleted on purpose.
    let cas = Precondition {
        expected: Some(Value::Null),
        command_id: Some("cmd-1".to_string()),
        ..Precondition::default()
    };
    store
        .write("shared/cas/ssh/profiles", wrapped(json!([])), cas, &web, 1)
        .unwrap();
    let delete = Precondition {
        expected: Some(wrapped(json!([]))),
        command_id: Some("cmd-2".to_string()),
        ..Precondition::default()
    };
    assert!(store
        .delete("shared/cas/ssh/profiles", delete, &web, 2)
        .unwrap());
    // The desktop device already holds one device key.
    put(
        &store,
        "device/desk/shell-layout",
        wrapped(json!({ "columns": 9 })),
        &who("desk", "t"),
    );
    let store = store.with_desktop_legacy(legacy);

    store
        .claim_desktop_import(&who("desk", "t"), 5_000)
        .unwrap();

    assert_eq!(
        value_of(&store, "shared/lww/settings/app", "web"),
        Some(wrapped(json!({ "theme": "light" }))),
        "the shared value that exists wins"
    );
    assert_eq!(
        value_of(&store, "shared/cas/ssh/profiles", "web"),
        None,
        "a deleted key stays deleted"
    );
    assert_eq!(
        value_of(&store, "shared/lww/acp/agents", "web"),
        Some(wrapped(json!([{ "id": "custom-1" }]))),
        "an absent shared key is imported"
    );
    assert_eq!(
        value_of(&store, "device/desk/shell-layout", "desk"),
        Some(wrapped(json!({ "columns": 9 }))),
        "a device key the partition holds is kept"
    );
    assert!(value_of(&store, "device/desk/projects", "desk").is_some());
    cleanup(&dir);
}

#[test]
fn keys_over_the_device_byte_budget_are_dropped_largest_first() {
    let dir = tempdir_like("desktop-budget");
    let file = dir.join("store.json");
    let legacy = write_legacy(
        &dir,
        &json!({
            "a-small": wrapped(json!("x")),
            "b-small": wrapped(json!("y")),
            "c-medium": wrapped(json!("m".repeat(300))),
            "d-large": wrapped(json!("l".repeat(5_000))),
            "settings/app": wrapped(json!({ "theme": "dark" })),
        }),
    );
    let policy = StorePolicy {
        partition_gc_age_secs: u64::MAX,
        partition_byte_budget: 700,
    };
    let store = open_with(&file, policy).with_desktop_legacy(legacy);

    store
        .claim_desktop_import(&who("desk", "t"), 1_000)
        .unwrap();

    let kept = |key: &str| value_of(&store, &format!("device/desk/{key}"), "desk").is_some();
    assert!(kept("a-small") && kept("b-small") && kept("c-medium"));
    assert!(!kept("d-large"), "the largest key does not fit the budget");
    assert!(
        value_of(&store, "shared/lww/settings/app", "desk").is_some(),
        "shared keys do not count against a device partition"
    );
    let used: usize = on_disk(&file)["data"]
        .as_object()
        .unwrap()
        .iter()
        .filter(|(key, _)| key.starts_with("device/desk/"))
        .map(|(key, record)| key.len() + serde_json::to_vec(record).unwrap().len())
        .sum();
    assert!(used <= 700, "the partition holds {used} bytes");
    cleanup(&dir);
}

#[test]
fn a_value_over_the_per_value_cap_is_skipped_and_the_rest_is_imported() {
    let dir = tempdir_like("desktop-oversized");
    let file = dir.join("store.json");
    let legacy = write_legacy(
        &dir,
        &json!({
            "terminals/huge": wrapped(json!("t".repeat(STORE_VALUE_MAX_BYTES))),
            "shell-layout": wrapped(json!("ok")),
        }),
    );
    let store = open(&file).with_desktop_legacy(legacy);

    store
        .claim_desktop_import(&who("desk", "t"), 1_000)
        .unwrap();

    assert_eq!(value_of(&store, "device/desk/terminals/huge", "desk"), None);
    assert_eq!(
        value_of(&store, "device/desk/shell-layout", "desk"),
        Some(wrapped(json!("ok")))
    );
    assert_eq!(
        backups(&dir).len(),
        1,
        "the skipped value stays in the backup file"
    );
    cleanup(&dir);
}

#[test]
fn an_import_that_would_pass_the_store_file_cap_drops_the_largest_keys_and_still_succeeds() {
    let dir = tempdir_like("desktop-file-cap");
    let file = dir.join("store.json");
    let filler = "f".repeat(200 * 1024);
    let mut content = serde_json::Map::new();
    // About 10.4 MiB: past the file cap, under the per-device budget.
    for index in 0..52 {
        content.insert(format!("snapshots/p{index:02}"), wrapped(json!(filler)));
    }
    content.insert("shell-layout".to_string(), wrapped(json!("small")));
    let legacy = write_legacy(&dir, &Value::Object(content));
    let store = open(&file).with_desktop_legacy(legacy);

    store
        .claim_desktop_import(&who("desk", "t"), 1_000)
        .unwrap();

    assert_eq!(
        value_of(&store, "device/desk/shell-layout", "desk"),
        Some(wrapped(json!("small")))
    );
    let data = on_disk(&file)["data"].clone();
    let payload = serde_json::to_vec(&data).unwrap().len();
    assert!(
        payload <= MAX_DATA_BYTES,
        "the written data is {payload} bytes"
    );
    let imported = data.as_object().unwrap().len();
    assert!((40..53).contains(&imported), "most keys fit: {imported}");
    // The next request is not blocked by an import that cannot be written.
    put(
        &store,
        "device/desk/chat-draft/p",
        wrapped(json!("hi")),
        &who("desk", "t"),
    );
    cleanup(&dir);
}

#[test]
fn a_failed_write_leaves_the_file_and_the_pending_import_for_the_next_request() {
    let dir = tempdir_like("desktop-retry");
    let file = dir.join("store.json");
    let legacy = write_legacy(&dir, &typical_file());
    let store = open(&file).with_desktop_legacy(legacy.clone());
    let desk = who("desk", "t");
    // A directory where the store file goes makes the atomic rename fail.
    std::fs::create_dir_all(&file).unwrap();

    let failure = store.claim_desktop_import(&desk, 1_000);
    assert!(matches!(failure, Err(StoreError::Io(_))), "{failure:?}");
    assert!(legacy.exists(), "the plugin-store file stays");
    assert!(backups(&dir).is_empty());

    std::fs::remove_dir_all(&file).unwrap();
    store.claim_desktop_import(&desk, 2_000).unwrap();

    assert!(value_of(&store, "device/desk/shell-layout", "desk").is_some());
    assert!(!legacy.exists());
    assert_eq!(backups(&dir).len(), 1);
    cleanup(&dir);
}

#[test]
fn an_unreadable_or_non_object_file_is_skipped_and_left_in_place() {
    for (label, bytes) in [("garbage", &b"{ not json"[..]), ("array", &b"[1,2]"[..])] {
        let dir = tempdir_like(&format!("desktop-corrupt-{label}"));
        let file = dir.join("store.json");
        let legacy = desktop_legacy_file(&dir);
        std::fs::write(&legacy, bytes).unwrap();
        let store = open(&file).with_desktop_legacy(legacy.clone());

        store
            .claim_desktop_import(&who("desk", "t"), 1_000)
            .unwrap();
        put(
            &store,
            "device/desk/k",
            wrapped(json!(1)),
            &who("desk", "t"),
        );

        assert_eq!(std::fs::read(&legacy).unwrap(), bytes, "{label}: untouched");
        assert!(backups(&dir).is_empty(), "{label}");
        assert!(
            on_disk(&file)["host"].get("desktopImported").is_none(),
            "{label}: no marker"
        );
        cleanup(&dir);
    }
}

#[test]
fn a_missing_file_or_one_with_no_keys_changes_nothing_useful() {
    let dir = tempdir_like("desktop-none");
    let file = dir.join("store.json");
    let store = open(&file).with_desktop_legacy(desktop_legacy_file(&dir));
    store
        .claim_desktop_import(&who("desk", "t"), 1_000)
        .unwrap();
    assert!(
        !file.exists(),
        "nothing pending: the store file is not written"
    );

    let legacy = write_legacy(&dir, &json!({}));
    let store = open(&file).with_desktop_legacy(legacy.clone());
    store
        .claim_desktop_import(&who("desk", "t"), 2_000)
        .unwrap();
    assert!(!legacy.exists(), "an empty file is retired");
    assert_eq!(
        on_disk(&file)["host"]["desktopImported"]["deviceId"],
        json!("desk")
    );
    cleanup(&dir);
}

#[test]
fn a_taken_backup_name_gets_a_numbered_suffix() {
    let dir = tempdir_like("desktop-suffix");
    let file = dir.join("store.json");
    let legacy = write_legacy(&dir, &typical_file());
    std::fs::write(
        dir.join(format!("{DESKTOP_LEGACY_FILE}.imported-9")),
        b"old",
    )
    .unwrap();
    let store = open(&file).with_desktop_legacy(legacy);

    store
        .claim_desktop_import(&who("desk", "t"), 9_000)
        .unwrap();

    assert_eq!(
        backups(&dir),
        vec![
            format!("{DESKTOP_LEGACY_FILE}.imported-9"),
            format!("{DESKTOP_LEGACY_FILE}.imported-9-1")
        ]
    );
    cleanup(&dir);
}

#[test]
fn a_device_without_a_namespace_leaves_the_import_pending() {
    let dir = tempdir_like("desktop-no-namespace");
    let file = dir.join("store.json");
    let legacy = write_legacy(&dir, &typical_file());
    let store = open(&file).with_desktop_legacy(legacy.clone());

    store.claim_desktop_import(&who("a/b", "t"), 1_000).unwrap();
    assert!(legacy.exists());
    assert!(!file.exists());

    store
        .claim_desktop_import(&who("desk", "t"), 2_000)
        .unwrap();
    assert!(value_of(&store, "device/desk/shell-layout", "desk").is_some());
    cleanup(&dir);
}
