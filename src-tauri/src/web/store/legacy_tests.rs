//! v1 -> v2 migration, first-device adoption and the Rust/TS scope-table parity.

use std::collections::BTreeSet;

use serde_json::json;

use super::legacy::{SHARED_CAS_KEYS, SHARED_LWW_KEYS};
use super::tests::{backups_with_prefix, cleanup, on_disk, open, put, tempdir_like, who};

const TS_PERSISTENCE: &str = include_str!("../../../../src/shared/types/persistence.types.ts");

/// The quoted entries of one `name: [ ... ]` list inside the TS
/// `export const KEY_SCOPES = { ... } as const` block.
fn ts_scope_list(name: &str) -> BTreeSet<String> {
    let block = TS_PERSISTENCE
        .split("export const KEY_SCOPES = {")
        .nth(1)
        .and_then(|rest| rest.split("} as const").next())
        .expect("KEY_SCOPES block");
    let list = block
        .split(&format!("{name}: ["))
        .nth(1)
        .and_then(|rest| rest.split(']').next())
        .unwrap_or_else(|| panic!("KEY_SCOPES.{name} list"));
    list.lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .flat_map(|line| line.split('\'').skip(1).step_by(2))
        .map(str::to_string)
        .collect()
}

#[test]
fn the_rust_legacy_table_equals_the_ts_key_scopes() {
    let rust = |table: &[&str]| table.iter().map(|k| (*k).to_string()).collect::<BTreeSet<_>>();
    assert_eq!(ts_scope_list("sharedLww"), rust(SHARED_LWW_KEYS), "shared-lww keys drifted");
    assert_eq!(ts_scope_list("sharedCas"), rust(SHARED_CAS_KEYS), "shared-cas keys drifted");
    assert!(!ts_scope_list("sharedLww").is_empty());
}

#[test]
fn table_entries_match_exactly_and_prefix_entries_match_a_family() {
    use super::legacy::{listed, shared_key};
    assert!(listed(&["settings/app"], "settings/app"));
    assert!(!listed(&["settings/app"], "settings/app/extra"), "exact entries match only themselves");
    assert!(listed(&["acp/mention/*"], "acp/mention/p1"));
    assert!(!listed(&["acp/mention/*"], "acp/mentions"));
    assert_eq!(shared_key("settings/app").as_deref(), Some("shared/lww/settings/app"));
    assert_eq!(shared_key("ssh/profiles").as_deref(), Some("shared/cas/ssh/profiles"));
    assert_eq!(shared_key("shell-layout"), None);
}

#[test]
fn a_parked_editor_state_key_is_adopted_as_the_workspace_key() {
    use super::legacy::adopted_key;
    assert_eq!(adopted_key("editor-state/p1"), "workspace/p1");
    assert_eq!(adopted_key("editor-state/"), "workspace/", "the prefix alone renames too");
    assert_eq!(adopted_key("shell-layout"), "shell-layout", "other keys keep their name");
    assert_eq!(adopted_key("terminals/editor-state/p1"), "terminals/editor-state/p1");

    let dir = tempdir_like("adopt-rename");
    let file = dir.join("store.json");
    std::fs::write(
        &file,
        br#"{"schemaVersion":1,"data":{"editor-state/p1":{"_version":1,"data":{"openFiles":[]}}}}"#,
    )
    .unwrap();
    let store = open(&file);
    let phone = who("phone", "t");
    let adopted = store.read("device/phone/workspace/p1", &phone, 1).unwrap();
    assert_eq!(adopted.value, Some(json!({ "_version": 1, "data": { "openFiles": [] } })));
    assert!(store.read("device/phone/editor-state/p1", &phone, 2).unwrap().value.is_none());
    cleanup(&dir);
}

fn flat_v1() -> &'static [u8] {
    br#"{"schemaVersion":1,"data":{
        "settings/app":{"_version":1,"data":{"theme":"dark"}},
        "ssh/profiles":{"_version":1,"data":["p1"]},
        "shell-layout":{"_version":1,"data":{"cols":2}},
        "terminals/p1":[1,2]}}"#
}

#[test]
fn a_v1_store_is_backed_up_then_migrated_in_place() {
    let dir = tempdir_like("migrate-v1");
    let file = dir.join("store.json");
    std::fs::write(&file, flat_v1()).unwrap();

    let store = open(&file);
    let a = who("dev-a", "t");

    // Exactly one `pre-v2` backup holds the original bytes.
    let backups = backups_with_prefix(&dir, "store.json.pre-v2-");
    assert_eq!(backups.len(), 1);
    assert_eq!(std::fs::read(&backups[0]).unwrap(), flat_v1());

    // Device keys are parked, not served under any scope, until adopted (the first request adopts them).
    let disk = on_disk(&file);
    assert_eq!(disk["schemaVersion"], json!(2));
    assert_eq!(disk["host"]["legacy"]["shell-layout"], json!({ "_version": 1, "data": { "cols": 2 } }));
    assert_eq!(disk["host"]["legacy"]["terminals/p1"], json!([1, 2]));
    assert!(disk["data"].get("shell-layout").is_none());

    // Shared keys were renamed in place; revisions start at 1.
    let lww = store.read("shared/lww/settings/app", &a, 1).unwrap();
    assert_eq!(lww.value, Some(json!({ "_version": 1, "data": { "theme": "dark" } })));
    assert_eq!(lww.revision, 1);
    let cas = store.read("shared/cas/ssh/profiles", &a, 1).unwrap();
    assert_eq!(cas.value, Some(json!({ "_version": 1, "data": ["p1"] })));

    // A restart reads the v2 file without taking another backup.
    drop(store);
    let again = open(&file);
    assert_eq!(again.read("shared/lww/settings/app", &a, 2).unwrap().revision, 1);
    assert_eq!(backups_with_prefix(&dir, "store.json.pre-v2-").len(), 1);
    cleanup(&dir);
}

#[test]
fn a_pre_versioning_bare_map_migrates_straight_to_v2() {
    let dir = tempdir_like("migrate-bare");
    let file = dir.join("store.json");
    // A user key named `schemaVersion` without a `data` envelope is data.
    let bare = br#"{"schemaVersion":7,"settings/app":{"theme":"dark"},"terminals/p1":[1]}"#;
    std::fs::write(&file, bare).unwrap();

    let store = open(&file);
    let backups = backups_with_prefix(&dir, "store.json.pre-v2-");
    assert_eq!(backups.len(), 1);
    assert_eq!(std::fs::read(&backups[0]).unwrap(), bare);
    assert_eq!(on_disk(&file)["host"]["legacy"]["schemaVersion"], json!(7));
    let a = who("dev-a", "t");
    assert_eq!(
        store.read("shared/lww/settings/app", &a, 1).unwrap().value,
        Some(json!({ "theme": "dark" }))
    );
    cleanup(&dir);
}

#[test]
fn an_envelope_with_non_object_data_is_read_as_a_bare_map() {
    let dir = tempdir_like("bad-envelope");
    let file = dir.join("store.json");
    std::fs::write(&file, br#"{"schemaVersion":1,"data":[1,2]}"#).unwrap();
    open(&file);
    assert_eq!(on_disk(&file)["host"]["legacy"]["data"], json!([1, 2]));
    assert_eq!(backups_with_prefix(&dir, "store.json.pre-v2-").len(), 1, "nothing is lost");
    cleanup(&dir);
}

#[test]
fn the_first_device_to_ask_adopts_the_parked_keys_once() {
    let dir = tempdir_like("adopt");
    let file = dir.join("store.json");
    std::fs::write(&file, flat_v1()).unwrap();
    let store = open(&file);
    let phone = who("phone", "t1");
    let desktop = who("desktop", "t2");

    // The first authenticated request — even a read of an unrelated key —
    // adopts everything in one write.
    let layout = store.read("device/phone/shell-layout", &phone, 10).unwrap();
    assert_eq!(layout.value, Some(json!({ "_version": 1, "data": { "cols": 2 } })));
    assert_eq!(layout.revision, 1);
    assert_eq!(layout.client_instance_id.as_deref(), Some("legacy"));
    assert_eq!(
        store.read("device/phone/terminals/p1", &phone, 10).unwrap().value,
        Some(json!([1, 2]))
    );

    let disk = on_disk(&file);
    assert!(disk["host"].get("legacy").is_none(), "nothing left parked");
    assert_eq!(disk["host"]["adopted"]["deviceId"], json!("phone"));

    // The second device sees an empty partition: the layout is not copied.
    assert_eq!(store.read("device/desktop/shell-layout", &desktop, 11).unwrap().revision, 0);
    // The adopted key is an ordinary key afterwards.
    put(&store, "device/phone/shell-layout", json!("new"), &phone);
    assert_eq!(store.read("device/phone/shell-layout", &phone, 12).unwrap().revision, 2);

    // Adoption survived to disk: a restart keeps it and the marker.
    drop(store);
    let again = open(&file);
    assert_eq!(again.read("device/phone/terminals/p1", &phone, 13).unwrap().revision, 1);
    assert_eq!(again.read("device/desktop/terminals/p1", &desktop, 13).unwrap().revision, 0);
    cleanup(&dir);
}

#[test]
fn a_device_without_a_namespace_cannot_adopt() {
    let dir = tempdir_like("adopt-slash");
    let file = dir.join("store.json");
    std::fs::write(&file, flat_v1()).unwrap();
    let store = open(&file);
    let odd = who("a/b", "t");
    assert!(store.read("shared/lww/settings/app", &odd, 1).is_ok());
    assert!(on_disk(&file)["host"]["legacy"].get("shell-layout").is_some());

    let normal = who("dev-a", "t");
    assert!(store.read("device/dev-a/shell-layout", &normal, 2).unwrap().value.is_some());
    cleanup(&dir);
}

#[test]
fn a_fresh_store_has_nothing_to_adopt() {
    let dir = tempdir_like("adopt-fresh");
    let file = dir.join("store.json");
    let store = open(&file);
    let a = who("dev-a", "t");
    store.read("device/dev-a/k", &a, 1).unwrap();
    assert!(!file.exists(), "no migration, no adoption, no write");
    cleanup(&dir);
}
