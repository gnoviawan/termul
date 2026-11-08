use std::path::PathBuf;

use serde_json::{json, Value};

use super::{
    import_project_files, import_registered_project_files, legacy_project_file, Import, STORE_KEY,
};
use crate::web::project_registry::ProjectRegistry;
use crate::web::store::{Precondition, StorePolicy, WebStore};
use crate::web::ws::ClientIdentity;

struct Host {
    dir: tempfile::TempDir,
    store: WebStore,
}

impl Host {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store = WebStore::open(dir.path().join("store.json"), StorePolicy::default()).unwrap();
        Self { dir, store }
    }

    /// A project folder, with `.termul/mcp-servers.json` holding `contents`
    /// when given.
    fn project(&self, name: &str, contents: Option<&str>) -> PathBuf {
        let root = self.dir.path().join(name);
        std::fs::create_dir_all(&root).unwrap();
        if let Some(contents) = contents {
            let file = legacy_project_file(&root);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, contents).unwrap();
        }
        root
    }

    fn stored(&self) -> Option<Value> {
        self.store.peek(STORE_KEY).unwrap()
    }
}

fn file_of(entries: Value) -> String {
    entries.to_string()
}

fn envelope(entries: Value) -> Value {
    json!({ "_version": 1, "data": entries })
}

#[test]
fn merges_every_project_list_dropping_duplicates_and_renaming_name_collisions() {
    let host = Host::new();
    let a = host.project(
        "a",
        Some(&file_of(json!([
            { "id": "files-1", "type": "stdio", "name": "Files", "command": "npx",
              "args": ["-y", "fs"], "env": [{ "name": "ROOT", "value": "/a" }], "enabled": true },
            { "id": "remote-1", "type": "http", "name": "Remote", "url": "https://mcp.example.com",
              "headers": [{ "name": "X-Key", "value": "k-a" }], "enabled": true }
        ]))),
    );
    let b = host.project(
        "b",
        Some(&file_of(json!([
            { "id": "files-1", "type": "stdio", "name": "Files renamed", "command": "other" },
            { "id": "files-b", "type": "stdio", "name": "Files", "command": "npx",
              "args": ["-y", "fs"], "env": [{ "name": "ROOT", "value": "/b" }], "enabled": true },
            { "id": "files-other", "type": "stdio", "name": "Files", "command": "uvx",
              "args": ["fs-server"], "enabled": true },
            { "id": "git-1", "type": "stdio", "name": "Git", "command": "git-mcp", "enabled": false }
        ]))),
    );
    let c = host.project(
        "c",
        Some(&file_of(json!([
            { "id": "remote-c", "type": "http", "name": "Remote", "url": "https://other.example.com",
              "enabled": true },
            { "id": "remote-c2", "type": "http", "name": "Remote", "url": "https://mcp.example.com",
              "headers": [{ "name": "X-Key", "value": "k-c" }], "enabled": true }
        ]))),
    );
    let none = host.project("none", None);

    let outcome = import_project_files(&host.store, &[a, b, c, none]).unwrap();

    assert_eq!(
        outcome,
        Import::Imported {
            servers: 5,
            files: 3
        }
    );
    assert_eq!(
        host.stored(),
        Some(envelope(json!([
            { "id": "files-1", "type": "stdio", "name": "Files", "command": "npx",
              "args": ["-y", "fs"], "env": [{ "name": "ROOT", "value": "/a" }], "enabled": true },
            { "id": "remote-1", "type": "http", "name": "Remote", "url": "https://mcp.example.com",
              "headers": [{ "name": "X-Key", "value": "k-a" }], "enabled": true },
            { "id": "files-other", "type": "stdio", "name": "Files-2", "command": "uvx",
              "args": ["fs-server"], "enabled": true },
            { "id": "git-1", "type": "stdio", "name": "Git", "command": "git-mcp", "enabled": false },
            { "id": "remote-c", "type": "http", "name": "Remote-2", "url": "https://other.example.com",
              "enabled": true }
        ])))
    );
}

#[test]
fn a_second_collision_takes_the_next_free_suffix() {
    let host = Host::new();
    let a = host.project(
        "a",
        Some(&file_of(json!([
            { "id": "1", "name": "Files", "command": "one" },
            { "id": "2", "name": "Files-2", "command": "two" }
        ]))),
    );
    let b = host.project(
        "b",
        Some(&file_of(
            json!([{ "id": "3", "name": "Files", "command": "three" }]),
        )),
    );

    import_project_files(&host.store, &[a, b]).unwrap();

    assert_eq!(
        host.stored(),
        Some(envelope(json!([
            { "id": "1", "name": "Files", "command": "one" },
            { "id": "2", "name": "Files-2", "command": "two" },
            { "id": "3", "name": "Files-3", "command": "three" }
        ])))
    );
}

#[test]
fn skips_malformed_files_and_entries_without_an_id_or_name() {
    let host = Host::new();
    let not_json = host.project("not-json", Some("{not json"));
    let object = host.project("object", Some(r#"{"id":"x","name":"X","command":"x"}"#));
    let valid = host.project(
        "valid",
        Some(&file_of(json!([
            { "name": "No id", "command": "x" },
            { "id": "blank", "name": "  ", "command": "x" },
            7,
            { "id": "ok", "name": "Ok", "command": "ok" }
        ]))),
    );

    let outcome = import_project_files(&host.store, &[not_json, object, valid]).unwrap();

    assert_eq!(
        outcome,
        Import::Imported {
            servers: 1,
            files: 1
        }
    );
    assert_eq!(
        host.stored(),
        Some(envelope(
            json!([{ "id": "ok", "name": "Ok", "command": "ok" }])
        ))
    );
}

#[test]
fn stores_an_empty_list_when_no_project_has_a_file() {
    let host = Host::new();
    let a = host.project("a", None);

    assert_eq!(
        import_project_files(&host.store, &[a]).unwrap(),
        Import::Imported {
            servers: 0,
            files: 0
        }
    );
    assert_eq!(host.stored(), Some(envelope(json!([]))));
}

#[test]
fn a_rerun_with_the_list_stored_changes_nothing_and_leaves_the_files() {
    let host = Host::new();
    let contents = file_of(json!([{ "id": "1", "name": "Files", "command": "one" }]));
    let a = host.project("a", Some(&contents));
    import_project_files(&host.store, std::slice::from_ref(&a)).unwrap();

    let b = host.project(
        "b",
        Some(&file_of(
            json!([{ "id": "2", "name": "Git", "command": "git" }]),
        )),
    );
    let rerun = import_project_files(&host.store, &[a.clone(), b]).unwrap();

    assert_eq!(rerun, Import::AlreadyStored);
    assert_eq!(
        host.stored(),
        Some(envelope(
            json!([{ "id": "1", "name": "Files", "command": "one" }])
        ))
    );
    assert_eq!(
        std::fs::read_to_string(legacy_project_file(&a)).unwrap(),
        contents
    );
}

#[test]
fn a_list_a_client_already_saved_is_never_replaced() {
    let host = Host::new();
    let client = ClientIdentity {
        device_id: "desktop-device".into(),
        client_instance_id: "tab-1".into(),
    };
    let saved = envelope(json!([{ "id": "mine", "name": "Mine", "command": "mine" }]));
    host.store
        .write(
            STORE_KEY,
            saved.clone(),
            Precondition::default(),
            &client,
            1,
        )
        .unwrap();
    let a = host.project(
        "a",
        Some(&file_of(
            json!([{ "id": "1", "name": "Files", "command": "one" }]),
        )),
    );

    assert_eq!(
        import_project_files(&host.store, &[a]).unwrap(),
        Import::AlreadyStored
    );
    assert_eq!(host.stored(), Some(saved));
}

#[test]
fn reads_only_registered_projects_that_are_not_archived() {
    let host = Host::new();
    let open = host.project(
        "open",
        Some(&file_of(
            json!([{ "id": "1", "name": "Open", "command": "one" }]),
        )),
    );
    let archived = host.project(
        "archived",
        Some(&file_of(
            json!([{ "id": "2", "name": "Archived", "command": "two" }]),
        )),
    );
    host.project(
        "unregistered",
        Some(&file_of(
            json!([{ "id": "3", "name": "Unregistered", "command": "three" }]),
        )),
    );
    let registry = ProjectRegistry::with_roots_for_test(&[
        ("open", open.as_path()),
        ("archived", archived.as_path()),
    ]);
    assert!(registry.update("archived", None, None, Some(true)));

    import_registered_project_files(&host.store, &registry).unwrap();

    assert_eq!(
        host.stored(),
        Some(envelope(
            json!([{ "id": "1", "name": "Open", "command": "one" }])
        ))
    );
}

#[test]
fn the_store_file_survives_a_reopen_with_the_imported_list() {
    let host = Host::new();
    let a = host.project(
        "a",
        Some(&file_of(
            json!([{ "id": "1", "name": "Files", "command": "one" }]),
        )),
    );
    import_project_files(&host.store, &[a]).unwrap();

    let reopened = WebStore::open(host.store.path().to_path_buf(), StorePolicy::default()).unwrap();

    assert_eq!(
        reopened.peek(STORE_KEY).unwrap(),
        Some(envelope(
            json!([{ "id": "1", "name": "Files", "command": "one" }])
        ))
    );
}
