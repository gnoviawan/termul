//! The one-shot workspace-manifest import: conversion to the renderer's
//! `workspace/<projectId>` record and its adoption by the first device.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::manifest_import::read_workspaces;
use super::tests::{cleanup, on_disk, open, open_with, tempdir_like, who};
use super::{StoreError, StorePolicy, WebStore};

fn envelope(manifest: &Value) -> Vec<u8> {
    serde_json::to_vec(&json!({ "schemaVersion": 1, "manifest": manifest })).unwrap()
}

fn write_manifest(dir: &Path, project_id: &str, manifest: &Value) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join(format!("{project_id}.json")), envelope(manifest)).unwrap();
}

/// Two panes: a terminal and an editor on the left, a Markdown file on the right.
fn split_manifest(project_id: &str) -> Value {
    json!({
        "projectId": project_id,
        "revision": 4,
        "updateIdentity": "web-1",
        "updatedAt": 1_700_000_000_000_u64,
        "topology": {
            "type": "split",
            "id": "s1",
            "direction": "horizontal",
            "sizes": [60, 40],
            "children": [
                {
                    "type": "leaf",
                    "id": "l1",
                    "terminalIds": ["t1", "t-gone"],
                    "editorIds": ["edit-/w/a.ts", "edit-/w/gone.ts"],
                    "activeTabId": "edit-/w/a.ts"
                },
                {
                    "type": "leaf",
                    "id": "l2",
                    "terminalIds": [],
                    "editorIds": ["edit-/w/README.md"],
                    "activeTabId": "edit-/w/README.md"
                }
            ]
        },
        "activePaneId": "l2",
        "focusedSessionId": "session-1",
        "terminals": [
            { "terminalId": "t1", "projectId": project_id, "shell": "bash", "cwd": "/w", "name": "main" }
        ],
        "editors": [
            { "editorId": "edit-/w/a.ts", "filePath": "/w/a.ts" },
            { "editorId": "edit-/w/README.md", "filePath": "/w/README.md" }
        ]
    })
}

fn converted(manifest: &Value) -> Option<Value> {
    let dir = tempdir_like("convert");
    write_manifest(&dir, "p", manifest);
    let mut all = read_workspaces(&dir);
    cleanup(&dir);
    all.pop().map(|(_, value)| value)
}

fn file_record(path: &str, view_mode: &str) -> Value {
    json!({
        "filePath": path,
        "cursorPosition": { "line": 1, "col": 1 },
        "scrollTop": 0,
        "viewMode": view_mode,
        "isDirty": false,
        "lastModified": 1_700_000_000_000_u64
    })
}

#[test]
fn a_split_topology_becomes_the_renderers_pane_layout() {
    let stored = converted(&split_manifest("p")).expect("a manifest with tabs converts");
    assert_eq!(
        stored,
        json!({
            "_version": 1,
            "data": {
                "openFiles": [file_record("/w/a.ts", "code"), file_record("/w/README.md", "markdown")],
                "activeFilePath": "/w/README.md",
                "expandedDirs": [],
                "activeTabId": "edit-/w/README.md",
                "paneLayout": {
                    "type": "split",
                    "id": "s1",
                    "direction": "horizontal",
                    "children": [
                        {
                            "type": "leaf",
                            "id": "l1",
                            // Dangling terminal and editor ids are dropped; terminals come first.
                            "tabs": [
                                { "type": "terminal", "terminalId": "t1" },
                                { "type": "editor", "filePath": "/w/a.ts" }
                            ],
                            "activeTabId": "edit-/w/a.ts"
                        },
                        {
                            "type": "leaf",
                            "id": "l2",
                            "tabs": [{ "type": "editor", "filePath": "/w/README.md" }],
                            "activeTabId": "edit-/w/README.md"
                        }
                    ],
                    "sizes": [60, 40]
                },
                "activePaneId": "l2"
            }
        })
    );
}

#[test]
fn a_leaf_topology_picks_a_live_active_tab_and_the_first_leaf_as_active_pane() {
    let manifest = json!({
        "projectId": "p",
        "revision": 1,
        "updatedAt": 5,
        "topology": {
            "type": "leaf",
            "id": "only",
            "terminalIds": ["t1"],
            "editorIds": [],
            "activeTabId": "edit-/w/closed.ts"
        },
        "activePaneId": "missing-pane",
        "terminals": [{ "terminalId": "t1", "projectId": "p", "shell": "zsh", "cwd": "/w", "name": "z" }],
        "editors": []
    });
    let data = converted(&manifest).unwrap()["data"].clone();
    assert_eq!(data["activePaneId"], json!("only"));
    assert_eq!(data["activeTabId"], json!("term-t1"), "a stale active tab falls back to the first tab");
    assert_eq!(data["activeFilePath"], Value::Null, "the active tab is a terminal");
    assert_eq!(data["openFiles"], json!([]));
    assert_eq!(
        data["paneLayout"],
        json!({
            "type": "leaf",
            "id": "only",
            "tabs": [{ "type": "terminal", "terminalId": "t1" }],
            "activeTabId": "term-t1"
        })
    );
}

#[test]
fn split_sizes_that_do_not_fit_the_surviving_children_are_shared_evenly() {
    let mut manifest = split_manifest("p");
    manifest["topology"]["sizes"] = json!([100]);
    // An unknown node kind is dropped with its subtree.
    manifest["topology"]["children"]
        .as_array_mut()
        .unwrap()
        .push(json!({ "type": "mystery", "id": "m" }));
    let data = converted(&manifest).unwrap()["data"].clone();
    assert_eq!(data["paneLayout"]["children"].as_array().unwrap().len(), 2);
    assert_eq!(data["paneLayout"]["sizes"], json!([50.0, 50.0]));
}

#[test]
fn a_manifest_without_topology_imports_its_editors_as_open_files_only() {
    let manifest = json!({
        "projectId": "p",
        "revision": 2,
        "updatedAt": 9,
        "terminals": [],
        "editors": [
            { "editorId": "edit-/w/a.ts", "filePath": "/w/a.ts" },
            { "editorId": "dup", "filePath": "/w/a.ts" }
        ]
    });
    let data = converted(&manifest).unwrap()["data"].clone();
    assert_eq!(data["openFiles"].as_array().unwrap().len(), 1, "one entry per file");
    assert!(data.get("paneLayout").is_none(), "the renderer builds a single pane from the files");
    assert!(data.get("activePaneId").is_none());
}

#[test]
fn a_manifest_with_nothing_to_restore_imports_nothing() {
    let empty_pane = json!({
        "projectId": "p",
        "revision": 1,
        "updatedAt": 1,
        "topology": { "type": "leaf", "id": "l", "terminalIds": [], "editorIds": [], "activeTabId": null },
        "terminals": [],
        "editors": []
    });
    assert_eq!(converted(&empty_pane), None);
}

#[test]
fn files_that_are_not_readable_manifests_are_skipped_and_left_in_place() {
    let dir = tempdir_like("skip-corrupt");
    write_manifest(&dir, "good", &split_manifest("good"));
    std::fs::write(dir.join("broken.json"), b"{ not json").unwrap();
    std::fs::write(
        dir.join("newer.json"),
        br#"{"schemaVersion":9,"manifest":{}}"#,
    )
    .unwrap();
    std::fs::write(dir.join("shape.json"), br#"{"schemaVersion":1,"manifest":[]}"#).unwrap();
    std::fs::write(dir.join(".termul.lock"), b"123").unwrap();
    std::fs::write(dir.join("good.json.corrupt-1.bak"), b"old").unwrap();

    let all = read_workspaces(&dir);
    assert_eq!(all.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(), ["good"]);
    for kept in ["broken.json", "newer.json", "shape.json", ".termul.lock"] {
        assert!(dir.join(kept).exists(), "{kept} is not touched");
    }
    assert_eq!(std::fs::read(dir.join("broken.json")).unwrap(), b"{ not json");
    cleanup(&dir);
}

struct Fixture {
    root: PathBuf,
    file: PathBuf,
    manifests: PathBuf,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let root = tempdir_like(label);
        Self {
            file: root.join("store.json"),
            manifests: root.join("workspace-manifests"),
            root,
        }
    }

    fn store(&self) -> WebStore {
        open(&self.file).with_legacy_manifests(self.manifests.clone())
    }

    /// The renamed manifest directories next to the live one.
    fn backups(&self) -> Vec<PathBuf> {
        std::fs::read_dir(&self.root)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with("workspace-manifests.imported-"))
            })
            .collect()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        cleanup(&self.root);
    }
}

#[test]
fn the_first_device_adopts_every_manifest_and_the_directory_is_renamed_once() {
    let fx = Fixture::new("import");
    write_manifest(&fx.manifests, "p1", &split_manifest("p1"));
    write_manifest(&fx.manifests, "p2", &split_manifest("p2"));
    std::fs::write(fx.manifests.join("broken.json"), b"nope").unwrap();
    let store = fx.store();
    let phone = who("phone", "t1");
    let desktop = who("desktop", "t2");

    // Nothing moved at open: the import waits for the first authenticated request.
    assert!(fx.manifests.is_dir());

    let first = store.read("device/phone/workspace/p1", &phone, 5_000_000).unwrap();
    assert_eq!(first.revision, 1);
    assert_eq!(first.client_instance_id.as_deref(), Some("legacy"));
    let value = first.value.unwrap();
    assert_eq!(value["_version"], json!(1));
    assert_eq!(value["data"]["activePaneId"], json!("l2"));
    assert!(store.read("device/phone/workspace/p2", &phone, 5_000_001).unwrap().value.is_some());

    // One persisted write carried both workspaces and the adoption marker.
    let disk = on_disk(&fx.file);
    assert_eq!(disk["host"]["adopted"]["deviceId"], json!("phone"));
    assert!(disk["data"]["device/phone/workspace/p1"].is_object());

    // The directory moved to a backup (never deleted); a bad file travelled with it.
    assert!(!fx.manifests.exists());
    let backups = fx.backups();
    assert_eq!(backups.len(), 1);
    assert!(backups[0].ends_with("workspace-manifests.imported-5000"));
    assert!(backups[0].join("p1.json").is_file());
    assert_eq!(std::fs::read(backups[0].join("broken.json")).unwrap(), b"nope");

    // The second device gets nothing copied.
    assert_eq!(store.read("device/desktop/workspace/p1", &desktop, 5_000_002).unwrap().revision, 0);

    // A restart does not import again, even if a directory reappears.
    drop(store);
    write_manifest(&fx.manifests, "p3", &split_manifest("p3"));
    let again = fx.store();
    assert!(again.read("device/phone/workspace/p3", &phone, 5_000_003).unwrap().value.is_none());
    assert!(fx.manifests.is_dir(), "an adopted store never touches the directory again");
}

#[test]
fn an_import_that_overshoots_the_partition_budget_drops_the_last_workspaces() {
    let fx = Fixture::new("budget");
    for id in ["p1", "p2", "p3"] {
        write_manifest(&fx.manifests, id, &split_manifest(id));
    }
    let value_bytes = serde_json::to_vec(&read_workspaces(&fx.manifests)[0].1).unwrap().len();
    // Room for two records (each adds under 180 bytes of key and metadata), not three.
    let policy = StorePolicy {
        partition_byte_budget: (2 * (value_bytes + 180)) as u64,
        ..StorePolicy::default()
    };
    let store = open_with(&fx.file, policy).with_legacy_manifests(fx.manifests.clone());
    let phone = who("phone", "t1");

    assert!(store.read("device/phone/workspace/p1", &phone, 5_000_000).unwrap().value.is_some());
    assert!(store.read("device/phone/workspace/p2", &phone, 5_000_001).unwrap().value.is_some());
    assert!(store.read("device/phone/workspace/p3", &phone, 5_000_002).unwrap().value.is_none());
    let disk = on_disk(&fx.file);
    assert!(disk["data"]["device/phone/workspace/p3"].is_null());
    assert_eq!(disk["host"]["adopted"]["deviceId"], json!("phone"));
    // The dropped manifest stays in the renamed directory.
    assert!(fx.backups()[0].join("p3.json").is_file());
}

#[test]
fn an_existing_workspace_key_wins_over_the_manifest() {
    let fx = Fixture::new("existing-wins");
    // A v1 store whose `editor-state/p1` is adopted as `workspace/p1`.
    std::fs::write(
        &fx.file,
        br#"{"schemaVersion":1,"data":{"editor-state/p1":{"_version":1,"data":{"openFiles":["mine"]}}}}"#,
    )
    .unwrap();
    write_manifest(&fx.manifests, "p1", &split_manifest("p1"));
    write_manifest(&fx.manifests, "p2", &split_manifest("p2"));
    let store = fx.store();
    let phone = who("phone", "t1");

    let kept = store.read("device/phone/workspace/p1", &phone, 10).unwrap();
    assert_eq!(kept.value, Some(json!({ "_version": 1, "data": { "openFiles": ["mine"] } })));
    let imported = store.read("device/phone/workspace/p2", &phone, 11).unwrap();
    assert!(imported.value.unwrap()["data"]["paneLayout"].is_object());
    assert!(
        store.read("device/phone/editor-state/p1", &phone, 12).unwrap().value.is_none(),
        "the old key name is gone"
    );
}

#[test]
fn a_store_that_already_adopted_does_not_import() {
    let fx = Fixture::new("already-adopted");
    {
        std::fs::write(
            &fx.file,
            br#"{"schemaVersion":1,"data":{"shell-layout":{"_version":1,"data":{}}}}"#,
        )
        .unwrap();
        let store = open(&fx.file);
        store.read("device/old/shell-layout", &who("old", "t"), 1).unwrap();
    }
    write_manifest(&fx.manifests, "p1", &split_manifest("p1"));
    let store = fx.store();
    let newcomer = who("new", "t");
    assert!(store.read("device/new/workspace/p1", &newcomer, 2).unwrap().value.is_none());
    assert!(fx.manifests.is_dir());
    assert!(fx.backups().is_empty());
}

#[test]
fn without_a_manifest_directory_nothing_is_adopted_or_written() {
    let fx = Fixture::new("no-dir");
    let store = fx.store();
    store.read("device/dev/workspace/p1", &who("dev", "t"), 1).unwrap();
    assert!(!fx.file.exists());
}

#[test]
fn an_empty_manifest_directory_is_retired_without_a_write() {
    let fx = Fixture::new("empty-dir");
    std::fs::create_dir_all(&fx.manifests).unwrap();
    std::fs::write(fx.manifests.join(".termul.lock"), b"1").unwrap();
    let store = fx.store();
    let device = who("dev", "t");
    store.read("device/dev/workspace/p1", &device, 7_000).unwrap();
    assert!(!fx.file.exists(), "nothing to adopt, nothing written");
    assert!(!fx.manifests.exists());
    assert_eq!(fx.backups().len(), 1);
    assert!(
        store.read("device/dev/workspace/p1", &device, 7_001).unwrap().value.is_none(),
        "nothing is left pending"
    );
}

#[test]
fn a_taken_backup_name_gets_a_numeric_suffix_and_nothing_is_overwritten() {
    let fx = Fixture::new("backup-name");
    write_manifest(&fx.manifests, "p1", &split_manifest("p1"));
    let taken = fx.root.join("workspace-manifests.imported-9");
    std::fs::create_dir_all(&taken).unwrap();
    std::fs::write(taken.join("older.json"), b"keep me").unwrap();
    let store = fx.store();

    store.read("device/dev/workspace/p1", &who("dev", "t"), 9_000).unwrap();

    assert_eq!(std::fs::read(taken.join("older.json")).unwrap(), b"keep me");
    assert!(fx.root.join("workspace-manifests.imported-9-1/p1.json").is_file());
}

#[test]
fn a_failed_write_keeps_the_import_pending_and_the_directory_in_place() {
    let fx = Fixture::new("write-fails");
    write_manifest(&fx.manifests, "p1", &split_manifest("p1"));
    let store = fx.store();
    // A directory squats on the store file's path after open: the replace fails.
    std::fs::create_dir(&fx.file).unwrap();
    let phone = who("phone", "t1");

    let failed = store.read("device/phone/workspace/p1", &phone, 100);
    assert!(matches!(failed, Err(StoreError::Io(_))), "{failed:?}");
    assert!(fx.manifests.join("p1.json").is_file(), "the directory is not renamed");
    assert!(fx.backups().is_empty());

    std::fs::remove_dir(&fx.file).unwrap();
    let ok = store.read("device/phone/workspace/p1", &phone, 101).unwrap();
    assert!(ok.value.is_some(), "the next request retries the whole adoption");
    assert_eq!(on_disk(&fx.file)["host"]["adopted"]["deviceId"], json!("phone"));
    assert!(!fx.manifests.exists());
}
