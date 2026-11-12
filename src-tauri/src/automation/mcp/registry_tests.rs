use std::sync::Arc;

use serde_json::{json, Value};

use super::registry::{attach_aliases, find_server, parse_registry, store_servers};
use super::{McpServerConfig, McpServerEntry};
use crate::acp::mcp_probe::McpNameValuePair;
use crate::web::mcp_registry::{ALIASES_KEY, STORE_KEY};
use crate::web::store::{Precondition, StorePolicy, WebStore};
use crate::web::ws::ClientIdentity;

fn stdio(name: &str, command: &str) -> McpServerConfig {
    McpServerConfig {
        r#type: None,
        name: name.to_string(),
        command: Some(command.to_string()),
        args: vec![],
        env: vec![],
        url: None,
        headers: vec![],
    }
}

fn ids(entries: &[McpServerEntry]) -> Vec<(&str, &str)> {
    entries
        .iter()
        .map(|e| (e.server_id.as_str(), e.name.as_str()))
        .collect()
}

fn stored_list() -> Value {
    json!([
        { "id": "srv-1", "name": "Files", "command": "npx", "args": ["-y", "fs"],
          "env": [{ "name": "TOKEN", "value": "t-123" }], "enabled": true,
          "catalog": { "source": "mcp-registry" } },
        { "id": "srv-2", "name": "Off", "command": "npx", "enabled": false },
        { "id": "srv-3", "type": "http", "name": "Remote", "url": "https://mcp.example.com",
          "headers": [{ "name": "X-Key", "value": "k-1" }] },
        { "name": "no id", "command": "x" },
        { "id": "srv-4", "name": "bad env", "command": "x", "env": "nope" },
        { "id": " ", "name": "blank id", "command": "x" },
        { "id": "srv-1", "name": "Shadow", "command": "y" },
        7
    ])
}

#[test]
fn keeps_enabled_well_formed_entries_and_flattens_their_config() {
    let entries = parse_registry(&stored_list());
    assert_eq!(ids(&entries), vec![("srv-1", "Files"), ("srv-3", "Remote")]);
    let mut files = stdio("Files", "npx");
    files.args = vec!["-y".into(), "fs".into()];
    files.env = vec![McpNameValuePair {
        name: "TOKEN".into(),
        value: "t-123".into(),
    }];
    assert_eq!(entries[0].config, files);
    assert_eq!(entries[1].config.r#type.as_deref(), Some("http"));
    assert_eq!(
        entries[1].config.url.as_deref(),
        Some("https://mcp.example.com")
    );
}

#[test]
fn reads_the_renderer_envelope_and_nothing_from_other_shapes() {
    let envelope = json!({ "_version": 1, "data": stored_list() });
    assert_eq!(
        ids(&parse_registry(&envelope)),
        vec![("srv-1", "Files"), ("srv-3", "Remote")]
    );
    assert_eq!(parse_registry(&json!({ "data": "x" })), vec![]);
    assert_eq!(parse_registry(&json!("x")), vec![]);
}

fn write_list(store: &WebStore, value: Value) {
    let client = ClientIdentity {
        device_id: "desktop-device".into(),
        client_instance_id: "tab-1".into(),
    };
    // A base revision above any stored one always wins the last-writer merge.
    let base = Precondition {
        base_revision: Some(u64::MAX),
        ..Precondition::default()
    };
    store.write(STORE_KEY, value, base, &client, 1).unwrap();
}

#[test]
fn every_project_reads_the_one_stored_list() {
    let dir = tempfile::tempdir().unwrap();
    let store =
        Arc::new(WebStore::open(dir.path().join("store.json"), StorePolicy::default()).unwrap());
    let servers = store_servers(store.clone());
    assert_eq!(servers("p1"), vec![]);

    write_list(&store, json!({ "_version": 1, "data": stored_list() }));
    for project in ["p1", "any-project", ""] {
        assert_eq!(
            ids(&servers(project)),
            vec![("srv-1", "Files"), ("srv-3", "Remote")],
            "{project}"
        );
    }

    write_list(&store, json!({ "_version": 1, "data": "not a list" }));
    assert_eq!(servers("p1"), vec![]);
}

fn aliases_of(entries: &[McpServerEntry]) -> Vec<(&str, Vec<&str>)> {
    entries
        .iter()
        .map(|e| {
            let mut aliases: Vec<&str> = e.aliases.iter().map(String::as_str).collect();
            aliases.sort_unstable();
            (e.server_id.as_str(), aliases)
        })
        .collect()
}

#[test]
fn an_alias_attaches_only_to_an_enabled_entry_and_never_shadows_an_id() {
    let mut entries = parse_registry(&stored_list());
    attach_aliases(
        &mut entries,
        &stored_list(),
        &json!({ "_version": 1, "data": {
            "old-files": "srv-1",
            "older-files": "srv-1",
            "old-off": "srv-2",
            "old-gone": "srv-9",
            "srv-3": "srv-1",
            "bad": 7
        } }),
    );
    assert_eq!(
        aliases_of(&entries),
        vec![
            ("srv-1", vec!["old-files", "older-files"]),
            ("srv-3", vec![])
        ]
    );
    assert_eq!(
        find_server(&entries, "older-files").unwrap().server_id,
        "srv-1"
    );
    assert_eq!(find_server(&entries, "srv-3").unwrap().server_id, "srv-3");
    assert!(find_server(&entries, "old-off").is_none());
    assert!(find_server(&entries, "old-gone").is_none());

    let mut bare = parse_registry(&stored_list());
    attach_aliases(&mut bare, &stored_list(), &json!({ "old-files": "srv-1" }));
    assert_eq!(find_server(&bare, "old-files").unwrap().server_id, "srv-1");
    let mut wrong = parse_registry(&stored_list());
    attach_aliases(&mut wrong, &stored_list(), &json!(["old-files"]));
    assert!(find_server(&wrong, "old-files").is_none());
}

#[test]
fn an_alias_never_takes_over_the_id_of_a_disabled_or_unparsed_stored_entry() {
    let list = stored_list();
    let mut entries = parse_registry(&list);
    attach_aliases(
        &mut entries,
        &json!({ "_version": 1, "data": list }),
        &json!({ "srv-2": "srv-1", "srv-4": "srv-1", "old-files": "srv-1" }),
    );
    assert_eq!(
        aliases_of(&entries),
        vec![("srv-1", vec!["old-files"]), ("srv-3", vec![])]
    );
    assert!(
        find_server(&entries, "srv-2").is_none(),
        "a disabled server's id runs nothing"
    );
    assert!(find_server(&entries, "srv-4").is_none());
}

#[test]
fn the_stored_aliases_follow_the_stored_list() {
    let dir = tempfile::tempdir().unwrap();
    let store =
        Arc::new(WebStore::open(dir.path().join("store.json"), StorePolicy::default()).unwrap());
    store
        .insert_if_absent(
            ALIASES_KEY,
            json!({ "_version": 1, "data": { "old-files": "srv-1" } }),
            1,
        )
        .unwrap();
    let servers = store_servers(store.clone());
    assert_eq!(servers("p1"), vec![]);

    write_list(&store, json!({ "_version": 1, "data": stored_list() }));
    assert_eq!(
        find_server(&servers("p1"), "old-files").map(|s| s.server_id.clone()),
        Some("srv-1".to_string())
    );

    // The kept server deleted: its alias names nothing.
    write_list(
        &store,
        json!({ "_version": 1, "data": [
            { "id": "srv-3", "type": "http", "name": "Remote", "url": "https://mcp.example.com" }
        ] }),
    );
    assert_eq!(aliases_of(&servers("p1")), vec![("srv-3", vec![])]);
    assert!(find_server(&servers("p1"), "old-files").is_none());
}
