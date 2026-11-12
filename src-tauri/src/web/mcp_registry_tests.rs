use std::path::PathBuf;

use serde_json::{json, Value};

use super::{
    bounded, import_project_files, import_registered_project_files, legacy_project_file, Import,
    ALIASES_KEY, MAX_ALIASES_BYTES, STORE_KEY,
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

    fn aliases(&self) -> Option<Value> {
        self.store.peek(ALIASES_KEY).unwrap()
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
            files: 3,
            aliases: 2
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
    assert_eq!(
        host.aliases(),
        Some(envelope(
            json!({ "files-b": "files-1", "remote-c2": "remote-1" })
        ))
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
            files: 1,
            aliases: 0
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
fn skips_a_file_over_the_size_limit_and_keeps_the_others() {
    let host = Host::new();
    let padding = " ".repeat(1024 * 1024);
    let huge = host.project(
        "huge",
        Some(&format!(
            r#"[{{"id":"big","name":"Big","command":"big"}}]{padding}"#
        )),
    );
    let small = host.project(
        "small",
        Some(&file_of(
            json!([{ "id": "ok", "name": "Ok", "command": "ok" }]),
        )),
    );

    assert_eq!(
        import_project_files(&host.store, &[huge, small]).unwrap(),
        Import::Imported {
            servers: 1,
            files: 1,
            aliases: 0
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
            files: 0,
            aliases: 0
        }
    );
    assert_eq!(host.stored(), Some(envelope(json!([]))));
    assert_eq!(host.aliases(), None);
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

#[test]
fn a_dropped_id_that_a_later_entry_keeps_names_that_entry_not_an_alias() {
    let host = Host::new();
    let a = host.project(
        "a",
        Some(&file_of(
            json!([{ "id": "1", "name": "Files", "command": "one" }]),
        )),
    );
    let b = host.project(
        "b",
        Some(&file_of(json!([
            { "id": "2", "name": "Files", "command": "one" },
            { "id": "3", "name": "Files", "command": "one" }
        ]))),
    );
    let c = host.project(
        "c",
        Some(&file_of(
            json!([{ "id": "2", "name": "Git", "command": "git" }]),
        )),
    );

    assert_eq!(
        import_project_files(&host.store, &[a, b, c]).unwrap(),
        Import::Imported {
            servers: 2,
            files: 3,
            aliases: 1
        }
    );
    assert_eq!(host.aliases(), Some(envelope(json!({ "3": "1" }))));
}

#[test]
fn the_aliases_survive_a_rerun_and_a_reopen() {
    let host = Host::new();
    let a = host.project(
        "a",
        Some(&file_of(
            json!([{ "id": "1", "name": "Files", "command": "one" }]),
        )),
    );
    let b = host.project(
        "b",
        Some(&file_of(
            json!([{ "id": "2", "name": "Files", "command": "one" }]),
        )),
    );
    import_project_files(&host.store, &[a.clone(), b.clone()]).unwrap();

    assert_eq!(
        import_project_files(&host.store, &[b, a]).unwrap(),
        Import::AlreadyStored
    );
    let reopened = WebStore::open(host.store.path().to_path_buf(), StorePolicy::default()).unwrap();
    assert_eq!(
        reopened.peek(ALIASES_KEY).unwrap(),
        Some(envelope(json!({ "2": "1" })))
    );
}

#[test]
fn an_alias_map_a_failed_import_left_is_replaced_by_the_one_merged_with_the_stored_list() {
    let host = Host::new();
    // An earlier attempt stored its aliases, then failed to store the list.
    host.store
        .insert_if_absent(ALIASES_KEY, envelope(json!({ "3": "1", "2": "9" })), 1)
        .unwrap();
    let a = host.project(
        "a",
        Some(&file_of(
            json!([{ "id": "1", "name": "Files", "command": "one" }]),
        )),
    );
    let b = host.project(
        "b",
        Some(&file_of(
            json!([{ "id": "2", "name": "Files", "command": "one" }]),
        )),
    );

    assert_eq!(
        import_project_files(&host.store, &[a.clone(), b]).unwrap(),
        Import::Imported {
            servers: 1,
            files: 2,
            aliases: 1
        }
    );
    assert_eq!(host.aliases(), Some(envelope(json!({ "2": "1" }))));

    // With no alias left to record, the stale map is emptied, not kept.
    let fresh = Host::new();
    fresh
        .store
        .insert_if_absent(ALIASES_KEY, envelope(json!({ "2": "1" })), 1)
        .unwrap();
    let only = fresh.project(
        "a",
        Some(&file_of(
            json!([{ "id": "1", "name": "Files", "command": "one" }]),
        )),
    );
    import_project_files(&fresh.store, &[only]).unwrap();
    assert_eq!(fresh.aliases(), Some(envelope(json!({}))));
}

#[test]
fn an_alias_and_its_target_are_trimmed_as_automation_reads_ids() {
    use crate::automation::mcp::{attach_aliases, find_server, parse_registry};

    let host = Host::new();
    let a = host.project(
        "a",
        Some(&file_of(
            json!([{ "id": " files ", "name": "Files", "command": "one" }]),
        )),
    );
    let b = host.project(
        "b",
        Some(&file_of(
            json!([{ "id": " files-b ", "name": "Files", "command": "one" }]),
        )),
    );
    import_project_files(&host.store, &[a, b]).unwrap();

    assert_eq!(
        host.aliases(),
        Some(envelope(json!({ "files-b": "files" })))
    );
    let list = host.stored().unwrap();
    assert_eq!(
        list["data"][0]["id"], " files ",
        "the list keeps its values"
    );
    let mut servers = parse_registry(&list);
    attach_aliases(&mut servers, &list, &host.aliases().unwrap());
    assert_eq!(find_server(&servers, "files-b").unwrap().server_id, "files");
}

#[test]
fn the_alias_map_is_bounded_so_the_list_is_still_imported() {
    let host = Host::new();
    // One kept entry with a long id, and dropped copies of it that each
    // store that id again as their alias target.
    let long_id = "k".repeat(60 * 1024);
    let a = host.project(
        "a",
        Some(&file_of(
            json!([{ "id": long_id, "name": "Files", "command": "one" }]),
        )),
    );
    let copies: Vec<Value> = (0..12)
        .map(|n| json!({ "id": format!("copy-{n:02}"), "name": "Files", "command": "one" }))
        .collect();
    let b = host.project("b", Some(&file_of(Value::Array(copies))));

    let Import::Imported {
        servers, aliases, ..
    } = import_project_files(&host.store, &[a, b]).unwrap()
    else {
        panic!("the list was not imported");
    };

    assert_eq!(servers, 1);
    assert!(aliases > 0 && aliases < 12, "kept {aliases} aliases");
    assert_eq!(host.stored().unwrap()["data"][0]["id"], json!(long_id));
    let stored = host.aliases().unwrap();
    assert!(stored.to_string().len() <= MAX_ALIASES_BYTES);
    let map = stored["data"].as_object().unwrap();
    assert_eq!(map.len(), aliases);
    assert!(map.values().all(|target| target == &json!(long_id)));
    // The first ones in order are kept.
    assert!(map.contains_key("copy-00"));
}

#[test]
fn bounded_keeps_aliases_in_order_while_the_envelope_fits() {
    let all = || std::collections::BTreeMap::from([("a", "1"), ("b", "2"), ("c", "3")]);
    let size = |pairs: Value| envelope(pairs).to_string().len();
    let two = size(json!({ "a": "1", "b": "2" }));

    assert_eq!(bounded(all(), two + 100).1, 0);
    let (kept, omitted) = bounded(all(), two);
    assert_eq!(
        kept,
        std::collections::BTreeMap::from([("a", "1"), ("b", "2")])
    );
    assert_eq!(omitted, 1);
    assert_eq!(bounded(all(), two - 1).0.len(), 1);
    assert_eq!(bounded(all(), size(json!({})) - 1).0.len(), 0);
}
