use super::*;

/// Minimal std-only temp dir (reuses the repo's pid+nanos pattern — no
/// `tempfile` dev-dep).
fn tempdir_like(label: &str) -> PathBuf {
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

fn cleanup(p: &PathBuf) {
    let _ = std::fs::remove_dir_all(p);
}

#[test]
fn missing_file_opens_empty_and_round_trips() {
    let dir = tempdir_like("roundtrip");
    let file = dir.join("store.json");
    let store = WebStore::open(file.clone());
    assert_eq!(store.read("missing").unwrap(), None);

    store
        .write("terminals/p1", serde_json::json!({ "active": "t1" }), None)
        .unwrap();
    store
        .write("settings", serde_json::json!({ "theme": "dark" }), None)
        .unwrap();
    assert_eq!(
        store.read("settings").unwrap(),
        Some(serde_json::json!({ "theme": "dark" }))
    );
    assert_eq!(
        store.read("terminals/p1").unwrap(),
        Some(serde_json::json!({ "active": "t1" }))
    );

    // A second open (simulating a restart) reloads the persisted map.
    let reloaded = WebStore::open(file.clone());
    assert_eq!(
        reloaded.read("settings").unwrap(),
        Some(serde_json::json!({ "theme": "dark" }))
    );

    // delete removes + persists.
    assert!(reloaded.delete("settings").unwrap());
    assert_eq!(reloaded.read("settings").unwrap(), None);
    assert!(!reloaded.delete("settings").unwrap());
    let reloaded_again = WebStore::open(file.clone());
    assert_eq!(reloaded_again.read("settings").unwrap(), None);
    assert_eq!(
        reloaded_again.read("terminals/p1").unwrap(),
        Some(serde_json::json!({ "active": "t1" }))
    );
    cleanup(&dir);
}

#[test]
fn write_replaces_existing_value_and_no_temp_leaks() {
    let dir = tempdir_like("replace");
    let file = dir.join("store.json");
    let store = WebStore::open(file.clone());
    store.write("k", serde_json::json!(1), None).unwrap();
    store.write("k", serde_json::json!(2), None).unwrap();
    assert_eq!(store.read("k").unwrap(), Some(serde_json::json!(2)));

    let temps: Vec<_> = std::fs::read_dir(&dir)
        .expect("read dir")
        .filter_map(Result::ok)
        .filter(|e| {
            e.file_name()
                .to_str()
                .map(|n| n.ends_with(".tmp"))
                .unwrap_or(false)
        })
        .collect();
    assert!(temps.is_empty(), "no lingering temp files: {temps:?}");
    cleanup(&dir);
}

#[test]
fn corrupt_file_is_backed_up_and_treated_as_empty() {
    let dir = tempdir_like("corrupt");
    let file = dir.join("store.json");
    std::fs::write(&file, "{ not valid json").expect("write garbage");

    let store = WebStore::open(file.clone());
    assert_eq!(store.read("anything").unwrap(), None);

    let backups: Vec<_> = std::fs::read_dir(&dir)
        .expect("read dir")
        .filter_map(Result::ok)
        .filter(|e| {
            e.file_name()
                .to_str()
                .map(|n| n.starts_with("store.json.corrupt-") && n.ends_with(".bak"))
                .unwrap_or(false)
        })
        .collect();
    assert_eq!(backups.len(), 1, "exactly one corrupt backup");

    // A write after recovery recreates a valid file.
    store.write("k", serde_json::json!("v"), None).unwrap();
    let reloaded = WebStore::open(file);
    assert_eq!(reloaded.read("k").unwrap(), Some(serde_json::json!("v")));
    cleanup(&dir);
}
