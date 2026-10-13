use std::collections::HashSet;

use serde_json::json;

use super::gc::LAST_SEEN_FLUSH_MS;
use super::tests::{backups_with_prefix, cleanup, on_disk, open, open_with, put, tempdir_like, who};
use super::*;

const DAY_MS: u64 = 24 * 60 * 60 * 1000;

fn none() -> HashSet<String> {
    HashSet::new()
}

fn present(devices: &[&str]) -> HashSet<String> {
    devices.iter().map(|d| (*d).to_string()).collect()
}

fn seen_at(store: &WebStore, device: &str, key: &str, now_ms: u64) {
    store
        .write(
            &format!("device/{device}/{key}"),
            json!(1),
            Precondition::default(),
            &who(device, "t"),
            now_ms,
        )
        .unwrap();
}

#[test]
fn a_stale_partition_is_collected_and_a_present_one_never_is() {
    let dir = tempdir_like("gc");
    let file = dir.join("store.json");
    let policy = StorePolicy { partition_gc_age_secs: 10 * 24 * 60 * 60, ..StorePolicy::default() };
    let store = open_with(&file, policy);
    let day0 = 1_000 * DAY_MS;
    seen_at(&store, "stale", "k1", day0);
    seen_at(&store, "stale", "k2", day0);
    seen_at(&store, "away-but-recent", "k", day0 + 9 * DAY_MS);
    seen_at(&store, "live", "k", day0);
    put(&store, "shared/lww/settings/app", json!({ "a": 1 }), &who("stale", "t"));

    let collected = store.sweep(day0 + 11 * DAY_MS, &present(&["live"])).unwrap();
    assert_eq!(collected, vec!["stale".to_string()]);

    let disk = on_disk(&file);
    let keys: Vec<&String> = disk["data"].as_object().unwrap().keys().collect();
    assert!(keys.iter().any(|k| *k == "device/live/k"), "a present device is spared: {keys:?}");
    assert!(keys.iter().any(|k| *k == "device/away-but-recent/k"));
    assert!(keys.iter().any(|k| *k == "shared/lww/settings/app"), "shared keys are never collected");
    assert!(!keys.iter().any(|k| k.starts_with("device/stale/")));
    assert!(disk["host"]["lastSeen"].get("stale").is_none(), "last-seen goes with the partition");

    // The live device stays safe however long it stays connected.
    assert!(store.sweep(day0 + 400 * DAY_MS, &present(&["live"])).unwrap().contains(&"away-but-recent".to_string()));
    assert!(store.read("device/live/k", &who("live", "t"), day0 + 400 * DAY_MS).unwrap().value.is_some());
    cleanup(&dir);
}

#[test]
fn an_unknown_last_seen_starts_its_clock_at_the_sweep() {
    let dir = tempdir_like("gc-unknown");
    let file = dir.join("store.json");
    // A v2 file whose partition has no last-seen entry (e.g. hand-edited).
    std::fs::write(
        &file,
        br#"{"schemaVersion":2,"data":{"device/old/k":{"v":1,"rev":1,"cid":"t"}}}"#,
    )
    .unwrap();
    let policy = StorePolicy { partition_gc_age_secs: 60, ..StorePolicy::default() };
    let store = open_with(&file, policy);
    // The sweep at open initialised the clock instead of collecting.
    let disk = on_disk(&file);
    assert!(disk["data"].get("device/old/k").is_some());
    let initialised = disk["host"]["lastSeen"]["old"].as_u64().expect("last-seen initialised");

    assert!(store.sweep(initialised + 30_000, &none()).unwrap().is_empty());
    assert_eq!(store.sweep(initialised + 61_000, &none()).unwrap(), vec!["old".to_string()]);
    assert!(on_disk(&file)["data"].get("device/old/k").is_none());
    cleanup(&dir);
}

#[test]
fn the_sweep_runs_when_the_store_opens() {
    let dir = tempdir_like("gc-open");
    let file = dir.join("store.json");
    let old = unix_ms() - 100 * DAY_MS;
    std::fs::write(
        &file,
        format!(
            r#"{{"schemaVersion":2,"data":{{"device/old/k":{{"v":1,"rev":1,"cid":"t"}}}},"host":{{"lastSeen":{{"old":{old}}}}}}}"#
        ),
    )
    .unwrap();
    let store = open(&file);
    assert_eq!(store.read("device/old/k", &who("old", "t"), unix_ms()).unwrap().revision, 0);
    cleanup(&dir);
}

#[test]
fn a_request_marks_the_device_seen_and_a_write_persists_it() {
    let dir = tempdir_like("last-seen");
    let file = dir.join("store.json");
    let store = open(&file);
    let a = who("dev-a", "t");
    let t0 = 5_000_000;
    // A read only touches memory: nothing to write yet.
    store.read("device/dev-a/k", &a, t0).unwrap();
    assert!(!file.exists(), "a read does not create the file");
    // The next write carries the (newer) last-seen with it.
    store.write("device/dev-a/k", json!(1), Precondition::default(), &a, t0 + 10).unwrap();
    assert_eq!(on_disk(&file)["host"]["lastSeen"]["dev-a"], json!(t0 + 10));
    cleanup(&dir);
}

#[test]
fn last_seen_reaches_the_file_at_most_hourly_when_only_reads_arrive() {
    let dir = tempdir_like("last-seen-flush");
    let file = dir.join("store.json");
    let store = open(&file);
    let a = who("dev-a", "t");
    let t0 = unix_ms();
    store.write("device/dev-a/k", json!(1), Precondition::default(), &a, t0).unwrap();
    let flushed = on_disk(&file)["host"]["lastSeen"]["dev-a"].clone();

    store.read("device/dev-a/k", &a, t0 + 1_000).unwrap();
    assert_eq!(on_disk(&file)["host"]["lastSeen"]["dev-a"], flushed, "within the hour: memory only");

    store.read("device/dev-a/k", &a, t0 + LAST_SEEN_FLUSH_MS + 1).unwrap();
    assert_eq!(on_disk(&file)["host"]["lastSeen"]["dev-a"], json!(t0 + LAST_SEEN_FLUSH_MS + 1));
    assert!(backups_with_prefix(&dir, "store.json.").is_empty());
    cleanup(&dir);
}
